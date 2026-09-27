'use client'
import { useEffect, useState, useRef } from 'react'
import { useParams, useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { fmt, isLight } from '../../../../lib/ui'
import { useCustomerAuth } from '../../../../store/customerAuth'
import { LoadingScreen } from '../../../../components/ui/Loader'
import { formatBrandName } from '../../../../lib/concept'
import { statusStory, voiceBrand } from '../../../../lib/voice'
import { sfx } from '../../../../lib/film/sfx'
import { haptic } from '../../../../lib/haptics'
import { Companion, companionKindFor } from '../../../../components/characters/Companion'
import { moodAccent } from '../../../../components/checkout/brandTheme'
import { PotIcon } from '../../../../components/tracker/PotIcon'
import { SteamWisps, ReadyBag } from '../../../../components/tracker/ActMood'
import { CurbsideBeat } from '../../../../components/tracker/CurbsideBeat'
import tr from '../../../../components/tracker/tracker.module.css'

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

// Headline + sub copy come from lib/voice.ts (statusStory): the order plays
// as five acts in the kitchen's own voice. Chip labels for /orders and
// /account still come from lib/orderStatus.ts.

// Companion pose per act.
function companionMood(status: string): 'watch' | 'cheer' | 'wave' | 'gasp' {
  if (status === 'ready') return 'cheer'
  if (status === 'completed') return 'wave'
  if (status === 'cancelled' || status === 'refunded') return 'gasp'
  return 'watch'
}

export default function OrderStatusPage() {
  const { concept: slug, id } = useParams<{ concept: string; id: string }>()
  const router = useRouter()
  const pathname = usePathname()
  const token = useCustomerAuth((s) => s.token)
  const [order,    setOrder]    = useState<OrderStatus | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [flash,    setFlash]    = useState(false)
  // True only when the customer tapped "I'm here" in this session, so the
  // car-arrives beat plays once and a reload goes straight to the copy.
  const [justArrived, setJustArrived] = useState(false)
  const prevStatus = useRef<string | null>(null)
  const brand = voiceBrand(slug)

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
          // Foley for the cut to the next act (silent unless sound is on).
          try {
            sfx('tick', { theme: brand })
            haptic(10)
            if (data.status === 'completed') sfx('chime', { theme: brand })
          } catch { /* decorative only */ }
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
  }, [id, token, router, pathname, slug, brand])

  if (notFound) return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4" style={{ background: brand === 'simmer' ? '#EDE6D3' : 'var(--servd-bg)' }}>
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
    <main className="flex min-h-dvh items-center justify-center" style={{ background: brand === 'simmer' ? '#EDE6D3' : 'var(--servd-bg)' }}>
      <LoadingScreen label="Loading your order…" minHeight="auto" />
    </main>
  )

  // Brand mood accent for the page wash, hero, step dots and total: the
  // brand's deep colour (stackd plum, Flipd Blue, simmer tiber), else the
  // concept's primaryColor, else servd plum.
  const isSimmer    = brand === 'simmer'
  const color       = moodAccent(brand, order.concept.primaryColor)
  const stepIdx     = STEP_INDEX[order.status] ?? 0
  const isCancelled = order.status === 'cancelled' || order.status === 'refunded'
  const isReady     = order.status === 'ready'
  const isPreparing = order.status === 'preparing'
  const isDone      = order.status === 'completed' || isCancelled
  const story       = statusStory(brand, order.status)
  const brandLabel  = formatBrandName(order.concept.name)
  const sidekick    = isSimmer ? null : companionKindFor(brand)

  // simmer never shows white: its base is bone, and its skin class remaps the
  // --servd-* tokens + repaints the white cards (globals.css .simmer-ordering).
  const base       = isSimmer ? '#EDE6D3' : '#FFFFFF'
  const skinClass  = isSimmer ? ' simmer-ordering' : brand === 'flipd' ? ' flipd-ordering' : ''
  // Act mood: the brand accent rises from 4% to 14% of the page as the
  // order moves through its five acts. Colour only; no motion needed.
  const moodPct    = 4 + Math.max(0, stepIdx) * 2.5
  const pageMood   = `color-mix(in srgb, ${color} ${moodPct}%, ${base})`
  const heroBg     = isCancelled ? (isSimmer ? '#E9DCCB' : 'rgba(239,68,68,0.06)') : `color-mix(in srgb, ${color} ${moodPct + 4}%, ${base})`
  const heroBorder = isCancelled ? (isSimmer ? '1px solid rgba(6,57,47,0.22)' : '1px solid rgba(239,68,68,0.22)') : `1px solid color-mix(in srgb, ${color} 25%, transparent)`
  const headerBg   = isSimmer ? 'rgba(237,230,211,0.94)' : 'rgba(255,255,255,0.92)'

  return (
    <main className={`min-h-dvh pb-16 ${tr.mood}${skinClass}`} style={{ backgroundColor: pageMood }}>

      {flash && (
        <div className="fixed inset-0 z-50 pointer-events-none"
          style={{ background: `color-mix(in srgb, ${color} 10%, transparent)`, animation: 'fadeIn 0.15s ease-out' }} />
      )}

      {/* Sticky header — on-system glass bar, matches /checkout */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center gap-2.5"
        style={{ borderBottom: '1px solid var(--servd-line)', background: headerBg, backdropFilter: 'blur(16px)' }}>
        {token ? (
          <Link href="/account" className="flex items-center gap-1 min-h-[44px] text-xs font-bold mr-1 transition-colors" style={{ color: 'var(--servd-mute)' }}>
            ← {isSimmer ? 'my orders' : 'My orders'}
          </Link>
        ) : (
          <Link href={`/${slug}`} className="flex items-center gap-1 min-h-[44px] text-xs font-bold mr-1 transition-colors" style={{ color: 'var(--servd-mute)' }}>
            ← {isSimmer ? 'menu' : 'Menu'}
          </Link>
        )}
        <span style={{ color: 'var(--servd-dim)' }}>·</span>
        <span className="font-display text-sm font-semibold" style={{ fontFamily: isSimmer ? 'var(--simmer-display)' : 'var(--font-display)', color: 'var(--servd-ink)' }}>
          {brandLabel}
        </span>
        {!isDone && !isCancelled && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full animate-pulse" style={{ background: 'var(--servd-green)' }} />
            <span className="text-xs font-bold" style={{ color: 'var(--servd-mute)' }}>{isSimmer ? 'live' : 'Live'}</span>
          </div>
        )}
      </div>

      <div className="relative z-10 max-w-md lg:max-w-2xl mx-auto px-4 py-6 space-y-4">

        {/* ── Status hero ── */}
        <div className={`rounded-3xl p-7 text-center relative overflow-hidden ${tr.hero}`}
          data-act={order.status}
          style={{ background: heroBg, border: heroBorder, color }}>
          {isReady && (
            <div className="absolute inset-0 rounded-3xl pointer-events-none"
              style={{ border: `1.5px solid color-mix(in srgb, ${color} 40%, transparent)` }} />
          )}
          {isPreparing && <SteamWisps />}

          {sidekick && (
            <div className={tr.companion} aria-hidden="true">
              <Companion kind={sidekick} placement="inline" mood={companionMood(order.status)} size={96} />
            </div>
          )}

          <div className="relative mb-5 flex justify-center" style={{ color }}>
            <StatusIcon status={order.status} />
          </div>

          <p className={`relative ${tr.actKicker}`} style={{ color }}>
            <span className={isSimmer ? tr.actRule : tr.actStripe} aria-hidden="true" />
            {story.act}
          </p>

          {order.customerName && (
            <p className="relative text-sm font-medium mb-1" style={{ color: 'var(--servd-mute)' }}>
              hi, {order.customerName}.
            </p>
          )}

          <h1 className="relative font-display font-black text-3xl leading-tight tracking-tight" style={{ fontFamily: isSimmer ? undefined : 'var(--font-display)', color: 'var(--servd-ink)', letterSpacing: isSimmer ? undefined : '-0.03em' }}>
            {story.headline}
          </h1>
          <p className="relative text-sm mt-2 font-medium" style={{ color: 'var(--servd-mute)' }}>
            {story.sub}
          </p>

          {!isDone && !isReady && (
            <p className="relative text-xs mt-3" style={{ color: 'var(--servd-mute)', opacity: 0.75 }}>
              {isSimmer ? 'updates on their own, every ten seconds' : 'updates on its own · checking every 10s'}
            </p>
          )}

          <div className="relative mt-5 inline-flex items-center gap-1.5 rounded-full px-3 py-1.5"
            style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)' }}>
            <span className="text-[9px] font-black uppercase tracking-[0.2em]" style={{ color: 'var(--servd-mute)' }}>{isSimmer ? 'order' : 'Order'}</span>
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
                return (
                  <div key={step.key} className="flex items-center flex-1">
                    <div className="flex flex-col items-center gap-2 flex-1">
                      <div
                        className={`h-9 w-9 rounded-full flex items-center justify-center text-sm ${tr.stepDot}`}
                        style={{
                          background: done ? color : 'var(--servd-surface)',
                          color: done ? (isLight(color) ? '#000' : '#fff') : 'var(--servd-dim)',
                          boxShadow: current ? `0 0 18px color-mix(in srgb, ${color} 60%, transparent)` : 'none',
                          transform: current ? 'scale(1.15)' : 'scale(1)',
                        }}>
                        {current && isPreparing
                          ? <PotIcon size={18} />
                          : done
                            ? <CheckSmall />
                            : <span className="text-[11px]" style={{ color: 'var(--servd-dim)' }}>{i + 1}</span>
                        }
                      </div>
                      <span className={`text-[9px] font-black tracking-wider text-center leading-tight ${isSimmer ? 'lowercase' : 'uppercase'}`}
                        style={{ color: done ? 'var(--servd-ink)' : 'var(--servd-mute)', opacity: done ? 1 : 0.7 }}>
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
            <p className="font-display font-black text-sm" style={{ fontFamily: isSimmer ? undefined : 'var(--font-display)', color: 'var(--servd-ink)' }}>
              {brandLabel}
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
            setJustArrived(true)
            setOrder((o) => o ? { ...o, curbsideArrivedAt: new Date().toISOString() } : o)
          }} />
        )}
        {order.curbsideVehicle && order.curbsideArrivedAt && !order.curbsideRunnerOutAt && (
          <CurbsideBeat vehicle={order.curbsideVehicle} play={justArrived} />
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

function StatusIcon({ status }: { status: string }) {
  const props = { width: 64, height: 64, viewBox: '0 0 64 64', fill: 'none', stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  switch (status) {
    case 'received':  return <svg {...props}><rect x="14" y="10" width="36" height="44" rx="3"/><path d="M22 22h20M22 30h20M22 38h12"/></svg>
    case 'confirmed': return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 32l8 8 14-16"/></svg>
    case 'preparing': return <PotIcon size={64} strokeWidth={1.4} />
    case 'ready':     return <ReadyBag size={64} />
    case 'completed': return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 32l8 8 14-16"/></svg>
    case 'cancelled':
    case 'refunded':  return <svg {...props}><circle cx="32" cy="32" r="22"/><path d="M22 22l20 20M42 22L22 42"/></svg>
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
