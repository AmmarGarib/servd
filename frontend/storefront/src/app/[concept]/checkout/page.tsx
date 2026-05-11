'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCart } from '../../../store/cart'
import { useCustomerAuth } from '../../../store/customerAuth'
import { fmt } from '../../../lib/ui'
import { decodeCartToken } from '../../../lib/cartHandoff'
import { CrossBrandUpsell } from '../../../components/CrossBrandUpsell'
import { trackCheckoutStarted, trackCheckoutAbandoned, trackOrderPlaced, trackPromoApplied, trackPromoFailed } from '../../../lib/analytics'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface AccountInfo {
  id: string
  name: string
  walletBalance: number
  loyaltyAccount: { pointsBalance: number } | null
}

export default function CheckoutPage() {
  const { concept: slug } = useParams<{ concept: string }>()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { items, subtotalCents, taxCents, totalCents, itemCount, clearCart, hydrateFromReorder } = useCart()
  const token = useCustomerAuth((s) => s.token)

  // Cross-domain handoff: when a user builds a cart on a brand custom domain
  // (eatstax.com, stax.localhost:3002…) and clicks checkout, the brand site
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
  const [useWallet,  setUseWallet]  = useState(false)
  const [loyaltyPts, setLoyaltyPts] = useState(0)

  // Fulfilment type. Curbside is a customer convenience — they tap "I'm
  // here" on arrival via /[concept]/order/[id], staff sees the queue at
  // /orders/curbside in admin and runs the bag out.
  const [fulfilmentType,   setFulfilmentType]   = useState<'pickup' | 'curbside'>('pickup')
  const [curbsideVehicle,  setCurbsideVehicle]  = useState('')
  const [curbsidePlate,    setCurbsidePlate]    = useState('')

  // Tip the rider — preset chips + custom amount. Cents.
  const [tipMode,   setTipMode]   = useState<'none' | '5' | '10' | '15' | '20' | 'custom'>('10')
  const [customTip, setCustomTip] = useState('')
  const [giftCard,  setGiftCard]  = useState('')
  const tipPctTable: Record<string, number> = { none: 0, '5': 0.05, '10': 0.10, '15': 0.15, '20': 0.20 }
  const _orderPlaced = useRef(false)

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/account`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() as Promise<AccountInfo> : null)
      .then(data => { if (data) setAccount(data) })
      .catch(() => {})
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

  if (itemCount() === 0) return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-4"
      style={{ background: 'transparent' }}>
      <div className="text-7xl" style={{ animation: 'float 3s ease-in-out infinite' }}>🛒</div>
      <div className="text-center space-y-2">
        <p className="font-black text-2xl tracking-tight" style={{ color: '#18160f' }}>Your cart is empty</p>
        <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>Add some items and come back</p>
      </div>
      <Link href={`/${slug}`}
        className="mt-1 rounded-2xl font-black px-8 py-4 text-sm transition-all hover:scale-[1.02] active:scale-[0.98]"
        style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', color: '#fff', boxShadow: '0 0 24px rgba(0,212,177,0.25)' }}>
        Back to Menu
      </Link>
    </main>
  )

  const walletBalance    = account?.walletBalance ?? 0
  const loyaltyBalance   = account?.loyaltyAccount?.pointsBalance ?? 0
  const loyaltyDeduction = Math.min(loyaltyPts * 10, totalCents())
  const walletDeduction  = useWallet ? Math.min(walletBalance, Math.max(0, totalCents() - loyaltyDeduction)) : 0
  // Tip — computed against subtotal + tax
  const tipCents         = tipMode === 'custom'
    ? Math.max(0, Math.round((parseFloat(customTip) || 0) * 100))
    : Math.round(totalCents() * (tipPctTable[tipMode] ?? 0))
  const displayTotal     = Math.max(0, totalCents() - loyaltyDeduction - walletDeduction) + tipCents

  const handlePlaceOrder = async () => {
    setError('')
    setLoading(true)
    try {
      if (token) {
        const res = await fetch(`${API_URL}/api/v1/storefront/orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            conceptSlug: slug,
            type: fulfilmentType,
            deliveryAddress: notes.trim() || undefined,
            ...(fulfilmentType === 'curbside' && {
              curbsideVehicle: curbsideVehicle.trim(),
              ...(curbsidePlate.trim() && { curbsidePlate: curbsidePlate.trim() }),
            }),
            promoCode: promoCode.trim() || undefined,
            useWallet,
            loyaltyPointsToRedeem: loyaltyPts,
            paymentGateway: 'cash',
            tipCents,
            giftCardCode: giftCard.trim().toUpperCase() || undefined,
            items: items.map(i => ({
              menuItemId: i.menuItemId,
              quantity: i.quantity,
              notes: i.notes,
              modifiers: [],
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
        trackOrderPlaced(order.id, slug, displayTotal, 'cash')
        clearCart()
        router.push(`/${slug}/order/${order.id}`)
      } else {
        if (!name.trim()) { setError('Please enter your name'); setLoading(false); return }
        const res = await fetch(`${API_URL}/api/v1/storefront/guest-orders`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conceptSlug: slug,
            customerName: name.trim(),
            customerPhone: phone.trim() || undefined,
            type: 'pickup',
            notes: notes.trim() || undefined,
            items: items.map(i => ({
              menuItemId: i.menuItemId, name: i.name,
              priceCents: i.priceCents, quantity: i.quantity, notes: i.notes,
            })),
          }),
        })
        if (!res.ok) {
          const d = await res.json() as { error?: { message?: string } }
          throw new Error(d?.error?.message ?? 'Failed to place order')
        }
        const order = await res.json() as { id: string }
        _orderPlaced.current = true
        trackOrderPlaced(order.id, slug, displayTotal, 'cash')
        clearCart()
        router.push(`/${slug}/order/${order.id}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Something went wrong'
      if (promoCode.trim()) trackPromoFailed(promoCode.trim(), msg)
      setError(msg)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen pb-32 relative overflow-hidden" style={{ background: 'transparent' }}>

      {/* Header */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center gap-3"
        style={{ borderBottom: '1px solid rgba(0,0,0,0.08)', background: 'rgba(193,191,187,0.95)', backdropFilter: 'blur(12px)' }}>
        <Link href={`/${slug}`}
          className="flex items-center gap-1.5 text-sm font-semibold transition-all duration-150 active:scale-95"
          style={{ color: 'rgba(24,22,15,0.45)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'rgba(24,22,15,0.8)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(24,22,15,0.45)')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Menu
        </Link>
        <span style={{ color: 'rgba(24,22,15,0.15)' }}>·</span>
        <h1 className="font-black text-lg tracking-tight" style={{ color: '#18160f' }}>Checkout</h1>
        {token && account && (
          <span className="ml-auto text-xs" style={{ color: 'rgba(24,22,15,0.38)' }}>
            as <span className="font-bold" style={{ color: 'rgba(24,22,15,0.65)' }}>{account.name}</span>
          </span>
        )}
      </div>

      <div className="relative z-10 max-w-lg mx-auto px-4 py-5 space-y-3">

        {/* ── Order summary ── */}
        <Panel icon="🧾" label="Your Order">
          <div className="space-y-3 mb-4">
            {items.map((item, i) => (
              <div key={item.menuItemId} className="flex items-center justify-between gap-3"
                style={{ animation: `revealUp 0.4s ${i * 0.05}s both` }}>
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-xl shrink-0 flex items-center justify-center text-sm font-black"
                    style={{ background: 'rgba(0,0,0,0.06)', color: 'rgba(24,22,15,0.55)' }}>
                    {item.quantity}×
                  </div>
                  <span className="font-semibold text-sm truncate" style={{ color: '#18160f' }}>{item.name}</span>
                </div>
                <span className="font-black text-sm shrink-0" style={{ color: '#00a896' }}>
                  {fmt(item.priceCents * item.quantity)}
                </span>
              </div>
            ))}
          </div>
          {/* How are you picking up? */}
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)' }}>
            <p className="text-xs font-bold tracking-wider uppercase mb-2" style={{ color: '#4338ca' }}>How are you getting it?</p>
            <div className="flex gap-2 mb-2">
              {(['pickup', 'curbside'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setFulfilmentType(m)}
                  className="flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-all"
                  style={fulfilmentType === m
                    ? { background: '#6366f1', color: '#fff', border: '1px solid #6366f1' }
                    : { background: '#fff', color: 'rgba(24,22,15,0.65)', border: '1px solid rgba(0,0,0,0.08)' }}>
                  {m === 'pickup' ? '🚶 Pickup' : '🚗 Curbside'}
                </button>
              ))}
            </div>
            {fulfilmentType === 'curbside' && (
              <div className="space-y-2 mt-2">
                <p className="text-[11px]" style={{ color: 'rgba(24,22,15,0.55)' }}>
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
          </div>

          {/* Tip the rider */}
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)' }}>
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

          {/* Gift card */}
          <div className="rounded-xl p-3.5 mb-3" style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <label className="text-xs font-bold tracking-wider uppercase text-[color:var(--servd-mute)] block mb-2">Gift card</label>
            <input
              value={giftCard}
              onChange={(e) => setGiftCard(e.target.value.toUpperCase())}
              placeholder="GS-XXXX-XXXX"
              className="w-full text-sm rounded-lg px-3 py-1.5 border font-mono uppercase tracking-wider"
              style={{ borderColor: 'rgba(0,0,0,0.1)' }}
            />
          </div>

          <div className="rounded-xl p-3.5 space-y-2"
            style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.06)' }}>
            <PriceLine label="Subtotal"    value={fmt(subtotalCents())} />
            <PriceLine label="Tax (17% GST)" value={fmt(taxCents())} />
            {tipCents > 0 && (
              <PriceLine label="Tip" value={fmt(tipCents)} accent="#16a34a" />
            )}
            {loyaltyDeduction > 0 && (
              <PriceLine label={`Points (${loyaltyPts} pts)`} value={`−${fmt(loyaltyDeduction)}`} accent="#6366f1" />
            )}
            {walletDeduction > 0 && (
              <PriceLine label="Wallet credit" value={`−${fmt(walletDeduction)}`} accent="#16a34a" />
            )}
            <div className="flex justify-between items-center pt-2.5"
              style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}>
              <span className="font-black text-base" style={{ color: '#18160f' }}>Total</span>
              <span className="font-black text-xl" style={{ color: '#00a896' }}>{fmt(displayTotal)}</span>
            </div>
          </div>
        </Panel>

        {/* Cross-brand upsell — surface 3 dishes from other GS Foods kitchens. */}
        <CrossBrandUpsell currentSlug={slug} />

        {token ? (
          <>
            {/* Promo code */}
            <Panel icon="🎟" label="Promo Code">
              <PremiumInput
                type="text" value={promoCode}
                onChange={e => setPromoCode(e.target.value.toUpperCase())}
                placeholder="Enter code (applied at checkout)"
              />
            </Panel>

            {/* Wallet toggle */}
            {walletBalance > 0 && (
              <button
                onClick={() => setUseWallet(v => !v)}
                className="flex items-center justify-between w-full rounded-2xl p-4 transition-all duration-200 active:scale-[0.99]"
                style={{
                  background: useWallet ? 'rgba(0,168,150,0.06)' : '#fff',
                  border: `1px solid ${useWallet ? 'rgba(0,168,150,0.28)' : 'rgba(0,0,0,0.07)'}`,
                  boxShadow: useWallet ? '0 0 20px rgba(0,168,150,0.08)' : '0 2px 8px rgba(0,0,0,0.04)',
                }}>
                <div className="flex items-center gap-3">
                  <div className="h-11 w-11 rounded-xl flex items-center justify-center text-xl shrink-0"
                    style={{ background: useWallet ? 'rgba(0,168,150,0.1)' : 'rgba(0,0,0,0.05)' }}>
                    💰
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-sm" style={{ color: '#18160f' }}>Use Wallet Balance</p>
                    <p className="text-xs mt-0.5" style={{ color: 'rgba(24,22,15,0.45)' }}>
                      {fmt(walletBalance)} available
                    </p>
                  </div>
                </div>
                <div className="h-5 w-9 rounded-full transition-all duration-300 relative shrink-0"
                  style={{ background: useWallet ? '#00D4B1' : 'rgba(0,0,0,0.12)' }}>
                  <div className="absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all duration-300"
                    style={{ left: useWallet ? '1.1rem' : '0.125rem' }} />
                </div>
              </button>
            )}

            {/* Loyalty points */}
            {loyaltyBalance > 0 && (
              <Panel icon="⭐" label="Redeem Points">
                <div className="flex items-center justify-between">
                  <p className="text-xs" style={{ color: 'rgba(24,22,15,0.45)' }}>
                    {loyaltyBalance} pts available · <span style={{ color: 'rgba(24,22,15,0.65)' }}>{loyaltyPts} selected</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <StepBtn onClick={() => setLoyaltyPts(p => Math.max(0, p - 10))}>−</StepBtn>
                    <span className="font-black text-sm w-10 text-center" style={{ color: '#18160f' }}>{loyaltyPts}</span>
                    <StepBtn onClick={() => setLoyaltyPts(p => Math.min(loyaltyBalance, p + 10))}>+</StepBtn>
                  </div>
                </div>
              </Panel>
            )}

            {/* Notes */}
            <Panel icon="📝" label="Special Instructions">
              <PremiumTextarea value={notes} onChange={e => setNotes(e.target.value)}
                placeholder="Allergies, preferences, extras…" rows={2} />
            </Panel>
          </>
        ) : (
          /* ── Guest details ── */
          <Panel icon="👤" label="Your Details" extra={
            <Link href="/login"
              className="text-xs font-black transition-colors"
              style={{ color: '#6366f1' }}
              onMouseEnter={e => (e.currentTarget.style.color = '#4f46e5')}
              onMouseLeave={e => (e.currentTarget.style.color = '#6366f1')}>
              Sign in for rewards →
            </Link>
          }>
            <div className="space-y-3">
              <FormField label="Name *">
                <PremiumInput type="text" value={name} onChange={e => setName(e.target.value)}
                  placeholder="Your name" autoFocus />
              </FormField>
              <FormField label="Phone (optional)">
                <PremiumInput type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                  placeholder="03xx-xxxxxxx" />
              </FormField>
              <FormField label="Special instructions (optional)">
                <PremiumTextarea value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="Allergies, preferences…" rows={2} />
              </FormField>
            </div>
          </Panel>
        )}

        {/* Payment method */}
        <div className="flex items-center gap-3 rounded-2xl p-4"
          style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          <div className="h-11 w-11 rounded-xl flex items-center justify-center text-xl shrink-0"
            style={{ background: 'rgba(0,0,0,0.05)' }}>💵</div>
          <div className="flex-1">
            <p className="font-bold text-sm" style={{ color: '#18160f' }}>Cash on collection</p>
            <p className="text-xs mt-0.5" style={{ color: 'rgba(24,22,15,0.45)' }}>Pay when you pick up</p>
          </div>
          <div className="h-5 w-5 rounded-full flex items-center justify-center shrink-0"
            style={{ background: 'rgba(0,168,150,0.12)', border: '1.5px solid rgba(0,168,150,0.45)' }}>
            <div className="h-2 w-2 rounded-full" style={{ background: '#00a896' }} />
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm font-medium"
            style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.2)', color: '#dc2626' }}>
            <span className="shrink-0 mt-0.5">⚠</span>
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* ── Fixed CTA ── */}
      <div className="fixed bottom-0 left-0 right-0 px-4 py-4 z-40"
        style={{ background: 'rgba(193,191,187,0.97)', backdropFilter: 'blur(24px)', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
        <button
          onClick={() => { void handlePlaceOrder() }} disabled={loading}
          className="flex items-center justify-between w-full max-w-lg mx-auto rounded-2xl py-4 px-6 font-black text-base transition-all duration-200 disabled:opacity-40 hover:scale-[1.01] active:scale-[0.98]"
          style={{
            background: loading ? 'rgba(0,0,0,0.08)' : 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)',
            color: loading ? 'rgba(24,22,15,0.4)' : '#fff',
            boxShadow: loading ? 'none' : '0 0 32px rgba(0,212,177,0.28)',
          }}>
          <span>{loading ? 'Placing order…' : 'Place Order'}</span>
          <span>{fmt(displayTotal)}</span>
        </button>
      </div>
    </main>
  )
}

/* ── Sub-components ── */

function Panel({ icon, label, extra, children }: {
  icon: string; label: string; extra?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div className="rounded-2xl p-4 space-y-3"
      style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <p className="text-[10px] font-black uppercase tracking-[0.2em]"
            style={{ color: 'rgba(24,22,15,0.38)' }}>{label}</p>
        </div>
        {extra}
      </div>
      {children}
    </div>
  )
}

function PriceLine({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between text-sm">
      <span style={{ color: 'rgba(24,22,15,0.45)' }}>{label}</span>
      <span style={{ color: accent ?? 'rgba(24,22,15,0.6)' }}>{value}</span>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
        style={{ color: 'rgba(24,22,15,0.38)' }}>{label}</label>
      {children}
    </div>
  )
}

function PremiumInput({ type, value, onChange, placeholder, autoFocus }: {
  type: string; value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string; autoFocus?: boolean
}) {
  return (
    <input
      type={type} value={value} onChange={onChange} placeholder={placeholder} autoFocus={autoFocus}
      className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none transition-all placeholder:text-black/25"
      style={{ background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: '#18160f' }}
      onFocus={e => {
        e.currentTarget.style.borderColor = '#00D4B1'
        e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(0,212,177,0.12)'
      }}
      onBlur={e => {
        e.currentTarget.style.borderColor = 'rgba(0,0,0,0.1)'
        e.currentTarget.style.boxShadow   = 'none'
      }}
    />
  )
}

function PremiumTextarea({ value, onChange, placeholder, rows }: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  placeholder?: string; rows?: number
}) {
  return (
    <textarea
      value={value} onChange={onChange} placeholder={placeholder} rows={rows}
      className="w-full rounded-xl px-4 py-3 text-sm focus:outline-none transition-all resize-none placeholder:text-black/25"
      style={{ background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: '#18160f' }}
      onFocus={e => {
        e.currentTarget.style.borderColor = '#00D4B1'
        e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(0,212,177,0.12)'
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
      style={{ background: 'rgba(0,0,0,0.07)', color: 'rgba(24,22,15,0.6)', border: '1px solid rgba(0,0,0,0.08)' }}
      onMouseEnter={e => (e.currentTarget.style.color = '#18160f')}
      onMouseLeave={e => (e.currentTarget.style.color = 'rgba(24,22,15,0.6)')}>
      {children}
    </button>
  )
}
