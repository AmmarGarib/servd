'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import Link from 'next/link'

interface AccountTotal { code: string; name: string; totalCents: number }
interface AuthorityReturn {
  authority: string
  name: string
  output: AccountTotal
  input: AccountTotal
  /** output − input of THIS authority; negative = excess input carried forward with it. */
  netPayableCents: number
  brands: string[]
  /** Output tax not explained by the period's order sales (manual journals, B2B invoices, older entries). */
  otherOutputCents: number
}
interface RateLine {
  authority: string
  ratePct: number | null
  tender: 'cash' | 'card' | 'other'
  orders: number
  salesValueCents: number
  salesTaxCents: number
  refundValueCents: number
  refundTaxCents: number
  taxableValueCents: number
  taxCents: number
}
interface Reclass { conceptSlug: string; conceptName: string; fromAccount: string; toAccount: string; amountCents: number }
interface STR {
  period: { from: string; to: string }
  outputTax: { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  inputTax:  { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  taxableSalesCents: number
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }>
  byAuthority: AuthorityReturn[]
  byRate: RateLine[]
  reclassification: Reclass[]
  netPayableCents: number
  carryForwardCents: number
  notes: string[]
}

const TENDER_LABEL: Record<RateLine['tender'], string> = { cash: 'Cash', card: 'Card / online', other: 'Other' }

export default function SalesTaxReturnPage() {
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['sales-tax-return', from, to],
    queryFn: () => api.get<STR>(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}`),
  })

  // Through api.download so the request carries the session (a plain link
  // sent no Authorization header and the export came back 401).
  const [csvError, setCsvError] = useState<string | null>(null)
  async function exportCsv() {
    setCsvError(null)
    try { await api.download(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}&format=csv`, `sales-tax-return-${from}-${to}.csv`) }
    catch (e) { setCsvError((e as Error).message) }
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Sales Tax Return Helper</h1>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <button type="button" onClick={exportCsv} className="s-btn-secondary text-sm">Export CSV</button>
        </div>
      </header>

      <div className="p-6 max-w-4xl mx-auto space-y-4">
        {csvError && <p className="text-s-red text-sm">CSV export failed: {csvError}</p>}
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <p className="text-xs text-s-muted">
              Period: {data.period.from} → {data.period.to}. This is reference data — file via FBR IRIS / provincial portal yourself.
            </p>

            {/* Output tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Output Tax (collected from customers)</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[data.outputTax.fbr, data.outputTax.pra, data.outputTax.srb, data.outputTax.kpra, data.outputTax.bra].map((r) => (
                    <tr key={r.code} className="border-t border-s-border">
                      <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
                      <td className="px-4 py-2 text-s-text">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                  <tr><td colSpan={2} className="px-4 py-2 text-s-text">Total output</td><td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.outputTax.totalCents)}</td></tr>
                </tfoot>
              </table>
              </div>
            </div>

            {/* Input tax */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Input Tax (paid on supplier purchases)</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {[data.inputTax.fbr, data.inputTax.pra, data.inputTax.srb, data.inputTax.kpra, data.inputTax.bra].map((r) => (
                    <tr key={r.code} className="border-t border-s-border">
                      <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
                      <td className="px-4 py-2 text-s-text">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalCents)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-s-border bg-s-bg-soft font-semibold">
                  <tr><td colSpan={2} className="px-4 py-2 text-s-text">Total input</td><td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.inputTax.totalCents)}</td></tr>
                </tfoot>
              </table>
              </div>
            </div>

            {/* Per authority — each files its own return */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                By authority — each files its own return; one authority&apos;s input is never set off against another&apos;s output
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Authority</th>
                    <th className="px-4 py-2 text-right font-medium">Output</th>
                    <th className="px-4 py-2 text-right font-medium">Input</th>
                    <th className="px-4 py-2 text-right font-medium">Net payable</th>
                    <th className="px-4 py-2 text-right font-medium">Carried forward</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byAuthority.map((a) => (
                    <tr key={a.authority} className="border-t border-s-border align-top">
                      <td className="px-4 py-2 text-s-text">
                        <div className="font-semibold">{a.authority}</div>
                        <div className="text-xs text-s-muted">{a.name}</div>
                        {a.brands.length > 0 && <div className="text-xs text-s-muted font-mono">{a.brands.join(', ')}</div>}
                        {a.otherOutputCents !== 0 && (
                          <div className="text-xs text-s-muted">Not from order sales (manual journals, B2B invoices, older entries): {fmtPkr(a.otherOutputCents)}</div>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.output.totalCents)}<div className="text-s-muted">{a.output.code}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">
                        {fmtPkr(a.input.totalCents)}<div className="text-s-muted">{a.input.code}</div>
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(Math.max(0, a.netPayableCents))}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.max(0, -a.netPayableCents))}</td>
                    </tr>
                  ))}
                  {data.byAuthority.length === 0 && (
                    <tr><td colSpan={5} className="px-4 py-3 text-xs text-s-muted">No sales tax in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Per rate — the brand's cash and card rates, refunds netted */}
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">By rate (cash 15% / card 8%) — refunds netted</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Authority</th>
                    <th className="px-4 py-2 text-left font-medium">Tender · rate</th>
                    <th className="px-4 py-2 text-right font-medium">Orders</th>
                    <th className="px-4 py-2 text-right font-medium">Sales value / tax</th>
                    <th className="px-4 py-2 text-right font-medium">Refunds value / tax</th>
                    <th className="px-4 py-2 text-right font-medium">Taxable value</th>
                    <th className="px-4 py-2 text-right font-medium">Output tax</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byRate.map((r) => (
                    <tr key={`${r.authority}-${r.tender}-${r.ratePct ?? 'none'}`} className="border-t border-s-border">
                      <td className="px-4 py-2 text-s-text">{r.authority}</td>
                      <td className="px-4 py-2 text-s-text">{TENDER_LABEL[r.tender]} · {r.ratePct == null ? 'rate not stored' : `${r.ratePct}%`}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{r.orders}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.salesValueCents)} / {fmtPkr(r.salesTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(r.refundValueCents)} / {fmtPkr(r.refundTaxCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.taxableValueCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs font-semibold text-s-text">{fmtPkr(r.taxCents)}</td>
                    </tr>
                  ))}
                  {data.byRate.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-3 text-xs text-s-muted">No order sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {/* Tax still in 2030 for provincially-taxed brands */}
            {data.reclassification.length > 0 && (
              <div className="s-card overflow-hidden border-l-4 border-s-amber">
                <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                  To reclassify — post one manual journal per brand, tagged with the brand, dated in the open period
                </div>
                <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <tbody>
                    {data.reclassification.map((r) => (
                      <tr key={r.conceptSlug} className="border-t border-s-border">
                        <td className="px-4 py-2 text-s-text">{r.conceptName} <span className="text-xs font-mono text-s-muted">{r.conceptSlug}</span></td>
                        <td className="px-4 py-2 font-mono text-xs text-s-text">
                          {r.amountCents >= 0 ? `Dr ${r.fromAccount} / Cr ${r.toAccount}` : `Dr ${r.toAccount} / Cr ${r.fromAccount} (refund)`}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(Math.abs(r.amountCents))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </div>
            )}

            {/* Net */}
            <div className="s-card p-4 space-y-1">
              <div className="flex justify-between text-base font-bold">
                <span className="text-s-text">Net payable (each authority&apos;s own net)</span>
                <span className={data.netPayableCents > 0 ? 'text-s-red' : 'text-s-text'}>{fmtPkr(data.netPayableCents)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-s-muted">Excess input carried forward (with its own authority)</span>
                <span className="font-mono text-s-text">{fmtPkr(data.carryForwardCents)}</span>
              </div>
              <p className="text-xs text-s-muted">Total taxable sales: {fmtPkr(data.taxableSalesCents)}</p>
            </div>

            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Taxable Sales by Concept</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.taxableValueByConceptCents.map((c) => (
                    <tr key={c.conceptSlug} className="border-t border-s-border">
                      <td className="px-4 py-2 text-xs font-mono text-s-muted w-32">{c.conceptSlug}</td>
                      <td className="px-4 py-2 text-s-text">{c.conceptName}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(c.revenueCents)}</td>
                    </tr>
                  ))}
                  {data.taxableValueByConceptCents.length === 0 && (
                    <tr><td colSpan={3} className="px-4 py-3 text-xs text-s-muted">No taxable sales in this period</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>

            {data.notes.length > 0 && (
              <div className="s-card p-4 border-l-4 border-s-amber">
                <p className="text-xs font-semibold text-s-amber mb-1">Caveats — read before filing</p>
                <ul className="text-xs text-s-text space-y-1 list-disc list-inside">
                  {data.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
