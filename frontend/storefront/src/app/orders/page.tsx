'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { useCustomerAuth } from '../../store/customerAuth'
import { useCart, type CartItemModifier } from '../../store/cart'
import { ErrorToast } from '../../components/ui/ErrorToast'
import { HopDots } from '../../components/tactile/HopDots'
import { CrowdPoster } from '../../components/characters/CrowdPoster'
import { formatBrandName } from '../../lib/concept'
import styles from '../../components/checkout/checkout.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Order {
  id: string
  status: string
  totalCents: number
  placedAt: string
  concept: { name: string; slug: string }
  items: Array<{ name: string; quantity: number }>
}

interface Profile {
  name: string | null
  orders: Order[]
}

function ReorderButton({ orderId, conceptSlug, token, onError }: {
  orderId: string
  conceptSlug: string
  token: string
  onError: (msg: string) => void
}) {
  const router = useRouter()
  const hydrate = useCart((s) => s.hydrateFromReorder)
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (!token) { router.push('/login?next=/orders'); return }
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/storefront/orders/${orderId}/reorder`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`Reorder failed (${res.status})`)
      const data = await res.json() as {
        conceptSlug: string
        items: Array<{
          menuItemId: string | null
          name: string
          quantity: number
          unitPriceCents: number
          modifiers?: CartItemModifier[]
        }>
        notice: string | null
      }
      const items = data.items
        .filter((i) => i.menuItemId)
        .map((i) => ({
          menuItemId: i.menuItemId!,
          name: i.name,
          priceCents: i.unitPriceCents,
          quantity: i.quantity,
          modifiers: i.modifiers ?? [],
        }))
      if (items.length === 0) {
        onError('Sorry — none of the items from that order are available right now.')
        return
      }
      hydrate(data.conceptSlug, items)
      // Notice ("3 items were unavailable and removed") flows through to
      // the brand page via querystring so the cart drawer can surface it
      // in context rather than us yanking the user with an alert.
      const target = data.notice
        ? `/${data.conceptSlug}?reorderNotice=${encodeURIComponent(data.notice)}`
        : `/${data.conceptSlug}`
      router.push(target)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      aria-busy={busy || undefined}
      className={`${styles.pillBtn} ${styles.pressable}`}
      style={{
        background: 'var(--servd-green)', color: 'white',
        border: 'none',
        minWidth: '6.5rem',
        cursor: busy ? 'wait' : 'pointer',
      }}
    >
      {busy ? <HopDots size={5} gap={3} label="Loading your order" /> : 'Reorder ↻'}
    </button>
  )
}

// Status palette + labels moved to lib/orderStatus.ts so /account and
// /[concept]/order/[id] share the same surface (was previously drifting
// — "Ready" had a purple bg + green text here, the inverse of the brand
// palette). statusFor handles unknown statuses with a sensible default.
import { statusFor } from '../../lib/orderStatus'

export default function OrdersPage() {
  const router = useRouter()
  const { token } = useCustomerAuth()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) {
      router.replace('/login?next=/orders')
      return
    }
    fetch(`${API_URL}/api/v1/storefront/account`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (r.status === 401) { router.replace('/login?next=/orders'); return null }
        if (!r.ok) throw new Error(`Profile API returned ${r.status}`)
        return r.json()
      })
      .then((d) => { if (d) setProfile(d) })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false))
  }, [token, router])

  const fmtPkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div style={{ background: 'var(--servd-bg)', minHeight: '70dvh' }}>
      {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
      <section className="section-tight" style={{ borderBottom: '1px solid var(--servd-line)' }}>
        <div className="container">
          <p style={{ color: 'var(--servd-green-dark)', fontWeight: 700, fontSize: '0.75rem', letterSpacing: '0.18em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
            Orders
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 5vw, 3rem)', marginBottom: '0.5rem' }}>
            Your order history
          </h1>
          <p style={{ color: 'var(--servd-mute)' }}>
            Every meal, every brand, all in one place.
          </p>
        </div>
      </section>

      <section className="section-tight">
        <div className="container">
          {loading ? (
            <div role="status" aria-label="Loading your orders" style={{ display: 'grid', gap: '0.85rem', maxWidth: '820px', margin: '0 auto' }}>
              {[0, 1, 2].map((i) => (
                <div key={i} className={styles.skeleton} style={{ ['--i' as string]: i } as CSSProperties} aria-hidden="true" />
              ))}
              <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--servd-mute)', paddingTop: '0.5rem' }}>
                <HopDots size={7} gap={5} />
              </div>
            </div>
          ) : error ? (
            <div role="alert" className="servd-card" style={{ padding: '2rem', textAlign: 'center' }}>
              <p style={{ color: '#b91c1c', fontWeight: 600 }}>{error}</p>
              <button onClick={() => window.location.reload()} className="servd-btn-secondary" style={{ marginTop: '1rem' }}>Try again</button>
            </div>
          ) : !profile?.orders.length ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem 0 2.5rem' }}>
              <div className={styles.stickerCard}>
                <div className={styles.posterFrame}>
                  <CrowdPoster cast={['burger', 'coffee']} mode="shrug" />
                </div>
                <h2 className={styles.stickerTitle}>No orders yet.</h2>
                <p className={styles.stickerSub}>Once you order, it&rsquo;ll show up here for re-ordering with one tap.</p>
                <Link href="/browse" className={`${styles.rubber} ${styles.rubberPrimary}`}>
                  Find something to eat
                </Link>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '0.85rem', maxWidth: '820px', margin: '0 auto' }}>
              {profile.orders.map((o, idx) => {
                const badge = statusFor(o.status)
                const itemSummary = o.items.slice(0, 2).map((i) => `${i.quantity}× ${i.name}`).join(', ')
                const more = o.items.length > 2 ? ` +${o.items.length - 2} more` : ''
                return (
                  <article
                    key={o.id}
                    className={`servd-card ${styles.cardSquish} ${styles.panelIn}`}
                    style={{ padding: '1.25rem 1.5rem', display: 'grid', gridTemplateColumns: '1fr auto', gap: '1rem', alignItems: 'center', ['--i' as string]: Math.min(idx, 8) } as CSSProperties}
                  >
                    <div>
                      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                        <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>{formatBrandName(o.concept.name)}</h2>
                        <span style={{
                          background: badge.bg, color: badge.text,
                          fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.06em',
                          textTransform: 'uppercase', padding: '0.2rem 0.55rem', borderRadius: '999px',
                        }}>
                          {badge.label}
                        </span>
                      </div>
                      <p style={{ color: 'var(--servd-mute)', fontSize: '0.875rem', marginBottom: '0.25rem' }}>
                        {itemSummary}{more}
                      </p>
                      <p style={{ color: 'var(--servd-dim)', fontSize: '0.75rem' }}>
                        {fmtDate(o.placedAt)} · #{o.id.slice(0, 8)}
                      </p>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: '0.4rem', alignItems: 'flex-end' }}>
                      <p style={{ fontWeight: 800, fontSize: '1.05rem' }}>{fmtPkr(o.totalCents)}</p>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <ReorderButton orderId={o.id} conceptSlug={o.concept.slug} token={token!} onError={setError} />
                        <Link
                          href={['preparing', 'received', 'confirmed', 'ready'].includes(o.status)
                            ? `/${o.concept.slug}/order/${o.id}`
                            : `/${o.concept.slug}`}
                          className={`${styles.pillBtn} ${styles.pressable}`}
                          style={{
                            background: 'var(--servd-black)',
                            color: 'white',
                          }}
                        >
                          {['preparing', 'received', 'confirmed', 'ready'].includes(o.status) ? 'Track →' : 'Visit brand'}
                        </Link>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
