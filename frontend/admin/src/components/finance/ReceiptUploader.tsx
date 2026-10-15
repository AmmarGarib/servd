'use client'
// Receipt photos for a cash spend: take or pick a photo (or a PDF), compressed
// in the browser (lib/photoPrep.ts), uploaded to `uploadPath` with
// `extraBody` (e.g. { boxId }), listed as thumbnails, and removable while they
// are on no spend (`filePath(id)` serves / deletes one). The parent keeps the
// list and sends the ids with the spend.
//
// Used by the petty-cash spend (POST /trustops/petty-cash/receipts) and the
// cash requests (POST /trustops/cash-vouchers/:id/receipts — served from
// /:id/attachments/:aid, removed at /:id/receipts/:aid: `deletePath`).

import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { EVIDENCE_MAX_BYTES, fetchEvidenceUrl, kb, prepareReceiptFile } from '../../lib/photoPrep'

const MAX_PHOTO_BYTES = 30 * 1024 * 1024 // photos are compressed in the browser first

/** Type and size, checked on select — the same list and limits the server takes (images, PDF ≤ 3 MB). */
export function checkReceiptFile(file: File): string | null {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
  const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|heic)$/i.test(file.name)
  if (!isPdf && !isImage) return `${file.name || 'That file'}: only photos and PDFs are accepted here.`
  if (isPdf && file.size > EVIDENCE_MAX_BYTES) return `${file.name}: ${kb(file.size)} is over the 3 MB limit for a PDF. Scan it at a lower resolution or take a photo.`
  if (!isPdf && file.size > MAX_PHOTO_BYTES) return `${file.name}: ${kb(file.size)} is too large for a photo.`
  return null
}

export interface UploadedReceipt {
  id: string
  mime: string
  sizeBytes: number
  /** A local preview of a photo just taken (blob URL); absent for a PDF. */
  previewUrl?: string
}

export function ReceiptUploader({
  uploadPath,
  extraBody,
  filePath,
  deletePath,
  receipts,
  onChange,
  max = 5,
  label = 'Receipt photos',
  required = false,
}: {
  uploadPath: string
  extraBody: Record<string, unknown>
  /** The API path of one uploaded receipt (GET shows it, DELETE removes it). */
  filePath: (id: string) => string
  /** Where DELETE goes when it is not `filePath`. */
  deletePath?: (id: string) => string
  receipts: UploadedReceipt[]
  onChange: (next: UploadedReceipt[]) => void
  max?: number
  label?: string
  required?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Revoke local previews when the uploader goes away.
  const previews = useRef<string[]>([])
  useEffect(() => () => { for (const u of previews.current) URL.revokeObjectURL(u) }, [])

  async function add(files: FileList | null) {
    if (!files || files.length === 0) return
    setError(null)
    const picked = Array.from(files)
    const refused = picked.map(checkReceiptFile).filter((m): m is string => !!m)
    const okFiles = picked.filter((f) => !checkReceiptFile(f))
    if (refused.length > 0) setError(refused.join(' '))
    if (okFiles.length === 0) { if (input.current) input.current.value = ''; return }
    setBusy(true)
    let next = [...receipts]
    try {
      for (const [i, file] of okFiles.entries()) {
        if (next.length >= max) { setError(`At most ${max} receipts here.`); break }
        setUploading(`Uploading ${file.name || 'photo'}${okFiles.length > 1 ? ` (${i + 1} of ${okFiles.length})` : ''}…`)
        const prepared = await prepareReceiptFile(file)
        const row = await api.post<{ id: string; mime: string; sizeBytes: number }>(uploadPath, { ...extraBody, photo: prepared.base64, mime: prepared.mime })
        if (prepared.previewUrl) previews.current.push(prepared.previewUrl)
        next = [...next, { ...row, previewUrl: prepared.previewUrl || undefined }]
        onChange(next)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The receipt could not be added.')
    } finally {
      setBusy(false)
      setUploading(null)
      if (input.current) input.current.value = ''
    }
  }

  async function remove(r: UploadedReceipt) {
    setError(null)
    try {
      await api.delete((deletePath ?? filePath)(r.id))
      onChange(receipts.filter((x) => x.id !== r.id))
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'The receipt could not be removed.')
    }
  }

  async function open(r: UploadedReceipt) {
    try {
      const url = r.previewUrl ?? await fetchEvidenceUrl(filePath(r.id))
      window.open(url, '_blank', 'noopener')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The receipt could not be opened.')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-white/55">{label}{required ? ' *' : ''}</span>
        <span className="text-[10px] text-white/35">{receipts.length} of {max}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {receipts.map((r) => (
          <div key={r.id} className="relative w-20 h-20 rounded-lg overflow-hidden flex items-center justify-center"
            style={{ background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }}>
            <button type="button" onClick={() => open(r)} className="w-full h-full flex items-center justify-center" aria-label="Open receipt">
              {r.previewUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={r.previewUrl} alt="Receipt" className="w-full h-full object-cover" />
                : <span className="text-[10px] font-bold text-white/55 px-1 text-center">{r.mime === 'application/pdf' ? 'PDF' : 'Photo'}<br />{kb(r.sizeBytes)}</span>}
            </button>
            <button type="button" onClick={() => remove(r)} aria-label="Remove receipt"
              className="absolute top-0.5 right-0.5 rounded-full w-5 h-5 text-[11px] leading-5 text-center"
              style={{ background: 'var(--surface)', color: 'var(--erp-danger)', border: '1px solid rgb(var(--fg-rgb) / 0.12)' }}>×</button>
          </div>
        ))}
        {receipts.length < max && (
          <button type="button" onClick={() => input.current?.click()} disabled={busy}
            className="w-20 h-20 rounded-lg text-[11px] font-bold disabled:opacity-50"
            style={{ border: '1px dashed rgb(var(--erp-primary-rgb) / 0.5)', color: 'var(--erp-primary)' }}>
            {busy ? 'Adding…' : '+ Photo'}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/*,application/pdf" capture="environment" multiple className="hidden"
        onChange={(e) => void add(e.target.files)} />
      {uploading && <p role="status" className="text-[11px] mt-1 text-white/70">{uploading}</p>}
      {error && <p role="alert" className="text-[11px] mt-1" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
    </div>
  )
}
