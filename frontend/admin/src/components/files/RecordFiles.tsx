'use client'
// The files of a saved record: list (name, size, who, when), View (photos and
// PDFs in the browser), Download, and "Attach file" when the caller may
// upload. The ONE component for supporting documents on a record (owner,
// 2026-10-16: files, never a URL) — backend /record-files, lib/recordFiles.ts.
// The server applies the record's module rule; `canUpload` only hides the
// picker for people the module would refuse anyway. There is no remove:
// evidence stays (attach the right file instead).

import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { kb } from '../../lib/photoPrep'
import { FileViewModal, isViewable } from './FileViewModal'
import {
  acceptFor, pickRecordFiles, recordFilePath, recordFilesKey, recordFilesPath, uploadRecordFiles,
  RECORD_FILES_MAX, type RecordFile, type RecordOwnerType,
} from './recordFiles'

const fmtWhen = (iso: string) => new Date(iso).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })

export function RecordFiles({ ownerType, ownerId, canUpload, title = 'Supporting documents', tenantId, compact = false, emptyText, lazy = false }: {
  ownerType: RecordOwnerType
  ownerId: string
  /** Show the "Attach file" picker (the server still decides). */
  canUpload: boolean
  title?: string
  /** The record's company — pins uploads to it in portfolio view. */
  tenantId?: string
  /** No heading, smaller spacing (inside a table row / card). */
  compact?: boolean
  /** Shown when there are no files ('' hides the line). */
  emptyText?: string
  /** Load only when opened ("Files" link) — for one per row of a long list, so a
   *  page never fires one request per row (the API's per-client rate limit). */
  lazy?: boolean
}) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<RecordFile | null>(null)
  const [opened, setOpened] = useState(!lazy)
  const key = recordFilesKey(ownerType, ownerId)
  const { data, error: loadError, isLoading } = useQuery<{ files: RecordFile[] }>({
    queryKey: key,
    queryFn: () => api.get(recordFilesPath(ownerType, ownerId)),
    enabled: !!ownerId && opened,
  })
  const files = data?.files ?? []
  const nameOf = (f: RecordFile) => f.fileName || `File ${f.id.slice(0, 6)}`

  async function attach(list: FileList | null) {
    setError(null); setBusy(true)
    try {
      const picked = await pickRecordFiles(list, ownerType, RECORD_FILES_MAX - files.length)
      if (picked.length) {
        await uploadRecordFiles(ownerType, ownerId, picked, { tenantId })
        await qc.invalidateQueries({ queryKey: key })
      }
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false); if (input.current) input.current.value = '' }
  }
  async function download(f: RecordFile) {
    setError(null)
    try { await api.download(recordFilePath(ownerType, ownerId, f.id), nameOf(f)) }
    catch (e) { setError((e as Error).message) }
  }

  if (!opened) {
    return (
      <button type="button" onClick={() => setOpened(true)} className="text-xs font-bold" style={{ color: 'var(--erp-primary)' }}>
        Files
      </button>
    )
  }

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      {!compact && <p className="text-[11px] font-bold uppercase tracking-wider text-white/45">{title}</p>}
      {isLoading ? (
        <p className="text-xs text-white/40">Loading files…</p>
      ) : loadError ? (
        <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{(loadError as Error).message}</p>
      ) : files.length > 0 ? (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-3 flex-wrap text-xs">
              <span className="min-w-0 break-all">
                <span className="font-bold text-white/85">{nameOf(f)}</span>
                <span className="text-white/45"> · {kb(f.sizeBytes)} · {f.uploadedByName ? `${f.uploadedByName}, ` : ''}{fmtWhen(f.createdAt)}</span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                {isViewable(f.mime) && (
                  <button type="button" onClick={() => setViewing(f)} className="font-bold" style={{ color: 'var(--erp-primary)' }}>View</button>
                )}
                <button type="button" onClick={() => void download(f)} className="font-bold" style={{ color: 'var(--erp-primary)' }}>Download</button>
              </span>
            </li>
          ))}
        </ul>
      ) : emptyText !== '' ? (
        <p className="text-xs text-white/40">{emptyText ?? 'No files attached.'}</p>
      ) : null}
      {canUpload && files.length < RECORD_FILES_MAX && !isLoading && !loadError && (
        <>
          <input ref={input} type="file" multiple accept={acceptFor(ownerType)} className="hidden" onChange={(e) => void attach(e.target.files)} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy} className="text-xs font-bold disabled:opacity-50" style={{ color: 'var(--erp-primary)' }}>
            {busy ? 'Uploading…' : files.length ? '+ Attach another file' : '+ Attach file'}
          </button>
        </>
      )}
      {error && <p role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
      {viewing && (
        <FileViewModal path={recordFilePath(ownerType, ownerId, viewing.id)} mime={viewing.mime} name={nameOf(viewing)} onClose={() => setViewing(null)} />
      )}
    </div>
  )
}
