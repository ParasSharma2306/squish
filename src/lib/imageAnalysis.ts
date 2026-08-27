/**
 * Cheap content classification, used to route an image to the compression
 * path that actually suits it. A screenshot and a photograph want opposite
 * treatment: lossy codecs smear the crisp edges and flat fills that make a
 * screenshot readable, while palette+PNG is wasteful nonsense on a photo.
 */

export type ImageClass = 'photo' | 'flat' | 'bilevel'

export interface ImageStats {
  imageClass: ImageClass
  /** Distinct colours found while sampling, capped at [UNIQUE_CAP]. */
  uniqueColors: number
  /** 0-1: share of sampled pixels identical to the pixel on their left. */
  flatness: number
  /** 0-1: share of sampled pixels sitting at the near-black or near-white extremes. */
  extremeRatio: number
}

// Sampling stops caring about exact counts past this; anything above it is
// unambiguously photographic as far as the routing decision goes.
const UNIQUE_CAP = 4096
// Keep the scan bounded regardless of source resolution.
const MAX_SAMPLES = 200_000

const FLAT_MIN_FLATNESS = 0.45
const FLAT_MAX_COLORS = 3072
const BILEVEL_MIN_EXTREME = 0.9
const NEAR_BLACK = 40
const NEAR_WHITE = 215

export function analyzeImageData(data: Uint8ClampedArray, width: number, height: number): ImageStats {
  const pixels = width * height
  const stride = Math.max(1, Math.floor(pixels / MAX_SAMPLES))

  const seen = new Set<number>()
  let sampled = 0
  let flatMatches = 0
  let extremes = 0
  let previous = -1

  for (let p = 0; p < pixels; p += stride) {
    const i = p * 4
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const packed = (r << 16) | (g << 8) | b
    if (seen.size < UNIQUE_CAP) seen.add(packed)

    if (previous === packed) flatMatches++
    previous = packed

    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    if (luma <= NEAR_BLACK || luma >= NEAR_WHITE) extremes++
    sampled++
  }

  const flatness = sampled > 0 ? flatMatches / sampled : 0
  const extremeRatio = sampled > 0 ? extremes / sampled : 0
  const uniqueColors = seen.size

  let imageClass: ImageClass = 'photo'
  if (extremeRatio >= BILEVEL_MIN_EXTREME && uniqueColors < UNIQUE_CAP) imageClass = 'bilevel'
  else if (flatness >= FLAT_MIN_FLATNESS && uniqueColors <= FLAT_MAX_COLORS) imageClass = 'flat'

  return { imageClass, uniqueColors, flatness, extremeRatio }
}

/** Reads pixels off a drawable source (downscaled if huge) and classifies it. */
export function analyzeSource(source: CanvasImageSource, width: number, height: number): ImageStats {
  const longEdge = Math.max(width, height)
  // 1024 is plenty to characterise content; going bigger only costs time.
  const ratio = longEdge > 1024 ? 1024 / longEdge : 1
  const w = Math.max(1, Math.round(width * ratio))
  const h = Math.max(1, Math.round(height * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(source, 0, 0, w, h)
  return analyzeImageData(ctx.getImageData(0, 0, w, h).data, w, h)
}

/**
 * Otsu's method: picks the luma threshold that best separates a bilevel
 * scan's ink from its paper, rather than assuming a fixed midpoint (real
 * scans are rarely centred on 128 — yellowed paper and grey ink both shift
 * the histogram).
 */
export function otsuThreshold(data: Uint8ClampedArray): number {
  const histogram = new Uint32Array(256)
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    const luma = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0
    histogram[luma]++
    count++
  }
  if (count === 0) return 128

  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * histogram[t]

  let sumBackground = 0
  let weightBackground = 0
  let best = 0
  let bestVariance = -1
  for (let t = 0; t < 256; t++) {
    weightBackground += histogram[t]
    if (weightBackground === 0) continue
    const weightForeground = count - weightBackground
    if (weightForeground === 0) break
    sumBackground += t * histogram[t]
    const meanBackground = sumBackground / weightBackground
    const meanForeground = (sum - sumBackground) / weightForeground
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2
    if (variance > bestVariance) {
      bestVariance = variance
      best = t
    }
  }
  return best
}

/** Thresholds a drawable into a packed "true = black ink" bitmap for CCITT coding. */
export function toBilevelBitmap(source: CanvasImageSource, width: number, height: number): Uint8Array {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(source, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const threshold = otsuThreshold(data)
  const bitmap = new Uint8Array(width * height)
  for (let i = 0, p = 0; p < bitmap.length; i += 4, p++) {
    const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    bitmap[p] = luma <= threshold ? 1 : 0
  }
  return bitmap
}
