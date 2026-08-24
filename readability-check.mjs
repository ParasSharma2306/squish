import { chromium } from 'playwright'
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

const scratch = '/tmp/claude-1000/-home-paras-dev-web-squish/c6f217bd-5a2d-4ec3-b71c-506d2970a942/scratchpad'

// Build a realistic text-heavy PDF (paragraphs, not noise) so we can
// actually judge legibility, not just file size.
const paragraph =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
  'How vexingly quick daft zebras jump! Squish compresses PDFs while trying to keep this ' +
  'text sharp enough to actually read, rather than turning it into mush. 0123456789.'

const doc = await PDFDocument.create()
const font = await doc.embedFont(StandardFonts.Helvetica)
for (let p = 0; p < 3; p++) {
  const page = doc.addPage([612, 792]) // US letter
  let y = 740
  for (let line = 0; line < 30; line++) {
    page.drawText(paragraph.slice(0, 90), { x: 50, y, size: 11, font, color: rgb(0.1, 0.1, 0.1) })
    y -= 22
  }
}
const bytes = await doc.save()
const srcPath = path.join(scratch, 'readability-source.pdf')
writeFileSync(srcPath, bytes)
console.log('SOURCE SIZE:', bytes.length, 'bytes')

const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })
await page.getByRole('tab', { name: 'Compress' }).click()
await page.waitForTimeout(400)
await page.locator('input[type=file]').first().setInputFiles([srcPath])
await page.waitForTimeout(400)

// Source is ~3KB (vector text is tiny), so the target must be smaller than
// that to force real rasterization + compression instead of the
// already-small-enough shortcut.
await page.fill('#target', '100')
await page.selectOption('select', { label: 'KB' }).catch(() => {})
await page.getByRole('button', { name: /compress all/i }).click()
await page.waitForTimeout(60000)
console.log('RESULT (target 1KB):', (await page.locator('.file-list').innerText()).replace(/\n/g, ' | '))

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.icon-btn[title="Download"]').first().click(),
])
const outPath = path.join(scratch, 'readability-compressed.pdf')
await download.saveAs(outPath)

// Render page 1 of both source and compressed PDFs to PNG via pdf.js in-page
// for a direct visual comparison.
async function renderFirstPageToPng(pdfPath, outName) {
  const b64 = readFileSync(pdfPath).toString('base64')
  const dataUrl = await page.evaluate(
    async ({ b64 }) => {
      // @ts-ignore
      const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const docProxy = await pdfjsLib.getDocument({ data: bytes }).promise
      const p1 = await docProxy.getPage(1)
      const viewport = p1.getViewport({ scale: 2 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      await p1.render({ canvasContext: ctx, viewport, canvas }).promise
      return canvas.toDataURL('image/png')
    },
    { b64 },
  )
  const outPng = path.join(scratch, outName)
  writeFileSync(outPng, Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote', outPng)
}

await renderFirstPageToPng(srcPath, 'readability-source-page1.png')
await renderFirstPageToPng(outPath, 'readability-compressed-page1.png')

console.log('ERRORS:', JSON.stringify(errors))
await browser.close()
