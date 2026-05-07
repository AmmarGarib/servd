'use client'

// Public reservation booking widget. Mounted under each brand microsite as
// /reserve/[slug] — but reachable directly too.
//
// Flow:
//   1. Pick party size + date → fetch availability
//   2. Pick a time slot
//   3. Enter guest details
//   4. Submit → SMS + email confirmation with confirm/cancel link

import { useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Slot { time: string; available: boolean; tablesAvailable?: number; reason?: string }
interface AvailabilityResponse {
  concept: { id: string; name: string; slug: string; type: string }
  date: string
  partySize: number
  slots: Slot[]
}

function todayPktIso(): string {
  const pkt = new Date(Date.now() + 5 * 3600_000)
  return pkt.toISOString().slice(0, 10)
}

function fmtSlot(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function ReservePage() {
  const { slug } = useParams<{ slug: string }>()
  const router = useRouter()

  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(todayPktIso())
  const [data, setData] = useState<AvailabilityResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  // Guest details
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    setLoading(true)
    setSelected(null)
    fetch(`${API_URL}/api/v1/reservations/availability?conceptSlug=${slug}&date=${date}&partySize=${partySize}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [slug, date, partySize])

  const groupedSlots = useMemo(() => {
    if (!data) return []
    const groups: Record<string, Slot[]> = { Lunch: [], Afternoon: [], Dinner: [], 'Late night': [] }
    for (const s of data.slots) {
      const h = new Date(s.time).getHours()
      const key = h < 12 ? 'Lunch'
                : h < 16 ? 'Afternoon'
                : h < 22 ? 'Dinner'
                :          'Late night'
      groups[key]!.push(s)
    }
    return Object.entries(groups).filter(([_, slots]) => slots.length > 0)
  }, [data])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected || !name.trim() || !phone.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/reservations/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conceptSlug: slug,
          partySize,
          startTime: selected,
          durationMin: 90,
          guestName: name.trim(),
          guestPhone: phone.trim(),
          guestEmail: email.trim() || null,
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message ?? `Booking failed (${res.status})`)
      }
      setDone(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '32rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✓</div>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.75rem' }}>
            Reservation request sent.
          </h1>
          <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
            Check your phone — we&rsquo;ve sent a confirmation link with your booking. {data?.concept.name} will see it in their dashboard.
          </p>
          <Link href={`/brand/${slug}`} className="servd-btn-primary">Back to {data?.concept.name}</Link>
        </div>
      </div>
    )
  }

  return (
    <div style={{ background: '#fff', minHeight: '100vh' }}>
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <Link href={`/brand/${slug}`} style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', textDecoration: 'none' }}>
            ← {data?.concept.name ?? 'Back'}
          </Link>
          <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            Book a table
          </h1>
          <p style={{ color: 'var(--servd-mute)' }}>
            {data ? `at ${data.concept.name}` : 'Choose a time and we&rsquo;ll save your spot.'}
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '2rem', maxWidth: '52rem' }}>
          {/* Step 1: party + date */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>1. When and how many?</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Party size</span>
                <select
                  value={partySize}
                  onChange={(e) => setPartySize(parseInt(e.target.value, 10))}
                  className="servd-input"
                  style={{ marginTop: '0.4rem' }}
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 20].map((n) => (
                    <option key={n} value={n}>{n} {n === 1 ? 'person' : 'people'}</option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'block' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Date</span>
                <input
                  type="date"
                  value={date}
                  min={todayPktIso()}
                  onChange={(e) => setDate(e.target.value)}
                  className="servd-input"
                  style={{ marginTop: '0.4rem' }}
                />
              </label>
            </div>
          </div>

          {/* Step 2: pick a slot */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>2. Pick a time</h2>
            {loading && <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '1.5rem' }}>Loading availability…</p>}
            {!loading && data && data.slots.length === 0 && (
              <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '1.5rem' }}>
                No slots available on {date}. Try another day.
              </p>
            )}
            {!loading && data && groupedSlots.map(([groupName, slots]) => (
              <div key={groupName} style={{ marginBottom: '1.25rem' }}>
                <p style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--servd-mute)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                  {groupName}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {slots.map((s) => {
                    const sel = selected === s.time
                    return (
                      <button
                        key={s.time}
                        onClick={() => s.available && setSelected(s.time)}
                        disabled={!s.available}
                        aria-pressed={sel}
                        style={{
                          padding: '0.55rem 0.95rem',
                          borderRadius: '999px',
                          border: `1px solid ${sel ? 'var(--servd-green-dark)' : 'var(--servd-line)'}`,
                          background: sel ? 'var(--servd-green)' : (s.available ? '#fff' : 'rgba(0,0,0,0.04)'),
                          color: sel ? 'var(--servd-black)' : (s.available ? 'var(--servd-ink)' : 'var(--servd-dim)'),
                          fontWeight: sel ? 800 : 500,
                          fontSize: '0.875rem',
                          cursor: s.available ? 'pointer' : 'not-allowed',
                          textDecoration: s.available ? 'none' : 'line-through',
                        }}
                      >
                        {fmtSlot(s.time)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Step 3: guest details */}
          {selected && (
            <form className="servd-card" style={{ padding: '1.5rem' }} onSubmit={onSubmit}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>3. Your details</h2>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Full name *</span>
                  <input required value={name} onChange={(e) => setName(e.target.value)} className="servd-input" style={{ marginTop: '0.4rem' }} />
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                  <label>
                    <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Phone *</span>
                    <input required type="tel" inputMode="tel" placeholder="+92 …" value={phone} onChange={(e) => setPhone(e.target.value)} className="servd-input" style={{ marginTop: '0.4rem' }} />
                  </label>
                  <label>
                    <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Email</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="servd-input" style={{ marginTop: '0.4rem' }} />
                  </label>
                </div>
                <label>
                  <span style={{ fontSize: '0.8rem', color: 'var(--servd-mute)', fontWeight: 600 }}>Allergies, occasion, special requests</span>
                  <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="servd-input" style={{ marginTop: '0.4rem' }} />
                </label>
              </div>

              <div style={{ marginTop: '1.25rem', padding: '0.75rem 1rem', background: 'var(--servd-green-soft)', borderRadius: '0.6rem', fontSize: '0.85rem', color: 'var(--servd-green-ink)' }}>
                Booking <strong>{partySize}</strong> at <strong>{data?.concept.name}</strong> for <strong>{fmtSlot(selected)} on {date}</strong>
              </div>

              {error && (
                <p role="alert" style={{ marginTop: '0.75rem', color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>
              )}

              <button type="submit" disabled={submitting || !name.trim() || !phone.trim()} className="servd-btn-primary" style={{ marginTop: '1rem', width: '100%', padding: '1rem' }}>
                {submitting ? 'Booking…' : 'Confirm booking'}
              </button>
              <p style={{ fontSize: '0.7rem', color: 'var(--servd-dim)', textAlign: 'center', marginTop: '0.75rem' }}>
                You&rsquo;ll get an SMS confirmation. Reminders 24h and 2h before.
              </p>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
