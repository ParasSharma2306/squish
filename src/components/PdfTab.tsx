import { useState } from 'react'
import { Dropzone } from './Dropzone'
import { buildPdfFromImages } from '../lib/imagePdf'
import { downloadBlob, formatBytes, nextId } from '../lib/fileUtils'
import { IconChevronDown, IconChevronUp, IconClose, IconGrip, IconLock } from './icons'

interface PdfItem {
  id: string
  file: File
  previewUrl: string
}

export function PdfTab() {
  const [items, setItems] = useState<PdfItem[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Blob | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  function addFiles(files: File[]) {
    const newItems: PdfItem[] = files
      .filter((f) => f.type.startsWith('image/'))
      .map((file) => ({ id: nextId(), file, previewUrl: URL.createObjectURL(file) }))
    setItems((prev) => [...prev, ...newItems])
    setResult(null)
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((i) => i.id !== id))
    setResult(null)
  }

  function reorder(from: number, to: number) {
    setItems((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
    setResult(null)
  }

  async function createPdf() {
    setBusy(true)
    setResult(null)
    try {
      const blob = await buildPdfFromImages(items.map((i) => i.file))
      setResult(blob)
    } finally {
      setBusy(false)
    }
  }

  function download() {
    if (result) downloadBlob(result, 'squish.pdf')
  }

  return (
    <div className="card">
      <div className="section-title">Combine images into a PDF</div>
      <Dropzone
        accept="image/*"
        onFiles={addFiles}
        label="Drop images here, or click to browse"
        hint="Reorder pages below before exporting. Drag on desktop, or use the arrows on touch devices."
      />

      {items.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          No images yet. Add some above.
        </div>
      ) : (
        <div className="file-list">
          {items.map((item, index) => (
            <div
              className={`file-item${dragIndex === index ? ' dragging' : ''}`}
              key={item.id}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragEnter={() => setOverIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={() => {
                if (dragIndex !== null && overIndex !== null && dragIndex !== overIndex) {
                  reorder(dragIndex, overIndex)
                }
                setDragIndex(null)
                setOverIndex(null)
              }}
              style={{ outline: overIndex === index ? '2px solid var(--accent)' : 'none' }}
            >
              <span className="drag-handle" title="Drag to reorder">
                <IconGrip size={16} />
              </span>
              <img className="file-thumb" src={item.previewUrl} alt="" />
              <div className="file-meta">
                <div className="file-name">
                  {index + 1}. {item.file.name}
                </div>
                <div className="file-sub">{formatBytes(item.file.size)}</div>
              </div>
              <div className="file-actions">
                <button
                  className="icon-btn"
                  title="Move up"
                  disabled={index === 0}
                  onClick={() => reorder(index, index - 1)}
                >
                  <IconChevronUp size={14} />
                </button>
                <button
                  className="icon-btn"
                  title="Move down"
                  disabled={index === items.length - 1}
                  onClick={() => reorder(index, index + 1)}
                >
                  <IconChevronDown size={14} />
                </button>
                <button className="icon-btn" title="Remove" onClick={() => removeItem(item.id)}>
                  <IconClose size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="actions-row">
        <button className="btn" disabled={items.length === 0 || busy} onClick={createPdf}>
          {busy ? 'Building PDF...' : `Create PDF (${items.length} page${items.length === 1 ? '' : 's'})`}
        </button>
      </div>

      {result && (
        <div className="result-row">
          <div className="result-size">
            PDF ready: <b>{formatBytes(result.size)}</b>
          </div>
          <button className="btn btn-secondary" onClick={download}>
            Download PDF
          </button>
        </div>
      )}

      <div className="privacy-note">
        <IconLock size={15} /> Everything happens locally. Your images never leave this device.
      </div>
    </div>
  )
}
