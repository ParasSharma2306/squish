/**
 * Browsers that can't encode AVIF silently fall back to PNG instead of
 * throwing (per the canvas spec), so we have to actually probe for it
 * rather than offer the option unconditionally.
 */
let cached: Promise<boolean> | null = null

export function isAvifEncodeSupported(): Promise<boolean> {
  if (!cached) {
    cached = new Promise((resolve) => {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      canvas.toBlob((blob) => resolve(!!blob && blob.type === 'image/avif'), 'image/avif')
    })
  }
  return cached
}
