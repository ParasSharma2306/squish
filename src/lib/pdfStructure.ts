import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
} from 'pdf-lib'

export interface ImageCandidate {
  ref: PDFRef
  key: string
  originalBytes: Uint8Array
}

// Skip images too small to be worth decoding/recompressing; the JPEG
// container overhead alone can make tiny icons/bullets bigger, not smaller.
const MIN_CANDIDATE_BYTES = 2048

const NAME_SUBTYPE = PDFName.of('Subtype')
const NAME_IMAGE = PDFName.of('Image')
const NAME_IMAGE_MASK = PDFName.of('ImageMask')
const NAME_SMASK = PDFName.of('SMask')
const NAME_MASK = PDFName.of('Mask')
const NAME_METADATA = PDFName.of('Metadata')
const NAME_THUMB = PDFName.of('Thumb')

function keyOf(ref: PDFRef): string {
  return `${ref.objectNumber}_${ref.generationNumber}`
}

/**
 * Finds embedded raster images that are safe to recompress: plain opaque
 * photos with no soft mask / stencil mask, above a minimum size. Images with
 * transparency are left untouched since JPEG re-encoding has no alpha
 * channel and would flatten/corrupt them.
 */
export function findCandidateImages(pdfDoc: PDFDocument): Map<string, ImageCandidate> {
  const result = new Map<string, ImageCandidate>()
  for (const [ref, obj] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue
    const dict = obj.dict
    if (dict.lookup(NAME_SUBTYPE) !== NAME_IMAGE) continue
    const imageMask = dict.get(NAME_IMAGE_MASK)
    if (imageMask && imageMask.toString() === 'true') continue
    if (dict.has(NAME_SMASK) || dict.has(NAME_MASK)) continue
    const originalBytes = obj.contents
    if (originalBytes.length < MIN_CANDIDATE_BYTES) continue
    result.set(keyOf(ref), { ref, key: keyOf(ref), originalBytes })
  }
  return result
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function remapRefsInline(obj: PDFObject, remap: Map<string, PDFRef>) {
  if (obj instanceof PDFDict) {
    for (const key of obj.keys()) {
      const value = obj.get(key)
      if (!value) continue
      if (value instanceof PDFRef) {
        const target = remap.get(keyOf(value))
        if (target) obj.set(key, target)
      } else {
        remapRefsInline(value, remap)
      }
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const value = obj.get(i)
      if (!value) continue
      if (value instanceof PDFRef) {
        const target = remap.get(keyOf(value))
        if (target) obj.set(i, target)
      } else {
        remapRefsInline(value, remap)
      }
    }
  } else if (obj instanceof PDFStream) {
    remapRefsInline(obj.dict, remap)
  }
}

/**
 * Detects embedded images that are byte-for-byte identical (the same photo
 * referenced from multiple pages as separate objects) and rewrites every
 * reference to point at one canonical copy. The now-unreferenced duplicates
 * are cleaned up later by [[removeUnreferencedObjects]]. Returns the
 * candidate map with duplicates removed.
 */
export function dedupeImages(
  pdfDoc: PDFDocument,
  candidates: Map<string, ImageCandidate>,
): Map<string, ImageCandidate> {
  const byLength = new Map<number, ImageCandidate[]>()
  for (const candidate of candidates.values()) {
    const group = byLength.get(candidate.originalBytes.length)
    if (group) group.push(candidate)
    else byLength.set(candidate.originalBytes.length, [candidate])
  }

  const remap = new Map<string, PDFRef>()
  const result = new Map(candidates)

  for (const group of byLength.values()) {
    if (group.length < 2) continue
    const merged = new Set<number>()
    for (let i = 0; i < group.length; i++) {
      if (merged.has(i)) continue
      for (let j = i + 1; j < group.length; j++) {
        if (merged.has(j)) continue
        if (bytesEqual(group[i].originalBytes, group[j].originalBytes)) {
          remap.set(group[j].key, group[i].ref)
          result.delete(group[j].key)
          merged.add(j)
        }
      }
    }
  }

  if (remap.size > 0) {
    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      remapRefsInline(obj, remap)
    }
  }

  return result
}

/** Replaces the image XObject at `ref` in place with a new JPEG-backed one. */
export function swapImage(pdfDoc: PDFDocument, ref: PDFRef, jpegBytes: Uint8Array, width: number, height: number) {
  const dict = pdfDoc.context.obj({
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  })
  const stream = PDFRawStream.of(dict, jpegBytes)
  pdfDoc.context.assign(ref, stream)
}

/** Clears document Info metadata, XMP metadata stream, and page thumbnails. */
export function stripMetadata(pdfDoc: PDFDocument) {
  const info = pdfDoc.context.lookupMaybe(pdfDoc.context.trailerInfo.Info, PDFDict)
  if (info) {
    for (const key of info.keys()) info.delete(key)
  }
  pdfDoc.catalog.delete(NAME_METADATA)
  for (const page of pdfDoc.getPages()) {
    page.node.delete(NAME_THUMB)
  }
}

/**
 * Mark-and-sweep garbage collection: walks every object reachable from the
 * trailer (Root + Info) and deletes any indirect object nothing points to
 * anymore — e.g. duplicate images merged by [[dedupeImages]], or metadata
 * streams dropped by [[stripMetadata]].
 */
export function removeUnreferencedObjects(pdfDoc: PDFDocument) {
  const context = pdfDoc.context
  const visitedObjects = new Set<PDFObject>()
  const visitedRefs = new Set<string>()

  function visit(obj: PDFObject | undefined) {
    if (!obj || visitedObjects.has(obj)) return
    visitedObjects.add(obj)
    if (obj instanceof PDFRef) {
      const key = keyOf(obj)
      if (visitedRefs.has(key)) return
      visitedRefs.add(key)
      visit(context.lookup(obj))
    } else if (obj instanceof PDFDict) {
      for (const key of obj.keys()) visit(obj.get(key))
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) visit(obj.get(i))
    } else if (obj instanceof PDFStream) {
      visit(obj.dict)
    }
  }

  visit(context.trailerInfo.Root)
  visit(context.trailerInfo.Info)

  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!visitedRefs.has(keyOf(ref))) context.delete(ref)
  }
}
