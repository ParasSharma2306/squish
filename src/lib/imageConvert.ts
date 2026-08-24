import { canvasToBlob, drawImageToCanvas, loadImage } from './fileUtils'
import { encodeBmp } from './bmpEncode'

export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'bmp'

export const FORMAT_MIME: Record<OutputFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

export const FORMAT_EXT: Record<OutputFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  bmp: 'bmp',
}

export const FORMAT_LABEL: Record<OutputFormat, string> = {
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  avif: 'AVIF',
  bmp: 'BMP',
}

/** Formats with no alpha channel; transparent areas get flattened onto white. */
export const OPAQUE_FORMATS: OutputFormat[] = ['jpeg', 'bmp']
/** Formats where a 0-1 quality argument actually changes the output. */
export const QUALITY_TUNABLE_FORMATS: OutputFormat[] = ['jpeg', 'webp', 'avif']

export async function convertImage(
  file: File,
  format: OutputFormat,
  quality: number,
): Promise<Blob> {
  const img = await loadImage(file)
  const background = OPAQUE_FORMATS.includes(format) ? '#ffffff' : undefined
  const canvas = drawImageToCanvas(img, img.naturalWidth, img.naturalHeight, background)

  if (format === 'bmp') return encodeBmp(canvas)

  const mime = FORMAT_MIME[format]
  const useQuality = QUALITY_TUNABLE_FORMATS.includes(format)
  return canvasToBlob(canvas, mime, useQuality ? quality : undefined)
}
