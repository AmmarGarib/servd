'use client'
// One set of fixes: what it asks for, what approving will do, and the CEO's buttons.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { useConfirm } from '../../ui/ConfirmDialog'
import { type CorrectionSet, MIN_REASON, STATUS_BADGE, STATUS_LABEL, effectText, fmtDateTime, fmtDay, tenderText } from './types'

export function CorrectionDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const isCeo = useAuthStore((s) => s.isRole('admin'))
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const { data: c, isLoading, error } = useQuery({
    queryKey: ['shift-corrections', 'set', id],
    queryFn: () => api.get<CorrectionSet>(`/pos/shift-corrections/${id}`),
  })

  const decide = useMutation({
    mutationFn: (v: { path: 'approve' | 'reject' | 'retry'; body?: { note: string } }) => api.post<CorrectionSet>(`/pos/shift-corrections/${id}/${v.path}`, v.body ?? {}),
    onSuccess: (r, v) => {
      void qc.invalidateQueries({ queryKey: ['shift-corrections'] })
      void qc.invalidateQueries({ queryKey: ['approvals'] })
      if (v.path === 'reject') setMsg({ ok: true, text: 'Rejected. Nothing was changed.' })
      else if (r.status === 'applied') setMsg({ ok: true, text: 'Approved and applied.' })
      else setMsg({ ok: false, text: r.error ? `Approved, but it did not finish: ${r.error}` : 'Approved, but it did not finish. You can retry.' })
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message || 'Could not complete that' }),
  })

  async function approve() {
    const r = await confirm({
      title: 'Approve and apply this correction?',
      body: 'The drawer\'s close is reversed and re-posted on its own business day, the bills are voided and the open tickets cancelled, and they move to the Trash. This changes the books.',
      confirmLabel: 'Approve and apply',
      reason: { label: 'Note (optional)', minLength: 0 },
    })
    if (r) { setMsg(null); decide.mutate({ path: 'approve', body: { note: r.reason ?? '' } }) }
  }
  async function reject() {
    const r = await confirm({
      title: 'Reject this correction?', body: 'Nothing will change.', danger: true, confirmLabel: 'Reject',
      reason: { label: 'Why are you rejecting it?', minLength: MIN_REASON },
    })
    if (r && r.reason) { setMsg(null); decide.mutate({ path: 'reject', body: { note: r.reason } }) }
  }
  async function retry() {
    const r = await confirm({ title: 'Try applying this correction again?', body: 'Steps that already finished are not repeated.', confirmLabel: 'Retry' })
    if (r) { setMsg(null); decide.mutate({ path: 'retry' }) }
  }

  if (isLoading) return <p className="text-xs text-s-muted">Loading…</p>
  if (error) return <p role="alert" className="text-xs text-s-red">{(error as Error).message}</p>
  if (!c) return null

  const before = c.result?.drawer
  const drawer = c.drawer
  const sh = c.shift

  return (
    <div className="space-y-4">
      <button type="button" className="s-btn-secondary text-sm" onClick={onBack}>Back to the list</button>
      {msg && <div role={msg.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${msg.ok ? 'text-success' : 'text-s-red'}`}>{msg.text}</div>}

      <div className="s-card p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-s-text">{sh?.cashierName ?? 'Shift'}{sh?.locationName ? ` · ${sh.locationName}` : ''}</h2>
          <span className={STATUS_BADGE[c.status]}>{STATUS_LABEL[c.status]}</span>
        </div>
        <p className="text-xs text-s-muted">Business day {fmtDay(c.businessDay)} · sent by {c.requestedBy.name ?? 'unknown'} on {fmtDateTime(c.createdAt)}</p>
        <p className="text-sm text-s-text">{c.reason}</p>
        {c.decidedBy && (
          <p className="text-xs text-s-muted">
            {c.status === 'rejected' ? 'Rejected' : 'Approved'} by {c.decidedBy.name ?? 'the CEO'} on {fmtDateTime(c.decidedAt)}{c.decisionNote ? `: ${c.decisionNote}` : ''}
          </p>
        )}
        {c.appliedAt && <p className="text-xs text-success">Applied on {fmtDateTime(c.appliedAt)}</p>}
        {c.error && <p role="alert" className="text-xs text-s-red">It did not finish: {c.error}</p>}
      </div>

      {drawer && (
        <div className="s-card p-4">
          <h3 className="text-sm font-semibold text-s-text mb-2">Cash drawer</h3>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {[
              ['Expected', c.status === 'applied' && before ? fmtPkr(before.expectedCents) : fmtPkr(drawer.expectedCents)],
              ['Counted', drawer.countedCents == null ? '—' : fmtPkr(drawer.countedCents)],
              ['Difference', c.status === 'applied' && before && before.varianceBeforeCents != null
                ? `${fmtPkr(before.varianceBeforeCents)} → ${before.varianceCents == null ? '—' : fmtPkr(before.varianceCents)}`
                : drawer.varianceCents == null ? '—' : fmtPkr(drawer.varianceCents)],
            ].map(([k, v]) => (
              <div key={k}><p className="text-s-muted">{k}</p><p className="text-sm font-semibold tabular-nums text-s-text">{v}</p></div>
            ))}
          </div>
          {c.status !== 'applied' && <p className="text-[11px] text-s-muted mt-2">The expected cash changes after approval: it drops by any cash bill that is voided and not handed back.</p>}
        </div>
      )}

      <div className="s-card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-s-text">Fixes ({c.items.length})</h3>
        <ul className="space-y-3">
          {c.items.map((i) => {
            const p = i.preview
            return (
              <li key={i.id} className="rounded-lg border border-s-border p-3 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-s-text">
                    {i.kind === 'cancel_kot' ? 'Cancel open ticket' : 'Void bill'} #{i.orderRef}{p?.brand ? ` · ${p.brand}` : ''}
                  </span>
                  {p && <span className="text-sm tabular-nums text-s-text">{fmtPkr(p.totalCents)}</span>}
                </div>
                {p && <p className="text-xs text-s-muted">{tenderText(p.tenders)}</p>}
                <p className="text-xs text-s-text">Reason: {i.reason}</p>
                {i.kind === 'void_bill' && <p className="text-xs text-s-muted">{i.moneyReturned ? 'Money was handed back.' : 'Money was not handed back.'} {i.foodMade ? 'Food was made.' : 'Food was not made.'}</p>}
                {p && c.status === 'submitted' && <p className="text-xs text-s-muted">On approval: {effectText(p, c.businessDay)}</p>}
                {p?.blockedBy && c.status !== 'applied' && c.status !== 'rejected' && <p role="alert" className="text-xs text-s-red">Cannot be applied now: {p.blockedBy.message}</p>}
                {i.result?.applied && <p className="text-xs text-success">Done.</p>}
                {i.result?.error && <p role="alert" className="text-xs text-s-red">{i.result.error}</p>}
              </li>
            )
          })}
        </ul>
      </div>

      {isCeo && c.status === 'submitted' && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="s-btn-primary text-sm" disabled={decide.isPending} onClick={approve}>{decide.isPending ? 'Working…' : 'Approve and apply'}</button>
          <button type="button" className="s-btn-secondary text-sm" disabled={decide.isPending} onClick={reject}>Reject</button>
        </div>
      )}
      {isCeo && c.status === 'failed' && (
        <button type="button" className="s-btn-primary text-sm" disabled={decide.isPending} onClick={retry}>{decide.isPending ? 'Working…' : 'Retry'}</button>
      )}
      {!isCeo && c.status === 'submitted' && <p className="text-xs text-s-muted">Only the CEO can approve or reject this.</p>}
    </div>
  )
}
