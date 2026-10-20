'use client'
// THE AP aging view — the Accounting "AP aging" page and the Procurement
// "Aging" tab both render this, from GET /procurement/ap-aging (procurement
// service agingReport). Net of withholding, payments and supplier credit notes
// applied, by days past due date; unapplied payments and unapplied credit
// notes are credits; "Owed" ties to ledger AP 2010. Opening balances sit in
// their own column; suppliers with no company are never in a company's books
// and are listed apart (to the CEO only). "As at" (?asOf=YYYY-MM-DD) rebuilds
// the aging as it stood at the end of that day, so a month-end aging run
// later still ties to AP 2010 in that day's trial balance.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { ExportMenu } from '@/components/ui/ExportMenu'

type Buckets = { current: number; '1_30': number; '31_60': number; '61_90': number; '90_plus': number }
export interface ApAgingRow extends Buckets {
  supplierId: string; supplierName: string; tenantId: string | null
  bills: number; creditsCents: number; total: number; openingCents: number; openingUnpostedCents?: number
  /** Of creditsCents: supplier credit notes not yet applied to a bill. */
  creditNotesCents?: number
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
            <th className="px-4 py-2 text-right" title="Payments and supplier credit notes not yet applied to a bill, and bills paid beyond what they owed">Credits</th>
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
              <td className="px-4 py-2 text-right font-mono text-xs text-s-muted"
                title={(s.creditNotesCents ?? 0) !== 0 ? `${fmtPkr(s.creditNotesCents ?? 0)} of it is credit notes not yet applied` : undefined}>
                {s.creditsCents !== 0 ? fmtPkr(-s.creditsCents) : ''}
                {(s.creditNotesCents ?? 0) !== 0 && <span className="block text-[10px]">incl. {fmtPkr(s.creditNotesCents ?? 0)} credit notes</span>}
              </td>
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
  // '' = today (the documents as they stand); a date = as at the end of that day.
  const [asOf, setAsOf] = useState('')
  const { data, isLoading, error } = useQuery({
    queryKey: ['ap-aging', asOf],
    queryFn: () => api.get<ApAgingReport>(`/procurement/ap-aging${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`),
  })

  const picker = (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs text-s-muted">
        <span className="block mb-0.5">As at (end of day)</span>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
          className="rounded-lg border border-s-border bg-s-surface px-3 py-1.5 text-sm text-s-text" />
      </label>
      {asOf && (
        <button type="button" onClick={() => setAsOf('')} className="text-xs font-semibold underline" style={{ color: 'var(--erp-primary)' }}>
          Back to today
        </button>
      )}
      <span className="ml-auto">
        <ExportMenu path={`/procurement/ap-aging${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`} filename={`ap-aging-${asOf || 'today'}`} />
      </span>
      <p className="text-[11px] text-s-muted basis-full">
        {asOf
          ? 'Bills, credit notes and payments dated on or before this day, as they stood then — ties to AP 2010 in that day\'s trial balance.'
          : 'Today, from the documents as they stand. Pick a date (e.g. a month end) to see the aging as it was then.'}
      </p>
    </div>
  )

  if (isLoading) return <div className="space-y-3">{picker}<p className="text-s-muted text-sm">Loading…</p></div>
  if (error) return <div className="space-y-3">{picker}<p className="text-s-red text-sm">{(error as Error).message}</p></div>
  if (!data) return null

  return (
    <div className="space-y-4">
      {picker}
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
        Days past each bill&apos;s due date. Amounts are net of withholding tax and of supplier credit notes — what the supplier is owed, as in the ledger (AP 2010).
        {(data.total.creditNotesCents ?? 0) !== 0 && <> Credits include {fmtPkr(data.total.creditNotesCents ?? 0)} of credit notes not yet applied to a bill.</>}
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
