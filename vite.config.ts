import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
        // pdf.js worker + wasm are fetched at runtime; cache them too
        runtimeCaching: [
          {
            urlPattern: ({ url }: { url: URL }) => url.pathname.includes('pdf.worker'),
            handler: 'CacheFirst',
            options: { cacheName: 'pdfjs-worker' },
          },
        ],
      },
    }),
  ],
})
