'use client'
// Journal requests (head office D1/D3, spec §7.3). Finance PREPARES a manual
// journal and the CEO approves it; only then does it reach the books. Backend:
// modules/accounting/journalRequests.ts, routes under /accounting/journal-requests.
//
//   draft ─submit─▶ submitted ─approve─▶ posted
//   submitted ─return {note}─▶ returned ─edit / submit─▶ submitted
//   draft / submitted / returned ─withdraw─▶ withdrawn
//
// "mine"  the caller's own requests (preparers): edit, send, withdraw.
// "all"   the CEO's Requests tab: everything the caller may see, with Approve
//         and Return. What each button may do is decided by the server; this
//         file keeps no role list beyond the `canDecide` the page passes down.

import { Button, Field, Input, LinkButton } from '@/components/finance/ui'
import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { useAuthStore } from '../../../store/auth'
import { Select } from '@/components/ui/Select'
import { CompactEmptyState } from '@/components/ui/CompactEmptyState'

export type JournalRequestStatus = 'draft' | 'submitted' | 'returned' | 'posted' | 'withdrawn'

export interface JournalRequestLine {
  accountId: string
  type: 'debit' | 'credit'
  amountCents: number
  memo?: string
  conceptId?: string | null
}

export interface JournalRequest {
  id: string
  tenantId: string
  tenantName: string | null
  kind: 'post' | 'reverse' | string
  status: JournalRequestStatus
  description: string
  reference: string | null
  entryDate: string | null
  lines: JournalRequestLine[] | null
  totalCents: number
  reverseEntryId: string | null
  reason: string | null
  preparedById: string
  preparedByName: string | null
  preparedAt: string
  submittedAt: string | null
  viaHeadOfficeId: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  postedEntryId: string | null
}

export interface RequestAccount { id: string; code: string; name: string }

const STATUS_BADGE: Record<JournalRequestStatus, { cls: string; label: string }> = {
  draft: { cls: 's-badge-muted', label: 'Draft' },
  submitted: { cls: 's-badge-amber', label: 'Waiting for the CEO' },
  returned: { cls: 's-badge-red', label: 'Returned' },
  posted: { cls: 's-badge-green', label: 'Posted' },
  withdrawn: { cls: 's-badge-muted', label: 'Withdrawn' },
}
const FILTERS: Array<{ key: '' | JournalRequestStatus; label: string }> = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'returned', label: 'Returned' },
  { key: 'posted', label: 'Posted' },
  { key: 'withdrawn', label: 'Withdrawn' },
]

const PKT_OFFSET_MS = 5 * 3600_000
const dateLabel = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10) : '—')
const errText = (e: unknown) => (e as Error)?.message ?? 'Something went wrong'

export function JournalRequests({ mode, accounts, canDecide, onEdit, refreshKey }: {
  mode: 'mine' | 'all'
  accounts: RequestAccount[]
  /** The CEO: Approve and Return buttons (the server still decides). */
  canDecide: boolean
  onEdit: (r: JournalRequest) => void
  /** Bumped by the page after it saves a request, so the list reloads. */
  refreshKey: number
}) {
  const qc = useQueryClient()
  const userId = useAuthStore((s) => s.user?.id ?? '')
  const [status, setStatus] = useState<'' | JournalRequestStatus>(mode === 'all' ? 'submitted' : '')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const list = useQuery({
    queryKey: ['journal-requests', mode, status, refreshKey],
    queryFn: () => api.get<{ requests: JournalRequest[] }>(`/accounting/journal-requests?limit=200${mode === 'mine' ? '&mine=1' : ''}${status ? `&status=${status}` : ''}`),
  })
  const done = (text: string) => {
    setMsg({ ok: true, text })
    void qc.invalidateQueries({ queryKey: ['journal-requests'] })
    void qc.invalidateQueries({ queryKey: ['manual-journal'] })
    void qc.invalidateQueries({ queryKey: ['ledger'] })
  }
  const fail = (e: unknown) => setMsg({ ok: false, text: errText(e) })
  const accountOf = (id: string) => accounts.find((a) => a.id === id)
  const requests = list.data?.requests ?? []

  return (
    <section className="space-y-3" aria-label={mode === 'mine' ? 'My requests' : 'Requests'}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Show">
          <Select value={status} onChange={(e) => setStatus(e.target.value as '' | JournalRequestStatus)} className="s-select py-1.5">
            {FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </Select>
        </Field>
        <p className="max-w-xl text-xs text-s-muted">
          {mode === 'mine'
            ? 'A request is only a proposal: nothing reaches the books until the CEO approves it. A returned request can be edited and sent again.'
            : 'Requests that finance has prepared. Approving posts the entry exactly as a direct post would; returning sends it back with your note.'}
        </p>
      </div>

      {msg && (
        <div role={msg.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${msg.ok ? 'text-success' : 'text-s-red'}`}>
          {msg.text}
          <LinkButton tone="muted" type="button" className="ml-3" onClick={() => setMsg(null)}>Close</LinkButton>
        </div>
      )}

      {list.isLoading && <p className="s-card p-6 text-center text-sm text-s-muted">Loading…</p>}
      {list.isError && <p role="alert" className="s-card p-6 text-center text-sm text-s-red">{errText(list.error)}</p>}
      {!list.isLoading && !list.isError && requests.length === 0 && (
        <CompactEmptyState message={`${mode === 'mine' ? 'You have no requests' : 'No requests'}${status ? ' with this status.' : ' yet.'}`} />
      )}
      <ul className="space-y-2">
        {requests.map((r) => (
          <RequestCard key={r.id} r={r} mine={r.preparedById === userId} canDecide={canDecide} accountOf={accountOf}
            onEdit={onEdit} onDone={done} onError={fail} />
        ))}
      </ul>
    </section>
  )
}

function RequestCard({ r, mine, canDecide, accountOf, onEdit, onDone, onError }: {
  r: JournalRequest
  mine: boolean
  canDecide: boolean
  accountOf: (id: string) => RequestAccount | undefined
  onEdit: (r: JournalRequest) => void
  onDone: (text: string) => void
  onError: (e: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const [returning, setReturning] = useState(false)
  const [note, setNote] = useState('')
  const badge = STATUS_BADGE[r.status] ?? STATUS_BADGE.draft
  const pin = { tenantId: r.tenantId }

  const act = useMutation({
    mutationFn: (a: { path: string; body?: Record<string, unknown> }) =>
      api.post<unknown>(`/accounting/journal-requests/${r.id}/${a.path}`, a.body ?? {}, pin),
    onSuccess: (_x, a) => {
      setReturning(false); setNote('')
      onDone(a.path === 'approve' ? 'Approved — posted to the books.'
        : a.path === 'reject' ? 'Returned to the preparer.'
        : a.path === 'submit' ? 'Sent for approval.'
        : 'Withdrawn.')
    },
    onError,
  })

  const preparerOpen = mine && (r.status === 'draft' || r.status === 'returned')
  const canWithdraw = mine && (r.status === 'draft' || r.status === 'submitted' || r.status === 'returned')
  const canDecideNow = canDecide && r.status === 'submitted'
  const lines = Array.isArray(r.lines) ? r.lines : []

  return (
    <li className="s-card p-4 space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={badge.cls}>{badge.label}</span>
            {r.kind === 'reverse' && <span className="s-badge-purple">Reversal</span>}
            {r.viaHeadOfficeId && <span className="s-badge-muted">Via head office</span>}
          </div>
          <p className="text-sm font-semibold text-s-text">{r.description || (r.kind === 'reverse' ? 'Reverse a manual entry' : 'Journal request')}</p>
          <p className="text-xs text-s-muted">
            {r.tenantName ?? 'Company'} · prepared by {r.preparedByName ?? '—'} on {dateLabel(r.preparedAt)}
            {r.entryDate && <> · dated {dateLabel(r.entryDate)}</>}
            {r.reference && <> · ref {r.reference}</>}
            {r.decidedByName && <> · decided by {r.decidedByName}</>}
          </p>
          {r.kind === 'reverse' && r.reason && <p className="text-xs text-s-muted">Reason: {r.reason}</p>}
          {r.status === 'returned' && r.decisionNote && (
            <p className="text-xs" style={{ color: 'var(--erp-danger)' }}>Returned: “{r.decisionNote}”</p>
          )}
          {r.postedEntryId && <p className="text-xs text-s-muted">Posted entry {r.postedEntryId.slice(-8).toUpperCase()}</p>}
        </div>
        {r.kind === 'post' && <p className="font-mono text-sm text-s-text">{fmtPkr(r.totalCents)}</p>}
      </div>

      {lines.length > 0 && (
        <div>
          <LinkButton tone="muted" type="button"  onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide lines' : `Show ${lines.length} lines`}
          </LinkButton>
          {open && (
            <table className="mt-2 w-full text-xs">
              <tbody>
                {lines.map((l, i) => {
                  const a = accountOf(l.accountId)
                  return (
                    <tr key={i} className="border-t border-s-border">
                      <td className="py-1 pr-2">{a ? `${a.code} — ${a.name}` : 'Account'}</td>
                      <td className="py-1 pr-2 text-s-muted">{l.memo ?? ''}</td>
                      <td className="py-1 pr-2 text-right font-mono">{l.type === 'debit' ? fmtPkr(l.amountCents) : ''}</td>
                      <td className="py-1 text-right font-mono">{l.type === 'credit' ? fmtPkr(l.amountCents) : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(preparerOpen || canWithdraw || canDecideNow) && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          {!returning && (
            <Fragment>
              {preparerOpen && r.kind === 'post' && (
                <Button variant="secondary" type="button"  onClick={() => onEdit(r)}>Edit</Button>
              )}
              {preparerOpen && (
                <Button type="button"  disabled={act.isPending} onClick={() => act.mutate({ path: 'submit' })}>
                  {r.status === 'returned' ? 'Send again' : 'Send for approval'}
                </Button>
              )}
              {canWithdraw && (
                <Button variant="ghost" type="button"  disabled={act.isPending}
                  onClick={() => { if (window.confirm('Withdraw this request?')) act.mutate({ path: 'withdraw' }) }}>
                  Withdraw
                </Button>
              )}
              {canDecideNow && (
                <>
                  <Button type="button"  disabled={act.isPending}
                    onClick={() => { if (window.confirm('Approve and post this entry to the books?')) act.mutate({ path: 'approve' }) }}>
                    {act.isPending ? 'Working…' : 'Approve and post'}
                  </Button>
                  <Button variant="secondary" type="button"  onClick={() => setReturning(true)}>Return</Button>
                </>
              )}
            </Fragment>
          )}
          {returning && (
            <>
              <Field label="Why is it returned? (at least 3 characters)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="py-1.5" />
              </Field>
              <Button variant="secondary" type="button"  disabled={act.isPending || note.trim().length < 3}
                onClick={() => act.mutate({ path: 'reject', body: { note: note.trim() } })}>
                Return to preparer
              </Button>
              <Button variant="ghost" type="button"  onClick={() => { setReturning(false); setNote('') }}>Cancel</Button>
            </>
          )}
        </div>
      )}
    </li>
  )
}
