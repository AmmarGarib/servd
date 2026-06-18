'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import Link from 'next/link'

interface PL {
  dateFrom: string
  dateTo: string
  revenue: Array<{ code: string; name: string; amountCents: number }>
  cogs:    Array<{ code: string; name: string; amountCents: number }>
  opex:    Array<{ code: string; name: string; amountCents: number }>
  contraRevenue: Array<{ code: string; name: string; amountCents: number }>
  totals: {
    revenueCents: number; cogsCents: number; grossProfitCents: number
    grossMarginPct: number; opexCents: number; contraRevenueCents: number; netProfitCents: number
  }
}

function Section({ title, rows, total, neg }: { title: string; rows: PL['revenue']; total: number; neg?: boolean }) {
  return (
    <div className="mb-3">
      <div className="px-4 py-1.5 bg-s-bg-soft border border-s-border text-xs font-semibold text-s-text rounded-t">{title}</div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm border-x border-s-border">
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-b border-s-border last:border-0">
              <td className="px-4 py-1.5 font-mono text-xs text-s-muted w-20">{r.code}</td>
              <td className="px-4 py-1.5 text-s-text">{r.name}</td>
              <td className={`px-4 py-1.5 text-right font-mono text-xs ${neg ? 'text-s-red' : 'text-s-text'}`}>
                {neg ? '(' + fmtPkr(r.amountCents) + ')' : fmtPkr(r.amountCents)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} className="px-4 py-2 text-xs text-s-muted">—</td></tr>
          )}
        </tbody>
      </table>
      </div>
      <div className="px-4 py-1.5 bg-s-bg-soft border border-s-border border-t-0 text-sm font-semibold text-s-text rounded-b flex justify-between">
        <span>Total {title}</span>
        <span className={`font-mono ${neg ? 'text-s-red' : ''}`}>{neg ? '(' + fmtPkr(total) + ')' : fmtPkr(total)}</span>
      </div>
    </div>
  )
}

export default function PLLedgerPage() {
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['pl-ledger', from, to],
    queryFn: () => api.get<PL>(`/accounting/pl-ledger?dateFrom=${from}&dateTo=${to}`),
  })

  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? ''
  const csvHref = `${apiUrl}/api/v1/accounting/pl-ledger?dateFrom=${from}&dateTo=${to}&format=csv`

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">P&L (from ledger)</h1>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
            className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <span className="text-s-muted text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
            className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
          <a href={csvHref} className="s-btn-secondary text-sm">Export CSV</a>
        </div>
      </header>

      <div className="p-6 max-w-4xl mx-auto">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <Section title="Revenue"            rows={data.revenue}       total={data.totals.revenueCents} />
            <Section title="Discounts/Refunds"  rows={data.contraRevenue} total={data.totals.contraRevenueCents} neg />
            <Section title="Cost of Goods Sold" rows={data.cogs}          total={data.totals.cogsCents} neg />

            <div className="s-card p-4 mb-4">
              <div className="flex justify-between text-base font-bold">
                <span className="text-s-text">Gross Profit</span>
                <span className="text-s-teal">{fmtPkr(data.totals.grossProfitCents)} ({data.totals.grossMarginPct}%)</span>
              </div>
            </div>

            <Section title="Operating Expenses" rows={data.opex} total={data.totals.opexCents} neg />

            <div className="s-card p-4 border-2 border-s-teal">
              <div className="flex justify-between text-lg font-bold">
                <span className="text-s-text">Net Profit</span>
                <span className={data.totals.netProfitCents >= 0 ? 'text-s-teal' : 'text-s-red'}>
                  {fmtPkr(data.totals.netProfitCents)}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
