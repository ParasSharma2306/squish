import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

const result = await page.evaluate(async () => {
  const { encodeCcittG4 } = await import('/src/lib/ccittG4.ts')
  const { PDFDocument, PDFRawStream, PDFName } = await import('/node_modules/.vite/deps/pdf-lib.js?import')
  const { loadPdfDocument } = await import('/src/lib/pdfSetup.ts')

  const cases = []

  function makeBitmap(w, h, fn) {
    const bm = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bm[y * w + x] = fn(x, y) ? 1 : 0
    return bm
  }

  const patterns = {
    allWhite: (w, h) => makeBitmap(w, h, () => 0),
    allBlack: (w, h) => makeBitmap(w, h, () => 1),
    vstripes: (w, h) => makeBitmap(w, h, (x) => (x >> 3) % 2 === 0),
    hstripes: (w, h) => makeBitmap(w, h, (_x, y) => (y >> 2) % 2 === 0),
    checker: (w, h) => makeBitmap(w, h, (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0),
    diagonal: (w, h) => makeBitmap(w, h, (x, y) => (x + y) % 17 < 3),
    // pseudo-random speckle: worst case for 2D coding, forces horizontal mode
    noise: (w, h) => { let s = 12345; return makeBitmap(w, h, () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >> 16) % 5 === 0 }) },
    // long runs, exercises make-up codes past 2560
    longruns: (w, h) => makeBitmap(w, h, (x, y) => y % 3 === 0 && x > 2700),
    textish: (w, h) => makeBitmap(w, h, (x, y) => {
      const row = y % 24
      if (row > 16) return false
      const col = x % 11
      return col < 7 && ((x * 7 + y * 13) % 23) % 4 !== 0
    }),
  }

  for (const [name, build] of Object.entries(patterns)) {
    const w = name === 'longruns' ? 3000 : 613
    const h = name === 'longruns' ? 30 : 397
    const bitmap = build(w, h)
    const encoded = encodeCcittG4(bitmap, w, h)

    // Build a one-page PDF whose only content is this CCITT image.
    const pdf = await PDFDocument.create()
    const dict = pdf.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: w, Height: h,
      ColorSpace: 'DeviceGray', BitsPerComponent: 1,
      Filter: 'CCITTFaxDecode',
      DecodeParms: pdf.context.obj({ K: -1, Columns: w, Rows: h, BlackIs1: false, EncodedByteAlign: false }),
    })
    const ref = pdf.context.register(PDFRawStream.of(dict, encoded))
    const pdfPage = pdf.addPage([w, h])
    pdfPage.node.setXObject(PDFName.of('Im0'), ref)
    pdfPage.node.set(PDFName.of('Contents'), pdf.context.register(
      pdf.context.flateStream(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`)
    ))
    const bytes = await pdf.save()

    // Decode it back with pdf.js and compare pixel for pixel.
    const doc = await loadPdfDocument(bytes.slice())
    const p = await doc.getPage(1)
    const viewport = p.getViewport({ scale: 1 })
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    await p.render({ canvasContext: ctx, viewport, canvas }).promise
    const px = ctx.getImageData(0, 0, w, h).data

    let mismatches = 0
    for (let i = 0, q = 0; q < w * h; i += 4, q++) {
      const isBlack = px[i] < 128 ? 1 : 0
      if (isBlack !== bitmap[q]) mismatches++
    }
    cases.push({ name, w, h, encodedBytes: encoded.length, rawBits: Math.ceil(w / 8) * h, mismatches })
  }
  return cases
})

console.log('pattern        size        raw(1bpp)   G4 bytes   ratio    pixel mismatches')
for (const c of result) {
  const ratio = (c.rawBits / c.encodedBytes).toFixed(1)
  console.log(
    `${c.name.padEnd(14)} ${String(c.w + 'x' + c.h).padEnd(11)} ${String(c.rawBits).padEnd(11)} ${String(c.encodedBytes).padEnd(10)} ${(ratio + 'x').padEnd(8)} ${c.mismatches === 0 ? 'NONE ✓' : c.mismatches + ' ✗'}`,
  )
}
await browser.close()
