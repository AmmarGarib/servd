'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ActivityFeed } from '../../components/ui/ActivityFeed'
import { fmtPkrShort } from '../../lib/money'
import { usePermissions } from '../../hooks/useCan'
import { canOpenPath } from '../../lib/moduleCatalog'

// The books' own audit trail answers only these roles (backend
// lib/moduleAccess.ts ACCOUNTING_AUDIT_ROLES) — the module alone is not enough.
const ACCOUNTING_AUDIT_ROLES = ['admin', 'management']

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

// Hub links, each shown only when the user can open the page (see `can`).
// Gift cards need 'gift_cards', Tip pools 'payroll', Payroll 'staff_hr' or
// 'payroll' (the one register), the audit log ACCOUNTING_AUDIT_ROLES too.
const OPERATIONS_LINKS: Array<{ href: string; label: string }> = [
  { href: '/orders',           label: '⚡ Live orders' },
  { href: '/floorplan',        label: '🪑 Floor plan' },
  { href: '/reservations',     label: '📅 Reservations' },
  { href: '/gift-cards',       label: '🎁 Gift cards' },
  { href: '/dispatch',         label: '🛵 Dispatch' },
  { href: '/tip-pools',        label: '💰 Tip pools' },
  { href: '/storefront',       label: 'Storefront content' },
  { href: '/analytics',        label: '📊 Sales analytics' },
  { href: '/crm',              label: '👥 Customers' },
  { href: '/refunds',          label: '↩️ Refunds' },
  { href: '/inventory/alerts', label: '📦 Stock alerts' },
  { href: '/reviews',          label: '⭐ Reviews' },
]

const LEDGER_LINKS: Array<{ href: string; label: string }> = [
  { href: '/accounting/trial-balance',    label: 'Trial Balance' },
  { href: '/accounting/balance-sheet',    label: 'Balance Sheet' },
  { href: '/accounting/pl-ledger',        label: 'P&L' },
  { href: '/accounting/ledger',           label: 'Ledger' },
  { href: '/accounting/journal',          label: 'Journal Entry' },
  { href: '/accounting/cash-flow',        label: 'Cash Flow' },
  { href: '/accounting/period-close',     label: 'Period Close' },
  { href: '/accounting/ap-aging',         label: 'AP Aging' },
  { href: '/accounting/sales-tax-return', label: 'Sales Tax Return' },
  { href: '/accounting/audit-log',        label: 'Audit Log' },
  { href: '/hr/payroll',                  label: 'Payroll' },
  { href: '/allocations',                 label: 'Cost Allocation' },
  { href: '/reconciliation',              label: 'Reconciliation' },
]

const statusColor = {
  good:     { bar: 'bg-s-teal', text: 'text-primary-ink', badge: 's-badge-teal', label: 'On Target' },
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

  // Every card, link and widget here is shown only when the signed-in user
  // can open the page behind it — the same module test as the sidebar and the
  // page guard (HR-R8: finance saw Tip pools, Gift cards, Payroll and the
  // books' audit log whatever its modules). Nothing shows until GET
  // /permissions/me answers.
  const { data: me } = usePermissions()
  const modules = me?.modules ?? []
  const can = (href: string): boolean => {
    if (!me) return false
    if (href === '/accounting/audit-log' && !ACCOUNTING_AUDIT_ROLES.includes(me.role)) return false
    return canOpenPath(href, me.role, modules)
  }
  const holds = (m: string) => me?.role === 'admin' || modules.includes(m)

  // Summary widgets the user didn't ask for one by one: a read their role
  // can't make leaves the widget empty rather than toasting (`background`).
  const { data: foodCost } = useQuery({
    queryKey: ['food-cost', 'hub'],
    queryFn: () => api.get<FoodCostData>(`/recipes/food-cost?dateFrom=${monthStart}`),
    refetchInterval: 300_000,
    enabled: can('/accounting/food-cost'),
    meta: { background: true },
  })

  // /procurement/* is the Procurement module's (module-gated in the API).
  const { data: vendors } = useQuery({
    queryKey: ['vendors'],
    queryFn: () => api.get<Vendor[]>('/procurement/suppliers'),
    enabled: holds('procurement'),
    meta: { background: true },
  })

  const { data: recentPOs } = useQuery({
    queryKey: ['purchase-orders', 'recent'],
    queryFn: () => api.get<PurchaseOrder[]>('/procurement/purchase-orders?limit=5'),
    refetchInterval: 60_000,
    enabled: holds('procurement'),
    meta: { background: true },
  })

  const { data: recipes } = useQuery({
    queryKey: ['recipes', 'count'],
    queryFn: () => api.get<{ id: string }[]>('/recipes'),
    enabled: holds('recipes'),
    meta: { background: true },
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
              // Sales-register figure (what customers paid, incl. GST) — the
              // books' revenue is the P&L.
              label: 'Sales (MTD, register)',
              value: foodCost ? fmtPkrShort(foodCost.revenue.grossCents) : '—',
              sub: foodCost ? `incl. GST · register net ${fmtPkrShort(foodCost.revenue.netCents)}` : undefined,
              color: 'text-gradient-brand',
              href: '/reports',
            },
            {
              label: 'Active Vendors',
              value: vendors?.length ?? '—',
              sub: `${vendors?.reduce((s, v) => s + v._count.purchaseOrders, 0) ?? 0} POs total`,
              color: 'text-s-indigo',
              href: '/procurement',
            },
            {
              label: 'Recipes Built',
              value: recipes?.length ?? '—',
              sub: foodCost ? `${foodCost.itemsWithoutRecipe.length} items unmapped` : undefined,
              color: 'text-primary-ink',
              href: '/accounting/recipes',
            },
          ].filter((kpi) => can(kpi.href)).map((kpi) => (
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
              {OPERATIONS_LINKS.filter((l) => can(l.href)).map((l) => (
                <Link key={l.href} href={l.href} className="s-card-hover p-3 rounded border border-s-border text-s-text">{l.label}</Link>
              ))}
            </div>
          </section>
          <ActivityFeed limit={12} />
        </div>

        {/* ── Ledger reports ──────────────────────────────────────────────── */}
        <section className="s-card p-4">
          <p className="text-xs font-semibold text-s-muted uppercase tracking-wider mb-3">Ledger Reports</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
            {LEDGER_LINKS.filter((l) => can(l.href)).map((l) => (
              <Link key={l.href} href={l.href} className="s-card-hover p-3 rounded border border-s-border text-s-text">{l.label}</Link>
            ))}
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
                <Link href="/accounting/food-cost" className="text-xs text-primary-ink hover:underline">Full report →</Link>
              </div>
            </div>

            {/* Gauge bar */}
            <div className="mb-4">
              <div className="flex justify-between text-xs text-s-muted mb-1.5">
                <span>0%</span>
                <span className="text-primary-ink">Target 30%</span>
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
                <span className={`text-sm font-semibold ${fc.variance > 0 ? 'text-s-red' : 'text-primary-ink'}`}>
                  {fc.variance > 0 ? '+' : ''}{fc.variance}% vs target
                </span>
              </div>
            </div>

            {/* Cost breakdown */}
            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-s-border">
              {[
                { label: 'Theoretical Cost', value: fmtPkrShort(fc.theoreticalCents), color: 'text-s-text' },
                { label: 'Actual Purchases', value: fmtPkrShort(fc.actualPurchasesCents), color: 'text-s-amber' },
                { label: 'Gross Revenue', value: fmtPkrShort(foodCost!.revenue.grossCents), color: 'text-primary-ink' },
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
              <Link href="/accounting/food-cost" className="text-xs text-primary-ink hover:underline">Detail →</Link>
            </div>
            {!foodCost?.byItem.length ? (
              <p className="text-sm text-s-dim text-center py-6">No data for this period</p>
            ) : (
              <div className="space-y-2">
                {foodCost.byItem.slice(0, 6).map((item) => (
                  <div key={item.menuItemId} className="flex items-center justify-between py-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-s-text truncate">{item.name}</p>
                      <p className="text-[11px] text-s-dim">{item.qtySold} sold · {fmtPkrShort(item.revenue)} revenue</p>
                    </div>
                    <div className="ml-3 text-right shrink-0">
                      <p className="text-sm font-bold text-s-text">{fmtPkrShort(item.totalCost)}</p>
                      <p className={`text-[11px] font-semibold ${item.foodCostPct > 35 ? 'text-s-red' : item.foodCostPct > 30 ? 'text-s-amber' : 'text-primary-ink'}`}>
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
              <Link href="/procurement" className="text-xs text-primary-ink hover:underline">All POs →</Link>
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
                      <span className="text-sm font-semibold text-s-text">{fmtPkrShort(po.totalCents)}</span>
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
              { href: '/procurement',   icon: '🏭', label: 'Vendors',   desc: 'Suppliers & POs' },
              { href: '/accounting/pl-ledger', icon: '💰', label: 'P&L',       desc: 'Profit & Loss (ledger)' },
              { href: '/reports',              icon: '📈', label: 'Reports',   desc: 'Sales & analytics' },
              { href: '/inventory',            icon: '📦', label: 'Inventory', desc: 'Stock & par levels' },
            ].filter((item) => can(item.href)).map((item) => (
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
              {can('/accounting/recipes') && <Link href="/accounting/recipes" className="s-btn text-xs shrink-0">Add Recipes →</Link>}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
