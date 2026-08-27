import { canvasToBlob } from './fileUtils'

/**
 * The lossless path, for screenshots, diagrams, logos and other flat-colour
 * images. Photographic codecs are the wrong tool for these: they blur the
 * hard edges that carry the meaning, and spend bits on gradient detail that
 * isn't there. Cutting the palette instead removes exactly the redundancy
 * these images actually have.
 *
 * oxipng (WASM, ~160 KB, loaded only when this path is taken) then does the
 * filter and Deflate search, including reducing a quantised RGBA image to a
 * real indexed-colour PNG.
 */

type OptimiseFn = (data: ArrayBuffer | ImageData, options?: { level?: number; interlace?: boolean; optimiseAlpha?: boolean }) => Promise<ArrayBuffer>

let optimiseModule: Promise<OptimiseFn> | null = null

/** Lazily pulls in the oxipng WASM so it never lands in the initial bundle. */
function loadOptimiser(): Promise<OptimiseFn> {
  if (!optimiseModule) {
    optimiseModule = import('@jsquash/oxipng').then((m) => m.optimise as OptimiseFn)
  }
  return optimiseModule
}

// oxipng's own scale. 2 is the sweet spot in-browser: level 3+ costs
// several times the time for low single-digit percentage gains.
const OXIPNG_LEVEL = 2

/** Colour cube resolution used for the histogram: 5 bits per channel. */
const BITS = 5
const SHIFT = 8 - BITS
const AXIS = 1 << BITS

interface ColorBox {
  bins: number[]
  rMin: number; rMax: number
  gMin: number; gMax: number
  bMin: number; bMax: number
  count: number
}

function binKey(r: number, g: number, b: number): number {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT)
}

function boundsOf(bins: number[], histogram: Uint32Array): ColorBox {
  let rMin = AXIS, rMax = -1, gMin = AXIS, gMax = -1, bMin = AXIS, bMax = -1
  let count = 0
  for (const bin of bins) {
    const r = bin >> (BITS * 2)
    const g = (bin >> BITS) & (AXIS - 1)
    const b = bin & (AXIS - 1)
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
    count += histogram[bin]
  }
  return { bins, rMin, rMax, gMin, gMax, bMin, bMax, count }
}

/**
 * Median cut: repeatedly split the box with the widest colour spread at the
 * median of its longest axis, so palette entries get spent where the image
 * actually varies rather than being spread evenly over unused colour space.
 */
function medianCut(histogram: Uint32Array, maxColors: number): ColorBox[] {
  const populated: number[] = []
  for (let bin = 0; bin < histogram.length; bin++) if (histogram[bin] > 0) populated.push(bin)
  if (populated.length === 0) return []

  let boxes = [boundsOf(populated, histogram)]
  while (boxes.length < maxColors) {
    let targetIndex = -1
    let widest = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]
      if (box.bins.length < 2) continue
      const spread = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin)
      // Weighting by population keeps a large near-uniform region from
      // being split ahead of a small but visually distinct one.
      const score = spread * Math.log2(box.count + 1)
      if (score > widest) {
        widest = score
        targetIndex = i
      }
    }
    if (targetIndex < 0) break

    const box = boxes[targetIndex]
    const rSpread = box.rMax - box.rMin
    const gSpread = box.gMax - box.gMin
    const bSpread = box.bMax - box.bMin
    const axis = rSpread >= gSpread && rSpread >= bSpread ? 0 : gSpread >= bSpread ? 1 : 2
    const componentOf = (bin: number) =>
      axis === 0 ? bin >> (BITS * 2) : axis === 1 ? (bin >> BITS) & (AXIS - 1) : bin & (AXIS - 1)

    const sorted = [...box.bins].sort((a, b) => componentOf(a) - componentOf(b))
    // Split at the population median, not the midpoint of the bin list.
    const half = box.count / 2
    let running = 0
    let splitAt = 0
    for (; splitAt < sorted.length - 1; splitAt++) {
      running += histogram[sorted[splitAt]]
      if (running >= half) break
    }
    // A single dominant colour (a screenshot's background is routinely more
    // than half the pixels) pushes the median onto the last bin, which would
    // otherwise put every bin on one side and stall the split. Clamping keeps
    // both sides non-empty and hands the dominant bin its own box, which is
    // exactly where it belongs.
    splitAt = Math.min(splitAt, sorted.length - 2)
    const left = sorted.slice(0, splitAt + 1)
    const right = sorted.slice(splitAt + 1)

    boxes.splice(targetIndex, 1, boundsOf(left, histogram), boundsOf(right, histogram))
  }
  return boxes
}

/**
 * Reduces an image to at most `maxColors` distinct colours in place.
 * Alpha is left untouched — quantising it is what produces the ragged
 * edges that make palette-reduced images look cheap.
 */
export function quantize(data: Uint8ClampedArray, maxColors: number): number {
  const histogram = new Uint32Array(AXIS * AXIS * AXIS)
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    histogram[binKey(data[i], data[i + 1], data[i + 2])]++
  }

  const boxes = medianCut(histogram, maxColors)
  if (boxes.length === 0) return 0

  // Palette entry = population-weighted mean of its box, which lands on the
  // colour the eye actually reads rather than the geometric box centre.
  const palette = boxes.map((box) => {
    let r = 0, g = 0, b = 0, total = 0
    for (const bin of box.bins) {
      const weight = histogram[bin]
      // +0.5 recovers the centre of each quantised bin rather than its floor.
      r += ((bin >> (BITS * 2)) + 0.5) * (1 << SHIFT) * weight
      g += (((bin >> BITS) & (AXIS - 1)) + 0.5) * (1 << SHIFT) * weight
      b += ((bin & (AXIS - 1)) + 0.5) * (1 << SHIFT) * weight
      total += weight
    }
    return total === 0 ? [0, 0, 0] : [r / total, g / total, b / total]
  })

  // Every pixel in a bin maps to the same palette entry, so resolve once
  // per bin and reuse. Screenshots hit this cache almost every pixel.
  const binToPalette = new Int16Array(histogram.length).fill(-1)
  boxes.forEach((box, index) => {
    for (const bin of box.bins) binToPalette[bin] = index
  })

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue
    const bin = binKey(data[i], data[i + 1], data[i + 2])
    let index = binToPalette[bin]
    if (index < 0) {
      // Colour that never appeared in the histogram (only reachable via a
      // fully transparent pixel becoming visible); fall back to a scan.
      let best = 0
      let bestDistance = Infinity
      for (let p = 0; p < palette.length; p++) {
        const dr = data[i] - palette[p][0]
        const dg = data[i + 1] - palette[p][1]
        const db = data[i + 2] - palette[p][2]
        const distance = dr * dr + dg * dg + db * db
        if (distance < bestDistance) {
          bestDistance = distance
          best = p
        }
      }
      index = best
      binToPalette[bin] = index
    }
    const entry = palette[index]
    data[i] = entry[0]
    data[i + 1] = entry[1]
    data[i + 2] = entry[2]
  }

  return palette.length
}

/** Runs oxipng over already-encoded PNG bytes. Returns the original on any failure. */
export async function optimisePng(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  try {
    const optimise = await loadOptimiser()
    const result = await optimise(bytes, { level: OXIPNG_LEVEL, interlace: false, optimiseAlpha: true })
    return result.byteLength > 0 && result.byteLength < bytes.byteLength ? result : bytes
  } catch {
    return bytes
  }
}

export interface PaletteResult {
  blob: Blob
  colors: number
  canvas: HTMLCanvasElement
}

/**
 * Quantises a drawable to `maxColors` and encodes it as a plain PNG.
 *
 * oxipng is deliberately *not* run here. It is by far the most expensive
 * step in this path, and running it on every candidate during a search
 * multiplies that cost by the number of palette sizes tried — for a ranking
 * that plain canvas PNG sizes already get right, since oxipng's savings are
 * near-proportional across candidates. The winner gets optimised once, by
 * the caller, via [[optimisePng]].
 */
export async function encodePalettePng(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxColors: number,
): Promise<PaletteResult> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, width, height)
  const imageData = ctx.getImageData(0, 0, width, height)
  const colors = quantize(imageData.data, maxColors)
  ctx.putImageData(imageData, 0, 0)

  return { blob: await canvasToBlob(canvas, 'image/png'), colors, canvas }
}
