'use client'
// Brand Manager dashboard — marketing-finance scorecard.
//
// Audience: the Brand Manager (and CEO / GM). Question it answers: "is our
// marketing working — what does a customer cost, what are they worth, what's
// the return on spend?" Mirrors the CEO dashboard's look; gated on the
// `brand_dashboard` module.
//
// CAC / CRC / ROAS require a spend input that order data can't provide, so the
// manager enters monthly spend (acquisition vs. retention) right here; the
// /management/brand-metrics endpoint pro-rates it across the selected period.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { useViewAsRole } from '../../../store/viewAsRole'
import type { AppRole } from '../../../lib/appRoles'

type Period = 'today' | 'week' | 'month'

interface Concept { id: string; name: string; slug: string }

interface BrandMetrics {
  revenue:   { grossCents: number; netCents: number; orders: number }
  customers: { distinct: number; new: number; returning: number }
  spend:     { acquisitionCents: number; retentionCents: number }
  kpis: {
    aovCents:  number | null
    arpuCents: number | null
    ltvCents:  number
    cacCents:  number | null
    crcCents:  number | null
    roas:      number | null
  }
  reputation: { avgRating: number | null; reviewCount: number; openComplaints: number }
}

interface SpendRow { conceptId: string; month: string; acquisitionCents: number; retentionCents: number; note: string | null }

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
const roasFmt = (r: number | null) => (r == null ? '—' : `${r.toFixed(1)}×`)
const curMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }

export default function BrandDashboardPage() {
  const router = useRouter()
  const [period, setPeriod] = useState<Period>('month')
  const [conceptId, setConceptId] = useState<string | null>(null)   // null = all brands
  const range = useMemo(() => rangeFor(period), [period])

  // Module gate — same pattern as the CEO dashboard.
  const { data: me, isLoading: permsLoading } = usePermissions()
  const viewAsRole = useViewAsRole((s) => s.role)
  const overrides  = useRoleModules((s) => s.overrides)
  const canView = useMemo(() => {
    if (!me) return null
    const isSuper = me.role === 'admin'
    if (isSuper && !viewAsRole) return true
    const role = (isSuper && viewAsRole ? viewAsRole : me.role) as AppRole
    return new Set(modulesForRole(role, overrides)).has('brand_dashboard')
  }, [me, viewAsRole, overrides])
  useEffect(() => { if (canView === false) router.replace('/dashboard') }, [canView, router])

  const { data: concepts } = useQuery({
    queryKey: ['brand-dash', 'concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
    enabled:  canView === true,
  })

  const q = useMemo(() => {
    const p = new URLSearchParams({ dateFrom: range.from, dateTo: range.to })
    if (conceptId) p.set('conceptId', conceptId)
    return p.toString()
  }, [range, conceptId])

  const { data: m } = useQuery({
    queryKey: ['brand-dash', 'metrics', q],
    queryFn:  () => api.get<BrandMetrics>(`/management/brand-metrics?${q}`),
    refetchInterval: 120_000,
    enabled:  canView === true,
  })

  if (permsLoading || canView === null) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#6E7186', padding: '4rem 1.4rem', textAlign: 'center', fontSize: '0.85rem' }}>Checking access…</main>
  }
  if (canView === false) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '4rem 1.4rem', textAlign: 'center' }}><p style={{ color: '#6E7186', fontSize: '0.85rem' }}>Restricted to the Brand Manager. Redirecting…</p></main>
  }

  const k = m?.kpis
  const rep = m?.reputation
  const brandName = conceptId ? (concepts?.find((c) => c.id === conceptId)?.name ?? 'Brand') : 'All brands'

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '78rem', margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <p style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', margin: 0 }}>Management · Brand</p>
            <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>
              Brand — {range.label}
            </h1>
            <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
              {brandName} · acquisition, retention &amp; return on spend.
            </p>
          </div>
          <PeriodSwitcher value={period} onChange={setPeriod} />
        </div>

        {/* Brand switcher */}
        <BrandSwitcher concepts={concepts ?? []} value={conceptId} onChange={setConceptId} />

        {/* Hero KPIs */}
        <div style={{ marginTop: '1.2rem', display: 'grid', gap: '0.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Scorecard label="ROAS"  value={roasFmt(k?.roas ?? null)}  accent="#00D4B1" sub="return on ad spend" />
          <Scorecard label="CAC"   value={dash(k?.cacCents)}          accent="#4F8EF7" sub="cost to acquire" />
          <Scorecard label="ARPU"  value={dash(k?.arpuCents)}         accent="#A855F7" sub="revenue / active user" />
          <Scorecard label="AOV"   value={dash(k?.aovCents)}          accent="#F59E0B" sub="avg order value" />
        </div>
        <div style={{ marginTop: '0.8rem', display: 'grid', gap: '0.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Scorecard label="LTV"   value={dash(k?.ltvCents)}          accent="#22C55E" sub="avg lifetime spend" />
          <Scorecard label="CRC"   value={dash(k?.crcCents)}          accent="#6366F1" sub="cost to retain" />
          <Scorecard label="New customers"       value={(m?.customers.new ?? 0).toLocaleString()}       accent="#00D4B1" sub={`${range.label}`} />
          <Scorecard label="Returning customers" value={(m?.customers.returning ?? 0).toLocaleString()} accent="#F59E0B" sub={`${range.label}`} />
        </div>

        {/* Revenue + customers strip */}
        <Section title="This period" hint={range.label}>
          <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <MiniStat label="Revenue"  value={dash(m?.revenue.grossCents)} />
            <MiniStat label="Orders"   value={(m?.revenue.orders ?? 0).toLocaleString()} />
            <MiniStat label="Active customers" value={(m?.customers.distinct ?? 0).toLocaleString()} />
            <MiniStat label="Acquisition spend" value={dash(m?.spend.acquisitionCents)} />
            <MiniStat label="Retention spend"   value={dash(m?.spend.retentionCents)} />
          </div>
        </Section>

        {/* Spend editor — the input that powers CAC / CRC / ROAS */}
        <SpendEditor conceptId={conceptId} concepts={concepts ?? []} />

        {/* Reputation */}
        <Section title="Reputation" hint="reviews + open complaints">
          <div style={{ display: 'grid', gap: '0.7rem', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
            <MiniStat label="Avg rating" value={rep?.avgRating != null ? `${rep.avgRating.toFixed(1)} ★` : '—'} />
            <MiniStat label="Reviews"    value={(rep?.reviewCount ?? 0).toLocaleString()} sub={range.label} />
            <MiniStat label="Open complaints" value={(rep?.openComplaints ?? 0).toLocaleString()} accent={(rep?.openComplaints ?? 0) > 0 ? '#FF4D4F' : undefined} />
          </div>
        </Section>

        {/* Footer pills */}
        <Section title="Where to dig" hint="link out">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/crm"        label="Customer base →" accent="#6366F1" />
            <Pill href="/reviews"    label="Reviews →"       accent="#00D4B1" />
            <Pill href="/complaints" label="Complaints →"    accent="#FF4D4F" />
            <Pill href="/marketing"  label="Campaigns & promos →" accent="#A855F7" />
            <Pill href="/marketing/activity" label="Marketing activity →" accent="#F59E0B" />
          </div>
        </Section>
      </div>
    </main>
  )
}

// ── Spend editor ──────────────────────────────────────────────────────────────
function SpendEditor({ conceptId, concepts }: { conceptId: string | null; concepts: Concept[] }) {
  const qc = useQueryClient()
  const month = curMonth()
  const [acq, setAcq] = useState('')
  const [ret, setRet] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const { data: row } = useQuery({
    queryKey: ['brand-dash', 'spend', conceptId, month],
    queryFn:  () => api.get<SpendRow>(`/management/marketing-spend?conceptId=${conceptId}&month=${month}`),
    enabled:  !!conceptId,
  })
  useEffect(() => {
    setAcq(row ? String((row.acquisitionCents ?? 0) / 100) : '')
    setRet(row ? String((row.retentionCents ?? 0) / 100) : '')
  }, [row, conceptId])

  if (!conceptId) {
    return (
      <Section title="Marketing spend" hint="powers CAC · CRC · ROAS">
        <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.9rem', padding: '1.1rem 1.2rem', color: '#9aa0b4', fontSize: '0.85rem' }}>
          Pick a single brand above to enter or edit its monthly spend. Spend is tracked per brand; the all-brands view sums them.
        </div>
      </Section>
    )
  }

  async function save() {
    setBusy(true); setMsg(null)
    try {
      await api.put('/management/marketing-spend', {
        conceptId, month,
        acquisitionCents: Math.round((parseFloat(acq) || 0) * 100),
        retentionCents:   Math.round((parseFloat(ret) || 0) * 100),
      })
      setMsg('Saved')
      void qc.invalidateQueries({ queryKey: ['brand-dash'] })
      setTimeout(() => setMsg(null), 2500)
    } catch (e) { setMsg((e as Error).message) }
    finally { setBusy(false) }
  }

  const brandName = concepts.find((c) => c.id === conceptId)?.name ?? 'this brand'
  const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })

  return (
    <Section title="Marketing spend" hint={`${brandName} · ${monthLabel} · powers CAC · CRC · ROAS`}>
      <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.9rem', padding: '1.1rem 1.2rem' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.9rem' }}>
          <SpendField label="Acquisition spend (PKR)" hint="ads, discovery → new customers (drives CAC)" value={acq} onChange={setAcq} />
          <SpendField label="Retention spend (PKR)"   hint="CRM, loyalty, win-back → existing (drives CRC)" value={ret} onChange={setRet} />
        </div>
        <div style={{ marginTop: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button onClick={() => void save()} disabled={busy}
            style={{ padding: '0.55rem 1.2rem', borderRadius: '0.6rem', background: '#00D4B1', color: '#0a0a0a', fontWeight: 700, fontSize: '0.85rem', border: 'none', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Saving…' : `Save spend for ${monthLabel}`}
          </button>
          {msg && <span style={{ color: msg === 'Saved' ? '#22C55E' : '#FF4D4F', fontSize: '0.8rem', fontWeight: 600 }}>{msg}</span>}
        </div>
        <p style={{ color: '#6E7186', fontSize: '0.72rem', margin: '0.7rem 0 0', lineHeight: 1.45 }}>
          Spend is entered per calendar month. The KPIs above pro-rate it to the period you&rsquo;ve selected (a 7-day view uses 7/30 of the month).
        </p>
      </div>
    </Section>
  )
}

function SpendField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#9aa0b4' }}>{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder="0"
        style={{ background: '#0a0d12', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '0.45rem', padding: '0.55rem 0.7rem', color: '#E8EAF0', fontSize: '0.95rem', fontVariantNumeric: 'tabular-nums', outline: 'none' }} />
      <span style={{ fontSize: '0.68rem', color: '#6E7186', lineHeight: 1.35 }}>{hint}</span>
    </label>
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
              background: on ? '#1d2433' : 'transparent', color: on ? '#E8EAF0' : '#9aa0b4',
              border: `1px solid ${on ? '#2d3650' : '#1d222b'}` }}>
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
