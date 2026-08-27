/**
 * ITU-T T.6 (CCITT Group 4) encoder.
 *
 * Scanned text pages are the worst possible input for JPEG: the codec
 * spends its bit budget describing ringing around every letter edge, and
 * still leaves the text looking chewed. Group 4 instead codes each row as
 * a set of differences against the row above, which is exactly the
 * structure a page of text has, and it is lossless once the page has been
 * thresholded to ink/paper.
 *
 * JBIG2 would compress these pages further still (it can build a
 * dictionary of repeated glyph shapes), but no JBIG2 *encoder* exists for
 * JS or WASM — only decoders. Group 4 is the strongest bilevel coding
 * that can actually be produced in a browser today, and unlike JBIG2 it is
 * decodable by every PDF reader ever shipped, with no extra bundle weight.
 */

/** Terminating codes for runs 0-63, as "bitstring" indexed by run length. */
const WHITE_TERMINATING = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111',
  '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100',
  '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000',
  '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000',
  '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
]

const BLACK_TERMINATING = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011',
  '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000',
  '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111',
  '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111',
  '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
]

/** Make-up codes for multiples of 64, indexed by (runLength / 64) - 1. */
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101',
  '01101000', '01100111', '011001100', '011001101', '011010010', '011010011', '011010100', '011010101',
  '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001',
  '010011010', '011000', '010011011',
]

const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100',
  '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100',
  '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010',
  '0000001011011', '0000001100100', '0000001100101',
]

/** Extended make-up codes 1792-2560 are shared by both colours. */
const SHARED_MAKEUP = [
  '00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110',
  '000000010111', '000000011100', '000000011101', '000000011110', '000000011111',
]

const MODE_PASS = '0001'
const MODE_HORIZONTAL = '001'
/** Vertical mode codes for a1-b1 offsets of -3..+3. */
const MODE_VERTICAL: Record<number, string> = {
  0: '1',
  1: '011',
  2: '000011',
  3: '0000011',
  [-1]: '010',
  [-2]: '000010',
  [-3]: '0000010',
}

const EOFB = '000000000001000000000001'

const WHITE = 0

class BitWriter {
  private bytes: number[] = []
  private current = 0
  private filled = 0

  write(bits: string) {
    for (let i = 0; i < bits.length; i++) {
      this.current = (this.current << 1) | (bits.charCodeAt(i) === 49 ? 1 : 0)
      this.filled++
      if (this.filled === 8) {
        this.bytes.push(this.current)
        this.current = 0
        this.filled = 0
      }
    }
  }

  /** Flushes the partial byte, zero-padded, as T.6 requires. */
  finish(): Uint8Array {
    if (this.filled > 0) {
      this.bytes.push(this.current << (8 - this.filled))
      this.current = 0
      this.filled = 0
    }
    return new Uint8Array(this.bytes)
  }
}

function writeRun(out: BitWriter, length: number, color: number) {
  const terminating = color === WHITE ? WHITE_TERMINATING : BLACK_TERMINATING
  const makeup = color === WHITE ? WHITE_MAKEUP : BLACK_MAKEUP
  let remaining = length

  // Runs longer than the largest single make-up code are emitted as
  // repeated 2560 blocks first.
  while (remaining >= 2624) {
    out.write(SHARED_MAKEUP[SHARED_MAKEUP.length - 1])
    remaining -= 2560
  }
  if (remaining >= 64) {
    const multiple = Math.floor(remaining / 64)
    out.write(multiple <= 27 ? makeup[multiple - 1] : SHARED_MAKEUP[multiple - 28])
    remaining -= multiple * 64
  }
  out.write(terminating[remaining])
}

/**
 * Positions where a row's colour changes, scanning left to right. Rows are
 * defined to start white, so element 0 is always a white->black transition,
 * element 1 black->white, and so on — which is what lets the coder identify
 * b1 by index parity alone.
 */
function changingElements(row: Uint8Array, offset: number, width: number): Int32Array<ArrayBuffer> {
  const positions: number[] = []
  let previous = WHITE
  for (let x = 0; x < width; x++) {
    const value = row[offset + x]
    if (value !== previous) {
      positions.push(x)
      previous = value
    }
  }
  const result = new Int32Array(positions.length)
  result.set(positions)
  return result
}

/**
 * Index of the first changing element strictly right of `after`.
 *
 * Binary search rather than a scan: a row of scanned text has hundreds of
 * changing elements and the coder queries this at every coding position, so
 * a linear scan makes each row quadratic in its own detail — precisely the
 * rows this codec exists to handle well.
 */
function firstIndexAfter(elements: Int32Array, after: number): number {
  let lo = 0
  let hi = elements.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (elements[mid] > after) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * First changing element strictly right of `after` whose transition is
 * *into* the opposite of `color`. Index parity encodes the colour being
 * transitioned into, so the parity check is the colour check.
 */
function findChanging(elements: Int32Array, after: number, color: number, width: number): number {
  let k = firstIndexAfter(elements, after)
  // Elements are increasing, so the next index still lies right of `after`.
  if ((k & 1) !== color) k++
  return k < elements.length ? elements[k] : width
}

function findNextAfter(elements: Int32Array, position: number, width: number): number {
  const k = firstIndexAfter(elements, position)
  return k < elements.length ? elements[k] : width
}

/**
 * Encodes a packed bitmap (one byte per pixel, 1 = black ink) as a Group 4
 * bitstream suitable for a PDF `CCITTFaxDecode` stream with `K = -1`.
 */
export function encodeCcittG4(bitmap: Uint8Array, width: number, height: number): Uint8Array {
  const out = new BitWriter()
  // The imaginary line above row 0 is all white, per T.6.
  let reference: Int32Array<ArrayBuffer> = new Int32Array(0)

  for (let y = 0; y < height; y++) {
    const coding = changingElements(bitmap, y * width, width)
    let a0 = -1
    let color = WHITE

    while (a0 < width) {
      const a1 = findChanging(coding, a0, color, width)
      const b1 = findChanging(reference, a0, color, width)
      const b2 = b1 >= width ? width : findNextAfter(reference, b1, width)

      if (b2 < a1) {
        out.write(MODE_PASS)
        a0 = b2
        continue
      }

      const delta = a1 - b1
      if (delta >= -3 && delta <= 3) {
        out.write(MODE_VERTICAL[delta])
        a0 = a1
        color ^= 1
        continue
      }

      const a2 = a1 >= width ? width : findNextAfter(coding, a1, width)
      out.write(MODE_HORIZONTAL)
      // The first run on a row is measured from column 0, not from the
      // notional a0 = -1 start position.
      writeRun(out, a1 - (a0 < 0 ? 0 : a0), color)
      writeRun(out, a2 - a1, color ^ 1)
      a0 = a2
    }

    reference = coding
  }

  out.write(EOFB)
  return out.finish()
}
