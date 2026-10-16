'use client'

// Public landing page for waitlist promotion offers. The guest gets here
// from an SMS/email link sent by the backend when a slot opens up. They see
// the offered slot + an expiring countdown, and one button to claim.
//
// Endpoints used:
//   GET  /api/v1/reservations/claim/:token  → fetch offer
//   POST /api/v1/reservations/claim/:token  → atomically apply offer

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { formatBrandName } from '../../../../lib/concept'
import { brandCanonical } from '../../../../lib/brandDomains'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface OfferResponse {
  guestName: string
  partySize: number
  offeredStartTime: string
  offeredEndTime: string
  expiresAt: string
  expired: boolean
  alreadyClaimed: boolean
  concept: { name: string; slug: string }
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export default function ClaimOfferPage() {
  const { token } = useParams<{ token: string }>()
  const [offer, setOffer]       = useState<OfferResponse | null>(null)
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)
  const [claimed, setClaimed]   = useState(false)
  const [now, setNow]           = useState(Date.now())

  // Tick every second so the countdown rerenders.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    fetch(`${API_URL}/api/v1/reservations/claim/${token}`)
      .then((r) => (r.ok ? r.json() as Promise<OfferResponse> : Promise.reject(r)))
      .then((d) => setOffer(d))
      .catch(() => setError('We couldn\'t find this offer. It may have already been claimed or the link is wrong.'))
      .finally(() => setLoading(false))
  }, [token])

  const onClaim = async () => {
    setClaiming(true)
    setError(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/reservations/claim/${token}`, { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message ?? 'Couldn\'t claim — please try again.')
      }
      setClaimed(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setClaiming(false)
    }
  }

  if (loading) {
    return <Centered><p style={{ color: 'var(--servd-mute)' }}>Looking for your offer…</p></Centered>
  }

  if (!offer || error && !offer) {
    return (
      <Centered>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem' }}>Offer not found</h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>{error ?? 'This offer link is no longer active.'}</p>
        <Link href="/" className="servd-btn-primary">servd home</Link>
      </Centered>
    )
  }

  if (claimed) {
    return (
      <Centered>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>✓</div>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem' }}>
          Confirmed.
        </h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '0.5rem' }}>
          Your table for <strong>{offer.partySize}</strong> at <strong>{formatBrandName(offer.concept.name)}</strong>.
        </p>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
          {fmtDateTime(offer.offeredStartTime)} PKT
        </p>
        <Link href={brandCanonical(offer.concept.slug)} className="servd-btn-primary">Back to {formatBrandName(offer.concept.name)}</Link>
      </Centered>
    )
  }

  if (offer.alreadyClaimed) {
    return (
      <Centered>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem' }}>Already claimed.</h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>This offer has been confirmed already.</p>
        <Link href={brandCanonical(offer.concept.slug)} className="servd-btn-primary">Back to {formatBrandName(offer.concept.name)}</Link>
      </Centered>
    )
  }

  if (offer.expired) {
    return (
      <Centered>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>⏱</div>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem' }}>This offer expired.</h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
          Sorry — we offered the slot to the next person on the list. Want to try a different time?
        </p>
        <Link href={`/reserve/${offer.concept.slug}`} className="servd-btn-primary">
          Pick another time
        </Link>
      </Centered>
    )
  }

  // Active offer — show details + countdown + claim button.
  const msLeft = Math.max(0, new Date(offer.expiresAt).getTime() - now)
  const minutesLeft = Math.floor(msLeft / 60000)
  const secondsLeft = Math.floor((msLeft % 60000) / 1000)

  return (
    <Centered>
      <p style={{ fontSize: '0.85rem', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--servd-mute)', marginBottom: '0.5rem' }}>
        A table opened up
      </p>
      <h1 style={{ fontSize: 'clamp(1.75rem, 5vw, 2.75rem)', fontWeight: 800, lineHeight: 1.15, marginBottom: '0.75rem' }}>
        {formatBrandName(offer.concept.name)}
      </h1>
      <p style={{ fontSize: '1.1rem', color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>
        Table for <strong style={{ color: '#000' }}>{offer.partySize}</strong> · <strong style={{ color: '#000' }}>{fmtDateTime(offer.offeredStartTime)} PKT</strong>
      </p>

      <div style={{
        display: 'inline-block', padding: '0.6rem 1.1rem', marginBottom: '1.5rem',
        border: '1px solid var(--servd-line)', borderRadius: '999px',
        fontVariantNumeric: 'tabular-nums', fontWeight: 600, fontSize: '0.95rem',
        color: minutesLeft < 5 ? '#c2410c' : 'var(--servd-mute)',
      }}>
        ⏱ {minutesLeft}m {secondsLeft.toString().padStart(2, '0')}s left to confirm
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <button
          onClick={onClaim}
          disabled={claiming || msLeft === 0}
          className="servd-btn-primary"
          style={{ minWidth: '14rem', fontSize: '1rem' }}>
          {claiming ? 'Confirming…' : 'Confirm my table'}
        </button>
      </div>

      <p style={{ fontSize: '0.8rem', color: 'var(--servd-mute)' }}>
        Can't make it? Just close this page — we'll offer the slot to the next person.
      </p>

      {error && (
        <p style={{ marginTop: '1rem', color: '#c2410c', fontSize: '0.85rem' }}>{error}</p>
      )}
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '70dvh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '2rem', background: '#fff',
    }}>
      <div style={{ textAlign: 'center', maxWidth: '32rem' }}>{children}</div>
    </div>
  )
}
