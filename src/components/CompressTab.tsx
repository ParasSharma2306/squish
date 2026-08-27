import { useCallback, useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { Dropzone } from './Dropzone'
import { compressImage, VISUAL_PRESETS, type VisualPreset } from '../lib/imageCompress'
import { compressPdf, DPI_PRESETS, type DpiPreset } from '../lib/pdfCompress'
import { FORMAT_EXT, FORMAT_LABEL, type OutputFormat } from '../lib/imageConvert'
import { isAvifEncodeSupported } from '../lib/avifSupport'
import { aggregate, TECHNIQUE_LABEL, type CompressReport } from '../lib/compressReport'
import { downloadBlob, formatBytes, nextId, parseSizeToBytes, stripExtension } from '../lib/fileUtils'
import { IconCheck, IconClose, IconDownload, IconImage, IconLock, IconPdf } from './icons'

type Kind = 'image' | 'pdf'
type Status = 'pending' | 'working' | 'done' | 'error'
type Mode = 'target' | 'visual'
type FormatChoice = OutputFormat | 'auto'

interface CompressItem {
  id: string
  file: File
  kind: Kind
  status: Status
  note?: string
  resultBlob?: Blob
  report?: CompressReport
  error?: string
}

const BASE_IMAGE_FORMATS: OutputFormat[] = ['webp', 'jpeg', 'png', 'bmp']

const VISUAL_PRESET_COPY: Record<VisualPreset, { label: string; hint: string }> = {
  identical: { label: 'Visually identical', hint: 'Strictest. Stops the moment a difference could show.' },
  high: { label: 'High', hint: 'Very close to the original, noticeably smaller.' },
  balanced: { label: 'Balanced', hint: 'Smallest files, slight softening on close inspection.' },
}

const DPI_COPY: Record<DpiPreset, { label: string; hint: string }> = {
  screen: { label: 'Screen', hint: '150 DPI — reading on a device' },
  print: { label: 'Print', hint: '300 DPI — keeps print detail' },
}

/**
 * Proportional savings bar. The track is the original size and the fill is
 * the part that went away, so a longer bar always means a better result —
 * the width *is* the measured ratio, so it cannot overstate the saving.
 */
function SavingsBar({ report }: { report: CompressReport }) {
  const saved = Math.max(0, Math.min(1, report.reductionPct / 100))
  return (
    <div className="savings-bar" aria-hidden="true">
      <div className="savings-bar-fill" style={{ width: `${saved * 100}%` }} />
    </div>
  )
}

/**
 * Side-by-side original vs. compressed.
 *
 * Mounting this component *is* the act of opening the comparison, so the
 * object URLs can be built once on mount and released on unmount. That keeps
 * a queue of fifty files from holding a hundred blob URLs alive for previews
 * nobody opened.
 */
function ComparePanel({ file, result, report }: { file: File; result: Blob; report: CompressReport }) {
  const [urls, setUrls] = useState<{ original: string; result: string } | null>(null)

  // The object URL registry is genuinely external state, and it has to be
  // driven from the effect rather than a `useState` initializer: under
  // StrictMode the effect is mounted, cleaned up, and mounted again, and a
  // once-only initializer would hand the second mount URLs the first
  // cleanup had already revoked — which renders as two broken images.
  useEffect(() => {
    const original = URL.createObjectURL(file)
    const resultUrl = URL.createObjectURL(result)
    // oxlint-disable-next-line react/set-state-in-effect
    setUrls({ original, result: resultUrl })
    return () => {
      URL.revokeObjectURL(original)
      URL.revokeObjectURL(resultUrl)
    }
  }, [file, result])

  if (!urls) return null

  return (
    <div className="compare-grid">
      <figure>
        <img src={urls.original} alt="Original" loading="lazy" />
        <figcaption>
          Original · <b>{formatBytes(report.originalBytes)}</b>
        </figcaption>
      </figure>
      <figure>
        <img src={urls.result} alt="Compressed" loading="lazy" />
        <figcaption>
          {report.formatLabel} · <b>{formatBytes(report.newBytes)}</b>
        </figcaption>
      </figure>
    </div>
  )
}

function ResultDetail({ item }: { item: CompressItem }) {
  const report = item.report!
  const [previewOpen, setPreviewOpen] = useState(false)

  return (
    <div className="result-detail">
      <dl className="detail-grid">
        {report.notes.map((note) => (
          <div className="detail-pair" key={note.label + note.value}>
            <dt>{note.label}</dt>
            <dd>{note.value}</dd>
          </div>
        ))}
      </dl>
      {item.kind === 'image' && item.resultBlob && (
        <>
          <button className="link-btn" onClick={() => setPreviewOpen((open) => !open)}>
            {previewOpen ? 'Hide comparison' : 'Compare before / after'}
          </button>
          {previewOpen && <ComparePanel file={item.file} result={item.resultBlob} report={report} />}
        </>
      )}
    </div>
  )
}

export function CompressTab() {
  const [items, setItems] = useState<CompressItem[]>([])
  const [mode, setMode] = useState<Mode>('target')
  const [targetValue, setTargetValue] = useState(500)
  const [targetUnit, setTargetUnit] = useState<'KB' | 'MB'>('KB')
  const [preset, setPreset] = useState<VisualPreset>('identical')
  const [dpi, setDpi] = useState<DpiPreset>('screen')
  const [imageFormat, setImageFormat] = useState<FormatChoice>('auto')
  const [busy, setBusy] = useState(false)
  const [avifSupported, setAvifSupported] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    isAvifEncodeSupported().then(setAvifSupported)
  }, [])

  const imageFormats = useMemo<FormatChoice[]>(
    () => ['auto', ...BASE_IMAGE_FORMATS, ...(avifSupported ? (['avif'] as const) : [])],
    [avifSupported],
  )

  const doneItems = useMemo(() => items.filter((i) => i.status === 'done' && i.report), [items])
  const totals = useMemo(() => aggregate(doneItems.map((i) => i.report!)), [doneItems])
  const targetBytes = parseSizeToBytes(targetValue, targetUnit)

  function addFiles(files: File[]) {
    const newItems: CompressItem[] = files
      .filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf')
      .map((file) => ({
        id: nextId(),
        file,
        kind: file.type === 'application/pdf' ? 'pdf' : 'image',
        status: 'pending',
      }))
    setItems((prev) => [...prev, ...newItems])
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  function update(id: string, patch: Partial<CompressItem>) {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)))
  }

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  async function compressAll() {
    setBusy(true)
    for (const item of items) {
      update(item.id, { status: 'working', note: undefined, report: undefined, resultBlob: undefined })
      try {
        if (item.kind === 'image') {
          const result = await compressImage(item.file, {
            mode:
              mode === 'target'
                ? { kind: 'target', targetBytes }
                : { kind: 'visual', minSsim: VISUAL_PRESETS[preset] },
            format: imageFormat,
          })
          update(item.id, { status: 'done', resultBlob: result.blob, report: result.report })
        } else {
          const result = await compressPdf(
            item.file,
            mode === 'target' ? { kind: 'target', targetBytes } : { kind: 'visual', maxDpi: DPI_PRESETS[dpi] },
            (p) => update(item.id, { note: p.detail }),
          )
          update(item.id, {
            status: 'done',
            resultBlob: new Blob([result.bytes as BlobPart], { type: 'application/pdf' }),
            report: result.report,
            note: undefined,
          })
        }
      } catch {
        update(item.id, { status: 'error', error: 'Could not compress this file' })
      }
    }
    setBusy(false)
  }

  function outName(item: CompressItem) {
    const base = stripExtension(item.file.name)
    if (item.kind === 'pdf') return `${base}-compressed.pdf`
    const report = item.report
    // Name the file after what actually came out, which in 'auto' mode is
    // only known once the engine has picked a format.
    const label = report?.formatLabel.toLowerCase()
    const known = BASE_IMAGE_FORMATS.concat(['avif']).find((f) => FORMAT_LABEL[f].toLowerCase() === label)
    if (known) return `${base}.${FORMAT_EXT[known]}`
    if (imageFormat !== 'auto') return `${base}.${FORMAT_EXT[imageFormat]}`
    return item.file.name
  }

  function downloadOne(item: CompressItem) {
    if (item.resultBlob) downloadBlob(item.resultBlob, outName(item))
  }

  async function downloadAll() {
    if (doneItems.length === 0) return
    if (doneItems.length === 1) return downloadOne(doneItems[0])
    const zip = new JSZip()
    doneItems.forEach((i) => zip.file(outName(i), i.resultBlob!))
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, 'squish-compressed.zip')
  }

  return (
    <div className="card">
      <div className="card-head">
        <h2 className="section-title">Compress</h2>
        <p className="section-sub">
          Pick how you want to decide the trade-off. Every file reports exactly what it did.
        </p>
      </div>

      <div className="mode-switch" role="tablist" aria-label="Compression mode">
        <button
          role="tab"
          aria-selected={mode === 'target'}
          className={`mode-btn${mode === 'target' ? ' active' : ''}`}
          onClick={() => setMode('target')}
        >
          <span className="mode-title">Target size</span>
          <span className="mode-hint">Get under a limit</span>
        </button>
        <button
          role="tab"
          aria-selected={mode === 'visual'}
          className={`mode-btn${mode === 'visual' ? ' active' : ''}`}
          onClick={() => setMode('visual')}
        >
          <span className="mode-title">Best quality</span>
          <span className="mode-hint">As small as it can go, unnoticed</span>
        </button>
      </div>

      <Dropzone
        accept="image/*,application/pdf"
        onFiles={addFiles}
        label="Drop images or PDFs here, or click to browse"
        hint="Nothing is uploaded. Compression runs on this device."
      />

      <div className="field-row">
        {mode === 'target' ? (
          <div className="field">
            <label htmlFor="target">Target size</label>
            <div className="size-input">
              <input
                id="target"
                type="number"
                min={1}
                value={targetValue}
                onChange={(e) => setTargetValue(Math.max(1, Number(e.target.value)))}
              />
              <select value={targetUnit} onChange={(e) => setTargetUnit(e.target.value as 'KB' | 'MB')}>
                <option value="KB">KB</option>
                <option value="MB">MB</option>
              </select>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor="preset">Image quality floor</label>
              <select id="preset" value={preset} onChange={(e) => setPreset(e.target.value as VisualPreset)}>
                {(Object.keys(VISUAL_PRESET_COPY) as VisualPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {VISUAL_PRESET_COPY[key].label}
                  </option>
                ))}
              </select>
              <span className="field-hint">{VISUAL_PRESET_COPY[preset].hint}</span>
            </div>
            <div className="field">
              <label htmlFor="dpi">PDF resolution</label>
              <select id="dpi" value={dpi} onChange={(e) => setDpi(e.target.value as DpiPreset)}>
                {(Object.keys(DPI_COPY) as DpiPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {DPI_COPY[key].label}
                  </option>
                ))}
              </select>
              <span className="field-hint">{DPI_COPY[dpi].hint}</span>
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="img-format">Image format</label>
          <select
            id="img-format"
            value={imageFormat}
            onChange={(e) => setImageFormat(e.target.value as FormatChoice)}
          >
            {imageFormats.map((f) => (
              <option key={f} value={f}>
                {f === 'auto' ? 'Auto (match content)' : FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
          {imageFormat === 'auto' && <span className="field-hint">Photos to WebP, flat art stays PNG</span>}
        </div>
      </div>

      <div className="actions-row">
        <button className="btn" disabled={items.length === 0 || busy} onClick={compressAll}>
          {busy ? 'Compressing…' : items.length > 0 ? `Compress ${items.length} file${items.length === 1 ? '' : 's'}` : 'Compress'}
        </button>
        {doneItems.length > 1 && (
          <button className="btn btn-secondary" onClick={downloadAll}>
            Download all (.zip)
          </button>
        )}
      </div>

      {doneItems.length > 0 && (
        <div className="batch-summary">
          <div className="batch-headline">
            <span className="batch-total">{formatBytes(totals.savedBytes)} saved</span>
            <span className="batch-sub">
              {totals.fileCount} file{totals.fileCount === 1 ? '' : 's'} · {formatBytes(totals.originalBytes)} →{' '}
              {formatBytes(totals.newBytes)}
            </span>
          </div>
          <div className="batch-figures">
            <div className="figure">
              <span className="figure-value">{totals.reductionPct.toFixed(0)}%</span>
              <span className="figure-label">smaller overall</span>
            </div>
            <div className="figure">
              <span className="figure-value">{totals.bestReductionPct.toFixed(0)}%</span>
              <span className="figure-label">best single file</span>
            </div>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="empty-state">Nothing queued yet. Add images or PDFs above.</div>
      ) : (
        <div className="file-list">
          {items.map((item) => {
            const report = item.report
            const isOpen = expanded.has(item.id)
            return (
              <div className={`file-card file-card-${item.status}`} key={item.id}>
                <div className="file-row">
                  <span className="file-type-icon">
                    {item.kind === 'pdf' ? <IconPdf size={20} /> : <IconImage size={20} />}
                  </span>
                  <div className="file-meta">
                    <div className="file-name">{item.file.name}</div>
                    {item.status === 'done' && report ? (
                      <>
                        <div className="file-sub">
                          <span className="strike">{formatBytes(report.originalBytes)}</span>
                          <b className="result-size">{formatBytes(report.newBytes)}</b>
                          {report.reductionPct > 0.5 ? (
                            <span className="pill success">
                              <IconCheck size={11} /> {report.reductionPct.toFixed(0)}% smaller
                            </span>
                          ) : (
                            <span className="pill">no saving</span>
                          )}
                          {report.hitTarget === false && <span className="pill warn">missed target</span>}
                        </div>
                        <SavingsBar report={report} />
                        <div className="file-tech">
                          <span className="tech-chip">{TECHNIQUE_LABEL[report.technique]}</span>
                          <span className="tech-format">{report.formatLabel}</span>
                          <button className="link-btn" onClick={() => toggleExpanded(item.id)}>
                            {isOpen ? 'Less' : 'Details'}
                          </button>
                        </div>
                      </>
                    ) : item.status === 'working' ? (
                      <div className="file-sub file-working">
                        <span className="spinner" aria-hidden="true" />
                        {item.note || 'Working…'}
                      </div>
                    ) : item.status === 'error' ? (
                      <div className="file-sub file-error">{item.error}</div>
                    ) : (
                      <div className="file-sub">{formatBytes(item.file.size)}</div>
                    )}
                  </div>
                  <div className="file-actions">
                    {item.status === 'done' && (
                      <button className="icon-btn" title="Download" onClick={() => downloadOne(item)}>
                        <IconDownload size={15} />
                      </button>
                    )}
                    <button className="icon-btn" title="Remove" onClick={() => removeItem(item.id)}>
                      <IconClose size={14} />
                    </button>
                  </div>
                </div>
                {isOpen && report && <ResultDetail item={item} />}
              </div>
            )
          })}
        </div>
      )}

      <details className="how-it-works">
        <summary>How compression works</summary>
        <p>
          <b>Photos and images</b> are classified before anything is encoded. Photographs go through a lossy
          codec whose quality is searched against a measured similarity score, so the setting is chosen per
          image instead of applied as a fixed number. Screenshots, diagrams and flat artwork take a lossless
          route instead — the palette is reduced only as far as the same similarity check allows, then oxipng
          rebuilds the file.
        </p>
        <p>
          <b>PDFs</b> are rewritten in place: page structure, vector shapes and text are never touched, so text
          stays sharp and selectable. Embedded photos are downsampled to suit the size they are actually drawn
          at rather than whatever the source over-provisioned, scanned pages are detected and coded losslessly
          as bilevel CCITT Group 4, duplicate images and duplicate embedded fonts are merged, and metadata and
          thumbnails are dropped. Only a PDF with no recompressible content, or a target too aggressive to
          reach any other way, falls back to rendering pages as images.
        </p>
        <p>
          Results depend entirely on the file you start with. Squish reports the numbers it actually measured
          for your files, and never claims a fixed ratio.
        </p>
      </details>

      <div className="privacy-note">
        <IconLock size={15} /> Everything happens locally. Your files never leave this device.
      </div>
    </div>
  )
}
