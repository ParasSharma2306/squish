import { canvasToBlob, drawImageToCanvas, loadImage } from './fileUtils'
import { encodeBmp } from './bmpEncode'
import { FORMAT_LABEL, FORMAT_MIME, OPAQUE_FORMATS, QUALITY_TUNABLE_FORMATS, type OutputFormat } from './imageConvert'
import { analyzeSource, type ImageClass } from './imageAnalysis'
import { encodePalettePng, optimisePng } from './pngOptimize'
import { createSsimComparator } from './ssim'
import { makeReport, type CompressReport, type ReportNote } from './compressReport'

export interface CompressResult {
  blob: Blob
  width: number
  height: number
  quality: number | null
  hitTarget: boolean
}

export interface ImageCompressResult {
  blob: Blob
  report: CompressReport
}

/**
 * Two ways to ask for compression, because they answer two different
 * questions. "Target" is the one that gets a file under an upload form's
 * limit — it will trade away quality to get there. "Visual" is the one that
 * makes a file as small as it can be *without* a visible difference, and
 * accepts whatever size that turns out to be.
 */
export type CompressMode =
  | { kind: 'target'; targetBytes: number }
  | { kind: 'visual'; minSsim: number }

/**
 * Named perceptual floors, so the UI never has to show a raw SSIM number.
 *
 * These are set from measured behaviour, not taste. On real photographic
 * content the size/SSIM curve is very steep at the top: reaching 0.995
 * needs a quality high enough that the codec is already near-lossless and
 * barely any bytes come off, while 0.99 still reads as identical and saves
 * a meaningful fraction. Setting the top preset above the knee would make
 * "best quality" mode look broken on exactly the files people care most
 * about. Re-derive with `engine-benchmark.mjs` if the encoder changes.
 */
export const VISUAL_PRESETS = {
  identical: 0.99,
  high: 0.98,
  balanced: 0.965,
} as const

export type VisualPreset = keyof typeof VISUAL_PRESETS

export interface ImageCompressOptions {
  mode: CompressMode
  /** 'auto' routes by image content; anything else is honoured as requested. */
  format: OutputFormat | 'auto'
}

// --- Target-size search tuning (unchanged behaviour from the size-first engine) ---
const PRIMARY_QUALITY = 0.82
const SCALE_STEPS = 6
const MIN_SCALE = 0.15
const MIN_DIMENSION = 16
const MIN_READABLE_QUALITY = 0.35
const FALLBACK_MIN_QUALITY = 0.1

// --- Perceptual search tuning ---
// Quality search bounds for "keep it visually identical". Below ~0.4 no
// amount of SSIM tolerance produces something worth shipping, and above
// 0.96 the file grows fast for no visible gain.
const VISUAL_MIN_QUALITY = 0.4
const VISUAL_MAX_QUALITY = 0.96
const VISUAL_QUALITY_STEPS = 7
/**
 * The quality search runs against a downscaled proxy. Encoding dominates
 * this path — a full-resolution WebP encode of a 4 MP photo costs well over
 * a second, and the search needs eight of them — while the *quality* that
 * clears a given SSIM bar barely moves with resolution. Searching on a
 * ~1 MP proxy and then verifying (and correcting) at full resolution gets
 * the same answer for a fraction of the encoding.
 */
const PROXY_MAX_PIXELS = 1_200_000
/** How far to step quality up when the full-res check lands under the bar. */
const VERIFY_STEP = 0.04
const VERIFY_ATTEMPTS = 3
/** Palette sizes tried, largest first, for flat-colour images. */
const PALETTE_STEPS = [256, 64, 32]

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

  if (file.type === mime && file.size <= targetBytes) {
    return { blob: file, width: nativeW, height: nativeH, quality: null, hitTarget: true }
  }
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

/**
 * Perceptual search for lossy formats: find the *lowest* quality whose
 * measured SSIM against the source still clears `minSsim`. Resolution is
 * deliberately left at native — "visually identical" has to mean the same
 * pixels at the same size, so scale is not a lever this mode is allowed to
 * pull.
 */
async function searchVisualQuality(
  img: HTMLImageElement,
  format: OutputFormat,
  minSsim: number,
): Promise<{ blob: Blob; quality: number; ssim: number } | null> {
  const mime = FORMAT_MIME[format]
  const background = OPAQUE_FORMATS.includes(format) ? '#ffffff' : undefined
  const nativeW = img.naturalWidth
  const nativeH = img.naturalHeight
  const fullCanvas = drawImageToCanvas(img, nativeW, nativeH, background)

  // Proxy used purely to locate the quality; never returned to the caller.
  const proxyRatio = Math.min(1, Math.sqrt(PROXY_MAX_PIXELS / (nativeW * nativeH)))
  const proxyW = Math.max(MIN_DIMENSION, Math.round(nativeW * proxyRatio))
  const proxyH = Math.max(MIN_DIMENSION, Math.round(nativeH * proxyRatio))
  const proxyCanvas = proxyRatio === 1 ? fullCanvas : drawImageToCanvas(img, proxyW, proxyH, background)
  const scoreAgainstProxy = createSsimComparator(proxyCanvas, proxyW, proxyH)
  const scoreAgainstSource = createSsimComparator(img, nativeW, nativeH)

  const probeProxy = async (quality: number) => {
    const blob = await encodeAt(proxyCanvas, format, mime, quality)
    return scoreAgainstProxy(await loadImage(blob))
  }
  const encodeFull = async (quality: number) => {
    const blob = await encodeAt(fullCanvas, format, mime, quality)
    return { blob, quality, ssim: scoreAgainstSource(await loadImage(blob)) }
  }

  // If even the ceiling can't clear the bar, this format simply can't
  // represent the image faithfully; the caller falls back to lossless.
  if ((await probeProxy(VISUAL_MAX_QUALITY)) < minSsim) {
    const ceiling = await encodeFull(VISUAL_MAX_QUALITY)
    return ceiling.ssim >= minSsim ? ceiling : null
  }

  let lo = VISUAL_MIN_QUALITY
  let hi = VISUAL_MAX_QUALITY
  for (let i = 0; i < VISUAL_QUALITY_STEPS; i++) {
    const mid = (lo + hi) / 2
    if ((await probeProxy(mid)) >= minSsim) hi = mid
    else lo = mid
  }

  // `hi` is the lowest proxy quality that cleared the bar. Verify it for
  // real, and walk up if the full-resolution image is fussier than the
  // proxy suggested — the proxy chooses where to look, it never decides.
  let quality = hi
  let best = await encodeFull(quality)
  for (let i = 0; i < VERIFY_ATTEMPTS && best.ssim < minSsim; i++) {
    quality = Math.min(VISUAL_MAX_QUALITY, quality + VERIFY_STEP)
    best = await encodeFull(quality)
    if (quality >= VISUAL_MAX_QUALITY) break
  }
  if (best.ssim < minSsim) return null

  // The proxy is systematically a little pessimistic — a downscaled image
  // loses proportionally more detail at a given quality — so it tends to
  // land above the quality actually needed. Walk back down while the real
  // measurement still clears the bar, to claw back the size that costs.
  for (let i = 0; i < VERIFY_ATTEMPTS && quality > VISUAL_MIN_QUALITY; i++) {
    const lower = Math.max(VISUAL_MIN_QUALITY, quality - VERIFY_STEP)
    const candidate = await encodeFull(lower)
    if (candidate.ssim < minSsim) break
    quality = lower
    best = candidate
  }
  return best
}

/** Palette search for flat images: fewest colours that still clears the SSIM bar. */
async function searchPalette(
  img: HTMLImageElement,
  minSsim: number,
): Promise<{ blob: Blob; colors: number; ssim: number } | null> {
  const nativeW = img.naturalWidth
  const nativeH = img.naturalHeight
  const scoreAgainstSource = createSsimComparator(img, nativeW, nativeH)
  let best: { blob: Blob; colors: number; ssim: number } | null = null

  for (const colors of PALETTE_STEPS) {
    const result = await encodePalettePng(img, nativeW, nativeH, colors)
    const ssim = scoreAgainstSource(result.canvas)
    // Fewer colours can only score worse, so the first failure ends the search.
    if (ssim < minSsim) break
    if (!best || result.blob.size < best.blob.size) best = { blob: result.blob, colors: result.colors, ssim }
  }
  if (!best) return null

  // Only the winner is worth oxipng's time.
  const optimised = await optimisePng(await best.blob.arrayBuffer())
  return { ...best, blob: new Blob([optimised], { type: 'image/png' }) }
}

/** Lossless re-encode: PNG through oxipng, pixels untouched. */
async function losslessPng(img: HTMLImageElement): Promise<Blob> {
  const canvas = drawImageToCanvas(img, img.naturalWidth, img.naturalHeight)
  const encoded = await canvasToBlob(canvas, 'image/png')
  const optimised = await optimisePng(await encoded.arrayBuffer())
  return new Blob([optimised], { type: 'image/png' })
}

/** Content-driven format choice when the user hasn't pinned one. */
function autoFormat(imageClass: ImageClass): OutputFormat {
  // Flat art and bilevel scans stay lossless; WebP is the broadly-supported
  // choice for photographs.
  return imageClass === 'photo' ? 'webp' : 'png'
}

/**
 * The single entry point the UI calls. Routes by content and mode, and
 * always reports what it actually did — including deciding to leave the
 * file alone, which is the right answer more often than it sounds.
 */
export async function compressImage(
  file: File,
  options: ImageCompressOptions,
): Promise<ImageCompressResult> {
  const img = await loadImage(file)
  const nativeW = img.naturalWidth
  const nativeH = img.naturalHeight
  const stats = analyzeSource(img, nativeW, nativeH)
  const format = options.format === 'auto' ? autoFormat(stats.imageClass) : options.format

  const baseNotes: ReportNote[] = [
    { label: 'Detected', value: stats.imageClass === 'photo' ? 'Photographic' : stats.imageClass === 'flat' ? 'Flat colour / screenshot' : 'Bilevel / scanned' },
    { label: 'Dimensions', value: `${nativeW} × ${nativeH}` },
  ]

  const keepOriginal = (reason: string): ImageCompressResult => ({
    blob: file,
    report: makeReport({
      originalBytes: file.size,
      newBytes: file.size,
      technique: 'untouched',
      formatLabel: file.type.split('/')[1]?.toUpperCase() ?? 'Original',
      notes: [...baseNotes, { label: 'Why', value: reason }],
      hitTarget: options.mode.kind === 'target' ? file.size <= options.mode.targetBytes : null,
      width: nativeW,
      height: nativeH,
    }),
  })

  if (options.mode.kind === 'target') {
    const result = await compressImageToTarget(file, options.mode.targetBytes, format)
    if (result.blob.size >= file.size) return keepOriginal('Re-encoding would have made it larger')
    const notes: ReportNote[] = [...baseNotes]
    if (result.width !== nativeW || result.height !== nativeH) {
      notes.push({ label: 'Resized to', value: `${result.width} × ${result.height}` })
    }
    if (result.quality !== null) {
      notes.push({ label: 'Quality', value: `${Math.round(result.quality * 100)}%` })
    }
    return {
      blob: result.blob,
      report: makeReport({
        originalBytes: file.size,
        newBytes: result.blob.size,
        technique: 'lossy-resample',
        formatLabel: FORMAT_LABEL[format],
        notes,
        hitTarget: result.hitTarget,
        width: result.width,
        height: result.height,
      }),
    }
  }

  const minSsim = options.mode.minSsim

  // Flat and bilevel content: palette reduction first, plain lossless as
  // the floor. Both are compared against the original before shipping.
  if (stats.imageClass !== 'photo' && (format === 'png' || options.format === 'auto')) {
    const palette = await searchPalette(img, minSsim)
    const lossless = await losslessPng(img)
    const candidates: { blob: Blob; technique: 'palette-png' | 'lossless-png'; notes: ReportNote[]; ssim: number }[] = []
    if (palette) {
      candidates.push({
        blob: palette.blob,
        technique: 'palette-png',
        notes: [{ label: 'Palette', value: `${palette.colors} colours` }, { label: 'Optimiser', value: 'oxipng' }],
        ssim: palette.ssim,
      })
    }
    candidates.push({
      blob: lossless,
      technique: 'lossless-png',
      notes: [{ label: 'Pixels', value: 'Bit-for-bit identical' }, { label: 'Optimiser', value: 'oxipng' }],
      ssim: 1,
    })

    const winner = candidates.reduce((a, b) => (b.blob.size < a.blob.size ? b : a))
    if (winner.blob.size >= file.size) return keepOriginal('Already smaller than anything we could re-encode')
    return {
      blob: winner.blob,
      report: makeReport({
        originalBytes: file.size,
        newBytes: winner.blob.size,
        technique: winner.technique,
        formatLabel: 'PNG',
        notes: [...baseNotes, ...winner.notes],
        ssim: winner.ssim,
        width: nativeW,
        height: nativeH,
      }),
    }
  }

  if (!QUALITY_TUNABLE_FORMATS.includes(format)) {
    // PNG/BMP requested for a photo: lossless is the only honest option.
    const lossless = format === 'png' ? await losslessPng(img) : await encodeAt(drawImageToCanvas(img, nativeW, nativeH, '#ffffff'), 'bmp', FORMAT_MIME.bmp)
    if (lossless.size >= file.size) return keepOriginal('Lossless re-encode was no smaller')
    return {
      blob: lossless,
      report: makeReport({
        originalBytes: file.size,
        newBytes: lossless.size,
        technique: 'lossless-png',
        formatLabel: FORMAT_LABEL[format],
        notes: [...baseNotes, { label: 'Pixels', value: 'Bit-for-bit identical' }],
        ssim: 1,
        width: nativeW,
        height: nativeH,
      }),
    }
  }

  const visual = await searchVisualQuality(img, format, minSsim)
  if (!visual) return keepOriginal(`Could not reach the quality floor in ${FORMAT_LABEL[format]}`)
  if (visual.blob.size >= file.size) return keepOriginal('Already smaller than a visually-identical re-encode')

  return {
    blob: visual.blob,
    report: makeReport({
      originalBytes: file.size,
      newBytes: visual.blob.size,
      technique: 'lossy-resample',
      formatLabel: FORMAT_LABEL[format],
      notes: [
        ...baseNotes,
        { label: 'Quality', value: `${Math.round(visual.quality * 100)}%` },
        { label: 'Similarity', value: `${(visual.ssim * 100).toFixed(2)}% SSIM` },
      ],
      ssim: visual.ssim,
      width: nativeW,
      height: nativeH,
    }),
  }
}
