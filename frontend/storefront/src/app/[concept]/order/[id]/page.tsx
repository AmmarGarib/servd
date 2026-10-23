'use client'
import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { fmt, isLight } from '../../../../lib/ui'
import { useCustomerAuth } from '../../../../store/customerAuth'
import { LoadingScreen } from '../../../../components/ui/Loader'
import { trackPurchaseOnce } from '../../../../lib/analytics'

// /<concept>/order/[id] — live order tracker.
// Restyled onto the on-system --servd-* tokens. Status icons are inline
// SVG (no emoji as structural icons). 10s polling, stops on terminal
// state.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface OrderStatus {
  id: string; status: string; totalCents: number; customerName: string | null
  concept: { name: string; slug: string; primaryColor: string | null; isTestCompany?: boolean }
  /** Present when the API marks the order's company as a test company. */
  isTestCompany?: boolean
  items: Array<{ id: string; name: string; quantity: number; unitPriceCents: number; status: string }>
  rider?: {
    id: string; name: string; phone: string; vehicleType: string
    lastLat: number | null; lastLng: number | null; lastReportedAt: string | null
  } | null
  curbsideVehicle?: string | null
  curbsidePlate?: string | null
  curbsideArrivedAt?: string | null
  curbsideRunnerOutAt?: string | null
  fulfilmentType?: string | null
  deliveredAt?: string | null
  /** When a rider was put on the order (docs/rider-app.md). */
  riderAssignedAt?: string | null
  /** The hand-over code for the rider at the door (docs/rider-app.md). The
   *  API sends it to the order's own customer, on delivery orders only. */
  deliveryOtp?: string | null
  /** True when the hand-over code was moved to the rider (the customer cannot
   *  give it): the API then sends no code and this line replaces the code block. */
  handoverRerouted?: boolean
  /** The order's own stored figures (H9) — the API sends them as columns.
   *  taxCents is ALL the GST charged: the food's AND the delivery fee's.
   *  Optional so an older API still renders. */
  taxCents?: number
  /** The delivery fee BEFORE its GST; 0 / absent on pickup, curbside, dine-in. */
  deliveryFeeCents?: number
  /** The GST on that fee (already inside taxCents). */
  deliveryFeeTaxCents?: number
}

/** A tel: link for the rider. Rider numbers are stored normalised (92…
 *  digits, docs/rider-app.md); without the + a phone dials them as local. */
function riderTel(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  return `tel:${digits.startsWith('92') ? `+${digits}` : digits}`
}

/** Statuses after which there is nothing left to hand over. 'completed' is
 *  not one of them: a delivery order paid at the till is 'completed' there
 *  and still has a rider on the way (see riderJobOpen). */
const CLOSED = new Set(['cancelled', 'rejected', 'refunded'])

/** How long a till-completed delivery stays an open rider job — the API's
 *  rule (backend modules/rider/service.ts openJobWhere: 24 h from the rider
 *  being assigned). */
const COMPLETED_JOB_WINDOW_MS = 24 * 60 * 60_000

/**
 * A rider has this delivery and has not handed it over yet — the customer
 * needs their code. Decided by deliveredAt, not by status: an order paid at
 * the till is 'completed' before it leaves the kitchen, and the rider still
 * asks for the code at the door.
 */
function riderJobOpen(o: OrderStatus): boolean {
  if (o.fulfilmentType !== 'delivery' || !o.rider || o.deliveredAt) return false
  if (CLOSED.has(o.status)) return false
  if (o.status !== 'completed') return true
  const assigned = o.riderAssignedAt ? Date.parse(o.riderAssignedAt) : NaN
  return Number.isFinite(assigned) && Date.now() - assigned < COMPLETED_JOB_WINDOW_MS
}

/** Nothing more will change on this order: stop polling. */
function trackingDone(o: OrderStatus): boolean {
  if (CLOSED.has(o.status)) return true
  // A completed delivery keeps polling until the rider hands it over, so the
  // code card goes away by itself.
  return o.status === 'completed' && !riderJobOpen(o)
}

const STEPS = [
  { key: 'received',  label: 'Received'  },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready',     label: 'Ready'     },
  { key: 'completed', label: 'Done'      },
] as const

const STEP_INDEX: Record<string, number> = {
  received: 0, confirmed: 1, preparing: 2, ready: 3, completed: 4, cancelled: -1,
}

// Headline + sub copy moved to lib/orderStatus.ts so all three order
// surfaces (/orders, /account, this tracker) share the same wording.
import { statusFor } from '../../../../lib/orderStatus'
import { TestCompanyStripe } from '../../../../components/TestCompanyStripe'
import { formatBrandName } from '../../../../lib/concept'

export default function OrderStatusPage() {
  const { concept: slug, id } = useParams<{ concept: string; id: string }>()
  const router = useRouter()
  const pathname = usePathname()
  const token = useCustomerAuth((s) => s.token)
  const [order,    setOrder]    = useState<OrderStatus | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [flash,    setFlash]    = useState(false)
  const prevStatus = useRef<string | null>(null)

  // Guest order viewing is gone — every order tracker requires sign-in.
  // Bounce to login with a return URL so the customer lands back here after
  // authenticating. Old SMS tracker links flow through this same path.
  useEffect(() => {
    if (!token) {
      const ret = encodeURIComponent(pathname ?? `/${slug}/order/${id}`)
      router.replace(`/login?return=${ret}`)
    }
  }, [token, router, pathname, slug, id])

  // Last good answer, and whether the last poll(s) failed. Drives the
  // "Reconnecting…" / "Updated n s ago" line.
  const [lastOkAt, setLastOkAt] = useState<number | null>(null)
  const [reconnecting, setReconnecting] = useState(false)

  // Poll for the order — a visibility-aware loop: nothing is requested while
  // the tab is hidden, and the moment the customer comes back (or the network
  // does) it refetches at once instead of waiting out the interval. Failures
  // back off and show "Reconnecting…" rather than a stale status that looks
  // live.
  useEffect(() => {
    if (!token) return
    let stopped = false
    let inflight = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null } }
    const stop = () => { stopped = true; clearTimer() }
    const schedule = () => {
      clearTimer()
      if (stopped || document.hidden) return
      const delay = failures > 0 ? Math.min(30000, 5000 * 2 ** failures) : 10000
      timer = setTimeout(() => void poll(), delay)
    }

    const poll = async () => {
      if (stopped || inflight) return
      clearTimer()
      inflight = true
      try {
        const res = await fetch(`${API_URL}/api/v1/storefront/orders/${id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 401 || res.status === 403) {
          const ret = encodeURIComponent(pathname ?? `/${slug}/order/${id}`)
          router.replace(`/login?return=${ret}`)
          stop()
          return
        }
        if (res.status === 404) { setNotFound(true); stop(); return }
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = await res.json() as OrderStatus
        failures = 0
        setReconnecting(false)
        setLastOkAt(Date.now())
        if (prevStatus.current && prevStatus.current !== data.status) {
          setFlash(true)
          setTimeout(() => setFlash(false), 900)
        }
        prevStatus.current = data.status
        setOrder(data)
        // GA4 purchase: once, only for the order this tab just placed (value,
        // currency and order reference only — no personal data). Test
        // companies never count.
        trackPurchaseOnce({
          id: data.id, totalCents: data.totalCents, taxCents: data.taxCents, slug: data.concept.slug,
          isTest: data.isTestCompany === true || data.concept.isTestCompany === true, status: data.status,
        })
        if (trackingDone(data)) { stop(); return }
      } catch {
        failures += 1
        if (!stopped) setReconnecting(true)
      } finally {
        inflight = false
      }
      schedule()
    }

    const onVisibility = () => {
      if (document.hidden) clearTimer()
      else void poll()
    }
    const onOnline = () => void poll()
    const onOffline = () => setReconnecting(true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    void poll()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [id, token, router, pathname, slug])

  if (notFound) return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4" style={{ background: 'var(--servd-bg)' }}>
      <SearchIcon size={48} stroke="var(--servd-mute)" />
      <div className="text-center space-y-2">
        <p className="font-display font-black text-2xl tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)' }}>Order not found</p>
        <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>
          This order doesn&apos;t exist or may have been removed.
        </p>
      </div>
      <Link href={`/${slug}`}
        className="rounded-[var(--servd-btn-radius)] font-black px-8 py-4 text-sm transition-transform active:scale-[0.98]"
        style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)', boxShadow: '0 6px 18px rgba(61,31,59,0.28)' }}>
        Back to menu
      </Link>
    </div>
  )

  if (!order) return (
    <div className="flex min-h-dvh items-center justify-center" style={{ background: 'var(--servd-bg)' }}>
      <LoadingScreen label="Loading your order…" minHeight="auto" />
    </div>
  )

  // Brand accent for the per-brand color wash on the hero ring + total. Use
  // brandAccent override semantics: prefer the brand's primaryColor, fall
  // back to servd-green.
  const color       = order.concept.primaryColor ?? 'var(--servd-green)'
  const stepIdx     = STEP_INDEX[order.status] ?? 0
  const isCancelled = order.status === 'cancelled'
  const isReady     = order.status === 'ready'
  const isPreparing = order.status === 'preparing'
  // The hand-over code: once a rider has the order and until it is delivered.
  const jobOpen     = riderJobOpen(order)
  const handoverCode = jobOpen ? (order.deliveryOtp ?? '').trim() : ''
  // A till-completed delivery is still live until the rider hands it over.
  const isDone      = (order.status === 'completed' && !jobOpen) || isCancelled
  const cfg         = statusFor(order.status)

  const heroBg     = isCancelled ? 'rgba(239,68,68,0.06)' : `color-mix(in srgb, ${color} 8%, white)`
  const heroBorder = isCancelled ? '1px solid rgba(239,68,68,0.22)' : `1px solid color-mix(in srgb, ${color} 25%, transparent)`

  return (
    <div className="min-h-dvh pb-16" style={{ background: 'var(--servd-bg)' }}>
      <TestCompanyStripe show={order.isTestCompany === true || order.concept.isTestCompany === true} />

      {flash && (
        <div className="fixed inset-0 z-50 pointer-events-none"
          style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, animation: 'fadeIn 0.15s ease-out' }} />
      )}

      {/* Sticky header — on-system glass bar, matches /checkout */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center gap-2.5"
        style={{ borderBottom: '1px solid var(--servd-line)', background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(16px)' }}>
        {token ? (
          <Link href="/account" className="flex items-center gap-1 text-xs font-bold mr-1 transition-colors" style={{ color: 'var(--servd-mute)' }}>
            ← My orders
          </Link>
        ) : (
          <Link href={`/${slug}`} className="flex items-center gap-1 text-xs font-bold mr-1 transition-colors" style={{ color: 'var(--servd-mute)' }}>
            ← Menu
          </Link>
        )}
        <span style={{ color: 'var(--servd-dim)' }}>·</span>
        <span className="font-display text-sm font-semibold" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)' }}>
          {formatBrandName(order.concept.name)}
        </span>
        {!isDone && !isCancelled && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--servd-green)' }} />
            <span className="text-xs font-bold" style={{ color: 'var(--servd-mute)' }}>Live</span>
          </div>
        )}
      </div>

      <div className="relative z-10 max-w-md lg:max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* ── Status hero ── */}
        <div className="rounded-3xl p-7 text-center relative overflow-hidden"
          style={{ background: heroBg, border: heroBorder }}>
          {isReady && (
            <div className="absolute inset-0 rounded-3xl pointer-events-none"
              style={{ border: `1.5px solid color-mix(in srgb, ${color} 40%, transparent)`, animation: 'glowPulse 2s ease-in-out infinite' }} />
          )}

          <div className="mb-5 flex justify-center" style={{ color }}>
            <StatusIcon status={order.status} animated={isPreparing} />
          </div>

          {order.customerName && (
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--servd-mute)' }}>
              Hi, {order.customerName}.
            </p>
          )}

          {/* Announced politely when the status changes. */}
          <div role="status" aria-live="polite" aria-atomic="true">
            <h1 className="font-display font-black text-3xl leading-tight tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>
              {cfg.headline}
            </h1>
            <p className="text-sm mt-2 font-medium" style={{ color: 'var(--servd-mute)' }}>
              {cfg.sub}
            </p>
          </div>

          {!isDone && (reconnecting || !isReady) && (
            <FreshnessLine since={lastOkAt} reconnecting={reconnecting} />
          )}

          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)' }}>
            <span className="text-[9px] font-black uppercase tracking-[0.2em]" style={{ color: 'var(--servd-mute)' }}>Order</span>
            <span className="text-[11px] font-black font-mono" style={{ color: 'var(--servd-ink)' }}>
              #{order.id.slice(-8).toUpperCase()}
            </span>
          </div>
        </div>

        {/* ── Delivery hand-over code ── */}
        {order.handoverRerouted === true && jobOpen ? (
          <div className="rounded-2xl px-4 py-3.5 text-sm font-semibold"
            style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' }}>
            Your rider has the code for this order.
          </div>
        ) : handoverCode ? <DeliveryCode code={handoverCode} riderName={order.rider?.name ?? null} /> : null}

        {/* ── Progress steps ── */}
        {!isCancelled && (
          <div className="rounded-2xl p-5"
            style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
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
                          background: done ? color : 'var(--servd-surface)',
                          color: done ? (order.concept.primaryColor ? (isLight(color) ? '#000' : '#fff') : 'var(--servd-on-green)') : 'var(--servd-dim)',
                          boxShadow: current ? `0 0 18px color-mix(in srgb, ${color} 60%, transparent)` : 'none',
                          transform: current ? 'scale(1.15)' : 'scale(1)',
                        }}>
                        {current && isPreparing
                          ? <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full"
                              style={{ border: '2px solid currentColor', borderRightColor: 'transparent' }} />
                          : done
                            ? <CheckSmall />
                            : <span className="text-[11px]" style={{ color: 'var(--servd-dim)' }}>{i + 1}</span>
                        }
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-wider text-center leading-tight"
                        style={{ color: done ? 'var(--servd-ink)' : 'var(--servd-dim)' }}>
                        {step.label}
                      </span>
                    </div>
                    {!last && (
                      <div className="h-px flex-1 mx-1 mb-5 transition-all duration-1000"
                        style={{ background: i < stepIdx ? color : 'var(--servd-line)' }} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── Order items + total ── */}
        <section className="rounded-2xl overflow-hidden"
          style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div className="px-4 py-3.5"
            style={{ borderBottom: '1px solid var(--servd-line)' }}>
            <p className="font-display font-black text-sm" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)' }}>
              {formatBrandName(order.concept.name)}
            </p>
          </div>

          {order.rider && (
            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--servd-line)', background: 'rgba(135,197,64,0.06)' }}>
              <div className="flex items-center gap-3">
                <span style={{ color: 'var(--servd-green-dark)' }}><BikeIcon /></span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs uppercase tracking-wider font-bold" style={{ color: 'var(--servd-mute)' }}>Your rider</p>
                  <p className="font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>{order.rider.name}</p>
                  <p className="text-xs" style={{ color: 'var(--servd-mute)' }}>
                    {order.rider.vehicleType}
                    {order.rider.lastReportedAt && (
                      <> · last seen {Math.round((Date.now() - new Date(order.rider.lastReportedAt).getTime()) / 60000)}m ago</>
                    )}
                  </p>
                </div>
                <a href={riderTel(order.rider.phone)}
                  className="px-3 py-1.5 rounded-[var(--servd-btn-radius)] text-xs font-bold"
                  style={{ background: 'var(--servd-ink)', color: '#fff' }}>
                  Call
                </a>
              </div>
              {order.rider.lastLat != null && order.rider.lastLng != null && (
                <a target="_blank" rel="noopener noreferrer"
                  href={`https://www.google.com/maps?q=${order.rider.lastLat},${order.rider.lastLng}`}
                  className="block mt-2 text-xs underline font-semibold" style={{ color: 'var(--servd-green-dark)' }}>
                  See live location on map ↗
                </a>
              )}
            </div>
          )}

          <div>
            {order.items.map((item, i) => (
              <div key={item.id}
                className="flex justify-between items-center px-4 py-3"
                style={{ borderBottom: i < order.items.length - 1 ? '1px solid var(--servd-line)' : 'none' }}>
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="text-xs font-black shrink-0" style={{ color: 'var(--servd-mute)' }}>{item.quantity}×</span>
                  <span className="text-sm font-semibold truncate" style={{ color: 'var(--servd-ink)' }}>{item.name}</span>
                </div>
                <span className="font-bold text-sm shrink-0" style={{ color: 'var(--servd-mute)' }}>
                  {fmt(item.unitPriceCents * item.quantity)}
                </span>
              </div>
            ))}
          </div>
          {/* GST and the delivery fee — the order's stored figures, nothing
              worked out here. One GST row (the food's AND the delivery's)
              with the delivery share named; the Delivery row only when the
              order had a fee. The fee is charged before its GST (H9). */}
          {((order.taxCents ?? 0) > 0 || (order.deliveryFeeCents ?? 0) > 0) && (
            <div className="px-4 py-2.5 space-y-1.5"
              style={{ borderTop: '1px solid var(--servd-line)' }}>
              {(order.taxCents ?? 0) > 0 && (
                <div className="flex justify-between items-start gap-3 text-sm">
                  <span style={{ color: 'var(--servd-mute)' }}>
                    GST
                    {(order.deliveryFeeTaxCents ?? 0) > 0 && (
                      <span className="block text-xs">incl. {fmt(order.deliveryFeeTaxCents ?? 0)} on delivery</span>
                    )}
                  </span>
                  <span className="font-bold shrink-0" style={{ color: 'var(--servd-mute)' }}>{fmt(order.taxCents ?? 0)}</span>
                </div>
              )}
              {(order.deliveryFeeCents ?? 0) > 0 && (
                <div className="flex justify-between items-start gap-3 text-sm">
                  <span style={{ color: 'var(--servd-mute)' }}>Delivery</span>
                  <span className="font-bold shrink-0" style={{ color: 'var(--servd-mute)' }}>{fmt(order.deliveryFeeCents ?? 0)}</span>
                </div>
              )}
            </div>
          )}
          <div className="px-4 py-3.5 flex justify-between items-center"
            style={{ background: 'var(--servd-surface)', borderTop: '1px solid var(--servd-line)' }}>
            <span className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>Total</span>
            <span className="font-display font-black text-xl" style={{ fontFamily: 'var(--font-display)', color }}>{fmt(order.totalCents)}</span>
          </div>
        </section>

        {/* ── Curbside flow ── */}
        {order.curbsideVehicle && !order.curbsideArrivedAt && order.status !== 'cancelled' && order.status !== 'completed' && (
          <CurbsideArrivedButton orderId={order.id} onArrived={() => {
            setOrder((o) => o ? { ...o, curbsideArrivedAt: new Date().toISOString() } : o)
          }} />
        )}
        {order.curbsideVehicle && order.curbsideArrivedAt && !order.curbsideRunnerOutAt && (
          <div className="rounded-2xl px-4 py-3.5 text-center"
            style={{ background: 'rgba(135,197,64,0.1)', border: '1px solid rgba(135,197,64,0.35)', color: 'var(--servd-green-dark)' }}>
            <p className="font-black text-sm">We see you. Bringing your food now.</p>
            <p className="text-xs mt-0.5 opacity-70">{order.curbsideVehicle}</p>
          </div>
        )}
        {order.curbsideVehicle && order.curbsideRunnerOutAt && (
          <div className="rounded-2xl px-4 py-3.5 text-center"
            style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' }}>
            <p className="font-black text-sm">Runner is on the way to your car.</p>
          </div>
        )}

        {/* ── Rate-your-meal CTA ── */}
        {/* Not while a till-completed delivery is still on its way. */}
        {order.status === 'completed' && !jobOpen && token && (
          <Link href={`/orders/${order.id}/review`}
            className="block w-full rounded-3xl overflow-hidden transition-transform active:scale-[0.98]"
            style={{ background: 'var(--servd-green)', boxShadow: '0 6px 18px rgba(61,31,59,0.28)' }}>
            <div className="px-6 py-5 flex items-center justify-between gap-4">
              <div>
                <p className="font-display font-black text-lg leading-tight" style={{ fontFamily: 'var(--font-display)', color: '#0a0a0a' }}>How was it?</p>
                <p className="text-sm mt-0.5" style={{ color: 'rgba(10,10,10,0.7)' }}>
                  Leave a review and earn <span className="font-black">+50 points</span>
                </p>
              </div>
              <div className="shrink-0 h-12 w-12 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.12)' }}>
                <StarIcon />
              </div>
            </div>
          </Link>
        )}

        <Link href={`/${slug}`}
          className="flex items-center justify-center gap-2 w-full rounded-[var(--servd-btn-radius)] py-3.5 font-bold text-sm transition-all active:scale-[0.98]"
          style={{ background: 'white', border: '1px solid var(--servd-line)', color: 'var(--servd-mute)' }}>
          Order something else →
        </Link>
      </div>
    </div>
  )
}

// ── Delivery hand-over code — the customer reads it to the rider ──────────
// The rider types it into their app to complete the delivery
// (docs/rider-app.md); the same code reaches the customer on WhatsApp at
// pick-up. Shown only while a rider has the order and it is not delivered.
function DeliveryCode({ code, riderName }: { code: string; riderName: string | null }) {
  return (
    <section
      aria-labelledby="delivery-code-title"
      className="rounded-3xl px-5 py-5 text-center"
      style={{ background: 'var(--servd-purple)', color: 'var(--servd-on-purple)' }}
    >
      <p id="delivery-code-title" className="text-[11px] font-black uppercase tracking-[0.2em]" style={{ opacity: 0.85 }}>
        Your delivery code
      </p>
      <div className="mt-3 flex justify-center gap-2">
        <span className="sr-only">{code.split('').join(' ')}</span>
        {code.split('').map((digit, i) => (
          <span
            key={i}
            aria-hidden="true"
            className="flex h-16 w-12 items-center justify-center rounded-2xl font-mono text-[34px] font-black"
            style={{ background: 'var(--servd-bg)', color: 'var(--servd-ink)' }}
          >
            {digit}
          </span>
        ))}
      </div>
      <p className="mt-3 text-sm font-semibold leading-snug">
        Give it to your rider{riderName ? ` (${riderName})` : ''} at the door — only once your order is in your hands.
      </p>
    </section>
  )
}

// ── Curbside "I'm here" — POSTs arrival, optimistic update parent ─────────
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
      className="flex items-center justify-center gap-2 w-full rounded-[var(--servd-btn-radius)] py-4 font-black text-sm tracking-wide transition-transform active:scale-[0.98]"
      style={{
        background: 'var(--servd-green)', color: 'var(--servd-on-green)',
        border: '1px solid var(--servd-green-dark)',
        boxShadow: '0 6px 18px rgba(61,31,59,0.28)',
        opacity: busy ? 0.6 : 1,
      }}>
      <CarIcon />
      <span>{busy ? "Letting them know…" : "I'm here"}</span>
    </button>
  )
}

// ── Inline SVG iconography — no emoji as structural icons ──────────────────

/** "Updates automatically · Updated 12s ago", or "Reconnecting…" when the last
 *  poll failed. Owns its own clock so the page does not re-render every tick. */
function FreshnessLine({ since, reconnecting }: { since: number | null; reconnecting: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const secs = since == null ? null : Math.max(0, Math.round((now - since) / 1000))
  return (
    <p className="text-xs mt-3" style={{ color: reconnecting ? 'var(--servd-danger)' : 'var(--servd-dim)' }}>
      {reconnecting
        ? `Reconnecting…${secs != null ? ` last updated ${secs}s ago` : ''}`
        : `Updates automatically${secs != null ? ` · Updated ${secs}s ago` : ''}`}
    </p>
  )
}

function StatusIcon({ status, animated }: { status: string; animated: boolean }) {
  const props = { width: 64, height: 64, viewBox: '0 0 64 64', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  const animStyle = animated ? { animation: 'float 2s ease-in-out infinite' as string } : undefined
  switch (status) {
    case 'received':  return <svg {...props}><rect x="14" y="10" width="36" height="44" rx="3"/><path d="M22 22h20M22 30h20M22 38h12"/></svg>
    case 'confirmed': return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 32l8 8 14-16"/></svg>
    case 'preparing': return <svg {...props} style={animStyle}><path d="M16 28a16 16 0 0 1 32 0"/><path d="M12 32h40v8a6 6 0 0 1-6 6H18a6 6 0 0 1-6-6z"/><path d="M22 22V14M32 22V12M42 22V14"/></svg>
    case 'ready':     return <svg {...props} style={{ animation: 'float 1.4s ease-in-out infinite' }}><path d="M16 26L32 14l16 12"/><path d="M20 26v22h24V26"/><path d="M28 48v-12h8v12"/></svg>
    case 'completed': return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 32l8 8 14-16"/></svg>
    case 'cancelled': return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 22l20 20M42 22L22 42"/></svg>
    default:          return <svg {...props}><circle cx="32" cy="32" r="22"/></svg>
  }
}

function CheckSmall() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 7l3 3 7-7"/>
    </svg>
  )
}

function BikeIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5.5" cy="17.5" r="3.5"/>
      <circle cx="18.5" cy="17.5" r="3.5"/>
      <path d="M15 6l-4 8M5.5 17.5L9 9l3 5 4-2 1-3h2"/>
    </svg>
  )
}

function CarIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12h18l-2-6H5z"/>
      <path d="M5 12v6M19 12v6"/>
      <circle cx="7.5" cy="18" r="1.5"/>
      <circle cx="16.5" cy="18" r="1.5"/>
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  )
}

function SearchIcon({ size = 24, stroke = 'currentColor' }: { size?: number; stroke?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
  )
}
