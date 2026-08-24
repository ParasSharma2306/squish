import { PDFDocument } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { canvasToBlob } from './fileUtils'
import { pdfjsLib } from './pdfSetup'
import { decodeCandidateImages, type DecodedImage } from './pdfImageExtract'
import {
  dedupeImages,
  findCandidateImages,
  removeUnreferencedObjects,
  stripMetadata,
  swapImage,
  type ImageCandidate,
} from './pdfStructure'

export interface PdfCompressResult {
  bytes: Uint8Array
  hitTarget: boolean
  pageCount: number
}

export interface PdfCompressProgress {
  stage: 'rendering' | 'searching'
  scaleAttempt: number
  detail: string
}

// JPEG quality is held fixed in this range for the primary pass; the
// binary search only varies how much each embedded photo is downsampled.
// Artifacts get bad fast below ~75%, whereas a modest resolution cut is
// visually free on-screen, so scale is the first lever, not quality.
const PRIMARY_QUALITY = 0.82

// Floors for the scale-only phase. Low enough that even a very aggressive
// target (e.g. shrinking a multi-photo PDF by 100x) is reachable without
// falling back to quality loss or whole-page rasterization.
const MIN_LONG_EDGE = 220
const MIN_SCALE = 0.05
const SCALE_STEPS = 8

// Secondary fallback if downsampling to the floor still can't hit the
// target: start trading quality away too.
const FALLBACK_MIN_QUALITY = 0.3
const FALLBACK_QUALITY_STEPS = 6

// Binary-search measurements only need to know how big the *result* would
// be, not the result itself, so they skip pdf-lib entirely (no swapImage,
// no pdfDoc.save()) and just sum freshly-encoded JPEG byte lengths against
// a one-time baseline of "everything that isn't a recompressed image".
// That turns what used to be a full PDF re-serialization per search step
// into a handful of cheap canvas encodes, which is where nearly all of the
// wall-clock time in PDF compression used to go.
const ESTIMATE_SAFETY_MARGIN = 0.99

function scaledDims(nativeW: number, nativeH: number, scale: number, minLongEdge: number): { w: number; h: number } {
  const longEdge = Math.max(nativeW, nativeH)
  const floorEdge = Math.min(longEdge, minLongEdge)
  const effectiveEdge = Math.max(longEdge * scale, floorEdge)
  const ratio = effectiveEdge / longEdge
  return { w: Math.max(1, Math.round(nativeW * ratio)), h: Math.max(1, Math.round(nativeH * ratio)) }
}

interface EncodedImage {
  bytes: Uint8Array
  width: number
  height: number
}

async function encodeCandidate(decoded: DecodedImage, scale: number, quality: number): Promise<EncodedImage> {
  const { w, h } = scaledDims(decoded.width, decoded.height, scale, MIN_LONG_EDGE)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(decoded.source, 0, 0, w, h)
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, width: w, height: h }
}

/** Encodes every candidate independently and in parallel; pure measurement, no pdf-lib mutation. */
async function encodeAllCandidates(
  decoded: Map<string, DecodedImage>,
  scale: number,
  quality: number,
): Promise<Map<string, EncodedImage>> {
  const entries = await Promise.all(
    Array.from(decoded, async ([key, img]) => [key, await encodeCandidate(img, scale, quality)] as const),
  )
  return new Map(entries)
}

function applyEncoded(pdfDoc: PDFDocument, candidates: Map<string, ImageCandidate>, encoded: Map<string, EncodedImage>) {
  for (const [key, enc] of encoded) {
    const candidate = candidates.get(key)
    if (!candidate) continue
    swapImage(pdfDoc, candidate.ref, enc.bytes, enc.width, enc.height)
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

// --- Legacy whole-page rasterization, kept only as a last-resort fallback
// for PDFs with no recompressible images (pure text/vector, or an
// aggressive target the image-based pass alone can't reach). This rebuilds
// every page as a single JPEG, which loses text selectability, so it's only
// used when the structural + image-swap pipeline above isn't enough.
//
// Pages are rendered with pdf.js exactly once, at a fixed base scale. Every
// scale/quality combination tried during the search is produced by
// downscaling and re-encoding that cached bitmap on a canvas — cheap 2D
// ops — instead of re-invoking pdf.js (font rasterization, vector paths)
// per attempt, which used to dominate compression time on multi-page PDFs.

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
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
  const baseScale = doc.numPages > 15 ? 1 : 1.5
  onProgress?.({ stage: 'rendering', scaleAttempt: 0, detail: `Rendering ${doc.numPages} page${doc.numPages === 1 ? '' : 's'}` })
  const base = await renderPages(doc, baseScale)

  const estimateTarget = targetBytes * ESTIMATE_SAFETY_MARGIN
  const sumBytes = (attempt: RasterPageAttempt[]) => attempt.reduce((sum, p) => sum + p.bytes.length, 0)

  const measureScale = async (scale: number) => {
    onProgress?.({ stage: 'searching', scaleAttempt: 0, detail: `Trying page scale ${Math.round(scale * 100)}%` })
    return sumBytes(await encodeRasterAttempt(base, scale, RASTER_PRIMARY_QUALITY))
  }
  const scaleResult = await binarySearchParam(measureScale, RASTER_MIN_SCALE, 1, RASTER_SCALE_STEPS, estimateTarget)

  let finalScale = scaleResult.value
  let finalQuality = RASTER_PRIMARY_QUALITY
  let hitTarget = scaleResult.fits

  if (!scaleResult.fits) {
    const measureQuality = async (quality: number) => {
      onProgress?.({ stage: 'searching', scaleAttempt: 1, detail: `Trying page quality ${Math.round(quality * 100)}%` })
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
 * Compresses a PDF toward a target size primarily by downsampling and
 * recompressing its embedded photos in place: pdf.js decodes each embedded
 * image (handling whatever filter/color space it was stored in), it's
 * redrawn at a reduced scale and re-encoded as a fixed-quality JPEG, and
 * pdf-lib swaps the result back into the original image object — so page
 * structure, vector content, and text stay untouched and selectable.
 * Structural cleanup (stripped metadata/thumbnails, deduped duplicate
 * images, removed unreferenced objects, object-stream output) runs
 * alongside this for free. Whole-page rasterization is only used as a last
 * resort, for PDFs with no recompressible images or an unreachable target.
 *
 * The scale/quality search only ever touches pdf-lib twice: once to
 * baseline "how big is everything except the images I'm about to swap",
 * and once at the end to actually apply the winning attempt. Every step in
 * between is a cheap, parallel, in-memory JPEG re-encode.
 */
export async function compressPdfToTarget(
  file: File,
  targetBytes: number,
  onProgress?: (p: PdfCompressProgress) => void,
): Promise<PdfCompressResult> {
  const data = new Uint8Array(await file.arrayBuffer())

  // Already small enough. Return the original bytes untouched rather than
  // re-encoding, which could (for already-optimized PDFs) make it bigger.
  if (file.size <= targetBytes) {
    const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
    const pageCount = doc.numPages
    return { bytes: data, hitTarget: true, pageCount }
  }
  const effectiveTarget = Math.min(targetBytes, file.size)

  let pdfDoc: PDFDocument | null = null
  try {
    pdfDoc = await PDFDocument.load(data, { updateMetadata: false })
  } catch {
    pdfDoc = null
  }

  // Malformed/encrypted PDFs pdf-lib can't load: fall back to the
  // rasterization path, which only needs pdf.js.
  if (!pdfDoc) {
    const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
    const pageCount = doc.numPages
    const result = await rasterizeFallback(data, effectiveTarget, onProgress)
    return { ...result, pageCount }
  }

  const pageCount = pdfDoc.getPages().length
  stripMetadata(pdfDoc)
  const rawCandidates = findCandidateImages(pdfDoc)
  const candidates = dedupeImages(pdfDoc, rawCandidates)

  let decoded = new Map<string, DecodedImage>()
  if (candidates.size > 0) {
    onProgress?.({
      stage: 'rendering',
      scaleAttempt: 0,
      detail: `Extracting ${candidates.size} embedded image${candidates.size === 1 ? '' : 's'}`,
    })
    try {
      const jsDoc = await pdfjsLib.getDocument({ data: data.slice() }).promise
      decoded = await decodeCandidateImages(jsDoc, candidates)
    } catch {
      decoded = new Map()
    }
  }

  if (decoded.size > 0) {
    // One real save gives an accurate baseline for "everything that isn't
    // one of the images we're about to recompress" (post metadata-strip,
    // post-dedupe, post object-stream packing), so every subsequent search
    // step can estimate final size with just a sum of JPEG byte lengths.
    const baselineBytes = await pdfDoc.save({ useObjectStreams: true })
    const decodedOriginalTotal = Array.from(decoded.keys()).reduce(
      (sum, key) => sum + (candidates.get(key)?.originalBytes.length ?? 0),
      0,
    )
    const baseOverhead = baselineBytes.length - decodedOriginalTotal
    const estimateTarget = effectiveTarget * ESTIMATE_SAFETY_MARGIN

    const measureScale = async (scale: number) => {
      onProgress?.({ stage: 'searching', scaleAttempt: 1, detail: `Trying image scale ${Math.round(scale * 100)}%` })
      const encoded = await encodeAllCandidates(decoded, scale, PRIMARY_QUALITY)
      let sum = baseOverhead
      for (const e of encoded.values()) sum += e.bytes.length
      return sum
    }
    const scaleResult = await binarySearchParam(measureScale, MIN_SCALE, 1, SCALE_STEPS, estimateTarget)

    let finalEncoded: Map<string, EncodedImage>
    if (scaleResult.fits) {
      finalEncoded = await encodeAllCandidates(decoded, scaleResult.value, PRIMARY_QUALITY)
    } else {
      const measureQuality = async (quality: number) => {
        onProgress?.({ stage: 'searching', scaleAttempt: 2, detail: `Trying image quality ${Math.round(quality * 100)}%` })
        const encoded = await encodeAllCandidates(decoded, MIN_SCALE, quality)
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
      finalEncoded = await encodeAllCandidates(decoded, MIN_SCALE, finalQuality)
    }
    applyEncoded(pdfDoc, candidates, finalEncoded)
  }

  removeUnreferencedObjects(pdfDoc)
  let finalBytes = await pdfDoc.save({ useObjectStreams: true })
  let hitTarget = finalBytes.length <= effectiveTarget

  // Never let structural-only cleanup make things worse than the source.
  if (finalBytes.length >= file.size) {
    finalBytes = data
    hitTarget = file.size <= effectiveTarget
  }

  if (!hitTarget) {
    const rasterResult = await rasterizeFallback(data, effectiveTarget, onProgress)
    if (rasterResult.bytes.length < finalBytes.length) {
      finalBytes = rasterResult.bytes
      hitTarget = rasterResult.hitTarget
    }
  }

  return { bytes: finalBytes, hitTarget, pageCount }
}
