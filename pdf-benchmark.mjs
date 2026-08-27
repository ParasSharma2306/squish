/**
 * Measures the PDF engine on generated documents that stand in for the real
 * cases: a scanned text page, an over-provisioned photo page, and a mixed
 * document. Run with the dev server up.
 */
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

const rows = await page.evaluate(async () => {
  const { compressPdf, DPI_PRESETS } = await import('/src/lib/pdfCompress.ts')
  const { PDFDocument } = await import('/node_modules/.vite/deps/pdf-lib.js?import')
  const { analyzeSource } = await import('/src/lib/imageAnalysis.ts')

  const paragraph =
    'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
    'How vexingly quick daft zebras jump! Squish compresses PDFs while trying to keep this ' +
    'text sharp enough to actually read, rather than turning it into mush. 0123456789.'

  function scanCanvas(seed) {
    const w = 1700, h = 2200
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.fillStyle = '#fbfbf8'; ctx.fillRect(0, 0, w, h)
    const id = ctx.getImageData(0, 0, w, h)
    let s = seed
    for (let i = 0; i < id.data.length; i += 4) {
      s = (s * 9301 + 49297) % 233280
      const n = (s / 233280) * 5 - 2.5
      id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n
    }
    ctx.putImageData(id, 0, 0)
    ctx.fillStyle = '#141414'; ctx.font = '26px Georgia, serif'
    let y = 100
    for (let line = 0; line < 55; line++) { ctx.fillText(paragraph.slice(0, 100), 60, y); y += 38 }
    return c
  }

  function photoCanvas(w, h, seed) {
    const c = document.createElement('canvas'); c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#3a5f9a'); g.addColorStop(0.5, '#d08a4a'); g.addColorStop(1, '#2a4a35')
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
    const id = ctx.getImageData(0, 0, w, h)
    let s = seed
    for (let i = 0; i < id.data.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      const n = (s / 0x7fffffff - 0.5) * 55
      id.data[i] += n; id.data[i + 1] += n * 0.9; id.data[i + 2] += n * 1.1
    }
    ctx.putImageData(id, 0, 0)
    return c
  }

  const toJpeg = async (canvas, q) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q))
    return new Uint8Array(await blob.arrayBuffer())
  }

  async function buildPdf(pages) {
    const pdf = await PDFDocument.create()
    for (const { bytes, pageW, pageH } of pages) {
      const img = await pdf.embedJpg(bytes)
      const p = pdf.addPage([pageW, pageH])
      p.drawImage(img, { x: 0, y: 0, width: pageW, height: pageH })
    }
    return pdf.save()
  }

  const docs = []

  // 1. Three scanned text pages at ~200 DPI on US Letter.
  const scanPages = []
  for (let i = 0; i < 3; i++) scanPages.push({ bytes: await toJpeg(scanCanvas(1000 + i * 777), 0.97), pageW: 612, pageH: 792 })
  docs.push({ name: 'scanned text (3pp, 1700x2200)', bytes: await buildPdf(scanPages), probe: scanCanvas(1000) })

  // 2. A photo massively over-provisioned for its placement: a 3000x2000
  //    image dropped into a 300x200pt box is ~720 DPI.
  docs.push({
    name: 'over-provisioned photo (720 DPI)',
    bytes: await buildPdf([{ bytes: await toJpeg(photoCanvas(3000, 2000, 42), 0.95), pageW: 300, pageH: 200 }]),
    probe: null,
  })

  // 3. Mixed: one scan page + one photo page.
  docs.push({
    name: 'mixed (scan + photo)',
    bytes: await buildPdf([
      { bytes: await toJpeg(scanCanvas(5), 0.97), pageW: 612, pageH: 792 },
      { bytes: await toJpeg(photoCanvas(2000, 1400, 7), 0.95), pageW: 612, pageH: 428 },
    ]),
    probe: null,
  })

  const out = []
  for (const doc of docs) {
    if (doc.probe) {
      const stats = analyzeSource(doc.probe, doc.probe.width, doc.probe.height)
      out.push({ classify: doc.name, stats })
    }
    const file = new File([doc.bytes], 'in.pdf', { type: 'application/pdf' })
    for (const mode of [
      { name: 'visual:screen', mode: { kind: 'visual', maxDpi: DPI_PRESETS.screen } },
      { name: 'visual:print', mode: { kind: 'visual', maxDpi: DPI_PRESETS.print } },
      { name: 'target:150KB', mode: { kind: 'target', targetBytes: 150 * 1024 } },
    ]) {
      const t0 = performance.now()
      let r
      try { r = await compressPdf(file, mode.mode) } catch (e) {
        out.push({ name: doc.name, mode: mode.name, error: String(e && e.message || e) }); continue
      }
      out.push({
        name: doc.name, mode: mode.name,
        before: r.report.originalBytes, after: r.report.newBytes, pct: r.report.reductionPct,
        technique: r.report.technique, format: r.report.formatLabel,
        notes: r.report.notes.map((n) => `${n.label}: ${n.value}`),
        ms: Math.round(performance.now() - t0),
      })
    }
  }
  return out
})

const kb = (n) => (n / 1024).toFixed(0) + 'K'
for (const r of rows) {
  if (r.classify) { console.log(`\n[classify] ${r.classify} -> ${r.stats.imageClass} (extremes ${(r.stats.extremeRatio*100).toFixed(1)}%, colors ${r.stats.uniqueColors})`); continue }
  if (r.error) { console.log(`${r.name} / ${r.mode}: ERROR ${r.error}`); continue }
  console.log(`\n${r.name}  [${r.mode}]`)
  console.log(`  ${kb(r.before)} -> ${kb(r.after)}  (${r.pct.toFixed(1)}% smaller)  ${r.technique} / ${r.format}  ${r.ms}ms`)
  for (const n of r.notes) console.log(`    - ${n}`)
}
await browser.close()
