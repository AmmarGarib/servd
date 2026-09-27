'use client'

// Low-stock & out-of-stock dashboard. Surfaces the items the kitchen risks
// 86ing tonight, sorted by urgency.

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface InventoryItem {
  id: string
  name: string
  unit: string
  parLevel: number
  currentStock: number
  unitCostCents: number | null
  isLowStock: boolean
  stockPercentage: number
  supplier?: { name: string } | null
}

export default function InventoryAlertsPage() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['inventory-list'],
    queryFn: () => api.get<InventoryItem[]>('/inventory'),
    refetchInterval: 60_000,
  })

  const items = data ?? []
  const out  = items.filter((i) => i.currentStock <= 0)
  const low  = items.filter((i) => i.currentStock > 0 && i.isLowStock)
  const ok   = items.filter((i) => !i.isLowStock && i.currentStock > 0)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/inventory" className="text-xs text-s-muted hover:text-s-text">← Inventory</Link>
          <h1 className="text-xl font-bold text-s-text">Stock alerts</h1>
        </div>
        <button onClick={() => refetch()} className="s-btn-secondary text-xs">Refresh</button>
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-4">
        {/* KPIs */}
        <div className="grid grid-cols-3 gap-3">
          <div className="s-card p-4 border-l-4 border-s-red">
            <p className="text-xs text-s-muted">Out of stock</p>
            <p className="text-2xl font-bold text-s-red">{out.length}</p>
            <p className="text-[11px] text-s-dim">orders will fail / 86 immediately</p>
          </div>
          <div className="s-card p-4 border-l-4 border-s-amber">
            <p className="text-xs text-s-muted">Low stock</p>
            <p className="text-2xl font-bold text-s-amber">{low.length}</p>
            <p className="text-[11px] text-s-dim">below par level</p>
          </div>
          <div className="s-card p-4 border-l-4 border-s-teal">
            <p className="text-xs text-s-muted">Healthy</p>
            <p className="text-2xl font-bold text-s-teal">{ok.length}</p>
            <p className="text-[11px] text-s-dim">no action needed</p>
          </div>
        </div>

        {/* Out-of-stock — most urgent */}
        {out.length > 0 && (
          <Section title="Out of stock — fix now" rows={out} loading={isLoading} severity="red" />
        )}
        {/* Low stock */}
        {low.length > 0 && (
          <Section title="Low stock — order soon" rows={low} loading={isLoading} severity="amber" />
        )}
        {out.length + low.length === 0 && !isLoading && (
          <div className="s-card p-8 text-center">
            <p className="text-s-text font-semibold mb-1">Everything&rsquo;s in stock.</p>
            <p className="text-xs text-s-muted">No items are below par.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Section({ title, rows, loading, severity }: { title: string; rows: InventoryItem[]; loading: boolean; severity: 'red' | 'amber' }) {
  // s.red / s.amber are TAILWIND colours (tailwind.config.ts), not CSS custom
  // properties — `var(--s-red)` never resolved, so both severities rendered
  // the same colourless stripe. Hex straight from the config.
  const accent = severity === 'red' ? '#FF4D4F' : '#F59E0B'
  return (
    <div className="s-card overflow-hidden">
      <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft" style={{ borderLeft: `3px solid ${accent}` }}>
        <h2 className="text-sm font-bold text-s-text">{title}</h2>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-xs text-s-muted">
          <tr>
            <th className="px-4 py-2 text-left">Item</th>
            <th className="px-4 py-2 text-left">Supplier</th>
            <th className="px-4 py-2 text-right">Current</th>
            <th className="px-4 py-2 text-right">Par</th>
            <th className="px-4 py-2 text-left">Health</th>
            <th className="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pctClamped = Math.max(0, Math.min(100, r.stockPercentage))
            return (
              <tr key={r.id} className="border-t border-s-border">
                <td className="px-4 py-2 text-s-text">{r.name}</td>
                <td className="px-4 py-2 text-xs text-s-muted">{r.supplier?.name ?? '—'}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{r.currentStock} {r.unit}</td>
                <td className="px-4 py-2 text-right font-mono text-xs text-s-muted">{r.parLevel} {r.unit}</td>
                <td className="px-4 py-2">
                  <div className="w-32 h-2 rounded-full bg-s-bg-soft overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pctClamped}%`, background: accent }} />
                  </div>
                </td>
                <td className="px-4 py-2 text-right">
                  <Link href="/inventory/count" className="text-xs text-s-teal hover:underline">Count →</Link>
                </td>
              </tr>
            )
          })}
          {loading && (
            <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-s-muted">Loading…</td></tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  )
}
