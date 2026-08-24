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

// JPEG/WebP/AVIF quality is held fixed here for the primary pass; the
// binary search only varies how much the image is downsampled. A modest
// resolution cut is visually free on-screen, whereas quality artifacts
// (blocking, smearing — especially bad for screenshots/diagrams/text) show
// up fast once quality drops much below this, so scale is the first lever.
const PRIMARY_QUALITY = 0.82
const SCALE_STEPS = 6
const MIN_SCALE = 0.15
const MIN_DIMENSION = 16

// Secondary fallback once downsampling to the floor still can't hit the
// target: start trading quality away too, but stay above the point where
// artifacts get obviously ugly.
const MIN_READABLE_QUALITY = 0.35
// Absolute last resort if even the readable floor at minimum scale can't
// hit the target, so an aggressive target is still honored as closely as
// possible instead of just giving up.
const FALLBACK_MIN_QUALITY = 0.1

function encodeAt(canvas: HTMLCanvasElement, format: OutputFormat, mime: string, quality?: number) {
  if (format === 'bmp') return Promise.resolve(encodeBmp(canvas))
  return canvasToBlob(canvas, mime, quality)
}

function scaledDims(width: number, height: number, scale: number): { w: number; h: number } {
  return {
    w: Math.max(MIN_DIMENSION, Math.round(width * scale)),
    h: Math.max(MIN_DIMENSION, Math.round(height * scale)),
  }
}

/**
 * For JPEG/WebP/AVIF: quality is held fixed and the image is downsampled
 * (largest first) via binary search until it fits the target. Only if the
 * minimum scale still overshoots does a secondary quality search kick in.
 * PNG and BMP have no quality knob, so downscaling is their only lever.
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
  const nativeW = img.naturalWidth
  const nativeH = img.naturalHeight

  // Already small enough in the requested format. Return as-is rather than
  // re-encoding, which could (for lossless/near-lossless cases) make it bigger.
  if (file.type === mime && file.size <= targetBytes) {
    return { blob: file, width: nativeW, height: nativeH, quality: null, hitTarget: true }
  }
  // Never intentionally produce an output bigger than the original. If the
  // requested target exceeds the source size, treat the source size as the
  // real ceiling so the search can't converge on a "successful" upsize.
  const effectiveTarget = Math.min(targetBytes, file.size)

  async function encodeScale(scale: number, quality: number | undefined) {
    const { w, h } = scaledDims(nativeW, nativeH, scale)
    const canvas = drawImageToCanvas(img, w, h, background)
    const blob = await encodeAt(canvas, format, mime, quality)
    return { blob, width: w, height: h }
  }

  let smallest: CompressResult | null = null
  function track(candidate: CompressResult) {
    if (!smallest || candidate.blob.size < smallest.blob.size) smallest = candidate
  }

  if (supportsQuality) {
    // Primary: fixed quality, binary search scale.
    const floor = await encodeScale(MIN_SCALE, PRIMARY_QUALITY)
    const floorResult: CompressResult = {
      blob: floor.blob,
      width: floor.width,
      height: floor.height,
      quality: PRIMARY_QUALITY,
      hitTarget: floor.blob.size <= effectiveTarget,
    }
    track(floorResult)

    if (floor.blob.size <= effectiveTarget) {
      let best = floorResult
      let lo = MIN_SCALE
      let hi = 1
      for (let i = 0; i < SCALE_STEPS; i++) {
        const mid = (lo + hi) / 2
        const attempt = await encodeScale(mid, PRIMARY_QUALITY)
        if (attempt.blob.size <= effectiveTarget) {
          best = { blob: attempt.blob, width: attempt.width, height: attempt.height, quality: PRIMARY_QUALITY, hitTarget: true }
          lo = mid
        } else {
          hi = mid
        }
      }
      return best
    }

    // Secondary: minimum scale still overshoots — trade quality away too,
    // bounded by a readable floor, then an absolute last-resort floor.
    let lo = MIN_READABLE_QUALITY
    let hi = PRIMARY_QUALITY
    const readableFloor = await encodeScale(MIN_SCALE, MIN_READABLE_QUALITY)
    const readableFloorResult: CompressResult = {
      blob: readableFloor.blob,
      width: readableFloor.width,
      height: readableFloor.height,
      quality: MIN_READABLE_QUALITY,
      hitTarget: readableFloor.blob.size <= effectiveTarget,
    }
    track(readableFloorResult)

    if (readableFloor.blob.size <= effectiveTarget) {
      let best = readableFloorResult
      for (let i = 0; i < SCALE_STEPS; i++) {
        const mid = (lo + hi) / 2
        const attempt = await encodeScale(MIN_SCALE, mid)
        if (attempt.blob.size <= effectiveTarget) {
          best = { blob: attempt.blob, width: attempt.width, height: attempt.height, quality: mid, hitTarget: true }
          lo = mid
        } else {
          hi = mid
        }
      }
      return best
    }

    // Absolute last resort: drop below the readable floor to get as close
    // to an aggressive target as possible. hitTarget stays reflective of
    // whether this actually lands under budget.
    lo = 0
    hi = MIN_READABLE_QUALITY
    let best = readableFloorResult
    for (let i = 0; i < SCALE_STEPS; i++) {
      const q = Math.max(FALLBACK_MIN_QUALITY, (lo + hi) / 2)
      const attempt = await encodeScale(MIN_SCALE, q)
      const candidate: CompressResult = {
        blob: attempt.blob,
        width: attempt.width,
        height: attempt.height,
        quality: q,
        hitTarget: attempt.blob.size <= effectiveTarget,
      }
      track(candidate)
      if (candidate.hitTarget) return candidate
      if (candidate.blob.size < best.blob.size) best = candidate
      hi = q
      if (q <= FALLBACK_MIN_QUALITY) break
    }
    return smallest ?? best
  }

  // PNG / BMP: no quality knob, downscale until it fits.
  let width = nativeW
  let height = nativeH
  for (let s = 0; s < SCALE_STEPS + 4; s++) {
    const canvas = drawImageToCanvas(img, width, height, background)
    const blob = await encodeAt(canvas, format, mime)
    const candidate: CompressResult = { blob, width, height, quality: null, hitTarget: blob.size <= effectiveTarget }
    track(candidate)
    if (candidate.hitTarget) return candidate
    width = Math.round(width * 0.82)
    height = Math.round(height * 0.82)
    if (width < MIN_DIMENSION || height < MIN_DIMENSION) break
  }

  return smallest!
}
