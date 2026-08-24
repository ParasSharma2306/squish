/** Canvas has no native BMP encoder, so this writes an uncompressed 24-bit BMP by hand. */
export function encodeBmp(canvas: HTMLCanvasElement): Blob {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')!
  const { data } = ctx.getImageData(0, 0, w, h)

  const rowSize = Math.floor((24 * w + 31) / 32) * 4
  const pixelArraySize = rowSize * h
  const fileSize = 54 + pixelArraySize
  const buffer = new ArrayBuffer(fileSize)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  // BITMAPFILEHEADER
  bytes[0] = 0x42 // 'B'
  bytes[1] = 0x4d // 'M'
  view.setUint32(2, fileSize, true)
  view.setUint32(10, 54, true) // pixel data offset

  // BITMAPINFOHEADER
  view.setUint32(14, 40, true)
  view.setInt32(18, w, true)
  view.setInt32(22, h, true) // positive height = bottom-up row order
  view.setUint16(26, 1, true) // color planes
  view.setUint16(28, 24, true) // bits per pixel
  view.setUint32(34, pixelArraySize, true)
  view.setInt32(38, 2835, true) // ~72 DPI
  view.setInt32(42, 2835, true)

  let offset = 54
  for (let y = h - 1; y >= 0; y--) {
    let rowOffset = offset
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      bytes[rowOffset++] = data[i + 2] // B
      bytes[rowOffset++] = data[i + 1] // G
      bytes[rowOffset++] = data[i] // R
    }
    offset += rowSize
  }

  return new Blob([bytes], { type: 'image/bmp' })
}
