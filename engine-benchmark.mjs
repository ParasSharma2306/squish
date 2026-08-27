/**
 * Measures the compression engine on real inputs and prints actual numbers.
 * Run with the dev server up: `npm run dev` then `node engine-benchmark.mjs`.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'

const browser = await chromium.launch()
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()) })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })

// Real assets from the repo, plus synthesised inputs that behave like the
// content classes the router cares about.
const assets = {
  'og-image.png': readFileSync('public/og-image.png').toString('base64'),
  'icon-512.png': readFileSync('public/icon-512.png').toString('base64'),
}

const rows = await page.evaluate(async (assets) => {
  const { compressImage, VISUAL_PRESETS } = await import('/src/lib/imageCompress.ts')

  function b64ToFile(b64, name, type) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], name, { type })
  }

  async function canvasFile(name, type, quality, draw) {
    const c = document.createElement('canvas')
    draw(c)
    const blob = await new Promise((res) => c.toBlob(res, type, quality))
    return new File([blob], name, { type })
  }

  // Multi-octave value noise over a gradient: behaves like a photograph for
  // a codec (broadband detail, no flat regions, no hard edges).
  const photo = await canvasFile('photo.jpg', 'image/jpeg', 0.95, (c) => {
    const w = 2400, h = 1600
    c.width = w; c.height = h
    const ctx = c.getContext('2d')
    const g = ctx.createLinearGradient(0, 0, w, h)
    g.addColorStop(0, '#2b4a7a'); g.addColorStop(0.5, '#c07a4a'); g.addColorStop(1, '#1d3b2a')
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h)
    const img = ctx.getImageData(0, 0, w, h)
    let s = 987654321
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    for (let octave = 1; octave <= 5; octave++) {
      const cell = 2 ** (8 - octave)
      const amp = 70 / octave
      const cols = Math.ceil(w / cell) + 1, rowsN = Math.ceil(h / cell) + 1
      const grid = new Float32Array(cols * rowsN)
      for (let i = 0; i < grid.length; i++) grid[i] = (rnd() - 0.5) * amp
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = x / cell, gy = y / cell
        const x0 = gx | 0, y0 = gy | 0
        const fx = gx - x0, fy = gy - y0
        const v = grid[y0 * cols + x0] * (1 - fx) * (1 - fy) + grid[y0 * cols + x0 + 1] * fx * (1 - fy)
                + grid[(y0 + 1) * cols + x0] * (1 - fx) * fy + grid[(y0 + 1) * cols + x0 + 1] * fx * fy
        const i = (y * w + x) * 4
        img.data[i] += v; img.data[i + 1] += v * 0.9; img.data[i + 2] += v * 1.1
      }
    }
    ctx.putImageData(img, 0, 0)
  })

  // A UI screenshot: flat fills, hard edges, text, a handful of colours.
  const screenshot = await canvasFile('screenshot.png', 'image/png', undefined, (c) => {
    const w = 1920, h = 1200
    c.width = w; c.height = h
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, 64)
    ctx.fillStyle = '#4f46e5'; ctx.fillRect(0, 64, 240, h - 64)
    for (let i = 0; i < 14; i++) {
      ctx.fillStyle = '#e2e8f0'; ctx.fillRect(280, 110 + i * 74, w - 340, 56)
      ctx.fillStyle = '#0f172a'; ctx.font = '20px sans-serif'
      ctx.fillText('Document ' + (i + 1) + ' — status pending review', 300, 145 + i * 74)
      ctx.fillStyle = '#16a34a'; ctx.fillRect(w - 160, 122 + i * 74, 80, 32)
    }
    ctx.fillStyle = '#ffffff'; ctx.font = 'bold 22px sans-serif'
    for (let i = 0; i < 8; i++) ctx.fillText('Nav item ' + i, 24, 130 + i * 52)
  })

  const inputs = [
    { file: photo, label: 'photo (2400x1600 JPEG)' },
    { file: screenshot, label: 'screenshot (1920x1200 PNG)' },
    { file: b64ToFile(assets['og-image.png'], 'og-image.png', 'image/png'), label: 'og-image.png (real)' },
    { file: b64ToFile(assets['icon-512.png'], 'icon-512.png', 'image/png'), label: 'icon-512.png (real)' },
  ]

  const out = []
  for (const { file, label } of inputs) {
    for (const mode of [
      { name: 'visual:identical', mode: { kind: 'visual', minSsim: VISUAL_PRESETS.identical } },
      { name: 'visual:high', mode: { kind: 'visual', minSsim: VISUAL_PRESETS.high } },
      { name: 'target:200KB', mode: { kind: 'target', targetBytes: 200 * 1024 } },
    ]) {
      const t0 = performance.now()
      let r
      try {
        r = await compressImage(file, { mode: mode.mode, format: 'auto' })
      } catch (e) {
        out.push({ label, mode: mode.name, error: String(e && e.message || e) })
        continue
      }
      const ms = Math.round(performance.now() - t0)
      out.push({
        label, mode: mode.name,
        before: r.report.originalBytes, after: r.report.newBytes,
        pct: r.report.reductionPct, technique: r.report.technique,
        format: r.report.formatLabel, ssim: r.report.ssim, ms,
      })
    }
  }
  return out
}, assets)

const kb = (n) => (n / 1024).toFixed(0) + 'K'
console.log('input                          mode              before   after    saved   technique        fmt   SSIM     ms')
console.log('-'.repeat(112))
for (const r of rows) {
  if (r.error) { console.log(`${r.label.padEnd(30)} ${r.mode.padEnd(17)} ERROR: ${r.error}`); continue }
  console.log(
    `${r.label.padEnd(30)} ${r.mode.padEnd(17)} ${kb(r.before).padEnd(8)} ${kb(r.after).padEnd(8)} ${(r.pct.toFixed(1) + '%').padEnd(7)} ${r.technique.padEnd(16)} ${r.format.padEnd(5)} ${(r.ssim === null ? '-' : r.ssim.toFixed(4)).padEnd(8)} ${r.ms}`,
  )
}
await browser.close()
