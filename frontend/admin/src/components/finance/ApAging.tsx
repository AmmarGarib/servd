'use client'
// THE AP aging view — the Accounting "AP aging" page and the Procurement
// "Aging" tab both render this, from GET /procurement/ap-aging (procurement
// service agingReport). Net of withholding, by days past due date, unapplied
// payments as credits; "Owed" ties to ledger AP 2010. Opening balances were
// never posted to the ledger, so they sit in their own column; suppliers with
// no company are never in a company's books and are listed apart.
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'

type Buckets = { current: number; '1_30': number; '31_60': number; '61_90': number; '90_plus': number }
export interface ApAgingRow extends Buckets {
  supplierId: string; supplierName: string; tenantId: string | null
  bills: number; creditsCents: number; total: number; openingCents: number; openingUnpostedCents?: number
}
export type ApAgingTotals = Omit<ApAgingRow, 'supplierId' | 'supplierName' | 'tenantId'>
export interface ApAgingReport {
  asOf: string
  bySupplier: ApAgingRow[]
  total: ApAgingTotals
  unassigned: { bySupplier: ApAgingRow[]; total: ApAgingTotals }
}

const BUCKETS = [
  { k: 'current', label: 'Current',    color: 'text-s-text'  },
  { k: '1_30',    label: '1–30 days',  color: 'text-s-amber' },
  { k: '31_60',   label: '31–60 days', color: 'text-s-amber' },
  { k: '61_90',   label: '61–90 days', color: 'text-s-red'   },
  { k: '90_plus', label: '90+ days',   color: 'text-s-red'   },
] as const

function AgingTable({ rows, total, empty }: { rows: ApAgingRow[]; total: ApAgingTotals; empty: string }) {
  const cell = (c: number, cls = 'text-s-text') => (
    <td className={`px-4 py-2 text-right font-mono text-xs ${cls}`}>{c !== 0 ? fmtPkr(c) : ''}</td>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-s-muted">
          <tr>
            <th className="px-4 py-2 text-left">Supplier</th>
            <th className="px-4 py-2 text-right">Bills</th>
            {BUCKETS.map((b) => <th key={b.k} className="px-4 py-2 text-right">{b.label.replace(' days', '')}</th>)}
            <th className="px-4 py-2 text-right" title="Payments not yet applied to a bill, and bills paid beyond what they owed">Credits</th>
            <th className="px-4 py-2 text-right" title="Ties to ledger AP 2010">Owed</th>
            <th className="px-4 py-2 text-right" title="Supplier opening balance, posted to the ledger">Opening</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.supplierId} className="border-t border-s-border">
              <td className="px-4 py-2 text-s-text">{s.supplierName}</td>
              <td className="px-4 py-2 text-right text-xs text-s-muted">{s.bills}</td>
              {cell(s.current)}
              {cell(s['1_30'])}
              {cell(s['31_60'], 'text-s-amber')}
              {cell(s['61_90'], 'text-s-red')}
              {cell(s['90_plus'], 'text-s-red')}
              {cell(-s.creditsCents, 'text-s-muted')}
              <td className="px-4 py-2 text-right font-mono text-sm text-s-text font-semibold">{fmtPkr(s.total)}</td>
              {cell(s.openingCents, 'text-s-muted')}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={10} className="px-4 py-3 text-xs text-s-muted">{empty}</td></tr>
          )}
          {rows.length > 0 && (
            <tr className="border-t-2 border-s-border font-semibold">
              <td className="px-4 py-2 text-s-text">Total</td>
              <td className="px-4 py-2 text-right text-xs text-s-muted">{total.bills}</td>
              {cell(total.current)}
              {cell(total['1_30'])}
              {cell(total['31_60'], 'text-s-amber')}
              {cell(total['61_90'], 'text-s-red')}
              {cell(total['90_plus'], 'text-s-red')}
              {cell(-total.creditsCents, 'text-s-muted')}
              <td className="px-4 py-2 text-right font-mono text-sm text-s-text">{fmtPkr(total.total)}</td>
              {cell(total.openingCents, 'text-s-muted')}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export function ApAging() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['ap-aging'],
    queryFn: () => api.get<ApAgingReport>('/procurement/ap-aging'),
  })

  if (isLoading) return <p className="text-s-muted text-sm">Loading…</p>
  if (error) return <p className="text-s-red text-sm">{(error as Error).message}</p>
  if (!data) return null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {BUCKETS.map((b) => (
          <div key={b.k} className="s-card p-3">
            <p className="text-xs text-s-muted">{b.label}</p>
            <p className={`text-lg font-bold ${b.color}`}>{fmtPkr(data.total[b.k])}</p>
          </div>
        ))}
      </div>

      <div className="s-card overflow-hidden">
        <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
          By supplier ({data.bySupplier.length}) — owed {fmtPkr(data.total.total)}
          {(data.total.openingUnpostedCents ?? 0) !== 0 && <span className="text-s-muted font-normal"> · {fmtPkr(data.total.openingUnpostedCents ?? 0)} of opening balances not yet posted</span>}
        </div>
        <AgingTable rows={data.bySupplier} total={data.total} empty="No outstanding payables" />
      </div>
      <p className="text-xs text-s-muted">
        Days past each bill&apos;s due date. Amounts are net of withholding tax — what the supplier is owed, as in the ledger (AP 2010).
      </p>

      {data.unassigned.bySupplier.length > 0 && (
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-amber">
            Suppliers with no company ({data.unassigned.bySupplier.length}) — not in any company&apos;s books until assigned
          </div>
          <AgingTable rows={data.unassigned.bySupplier} total={data.unassigned.total} empty="" />
        </div>
      )}
    </div>
  )
}
