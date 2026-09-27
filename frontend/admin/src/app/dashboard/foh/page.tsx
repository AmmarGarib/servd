'use client'
// FOH Dashboard — live floor view for the GM / floor manager.
//
// Audience: floor manager during service. Question it answers: "is the
// floor running, who's arriving, who's complaining, who's on shift?"
// Live, like BOH. Numbers happen on /dashboard/ceo.
//
// Composition:
//   - Tonight's covers (reservations today)
//   - Curbside queue (cars arrived + en route)
//   - Open complaints
//   - Reservation list for tonight

import Link from 'next/link'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

interface Reservation {
  id: string
  startTime: string
  partySize: number
  status: string
  customer: { name: string | null } | null
  table:    { label: string | null } | null
  concept?: { name: string } | null
}
interface Curbside {
  arrived: Array<{ id: string; conceptId: string; placedAt: string; curbsideVehicle: string | null; curbsidePlate: string | null; curbsideSpot: string | null; customerName: string | null }>
  enRoute: Array<{ id: string; conceptId: string; placedAt: string; curbsideVehicle: string | null; curbsidePlate: string | null; customerName: string | null }>
}
interface ComplaintStats {
  stats: { total: number; open: number; resolved: number; inProgress: number }
}

function todayStr(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export default function FohDashboardPage() {
  const today = todayStr()

  const { data: reservations } = useQuery({
    queryKey: ['foh', 'reservations', today],
    queryFn:  () => api.get<Reservation[]>(`/reservations?date=${today}`),
    refetchInterval: 30_000,
  })
  const { data: curbside } = useQuery({
    queryKey: ['foh', 'curbside'],
    queryFn:  () => api.get<Curbside>('/orders/curbside'),
    refetchInterval: 10_000,
  })
  const { data: complaints } = useQuery({
    queryKey: ['foh', 'complaints'],
    queryFn:  () => api.get<ComplaintStats>('/complaints/stats'),
    refetchInterval: 60_000,
  })

  const tonight = reservations ?? []
  const covers  = tonight.reduce((sum, r) => sum + (r.partySize || 0), 0)
  const seated  = tonight.filter((r) => ['seated', 'arrived'].includes(r.status)).length
  const upcoming = tonight.filter((r) => ['confirmed', 'pending'].includes(r.status)).length

  const carsHere = curbside?.arrived.length ?? 0
  const carsEnRoute = curbside?.enRoute.length ?? 0

  const openCmp = complaints?.stats.open ?? 0
  const inProg  = complaints?.stats.inProgress ?? 0

  const upcomingList = useMemo(() => {
    const now = Date.now()
    return tonight
      .filter((r) => new Date(r.startTime).getTime() >= now - 30 * 60_000)
      .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
      .slice(0, 10)
  }, [tonight])

  return (
    <main style={{ minHeight: '100vh', background: '#0a0d12', color: '#E8EAF0', padding: '1.6rem 1.4rem 5rem' }}>
      <div style={{ maxWidth: '78rem', margin: '0 auto' }}>

        <Link href="/dashboard" style={{ fontSize: '0.7rem', color: '#6E7186', letterSpacing: '0.2em', textTransform: 'uppercase', textDecoration: 'none' }}>
          ← all dashboards
        </Link>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.8rem', marginTop: '0.4rem' }}>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.1rem)', letterSpacing: '-0.02em', margin: 0 }}>
            Front of House
          </h1>
          <LivePulse color="#F59E0B" label="refreshing" />
        </div>
        <p style={{ color: '#6E7186', margin: '0.35rem 0 0', fontSize: '0.88rem' }}>
          Live floor. Reservations, curbside, complaints. Refreshes every 10–30 seconds.
        </p>

        {/* Health strip */}
        <div style={{ marginTop: '1.6rem', display: 'grid', gap: '0.7rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Tile label="Covers tonight" value={covers}   accent="#F59E0B" sub={`${tonight.length} bookings`} />
          <Tile label="Seated now"     value={seated}   accent="#22C55E" sub={`${upcoming} upcoming`} />
          <Tile label="Cars curbside"  value={carsHere} accent="#4F8EF7" sub={`${carsEnRoute} en route`} />
          <Tile label="Complaints"     value={openCmp}  accent={openCmp > 0 ? '#EF4444' : '#6E7186'} sub={`${inProg} in progress`} />
        </div>

        {/* Curbside arrivals */}
        <Section title="Curbside queue" hint="cars-here-first">
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {(curbside?.arrived ?? []).length === 0 && (curbside?.enRoute ?? []).length === 0 && (
              <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.84rem', margin: 0 }}>
                No cars in the queue.
              </p>
            )}
            {(curbside?.arrived ?? []).map((c, i) => (
              <CurbsideRow key={c.id} order={c} arrived first={i === 0} />
            ))}
            {(curbside?.enRoute ?? []).map((c, i) => {
              const idx = (curbside?.arrived.length ?? 0) + i
              return <CurbsideRow key={c.id} order={c} arrived={false} first={idx === 0} />
            })}
          </div>
        </Section>

        {/* Tonight's reservations */}
        <Section title="Tonight's bookings" hint={`${tonight.length} on the book`}>
          <div style={{ borderRadius: '0.9rem', background: '#11151c', border: '1px solid #1d222b', overflow: 'hidden' }}>
            {upcomingList.length === 0 && (
              <p style={{ color: '#6E7186', padding: '1rem 1.2rem', fontSize: '0.84rem', margin: 0 }}>
                Nothing on the book.
              </p>
            )}
            {upcomingList.map((r, i) => (
              <ReservationRow key={r.id} r={r} first={i === 0} />
            ))}
            {tonight.length > upcomingList.length && (
              <div style={{ padding: '0.7rem 1.1rem', borderTop: '1px solid #1d222b' }}>
                <Link href={`/reservations?date=${today}`} style={{ color: '#F59E0B', fontSize: '0.78rem', fontWeight: 700, textDecoration: 'none' }}>
                  See full book →
                </Link>
              </div>
            )}
          </div>
        </Section>

        {/* Footer pills */}
        <Section title="Jump in" hint="floor surfaces">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.6rem' }}>
            <Pill href="/reservations"          label="Reservations →"  accent="#F59E0B" />
            <Pill href="/orders/curbside"       label="Curbside →"      accent="#4F8EF7" />
            <Pill href="/complaints"            label="Complaints →"    accent="#EF4444" />
            <Pill href="/pos"                    label="Open POS →"      accent="#00D4B1" />
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

function CurbsideRow({ order, arrived, first }: {
  order: Curbside['arrived'][number] | Curbside['enRoute'][number]
  arrived: boolean
  first: boolean
}) {
  const accent = arrived ? '#4F8EF7' : '#6E7186'
  return (
    <Link href={`/orders/${order.id}`} style={{
      display: 'grid', gridTemplateColumns: '4.5rem 1fr 8rem 5rem',
      gap: '0.9rem', alignItems: 'center',
      padding: '0.85rem 1.1rem',
      borderTop: first ? 'none' : '1px solid #1d222b',
      textDecoration: 'none', color: 'inherit',
    }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, color: accent, fontSize: '0.86rem' }}>
        #{order.id.slice(-5)}
      </span>
      <span style={{ fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {order.customerName ?? 'Guest'}
        {order.curbsideVehicle && <span style={{ color: '#6E7186' }}> · {order.curbsideVehicle}</span>}
      </span>
      <span style={{ fontSize: '0.78rem', color: '#9aa0b4', fontVariantNumeric: 'tabular-nums' }}>
        {order.curbsidePlate ?? ''}
      </span>
      <span style={{
        textAlign: 'right',
        fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.16em',
        textTransform: 'uppercase', color: accent,
      }}>
        {arrived ? 'here' : 'en route'}
      </span>
    </Link>
  )
}

function ReservationRow({ r, first }: { r: Reservation; first: boolean }) {
  const t = new Date(r.startTime)
  const time = t.toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' })
  const accent = r.status === 'seated' ? '#22C55E'
    : r.status === 'arrived' ? '#4F8EF7'
    : r.status === 'cancelled' || r.status === 'no_show' ? '#6E7186'
    : '#F59E0B'
  return (
    <Link href="/reservations" style={{
      display: 'grid', gridTemplateColumns: '5rem 1fr 4rem 5rem',
      gap: '0.9rem', alignItems: 'center',
      padding: '0.85rem 1.1rem',
      borderTop: first ? 'none' : '1px solid #1d222b',
      textDecoration: 'none', color: 'inherit',
    }}>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: '0.86rem' }}>
        {time}
      </span>
      <span style={{ fontSize: '0.86rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.customer?.name ?? 'Guest'}
        {r.table?.label && <span style={{ color: '#6E7186' }}> · {r.table.label}</span>}
      </span>
      <span style={{ fontSize: '0.8rem', color: '#9aa0b4', fontVariantNumeric: 'tabular-nums' }}>
        {r.partySize} ppl
      </span>
      <span style={{
        textAlign: 'right',
        fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.16em',
        textTransform: 'uppercase', color: accent,
      }}>
        {r.status}
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
