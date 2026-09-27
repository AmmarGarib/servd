'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCart } from '../../../store/cart'
import { useCustomerAuth } from '../../../store/customerAuth'
import { fmt } from '../../../lib/ui'
import { decodeCartToken } from '../../../lib/cartHandoff'
import { trackCheckoutStarted, trackCheckoutAbandoned, trackOrderPlaced, trackPromoApplied, trackPromoFailed } from '../../../lib/analytics'
import { formatBrandName } from '../../../lib/concept'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { TactileButton, type TactileState } from '../../../components/tactile/TactileButton'
import { HopDots } from '../../../components/tactile/HopDots'
import { JELLY, SPRING, tick } from '../../../lib/tactile'
import { CrowdPoster } from '../../../components/characters/CrowdPoster'
import { ChoiceChip } from '../../../components/checkout/ChoiceChip'
import { TactileInput, TactileTextarea } from '../../../components/checkout/TactileField'
import { TrustStrip } from '../../../components/checkout/TrustStrip'
import styles from '../../../components/checkout/checkout.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface AccountInfo {
  id: string
  name: string
  walletBalance: number
  loyaltyAccount: { pointsBalance: number } | null
}

interface CustomerAddress {
  id: string; label: string; address: string; lat?: number | null; lng?: number | null; isDefault: boolean
}

type PaymentMethod = 'cash' | 'card' | 'jazzcash' | 'easypaisa' | 'keenu'

// Fulfilment options. Backend accepts these strings on
// POST /storefront/orders.type.
type FulfilmentOption = 'dine-in' | 'pickup' | 'curbside' | 'delivery'

// Per-brand allow-list. The brand's operating model decides what
// fulfilment modes the customer can pick. Simmer is plated dining
// only (the QR card is at the table); stackd is a twenty-seat cafe
// with a grab-and-go counter, so it adds pickup + curbside; Flipd
// ships hot from the kitchen, so it
// also opens up delivery. Slugs not in the map see the full set
// (legacy / generic brand pages).
const BRAND_FULFILMENT: Record<string, FulfilmentOption[]> = {
  simmer: ['dine-in'],
  stackd:   ['dine-in', 'pickup', 'curbside'],
  flipd:  ['dine-in', 'pickup', 'curbside', 'delivery'],
}
const FULFILMENT_LABEL: Record<FulfilmentOption, string> = {
  'dine-in':  'Dine in',
  'pickup':   'Pickup',
  'curbside': 'Curbside',
  'delivery': 'Delivery',
}

const PAYMENT_OPTIONS: Array<{
  id: PaymentMethod
  icon: string
  label: string
  sub: string
  phoneRequired: boolean
}> = [
  { id: 'cash',      icon: 'Cash', label: 'Cash on Delivery',  sub: 'Pay when you receive your order', phoneRequired: false },
  { id: 'jazzcash',  icon: 'JC', label: 'JazzCash Wallet',   sub: 'Enter your JazzCash number',      phoneRequired: true  },
  { id: 'easypaisa', icon: 'EP', label: 'EasyPaisa',         sub: 'Enter your EasyPaisa number',     phoneRequired: true  },
  { id: 'keenu',     icon: 'Card', label: 'Keenu (Card)',       sub: "You'll be redirected to Keenu after placing your order", phoneRequired: false },
]

export default function CheckoutPage() {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  // taxCents/totalCents from the store are deprecated for this page —
  // the page computes both locally so it can react to paymentMethod
  // (see taxCentsLive / totalLive below). We still pull totalCents to
  // hand to the promo-preview endpoint as the baseline.
  const { items, subtotalCents, totalCents, itemCount, clearCart, hydrateFromReorder } = useCart()
  const token = useCustomerAuth((s) => s.token)

  // Per-brand ordering skin. Same class system as /[concept]/page.tsx so
  // the brand carries through from menu → modal → cart → checkout in one
  // continuous voice. CSS lives in globals.css under the .X-ordering
  // selectors: token remap (--servd-ink / --servd-green / etc. → brand
  // palette) plus targeted !important overrides for the inline
  // `background: white` cards the JSX hardcodes.
  const brandSkinClass =
    slug === 'simmer' ? 'simmer-ordering' :
    slug === 'stackd'   ? 'stackd-ordering'   :
    slug === 'flipd'  ? 'flipd-ordering'  :
    ''
  // Cross-brand upsell ("want a side from another GS Foods kitchen?")

  // Guest checkout is gone — every order needs a logged-in customer. Bounce
  // unauthenticated visitors to /login with a return URL so their cart still
  // makes it back here after they sign in.
  useEffect(() => {
    if (!token) {
      const next = encodeURIComponent(`/${slug}/checkout`)
      router.replace(`/login?next=${next}`)
    }
  }, [token, slug, router])

  // Cross-domain handoff: when a user builds a cart on a brand custom domain
  // (eatstax.com, stackd.localhost:3002…) and clicks checkout, the brand site
  // appends the cart as a base64url-encoded token. Hydrate on mount, then
  // strip the param so a refresh doesn't re-hydrate stale data.
  useEffect(() => {
    const cartParam = searchParams?.get('cart')
    if (!cartParam) return
    const payload = decodeCartToken(cartParam)
    if (payload && payload.items.length > 0) {
      hydrateFromReorder(payload.conceptSlug ?? slug, payload.items)
    }
    router.replace(`/${slug}/checkout`, { scroll: false })
  }, [searchParams, slug, router, hydrateFromReorder])

  const [name,  setName]  = useState('')
  const [phone, setPhone] = useState('')
  const [notes,   setNotes]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const [account,    setAccount]    = useState<AccountInfo | null>(null)
  const [promoCode,  setPromoCode]  = useState('')
  const [promoStatus,       setPromoStatus]       = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [promoDiscountCents, setPromoDiscountCents] = useState(0)
  const [promoMessage,      setPromoMessage]      = useState('')
  const [useWallet,  setUseWallet]  = useState(false)
  const [loyaltyPts, setLoyaltyPts] = useState(0)

  // Fulfilment type. Curbside is a customer convenience — they tap "I'm
  // here" on arrival via /[concept]/order/[id], staff sees the queue at
  // /orders/curbside in admin and runs the bag out. The allow-list per
  // brand drives both the rendered chooser and the initial selection
  // (whatever option appears first in BRAND_FULFILMENT for the slug).
  const allowedFulfilment = BRAND_FULFILMENT[slug] ?? ['pickup', 'curbside', 'delivery']
  const [fulfilmentType, setFulfilmentType] = useState<FulfilmentOption>(allowedFulfilment[0]!)
  const [curbsideVehicle,  setCurbsideVehicle]  = useState('')
  const [curbsidePlate,    setCurbsidePlate]    = useState('')
  const [deliveryAddress,  setDeliveryAddress]  = useState('')
  const [deliveryNotes,    setDeliveryNotes]    = useState('')
  // Dine-in: customer types the table label printed on the QR card at
  // their seat. Backend resolves the label to a Table.id (case-
  // insensitive); on miss the raw string is stored on the order so
  // expo still sees it on the ticket.
  const [tableLabel,       setTableLabel]       = useState('')

  // Saved addresses for logged-in users
  const [savedAddresses,      setSavedAddresses]      = useState<CustomerAddress[]>([])
  const [selectedAddressId,   setSelectedAddressId]   = useState<string | null>(null)
  const [showNewAddressInput, setShowNewAddressInput] = useState(false)

  // Tip the rider — preset chips + custom amount. Cents.
  const [tipMode,   setTipMode]   = useState<'none' | '5' | '10' | '15' | '20' | 'custom'>('10')
  const [customTip, setCustomTip] = useState('')
  const [giftCard,  setGiftCard]  = useState('')
  const tipPctTable: Record<string, number> = { none: 0, '5': 0.05, '10': 0.10, '15': 0.15, '20': 0.20 }
  const _orderPlaced = useRef(false)

  // Payment method
  const [paymentMethod,  setPaymentMethod]  = useState<PaymentMethod>('cash')
  const [paymentPhone,   setPaymentPhone]   = useState('')

  // Gift card balance check
  const [giftCardStatus,  setGiftCardStatus]  = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [giftCardBalance, setGiftCardBalance] = useState(0)

  useEffect(() => {
    if (!token) return
    Promise.all([
      fetch(`${API_URL}/api/v1/storefront/account`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.ok ? r.json() as Promise<AccountInfo> : null),
      fetch(`${API_URL}/api/v1/storefront/addresses`, {
        headers: { Authorization: `Bearer ${token}` },
      }).then(r => r.ok ? r.json() as Promise<CustomerAddress[]> : []),
    ]).then(([acct, addrs]) => {
      if (acct) setAccount(acct)
      const addresses = addrs ?? []
      setSavedAddresses(addresses)
      // Pre-select default address
      const defaultAddr = addresses.find((a: CustomerAddress) => a.isDefault)
      if (defaultAddr) {
        setSelectedAddressId(defaultAddr.id)
        setDeliveryAddress(defaultAddr.address)
      }
    }).catch(() => {})
  }, [token])

  useEffect(() => {
    if (items.length > 0) {
      trackCheckoutStarted(slug, items.length, subtotalCents())
    }
    return () => {
      if (!_orderPlaced.current) {
        trackCheckoutAbandoned(slug, 'checkout')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Presentation state (no money logic) ─────────────────────────────────
  // `placed` holds the Place-order check for a beat before navigating;
  // `ctaError` drives the button's one-shot error shake.
  const isSimmer = slug === 'simmer'
  const [placed,   setPlaced]   = useState(false)
  const [ctaError, setCtaError] = useState(false)
  useEffect(() => {
    if (!ctaError) return
    const t = setTimeout(() => setCtaError(false), 900)
    return () => clearTimeout(t)
  }, [ctaError])
  // Haptic confirmation for the code checks. Presentation only: reads the
  // existing status state, never writes it.
  useEffect(() => {
    if (promoStatus === 'invalid') tick('error')
    else if (promoStatus === 'valid') tick('success')
  }, [promoStatus])
  useEffect(() => {
    if (giftCardStatus === 'invalid') tick('error')
    else if (giftCardStatus === 'valid') tick('success')
  }, [giftCardStatus])

  if (itemCount() === 0) return (
    <main className={`flex min-h-dvh flex-col items-center justify-center gap-5 px-4${brandSkinClass ? ' ' + brandSkinClass : ''}`}
      style={{ background: 'transparent' }}>
      {placed ? (
        // The cart was just cleared on a successful order and the router is
        // on its way to the tracker — a pending beat, never an "empty cart".
        <div className="flex flex-col items-center gap-3" style={{ color: 'var(--servd-ink)' }}>
          <HopDots size={9} gap={6} label="Opening your order" />
          <p className="text-sm font-semibold" style={{ color: 'var(--servd-mute)' }}>
            {isSimmer ? 'opening your order' : 'Opening your order'}
          </p>
        </div>
      ) : (
        <EmptyCart slug={slug} simmer={isSimmer} />
      )}
    </main>
  )

  const walletBalance    = account?.walletBalance ?? 0
  const loyaltyBalance   = account?.loyaltyAccount?.pointsBalance ?? 0

  // GST is payment-method-aware (per the admin tax config): cash pays
  // the full 15% rate, card-rails — Keenu, JazzCash, EasyPaisa — get
  // the discounted 8% rate that the processor passes through. We
  // compute it locally here because the cart store can't know payment
  // method at the time it builds the basket. `taxCentsLive` and
  // `totalLive` replace the cart store's tax/total helpers throughout
  // this page.
  const taxRate = paymentMethod === 'cash' ? 0.15 : 0.08
  const taxCentsLive = Math.round(subtotalCents() * taxRate)
  const totalLive    = subtotalCents() + taxCentsLive

  const loyaltyDeduction = Math.min(loyaltyPts * 10, totalLive)
  const walletDeduction  = useWallet ? Math.min(walletBalance, Math.max(0, totalLive - loyaltyDeduction)) : 0
  // Tip — computed against subtotal + tax. Only applies to delivery
  // orders (no rider on dine-in / pickup / curbside, so no tip to
  // pool); we zero it out regardless of the chip the user happened to
  // leave selected.
  const tipCents = fulfilmentType !== 'delivery' ? 0 :
    tipMode === 'custom'
      ? Math.max(0, Math.round((parseFloat(customTip) || 0) * 100))
      : Math.round(totalLive * (tipPctTable[tipMode] ?? 0))
  // Gift card deduction — capped at order total
  const giftCardDeduction = giftCardStatus === 'valid'
    ? Math.min(giftCardBalance, Math.max(0, totalLive - loyaltyDeduction - walletDeduction - promoDiscountCents))
    : 0
  const displayTotal     = Math.max(0, totalLive - loyaltyDeduction - walletDeduction - promoDiscountCents - giftCardDeduction) + tipCents

  const applyPromo = async () => {
    const code = promoCode.trim().toUpperCase()
    if (!code) return
    setPromoStatus('checking')
    setPromoDiscountCents(0)
    setPromoMessage('')
    try {
      const params = new URLSearchParams({
        code,
        conceptSlug: slug,
        subtotalCents: String(totalCents()),
      })
      const res = await fetch(`${API_URL}/api/v1/storefront/promo-preview?${params.toString()}`)
      const data = await res.json() as
        | { valid: true;  discountCents: number; description: string }
        | { valid: false; reason: string }
      if (data.valid) {
        setPromoStatus('valid')
        setPromoDiscountCents(data.discountCents)
        setPromoMessage(data.description)
      } else {
        setPromoStatus('invalid')
        setPromoMessage(data.reason)
      }
    } catch {
      setPromoStatus('invalid')
      setPromoMessage('Could not validate code. Try again.')
    }
  }

  const checkGiftCardBalance = async () => {
    const code = giftCard.trim().toUpperCase()
    if (!code) return
    setGiftCardStatus('checking')
    setGiftCardBalance(0)
    try {
      const res = await fetch(`${API_URL}/api/v1/gift-cards/balance/${encodeURIComponent(code)}`)
      if (!res.ok) {
        setGiftCardStatus('invalid')
        return
      }
      const data = await res.json() as { balanceCents: number; status: string; expiresAt?: string | null }
      if (data.status !== 'active') {
        setGiftCardStatus('invalid')
        return
      }
      if (data.expiresAt && new Date(data.expiresAt) < new Date()) {
        setGiftCardStatus('invalid')
        return
      }
      setGiftCardBalance(data.balanceCents)
      setGiftCardStatus('valid')
    } catch {
      setGiftCardStatus('invalid')
    }
  }

  const handlePlaceOrder = async () => {
    setError('')
    if (fulfilmentType === 'delivery' && !deliveryAddress.trim()) {
      setError('Please enter your delivery address')
      setCtaError(true)
      return
    }
    if (fulfilmentType === 'dine-in' && !tableLabel.trim()) {
      setError('Please enter your table number (printed on the QR card at your seat).')
      setCtaError(true)
      return
    }
    if ((paymentMethod === 'jazzcash' || paymentMethod === 'easypaisa') && !paymentPhone.trim()) {
      setError(`Please enter your ${paymentMethod === 'jazzcash' ? 'JazzCash' : 'EasyPaisa'} mobile number`)
      setCtaError(true)
      return
    }
    setLoading(true)
    try {
      if (token) {
        const res = await fetch(`${API_URL}/api/v1/storefront/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            conceptSlug: slug,
            type: fulfilmentType,
            ...(fulfilmentType === 'delivery' && {
              deliveryAddress: deliveryAddress.trim(),
              ...(deliveryNotes.trim() && { notes: deliveryNotes.trim() }),
            }),
            ...(fulfilmentType === 'curbside' && {
              curbsideVehicle: curbsideVehicle.trim(),
              ...(curbsidePlate.trim() && { curbsidePlate: curbsidePlate.trim() }),
            }),
            ...(fulfilmentType === 'dine-in' && {
              tableLabel: tableLabel.trim(),
            }),
            promoCode: promoCode.trim() || undefined,
            useWallet,
            loyaltyPointsToRedeem: loyaltyPts,
            paymentGateway: paymentMethod,
            ...(paymentPhone.trim() && (paymentMethod === 'jazzcash' || paymentMethod === 'easypaisa') && {
              paymentPhone: paymentPhone.trim(),
            }),
            tipCents,
            giftCardCode: giftCard.trim().toUpperCase() || undefined,
            items: items.map(i => ({
              menuItemId: i.menuItemId,
              quantity: i.quantity,
              notes: i.notes,
              modifiers: (i.modifiers ?? []).map(m => ({
                modifierId: m.modifierId ?? '',
                name: m.name,
                priceDeltaCents: m.priceDeltaCents,
              })).filter(m => m.modifierId),
            })),
          }),
        })
        if (!res.ok) {
          const d = await res.json() as { error?: { message?: string } }
          throw new Error(d?.error?.message ?? 'Failed to place order')
        }
        const order = await res.json() as { id: string }
        if (promoCode.trim()) trackPromoApplied(promoCode.trim(), slug, subtotalCents() - displayTotal)
        _orderPlaced.current = true
        trackOrderPlaced(order.id, slug, displayTotal, paymentMethod)
        // Presentation only: hold the Place-order check for a beat. The
        // button stays disabled (loading is still true), and the cart clear
        // + navigation below are unchanged, same target.
        setPlaced(true)
        await new Promise<void>((resolve) => setTimeout(resolve, 420))
        clearCart()
        router.push(`/${slug}/order/${order.id}`)
      } else {
        // Guest checkout is no longer available — anonymous order placement
        // was abused (free kitchen tickets fired before payment ever cleared).
        // Push the user to login, then resume here after they sign in.
        setLoading(false)
        const next = encodeURIComponent(`/${slug}/checkout`)
        router.push(`/login?next=${next}`)
        return
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong'
      if (promoCode.trim()) trackPromoFailed(promoCode.trim(), msg)
      setError(msg)
      setCtaError(true)
    } finally {
      setLoading(false)
    }
  }

  // CTA label that reflects payment method
  const ctaLabel = loading
    ? 'Placing order…'
    : paymentMethod === 'keenu'
      ? 'Continue to Keenu'
      : 'Place Order'
  // TactileButton state: success holds the check, loading hops, a caught or
  // validation error shakes once, then back to idle.
  const ctaState: TactileState = placed ? 'success' : loading ? 'loading' : ctaError ? 'error' : 'idle'

  return (
    <main
      className={`min-h-dvh pb-32 relative overflow-hidden${brandSkinClass ? ' ' + brandSkinClass : ''}`}
      style={{ background: 'transparent' }}
    >

      {/* Header */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center gap-3"
        style={{ borderBottom: '1px solid rgba(0,0,0,0.08)', background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)' }}>
        <Link href={`/${slug}`}
          className="flex items-center gap-1.5 text-sm font-semibold transition-all duration-150 active:scale-95"
          style={{ color: 'var(--servd-mute)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-mute)')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Menu
        </Link>
        <span style={{ color: 'var(--servd-line)' }}>·</span>
        <h1 className="font-black text-lg tracking-tight" style={{ color: 'var(--servd-ink)' }}>Checkout</h1>
        {token && account && (
          <span className="ml-auto text-xs" style={{ color: 'var(--servd-mute)' }}>
            as <span className="font-bold" style={{ color: 'var(--servd-ink)' }}>{account.name}</span>
          </span>
        )}
      </div>

      <div className="relative z-10 max-w-lg mx-auto px-4 py-5 space-y-3">

        {/* ── Order summary ── */}
        <Panel label="Your Order" i={0}>
          <div className="space-y-3 mb-4">
            {items.map((item, i) => (
              <div key={item.lineId} className={`flex items-start justify-between gap-3 ${styles.rowIn}`}
                style={{ ['--i' as string]: i } as React.CSSProperties}>
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  <div className="h-9 w-9 rounded-xl shrink-0 flex items-center justify-center text-sm font-black"
                    style={{ background: 'var(--servd-surface)', color: 'var(--servd-mute)' }}>
                    {item.quantity}×
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-sm truncate" style={{ color: 'var(--servd-ink)' }}>{item.name}</p>
                    {item.modifiers && item.modifiers.length > 0 && (
                      <p className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--servd-mute)' }}>
                        {item.modifiers.map((m) => m.name).join(' · ')}
                      </p>
                    )}
                  </div>
                </div>
                <span className="font-black text-sm shrink-0" style={{ color: 'var(--servd-green-dark)' }}>
                  {fmt(item.priceCents * item.quantity)}
                </span>
              </div>
            ))}
          </div>
          {/* How are you getting it? — brand-aware. Allow-list driven by
              BRAND_FULFILMENT at top of file. When the brand offers only
              one option (e.g. Simmer = dine-in), skip the chooser and
              just confirm the mode statically. */}
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(58,14,105,0.06)', border: '1px solid rgba(58,14,105,0.25)' }}>
            {allowedFulfilment.length === 1 ? (
              <>
                <p className="text-xs font-bold tracking-wider uppercase mb-1" style={{ color: 'var(--servd-green-dark)' }}>
                  {FULFILMENT_LABEL[allowedFulfilment[0]!]}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  {allowedFulfilment[0] === 'dine-in'
                    ? 'Your order goes straight to your table.'
                    : ''}
                </p>
              </>
            ) : (
              <>
                <p className="text-xs font-bold tracking-wider uppercase mb-2" style={{ color: 'var(--servd-green-dark)' }}>How are you getting it?</p>
                <div className="flex gap-2 mb-2" role="group" aria-label="How are you getting it?">
                  {allowedFulfilment.map((m) => (
                    <ChoiceChip
                      key={m}
                      calm={isSimmer}
                      selected={fulfilmentType === m}
                      onClick={() => setFulfilmentType(m)}
                      className="flex-1 rounded-lg px-3 py-2 text-xs font-bold"
                      selectedStyle={{ background: 'var(--servd-green-dark)', color: slug === 'stackd' ? '#0a0a0a' : 'var(--party-cream, #FFF4D6)', border: '1px solid var(--servd-green)' }}
                      idleStyle={{ background: '#fff', color: 'var(--servd-ink)', border: '1px solid rgba(0,0,0,0.08)' }}>
                      {FULFILMENT_LABEL[m]}
                    </ChoiceChip>
                  ))}
                </div>
              </>
            )}
            {fulfilmentType === 'dine-in' && allowedFulfilment.length > 1 && (
              <p className="text-[11px] mt-1" style={{ color: 'var(--servd-mute)' }}>
                Your order goes straight to your table.
              </p>
            )}
            {/* Dine-in table number — required for dine-in so the runner
                knows which table to bring the plates to. Renders for both
                the "single option" case (Simmer) and the chooser case
                (Stackd, Flipd) whenever dine-in is selected. */}
            {fulfilmentType === 'dine-in' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  What table are you at? The number is on the QR card at your seat (e.g. T-7, 12).
                </p>
                <TactileInput
                  value={tableLabel} onChange={(e) => setTableLabel(e.target.value)}
                  placeholder="Table number"
                  aria-label="Table number"
                  maxLength={20}
                  inputMode="text"
                  autoCapitalize="characters"
                  className="w-full rounded-lg px-3 py-2 text-sm uppercase tracking-wider"
                  style={{ background: '#fff' }}
                />
              </div>
            )}
            {fulfilmentType === 'curbside' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  Tell us about your car so we can find you. Tap &ldquo;I&rsquo;m here&rdquo; on the order page when you arrive.
                </p>
                <TactileInput
                  value={curbsideVehicle} onChange={(e) => setCurbsideVehicle(e.target.value)}
                  placeholder="e.g. Blue Honda Civic"
                  aria-label="Your car"
                  maxLength={80}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff' }} />
                <TactileInput
                  value={curbsidePlate} onChange={(e) => setCurbsidePlate(e.target.value)}
                  placeholder="License plate (optional)"
                  aria-label="License plate (optional)"
                  maxLength={20}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff' }} />
              </div>
            )}
            {fulfilmentType === 'delivery' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  We&rsquo;ll bring it to your door.
                </p>

                {/* Saved address pills — only for logged-in users who have addresses */}
                {token && savedAddresses.length > 0 && (
                  <div className="space-y-1.5">
                    {savedAddresses.map((addr) => {
                      const isSelected = selectedAddressId === addr.id && !showNewAddressInput
                      return (
                        <button
                          key={addr.id}
                          type="button"
                          onClick={() => {
                            setSelectedAddressId(addr.id)
                            setDeliveryAddress(addr.address)
                            setShowNewAddressInput(false)
                          }}
                          aria-pressed={isSelected}
                          className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left ${styles.pressable}`}
                          style={isSelected
                            ? { background: 'rgba(58,14,105,0.1)', border: '1.5px solid var(--servd-green)' }
                            : { background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }}>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                            className="shrink-0" style={{ color: isSelected ? 'var(--servd-green-dark)' : 'var(--servd-mute)' }}>
                            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                            <circle cx="12" cy="10" r="3"/>
                          </svg>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-xs" style={{ color: 'var(--servd-ink)' }}>{addr.label}</span>
                              {addr.isDefault && (
                                <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                                  style={{ background: 'rgba(58,14,105,0.12)', color: 'var(--servd-green-dark)' }}>Default</span>
                              )}
                            </div>
                            <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--servd-mute)' }}>{addr.address}</p>
                          </div>
                          {isSelected && (
                            <div className="h-4 w-4 rounded-full shrink-0 flex items-center justify-center"
                              style={{ background: 'var(--servd-green-dark)' }}>
                              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                <path d="M1.5 4L3.5 6L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </div>
                          )}
                        </button>
                      )
                    })}
                    {/* Enter new address option */}
                    <button
                      type="button"
                      onClick={() => {
                        setShowNewAddressInput(true)
                        setSelectedAddressId(null)
                        setDeliveryAddress('')
                      }}
                      aria-pressed={showNewAddressInput}
                      className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left ${styles.pressable}`}
                      style={showNewAddressInput
                        ? { background: 'rgba(58,14,105,0.1)', border: '1.5px solid var(--servd-green)' }
                        : { background: '#fff', border: '1px dashed rgba(0,0,0,0.12)' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                        className="shrink-0" style={{ color: 'var(--servd-mute)' }}>
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                      <span className="text-xs font-semibold" style={{ color: 'var(--servd-ink)' }}>Enter a different address</span>
                    </button>
                  </div>
                )}

                {/* Show text input when "new address" is selected or no saved addresses exist. */}
                {(showNewAddressInput || savedAddresses.length === 0) && (
                  <TactileInput
                    value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)}
                    placeholder="Full delivery address"
                    aria-label="Full delivery address"
                    maxLength={200}
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: '#fff' }} />
                )}

                <TactileInput
                  value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)}
                  placeholder="Gate code, floor, landmark… (optional)"
                  aria-label="Delivery notes (optional)"
                  maxLength={120}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff' }} />
              </div>
            )}
          </div>

          {/* Tip the rider — only when there's actually a rider, i.e.
              the order is being delivered. Dine-in, pickup, and curbside
              don't involve a rider, so hide the section entirely. */}
          {fulfilmentType === 'delivery' && (
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(58,14,105,0.08)', border: '1px solid rgba(58,14,105,0.2)' }}>
            <p className="text-xs font-bold tracking-wider uppercase text-[color:var(--servd-green-dark)] mb-2">Tip the rider</p>
            <div className="flex flex-wrap gap-1.5 mb-2" role="group" aria-label="Tip the rider">
              {(['none', '5', '10', '15', '20', 'custom'] as const).map((m) => (
                <ChoiceChip
                  key={m}
                  calm={isSimmer}
                  selected={tipMode === m}
                  onClick={() => setTipMode(m)}
                  className="px-3 py-1.5 rounded-full text-xs font-bold border"
                  selectedStyle={{ background: '#0a0a0a', color: '#fff', borderColor: '#0a0a0a' }}
                  idleStyle={{ background: 'white', color: '#0a0a0a', borderColor: 'rgba(0,0,0,0.1)' }}
                >
                  {m === 'none' ? 'No tip' : m === 'custom' ? 'Custom' : `${m}%`}
                </ChoiceChip>
              ))}
            </div>
            {tipMode === 'custom' && (
              <TactileInput
                type="number" min={0} step={50}
                value={customTip}
                onChange={(e) => setCustomTip(e.target.value)}
                placeholder="Tip amount (PKR)"
                aria-label="Tip amount (PKR)"
                className="w-full text-sm rounded-lg px-3 py-1.5"
              />
            )}
            {tipCents > 0 && (
              <p className="text-xs mt-2 text-[color:var(--servd-green-dark)] font-semibold">
                Tip: {fmt(tipCents)} — goes 100% to staff (tip pool).
              </p>
            )}
          </div>
          )}

          {/* Gift card */}
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <label className="text-xs font-bold tracking-wider uppercase text-[color:var(--servd-mute)] block mb-2">Gift card</label>
            <div className="flex gap-2">
              <TactileInput
                aria-label="Gift card code"
                invalid={giftCardStatus === 'invalid'}
                value={giftCard}
                onChange={(e) => {
                  setGiftCard(e.target.value.toUpperCase())
                  // Reset validation when user edits the code
                  if (giftCardStatus !== 'idle') {
                    setGiftCardStatus('idle')
                    setGiftCardBalance(0)
                  }
                }}
                placeholder="GS-XXXX-XXXX"
                className="flex-1 min-w-0 text-sm rounded-lg px-3 py-1.5 font-mono uppercase tracking-wider"
              />
              <button
                type="button"
                onClick={() => { void checkGiftCardBalance() }}
                disabled={giftCardStatus === 'checking' || !giftCard.trim()}
                aria-busy={giftCardStatus === 'checking' || undefined}
                className={`shrink-0 inline-flex items-center justify-center min-w-[3.75rem] rounded-lg px-3 py-1.5 text-xs font-black ${styles.pressable}`}
                style={{
                  background: giftCardStatus === 'valid' ? 'var(--servd-green-dark)' : 'rgba(0,0,0,0.07)',
                  color: giftCardStatus === 'valid' ? '#fff' : 'var(--servd-ink)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  opacity: !giftCard.trim() && giftCardStatus !== 'checking' ? 0.4 : 1,
                }}>
                {giftCardStatus === 'checking'
                  ? <HopDots size={5} gap={3} label="Checking card" />
                  : giftCardStatus === 'valid'
                    ? <SpringCheck label="Card accepted" />
                    : 'Check'}
              </button>
            </div>
            <AnimatePresence initial={false}>
              {giftCardStatus === 'valid' && (
                <SlideMessage key="gc-ok" color="var(--servd-green-dark)">
                  Balance: {fmt(giftCardBalance)}
                  {giftCardDeduction > 0 && ` · saving ${fmt(giftCardDeduction)} on this order`}
                </SlideMessage>
              )}
              {giftCardStatus === 'invalid' && (
                <SlideMessage key="gc-bad" color="#dc2626" alert>
                  Invalid or expired card
                </SlideMessage>
              )}
            </AnimatePresence>
          </div>

          <div className="rounded-xl p-3.5 space-y-2"
            style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <PriceLine label="Subtotal"    value={fmt(subtotalCents())} />
            <PriceLine label={`GST (${(taxRate * 100).toFixed(0)}%)`} value={fmt(taxCentsLive)} />
            {tipCents > 0 && (
              <PriceLine label="Tip" value={fmt(tipCents)} accent="var(--servd-green-dark)" />
            )}
            {loyaltyDeduction > 0 && (
              <PriceLine label={`Points (${loyaltyPts} pts)`} value={`−${fmt(loyaltyDeduction)}`} accent="var(--servd-green-dark)" pop={!isSimmer} />
            )}
            {walletDeduction > 0 && (
              <PriceLine label="Wallet credit" value={`−${fmt(walletDeduction)}`} accent="var(--servd-green-dark)" pop={!isSimmer} />
            )}
            {promoDiscountCents > 0 && (
              <PriceLine label={`Promo (${promoCode.trim().toUpperCase()})`} value={`−${fmt(promoDiscountCents)}`} accent="var(--servd-green-dark)" pop={!isSimmer} />
            )}
            {giftCardDeduction > 0 && (
              <PriceLine label={`Gift card (${giftCard.trim().toUpperCase()})`} value={`−${fmt(giftCardDeduction)}`} accent="var(--servd-green-dark)" pop={!isSimmer} />
            )}
            <div className="flex justify-between items-center pt-2.5"
              style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <span className="font-black text-base" style={{ color: 'var(--servd-ink)' }}>Total</span>
              <RollingPrice cents={displayTotal} className="font-black text-xl" style={{ color: 'var(--servd-green-dark)' }} />
            </div>
          </div>
        </Panel>

        {/* Cross-brand upsell removed from checkout: it linked to another
            brand at peak intent, and switching brand calls cart.clearCart()
            (single-concept cart), silently destroying the order it was meant
            to grow. Re-introduce only behind a real multi-kitchen cart. */}

        {token ? (
          <>
            {/* Promo code */}
            <Panel icon="" label="Promo Code" i={1}>
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <ServdInput
                    ariaLabel="Promo code"
                    invalid={promoStatus === 'invalid'}
                    type="text" value={promoCode}
                    onChange={e => {
                      setPromoCode(e.target.value.toUpperCase())
                      // Reset validation when user edits the code
                      if (promoStatus !== 'idle') {
                        setPromoStatus('idle')
                        setPromoDiscountCents(0)
                        setPromoMessage('')
                      }
                    }}
                    placeholder="Enter promo code"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { void applyPromo() }}
                  disabled={promoStatus === 'checking' || !promoCode.trim()}
                  aria-busy={promoStatus === 'checking' || undefined}
                  className={`shrink-0 inline-flex items-center justify-center min-w-[4.5rem] rounded-xl px-4 py-3 text-sm font-black ${styles.pressable}`}
                  style={{
                    background: 'var(--servd-green-dark)', color: '#fff',
                    opacity: !promoCode.trim() && promoStatus !== 'checking' ? 0.4 : 1,
                  }}
                >
                  {promoStatus === 'checking'
                    ? <HopDots size={5} gap={3} label="Checking code" />
                    : promoStatus === 'valid'
                      ? <SpringCheck label="Code applied" />
                      : 'Apply'}
                </button>
              </div>
              <AnimatePresence initial={false}>
                {promoStatus === 'valid' && promoMessage && (
                  <SlideMessage key="promo-ok" color="var(--servd-green-dark)">
                    <InlineCheck /> {promoMessage} · saving {fmt(promoDiscountCents)}
                  </SlideMessage>
                )}
                {promoStatus === 'invalid' && promoMessage && (
                  <SlideMessage key="promo-bad" color="#dc2626" alert>
                    {promoMessage}
                  </SlideMessage>
                )}
              </AnimatePresence>
            </Panel>

            {/* Wallet toggle */}
            {walletBalance > 0 && (
              <button
                onClick={() => setUseWallet(v => !v)}
                aria-pressed={useWallet}
                className={`flex items-center justify-between w-full rounded-2xl p-4 ${styles.pressable} ${styles.panelIn}`}
                style={{
                  ['--i' as string]: 2,
                  background: useWallet ? 'rgba(58,14,105,0.06)' : '#fff',
                  border: `1px solid ${useWallet ? 'rgba(58,14,105,0.28)' : 'rgba(0,0,0,0.07)'}`,
                  boxShadow: useWallet ? '0 0 20px rgba(58,14,105,0.08)' : '0 2px 8px rgba(0,0,0,0.04)',
                }}>
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: useWallet ? 'rgba(58,14,105,0.12)' : 'var(--servd-surface)', color: useWallet ? 'var(--servd-green-dark)' : 'var(--servd-mute)' }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 7H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
                      <path d="M17 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>
                      <path d="M5 5h14"/>
                    </svg>
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>Use Wallet Balance</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--servd-mute)' }}>
                      {fmt(walletBalance)} available
                    </p>
                  </div>
                </div>
                <div className="h-5 w-9 rounded-full transition-all duration-300 relative shrink-0"
                  style={{ background: useWallet ? 'var(--servd-green)' : 'rgba(0,0,0,0.12)' }}>
                  <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-300"
                    style={{ left: useWallet ? '1.1rem' : '0.125rem' }} />
                </div>
              </button>
            )}

            {/* Loyalty points */}
            {loyaltyBalance > 0 && (
              <Panel icon="" label="Redeem Points" i={3}>
                <div className="flex items-center justify-between">
                  <p className="text-xs" style={{ color: 'var(--servd-mute)' }}>
                    {loyaltyBalance} pts available · <span style={{ color: 'var(--servd-ink)' }}>{loyaltyPts} selected</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <StepBtn onClick={() => setLoyaltyPts(p => Math.max(0, p - 10))}>−</StepBtn>
                    <span className="font-black text-sm w-10 text-center" style={{ color: 'var(--servd-ink)' }}>{loyaltyPts}</span>
                    <StepBtn onClick={() => setLoyaltyPts(p => Math.min(loyaltyBalance, p + 10))}>+</StepBtn>
                  </div>
                </div>
              </Panel>
            )}

            {/* Notes */}
            <Panel icon="" label="Special Instructions for Kitchen" i={4}>
              <ServdTextarea ariaLabel="Special instructions for the kitchen" value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Allergies, spice level, extras…" rows={2} />
            </Panel>
          </>
        ) : (
          /* ── Guest details ── */
          <Panel icon="" label="Your Details" i={1} extra={
            <Link href="/login"
              className="text-xs font-black transition-colors"
              style={{ color: 'var(--servd-green-dark)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-green-dark)')}>
              Sign in for rewards →
            </Link>
          }>
            <div className="space-y-3">
              <FormField label="Name *">
                <ServdInput type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your name" autoFocus />
              </FormField>
              <FormField label="Phone (optional)">
                <ServdInput type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="03xx-xxxxxxx" />
              </FormField>
              <FormField label="Special instructions (optional)">
                <ServdTextarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Allergies, preferences…" rows={2} />
              </FormField>
            </div>
          </Panel>
        )}

        {/* ── Payment Method ── */}
        <Panel icon="" label="Payment Method" i={5}>
          <div className="space-y-2" role="radiogroup" aria-label="Payment method">
            {PAYMENT_OPTIONS.map((opt) => {
              const isSelected = paymentMethod === opt.id
              return (
                <div key={opt.id}>
                  <ChoiceChip
                    aria="radio"
                    calm={isSimmer}
                    selected={isSelected}
                    onClick={() => setPaymentMethod(opt.id)}
                    className="w-full flex items-center gap-3 rounded-xl px-3.5 py-3"
                    selectedStyle={{ background: 'rgba(58,14,105,0.06)', border: '1.5px solid rgba(58,14,105,0.35)' }}
                    idleStyle={{ background: 'rgba(0,0,0,0.025)', border: '1.5px solid rgba(0,0,0,0.07)' }}
                    dot
                    dotSelectedStyle={{ background: 'rgba(58,14,105,0.12)', border: '1.5px solid rgba(58,14,105,0.45)' }}
                    dotIdleStyle={{ background: 'transparent', border: '1.5px solid rgba(0,0,0,0.15)' }}>
                    <span className="text-lg shrink-0">{opt.icon}</span>
                    <span className="flex-1 text-left min-w-0">
                      <span className="block font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>{opt.label}</span>
                      {!opt.phoneRequired && (
                        <span className="block text-[11px] mt-0.5" style={{ color: 'var(--servd-mute)' }}>{opt.sub}</span>
                      )}
                    </span>
                  </ChoiceChip>

                  {/* Phone number input for mobile wallets */}
                  {isSelected && opt.phoneRequired && (
                    <div className="mt-1.5 px-1">
                      <TactileInput
                        type="tel"
                        value={paymentPhone}
                        onChange={(e) => setPaymentPhone(e.target.value)}
                        placeholder="03xx-xxxxxxx"
                        aria-label={`${opt.label} number`}
                        maxLength={15}
                        className="w-full rounded-lg px-3 py-2 text-sm"
                        style={{ background: '#fff' }}
                      />
                      <p className="text-[11px] mt-1" style={{ color: 'var(--servd-mute)' }}>
                        Enter your {opt.label} number to process payment
                      </p>
                    </div>
                  )}

                  {/* Keenu redirect note */}
                  {isSelected && opt.id === 'keenu' && (
                    <div className="mt-1.5 mx-1 rounded-lg px-3 py-2"
                      style={{ background: 'rgba(58,14,105,0.06)', border: '1px solid rgba(58,14,105,0.2)' }}>
                      <p className="text-[11px]" style={{ color: 'var(--servd-green-dark)' }}>
                        After placing your order you&rsquo;ll be redirected to Keenu&rsquo;s secure payment page to complete payment by card.
                      </p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Panel>

        {error && (
          <div role="alert" aria-live="assertive"
            className="flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium"
            style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#dc2626' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* ── Trust strip — per the CRO skill: address the three top
              objections right before the place-order button. Same facts,
              now drawn in as they arrive. */}
        <TrustStrip />
      </div>

      {/* ── Fixed CTA ── */}
      <div className="fixed bottom-0 left-0 right-0 px-4 pt-4 z-40"
        style={{ background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(24px)', borderTop: '1px solid rgba(0,0,0,0.08)', paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <TactileButton
          onClick={() => { void handlePlaceOrder() }} disabled={loading}
          state={ctaState}
          loadingLabel="Placing your order"
          successLabel={isSimmer ? 'order in' : 'Order in'}
          squish={isSimmer ? 0.2 : 1.2}
          className="flex items-center justify-center w-full max-w-lg mx-auto rounded-2xl py-4 px-6 font-black text-base transition-[box-shadow,background-color,color] duration-200"
          style={{
            background: 'var(--servd-green)',
            color: '#fff',
            boxShadow: loading ? '0 0 18px rgba(58,14,105,0.18)' : '0 0 32px rgba(58,14,105,0.28)',
          }}>
          <span className={styles.ctaInner}>
            <span className={styles.ctaLabel}>{ctaLabel}</span>
            <span className={styles.ctaSep} aria-hidden="true">·</span>
            <RollingPrice cents={displayTotal} />
          </span>
        </TactileButton>
      </div>
    </main>
  )
}

/* ── Sub-components ── */

function Panel({ icon, label, extra, children, i = 0 }: {
  icon?: string; label: string; extra?: React.ReactNode; children: React.ReactNode
  /** Mount order — panels fade up with a 60ms stagger. */
  i?: number
}) {
  // icon prop retained for backward compat but unused — the eyebrow label
  // alone carries the meaning. Skill rule: no emoji as structural icons.
  void icon
  return (
    <div className={`rounded-2xl p-4 space-y-3 ${styles.panelIn}`}
      style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', ['--i' as string]: i } as React.CSSProperties}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.22em]"
          style={{ color: 'var(--servd-mute)' }}>{label}</p>
        {extra}
      </div>
      {children}
    </div>
  )
}

function PriceLine({ label, value, accent, pop = false }: {
  label: string; value: string; accent?: string
  /** A discount arriving: the value lands with a jelly wobble and a
   *  tomato-to-ink flash. Off on simmer (no bounce) and under reduced motion. */
  pop?: boolean
}) {
  const reduce = useReducedMotion()
  const animate = pop && !reduce
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: 'var(--servd-mute)' }}>{label}</span>
      {animate ? (
        <motion.span
          className={styles.inkFlash}
          style={{ color: accent ?? 'var(--servd-mute)', display: 'inline-block', transformOrigin: '100% 60%' }}
          initial={{ scaleX: 1, scaleY: 1 }}
          animate={JELLY}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          {value}
        </motion.span>
      ) : (
        <span style={{ color: accent ?? 'var(--servd-mute)' }}>{value}</span>
      )}
    </div>
  )
}

/* Rolling digits — each digit is a 0-9 strip that springs to its place, so
   a total that changes reads as the same number rolling, not a swap. The
   full value is in a visually hidden span for assistive tech. Digits are
   keyed from the right so the units column stays the units column as the
   number grows. */
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

function RollingPrice({ cents, className, style }: {
  cents: number; className?: string; style?: React.CSSProperties
}) {
  const text = fmt(cents)
  const chars = text.split('')
  return (
    <span className={className} style={style}>
      <span className={styles.srOnly}>{text}</span>
      <span className={styles.roll} aria-hidden="true">
        {chars.map((c, idx) => {
          const col = chars.length - idx
          const d = c.charCodeAt(0) - 48
          if (d < 0 || d > 9) {
            return <span key={`s${col}`} className={styles.rollStatic}>{c}</span>
          }
          return (
            <span key={`d${col}`} className={styles.rollCell}>
              <span className={styles.rollGhost}>{c}</span>
              <span className={styles.rollStrip} style={{ transform: `translateY(${-d * 10}%)` }}>
                {DIGITS.map((n) => <span key={n}>{n}</span>)}
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}

/* A field message that slides down (height + fade, 200ms) instead of
   popping in and shoving the page. Reduced motion: a plain fade. */
function SlideMessage({ color, alert = false, children }: {
  color: string; alert?: boolean; children: React.ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      className={styles.msgWrap}
      initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
      animate={reduce ? { opacity: 1 } : { height: 'auto', opacity: 1 }}
      exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
      transition={{ duration: reduce ? 0.12 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      {...(alert ? { role: 'alert' as const } : {})}
    >
      <p className="text-xs font-semibold pt-1.5" style={{ color }}>
        {children}
      </p>
    </motion.div>
  )
}

/* The apply button's success mark: springs in on SPRING.pop and draws on. */
function SpringCheck({ label }: { label: string }) {
  const reduce = useReducedMotion()
  return (
    <motion.svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" role="img" aria-label={label}
      initial={reduce ? false : { scale: 0, rotate: -25 }}
      animate={{ scale: 1, rotate: 0 }}
      transition={SPRING.pop}
    >
      <motion.path
        d="M4.5 12.5l5 5L19.5 7"
        stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"
        initial={reduce ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.26, delay: 0.08, ease: 'easeOut' }}
      />
    </motion.svg>
  )
}

function InlineCheck() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline', verticalAlign: '-1px' }}>
      <path d="M4.5 12.5l5 5L19.5 7" />
    </svg>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
        style={{ color: 'var(--servd-mute)' }}>{label}</label>
      {children}
    </div>
  )
}

// Focus is class-driven now (TactileField): the ring grows via box-shadow,
// the border colour transitions, and the field lifts to 1.01. Same props and
// values as before; `invalid` / `ariaLabel` are presentation-only additions.
function ServdInput({ type, value, onChange, placeholder, autoFocus, invalid, ariaLabel }: {
  type: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string; autoFocus?: boolean
  invalid?: boolean; ariaLabel?: string
}) {
  return (
    <TactileInput
      type={type} value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus}
      invalid={invalid}
      aria-label={ariaLabel}
      className="w-full rounded-xl px-4 py-3 text-sm placeholder:text-black/25"
      style={{ background: '#fff', color: 'var(--servd-ink)' }}
    />
  )
}

function ServdTextarea({ value, onChange, placeholder, rows, ariaLabel }: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string; rows?: number
  ariaLabel?: string
}) {
  return (
    <TactileTextarea
      value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      aria-label={ariaLabel}
      className="w-full rounded-xl px-4 py-3 text-sm resize-none placeholder:text-black/25"
      style={{ background: '#fff', color: 'var(--servd-ink)' }}
    />
  )
}

function StepBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`h-8 w-8 rounded-xl flex items-center justify-center font-black ${styles.pressable}`}
      style={{ background: 'rgba(0,0,0,0.07)', color: 'var(--servd-mute)', border: '1px solid rgba(0,0,0,0.08)' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-mute)')}>
      {children}
    </button>
  )
}

/* Brand name for a slug, through formatBrandName so simmer / stackd stay
   lowercase and Flipd keeps its capital. */
function brandLabel(s: string): string {
  return formatBrandName(s ? s.charAt(0).toUpperCase() + s.slice(1) : '')
}

/* Empty cart — a designed state, not a dead end.
   Hub / stackd / Flipd: the crowd shrugs on a rubber sticker card, with a
   rubber CTA back to the menu and rubber-press quick switches.
   simmer: no characters. Lowercase, Amarante + Times, hairlines, a weighted
   1px press. */
function EmptyCart({ slug, simmer }: { slug: string; simmer: boolean }) {
  const others = ['stackd', 'simmer', 'flipd'].filter((s) => s !== slug)
  const name = slug ? brandLabel(slug) : ''

  if (simmer) {
    return (
      <div className={styles.simmerEmpty}>
        <h1 className={styles.simmerTitle}>your cart&rsquo;s empty</h1>
        <p className={styles.simmerSub}>pick something from {name || 'the menu'} to get going.</p>
        <Link href={`/${slug}`} className={styles.simmerLink}>see the {name} menu</Link>
        <div className="flex flex-col items-center gap-2 pt-6">
          <p className="text-[11px] tracking-[0.22em]" style={{ opacity: 0.6 }}>or pick a different kitchen</p>
          <div className="flex gap-2 flex-wrap justify-center">
            {others.map((s) => (
              <Link key={s} href={`/${s}`} className={styles.simmerChip}>{brandLabel(s)}</Link>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className={styles.stickerCard}>
        <div className={styles.posterFrame}>
          <CrowdPoster cast={['fries', 'sandwich']} mode="shrug" />
        </div>
        <h1 className={styles.stickerTitle}>Your cart&rsquo;s empty</h1>
        <p className={styles.stickerSub}>
          Pick something from {name || 'the menu'} to get going.
        </p>
        <Link href={`/${slug}`} className={`${styles.rubber} ${styles.rubberPrimary}`}>
          See the {name} menu
        </Link>
      </div>
      {/* Quick switch to the other brands so an empty-cart visitor doesn't
          have to back out to the home page to change kitchens. */}
      <div className="flex flex-col items-center gap-2.5 pt-3">
        <p className={styles.eyebrow}>or pick a different kitchen</p>
        <div className="flex gap-2.5 flex-wrap justify-center">
          {others.map((s) => (
            <Link key={s} href={`/${s}`} className={`${styles.rubber} ${styles.rubberSmall}`}>
              {brandLabel(s)}
            </Link>
          ))}
        </div>
      </div>
    </>
  )
}
