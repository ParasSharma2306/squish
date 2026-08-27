import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).href

/**
 * Where pdf.js fetches its JBIG2 / CCITT / JPEG 2000 / colour-management
 * WASM modules from. Served out of node_modules in dev and emitted into the
 * build by the `squish:pdfjs-wasm` Vite plugin. Without it pdf.js cannot
 * decode scanned documents stored with those filters — which is most of
 * them — and silently drops the images instead.
 */
const PDF_WASM_URL = '/pdfjs-wasm/'

/** Single entry point for opening a PDF, so wasm config can't be forgotten at a call site. */
export function loadPdfDocument(data: Uint8Array) {
  return pdfjsLib.getDocument({ data, wasmUrl: PDF_WASM_URL }).promise
}

export { pdfjsLib }
