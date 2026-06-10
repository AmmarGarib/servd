'use client'

// Post-order review page. Linked from the SMS/email "rate your meal" prompt
// AND surfaced inline on the order tracking page. Customer fills out a
// 30-second form: 5-star overall, optional sub-ratings, optional tag chips,
// optional comment. Submitting within 24h of completion gets +50 loyalty pts.

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { MagneticLink } from '@/components/ui/MagneticButton'
import { useCustomerAuth } from '../../../../store/customerAuth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface OrderInfo {
  id: string
  status: string
  completedAt: string | null
  conceptId: string
  concept: { name: string; slug: string }
  totalCents: number
  alreadyReviewed: boolean
}

const POSITIVE_TAGS = [
  'Food was great', 'Quick service', 'Generous portions', 'Friendly staff',
  'Good value', 'Loved the flavours', 'Hot when it arrived', 'Beautiful presentation',
] as const

const IMPROVEMENT_TAGS = [
  'Took too long', 'Cold when it arrived', 'Item missing', 'Wrong item',
  'Portion too small', 'Quality off', 'Driver was rude', 'Confusing menu',
] as const

export default function ReviewOrderPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const token = useCustomerAuth((s) => s.token)

  const [order, setOrder] = useState<OrderInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  const [rating, setRating]                 = useState<number>(0)
  const [foodRating, setFoodRating]         = useState<number>(0)
  const [serviceRating, setServiceRating]   = useState<number>(0)
  const [valueRating, setValueRating]       = useState<number>(0)
  const [speedRating, setSpeedRating]       = useState<number>(0)
  const [tags, setTags]       = useState<string[]>([])
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ bonusPointsAwarded: number } | null>(null)

  useEffect(() => {
    if (!token) {
      router.replace(`/login?next=/orders/${id}/review`)
      return
    }
    fetch(`${API_URL}/api/v1/storefront/orders/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (r) => {
        if (!r.ok) throw new Error('Order not found')
        return r.json() as Promise<OrderInfo>
      })
      .then((d) => setOrder(d))
      .catch(() => setError('Couldn\'t load this order. The link may be expired.'))
      .finally(() => setLoading(false))
  }, [id, router, token])

  const isLow = rating > 0 && rating <= 3
  const tagPalette = isLow ? IMPROVEMENT_TAGS : POSITIVE_TAGS

  function toggleTag(t: string) {
    setTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])
  }

  async function submit() {
    if (rating < 1) return
    setSubmitting(true)
    setError(null)
    try {
      const categoryRatings: Record<string, number> = {}
      if (foodRating)    categoryRatings.food = foodRating
      if (serviceRating) categoryRatings.service = serviceRating
      if (valueRating)   categoryRatings.value = valueRating
      if (speedRating)   categoryRatings.speed = speedRating

      const res = await fetch(`${API_URL}/api/v1/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          orderId: id,
          rating,
          comment: comment.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          categoryRatings: Object.keys(categoryRatings).length > 0 ? categoryRatings : undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message ?? 'Couldn\'t submit — please try again.')
      }
      const data = await res.json() as { bonusPointsAwarded?: number }
      setDone({ bonusPointsAwarded: data.bonusPointsAwarded ?? 0 })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return <Centered><p style={{ color: 'var(--servd-mute)' }}>Loading…</p></Centered>
  }
  if (!order) {
    return (
      <Centered>
        <h1 style={{ fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem' }}>Hmm.</h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>{error ?? 'We couldn\'t find this order.'}</p>
        <MagneticLink href="/orders" className="servd-btn-primary">My orders</MagneticLink>
      </Centered>
    )
  }
  if (order.alreadyReviewed) {
    return (
      <Centered>
        <div style={{ marginBottom: '0.75rem', color: 'var(--servd-green-dark)' }}><BigCheckIcon /></div>
        <h1 className="font-display" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem', letterSpacing: '-0.03em' }}>Already reviewed.</h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem' }}>Thanks for the feedback — it helps us cook better.</p>
        <MagneticLink href={`/brand/${order.concept.slug}`} className="servd-btn-primary">Back to {order.concept.name}</MagneticLink>
      </Centered>
    )
  }
  if (done) {
    return (
      <Centered>
        <div style={{ marginBottom: '0.75rem', color: 'var(--servd-green-dark)' }}>
          {rating >= 4 ? <BigStarIcon /> : <BigCheckIcon />}
        </div>
        <h1 className="font-display" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.6rem, 4vw, 2.25rem)', fontWeight: 800, marginBottom: '0.5rem', letterSpacing: '-0.03em' }}>
          {rating >= 4 ? 'Thanks for the love.' : 'Thanks for telling us.'}
        </h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '0.75rem' }}>
          {rating >= 4
            ? 'We\'re glad it landed. We\'ll pass this on to the team.'
            : 'We read every word. The kitchen will see this and we\'ll do better next time.'}
        </p>
        {done.bonusPointsAwarded > 0 && (
          <div style={{
            display: 'inline-block', padding: '0.6rem 1.1rem', marginBottom: '1.5rem',
            background: 'rgba(58,14,105,0.1)', color: 'var(--servd-green-dark)', borderRadius: '999px',
            fontWeight: 700, fontSize: '0.9rem',
          }}>
            +{done.bonusPointsAwarded} loyalty points credited
          </div>
        )}
        <div>
          <MagneticLink href={`/brand/${order.concept.slug}`} className="servd-btn-primary">Back to {order.concept.name}</MagneticLink>
        </div>
      </Centered>
    )
  }

  return (
    <div style={{ background: 'var(--servd-bg)', minHeight: '100vh', padding: '2rem 1rem' }}>
      <div style={{ maxWidth: '32rem', margin: '0 auto' }}>
        <Link href="/orders" style={{ color: 'var(--servd-mute)', fontSize: '0.85rem', textDecoration: 'none' }}>
          ← My orders
        </Link>

        <h1 className="font-display" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.75rem, 4vw, 2.5rem)', fontWeight: 800, marginTop: '0.5rem', marginBottom: '0.25rem', letterSpacing: '-0.03em', color: 'var(--servd-ink)' }}>
          How was your meal?
        </h1>
        <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem' }}>
          {order.concept.name} · 30 seconds · review within 24h for <strong style={{ color: 'var(--servd-ink)' }}>+50 loyalty points</strong>
        </p>

        {/* Overall stars */}
        <div className="servd-card" style={{ padding: '1.5rem', marginBottom: '1rem' }}>
          <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.75rem' }}>Overall</div>
          <StarPicker value={rating} onChange={setRating} large />
        </div>

        {/* Sub-ratings (only show after overall is picked) */}
        {rating > 0 && (
          <div className="servd-card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              Anything specific? <span style={{ color: 'var(--servd-mute)', fontWeight: 400 }}>(optional)</span>
            </div>
            <SubRow label="Food"    value={foodRating}    onChange={setFoodRating} />
            <SubRow label="Service" value={serviceRating} onChange={setServiceRating} />
            <SubRow label="Value"   value={valueRating}   onChange={setValueRating} />
            <SubRow label="Speed"   value={speedRating}   onChange={setSpeedRating} />
          </div>
        )}

        {/* Tag chips */}
        {rating > 0 && (
          <div className="servd-card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.75rem' }}>
              {isLow ? 'What went wrong?' : 'What stood out?'}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              {tagPalette.map((t) => {
                const active = tags.includes(t)
                return (
                  <button
                    key={t}
                    onClick={() => toggleTag(t)}
                    type="button"
                    style={{
                      padding: '0.5rem 0.85rem',
                      borderRadius: '999px',
                      border: `1px solid ${active ? 'var(--servd-green)' : 'var(--servd-line)'}`,
                      background: active ? 'rgba(58,14,105,0.1)' : 'white',
                      color: active ? 'var(--servd-green-dark)' : 'var(--servd-ink)',
                      fontSize: '0.85rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}>
                    {t}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Optional freeform */}
        {rating > 0 && (
          <div className="servd-card" style={{ padding: '1.25rem 1.5rem', marginBottom: '1.5rem' }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.5rem' }}>
              Anything else? <span style={{ color: 'var(--servd-mute)', fontWeight: 400 }}>(optional)</span>
            </div>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={isLow ? 'Tell us what we should fix…' : 'Tell us what made it special…'}
              style={{
                width: '100%', padding: '0.6rem 0.8rem', border: '1px solid var(--servd-line)',
                borderRadius: '0.5rem', fontSize: '0.9rem', resize: 'vertical', fontFamily: 'inherit',
              }} />
          </div>
        )}

        <button
          onClick={submit}
          disabled={rating < 1 || submitting}
          className="servd-btn-primary"
          style={{ width: '100%', padding: '1rem', fontSize: '1rem' }}>
          {submitting ? 'Submitting…' : rating < 1 ? 'Pick a star to submit' : 'Submit review'}
        </button>

        {error && (
          <p style={{ marginTop: '1rem', color: '#c2410c', fontSize: '0.85rem', textAlign: 'center' }}>{error}</p>
        )}
      </div>
    </div>
  )
}

function StarPicker({ value, onChange, large }: { value: number; onChange: (n: number) => void; large?: boolean }) {
  const size = large ? 36 : 22
  return (
    <div style={{ display: 'flex', gap: large ? '0.5rem' : '0.25rem' }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-label={`${n} star${n === 1 ? '' : 's'}`}
          onClick={() => onChange(n)}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0.15rem',
            color: n <= value ? '#F59E0B' : 'var(--servd-line)',
            transition: 'color 160ms ease',
            display: 'inline-flex',
          }}>
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
        </button>
      ))}
    </div>
  )
}

function SubRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.4rem 0' }}>
      <span style={{ fontSize: '0.9rem', color: 'var(--servd-ink)' }}>{label}</span>
      <StarPicker value={value} onChange={onChange} />
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
      <div style={{ textAlign: 'center', maxWidth: '32rem' }}>{children}</div>
    </div>
  )
}

// ── Inline SVG iconography — no emoji as structural icons ──────────────────

function BigStarIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  )
}

function BigCheckIcon() {
  return (
    <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"/>
      <path d="M8 12l3 3 5-6"/>
    </svg>
  )
}
