/**
 * Every compression path reports what it actually did, in one shape, so the
 * UI never has to guess and never has to state a ratio that wasn't measured.
 * Percentages here are always computed from real byte counts.
 */

export type TechniqueId =
  | 'untouched'
  | 'lossy-resample'
  | 'palette-png'
  | 'lossless-png'
  | 'pdf-images'
  | 'pdf-bilevel'
  | 'pdf-structure'
  | 'pdf-rasterize'

/** Short human label per technique, used as the headline in the UI. */
export const TECHNIQUE_LABEL: Record<TechniqueId, string> = {
  untouched: 'Left as-is',
  'lossy-resample': 'Lossy re-encode',
  'palette-png': 'Palette PNG',
  'lossless-png': 'Lossless PNG',
  'pdf-images': 'Embedded images',
  'pdf-bilevel': 'Bilevel CCITT G4',
  'pdf-structure': 'Structural cleanup',
  'pdf-rasterize': 'Page rasterization',
}

/**
 * One line of "here is a thing that happened", shown in the UI's per-file
 * detail. Kept as data rather than a prebuilt sentence so the UI can
 * present it however it likes.
 */
export interface ReportNote {
  label: string
  value: string
}

export interface CompressReport {
  originalBytes: number
  newBytes: number
  /** Positive = smaller. Negative if the output grew (we then keep the original). */
  reductionPct: number
  technique: TechniqueId
  /** e.g. "WebP" or "CCITT G4" — the concrete format that came out. */
  formatLabel: string
  notes: ReportNote[]
  /** Only meaningful in target-size mode; null when compressing perceptually. */
  hitTarget: boolean | null
  /** Measured SSIM against the source, when the path computed one. */
  ssim: number | null
  width?: number
  height?: number
}

export function reductionPct(originalBytes: number, newBytes: number): number {
  if (originalBytes <= 0) return 0
  return ((originalBytes - newBytes) / originalBytes) * 100
}

export function makeReport(input: {
  originalBytes: number
  newBytes: number
  technique: TechniqueId
  formatLabel: string
  notes?: ReportNote[]
  hitTarget?: boolean | null
  ssim?: number | null
  width?: number
  height?: number
}): CompressReport {
  return {
    originalBytes: input.originalBytes,
    newBytes: input.newBytes,
    reductionPct: reductionPct(input.originalBytes, input.newBytes),
    technique: input.technique,
    formatLabel: input.formatLabel,
    notes: input.notes ?? [],
    hitTarget: input.hitTarget ?? null,
    ssim: input.ssim ?? null,
    width: input.width,
    height: input.height,
  }
}

export interface BatchTotals {
  fileCount: number
  originalBytes: number
  newBytes: number
  savedBytes: number
  /** Aggregate reduction across the whole job, from summed real byte counts. */
  reductionPct: number
  /** The single best per-file result in this batch, for honest "up to" copy. */
  bestReductionPct: number
  techniques: TechniqueId[]
}

/**
 * Aggregates a multi-file job. `bestReductionPct` is what the UI's "up to
 * X% smaller" line is allowed to cite — it's a result that actually
 * happened in this batch, not a marketing figure.
 */
export function aggregate(reports: CompressReport[]): BatchTotals {
  const originalBytes = reports.reduce((sum, r) => sum + r.originalBytes, 0)
  const newBytes = reports.reduce((sum, r) => sum + r.newBytes, 0)
  const techniques: TechniqueId[] = []
  for (const r of reports) if (!techniques.includes(r.technique)) techniques.push(r.technique)
  return {
    fileCount: reports.length,
    originalBytes,
    newBytes,
    savedBytes: Math.max(0, originalBytes - newBytes),
    reductionPct: reductionPct(originalBytes, newBytes),
    bestReductionPct: reports.reduce((best, r) => Math.max(best, r.reductionPct), 0),
    techniques,
  }
}
