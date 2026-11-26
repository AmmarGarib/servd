'use client'
// Purchases by supplier, with the items, amounts and totals (owner, 2026-11-26; backend
// procurement/purchasesReport.ts). "What counts" is picked: every purchase at any approval stage, goods received
// (GRNs), or billed purchases. Read only; exports CSV / Excel / PDF.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso } from '../../lib/money'
import { Select } from '@/components/ui/Select'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { Field, Input } from '@/components/finance/ui'

type Basis = 'all' | 'grn' | 'billed'
interface Line { date: string; source: string; document: string; stage: string; item: string; quantity: number; unit: string; rateCents: number; amountCents: number }
interface Group { supplierId: string; supplierName: string; companyName: string | null; lines: Line[]; itemsCents: number; taxCents: number; totalCents: number }
interface Report { basisLabel: string; suppliers: Group[]; totals: { itemsCents: number; taxCents: number; totalCents: number; lines: number } }

const BASIS: { id: Basis; label: string; hint: string }[] = [
  { id: 'all', label: 'All purchases (any approval stage)', hint: 'Everything, counted once: goods received at any stage (waiting for finance or the CEO included), bills that are not for a delivery, and what is still to arrive on purchase orders that are waiting for approval or with the buyer.' },
  { id: 'grn', label: 'Based on GRN (goods received)', hint: 'Every delivery received in these dates, at the cost it was taken in at — whatever its approval stage. Bills are not looked at.' },
  { id: 'billed', label: 'Based on billed purchases', hint: 'Supplier bills dated in these dates, less credit notes. This is what the books show; deliveries not billed yet are left out.' },
]
const monthStart = () => `${todayPktIso().slice(0, 8)}01`
const qty = (n: number) => n.toLocaleString('en-PK', { maximumFractionDigits: 3 })

export function PurchasesReport() {
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayPktIso())
  const [basis, setBasis] = useState<Basis>('all')
  const [supplierId, setSupplierId] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { data: suppliers = [] } = useQuery<{ id: string; name: string }[]>({ queryKey: ['suppliers'], queryFn: () => api.get('/procurement/suppliers') })
  const ok = !!from && !!to && from <= to
  const qs = `from=${from}&to=${to}&basis=${basis}${supplierId ? `&supplierId=${supplierId}` : ''}`
  const { data, isLoading, error } = useQuery<Report>({ queryKey: ['purchases-report', qs], queryFn: () => api.get(`/procurement/purchases-report?${qs}`), enabled: ok })
  const picked = BASIS.find((b) => b.id === basis)!
  const allOpen = (data?.suppliers ?? []).every((g) => open[g.supplierId] ?? true)

  return (
    <div className="space-y-4">
      <div className="s-card p-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="From"><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="w-full" /></Field>
          <Field label="To"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="w-full" /></Field>
          <Field label="What counts as a purchase">
            <Select value={basis} onChange={(e) => setBasis(e.target.value as Basis)} className="s-input w-full">
              {BASIS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </Select>
          </Field>
          <Field label="Supplier">
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="s-input w-full">
              <option value="">All suppliers</option>
              {[...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-s-muted break-words">{picked.hint}</p>
        {!ok && <p role="alert" className="text-xs text-s-red">Pick a start date on or before the end date.</p>}
      </div>

      {error && <p role="alert" className="text-sm text-s-red break-words">{(error as Error).message}</p>}
      {isLoading && ok && <p className="text-sm text-s-muted">Loading…</p>}

      {data && (
        <>
          <div className="s-card p-4 flex flex-wrap items-end justify-between gap-4">
            <div className="flex flex-wrap gap-x-8 gap-y-3">
              <div><p className="text-xs text-s-muted">Items</p><p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.itemsCents)}</p></div>
              <div><p className="text-xs text-s-muted">Sales tax</p><p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.taxCents)}</p></div>
              <div><p className="text-xs text-s-muted">Total · {data.suppliers.length} supplier{data.suppliers.length === 1 ? '' : 's'}</p><p className="text-2xl font-black text-s-text">{fmtPkr(data.totals.totalCents)}</p></div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {data.suppliers.length > 1 && (
                <button type="button" className="s-btn-secondary text-sm" onClick={() => setOpen(Object.fromEntries(data.suppliers.map((g) => [g.supplierId, !allOpen])))}>
                  {allOpen ? 'Hide items' : 'Show items'}
                </button>
              )}
              <ExportMenu path={`/procurement/purchases-report?${qs}`} filename={`purchases-${basis}-${from}-to-${to}`} disabled={data.suppliers.length === 0} />
            </div>
          </div>

          {data.suppliers.length === 0 && <p className="s-card p-6 text-sm text-s-muted text-center">No purchases in these dates for this choice.</p>}

          {data.suppliers.map((g) => {
            const shown = open[g.supplierId] ?? true
            return (
              <div key={g.supplierId} className="s-card overflow-hidden">
                <button type="button" aria-expanded={shown} onClick={() => setOpen({ ...open, [g.supplierId]: !shown })}
                  className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-left bg-s-bg-soft border-b border-s-border">
                  <span className="min-w-0">
                    <span className="font-bold text-s-text break-words">{g.supplierName}</span>
                    <span className="text-xs text-s-muted"> · {g.lines.length} line{g.lines.length === 1 ? '' : 's'}{g.companyName ? ` · ${g.companyName}` : ''}</span>
                  </span>
                  <span className="font-mono font-bold text-s-text">{fmtPkr(g.totalCents)} <span className="text-s-muted text-xs">{shown ? '▴' : '▾'}</span></span>
                </button>
                {shown && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[720px]">
                      <thead>
                        <tr className="text-left text-s-muted">
                          <th className="px-4 py-2 font-semibold">Date</th>
                          <th className="px-2 py-2 font-semibold">Document</th>
                          <th className="px-2 py-2 font-semibold">Item</th>
                          <th className="px-2 py-2 font-semibold text-right">Qty</th>
                          <th className="px-2 py-2 font-semibold text-right">Rate</th>
                          <th className="px-2 py-2 font-semibold text-right">Amount</th>
                          <th className="px-4 py-2 font-semibold">Stage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.lines.map((l, i) => (
                          <tr key={i} className="border-t border-s-border align-top">
                            <td className="px-4 py-2 whitespace-nowrap text-s-muted">{l.date}</td>
                            <td className="px-2 py-2 text-s-text break-words max-w-[12rem]"><span className="text-s-muted">{l.source}</span> {l.document}</td>
                            <td className="px-2 py-2 text-s-text break-words max-w-[16rem]">{l.item}</td>
                            <td className="px-2 py-2 text-right font-mono whitespace-nowrap">{qty(l.quantity)} {l.unit}</td>
                            <td className="px-2 py-2 text-right font-mono whitespace-nowrap">{fmtPkr(l.rateCents)}</td>
                            <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${l.amountCents < 0 ? 'text-s-red' : 'text-s-text'}`}>{fmtPkr(l.amountCents)}</td>
                            <td className="px-4 py-2 text-s-muted break-words max-w-[12rem]">{l.stage}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t border-s-border"><td colSpan={5} className="px-2 py-1.5 text-right text-s-muted">Items</td><td className="px-2 py-1.5 text-right font-mono">{fmtPkr(g.itemsCents)}</td><td /></tr>
                        {g.taxCents !== 0 && <tr><td colSpan={5} className="px-2 py-1.5 text-right text-s-muted">Sales tax</td><td className="px-2 py-1.5 text-right font-mono">{fmtPkr(g.taxCents)}</td><td /></tr>}
                        <tr className="border-t border-s-border font-bold"><td colSpan={5} className="px-2 py-2 text-right text-s-text">Total</td><td className="px-2 py-2 text-right font-mono text-s-text">{fmtPkr(g.totalCents)}</td><td /></tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
