import { PDFDocument } from 'pdf-lib'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { canvasToBlob } from './fileUtils'
import { pdfjsLib } from './pdfSetup'

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

// Render scales to try, largest first. Kept at or above 1x (~72 DPI) for the
// primary pass since going lower makes small text blurry from resolution
// loss alone, independent of JPEG quality.
const SCALE_ATTEMPTS = [2, 1.5, 1.15, 1]
const QUALITY_STEPS = 6

// JPEG quality below this looks fine on photos but wrecks text: block
// artifacts start eating into character strokes. The primary search never
// goes below this, and prefers rendering pages smaller instead, which for
// the same byte budget reads far more legibly than a huge page crushed to
// near-zero quality.
const MIN_READABLE_QUALITY = 0.4
// Absolute last resort, only used if every (scale, MIN_READABLE_QUALITY)
// combination still overshoots the target, so an aggressive target size is
// still honored as closely as possible rather than just giving up.
const FALLBACK_MIN_QUALITY = 0.12
const FALLBACK_SCALE = 0.75

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

async function buildPdf(canvases: HTMLCanvasElement[], quality: number): Promise<Uint8Array> {
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

/**
 * Binary-searches JPEG quality within [minQuality, 1] for the given rendered
 * pages. `bytes` is set only if minQuality itself fit; `floorBytes` is always
 * returned so callers can track a "closest so far" baseline even when this
 * scale never fits.
 */
async function searchQuality(
  canvases: HTMLCanvasElement[],
  targetBytes: number,
  minQuality: number,
  onTry?: (quality: number) => void,
): Promise<{ bytes: Uint8Array | null; floorBytes: Uint8Array }> {
  let lo = minQuality
  let hi = 1

  // Check the floor first: if even minQuality overshoots, there's no point
  // searching the range above it, so bail out immediately to the next scale.
  onTry?.(lo)
  const floorBytes = await buildPdf(canvases, lo)
  if (floorBytes.length > targetBytes) return { bytes: null, floorBytes }

  let best = floorBytes
  for (let i = 0; i < QUALITY_STEPS; i++) {
    const q = (lo + hi) / 2
    onTry?.(q)
    const bytes = await buildPdf(canvases, q)
    if (bytes.length <= targetBytes) {
      best = bytes
      lo = q
    } else {
      hi = q
    }
  }

  return { bytes: best, floorBytes }
}

/**
 * PDFs are rasterized page-by-page (via pdf.js) then rebuilt as a JPEG-backed
 * PDF (via pdf-lib). For each render scale (largest first), quality is
 * binary-searched within a readable floor; only once the floor itself can't
 * fit the target does the render scale step down. This deliberately prefers
 * a smaller, cleaner page over a full-size page crushed with heavy JPEG
 * artifacts, since the latter reads as broken text rather than "compressed."
 * This trades away text selectability for a size guarantee either way,
 * which is the standard trade-off for a fully client-side PDF compressor.
 */
export async function compressPdfToTarget(
  file: File,
  targetBytes: number,
  onProgress?: (p: PdfCompressProgress) => void,
): Promise<PdfCompressResult> {
  const data = new Uint8Array(await file.arrayBuffer())

  // Already small enough. Return the original bytes untouched rather than
  // rasterizing (which can easily make a small, mostly-vector/text PDF bigger).
  if (file.size <= targetBytes) {
    const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise
    return { bytes: data, hitTarget: true, pageCount: doc.numPages }
  }
  // Never intentionally produce an output bigger than the original.
  const effectiveTarget = Math.min(targetBytes, file.size)

  const doc = await pdfjsLib.getDocument({ data }).promise

  let smallest: Uint8Array | null = null

  for (let s = 0; s < SCALE_ATTEMPTS.length; s++) {
    const scale = SCALE_ATTEMPTS[s]
    onProgress?.({ stage: 'rendering', scaleAttempt: s, detail: `Rendering pages at ${scale}x` })
    const canvases = await renderPages(doc, scale)

    const { bytes, floorBytes } = await searchQuality(canvases, effectiveTarget, MIN_READABLE_QUALITY, (q) =>
      onProgress?.({ stage: 'searching', scaleAttempt: s, detail: `Trying quality ${Math.round(q * 100)}%` }),
    )
    if (!smallest || floorBytes.length < smallest.length) smallest = floorBytes
    if (bytes) {
      return { bytes, hitTarget: true, pageCount: doc.numPages }
    }
  }

  // Last resort: the readable-quality floor couldn't hit the target at any
  // scale, so drop both the scale and the quality floor to get as close as
  // possible. The UI marks this "closest possible" rather than "hit target".
  onProgress?.({ stage: 'rendering', scaleAttempt: SCALE_ATTEMPTS.length, detail: 'Rendering at a smaller size' })
  const canvases = await renderPages(doc, FALLBACK_SCALE)
  let lo = 0
  let hi = 1
  for (let i = 0; i < QUALITY_STEPS; i++) {
    const q = Math.max(FALLBACK_MIN_QUALITY, (lo + hi) / 2)
    onProgress?.({ stage: 'searching', scaleAttempt: SCALE_ATTEMPTS.length, detail: `Trying quality ${Math.round(q * 100)}%` })
    const bytes = await buildPdf(canvases, q)
    if (!smallest || bytes.length < smallest.length) smallest = bytes
    if (bytes.length <= effectiveTarget) {
      return { bytes, hitTarget: true, pageCount: doc.numPages }
    }
    hi = q
    if (q <= FALLBACK_MIN_QUALITY) break
  }

  return { bytes: smallest!, hitTarget: false, pageCount: doc.numPages }
}
