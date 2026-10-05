'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import Link from 'next/link'

interface BalanceSheet {
  asOf: string
  assets:      Array<{ code: string; name: string; balanceCents: number }>
  liabilities: Array<{ code: string; name: string; balanceCents: number }>
  equity:      Array<{ code: string; name: string; balanceCents: number }>
  totals: {
    assetsCents: number
    liabilitiesCents: number
    equityCents: number
    currentEarningsCents: number
    differenceCents: number
  }
}

function Section({ title, rows, total }: { title: string; rows: BalanceSheet['assets']; total: number }) {
  return (
    <div className="s-card mb-4">
      <div className="px-4 py-2 border-b border-s-border bg-s-bg-soft">
        <h3 className="text-sm font-semibold text-s-text">{title}</h3>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.code} className="border-b border-s-border last:border-0">
              <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
              <td className="px-4 py-2 text-s-text">{r.name}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.balanceCents)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={3} className="px-4 py-3 text-xs text-s-muted">No balances</td></tr>
          )}
        </tbody>
        <tfoot className="bg-s-bg-soft border-t border-s-border font-semibold">
          <tr>
            <td colSpan={2} className="px-4 py-2 text-s-text">Total {title}</td>
            <td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(total)}</td>
          </tr>
        </tfoot>
      </table>
      </div>
    </div>
  )
}

export default function BalanceSheetPage() {
  const [asOf, setAsOf] = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['balance-sheet', asOf],
    queryFn: () => api.get<BalanceSheet>(`/accounting/balance-sheet?asOf=${asOf}`),
  })

  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? ''
  const csvHref = `${apiUrl}/api/v1/accounting/balance-sheet?asOf=${asOf}&format=csv`

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Balance Sheet</h1>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
            className="bg-s-card border border-s-border rounded px-3 py-1.5 text-sm text-s-text" />
          <a href={csvHref} className="s-btn-secondary text-sm">Export CSV</a>
        </div>
      </header>

      <div className="p-6 max-w-5xl mx-auto">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <Section title="Assets"      rows={data.assets}      total={data.totals.assetsCents} />
            <Section title="Liabilities" rows={data.liabilities} total={data.totals.liabilitiesCents} />
            <Section
              title="Equity"
              rows={[
                ...data.equity,
                { code: '—', name: 'Current Period Earnings', balanceCents: data.totals.currentEarningsCents },
              ]}
              total={data.totals.equityCents + data.totals.currentEarningsCents}
            />

            <div className={`s-card p-4 ${data.totals.differenceCents === 0 ? 'border-s-teal' : 'border-s-red'}`}>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-s-muted">Assets</p>
                  <p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.assetsCents)}</p>
                </div>
                <div>
                  <p className="text-xs text-s-muted">Liabilities + Equity + Earnings</p>
                  <p className="text-lg font-bold text-s-text">
                    {fmtPkr(data.totals.liabilitiesCents + data.totals.equityCents + data.totals.currentEarningsCents)}
                  </p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-s-border">
                <p className={`text-sm ${data.totals.differenceCents === 0 ? 'text-primary-ink' : 'text-s-red'}`}>
                  {data.totals.differenceCents === 0
                    ? '✓ Balance sheet balances'
                    : `⚠ Off by ${fmtPkr(data.totals.differenceCents)} — investigate`}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
