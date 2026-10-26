'use client'

// Simmer's booking page (owner, 2026-10-26: "Make simmers thing super minimal..
// and on top change the theme to 'invite your table at this niche supper club
// vibes'"). servd.pk/reserve/simmer (and simmer.pk/reserve/simmer, the same
// route). Only the essentials: night, party size, time, the name on the table
// (the account's proper name), hold it — then the invite-your-table link.
//
// simmer-brand rules hold here: lowercase voice (the wordmark is the only
// logo), Amarante (--simmer-display) + Times (--simmer-body), no white, no
// gradients, no exclamation marks, no emoji, one orange signal per viewport
// (the hold button; a picked time is bone, never orange), the tagline
// "simmer down." sits BELOW the wordmark, and none of the banned words.
//
// Same API as ReserveScreen: GET /reservations/availability, POST
// /reservations/public (servd members only — a signed-out guest is sent to
// sign in / create an account and comes back to the same night and time).

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useCustomerAuth } from '../../../store/customerAuth'
import { withReturnPath } from '@/components/auth/authFlow'
import { InviteTable } from '../../../components/reserve/InviteTable'
import { track } from '../../../lib/analytics'
import { PARTY_SIZES } from './partySizes'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const SLUG = 'simmer'

interface Slot { time: string; available: boolean; reason?: string }

function todayPkt(): string {
  return new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10)
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
}
function fmtNight(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase()
}

const bone = 'var(--simmer-bone)'
const boneSoft = 'color-mix(in srgb, var(--simmer-bone) 65%, transparent)'
const hair = '1px solid color-mix(in srgb, var(--simmer-bone) 30%, transparent)'

const fieldStyle: React.CSSProperties = {
  width: '100%', minHeight: 48, background: 'transparent', color: bone, border: 0, borderBottom: hair,
  borderRadius: 0, padding: '0.5rem 0', fontFamily: 'var(--simmer-body)', fontSize: '1.05rem', letterSpacing: '0.02em',
  colorScheme: 'dark',
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontFamily: 'var(--simmer-body)', fontSize: '0.72rem', letterSpacing: '0.28em', textTransform: 'lowercase', color: boneSoft,
}

export default function SimmerReserve() {
  const token = useCustomerAuth((s) => s.token)
  const [party, setParty] = useState(2)
  const [date, setDate] = useState(todayPkt())
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [booked, setBooked] = useState<{ id: string; confirmToken: string; startTime: string } | null>(null)

  // Back from sign-in: the same night, party and time.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    const p = parseInt(sp.get('party') ?? '', 10)
    if (PARTY_SIZES.includes(p)) setParty(p)
    const d = sp.get('date') ?? ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d)
    const t = sp.get('time')
    if (t) setPicked(t)
  }, [])

  // The name on the table: the account's proper name (editable — booking for someone else).
  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/account?conceptSlug=${SLUG}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((a: { name?: string | null } | null) => { if (a?.name) setName((v) => v || a.name || '') })
      .catch(() => {})
  }, [token])

  const dateOk = !!date && date >= todayPkt()
  useEffect(() => {
    if (!dateOk) { setSlots(null); return }
    const ctl = new AbortController()
    setLoading(true)
    fetch(`${API_URL}/api/v1/reservations/availability?conceptSlug=${SLUG}&date=${date}&partySize=${party}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { slots?: Slot[] } | null) => {
        if (ctl.signal.aborted) return
        const open = (d?.slots ?? []).filter((s) => s.available || s.reason === 'sign_in')
        setSlots(open)
        setPicked((p) => (p && open.some((s) => s.time === p) ? p : null))
      })
      .catch(() => { if (!ctl.signal.aborted) setSlots([]) })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false) })
    return () => ctl.abort()
  }, [date, dateOk, party, token])

  const next = useMemo(() => `/reserve/${SLUG}?party=${party}&date=${date}${picked ? `&time=${encodeURIComponent(picked)}` : ''}`, [party, date, picked])

  const hold = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!picked || !name.trim() || !token || busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${API_URL}/api/v1/reservations/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conceptSlug: SLUG, partySize: party, startTime: picked, guestName: name.trim() }),
      })
      const body = await res.json().catch(() => null) as { id?: string; confirmToken?: string; startTime?: string; error?: { code?: string; message?: string } } | null
      if (!res.ok || !body?.id || !body.confirmToken) {
        setError((body?.error?.message ?? 'that did not go through. try again.').toLowerCase().replace(/!/g, '.'))
        return
      }
      track('reservation', { brand: SLUG, party_size: party })
      setBooked({ id: body.id, confirmToken: body.confirmToken, startTime: body.startTime ?? picked })
      window.scrollTo(0, 0)
    } catch {
      setError('no connection. try again.')
    } finally { setBusy(false) }
  }

  return (
    <div className="simmer-page" style={{ minHeight: '100dvh', padding: '3.5rem 1rem 4rem' }}>
      <div style={{ maxWidth: '30rem', margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: '2.5rem' }}>
          <p className="wordmark" style={{ fontSize: '2.6rem', margin: 0, color: bone }}>simmer</p>
          <p className="utility" style={{ fontSize: '0.72rem', color: boneSoft, margin: '0.4rem 0 0' }}>simmer down.</p>
        </header>

        {booked ? (
          <section aria-live="polite">
            <h1 className="amarante" style={{ fontSize: 'clamp(2rem, 8vw, 2.6rem)', fontWeight: 400, lineHeight: 1.1, margin: 0 }}>your table is held.</h1>
            <p style={{ color: boneSoft, margin: '0.75rem 0 1.75rem', lineHeight: 1.6 }}>
              {fmtNight(booked.startTime)}, {fmtTime(booked.startTime)}. {party} at the table. now bring them in.
            </p>
            {token && party > 1 && <InviteTable token={token} reservationId={booked.id} tone="simmer" partySize={party} />}
            <p style={{ marginTop: '1.75rem', fontSize: '0.9rem' }}>
              <Link href={`/reserve/confirm/${booked.confirmToken}`} style={{ color: bone, textDecoration: 'underline' }}>confirm or cancel</Link>
              <span style={{ color: boneSoft }}> · </span>
              <Link href="/account" style={{ color: bone, textDecoration: 'underline' }}>my bookings</Link>
            </p>
          </section>
        ) : (
          <form onSubmit={(e) => { void hold(e) }} noValidate>
            <h1 className="amarante" style={{ fontSize: 'clamp(2rem, 8vw, 2.6rem)', fontWeight: 400, lineHeight: 1.1, margin: 0 }}>invite your table.</h1>
            <p style={{ color: boneSoft, margin: '0.75rem 0 2rem', lineHeight: 1.6 }}>
              a small room, one long night, the people you would cross town for. pick the night. we hold the seats, you send the invites.
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '1.25rem', marginBottom: '1.75rem' }}>
              <label>
                <span style={labelStyle}>the night</span>
                <input type="date" value={date} min={todayPkt()} onChange={(e) => { setDate(e.target.value); setPicked(null) }} style={fieldStyle} />
              </label>
              <label>
                <span style={labelStyle}>how many</span>
                <select value={party} onChange={(e) => { setParty(parseInt(e.target.value, 10)); setPicked(null) }} style={fieldStyle}>
                  {PARTY_SIZES.map((n) => <option key={n} value={n} style={{ background: 'var(--simmer-green)', color: bone }}>{n}</option>)}
                </select>
              </label>
            </div>

            <fieldset style={{ border: 0, padding: 0, margin: '0 0 1.75rem' }}>
              <legend style={labelStyle}>the time</legend>
              <div aria-live="polite" style={{ marginTop: '0.75rem' }}>
                {!dateOk && <p style={{ color: boneSoft }}>pick tonight or a later night.</p>}
                {dateOk && loading && !slots && <p style={{ color: boneSoft }}>finding seats…</p>}
                {dateOk && slots && slots.length === 0 && !loading && <p style={{ color: boneSoft }}>no seats for {party} that night. try another.</p>}
                {dateOk && slots && slots.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '0.5rem', opacity: loading ? 0.5 : 1 }}>
                    {slots.map((s) => {
                      const on = picked === s.time
                      return (
                        <button key={s.time} type="button" aria-pressed={on} onClick={() => setPicked(s.time)}
                          style={{
                            minHeight: 48, borderRadius: 0, cursor: 'pointer', fontFamily: 'var(--simmer-body)', fontSize: '1rem',
                            background: on ? bone : 'transparent', color: on ? 'var(--simmer-green)' : bone, border: hair,
                          }}>
                          {fmtTime(s.time)}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </fieldset>

            {token ? (
              <>
                <label style={{ display: 'block', marginBottom: '2rem' }}>
                  <span style={labelStyle}>the name on the table</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} style={fieldStyle} />
                </label>
                {error && <p role="alert" style={{ color: bone, marginBottom: '1rem' }}>{error}</p>}
                <button type="submit" disabled={!picked || !name.trim() || busy}
                  style={{
                    width: '100%', minHeight: 52, border: 0, borderRadius: 0, cursor: 'pointer',
                    background: 'var(--simmer-orange)', color: 'var(--simmer-green)', fontFamily: 'var(--simmer-body)',
                    fontSize: '1.05rem', letterSpacing: '0.12em', opacity: !picked || !name.trim() || busy ? 0.45 : 1,
                  }}>
                  {busy ? 'holding…' : 'hold the table'}
                </button>
              </>
            ) : (
              <div style={{ borderTop: hair, paddingTop: '1.25rem' }}>
                <p style={{ color: boneSoft, marginBottom: '1rem', lineHeight: 1.6 }}>
                  tables are held for servd members. sign in, and you come straight back to this night.
                </p>
                <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
                  <Link href={withReturnPath('/login', next)} style={{ color: 'var(--simmer-orange)', textDecoration: 'underline', fontSize: '1.05rem' }}>sign in</Link>
                  <Link href={withReturnPath('/signup', next)} style={{ color: bone, textDecoration: 'underline', fontSize: '1.05rem' }}>create a servd account</Link>
                </div>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
