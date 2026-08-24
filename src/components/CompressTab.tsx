import { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { Dropzone } from './Dropzone'
import { compressImageToTarget } from '../lib/imageCompress'
import { compressPdfToTarget } from '../lib/pdfCompress'
import { FORMAT_EXT, FORMAT_LABEL, type OutputFormat } from '../lib/imageConvert'
import { isAvifEncodeSupported } from '../lib/avifSupport'
import { downloadBlob, formatBytes, nextId, parseSizeToBytes, stripExtension } from '../lib/fileUtils'
import { IconCheck, IconClose, IconDownload, IconImage, IconLock, IconPdf } from './icons'

type Kind = 'image' | 'pdf'
type Status = 'pending' | 'working' | 'done' | 'error'

interface CompressItem {
  id: string
  file: File
  kind: Kind
  status: Status
  note?: string
  resultBlob?: Blob
  hitTarget?: boolean
  error?: string
}

const BASE_IMAGE_FORMATS: OutputFormat[] = ['webp', 'jpeg', 'png', 'bmp']
const RESIZE_ONLY_FORMATS: OutputFormat[] = ['png', 'bmp']

export function CompressTab() {
  const [items, setItems] = useState<CompressItem[]>([])
  const [targetValue, setTargetValue] = useState(500)
  const [targetUnit, setTargetUnit] = useState<'KB' | 'MB'>('KB')
  const [imageFormat, setImageFormat] = useState<OutputFormat>('webp')
  const [busy, setBusy] = useState(false)
  const [avifSupported, setAvifSupported] = useState(false)

  useEffect(() => {
    isAvifEncodeSupported().then(setAvifSupported)
  }, [])

  const imageFormats = useMemo(
    () => (avifSupported ? [...BASE_IMAGE_FORMATS, 'avif' as const] : BASE_IMAGE_FORMATS),
    [avifSupported],
  )
  const doneCount = useMemo(() => items.filter((i) => i.status === 'done').length, [items])
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

  async function compressAll() {
    setBusy(true)
    for (const item of items) {
      update(item.id, { status: 'working', note: undefined })
      try {
        if (item.kind === 'image') {
          const res = await compressImageToTarget(item.file, targetBytes, imageFormat)
          update(item.id, { status: 'done', resultBlob: res.blob, hitTarget: res.hitTarget })
        } else {
          const res = await compressPdfToTarget(item.file, targetBytes, (p) =>
            update(item.id, { note: p.detail }),
          )
          update(item.id, {
            status: 'done',
            resultBlob: new Blob([res.bytes as BlobPart], { type: 'application/pdf' }),
            hitTarget: res.hitTarget,
            note: undefined,
          })
        }
      } catch {
        update(item.id, { status: 'error', error: 'Compression failed' })
      }
    }
    setBusy(false)
  }

  function outName(item: CompressItem) {
    if (item.kind === 'pdf') return `${stripExtension(item.file.name)}-compressed.pdf`
    return `${stripExtension(item.file.name)}.${FORMAT_EXT[imageFormat]}`
  }

  function downloadOne(item: CompressItem) {
    if (item.resultBlob) downloadBlob(item.resultBlob, outName(item))
  }

  async function downloadAll() {
    const done = items.filter((i) => i.status === 'done' && i.resultBlob)
    if (done.length === 0) return
    if (done.length === 1) return downloadOne(done[0])
    const zip = new JSZip()
    done.forEach((i) => zip.file(outName(i), i.resultBlob!))
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, 'squish-compressed.zip')
  }

  return (
    <div className="card">
      <div className="section-title">Compress to a target size</div>
      <Dropzone
        accept="image/*,application/pdf"
        onFiles={addFiles}
        label="Drop images or PDFs here, or click to browse"
        hint="Quality is binary-searched to land as close as possible to your target."
      />

      <div className="field-row">
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
        <div className="field">
          <label htmlFor="img-format">Image output format</label>
          <select id="img-format" value={imageFormat} onChange={(e) => setImageFormat(e.target.value as OutputFormat)}>
            {imageFormats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
                {RESIZE_ONLY_FORMATS.includes(f) ? ' (resize only)' : ''}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" disabled={items.length === 0 || busy} onClick={compressAll}>
          {busy ? 'Compressing...' : 'Compress all'}
        </button>
        {doneCount > 1 && (
          <button className="btn btn-secondary" onClick={downloadAll}>
            Download all (.zip)
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          No files yet. Add images or PDFs above.
        </div>
      ) : (
        <div className="file-list">
          {items.map((item) => (
            <div className="file-item" key={item.id}>
              <span className="file-type-icon">{item.kind === 'pdf' ? <IconPdf size={20} /> : <IconImage size={20} />}</span>
              <div className="file-meta">
                <div className="file-name">{item.file.name}</div>
                <div className="file-sub">
                  {item.status === 'done' && item.resultBlob ? (
                    <>
                      <span className="strike">{formatBytes(item.file.size)}</span>
                      <b>{formatBytes(item.resultBlob.size)}</b>{' '}
                      {item.hitTarget ? (
                        <span className="pill success">
                          <IconCheck size={11} /> hit target
                        </span>
                      ) : (
                        <span className="pill">closest possible</span>
                      )}
                    </>
                  ) : item.status === 'working' ? (
                    item.note || 'Compressing...'
                  ) : item.status === 'error' ? (
                    item.error
                  ) : (
                    formatBytes(item.file.size)
                  )}
                </div>
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
          ))}
        </div>
      )}

      <div className="privacy-note">
        <IconLock size={15} /> Everything happens locally. Your files never leave this device.
      </div>
    </div>
  )
}
