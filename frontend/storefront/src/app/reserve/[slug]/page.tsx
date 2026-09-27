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
import { MagneticButton, MagneticLink } from '@/components/ui/MagneticButton'
import { useBrandSlug } from '../../../lib/host'
import { formatBrandName } from '../../../lib/concept'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Slot { time: string; available: boolean; tablesAvailable?: number; reason?: string }
interface Daypart { label: string; startHour: number; endHour: number }
interface AvailabilityResponse {
  concept: { id: string; name: string; slug: string; type: string }
  date: string
  partySize: number
  // Operator-controlled, returned by the API. Older API versions may omit
  // these — the storefront falls back to sensible defaults below.
  slotIntervalMin?: number
  defaultDurationMin?: number
  dayparts?: Daypart[]
  slots: Slot[]
}
interface ApiErrorResponse { error: { code: string; message: string } }

// Fallback grouping if the API didn't return dayparts (older deploy or
// custom integration). Matches the original hardcoded thresholds so
// behaviour is unchanged.
const DEFAULT_DAYPARTS: Daypart[] = [
  { label: 'Lunch',      startHour: 0,  endHour: 12 },
  { label: 'Afternoon',  startHour: 12, endHour: 16 },
  { label: 'Dinner',     startHour: 16, endHour: 22 },
  { label: 'Late night', startHour: 22, endHour: 24 },
]

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
  const brandHost = useBrandSlug()
  // On a brand custom domain (e.g. eatstax.com), middleware rewrites `/` to
  // `/brand/<slug>` — so "back to brand" should send the user to `/`. On the
  // canonical servd host, we want them on the explicit `/brand/<slug>` page.
  // brandHost is null until the client mounts; SSR pass treats it as servd.
  const backToBrandHref = brandHost ? '/' : `/brand/${slug}`
  // simmer's bible forbids white: /reserve/simmer wears a bone + tiber skin
  // (see .simmer-reserve in globals.css) instead of the white servd form.
  const simmer = slug === 'simmer'
  const skin = simmer ? 'simmer-reserve' : undefined

  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(todayPktIso())
  const [data, setData] = useState<AvailabilityResponse | null>(null)
  // Every user-visible brand name goes through formatBrandName (lowercase
  // brands stay lowercase: simmer, stackd).
  const brandName = data ? formatBrandName(data.concept.name) : ''
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

  // Surfaced when the brand has reservationsEnabled=false. We treat this as
  // "disabled at the brand", not a transient error — the user shouldn't see
  // a retry CTA, just a polite "we're not taking bookings right now."
  const [disabled, setDisabled] = useState(false)

  useEffect(() => {
    setLoading(true)
    setSelected(null)
    setDisabled(false)
    fetch(`${API_URL}/api/v1/reservations/availability?conceptSlug=${slug}&date=${date}&partySize=${partySize}`)
      .then(async (r) => {
        if (r.ok) return r.json() as Promise<AvailabilityResponse>
        if (r.status === 403) {
          const body = (await r.json().catch(() => null)) as ApiErrorResponse | null
          if (body?.error?.code === 'RESERVATIONS_DISABLED') {
            setDisabled(true)
            return null
          }
        }
        return null
      })
      .then((d) => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [slug, date, partySize])

  const groupedSlots = useMemo(() => {
    if (!data) return []
    const dayparts = data.dayparts && data.dayparts.length > 0 ? data.dayparts : DEFAULT_DAYPARTS
    const groups: Array<[string, Slot[]]> = dayparts.map((d) => [d.label, [] as Slot[]])
    for (const s of data.slots) {
      const h = new Date(s.time).getHours()
      // Find the first daypart whose [startHour, endHour) contains this hour.
      const idx = dayparts.findIndex((d) => h >= d.startHour && h < d.endHour)
      if (idx === -1) continue              // hour outside all dayparts — drop
      groups[idx]![1].push(s)
    }
    return groups.filter(([, slots]) => slots.length > 0)
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
      <div className={skin} style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '32rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--servd-ink)"
            strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ display: 'inline-block', marginBottom: '0.75rem' }}>
            <circle cx="12" cy="12" r="10" />
            <path d="M7.5 12.5l3 3 6-6.5" />
          </svg>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.75rem' }}>
            Reservation request sent.
          </h1>
          <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
            Check your phone — we&rsquo;ve sent a confirmation link with your booking. {brandName || 'The kitchen'} will see it in their dashboard.
          </p>
          <MagneticLink href={backToBrandHref} className="servd-btn-primary">Back to {brandName || 'the brand'}</MagneticLink>
        </div>
      </div>
    )
  }

  if (disabled) {
    return (
      <div className={skin} style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '32rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--servd-mute)"
            strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ display: 'inline-block', marginBottom: '0.75rem' }}>
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.75rem' }}>
            Reservations not available right now.
          </h1>
          <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
            This brand isn&rsquo;t accepting bookings online. Order ahead, or walk in — we&rsquo;ll seat you.
          </p>
          <MagneticLink href={backToBrandHref} className="servd-btn-primary">Back to brand</MagneticLink>
        </div>
      </div>
    )
  }

  return (
    <div className={skin} style={{ background: simmer ? 'var(--simmer-bone)' : '#fff', minHeight: '100dvh' }}>
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <Link href={backToBrandHref} style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', textDecoration: 'none' }}>
            ← {brandName || 'Back'}
          </Link>
          <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            Book a table
          </h1>
          <p style={{ color: 'var(--servd-mute)' }}>
            {data ? `at ${brandName}` : 'Choose a time and we\u2019ll save your spot.'}
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
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minHeight: '44px',
                          padding: '0.55rem 0.95rem',
                          borderRadius: '999px',
                          border: `1px solid ${sel ? 'var(--servd-green-dark)' : 'var(--servd-line)'}`,
                          background: sel ? 'var(--servd-green)' : (s.available ? (simmer ? 'transparent' : '#fff') : 'rgba(0,0,0,0.04)'),
                          color: sel ? (simmer ? 'var(--simmer-bone)' : 'var(--servd-black)') : (s.available ? 'var(--servd-ink)' : 'var(--servd-dim)'),
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
                Booking <strong>{partySize}</strong> at <strong>{brandName}</strong> for <strong>{fmtSlot(selected)} on {date}</strong>
              </div>

              {error && (
                <p role="alert" style={{ marginTop: '0.75rem', color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>
              )}

              <MagneticButton type="submit" disabled={submitting || !name.trim() || !phone.trim()} className="servd-btn-primary" style={{ marginTop: '1rem', width: '100%', padding: '1rem' }}>
                {submitting ? 'Booking…' : 'Confirm booking'}
              </MagneticButton>
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
