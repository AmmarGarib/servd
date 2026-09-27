'use client'
import { useCallback, useEffect, useState, useRef } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { fmt, isLight } from '../../../../lib/ui'
import { useCustomerAuth } from '../../../../store/customerAuth'
import { LoadingScreen } from '../../../../components/ui/Loader'
import { formatBrandName } from '../../../../lib/concept'
import { buzz, celebrate, sfx, usePlay, usePrefersReducedMotion, type Palette } from '@/lib/play'
import { WaitGame, type WaitRound } from '@/components/play/wait/WaitGame'
import { Candle } from '@/components/brand/simmer/Candle'
import w from '@/components/play/wait/wait.module.css'

// /<concept>/order/[id] — live order tracker.
// Restyled onto the on-system --servd-* tokens. Status icons are inline
// SVG (no emoji as structural icons). 10s polling, stops on terminal
// state.

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
  { key: 'received',  label: 'Received'  },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'preparing', label: 'Preparing' },
  { key: 'ready',     label: 'Ready'     },
  { key: 'completed', label: 'Done'      },
] as const

const STEP_INDEX: Record<string, number> = {
  received: 0, confirmed: 1, preparing: 2, ready: 3, completed: 4, cancelled: -1,
}

// Status copy lives in lib/orderStatus.ts. /orders and /account use the
// neutral `statusFor` wording; this tracker speaks in the kitchen's own
// voice via `trackerLine` (which falls back to the neutral copy, and never
// jokes on a cancelled or refunded order).
import { trackerLine } from '../../../../lib/orderStatus'

/** Statuses during which the kitchen's wait game is on the table. */
const WAITING = new Set(['received', 'confirmed', 'preparing'])

export default function OrderStatusPage() {
  const { concept: slug, id } = useParams<{ concept: string; id: string }>()
  const router = useRouter()
  const pathname = usePathname()
  const token = useCustomerAuth((s) => s.token)
  const [order,    setOrder]    = useState<OrderStatus | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [flash,    setFlash]    = useState(false)
  const prevStatus = useRef<string | null>(null)

  // ── Play (presentation only — never touches polling, auth or the API) ──
  const reduced = usePrefersReducedMotion()
  const brand = (order?.concept.slug ?? slug ?? '').toLowerCase()
  // Tap a finished step to replay its tick.
  const [replay, setReplay] = useState<Record<string, number>>({})
  // The simmer candle flares when the order turns ready (no confetti there).
  const [flare, setFlare] = useState(0)
  // Curbside: the car drives in and parks once "I'm here" lands.
  const [parked, setParked] = useState(false)
  // The best wait-game round played on this visit, for the "nice timing" note.
  const [played, setPlayed] = useState<WaitRound | null>(null)
  const bestPatty = usePlay((st) => st.best['patty'])
  const bestPour = usePlay((st) => st.best['pour'])
  const seenStatus = useRef<string | null>(null)

  const onRound = useCallback((r: WaitRound) => {
    setPlayed((p) => (p && p.game === r.game && p.score >= r.score ? p : r))
  }, [])

  // The ready moment: only on a live transition, never on a page load that
  // already finds the order ready. Tracked separately from `prevStatus` so
  // the polling loop stays exactly as it was.
  useEffect(() => {
    const st = order?.status
    if (!st) return
    const prev = seenStatus.current
    seenStatus.current = st
    if (!prev || prev === st || st !== 'ready') return
    if (brand === 'simmer') {
      setFlare((f) => f + 1)
      return
    }
    const palette: Palette = brand === 'stackd' ? 'stackd' : brand === 'flipd' ? 'flipd' : 'servd'
    void celebrate({ power: 'big', palette })
    buzz(60)
    sfx('ding')
  }, [order?.status, brand])

  // Guest order viewing is gone — every order tracker requires sign-in.
  // Bounce to login with a return URL so the customer lands back here after
  // authenticating. Old SMS tracker links flow through this same path.
  useEffect(() => {
    if (!token) {
      const ret = encodeURIComponent(pathname ?? `/${slug}/order/${id}`)
      router.replace(`/login?return=${ret}`)
    }
  }, [token, router, pathname, slug, id])

  useEffect(() => {
    if (!token) return
    let stopped = false
    let iv: ReturnType<typeof setInterval> | null = null
    const stop = () => { if (iv) { clearInterval(iv); iv = null } stopped = true }

    const poll = async () => {
      if (stopped) return
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
        if (!res.ok) return
        const data = await res.json() as OrderStatus
        if (prevStatus.current && prevStatus.current !== data.status) {
          setFlash(true)
          setTimeout(() => setFlash(false), 900)
        }
        prevStatus.current = data.status
        setOrder(data)
        if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'refunded') {
          stop()
        }
      } catch { /* keep polling */ }
    }
    void poll()
    iv = setInterval(() => void poll(), 10000)
    return () => stop()
  }, [id, token, router, pathname, slug])

  if (notFound) return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4" style={{ background: 'var(--servd-bg)' }}>
      <SearchIcon size={48} stroke="var(--servd-mute)" />
      <div className="text-center space-y-2">
        <p className="font-display font-black text-2xl tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)' }}>Order not found</p>
        <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>
          This order doesn&apos;t exist or may have been removed.
        </p>
      </div>
      <Link href={`/${slug}`}
        className="rounded-2xl font-black px-8 py-4 text-sm transition-transform active:scale-[0.98]"
        style={{ background: 'var(--servd-green)', color: 'white', boxShadow: '0 6px 18px rgba(58,14,105,0.28)' }}>
        Back to menu
      </Link>
    </main>
  )

  if (!order) return (
    <main className="flex min-h-dvh items-center justify-center" style={{ background: 'var(--servd-bg)' }}>
      <LoadingScreen label="Loading your order…" minHeight="auto" />
    </main>
  )

  // Brand accent for the per-brand color wash on the hero ring + total. Use
  // brandAccent override semantics: prefer the brand's primaryColor, fall
  // back to servd-green.
  const color       = order.concept.primaryColor ?? 'var(--servd-green)'
  const stepIdx     = STEP_INDEX[order.status] ?? 0
  const isCancelled = order.status === 'cancelled'
  const isReady     = order.status === 'ready'
  const isPreparing = order.status === 'preparing'
  const isDone      = order.status === 'completed' || isCancelled
  const cfg         = trackerLine(order.status, brand)
  const isSimmer    = brand === 'simmer'
  const showWait    = WAITING.has(order.status)
  const niceBest    = played ? (played.game === 'patty' ? bestPatty : bestPour) ?? played.score : null

  const heroBg     = isCancelled ? 'rgba(239,68,68,0.06)' : `color-mix(in srgb, ${color} 8%, white)`
  const heroBorder = isCancelled ? '1px solid rgba(239,68,68,0.22)' : `1px solid color-mix(in srgb, ${color} 25%, transparent)`

  return (
    <main className="min-h-dvh pb-16" style={{ background: 'var(--servd-bg)' }}>

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
            {isSimmer && isReady ? (
              // simmer's ready moment: the candle, lit, on a flat green disc.
              // It flares once on the live transition — no confetti on simmer.
              <span className={w.simmerDisc} aria-hidden="true">
                <span key={flare} className={flare > 0 ? w.candleFlare : undefined}>
                  <Candle lit height={78} />
                </span>
              </span>
            ) : (
              <StatusIcon status={order.status} animated={isPreparing} />
            )}
          </div>

          {order.customerName && (
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--servd-mute)' }}>
              {isSimmer ? `hi, ${order.customerName}.` : `Hi, ${order.customerName}.`}
            </p>
          )}

          <h1 className="font-display font-black text-3xl leading-tight tracking-tight" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>
            {cfg.headline}
          </h1>
          <p className="text-sm mt-2 font-medium" style={{ color: 'var(--servd-mute)' }}>
            {cfg.sub}
          </p>

          {!isDone && !isReady && (
            <p className="text-xs mt-3" style={{ color: 'var(--servd-dim)' }}>
              Updates automatically · checking every 10s
            </p>
          )}

          <div className="mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)' }}>
            <span className="text-[9px] font-black uppercase tracking-[0.2em]" style={{ color: 'var(--servd-mute)' }}>Order</span>
            <span className="text-[11px] font-black font-mono" style={{ color: 'var(--servd-ink)' }}>
              #{order.id.slice(-8).toUpperCase()}
            </span>
          </div>
        </div>

        {/* ── Progress steps ── */}
        {!isCancelled && (
          <div className="rounded-2xl p-5"
            style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
            <div className="flex items-center">
              {STEPS.map((step, i) => {
                const done    = i <= stepIdx
                const current = i === stepIdx
                const last    = i === STEPS.length - 1
                const spinning = current && isPreparing
                const replayable = done && !spinning
                const circle = (
                  <div
                    className="h-9 w-9 rounded-full flex items-center justify-center text-sm transition-all duration-700"
                    style={{
                      background: done ? color : 'var(--servd-surface)',
                      color: done ? (isLight(color) ? '#000' : '#fff') : 'var(--servd-dim)',
                      boxShadow: current ? `0 0 18px color-mix(in srgb, ${color} 60%, transparent)` : 'none',
                      transform: current ? 'scale(1.15)' : 'scale(1)',
                    }}>
                    {spinning
                      ? <span className={w.stepSpin}><TimerSmall /></span>
                      : done
                        ? (
                          <motion.span
                            key={replay[step.key] ?? 0}
                            className={w.checkDraw}
                            initial={reduced ? false : { scale: 0.45 }}
                            animate={{ scale: 1 }}
                            transition={{ type: 'spring', stiffness: 520, damping: 18 }}
                          >
                            <CheckSmall />
                          </motion.span>
                        )
                        : <span className="text-[11px]" style={{ color: 'var(--servd-dim)' }}>{i + 1}</span>
                    }
                  </div>
                )
                return (
                  <div key={step.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-2 flex-1">
                      {replayable ? (
                        <button
                          type="button"
                          className={w.stepHit}
                          data-toy="tap"
                          aria-label={`${step.label.toLowerCase()}: done. replay the tick`}
                          onClick={() => setReplay((r) => ({ ...r, [step.key]: (r[step.key] ?? 0) + 1 }))}
                        >
                          {circle}
                        </button>
                      ) : (
                        <span className={w.stepHit}>{circle}</span>
                      )}
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

        {/* ── While you wait: the kitchen's own game ── */}
        {showWait && (
          <WaitGame slug={brand} status={order.status} onRound={onRound} />
        )}
        {isReady && played && niceBest !== null && !isSimmer && (
          <div className={w.niceTiming} data-skin={brand === 'flipd' || brand === 'stackd' ? brand : 'servd'} role="status">
            <span className={w.niceKicker}>{brand === 'flipd' ? 'Nice timing.' : 'nice timing'}</span>
            <span className={w.niceScore}>
              {played.game === 'patty'
                ? `Best flip ${niceBest}`
                : `best pour ${niceBest}`}
            </span>
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
            <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--servd-line)', background: 'rgba(58,14,105,0.06)' }}>
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
                <a href={`tel:${order.rider.phone}`}
                  className="px-3 py-1.5 rounded-full text-xs font-bold"
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
          <div className="px-4 py-3.5 flex justify-between items-center"
            style={{ background: 'var(--servd-surface)', borderTop: '1px solid var(--servd-line)' }}>
            <span className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>Total</span>
            <span className="font-display font-black text-xl" style={{ fontFamily: 'var(--font-display)', color }}>{fmt(order.totalCents)}</span>
          </div>
        </section>

        {/* ── Curbside flow ── */}
        {order.curbsideVehicle && !order.curbsideArrivedAt && order.status !== 'cancelled' && order.status !== 'completed' && (
          <CurbsideArrivedButton orderId={order.id} onArrived={() => {
            setParked(true)
            setOrder((o) => o ? { ...o, curbsideArrivedAt: new Date().toISOString() } : o)
          }} />
        )}
        {order.curbsideVehicle && order.curbsideArrivedAt && !order.curbsideRunnerOutAt && (
          <div className="rounded-2xl px-4 py-3.5 text-center overflow-hidden"
            style={{ background: 'rgba(58,14,105,0.1)', border: '1px solid rgba(58,14,105,0.35)', color: 'var(--servd-green-dark)' }}>
            {/* Presentation only: the car drives in and parks. */}
            <span className={`${w.carBay} ${parked ? w.carPark : ''}`} aria-hidden="true">
              <CarIcon size={30} />
            </span>
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
        {order.status === 'completed' && token && (
          <Link href={`/orders/${order.id}/review`}
            className="block w-full rounded-3xl overflow-hidden transition-transform active:scale-[0.98]"
            style={{ background: 'var(--servd-green)', boxShadow: '0 6px 18px rgba(58,14,105,0.28)' }}>
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
          className="flex items-center justify-center gap-2 w-full rounded-2xl py-3.5 font-bold text-sm transition-all active:scale-[0.98]"
          style={{ background: 'white', border: '1px solid var(--servd-line)', color: 'var(--servd-mute)' }}>
          Order something else →
        </Link>
      </div>
    </main>
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
      className="flex items-center justify-center gap-2 w-full rounded-2xl py-4 font-black text-sm tracking-wide transition-transform active:scale-[0.98]"
      style={{
        background: 'var(--servd-green)', color: 'white',
        border: '1px solid var(--servd-green-dark)',
        boxShadow: '0 6px 18px rgba(58,14,105,0.28)',
        opacity: busy ? 0.6 : 1,
      }}>
      <CarIcon />
      <span>{busy ? "Letting them know…" : "I'm here"}</span>
    </button>
  )
}

// ── Inline SVG iconography — no emoji as structural icons ──────────────────

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

function TimerSmall() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6" strokeOpacity="0.35" />
      <path d="M8 2a6 6 0 0 1 6 6" />
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

function CarIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
