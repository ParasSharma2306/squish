import type { PDFDocumentProxy } from 'pdfjs-dist'
import { pdfjsLib } from './pdfSetup'
import type { ImageCandidate } from './pdfStructure'

export interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
}

// pdf.js's ImageKind enum (GRAYSCALE_1BPP / RGB_24BPP / RGBA_32BPP), inlined
// so we don't depend on a runtime import just for three constants.
const RGB_24BPP = 2
const RGBA_32BPP = 3

interface PdfjsImageData {
  width: number
  height: number
  bitmap?: ImageBitmap
  data?: Uint8ClampedArray
  kind?: number
  // pdf.js serializes this as a plain "<num>R<gen>" string (e.g. "4R0"),
  // not the {num, gen} object its own internal Ref class uses.
  ref?: string
}

/** Parses pdf.js's "<num>R<gen>" ref string into the same key format pdf-lib's PDFRef uses. */
function keyFromPdfjsRef(ref: string | undefined): string | null {
  if (!ref) return null
  const match = /^(\d+)R(\d*)$/.exec(ref)
  if (!match) return null
  return `${match[1]}_${match[2] || '0'}`
}

function toRGBA(data: Uint8ClampedArray, kind: number | undefined, width: number, height: number): Uint8ClampedArray | null {
  if (kind === RGBA_32BPP) return data
  if (kind === RGB_24BPP) {
    const out = new Uint8ClampedArray(width * height * 4)
    for (let i = 0, j = 0; j < out.length; i += 3, j += 4) {
      out[j] = data[i]
      out[j + 1] = data[i + 1]
      out[j + 2] = data[i + 2]
      out[j + 3] = 255
    }
    return out
  }
  // GRAYSCALE_1BPP and anything unrecognized: not worth the extra decode
  // complexity for what's almost always a tiny stencil mask, not a photo.
  return null
}

function toDrawable(imgData: PdfjsImageData): DecodedImage | null {
  const { width, height } = imgData
  if (!width || !height) return null
  if (imgData.bitmap) {
    // Copy onto a canvas we own immediately: pdf.js closes/reclaims this
    // bitmap once the page it belongs to is cleaned up, but the encoded
    // image is re-drawn from `source` many times over the course of the
    // compression search, long after that cleanup has run.
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(imgData.bitmap, 0, 0)
    return { source: canvas, width, height }
  }
  if (imgData.data) {
    const rgba = toRGBA(imgData.data, imgData.kind, width, height)
    if (!rgba) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
    return { source: canvas, width, height }
  }
  return null
}

/**
 * Decodes the pixel data pdf.js extracts for each candidate image. pdf-lib
 * only understands PDF structure, not JPEG/JPX/CCITT/indexed-color
 * decoding, so pdf.js is the only practical way to get real pixel data out
 * of an embedded image. Building a page's operator list only records which
 * object ids it *references*, though — the objects themselves don't decode
 * and land in `page.objs`/`page.commonObjs` until the page is actually
 * rendered, so each page with a candidate image is rendered once (to a
 * throwaway canvas) purely to force that resolution. Each resolved image
 * carries a `.ref` string back to its original indirect object so it can
 * be matched against pdf-lib's candidate list.
 */
export async function decodeCandidateImages(
  doc: PDFDocumentProxy,
  candidates: Map<string, ImageCandidate>,
): Promise<Map<string, DecodedImage>> {
  const decoded = new Map<string, DecodedImage>()
  for (let i = 1; i <= doc.numPages && decoded.size < candidates.size; i++) {
    const page = await doc.getPage(i)
    const opList = await page.getOperatorList()
    const imageObjIds: string[] = []
    for (let j = 0; j < opList.fnArray.length; j++) {
      if (opList.fnArray[j] === pdfjsLib.OPS.paintImageXObject) {
        imageObjIds.push(opList.argsArray[j][0] as string)
      }
    }

    if (imageObjIds.length > 0) {
      const viewport = page.getViewport({ scale: 1 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.ceil(viewport.width))
      canvas.height = Math.max(1, Math.ceil(viewport.height))
      const ctx = canvas.getContext('2d')!
      await page.render({ canvasContext: ctx, viewport, canvas }).promise
    }

    for (const objId of imageObjIds) {
      let imgData: PdfjsImageData | null = null
      if (page.objs.has(objId)) imgData = page.objs.get(objId)
      else if (page.commonObjs.has(objId)) imgData = page.commonObjs.get(objId)
      if (!imgData) continue
      const key = keyFromPdfjsRef(imgData.ref)
      if (!key || decoded.has(key) || !candidates.has(key)) continue
      const drawable = toDrawable(imgData)
      if (drawable) decoded.set(key, drawable)
    }
    page.cleanup()
  }
  return decoded
}
