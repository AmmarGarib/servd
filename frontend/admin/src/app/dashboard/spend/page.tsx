'use client'
// Marketing Spend — the spend model, managed in the Management tab.
//
// One row per month (last 12), per brand, split into acquisition (→ new
// customers, drives CAC) and retention (→ existing customers, drives CRC).
// This is the single input that turns CAC / CRC / ROAS into real numbers on
// the Brand dashboard and the CEO dashboard. Gated on `brand_dashboard`.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { usePermissions } from '../../../hooks/useCan'
import { useRoleModules, modulesForRole } from '../../../store/roleModules'
import { useViewAsRole } from '../../../store/viewAsRole'
import type { AppRole } from '../../../lib/appRoles'

interface Concept { id: string; name: string; slug: string }
interface SpendRow { conceptId: string; month: string; acquisitionCents: number; retentionCents: number; note: string | null }
interface ListResp { months: string[]; rows: SpendRow[] }

function pkr(cents: number): string {
  const n = cents / 100
  if (n >= 1_000_000) return `PKR ${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000)    return `PKR ${(n / 1_000).toFixed(0)}K`
  return `PKR ${Math.round(n).toLocaleString()}`
}
function monthLabel(m: string): string {
  return new Date(`${m}-01T00:00:00`).toLocaleDateString('en-PK', { month: 'long', year: 'numeric' })
}

export default function MarketingSpendPage() {
  const router = useRouter()
  const [conceptId, setConceptId] = useState<string | null>(null)

  // Gate — same pattern as the dashboards.
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
    queryKey: ['spend', 'concepts'],
    queryFn:  () => api.get<Concept[]>('/concepts'),
    enabled:  canView === true,
  })

  // Default to the first brand once concepts load.
  useEffect(() => {
    if (!conceptId && concepts && concepts.length > 0) setConceptId(concepts[0]!.id)
  }, [concepts, conceptId])

  const { data: list } = useQuery({
    queryKey: ['spend', 'list', conceptId],
    queryFn:  () => api.get<ListResp>(`/management/marketing-spend/list?conceptId=${conceptId}&months=12`),
    enabled:  canView === true && !!conceptId,
  })

  if (permsLoading || canView === null) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#6E7186', padding: '4rem 1.4rem', textAlign: 'center', fontSize: '0.85rem' }}>Checking access…</main>
  }
  if (canView === false) {
    return <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '4rem 1.4rem', textAlign: 'center' }}><p style={{ color: '#6E7186', fontSize: '0.85rem' }}>Restricted. Redirecting…</p></main>
  }

  const rowByMonth = new Map((list?.rows ?? []).map((r) => [r.month, r]))
  const totalAcq = (list?.rows ?? []).reduce((s, r) => s + r.acquisitionCents, 0)
  const totalRet = (list?.rows ?? []).reduce((s, r) => s + r.retentionCents, 0)
  const brandName = concepts?.find((c) => c.id === conceptId)?.name ?? 'Brand'

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '64rem', margin: '0 auto' }}>

        <div>
          <p style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', margin: 0 }}>Management · Marketing spend</p>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: '0.4rem 0 0' }}>Marketing spend</h1>
          <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem', maxWidth: '40rem' }}>
            Enter spend per brand, per month. Acquisition drives CAC; retention drives CRC; the blended total drives ROAS on the Brand &amp; CEO dashboards.
          </p>
        </div>

        {/* Brand switcher (per brand — spend is brand-attributed) */}
        <div style={{ marginTop: '1.1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {(concepts ?? []).map((c) => {
            const on = c.id === conceptId
            return (
              <button key={c.id} onClick={() => setConceptId(c.id)}
                style={{ padding: '0.4rem 0.9rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '999px', cursor: 'pointer',
                  background: on ? '#1d2433' : 'transparent', color: on ? '#E8EAF0' : '#9aa0b4', border: `1px solid ${on ? '#2d3650' : '#1d222b'}` }}>
                {c.name}
              </button>
            )
          })}
        </div>

        {/* Totals */}
        <div style={{ marginTop: '1.2rem', display: 'grid', gap: '0.8rem', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Card label="Acquisition · 12 mo" value={pkr(totalAcq)} accent="#4F8EF7" />
          <Card label="Retention · 12 mo"   value={pkr(totalRet)} accent="#A855F7" />
          <Card label="Total · 12 mo"        value={pkr(totalAcq + totalRet)} accent="#00D4B1" />
        </div>

        {/* Editable grid */}
        <div style={{ marginTop: '1.6rem', borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr', gap: '0.5rem', padding: '0.75rem 1.1rem', borderBottom: '1px solid #1d222b' }}>
            <Th>Month</Th><Th>Acquisition (PKR)</Th><Th>Retention (PKR)</Th><Th>{''}</Th>
          </div>
          {(list?.months ?? []).map((m) => (
            <SpendRowEditor
              key={m}
              conceptId={conceptId!}
              month={m}
              initial={rowByMonth.get(m) ?? null}
            />
          ))}
          {!list && <p style={{ color: '#6E7186', padding: '1rem 1.1rem', fontSize: '0.85rem', margin: 0 }}>Loading {brandName} spend…</p>}
        </div>

        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <Link href="/dashboard/brand" style={{ padding: '0.5rem 0.95rem', borderRadius: '999px', background: '#00D4B115', border: '1px solid #00D4B133', color: '#00D4B1', fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>← Brand dashboard</Link>
          <Link href="/marketing/activity" style={{ padding: '0.5rem 0.95rem', borderRadius: '999px', background: '#A855F715', border: '1px solid #A855F733', color: '#A855F7', fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>Marketing activity →</Link>
        </div>
      </div>
    </main>
  )
}

function SpendRowEditor({ conceptId, month, initial }: { conceptId: string; month: string; initial: SpendRow | null }) {
  const qc = useQueryClient()
  const [acq, setAcq] = useState(initial ? String(initial.acquisitionCents / 100) : '')
  const [ret, setRet] = useState(initial ? String(initial.retentionCents / 100) : '')
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    setAcq(initial ? String(initial.acquisitionCents / 100) : '')
    setRet(initial ? String(initial.retentionCents / 100) : '')
  }, [initial])

  const acqCents = Math.round((parseFloat(acq) || 0) * 100)
  const retCents = Math.round((parseFloat(ret) || 0) * 100)
  const dirty = acqCents !== (initial?.acquisitionCents ?? 0) || retCents !== (initial?.retentionCents ?? 0)

  async function save() {
    setBusy(true); setOk(false)
    try {
      await api.put('/management/marketing-spend', { conceptId, month, acquisitionCents: acqCents, retentionCents: retCents })
      setOk(true)
      void qc.invalidateQueries({ queryKey: ['spend'] })
      void qc.invalidateQueries({ queryKey: ['brand-dash'] })
      void qc.invalidateQueries({ queryKey: ['ceo'] })
      setTimeout(() => setOk(false), 2000)
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 0.9fr', gap: '0.5rem', alignItems: 'center', padding: '0.55rem 1.1rem', borderBottom: '1px solid #161b24' }}>
      <span style={{ fontSize: '0.88rem', color: '#E8EAF0' }}>{monthLabel(month)}</span>
      <Cell value={acq} onChange={setAcq} />
      <Cell value={ret} onChange={setRet} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-end' }}>
        {ok && <span style={{ color: '#22C55E', fontSize: '0.72rem', fontWeight: 700 }}>✓</span>}
        <button onClick={() => void save()} disabled={busy || !dirty}
          style={{ padding: '0.4rem 0.8rem', borderRadius: '0.5rem', fontSize: '0.75rem', fontWeight: 700, border: 'none',
            background: dirty ? '#00D4B1' : '#1a1f29', color: dirty ? '#0a0a0a' : '#4a4f5e', cursor: dirty ? 'pointer' : 'default', opacity: busy ? 0.6 : 1 }}>
          {busy ? '…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

function Cell({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder="0"
      style={{ background: '#0a0d12', border: '1px solid rgba(255,255,255,0.10)', borderRadius: '0.4rem', padding: '0.45rem 0.6rem', color: '#E8EAF0', fontSize: '0.88rem', fontVariantNumeric: 'tabular-nums', outline: 'none', width: '100%' }} />
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#6E7186' }}>{children}</span>
}

function Card({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '1rem', padding: '1rem 1.15rem', position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: accent, opacity: 0.7 }} />
      <p style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#6E7186', margin: 0 }}>{label}</p>
      <p style={{ fontSize: '1.4rem', fontWeight: 800, margin: '0.45rem 0 0', fontVariantNumeric: 'tabular-nums' }}>{value}</p>
    </div>
  )
}
