'use client'
// Closed shifts that never reached the books (owner decision 6): POST
// /reconciliation/backfill-unposted. Admin only. Preview first (dry run),
// then post — a shift whose month is still open posts into its own month; a
// shift in a closed month posts into the CURRENT open month with a memo naming
// its original close date. A locked month is never reopened for it.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { orderRef } from '../../lib/orderRef'
import { useAuthStore } from '../../store/auth'

interface Row { shiftId: string; closedAt: string | null; outcome: string; detail: string }
// BOOKS-R2-01: order completions, loyalty earns / redemptions and refund
// restores the ledger refused. Each posts into its own day only — a day inside
// a closed period is listed as 'locked' and never moved.
// Finance gap 8: bank deposits, waste, stock counts, waste from voided items,
// cancelled orders' unwinds and failed till cards the ledger refused. These
// post on their own day while its month is open, else into this month with a
// note naming the original date (owner decision 6). Ones nothing flagged are
// listed as 'unflagged': Post flags them for review, the next run posts them.
type OrderKind = 'order.complete' | 'loyalty.earn' | 'loyalty.redeem' | 'order.refund'
  | 'deposit.drop' | 'inventory.waste' | 'inventory.count' | 'pos.void_waste' | 'order.cancel_unwind' | 'pos.card_failed'
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
  'deposit.drop': 'Bank deposit',
  'inventory.waste': 'Waste',
  'inventory.count': 'Stock count',
  'pos.void_waste': 'Waste from a voided item',
  'order.cancel_unwind': 'Cancelled order',
  'pos.card_failed': 'Failed card payment',
}

// Outcomes of the order / loyalty / refund rows, in plain words. Anything not
// listed is a reason the posting was skipped; it is shown as "Skipped" with
// the reason in the row's detail.
const ORDER_LABEL: Record<string, string> = {
  would_post: 'Will post on its own day',
  would_post_into_current_month: 'Will post into this month (its month is closed)',
  posted: 'Posted',
  posted_into_current_month: 'Posted into this month',
  locked: 'Its day is closed — not posted; for the accountant',
  already_posted: 'Already on the books',
  would_resolve: 'Nothing to post — the flag will be closed',
  resolved: 'Nothing to post — flag closed',
  not_refunded: 'Not refunded — nothing to post',
  unflagged: 'Missing and never flagged — Post flags it for review',
  flagged: 'Flagged for review — the next run posts it',
  no_company: 'No company — cannot post',
  error: 'Error — not posted',
}

// Kinds in the order the summary lists them.
const KINDS: OrderKind[] = [
  'order.complete', 'loyalty.earn', 'loyalty.redeem', 'order.refund',
  'deposit.drop', 'inventory.waste', 'inventory.count', 'pos.void_waste', 'order.cancel_unwind', 'pos.card_failed',
]
const SUMMARY_OUTCOMES: Array<{ key: string; label: string }> = [
  { key: 'would_post', label: 'to post' },
  { key: 'would_post_into_current_month', label: 'to post into this month' },
  { key: 'posted', label: 'posted' },
  { key: 'posted_into_current_month', label: 'posted into this month' },
  { key: 'unflagged', label: 'missing, never flagged' },
  { key: 'flagged', label: 'flagged for review' },
  { key: 'locked', label: 'in a closed period' },
  { key: 'error', label: 'errors' },
]
// Outcomes a Post run acts on (posts, closes a flag, or flags a miss).
const ACTIONABLE = new Set(['would_post', 'would_post_into_current_month', 'would_resolve', 'unflagged'])
const PROBLEM = new Set(['error', 'locked', 'no_company'])

function orderOutcomeLabel(outcome: string): string {
  return ORDER_LABEL[outcome] ?? 'Skipped'
}

/** The order number staff read (last 8, uppercased); a document's own id otherwise. */
function refOf(r: OrderRow): string {
  if (r.orderId) return orderRef(r.orderId)
  return r.id ? r.id.slice(0, 8) : '—'
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
    + orderRows.filter((r) => ACTIONABLE.has(r.outcome)).length
  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Postings that never reached the books</h2>
          <p className="text-xs text-s-muted">Closed drawers, sales, points, refunds, bank deposits, waste, stock counts, cancelled orders and failed card payments with no ledger entry. A shift, deposit, waste or count in a closed month posts into the current month with a note naming its date. A sale, points or refund posts on its own day only — if that day is closed it is listed for the accountant and not posted. Closed months are never reopened.</p>
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
          <h3 className="text-xs font-semibold text-s-text">Sales, points, refunds and other postings</h3>
          {orderRows.length === 0
            ? <p className="text-xs text-s-muted">Every sale, points earn or spend, refund, deposit, waste and count is on the books.</p>
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
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-s-muted">
                      <tr>
                        <th className="text-left py-1">What</th>
                        <th className="text-left py-1">Ref</th>
                        <th className="text-left py-1">Day</th>
                        <th className="text-left py-1">Outcome</th>
                        <th className="text-left py-1">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderRows.map((r) => (
                        <tr key={`${r.kind}:${r.id}`} className="border-t border-s-border">
                          <td className="py-1">{KIND_LABEL[r.kind] ?? r.kind}</td>
                          <td className="py-1 font-mono">{refOf(r)}</td>
                          <td className="py-1">{r.date ? new Date(r.date).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' }) : '—'}</td>
                          <td className={`py-1 ${PROBLEM.has(r.outcome) ? 'text-s-red' : ''}`}>{orderOutcomeLabel(r.outcome)}</td>
                          <td className="py-1 text-s-muted break-words">{ORDER_LABEL[r.outcome] ? r.detail : `${r.outcome.replace(/_/g, ' ')}${r.detail ? ` — ${r.detail}` : ''}`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
        </div>
      )}
    </div>
  )
}
