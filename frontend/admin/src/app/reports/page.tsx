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

// Shift a date range back by `periodDays` days to produce a comparison window
function buildPrevRange(dateFrom: string, dateTo: string) {
  const fromD = new Date(dateFrom)
  const toD   = new Date(dateTo)
  const diffMs = toD.getTime() - fromD.getTime()
  const diffDays = Math.round(diffMs / 86_400_000) + 1
  const prevTo   = new Date(fromD.getTime() - 86_400_000)
  const prevFrom = new Date(prevTo.getTime() - (diffDays - 1) * 86_400_000)
  return {
    from: prevFrom.toISOString().split('T')[0]!,
    to:   prevTo.toISOString().split('T')[0]!,
  }
}

function exportToCsv(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return
  const headers = Object.keys(rows[0]!)
  const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const csv = [headers.map(escape).join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

// ─── Delta helpers ─────────────────────────────────────────────────────────────

interface DeltaResult { pct: number; dir: 'up' | 'down' | 'flat' }

function computeDelta(curr: number, prev: number): DeltaResult | null {
  if (prev === 0) return null
  const pct = ((curr - prev) / prev) * 100
  return { pct: Math.abs(pct), dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' }
}

function DeltaBadge({ delta, invert = false }: { delta: DeltaResult | null; invert?: boolean }) {
  if (!delta || delta.dir === 'flat') {
    return <span className="text-xs text-s-muted">=</span>
  }
  // invert = for metrics where "more" is bad (e.g. avg cook time)
  const positive = invert ? delta.dir === 'down' : delta.dir === 'up'
  const color = positive ? 'text-s-teal' : 'text-s-red'
  const arrow = delta.dir === 'up' ? '↑' : '↓'
  return (
    <span className={`text-xs font-semibold ${color}`}>
      {arrow}{delta.pct.toFixed(1)}%
    </span>
  )
}

function RankDelta({ curr, prev }: { curr: number; prev: number | null }) {
  if (prev === null) return <span className="text-xs font-bold text-s-teal">NEW</span>
  const diff = prev - curr  // lower rank number = better; if prev > curr, rank improved
  if (diff === 0) return <span className="text-xs text-s-muted">=</span>
  const color = diff > 0 ? 'text-s-teal' : 'text-s-red'
  const arrow = diff > 0 ? '↑' : '↓'
  return <span className={`text-xs font-bold ${color}`}>{arrow}{Math.abs(diff)}</span>
}

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('sales')
  const [preset, setPreset] = useState<number | null>(7)
  const [dateFrom, setDateFrom] = useState(() => buildRange(7).from)
  const [dateTo,   setDateTo]   = useState(() => buildRange(7).to)
  const [compare, setCompare]   = useState(false)

  function applyPreset(days: number) {
    setPreset(days)
    const r = buildRange(days)
    setDateFrom(r.from); setDateTo(r.to)
  }

  const fromISO = `${dateFrom}T00:00:00Z`
  const toISO   = `${dateTo}T23:59:59Z`

  // Compute previous period dates
  const prevRange = buildPrevRange(dateFrom, dateTo)
  const prevFromISO = `${prevRange.from}T00:00:00Z`
  const prevToISO   = `${prevRange.to}T23:59:59Z`

  // ── Current period queries ──────────────────────────────────────────────────
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

  // ── Previous period queries (only when compare is on) ──────────────────────
  const { data: prevSales }    = useQuery<SalesData>({
    queryKey: ['reports', 'sales',     prevFromISO, prevToISO],
    queryFn: () => api.get<SalesData>(`/reports/sales?dateFrom=${prevFromISO}&dateTo=${prevToISO}`),
    enabled: tab === 'sales' && compare,
  })
  const { data: prevTopItems } = useQuery<TopItem[]>({
    queryKey: ['reports', 'top-items', prevFromISO, prevToISO],
    queryFn: () => api.get<TopItem[]>(`/reports/top-items?dateFrom=${prevFromISO}&dateTo=${prevToISO}&limit=20`),
    enabled: tab === 'items' && compare,
  })
  const { data: prevStations } = useQuery<ByStation[]>({
    queryKey: ['reports', 'stations',  prevFromISO, prevToISO],
    queryFn: () => api.get<ByStation[]>(`/reports/stations?dateFrom=${prevFromISO}&dateTo=${prevToISO}`),
    enabled: tab === 'stations' && compare,
  })
  const { data: prevChannels } = useQuery<BySource[]>({
    queryKey: ['reports', 'channels',  prevFromISO, prevToISO],
    queryFn: () => api.get<BySource[]>(`/reports/by-source?dateFrom=${prevFromISO}&dateTo=${prevToISO}`),
    enabled: tab === 'channel' && compare,
  })

  const slug = `${dateFrom}_${dateTo}`

  // Build hourly chart data combining curr + prev
  function buildHourlyRows() {
    const curr = sales?.byHour ?? {}
    const prev = prevSales?.byHour ?? {}
    const allHours = new Set([...Object.keys(curr), ...Object.keys(prev)].map(Number))
    return Array.from(allHours).sort((a, b) => a - b).map((h) => ({
      hour: h,
      curr: curr[String(h)]?.orders ?? 0,
      prev: prev[String(h)]?.orders ?? 0,
    }))
  }

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

            {/* Compare toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none ml-1">
              <div
                onClick={() => setCompare((v) => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors ${compare ? 'bg-s-teal' : 'bg-s-border'}`}>
                <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${compare ? 'translate-x-4' : ''}`} />
              </div>
              <span className="text-xs text-s-muted whitespace-nowrap">Compare to prev period</span>
            </label>
          </div>
        </div>

        {/* Previous period label (shown when compare on) */}
        {compare && (
          <p className="text-xs text-s-muted mt-2">
            Comparing against <span className="text-s-text font-medium">{prevRange.from} → {prevRange.to}</span>
          </p>
        )}

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

      <div className="p-6 space-y-5 max-w-5xl mx-auto">

        {/* ── Sales ─────────────────────────────────────────────────────────── */}
        {tab === 'sales' && (salesLoading ? <Skeleton /> : sales ? (
          <div className="space-y-5">
            <div className="flex justify-end">
              <button
                onClick={() => {
                  const rows: Record<string, unknown>[] = [
                    { metric: 'Sales incl. GST (register)', value: Math.round(sales.totals.gross / 100) },
                    { metric: 'Register net (sales − discounts)', value: Math.round(sales.totals.net / 100) },
                    { metric: 'Tax on these orders (register)', value: Math.round(sales.totals.tax / 100) },
                    { metric: 'Total Orders', value: sales.totals.orders },
                  ]
                  exportToCsv(rows, `sales_${slug}.csv`)
                }}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-s-surface border border-s-border text-s-muted hover:text-s-teal hover:border-s-teal/40 transition-colors">
                Export CSV
              </button>
            </div>

            {/* KPI cards with delta arrows */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                {
                  // Sales-register figures: what customers paid, incl. GST
                  // and service charge. The books' revenue is the ledger P&L.
                  label: 'Sales (incl. GST)',
                  value: fmt(sales.totals.gross),
                  color: 'text-gradient-brand',
                  sub: 'sales register — not the P&L',
                  delta: compare && prevSales ? computeDelta(sales.totals.gross, prevSales.totals.gross) : null,
                },
                {
                  label: 'Register net',
                  value: fmt(sales.totals.net),
                  color: 'text-s-teal',
                  sub: 'register: sales − discounts',
                  delta: compare && prevSales ? computeDelta(sales.totals.net, prevSales.totals.net) : null,
                },
                {
                  label: 'Tax on orders',
                  value: fmt(sales.totals.tax),
                  color: 'text-s-amber',
                  sub: 'register — the filed figure is the tax return',
                  delta: compare && prevSales ? computeDelta(sales.totals.tax, prevSales.totals.tax) : null,
                },
                {
                  label: 'Total Orders',
                  value: String(sales.totals.orders),
                  color: 'text-s-text',
                  sub: sales.totals.orders > 0 ? `avg ${fmt(Math.round(sales.totals.gross / sales.totals.orders))}` : undefined,
                  delta: compare && prevSales ? computeDelta(sales.totals.orders, prevSales.totals.orders) : null,
                },
              ].map((s) => (
                <div key={s.label} className="metric-card">
                  <p className="metric-label">{s.label}</p>
                  <p className={`metric-value ${s.color}`}>{s.value}</p>
                  {s.sub && <p className="text-[11px] text-s-dim mt-1">{s.sub}</p>}
                  {s.delta && (
                    <div className="flex items-center gap-1 mt-1.5">
                      <DeltaBadge delta={s.delta} />
                      <span className="text-[10px] text-s-dim">vs prev</span>
                    </div>
                  )}
                  {compare && prevSales && !s.delta && s.delta !== null && (
                    <p className="text-[10px] text-s-dim mt-1">no prev data</p>
                  )}
                </div>
              ))}
            </div>

            {/* Hourly chart — grouped bars when compare is on */}
            {sales.byHour && Object.keys(sales.byHour).length > 0 && (
              <div className="s-card p-5">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Orders by Hour</p>
                  {compare && (
                    <div className="flex items-center gap-3 text-[10px] text-s-muted">
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded-sm bg-s-teal/70" /> This period</span>
                      <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded-sm bg-s-muted/40" /> Prev period</span>
                    </div>
                  )}
                </div>

                {compare ? (
                  // Grouped bars
                  <div className="flex items-end gap-1 h-28">
                    {buildHourlyRows().map(({ hour, curr, prev: prevOrders }) => {
                      const maxVal = Math.max(...buildHourlyRows().flatMap(r => [r.curr, r.prev]), 1)
                      const currPct = (curr / maxVal) * 100
                      const prevPct = (prevOrders / maxVal) * 100
                      return (
                        <div key={hour} className="flex-1 flex flex-col items-center gap-1"
                          title={`${hour}:00 — current: ${curr} orders, prev: ${prevOrders} orders`}>
                          <div className="w-full flex items-end gap-px">
                            <div className="flex-1 rounded-t bg-s-teal/70 hover:bg-s-teal transition-colors cursor-default"
                              style={{ height: `${Math.max(currPct, curr > 0 ? 4 : 0)}%`, minHeight: curr > 0 ? '3px' : '0' }} />
                            <div className="flex-1 rounded-t bg-s-muted/40 hover:bg-s-muted/60 transition-colors cursor-default"
                              style={{ height: `${Math.max(prevPct, prevOrders > 0 ? 4 : 0)}%`, minHeight: prevOrders > 0 ? '3px' : '0' }} />
                          </div>
                          <span className="text-[9px] text-s-dim">{hour}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  // Single bars (original)
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
                )}
              </div>
            )}
          </div>
        ) : <Empty />)}

        {/* ── Top Items ─────────────────────────────────────────────────────── */}
        {tab === 'items' && (itemsLoading ? <Skeleton /> : (
          <div className="space-y-2 max-w-2xl">
            {(topItems ?? []).length === 0 ? <Empty /> : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-s-muted">Top {topItems?.length} items by quantity sold</p>
                  <button
                    onClick={() => {
                      const rows = (topItems ?? []).map((item, i) => ({
                        rank: i + 1,
                        name: item.name,
                        quantity: item.quantity,
                        revenue_pkr: Math.round(item.revenueCents / 100),
                      }))
                      exportToCsv(rows as Record<string, unknown>[], `top-items_${slug}.csv`)
                    }}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-s-surface border border-s-border text-s-muted hover:text-s-teal hover:border-s-teal/40 transition-colors">
                    Export CSV
                  </button>
                </div>

                {/* Build previous-period rank map for comparison */}
                {(() => {
                  const prevRankMap = new Map<string, { rank: number; revenue: number }>()
                  if (compare && prevTopItems) {
                    prevTopItems.forEach((item, i) => {
                      prevRankMap.set(item.menuItemId, { rank: i + 1, revenue: item.revenueCents })
                    })
                  }
                  return (topItems ?? []).map((item, i) => {
                    const max = topItems?.[0]?.quantity ?? 1
                    const pct = (item.quantity / max) * 100
                    const prevEntry = prevRankMap.get(item.menuItemId) ?? null
                    return (
                      <div key={item.menuItemId} className="s-card px-4 py-3">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-s-dim w-5">#{i + 1}</span>
                            <span className="text-sm font-semibold text-s-text">{item.name}</span>
                            {compare && (
                              <RankDelta curr={i + 1} prev={prevEntry?.rank ?? null} />
                            )}
                          </div>
                          <div className="flex items-center gap-4 text-xs shrink-0">
                            <span className="text-s-muted">{item.quantity} sold</span>
                            <span className="font-bold text-s-teal">{fmt(item.revenueCents)}</span>
                            {compare && prevEntry && (
                              <span className="text-s-dim">{fmt(prevEntry.revenue)} prev</span>
                            )}
                          </div>
                        </div>
                        <div className="stat-bar-track h-1.5">
                          <div className="stat-bar-fill h-1.5 bg-s-teal/70" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })
                })()}
              </>
            )}
          </div>
        ))}

        {/* ── By Station ────────────────────────────────────────────────────── */}
        {tab === 'stations' && (stationsLoading ? <Skeleton /> : (
          (stations ?? []).length === 0 ? <Empty /> : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    const rows = (stations ?? []).map(s => ({
                      station: s.stationName,
                      items_fired: s.items,
                      avg_minutes: s.avgMinutes.toFixed(1),
                    }))
                    exportToCsv(rows as Record<string, unknown>[], `stations_${slug}.csv`)
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-s-surface border border-s-border text-s-muted hover:text-s-teal hover:border-s-teal/40 transition-colors">
                  Export CSV
                </button>
              </div>
              <div className="s-card overflow-hidden max-w-xl">
                <div className="overflow-x-auto">
                  <table className="s-table w-full">
                    <thead>
                      <tr>
                        <th>Station</th>
                        <th className="text-right">Items Fired</th>
                        <th className="text-right">Avg Time</th>
                        {compare && <th className="text-right">vs Prev</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const prevMap = new Map<string, ByStation>()
                        if (compare && prevStations) {
                          prevStations.forEach((s) => prevMap.set(s.stationId, s))
                        }
                        return (stations ?? []).map((s) => {
                          const prev = prevMap.get(s.stationId)
                          const delta = compare && prev ? computeDelta(s.avgMinutes, prev.avgMinutes) : null
                          return (
                            <tr key={s.stationId}>
                              <td className="font-semibold text-s-text">{s.stationName}</td>
                              <td className="text-right text-s-muted">{s.items}</td>
                              <td className="text-right">
                                <span className={`font-bold ${s.avgMinutes > 15 ? 'text-s-red' : s.avgMinutes > 10 ? 'text-s-amber' : 'text-s-teal'}`}>
                                  {s.avgMinutes.toFixed(1)}m
                                </span>
                              </td>
                              {compare && (
                                <td className="text-right">
                                  {prev ? <DeltaBadge delta={delta} invert /> : <span className="text-xs text-s-dim">—</span>}
                                </td>
                              )}
                            </tr>
                          )
                        })
                      })()}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        ))}

        {/* ── By Channel ────────────────────────────────────────────────────── */}
        {tab === 'channel' && (channelsLoading ? <Skeleton /> : (
          (channels ?? []).length === 0 ? <Empty /> : (
            <div className="space-y-3">
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    const rows = [...(channels ?? [])].sort((a, b) => b.gross - a.gross).map(c => ({
                      channel: c.source,
                      orders: c.orders,
                      gross_pkr: Math.round(c.gross / 100),
                      net_pkr: Math.round(c.net / 100),
                    }))
                    exportToCsv(rows as Record<string, unknown>[], `by-channel_${slug}.csv`)
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-s-surface border border-s-border text-s-muted hover:text-s-teal hover:border-s-teal/40 transition-colors">
                  Export CSV
                </button>
              </div>
              <div className="s-card overflow-hidden max-w-xl">
                <div className="overflow-x-auto">
                  <table className="s-table w-full">
                    <thead>
                      <tr>
                        <th>Channel</th>
                        <th className="text-right">Orders</th>
                        <th className="text-right">Sales (incl. GST)</th>
                        <th className="text-right">Register net</th>
                        {compare && <th className="text-right">vs Prev</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const prevMap = new Map<string, BySource>()
                        if (compare && prevChannels) {
                          prevChannels.forEach((c) => prevMap.set(c.source, c))
                        }
                        return [...(channels ?? [])].sort((a, b) => b.gross - a.gross).map((c) => {
                          const prev = prevMap.get(c.source)
                          const delta = compare && prev ? computeDelta(c.gross, prev.gross) : null
                          return (
                            <tr key={c.source}>
                              <td>
                                <span className="s-badge s-badge-muted text-[10px] uppercase">{c.source}</span>
                              </td>
                              <td className="text-right text-s-muted">{c.orders}</td>
                              <td className="text-right text-s-text">{fmt(c.gross)}</td>
                              <td className="text-right font-bold text-s-teal">{fmt(c.net)}</td>
                              {compare && (
                                <td className="text-right">
                                  {prev ? <DeltaBadge delta={delta} /> : <span className="text-xs text-s-dim">NEW</span>}
                                </td>
                              )}
                            </tr>
                          )
                        })
                      })()}
                    </tbody>
                  </table>
                </div>
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
