'use client'
// F&B Manager dashboard — kitchen + food scorecard.
//
// Audience: the Food & Beverage Manager (BOH + FOH) and CEO / GM. Question it
// answers: "is the food program healthy — are we fast, are we selling the
// right things, are we wasting stock, are guests happy with the food?"
// Mirrors the CEO dashboard's look; gated on the `fnb_dashboard` module.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { useViewAsRole } from '../../../store/viewAsRole'
import type { AppRole } from '../../../lib/appRoles'
import { isExecutive } from '../../../lib/appRoles'

type Period = 'today' | 'week' | 'month'

interface Concept { id: string; name: string; slug: string }

interface FnbMetrics {
  sales:    { grossCents: number; orders: number; aovCents: number | null }
  topItems: Array<{ rank: number; name: string; quantity: number; revenueCents: number }>
  kitchen:  { avgTicketMinutes: number | null; stations: Array<{ stationName: string; items: number; avgMinutes: number }> }
  quality:  {
    foodComplaints: number
    complaintsByCategory: Array<{ category: string; count: number }>
    avgRating: number | null
    reviewCount: number
  }
  stock: {
    lowStockCount: number
    lowStockItems: Array<{ name: string; currentStock: number; parLevel: number }>
    wasteCostCents: number
    wasteEvents: number
  }
}

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
  return `PKR ${Math.round(n).toLocaleString()}`
}
const dash = (c: number | null | undefined) => (c == null ? '—' : pkr(c))
const CAT_LABEL: Record<string, string> = { wrong_item: 'Wrong item', missing_item: 'Missing item', quality: 'Quality', service: 'Service', delivery: 'Delivery', other: 'Other' }

export default function FnbDashboardPage() {
  const router = useRouter()
  const [period, setPeriod] = useState<Period>('today')
  const [conceptId, setConceptId] = useState<string | null>(null)
  const range = useMemo(() => rangeFor(period), [period])

  const { data: me, isLoading: permsLoading } = usePermissions()
  const viewAsRole = useViewAsRole((s) => s.role)
  const overrides  = useRoleModules((s) => s.overrides)
  const canView = useMemo(() => {
    if (!me) return null
    const isSuper = isExecutive(me.role)
    if (isSuper && !viewAsRole) return true
    const role = (isSuper && viewAsRole ? viewAsRole : me.role) as AppRole
    return new Set(modulesForRole(role, overrides)).has('fnb_dashboard')
  }, [me, viewAsRole, overrides])
  useEffect(() => { if (canView === false) router.replace('/dashboard') }, [canView, router])

  const { data: concepts } = useQuery({
    queryKey: ['fnb-dash', 'concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
    enabled:  canView === true,
  })

  const q = useMemo(() => {
    const p = new URLSearchParams({ dateFrom: range.from, dateTo: range.to })
    if (conceptId) p.set('conceptId', conceptId)
    return p.toString()
  }, [range, conceptId])

  const { data: m } = useQuery({
    queryKey: ['fnb-dash', 'metrics', q],
    queryFn:  () => api.get<FnbMetrics>(`/management/fnb-metrics?${q}`),
    refetchInterval: 60_000,
    enabled:  canView === true,
  })

  if (permsLoading || canView === null) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#6E7186', padding: '4rem 1.4rem', textAlign: 'center', fontSize: '0.85rem' }}>Checking access…</main>
  }
  if (canView === false) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '4rem 1.4rem', textAlign: 'center' }}><p style={{ color: '#6E7186', fontSize: '0.85rem' }}>Restricted to the F&amp;B Manager. Redirecting…</p></main>
  }

  const brandName = conceptId ? (concepts?.find((c) => c.id === conceptId)?.name ?? 'Brand') : 'All brands'
  const lowStock = m?.stock.lowStockCount ?? 0

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '78rem', margin: '0 auto' }}>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <p style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', margin: 0 }}>Management · F&amp;B</p>
            <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>
              F&amp;B — {range.label}
            </h1>
            <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
              {brandName} · kitchen throughput, menu, food cost &amp; quality.
            </p>
          </div>
          <PeriodSwitcher value={period} onChange={setPeriod} />
        </div>

        <BrandSwitcher concepts={concepts ?? []} value={conceptId} onChange={setConceptId} />

        {/* Hero */}
        <div style={{ marginTop: '1.2rem', display: 'grid', gap: '0.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Scorecard label="Sales"        value={dash(m?.sales.grossCents)} accent="#00D4B1" sub={`incl. GST · ${(m?.sales.orders ?? 0).toLocaleString()} orders`} />
          <Scorecard label="Avg ticket"   value={dash(m?.sales.aovCents)}   accent="#4F8EF7" sub="per order" />
          <Scorecard label="Kitchen speed" value={m?.kitchen.avgTicketMinutes != null ? `${m.kitchen.avgTicketMinutes} min` : '—'} accent="#A855F7" sub="fire → bump avg" />
          <Scorecard label="Food complaints" value={(m?.quality.foodComplaints ?? 0).toLocaleString()} accent={(m?.quality.foodComplaints ?? 0) > 0 ? '#FF4D4F' : '#F59E0B'} sub="quality · wrong · missing" />
        </div>

        {/* Top sellers */}
        <Section title="Top sellers" hint={`top items — ${range.label}`}>
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {(m?.topItems ?? []).length === 0 && <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.85rem', margin: 0 }}>No items sold {range.label}.</p>}
            {(m?.topItems ?? []).map((it, i) => (
              <div key={`${it.name}-${i}`} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0.8rem 1.1rem', borderTop: i === 0 ? 'none' : '1px solid #1d222b' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', minWidth: 0 }}>
                  <span style={{ color: '#6E7186', fontVariantNumeric: 'tabular-nums', fontSize: '0.78rem', width: '1.2rem' }}>{it.rank}.</span>
                  <span style={{ fontSize: '0.95rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.4rem', flexShrink: 0 }}>
                  <span style={{ color: '#6E7186', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>{it.quantity} sold</span>
                  <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{pkr(it.revenueCents)}</span>
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* Kitchen stations */}
        <Section title="Kitchen — station times" hint="avg fire → bump per station">
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {(m?.kitchen.stations ?? []).length === 0 && <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.85rem', margin: 0 }}>No completed tickets {range.label}.</p>}
            {(m?.kitchen.stations ?? []).map((s, i) => {
              const slow = s.avgMinutes >= 12
              return (
                <div key={s.stationName + i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0.8rem 1.1rem', borderTop: i === 0 ? 'none' : '1px solid #1d222b' }}>
                  <span style={{ fontSize: '0.95rem' }}>{s.stationName}</span>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '1.4rem' }}>
                    <span style={{ color: '#6E7186', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums' }}>{s.items} items</span>
                    <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: slow ? '#FF4D4F' : '#22C55E' }}>{s.avgMinutes} min</span>
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        {/* Stock + waste */}
        <Section title="Stock health" hint="low stock + waste cost">
          <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <MiniStat label="Low stock items" value={lowStock.toLocaleString()} accent={lowStock > 0 ? '#F59E0B' : undefined} />
            <MiniStat label="Waste cost"   value={dash(m?.stock.wasteCostCents)} sub={`${(m?.stock.wasteEvents ?? 0)} events · ${range.label}`} accent={(m?.stock.wasteCostCents ?? 0) > 0 ? '#FF4D4F' : undefined} />
            <MiniStat label="Avg food rating" value={m?.quality.avgRating != null ? `${m.quality.avgRating.toFixed(1)} ★` : '—'} sub={`${m?.quality.reviewCount ?? 0} reviews`} />
          </div>
          {(m?.stock.lowStockItems ?? []).length > 0 && (
            <div style={{ marginTop: '0.7rem', borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
              {(m?.stock.lowStockItems ?? []).map((it, i) => (
                <div key={it.name + i} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0.7rem 1.1rem', borderTop: i === 0 ? 'none' : '1px solid #1d222b' }}>
                  <span style={{ fontSize: '0.9rem' }}>{it.name}</span>
                  <span style={{ color: '#F59E0B', fontSize: '0.82rem', fontVariantNumeric: 'tabular-nums' }}>{it.currentStock} / {it.parLevel} par</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Complaints breakdown */}
        {(m?.quality.complaintsByCategory ?? []).length > 0 && (
          <Section title="Complaints by type" hint={range.label}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
              {(m?.quality.complaintsByCategory ?? []).map((c) => (
                <div key={c.category} style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.7rem', padding: '0.6rem 0.9rem' }}>
                  <span style={{ color: '#9aa0b4', fontSize: '0.78rem' }}>{CAT_LABEL[c.category] ?? c.category}</span>
                  <span style={{ marginLeft: '0.6rem', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{c.count}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="Where to dig" hint="link out">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/menu"       label="Menu editor →"   accent="#A855F7" />
            <Pill href="/inventory"  label="Inventory →"     accent="#F59E0B" />
            <Pill href="/kds"        label="Kitchen view →"  accent="#00D4B1" />
            <Pill href="/reports"    label="Full reports →"  accent="#4F8EF7" />
            <Pill href="/complaints" label="Complaints →"    accent="#FF4D4F" />
          </div>
        </Section>
      </div>
    </main>
  )
}

// ── shared UI (mirrors the CEO dashboard) ────────────────────────────────────
function PeriodSwitcher({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const opts: { id: Period; label: string }[] = [{ id: 'today', label: 'Today' }, { id: 'week', label: '7 days' }, { id: 'month', label: 'Month' }]
  return (
    <div style={{ display: 'inline-flex', background: '#11151c', border: '1px solid #1d222b', borderRadius: '999px', padding: '0.2rem' }}>
      {opts.map((o) => {
        const on = o.id === value
        return (
          <button key={o.id} onClick={() => onChange(o.id)}
            style={{ padding: '0.4rem 0.95rem', fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.05em', borderRadius: '999px', background: on ? '#00D4B1' : 'transparent', color: on ? '#0a0d12' : '#9aa0b4', border: 'none', cursor: 'pointer' }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function BrandSwitcher({ concepts, value, onChange }: { concepts: Concept[]; value: string | null; onChange: (id: string | null) => void }) {
  const all = [{ id: null as string | null, name: 'All brands' }, ...concepts.map((c) => ({ id: c.id as string | null, name: c.name }))]
  return (
    <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      {all.map((b) => {
        const on = b.id === value
        return (
          <button key={b.id ?? 'all'} onClick={() => onChange(b.id)}
            style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '999px', cursor: 'pointer',
              background: on ? '#1d2433' : 'transparent', color: on ? '#E8EAF0' : '#9aa0b4', border: `1px solid ${on ? '#2d3650' : '#1d222b'}` }}>
            {b.name}
          </button>
        )
      })}
    </div>
  )
}

function Scorecard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  return (
    <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '1rem', padding: '1.1rem 1.2rem', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: accent, opacity: 0.7 }} />
      <p style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#6E7186', margin: 0 }}>{label}</p>
      <p style={{ fontSize: 'clamp(1.4rem, 2.8vw, 1.8rem)', fontWeight: 800, letterSpacing: '-0.02em', margin: '0.55rem 0 0', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
      <p style={{ color: '#6E7186', fontSize: '0.74rem', margin: '0.35rem 0 0' }}>{sub}</p>
    </div>
  )
}

function MiniStat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.85rem', padding: '0.9rem 1rem' }}>
      <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#6E7186', margin: 0 }}>{label}</p>
      <p style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0.4rem 0 0', fontVariantNumeric: 'tabular-nums', color: accent ?? '#E8EAF0' }}>{value}</p>
      {sub && <p style={{ color: '#6E7186', fontSize: '0.7rem', margin: '0.25rem 0 0' }}>{sub}</p>}
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

function Pill({ href, label, accent }: { href: string; label: string; accent: string }) {
  return (
    <Link href={href} style={{ padding: '0.5rem 0.95rem', borderRadius: '999px', background: `${accent}15`, border: `1px solid ${accent}33`, color: accent, fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>
      {label}
    </Link>
  )
}
