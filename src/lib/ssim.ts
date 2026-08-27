/**
 * Structural similarity, used to decide "is this re-encode visually
 * identical to the source?" instead of trusting a fixed quality number.
 *
 * Butteraugli would be the better metric, but the only real implementation
 * lives in libjxl — a multi-megabyte WASM payload for a tool whose whole
 * build is currently smaller than that. SSIM is a few hundred lines of
 * plain arithmetic, needs no bundle budget at all, and is more than
 * sufficient for the decision being made here (accept / lower the quality
 * and try again).
 */

// Standard SSIM stabilisers for 8-bit data (C1 = (0.01*L)^2, C2 = (0.03*L)^2).
const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2
const WINDOW = 8

/**
 * SSIM is computed on a downscaled copy. Full-resolution SSIM on a 12MP
 * photo costs far more than the encode it's judging, and the quality
 * decision doesn't change: encoder artifacts that matter are still visible
 * at this size, and it keeps the search interactive.
 */
const MAX_EDGE = 512

function toGray(canvas: HTMLCanvasElement): { data: Float32Array; width: number; height: number } {
  const { width, height } = canvas
  const rgba = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data
  const gray = new Float32Array(width * height)
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    // Rec. 601 luma — matches how JPEG/WebP allocate their own bit budget.
    gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
  }
  return { data: gray, width, height }
}

function drawScaled(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // A flat white ground keeps alpha differences from reading as structure
  // when one side has an alpha channel and the other doesn't.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

/**
 * Normalises any drawable to a full-resolution canvas before it is scaled
 * down for comparison.
 *
 * This matters more than it looks: browsers do not resample an
 * <img> and a <canvas> identically, so scaling the two sides straight from
 * mixed source types injects a difference that has nothing to do with the
 * encoder being measured. Putting both sides through the same two steps
 * makes the score reflect compression damage and nothing else.
 */
function toFullResCanvas(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  if (source instanceof HTMLCanvasElement && source.width === width && source.height === height) return source
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  return canvas
}

function comparisonDims(width: number, height: number): { w: number; h: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= MAX_EDGE) return { w: Math.max(1, width), h: Math.max(1, height) }
  const ratio = MAX_EDGE / longEdge
  return { w: Math.max(1, Math.round(width * ratio)), h: Math.max(1, Math.round(height * ratio)) }
}

function meanSsim(
  a: { data: Float32Array },
  b: { data: Float32Array },
  w: number,
  h: number,
): number {
  let total = 0
  let windows = 0
  for (let y = 0; y + WINDOW <= h; y += WINDOW) {
    for (let x = 0; x + WINDOW <= w; x += WINDOW) {
      let sumA = 0
      let sumB = 0
      let sumAA = 0
      let sumBB = 0
      let sumAB = 0
      for (let dy = 0; dy < WINDOW; dy++) {
        let idx = (y + dy) * w + x
        for (let dx = 0; dx < WINDOW; dx++, idx++) {
          const va = a.data[idx]
          const vb = b.data[idx]
          sumA += va
          sumB += vb
          sumAA += va * va
          sumBB += vb * vb
          sumAB += va * vb
        }
      }
      const n = WINDOW * WINDOW
      const muA = sumA / n
      const muB = sumB / n
      const varA = sumAA / n - muA * muA
      const varB = sumBB / n - muB * muB
      const covAB = sumAB / n - muA * muB
      const numerator = (2 * muA * muB + C1) * (2 * covAB + C2)
      const denominator = (muA * muA + muB * muB + C1) * (varA + varB + C2)
      total += denominator === 0 ? 1 : numerator / denominator
      windows++
    }
  }

  // Images smaller than a single window are trivially "identical enough";
  // there is no structure to measure.
  return windows === 0 ? 1 : total / windows
}

/**
 * Mean SSIM over non-overlapping 8x8 windows. Both inputs are rendered to
 * the same dimensions first, so a downscaled candidate is compared against
 * the source as the viewer would actually see it — scaled back up to the
 * same display box — rather than being penalised purely for having fewer
 * pixels.
 */
export function compareSsim(
  reference: CanvasImageSource,
  candidate: CanvasImageSource,
  nativeWidth: number,
  nativeHeight: number,
): number {
  return createSsimComparator(reference, nativeWidth, nativeHeight)(candidate)
}

/**
 * Prepares the reference side once and returns a function that scores
 * candidates against it. A quality search re-scores the *same* source seven
 * or eight times over, and preparing the reference is half the cost of a
 * comparison, so hoisting it out of the loop roughly halves the search.
 */
export function createSsimComparator(
  reference: CanvasImageSource,
  nativeWidth: number,
  nativeHeight: number,
): (candidate: CanvasImageSource) => number {
  const { w, h } = comparisonDims(nativeWidth, nativeHeight)
  const referenceGray = toGray(drawScaled(toFullResCanvas(reference, nativeWidth, nativeHeight), w, h))
  return (candidate: CanvasImageSource) =>
    meanSsim(referenceGray, toGray(drawScaled(toFullResCanvas(candidate, nativeWidth, nativeHeight), w, h)), w, h)
}
