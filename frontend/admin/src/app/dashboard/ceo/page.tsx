'use client'
// CEO Dashboard — daily-cadence scorecard. Numbers, not live ops.
//
// Audience: ownership. Question it answers: "is the business healthy
// today / this week?" Not "is the kitchen on fire right now?" — that's
// /dashboard/boh.
//
// Period switcher (Today/Week/Month) drives every tile. Per-brand grid
// uses the same /reports/sales endpoint scoped by conceptId so the
// numbers reconcile with /reports.

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

interface SalesTotals {
  totals: { gross: number; net: number; tax: number; commission: number; orders: number }
}
interface Concept    { id: string; name: string; slug: string }
interface SmartSeg   { summary: { totalCustomers: number; repeatRate: number } }
interface TopItem    { name: string; quantity: number; revenue: number }
interface TopResp    { items: TopItem[] }

function rangeFor(period: Period): { from: string; to: string; label: string } {
  const now = new Date()
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate()
  const pad = (n: number) => String(n).padStart(2, '0')
  const iso = (dt: Date) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`
  if (period === 'today') {
    const s = iso(now)
    return { from: `${s}T00:00:00Z`, to: `${s}T23:59:59Z`, label: 'today' }
  }
  if (period === 'week') {
    const start = new Date(y, m, d - 6)
    return { from: `${iso(start)}T00:00:00Z`, to: `${iso(now)}T23:59:59Z`, label: 'last 7 days' }
  }
  const start = new Date(y, m, 1)
  return { from: `${iso(start)}T00:00:00Z`, to: `${iso(now)}T23:59:59Z`, label: 'this month' }
}

function pkr(cents: number): string {
  const n = cents / 100
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000)    return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${n.toLocaleString()}`
}

export default function CeoDashboardPage() {
  const router = useRouter()
  const [period, setPeriod] = useState<Period>('today')
  const range = useMemo(() => rangeFor(period), [period])

  // Module gate — mirror the chooser + AppShell logic. The CEO dashboard
  // exposes revenue, margin, AOV, repeat-rate per brand; only roles with
  // `ceo_overview` in their module map should reach it, even by typing the
  // URL directly. Real admin (CEO) always passes unless impersonating.
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

  useEffect(() => {
    if (canViewCeo === false) router.replace('/dashboard')
  }, [canViewCeo, router])

  const { data: concepts } = useQuery({
    queryKey: ['ceo', 'concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
    enabled:  canViewCeo === true,
  })

  const { data: sales } = useQuery({
    queryKey: ['ceo', 'sales', range.from, range.to],
    queryFn:  () => api.get<SalesTotals>(`/reports/sales?dateFrom=${range.from}&dateTo=${range.to}`),
    refetchInterval: 60_000,
    enabled:  canViewCeo === true,
  })

  const { data: top } = useQuery({
    queryKey: ['ceo', 'top-items', range.from, range.to],
    queryFn:  () => api.get<TopResp>(`/reports/top-items?dateFrom=${range.from}&dateTo=${range.to}&limit=5`),
    refetchInterval: 120_000,
    enabled:  canViewCeo === true,
  })

  const { data: segments } = useQuery({
    queryKey: ['ceo', 'segments'],
    queryFn:  () => api.get<SmartSeg>('/crm/smart-segments'),
    refetchInterval: 300_000,
    enabled:  canViewCeo === true,
  })

  if (permsLoading || canViewCeo === null) {
    return (
      <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#6E7186', padding: '4rem 1.4rem', textAlign: 'center', fontSize: '0.85rem' }}>
        Checking access…
      </main>
    )
  }
  if (canViewCeo === false) {
    return (
      <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '4rem 1.4rem', textAlign: 'center' }}>
        <p style={{ color: '#6E7186', fontSize: '0.85rem' }}>This view is restricted to ownership. Redirecting…</p>
      </main>
    )
  }

  const totals     = sales?.totals
  const gross      = totals?.gross ?? 0
  const orders     = totals?.orders ?? 0
  const aov        = orders > 0 ? Math.round(gross / orders) : 0
  const repeatPct  = segments?.summary.repeatRate ?? 0

  // Prime cost lands when COGS is wired through Recipes -> FinancialEntry
  // properly. For now we tag it as "—" so it doesn't lie.

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '78rem', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <Link href="/dashboard" style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', textDecoration: 'none' }}>
              ← all dashboards
            </Link>
            <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>
              CEO — {range.label}
            </h1>
            <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
              How the business is doing. Numbers reconcile with Reports.
            </p>
          </div>
          <PeriodSwitcher value={period} onChange={setPeriod} />
        </div>

        {/* Hero scorecards */}
        <div style={{
          marginTop: '1.6rem', display: 'grid', gap: '0.8rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        }}>
          <Scorecard label="Revenue"     value={pkr(gross)}          accent="#00D4B1" sub={`${orders} orders`} />
          <Scorecard label="Avg ticket"  value={pkr(aov)}            accent="#4F8EF7" sub="per order"          />
          <Scorecard label="Repeat rate" value={`${Math.round(repeatPct * 100)}%`} accent="#A855F7" sub="of customers" />
          <Scorecard label="Prime cost"  value="—"                   accent="#F59E0B" sub="needs recipe COGS"   />
        </div>

        {/* Marketing & growth — CAC / CRC / ROAS / ARPU / LTV. Same numbers
            the Brand Manager owns; surfaced here for ownership. Spend is
            entered under Management → Marketing Spend. */}
        <MarketingGrowthSection from={range.from} to={range.to} />

        {/* Per-brand grid */}
        <Section title="By brand" hint="same period, scoped per brand">
          <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {(concepts ?? []).map((c) => (
              <BrandCard key={c.id} concept={c} from={range.from} to={range.to} />
            ))}
            {concepts && concepts.length === 0 && (
              <p style={{ color: '#6E7186', fontSize: '0.85rem' }}>No brands yet.</p>
            )}
          </div>
        </Section>

        {/* Top items */}
        <Section title="Top sellers" hint={`top 5 — ${range.label}`}>
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {(top?.items ?? []).length === 0 && (
              <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.85rem', margin: 0 }}>
                No items sold {range.label}.
              </p>
            )}
            {(top?.items ?? []).map((it, i) => (
              <div key={`${it.name}-${i}`} style={{
                display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                padding: '0.85rem 1.1rem',
                borderTop: i === 0 ? 'none' : '1px solid #1d222b',
              }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', minWidth: 0 }}>
                  <span style={{ color: '#6E7186', fontVariantNumeric: 'tabular-nums', fontSize: '0.78rem', width: '1.2rem' }}>
                    {i + 1}.
                  </span>
                  <span style={{ fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.name}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.4rem', flexShrink: 0 }}>
                  <span style={{ color: '#6E7186', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>
                    {it.quantity} sold
                  </span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {pkr(it.revenue)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Footer signals */}
        <Section title="Where to dig" hint="link out — not a metric">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/reports"           label="Full reports →"        accent="#00D4B1" />
            <Pill href="/accounting"        label="Accounting →"           accent="#00D4B1" />
            <Pill href="/crm"               label="Customer base →"        accent="#6366F1" />
            <Pill href="/inventory"         label="Inventory levels →"     accent="#F59E0B" />
            <Pill href="/menu"              label="Menu editor →"          accent="#A855F7" />
          </div>
        </Section>
      </div>
    </main>
  )
}

// ── Marketing & growth section ───────────────────────────────────────────────
// Pulls the same marketing-finance KPIs the Brand Manager owns (all brands,
// current period) and surfaces them on the CEO dashboard. CAC / CRC / ROAS show
// "—" until spend is entered under Management → Marketing Spend.
interface GrowthMetrics {
  customers: { distinct: number; new: number; returning: number }
  spend:     { acquisitionCents: number; retentionCents: number }
  kpis: {
    aovCents: number | null; arpuCents: number | null; ltvCents: number
    cacCents: number | null; crcCents: number | null; roas: number | null
  }
}

function MarketingGrowthSection({ from, to }: { from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ['ceo', 'growth', from, to],
    queryFn:  () => api.get<GrowthMetrics>(`/management/brand-metrics?dateFrom=${from}&dateTo=${to}`),
    refetchInterval: 120_000,
  })
  const k = data?.kpis
  const dash = (c: number | null | undefined) => (c == null ? '—' : pkr(c))
  const roas = k?.roas == null ? '—' : `${k.roas.toFixed(1)}×`
  const hasSpend = (data?.spend.acquisitionCents ?? 0) + (data?.spend.retentionCents ?? 0) > 0

  return (
    <Section
      title="Marketing & growth"
      hint={hasSpend ? 'acquisition, retention & return on spend' : 'enter spend → Management · Marketing Spend'}
    >
      <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Scorecard label="ROAS"  value={roas}             accent="#00D4B1" sub="return on ad spend" />
        <Scorecard label="CAC"   value={dash(k?.cacCents)} accent="#4F8EF7" sub="cost to acquire" />
        <Scorecard label="CRC"   value={dash(k?.crcCents)} accent="#6366F1" sub="cost to retain" />
        <Scorecard label="ARPU"  value={dash(k?.arpuCents)} accent="#A855F7" sub="revenue / user" />
        <Scorecard label="LTV"   value={dash(k?.ltvCents)} accent="#22C55E" sub="lifetime spend" />
      </div>
      <div style={{ marginTop: '0.7rem', display: 'flex', gap: '1.4rem', flexWrap: 'wrap', color: '#6E7186', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
        <span><span style={{ color: '#9aa0b4' }}>{(data?.customers.new ?? 0).toLocaleString()}</span> new customers</span>
        <span><span style={{ color: '#9aa0b4' }}>{(data?.customers.returning ?? 0).toLocaleString()}</span> returning</span>
        <span><span style={{ color: '#9aa0b4' }}>{dash(data?.spend.acquisitionCents)}</span> acquisition spend</span>
        <span><span style={{ color: '#9aa0b4' }}>{dash(data?.spend.retentionCents)}</span> retention spend</span>
      </div>
    </Section>
  )
}

function PeriodSwitcher({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const opts: { id: Period; label: string }[] = [
    { id: 'today', label: 'Today' },
    { id: 'week',  label: '7 days' },
    { id: 'month', label: 'Month' },
  ]
  return (
    <div style={{ display: 'inline-flex', background: '#11151c', border: '1px solid #1d222b', borderRadius: '999px', padding: '0.2rem' }}>
      {opts.map((o) => {
        const on = o.id === value
        return (
          <button key={o.id} onClick={() => onChange(o.id)}
            style={{
              padding: '0.4rem 0.95rem',
              fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.05em',
              borderRadius: '999px',
              background: on ? '#00D4B1' : 'transparent',
              color: on ? '#0a0d12' : '#9aa0b4',
              border: 'none', cursor: 'pointer',
            }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Scorecard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{
      background: '#11151c',
      border: '1px solid #1d222b',
      borderRadius: '1rem',
      padding: '1.1rem 1.2rem',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: accent, opacity: 0.7 }} />
      <p style={{
        fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.28em',
        textTransform: 'uppercase', color: '#6E7186', margin: 0,
      }}>{label}</p>
      <p style={{
        fontSize: 'clamp(1.4rem, 2.8vw, 1.8rem)',
        fontWeight: 800, letterSpacing: '-0.02em',
        margin: '0.55rem 0 0',
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</p>
      <p style={{ color: '#6E7186', fontSize: '0.74rem', margin: '0.35rem 0 0' }}>{sub}</p>
    </div>
  )
}

function BrandCard({ concept, from, to }: { concept: Concept; from: string; to: string }) {
  const { data } = useQuery({
    queryKey: ['ceo', 'brand-sales', concept.id, from, to],
    queryFn:  () => api.get<SalesTotals>(`/reports/sales?conceptId=${concept.id}&dateFrom=${from}&dateTo=${to}`),
    refetchInterval: 90_000,
  })
  const t = data?.totals
  const gross = t?.gross ?? 0
  const orders = t?.orders ?? 0
  const aov = orders > 0 ? Math.round(gross / orders) : 0
  return (
    <Link href={`/reports?conceptId=${concept.id}`} style={{
      display: 'block', textDecoration: 'none', color: 'inherit',
      background: '#11151c', border: '1px solid #1d222b',
      borderRadius: '1rem', padding: '1rem 1.15rem',
    }}>
      <p style={{ fontSize: '0.85rem', fontWeight: 700, margin: 0 }}>{concept.name}</p>
      <p style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0.5rem 0 0', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.01em' }}>
        {pkr(gross)}
      </p>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.45rem', color: '#6E7186', fontSize: '0.74rem', fontVariantNumeric: 'tabular-nums' }}>
        <span>{orders} orders</span>
        <span>·</span>
        <span>{pkr(aov)} AOV</span>
      </div>
    </Link>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', marginBottom: '0.7rem' }}>
        <h2 style={{
          fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.28em',
          textTransform: 'uppercase', color: '#9aa0b4', margin: 0,
        }}>{title}</h2>
        {hint && <p style={{ color: '#6E7186', fontSize: '0.74rem', margin: 0 }}>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

function Pill({ href, label, accent }: { href: string; label: string; accent: string }) {
  return (
    <Link href={href} style={{
      padding: '0.5rem 0.95rem',
      borderRadius: '999px',
      background: `${accent}15`,
      border: `1px solid ${accent}33`,
      color: accent,
      fontSize: '0.78rem', fontWeight: 700,
      textDecoration: 'none',
    }}>
      {label}
    </Link>
  )
}
