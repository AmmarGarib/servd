'use client'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import Link from 'next/link'

interface TrialBalance {
  asOf: string
  rows: Array<{ code: string; name: string; type: string; debitCents: number; creditCents: number }>
  totals: { debitCents: number; creditCents: number; differenceCents: number }
}

export default function TrialBalancePage() {
  const [asOf, setAsOf] = useState(todayPktIso())

  const { data, isLoading } = useQuery({
    queryKey: ['trial-balance', asOf],
    queryFn: () => api.get<TrialBalance>(`/accounting/trial-balance?asOf=${asOf}`),
  })

  const apiUrl = process.env['NEXT_PUBLIC_API_URL'] ?? ''
  const csvHref = `${apiUrl}/api/v1/accounting/trial-balance?asOf=${asOf}&format=csv`

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Trial Balance</h1>
        </div>
        <div className="flex items-center gap-3">
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
            className="bg-s-card border border-s-border rounded px-3 py-1.5 text-sm text-s-text" />
          <a href={csvHref} className="s-btn-secondary text-sm">Export CSV</a>
        </div>
      </header>

      <div className="p-6 max-w-5xl">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <div className="s-card p-4 mb-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-s-muted">Total Debits</p>
                  <p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.debitCents)}</p>
                </div>
                <div>
                  <p className="text-xs text-s-muted">Total Credits</p>
                  <p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.creditCents)}</p>
                </div>
                <div>
                  <p className="text-xs text-s-muted">Difference</p>
                  <p className={`text-lg font-bold ${data.totals.differenceCents === 0 ? 'text-s-teal' : 'text-s-red'}`}>
                    {fmtPkr(data.totals.differenceCents)}
                    {data.totals.differenceCents !== 0 && <span className="ml-2 text-xs">⚠ books unbalanced</span>}
                  </p>
                </div>
              </div>
            </div>

            <div className="s-card overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-s-bg-soft border-b border-s-border">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Code</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Account</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Type</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-s-muted">Debit</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-s-muted">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => (
                    <tr key={row.code} className="border-b border-s-border last:border-0">
                      <td className="px-4 py-2 font-mono text-xs text-s-muted">{row.code}</td>
                      <td className="px-4 py-2 text-s-text">{row.name}</td>
                      <td className="px-4 py-2 text-xs text-s-muted">{row.type}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{row.debitCents > 0 ? fmtPkr(row.debitCents) : ''}</td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{row.creditCents > 0 ? fmtPkr(row.creditCents) : ''}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-s-bg-soft border-t border-s-border font-semibold">
                  <tr>
                    <td colSpan={3} className="px-4 py-2 text-s-text">Totals</td>
                    <td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.totals.debitCents)}</td>
                    <td className="px-4 py-2 text-right font-mono text-s-text">{fmtPkr(data.totals.creditCents)}</td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
