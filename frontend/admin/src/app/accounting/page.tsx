'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ActivityFeed } from '../../components/ui/ActivityFeed'

function fmt(cents: number) {
  const n = cents / 100
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${n.toFixed(0)}`
}

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
  byItem: { menuItemId: string; name: string; qtySold: number; totalCost: number; revenue: number; foodCostPct: number; marginPct: number }[]
  itemsWithoutRecipe: { menuItemId: string | null; name: string; qtySold: number }[]
}

interface PurchaseOrder {
  id: string
  status: string
  orderDate: string
  totalCents: number
  reference: string | null
  supplier: { name: string }
  lines: { id: string }[]
}

interface Vendor {
  id: string
  name: string
  _count: { purchaseOrders: number; inventoryItems: number }
}

const statusColor = {
  good:     { bar: 'bg-s-teal', text: 'text-s-teal', badge: 's-badge-teal', label: 'On Target' },
  warning:  { bar: 'bg-s-amber', text: 'text-s-amber', badge: 's-badge-amber', label: 'Watch' },
  critical: { bar: 'bg-s-red', text: 'text-s-red', badge: 's-badge-red', label: 'Over Budget' },
}

const poStatusColor: Record<string, string> = {
  draft:     's-badge-muted',
  sent:      's-badge-blue',
  partial:   's-badge-amber',
  received:  's-badge-teal',
  cancelled: 's-badge-red',
}

export default function AccountingHubPage() {
  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString()

  const { data: foodCost } = useQuery({
    queryKey: ['food-cost', 'hub'],
    queryFn: () => api.get<FoodCostData>(`/recipes/food-cost?dateFrom=${monthStart}`),
    refetchInterval: 300_000,
  })

  const { data: vendors } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<Vendor[]>('/recipes/vendors'),
  })

  const { data: recentPOs } = useQuery({
    queryKey: ['purchase-orders', 'recent'],
    queryFn: () => api.get<PurchaseOrder[]>('/recipes/purchase-orders?limit=5'),
    refetchInterval: 60_000,
  })

  const { data: recipes } = useQuery({
    queryKey: ['recipes', 'count'],
    queryFn: () => api.get<{ id: string }[]>('/recipes'),
  })

  const fc = foodCost?.cost
  const fcStatus = fc ? statusColor[fc.status] : null

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <p className="text-xs text-s-muted">Finance</p>
        <h1 className="text-xl font-bold text-s-text">Accounting Hub</h1>
      </header>

      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* ── KPI row ───────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            {
              label: 'Food Cost % (MTD)',
              value: fc ? `${fc.theoreticalFoodCostPct}%` : '—',
              sub: fc ? `Target: ${fc.targetFoodCostPct}%` : undefined,
              color: fcStatus?.text ?? 'text-s-text',
              href: '/accounting/food-cost',
            },
            {
              label: 'Gross Revenue (MTD)',
              value: foodCost ? fmt(foodCost.revenue.grossCents) : '—',
              sub: foodCost ? `Net: ${fmt(foodCost.revenue.netCents)}` : undefined,
              color: 'text-gradient-brand',
              href: '/finance',
            },
            {
              label: 'Active Vendors',
              value: vendors?.length ?? '—',
              sub: `${vendors?.reduce((s, v) => s + v._count.purchaseOrders, 0) ?? 0} POs total`,
              color: 'text-s-indigo',
              href: '/accounting/vendors',
            },
            {
              label: 'Recipes Built',
              value: recipes?.length ?? '—',
              sub: foodCost ? `${foodCost.itemsWithoutRecipe.length} items unmapped` : undefined,
              color: 'text-s-teal',
              href: '/accounting/recipes',
            },
          ].map((kpi) => (
            <Link key={kpi.label} href={kpi.href}
              className="metric-card s-card-hover group">
              <p className="metric-label">{kpi.label}</p>
              <p className={`metric-value ${kpi.color}`}>{kpi.value}</p>
              {kpi.sub && <p className="text-[11px] text-s-dim mt-1">{kpi.sub}</p>}
            </Link>
          ))}
        </div>

        {/* ── Operations + recent activity ────────────────────────────────── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <section className="s-card p-4 lg:col-span-2">
            <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-3">Operations</p>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm">
              <Link href="/live"               className="s-card-hover p-3 rounded border border-s-border text-s-text">⚡ Live orders</Link>
              <Link href="/floorplan"          className="s-card-hover p-3 rounded border border-s-border text-s-text">🪑 Floor plan</Link>
              <Link href="/reservations"       className="s-card-hover p-3 rounded border border-s-border text-s-text">📅 Reservations</Link>
              <Link href="/gift-cards"         className="s-card-hover p-3 rounded border border-s-border text-s-text">🎁 Gift cards</Link>
              <Link href="/dispatch"           className="s-card-hover p-3 rounded border border-s-border text-s-text">🛵 Dispatch</Link>
              <Link href="/tip-pools"          className="s-card-hover p-3 rounded border border-s-border text-s-text">💰 Tip pools</Link>
              <Link href="/content"            className="s-card-hover p-3 rounded border border-s-border text-s-text">🧱 Content editor</Link>
              <Link href="/analytics"          className="s-card-hover p-3 rounded border border-s-border text-s-text">📊 Sales analytics</Link>
              <Link href="/customers"          className="s-card-hover p-3 rounded border border-s-border text-s-text">👥 Customers</Link>
              <Link href="/refunds"            className="s-card-hover p-3 rounded border border-s-border text-s-text">↩️ Refunds</Link>
              <Link href="/inventory/alerts"   className="s-card-hover p-3 rounded border border-s-border text-s-text">📦 Stock alerts</Link>
              <Link href="/reviews"            className="s-card-hover p-3 rounded border border-s-border text-s-text">⭐ Reviews</Link>
            </div>
          </section>
          <ActivityFeed limit={12} />
        </div>

        {/* ── Ledger reports ──────────────────────────────────────────────── */}
        <section className="s-card p-4">
          <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-3">Ledger Reports</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            <Link href="/accounting/trial-balance"  className="s-card-hover p-3 rounded border border-s-border text-s-text">Trial Balance</Link>
            <Link href="/accounting/balance-sheet"  className="s-card-hover p-3 rounded border border-s-border text-s-text">Balance Sheet</Link>
            <Link href="/accounting/pl-ledger"      className="s-card-hover p-3 rounded border border-s-border text-s-text">P&L (ledger)</Link>
            <Link href="/accounting/cash-flow"      className="s-card-hover p-3 rounded border border-s-border text-s-text">Cash Flow</Link>
            <Link href="/accounting/period-close"      className="s-card-hover p-3 rounded border border-s-border text-s-text">Period Close</Link>
            <Link href="/accounting/ap-aging"          className="s-card-hover p-3 rounded border border-s-border text-s-text">AP Aging</Link>
            <Link href="/accounting/sales-tax-return"  className="s-card-hover p-3 rounded border border-s-border text-s-text">Sales Tax Return</Link>
            <Link href="/accounting/audit-log"         className="s-card-hover p-3 rounded border border-s-border text-s-text">Audit Log</Link>
            <Link href="/payroll"                   className="s-card-hover p-3 rounded border border-s-border text-s-text">Payroll</Link>
            <Link href="/allocations"               className="s-card-hover p-3 rounded border border-s-border text-s-text">Cost Allocation</Link>
            <Link href="/reconciliation"            className="s-card-hover p-3 rounded border border-s-border text-s-text col-span-2 sm:col-span-1">Reconciliation</Link>
          </div>
        </section>

        {/* ── Food cost gauge ───────────────────────────────────────────────── */}
        {fc && (
          <section className="s-card p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Food Cost Analysis — Month to Date</p>
                <p className="text-xs text-s-dim mt-0.5">
                  Theoretical cost vs revenue · Target ≤{fc.targetFoodCostPct}%
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`s-badge ${fcStatus?.badge}`}>{fcStatus?.label}</span>
                <Link href="/accounting/food-cost" className="text-xs text-s-teal hover:underline">Full report →</Link>
              </div>
            </div>

            {/* Gauge bar */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-s-muted mb-1.5">
                <span>0%</span>
                <span className="text-s-teal">Target 30%</span>
                <span>50%+</span>
              </div>
              <div className="stat-bar-track h-3 relative">
                {/* target line */}
                <div className="absolute top-0 bottom-0 w-px bg-s-teal/60" style={{ left: '60%' }} />
                <div
                  className={`stat-bar-fill h-3 ${fcStatus?.bar}`}
                  style={{ width: `${Math.min((fc.theoreticalFoodCostPct / 50) * 100, 100)}%` }}
                />
              </div>
              <div className="flex justify-between items-center mt-2">
                <span className={`text-2xl font-black ${fcStatus?.text}`}>{fc.theoreticalFoodCostPct}%</span>
                <span className={`text-sm font-semibold ${fc.variance > 0 ? 'text-s-red' : 'text-s-teal'}`}>
                  {fc.variance > 0 ? '+' : ''}{fc.variance}% vs target
                </span>
              </div>
            </div>

            {/* Cost breakdown */}
            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-s-border">
              {[
                { label: 'Theoretical Cost', value: fmt(fc.theoreticalCents), color: 'text-s-text' },
                { label: 'Actual Purchases', value: fmt(fc.actualPurchasesCents), color: 'text-s-amber' },
                { label: 'Gross Revenue', value: fmt(foodCost!.revenue.grossCents), color: 'text-s-teal' },
              ].map((s) => (
                <div key={s.label} className="text-center rounded-lg bg-s-elevated border border-s-border p-3">
                  <p className={`text-base font-bold ${s.color}`}>{s.value}</p>
                  <p className="text-[10px] text-s-dim mt-0.5">{s.label}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Two-column: top items + recent POs ───────────────────────────── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">

          {/* Top cost items */}
          <section className="s-card p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Top Cost Items (MTD)</p>
              <Link href="/accounting/food-cost" className="text-xs text-s-teal hover:underline">Detail →</Link>
            </div>
            {!foodCost?.byItem.length ? (
              <p className="text-sm text-s-dim text-center py-6">No data for this period</p>
            ) : (
              <div className="space-y-2">
                {foodCost.byItem.slice(0, 6).map((item) => (
                  <div key={item.menuItemId} className="flex items-center justify-between py-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-s-text truncate">{item.name}</p>
                      <p className="text-[11px] text-s-dim">{item.qtySold} sold · {fmt(item.revenue)} revenue</p>
                    </div>
                    <div className="ml-3 text-right shrink-0">
                      <p className="text-sm font-bold text-s-text">{fmt(item.totalCost)}</p>
                      <p className={`text-[11px] font-semibold ${item.foodCostPct > 35 ? 'text-s-red' : item.foodCostPct > 30 ? 'text-s-amber' : 'text-s-teal'}`}>
                        {item.foodCostPct}% FC
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Recent POs */}
          <section className="s-card p-5">
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Recent Purchase Orders</p>
              <Link href="/accounting/vendors" className="text-xs text-s-teal hover:underline">All POs →</Link>
            </div>
            {!recentPOs?.length ? (
              <p className="text-sm text-s-dim text-center py-6">No purchase orders yet</p>
            ) : (
              <div className="space-y-2">
                {recentPOs.map((po) => (
                  <div key={po.id} className="flex items-center justify-between py-1.5 border-b border-s-border/50 last:border-0">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-s-text truncate">{po.supplier.name}</p>
                      <p className="text-[11px] text-s-dim font-mono">
                        {po.reference ?? po.id.slice(-8).toUpperCase()} · {po.lines.length} lines
                      </p>
                    </div>
                    <div className="ml-3 flex items-center gap-2 shrink-0">
                      <span className="text-sm font-semibold text-s-text">{fmt(po.totalCents)}</span>
                      <span className={`s-badge text-[10px] ${poStatusColor[po.status] ?? 's-badge-muted'}`}>
                        {po.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* ── Quick nav ─────────────────────────────────────────────────────── */}
        <section>
          <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-3">Finance Modules</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { href: '/accounting/food-cost', icon: '🍽', label: 'Food Cost', desc: 'Theoretical vs actual' },
              { href: '/accounting/recipes',   icon: '📐', label: 'Recipes',   desc: 'Ingredient costing' },
              { href: '/accounting/vendors',   icon: '🏭', label: 'Vendors',   desc: 'Suppliers & POs' },
              { href: '/finance',              icon: '💰', label: 'P&L',       desc: 'Profit & Loss' },
              { href: '/reports',              icon: '📈', label: 'Reports',   desc: 'Sales & analytics' },
              { href: '/inventory',            icon: '📦', label: 'Inventory', desc: 'Stock & par levels' },
            ].map((item) => (
              <Link key={item.href} href={item.href}
                className="s-card p-4 hover:border-s-teal/40 hover:bg-s-elevated transition-all group">
                <span className="text-2xl group-hover:scale-110 transition-transform block mb-2">{item.icon}</span>
                <p className="text-sm font-semibold text-s-text">{item.label}</p>
                <p className="text-[11px] text-s-dim mt-0.5">{item.desc}</p>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Unmapped items warning ────────────────────────────────────────── */}
        {(foodCost?.itemsWithoutRecipe.length ?? 0) > 0 && (
          <section className="rounded-xl border border-s-amber/20 bg-s-amber-dim/30 p-4">
            <div className="flex items-start gap-3">
              <span className="text-xl mt-0.5">⚠</span>
              <div className="flex-1">
                <p className="font-semibold text-s-amber text-sm">
                  {foodCost!.itemsWithoutRecipe.length} menu items sold without recipes
                </p>
                <p className="text-xs text-s-muted mt-0.5">
                  Food cost analysis is incomplete. Build recipes for these items to get accurate cost data.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {foodCost!.itemsWithoutRecipe.slice(0, 8).map((item) => (
                    <span key={item.menuItemId} className="text-[11px] bg-s-surface border border-s-amber/20 text-s-amber rounded px-2 py-0.5">
                      {item.name}
                    </span>
                  ))}
                  {foodCost!.itemsWithoutRecipe.length > 8 && (
                    <span className="text-[11px] text-s-dim">+{foodCost!.itemsWithoutRecipe.length - 8} more</span>
                  )}
                </div>
              </div>
              <Link href="/accounting/recipes" className="s-btn text-xs shrink-0">Add Recipes →</Link>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
