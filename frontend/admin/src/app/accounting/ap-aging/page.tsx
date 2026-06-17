'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import Link from 'next/link'

interface ApAging {
  asOf: string
  total: { current: number; '1_30': number; '31_60': number; '61_90': number; '90_plus': number; total: number; bills: number }
  bySupplier: Array<{
    supplierId: string; supplierName: string; bills: number; total: number
    current: number; '1_30': number; '31_60': number; '61_90': number; '90_plus': number
  }>
}

export default function ApAgingPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['ap-aging'],
    queryFn: () => api.get<ApAging>('/procurement/ap-aging'),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Accounts Payable Aging</h1>
      </header>

      <div className="p-6 max-w-6xl space-y-4">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {([
                { k: 'current', label: 'Current',     color: 'text-s-text'  },
                { k: '1_30',    label: '1–30 days',   color: 'text-s-amber' },
                { k: '31_60',   label: '31–60 days',  color: 'text-s-amber' },
                { k: '61_90',   label: '61–90 days',  color: 'text-s-red'   },
                { k: '90_plus', label: '90+ days',    color: 'text-s-red'   },
              ] as const).map((b) => (
                <div key={b.k} className="s-card p-3">
                  <p className="text-xs text-s-muted">{b.label}</p>
                  <p className={`text-lg font-bold ${b.color}`}>{fmtPkr(data.total[b.k])}</p>
                </div>
              ))}
            </div>

            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
                By Supplier ({data.bySupplier.length}) — total outstanding {fmtPkr(data.total.total)}
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left">Supplier</th>
                    <th className="px-4 py-2 text-right">Bills</th>
                    <th className="px-4 py-2 text-right">Current</th>
                    <th className="px-4 py-2 text-right">1–30</th>
                    <th className="px-4 py-2 text-right">31–60</th>
                    <th className="px-4 py-2 text-right">61–90</th>
                    <th className="px-4 py-2 text-right">90+</th>
                    <th className="px-4 py-2 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.bySupplier.map((s) => (
                    <tr key={s.supplierId} className="border-t border-s-border">
                      <td className="px-4 py-2 text-s-text">{s.supplierName}</td>
                      <td className="px-4 py-2 text-right text-xs text-s-muted">{s.bills}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{s.current  > 0 ? fmtPkr(s.current)  : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{s['1_30']  > 0 ? fmtPkr(s['1_30'])  : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-amber">{s['31_60'] > 0 ? fmtPkr(s['31_60']) : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-red">{s['61_90'] > 0 ? fmtPkr(s['61_90']) : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-red">{s['90_plus'] > 0 ? fmtPkr(s['90_plus']) : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-sm text-s-text font-semibold">{fmtPkr(s.total)}</td>
                    </tr>
                  ))}
                  {data.bySupplier.length === 0 && (
                    <tr><td colSpan={8} className="px-4 py-3 text-xs text-s-muted">No outstanding payables</td></tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
