'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import Link from 'next/link'
import { ActivityFeed } from '../../components/ui/ActivityFeed'
import { fmtPkrShort, startOfMonthPktIso, todayPktIso } from '../../lib/money'
import { usePermissions } from '../../hooks/useCan'
import { canOpenPath } from '../../lib/moduleCatalog'

// The books' own audit trail answers only these roles (backend
// lib/moduleAccess.ts ACCOUNTING_AUDIT_ROLES) — the module alone is not enough.
const ACCOUNTING_AUDIT_ROLES = ['admin', 'management']

// GET /reports/food-cost/summary (THE food-cost engine, reports/foodCost.ts):
// one block per company in view. Brand sales and every % only for the finance
// tier (revenueHidden otherwise).
type FcStatus = 'no_data' | 'incomplete' | 'good' | 'warning' | 'critical'
interface FoodCostBlock {
  tenantId: string
  companyName: string
  status: FcStatus
  statusLabel: string
  revenueCents?: number
  targetPct?: number | null
  theoreticalPct?: number | null
  actualPct?: number | null
  theoretical: { totalCents: number }
  actual: { totalCents: number } | null
  unexplainedCents: number
  items: Array<{ menuItemId: string; name: string; qtySold: number; costCents: number; revenueCents?: number; costPct?: number | null; targetPct?: number | null }>
  warnings: Array<{ code: string; count: number; names?: string[] }>
}
interface FoodCostData { revenueHidden: boolean; companies: FoodCostBlock[] }

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
  { href: '/accounting/statutory',        label: 'Statutory Payments' },
  { href: '/accounting/audit-log',        label: 'Audit Log' },
  { href: '/hr/payroll',                  label: 'Payroll' },
  { href: '/allocations',                 label: 'Cost Allocation' },
  { href: '/reconciliation',              label: 'Reconciliation' },
]

// Status colours (labels come from the API: 'On target', 'Watch', 'Over
// target', 'Incomplete data', 'No sales').
const statusColor: Record<FcStatus, { bar: string; text: string; badge: string }> = {
  good:       { bar: 'var(--erp-accent)',  text: 'text-success',  badge: 's-badge-green' },
  warning:    { bar: 'var(--erp-warning)', text: 'text-s-amber',  badge: 's-badge-amber' },
  critical:   { bar: 'var(--erp-danger)',  text: 'text-s-red',    badge: 's-badge-red' },
  incomplete: { bar: 'var(--erp-warning)', text: 'text-s-amber',  badge: 's-badge-amber' },
  no_data:    { bar: 'var(--border)',      text: 'text-s-muted',  badge: 's-badge-muted' },
}

const poStatusColor: Record<string, string> = {
  draft:     's-badge-muted',
  sent:      's-badge-blue',
  partial:   's-badge-amber',
  received:  's-badge-teal',
  cancelled: 's-badge-red',
}

export default function AccountingHubPage() {
  // Month to date, as PKT days (the API reads YYYY-MM-DD as whole PKT days).
  const monthStart = startOfMonthPktIso()
  const today = todayPktIso()

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
  // The food-cost gauge reads THE food-cost report (Reports → Food cost
  // variance); the API also answers the accounting module's reads for it.
  const { data: foodCost } = useQuery({
    queryKey: ['food-cost', 'hub', monthStart, today],
    queryFn: () => api.get<FoodCostData>(`/reports/food-cost/summary?from=${monthStart}&to=${today}`),
    refetchInterval: 300_000,
    enabled: holds('food_cost') || holds('accounting'),
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

  // Across the companies in view: one gauge, each company's own figures summed
  // (the report itself keeps them apart).
  const blocks = foodCost?.companies ?? []
  const fc = blocks.length === 0 ? null : (() => {
    const sum = (f: (b: FoodCostBlock) => number) => blocks.reduce((s, b) => s + f(b), 0)
    const revenue = sum((b) => b.revenueCents ?? 0)
    const actual = sum((b) => b.actual?.totalCents ?? 0)
    const theoretical = sum((b) => b.theoretical.totalCents)
    const pct = (c: number) => (revenue > 0 ? Math.round((c / revenue) * 1000) / 10 : null)
    const targets = blocks.filter((b) => b.targetPct != null && (b.revenueCents ?? 0) > 0)
    const targetPct = targets.length === 0 ? null
      : Math.round((targets.reduce((s, b) => s + (b.targetPct! * (b.revenueCents ?? 0)), 0) / Math.max(1, targets.reduce((s, b) => s + (b.revenueCents ?? 0), 0))) * 10) / 10
    const rank: FcStatus[] = ['no_data', 'incomplete', 'critical', 'warning', 'good']
    const worst = [...blocks].sort((a, b) => rank.indexOf(a.status) - rank.indexOf(b.status))[0]!
    return {
      revenueHidden: foodCost!.revenueHidden, revenue, actual, theoretical, actualPct: pct(actual), theoreticalPct: pct(theoretical), targetPct,
      unexplained: sum((b) => b.unexplainedCents), status: worst.status, statusLabel: worst.statusLabel,
      items: blocks.flatMap((b) => b.items).sort((a, b) => b.costCents - a.costCents),
      noRecipe: blocks.flatMap((b) => b.warnings.filter((w) => w.code === 'no_recipe')),
    }
  })()
  const fcStatus = fc ? statusColor[fc.status] : null
  const fcLink = can('/reports/food-cost')
  const noRecipeCount = fc ? fc.noRecipe.reduce((s, w) => s + w.count, 0) : 0
  const noRecipeNames = fc ? fc.noRecipe.flatMap((w) => w.names ?? []) : []
  const pctText = (v: number | null) => (v == null ? '—' : `${v}%`)
  // Gauge scale: never a hard-coded target — the bar runs to the larger of 50% and the figures + 10.
  const scale = fc ? Math.max(50, (fc.actualPct ?? 0) + 10, (fc.targetPct ?? 0) + 10) : 50

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <p className="text-xs text-success">Finance</p>
        <h1 className="text-xl font-bold text-s-text">Accounting Hub</h1>
      </header>

      <div className="p-6 space-y-6 max-w-6xl mx-auto">

        {/* ── KPI row ───────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            {
              // Actual cost of sales (ledger) over brand sales — the food-cost
              // report's definition; PKR at cost when sales are not shown.
              label: 'Cost of sales (MTD)',
              value: fc ? (fc.revenueHidden ? fmtPkrShort(fc.actual) : pctText(fc.actualPct)) : '—',
              sub: fc ? (fc.revenueHidden ? fc.statusLabel : `Theoretical ${pctText(fc.theoreticalPct)} · target ${pctText(fc.targetPct)}`) : undefined,
              color: fcStatus?.text ?? 'text-s-text',
              href: fcLink ? '/reports/food-cost' : '/accounting',
              show: !!fc,
            },
            {
              // Brand sales from the ledger (40xx after discounts, ex-GST) —
              // the food-cost denominator. Finance tier only.
              label: 'Brand sales (MTD)',
              value: fc && !fc.revenueHidden ? fmtPkrShort(fc.revenue) : '—',
              sub: fc && !fc.revenueHidden ? 'ledger, after discounts, ex-GST' : undefined,
              color: 'text-primary-ink',
              href: '/accounting/pl-ledger',
              show: !!fc && !fc.revenueHidden && can('/accounting/pl-ledger'),
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
              sub: fc ? `${noRecipeCount} sold item(s) with no recipe` : undefined,
              color: 'text-primary-ink',
              href: '/accounting/recipes',
            },
          ].filter((kpi) => ('show' in kpi ? kpi.show : can(kpi.href))).map((kpi) => (
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

        {/* ── Food cost gauge (Reports → Food cost variance) ───────────────── */}
        {fc && (
          <section className="s-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
              <div>
                <p className="text-xs font-semibold text-s-muted uppercase tracking-wider">Food cost — month to date</p>
                <p className="text-xs text-s-dim mt-0.5">
                  Actual cost of sales against the recipes at the price paid{fc.targetPct != null && !fc.revenueHidden ? ` · target ${fc.targetPct}%` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={fcStatus?.badge}>{fc.statusLabel}</span>
                {fcLink && <Link href="/reports/food-cost" className="text-xs text-primary-ink hover:underline">Full report →</Link>}
              </div>
            </div>

            {!fc.revenueHidden && (
              <div className="mb-4">
                <div className="stat-bar-track h-3 relative">
                  {fc.targetPct != null && (
                    <div className="absolute top-0 bottom-0 w-px" style={{ left: `${Math.min(100, (fc.targetPct / scale) * 100)}%`, background: 'var(--erp-success)' }} title={`Target ${fc.targetPct}%`} />
                  )}
                  <div className="h-3 rounded-full" style={{ width: `${Math.min(100, ((fc.actualPct ?? 0) / scale) * 100)}%`, background: fcStatus?.bar }} />
                </div>
                <div className="flex flex-wrap justify-between items-center gap-2 mt-2">
                  <span className={`text-2xl font-black ${fcStatus?.text}`}>Actual {pctText(fc.actualPct)}</span>
                  <span className="text-sm text-s-muted">Theoretical {pctText(fc.theoreticalPct)}</span>
                  {fc.actualPct != null && fc.theoreticalPct != null && (
                    <span className="text-sm font-semibold" style={{ color: fc.actualPct > fc.theoreticalPct ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                      {fc.actualPct > fc.theoreticalPct ? '+' : ''}{Math.round((fc.actualPct - fc.theoreticalPct) * 10) / 10} pts vs theoretical
                    </span>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 pt-3 border-t border-s-border">
              {[
                { label: 'Theoretical cost', value: fmtPkrShort(fc.theoretical), color: 'text-s-text' },
                { label: 'Actual cost (ledger)', value: fmtPkrShort(fc.actual), color: fcStatus?.text ?? 'text-s-text' },
                { label: 'Unexplained', value: fmtPkrShort(fc.unexplained), color: fc.unexplained > 0 ? 'text-s-red' : 'text-success' },
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
              {fcLink && <Link href="/reports/food-cost" className="text-xs text-primary-ink hover:underline">Detail →</Link>}
            </div>
            {!fc?.items.length ? (
              <p className="text-sm text-s-dim text-center py-6">No sales</p>
            ) : (
              <div className="space-y-2">
                {fc.items.slice(0, 6).map((item) => (
                  <div key={item.menuItemId} className="flex items-center justify-between py-1">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-s-text truncate">{item.name}</p>
                      <p className="text-[11px] text-s-dim">{item.qtySold} sold{item.revenueCents != null ? ` · ${fmtPkrShort(item.revenueCents)} sales` : ''}</p>
                    </div>
                    <div className="ml-3 text-right shrink-0">
                      <p className="text-sm font-bold text-s-text">{fmtPkrShort(item.costCents)}</p>
                      {item.costPct != null && (
                        <p className="text-[11px] font-semibold" style={{ color: item.targetPct != null && item.costPct > item.targetPct ? 'var(--erp-danger)' : 'var(--erp-success)' }}>
                          {item.costPct}% of sales
                        </p>
                      )}
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
              { href: '/reports/food-cost',    icon: '🍽', label: 'Food cost variance', desc: 'Actual vs recipe' },
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

        {/* ── Sold with no recipe ───────────────────────────────────────────── */}
        {noRecipeCount > 0 && (
          <section className="rounded-xl p-4" style={{ color: 'var(--erp-warning)', background: 'color-mix(in srgb, var(--erp-warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 25%, transparent)' }}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1">
                <p className="font-semibold text-sm">Incomplete data: {noRecipeCount} menu item(s) sold with no recipe</p>
                <p className="text-xs mt-0.5 opacity-80">
                  Nothing was taken from stock for them, so their cost is missing from the food-cost figures. Build their recipes.
                </p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {noRecipeNames.slice(0, 8).map((name) => (
                    <span key={name} className="s-badge-amber">{name}</span>
                  ))}
                  {noRecipeCount > 8 && <span className="text-[11px] opacity-80">+{noRecipeCount - 8} more</span>}
                </div>
              </div>
              {can('/accounting/recipes') && <Link href="/accounting/recipes" className="s-btn text-xs shrink-0">Add recipes →</Link>}
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
