'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCart } from '../../../store/cart'
import { useCustomerAuth } from '../../../store/customerAuth'
import { fmt } from '../../../lib/ui'
import { decodeCartToken } from '../../../lib/cartHandoff'
import { trackCheckoutStarted, trackCheckoutAbandoned, trackOrderPlaced, trackPromoApplied, trackPromoFailed } from '../../../lib/analytics'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface AccountInfo {
  id: string
  name: string
  walletBalance: number
  loyaltyAccount: { pointsBalance: number } | null
}

// GET /storefront/quote — the server's bill for this basket.
interface Quote {
  tender: 'cash' | 'card'
  taxRatePct: number
  itemTotalCents: number
  taxCents: number
  deliveryFeeCents: number
  serviceChargeCents: number
  pricedTotalCents: number
  promo: { code: string; discountCents: number; description: string } | null
  promoError: { code: string; message: string } | null
  loyaltyPoints: number
  loyaltyDiscountCents: number
  walletCents: number
  tipCents: number
  giftCardCents: number
  totalCents: number
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
  // The page prices NOTHING itself: every figure on it — GST (by tender,
  // decision 9), delivery fee, service charge, promo, points, wallet, tip,
  // gift card, total — comes from GET /storefront/quote, which prices with
  // the same server function checkout charges with (lib/pricing.ts). It used
  // to hardcode 15% / 8% here while the server always charged 8%.
  const { items, subtotalCents, itemCount, clearCart, hydrateFromReorder } = useCart()
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
  // (stackd.pk, stackd.localhost:3002…) and clicks checkout, the brand site
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
  const [promoMessage,      setPromoMessage]      = useState('')
  // The code the customer pressed Apply on — sent to the quote.
  const [appliedPromo,      setAppliedPromo]      = useState('')
  const [useWallet,  setUseWallet]  = useState(false)
  const [loyaltyPts, setLoyaltyPts] = useState(0)
  // The company's redeem minimum (GET /loyalty/program): below it the server
  // refuses the redemption, so the stepper jumps from 0 straight to it.
  const [minRedeemPts, setMinRedeemPts] = useState(0)
  useEffect(() => {
    fetch(`${API_URL}/api/v1/loyalty/program?conceptSlug=${encodeURIComponent(slug)}`)
      .then((r) => (r.ok ? r.json() as Promise<{ minRedeemPoints: number }> : null))
      .then((p) => { if (p) setMinRedeemPts(p.minRedeemPoints ?? 0) })
      .catch(() => {})
  }, [slug])

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

  // Delivery drop point: the chosen saved address's pin. The server needs
  // it for the zone fee (and refuses delivery without it).
  const selectedAddress = savedAddresses.find((a) => a.id === selectedAddressId && !showNewAddressInput) ?? null
  const deliveryLat = selectedAddress?.lat ?? null
  const deliveryLng = selectedAddress?.lng ?? null

  // Server quote — refreshed whenever anything that changes the bill does.
  const [quote,      setQuote]      = useState<Quote | null>(null)
  const [quoteError, setQuoteError] = useState('')
  const basketKey = JSON.stringify(items.map((i) => [i.menuItemId, i.quantity, (i.modifiers ?? []).map((m) => m.modifierId ?? '')]))
  const tipParams: Record<string, string> = fulfilmentType !== 'delivery' || tipMode === 'none'
    ? {}
    : tipMode === 'custom'
      ? { tipCents: String(Math.max(0, Math.round((parseFloat(customTip) || 0) * 100))) }
      : { tipPct: tipMode }
  const tipKey = JSON.stringify(tipParams)
  useEffect(() => {
    if (items.length === 0) return
    const params = new URLSearchParams({
      conceptSlug: slug,
      type: fulfilmentType,
      paymentGateway: paymentMethod,
      items: JSON.stringify(items.map((i) => ({
        menuItemId: i.menuItemId,
        quantity: i.quantity,
        modifiers: (i.modifiers ?? []).filter((m) => m.modifierId).map((m) => ({ modifierId: m.modifierId! })),
      }))),
      ...(fulfilmentType === 'delivery' && deliveryLat != null && deliveryLng != null && {
        deliveryLat: String(deliveryLat), deliveryLng: String(deliveryLng),
      }),
      ...(appliedPromo && { promoCode: appliedPromo }),
      ...(loyaltyPts > 0 && { loyaltyPointsToRedeem: String(loyaltyPts) }),
      ...(useWallet && { useWallet: 'true' }),
      ...(giftCardStatus === 'valid' && giftCard.trim() && { giftCardCode: giftCard.trim().toUpperCase() }),
      ...tipParams,
    })
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/quote?${params.toString()}`, {
        signal: ctrl.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
        .then(async (res) => {
          const data = await res.json()
          if (!res.ok) {
            setQuote(null)
            setQuoteError((data as { error?: { message?: string } })?.error?.message ?? 'Could not price your order')
            return
          }
          const q = data as Quote
          setQuote(q)
          setQuoteError('')
          if (appliedPromo) {
            if (q.promo) { setPromoStatus('valid'); setPromoMessage(q.promo.description) }
            else { setPromoStatus('invalid'); setPromoMessage(q.promoError?.message ?? 'Promo code is invalid') }
          }
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setQuoteError('Could not price your order. Check your connection.')
        })
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketKey, slug, fulfilmentType, paymentMethod, deliveryLat, deliveryLng, appliedPromo, loyaltyPts, useWallet, giftCardStatus, giftCard, tipKey, token])

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

  if (itemCount() === 0) return (
    <div className={`flex min-h-dvh flex-col items-center justify-center gap-5 px-4${brandSkinClass ? ' ' + brandSkinClass : ''}`}
      style={{ background: 'transparent' }}>
      <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="var(--servd-mute)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="21" r="1"/>
        <circle cx="20" cy="21" r="1"/>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
      </svg>
      <div className="text-center space-y-2">
        <p className="font-black text-2xl tracking-tight" style={{ color: 'var(--servd-ink)' }}>
          Your cart&rsquo;s empty
        </p>
        <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>
          Pick something from {slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'the menu'} to get going.
        </p>
      </div>
      <Link href={`/${slug}`}
        className="mt-1 rounded-2xl font-black px-8 py-4 text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
        style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)', boxShadow: '0 6px 18px rgba(61,31,59,0.28)' }}>
        See the {slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : ''} menu
      </Link>
      {/* Quick switch to the other brands so an empty-cart visitor doesn't
          have to back out to the home page to change kitchens. */}
      <div className="flex flex-col items-center gap-1.5 pt-2">
        <p className="text-[10px] font-bold uppercase tracking-[0.22em]" style={{ color: 'var(--servd-dim)' }}>
          or pick a different kitchen
        </p>
        <div className="flex gap-2 flex-wrap justify-center">
          {['stackd', 'simmer', 'flipd'].filter((s) => s !== slug).map((s) => (
            <Link key={s} href={`/${s}`}
              className="rounded-full px-4 py-2 text-xs font-bold transition-colors"
              style={{
                background: 'var(--servd-surface)',
                color: 'var(--servd-ink)',
                border: '1px solid var(--servd-line)',
              }}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )

  const walletBalance    = account?.walletBalance ?? 0
  const loyaltyBalance   = account?.loyaltyAccount?.pointsBalance ?? 0

  // Every figure below is the server's (GET /storefront/quote).
  const tipCents          = quote?.tipCents ?? 0
  const loyaltyDeduction  = quote?.loyaltyDiscountCents ?? 0
  const walletDeduction   = quote?.walletCents ?? 0
  const promoDiscountCents = quote?.promo?.discountCents ?? 0
  const giftCardDeduction = quote?.giftCardCents ?? 0
  const displayTotal      = quote?.totalCents ?? null

  // Apply = ask the quote to price the code (same evaluation as checkout).
  const applyPromo = () => {
    const code = promoCode.trim().toUpperCase()
    if (!code) return
    setPromoStatus('checking')
    setPromoMessage('')
    setAppliedPromo(code)
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
      return
    }
    if (fulfilmentType === 'dine-in' && !tableLabel.trim()) {
      setError('Please enter your table number (printed on the QR card at your seat).')
      return
    }
    if ((paymentMethod === 'jazzcash' || paymentMethod === 'easypaisa') && !paymentPhone.trim()) {
      setError(`Please enter your ${paymentMethod === 'jazzcash' ? 'JazzCash' : 'EasyPaisa'} mobile number`)
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
              ...(deliveryLat != null && deliveryLng != null && { deliveryLat, deliveryLng }),
              ...(deliveryNotes.trim() && { notes: deliveryNotes.trim() }),
            }),
            ...(fulfilmentType === 'curbside' && {
              curbsideVehicle: curbsideVehicle.trim(),
              ...(curbsidePlate.trim() && { curbsidePlate: curbsidePlate.trim() }),
            }),
            ...(fulfilmentType === 'dine-in' && {
              tableLabel: tableLabel.trim(),
            }),
            promoCode: appliedPromo || undefined,
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
        if (appliedPromo) trackPromoApplied(appliedPromo, slug, promoDiscountCents)
        _orderPlaced.current = true
        trackOrderPlaced(order.id, slug, displayTotal ?? 0, paymentMethod)
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

  return (
    <div
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
        <Panel label="Your Order">
          <div className="space-y-3 mb-4">
            {items.map((item, i) => (
              <div key={item.lineId} className="flex items-start justify-between gap-3"
                style={{ animation: `revealUp 0.4s ${i * 0.05}s both` }}>
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
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(135,197,64,0.06)', border: '1px solid rgba(135,197,64,0.25)' }}>
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
                <div className="flex gap-2 mb-2">
                  {allowedFulfilment.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setFulfilmentType(m)}
                      className="flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-all"
                      style={fulfilmentType === m
                        ? { background: 'var(--servd-green-dark)', color: '#0a0a0a', border: '1px solid var(--servd-green)' }
                        : { background: '#fff', color: 'var(--servd-ink)', border: '1px solid rgba(0,0,0,0.08)' }}>
                      {FULFILMENT_LABEL[m]}
                    </button>
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
                <input
                  value={tableLabel} onChange={(e) => setTableLabel(e.target.value)}
                  placeholder="Table number"
                  maxLength={20}
                  inputMode="text"
                  autoCapitalize="characters"
                  className="w-full rounded-lg px-3 py-2 text-sm uppercase tracking-wider"
                  style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }}
                />
              </div>
            )}
            {fulfilmentType === 'curbside' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  Tell us about your car so we can find you. Tap &ldquo;I&rsquo;m here&rdquo; on the order page when you arrive.
                </p>
                <input
                  value={curbsideVehicle} onChange={(e) => setCurbsideVehicle(e.target.value)}
                  placeholder="e.g. Blue Honda Civic"
                  maxLength={80}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }} />
                <input
                  value={curbsidePlate} onChange={(e) => setCurbsidePlate(e.target.value)}
                  placeholder="License plate (optional)"
                  maxLength={20}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }} />
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
                          className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all"
                          style={isSelected
                            ? { background: 'rgba(135,197,64,0.1)', border: '1.5px solid var(--servd-green)' }
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
                                  style={{ background: 'rgba(135,197,64,0.12)', color: 'var(--servd-green-dark)' }}>Default</span>
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
                      className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-all"
                      style={showNewAddressInput
                        ? { background: 'rgba(135,197,64,0.1)', border: '1.5px solid var(--servd-green)' }
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
                  <input
                    value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)}
                    placeholder="Full delivery address"
                    maxLength={200}
                    className="w-full rounded-lg px-3 py-2 text-sm"
                    style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }} />
                )}

                <input
                  value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)}
                  placeholder="Gate code, floor, landmark… (optional)"
                  maxLength={120}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }} />
              </div>
            )}
          </div>

          {/* Tip the rider — only when there's actually a rider, i.e.
              the order is being delivered. Dine-in, pickup, and curbside
              don't involve a rider, so hide the section entirely. */}
          {fulfilmentType === 'delivery' && (
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(135,197,64,0.08)', border: '1px solid rgba(135,197,64,0.2)' }}>
            <p className="text-xs font-bold tracking-wider uppercase text-[color:var(--servd-green-dark)] mb-2">Tip the rider</p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {(['none', '5', '10', '15', '20', 'custom'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setTipMode(m)}
                  aria-pressed={tipMode === m}
                  className="px-3 py-1.5 rounded-full text-xs font-bold border"
                  style={{
                    background: tipMode === m ? '#0a0a0a' : 'white',
                    color:      tipMode === m ? '#fff' : '#0a0a0a',
                    borderColor: tipMode === m ? '#0a0a0a' : 'rgba(0,0,0,0.1)',
                  }}
                >
                  {m === 'none' ? 'No tip' : m === 'custom' ? 'Custom' : `${m}%`}
                </button>
              ))}
            </div>
            {tipMode === 'custom' && (
              <input
                type="number" min={0} step={50}
                value={customTip}
                onChange={(e) => setCustomTip(e.target.value)}
                placeholder="Tip amount (PKR)"
                className="w-full text-sm rounded-lg px-3 py-1.5 border"
                style={{ borderColor: 'rgba(0,0,0,0.1)' }}
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
              <input
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
                className="flex-1 text-sm rounded-lg px-3 py-1.5 border font-mono uppercase tracking-wider"
                style={{ borderColor: 'rgba(0,0,0,0.1)' }}
              />
              <button
                type="button"
                onClick={() => { void checkGiftCardBalance() }}
                disabled={giftCardStatus === 'checking' || !giftCard.trim()}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-black transition-all disabled:opacity-40"
                style={{
                  background: giftCardStatus === 'valid' ? 'var(--servd-green-dark)' : 'rgba(0,0,0,0.07)',
                  color: giftCardStatus === 'valid' ? '#fff' : 'var(--servd-ink)',
                  border: '1px solid rgba(0,0,0,0.08)',
                }}>
                {giftCardStatus === 'checking' ? '…' : giftCardStatus === 'valid' ? '✓' : 'Check'}
              </button>
            </div>
            {giftCardStatus === 'valid' && (
              <p className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-green-dark)' }}>
                Balance: {fmt(giftCardBalance)}
                {giftCardDeduction > 0 && ` · saving ${fmt(giftCardDeduction)} on this order`}
              </p>
            )}
            {giftCardStatus === 'invalid' && (
              <p className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-danger)' }}>
                Invalid or expired card
              </p>
            )}
          </div>

          <div className="rounded-xl p-3.5 space-y-2"
            style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <PriceLine label="Subtotal"    value={quote ? fmt(quote.itemTotalCents) : '…'} />
            <PriceLine label={quote ? `GST (${quote.taxRatePct}%)` : 'GST'} value={quote ? fmt(quote.taxCents) : '…'} />
            {quote && quote.deliveryFeeCents > 0 && (
              <PriceLine label="Delivery" value={fmt(quote.deliveryFeeCents)} />
            )}
            {quote && quote.serviceChargeCents > 0 && (
              <PriceLine label="Service charge" value={fmt(quote.serviceChargeCents)} />
            )}
            {tipCents > 0 && (
              <PriceLine label="Tip" value={fmt(tipCents)} accent="var(--servd-green-dark)" />
            )}
            {loyaltyDeduction > 0 && (
              <PriceLine label={`Points (${quote?.loyaltyPoints ?? loyaltyPts} pts)`} value={`−${fmt(loyaltyDeduction)}`} accent="var(--servd-green-dark)" />
            )}
            {walletDeduction > 0 && (
              <PriceLine label="Wallet credit" value={`−${fmt(walletDeduction)}`} accent="var(--servd-green-dark)" />
            )}
            {promoDiscountCents > 0 && (
              <PriceLine label={`Promo (${appliedPromo})`} value={`−${fmt(promoDiscountCents)}`} accent="var(--servd-green-dark)" />
            )}
            {giftCardDeduction > 0 && (
              <PriceLine label={`Gift card (${giftCard.trim().toUpperCase()})`} value={`−${fmt(giftCardDeduction)}`} accent="var(--servd-green-dark)" />
            )}
            <div className="flex justify-between items-center pt-2.5"
              style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <span className="font-black text-base" style={{ color: 'var(--servd-ink)' }}>Total</span>
              <span className="font-black text-xl" style={{ color: 'var(--servd-green-dark)' }}>{displayTotal != null ? fmt(displayTotal) : '…'}</span>
            </div>
            {quoteError && (
              <p className="text-xs pt-1" style={{ color: 'var(--servd-mute)' }} role="status">{quoteError}</p>
            )}
          </div>
        </Panel>

        {/* Cross-brand upsell removed from checkout: it linked to another
            brand at peak intent, and switching brand calls cart.clearCart()
            (single-concept cart), silently destroying the order it was meant
            to grow. Re-introduce only behind a real multi-kitchen cart. */}

        {token ? (
          <>
            {/* Promo code */}
            <Panel icon="" label="Promo Code">
              <div className="flex gap-2">
                <div className="flex-1">
                  <ServdInput
                    type="text" value={promoCode}
                    onChange={e => {
                      setPromoCode(e.target.value.toUpperCase())
                      // Reset validation when user edits the code
                      if (promoStatus !== 'idle') {
                        setPromoStatus('idle')
                        setAppliedPromo('')
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
                  className="shrink-0 rounded-xl px-4 py-3 text-sm font-black transition-all disabled:opacity-40"
                  style={{ background: 'var(--servd-green-dark)', color: '#fff' }}
                >
                  {promoStatus === 'checking' ? '…' : promoStatus === 'valid' ? '✓' : 'Apply'}
                </button>
              </div>
              {promoStatus === 'valid' && promoMessage && (
                <p className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-green-dark)' }}>
                  ✓ {promoMessage} · saving {fmt(promoDiscountCents)}
                </p>
              )}
              {promoStatus === 'invalid' && promoMessage && (
                <p className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-danger)' }}>
                  {promoMessage}
                </p>
              )}
            </Panel>

            {/* Wallet toggle */}
            {walletBalance > 0 && (
              <button
                onClick={() => setUseWallet(v => !v)}
                className="flex items-center justify-between w-full rounded-2xl p-4 transition-all duration-200 active:scale-[0.99]"
                style={{
                  background: useWallet ? 'rgba(135,197,64,0.06)' : '#fff',
                  border: `1px solid ${useWallet ? 'rgba(135,197,64,0.28)' : 'rgba(0,0,0,0.07)'}`,
                  boxShadow: useWallet ? '0 0 20px rgba(61,31,59,0.08)' : '0 2px 8px rgba(0,0,0,0.04)',
                }}>
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: useWallet ? 'rgba(135,197,64,0.12)' : 'var(--servd-surface)', color: useWallet ? 'var(--servd-green-dark)' : 'var(--servd-mute)' }}>
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
            {loyaltyBalance > 0 && loyaltyBalance >= minRedeemPts && (
              <Panel icon="" label="Redeem Points">
                <div className="flex items-center justify-between">
                  <p className="text-xs" style={{ color: 'var(--servd-mute)' }}>
                    {loyaltyBalance} pts available · <span style={{ color: 'var(--servd-ink)' }}>{loyaltyPts} selected</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <StepBtn onClick={() => setLoyaltyPts(p => (p - 10 < Math.max(minRedeemPts, 1) ? 0 : p - 10))}>−</StepBtn>
                    <span className="font-black text-sm w-10 text-center" style={{ color: 'var(--servd-ink)' }}>{loyaltyPts}</span>
                    <StepBtn onClick={() => setLoyaltyPts(p => Math.min(loyaltyBalance, p === 0 ? Math.max(minRedeemPts, 10) : p + 10))}>+</StepBtn>
                  </div>
                </div>
              </Panel>
            )}

            {/* Notes */}
            <Panel icon="" label="Special Instructions for Kitchen">
              <ServdTextarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Allergies, spice level, extras…" rows={2} />
            </Panel>
          </>
        ) : (
          /* ── Guest details ── */
          <Panel icon="" label="Your Details" extra={
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
        <Panel icon="" label="Payment Method">
          <div className="space-y-2">
            {PAYMENT_OPTIONS.map((opt) => {
              const isSelected = paymentMethod === opt.id
              return (
                <div key={opt.id}>
                  <button
                    type="button"
                    onClick={() => setPaymentMethod(opt.id)}
                    className="w-full flex items-center gap-3 rounded-xl px-3.5 py-3 transition-all"
                    style={isSelected
                      ? { background: 'rgba(135,197,64,0.06)', border: '1.5px solid rgba(135,197,64,0.35)' }
                      : { background: 'rgba(0,0,0,0.025)', border: '1px solid rgba(0,0,0,0.07)' }}>
                    <span className="text-lg shrink-0">{opt.icon}</span>
                    <div className="flex-1 text-left min-w-0">
                      <p className="font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>{opt.label}</p>
                      {!opt.phoneRequired && (
                        <p className="text-[11px] mt-0.5" style={{ color: 'var(--servd-mute)' }}>{opt.sub}</p>
                      )}
                    </div>
                    <div className="h-5 w-5 rounded-full shrink-0 flex items-center justify-center"
                      style={isSelected
                        ? { background: 'rgba(135,197,64,0.12)', border: '1.5px solid rgba(135,197,64,0.45)' }
                        : { background: 'transparent', border: '1.5px solid rgba(0,0,0,0.15)' }}>
                      {isSelected && <div className="h-2 w-2 rounded-full" style={{ background: 'var(--servd-green-dark)' }} />}
                    </div>
                  </button>

                  {/* Phone number input for mobile wallets */}
                  {isSelected && opt.phoneRequired && (
                    <div className="mt-1.5 px-1">
                      <input
                        type="tel"
                        value={paymentPhone}
                        onChange={(e) => setPaymentPhone(e.target.value)}
                        placeholder="03xx-xxxxxxx"
                        maxLength={15}
                        className="w-full rounded-lg px-3 py-2 text-sm"
                        style={{ background: '#fff', border: '1.5px solid rgba(135,197,64,0.3)' }}
                      />
                      <p className="text-[11px] mt-1" style={{ color: 'var(--servd-mute)' }}>
                        Enter your {opt.label} number to process payment
                      </p>
                    </div>
                  )}

                  {/* Keenu redirect note */}
                  {isSelected && opt.id === 'keenu' && (
                    <div className="mt-1.5 mx-1 rounded-lg px-3 py-2"
                      style={{ background: 'rgba(135,197,64,0.06)', border: '1px solid rgba(135,197,64,0.2)' }}>
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
            style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: 'var(--servd-danger)' }}>
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
              objections ("will this work for me / what if it doesn't /
              can I get out") right before the place-order button. Each
              line is fact, not puffery. */}
        <div className="rounded-xl p-3.5" style={{ background: 'rgba(135,197,64,0.04)', border: '1px solid rgba(135,197,64,0.12)' }}>
          <ul className="space-y-1.5 text-xs" style={{ color: 'var(--servd-mute)' }}>
            <li className="flex items-start gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-dark)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-0.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span><strong style={{ color: 'var(--servd-ink)' }}>One clear price.</strong> What you see is what you pay — no surprise fees.</span>
            </li>
            <li className="flex items-start gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-dark)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-0.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span><strong style={{ color: 'var(--servd-ink)' }}>Cancel free</strong> until the kitchen confirms.</span>
            </li>
            <li className="flex items-start gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-dark)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-0.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span><strong style={{ color: 'var(--servd-ink)' }}>Cash on delivery</strong> if you prefer.</span>
            </li>
          </ul>
        </div>
      </div>

      {/* ── Fixed CTA ── */}
      <div className="fixed bottom-0 left-0 right-0 px-4 pt-4 z-40"
        style={{ background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(24px)', borderTop: '1px solid rgba(0,0,0,0.08)', paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <button
          onClick={() => { void handlePlaceOrder() }} disabled={loading}
          className="flex items-center justify-between w-full max-w-lg mx-auto rounded-2xl py-4 px-6 font-black text-base transition-all duration-200 disabled:opacity-40 hover:scale-[1.01] active:scale-[0.98]"
          style={{
            background: loading ? 'var(--servd-line)' : 'var(--servd-green)',
            color: loading ? 'var(--servd-mute)' : '#fff',
            boxShadow: loading ? 'none' : '0 0 32px rgba(61,31,59,0.28)',
          }}>
          <span>{ctaLabel}</span>
          <span>{displayTotal != null ? fmt(displayTotal) : '…'}</span>
        </button>
      </div>
    </div>
  )
}

/* ── Sub-components ── */

function Panel({ icon, label, extra, children }: {
  icon?: string; label: string; extra?: React.ReactNode; children: React.ReactNode
}) {
  // icon prop retained for backward compat but unused — the eyebrow label
  // alone carries the meaning. Skill rule: no emoji as structural icons.
  void icon
  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-black uppercase tracking-[0.22em]"
          style={{ color: 'var(--servd-mute)' }}>{label}</p>
        {extra}
      </div>
      {children}
    </div>
  )
}

function PriceLine({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: 'var(--servd-mute)' }}>{label}</span>
      <span style={{ color: accent ?? 'var(--servd-mute)' }}>{value}</span>
    </div>
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

function ServdInput({ type, value, onChange, placeholder, autoFocus }: {
  type: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string; autoFocus?: boolean
}) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus}
      className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none transition-all placeholder:text-black/25"
      style={{ background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: 'var(--servd-ink)' }}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'var(--servd-green)'
        e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(61,31,59,0.28)'
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = 'rgba(0,0,0,0.1)'
        e.currentTarget.style.boxShadow   = 'none'
      }}
    />
  )
}

function ServdTextarea({ value, onChange, placeholder, rows }: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string; rows?: number
}) {
  return (
    <textarea
      value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none transition-all resize-none placeholder:text-black/25"
      style={{ background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: 'var(--servd-ink)' }}
      onFocus={e => {
        e.currentTarget.style.borderColor = 'var(--servd-green)'
        e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(61,31,59,0.28)'
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = 'rgba(0,0,0,0.1)'
        e.currentTarget.style.boxShadow   = 'none'
      }}
    />
  )
}

function StepBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="h-8 w-8 rounded-xl flex items-center justify-center font-black transition-all active:scale-90"
      style={{ background: 'rgba(0,0,0,0.07)', color: 'var(--servd-mute)', border: '1px solid rgba(0,0,0,0.08)' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-mute)')}>
      {children}
    </button>
  )
}
