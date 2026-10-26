'use client'

// Public reservation booking widget (client). Rendered by page.tsx (a server
// component), which passes the brand's name and a short factual paragraph
// (`intro`, server-rendered) so both are in the first HTML. Mounted under
// each brand microsite as /reserve/[slug] — but reachable directly too.
//
// Booking is for servd members only (owner, 2026-10-16): a signed-out visitor
// can look at times but is asked to sign in / create a servd account to book,
// and comes back to the same booking (party, date and time ride the ?next=
// link). There is no limit on how far ahead a date can be; an account may hold
// 5 upcoming bookings at once (API: 409 BOOKING_LIMIT_REACHED; 401
// AUTH_REQUIRED if the session lapsed). Times are shown as 7:30 pm.
//
// Flow:
//   1. Pick party size + date → fetch availability
//   2. Pick a time slot
//   3. Enter guest details (pre-filled from the account when signed in)
//   4. Submit. servd only messages a phone / email the signed-in guest has
//      VERIFIED on their own account (ONL-09) — anyone else gets the
//      confirm / cancel link on this screen instead, and no reminders.
//
// Signed-in guests send their customer token (availability and booking):
// a booking from a verified account is linked to it (My bookings), confirmed
// over WhatsApp, reminded, and not held to the share of tables the API keeps
// for anonymous bookings (ONLINE-R2 — such slots come back as
// reason 'sign_in').

import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { MagneticButton, MagneticLink } from '@/components/ui/MagneticButton'
import { useBrandSlug } from '../../../lib/host'
import { formatBrandName } from '../../../lib/concept'
import { brandCanonical } from '../../../lib/brandDomains'
import { useCustomerAuth } from '../../../store/customerAuth'
// GA4 events (no-op without GA4 / consent) — the shared contract in lib/analytics.
import { track } from '../../../lib/analytics'
import { PARTY_SIZES } from './partySizes'
import { InviteTable } from '../../../components/reserve/InviteTable'
import { smoothScrollTo } from '../../../lib/scroll'
import { Field } from '@/components/ui/Field'
import { withReturnPath } from '@/components/auth/authFlow'

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
interface ApiErrorResponse { error: { code: string; message: string; details?: { signInToBook?: boolean } } }
interface BookingResponse {
  id: string
  confirmToken: string
  confirmUrl?: string
  startTime: string
  status: string
  notified?: { whatsapp: boolean; email: boolean; reminders: boolean }
}
interface AccountProfile { name?: string | null; phone?: string | null; email?: string | null; phoneVerifiedAt?: string | null; emailVerifiedAt?: string | null }

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

/** Hour of the day in Karachi (the slot's own clock, not the browser's). */
function pktHour(iso: string): number {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).getUTCHours()
}

/** "7:30 pm" — Karachi time, 12-hour. */
function fmtSlot(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit', hour12: true })
}

/** A slot that is full for everyone (not merely held for signed-in guests). */
function isFull(s: Slot): boolean { return !s.available && s.reason !== 'sign_in' }

export default function ReserveScreen({ brandName = null, intro = null }: {
  /** The brand's display name as the server resolved it (null = unknown
   *  until availability loads). */
  brandName?: string | null
  /** A short factual paragraph about the brand, rendered on the server. */
  intro?: React.ReactNode
}) {
  const { slug } = useParams<{ slug: string }>()
  const router = useRouter()
  const brandHost = useBrandSlug()
  // "Back to brand" goes to the brand's microsite, which lives on its own
  // domain (simmer.pk/). On that same domain `/` is already it; anywhere else
  // (servd.pk, another brand's domain) link the canonical URL rather than the
  // servd.pk/brand/<slug> duplicate. brandHost is null until the client
  // mounts; the SSR pass treats it as servd.
  const backToBrandHref = brandHost === slug ? '/' : brandCanonical(slug)

  const [partySize, setPartySize] = useState(2)
  const [date, setDate] = useState(todayPktIso())
  const [data, setData] = useState<AvailabilityResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<BookingResponse | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const formRef = useRef<HTMLFormElement | null>(null)
  const nameRef = useRef<HTMLInputElement | null>(null)
  const doneHeadingRef = useRef<HTMLHeadingElement | null>(null)

  // The signed-in customer, if any (persisted store — null until hydrated).
  const token = useCustomerAuth((s) => s.token)
  const [profile, setProfile] = useState<AccountProfile | null>(null)

  // Guest details
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [notes, setNotes] = useState('')

  // Surfaced when the brand has reservationsEnabled=false. We treat this as
  // "disabled at the brand", not a transient error — the user shouldn't see
  // a retry CTA, just a polite "we're not taking bookings right now."
  const [disabled, setDisabled] = useState(false)

  // Back from sign-in: put the same booking (party, date, time) back.
  const restoreTime = useRef<string | null>(null)
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const p = parseInt(sp.get('party') ?? '', 10)
    const d = sp.get('date') ?? ''
    if (p >= 1 && p <= 99) setPartySize(p)
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d)
    restoreTime.current = sp.get('time')
  }, [])

  // Pre-fill the guest's details from their account (only empty fields).
  useEffect(() => {
    if (!token) { setProfile(null); return }
    let cancelled = false
    fetch(`${API_URL}/api/v1/storefront/account?conceptSlug=${encodeURIComponent(slug)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? (r.json() as Promise<AccountProfile>) : null))
      .then((a) => {
        if (cancelled || !a) return
        setProfile(a)
        if (a.name) setName((v) => v || a.name || '')
        if (a.phone) setPhone((v) => v || a.phone || '')
        if (a.email) setEmail((v) => v || a.email || '')
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, slug])

  const dateUsable = !!date && date >= todayPktIso()
  useEffect(() => {
    setSelected(null)
    setDisabled(false)
    setNeedsSignIn(false)
    setLimitReached(false)
    setLoadError(false)
    // No request for an empty or past date; say what to do instead.
    if (!dateUsable) { setData(null); setLoading(false); return }
    // One controller per request: a superseded answer is dropped, never shown.
    const ctl = new AbortController()
    setLoading(true)
    fetch(`${API_URL}/api/v1/reservations/availability?conceptSlug=${slug}&date=${date}&partySize=${partySize}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: ctl.signal,
    })
      .then(async (r) => {
        if (r.ok) return r.json() as Promise<AvailabilityResponse>
        if (r.status === 403) {
          const body = (await r.json().catch(() => null)) as ApiErrorResponse | null
          if (body?.error?.code === 'RESERVATIONS_DISABLED') {
            setDisabled(true)
            return null
          }
        }
        throw new Error(`availability ${r.status}`)
      })
      .then((d) => {
        if (ctl.signal.aborted) return
        setData(d)
        const want = restoreTime.current
        if (want && d?.slots.some((x) => x.time === want && (x.available || x.reason === 'sign_in'))) setSelected(want)
      })
      .catch(() => { if (!ctl.signal.aborted) { setData(null); setLoadError(true) } })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false) })
    return () => ctl.abort()
  }, [slug, date, dateUsable, partySize, token, reloadKey])

  // A slot was picked: bring the details form into view and start on the name.
  useEffect(() => {
    if (!selected) return
    const t = setTimeout(() => {
      smoothScrollTo(formRef.current)
      nameRef.current?.focus({ preventScroll: true })
    }, 0)
    return () => clearTimeout(t)
  }, [selected])

  // Booked: back to the top, on the confirmation.
  useEffect(() => {
    if (!done) return
    window.scrollTo(0, 0)
    doneHeadingRef.current?.focus({ preventScroll: true })
  }, [done])

  const groupedSlots = useMemo(() => {
    if (!data) return []
    const dayparts = data.dayparts && data.dayparts.length > 0 ? data.dayparts : DEFAULT_DAYPARTS
    const groups: Array<[string, Slot[]]> = dayparts.map((d) => [d.label, [] as Slot[]])
    for (const s of data.slots) {
      if (isFull(s)) continue            // full times are hidden, not struck through
      const h = pktHour(s.time)
      // Find the first daypart whose [startHour, endHour) contains this hour.
      const idx = dayparts.findIndex((d) => h >= d.startHour && h < d.endHour)
      if (idx === -1) continue              // hour outside all dayparts — drop
      groups[idx]![1].push(s)
    }
    return groups.filter(([, slots]) => slots.length > 0)
  }, [data])
  const anyBookable = groupedSlots.length > 0

  // Where sign-in / sign-up sends the guest back to: this same booking.
  const bookingNext = `/reserve/${slug}?party=${partySize}&date=${date}${selected ? `&time=${encodeURIComponent(selected)}` : ''}`

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected || !name.trim()) return
    if (!token) { setNeedsSignIn(true); return }
    // The phone and email on a booking are always the account's own (the API
    // ignores typed ones, UX-5), so the number is not checked here — an
    // international number on the account (2026-10-26) must not block a booking.
    setSubmitting(true)
    setError(null)
    setNeedsSignIn(false)
    setLimitReached(false)
    try {
      // The sitting length is the restaurant's (the API ignores a client
      // value), so none is sent.
      const res = await fetch(`${API_URL}/api/v1/reservations/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          conceptSlug: slug,
          partySize,
          startTime: selected,
          guestName: name.trim(),
          notes: notes.trim() || null,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<ApiErrorResponse>
        // The time was taken (or the share for guests without an account is
        // full) between loading the slots and pressing the button: say so and
        // show the times as they are now.
        if (res.status === 401 || body.error?.code === 'AUTH_REQUIRED') {
          setNeedsSignIn(true)
          throw new Error('Please sign in to your servd account to book a table.')
        }
        if (res.status === 409 && body.error?.code === 'BOOKING_LIMIT_REACHED') {
          setLimitReached(true)
          throw new Error('Your servd account already has 5 upcoming bookings, which is the most one account can hold at a time. Cancel one or wait until one has passed, then book again.')
        }
        if (res.status === 409 && (body.error?.code === 'SLOT_FULL' || body.error?.code === 'CLOSED')) {
          setReloadKey((k) => k + 1)
        }
        throw new Error(body?.error?.message ?? `Booking failed (${res.status})`)
      }
      const booking = (await res.json()) as BookingResponse
      track('reservation', { brand: slug, party_size: partySize })
      setDone(booking)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    const sentWhatsapp = !!done.notified?.whatsapp
    const sentEmail = !!done.notified?.email
    // The guest's own confirm / cancel page, on this site (the API's
    // confirmUrl names the storefront host it was configured with).
    const manageHref = `/reserve/confirm/${done.confirmToken}`
    const brand = formatBrandName(data?.concept.name)
    return (
      <div style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
        <div style={{ textAlign: 'center', maxWidth: '32rem' }}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-ink)"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            style={{ display: 'inline-block', marginBottom: '0.5rem' }}>
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <h1 ref={doneHeadingRef} tabIndex={-1} style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.75rem', outline: 'none' }}>
            Reservation request sent.
          </h1>
          {sentWhatsapp || sentEmail ? (
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1.25rem' }}>
              We&rsquo;ve sent a confirmation link to your {sentWhatsapp && sentEmail ? 'WhatsApp and email' : sentWhatsapp ? 'WhatsApp' : 'email'}
              {done.notified?.reminders ? ', and we’ll remind you before your booking' : ''}. {brand} will see it in their dashboard.
            </p>
          ) : (
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1.25rem' }}>
              {brand} will see your booking in their dashboard. We haven&rsquo;t sent a message, so keep this link to
              confirm or cancel your table:
            </p>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'center' }}>
            <MagneticLink href={manageHref} className="servd-btn-primary">Confirm or cancel your booking</MagneticLink>
            {!sentWhatsapp && (
              <p style={{ fontSize: '0.8rem', color: 'var(--servd-dim)', maxWidth: '26rem' }}>
                WhatsApp confirmations and reminders go to the verified phone on your account. Verify your number in your account to get them next time.
              </p>
            )}
            {token && partySize > 1 && (
              <div style={{ width: '100%', textAlign: 'left', marginTop: '0.5rem' }}>
                <InviteTable token={token} reservationId={done.id} partySize={partySize} />
              </div>
            )}
            <Link href="/account" style={{ color: 'var(--servd-green-ink)', fontWeight: 700, fontSize: '0.9rem' }}>See my bookings</Link>
            <Link href={backToBrandHref} style={{ color: 'var(--servd-mute)', fontSize: '0.85rem' }}>Back to {brand}</Link>
          </div>
        </div>
      </div>
    )
  }

  if (disabled) {
    return (
      <div style={{ minHeight: '60dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
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
    <div style={{ background: 'var(--servd-bg)', minHeight: '100dvh' }}>
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <Link href={backToBrandHref} style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', textDecoration: 'none' }}>
            ← {data ? formatBrandName(data.concept.name) : (brandName ?? 'Back')}
          </Link>
          <h1 style={{ fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            Book a table
          </h1>
          <p style={{ color: 'var(--servd-mute)' }}>
            {data ? `at ${formatBrandName(data.concept.name)}` : brandName ? `at ${brandName}` : 'Choose a time and we’ll save your spot.'}
          </p>
          {intro}
        </div>
      </section>

      <section className="section">
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '2rem', maxWidth: '52rem' }}>
          {/* Step 1: party + date */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>1. When and how many?</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
              <Field label="Party size">
                <select
                  value={partySize}
                  onChange={(e) => { restoreTime.current = null; setPartySize(parseInt(e.target.value, 10)) }}
                  className="sv-field-input servd-field"
                >
                  {PARTY_SIZES.map((n) => (
                    <option key={n} value={n}>{n} {n === 1 ? 'person' : 'people'}</option>
                  ))}
                </select>
              </Field>
              <Field label="Date">
                <input
                  type="date"
                  value={date}
                  min={todayPktIso()}
                  onChange={(e) => { restoreTime.current = null; setDate(e.target.value) }}
                  className="sv-field-input servd-field"
                />
              </Field>
            </div>
          </div>

          {/* Step 2: pick a slot */}
          <div className="servd-card" style={{ padding: '1.5rem' }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>2. Pick a time</h2>
            <div aria-live="polite">
              {loading && <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '0.75rem' }}>Loading availability…</p>}
              {!loading && !dateUsable && (
                <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '1.5rem' }}>
                  {date ? 'Pick today or a later date.' : 'Pick a date'}
                </p>
              )}
              {!loading && loadError && (
                <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '1.5rem' }}>
                  Couldn&rsquo;t load times ·{' '}
                  <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={{ color: 'var(--servd-green-ink)', fontWeight: 700, textDecoration: 'underline', minHeight: '44px', padding: '0 0.5rem' }}>Try again</button>
                </p>
              )}
              {!loading && data && dateUsable && !anyBookable && (
                <p style={{ color: 'var(--servd-mute)', textAlign: 'center', padding: '1.5rem' }}>
                  No tables for {partySize} on this day. Try another day.
                </p>
              )}
            </div>
            {!loading && data && dateUsable && !token && anyBookable && (
              <p style={{ fontSize: '0.85rem', color: 'var(--servd-mute)', marginBottom: '1rem' }}>
                Booking is for servd members. Pick a time, then sign in or create your free servd account to book it.
              </p>
            )}
            {data && dateUsable && groupedSlots.map(([groupName, slots]) => (
              <div key={groupName} aria-busy={loading} style={{ marginBottom: '1.25rem', opacity: loading ? 0.45 : 1, pointerEvents: loading ? 'none' : undefined, transition: 'opacity 0.15s' }}>
                <p style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--servd-mute)', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.6rem' }}>
                  {groupName}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.6rem' }}>
                  {slots.map((s) => {
                    const sel = selected === s.time
                    return (
                      <button
                        key={s.time}
                        type="button"
                        onClick={() => { restoreTime.current = null; setSelected(s.time) }}
                        aria-pressed={sel}
                        aria-label={`${new Date(s.time).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long' })}, ${fmtSlot(s.time)}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          minHeight: '56px',
                          padding: '0.6rem 0.5rem',
                          borderRadius: '0.75rem',
                          border: `1.5px solid ${sel ? 'var(--servd-green-dark)' : 'var(--servd-line)'}`,
                          background: sel ? 'var(--servd-green)' : 'var(--servd-surface)',
                          color: sel ? 'var(--servd-on-green)' : 'var(--servd-ink)',
                          fontWeight: sel ? 800 : 600,
                          fontSize: '1rem',
                          cursor: 'pointer',
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

          {/* Step 3: sign in (visitors) or guest details (members) */}
          {selected && !token && (
            <div className="servd-card" style={{ padding: '1.5rem' }}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>3. Sign in to book</h2>
              <p style={{ color: 'var(--servd-mute)', fontSize: '0.95rem', marginBottom: '1rem' }}>
                Tables are booked from a servd account. You&rsquo;ll come straight back to
                {' '}<strong>{partySize}</strong> at <strong>{fmtSlot(selected)} on {date}</strong>.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
                <MagneticLink href={withReturnPath('/login', bookingNext)} className="servd-btn-primary">Sign in</MagneticLink>
                <MagneticLink href={withReturnPath('/signup', bookingNext)} className="servd-btn-dark">Create a servd account</MagneticLink>
              </div>
            </div>
          )}

          {selected && token && (
            <form ref={formRef} className="servd-card" style={{ padding: '1.5rem' }} onSubmit={onSubmit}>
              <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '1rem' }}>3. Your details</h2>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                <Field label="Full name *">
                  <input ref={nameRef} required name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className="sv-field-input servd-field" />
                </Field>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                  <Field label="Phone (from your account)">
                    <input id="reserve-phone" name="tel" type="tel" value={phone ? `+${phone.replace(/^\+/, '')}` : ''} readOnly
                      className="sv-field-input servd-field" />
                  </Field>
                  <Field label="Email">
                    <input type="email" name="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} className="sv-field-input servd-field" />
                  </Field>
                </div>
                <Field label="Allergies, occasion, special requests">
                  <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} className="sv-field-input servd-field" />
                </Field>
              </div>

              <div style={{ marginTop: '1.25rem', padding: '0.75rem 1rem', background: 'var(--servd-green-soft)', borderRadius: '0.6rem', fontSize: '0.85rem', color: 'var(--servd-green-ink)' }}>
                Booking <strong>{partySize}</strong> at <strong>{formatBrandName(data?.concept.name)}</strong> for <strong>{fmtSlot(selected)} on {date}</strong>
              </div>

              {error && (
                <p role="alert" style={{ marginTop: '0.75rem', color: 'var(--servd-danger)', fontSize: '0.85rem' }}>
                  {error}
                  {needsSignIn && (
                    <> <Link href={withReturnPath('/login', bookingNext)} style={{ color: 'var(--servd-green-ink)', fontWeight: 700 }}>Sign in</Link></>
                  )}
                  {limitReached && (
                    <> <Link href="/account" style={{ color: 'var(--servd-green-ink)', fontWeight: 700 }}>See my bookings</Link></>
                  )}
                </p>
              )}

              <MagneticButton type="submit" disabled={submitting || !name.trim() || limitReached} className="servd-btn-primary" style={{ marginTop: '1rem', width: '100%', padding: '1rem' }}>
                {submitting ? 'Booking…' : 'Confirm booking'}
              </MagneticButton>
              <p style={{ fontSize: '0.7rem', color: 'var(--servd-dim)', textAlign: 'center', marginTop: '0.75rem' }}>
                {profile?.phoneVerifiedAt
                  ? 'You’ll get a WhatsApp confirmation on your verified number, and a reminder before your booking.'
                  : 'You’ll get a link to confirm or cancel on the next screen. Verify your phone in your account for WhatsApp confirmations and reminders.'}
              </p>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
