import { PDFDocument } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { canvasToBlob } from './fileUtils'
import { loadPdfDocument } from './pdfSetup'
import { decodeCandidateImages, type DecodedImage } from './pdfImageExtract'
import { analyzeSource, toBilevelBitmap } from './imageAnalysis'
import { encodeCcittG4 } from './ccittG4'
import { makeReport, type CompressReport, type ReportNote } from './compressReport'
import {
  dedupeFonts,
  dedupeImages,
  findCandidateImages,
  removeUnreferencedObjects,
  stripMetadata,
  swapImage,
  swapImageCcitt,
  type ImageCandidate,
} from './pdfStructure'

export interface PdfCompressResult {
  bytes: Uint8Array
  hitTarget: boolean
  pageCount: number
  report: CompressReport
}

export interface PdfCompressProgress {
  stage: 'rendering' | 'searching' | 'finalising'
  detail: string
}

/**
 * Target mode drives toward a byte budget. Visual mode instead caps
 * resolution at a DPI that suits how the document will actually be used,
 * and otherwise only removes redundancy — no quality search, no guessing.
 */
export type PdfCompressMode =
  | { kind: 'target'; targetBytes: number }
  | { kind: 'visual'; maxDpi: number }

/** DPI ceilings by intended use. Source files routinely carry far more than either. */
export const DPI_PRESETS = {
  screen: 150,
  print: 300,
} as const

export type DpiPreset = keyof typeof DPI_PRESETS

const PRIMARY_QUALITY = 0.82
/** Quality used in visual mode, where there is no size budget to trade against. */
const VISUAL_QUALITY = 0.88

const MIN_LONG_EDGE = 220
const MIN_SCALE = 0.05
const SCALE_STEPS = 8

const FALLBACK_MIN_QUALITY = 0.3
const FALLBACK_QUALITY_STEPS = 6

const ESTIMATE_SAFETY_MARGIN = 0.99

function scaledDims(nativeW: number, nativeH: number, scale: number, minLongEdge: number): { w: number; h: number } {
  const longEdge = Math.max(nativeW, nativeH)
  const floorEdge = Math.min(longEdge, minLongEdge)
  const effectiveEdge = Math.max(longEdge * scale, floorEdge)
  const ratio = effectiveEdge / longEdge
  return { w: Math.max(1, Math.round(nativeW * ratio)), h: Math.max(1, Math.round(nativeH * ratio)) }
}

/**
 * The resolution an image is actually being displayed at, in DPI. Returns
 * null when the placement is unknown, in which case no DPI ceiling can be
 * applied — guessing here would risk destroying an image that was correctly
 * sized to begin with.
 */
function effectiveDpi(decoded: DecodedImage): number | null {
  if (!decoded.displayedWidthPt || !decoded.displayedHeightPt) return null
  const horizontal = decoded.width / (decoded.displayedWidthPt / 72)
  const vertical = decoded.height / (decoded.displayedHeightPt / 72)
  return Math.max(horizontal, vertical)
}

/** Scale factor that brings an over-provisioned image down to `maxDpi`, else 1. */
function dpiScale(decoded: DecodedImage, maxDpi: number): number {
  const dpi = effectiveDpi(decoded)
  if (dpi === null || dpi <= maxDpi) return 1
  return maxDpi / dpi
}

interface EncodedImage {
  bytes: Uint8Array
  width: number
  height: number
  /** Set when the image was coded as bilevel CCITT rather than JPEG. */
  bilevel?: boolean
}

function drawScaled(decoded: DecodedImage, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(decoded.source, 0, 0, w, h)
  return canvas
}

async function encodeJpeg(decoded: DecodedImage, w: number, h: number, quality: number): Promise<EncodedImage> {
  const canvas = drawScaled(decoded, w, h)
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h }
}

/**
 * Codes a scanned/bilevel image losslessly with CCITT Group 4, but only
 * keeps it if it actually beats the JPEG the image would otherwise get.
 * Group 4 is a huge win on clean scanned text and a loss on anything noisy
 * or dithered, so the decision is made by measurement, not by the
 * classifier alone.
 */
async function encodeBilevel(decoded: DecodedImage, w: number, h: number, quality: number): Promise<EncodedImage> {
  const bitmap = toBilevelBitmap(decoded.source, w, h)
  const ccitt = encodeCcittG4(bitmap, w, h)
  const jpeg = await encodeJpeg(decoded, w, h, quality)
  return ccitt.length < jpeg.bytes.length ? { bytes: ccitt, width: w, height: h, bilevel: true } : jpeg
}

interface CandidatePlan {
  decoded: DecodedImage
  /** Native dimensions after the DPI ceiling, before any search scaling. */
  baseW: number
  baseH: number
  isBilevel: boolean
}

/**
 * Classifies each embedded image once and pre-applies the DPI ceiling, so
 * the size search never has to re-do either.
 */
function planCandidates(decoded: Map<string, DecodedImage>, maxDpi: number): Map<string, CandidatePlan> {
  const plans = new Map<string, CandidatePlan>()
  for (const [key, image] of decoded) {
    const ratio = dpiScale(image, maxDpi)
    const { w, h } = scaledDims(image.width, image.height, ratio, MIN_LONG_EDGE)
    const stats = analyzeSource(image.source, image.width, image.height)
    plans.set(key, { decoded: image, baseW: w, baseH: h, isBilevel: stats.imageClass === 'bilevel' })
  }
  return plans
}

async function encodePlan(plan: CandidatePlan, scale: number, quality: number): Promise<EncodedImage> {
  const { w, h } = scaledDims(plan.baseW, plan.baseH, scale, MIN_LONG_EDGE)
  return plan.isBilevel
    ? encodeBilevel(plan.decoded, w, h, quality)
    : encodeJpeg(plan.decoded, w, h, quality)
}

async function encodeAllPlans(
  plans: Map<string, CandidatePlan>,
  scale: number,
  quality: number,
): Promise<Map<string, EncodedImage>> {
  const entries = await Promise.all(
    Array.from(plans, async ([key, plan]) => [key, await encodePlan(plan, scale, quality)] as const),
  )
  return new Map(entries)
}

function applyEncoded(pdfDoc: PDFDocument, candidates: Map<string, ImageCandidate>, encoded: Map<string, EncodedImage>) {
  for (const [key, enc] of encoded) {
    const candidate = candidates.get(key)
    if (!candidate) continue
    if (enc.bilevel) swapImageCcitt(pdfDoc, candidate.ref, enc.bytes, enc.width, enc.height)
    else swapImage(pdfDoc, candidate.ref, enc.bytes, enc.width, enc.height)
  }
}

/**
 * Binary-searches a single scalar `measure` for the largest value in
 * [lo, hi] whose measured size still fits `target`, assuming size increases
 * monotonically with the value (true for both scale and JPEG quality).
 */
async function binarySearchParam(
  measure: (value: number) => Promise<number>,
  lo: number,
  hi: number,
  steps: number,
  target: number,
): Promise<{ fits: boolean; value: number; size: number }> {
  const floorSize = await measure(lo)
  if (floorSize > target) return { fits: false, value: lo, size: floorSize }

  let bestValue = lo
  let bestSize = floorSize
  let a = lo
  let b = hi
  for (let i = 0; i < steps; i++) {
    const mid = (a + b) / 2
    const size = await measure(mid)
    if (size <= target) {
      bestValue = mid
      bestSize = size
      a = mid
    } else {
      b = mid
    }
  }
  return { fits: true, value: bestValue, size: bestSize }
}

// --- Whole-page rasterization, the last-resort fallback for PDFs with no
// recompressible images or a target the image pass alone can't reach. It
// rebuilds every page as one JPEG, which loses text selectability.

const RASTER_PRIMARY_QUALITY = 0.75
const RASTER_MIN_QUALITY = 0.3
const RASTER_MIN_SCALE = 0.08
const RASTER_MIN_LONG_EDGE = 220
const RASTER_SCALE_STEPS = 8
const RASTER_QUALITY_STEPS = 6

async function renderPages(doc: PDFDocumentProxy, scale: number): Promise<HTMLCanvasElement[]> {
  const canvases: HTMLCanvasElement[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, viewport, canvas }).promise
    canvases.push(canvas)
    page.cleanup()
  }
  return canvases
}

type RasterPageAttempt = EncodedImage

async function encodeRasterAttempt(base: HTMLCanvasElement[], scale: number, quality: number): Promise<RasterPageAttempt[]> {
  return Promise.all(
    base.map(async (canvas) => {
      const { w, h } = scaledDims(canvas.width, canvas.height, scale, RASTER_MIN_LONG_EDGE)
      const resized = document.createElement('canvas')
      resized.width = w
      resized.height = h
      resized.getContext('2d')!.drawImage(canvas, 0, 0, w, h)
      const blob = await canvasToBlob(resized, 'image/jpeg', quality)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      return { bytes, width: w, height: h }
    }),
  )
}

async function buildRasterPdf(attempt: RasterPageAttempt[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (const page of attempt) {
    const embedded = await pdf.embedJpg(page.bytes)
    const pdfPage = pdf.addPage([page.width, page.height])
    pdfPage.drawImage(embedded, { x: 0, y: 0, width: page.width, height: page.height })
  }
  return pdf.save()
}

async function rasterizeFallback(
  data: Uint8Array,
  targetBytes: number,
  onProgress?: (p: PdfCompressProgress) => void,
): Promise<{ bytes: Uint8Array; hitTarget: boolean }> {
  const doc = await loadPdfDocument(data.slice())
  const baseScale = doc.numPages > 15 ? 1 : 1.5
  onProgress?.({ stage: 'rendering', detail: `Rendering ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` })
  const base = await renderPages(doc, baseScale)

  const estimateTarget = targetBytes * ESTIMATE_SAFETY_MARGIN
  const sumBytes = (attempt: RasterPageAttempt[]) => attempt.reduce((sum, p) => sum + p.bytes.length, 0)

  const measureScale = async (scale: number) => {
    onProgress?.({ stage: 'searching', detail: `Trying page scale ${Math.round(scale * 100)}%` })
    return sumBytes(await encodeRasterAttempt(base, scale, RASTER_PRIMARY_QUALITY))
  }
  const scaleResult = await binarySearchParam(measureScale, RASTER_MIN_SCALE, 1, RASTER_SCALE_STEPS, estimateTarget)

  let finalScale = scaleResult.value
  let finalQuality = RASTER_PRIMARY_QUALITY
  let hitTarget = scaleResult.fits

  if (!scaleResult.fits) {
    const measureQuality = async (quality: number) => {
      onProgress?.({ stage: 'searching', detail: `Trying page quality ${Math.round(quality * 100)}%` })
      return sumBytes(await encodeRasterAttempt(base, RASTER_MIN_SCALE, quality))
    }
    const qualityResult = await binarySearchParam(
      measureQuality,
      RASTER_MIN_QUALITY,
      RASTER_PRIMARY_QUALITY,
      RASTER_QUALITY_STEPS,
      estimateTarget,
    )
    finalScale = RASTER_MIN_SCALE
    finalQuality = qualityResult.fits ? qualityResult.value : RASTER_MIN_QUALITY
    hitTarget = qualityResult.fits
  }

  const finalAttempt = await encodeRasterAttempt(base, finalScale, finalQuality)
  const bytes = await buildRasterPdf(finalAttempt)
  return { bytes, hitTarget: hitTarget && bytes.length <= targetBytes }
}

/**
 * Compresses a PDF by rewriting its embedded images in place and stripping
 * structural redundancy, leaving page structure, vector content and text
 * untouched and selectable.
 *
 * Images are handled according to what they are: scanned/bilevel pages are
 * thresholded and coded losslessly with CCITT Group 4, photographs are
 * downsampled to a sensible DPI for how they are actually placed on the
 * page and re-encoded as JPEG. Duplicate images and duplicate embedded font
 * programs are merged, metadata and thumbnails are dropped, and the file is
 * rebuilt with object streams. Whole-page rasterization is used only when
 * none of that is enough.
 */
export async function compressPdf(
  file: File,
  mode: PdfCompressMode,
  onProgress?: (p: PdfCompressProgress) => void,
): Promise<PdfCompressResult> {
  const data = new Uint8Array(await file.arrayBuffer())
  const originalBytes = file.size
  const notes: ReportNote[] = []

  const finish = (
    bytes: Uint8Array,
    pageCount: number,
    hitTarget: boolean,
    technique: CompressReport['technique'],
    formatLabel: string,
    extraNotes: ReportNote[] = [],
  ): PdfCompressResult => ({
    bytes,
    hitTarget,
    pageCount,
    report: makeReport({
      originalBytes,
      newBytes: bytes.length,
      technique,
      formatLabel,
      notes: [{ label: 'Pages', value: String(pageCount) }, ...notes, ...extraNotes],
      hitTarget: mode.kind === 'target' ? hitTarget : null,
    }),
  })

  if (mode.kind === 'target' && file.size <= mode.targetBytes) {
    const doc = await loadPdfDocument(data.slice())
    return finish(data, doc.numPages, true, 'untouched', 'PDF', [
      { label: 'Why', value: 'Already under the target size' },
    ])
  }
  const effectiveTarget = mode.kind === 'target' ? Math.min(mode.targetBytes, file.size) : Infinity

  let pdfDoc: PDFDocument | null = null
  try {
    pdfDoc = await PDFDocument.load(data, { updateMetadata: false })
  } catch {
    pdfDoc = null
  }

  // Malformed/encrypted PDFs pdf-lib can't load: fall back to the
  // rasterization path, which only needs pdf.js.
  if (!pdfDoc) {
    const doc = await loadPdfDocument(data.slice())
    const pageCount = doc.numPages
    if (mode.kind === 'visual') {
      return finish(data, pageCount, true, 'untouched', 'PDF', [
        { label: 'Why', value: 'File could not be rewritten safely' },
      ])
    }
    const result = await rasterizeFallback(data, effectiveTarget, onProgress)
    return finish(result.bytes, pageCount, result.hitTarget, 'pdf-rasterize', 'JPEG pages')
  }

  const pageCount = pdfDoc.getPages().length
  stripMetadata(pdfDoc)
  notes.push({ label: 'Metadata', value: 'Info, XMP and thumbnails stripped' })

  const rawCandidates = findCandidateImages(pdfDoc)
  const candidates = dedupeImages(pdfDoc, rawCandidates)
  const duplicateImages = rawCandidates.size - candidates.size
  if (duplicateImages > 0) {
    notes.push({ label: 'Duplicate images', value: `${duplicateImages} merged` })
  }

  const mergedFonts = dedupeFonts(pdfDoc)
  if (mergedFonts > 0) notes.push({ label: 'Duplicate fonts', value: `${mergedFonts} merged` })

  let decoded = new Map<string, DecodedImage>()
  if (candidates.size > 0) {
    onProgress?.({
      stage: 'rendering',
      detail: `Extracting ${candidates.size} embedded image${candidates.size === 1 ? '' : 's'}`,
    })
    try {
      const jsDoc = await loadPdfDocument(data.slice())
      decoded = await decodeCandidateImages(jsDoc, candidates)
    } catch {
      decoded = new Map()
    }
  }

  let technique: CompressReport['technique'] = 'pdf-structure'
  let formatLabel = 'PDF'

  if (decoded.size > 0) {
    const maxDpi = mode.kind === 'visual' ? mode.maxDpi : DPI_PRESETS.print
    const plans = planCandidates(decoded, maxDpi)
    const bilevelCount = Array.from(plans.values()).filter((p) => p.isBilevel).length
    const downsampled = Array.from(plans.values()).filter(
      (p) => p.baseW < p.decoded.width || p.baseH < p.decoded.height,
    ).length

    if (downsampled > 0) {
      notes.push({ label: 'Over-resolution', value: `${downsampled} image${downsampled === 1 ? '' : 's'} capped at ${maxDpi} DPI` })
    }
    if (bilevelCount > 0) {
      notes.push({ label: 'Scanned pages', value: `${bilevelCount} coded as bilevel CCITT G4` })
    }

    if (mode.kind === 'visual') {
      onProgress?.({ stage: 'searching', detail: 'Recompressing embedded images' })
      const encoded = await encodeAllPlans(plans, 1, VISUAL_QUALITY)
      const usedBilevel = Array.from(encoded.values()).filter((e) => e.bilevel).length
      applyEncoded(pdfDoc, candidates, encoded)
      technique = usedBilevel > 0 ? 'pdf-bilevel' : 'pdf-images'
      formatLabel = usedBilevel > 0 ? 'CCITT G4 + JPEG' : 'JPEG'
    } else {
      // One real save gives an accurate baseline for "everything that isn't
      // one of the images we're about to recompress", so every search step
      // can estimate the final size from a sum of encoded byte lengths.
      const baselineBytes = await pdfDoc.save({ useObjectStreams: true })
      const decodedOriginalTotal = Array.from(decoded.keys()).reduce(
        (sum, key) => sum + (candidates.get(key)?.originalBytes.length ?? 0),
        0,
      )
      const baseOverhead = baselineBytes.length - decodedOriginalTotal
      const estimateTarget = effectiveTarget * ESTIMATE_SAFETY_MARGIN

      const measureScale = async (scale: number) => {
        onProgress?.({ stage: 'searching', detail: `Trying image scale ${Math.round(scale * 100)}%` })
        const encoded = await encodeAllPlans(plans, scale, PRIMARY_QUALITY)
        let sum = baseOverhead
        for (const e of encoded.values()) sum += e.bytes.length
        return sum
      }
      const scaleResult = await binarySearchParam(measureScale, MIN_SCALE, 1, SCALE_STEPS, estimateTarget)

      let finalEncoded: Map<string, EncodedImage>
      if (scaleResult.fits) {
        finalEncoded = await encodeAllPlans(plans, scaleResult.value, PRIMARY_QUALITY)
      } else {
        const measureQuality = async (quality: number) => {
          onProgress?.({ stage: 'searching', detail: `Trying image quality ${Math.round(quality * 100)}%` })
          const encoded = await encodeAllPlans(plans, MIN_SCALE, quality)
          let sum = baseOverhead
          for (const e of encoded.values()) sum += e.bytes.length
          return sum
        }
        const qualityResult = await binarySearchParam(
          measureQuality,
          FALLBACK_MIN_QUALITY,
          PRIMARY_QUALITY,
          FALLBACK_QUALITY_STEPS,
          estimateTarget,
        )
        const finalQuality = qualityResult.fits ? qualityResult.value : FALLBACK_MIN_QUALITY
        finalEncoded = await encodeAllPlans(plans, MIN_SCALE, finalQuality)
      }
      const usedBilevel = Array.from(finalEncoded.values()).filter((e) => e.bilevel).length
      applyEncoded(pdfDoc, candidates, finalEncoded)
      technique = usedBilevel > 0 ? 'pdf-bilevel' : 'pdf-images'
      formatLabel = usedBilevel > 0 ? 'CCITT G4 + JPEG' : 'JPEG'
    }
  }

  onProgress?.({ stage: 'finalising', detail: 'Rebuilding document' })
  removeUnreferencedObjects(pdfDoc)
  let finalBytes = await pdfDoc.save({ useObjectStreams: true })
  let hitTarget = finalBytes.length <= effectiveTarget

  // Never let cleanup make things worse than the source.
  if (finalBytes.length >= file.size) {
    return finish(data, pageCount, file.size <= effectiveTarget, 'untouched', 'PDF', [
      { label: 'Why', value: 'Rewriting the file produced no saving' },
    ])
  }

  if (mode.kind === 'target' && !hitTarget) {
    const rasterResult = await rasterizeFallback(data, effectiveTarget, onProgress)
    if (rasterResult.bytes.length < finalBytes.length) {
      finalBytes = rasterResult.bytes
      hitTarget = rasterResult.hitTarget
      technique = 'pdf-rasterize'
      formatLabel = 'JPEG pages'
      notes.push({ label: 'Fallback', value: 'Pages rasterized to reach the target' })
    }
  }

  return finish(finalBytes, pageCount, hitTarget, technique, formatLabel)
}
