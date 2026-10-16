'use client'
// Files chosen on a CREATE form, before the record exists. The form keeps the
// list (value / onChange), creates the record through its own route, then
// calls uploadRecordFiles(ownerType, newId, files) — or, where the create
// route takes files inline (the dock receive's `photos`), sends
// asUploadBody(files) in its body. Photos are compressed on pick.

import { useRef, useState } from 'react'
import { kb } from '../../lib/photoPrep'
import { acceptFor, pickRecordFiles, RECORD_FILES_MAX, type PickedFile, type RecordOwnerType } from './recordFiles'

export function PendingFilesPicker({ ownerType, value, onChange, label = 'Supporting documents', hint, max = RECORD_FILES_MAX, required = false }: {
  ownerType: RecordOwnerType
  value: PickedFile[]
  onChange: (files: PickedFile[]) => void
  label?: string
  hint?: string
  /** Most files on the form (an inline create route may take fewer, e.g. 5). */
  max?: number
  /** Marks the label (the form enforces it). */
  required?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add(list: FileList | null) {
    setError(null); setBusy(true)
    try {
      const picked = await pickRecordFiles(list, ownerType, max - value.length)
      if (picked.length) onChange([...value, ...picked])
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }

  return (
    <div className="space-y-1.5">
      <span className="block text-[11px] font-bold text-white/50">{label}{required && <span style={{ color: 'var(--erp-danger)' }}> *</span>}</span>
      {value.length > 0 && (
        <ul className="space-y-1">
          {value.map((f, i) => (
            <li key={`${f.fileName}-${i}`} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 break-all"><span className="font-bold text-white/85">{f.fileName}</span><span className="text-white/45"> · {kb(f.bytes)}</span></span>
              <button type="button" aria-label={`Remove ${f.fileName}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="font-bold text-white/50 hover:text-s-red">Remove</button>
            </li>
          ))}
        </ul>
      )}
      {value.length < max && (
        <>
          <input ref={input} type="file" multiple accept={acceptFor(ownerType)} className="hidden" onChange={(e) => void add(e.target.files)} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="rounded-lg border px-3 py-2 text-xs font-bold disabled:opacity-50" style={{ color: 'var(--erp-primary)', borderColor: 'rgb(var(--erp-primary-rgb) / 0.35)' }}>
            {busy ? 'Preparing…' : value.length ? '+ Add another file' : '+ Attach file'}
          </button>
        </>
      )}
      {hint && <p className="text-[11px] text-white/45">{hint}</p>}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}
