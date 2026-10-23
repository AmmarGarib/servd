'use client'
// THE P&L — from the ledger. Two tabs over one date range:
//   Statement — revenue, discounts/refunds, COGS, opex, operating profit,
//               other income (42xx, below the operating line) and net profit
//               (GET /accounting/pl-ledger)
//   By brand  — each brand's measured lines plus the shared bucket
//               (GET /accounting/pl-ledger/brands)
// The old /finance "P&L" summed the sales register (GST-inclusive, discount
// taken off twice, no costs); /finance now redirects here.
import { Input } from '@/components/finance/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../../lib/money'
import Link from 'next/link'
import { ExportMenu } from '@/components/ui/ExportMenu'

interface PL {
  dateFrom: string
  dateTo: string
  revenue: Array<{ code: string; name: string; amountCents: number }>
  cogs:    Array<{ code: string; name: string; amountCents: number }>
  opex:    Array<{ code: string; name: string; amountCents: number }>
  contraRevenue: Array<{ code: string; name: string; amountCents: number }>
  /** 42xx other income (kept deposits, breakage, …): below the operating result, never revenue. */
  otherIncome?: Array<{ code: string; name: string; amountCents: number }>
  totals: {
    revenueCents: number; cogsCents: number; grossProfitCents: number
    grossMarginPct: number; opexCents: number; contraRevenueCents: number; netProfitCents: number
    operatingProfitCents?: number; otherIncomeCents?: number
    /** Inside opexCents — shown as "of which". */
    depreciationCents?: number; impairmentCents?: number
  }
}

interface BrandRow {
  conceptId: string | null; name: string
  revenueCents: number; contraRevenueCents: number; netRevenueCents: number
  cogsCents: number; grossProfitCents: number; opexCents: number; netProfitCents: number
  otherIncomeCents?: number
  grossMarginPct: number
}
interface ByBrand {
  dateFrom: string; dateTo: string
  brands: BrandRow[]
  shared: BrandRow | null
  totals: Omit<BrandRow, 'conceptId' | 'name' | 'grossMarginPct'>
}

type Tab = 'statement' | 'brands'

// Date presets, in PKT — the ledger's periods are PKT days.
function shiftDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10)
}
const PRESETS: Array<{ key: string; label: string; range: () => { from: string; to: string } }> = [
  { key: 'today',     label: 'Today',      range: () => ({ from: todayPktIso(), to: todayPktIso() }) },
  { key: 'yesterday', label: 'Yesterday',  range: () => ({ from: shiftDays(todayPktIso(), -1), to: shiftDays(todayPktIso(), -1) }) },
  { key: 'week',      label: 'Last 7 days', range: () => ({ from: shiftDays(todayPktIso(), -6), to: todayPktIso() }) },
  { key: 'month',     label: 'This month', range: () => ({ from: startOfMonthPktIso(), to: todayPktIso() }) },
  { key: '90d',       label: 'Last 90 days', range: () => ({ from: shiftDays(todayPktIso(), -89), to: todayPktIso() }) },
]

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

function Statement({ data }: { data: PL }) {
  return (
    <>
      <Section title="Revenue"            rows={data.revenue}       total={data.totals.revenueCents} />
      <Section title="Discounts/Refunds"  rows={data.contraRevenue} total={data.totals.contraRevenueCents} neg />
      <Section title="Cost of Goods Sold" rows={data.cogs}          total={data.totals.cogsCents} neg />

      <div className="s-card p-4 mb-4">
        <div className="flex justify-between text-base font-bold">
          <span className="text-s-text">Gross Profit</span>
          <span className="text-success">{fmtPkr(data.totals.grossProfitCents)} ({data.totals.grossMarginPct}%)</span>
        </div>
      </div>

      <Section title="Operating Expenses" rows={data.opex} total={data.totals.opexCents} neg />
      {((data.totals.depreciationCents ?? 0) !== 0 || (data.totals.impairmentCents ?? 0) !== 0) && (
        <div className="px-4 -mt-2 mb-3 text-xs text-s-muted space-y-0.5">
          {(data.totals.depreciationCents ?? 0) !== 0 && (
            <div className="flex justify-between"><span>of which depreciation</span><span className="font-mono">({fmtPkr(data.totals.depreciationCents ?? 0)})</span></div>
          )}
          {(data.totals.impairmentCents ?? 0) !== 0 && (
            <div className="flex justify-between"><span>of which impairment</span><span className="font-mono">({fmtPkr(data.totals.impairmentCents ?? 0)})</span></div>
          )}
        </div>
      )}

      {data.totals.operatingProfitCents !== undefined && (
        <div className="s-card p-4 mb-4">
          <div className="flex justify-between text-base font-bold">
            <span className="text-s-text">Operating Profit</span>
            <span className={data.totals.operatingProfitCents >= 0 ? 'text-success' : 'text-s-red'}>{fmtPkr(data.totals.operatingProfitCents)}</span>
          </div>
        </div>
      )}

      {(data.otherIncome?.length ?? 0) > 0 && (
        <Section title="Other Income" rows={data.otherIncome ?? []} total={data.totals.otherIncomeCents ?? 0} />
      )}

      <div className="s-card p-4 border-2 border-accent">
        <div className="flex justify-between text-lg font-bold">
          <span className="text-s-text">Net Profit</span>
          <span className={data.totals.netProfitCents >= 0 ? 'text-success' : 'text-s-red'}>
            {fmtPkr(data.totals.netProfitCents)}
          </span>
        </div>
      </div>
    </>
  )
}

function BrandTable({ data }: { data: ByBrand }) {
  const rows = [...data.brands, ...(data.shared ? [data.shared] : [])]
  const cell = (c: number, neg?: boolean) => (
    <td className={`px-3 py-2 text-right font-mono text-xs ${neg ? 'text-s-red' : c < 0 ? 'text-s-red' : 'text-s-text'}`}>
      {c === 0 ? '—' : neg ? `(${fmtPkr(c)})` : fmtPkr(c)}
    </td>
  )
  return (
    <div className="space-y-3">
      <div className="s-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted bg-s-bg-soft">
              <tr>
                <th className="px-3 py-2 text-left">Brand</th>
                <th className="px-3 py-2 text-right">Revenue</th>
                <th className="px-3 py-2 text-right">Discounts / refunds</th>
                <th className="px-3 py-2 text-right">COGS</th>
                <th className="px-3 py-2 text-right">Gross profit</th>
                <th className="px-3 py-2 text-right">Opex</th>
                <th className="px-3 py-2 text-right">Other income</th>
                <th className="px-3 py-2 text-right">Net profit</th>
                <th className="px-3 py-2 text-right">Gross margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.conceptId ?? 'shared'} className={`border-t border-s-border ${r.conceptId ? '' : 'italic'}`}>
                  <td className="px-3 py-2 text-s-text">{r.name}</td>
                  {cell(r.revenueCents)}
                  {cell(r.contraRevenueCents, true)}
                  {cell(r.cogsCents, true)}
                  {cell(r.grossProfitCents)}
                  {cell(r.opexCents, true)}
                  {cell(r.otherIncomeCents ?? 0)}
                  {cell(r.netProfitCents)}
                  <td className="px-3 py-2 text-right text-xs text-s-muted">{r.revenueCents > 0 ? `${r.grossMarginPct}%` : '—'}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={9} className="px-3 py-3 text-xs text-s-muted">Nothing posted in this period.</td></tr>
              )}
              <tr className="border-t-2 border-s-border bg-s-bg-soft font-semibold">
                <td className="px-3 py-2 text-s-text">Total</td>
                {cell(data.totals.revenueCents)}
                {cell(data.totals.contraRevenueCents, true)}
                {cell(data.totals.cogsCents, true)}
                {cell(data.totals.grossProfitCents)}
                {cell(data.totals.opexCents, true)}
                {cell(data.totals.otherIncomeCents ?? 0)}
                {cell(data.totals.netProfitCents)}
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-s-muted">
        Each brand shows only what is measured on its own ledger lines (sales, discounts, food cost posted from its orders and shifts).
        Overhead, manual entries and older postings without a brand stay in the shared row — they are not spread across brands here.
      </p>
    </div>
  )
}

export default function PLLedgerPage() {
  const [tab, setTab] = useState<Tab>('statement')
  const [preset, setPreset] = useState<string | null>('month')
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())
  const [csvError, setCsvError] = useState<string | null>(null)

  const statement = useQuery({
    queryKey: ['pl-ledger', from, to],
    queryFn: () => api.get<PL>(`/accounting/pl-ledger?dateFrom=${from}&dateTo=${to}`),
    enabled: tab === 'statement',
  })
  const brands = useQuery({
    queryKey: ['pl-ledger-brands', from, to],
    queryFn: () => api.get<ByBrand>(`/accounting/pl-ledger/brands?dateFrom=${from}&dateTo=${to}`),
    enabled: tab === 'brands',
  })

  function applyPreset(key: string) {
    const p = PRESETS.find((x) => x.key === key)
    if (!p) return
    const r = p.range()
    setPreset(key); setFrom(r.from); setTo(r.to)
  }

  const exportPath = `${tab === 'statement' ? '/accounting/pl-ledger' : '/accounting/pl-ledger/brands'}?dateFrom=${from}&dateTo=${to}`
  const exportName = tab === 'statement' ? `pl-${from}-${to}` : `pl-by-brand-${from}-${to}`

  const isLoading = tab === 'statement' ? statement.isLoading : brands.isLoading

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
            <h1 className="text-xl font-bold text-s-text">Profit &amp; Loss</h1>
            <p className="text-xs text-s-muted">From the ledger — revenue ex-GST, after discounts and refunds.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((p) => (
              <button key={p.key} onClick={() => applyPreset(p.key)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  preset === p.key
                    ? 'bg-accent-dim border border-accent text-s-text'
                    : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'
                }`}>
                {p.label}
              </button>
            ))}
            <Input className="w-auto px-2 py-1 text-sm" type="date" value={from} onChange={(e) => { setPreset(null); setFrom(e.target.value) }}
               />
            <span className="text-s-muted text-xs">→</span>
            <Input className="w-auto px-2 py-1 text-sm" type="date" value={to} onChange={(e) => { setPreset(null); setTo(e.target.value) }}
               />
            <ExportMenu path={exportPath} filename={exportName} onError={(m) => setCsvError(m)} />
          </div>
        </div>
        <div className="flex gap-1 mt-3 -mb-px">
          {([['statement', 'Statement'], ['brands', 'By brand']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === k ? 'border-accent text-primary-ink' : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {label}
            </button>
          ))}
        </div>
      </header>

      <div className="p-6 max-w-5xl mx-auto">
        {csvError && <p className="text-s-red text-sm mb-3">{csvError}</p>}
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {tab === 'statement' && statement.data && <Statement data={statement.data} />}
        {tab === 'brands' && brands.data && <BrandTable data={brands.data} />}
      </div>
    </div>
  )
}
