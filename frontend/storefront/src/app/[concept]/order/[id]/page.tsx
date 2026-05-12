'use client'
import { useEffect, useState, useRef } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { fmt, isLight } from '../../../../lib/ui'
import { useCustomerAuth } from '../../../../store/customerAuth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface OrderStatus {
  id: string; status: string; totalCents: number; customerName: string | null
  concept: { name: string; slug: string; primaryColor: string | null }
  items: Array<{ id: string; name: string; quantity: number; unitPriceCents: number; status: string }>
  rider?: {
    id: string; name: string; phone: string; vehicleType: string
    lastLat: number | null; lastLng: number | null; lastReportedAt: string | null
  } | null
  curbsideVehicle?: string | null
  curbsidePlate?: string | null
  curbsideArrivedAt?: string | null
  curbsideRunnerOutAt?: string | null
}

const STEPS = [
  { key: 'received',  label: 'Received',  icon: '📋' },
  { key: 'confirmed', label: 'Confirmed', icon: '✓'  },
  { key: 'preparing', label: 'Preparing', icon: '👨‍🍳' },
  { key: 'ready',     label: 'Ready!',    icon: '🎉' },
  { key: 'completed', label: 'Done',      icon: '✅' },
]
const STEP_INDEX: Record<string, number> = {
  received: 0, confirmed: 1, preparing: 2, ready: 3, completed: 4, cancelled: -1,
}

const STATUS_CONFIG: Record<string, { emoji: string; headline: string; sub: string; anim?: string }> = {
  received:  { emoji: '📋', headline: 'Order received',   sub: 'Waiting for confirmation…' },
  confirmed: { emoji: '✅', headline: 'Order confirmed',  sub: 'Getting ready for the kitchen' },
  preparing: { emoji: '👨‍🍳', headline: "We're cooking…",  sub: 'Your order is being prepared', anim: 'float 2s ease-in-out infinite' },
  ready:     { emoji: '🎉', headline: 'Ready for pickup!', sub: 'Head to the counter to collect your order', anim: 'float 1.4s ease-in-out infinite' },
  completed: { emoji: '🥡', headline: 'Order complete',   sub: 'Enjoy your meal!' },
  cancelled: { emoji: '❌', headline: 'Order cancelled',  sub: 'Something went wrong with this order' },
}

export default function OrderStatusPage() {
  const { concept: slug, id } = useParams<{ concept: string; id: string }>()
  const token = useCustomerAuth((s) => s.token)
  const [order,    setOrder]    = useState<OrderStatus | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [flash,    setFlash]    = useState(false)
  const prevStatus = useRef<string | null>(null)

  useEffect(() => {
    let stopped = false
    let iv: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (iv) { clearInterval(iv); iv = null } stopped = true }

    const poll = async () => {
      if (stopped) return
      try {
        let data: OrderStatus | null = null
        if (token) {
          const res = await fetch(`${API_URL}/api/v1/storefront/orders/${id}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          if (res.ok) data = await res.json() as OrderStatus
        }
        if (!data) {
          const res = await fetch(`${API_URL}/api/v1/storefront/guest-orders/${id}`)
          if (res.status === 404) { setNotFound(true); stop(); return }
          if (res.ok) data = await res.json() as OrderStatus
        }
        if (data) {
          if (prevStatus.current && prevStatus.current !== data.status) {
            setFlash(true)
            setTimeout(() => setFlash(false), 900)
          }
          prevStatus.current = data.status
          setOrder(data)
          // Terminal states — stop polling so idle tabs don't hammer the API forever.
          if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'refunded') {
            stop()
          }
        }
      } catch { /* keep polling */ }
    }
    void poll()
    iv = setInterval(() => void poll(), 10000)
    return () => stop()
  }, [id, token])

  if (notFound) return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-4"
      style={{ background: 'transparent' }}>
      <div className="text-7xl" style={{ animation: 'float 3s ease-in-out infinite' }}>🔍</div>
      <div className="text-center space-y-2">
        <p className="font-black text-2xl tracking-tight" style={{ color: '#18160f' }}>Order not found</p>
        <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>
          This order doesn&apos;t exist or may have been removed
        </p>
      </div>
      <Link href={`/${slug}`}
        className="rounded-2xl font-black px-8 py-4 text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
        style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', color: '#fff', boxShadow: '0 0 24px rgba(0,212,177,0.25)' }}>
        Back to menu
      </Link>
    </main>
  )

  if (!order) return (
    <main className="flex min-h-screen items-center justify-center" style={{ background: 'transparent' }}>
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-14 w-14">
          <div className="absolute inset-0 rounded-full" style={{ border: '2px solid rgba(0,0,0,0.07)' }} />
          <div className="absolute inset-0 rounded-full animate-spin"
            style={{ border: '2px solid transparent', borderTopColor: 'rgba(0,212,177,0.6)' }} />
        </div>
        <p className="text-sm" style={{ color: 'rgba(24,22,15,0.38)' }}>Loading your order…</p>
      </div>
    </main>
  )

  const color       = order.concept.primaryColor ?? '#6366f1'
  const stepIdx     = STEP_INDEX[order.status] ?? 0
  const isCancelled = order.status === 'cancelled'
  const isReady     = order.status === 'ready'
  const isPreparing = order.status === 'preparing'
  const isDone      = order.status === 'completed' || isCancelled
  const cfg         = STATUS_CONFIG[order.status] ?? STATUS_CONFIG['received']!

  const heroBg = isCancelled
    ? 'rgba(239,68,68,0.06)'
    : `linear-gradient(135deg, ${color}12 0%, transparent 100%)`
  const heroBorder = isCancelled
    ? '1px solid rgba(239,68,68,0.18)'
    : `1px solid ${color}28`
  const heroGlow = !isCancelled ? `0 0 40px ${color}10` : 'none'

  return (
    <main className="min-h-screen pb-16" style={{ background: 'transparent' }}>

      {/* Status-change flash overlay */}
      {flash && (
        <div className="fixed inset-0 z-50 pointer-events-none"
          style={{ background: `${color}10`, animation: 'fadeIn 0.15s ease-out' }} />
      )}

      {/* Subtle ambient glow */}
      <div className="fixed pointer-events-none select-none" style={{
        top: '-120px', left: '50%', transform: 'translateX(-50%)',
        width: '600px', height: '350px',
        background: `radial-gradient(ellipse, ${color}12 0%, transparent 70%)`,
      }} />

      {/* Header */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center gap-2.5"
        style={{ borderBottom: '1px solid rgba(0,0,0,0.08)', background: 'rgba(193,191,187,0.95)', backdropFilter: 'blur(12px)' }}>
        {token ? (
          <Link href="/account" className="flex items-center gap-1 text-xs font-bold mr-1 transition-opacity hover:opacity-60"
            style={{ color: 'rgba(24,22,15,0.45)' }}>
            ← My orders
          </Link>
        ) : (
          <Link href={`/${slug}`} className="flex items-center gap-1 text-xs font-bold mr-1 transition-opacity hover:opacity-60"
            style={{ color: 'rgba(24,22,15,0.45)' }}>
            ← Menu
          </Link>
        )}
        <span style={{ color: 'rgba(24,22,15,0.2)' }}>·</span>
        <span className="text-sm font-semibold" style={{ color: 'rgba(24,22,15,0.5)' }}>
          {order.concept.name}
        </span>
        {!isDone && !isCancelled && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: '#00D4B1' }} />
            <span className="text-xs font-bold" style={{ color: 'rgba(24,22,15,0.35)' }}>Live</span>
          </div>
        )}
      </div>

      <div className="relative z-10 max-w-md mx-auto px-4 py-6 space-y-4">

        {/* ── Status hero ── */}
        <div className="rounded-3xl p-8 text-center relative overflow-hidden grain"
          style={{ background: heroBg, border: heroBorder, boxShadow: heroGlow }}>
          {isReady && (
            <div className="absolute inset-0 rounded-3xl pointer-events-none"
              style={{ border: `1.5px solid ${color}40`, animation: 'glowPulse 2s ease-in-out infinite' }} />
          )}

          <div className="mb-5 text-7xl leading-none select-none"
            style={{ animation: cfg.anim ?? 'none' }}>
            {cfg.emoji}
          </div>

          {order.customerName && (
            <p className="text-sm font-medium mb-1" style={{ color: 'rgba(24,22,15,0.45)' }}>
              Hey, {order.customerName}!
            </p>
          )}

          <h1 className="font-black text-3xl leading-tight tracking-tight" style={{ color: '#18160f' }}>
            {cfg.headline}
          </h1>
          <p className="text-sm mt-2 font-medium" style={{ color: 'rgba(24,22,15,0.5)' }}>
            {cfg.sub}
          </p>

          {!isDone && !isReady && (
            <p className="text-xs mt-3" style={{ color: 'rgba(24,22,15,0.28)' }}>
              Updates automatically · checking every 10s
            </p>
          )}

          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{ background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.09)' }}>
            <span className="text-[9px] font-black uppercase tracking-[0.2em]"
              style={{ color: 'rgba(24,22,15,0.38)' }}>Order</span>
            <span className="text-[11px] font-black font-mono"
              style={{ color: 'rgba(24,22,15,0.55)' }}>
              #{order.id.slice(-8).toUpperCase()}
            </span>
          </div>
        </div>

        {/* ── Progress steps ── */}
        {!isCancelled && (
          <div className="rounded-2xl p-5"
            style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
            <div className="flex items-center">
              {STEPS.map((step, i) => {
                const done    = i <= stepIdx
                const current = i === stepIdx
                const last    = i === STEPS.length - 1
                return (
                  <div key={step.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-2 flex-1">
                      <div
                        className="h-9 w-9 rounded-full flex items-center justify-center text-sm transition-all duration-700"
                        style={{
                          background: done ? color : 'rgba(0,0,0,0.06)',
                          color: done ? (isLight(color) ? '#000' : '#fff') : 'rgba(24,22,15,0.28)',
                          boxShadow: current ? `0 0 18px ${color}60` : 'none',
                          transform: current ? 'scale(1.18)' : 'scale(1)',
                        }}>
                        {current && isPreparing
                          ? <span style={{ display: 'inline-block', animation: 'spin 1.2s linear infinite' }}>⚙</span>
                          : done
                          ? <span className="text-sm">{step.icon}</span>
                          : <span className="text-[11px]" style={{ color: 'rgba(24,22,15,0.25)' }}>{i + 1}</span>
                        }
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-wider text-center leading-tight"
                        style={{ color: done ? 'rgba(24,22,15,0.6)' : 'rgba(24,22,15,0.25)' }}>
                        {step.label}
                      </span>
                    </div>
                    {!last && (
                      <div className="h-px flex-1 mx-1 mb-5 transition-all duration-1000"
                        style={{ background: i < stepIdx ? color : 'rgba(0,0,0,0.08)' }} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Order items ── */}
        <section className="rounded-2xl overflow-hidden"
          style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
          <div className="px-4 py-3.5 flex items-center gap-2.5"
            style={{ borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
            <span className="text-sm">🧾</span>
            <p className="font-black text-sm" style={{ color: 'rgba(24,22,15,0.65)' }}>
              {order.concept.name}
            </p>
          </div>

          {/* Rider live status — only when assigned */}
          {order.rider && (
            <div className="px-4 py-3 border-b" style={{ borderColor: 'rgba(0,0,0,0.07)', background: 'rgba(34,197,94,0.06)' }}>
              <div className="flex items-center gap-3">
                <span className="text-2xl">🛵</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs uppercase tracking-wider font-bold" style={{ color: 'rgba(0,0,0,0.5)' }}>Your rider</p>
                  <p className="font-bold text-sm">{order.rider.name}</p>
                  <p className="text-xs" style={{ color: 'rgba(0,0,0,0.6)' }}>
                    {order.rider.vehicleType}
                    {order.rider.lastReportedAt && (
                      <> · last seen {Math.round((Date.now() - new Date(order.rider.lastReportedAt).getTime()) / 60000)}m ago</>
                    )}
                  </p>
                </div>
                <a href={`tel:${order.rider.phone}`}
                  className="px-3 py-1.5 rounded-full text-xs font-bold"
                  style={{ background: '#0a0a0a', color: '#fff' }}>
                  Call
                </a>
              </div>
              {order.rider.lastLat != null && order.rider.lastLng != null && (
                <a target="_blank" rel="noopener noreferrer"
                  href={`https://www.google.com/maps?q=${order.rider.lastLat},${order.rider.lastLng}`}
                  className="block mt-2 text-xs underline text-[color:var(--servd-green-dark)] font-semibold">
                  See live location on map ↗
                </a>
              )}
            </div>
          )}

          <div>
            {order.items.map((item, i) => (
              <div key={item.id}
                className="flex justify-between items-center px-4 py-3"
                style={{
                  borderBottom: i < order.items.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-xs font-black shrink-0"
                    style={{ color: 'rgba(24,22,15,0.38)' }}>{item.quantity}×</span>
                  <span className="text-sm font-semibold truncate"
                    style={{ color: 'rgba(24,22,15,0.75)' }}>{item.name}</span>
                </div>
                <span className="font-bold text-sm shrink-0"
                  style={{ color: 'rgba(24,22,15,0.55)' }}>
                  {fmt(item.unitPriceCents * item.quantity)}
                </span>
              </div>
            ))}
          </div>
          <div className="px-4 py-3.5 flex justify-between items-center"
            style={{ background: 'rgba(0,0,0,0.03)', borderTop: '1px solid rgba(0,0,0,0.07)' }}>
            <span className="font-black text-sm" style={{ color: '#18160f' }}>Total</span>
            <span className="font-black text-xl" style={{ color }}>{fmt(order.totalCents)}</span>
          </div>
        </section>

        {/* ── Curbside "I'm here" CTA ────────────────────────────────────
            Only shows for curbside orders that are ready and customer hasn't
            yet marked themselves as arrived. Tapping POSTs to /arrived which
            stamps the queue + flashes the admin /orders/curbside page. */}
        {order.curbsideVehicle && !order.curbsideArrivedAt && order.status !== 'cancelled' && order.status !== 'completed' && (
          <CurbsideArrivedButton orderId={order.id} onArrived={() => {
            setOrder((o) => o ? { ...o, curbsideArrivedAt: new Date().toISOString() } : o)
          }} />
        )}
        {order.curbsideVehicle && order.curbsideArrivedAt && !order.curbsideRunnerOutAt && (
          <div className="rounded-2xl px-4 py-3.5 text-center"
            style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#15803d' }}>
            <p className="font-black text-sm">✓ We see you. Bringing your food now.</p>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(21,128,61,0.7)' }}>{order.curbsideVehicle}</p>
          </div>
        )}
        {order.curbsideVehicle && order.curbsideRunnerOutAt && (
          <div className="rounded-2xl px-4 py-3.5 text-center"
            style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.35)', color: '#4338ca' }}>
            <p className="font-black text-sm">🚶 Runner is on their way to your car</p>
          </div>
        )}

        {/* ── Rate-your-meal CTA (completed orders only) ────────────────── */}
        {order.status === 'completed' && token && (
          <Link href={`/orders/${order.id}/review`}
            className="block w-full rounded-3xl overflow-hidden transition-all duration-200 hover:scale-[1.01] active:scale-[0.98]"
            style={{
              background: 'linear-gradient(135deg, #16a34a 0%, #00a896 100%)',
              boxShadow: '0 4px 24px rgba(22,163,74,0.32)',
            }}>
            <div className="px-6 py-5 flex items-center justify-between gap-4">
              <div>
                <p className="font-black text-lg leading-tight text-white">How was it?</p>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.78)' }}>
                  Leave a review and earn <span className="font-black text-white">+50 loyalty pts</span>
                </p>
              </div>
              <div className="shrink-0 h-12 w-12 rounded-2xl flex items-center justify-center"
                style={{ background: 'rgba(255,255,255,0.18)' }}>
                <span className="text-2xl leading-none">★</span>
              </div>
            </div>
          </Link>
        )}

        {/* ── Order again ── */}
        <Link href={`/${slug}`}
          className="flex items-center justify-center gap-2 w-full rounded-2xl py-3.5 font-bold text-sm transition-all duration-150 hover:scale-[1.01] active:scale-[0.98]"
          style={{
            background: '#fff',
            border: '1px solid rgba(0,0,0,0.08)',
            color: 'rgba(24,22,15,0.5)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = 'rgba(24,22,15,0.8)'
            e.currentTarget.style.borderColor = 'rgba(0,0,0,0.15)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = 'rgba(24,22,15,0.5)'
            e.currentTarget.style.borderColor = 'rgba(0,0,0,0.08)'
          }}>
          Order something else →
        </Link>
      </div>
    </main>
  )
}

// "I'm here" button for curbside orders. POSTs the arrival, then optimistic-
// updates the parent so the user immediately sees confirmation without the
// poll having to land.
function CurbsideArrivedButton({ orderId, onArrived }: { orderId: string; onArrived: () => void }) {
  const token = useCustomerAuth((s) => s.token)
  const [busy, setBusy] = useState(false)

  async function tap() {
    if (!token) return
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/storefront/orders/${orderId}/arrived`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({}),
      })
      if (res.ok) onArrived()
    } catch { /* swallow */ }
    finally { setBusy(false) }
  }

  return (
    <button onClick={tap} disabled={busy}
      className="flex items-center justify-center gap-2 w-full rounded-2xl py-4 font-black text-sm tracking-wide transition-all duration-150 hover:scale-[1.01] active:scale-[0.98]"
      style={{
        background: '#22c55e', color: '#fff',
        border: '2px solid #16a34a',
        boxShadow: '0 4px 16px rgba(34,197,94,0.25)',
        opacity: busy ? 0.6 : 1,
      }}>
      <span style={{ fontSize: '1.3rem' }}>🚗</span>
      <span>{busy ? "Letting them know…" : "I'm here!"}</span>
    </button>
  )
}
