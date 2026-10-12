'use client'
// NEEDS 21 — supplier bills booked before their goods carried their price
// difference in Inventory 1210 until the goods arrived. Receipts made before
// receiving applied it itself never did. POST
// /reconciliation/apply-missed-bill-variances applies those missed slices
// once: the share still on hand re-prices the item, the rest goes to 5060
// dated today. CEO only. Preview first (dry run), then Apply. Safe to run
// twice — a second run finds nothing. A company whose books are closed
// through today is listed as 'locked' and nothing of it is applied.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { useAuthStore } from '../../store/auth'

type Outcome = 'would_apply' | 'applied' | 'locked' | 'error'
interface Row {
  tenantId: string
  poLineId: string
  quantity: number
  onHandQty: number
  movedCents: number | null
  outcome: Outcome
  detail: string
  billNumbers: string[]
  itemName: string | null
}
interface Result {
  dryRun: boolean
  rows: Row[]
  summary: { lines: number; quantity: number } & Partial<Record<Outcome, number>>
}

const LABEL: Record<Outcome, string> = {
  would_apply: 'Will apply',
  applied: 'Applied',
  locked: 'Books closed — not applied',
  error: 'Error — not applied',
}

const qty = (n: number) => n.toLocaleString('en-PK', { maximumFractionDigits: 3 })

export function MissedBillVariances() {
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [result, setResult] = useState<Result | null>(null)
  const run = useMutation({
    mutationFn: (dryRun: boolean) => api.post<Result>('/reconciliation/apply-missed-bill-variances', { dryRun }),
    onSuccess: setResult,
  })
  if (!isAdmin) return null
  const applicable = (result?.rows ?? []).filter((r) => r.outcome === 'would_apply').length
  return (
    <div className="s-card p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-s-text">Bill price differences never applied</h2>
          <p className="text-xs text-s-muted">A supplier bill entered before its goods arrived holds its price difference until they do. Goods received before this was automatic never picked it up. Applying re-prices the stock still on hand and posts the rest to Inventory Cost Adjustment (5060), dated today. Safe to run twice. If the books are closed through today nothing is applied.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="s-btn-secondary text-xs">Preview</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending || !result?.dryRun || applicable === 0} className="s-btn-primary text-xs">
            Apply {applicable > 0 ? applicable : ''}
          </button>
        </div>
      </div>
      {run.error && <p role="alert" className="text-xs text-s-red">{(run.error as Error).message}</p>}
      {result && (
        result.rows.length === 0
          ? <p className="text-xs text-s-muted">{result.dryRun ? 'Nothing to apply — every received delivery has its bill\'s price difference.' : 'Nothing was left to apply.'}</p>
          : (
            <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-s-muted">
                <tr>
                  <th className="text-left py-1">Item</th>
                  <th className="text-left py-1">Bill</th>
                  <th className="text-right py-1">Received</th>
                  <th className="text-right py-1">On hand</th>
                  <th className="text-right py-1">Stock value moved</th>
                  <th className="text-left py-1 pl-3">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={`${r.tenantId}:${r.poLineId}`} className="border-t border-s-border">
                    <td className="py-1">{r.itemName ?? <span className="font-mono">{r.poLineId.slice(0, 8)}</span>}</td>
                    <td className="py-1">{r.billNumbers.length > 0 ? r.billNumbers.join(', ') : '—'}</td>
                    <td className="py-1 text-right">{qty(r.quantity)}</td>
                    <td className="py-1 text-right">{qty(r.onHandQty)}</td>
                    <td className="py-1 text-right">{r.movedCents == null ? '—' : fmtPkr(r.movedCents)}</td>
                    <td className={`py-1 pl-3 ${r.outcome === 'error' || r.outcome === 'locked' ? 'text-s-red' : ''}`} title={r.detail}>
                      {LABEL[r.outcome] ?? r.outcome}
                      {(r.outcome === 'error' || r.outcome === 'locked') && <span className="block text-s-muted">{r.detail}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )
      )}
    </div>
  )
}
