'use client'
// Closed shifts that never reached the books (owner decision 6): POST
// /reconciliation/backfill-unposted. Admin only. Preview first (dry run),
// then post — a shift whose month is still open posts into its own month; a
// shift in a closed month posts into the CURRENT open month with a memo naming
// its original close date. A locked month is never reopened for it.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

interface Row { shiftId: string; closedAt: string | null; outcome: string; detail: string }
// BOOKS-R2-01: order completions, loyalty earns / redemptions and refund
// restores the ledger refused. Each posts into its own day only — a day inside
// a closed period is listed as 'locked' and never moved.
type OrderKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund'
interface OrderRow { kind: OrderKind; id: string; orderId: string | null; tenantId: string; date: string | null; outcome: string; detail: string }
interface Result {
  dryRun: boolean
  rows: Row[]
  summary: Record<string, number>
  orders?: { rows: OrderRow[]; summary: Record<string, number> }
}

const LABEL: Record<string, string> = {
  would_post: 'Will post in its own month',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  unbalanced: 'Does not balance — for the accountant',
  shift_has_no_company: 'No company — cannot post',
  no_postable_activity: 'Nothing to post',
  already_posted: 'Already on the books',
  error: 'Error',
}

const KIND_LABEL: Record<OrderKind, string> = {
  'order.complete': 'Sale',
  'loyalty.earn': 'Points earned',
  'loyalty.redeem': 'Points spent',
  'order.refund': 'Refund',
}

// Outcomes of the order / loyalty / refund rows, in plain words. Anything not
// listed is a reason the posting was skipped; it is shown as "Skipped" with
// the reason in the row's detail.
const ORDER_LABEL: Record<string, string> = {
  would_post: 'Will post on its own day',
  posted: 'Posted',
  locked: 'Its day is closed — not posted; for the accountant',
  already_posted: 'Already on the books',
  would_resolve: 'Nothing to post — the flag will be closed',
  resolved: 'Nothing to post — flag closed',
  not_refunded: 'Not refunded — nothing to post',
  error: 'Error — not posted',
}

// Kinds in the order the summary lists them.
const KINDS: OrderKind[] = ['order.complete', 'loyalty.earn', 'loyalty.redeem', 'order.refund']
const SUMMARY_OUTCOMES: Array<{ key: string; label: string }> = [
  { key: 'would_post', label: 'to post' },
  { key: 'posted', label: 'posted' },
  { key: 'locked', label: 'in a closed period' },
  { key: 'error', label: 'errors' },
]

function orderOutcomeLabel(outcome: string): string {
  return ORDER_LABEL[outcome] ?? 'Skipped'
}

function shortId(id: string | null): string {
  return id ? id.slice(0, 8) : '—'
}

export function BackfillUnposted() {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [result, setResult] = useState<Result | null>(null)
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Result>('/reconciliation/backfill-unposted', { dryRun }),
    onSuccess: setResult,
  })
  if (!isAdmin) return null
  const orderRows = result?.orders?.rows ?? []
  const orderSummary = result?.orders?.summary ?? {}
  const postable = (result?.rows ?? []).filter((r) => r.outcome.startsWith('would_post')).length
    + orderRows.filter((r) => r.outcome === 'would_post' || r.outcome === 'would_resolve').length
  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Postings that never reached the books</h2>
          <p className="text-xs text-s-muted">Closed drawers, sales, points and refunds with no ledger entry. A shift in a closed month posts into the current month with a note. A sale, points or refund posts on its own day only — if that day is closed it is listed for the accountant and not posted. Closed months are never reopened.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="s-btn-secondary text-xs">Preview</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending || !result?.dryRun || postable === 0} className="s-btn-primary text-xs">
            Post {postable > 0 ? postable : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{(run.error as Error).message}</p>}
      {result && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-s-text">Shifts</h3>
          {result.rows.length === 0
            ? <p className="text-xs text-s-muted">Every closed shift is on the books.</p>
            : (
              <table className="w-full text-xs">
                <thead className="text-s-muted"><tr><th className="text-left py-1">Shift</th><th className="text-left py-1">Closed</th><th className="text-left py-1">Outcome</th></tr></thead>
                <tbody>
                  {result.rows.map((r) => (
                    <tr key={r.shiftId} className="border-t border-s-border">
                      <td className="py-1 font-mono">{r.shiftId.slice(0, 8)}</td>
                      <td className="py-1">{r.closedAt ? new Date(r.closedAt).toLocaleString() : '—'}</td>
                      <td className="py-1" title={r.detail}>{LABEL[r.outcome] ?? r.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
      {result?.orders && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-s-text">Sales, points and refunds</h3>
          {orderRows.length === 0
            ? <p className="text-xs text-s-muted">Every sale, points earn or spend and refund is on the books.</p>
            : (
              <>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-s-muted">
                  {KINDS.map((k) => {
                    const parts = SUMMARY_OUTCOMES
                      .map((o) => ({ ...o, n: orderSummary[`${k}:${o.key}`] ?? 0 }))
                      .filter((o) => o.n > 0)
                    if (parts.length === 0) return null
                    return (
                      <li key={k}>
                        <span className="font-semibold text-s-text">{KIND_LABEL[k]}</span>{' '}
                        {parts.map((o) => `${o.n} ${o.label}`).join(', ')}
                      </li>
                    )
                  })}
                </ul>
                <table className="w-full text-xs">
                  <thead className="text-s-muted">
                    <tr>
                      <th className="text-left py-1">What</th>
                      <th className="text-left py-1">Order</th>
                      <th className="text-left py-1">Day</th>
                      <th className="text-left py-1">Outcome</th>
                      <th className="text-left py-1">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((r) => (
                      <tr key={`${r.kind}:${r.id}`} className="border-t border-s-border">
                        <td className="py-1">{KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td className="py-1 font-mono">{shortId(r.orderId ?? r.id)}</td>
                        <td className="py-1">{r.date ? new Date(r.date).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'}</td>
                        <td className={`py-1 ${r.outcome === 'error' || r.outcome === 'locked' ? 'text-s-red' : ''}`}>{orderOutcomeLabel(r.outcome)}</td>
                        <td className="py-1 text-s-muted break-words">{ORDER_LABEL[r.outcome] ? r.detail : `${r.outcome.replace(/_/g, ' ')}${r.detail ? ` — ${r.detail}` : ''}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
        </div>
      )}
    </div>
  )
}
