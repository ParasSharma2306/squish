import { canvasToBlob, drawImageToCanvas, loadImage } from './fileUtils'
import { encodeBmp } from './bmpEncode'
import { FORMAT_MIME, OPAQUE_FORMATS, QUALITY_TUNABLE_FORMATS, type OutputFormat } from './imageConvert'

export interface CompressResult {
  blob: Blob
  width: number
  height: number
  quality: number | null
  hitTarget: boolean
}

const QUALITY_STEPS = 8
const SCALE_STEPS = 6
const SCALE_FACTOR = 0.82

// JPEG/WebP/AVIF quality below this starts producing visible blocking and
// smearing, which is especially bad for screenshots, diagrams, and anything
// with text in it. The primary search never goes below this and downscales
// instead, since a smaller image at moderate quality reads far better than
// a full-size image crushed to near-zero quality for the same byte budget.
const MIN_READABLE_QUALITY = 0.35
// Absolute last resort if even the smallest reasonable size can't hit the
// target at the readable floor, so an aggressive target is still honored as
// closely as possible instead of just giving up.
const FALLBACK_MIN_QUALITY = 0.1
const MIN_DIMENSION = 16

function encodeAt(canvas: HTMLCanvasElement, format: OutputFormat, mime: string, quality?: number) {
  if (format === 'bmp') return Promise.resolve(encodeBmp(canvas))
  return canvasToBlob(canvas, mime, quality)
}

/**
 * Binary-searches quality within [minQuality, 1]. `result` is set only if
 * minQuality itself fit; `floorAttempt` is always returned so callers can
 * track a "closest so far" baseline even when this scale never fits.
 */
async function searchQuality(
  canvas: HTMLCanvasElement,
  format: OutputFormat,
  mime: string,
  targetBytes: number,
  minQuality: number,
  width: number,
  height: number,
): Promise<{ result: CompressResult | null; floorAttempt: CompressResult }> {
  const floorBlob = await encodeAt(canvas, format, mime, minQuality)
  const floorAttempt: CompressResult = {
    blob: floorBlob,
    width,
    height,
    quality: minQuality,
    hitTarget: floorBlob.size <= targetBytes,
  }
  if (floorBlob.size > targetBytes) return { result: null, floorAttempt }

  let lo = minQuality
  let hi = 1
  let best: CompressResult = floorAttempt

  for (let i = 0; i < QUALITY_STEPS; i++) {
    const q = (lo + hi) / 2
    const blob = await encodeAt(canvas, format, mime, q)
    if (blob.size <= targetBytes) {
      best = { blob, width, height, quality: q, hitTarget: true }
      lo = q
    } else {
      hi = q
    }
  }

  return { result: best, floorAttempt }
}

/**
 * For JPEG/WebP/AVIF, quality is binary-searched within a readable floor at
 * each resolution (largest first); only once the floor itself can't fit the
 * target does the image get downscaled and the search repeat. PNG and BMP
 * have no quality knob, so the downscale loop is their only lever.
 */
export async function compressImageToTarget(
  file: File,
  targetBytes: number,
  format: OutputFormat,
): Promise<CompressResult> {
  const img = await loadImage(file)
  const mime = FORMAT_MIME[format]
  const supportsQuality = QUALITY_TUNABLE_FORMATS.includes(format)
  const background = OPAQUE_FORMATS.includes(format) ? '#ffffff' : undefined

  // Already small enough in the requested format. Return as-is rather than
  // re-encoding, which could (for lossless/near-lossless cases) make it bigger.
  if (file.type === mime && file.size <= targetBytes) {
    return { blob: file, width: img.naturalWidth, height: img.naturalHeight, quality: null, hitTarget: true }
  }
  // Never intentionally produce an output bigger than the original. If the
  // requested target exceeds the source size, treat the source size as the
  // real ceiling so the search can't converge on a "successful" upsize.
  const effectiveTarget = Math.min(targetBytes, file.size)

  let width = img.naturalWidth
  let height = img.naturalHeight
  let smallest: CompressResult | null = null

  for (let s = 0; s < SCALE_STEPS; s++) {
    const canvas = drawImageToCanvas(img, width, height, background)

    if (supportsQuality) {
      const { result, floorAttempt } = await searchQuality(
        canvas,
        format,
        mime,
        effectiveTarget,
        MIN_READABLE_QUALITY,
        width,
        height,
      )
      if (!smallest || floorAttempt.blob.size < smallest.blob.size) smallest = floorAttempt
      if (result) return result
    } else {
      const blob = await encodeAt(canvas, format, mime)
      const candidate: CompressResult = { blob, width, height, quality: null, hitTarget: blob.size <= effectiveTarget }
      if (!smallest || blob.size < smallest.blob.size) smallest = candidate
      if (blob.size <= effectiveTarget) return candidate
    }

    width = Math.round(width * SCALE_FACTOR)
    height = Math.round(height * SCALE_FACTOR)
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) break
  }

  // Last resort for quality-tunable formats: the readable floor couldn't hit
  // the target at any scale, so drop the quality floor at the smallest size
  // tried so far to get as close as possible. hitTarget stays false so the
  // UI shows "closest possible" rather than claiming success.
  if (supportsQuality) {
    const canvas = drawImageToCanvas(img, width, height, background)
    let lo = 0
    let hi = MIN_READABLE_QUALITY
    for (let i = 0; i < QUALITY_STEPS; i++) {
      const q = Math.max(FALLBACK_MIN_QUALITY, (lo + hi) / 2)
      const blob = await encodeAt(canvas, format, mime, q)
      const candidate: CompressResult = { blob, width, height, quality: q, hitTarget: blob.size <= effectiveTarget }
      if (!smallest || blob.size < smallest.blob.size) smallest = candidate
      if (blob.size <= effectiveTarget) return candidate
      hi = q
      if (q <= FALLBACK_MIN_QUALITY) break
    }
  }

  return smallest!
}
