'use client'
// One head-office recharge run (D1; backend modules/headOffices/runRoutes.ts,
// mounted at /accounting/intercompany/recharge-runs).
//
// Shows the BASIS (the head office's cost by account), the LINES (one per
// company, with its share and the transfer it posted), the warnings and the
// status, and offers the actions the viewer may take:
//   head-office preparers  Refresh (re-read the month), Submit, Withdraw;
//   the CEO or a head-office-wide Finance hand-over   Approve / Reject;
//   the CEO   Reverse (needs a reason of at least 10 characters).
// Whether a click is allowed is decided by the server — every refusal message
// is shown as the API wrote it. A company-only viewer sees only its own lines
// and the warnings that name no other company (the server trims the rest).

import { Button, CheckLabel, Field, Input, LinkButton } from '@/components/finance/ui'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'

// ─── Shapes (RunView in headOffices/runs.ts) ─────────────────────────────────

export type RunStatus = 'draft' | 'submitted' | 'posted' | 'rejected' | 'withdrawn' | 'reversed'

export interface RunLine {
  id: string
  companyTenantId: string
  companyName: string | null
  shareBps: number
  amountCents: number
  transferId: string | null
  entryDate: string | null
  postedLate: boolean
  memoNote: string | null
}
export interface BasisRow { accountId: string; code: string; name: string; netCents: number }

export interface RechargeRun {
  id: string
  tenantId: string
  headOfficeName: string | null
  period: string
  kind: 'monthly' | 'true_up' | string
  status: RunStatus
  stale: boolean
  poolCents: number
  priorCents: number
  baseCents: number
  rechargedCents: number
  /** null for a company-only viewer. */
  retainedCents: number | null
  driftAtApprovalCents: number | null
  basis: unknown
  warnings: string[]
  preparedAt: string
  submittedAt: string | null
  decidedAt: string | null
  decisionNote: string | null
  decidedVia: string | null
  postedAt: string | null
  reversedAt: string | null
  reversalReason: string | null
  lines: RunLine[]
  memberOfHeadOffice: boolean
  invariants?: { ok: boolean; problems: string[] }
}

export const RUN_BADGE: Record<RunStatus, { cls: string; label: string }> = {
  draft: { cls: 's-badge-muted', label: 'Draft' },
  submitted: { cls: 's-badge-amber', label: 'Waiting for approval' },
  posted: { cls: 's-badge-green', label: 'Posted' },
  rejected: { cls: 's-badge-red', label: 'Rejected' },
  withdrawn: { cls: 's-badge-muted', label: 'Withdrawn' },
  reversed: { cls: 's-badge-muted', label: 'Reversed' },
}

export function basisOf(run: Pick<RechargeRun, 'basis'>): BasisRow[] {
  return Array.isArray(run.basis) ? (run.basis as BasisRow[]) : []
}

export function runMonthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

const labelCls = 'block mb-1'
const danger = 'var(--erp-danger)'

function errText(err: unknown): string {
  return err instanceof ApiError ? err.message : (err as Error)?.message ?? 'Something went wrong'
}
function dateLabel(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric' })
}

/** The cost basis and the per-company lines of a run (also used for a preview, which has no id). */
export function RunBody({ run }: { run: Pick<RechargeRun, 'basis' | 'lines' | 'poolCents' | 'priorCents' | 'baseCents' | 'rechargedCents' | 'retainedCents'> }) {
  const basis = basisOf(run)
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        {([
          ['Month cost (pool)', run.poolCents],
          ['Already recharged', run.priorCents],
          ['This run', run.baseCents],
          ['Charged to companies', run.rechargedCents],
          ['Kept by head office', run.retainedCents],
        ] as Array<[string, number | null]>).map(([k, v]) => (
          <div key={k}>
            <dt className={labelCls}>{k}</dt>
            <dd className="tabular-nums text-white/85">{v === null ? '—' : fmtPkr(v)}</dd>
          </div>
        ))}
      </dl>

      {basis.length > 0 && (
        <div className="overflow-x-auto">
          <p className={labelCls}>Basis — cost by account</p>
          <table className="w-full min-w-[24rem] text-sm">
            <tbody>
              {basis.map((b) => (
                <tr key={b.accountId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-1.5 pr-2 tabular-nums text-white/55">{b.code}</td>
                  <td className="py-1.5 pr-2 text-white/80">{b.name}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtPkr(b.netCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="overflow-x-auto">
        <p className={labelCls}>Lines — one per company</p>
        <table className="w-full min-w-[30rem] text-sm">
          <thead className="text-xs text-s-muted">
            <tr>
              <th className="py-1 pr-2 text-left font-medium">Company</th>
              <th className="py-1 pr-2 text-right font-medium">Share</th>
              <th className="py-1 pr-2 text-right font-medium">Amount</th>
              <th className="py-1 text-left font-medium pl-3">Posted</th>
            </tr>
          </thead>
          <tbody>
            {run.lines.map((l) => (
              <tr key={l.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                <td className="py-1.5 pr-2 text-white/85">{l.companyName ?? 'Company'}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{(l.shareBps / 100).toFixed(2)}%</td>
                <td className="py-1.5 pr-2 text-right tabular-nums" style={l.amountCents < 0 ? { color: danger } : undefined}>{fmtPkr(l.amountCents)}</td>
                <td className="py-1.5 pl-3 text-xs text-s-muted">
                  {l.transferId ? <>{dateLabel(l.entryDate)}{l.postedLate && <span className="s-badge-amber ml-2">Posted late</span>}</> : '—'}
                  {l.memoNote && <span className="block text-white/40">{l.memoNote}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function RechargeRunDetail({ runId, canPrepare, canDecide, canReverse, onClose, setMsg }: {
  runId: string
  /** Head-office preparers: refresh, submit, withdraw. */
  canPrepare: boolean
  /** CEO or a Finance hand-over: approve / reject. */
  canDecide: boolean
  /** CEO: reverse. */
  canReverse: boolean
  onClose: () => void
  setMsg: (m: { ok: boolean; text: string } | null) => void
}) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['ic', 'recharge-run', runId],
    queryFn: () => api.get<RechargeRun>(`/accounting/intercompany/recharge-runs/${encodeURIComponent(runId)}`),
  })
  const [mode, setMode] = useState<'' | 'approve' | 'reject' | 'reverse'>('')
  const [note, setNote] = useState('')
  const [ack, setAck] = useState(false)
  const [late, setLate] = useState(false)

  const act = useMutation({
    mutationFn: (a: { path: string; body?: Record<string, unknown> }) =>
      api.post<RechargeRun & { notice?: string }>(`/accounting/intercompany/recharge-runs/${encodeURIComponent(runId)}/${a.path}`, a.body ?? {}),
    onSuccess: (r, a) => {
      setMode(''); setNote(''); setAck(false); setLate(false)
      const words: Record<string, string> = {
        refresh: 'Run refreshed from the head office\'s books.', submit: 'Submitted for approval.', withdraw: 'Run withdrawn.',
        approve: 'Approved — posted in the head office\'s and every company\'s books.', reject: 'Run rejected.', reverse: 'Run reversed in every book.',
      }
      setMsg({ ok: true, text: r.notice ?? words[a.path] ?? 'Done.' })
      void qc.invalidateQueries({ queryKey: ['ic'] })
    },
    onError: (err) => setMsg({ ok: false, text: errText(err) }),
  })

  if (q.isLoading) return <p className="p-4 text-sm text-white/40">Loading…</p>
  if (q.isError || !q.data) return <p className="p-4 text-sm" style={{ color: danger }}>{errText(q.error)}</p>
  const run = q.data
  const badge = RUN_BADGE[run.status]
  const open = run.status === 'draft' || run.status === 'submitted'
  const needsAck = run.warnings.length > 0

  return (
    <div className="space-y-4 border-t p-4" style={{ borderColor: 'var(--border)' }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={badge.cls}>{badge.label}</span>
          <span className="s-badge-purple">{run.kind === 'true_up' ? 'True-up' : 'Monthly'}</span>
          {run.stale && <span className="s-badge-amber">Out of date — refresh</span>}
          <span className="text-xs text-s-muted">
            Prepared {dateLabel(run.preparedAt)}{run.submittedAt && <> · submitted {dateLabel(run.submittedAt)}</>}
            {run.postedAt && <> · posted {dateLabel(run.postedAt)}</>}
            {run.decisionNote && <> · “{run.decisionNote}”</>}
          </span>
        </div>
        <LinkButton tone="muted" type="button"  onClick={onClose}>Close</LinkButton>
      </div>

      {run.reversedAt && <p className="text-xs text-s-muted">Reversed {dateLabel(run.reversedAt)}: {run.reversalReason}</p>}
      {run.driftAtApprovalCents !== null && run.driftAtApprovalCents !== 0 && (
        <p className="text-xs" style={{ color: 'var(--erp-warning)' }}>
          The month&apos;s cost moved by {fmtPkr(run.driftAtApprovalCents)} after this run was prepared; a true-up covers it.
        </p>
      )}

      {run.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg px-3 py-2 text-xs" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)' }}>
          {run.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {run.invariants && !run.invariants.ok && (
        <ul className="space-y-1 text-xs" style={{ color: danger }}>
          {run.invariants.problems.map((p) => <li key={p}>Check failed: {p}</li>)}
        </ul>
      )}

      <RunBody run={run} />

      <div className="flex flex-wrap items-end gap-2">
        {mode === '' && (
          <>
            {canPrepare && open && (
              <Button variant="secondary" type="button"  disabled={act.isPending} onClick={() => act.mutate({ path: 'refresh' })}>Refresh</Button>
            )}
            {canPrepare && run.status === 'draft' && (
              <Button type="button"  disabled={act.isPending || run.stale} onClick={() => act.mutate({ path: 'submit' })}>Submit for approval</Button>
            )}
            {canPrepare && open && (
              <Button variant="ghost" type="button"  disabled={act.isPending}
                onClick={() => { if (window.confirm('Withdraw this run?')) act.mutate({ path: 'withdraw' }) }}>Withdraw</Button>
            )}
            {canDecide && run.status === 'submitted' && (
              <>
                <Button type="button"  onClick={() => setMode('approve')}>Approve</Button>
                <Button variant="secondary" type="button"  onClick={() => setMode('reject')}>Reject</Button>
              </>
            )}
            {canReverse && run.status === 'posted' && (
              <Button variant="danger" type="button"  onClick={() => setMode('reverse')}>Reverse</Button>
            )}
          </>
        )}
        {mode === 'approve' && (
          <div className="w-full space-y-2">
            <p className="text-sm text-white/70">Posting charges every company and credits the head office, in both books at once.</p>
            {needsAck && (
              <CheckLabel className="flex items-start gap-2 text-sm text-white/70">
                <input type="checkbox" className="mt-1" style={{ accentColor: 'var(--erp-accent)' }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>I have read the warnings above</span>
              </CheckLabel>
            )}
            <CheckLabel className="flex items-start gap-2 text-sm text-white/70">
              <input type="checkbox" className="mt-1" style={{ accentColor: 'var(--erp-accent)' }} checked={late} onChange={(e) => setLate(e.target.checked)} />
              <span>If a book is already closed for the month, post in the open period instead (marked as posted late)</span>
            </CheckLabel>
            <div className="flex gap-2">
              <Button type="button"  disabled={act.isPending || (needsAck && !ack)}
                onClick={() => act.mutate({ path: 'approve', body: { ...(needsAck && { acknowledgeWarnings: true }), ...(late && { postInOpenPeriod: true }) } })}>
                {act.isPending ? 'Posting…' : 'Approve and post'}
              </Button>
              <Button variant="ghost" type="button"  onClick={() => setMode('')}>Cancel</Button>
            </div>
          </div>
        )}
        {(mode === 'reject' || mode === 'reverse') && (
          <>
            <div className="min-w-[14rem] flex-1"><Field label={mode === 'reject' ? 'Why is it rejected? (at least 3 characters)' : 'Why is it reversed? (at least 10 characters)'}>
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </Field></div>
            <button type="button" className={mode === 'reject' ? 's-btn-secondary text-sm' : 's-btn-danger text-sm'}
              disabled={act.isPending || note.trim().length < (mode === 'reject' ? 3 : 10)}
              onClick={() => act.mutate(mode === 'reject' ? { path: 'reject', body: { note: note.trim() } } : { path: 'reverse', body: { reason: note.trim() } })}>
              {mode === 'reject' ? 'Reject run' : 'Reverse in every book'}
            </button>
            <Button variant="ghost" type="button"  onClick={() => { setMode(''); setNote('') }}>Cancel</Button>
          </>
        )}
      </div>
    </div>
  )
}
