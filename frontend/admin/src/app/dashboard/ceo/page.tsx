'use client'
// CEO Dashboard — the executive command center. Daily-cadence scorecard for
// ownership across the whole company and per brand.
//
//   Top:   brand selector (All / per-brand) + period switcher — drives everything.
//   Below: a comprehensive, sectioned breakdown of the selected scope:
//          Money · Demand · Customers · Funnel · Operations · Quality ·
//          Reservations · Inventory · Loss-control · Workforce cost.
//
// Most numbers are brand-scoped via `conceptId`. A few are whole-company only
// (full ledger P&L, labour %, cash reconciliation, loss-control, workforce
// cost) — those carry a "company-wide" tag and don't change when you pick a
// single brand. Everything degrades to "—" rather than breaking if a field is
// missing, so the page is resilient as the backend evolves.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { useViewAsRole } from '../../../store/viewAsRole'
import type { AppRole } from '../../../lib/appRoles'

type Period = 'today' | 'week' | 'month'
type Scope = { conceptId: string | null; fromISO: string; toISO: string; fromDate: string; toDate: string; days: number; brandName: string }

interface Concept { id: string; name: string; slug: string }

// ─── date helpers ─────────────────────────────────────────────────────────────
function rangeFor(period: Period): { fromISO: string; toISO: string; fromDate: string; toDate: string; days: number; label: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  let fromDate: string, toDate: string, days: number, label: string
  if (period === 'today') {
    fromDate = toDate = iso(now); days = 1; label = 'today'
  } else if (period === 'week') {
    fromDate = iso(new Date(y, m, d - 6)); toDate = iso(now); days = 7; label = 'last 7 days'
  } else {
    fromDate = iso(new Date(y, m, 1)); toDate = iso(now); days = 30; label = 'this month'
  }
  // reports/management/analytics parse full ISO; accounting/payroll parse date-only.
  return { fromISO: `${fromDate}T00:00:00Z`, toISO: `${toDate}T23:59:59Z`, fromDate, toDate, days, label }
}

// ─── number helpers ───────────────────────────────────────────────────────────
function pkr(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return '—'
  const n = cents / 100
  if (Math.abs(n) >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 10_000)    return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${n.toLocaleString()}`
}
function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n.toFixed(digits)}%`
}
function num(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}
function mins(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return `${n.toFixed(n < 10 ? 1 : 0)}m`
}
function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? `?${s}` : ''
}
// Several endpoints return a bare array; normalise whatever we get to an array.
function arr<T = unknown>(x: unknown, key?: string): T[] {
  if (Array.isArray(x)) return x as T[]
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    if (key && Array.isArray(o[key])) return o[key] as T[]
    if (Array.isArray(o['items'])) return o['items'] as T[]
    if (Array.isArray(o['rows'])) return o['rows'] as T[]
  }
  return []
}

export default function CeoDashboardPage() {
  const router = useRouter()
  const [period, setPeriod] = useState<Period>('today')
  const [conceptId, setConceptId] = useState<string | null>(null) // null = All brands / company
  const range = useMemo(() => rangeFor(period), [period])

  // ── access gate (unchanged) ──────────────────────────────────────────────
  const { data: me, isLoading: permsLoading } = usePermissions()
  const viewAsRole = useViewAsRole((s) => s.role)
  const overrides  = useRoleModules((s) => s.overrides)
  const canViewCeo = useMemo(() => {
    if (!me) return null
    const isSuper = me.role === 'admin'
    if (isSuper && !viewAsRole) return true
    const effectiveRole = (isSuper && viewAsRole ? viewAsRole : me.role) as AppRole
    return new Set(modulesForRole(effectiveRole, overrides)).has('ceo_overview')
  }, [me, viewAsRole, overrides])

  useEffect(() => { if (canViewCeo === false) router.replace('/dashboard') }, [canViewCeo, router])

  const { data: concepts } = useQuery({
    queryKey: ['ceo', 'concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
    enabled:  canViewCeo === true,
  })

  if (permsLoading || canViewCeo === null) {
    return <main style={shellMuted}>Checking access…</main>
  }
  if (canViewCeo === false) {
    return <main style={shellMuted}>This view is restricted to ownership. Redirecting…</main>
  }

  const brandName = conceptId ? (concepts?.find((c) => c.id === conceptId)?.name ?? 'Brand') : 'All brands'
  const scope: Scope = { conceptId, fromISO: range.fromISO, toISO: range.toISO, fromDate: range.fromDate, toDate: range.toDate, days: range.days, brandName }
  const isCompany = conceptId === null

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '82rem', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <Link href="/dashboard" style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', textDecoration: 'none' }}>
              ← all dashboards
            </Link>
            <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>
              CEO — {brandName} · {range.label}
            </h1>
            <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
              How the business is doing. Pick a brand to drill in. Numbers reconcile with Reports.
            </p>
          </div>
          <PeriodSwitcher value={period} onChange={setPeriod} />
        </div>

        {/* ── Brand selector (top) ── */}
        <BrandSelector
          concepts={concepts ?? []}
          selected={conceptId}
          onSelect={setConceptId}
          fromISO={range.fromISO}
          toISO={range.toISO}
        />

        {/* ── Sections ── */}
        <MoneySection scope={scope} isCompany={isCompany} />
        <DemandSection scope={scope} />
        <CustomersSection scope={scope} />
        <FunnelSection scope={scope} />
        <OperationsSection scope={scope} />
        <QualitySection scope={scope} />
        {!isCompany && <ReservationsSection scope={scope} />}
        <InventorySection scope={scope} />
        <LossControlSection scope={scope} />
        <WorkforceCostSection />

        {/* Footer signals */}
        <Section title="Where to dig" hint="link out — not a metric">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/reports"     label="Full reports →"     accent="#00D4B1" />
            <Pill href="/accounting"  label="Accounting →"        accent="#00D4B1" />
            <Pill href="/finance"     label="P&L →"               accent="#22C55E" />
            <Pill href="/crm"         label="Customer base →"     accent="#6366F1" />
            <Pill href="/inventory"   label="Inventory →"         accent="#F59E0B" />
            <Pill href="/menu"        label="Menu editor →"       accent="#A855F7" />
          </div>
        </Section>
      </div>
    </main>
  )
}

// ─── Brand selector ───────────────────────────────────────────────────────────
function BrandSelector({ concepts, selected, onSelect, fromISO, toISO }: {
  concepts: Concept[]; selected: string | null; onSelect: (id: string | null) => void; fromISO: string; toISO: string
}) {
  return (
    <div style={{ marginTop: '1.4rem', display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <BrandSelectCard label="All brands" sublabel="whole company" conceptId={null} selected={selected === null} onSelect={() => onSelect(null)} fromISO={fromISO} toISO={toISO} />
      {concepts.map((c) => (
        <BrandSelectCard key={c.id} label={c.name} sublabel={`/${c.slug}`} conceptId={c.id} selected={selected === c.id} onSelect={() => onSelect(c.id)} fromISO={fromISO} toISO={toISO} />
      ))}
    </div>
  )
}

interface SalesResp { totals?: { gross?: number; net?: number; tax?: number; commission?: number; orders?: number } }

function BrandSelectCard({ label, sublabel, conceptId, selected, onSelect, fromISO, toISO }: {
  label: string; sublabel: string; conceptId: string | null; selected: boolean; onSelect: () => void; fromISO: string; toISO: string
}) {
  const { data } = useQuery({
    queryKey: ['ceo', 'selcard', conceptId ?? 'all', fromISO, toISO],
    queryFn:  () => api.get<SalesResp>(`/reports/sales${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`),
    refetchInterval: 90_000,
  })
  const gross = data?.totals?.gross ?? 0
  const orders = data?.totals?.orders ?? 0
  return (
    <button onClick={onSelect} style={{
      textAlign: 'left', cursor: 'pointer',
      background: selected ? 'rgba(0,212,177,0.10)' : '#11151c',
      border: `1px solid ${selected ? 'rgba(0,212,177,0.55)' : '#1d222b'}`,
      borderRadius: '1rem', padding: '0.95rem 1.1rem', color: 'inherit',
      boxShadow: selected ? '0 0 0 1px rgba(0,212,177,0.25), 0 0 18px rgba(0,212,177,0.10)' : 'none',
      transition: 'all 0.15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontSize: '0.85rem', fontWeight: 700, margin: 0, color: selected ? '#00D4B1' : '#E8EAF0' }}>{label}</p>
        {selected && <span style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.12em', color: '#00D4B1', textTransform: 'uppercase' }}>viewing</span>}
      </div>
      <p style={{ fontSize: '1.35rem', fontWeight: 800, margin: '0.45rem 0 0', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>{pkr(gross)}</p>
      <p style={{ color: '#6E7186', fontSize: '0.72rem', margin: '0.35rem 0 0', fontVariantNumeric: 'tabular-nums' }}>{orders} orders · {sublabel}</p>
    </button>
  )
}

// ─── 1. Money ─────────────────────────────────────────────────────────────────
interface PlLedger { totals?: { revenueCents?: number; cogsCents?: number; grossProfitCents?: number; grossMarginPct?: number; opexCents?: number; contraRevenueCents?: number; netProfitCents?: number } }
interface LabourPct { revenueCents?: number; labourCents?: number; labourPct?: number }
interface CashFlow { totals?: { inflowCents?: number; outflowCents?: number; netCents?: number } }
interface MenuEngItem { priceCents?: number; qtySold?: number; foodCostCents?: number; grossMarginPct?: number; quadrant?: string; hasRecipe?: boolean }

function MoneySection({ scope, isCompany }: { scope: Scope; isCompany: boolean }) {
  const { conceptId, fromISO, toISO, fromDate, toDate } = scope
  const sales = useQuery({ queryKey: ['ceo', 'sales', conceptId, fromISO, toISO], queryFn: () => api.get<SalesResp>(`/reports/sales${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`), refetchInterval: 60_000 })
  const pl = useQuery({ queryKey: ['ceo', 'pl', fromDate, toDate], queryFn: () => api.get<PlLedger>(`/accounting/pl-ledger${qs({ dateFrom: fromDate, dateTo: toDate })}`), refetchInterval: 300_000 })
  const labour = useQuery({ queryKey: ['ceo', 'labour', fromDate, toDate], queryFn: () => api.get<LabourPct>(`/payroll/labour-pct${qs({ dateFrom: fromDate, dateTo: toDate })}`), refetchInterval: 300_000 })
  const cash = useQuery({ queryKey: ['ceo', 'cashflow', fromDate, toDate], queryFn: () => api.get<CashFlow>(`/accounting/cash-flow${qs({ dateFrom: fromDate, dateTo: toDate })}`), refetchInterval: 300_000 })
  const menuEng = useQuery({
    queryKey: ['ceo', 'menu-eng-cost', conceptId, fromISO, toISO],
    queryFn:  () => api.get<MenuEngItem[]>(`/reports/menu-engineering${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`),
    enabled:  !!conceptId,
  })

  const t = sales.data?.totals
  const gross = t?.gross ?? 0
  const orders = t?.orders ?? 0
  const aov = orders > 0 ? Math.round(gross / orders) : null

  // Food cost %: company → ledger COGS/revenue; per-brand → weighted from recipe costing.
  const companyFoodPct = pl.data?.totals?.revenueCents ? ((pl.data.totals.cogsCents ?? 0) / pl.data.totals.revenueCents) * 100 : null
  const brandFoodPct = useMemo(() => {
    const items = menuEng.data ?? []
    let cost = 0, rev = 0
    for (const i of items) { const q = i.qtySold ?? 0; cost += (i.foodCostCents ?? 0) * q; rev += (i.priceCents ?? 0) * q }
    return rev > 0 ? (cost / rev) * 100 : null
  }, [menuEng.data])
  const foodPct = isCompany ? companyFoodPct : brandFoodPct
  const labourPct = labour.data?.labourPct ?? null
  const primePct = (foodPct != null && labourPct != null) ? foodPct + labourPct : null

  return (
    <Section title="The money" hint={isCompany ? 'company-wide P&L' : `${scope.brandName} sales · P&L is company-wide`}>
      <Grid>
        <Scorecard label="Net revenue"  value={pkr(t?.net ?? gross)} accent="#00D4B1" sub={`${orders} orders`} />
        <Scorecard label="Avg ticket"   value={pkr(aov)} accent="#4F8EF7" sub="per order" />
        <Scorecard label="Gross profit" value={pkr(pl.data?.totals?.grossProfitCents)} accent="#22C55E" sub="rev − COGS" tag="co." />
        <Scorecard label="Gross margin" value={pct(pl.data?.totals?.grossMarginPct)} accent="#22C55E" sub="of revenue" tag="co." />
        <Scorecard label="Food cost"    value={pct(foodPct)} accent="#F59E0B" sub={isCompany ? 'COGS / rev' : 'recipe-weighted'} />
        <Scorecard label="Labour"       value={pct(labourPct)} accent="#F59E0B" sub="wages / rev" tag="co." />
        <Scorecard label="Prime cost"   value={pct(primePct)} accent="#EF4444" sub="food + labour" tag={isCompany ? undefined : 'approx'} />
        <Scorecard label="Net profit"   value={pkr(pl.data?.totals?.netProfitCents)} accent="#00D4B1" sub="bottom line" tag="co." />
        <Scorecard label="Tax collected" value={pkr(t?.tax)} accent="#A855F7" sub="FBR + provincial" />
        <Scorecard label="OpEx"         value={pkr(pl.data?.totals?.opexCents)} accent="#6E7186" sub="operating expense" tag="co." />
        <Scorecard label="Discounts"    value={pkr(pl.data?.totals?.contraRevenueCents)} accent="#6E7186" sub="contra-revenue" tag="co." />
        <Scorecard label="Cash flow"    value={pkr(cash.data?.totals?.netCents)} accent="#4F8EF7" sub="net in − out" tag="co." />
      </Grid>
    </Section>
  )
}

// ─── 2. Demand ────────────────────────────────────────────────────────────────
interface BySourceRow { source?: string; orders?: number; gross?: number; net?: number }
interface TopItemRow { name?: string; quantity?: number; revenue?: number; revenueCents?: number }
interface BrandMetrics {
  revenue?: { grossCents?: number; netCents?: number; orders?: number }
  customers?: { distinct?: number; new?: number; returning?: number }
  spend?: { acquisitionCents?: number; retentionCents?: number }
  kpis?: { aovCents?: number; arpuCents?: number; ltvCents?: number; cacCents?: number | null; crcCents?: number | null; roas?: number | null }
  reputation?: { avgRating?: number; reviewCount?: number; openComplaints?: number }
}
interface ForecastResp { items?: Array<{ totalPredicted?: number }> }

function DemandSection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO, days } = scope
  const bySource = useQuery({ queryKey: ['ceo', 'by-source', conceptId, fromISO, toISO], queryFn: () => api.get<BySourceRow[]>(`/reports/by-source${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const top = useQuery({ queryKey: ['ceo', 'top', conceptId, fromISO, toISO], queryFn: () => api.get<{ items?: TopItemRow[] }>(`/reports/top-items${qs({ conceptId, dateFrom: fromISO, dateTo: toISO, limit: 6 })}`) })
  const bm = useQuery({ queryKey: ['ceo', 'bm-demand', conceptId, fromISO, toISO], queryFn: () => api.get<BrandMetrics>(`/management/brand-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const menuEng = useQuery({ queryKey: ['ceo', 'menu-eng', conceptId, fromISO, toISO], queryFn: () => api.get<MenuEngItem[]>(`/reports/menu-engineering${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`), enabled: !!conceptId })
  const forecast = useQuery({ queryKey: ['ceo', 'forecast', conceptId, days], queryFn: () => api.get<ForecastResp>(`/reports/demand-forecast${qs({ conceptId, days })}`), enabled: !!conceptId })

  const sources = arr<BySourceRow>(bySource.data)
  const topItems = arr<TopItemRow>(top.data, 'items')
  const quad = useMemo(() => {
    const items = menuEng.data ?? []
    const c: Record<string, number> = { star: 0, plowHorse: 0, puzzle: 0, dog: 0 }
    for (const i of items) { const q = i.quadrant; if (q && q in c) c[q] = (c[q] ?? 0) + 1 }
    return c
  }, [menuEng.data])
  const forecastTotal = (forecast.data?.items ?? []).reduce((s, i) => s + (i.totalPredicted ?? 0), 0)

  return (
    <Section title="Demand & sales" hint="what's selling, where, when">
      <Grid>
        <Scorecard label="Avg order value" value={pkr(bm.data?.kpis?.aovCents)} accent="#4F8EF7" sub="per order" />
        <Scorecard label="Active customers" value={num(bm.data?.customers?.distinct)} accent="#6366F1" sub="ordered in period" />
        {!!conceptId && <Scorecard label="Menu stars" value={num(quad['star'])} accent="#22C55E" sub={`${quad['dog'] ?? 0} dogs`} />}
        {!!conceptId && <Scorecard label="Forecast (7d)" value={num(forecastTotal)} accent="#A855F7" sub="units predicted" />}
      </Grid>

      <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginTop: '0.85rem' }}>
        <Panel title="By channel">
          {sources.length === 0 && <Empty>No channel data.</Empty>}
          {sources.map((s, i) => <BarRow key={i} label={s.source ?? '—'} value={pkr(s.gross)} pct={pctOf(s.gross, sources.reduce((a, b) => a + (b.gross ?? 0), 0))} />)}
        </Panel>
        <Panel title="Top sellers">
          {topItems.length === 0 && <Empty>No items sold.</Empty>}
          {topItems.map((it, i) => (
            <Row key={i} left={`${i + 1}. ${it.name ?? '—'}`} mid={`${num(it.quantity)} sold`} right={pkr(it.revenueCents ?? it.revenue)} />
          ))}
        </Panel>
      </div>
    </Section>
  )
}

// ─── 3. Customers & growth ────────────────────────────────────────────────────
interface SmartSeg { summary?: { totalCustomers?: number; repeatRate?: number; avgOrderValueCents?: number }; segments?: Array<{ key?: string; label?: string; count?: number }> }
interface MarketingPerf { campaigns?: number; promosCreated?: number; promoUsages?: number; contentEvents?: number; mediaUploads?: number; totalActions?: number }

function CustomersSection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO, days } = scope
  const bm = useQuery({ queryKey: ['ceo', 'bm', conceptId, fromISO, toISO], queryFn: () => api.get<BrandMetrics>(`/management/brand-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`), refetchInterval: 120_000 })
  const seg = useQuery({ queryKey: ['ceo', 'segments'], queryFn: () => api.get<SmartSeg>('/crm/smart-segments'), refetchInterval: 300_000 })
  const mk = useQuery({ queryKey: ['ceo', 'mk-perf', days], queryFn: () => api.get<MarketingPerf>(`/marketing/performance${qs({ days })}`), refetchInterval: 300_000 })

  const k = bm.data?.kpis
  const roas = k?.roas == null ? '—' : `${k.roas.toFixed(1)}×`
  const segments = arr<{ key?: string; label?: string; count?: number }>(seg.data?.segments)

  return (
    <Section title="Customers & growth" hint="acquisition, retention, value">
      <Grid>
        <Scorecard label="New customers"  value={num(bm.data?.customers?.new)} accent="#22C55E" sub="first order in period" />
        <Scorecard label="Returning"      value={num(bm.data?.customers?.returning)} accent="#4F8EF7" sub="repeat in period" />
        <Scorecard label="Repeat rate"    value={pct(seg.data?.summary?.repeatRate)} accent="#A855F7" sub="3+ orders" tag="co." />
        <Scorecard label="LTV"            value={pkr(k?.ltvCents)} accent="#22C55E" sub="lifetime spend" />
        <Scorecard label="ARPU"           value={pkr(k?.arpuCents)} accent="#A855F7" sub="rev / active user" />
        <Scorecard label="ROAS"           value={roas} accent="#00D4B1" sub="return on ad spend" />
        <Scorecard label="CAC"            value={pkr(k?.cacCents)} accent="#4F8EF7" sub="cost to acquire" />
        <Scorecard label="CRC"            value={pkr(k?.crcCents)} accent="#6366F1" sub="cost to retain" />
        <Scorecard label="Acq. spend"     value={pkr(bm.data?.spend?.acquisitionCents)} accent="#6E7186" sub="marketing — new" />
        <Scorecard label="Retention spend" value={pkr(bm.data?.spend?.retentionCents)} accent="#6E7186" sub="marketing — repeat" />
        <Scorecard label="Total customers" value={num(seg.data?.summary?.totalCustomers)} accent="#6366F1" sub="all-time base" tag="co." />
        <Scorecard label="Mktg actions"   value={num(mk.data?.totalActions)} accent="#EC4899" sub={`${num(mk.data?.promoUsages)} redemptions`} tag="co." />
      </Grid>

      <div style={{ marginTop: '0.85rem' }}>
        <Panel title="Segments">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {segments.length === 0 && <Empty>No segments computed.</Empty>}
            {segments.map((s, i) => (
              <span key={i} style={{ fontSize: '0.74rem', padding: '0.3rem 0.6rem', borderRadius: '999px', background: 'rgba(99,102,241,0.10)', border: '1px solid rgba(99,102,241,0.25)', color: '#A5B4FC' }}>
                {s.label ?? s.key}: <strong>{num(s.count)}</strong>
              </span>
            ))}
          </div>
        </Panel>
      </div>
    </Section>
  )
}

// ─── 4. Storefront funnel ─────────────────────────────────────────────────────
interface FunnelResp { steps?: Array<{ event?: string; count?: number; conversionRate?: number | null }> }
interface OverviewResp { totalSessions?: number; checkoutStarted?: number; ordersPlaced?: number; checkoutConversion?: number }
interface ItemsResp { items?: Array<{ name?: string; views?: number; adds?: number; addRate?: number }> }
interface SearchResp { items?: Array<{ query?: string; count?: number; noResultRate?: number }> }

function FunnelSection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO } = scope
  const funnel = useQuery({ queryKey: ['ceo', 'funnel', conceptId, fromISO, toISO], queryFn: () => api.get<FunnelResp>(`/analytics/funnel${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const overview = useQuery({ queryKey: ['ceo', 'ov', conceptId, fromISO, toISO], queryFn: () => api.get<OverviewResp>(`/analytics/overview${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const items = useQuery({ queryKey: ['ceo', 'an-items', conceptId, fromISO, toISO], queryFn: () => api.get<ItemsResp>(`/analytics/items${qs({ conceptId, dateFrom: fromISO, dateTo: toISO, limit: 5 })}`) })
  const search = useQuery({ queryKey: ['ceo', 'an-search', conceptId, fromISO, toISO], queryFn: () => api.get<SearchResp>(`/analytics/search${qs({ conceptId, dateFrom: fromISO, dateTo: toISO, limit: 5 })}`) })

  const steps = arr<{ event?: string; count?: number; conversionRate?: number | null }>(funnel.data?.steps)
  const anItems = arr<{ name?: string; views?: number; adds?: number; addRate?: number }>(items.data, 'items')
  const searches = arr<{ query?: string; count?: number; noResultRate?: number }>(search.data, 'items')
  const avgAddRate = anItems.length ? anItems.reduce((s, i) => s + (i.addRate ?? 0), 0) / anItems.length : null
  const zeroResultRate = searches.length ? searches.reduce((s, i) => s + (i.noResultRate ?? 0), 0) / searches.length : null

  return (
    <Section title="Storefront funnel" hint="web + app — views → orders">
      <Grid>
        <Scorecard label="Sessions"        value={num(overview.data?.totalSessions)} accent="#4F8EF7" sub="visits" />
        <Scorecard label="Checkout conv."  value={pct(overview.data?.checkoutConversion)} accent="#00D4B1" sub="orders / checkouts" />
        <Scorecard label="Add-to-cart"     value={pct(avgAddRate)} accent="#A855F7" sub="adds / views (top items)" />
        <Scorecard label="Orders placed"   value={num(overview.data?.ordersPlaced)} accent="#22C55E" sub="from storefront" />
        <Scorecard label="Zero-result search" value={pct(zeroResultRate)} accent="#EF4444" sub="searches w/ no hits" />
      </Grid>

      <div style={{ marginTop: '0.85rem' }}>
        <Panel title="Conversion funnel">
          {steps.length === 0 && <Empty>No funnel events captured yet.</Empty>}
          {steps.map((s, i) => (
            <BarRow key={i} label={(s.event ?? '—').replace(/_/g, ' ')} value={num(s.count)} pct={s.conversionRate ?? (i === 0 ? 100 : null)} />
          ))}
        </Panel>
      </div>
    </Section>
  )
}

// ─── 5. Operations ────────────────────────────────────────────────────────────
interface StationRow { stationName?: string; items?: number; avgMinutes?: number }
interface FnbMetrics {
  kitchen?: { avgTicketMinutes?: number; stations?: StationRow[] }
  quality?: { foodComplaints?: number; avgRating?: number; reviewCount?: number; complaintsByCategory?: Array<{ category?: string; count?: number }> }
  stock?: { lowStockCount?: number; wasteCostCents?: number; wasteEvents?: number; lowStockItems?: Array<{ name?: string; currentStock?: number; parLevel?: number }> }
}
interface Anomaly { severity?: string; category?: string; title?: string; detail?: string }

function OperationsSection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO } = scope
  const fnb = useQuery({ queryKey: ['ceo', 'fnb', conceptId, fromISO, toISO], queryFn: () => api.get<FnbMetrics>(`/management/fnb-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const anomalies = useQuery({ queryKey: ['ceo', 'anomalies', conceptId], queryFn: () => api.get<{ flags?: Anomaly[] } | Anomaly[]>(`/ops/anomalies${qs({ conceptId, hours: 24 })}`), refetchInterval: 120_000 })

  const stations = arr<StationRow>(fnb.data?.kitchen?.stations)
  const flags = arr<Anomaly>(anomalies.data, 'flags')

  return (
    <Section title="Operations & speed" hint="kitchen throughput & anomalies">
      <Grid>
        <Scorecard label="Avg ticket time" value={mins(fnb.data?.kitchen?.avgTicketMinutes)} accent="#4F8EF7" sub="fire → bump" />
        <Scorecard label="Stations" value={num(stations.length || null)} accent="#6366F1" sub="reporting" />
        <Scorecard label="Live anomalies" value={num(flags.length)} accent={flags.length ? '#EF4444' : '#22C55E'} sub="last 24h" tag="co." />
        <Scorecard label="Food complaints" value={num(fnb.data?.quality?.foodComplaints)} accent="#F59E0B" sub="quality/wrong/missing" />
      </Grid>

      <div style={{ display: 'grid', gap: '0.85rem', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginTop: '0.85rem' }}>
        <Panel title="Station times">
          {stations.length === 0 && <Empty>No station data.</Empty>}
          {stations.map((s, i) => <Row key={i} left={s.stationName ?? '—'} mid={`${num(s.items)} items`} right={mins(s.avgMinutes)} warn={(s.avgMinutes ?? 0) > 12} />)}
        </Panel>
        <Panel title="Anomalies">
          {flags.length === 0 && <Empty>All clear — no anomalies.</Empty>}
          {flags.map((f, i) => (
            <Row key={i} left={f.title ?? f.category ?? '—'} mid="" right={f.severity ?? ''} warn={f.severity === 'high'} />
          ))}
        </Panel>
      </div>
    </Section>
  )
}

// ─── 6. Quality ───────────────────────────────────────────────────────────────
interface FeedbackResp { nps?: { score?: number; total?: number; promoters?: number; detractors?: number }; csat?: { average?: number; total?: number }; openSuggestions?: number }

function QualitySection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO, days } = scope
  const bm = useQuery({ queryKey: ['ceo', 'rep', conceptId, fromISO, toISO], queryFn: () => api.get<BrandMetrics>(`/management/brand-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const fb = useQuery({ queryKey: ['ceo', 'feedback', conceptId, days], queryFn: () => api.get<FeedbackResp>(`/feedback/summary${qs({ conceptId, days })}`) })
  const fnb = useQuery({ queryKey: ['ceo', 'fnb-q', conceptId, fromISO, toISO], queryFn: () => api.get<FnbMetrics>(`/management/fnb-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })

  const cats = arr<{ category?: string; count?: number }>(fnb.data?.quality?.complaintsByCategory)
  const rating = bm.data?.reputation?.avgRating
  return (
    <Section title="Service quality" hint="ratings, NPS, complaints">
      <Grid>
        <Scorecard label="Avg rating"  value={rating != null ? `${rating.toFixed(1)} ★` : '—'} accent="#F59E0B" sub={`${num(bm.data?.reputation?.reviewCount)} reviews`} />
        <Scorecard label="NPS"         value={fb.data?.nps?.score != null ? String(Math.round(fb.data.nps.score)) : '—'} accent="#22C55E" sub={`${num(fb.data?.nps?.total)} responses`} />
        <Scorecard label="CSAT"        value={fb.data?.csat?.average != null ? fb.data.csat.average.toFixed(1) : '—'} accent="#4F8EF7" sub="1–5 avg" />
        <Scorecard label="Open complaints" value={num(bm.data?.reputation?.openComplaints)} accent="#EF4444" sub="awaiting resolution" />
      </Grid>
      {cats.length > 0 && (
        <div style={{ marginTop: '0.85rem' }}>
          <Panel title="Complaints by type">
            {cats.map((c, i) => <Row key={i} left={(c.category ?? '—').replace(/_/g, ' ')} mid="" right={num(c.count)} />)}
          </Panel>
        </div>
      )}
    </Section>
  )
}

// ─── 7. Reservations (per-brand) ──────────────────────────────────────────────
interface ResvAnalytics { totals?: { bookings?: number; completed?: number; noShow?: number; cancelled?: number; covers?: number }; rates?: { noShowPct?: number; occupancyPct?: number; repeatGuestPct?: number } }

function ReservationsSection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO } = scope
  const r = useQuery({
    queryKey: ['ceo', 'resv', conceptId, fromISO, toISO],
    queryFn:  () => api.get<ResvAnalytics>(`/reservations/analytics${qs({ conceptId, from: fromISO, to: toISO })}`),
    enabled:  !!conceptId,
  })
  return (
    <Section title="Reservations" hint="front-of-house demand">
      <Grid>
        <Scorecard label="Covers"        value={num(r.data?.totals?.covers)} accent="#00D4B1" sub={`${num(r.data?.totals?.bookings)} bookings`} />
        <Scorecard label="No-show rate"  value={pct(r.data?.rates?.noShowPct)} accent="#EF4444" sub={`${num(r.data?.totals?.noShow)} no-shows`} />
        <Scorecard label="Occupancy"     value={pct(r.data?.rates?.occupancyPct)} accent="#4F8EF7" sub="table utilisation" />
        <Scorecard label="Repeat guests" value={pct(r.data?.rates?.repeatGuestPct)} accent="#A855F7" sub="returning diners" />
      </Grid>
    </Section>
  )
}

// ─── 8. Inventory & waste ─────────────────────────────────────────────────────
function InventorySection({ scope }: { scope: Scope }) {
  const { conceptId, fromISO, toISO } = scope
  const fnb = useQuery({ queryKey: ['ceo', 'fnb-inv', conceptId, fromISO, toISO], queryFn: () => api.get<FnbMetrics>(`/management/fnb-metrics${qs({ conceptId, dateFrom: fromISO, dateTo: toISO })}`) })
  const low = arr<{ name?: string; currentStock?: number; parLevel?: number }>(fnb.data?.stock?.lowStockItems)
  return (
    <Section title="Inventory & waste" hint="stock health (company-wide)">
      <Grid>
        <Scorecard label="Low-stock items" value={num(fnb.data?.stock?.lowStockCount)} accent="#F59E0B" sub="below par" tag="co." />
        <Scorecard label="Waste cost"      value={pkr(fnb.data?.stock?.wasteCostCents)} accent="#EF4444" sub={`${num(fnb.data?.stock?.wasteEvents)} events`} tag="co." />
      </Grid>
      {low.length > 0 && (
        <div style={{ marginTop: '0.85rem' }}>
          <Panel title="Low stock">
            {low.slice(0, 8).map((l, i) => <Row key={i} left={l.name ?? '—'} mid="" right={`${num(l.currentStock)} / ${num(l.parLevel)}`} warn />)}
          </Panel>
        </div>
      )}
    </Section>
  )
}

// ─── 9. Loss control (company) ────────────────────────────────────────────────
interface ExceptionStats { open?: number; acknowledged?: number; last24h?: number; byKind?: Array<{ kind?: string; count?: number }> }
interface ReconSummary { totalShifts?: number; balancedShifts?: number }

function LossControlSection({ scope }: { scope: Scope }) {
  const { fromDate, toDate } = scope
  const exc = useQuery({ queryKey: ['ceo', 'exceptions'], queryFn: () => api.get<ExceptionStats>('/crosschecks/exceptions/stats'), refetchInterval: 300_000 })
  const recon = useQuery({ queryKey: ['ceo', 'recon', fromDate, toDate], queryFn: () => api.get<ReconSummary>(`/reconciliation/summary${qs({ dateFrom: fromDate, dateTo: toDate })}`), refetchInterval: 300_000 })
  const balanced = recon.data?.totalShifts ? (recon.data.balancedShifts ?? 0) / recon.data.totalShifts * 100 : null
  return (
    <Section title="Loss control" hint="trust & cash integrity (company-wide)">
      <Grid>
        <Scorecard label="Open exceptions" value={num(exc.data?.open)} accent={exc.data?.open ? '#EF4444' : '#22C55E'} sub="flagged anomalies" tag="co." />
        <Scorecard label="New (24h)"       value={num(exc.data?.last24h)} accent="#F59E0B" sub="exceptions today" tag="co." />
        <Scorecard label="Cash balanced"   value={pct(balanced)} accent="#22C55E" sub={`${num(recon.data?.balancedShifts)}/${num(recon.data?.totalShifts)} shifts`} tag="co." />
      </Grid>
    </Section>
  )
}

// ─── 10. Workforce cost (company) ─────────────────────────────────────────────
interface PayrollSnapshot { budget?: { monthlyCents?: number; grossMonthlyCents?: number }; headcount?: number; openSeats?: number }

function WorkforceCostSection() {
  const snap = useQuery({ queryKey: ['ceo', 'payroll-snap'], queryFn: () => api.get<PayrollSnapshot>('/opex/payroll-snapshot'), refetchInterval: 300_000 })
  return (
    <Section title="Workforce cost" hint="payroll run-rate (company-wide)">
      <Grid>
        <Scorecard label="Payroll / mo"  value={pkr(snap.data?.budget?.grossMonthlyCents ?? snap.data?.budget?.monthlyCents)} accent="#F59E0B" sub="monthly run-rate" tag="co." />
        <Scorecard label="Headcount"     value={num(snap.data?.headcount)} accent="#6366F1" sub="filled positions" tag="co." />
        <Scorecard label="Open seats"    value={num(snap.data?.openSeats)} accent="#4F8EF7" sub="unfilled" tag="co." />
      </Grid>
    </Section>
  )
}

// ─── shared UI ────────────────────────────────────────────────────────────────
const shellMuted: React.CSSProperties = { minHeight: '100vh', background: '#0a0d12', color: '#6E7186', padding: '4rem 1.4rem', textAlign: 'center', fontSize: '0.85rem' }

function pctOf(part: number | undefined, total: number): number | null {
  if (!total) return null
  return ((part ?? 0) / total) * 100
}

function PeriodSwitcher({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const opts: { id: Period; label: string }[] = [
    { id: 'today', label: 'Today' }, { id: 'week', label: '7 days' }, { id: 'month', label: 'Month' },
  ]
  return (
    <div style={{ display: 'inline-flex', background: '#11151c', border: '1px solid #1d222b', borderRadius: '999px', padding: '0.2rem' }}>
      {opts.map((o) => {
        const on = o.id === value
        return (
          <button key={o.id} onClick={() => onChange(o.id)} style={{
            padding: '0.4rem 0.95rem', fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.05em', borderRadius: '999px',
            background: on ? '#00D4B1' : 'transparent', color: on ? '#0a0d12' : '#9aa0b4', border: 'none', cursor: 'pointer',
          }}>{o.label}</button>
        )
      })}
    </div>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>{children}</div>
}

function Scorecard({ label, value, sub, accent, tag }: { label: string; value: string; sub?: string; accent: string; tag?: string }) {
  return (
    <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '1rem', padding: '1rem 1.1rem', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: accent, opacity: 0.7 }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#6E7186', margin: 0 }}>{label}</p>
        {tag && <span style={{ fontSize: '0.54rem', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#6E7186', background: 'rgba(255,255,255,0.05)', padding: '0.1rem 0.3rem', borderRadius: '4px' }}>{tag}</span>}
      </div>
      <p style={{ fontSize: 'clamp(1.25rem, 2.4vw, 1.6rem)', fontWeight: 800, letterSpacing: '-0.02em', margin: '0.5rem 0 0', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      {sub && <p style={{ color: '#6E7186', fontSize: '0.72rem', margin: '0.3rem 0 0' }}>{sub}</p>}
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', marginBottom: '0.7rem' }}>
        <h2 style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#9aa0b4', margin: 0 }}>{title}</h2>
        {hint && <p style={{ color: '#6E7186', fontSize: '0.74rem', margin: 0 }}>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.9rem', padding: '0.9rem 1.1rem' }}>
      <p style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6E7186', margin: '0 0 0.6rem' }}>{title}</p>
      {children}
    </div>
  )
}

function Row({ left, mid, right, warn }: { left: string; mid?: string; right?: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.8rem', padding: '0.4rem 0', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      <span style={{ fontSize: '0.84rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{left}</span>
      {mid ? <span style={{ color: '#6E7186', fontSize: '0.74rem', fontVariantNumeric: 'tabular-nums' }}>{mid}</span> : null}
      {right ? <span style={{ fontWeight: 700, fontSize: '0.84rem', fontVariantNumeric: 'tabular-nums', color: warn ? '#F59E0B' : '#E8EAF0' }}>{right}</span> : null}
    </div>
  )
}

function BarRow({ label, value, pct: p }: { label: string; value: string; pct: number | null }) {
  return (
    <div style={{ padding: '0.35rem 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
        <span style={{ textTransform: 'capitalize' }}>{label}</span>
        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}{p != null ? ` · ${p.toFixed(0)}%` : ''}</span>
      </div>
      <div style={{ height: '4px', background: 'rgba(255,255,255,0.06)', borderRadius: '999px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, p ?? 0))}%`, background: 'linear-gradient(90deg,#00D4B1,#6366F1)' }} />
      </div>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p style={{ color: '#6E7186', fontSize: '0.82rem', margin: 0 }}>{children}</p>
}

function Pill({ href, label, accent }: { href: string; label: string; accent: string }) {
  return (
    <Link href={href} style={{ padding: '0.5rem 0.95rem', borderRadius: '999px', background: `${accent}15`, border: `1px solid ${accent}33`, color: accent, fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>
      {label}
    </Link>
  )
}
