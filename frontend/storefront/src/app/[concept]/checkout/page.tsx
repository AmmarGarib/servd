'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCart } from '../../../store/cart'
import { useCustomerAuth } from '../../../store/customerAuth'
import { fmt } from '../../../lib/ui'
import { decodeCartToken } from '../../../lib/cartHandoff'
import { trackCheckoutStarted, trackCheckoutAbandoned, trackOrderPlaced, trackPromoApplied, trackPromoFailed, track, armPurchase } from '../../../lib/analytics'
import DeliveryPin, { type LatLng } from '../../../components/checkout/DeliveryPin'
import { BlockedNotice } from '../../../components/account/BlockedNotice'
import { fulfilmentFor, type FulfilmentOption } from '../../../lib/fulfilment'
import { smoothScrollTo, prefersReducedMotion } from '../../../lib/scroll'

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
  /** GST on the food. */
  itemTaxCents: number
  /** ALL the GST on the bill: the food's (itemTaxCents) plus the delivery
   *  fee's (deliveryFeeTaxCents). The GST row shows this one figure. */
  taxCents: number
  /** The delivery fee BEFORE its GST — the GST is added on top (H9) and is
   *  already inside taxCents. 0 for pickup, curbside and dine-in. */
  deliveryFeeCents: number
  /** The delivery fee's own GST, at the order's tender rate. */
  deliveryFeeTaxCents: number
  serviceChargeCents: number
  pricedTotalCents: number
  promo: { code: string; discountCents: number; description: string } | null
  promoError: { code: string; message: string } | null
  loyaltyPoints: number
  loyaltyDiscountCents: number
  walletCents: number
  tipCents: number
  giftCardCents: number
  // A gift card that can't pay here (unknown, another company's, expired,
  // empty) — ONL-15. Shown under the gift-card field, like a promo error.
  giftCardError?: { code: string; message: string } | null
  totalCents: number
  // The methods checkout accepts right now (ONL-02) — today cash only.
  paymentMethods?: string[]
}

// Pin -> address line. OpenStreetMap Nominatim (the same service the admin
// location picker uses; the map tiles are OSM too). Best effort: on any
// failure the text stays empty and editable.
async function reverseGeocode(p: LatLng): Promise<string | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${p.lat.toFixed(6)}&lon=${p.lng.toFixed(6)}`
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
    if (!res.ok) return null
    const d = await res.json() as { display_name?: string; address?: Record<string, string> }
    const a = d.address ?? {}
    const street = [a['house_number'], a['road'] ?? a['pedestrian'] ?? a['footway']].filter(Boolean).join(' ')
    const area = a['neighbourhood'] ?? a['suburb'] ?? a['quarter'] ?? a['residential']
    const city = a['city'] ?? a['town'] ?? a['village'] ?? a['state_district']
    const line = [street, area, city].filter(Boolean).join(', ') || d.display_name || ''
    return line.slice(0, 200) || null
  } catch { return null }
}

interface CustomerAddress {
  id: string; label: string; address: string; lat?: number | null; lng?: number | null; isDefault: boolean
}

type PaymentMethod = 'cash' | 'card' | 'jazzcash' | 'easypaisa' | 'keenu'

// Which fulfilment modes each brand offers lives in lib/fulfilment.ts — the
// one list the ordering screen reads too.

const FULFILMENT_LABEL: Record<FulfilmentOption, string> = {
  'dine-in':  'Dine in',
  'pickup':   'Pickup',
  'curbside': 'Curbside',
  'delivery': 'Delivery',
}

// Every method the page knows how to show. Only the ones the API lists
// (quote.paymentMethods — GET /storefront/payment-methods) are rendered:
// checkout refuses the rest with 422 PAYMENT_METHOD_UNAVAILABLE until its
// gateway really takes the money (ONL-02). Today that is cash only, so the
// online methods — and their phone field and redirect copy — stay hidden.
const PAYMENT_OPTIONS: Array<{
  id: PaymentMethod
  icon: string
  label: string
  sub: string
}> = [
  // label/sub for cash are replaced per fulfilment by cashCopy() below.
  { id: 'cash',      icon: 'Cash', label: 'Cash',            sub: 'Pay in cash' },
  { id: 'jazzcash',  icon: 'JC',   label: 'JazzCash Wallet', sub: 'Pay with JazzCash' },
  { id: 'easypaisa', icon: 'EP',   label: 'EasyPaisa',       sub: 'Pay with EasyPaisa' },
  { id: 'keenu',     icon: 'Card', label: 'Card (Keenu)',    sub: 'Pay by card' },
]

// The cash option is named for how the order reaches the customer — only a
// delivery is "cash on delivery". Copy only; the gateway is 'cash' either way.
function cashCopy(f: FulfilmentOption): { label: string; sub: string } {
  switch (f) {
    case 'delivery': return { label: 'Cash on delivery',   sub: 'Pay the rider when your order arrives' }
    case 'pickup':   return { label: 'Pay cash at pickup', sub: 'Pay at the counter when you collect' }
    case 'curbside': return { label: 'Pay cash at pickup', sub: 'Pay when we bring your order to your car' }
    case 'dine-in':  return { label: 'Pay at the counter', sub: 'Settle up in cash at the counter' }
  }
}

// Quote errors that are about WHERE the order is going — shown by the map,
// not just in the totals box.
const DELIVERY_AREA_ERRORS = new Set(['DELIVERY_UNAVAILABLE', 'OUTSIDE_DELIVERY_AREA', 'BELOW_ZONE_MINIMUM'])

export default function CheckoutPage() {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  // The page prices NOTHING itself: every figure on it — GST (by tender,
  // decision 9), delivery fee, service charge, promo, points, wallet, tip,
  // gift card, total — comes from GET /storefront/quote, which prices with
  // the same server function checkout charges with (lib/pricing.ts). It used
  // to hardcode 15% / 8% here while the server always charged 8%.
  const { items, subtotalCents, itemCount, clearCart, hydrateFromReorder, conceptSlug: cartSlug } = useCart()
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
    // A ?cart= hand-off is loaded into the basket first (the effect below),
    // which then sends a signed-out visitor on to sign in.
    if (!token && !searchParams?.get('cart')) {
      const next = encodeURIComponent(`/${slug}/checkout`)
      router.replace(`/login?next=${next}`)
    }
  }, [token, slug, router, searchParams])

  // The basket belongs to one kitchen (the ordering screen can keep another
  // kitchen's basket when the customer chooses to). Checking it out under a
  // different brand's URL would send that kitchen's items to this one, so go
  // to the basket's own checkout. Not while a ?cart= hand-off is pending: that
  // effect below replaces the basket first.
  useEffect(() => {
    if (searchParams?.get('cart')) return
    // A plain slug only: the basket's slug can arrive in a ?cart= link, and
    // '/evil.example' would make this an open redirect.
    if (cartSlug && /^[a-z0-9-]+$/.test(cartSlug) && cartSlug !== slug && items.length > 0) {
      router.replace(`/${cartSlug}/checkout`)
    }
  }, [cartSlug, slug, items.length, searchParams, router])

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
    // The basket is kept; a signed-out visitor signs in and returns here.
    router.replace(
      token ? `/${slug}/checkout` : `/login?next=${encodeURIComponent(`/${slug}/checkout`)}`,
      { scroll: false },
    )
  }, [searchParams, slug, router, hydrateFromReorder, token])

  const [name,  setName]  = useState('')
  const [phone, setPhone] = useState('')
  const [notes,   setNotes]   = useState('')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  // A BANNED answer (quote or place order): the cart stays, and with appeals on
  // BlockedNotice shows the account-wide block + appeal form (renders nothing
  // while appeals are off, so today's BANNED message is all there is).
  const [banned,  setBanned]  = useState(false)

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
  // (whatever option appears first in fulfilmentFor(slug)).
  const allowedFulfilment = fulfilmentFor(slug)
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

  // Tip the rider — preset chips + custom amount. Cents. Starts at "No tip":
  // a tip is the customer's choice, never pre-selected for them.
  const [tipMode,   setTipMode]   = useState<'none' | '5' | '10' | '15' | '20' | 'custom'>('none')
  const [customTip, setCustomTip] = useState('')
  const [giftCard,  setGiftCard]  = useState('')
  const _orderPlaced = useRef(false)
  // Re-entry guard: Enter held down or a double tap must never place two orders.
  const placingRef = useRef(false)
  // Which field the last failed submit blamed (aria-invalid + a message right
  // under it). The banner above the button stays as the summary.
  const [fieldErr, setFieldErr] = useState<{ address?: string; table?: string; giftCard?: string }>({})
  const clearFieldErr = (k: 'address' | 'table' | 'giftCard') =>
    setFieldErr((f) => (f[k] ? { ...f, [k]: undefined } : f))
  // The order list animates in once, not every time it re-renders.
  const [animateList, setAnimateList] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setAnimateList(false), 900)
    return () => clearTimeout(t)
  }, [])
  // On a phone the on-screen keyboard pushes a fixed bar over the field being
  // typed in: hide the Place Order bar while a text field has focus. (Enter
  // still submits — the button stays in the form.)
  const [fieldFocused, setFieldFocused] = useState(false)
  useEffect(() => {
    const small = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches
    const isField = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') &&
      !['checkbox', 'radio', 'button', 'submit'].includes((t as HTMLInputElement).type)
    const onIn = (e: FocusEvent) => { if (small() && isField(e.target)) setFieldFocused(true) }
    const onOut = () => setFieldFocused(false)
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    const vv = window.visualViewport
    // A keyboard that closes without a blur (Android back) shows the bar again.
    const onVv = () => { if (vv && vv.height >= window.innerHeight - 80) setFieldFocused(false) }
    vv?.addEventListener('resize', onVv)
    return () => {
      document.removeEventListener('focusin', onIn)
      document.removeEventListener('focusout', onOut)
      vv?.removeEventListener('resize', onVv)
    }
  }, [])

  // Payment method — only what the API accepts (starts as cash, the one
  // method always offered).
  const [paymentMethod,  setPaymentMethod]  = useState<PaymentMethod>('cash')
  const [availableMethods, setAvailableMethods] = useState<string[]>(['cash'])
  const [paymentNotice, setPaymentNotice] = useState('')

  // Gift card: Check sends the code to the quote, which says whether it can
  // pay here (this brand's company, active, not expired, has balance).
  const [giftCardStatus,  setGiftCardStatus]  = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle')
  const [giftCardBalance, setGiftCardBalance] = useState(0)
  const [appliedGiftCard, setAppliedGiftCard] = useState('')
  const [giftCardMessage, setGiftCardMessage] = useState('')

  // Placed, but the response carries something the customer must read
  // (a gift card that could not be applied) — shown before the tracker.
  const [placedNotice, setPlacedNotice] = useState<{ orderId: string; message: string } | null>(null)

  useEffect(() => {
    if (!token) return
    Promise.all([
      // ?conceptSlug: the points shown are this brand's company's (loyalty is
      // per company — points from another company can't be spent here).
      fetch(`${API_URL}/api/v1/storefront/account?conceptSlug=${encodeURIComponent(slug)}`, {
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
  }, [token, slug])

  // Delivery drop point. The server needs coordinates for the zone fee and
  // the rider, and refuses delivery without them (DELIVERY_LOCATION_REQUIRED).
  // They come from the map pin the customer sets in THIS checkout (keyed
  // 'new' for a typed address, or by saved-address id), else from the chosen
  // saved address's stored pin. A saved address without a pin shows the map,
  // and the pin is saved back to it.
  const selectedAddress = savedAddresses.find((a) => a.id === selectedAddressId && !showNewAddressInput) ?? null
  const usingNewAddress = showNewAddressInput || savedAddresses.length === 0
  const pinKey = usingNewAddress ? 'new' : selectedAddress?.id ?? null
  const [pins, setPins] = useState<Record<string, LatLng>>({})
  const sessionPin = pinKey ? pins[pinKey] ?? null : null
  const savedPin: LatLng | null = !usingNewAddress && selectedAddress?.lat != null && selectedAddress?.lng != null
    ? { lat: selectedAddress.lat, lng: selectedAddress.lng }
    : null
  const deliveryPin = sessionPin ?? savedPin
  const deliveryLat = deliveryPin?.lat ?? null
  const deliveryLng = deliveryPin?.lng ?? null
  // The map shows for a typed address, for a saved address with no pin, and
  // for one whose pin the customer chose to move (it then stays open).
  const showPinMap = fulfilmentType === 'delivery' && pinKey != null && (usingNewAddress || !savedPin || sessionPin != null)
  // Set when "Place order" was pressed with no pin — the map then says why.
  const [pinPrompt, setPinPrompt] = useState(false)
  const pinBlockRef = useRef<HTMLDivElement | null>(null)
  // UX-3: the pin comes first and the address text fills in from it. A line
  // the customer typed or edited is never overwritten by a later pin move.
  const addressEditedRef = useRef(false)
  const geocodeSeq = useRef(0)
  const [addressFilling, setAddressFilling] = useState(false)
  const setPin = (v: LatLng) => {
    if (!pinKey) return
    setPins((p) => ({ ...p, [pinKey]: v }))
    setPinPrompt(false)
    if (pinKey === 'new' && !(addressEditedRef.current && deliveryAddress.trim())) {
      const seq = ++geocodeSeq.current
      setAddressFilling(true)
      void reverseGeocode(v).then((line) => {
        if (seq !== geocodeSeq.current) return
        setAddressFilling(false)
        if (line && !(addressEditedRef.current && deliveryAddress.trim())) {
          addressEditedRef.current = false
          setDeliveryAddress(line)
          clearFieldErr('address')
        }
      })
    }
  }

  // Open the map on the kitchen when we know where it is (else Karachi).
  const [kitchen, setKitchen] = useState<LatLng | null>(null)
  const kitchenLoaded = useRef(false)
  useEffect(() => {
    if (fulfilmentType !== 'delivery' || kitchenLoaded.current) return
    kitchenLoaded.current = true
    fetch(`${API_URL}/api/v1/storefront/concepts`)
      .then((r) => (r.ok ? r.json() as Promise<Array<{ slug: string; latitude?: number | null; longitude?: number | null }>> : null))
      .then((all) => {
        const c = Array.isArray(all) ? all.find((x) => x.slug === slug) : undefined
        if (c?.latitude != null && c?.longitude != null) setKitchen({ lat: c.latitude, lng: c.longitude })
      })
      .catch(() => {})
  }, [fulfilmentType, slug])

  // A pin dropped for a SAVED address is saved back to it (debounced, so
  // dragging the pin around doesn't fire a request per move).
  const [pinSavedFor, setPinSavedFor] = useState<string | null>(null)
  const savePinFor = !usingNewAddress && selectedAddress && sessionPin ? selectedAddress.id : null
  useEffect(() => {
    if (!token || !savePinFor || !sessionPin) return
    const addr = savedAddresses.find((a) => a.id === savePinFor)
    if (addr && addr.lat === sessionPin.lat && addr.lng === sessionPin.lng) return
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/addresses/${encodeURIComponent(savePinFor)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lat: sessionPin.lat, lng: sessionPin.lng }),
      })
        .then((r) => {
          if (!r.ok) return
          setSavedAddresses((list) => list.map((a) => (a.id === savePinFor ? { ...a, lat: sessionPin.lat, lng: sessionPin.lng } : a)))
          setPinSavedFor(savePinFor)
        })
        .catch(() => {})
    }, 800)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, savePinFor, sessionPin?.lat, sessionPin?.lng])

  // Server quote — refreshed whenever anything that changes the bill does.
  const [quote,      setQuote]      = useState<Quote | null>(null)
  const [quoteError, setQuoteError] = useState('')
  const [quoteErrorCode, setQuoteErrorCode] = useState('')
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
      ...(appliedGiftCard && { giftCardCode: appliedGiftCard }),
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
            const err = (data as { error?: { code?: string; message?: string; details?: { available?: string[] } } })?.error
            // A method checkout can't charge: back to cash, and say why.
            if (err?.code === 'PAYMENT_METHOD_UNAVAILABLE' && paymentMethod !== 'cash') {
              setAvailableMethods(err.details?.available?.length ? err.details.available : ['cash'])
              setPaymentMethod('cash')
              setPaymentNotice(err.message ?? 'That payment method isn’t available. Please pay with cash.')
              return
            }
            if (err?.code === 'BANNED') setBanned(true)
            setQuote(null)
            setQuoteError(err?.message ?? 'Could not price your order')
            setQuoteErrorCode(err?.code ?? '')
            return
          }
          const q = data as Quote
          setQuote(q)
          setQuoteError('')
          setQuoteErrorCode('')
          if (Array.isArray(q.paymentMethods) && q.paymentMethods.length > 0) {
            setAvailableMethods(q.paymentMethods)
            if (!q.paymentMethods.includes(paymentMethod)) setPaymentMethod('cash')
          }
          if (appliedPromo) {
            if (q.promo) { setPromoStatus('valid'); setPromoMessage(q.promo.description) }
            else { setPromoStatus('invalid'); setPromoMessage(q.promoError?.message ?? 'Promo code is invalid') }
          }
          if (appliedGiftCard) {
            if (q.giftCardError) { setGiftCardStatus('invalid'); setGiftCardMessage(q.giftCardError.message) }
            else { setGiftCardStatus('valid'); setGiftCardMessage('') }
          }
        })
        .catch((e: unknown) => {
          if ((e as { name?: string })?.name === 'AbortError') return
          setQuoteError('Could not price your order. Check your connection.')
          setQuoteErrorCode('')
        })
    }, 250)
    return () => { clearTimeout(t); ctrl.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basketKey, slug, fulfilmentType, paymentMethod, deliveryLat, deliveryLng, appliedPromo, loyaltyPts, useWallet, appliedGiftCard, tipKey, token])

  useEffect(() => {
    if (items.length > 0) {
      trackCheckoutStarted(slug, items.length, subtotalCents())
      // GA4 begin_checkout (no-op without GA4 + consent).
      track('begin_checkout', { currency: 'PKR', value: subtotalCents() / 100, item_brand: slug, items: items.length })
    }
    return () => {
      if (!_orderPlaced.current) {
        trackCheckoutAbandoned(slug, 'checkout')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (placedNotice) return (
    <div className={`flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center${brandSkinClass ? ' ' + brandSkinClass : ''}`}
      style={{ background: 'transparent' }}>
      <p className="font-black text-2xl tracking-tight" style={{ color: 'var(--servd-ink)' }}>Your order is placed.</p>
      <p role="alert" className="text-sm max-w-sm" style={{ color: 'var(--servd-danger)' }}>{placedNotice.message}</p>
      <Link href={`/${slug}/order/${placedNotice.orderId}`}
        className="rounded-2xl font-black px-8 py-4 text-sm"
        style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}>
        Track your order
      </Link>
    </div>
  )

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
              className="rounded-xl px-4 py-2 text-xs font-bold transition-colors"
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

  // Delivery: no pin yet, or the pin is somewhere we can't deliver to.
  const needsPin = fulfilmentType === 'delivery' && (deliveryLat == null || deliveryLng == null)
  const deliveryAreaError = fulfilmentType === 'delivery' && !needsPin && DELIVERY_AREA_ERRORS.has(quoteErrorCode)
    ? quoteError
    : ''
  const pinMessage = needsPin && pinPrompt
    ? 'Drop a pin on the map, or tap “Use my current location”, so your rider can find you.'
    : deliveryAreaError || null
  const cash = cashCopy(fulfilmentType)
  // The brand is closed for this order's time (409 BRAND_CLOSED, ONL-14):
  // the quote says when it opens, and the order can't be placed.
  const brandClosed = quoteErrorCode === 'BRAND_CLOSED'
  const shownMethods = PAYMENT_OPTIONS.filter((o) => availableMethods.includes(o.id))

  // Apply = ask the quote to price the code (same evaluation as checkout).
  const applyPromo = () => {
    const code = promoCode.trim().toUpperCase()
    if (!code) return
    setPromoStatus('checking')
    setPromoMessage('')
    setAppliedPromo(code)
  }

  const clearPromo = () => {
    setPromoCode('')
    setPromoStatus('idle')
    setAppliedPromo('')
    setPromoMessage('')
  }
  const clearGiftCard = () => {
    setGiftCard('')
    setGiftCardStatus('idle')
    setGiftCardBalance(0)
    setGiftCardMessage('')
    setAppliedGiftCard('')
    clearFieldErr('giftCard')
  }
  // Enter in the promo / gift-card box applies it and never places the order.
  const applyOnEnter = (apply: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    e.preventDefault()
    apply()
  }

  // Say which field a failed submit is about: message under it, aria-invalid,
  // focus and scroll to it. The banner keeps the same text as a summary.
  const failField = (k: 'address' | 'table' | 'giftCard', id: string, msg: string) => {
    setFieldErr((f) => ({ ...f, [k]: msg }))
    setError(msg)
    const el = document.getElementById(id)
    if (el) {
      smoothScrollTo(el, { block: 'center' })
      ;(el as HTMLElement).focus({ preventScroll: true })
    } else {
      smoothScrollTo(pinBlockRef.current, { block: 'center' })
    }
  }

  // Check = ask the quote whether this card pays HERE (the same check
  // checkout makes). The balance lookup is only for showing the balance.
  const checkGiftCardBalance = async () => {
    const code = giftCard.trim().toUpperCase()
    if (!code) return
    setGiftCardStatus('checking')
    setGiftCardMessage('')
    setGiftCardBalance(0)
    setAppliedGiftCard(code)
    try {
      const res = await fetch(`${API_URL}/api/v1/gift-cards/balance/${encodeURIComponent(code)}`)
      if (res.ok) {
        const data = await res.json() as { balanceCents?: number }
        setGiftCardBalance(data.balanceCents ?? 0)
      }
    } catch { /* the quote decides */ }
  }

  const handlePlaceOrder = async () => {
    setError('')
    setFieldErr({})
    if (fulfilmentType === 'delivery' && !deliveryAddress.trim()) {
      failField('address', 'co-address', 'Please enter your delivery address')
      return
    }
    // No pin → the server can't price or dispatch the delivery. Say so by
    // the map (and bring it into view) instead of letting the order bounce.
    if (fulfilmentType === 'delivery' && (deliveryLat == null || deliveryLng == null)) {
      setPinPrompt(true)
      smoothScrollTo(pinBlockRef.current, { block: 'center' })
      return
    }
    if (fulfilmentType === 'delivery' && deliveryAreaError) {
      setError(deliveryAreaError)
      smoothScrollTo(pinBlockRef.current, { block: 'center' })
      return
    }
    if (fulfilmentType === 'dine-in' && !tableLabel.trim()) {
      failField('table', 'co-table', 'Please enter your table number (printed on the QR card at your seat).')
      return
    }
    if (brandClosed) {
      setError(quoteError)
      return
    }
    if (appliedGiftCard && giftCardStatus === 'invalid') {
      failField('giftCard', 'co-gift', giftCardMessage || 'That gift card can’t be used here. Remove it to continue.')
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
            tipCents,
            // Only a card the quote accepted — checkout refuses an unusable
            // one with 422 before anything is created (ONL-15).
            giftCardCode: (giftCardStatus === 'valid' && appliedGiftCard) || undefined,
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
          const d = await res.json() as { error?: { code?: string; message?: string; details?: { available?: string[] } } }
          if (d?.error?.code === 'PAYMENT_METHOD_UNAVAILABLE') {
            setAvailableMethods(d.error.details?.available?.length ? d.error.details.available : ['cash'])
            setPaymentMethod('cash')
          }
          if (d?.error?.code === 'BRAND_CLOSED') {
            setQuote(null)
            setQuoteError(d.error.message ?? 'This kitchen is closed right now.')
            setQuoteErrorCode('BRAND_CLOSED')
          }
          if (d?.error?.code === 'BANNED') setBanned(true)
          throw new Error(d?.error?.message ?? 'Failed to place order')
        }
        const order = await res.json() as { id: string; totalCents?: number; giftCardError?: { message?: string } | null }
        if (appliedPromo) trackPromoApplied(appliedPromo, slug, promoDiscountCents)
        _orderPlaced.current = true
        trackOrderPlaced(order.id, slug, order.totalCents ?? displayTotal ?? 0, paymentMethod)
        armPurchase(order.id) // the tracker page fires GA4 `purchase` once for this order
        clearCart()
        if (order.giftCardError?.message) {
          // Placed at full price — the customer must see why before the tracker.
          setPlacedNotice({ orderId: order.id, message: order.giftCardError.message })
          return
        }
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

  // The one submit path (Place Order button, Enter in a name / address field).
  // The ref makes a second submit in the same tick a no-op.
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    // A submit from a form nested in this one (none today) is not ours.
    if (e.target !== e.currentTarget) return
    if (placingRef.current || _orderPlaced.current || loading) return
    placingRef.current = true
    void handlePlaceOrder().finally(() => { placingRef.current = false })
  }

  // CTA label that reflects payment method
  // (Delivery without a pin can't be placed yet — the button says what's missing.)
  const ctaLabel = loading
    ? 'Placing order…'
    : needsPin
      ? 'Set your delivery pin'
      : brandClosed
        ? 'Closed right now'
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

      <form id="checkout" noValidate onSubmit={onSubmit}>
      <div className="relative z-10 max-w-lg mx-auto px-4 py-5 space-y-3">

        {/* ── Order summary ── */}
        <Panel label="Your Order">
          <div className="space-y-3 mb-4">
            {items.map((item, i) => (
              <div key={item.lineId} className="flex items-start justify-between gap-3"
                style={animateList && !prefersReducedMotion() ? { animation: `revealUp 0.4s ${i * 0.05}s both` } : undefined}>
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
              lib/fulfilment.ts. When the brand offers only
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
                  id="co-table" name="tableLabel"
                  value={tableLabel} onChange={(e) => { setTableLabel(e.target.value); clearFieldErr('table') }}
                  placeholder="Table number"
                  aria-label="Table number"
                  aria-invalid={fieldErr.table ? true : undefined}
                  aria-describedby={fieldErr.table ? 'co-table-err' : undefined}
                  maxLength={20}
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="servd-field w-full rounded-lg px-3 py-2 text-sm uppercase tracking-wider"
                  style={{ background: '#fff', border: `1px solid ${fieldErr.table ? 'var(--servd-danger)' : 'rgba(0,0,0,0.08)'}` }}
                />
                {fieldErr.table && (
                  <p id="co-table-err" role="alert" className="text-xs font-semibold" style={{ color: 'var(--servd-danger)' }}>{fieldErr.table}</p>
                )}
              </div>
            )}
            {fulfilmentType === 'curbside' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                  Tell us about your car so we can find you. Tap &ldquo;I&rsquo;m here&rdquo; on the order page when you arrive.
                </p>
                <input
                  id="co-vehicle" name="vehicle" aria-label="Vehicle"
                  value={curbsideVehicle} onChange={(e) => setCurbsideVehicle(e.target.value)}
                  placeholder="e.g. Blue Honda Civic"
                  maxLength={80}
                  autoComplete="off"
                  className="servd-field w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }} />
                <input
                  id="co-plate" name="plate" aria-label="License plate (optional)"
                  value={curbsidePlate} onChange={(e) => setCurbsidePlate(e.target.value)}
                  placeholder="License plate (optional)"
                  maxLength={20}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  className="servd-field w-full rounded-lg px-3 py-2 text-sm"
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
                        addressEditedRef.current = false; setDeliveryAddress('')
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

                {/* The drop point. The address text tells the rider which
                    door; the pin tells the kitchen which zone and the rider
                    where to drive — the order can't go without it. */}
                <div ref={pinBlockRef} className="scroll-mt-24">
                  {showPinMap ? (
                    <>
                      {!usingNewAddress && selectedAddress && !savedPin && (
                        <p className="text-[11px] mb-1.5" style={{ color: 'var(--servd-mute)' }}>
                          &ldquo;{selectedAddress.label}&rdquo; has no map pin yet. Set it once and we&rsquo;ll remember it.
                        </p>
                      )}
                      <DeliveryPin
                        key={pinKey ?? 'none'}
                        value={deliveryPin}
                        onChange={setPin}
                        center={kitchen}
                        label={usingNewAddress ? 'Delivery location' : `Delivery location for ${selectedAddress?.label ?? 'this address'}`}
                        message={pinMessage}
                      />
                      {!usingNewAddress && selectedAddress && pinSavedFor === selectedAddress.id && (
                        <p className="text-[11px] mt-1" style={{ color: 'var(--servd-mute)' }} aria-live="polite">
                          Saved to &ldquo;{selectedAddress.label}&rdquo; for next time.
                        </p>
                      )}
                    </>
                  ) : savedPin && selectedAddress ? (
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-[11px]" style={{ color: 'var(--servd-mute)' }}>
                        Delivering to the pin saved for &ldquo;{selectedAddress.label}&rdquo;.
                      </p>
                      <button type="button" onClick={() => setPin(savedPin)}
                        className="text-[11px] font-bold underline underline-offset-2"
                        style={{ color: 'var(--servd-green-dark)' }}>
                        Move pin
                      </button>
                      {deliveryAreaError && (
                        <p role="alert" className="w-full text-xs font-semibold" style={{ color: 'var(--servd-danger)' }}>
                          {deliveryAreaError}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* The address text comes AFTER the pin: it fills in from the pin
                    (reverse geocode) and stays editable. */}
                {usingNewAddress && (
                  <>
                    <input
                      id="co-address" name="address"
                      value={deliveryAddress} onChange={(e) => { addressEditedRef.current = true; setDeliveryAddress(e.target.value); clearFieldErr('address') }}
                      placeholder={addressFilling ? 'Finding the address from your pin…' : 'Full delivery address (filled from your pin, edit if needed)'}
                      aria-label="Delivery address"
                      aria-invalid={fieldErr.address ? true : undefined}
                      aria-describedby={fieldErr.address ? 'co-address-err' : undefined}
                      autoComplete="street-address"
                      maxLength={200}
                      className="servd-field w-full rounded-lg px-3 py-2 text-sm"
                      style={{ background: '#fff', border: `1px solid ${fieldErr.address ? 'var(--servd-danger)' : 'rgba(0,0,0,0.08)'}` }} />
                    {fieldErr.address && (
                      <p id="co-address-err" role="alert" className="text-xs font-semibold" style={{ color: 'var(--servd-danger)' }}>{fieldErr.address}</p>
                    )}
                  </>
                )}

                <input
                  id="co-delivery-notes" name="deliveryNotes" aria-label="Delivery notes (optional)"
                  value={deliveryNotes} onChange={(e) => setDeliveryNotes(e.target.value)}
                  placeholder="Gate code, floor, landmark… (optional)"
                  maxLength={120}
                  autoComplete="off"
                  className="servd-field w-full rounded-lg px-3 py-2 text-sm"
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
                  type="button"
                  onClick={() => setTipMode(m)}
                  aria-pressed={tipMode === m}
                  className="px-3 py-1.5 rounded-xl text-xs font-bold border"
                  style={{
                    minHeight: 44, minWidth: 44,
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
                id="co-tip" name="tip" aria-label="Tip amount in PKR"
                type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
                value={customTip}
                onChange={(e) => {
                  // Whole rupees only, capped at PKR 100,000.
                  const digits = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 6)
                  setCustomTip(digits !== '' && Number(digits) > 100000 ? '100000' : digits)
                }}
                placeholder="Tip amount (PKR)"
                className="servd-field w-full text-sm rounded-lg px-3 py-1.5 border"
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
            <label htmlFor="co-gift" className="text-xs font-bold tracking-wider uppercase text-[color:var(--servd-mute)] block mb-2">Gift card</label>
            <div className="flex gap-2">
              <input
                id="co-gift" name="giftCard"
                value={giftCard}
                autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
                aria-invalid={giftCardStatus === 'invalid' || fieldErr.giftCard ? true : undefined}
                aria-describedby={giftCardStatus === 'invalid' ? 'co-gift-msg' : undefined}
                onKeyDown={applyOnEnter(() => { if (giftCard.trim() && giftCardStatus !== 'checking' && giftCardStatus !== 'valid') void checkGiftCardBalance() })}
                onChange={(e) => {
                  clearFieldErr('giftCard')
                  setGiftCard(e.target.value.toUpperCase())
                  // Editing the code takes it off the bill until checked again.
                  if (giftCardStatus !== 'idle' || appliedGiftCard) {
                    setGiftCardStatus('idle')
                    setGiftCardBalance(0)
                    setGiftCardMessage('')
                    setAppliedGiftCard('')
                  }
                }}
                placeholder="GS-XXXX-XXXX"
                className="servd-field flex-1 text-sm rounded-lg px-3 py-1.5 border font-mono uppercase tracking-wider"
                style={{ borderColor: 'rgba(0,0,0,0.1)' }}
              />
              <button
                type="button"
                onClick={() => { if (giftCardStatus === 'valid') clearGiftCard(); else void checkGiftCardBalance() }}
                disabled={giftCardStatus === 'checking' || (giftCardStatus !== 'valid' && !giftCard.trim())}
                aria-label={giftCardStatus === 'valid' ? 'Remove gift card' : 'Check gift card'}
                className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-black transition-all disabled:opacity-40"

                style={{
                  minHeight: 44,
                  background: giftCardStatus === 'valid' ? 'var(--servd-green-dark)' : 'rgba(0,0,0,0.07)',
                  color: giftCardStatus === 'valid' ? 'var(--servd-on-green)' : 'var(--servd-ink)',
                  border: '1px solid rgba(0,0,0,0.08)',
                }}>
                {giftCardStatus === 'checking' ? '…' : giftCardStatus === 'valid' ? 'Remove' : 'Check'}
              </button>
            </div>
            {giftCardStatus === 'valid' && (
              <p className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-green-dark)' }}>
                {giftCardBalance > 0 ? `Balance: ${fmt(giftCardBalance)}` : 'Gift card applied'}
                {giftCardDeduction > 0 && ` · saving ${fmt(giftCardDeduction)} on this order`}
              </p>
            )}
            {giftCardStatus === 'invalid' && (
              <p id="co-gift-msg" className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-danger)' }} role="alert">
                {giftCardMessage || 'This gift card can’t be used here'}{' '}
                <button type="button" onClick={clearGiftCard} className="underline underline-offset-2 font-black">Remove</button>
              </p>
            )}
          </div>

          <div className="rounded-xl p-3.5 space-y-2"
            style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <PriceLine label="Subtotal"    value={quote ? fmt(quote.itemTotalCents) : '…'} />
            {/* One GST row: all the GST the server charged — the food's AND the
                delivery fee's — with the delivery share named. The figures are
                the server's; nothing is worked out here. */}
            <PriceLine
              label={quote ? `GST (${quote.taxRatePct}%)` : 'GST'}
              value={quote ? fmt(quote.taxCents) : '…'}
              note={quote && (quote.deliveryFeeTaxCents ?? 0) > 0
                ? `incl. ${fmt(quote.deliveryFeeTaxCents)} on delivery`
                : undefined}
            />
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
              <p className="text-xs pt-1" style={{ color: brandClosed ? 'var(--servd-danger)' : 'var(--servd-mute)' }} role="status">
                {needsPin && quoteErrorCode === 'DELIVERY_LOCATION_REQUIRED'
                  ? 'Set your delivery pin above to see the delivery fee and total.'
                  : deliveryAreaError
                    ? 'Delivery isn’t available for this order yet — see the delivery details above.'
                    : quoteError}
              </p>
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
                    id="co-promo" name="promo" ariaLabel="Promo code"
                    autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="go"
                    ariaInvalid={promoStatus === 'invalid'}
                    ariaDescribedBy={promoStatus === 'invalid' ? 'co-promo-msg' : undefined}
                    onKeyDown={applyOnEnter(() => { if (promoCode.trim() && promoStatus !== 'checking' && promoStatus !== 'valid') applyPromo() })}
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
                  onClick={() => { if (promoStatus === 'valid') clearPromo(); else applyPromo() }}
                  disabled={promoStatus === 'checking' || (promoStatus !== 'valid' && !promoCode.trim())}
                  aria-label={promoStatus === 'valid' ? 'Remove promo code' : 'Apply promo code'}
                  className="shrink-0 rounded-xl px-4 py-3 text-sm font-black transition-all disabled:opacity-40"
                  style={{ background: 'var(--servd-green)', color: 'var(--servd-on-green)' }}
                >
                  {promoStatus === 'checking' ? '…' : promoStatus === 'valid' ? 'Remove' : 'Apply'}
                </button>
              </div>
              {promoStatus === 'valid' && promoMessage && (
                <p role="status" className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-green-dark)' }}>
                  ✓ {promoMessage} · saving {fmt(promoDiscountCents)}
                </p>
              )}
              {promoStatus === 'invalid' && promoMessage && (
                <p id="co-promo-msg" role="alert" className="text-xs font-semibold mt-1.5" style={{ color: 'var(--servd-danger)' }}>
                  {promoMessage}{' '}
                  <button type="button" onClick={clearPromo} className="underline underline-offset-2 font-black">Remove</button>
                </p>
              )}
            </Panel>

            {/* Wallet toggle */}
            {walletBalance > 0 && (
              <button
                type="button"
                role="switch"
                aria-checked={useWallet}
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
                    <StepBtn label="Decrease points" onClick={() => setLoyaltyPts(p => (p - 10 < Math.max(minRedeemPts, 1) ? 0 : p - 10))}>−</StepBtn>
                    <span className="font-black text-sm w-10 text-center" style={{ color: 'var(--servd-ink)' }}>{loyaltyPts}</span>
                    <StepBtn label="Increase points" onClick={() => setLoyaltyPts(p => Math.min(loyaltyBalance, p === 0 ? Math.max(minRedeemPts, 10) : p + 10))}>+</StepBtn>
                  </div>
                </div>
              </Panel>
            )}

            {/* Notes */}
            <Panel icon="" label="Special Instructions for Kitchen">
              <ServdTextarea id="co-notes" name="notes" ariaLabel="Special instructions for the kitchen" value={notes} onChange={e => setNotes(e.target.value)}
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
              <FormField label="Name *" htmlFor="co-name">
                <ServdInput id="co-name" name="name" autoComplete="name" type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your name" autoFocus />
              </FormField>
              <FormField label="Phone (optional)" htmlFor="co-phone">
                <ServdInput id="co-phone" name="phone" autoComplete="tel" inputMode="tel" type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="03xx-xxxxxxx" />
              </FormField>
              <FormField label="Special instructions (optional)" htmlFor="co-guest-notes">
                <ServdTextarea id="co-guest-notes" name="notes" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Allergies, preferences…" rows={2} />
              </FormField>
            </div>
          </Panel>
        )}

        {/* ── Payment Method ── */}
        <Panel icon="" label="Payment Method">
          <div className="space-y-2">
            {paymentNotice && (
              <p className="text-xs font-semibold" role="status" style={{ color: 'var(--servd-danger)' }}>{paymentNotice}</p>
            )}
            {shownMethods.map((base) => {
              const opt = base.id === 'cash' ? { ...base, ...cash } : base
              const isSelected = paymentMethod === opt.id
              return (
                <div key={opt.id}>
                  <button
                    type="button"
                    onClick={() => { setPaymentMethod(opt.id); setPaymentNotice('') }}
                    className="w-full flex items-center gap-3 rounded-xl px-3.5 py-3 transition-all"
                    style={isSelected
                      ? { background: 'rgba(135,197,64,0.06)', border: '1.5px solid rgba(135,197,64,0.35)' }
                      : { background: 'rgba(0,0,0,0.025)', border: '1px solid rgba(0,0,0,0.07)' }}>
                    <span className="text-lg shrink-0">{opt.icon}</span>
                    <div className="flex-1 text-left min-w-0">
                      <p className="font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>{opt.label}</p>
                      <p className="text-[11px] mt-0.5" style={{ color: 'var(--servd-mute)' }}>{opt.sub}</p>
                    </div>
                    <div className="h-5 w-5 rounded-full shrink-0 flex items-center justify-center"
                      style={isSelected
                        ? { background: 'rgba(135,197,64,0.12)', border: '1.5px solid rgba(135,197,64,0.45)' }
                        : { background: 'transparent', border: '1.5px solid rgba(0,0,0,0.15)' }}>
                      {isSelected && <div className="h-2 w-2 rounded-full" style={{ background: 'var(--servd-green-dark)' }} />}
                    </div>
                  </button>

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
              <span><strong style={{ color: 'var(--servd-ink)' }}>{cash.label}</strong> if you prefer.</span>
            </li>
          </ul>
        </div>
      </div>
      </form>
      {/* Outside the form: BlockedNotice has a form of its own. */}
      {banned && (
        <div className="relative z-10 max-w-lg mx-auto px-4 pb-5">
          <BlockedNotice conceptSlug={slug} />
        </div>
      )}

      {/* ── Fixed CTA ── */}
      <div className="fixed bottom-0 left-0 right-0 px-4 pt-4 z-40"
        aria-hidden={fieldFocused ? true : undefined}
        style={{ ...(fieldFocused && { visibility: 'hidden', transform: 'translateY(100%)' }), background: 'rgba(255,255,255,0.96)', backdropFilter: 'blur(24px)', borderTop: '1px solid rgba(0,0,0,0.08)', paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        <button
          type="submit" form="checkout" disabled={loading || brandClosed}
          className="flex items-center justify-between w-full max-w-lg mx-auto rounded-2xl py-4 px-6 font-black text-base transition-all duration-200 disabled:opacity-40 hover:scale-[1.01] active:scale-[0.98]"
          style={{
            background: loading || brandClosed ? 'var(--servd-line)' : 'var(--servd-green)',
            color: loading || brandClosed ? 'var(--servd-mute)' : 'var(--servd-on-green)',
            boxShadow: loading || brandClosed ? 'none' : '0 0 32px rgba(61,31,59,0.28)',
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

function PriceLine({ label, value, accent, note }: { label: string; value: string; accent?: string; note?: string }) {
  return (
    <div className="flex justify-between items-start gap-3 text-sm">
      <span style={{ color: 'var(--servd-mute)' }}>
        {label}
        {note && <span className="block text-xs">{note}</span>}
      </span>
      <span className="shrink-0" style={{ color: accent ?? 'var(--servd-mute)' }}>{value}</span>
    </div>
  )
}

function FormField({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
        style={{ color: 'var(--servd-mute)' }}>{label}</label>
      {children}
    </div>
  )
}

// Focus ring comes from the shared .servd-field rule (:focus-visible), not
// from JS handlers, so keyboard users get it on every field.
function ServdInput({
  type, value, onChange, placeholder, autoFocus, id, name, autoComplete, inputMode, autoCapitalize,
  spellCheck, enterKeyHint, ariaInvalid, ariaDescribedBy, ariaLabel, onKeyDown,
}: {
  type: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string; autoFocus?: boolean
  id?: string; name?: string; autoComplete?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  autoCapitalize?: string; spellCheck?: boolean
  enterKeyHint?: React.HTMLAttributes<HTMLInputElement>['enterKeyHint']
  ariaInvalid?: boolean; ariaDescribedBy?: string; ariaLabel?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus}
      id={id} name={name} autoComplete={autoComplete} inputMode={inputMode}
      autoCapitalize={autoCapitalize} spellCheck={spellCheck} enterKeyHint={enterKeyHint}
      aria-invalid={ariaInvalid ? true : undefined} aria-describedby={ariaDescribedBy} aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="servd-field w-full rounded-xl px-4 py-3 text-sm transition-all placeholder:text-black/25"
      style={{
        background: '#fff', color: 'var(--servd-ink)',
        border: `1.5px solid ${ariaInvalid ? 'var(--servd-danger)' : 'rgba(0,0,0,0.1)'}`,
      }}
    />
  )
}

function ServdTextarea({ value, onChange, placeholder, rows, id, name, ariaLabel }: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string; rows?: number
  id?: string; name?: string; ariaLabel?: string
}) {
  return (
    <textarea
      value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      id={id} name={name} aria-label={ariaLabel} autoComplete="off"
      className="servd-field w-full rounded-xl px-4 py-3 text-sm transition-all resize-none placeholder:text-black/25"
      style={{ background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: 'var(--servd-ink)' }}
    />
  )
}

function StepBtn({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="h-11 w-11 rounded-xl flex items-center justify-center font-black transition-all active:scale-90"
      style={{ background: 'rgba(0,0,0,0.07)', color: 'var(--servd-mute)', border: '1px solid rgba(0,0,0,0.08)' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-mute)')}>
      {children}
    </button>
  )
}
