'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import Link from 'next/link'
import { useBrandFilter } from '../../../store/brandFilter'
import { fmtPkrShort, fmtPkrWhole } from '../../../lib/money'

interface Concept { id: string; name: string }
interface FoodCostData {
  period: { from: string; to: string }
  revenue: { grossCents: number; netCents: number }
  cost: {
    theoreticalCents: number
    actualPurchasesCents: number
    theoreticalFoodCostPct: number
    targetFoodCostPct: number
    variance: number
    status: 'good' | 'warning' | 'critical'
  }
  byItem: {
    menuItemId: string; name: string; qtySold: number
    costPerPortion: number; totalCost: number
    revenue: number; foodCostPct: number; marginPct: number
  }[]
  itemsWithoutRecipe: { menuItemId: string | null; name: string; qtySold: number }[]
}

const STATUS_STYLES = {
  good:     { badge: 's-badge-teal',  text: 'text-primary-ink',  bar: 'bg-s-teal',  label: 'On Target ✓' },
  warning:  { badge: 's-badge-amber', text: 'text-s-amber', bar: 'bg-s-amber', label: 'Watch ⚠' },
  critical: { badge: 's-badge-red',   text: 'text-s-red',   bar: 'bg-s-red',   label: 'Over Budget ✕' },
}

function toDateInput(d: Date) {
  return d.toISOString().split('T')[0]!
}

export default function FoodCostPage() {
  const today = new Date()
  const [dateFrom, setDateFrom] = useState(toDateInput(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [dateTo,   setDateTo]   = useState(toDateInput(today))
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [sortKey, setSortKey] = useState<'totalCost' | 'foodCostPct' | 'qtySold'>('totalCost')

  // Brand list from GET /concepts?view=picker (every staff role, the active
  // brands of its own companies, id + name) — plain /concepts is managers /
  // till only and 403'd for the roles that hold this page (R2-UI-04).
  // Shares the shell BrandPicker's cache key and shape.
  const { data: concepts } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })

  const qs = new URLSearchParams({
    dateFrom: `${dateFrom}T00:00:00Z`,
    dateTo:   `${dateTo}T23:59:59Z`,
    ...(conceptId && { conceptId }),
  })

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['food-cost', dateFrom, dateTo, conceptId],
    queryFn: () => api.get<FoodCostData>(`/recipes/food-cost?${qs}`),
  })

  const fc = data?.cost
  const styles = fc ? STATUS_STYLES[fc.status] : null
  const sorted = [...(data?.byItem ?? [])].sort((a, b) => b[sortKey] - a[sortKey])

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-s-muted">Accounting</p>
            <h1 className="text-xl font-bold text-s-text">Food Cost Analysis</h1>
          </div>
          <Link href="/accounting" className="text-xs text-primary-ink hover:underline">← Hub</Link>
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* ── Filters ───────────────────────────────────────────────────────── */}
        <section className="flex flex-wrap gap-3 items-end">
          <div className="space-y-1">
            <label className="text-[11px] text-s-muted uppercase tracking-wider">From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="s-input text-sm h-9 w-40" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-s-muted uppercase tracking-wider">To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="s-input text-sm h-9 w-40" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-s-muted uppercase tracking-wider">Concept</label>
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
              className="s-select text-sm h-9 w-44">
              <option value="">All Concepts</option>
              {concepts?.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {isFetching && (
            <span className="text-xs text-s-dim animate-pulse self-end mb-2">Refreshing…</span>
          )}
        </section>

        {/* ── Presets ───────────────────────────────────────────────────────── */}
        <div className="flex gap-2">
          {[
            { label: 'This Month', from: toDateInput(new Date(today.getFullYear(), today.getMonth(), 1)), to: toDateInput(today) },
            { label: 'Last Month', from: toDateInput(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: toDateInput(new Date(today.getFullYear(), today.getMonth(), 0)) },
            { label: 'Last 7d', from: toDateInput(new Date(Date.now() - 7 * 86_400_000)), to: toDateInput(today) },
            { label: 'Last 30d', from: toDateInput(new Date(Date.now() - 30 * 86_400_000)), to: toDateInput(today) },
          ].map((p) => (
            <button key={p.label}
              onClick={() => { setDateFrom(p.from); setDateTo(p.to) }}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
                dateFrom === p.from && dateTo === p.to
                  ? 'border-s-teal/40 bg-s-teal-dim text-primary-ink'
                  : 'border-s-border bg-s-surface text-s-muted hover:text-s-text'
              }`}>
              {p.label}
            </button>
          ))}
        </div>

        {/* ── Summary cards ─────────────────────────────────────────────────── */}
        {isLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton h-24 rounded-xl" />
            ))}
          </div>
        ) : fc ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className={`s-card p-4 border-l-2 ${styles?.bar.replace('bg-', 'border-')}`}>
                <p className="metric-label">Food Cost %</p>
                <p className={`text-3xl font-black tabular-nums ${styles?.text}`}>{fc.theoreticalFoodCostPct}%</p>
                <p className="text-[11px] text-s-dim mt-1">Target: {fc.targetFoodCostPct}%</p>
              </div>
              <div className="s-card p-4">
                <p className="metric-label">Variance</p>
                <p className={`text-3xl font-black tabular-nums ${fc.variance > 0 ? 'text-s-red' : 'text-primary-ink'}`}>
                  {fc.variance > 0 ? '+' : ''}{fc.variance}%
                </p>
                <span className={`s-badge ${styles?.badge} text-[10px] mt-1 inline-block`}>{styles?.label}</span>
              </div>
              <div className="s-card p-4">
                <p className="metric-label">Gross Revenue</p>
                <p className="text-xl font-black text-gradient-brand">{fmtPkrShort(data!.revenue.grossCents)}</p>
                <p className="text-[11px] text-s-dim mt-1">Net: {fmtPkrShort(data!.revenue.netCents)}</p>
              </div>
              <div className="s-card p-4">
                <p className="metric-label">Theoretical Cost</p>
                <p className="text-xl font-black text-s-text">{fmtPkrShort(fc.theoreticalCents)}</p>
                <p className="text-[11px] text-s-dim mt-1">Purchases: {fmtPkrShort(fc.actualPurchasesCents)}</p>
              </div>
            </div>

            {/* ── Visual breakdown bar ─────────────────────────────────────── */}
            <section className="s-card p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Food Cost Formula</p>
                <p className="text-xs text-s-dim font-mono">
                  {fmtPkrWhole(fc.theoreticalCents)} ÷ {fmtPkrShort(data!.revenue.grossCents)} × 100 = {fc.theoreticalFoodCostPct}%
                </p>
              </div>
              <div className="stat-bar-track h-4 relative mb-2">
                <div className="absolute top-0 bottom-0 w-0.5 bg-s-teal/60 z-10" style={{ left: '60%' }} />
                <div
                  className={`stat-bar-fill h-4 ${styles?.bar} transition-all duration-700`}
                  style={{ width: `${Math.min((fc.theoreticalFoodCostPct / 50) * 100, 100)}%` }}
                />
              </div>
              <div className="flex justify-between text-[11px] text-s-muted">
                <span>0%</span>
                <span className="text-primary-ink">30% target</span>
                <span>35%</span>
                <span>50%+</span>
              </div>
            </section>

            {/* ── By-item table ─────────────────────────────────────────────── */}
            <section className="s-card overflow-hidden">
              <div className="flex items-center justify-between px-5 py-4 border-b border-s-border">
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">
                  Item Breakdown — {sorted.length} items
                </p>
                <div className="flex gap-2">
                  {(['totalCost', 'foodCostPct', 'qtySold'] as const).map((k) => (
                    <button key={k}
                      onClick={() => setSortKey(k)}
                      className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                        sortKey === k
                          ? 'border-s-teal/40 bg-s-teal-dim text-primary-ink'
                          : 'border-s-border bg-s-surface text-s-muted hover:text-s-text'
                      }`}>
                      {k === 'totalCost' ? 'By Cost' : k === 'foodCostPct' ? 'By FC%' : 'By Qty'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="s-table w-full">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="text-right">Qty Sold</th>
                      <th className="text-right">Cost / Portion</th>
                      <th className="text-right">Total Cost</th>
                      <th className="text-right">Revenue</th>
                      <th className="text-right">Food Cost %</th>
                      <th className="text-right">Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center text-s-dim py-8">
                          No items with recipes found for this period
                        </td>
                      </tr>
                    ) : sorted.map((item) => {
                      const fcHigh = item.foodCostPct > 35
                      const fcWarn = item.foodCostPct > 30 && !fcHigh
                      return (
                        <tr key={item.menuItemId}>
                          <td>
                            <p className="text-s-text font-medium">{item.name}</p>
                          </td>
                          <td className="text-right text-s-muted">{item.qtySold.toLocaleString()}</td>
                          <td className="text-right text-s-muted">{fmtPkrWhole(item.costPerPortion)}</td>
                          <td className="text-right font-semibold text-s-text">{fmtPkrWhole(item.totalCost)}</td>
                          <td className="text-right text-s-muted">{fmtPkrWhole(item.revenue)}</td>
                          <td className={`text-right font-bold ${fcHigh ? 'text-s-red' : fcWarn ? 'text-s-amber' : 'text-primary-ink'}`}>
                            {item.foodCostPct}%
                          </td>
                          <td className={`text-right font-bold ${item.marginPct < 50 ? 'text-s-amber' : 'text-primary-ink'}`}>
                            {item.marginPct}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ── Unmapped items ────────────────────────────────────────────── */}
            {data!.itemsWithoutRecipe.length > 0 && (
              <section className="rounded-xl border border-s-amber/20 bg-s-amber-dim/30 p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="font-semibold text-s-amber text-sm">
                    ⚠ {data!.itemsWithoutRecipe.length} items sold without recipes (excluded from analysis)
                  </p>
                  <Link href="/accounting/recipes" className="text-xs text-primary-ink hover:underline">Build Recipes →</Link>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {data!.itemsWithoutRecipe.map((item) => (
                    <span key={item.menuItemId ?? item.name}
                      className="text-[11px] bg-s-surface border border-s-amber/20 text-s-amber rounded px-2 py-0.5">
                      {item.name} ({item.qtySold})
                    </span>
                  ))}
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="s-card p-12 text-center">
            <p className="text-s-dim">No data found for this period</p>
          </div>
        )}
      </div>
    </div>
  )
}
