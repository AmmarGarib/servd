'use client'
// Trial balance. By default the fiscal-year basis (H29): revenue and expense
// accounts from each company's fiscal-year start, plus ONE computed
// 'Retained earnings b/f' row per company holding the profit before it (shown
// muted — no account behind it). "Since inception" shows every account's
// whole history. Either way debits equal credits.
import { CheckLabel, Input } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import Link from 'next/link'
import { ExportMenu } from '@/components/ui/ExportMenu'

interface TrialBalance {
  asOf: string
  // More than one company = "All companies" view: each row names its company
  // (the same code appears once per company) and each company's books must
  // balance on their own.
  companies: Array<{ id: string; name: string }>
  basis?: 'inception' | 'year'
  fiscalYears?: Array<{ tenantId: string; label: string; start: string; end: string }>
  rows: Array<{ tenantId: string | null; companyName: string | null; code: string; name: string; type: string; debitCents: number; creditCents: number; virtual?: boolean }>
  totals: { debitCents: number; creditCents: number; differenceCents: number }
  companyTotals: Array<{ tenantId: string; name: string; debitCents: number; creditCents: number; differenceCents: number }>
}

export default function TrialBalancePage() {
  const [asOf, setAsOf] = useState(todayPktIso())
  const [basis, setBasis] = useState<'year' | 'inception'>('year')

  const { data, isLoading } = useQuery({
    queryKey: ['trial-balance', asOf, basis],
    queryFn: () => api.get<TrialBalance>(`/accounting/trial-balance?asOf=${asOf}&basis=${basis}`),
  })

  const multi = (data?.companies.length ?? 0) > 1

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Trial Balance</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CheckLabel className="flex items-center gap-1.5 text-xs text-s-text">
            <input type="checkbox" className="accent-primary" checked={basis === 'inception'} onChange={(e) => setBasis(e.target.checked ? 'inception' : 'year')} />
            Since inception
          </CheckLabel>
          <Input className="w-auto px-3 py-1.5 text-sm" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
             />
          <ExportMenu path={`/accounting/trial-balance?asOf=${asOf}&basis=${basis}`} filename={`trial-balance-${basis === 'year' ? 'year-' : ''}${asOf}`} />
        </div>
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            {data.basis === 'year' && data.fiscalYears && data.fiscalYears.length > 0 && (
              <p className="text-xs text-s-muted mb-3">
                Income and expenses from the start of the fiscal year
                {data.fiscalYears.length === 1
                  ? ` (${data.fiscalYears[0]!.label}, from ${data.fiscalYears[0]!.start})`
                  : `: ${data.fiscalYears.map((y) => `${data.companies.find((c) => c.id === y.tenantId)?.name ?? ''} ${y.label} from ${y.start}`).join('; ')}`}
                ; earlier profit is the computed retained earnings b/f row.
              </p>
            )}
            <p className="text-xs text-s-muted mb-3">
              Each account shows its net balance, in the Debit or the Credit column; accounts with a zero balance are not listed.
            </p>
            <div className="s-card p-4 mb-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
                  <p className={`text-lg font-bold ${data.totals.differenceCents === 0 ? 'text-success' : 'text-s-red'}`}>
                    {fmtPkr(data.totals.differenceCents)}
                    {data.totals.differenceCents !== 0 && <span className="ml-2 text-xs">books unbalanced</span>}
                  </p>
                </div>
              </div>
              {multi && (
                <div className="mt-3 pt-3 border-t border-s-border space-y-1">
                  {data.companyTotals.map((c) => (
                    <p key={c.tenantId} className="text-xs text-s-muted flex flex-wrap justify-between gap-2">
                      <span className="text-s-text">{c.name}</span>
                      <span className="font-mono">
                        Dr {fmtPkr(c.debitCents)} · Cr {fmtPkr(c.creditCents)} ·{' '}
                        <span className={c.differenceCents === 0 ? 'text-success' : 'text-s-red'}>
                          {c.differenceCents === 0 ? 'balanced' : `off by ${fmtPkr(c.differenceCents)}`}
                        </span>
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="s-card overflow-hidden">
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-s-bg-soft border-b border-s-border">
                  <tr>
                    {multi && <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Company</th>}
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Code</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Account</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-s-muted">Type</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-s-muted">Debit</th>
                    <th className="px-4 py-2 text-right text-xs font-medium text-s-muted">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((row) => {
                    // The computed b/f row: muted and italic — no account behind it.
                    const ink = row.virtual ? 'text-s-muted italic' : 'text-s-text'
                    return (
                      <tr key={`${row.tenantId ?? ''}:${row.code}`} className="border-b border-s-border last:border-0">
                        {multi && <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{row.companyName ?? '—'}</td>}
                        <td className="px-4 py-2 font-mono text-xs text-s-muted">{row.code}</td>
                        <td className={`px-4 py-2 ${ink}`}>{row.name}{row.virtual && <span className="ml-1 text-xs not-italic">(computed)</span>}</td>
                        <td className="px-4 py-2 text-xs text-s-muted">{row.type}</td>
                        <td className={`px-4 py-2 text-right font-mono text-xs ${ink}`}>{row.debitCents > 0 ? fmtPkr(row.debitCents) : ''}</td>
                        <td className={`px-4 py-2 text-right font-mono text-xs ${ink}`}>{row.creditCents > 0 ? fmtPkr(row.creditCents) : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot className="bg-s-bg-soft border-t border-s-border font-semibold">
                  <tr>
                    <td colSpan={multi ? 4 : 3} className="px-4 py-2 text-s-text">Totals{multi && ' (all companies)'}</td>
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
