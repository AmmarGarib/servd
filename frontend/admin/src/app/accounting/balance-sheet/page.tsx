'use client'
// Balance sheet. Equity shows each company's earnings as two lines (H29,
// virtual roll-forward): 'Retained earnings b/f' — profit before the company's
// fiscal year (the one containing the date) started — and 'Profit for the year
// to date'. In "All companies" view every company keeps its own rows: the
// inter-company Due from / Due to balances are shown GROSS, never netted — this
// is not a consolidation.
import { Input } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso } from '../../../lib/money'
import Link from 'next/link'
import { ExportMenu } from '@/components/ui/ExportMenu'

// In "All companies" view (more than one company) each row names its company.
type Row = { tenantId?: string | null; companyName?: string | null; code: string; name: string; balanceCents: number }

interface BalanceSheet {
  asOf: string
  companies: Array<{ id: string; name: string }>
  assets:      Row[]
  liabilities: Row[]
  equity:      Row[]
  earningsByCompany?: Array<{
    tenantId: string
    companyName: string
    fiscalYear: { label: string; start: string; end: string }
    retainedEarningsBroughtForwardCents: number
    currentYearEarningsCents: number
  }>
  ppe?: Array<{ tenantId: string | null; companyName: string | null; classKey: string; label: string; costCents: number; accumulatedCents: number; netCents: number }>
  totals: {
    assetsCents: number
    liabilitiesCents: number
    equityCents: number
    retainedEarningsBroughtForwardCents?: number
    currentYearEarningsCents?: number
    currentEarningsCents: number
    differenceCents: number
  }
}

/** The two earnings lines per company (older API: one 'Current period earnings' line). */
function earningsRows(data: BalanceSheet): Row[] {
  if (!data.earningsByCompany) {
    return [{ code: '—', name: 'Current period earnings', balanceCents: data.totals.currentEarningsCents }]
  }
  const rows: Row[] = data.earningsByCompany.flatMap((e) => [
    { tenantId: e.tenantId, companyName: e.companyName, code: '—', name: `Retained earnings b/f (before ${e.fiscalYear.start})`, balanceCents: e.retainedEarningsBroughtForwardCents },
    { tenantId: e.tenantId, companyName: e.companyName, code: '—', name: `Profit for the year to date (${e.fiscalYear.label})`, balanceCents: e.currentYearEarningsCents },
  ])
  const owned = data.earningsByCompany.reduce((s, e) => s + e.retainedEarningsBroughtForwardCents + e.currentYearEarningsCents, 0)
  const rest = data.totals.currentEarningsCents - owned
  if (rest !== 0) rows.push({ code: '—', name: 'Profit on accounts with no company', balanceCents: rest })
  return rows
}

function Section({ title, rows, total, multi }: { title: string; rows: Row[]; total: number; multi: boolean }) {
  return (
    <div className="s-card mb-4">
      <div className="px-4 py-2 border-b border-s-border bg-s-bg-soft">
        <h3 className="text-sm font-semibold text-s-text">{title}</h3>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.tenantId ?? ''}:${r.code}:${r.name}`} className="border-b border-s-border last:border-0">
              {multi && <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{r.companyName ?? ''}</td>}
              <td className="px-4 py-2 font-mono text-xs text-s-muted w-20">{r.code}</td>
              <td className="px-4 py-2 text-s-text">{r.name}</td>
              <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.balanceCents)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={multi ? 4 : 3} className="px-4 py-3 text-xs text-s-muted">No balances</td></tr>
          )}
        </tbody>
        <tfoot className="bg-s-bg-soft border-t border-s-border font-semibold">
          <tr>
            <td colSpan={multi ? 3 : 2} className="px-4 py-2 text-s-text">Total {title}</td>
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

  const multi = (data?.companies?.length ?? 0) > 1

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
          <h1 className="text-xl font-bold text-s-text">Balance Sheet</h1>
        </div>
        <div className="flex items-center gap-3">
          <Input className="w-auto px-3 py-1.5 text-sm" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)}
             />
          <ExportMenu path={`/accounting/balance-sheet?asOf=${asOf}`} filename={`balance-sheet-${asOf}`} />
        </div>
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && (
          <>
            <Section title="Assets"      rows={data.assets}      total={data.totals.assetsCents} multi={multi} />
            <Section title="Liabilities" rows={data.liabilities} total={data.totals.liabilitiesCents} multi={multi} />
            <Section
              multi={multi}
              title="Equity"
              rows={[
                ...data.equity,
                ...earningsRows(data),
              ]}
              total={data.totals.equityCents + data.totals.currentEarningsCents}
            />

            {multi && (
              <p className="text-xs text-s-muted mb-4">
                All companies: each company&rsquo;s own books side by side. Inter-company Due from / Due to balances are shown gross (one company&rsquo;s receivable, the other&rsquo;s payable) — they are not netted off.
              </p>
            )}

            {data.ppe && data.ppe.length > 0 && (
              <div className="s-card mb-4">
                <div className="px-4 py-2 border-b border-s-border bg-s-bg-soft">
                  <h3 className="text-sm font-semibold text-s-text">Fixed assets by class</h3>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs text-s-muted">
                      <tr>
                        {multi && <th className="px-4 py-2 text-left">Company</th>}
                        <th className="px-4 py-2 text-left">Class</th>
                        <th className="px-4 py-2 text-right">Cost</th>
                        <th className="px-4 py-2 text-right">Accumulated depreciation</th>
                        <th className="px-4 py-2 text-right">Net book value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.ppe.map((p) => (
                        <tr key={`${p.tenantId ?? ''}:${p.classKey}`} className="border-t border-s-border">
                          {multi && <td className="px-4 py-2 text-xs text-s-muted whitespace-nowrap">{p.companyName ?? ''}</td>}
                          <td className="px-4 py-2 text-s-text">{p.label}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(p.costCents)}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{fmtPkr(p.accumulatedCents)}</td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(p.netCents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className={`s-card p-4 ${data.totals.differenceCents === 0 ? 'border-accent' : 'border-s-red'}`}>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-s-muted">Assets</p>
                  <p className="text-lg font-bold text-s-text">{fmtPkr(data.totals.assetsCents)}</p>
                </div>
                <div>
                  <p className="text-xs text-s-muted">Liabilities + equity + earnings</p>
                  <p className="text-lg font-bold text-s-text">
                    {fmtPkr(data.totals.liabilitiesCents + data.totals.equityCents + data.totals.currentEarningsCents)}
                  </p>
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-s-border">
                <p className={`text-sm ${data.totals.differenceCents === 0 ? 'text-success' : 'text-s-red'}`}>
                  {data.totals.differenceCents === 0
                    ? 'Balance sheet balances'
                    : `Off by ${fmtPkr(data.totals.differenceCents)} — investigate`}
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
