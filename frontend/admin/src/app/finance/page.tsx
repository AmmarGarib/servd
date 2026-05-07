'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

function fmt(cents: number) { return `PKR ${Math.round(cents / 100).toLocaleString()}` }

interface PLData {
  byConcept: Record<string, { conceptName: string; gross: number; commission: number; discount: number; tax: number; net: number; orders: number }>
  totals: { gross: number; commission: number; discount: number; tax: number; net: number; orders: number }
}

interface FinancialEntry {
  id: string; grossCents: number; netCents: number; taxCents: number; commissionCents: number
  channel: string; createdAt: string
  concept: { name: string }
  order: { id: string; customerName: string | null }
}

type Tab = 'summary' | 'by-concept' | 'transactions'

const PRESETS = [
  { label: 'Today',      days: 0 },
  { label: 'Yesterday',  days: 1 },
  { label: 'This week',  days: 7 },
  { label: 'This month', days: 30 },
  { label: 'Last 90d',   days: 90 },
]

function dateRange(days: number): { from: string; to: string } {
  const to = new Date()
  const from = new Date()
  if (days === 0) {
    from.setHours(0, 0, 0, 0)
  } else if (days === 1) {
    from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0)
    to.setDate(to.getDate() - 1); to.setHours(23, 59, 59, 999)
  } else {
    from.setDate(from.getDate() - days)
  }
  return { from: from.toISOString().split('T')[0]!, to: to.toISOString().split('T')[0]! }
}

const TAB_LABELS: Record<Tab, string> = {
  summary: 'P&L Summary',
  'by-concept': 'By Concept',
  transactions: 'Transactions',
}

export default function FinancePage() {
  const [tab, setTab] = useState<Tab>('summary')
  const [preset, setPreset] = useState<number | null>(30)
  const [dateFrom, setDateFrom] = useState(() => dateRange(30).from)
  const [dateTo, setDateTo]     = useState(() => dateRange(30).to)

  function applyPreset(days: number) {
    setPreset(days)
    const r = dateRange(days)
    setDateFrom(r.from); setDateTo(r.to)
  }
  function handleCustomDate(field: 'from' | 'to', val: string) {
    setPreset(null)
    if (field === 'from') setDateFrom(val)
    else setDateTo(val)
  }

  const fromISO = `${dateFrom}T00:00:00Z`
  const toISO   = `${dateTo}T23:59:59Z`

  const { data: pl, isLoading: plLoading } = useQuery<PLData>({
    queryKey: ['pl', fromISO, toISO],
    queryFn: () => api.get<PLData>(`/accounting/pl?dateFrom=${fromISO}&dateTo=${toISO}`),
    enabled: tab !== 'transactions',
  })

  const { data: entries, isLoading: entriesLoading } = useQuery<FinancialEntry[]>({
    queryKey: ['financial-entries', fromISO, toISO],
    queryFn: () => api.get<FinancialEntry[]>(`/accounting/entries?dateFrom=${fromISO}&dateTo=${toISO}&limit=100`),
    enabled: tab === 'transactions',
  })

  return (
    <div className="min-h-screen bg-s-bg">
      {/* Header */}
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-s-muted">Finance</p>
            <h1 className="text-xl font-bold text-s-text">P&L Statement</h1>
          </div>
          {/* Date controls */}
          <div className="flex items-center gap-2 flex-wrap">
            {PRESETS.map((p) => (
              <button key={p.days} onClick={() => applyPreset(p.days)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  preset === p.days
                    ? 'bg-s-teal-dim border border-s-teal/40 text-s-teal'
                    : 'bg-s-surface border border-s-border text-s-muted hover:text-s-text'
                }`}>
                {p.label}
              </button>
            ))}
            <input type="date" value={dateFrom} onChange={(e) => handleCustomDate('from', e.target.value)}
              className="s-input text-sm h-8 w-36" />
            <span className="text-s-dim text-xs">→</span>
            <input type="date" value={dateTo} onChange={(e) => handleCustomDate('to', e.target.value)}
              className="s-input text-sm h-8 w-36" />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mt-3 -mb-px">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t
                  ? 'border-s-teal text-s-teal'
                  : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-6xl">

        {/* ── P&L Summary ───────────────────────────────────────────────────── */}
        {tab === 'summary' && (
          plLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-24 rounded-xl" />)}
            </div>
          ) : pl ? (
            <div className="space-y-5">
              {/* KPI row */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[
                  { label: 'Gross Revenue',        value: fmt(pl.totals.gross),      color: 'text-gradient-brand', sub: `${pl.totals.orders} orders` },
                  { label: 'Platform Commissions', value: fmt(pl.totals.commission), color: 'text-s-red',          sub: pl.totals.gross > 0 ? `${((pl.totals.commission / pl.totals.gross) * 100).toFixed(1)}% of gross` : '—' },
                  { label: 'GST / Tax',            value: fmt(pl.totals.tax),        color: 'text-s-amber',        sub: pl.totals.gross > 0 ? `${((pl.totals.tax / pl.totals.gross) * 100).toFixed(1)}% of gross` : '—' },
                  { label: 'Net Revenue',          value: fmt(pl.totals.net),        color: 'text-s-teal',         sub: pl.totals.gross > 0 ? `${((pl.totals.net / pl.totals.gross) * 100).toFixed(1)}% margin` : '—' },
                ].map((s) => (
                  <div key={s.label} className="metric-card">
                    <p className="metric-label">{s.label}</p>
                    <p className={`metric-value ${s.color}`}>{s.value}</p>
                    <p className="text-[11px] text-s-dim mt-1">{s.sub}</p>
                  </div>
                ))}
              </div>

              {/* Revenue by concept bars */}
              <div className="s-card p-5">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-4">Revenue by Concept</p>
                <div className="space-y-4">
                  {Object.values(pl.byConcept)
                    .sort((a, b) => b.gross - a.gross)
                    .map((c) => {
                      const pct = pl.totals.gross > 0 ? (c.gross / pl.totals.gross) * 100 : 0
                      const netPct = c.gross > 0 ? (c.net / c.gross) * 100 : 0
                      return (
                        <div key={c.conceptName}>
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-sm font-medium text-s-text">{c.conceptName}</span>
                            <div className="flex items-center gap-4">
                              <span className="text-xs text-s-muted">{c.orders} orders</span>
                              <span className="text-xs text-s-dim">Net margin: <span className="text-s-teal font-semibold">{netPct.toFixed(1)}%</span></span>
                              <span className="text-sm font-bold text-s-teal">{fmt(c.net)}</span>
                            </div>
                          </div>
                          <div className="stat-bar-track h-2">
                            <div className="stat-bar-fill h-2 bg-s-teal" style={{ width: `${pct}%` }} />
                          </div>
                          <div className="flex justify-between text-[10px] text-s-dim mt-0.5">
                            <span>Gross: {fmt(c.gross)}</span>
                            <span>{pct.toFixed(1)}% of total</span>
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>

              {/* P&L waterfall summary */}
              <div className="s-card p-5">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-4">P&L Waterfall</p>
                <div className="space-y-2 text-sm max-w-sm">
                  {[
                    { label: 'Gross Revenue',    value: pl.totals.gross,      sign: '',  color: 'text-s-text' },
                    { label: 'Less: Commission', value: pl.totals.commission, sign: '−', color: 'text-s-red' },
                    { label: 'Less: Discounts',  value: pl.totals.discount,   sign: '−', color: 'text-s-amber' },
                    { label: 'Less: Tax (GST)',  value: pl.totals.tax,        sign: '−', color: 'text-s-muted' },
                  ].map((row) => (
                    <div key={row.label} className="flex justify-between py-1.5 border-b border-s-border/50">
                      <span className="text-s-muted">{row.label}</span>
                      <span className={row.color}>{row.sign}{fmt(row.value)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between py-2 pt-3">
                    <span className="font-bold text-s-text">Net Revenue</span>
                    <span className="font-black text-s-teal text-base">{fmt(pl.totals.net)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="s-card p-12 text-center text-s-dim">No data for this period</div>
          )
        )}

        {/* ── By Concept Table ──────────────────────────────────────────────── */}
        {tab === 'by-concept' && (
          plLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : pl ? (
            <div className="s-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      {['Concept', 'Orders', 'Gross', 'Commission', 'Discount', 'Tax', 'Net', 'Margin'].map((h) => (
                        <th key={h} className={h !== 'Concept' ? 'text-right' : ''}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.values(pl.byConcept).map((c) => {
                      const marginPct = c.gross > 0 ? ((c.net / c.gross) * 100).toFixed(1) : '—'
                      return (
                        <tr key={c.conceptName}>
                          <td className="font-semibold text-s-text">{c.conceptName}</td>
                          <td className="text-right text-s-muted">{c.orders}</td>
                          <td className="text-right text-s-text">{fmt(c.gross)}</td>
                          <td className="text-right text-s-red">{c.commission > 0 ? `−${fmt(c.commission)}` : '—'}</td>
                          <td className="text-right text-s-amber">{c.discount > 0 ? `−${fmt(c.discount)}` : '—'}</td>
                          <td className="text-right text-s-muted">{fmt(c.tax)}</td>
                          <td className="text-right font-bold text-s-teal">{fmt(c.net)}</td>
                          <td className="text-right font-semibold text-s-teal">{marginPct}%</td>
                        </tr>
                      )
                    })}
                    <tr className="border-t-2 border-s-border bg-s-elevated font-bold">
                      <td className="text-s-text">Total</td>
                      <td className="text-right text-s-text">{pl.totals.orders}</td>
                      <td className="text-right text-s-text">{fmt(pl.totals.gross)}</td>
                      <td className="text-right text-s-red">{pl.totals.commission > 0 ? `−${fmt(pl.totals.commission)}` : '—'}</td>
                      <td className="text-right text-s-amber">{pl.totals.discount > 0 ? `−${fmt(pl.totals.discount)}` : '—'}</td>
                      <td className="text-right text-s-muted">{fmt(pl.totals.tax)}</td>
                      <td className="text-right text-s-teal">{fmt(pl.totals.net)}</td>
                      <td className="text-right text-s-teal">
                        {pl.totals.gross > 0 ? `${((pl.totals.net / pl.totals.gross) * 100).toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="s-card p-12 text-center text-s-dim">No data for this period</div>
          )
        )}

        {/* ── Transactions ──────────────────────────────────────────────────── */}
        {tab === 'transactions' && (
          entriesLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : (
            <div className="s-card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Concept</th>
                      <th>Channel</th>
                      <th className="text-right">Gross</th>
                      <th className="text-right">Commission</th>
                      <th className="text-right">Tax</th>
                      <th className="text-right">Net</th>
                      <th className="text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(entries ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={8} className="text-center text-s-dim py-10">
                          No transactions in this period
                        </td>
                      </tr>
                    ) : (entries ?? []).map((e) => (
                      <tr key={e.id}>
                        <td className="font-mono text-xs text-s-dim">#{e.order.id.slice(-6).toUpperCase()}</td>
                        <td className="text-s-text text-sm">{e.concept.name}</td>
                        <td>
                          <span className="s-badge s-badge-muted text-[10px] uppercase">{e.channel}</span>
                        </td>
                        <td className="text-right text-s-text">{fmt(e.grossCents)}</td>
                        <td className="text-right text-s-red">{e.commissionCents > 0 ? `−${fmt(e.commissionCents)}` : '—'}</td>
                        <td className="text-right text-s-muted">{fmt(e.taxCents)}</td>
                        <td className="text-right font-bold text-s-teal">{fmt(e.netCents)}</td>
                        <td className="text-right text-xs text-s-dim">
                          {new Date(e.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        )}

      </div>
    </div>
  )
}
