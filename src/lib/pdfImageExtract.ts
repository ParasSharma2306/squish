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
  ref?: { num: number; gen: number }
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
  if (imgData.bitmap) return { source: imgData.bitmap, width, height }
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
 * Decodes the pixel data pdf.js already extracted for each candidate image
 * while building each page's operator list. This is the only practical way
 * to get real pixel data out of an embedded PDF image (pdf-lib only
 * understands PDF structure, not JPEG/JPX/CCITT/indexed-color decoding) —
 * pdf.js resolves every embedded image into `page.objs`/`page.commonObjs`,
 * keyed by an object id, tagged with a `.ref` back to the original indirect
 * object so it can be matched against pdf-lib's candidate list.
 */
export async function decodeCandidateImages(
  doc: PDFDocumentProxy,
  candidates: Map<string, ImageCandidate>,
): Promise<Map<string, DecodedImage>> {
  const decoded = new Map<string, DecodedImage>()
  for (let i = 1; i <= doc.numPages && decoded.size < candidates.size; i++) {
    const page = await doc.getPage(i)
    const opList = await page.getOperatorList()
    for (let j = 0; j < opList.fnArray.length; j++) {
      if (opList.fnArray[j] !== pdfjsLib.OPS.paintImageXObject) continue
      const objId = opList.argsArray[j][0] as string
      let imgData: PdfjsImageData | null = null
      if (page.objs.has(objId)) imgData = page.objs.get(objId)
      else if (page.commonObjs.has(objId)) imgData = page.commonObjs.get(objId)
      if (!imgData || !imgData.ref) continue
      const key = `${imgData.ref.num}_${imgData.ref.gen}`
      if (decoded.has(key) || !candidates.has(key)) continue
      const drawable = toDrawable(imgData)
      if (drawable) decoded.set(key, drawable)
    }
    page.cleanup()
  }
  return decoded
}
