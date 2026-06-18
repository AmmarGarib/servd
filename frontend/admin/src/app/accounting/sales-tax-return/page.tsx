'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import Link from 'next/link'

interface AccountTotal { code: string; name: string; totalCents: number }
interface STR {
  period: { from: string; to: string }
  outputTax: { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  inputTax:  { fbr: AccountTotal; pra: AccountTotal; srb: AccountTotal; kpra: AccountTotal; bra: AccountTotal; totalCents: number }
  taxableSalesCents: number
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }>
  netPayableCents: number
  notes: string[]
}

export default function SalesTaxReturnPage() {
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['sales-tax-return', from, to],
    queryFn: () => api.get<STR>(`/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}`),
  })

  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? ''
  const csv = `${apiUrl}/api/v1/accounting/sales-tax-return?dateFrom=${from}&dateTo=${to}&format=csv`

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
          <a href={csv} className="s-btn-secondary text-sm">Export CSV</a>
        </div>
      </header>

      <div className="p-6 max-w-4xl mx-auto space-y-4">
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

            {/* Net + concept breakdown */}
            <div className="s-card p-4">
              <div className="flex justify-between text-base font-bold mb-2">
                <span className="text-s-text">Net payable / (refund)</span>
                <span className={data.netPayableCents >= 0 ? 'text-s-red' : 'text-s-teal'}>{fmtPkr(data.netPayableCents)}</span>
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
