import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const scratch = '/tmp/claude-1000/-home-paras-dev-web-squish/c6f217bd-5a2d-4ec3-b71c-506d2970a942/scratchpad'
const srcPath = path.join(scratch, 'readability-source.pdf')

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('console', (m) => console.log('PAGE:', m.text()))
await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })

const b64 = readFileSync(srcPath).toString('base64')

// Reproduce the OLD algorithm exactly: scale=2 first, binary search quality
// across the FULL [0, 1] range with no floor, return as soon as ANY quality
// fits under target (which is what let quality collapse to near-zero).
const dataUrl = await page.evaluate(
  async ({ b64 }) => {
    const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.mjs')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
    const { PDFDocument } = await import('/node_modules/pdf-lib/dist/pdf-lib.esm.js')

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
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

    const targetBytes = 100 * 1024
    const SCALE_ATTEMPTS = [2, 1.4, 1, 0.7]
    let bestBytes = null
    let usedScale = null
    let usedQuality = null

    outer: for (const scale of SCALE_ATTEMPTS) {
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
      if (bestBytes) break outer
    }

    // Render page 1 of whatever the old algorithm landed on, to PNG, for
    // a direct visual comparison against the new algorithm's output.
    const resultDoc = await pdfjsLib.getDocument({ data: bestBytes }).promise
    const p1 = await resultDoc.getPage(1)
    const viewport = p1.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')
    await p1.render({ canvasContext: ctx, viewport, canvas }).promise

    return { png: canvas.toDataURL('image/png'), usedScale, usedQuality, size: bestBytes.length }
  },
  { b64 },
)

console.log('OLD ALGORITHM landed on: scale =', dataUrl.usedScale, ' quality =', dataUrl.usedQuality, ' size =', dataUrl.size, 'bytes')
writeFileSync(path.join(scratch, 'old-behavior-page1.png'), Buffer.from(dataUrl.png.split(',')[1], 'base64'))
console.log('wrote old-behavior-page1.png')

await browser.close()
