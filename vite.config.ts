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

// Names every Workbox cache bucket, so bumping it orphans the previous
// deploy's caches rather than letting a stale entry outlive it. While
// `selfDestroying` is on below the generated worker ignores this whole config,
// so this is dormant — it's the switch to turn if caching is ever restored,
// and it is already bumped past the v1 buckets the last release wrote.
const CACHE_VERSION = 'v2'

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
      // Caching is off. The previous release shipped a precaching service
      // worker, and an installed one keeps answering from its own cache long
      // after the deploy that replaced it — so simply deleting the config
      // would strand those clients on old assets forever. `selfDestroying`
      // instead ships a service worker whose only job is to unregister itself
      // and delete every cache it finds, which is what actually gets an
      // existing install back onto the network. The manifest below still
      // ships, so the install prompt survives; what is gone is offline use and
      // every cached response.
      selfDestroying: true,
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
        cacheId: `squish-${CACHE_VERSION}`,
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
            options: { cacheName: `pdfjs-worker-${CACHE_VERSION}` },
          },
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/pdfjs-wasm/'),
            handler: 'CacheFirst',
            options: { cacheName: `pdfjs-wasm-${CACHE_VERSION}` },
          },
          {
            // oxipng, and any other lazily-fetched wasm under /assets.
            urlPattern: ({ url }: { url: URL }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: `squish-wasm-${CACHE_VERSION}` },
          },
        ],
      },
    }),
  ],
})
