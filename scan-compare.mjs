import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PDFDocument } from 'pdf-lib'

const scratch = '/tmp/claude-1000/-home-paras-dev-web-squish/c6f217bd-5a2d-4ec3-b71c-506d2970a942/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()) })
await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })

// Render 3 "scanned" pages: paragraph text drawn onto a canvas at ~200 DPI
// (like a real phone-scanned document), exported as JPEG, so the PDF's
// natural size is realistically large instead of tiny vector text.
const paragraph =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
  'How vexingly quick daft zebras jump! Squish compresses PDFs while trying to keep this ' +
  'text sharp enough to actually read, rather than turning it into mush. 0123456789.'

async function makeScanPage(seed) {
  const dataUrl = await page.evaluate(
    ({ paragraph, seed }) => {
      const w = 1700
      const h = 2200
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const ctx = c.getContext('2d')
      // faint paper texture / noise so it behaves like a real scan, not a
      // perfectly flat vector-like render
      ctx.fillStyle = '#fafaf7'
      ctx.fillRect(0, 0, w, h)
      const imgData = ctx.getImageData(0, 0, w, h)
      let s = seed
      for (let i = 0; i < imgData.data.length; i += 4) {
        s = (s * 9301 + 49297) % 233280
        const n = (s / 233280) * 6 - 3
        imgData.data[i] += n
        imgData.data[i + 1] += n
        imgData.data[i + 2] += n
      }
      ctx.putImageData(imgData, 0, 0)
      ctx.fillStyle = '#1a1a1a'
      ctx.font = '26px Georgia, serif'
      let y = 100
      for (let line = 0; line < 55; line++) {
        ctx.fillText(paragraph.slice(0, 100), 60, y)
        y += 38
      }
      return c.toDataURL('image/jpeg', 0.97)
    },
    { paragraph, seed },
  )
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

const pdf = await PDFDocument.create()
for (let i = 0; i < 3; i++) {
  const jpegBytes = await makeScanPage(1000 + i * 777)
  const embedded = await pdf.embedJpg(jpegBytes)
  const p = pdf.addPage([612, 792])
  p.drawImage(embedded, { x: 0, y: 0, width: 612, height: 792 })
}
const srcBytes = await pdf.save()
const srcPath = path.join(scratch, 'scan-source.pdf')
writeFileSync(srcPath, srcBytes)
console.log('SCAN SOURCE SIZE:', srcBytes.length, 'bytes (', (srcBytes.length / 1024).toFixed(1), 'KB)')

const TARGET_KB = 60

// --- Run through the REAL app (new algorithm) ---
await page.getByRole('tab', { name: 'Compress' }).click()
await page.waitForTimeout(400)
await page.locator('input[type=file]').first().setInputFiles([srcPath])
await page.waitForTimeout(400)
await page.fill('#target', String(TARGET_KB))
await page.getByRole('button', { name: /compress all/i }).click()
await page.waitForTimeout(60000)
console.log('NEW ALGORITHM RESULT:', (await page.locator('.file-list').innerText()).replace(/\n/g, ' | '))

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.icon-btn[title="Download"]').first().click(),
])
const newOutPath = path.join(scratch, 'scan-new.pdf')
await download.saveAs(newOutPath)

// --- Run the OLD algorithm (no quality floor) directly against the same source/target ---
const srcB64 = readFileSync(srcPath).toString('base64')
const oldResult = await page.evaluate(
  async ({ srcB64, targetBytes }) => {
    const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const { PDFDocument } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')
    const bytes = Uint8Array.from(atob(srcB64), (c) => c.charCodeAt(0))
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise

    async function renderPages(scale) {
      const canvases = []
      for (let i = 1; i <= doc.numPages; i++) {
        const p = await doc.getPage(i)
        const viewport = p.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const ctx = canvas.getContext('2d')
        await p.render({ canvasContext: ctx, viewport, canvas }).promise
        canvases.push(canvas)
      }
      return canvases
    }
    function canvasToBlob(canvas, type, quality) {
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
    }
    async function buildPdf(canvases, quality) {
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

    const SCALE_ATTEMPTS = [2, 1.4, 1, 0.7]
    let bestBytes = null
    let usedScale = null
    let usedQuality = null

    for (const scale of SCALE_ATTEMPTS) {
      const canvases = await renderPages(scale)
      let lo = 0
      let hi = 1
      for (let i = 0; i < 6; i++) {
        const q = (lo + hi) / 2
        const out = await buildPdf(canvases, q)
        if (out.length <= targetBytes) {
          bestBytes = out
          usedScale = scale
          usedQuality = q
          lo = q
        } else {
          hi = q
        }
      }
      if (bestBytes) break
    }

    return { bytes: Array.from(bestBytes), usedScale, usedQuality, size: bestBytes.length }
  },
  { srcB64, targetBytes: TARGET_KB * 1024 },
)
console.log('OLD ALGORITHM landed on: scale =', oldResult.usedScale, ' quality =', oldResult.usedQuality, ' size =', oldResult.size, 'bytes')
const oldOutPath = path.join(scratch, 'scan-old.pdf')
writeFileSync(oldOutPath, Buffer.from(oldResult.bytes))

// --- Render page 1 of both for direct visual comparison ---
async function renderFirstPageToPng(pdfPath, outName) {
  const b64 = readFileSync(pdfPath).toString('base64')
  const dataUrl = await page.evaluate(
    async ({ b64 }) => {
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
  writeFileSync(path.join(scratch, outName), Buffer.from(dataUrl.split(',')[1], 'base64'))
  console.log('wrote', outName)
}

await renderFirstPageToPng(newOutPath, 'scan-new-page1.png')
await renderFirstPageToPng(oldOutPath, 'scan-old-page1.png')

await browser.close()
