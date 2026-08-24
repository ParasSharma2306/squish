import { PDFDocument } from 'pdf-lib'
import { canvasToBlob, drawImageToCanvas, loadImage } from './fileUtils'

const MAX_DIMENSION_PT = 1600 // caps very large photos so pages stay a sane size

export async function buildPdfFromImages(files: File[]): Promise<Blob> {
  const pdf = await PDFDocument.create()

  for (const file of files) {
    const img = await loadImage(file)
    let { naturalWidth: w, naturalHeight: h } = img
    const scale = Math.min(1, MAX_DIMENSION_PT / Math.max(w, h))
    w = Math.round(w * scale)
    h = Math.round(h * scale)

    const isPng = file.type === 'image/png'
    let embedded
    if (isPng) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      embedded = await pdf.embedPng(bytes)
    } else {
      // Flatten everything else to JPEG for smaller, predictable output.
      const canvas = drawImageToCanvas(img, w, h, '#ffffff')
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      embedded = await pdf.embedJpg(bytes)
    }

    const page = pdf.addPage([w, h])
    page.drawImage(embedded, { x: 0, y: 0, width: w, height: h })
  }

  const bytes = await pdf.save()
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}
