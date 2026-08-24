import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const scratch = '/tmp/claude-1000/-home-paras-dev-web-squish/c6f217bd-5a2d-4ec3-b71c-506d2970a942/scratchpad'
const browser = await chromium.launch()
const page = await browser.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto('http://localhost:5174/', { waitUntil: 'networkidle' })

const dataUrl = await page.evaluate(() => {
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 900
  const ctx = c.getContext('2d')
  // photo-like gradient + noise so it doesn't compress trivially
  const grad = ctx.createLinearGradient(0, 0, 1200, 900)
  grad.addColorStop(0, '#4f46e5')
  grad.addColorStop(1, '#16a34a')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 1200, 900)
  const img = ctx.getImageData(0, 0, 1200, 900)
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 40
    img.data[i] += n
    img.data[i + 1] += n
    img.data[i + 2] += n
  }
  ctx.putImageData(img, 0, 0)
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 40px sans-serif'
  ctx.fillText('Readable label text', 60, 460)
  return c.toDataURL('image/png')
})
const srcPath = path.join(scratch, 'imgcheck-source.png')
writeFileSync(srcPath, Buffer.from(dataUrl.split(',')[1], 'base64'))

await page.getByRole('tab', { name: 'Compress' }).click()
await page.waitForTimeout(400)
await page.locator('input[type=file]').first().setInputFiles([srcPath])
await page.waitForTimeout(400)
await page.fill('#target', '15')
await page.getByRole('button', { name: /compress all/i }).click()
await page.waitForTimeout(15000)
console.log('RESULT:', (await page.locator('.file-list').innerText()).replace(/\n/g, ' | '))

const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.locator('.icon-btn[title="Download"]').first().click(),
])
await download.saveAs(path.join(scratch, 'imgcheck-result.webp'))

console.log('ERRORS:', JSON.stringify(errors))
await browser.close()
