'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import Link from 'next/link'

// Inflow / outflow are cash from and to OUTSIDE the company. Money moved
// between the company's own cash accounts (safe drops, pay-ins, bank
// deposits) is a transfer: shown per account, never counted as cash flow.
interface CashFlow {
  dateFrom: string
  dateTo: string
  companies: Array<{ id: string; name: string }>
  byCashAccount: Array<{
    tenantId: string | null; companyName: string | null; code: string; name: string
    inflowCents: number; outflowCents: number; transferInCents: number; transferOutCents: number; netCents: number
  }>
  byCategory: Array<{ category: 'operating'|'investing'|'financing'; inflowCents: number; outflowCents: number; netCents: number }>
  totals: { inflowCents: number; outflowCents: number; netCents: number; transfersCents: number }
}

export default function CashFlowPage() {
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['cash-flow', from, to],
    queryFn: () => api.get<CashFlow>(`/accounting/cash-flow?dateFrom=${from}&dateTo=${to}`),
  })

  const multi = (data?.companies?.length ?? 0) > 1

  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? ''
  const csvHref = `${apiUrl}/api/v1/accounting/cash-flow?dateFrom=${from}&dateTo=${to}&format=csv`

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Cash Flow</h1>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <a href={csvHref} className="s-btn-secondary text-sm">Export CSV</a>
        </div>
      </header>

      <div className="p-6 max-w-4xl mx-auto space-y-4">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">By Cash Account</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-4 py-2 text-left">Account</th>
                    <th className="px-4 py-2 text-right">Inflow</th>
                    <th className="px-4 py-2 text-right">Outflow</th>
                    <th className="px-4 py-2 text-right">Transfers (own accounts)</th>
                    <th className="px-4 py-2 text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCashAccount.map((r) => (
                    <tr key={`${r.tenantId ?? ''}:${r.code}`} className="border-t border-s-border">
                      <td className="px-4 py-2 text-s-text">
                        <span className="font-mono text-xs text-s-muted mr-2">{r.code}</span>{r.name}
                        {multi && r.companyName && <span className="block text-[11px] text-s-muted">{r.companyName}</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-success">{fmtPkr(r.inflowCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-red">{fmtPkr(r.outflowCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">
                        {r.transferInCents === 0 && r.transferOutCents === 0 ? '—' : fmtPkr(r.transferInCents - r.transferOutCents)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.netCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            <div className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">By Category</div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.byCategory.map((r) => (
                    <tr key={r.category} className="border-t border-s-border first:border-0">
                      <td className="px-4 py-2 text-s-text capitalize">{r.category}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-success">{fmtPkr(r.inflowCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-red">{fmtPkr(r.outflowCents)}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.netCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>

            <div className="s-card p-4 space-y-2">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-s-muted">Cash in</span>
                <span className="font-mono text-success">{fmtPkr(data.totals.inflowCents)}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-s-muted">Cash out</span>
                <span className="font-mono text-s-red">{fmtPkr(data.totals.outflowCents)}</span>
              </div>
              <div className="flex flex-wrap justify-between gap-2 font-bold pt-2 border-t border-s-border">
                <span className="text-s-text">Net Change in Cash</span>
                <span className={data.totals.netCents >= 0 ? 'text-success' : 'text-s-red'}>{fmtPkr(data.totals.netCents)}</span>
              </div>
              <p className="text-xs text-s-muted">
                {fmtPkr(data.totals.transfersCents)} moved between the company&apos;s own cash accounts (safe drops, pay-ins, bank deposits).
                Transfers change which account holds the cash, not how much there is, so they are not counted as cash in or out.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
