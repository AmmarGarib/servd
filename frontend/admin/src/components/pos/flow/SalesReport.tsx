'use client'
import { useMemo, useState } from 'react'
import { Menu } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import { ExportMenu } from '../../ui/ExportMenu'
import { flowErrorMessage } from './flowApi'

// Till → Other → Sales report (owner, 2026-10-20): the period's sales of the
// brand (or every brand of the company), grouped the way the manager asks —
// menu items, payment method, Keenu / servd, discounted sales, No Charge
// sales, waiter, order type. The figures come from the ONE sales engine
// (GET /reports/till-sales → reports/service.ts, the same as Reports); this
// screen only shows them. Managers and finance (REPORT_READERS).

type GroupBy = 'items' | 'tenders' | 'settlement' | 'discounts' | 'no_charge' | 'waiters' | 'order_type'
const GROUPS: Array<{ id: GroupBy; label: string }> = [
  { id: 'items', label: 'Menu items' },
  { id: 'tenders', label: 'Payment method' },
  { id: 'settlement', label: 'Keenu / servd' },
  { id: 'discounts', label: 'Discounted sales' },
  { id: 'no_charge', label: 'No Charge sales' },
  { id: 'waiters', label: 'Waiter' },
  { id: 'order_type', label: 'Order type' },
]

interface Column { key: string; label: string; type?: 'pkr' | 'number' | 'text' }
interface TillSales {
  /** Money is null for the report readers who see counts only. */
  summary: { orders: number; gross: number | null; discount: number | null; comps: number | null; tax: number | null; net: number | null }
  columns: Column[]
  rows: Array<Record<string, string | number | null>>
  totals: Record<string, string | number | null> | null
  note?: string | null
}

export function SalesReport({ conceptId, brandName, onMenu }: { conceptId: string | null; brandName: string | null; onMenu: () => void }) {
  const [from, setFrom] = useState(() => todayPktIso())
  const [to, setTo] = useState(() => todayPktIso())
  const [allBrands, setAllBrands] = useState(false)
  const [view, setView] = useState<GroupBy>('items')
  const [exportErr, setExportErr] = useState('')

  const qs = useMemo(() => {
    const p = new URLSearchParams({ view, dateFrom: from, dateTo: to })
    if (!allBrands && conceptId) p.set('conceptId', conceptId)
    return p.toString()
  }, [view, from, to, allBrands, conceptId])
  const q = useQuery<TillSales>({ queryKey: ['pos', 'till-sales', qs], queryFn: () => api.get(`/reports/till-sales?${qs}`) })
  const d = q.data

  const cell = (c: Column, v: string | number | null | undefined) =>
    v == null || v === '' ? '—' : c.type === 'pkr' ? fmtPkr(Number(v)) : String(v)
  const field = 'min-h-11 rounded-lg border border-kds-border bg-kds-bg px-3 text-base text-kds-text focus:border-kds-green focus:outline-none'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-kds-border bg-kds-card px-3 py-2">
        <button type="button" onClick={onMenu} aria-label="Open the till menu" className="flex h-11 w-11 items-center justify-center rounded-lg text-kds-text hover:bg-kds-border/60"><Menu size={22} aria-hidden="true" /></button>
        <h1 className="text-lg font-bold text-kds-text">Sales report</h1>
        <div className="ml-auto">
          <ExportMenu path={`/reports/till-sales?${qs}`} filename={`sales-${view}-${from}-to-${to}`} onError={setExportErr}
            className="flex min-h-11 items-center rounded-lg border border-kds-border px-4 text-sm font-semibold text-kds-text hover:border-kds-green" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-semibold text-kds-subtext">From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={`${field} mt-1 block`} /></label>
          <label className="text-xs font-semibold text-kds-subtext">To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={`${field} mt-1 block`} /></label>
          <div className="flex rounded-lg border border-kds-border p-1" role="radiogroup" aria-label="Brands">
            {[{ v: false, l: brandName ?? 'This brand' }, { v: true, l: 'All brands' }].map((o) => (
              <button key={String(o.v)} type="button" role="radio" aria-checked={allBrands === o.v} onClick={() => setAllBrands(o.v)}
                className={`min-h-9 rounded-md px-3 text-sm font-semibold ${allBrands === o.v ? 'bg-kds-green/20 text-kds-green' : 'text-kds-subtext'}`}>{o.l}</button>
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Group by">
          {GROUPS.map((g) => (
            <button key={g.id} type="button" role="tab" aria-selected={view === g.id} onClick={() => setView(g.id)}
              className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${view === g.id ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-text hover:border-kds-green'}`}>{g.label}</button>
          ))}
        </div>

        {exportErr && <p role="alert" className="mt-2 text-sm font-semibold text-kds-red">{exportErr}</p>}
        {q.isLoading && <p className="mt-4 text-sm text-kds-subtext">Loading…</p>}
        {q.isError && <p role="alert" className="mt-4 text-sm font-semibold text-kds-red">{flowErrorMessage(q.error)}</p>}

        {d && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {([
                ['Orders', String(d.summary.orders)],
                ['Sales incl. GST', d.summary.gross],
                ['Discounts', d.summary.discount],
                ['No Charge', d.summary.comps],
                ['GST', d.summary.tax],
                ['Net ex-GST', d.summary.net],
              ] as Array<[string, string | number | null]>).filter(([, v]) => v !== null).map(([l, v]) => typeof v === 'number' ? [l, fmtPkr(v)] as const : [l, v as string] as const).map(([l, v]) => (
                <div key={l} className="rounded-xl border border-kds-border bg-kds-card p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-kds-subtext">{l}</p>
                  <p className="mt-1 text-lg font-bold text-kds-text">{v}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 overflow-x-auto rounded-xl border border-kds-border">
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="bg-kds-card text-left text-xs uppercase tracking-wider text-kds-subtext">
                  <tr>{d.columns.map((c) => <th key={c.key} className={`px-3 py-2 font-semibold ${c.type && c.type !== 'text' ? 'text-right' : ''}`}>{c.label}</th>)}</tr>
                </thead>
                <tbody>
                  {d.rows.length === 0 && <tr><td colSpan={d.columns.length} className="px-3 py-6 text-center text-kds-subtext">Nothing in these dates.</td></tr>}
                  {d.rows.map((r, i) => (
                    <tr key={i} className="border-t border-kds-border text-kds-text">
                      {d.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${c.type && c.type !== 'text' ? 'text-right font-mono' : ''}`}>{cell(c, r[c.key])}</td>)}
                    </tr>
                  ))}
                  {d.totals && d.rows.length > 0 && (
                    <tr className="border-t-2 border-kds-border font-bold text-kds-text">
                      {d.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${c.type && c.type !== 'text' ? 'text-right font-mono' : ''}`}>{d.totals![c.key] == null ? '' : cell(c, d.totals![c.key])}</td>)}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {d.note && <p className="mt-2 text-xs text-kds-subtext">{d.note}</p>}
          </>
        )}
      </div>
    </div>
  )
}
