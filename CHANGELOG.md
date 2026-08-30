# Changelog

All notable changes to Squish are recorded here. This project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-08-30

The first stable release. The beta line ends here: the compression engine and
the interface shipped in `0.4.0-beta.1` have held up in use, so they are now
the 1.0 surface, with no functional changes from the beta.

### Changed

- **Sponsor avatars.** The sponsors carousel shows each sponsor's GitHub avatar
  in place of the generated initials. The images are checked into the repo and
  bundled with the app rather than hotlinked from GitHub, so the promise that
  Squish issues no third-party requests still holds.
- Sponsor amounts read as a plain figure (`$30`) instead of a monthly rate
  (`$30/mo`).

## [0.4.0-beta.1] — 2026-08-27

A rebuild of the compression engine and the interface around it. Compression is
now chosen per file from what the file actually is, and every result reports the
technique and the real numbers behind it.

### Added

- **Best quality mode.** A second compression mode that shrinks a file as far as
  it can go without a visible difference, instead of driving toward a byte
  budget. Quality is searched against a measured SSIM floor per image, with
  three named levels (Visually identical / High / Balanced). Target size mode is
  unchanged and still the default.
- **Content-aware routing.** Images are classified as photographic, flat-colour
  or bilevel before anything is encoded. Photographs take a lossy codec;
  screenshots, diagrams and flat artwork take a lossless median-cut palette plus
  oxipng, which lossy codecs handle badly.
- **CCITT Group 4 bilevel coding for PDFs.** Scanned pages are detected,
  thresholded with Otsu's method, and coded losslessly with a hand-written
  ITU-T T.6 encoder. This is the largest single win on scanned documents. It is
  only kept when it beats the JPEG alternative, which it does not on noisy or
  dithered scans.
- **DPI-aware downsampling for PDFs.** Embedded images are downsampled to suit
  the size they are actually drawn at on the page — recovered by replaying the
  content stream's graphics state to get the transformation matrix in force at
  each paint — rather than whatever resolution the source over-provisioned.
- **Embedded font deduplication.** Byte-identical embedded font programs are
  merged. Note this is deduplication, not subsetting; see *Known limitations*.
- **Per-file reporting.** Every compressed file reports original size, new size,
  real percentage reduction, the technique used, the output format, and
  technique-specific detail (palette size, quality, measured SSIM, DPI cap,
  duplicates merged).
- **Batch totals.** A multi-file job aggregates total bytes saved, overall
  reduction, and the single best per-file result.
- **Before / after comparison.** Per-image side-by-side preview with both sizes.
- **`oxipng`** (`@jsquash/oxipng`) as the lossless PNG optimiser. ~160 KB of
  WASM, dynamically imported so it is only fetched when the PNG path runs.
- **Benchmark and verification scripts**: `ccitt-roundtrip-check.mjs`,
  `engine-benchmark.mjs`, `pdf-benchmark.mjs`.

### Fixed

- **pdf.js WASM modules were never served, so scanned PDFs silently failed.**
  pdf.js 6 moved JBIG2, CCITT, JPEG 2000 and colour-management decoding into
  WASM modules fetched at runtime from a `wasmUrl` directory. That parameter was
  never set, so those modules 404'd and any PDF whose images used those
  encodings — which is most scanned documents — had its images silently dropped
  from compression. They are now served from `node_modules` in development and
  emitted into the build by a Vite plugin, pinned to the installed pdfjs-dist
  version.
- **Median-cut quantization collapsed to two colours** whenever one colour held
  more than half the pixels, which is the normal case for a screenshot
  background. The split index was not clamped, so the entire box landed on one
  side and the split stalled.
- **Mobile form layout** reserved a 150px height floor per field, because the
  desktop `flex: 1 1 150px` resolves its basis against the cross axis once the
  row becomes a column.
- **Before/after previews rendered broken images** under React StrictMode: the
  object URLs were built in a `useState` initializer that does not re-run, so
  the second mount kept URLs the first cleanup had already revoked.

### Changed

- **Breaking — library API.** `compressImageToTarget(file, targetBytes, format)`
  is superseded by `compressImage(file, { mode, format })`, and
  `compressPdfToTarget(file, targetBytes, onProgress)` by
  `compressPdf(file, mode, onProgress)`. Both now return a `report` alongside
  the output. `compressImageToTarget` remains exported and unchanged as the
  target-mode implementation; `compressPdfToTarget` is gone. Only relevant if
  you import Squish's modules directly.
- **Breaking — default image output format** is now **Auto**, which picks by
  content (photographs to WebP, flat artwork stays PNG) rather than defaulting
  to WebP for everything. Every explicit format remains selectable, and an
  explicit choice is always honoured.
- **Breaking — files that cannot be improved are returned untouched** and
  reported as "Left as-is", rather than being re-encoded into a larger file.
  Output filenames in Auto mode follow the format actually chosen.
- **PDF progress reporting** gained a `finalising` stage; `PdfCompressProgress`
  dropped its unused `scaleAttempt` field.
- **Interface redesign** around the new reporting: a mode switch, per-file
  savings bars whose width is the measured ratio, technique chips, expandable
  detail, batch totals, and designed idle / processing / done / error states.
  The no-uploads, no-accounts, no-tracking, works-offline positioning is now
  stated on the page itself rather than only in the README and privacy policy.
- **Copy** no longer states or implies any fixed compression ratio anywhere in
  the app, the README, or code comments. The README's "shrinks by two or three
  orders of magnitude" claim is gone.
- **Removed four stale development scripts** (`scan-compare.mjs`,
  `readability-check.mjs`, `old-behavior-check.mjs`, `image-compress-check.mjs`)
  that hardcoded a dead temporary path and drove UI selectors that no longer
  exist. The three new benchmark scripts replace them.

### Known limitations

- **JBIG2 is not available.** It would compress scanned text further than Group
  4 by building a dictionary of repeated glyph shapes, but no JBIG2 *encoder*
  exists for JavaScript or WASM — only decoders. Group 4 is the strongest
  bilevel coding that can currently be produced in a browser, and unlike JBIG2
  it is decodable by every PDF reader with no added bundle weight.
- **Fonts are deduplicated, not subsetted.** Trimming unused glyphs requires
  parsing content streams to determine which glyphs are drawn and then
  rewriting the CFF/TrueType tables.
- **No AVIF or JPEG XL WASM encoder.** The AVIF encoder alone is ~3.4 MB, larger
  than Squish's entire build, and JPEG XL output cannot be decoded by most
  browsers. AVIF is still offered wherever the browser can encode it natively,
  at no bundle cost.
- **Perceptual quality is judged by SSIM, not butteraugli.** Butteraugli only
  exists inside libjxl, a multi-megabyte WASM payload, and SSIM is sufficient
  for the accept/retry decision being made.

## [0.3.0-beta]

- Recompress embedded PDF images in place instead of rasterizing whole pages,
  preserving text selectability.
- Substantially faster PDF compression: the size search estimates from encoded
  byte lengths instead of re-serializing the document each step.
- Structural cleanup — metadata and thumbnail stripping, duplicate image
  merging, unreferenced object collection, object-stream output.
