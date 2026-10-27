'use client'
// A guest-list download with phones / emails (owner, 2026-10-27): the CEO downloads at once; anyone else asks
// the CEO ("Ask the CEO to export"), and once the CEO approves, downloads it ONCE within 24 hours.
// API: modules/crm/customerExports.ts (POST /crm/exports, GET /crm/exports, /:id/download, /:id/withdraw).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { usePermissions } from '../../hooks/useCan'
import { Modal } from '@/components/ui/Modal'
import { ExportMenu } from '@/components/ui/ExportMenu'

type Kind = 'customers' | 'waitlist'
interface ExportRequest {
  id: string; kind: Kind; state: 'pending' | 'ready' | 'downloaded' | 'expired' | 'rejected' | 'cancelled'
  reason: string; requestedAt: string; expiresAt: string | null; decisionNote: string | null; rowCount: number | null
  canDownload: boolean; canWithdraw: boolean
}

const STATE_TEXT: Record<ExportRequest['state'], string> = {
  pending: 'Waiting for the CEO', ready: 'Approved — download once', downloaded: 'Downloaded',
  expired: 'Expired (24 hours passed)', rejected: 'Rejected', cancelled: 'Withdrawn',
}
const STATE_BADGE: Record<ExportRequest['state'], string> = {
  pending: 's-badge-amber', ready: 's-badge-green', downloaded: 's-badge-muted', expired: 's-badge-muted', rejected: 's-badge-red', cancelled: 's-badge-muted',
}
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
const hoursLeft = (iso: string | null) => (iso ? Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3_600_000)) : 0)

/**
 * The button (and, for anyone but the CEO, their requests of this kind).
 * `filters` are what the CEO approves; `ceoExport` is the CEO's own download (null = the page has its own).
 */
export function GuestListExport({ kind, filters, ceoExport }: {
  kind: Kind
  filters: Record<string, string>
  ceoExport: { path: string; filename: string } | null
}) {
  const { data: me } = usePermissions()
  const qc = useQueryClient()
  const isCeo = me?.role === 'admin'
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const { data } = useQuery({
    queryKey: ['crm-exports', kind],
    queryFn: () => api.get<{ items: ExportRequest[] }>('/crm/exports'),
    enabled: !!me && !isCeo,
    select: (d) => d.items.filter((i) => i.kind === kind && ['pending', 'ready'].includes(i.state)).slice(0, 5),
  })

  const ask = useMutation({
    mutationFn: () => api.post('/crm/exports', { kind, filters, reason: reason.trim() }),
    onSuccess: () => { setAsking(false); setReason(''); setMsg('Sent to the CEO. You can download it here once it is approved.'); void qc.invalidateQueries({ queryKey: ['crm-exports'] }) },
    onError: (e: Error) => setErr(e.message),
  })
  const withdraw = useMutation({
    mutationFn: (id: string) => api.post(`/crm/exports/${id}/withdraw`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crm-exports'] }),
    onError: (e: Error) => setErr(e.message),
  })
  const download = useMutation({
    mutationFn: (id: string) => api.download(`/crm/exports/${id}/download?format=csv`, `${kind === 'waitlist' ? 'waitlist' : 'guest-list'}-${today()}.csv`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['crm-exports'] }),
    onError: (e: Error) => { setErr(e.message); void qc.invalidateQueries({ queryKey: ['crm-exports'] }) },
  })

  if (!me) return null
  if (isCeo) return ceoExport ? <ExportMenu path={ceoExport.path} filename={ceoExport.filename} label="Export guest list" /> : null

  const items = data ?? []
  return (
    <div className="flex flex-col items-start gap-2 min-w-0">
      <button type="button" className="s-btn-secondary text-sm" onClick={() => { setErr(null); setMsg(null); setAsking(true) }}>
        Ask the CEO to export
      </button>
      {msg && <p className="text-xs text-s-muted" role="status">{msg}</p>}
      {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
      {items.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-2 text-xs max-w-full">
          <span className={STATE_BADGE[r.state]}>{STATE_TEXT[r.state]}</span>
          {r.state === 'ready' && <span className="text-s-muted">{hoursLeft(r.expiresAt)} h left</span>}
          {r.canDownload && (
            <button type="button" className="s-btn-primary text-xs" disabled={download.isPending} onClick={() => download.mutate(r.id)}>
              {download.isPending ? 'Downloading…' : 'Download'}
            </button>
          )}
          {r.canWithdraw && (
            <button type="button" className="text-xs text-s-muted underline" disabled={withdraw.isPending} onClick={() => withdraw.mutate(r.id)}>Withdraw</button>
          )}
        </div>
      ))}
      {asking && (
        <Modal title="Ask the CEO to export" dirty={reason.trim().length > 0} onClose={() => setAsking(false)}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!ask.isPending && reason.trim().length >= 10) ask.mutate() }}>
            <p className="text-sm text-s-muted">
              The list carries guests&apos; phone numbers and emails, so the CEO approves every download. Once approved you can
              download it here once, within 24 hours.
            </p>
            <label className="block text-xs font-semibold text-s-muted">Why you need it
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500}
                className="s-input mt-1" placeholder="For example: the October birthday campaign" />
            </label>
            {reason.trim().length > 0 && reason.trim().length < 10 && <p className="text-xs text-s-muted">At least 10 characters.</p>}
            {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className="s-btn-secondary text-sm" onClick={() => setAsking(false)}>Cancel</button>
              <button type="submit" className="s-btn-primary text-sm" disabled={ask.isPending || reason.trim().length < 10}>
                {ask.isPending ? 'Sending…' : 'Send to the CEO'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
