'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

function fmt(cents: number) { return `PKR ${Math.round(cents / 100).toLocaleString()}` }

interface SalesData {
  totals: { gross: number; net: number; tax: number; orders: number }
  byHour?: Record<string, { orders: number; gross: number }>
}
interface TopItem   { menuItemId: string; name: string; quantity: number; revenueCents: number }
interface ByStation { stationId: string; stationName: string; avgMinutes: number; items: number }
interface BySource  { source: string; orders: number; gross: number; net: number }

type Tab = 'sales' | 'items' | 'stations' | 'channel'
const TAB_LABELS: Record<Tab, string> = { sales: 'Sales', items: 'Top Items', stations: 'By Station', channel: 'By Channel' }

const PRESETS = [
  { label: 'Today',   days: 0 },
  { label: 'Yesterday', days: 1 },
  { label: 'Week',    days: 7 },
  { label: 'Month',   days: 30 },
  { label: '90 days', days: 90 },
]

function buildRange(days: number) {
  const to = new Date()
  const from = new Date()
  if (days === 0) { from.setHours(0, 0, 0, 0) }
  else if (days === 1) { from.setDate(from.getDate() - 1); from.setHours(0, 0, 0, 0); to.setDate(to.getDate() - 1); to.setHours(23, 59, 59, 999) }
  else { from.setDate(from.getDate() - days) }
  return { from: from.toISOString().split('T')[0]!, to: to.toISOString().split('T')[0]! }
}

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('sales')
  const [preset, setPreset] = useState<number | null>(7)
  const [dateFrom, setDateFrom] = useState(() => buildRange(7).from)
  const [dateTo,   setDateTo]   = useState(() => buildRange(7).to)

  function applyPreset(days: number) {
    setPreset(days)
    const r = buildRange(days)
    setDateFrom(r.from); setDateTo(r.to)
  }

  const fromISO = `${dateFrom}T00:00:00Z`
  const toISO   = `${dateTo}T23:59:59Z`

  const { data: sales,    isLoading: salesLoading }    = useQuery<SalesData>({
    queryKey: ['reports', 'sales',    fromISO, toISO],
    queryFn: () => api.get<SalesData>(`/reports/sales?dateFrom=${fromISO}&dateTo=${toISO}`),
    enabled: tab === 'sales',
  })
  const { data: topItems, isLoading: itemsLoading }    = useQuery<TopItem[]>({
    queryKey: ['reports', 'top-items', fromISO, toISO],
    queryFn: () => api.get<TopItem[]>(`/reports/top-items?dateFrom=${fromISO}&dateTo=${toISO}&limit=20`),
    enabled: tab === 'items',
  })
  const { data: stations, isLoading: stationsLoading } = useQuery<ByStation[]>({
    queryKey: ['reports', 'stations', fromISO, toISO],
    queryFn: () => api.get<ByStation[]>(`/reports/stations?dateFrom=${fromISO}&dateTo=${toISO}`),
    enabled: tab === 'stations',
  })
  const { data: channels, isLoading: channelsLoading } = useQuery<BySource[]>({
    queryKey: ['reports', 'channels', fromISO, toISO],
    queryFn: () => api.get<BySource[]>(`/reports/by-source?dateFrom=${fromISO}&dateTo=${toISO}`),
    enabled: tab === 'channel',
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs text-s-muted">Finance</p>
            <h1 className="text-xl font-bold text-s-text">Reports</h1>
          </div>
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
            <input type="date" value={dateFrom} onChange={(e) => { setPreset(null); setDateFrom(e.target.value) }}
              className="s-input text-sm h-8 w-36" />
            <span className="text-s-dim text-xs">→</span>
            <input type="date" value={dateTo} onChange={(e) => { setPreset(null); setDateTo(e.target.value) }}
              className="s-input text-sm h-8 w-36" />
          </div>
        </div>

        <div className="flex gap-1 mt-3 -mb-px">
          {(Object.keys(TAB_LABELS) as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? 'border-s-teal text-s-teal' : 'border-transparent text-s-muted hover:text-s-text'
              }`}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </header>

      <div className="p-6 space-y-5 max-w-5xl">

        {/* ── Sales ─────────────────────────────────────────────────────────── */}
        {tab === 'sales' && (salesLoading ? <Skeleton /> : sales ? (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Gross Revenue', value: fmt(sales.totals.gross), color: 'text-gradient-brand', sub: undefined },
                { label: 'Net Revenue',   value: fmt(sales.totals.net),   color: 'text-s-teal',         sub: sales.totals.gross > 0 ? `${((sales.totals.net / sales.totals.gross) * 100).toFixed(1)}% margin` : undefined },
                { label: 'Tax Collected', value: fmt(sales.totals.tax),   color: 'text-s-amber',        sub: undefined },
                { label: 'Total Orders',  value: String(sales.totals.orders), color: 'text-s-text',     sub: sales.totals.orders > 0 ? `avg ${fmt(Math.round(sales.totals.gross / sales.totals.orders))}` : undefined },
              ].map((s) => (
                <div key={s.label} className="metric-card">
                  <p className="metric-label">{s.label}</p>
                  <p className={`metric-value ${s.color}`}>{s.value}</p>
                  {s.sub && <p className="text-[11px] text-s-dim mt-1">{s.sub}</p>}
                </div>
              ))}
            </div>

            {sales.byHour && Object.keys(sales.byHour).length > 0 && (
              <div className="s-card p-5">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-4">Orders by Hour</p>
                <div className="flex items-end gap-1 h-28">
                  {Object.entries(sales.byHour).sort((a, b) => Number(a[0]) - Number(b[0])).map(([hour, data]) => {
                    const max = Math.max(...Object.values(sales.byHour!).map((d) => d.orders))
                    const pct = max > 0 ? (data.orders / max) * 100 : 0
                    return (
                      <div key={hour} className="flex-1 flex flex-col items-center gap-1"
                        title={`${hour}:00 — ${data.orders} orders`}>
                        <div className="w-full rounded-t bg-s-teal/50 hover:bg-s-teal transition-colors cursor-default"
                          style={{ height: `${Math.max(pct, 3)}%` }} />
                        <span className="text-[9px] text-s-dim">{hour}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        ) : <Empty />)}

        {/* ── Top Items ─────────────────────────────────────────────────────── */}
        {tab === 'items' && (itemsLoading ? <Skeleton /> : (
          <div className="space-y-2 max-w-2xl">
            {(topItems ?? []).length === 0 ? <Empty /> : (
              <>
                <p className="text-xs text-s-muted mb-3">Top {topItems?.length} items by quantity sold</p>
                {(topItems ?? []).map((item, i) => {
                  const max = topItems?.[0]?.quantity ?? 1
                  const pct = (item.quantity / max) * 100
                  return (
                    <div key={item.menuItemId} className="s-card px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-s-dim w-5">#{i + 1}</span>
                          <span className="text-sm font-semibold text-s-text">{item.name}</span>
                        </div>
                        <div className="flex items-center gap-4 text-xs shrink-0">
                          <span className="text-s-muted">{item.quantity} sold</span>
                          <span className="font-bold text-s-teal">{fmt(item.revenueCents)}</span>
                        </div>
                      </div>
                      <div className="stat-bar-track h-1.5">
                        <div className="stat-bar-fill h-1.5 bg-s-teal/70" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </>
            )}
          </div>
        ))}

        {/* ── By Station ────────────────────────────────────────────────────── */}
        {tab === 'stations' && (stationsLoading ? <Skeleton /> : (
          (stations ?? []).length === 0 ? <Empty /> : (
            <div className="s-card overflow-hidden max-w-xl">
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      <th>Station</th>
                      <th className="text-right">Items Fired</th>
                      <th className="text-right">Avg Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stations ?? []).map((s) => (
                      <tr key={s.stationId}>
                        <td className="font-semibold text-s-text">{s.stationName}</td>
                        <td className="text-right text-s-muted">{s.items}</td>
                        <td className="text-right">
                          <span className={`font-bold ${s.avgMinutes > 15 ? 'text-s-red' : s.avgMinutes > 10 ? 'text-s-amber' : 'text-s-teal'}`}>
                            {s.avgMinutes.toFixed(1)}m
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ))}

        {/* ── By Channel ────────────────────────────────────────────────────── */}
        {tab === 'channel' && (channelsLoading ? <Skeleton /> : (
          (channels ?? []).length === 0 ? <Empty /> : (
            <div className="s-card overflow-hidden max-w-xl">
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th className="text-right">Orders</th>
                      <th className="text-right">Gross</th>
                      <th className="text-right">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(channels ?? []).sort((a, b) => b.gross - a.gross).map((c) => (
                      <tr key={c.source}>
                        <td>
                          <span className="s-badge s-badge-muted text-[10px] uppercase">{c.source}</span>
                        </td>
                        <td className="text-right text-s-muted">{c.orders}</td>
                        <td className="text-right text-s-text">{fmt(c.gross)}</td>
                        <td className="text-right font-bold text-s-teal">{fmt(c.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        ))}

      </div>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-20 rounded-xl" />)}
      </div>
      <div className="skeleton h-40 rounded-xl" />
    </div>
  )
}

function Empty() {
  return (
    <div className="text-center py-16 text-s-dim">
      <p className="text-3xl mb-2">📊</p>
      <p>No data for this period</p>
    </div>
  )
}
