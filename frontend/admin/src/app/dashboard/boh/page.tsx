'use client'
// BOH Dashboard — live kitchen view for the chef/kitchen-lead.
//
// Audience: kitchen lead / sous on the line. Question it answers: "is
// my line on time, what's stuck, what's about to run out?" Purely live
// — refreshes on 5–10s intervals. No revenue/AOV here; that's CEO.
//
// Composition:
//   - Health strip: New / Preparing / Ready / Oldest ticket
//   - Station load grid: per-station live load (from /kds/stations)
//   - 86 list (unavailable today, source: /menu items isAvailable=false)
//   - Low stock alerts
//   - Recent ticket ticker

import Link from 'next/link'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, ordersApi, type Order } from '../../../lib/api'

interface Station {
  id: string
  conceptId: string
  name: string
  isActive: boolean
  liveLoad: number
  concept: { name: string; slug: string }
}
interface InventoryAlert {
  id: string
  name: string
  currentStock: number
  parLevel: number
}

export default function BohDashboardPage() {
  const { data: ordersResp } = useQuery({
    queryKey: ['boh', 'orders'],
    queryFn:  () => ordersApi.list({ status: 'received,confirmed,preparing,ready', limit: '200' }),
    refetchInterval: 8_000,
  })
  const { data: stations } = useQuery({
    queryKey: ['boh', 'stations'],
    queryFn:  () => api.get<Station[]>('/kds/stations'),
    refetchInterval: 10_000,
  })
  const { data: lowStock } = useQuery({
    queryKey: ['boh', 'inventory-alerts'],
    queryFn:  () => api.get<InventoryAlert[]>('/inventory/alerts'),
    refetchInterval: 120_000,
  })
  const live = ordersResp?.data ?? []
  const received  = live.filter((o) => o.status === 'received').length
  const preparing = live.filter((o) => ['confirmed', 'preparing'].includes(o.status)).length
  const ready     = live.filter((o) => o.status === 'ready').length

  const oldest = useMemo(() => {
    const open = live.filter((o) => o.status !== 'ready')
    if (open.length === 0) return null
    const sorted = [...open].sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())
    return sorted[0]!
  }, [live])

  const oldestMins = oldest
    ? Math.max(0, Math.floor((Date.now() - new Date(oldest.placedAt).getTime()) / 60_000))
    : 0
  const oldestAccent = oldestMins >= 20 ? '#EF4444' : oldestMins >= 10 ? '#F59E0B' : '#22C55E'

  // Group stations by concept so a multi-brand kitchen reads cleanly.
  const stationsByConcept = useMemo(() => {
    const map = new Map<string, { name: string; rows: Station[] }>()
    for (const s of stations ?? []) {
      const cur = map.get(s.conceptId) ?? { name: s.concept.name, rows: [] }
      cur.rows.push(s)
      map.set(s.conceptId, cur)
    }
    return [...map.values()]
  }, [stations])

  const recent = useMemo(() => [...live]
    .sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime())
    .slice(0, 8), [live])

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '78rem', margin: '0 auto' }}>

        <Link href="/dashboard" style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', textDecoration: 'none' }}>
          ← all dashboards
        </Link>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.8rem', marginTop: '0.4rem' }}>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: 0 }}>
            Back of House
          </h1>
          <LivePulse color="#4F8EF7" label="refreshing" />
        </div>
        <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
          Live kitchen line. Refreshes every 8–10 seconds.
        </p>

        {/* Health strip */}
        <div style={{ marginTop: '1.6rem', display: 'grid', gap: '0.7rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Tile label="New"        value={received}  accent="#4F8EF7" />
          <Tile label="Preparing"  value={preparing} accent="#F59E0B" />
          <Tile label="Ready"      value={ready}     accent="#22C55E" />
          <Tile label="Oldest"     value={oldest ? `${oldestMins}m` : '—'}
                accent={oldest ? oldestAccent : '#6E7186'}
                sub={oldest ? `#${oldest.id.slice(-5)} ${oldest.concept?.slug ?? ''}` : 'no open tickets'} />
        </div>

        {/* Station load grid */}
        <Section title="Station load" hint="open items, not completed">
          {stationsByConcept.length === 0 && (
            <p style={{ color: '#6E7186', fontSize: '0.85rem' }}>No stations configured.</p>
          )}
          {stationsByConcept.map((g) => {
            const max = Math.max(1, ...g.rows.map((r) => r.liveLoad))
            return (
              <div key={g.name} style={{ marginBottom: '1.4rem' }}>
                <p style={{ fontSize: '0.74rem', color: '#9aa0b4', fontWeight: 700, margin: '0 0 0.5rem' }}>
                  {g.name}
                </p>
                <div style={{
                  background: '#11151c', border: '1px solid #1d222b',
                  borderRadius: '0.9rem', padding: '0.85rem 1.1rem',
                  display: 'grid', gap: '0.55rem',
                }}>
                  {g.rows.map((s) => {
                    const pct = (s.liveLoad / max) * 100
                    const accent = s.liveLoad >= 8 ? '#EF4444' : s.liveLoad >= 4 ? '#F59E0B' : '#4F8EF7'
                    return (
                      <Link key={s.id} href={`/kds/${s.id}`} style={{
                        display: 'grid', gridTemplateColumns: '12rem 1fr 2rem',
                        gap: '0.9rem', alignItems: 'center',
                        textDecoration: 'none', color: 'inherit', padding: '0.2rem 0',
                      }}>
                        <span style={{ fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: s.isActive ? 1 : 0.5 }}>
                          {s.name}
                        </span>
                        <div style={{ position: 'relative', height: '0.55rem', background: '#1d222b', borderRadius: '999px', overflow: 'hidden' }}>
                          <div style={{
                            position: 'absolute', inset: '0 auto 0 0',
                            width: `${pct}%`, background: accent,
                            borderRadius: '999px',
                          }} />
                        </div>
                        <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: accent }}>
                          {s.liveLoad}
                        </span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </Section>

        {/* Low stock */}
        <Section title="Low stock" hint="ingredients at or below par">
          <div style={{ background: '#11151c', border: '1px solid #1d222b', borderRadius: '0.9rem', padding: '0.95rem 1.15rem' }}>
            {(lowStock ?? []).length === 0 && (
              <p style={{ color: '#6E7186', fontSize: '0.84rem', margin: 0 }}>All ingredients at par.</p>
            )}
            {(lowStock ?? []).slice(0, 10).map((a, i) => (
              <div key={a.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                padding: '0.45rem 0',
                borderTop: i === 0 ? 'none' : '1px solid #1d222b',
              }}>
                <span style={{ fontSize: '0.88rem' }}>{a.name}</span>
                <span style={{ color: '#F59E0B', fontSize: '0.8rem', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {a.currentStock}/{a.parLevel}
                </span>
              </div>
            ))}
            {lowStock && lowStock.length > 10 && (
              <p style={{ color: '#6E7186', fontSize: '0.76rem', margin: '0.65rem 0 0' }}>
                +{lowStock.length - 10} more in <Link href="/inventory" style={{ color: '#F59E0B' }}>Inventory</Link>
              </p>
            )}
          </div>
        </Section>

        {/* Recent ticker */}
        <Section title="Last 8 tickets" hint="live ticker">
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {recent.length === 0 && (
              <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.84rem', margin: 0 }}>
                No open tickets.
              </p>
            )}
            {recent.map((o, i) => (
              <TicketRow key={o.id} order={o} first={i === 0} />
            ))}
          </div>
        </Section>

        {/* Footer pills */}
        <Section title="Jump in" hint="kitchen surfaces">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/kds"         label="Open KDS →"        accent="#4F8EF7" />
            <Pill href="/menu"        label="Menu editor →"     accent="#A855F7" />
            <Pill href="/inventory"   label="Inventory →"       accent="#F59E0B" />
            <Pill href="/accounting/recipes" label="Recipes →"         accent="#22C55E" />
          </div>
        </Section>
      </div>
    </main>
  )
}

function Tile({ label, value, sub, accent }: { label: string; value: number | string; sub?: string; accent: string }) {
  return (
    <div style={{
      background: '#11151c', border: '1px solid #1d222b',
      borderRadius: '1rem', padding: '1.05rem 1.15rem', position: 'relative', overflow: 'hidden',
    }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: accent, opacity: 0.8 }} />
      <p style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#6E7186', margin: 0 }}>
        {label}
      </p>
      <p style={{ fontSize: 'clamp(1.4rem, 2.8vw, 1.8rem)', fontWeight: 800, letterSpacing: '-0.02em', margin: '0.45rem 0 0', fontVariantNumeric: 'tabular-nums', color: accent }}>
        {value}
      </p>
      {sub && <p style={{ color: '#6E7186', fontSize: '0.74rem', margin: '0.3rem 0 0' }}>{sub}</p>}
    </div>
  )
}

function TicketRow({ order, first }: { order: Order; first: boolean }) {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(order.placedAt).getTime()) / 60_000))
  const accent = order.status === 'ready' ? '#22C55E'
    : mins >= 20 ? '#EF4444'
    : mins >= 10 ? '#F59E0B'
    : '#4F8EF7'
  return (
    <Link href={`/orders/${order.id}`} style={{
      display: 'grid', gridTemplateColumns: '4.5rem 1fr 6rem 4.5rem',
      gap: '0.9rem', alignItems: 'center',
      padding: '0.85rem 1.1rem',
      borderTop: first ? 'none' : '1px solid #1d222b',
      textDecoration: 'none', color: 'inherit',
    }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: accent, fontSize: '0.86rem' }}>
        #{order.id.slice(-5)}
      </span>
      <span style={{ fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {order.concept?.name ?? ''} · {order.items?.length ?? 0} items
      </span>
      <span style={{ fontSize: '0.72rem', color: '#9aa0b4', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
        {order.status}
      </span>
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: accent, fontSize: '0.86rem' }}>
        {mins}m
      </span>
    </Link>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', marginBottom: '0.7rem' }}>
        <h2 style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#9aa0b4', margin: 0 }}>
          {title}
        </h2>
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

function LivePulse({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      <span style={{
        width: '0.55rem', height: '0.55rem', borderRadius: '50%',
        background: color, boxShadow: `0 0 10px ${color}`,
      }} />
      <span style={{ fontSize: '0.68rem', letterSpacing: '0.22em', textTransform: 'uppercase', color: '#6E7186' }}>
        {label}
      </span>
    </div>
  )
}
