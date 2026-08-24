import { useEffect, useMemo, useState } from 'react'
import JSZip from 'jszip'
import { Dropzone } from './Dropzone'
import {
  convertImage,
  FORMAT_EXT,
  FORMAT_LABEL,
  QUALITY_TUNABLE_FORMATS,
  type OutputFormat,
} from '../lib/imageConvert'
import { isAvifEncodeSupported } from '../lib/avifSupport'
import { downloadBlob, formatBytes, nextId, stripExtension } from '../lib/fileUtils'
import { IconClose, IconDownload, IconLock } from './icons'

interface ConvertItem {
  id: string
  file: File
  previewUrl: string
  status: 'pending' | 'converting' | 'done' | 'error'
  resultBlob?: Blob
  error?: string
}

const BASE_FORMATS: OutputFormat[] = ['jpeg', 'png', 'webp', 'bmp']

export function ConvertTab() {
  const [items, setItems] = useState<ConvertItem[]>([])
  const [format, setFormat] = useState<OutputFormat>('webp')
  const [quality, setQuality] = useState(0.85)
  const [busy, setBusy] = useState(false)
  const [avifSupported, setAvifSupported] = useState(false)

  useEffect(() => {
    isAvifEncodeSupported().then(setAvifSupported)
  }, [])

  const formats = useMemo(
    () => (avifSupported ? [...BASE_FORMATS, 'avif' as const] : BASE_FORMATS),
    [avifSupported],
  )
  const doneCount = useMemo(() => items.filter((i) => i.status === 'done').length, [items])
  const showQuality = QUALITY_TUNABLE_FORMATS.includes(format)

  function addFiles(files: File[]) {
    const newItems: ConvertItem[] = files
      .filter((f) => f.type.startsWith('image/'))
      .map((file) => ({ id: nextId(), file, previewUrl: URL.createObjectURL(file), status: 'pending' }))
    setItems((prev) => [...prev, ...newItems])
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function convertAll() {
    setBusy(true)
    for (const item of items) {
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, status: 'converting' } : i)))
      try {
        const blob = await convertImage(item.file, format, quality)
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: 'done', resultBlob: blob } : i)),
        )
      } catch {
        setItems((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: 'error', error: 'Failed to convert' } : i)),
        )
      }
    }
    setBusy(false)
  }

  function downloadOne(item: ConvertItem) {
    if (!item.resultBlob) return
    downloadBlob(item.resultBlob, `${stripExtension(item.file.name)}.${FORMAT_EXT[format]}`)
  }

  async function downloadAll() {
    const done = items.filter((i) => i.status === 'done' && i.resultBlob)
    if (done.length === 0) return
    if (done.length === 1) return downloadOne(done[0])
    const zip = new JSZip()
    done.forEach((i) => {
      zip.file(`${stripExtension(i.file.name)}.${FORMAT_EXT[format]}`, i.resultBlob!)
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    downloadBlob(blob, 'squish-converted.zip')
  }

  return (
    <div className="card">
      <div className="section-title">Convert image format</div>
      <Dropzone
        accept="image/*"
        onFiles={addFiles}
        label="Drop images here, or click to browse"
        hint="Accepts JPG, PNG, WebP, GIF, BMP, AVIF and SVG. Converted entirely on your device."
      />

      <div className="field-row">
        <div className="field">
          <label htmlFor="format">Output format</label>
          <select id="format" value={format} onChange={(e) => setFormat(e.target.value as OutputFormat)}>
            {formats.map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABEL[f]}
              </option>
            ))}
          </select>
        </div>
        {showQuality && (
          <div className="field">
            <label htmlFor="quality">Quality: {Math.round(quality * 100)}%</label>
            <input
              id="quality"
              type="range"
              min={0.1}
              max={1}
              step={0.01}
              value={quality}
              onChange={(e) => setQuality(Number(e.target.value))}
            />
          </div>
        )}
        <button className="btn" disabled={items.length === 0 || busy} onClick={convertAll}>
          {busy ? 'Converting...' : 'Convert all'}
        </button>
        {doneCount > 1 && (
          <button className="btn btn-secondary" onClick={downloadAll}>
            Download all (.zip)
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          No images yet. Add some above.
        </div>
      ) : (
        <div className="file-list">
          {items.map((item) => (
            <div className="file-item" key={item.id}>
              <img className="file-thumb" src={item.previewUrl} alt="" />
              <div className="file-meta">
                <div className="file-name">{item.file.name}</div>
                <div className="file-sub">
                  {item.status === 'done' && item.resultBlob ? (
                    <>
                      {formatBytes(item.file.size)} to <b>{formatBytes(item.resultBlob.size)}</b>
                    </>
                  ) : item.status === 'converting' ? (
                    'Converting...'
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
        <IconLock size={15} /> Everything happens locally. Your images never leave this device.
      </div>
    </div>
  )
}
