'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useCustomerAuth } from '../../store/customerAuth'
import { useCart } from '../../store/cart'

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

function ReorderButton({ orderId, conceptSlug, token }: { orderId: string; conceptSlug: string; token: string }) {
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
      const data = await res.json() as { conceptSlug: string; items: Array<{ menuItemId: string | null; name: string; quantity: number; unitPriceCents: number }>; notice: string | null }
      const items = data.items
        .filter((i) => i.menuItemId)
        .map((i) => ({ menuItemId: i.menuItemId!, name: i.name, priceCents: i.unitPriceCents, quantity: i.quantity }))
      if (items.length === 0) {
        alert('Sorry — none of the items from that order are available right now.')
        return
      }
      hydrate(data.conceptSlug, items)
      if (data.notice) alert(data.notice)
      router.push(`/${data.conceptSlug}`)
    } catch (e) {
      alert((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={busy}
      style={{
        background: 'var(--servd-green)',
        color: 'var(--servd-black)',
        fontWeight: 700,
        fontSize: '0.8rem',
        padding: '0.45rem 0.9rem',
        borderRadius: '999px',
        border: 'none',
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? 'Loading…' : 'Reorder ↻'}
    </button>
  )
}

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  received:  { bg: 'rgba(59,130,246,0.12)', text: '#2563eb', label: 'Received' },
  confirmed: { bg: 'rgba(99,102,241,0.12)', text: '#4f46e5', label: 'Confirmed' },
  preparing: { bg: 'rgba(234,179,8,0.15)',  text: '#a16207', label: 'In the kitchen' },
  ready:     { bg: 'rgba(34,197,94,0.15)',  text: '#15803d', label: 'Ready' },
  completed: { bg: 'rgba(0,0,0,0.06)',      text: 'var(--servd-mute)', label: 'Delivered' },
  cancelled: { bg: 'rgba(239,68,68,0.12)',  text: '#dc2626', label: 'Cancelled' },
  refunded:  { bg: 'rgba(239,68,68,0.12)',  text: '#dc2626', label: 'Refunded' },
}

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
    <div style={{ background: 'var(--servd-bg)', minHeight: '70vh' }}>
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
            <div role="status" style={{ padding: '4rem 0', textAlign: 'center', color: 'var(--servd-mute)' }}>Loading…</div>
          ) : error ? (
            <div role="alert" className="servd-card" style={{ padding: '2rem', textAlign: 'center' }}>
              <p style={{ color: '#b91c1c', fontWeight: 600 }}>{error}</p>
              <button onClick={() => window.location.reload()} className="servd-btn-secondary" style={{ marginTop: '1rem' }}>Try again</button>
            </div>
          ) : !profile?.orders.length ? (
            <div className="servd-card" style={{ padding: '4rem 2rem', textAlign: 'center' }}>
              <h2 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>No orders yet</h2>
              <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem' }}>Once you order, it&rsquo;ll show up here for re-ordering with one tap.</p>
              <Link href="/browse" className="servd-btn-primary">Browse brands</Link>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '0.85rem' }}>
              {profile.orders.map((o) => {
                const badge = STATUS_BADGE[o.status] ?? { bg: 'rgba(0,0,0,0.06)', text: 'var(--servd-mute)', label: o.status }
                const itemSummary = o.items.slice(0, 2).map((i) => `${i.quantity}× ${i.name}`).join(', ')
                const more = o.items.length > 2 ? ` +${o.items.length - 2} more` : ''
                return (
                  <article
                    key={o.id}
                    className="servd-card"
                    style={{ padding: '1.25rem 1.5rem', display: 'grid', gridTemplateColumns: '1fr auto', gap: '1rem', alignItems: 'center' }}
                  >
                    <div>
                      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                        <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>{o.concept.name}</h2>
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
                        <ReorderButton orderId={o.id} conceptSlug={o.concept.slug} token={token!} />
                        <Link
                          href={['preparing', 'received', 'confirmed', 'ready'].includes(o.status)
                            ? `/${o.concept.slug}/order/${o.id}`
                            : `/${o.concept.slug}`}
                          style={{
                            display: 'inline-block',
                            background: 'var(--servd-black)',
                            color: 'white',
                            fontWeight: 700,
                            fontSize: '0.8rem',
                            padding: '0.45rem 0.9rem',
                            borderRadius: '999px',
                            textDecoration: 'none',
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
