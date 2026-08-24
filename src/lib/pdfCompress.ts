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

// Never downsample an image's long edge below this many pixels — roughly
// the equivalent of ~100 DPI for a normal printed photo, below which text
// or fine detail inside the image starts to visibly break down.
const MIN_LONG_EDGE = 480
const MIN_SCALE = 0.15
const SCALE_STEPS = 6

// Secondary fallback if downsampling to the floor still can't hit the
// target: start trading quality away too, but stay above the point where
// JPEG blocking becomes obviously ugly.
const FALLBACK_MIN_QUALITY = 0.5
const FALLBACK_QUALITY_STEPS = 5

function targetDims(nativeW: number, nativeH: number, scale: number): { w: number; h: number } {
  const longEdge = Math.max(nativeW, nativeH)
  const floorEdge = Math.min(longEdge, MIN_LONG_EDGE)
  const effectiveEdge = Math.max(longEdge * scale, floorEdge)
  const ratio = effectiveEdge / longEdge
  return { w: Math.max(1, Math.round(nativeW * ratio)), h: Math.max(1, Math.round(nativeH * ratio)) }
}

async function encodeCandidate(
  decoded: DecodedImage,
  scale: number,
  quality: number,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const { w, h } = targetDims(decoded.width, decoded.height, scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(decoded.source, 0, 0, w, h)
  const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { bytes, width: w, height: h }
}

/** Recompresses every candidate image into `pdfDoc` in place and saves. */
async function applyAttempt(
  pdfDoc: PDFDocument,
  candidates: Map<string, ImageCandidate>,
  decoded: Map<string, DecodedImage>,
  scale: number,
  quality: number,
): Promise<Uint8Array> {
  for (const [key, img] of decoded) {
    const candidate = candidates.get(key)
    if (!candidate) continue
    const { bytes, width, height } = await encodeCandidate(img, scale, quality)
    swapImage(pdfDoc, candidate.ref, bytes, width, height)
  }
  return pdfDoc.save({ useObjectStreams: true })
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

const RASTER_SCALE_ATTEMPTS = [2, 1.5, 1.15, 1]
const RASTER_QUALITY_STEPS = 6
const RASTER_MIN_READABLE_QUALITY = 0.4
const RASTER_FALLBACK_MIN_QUALITY = 0.12
const RASTER_FALLBACK_SCALE = 0.75

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
  }
  return canvases
}

async function buildRasterPdf(canvases: HTMLCanvasElement[], quality: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  for (const canvas of canvases) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const embedded = await pdf.embedJpg(bytes)
    const page = pdf.addPage([canvas.width, canvas.height])
    page.drawImage(embedded, { x: 0, y: 0, width: canvas.width, height: canvas.height })
  }
  return pdf.save()
}

async function searchRasterQuality(
  canvases: HTMLCanvasElement[],
  targetBytes: number,
  minQuality: number,
  onTry?: (quality: number) => void,
): Promise<{ bytes: Uint8Array | null; floorBytes: Uint8Array }> {
  let lo = minQuality
  let hi = 1
  onTry?.(lo)
  const floorBytes = await buildRasterPdf(canvases, lo)
  if (floorBytes.length > targetBytes) return { bytes: null, floorBytes }

  let best = floorBytes
  for (let i = 0; i < RASTER_QUALITY_STEPS; i++) {
    const q = (lo + hi) / 2
    onTry?.(q)
    const bytes = await buildRasterPdf(canvases, q)
    if (bytes.length <= targetBytes) {
      best = bytes
      lo = q
    } else {
      hi = q
    }
  }
  return { bytes: best, floorBytes }
}

async function rasterizeFallback(
  data: Uint8Array,
  targetBytes: number,
  onProgress?: (p: PdfCompressProgress) => void,
): Promise<{ bytes: Uint8Array; hitTarget: boolean }> {
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
  let smallest: Uint8Array | null = null

  for (let s = 0; s < RASTER_SCALE_ATTEMPTS.length; s++) {
    const scale = RASTER_SCALE_ATTEMPTS[s]
    onProgress?.({ stage: 'rendering', scaleAttempt: s, detail: `Rendering pages at ${scale}x` })
    const canvases = await renderPages(doc, scale)
    const { bytes, floorBytes } = await searchRasterQuality(canvases, targetBytes, RASTER_MIN_READABLE_QUALITY, (q) =>
      onProgress?.({ stage: 'searching', scaleAttempt: s, detail: `Trying quality ${Math.round(q * 100)}%` }),
    )
    if (!smallest || floorBytes.length < smallest.length) smallest = floorBytes
    if (bytes) return { bytes, hitTarget: true }
  }

  onProgress?.({ stage: 'rendering', scaleAttempt: RASTER_SCALE_ATTEMPTS.length, detail: 'Rendering at a smaller size' })
  const canvases = await renderPages(doc, RASTER_FALLBACK_SCALE)
  let lo = 0
  let hi = 1
  for (let i = 0; i < RASTER_QUALITY_STEPS; i++) {
    const q = Math.max(RASTER_FALLBACK_MIN_QUALITY, (lo + hi) / 2)
    onProgress?.({
      stage: 'searching',
      scaleAttempt: RASTER_SCALE_ATTEMPTS.length,
      detail: `Trying quality ${Math.round(q * 100)}%`,
    })
    const bytes = await buildRasterPdf(canvases, q)
    if (!smallest || bytes.length < smallest.length) smallest = bytes
    if (bytes.length <= targetBytes) return { bytes, hitTarget: true }
    hi = q
    if (q <= RASTER_FALLBACK_MIN_QUALITY) break
  }

  return { bytes: smallest!, hitTarget: false }
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
    const measureScale = async (scale: number) => {
      onProgress?.({ stage: 'searching', scaleAttempt: 1, detail: `Trying image scale ${Math.round(scale * 100)}%` })
      const bytes = await applyAttempt(pdfDoc!, candidates, decoded, scale, PRIMARY_QUALITY)
      return bytes.length
    }
    const scaleResult = await binarySearchParam(measureScale, MIN_SCALE, 1, SCALE_STEPS, effectiveTarget)

    if (scaleResult.fits) {
      await applyAttempt(pdfDoc, candidates, decoded, scaleResult.value, PRIMARY_QUALITY)
    } else {
      const measureQuality = async (quality: number) => {
        onProgress?.({ stage: 'searching', scaleAttempt: 2, detail: `Trying image quality ${Math.round(quality * 100)}%` })
        const bytes = await applyAttempt(pdfDoc!, candidates, decoded, MIN_SCALE, quality)
        return bytes.length
      }
      const qualityResult = await binarySearchParam(
        measureQuality,
        FALLBACK_MIN_QUALITY,
        PRIMARY_QUALITY,
        FALLBACK_QUALITY_STEPS,
        effectiveTarget,
      )
      await applyAttempt(pdfDoc, candidates, decoded, MIN_SCALE, qualityResult.fits ? qualityResult.value : FALLBACK_MIN_QUALITY)
    }
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
