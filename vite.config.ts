import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// pdf.js 6 moved JBIG2, CCITT, JPEG 2000 and colour-management decoding into
// WASM modules that it fetches at runtime from a directory given by the
// `wasmUrl` API parameter. They ship inside the pdfjs-dist package, which
// isn't web-reachable, so without this they 404 and every scanned PDF using
// those encodings silently fails to decode. Serving them straight out of
// node_modules keeps them pinned to the installed pdfjs-dist version instead
// of drifting as a hand-copied snapshot in public/.
const PDF_WASM_ROUTE = '/pdfjs-wasm/'

function pdfjsWasm(): Plugin {
  const sourceDir = fileURLToPath(new URL('./node_modules/pdfjs-dist/wasm/', import.meta.url))
  const files = () => readdirSync(sourceDir).filter((name) => statSync(join(sourceDir, name)).isFile())

  return {
    name: 'squish:pdfjs-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        if (!path?.startsWith(PDF_WASM_ROUTE)) return next()
        const name = path.slice(PDF_WASM_ROUTE.length)
        if (!name || name.includes('/')) return next()
        let file: string
        try {
          file = join(sourceDir, name)
          statSync(file)
        } catch {
          return next()
        }
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        createReadStream(file).pipe(res)
      })
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({
          type: 'asset',
          fileName: `pdfjs-wasm/${name}`,
          source: readFileSync(join(sourceDir, name)),
        })
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    pdfjsWasm(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'logo.svg'],
      manifest: {
        id: 'https://squish.parassharma.in/',
        name: 'Squish',
        short_name: 'Squish',
        description:
          'Convert image formats, combine images into a PDF, and compress images or PDFs to a target size, entirely in your browser.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        categories: ['utilities', 'productivity', 'photo'],
        background_color: '#312e81',
        theme_color: '#4f46e5',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // pdf.js ships large `*_nowasm_fallback.js` files next to its wasm.
        // The glob above would sweep those into the precache — ~580 KB of
        // fallbacks that are only reachable when wasm is unavailable — while
        // still missing the .wasm files that actually get used. Both are
        // handled by runtime caching below instead, so a first install stays
        // small and each module is cached the first time it's genuinely needed.
        globIgnores: ['pdfjs-wasm/**'],
        // pdf.js worker + wasm are fetched at runtime; cache them too
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.includes('pdf.worker'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-worker' },
          },
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/pdfjs-wasm/'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-wasm' },
          },
          {
            // oxipng, and any other lazily-fetched wasm under /assets.
            urlPattern: ({ url }: { url: URL }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: 'squish-wasm' },
          },
        ],
      },
    }),
  ],
})
