import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import { IconUpload } from './icons'

interface DropzoneProps {
  accept: string
  multiple?: boolean
  onFiles: (files: File[]) => void
  label: string
  hint: string
  icon?: ReactNode
}

export function Dropzone({ accept, multiple = true, onFiles, label, hint, icon }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return
    onFiles(Array.from(fileList))
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  return (
    <div
      className={`dropzone${dragging ? ' dragging' : ''}`}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
      }}
    >
      <span className="dz-icon">{icon ?? <IconUpload size={26} />}</span>
      <div>
        <strong>{label}</strong>
      </div>
      <div style={{ fontSize: 13, marginTop: 4 }}>{hint}</div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
