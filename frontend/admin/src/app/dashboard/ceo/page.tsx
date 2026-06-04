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

        {/* Brand info — the NAP + cuisine + price-tier rows the storefront
            uses for schema.org JSON-LD, Maps link, footer, /locations geo
            pages. Editing here updates the live customer-facing surfaces
            (Google rich results, brand microsite footer, /press contact)
            so the operator never needs a code deploy to fix a wrong
            number on Google or change the displayed neighbourhood. */}
        <BrandInfoSection />

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

// ─── BrandInfoSection ────────────────────────────────────────────────────────
// Per-brand "real info" editor — phone, WhatsApp, street, locality, geo,
// cuisine, price tier, reservations toggle. Saves via PATCH /concepts/:id
// (the same endpoint admin already uses for everything else on a concept).
// Inline edits, optimistic local state, save button per brand. Kept on the
// CEO dashboard so the operator who edits financial scorecards can also fix
// a wrong phone on Google in two clicks without leaving the page.

interface ConceptRow {
  id:               string
  name:             string
  slug:             string
  phone:            string | null
  whatsapp:         string | null
  address:          string | null
  addressLocality:  string | null
  latitude:         number | null
  longitude:        number | null
  cuisine:          string | null
  priceTier:        string | null
  reservationsEnabled: boolean
}

function BrandInfoSection() {
  const { data: concepts, refetch } = useQuery<ConceptRow[]>({
    queryKey: ['ceo', 'concepts', 'brand-info'],
    queryFn:  () => api.get<ConceptRow[]>('/concepts'),
  })

  if (!concepts || concepts.length === 0) {
    return (
      <Section title="Business info" hint="phone, address, geo per brand">
        <p style={{ color: '#6E7186', fontSize: '0.85rem', margin: 0 }}>
          No concepts found.
        </p>
      </Section>
    )
  }

  return (
    <Section title="Business info" hint="edits flow to schema.org, Maps, footer, /press, /locations">
      <div style={{ display: 'grid', gap: '0.85rem' }}>
        {concepts.map((c) => (
          <BrandInfoCard key={c.id} concept={c} onSaved={() => void refetch()} />
        ))}
      </div>
    </Section>
  )
}

function BrandInfoCard({ concept, onSaved }: { concept: ConceptRow; onSaved: () => void }) {
  const [open, setOpen]       = useState(false)
  const [draft, setDraft]     = useState<ConceptRow>(concept)
  const [busy, setBusy]       = useState(false)
  const [msg, setMsg]         = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Reset draft whenever the parent's concept identity changes (refetch).
  useEffect(() => { setDraft(concept) }, [concept.id])

  const dirty = JSON.stringify(draft) !== JSON.stringify(concept)

  async function save() {
    setBusy(true); setMsg(null)
    try {
      // Send only the fields this editor owns. PATCH /concepts/:id will
      // ignore unknown keys via zod's .partial() schema.
      await api.patch(`/concepts/${concept.id}`, {
        phone:           draft.phone           || null,
        whatsapp:        draft.whatsapp        || null,
        address:         draft.address         || null,
        addressLocality: draft.addressLocality || null,
        latitude:        draft.latitude,
        longitude:       draft.longitude,
        cuisine:         draft.cuisine         || null,
        priceTier:       draft.priceTier       || null,
        reservationsEnabled: draft.reservationsEnabled,
      })
      setMsg({ kind: 'ok', text: 'Saved' })
      onSaved()
      setTimeout(() => setMsg(null), 2500)
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      background: '#161a24',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '0.85rem',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%', textAlign: 'left',
          display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '0.75rem',
          alignItems: 'center',
          padding: '0.95rem 1.1rem',
          background: 'transparent', border: 'none', color: 'inherit',
          cursor: 'pointer',
        }}
      >
        <div>
          <p style={{ fontWeight: 700, fontSize: '0.98rem', margin: 0, color: '#E8EAF0' }}>
            {concept.name}
          </p>
          <p style={{ color: '#6E7186', fontSize: '0.78rem', margin: '0.2rem 0 0' }}>
            {concept.addressLocality ?? concept.address ?? 'no address set'} · {concept.phone ?? 'no phone'}
          </p>
        </div>
        <span style={{
          fontSize: '0.68rem', fontWeight: 700,
          color: filled(concept) === 'all' ? '#22C55E' : filled(concept) === 'some' ? '#F59E0B' : '#EF4444',
          background: filled(concept) === 'all' ? 'rgba(34,197,94,0.10)' : filled(concept) === 'some' ? 'rgba(245,158,11,0.10)' : 'rgba(239,68,68,0.10)',
          padding: '0.2rem 0.5rem', borderRadius: '999px',
          letterSpacing: '0.12em', textTransform: 'uppercase',
        }}>
          {filled(concept) === 'all' ? 'Complete' : filled(concept) === 'some' ? 'Partial' : 'Empty'}
        </span>
        <span aria-hidden style={{ color: '#6E7186', fontSize: '0.85rem' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0.5rem 1.1rem 1.1rem', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
            <Field label="Phone (E.164)"
              value={draft.phone ?? ''} placeholder="+923001234567"
              onChange={(v) => setDraft((d) => ({ ...d, phone: v }))}
              hint="The number Google + foodpanda list. Keep byte-identical with GBP." />
            <Field label="WhatsApp (digits only)"
              value={draft.whatsapp ?? ''} placeholder="923001234567"
              onChange={(v) => setDraft((d) => ({ ...d, whatsapp: v }))}
              hint="wa.me/<this>. No +, no spaces. Falls back to phone digits if blank." />
            <Field label="Street address"
              value={draft.address ?? ''} placeholder="Shop 12, ground floor, …"
              onChange={(v) => setDraft((d) => ({ ...d, address: v }))}
              hint="Street line only. Area goes in the next field." />
            <Field label="Area / neighbourhood"
              value={draft.addressLocality ?? ''} placeholder="Bukhari Commercial, DHA Phase 6"
              onChange={(v) => setDraft((d) => ({ ...d, addressLocality: v }))}
              hint="The locality shown in the storefront pill and Maps title." />
            <Field label="Latitude"
              value={draft.latitude == null ? '' : String(draft.latitude)}
              placeholder="24.8054"
              onChange={(v) => setDraft((d) => ({ ...d, latitude: v === '' ? null : parseFloat(v) }))}
              hint="Map pin lat. Drop the pin on the actual entrance." />
            <Field label="Longitude"
              value={draft.longitude == null ? '' : String(draft.longitude)}
              placeholder="67.0517"
              onChange={(v) => setDraft((d) => ({ ...d, longitude: v === '' ? null : parseFloat(v) }))}
              hint="Map pin lng." />
            <Field label="Cuisine"
              value={draft.cuisine ?? ''} placeholder="Small plates, Burgers, Fried chicken, …"
              onChange={(v) => setDraft((d) => ({ ...d, cuisine: v }))}
              hint="Fed into schema.org servesCuisine." />
            <SelectField label="Price tier"
              value={draft.priceTier ?? ''}
              onChange={(v) => setDraft((d) => ({ ...d, priceTier: v || null }))}
              options={[
                { value: '',        label: '— pick —' },
                { value: 'budget',  label: 'Budget ($)' },
                { value: 'mid',     label: 'Mid ($$)' },
                { value: 'premium', label: 'Premium ($$$)' },
                { value: 'luxury',  label: 'Luxury ($$$$)' },
              ]}
              hint="Fed into schema.org priceRange." />
            <ToggleField label="Takes reservations"
              checked={draft.reservationsEnabled}
              onChange={(v) => setDraft((d) => ({ ...d, reservationsEnabled: v }))}
              hint="Off = walk-in / delivery only. Hides Book-a-table CTA on storefront." />
          </div>

          <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty}
              style={{
                padding: '0.55rem 1.2rem',
                borderRadius: '0.6rem',
                background: dirty ? '#00D4B1' : '#1f2533',
                color: dirty ? '#0a0a0a' : '#6E7186',
                fontWeight: 700, fontSize: '0.85rem',
                border: 'none', cursor: dirty ? 'pointer' : 'not-allowed',
                opacity: busy ? 0.6 : 1,
              }}>
              {busy ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => setDraft(concept)}
                style={{
                  padding: '0.55rem 1rem', borderRadius: '0.6rem',
                  background: 'transparent', color: '#6E7186',
                  border: '1px solid rgba(255,255,255,0.12)',
                  fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer',
                }}>
                Revert
              </button>
            )}
            {msg && (
              <span role="alert" style={{
                color: msg.kind === 'ok' ? '#22C55E' : '#EF4444',
                fontSize: '0.8rem', fontWeight: 600,
              }}>{msg.text}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function filled(c: ConceptRow): 'all' | 'some' | 'none' {
  const has = [c.phone, c.whatsapp, c.address, c.addressLocality, c.latitude, c.longitude, c.cuisine, c.priceTier].filter(Boolean).length
  if (has === 0) return 'none'
  if (has >= 6)  return 'all'
  return 'some'
}

function Field({
  label, value, placeholder, onChange, hint,
}: {
  label: string; value: string; placeholder?: string
  onChange: (v: string) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#9aa0b4' }}>
        {label}
      </span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: '#0a0d12',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '0.45rem',
          padding: '0.55rem 0.7rem',
          color: '#E8EAF0',
          fontSize: '0.88rem',
          outline: 'none',
        }}
      />
      {hint && <span style={{ fontSize: '0.7rem', color: '#6E7186', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}

function SelectField({
  label, value, onChange, options, hint,
}: {
  label: string; value: string; options: Array<{ value: string; label: string }>
  onChange: (v: string) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#9aa0b4' }}>
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: '#0a0d12',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '0.45rem',
          padding: '0.55rem 0.7rem',
          color: '#E8EAF0',
          fontSize: '0.88rem',
          outline: 'none',
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <span style={{ fontSize: '0.7rem', color: '#6E7186', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}

function ToggleField({
  label, checked, onChange, hint,
}: {
  label: string; checked: boolean
  onChange: (v: boolean) => void; hint?: string
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#9aa0b4' }}>
        {label}
      </span>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '0.6rem',
        padding: '0.45rem 0.5rem',
      }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{ width: '1.1rem', height: '1.1rem', accentColor: '#00D4B1' }}
        />
        <span style={{ color: '#E8EAF0', fontSize: '0.88rem' }}>{checked ? 'Yes' : 'No'}</span>
      </div>
      {hint && <span style={{ fontSize: '0.7rem', color: '#6E7186', lineHeight: 1.35 }}>{hint}</span>}
    </label>
  )
}
