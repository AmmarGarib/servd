'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'
import { fmt } from '../../lib/ui'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Order {
  id: string; status: string; totalCents: number; placedAt: string
  concept: { name: string; slug: string }
  items: Array<{ name: string; quantity: number }>
}
interface LoyaltyAccount { pointsBalance: number; tier: string }
interface CustomerProfile {
  name: string | null; email: string | null; phone: string | null
  referralCode?: string | null
  loyaltyAccount: LoyaltyAccount | null; orders: Order[]
}
interface CustomerAddress {
  id: string; label: string; address: string; lat?: number | null; lng?: number | null; isDefault: boolean
}

const STATUS_CONFIG: Record<string, { bg: string; text: string; label: string; bar: string }> = {
  received:  { bg: 'rgba(59,130,246,0.12)',  text: '#2563eb', label: 'Received',  bar: '#3b82f6' },
  confirmed: { bg: 'rgba(99,102,241,0.12)',  text: '#4f46e5', label: 'Confirmed', bar: '#6366f1' },
  preparing: { bg: 'rgba(234,179,8,0.12)',   text: '#d97706', label: 'Preparing', bar: '#eab308' },
  ready:     { bg: 'rgba(34,197,94,0.12)',   text: '#16a34a', label: 'Ready!',    bar: '#22c55e' },
  completed: { bg: 'rgba(0,0,0,0.05)',       text: 'rgba(24,22,15,0.38)', label: 'Completed', bar: 'rgba(0,0,0,0.18)' },
  cancelled: { bg: 'rgba(239,68,68,0.1)',    text: '#dc2626', label: 'Cancelled', bar: '#ef4444' },
}
const TIER_COLOR: Record<string, string> = { bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffd700' }
const TIER_THRESHOLDS = [
  { name: 'bronze', label: 'Bronze', nextAt: 1000 },
  { name: 'silver', label: 'Silver', nextAt: 5000 },
  { name: 'gold',   label: 'Gold',   nextAt: null },
]
const PERSONAL_OFFERS = [
  { id: 'o1', emoji: '⚡', title: '2× Points',   desc: 'Earn double this weekend.' },
  { id: 'o2', emoji: '🥤', title: 'Free Drink',   desc: 'Add to your next order.' },
  { id: 'o3', emoji: '🎁', title: 'Loyalty Bonus', desc: '500 pts = Rs. 100 off.' },
]

export default function AccountPage() {
  const router = useRouter()
  const { token, clearAuth } = useCustomerAuth()
  const [profile, setProfile] = useState<CustomerProfile | null>(null)
  const [addresses, setAddresses] = useState<CustomerAddress[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [showAddAddr, setShowAddAddr] = useState(false)
  const [addrForm, setAddrForm] = useState({ label: '', address: '', isDefault: false })
  const [addrSaving, setAddrSaving] = useState(false)

  const fetchAddresses = useCallback(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/addresses`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then(d => setAddresses(d as CustomerAddress[]))
      .catch(() => {})
  }, [token])

  useEffect(() => {
    if (!token) { router.replace('/login'); return }
    Promise.all([
      fetch(`${API_URL}/api/v1/storefront/account`, { headers: { Authorization: `Bearer ${token}` } })
        .then(async res => {
          if (res.status === 401) { clearAuth(); router.replace('/login'); return null }
          if (!res.ok) throw new Error('Failed to load account')
          return res.json() as Promise<CustomerProfile>
        }),
      fetch(`${API_URL}/api/v1/storefront/addresses`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : []),
    ])
      .then(([profile, addrs]) => {
        if (profile) setProfile(profile)
        setAddresses(addrs as CustomerAddress[])
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token, router, clearAuth])

  async function saveAddress() {
    if (!token || !addrForm.label || !addrForm.address) return
    setAddrSaving(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/storefront/addresses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(addrForm),
      })
      if (res.ok) {
        setShowAddAddr(false)
        setAddrForm({ label: '', address: '', isDefault: false })
        fetchAddresses()
      }
    } finally { setAddrSaving(false) }
  }

  async function deleteAddress(id: string) {
    if (!token) return
    await fetch(`${API_URL}/api/v1/storefront/addresses/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    })
    fetchAddresses()
  }

  async function setDefault(id: string) {
    if (!token) return
    await fetch(`${API_URL}/api/v1/storefront/addresses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ isDefault: true }),
    })
    fetchAddresses()
  }

  if (loading) return (
    <main className="flex min-h-screen items-center justify-center" style={{ background: 'transparent' }}>
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-14 w-14">
          <div className="absolute inset-0 rounded-full" style={{ border: '2px solid rgba(0,0,0,0.07)' }} />
          <div className="absolute inset-0 rounded-full animate-spin"
            style={{ border: '2px solid transparent', borderTopColor: 'rgba(0,212,177,0.6)' }} />
        </div>
        <p className="text-sm" style={{ color: 'rgba(24,22,15,0.38)' }}>Loading account…</p>
      </div>
    </main>
  )

  if (error || !profile) return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-5 px-4"
      style={{ background: 'transparent' }}>
      <div className="text-5xl">⚠</div>
      <p className="text-sm" style={{ color: '#dc2626' }}>{error || 'Account not found'}</p>
      <Link href="/"
        className="rounded-2xl font-black px-8 py-3.5 text-sm transition-all hover:scale-[1.02]"
        style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', color: '#fff', boxShadow: '0 4px 20px rgba(0,212,177,0.3)' }}>
        Back to menu
      </Link>
    </main>
  )

  const initials      = (profile.name ?? 'A').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  const tier          = profile.loyaltyAccount?.tier ?? 'bronze'
  const pts           = profile.loyaltyAccount?.pointsBalance ?? 0
  const tierIdx       = TIER_THRESHOLDS.findIndex(t => t.name === tier)
  const current       = TIER_THRESHOLDS[Math.max(0, tierIdx)]
  const next          = TIER_THRESHOLDS[tierIdx + 1]
  const prevThreshold = tierIdx > 0 ? (TIER_THRESHOLDS[tierIdx - 1]?.nextAt ?? 0) : 0
  const progress      = next
    ? Math.min(100, Math.max(0, ((pts - prevThreshold) / ((next.nextAt ?? 0) - prevThreshold)) * 100))
    : 100
  const lifetimeSpend = profile.orders.reduce((s, o) => s + o.totalCents, 0)
  const totalOrders   = profile.orders.length
  const tc            = TIER_COLOR[tier] ?? '#cd7f32'
  const firstName     = profile.name?.split(' ')[0] ?? null

  return (
    <main className="min-h-screen pb-16 relative" style={{ background: 'transparent' }}>

      {/* Subtle tier color accent */}
      <div className="fixed pointer-events-none select-none" style={{
        top: '-60px', right: '-40px', width: '380px', height: '380px',
        background: `radial-gradient(circle, ${tc}14 0%, transparent 70%)`,
      }} />

      {/* Header */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(22,163,74,0.12)', background: 'rgba(240,253,244,0.96)', backdropFilter: 'blur(20px)' }}>
        <Link href="/"
          className="flex items-center gap-1.5 text-sm font-semibold transition-colors"
          style={{ color: 'rgba(24,22,15,0.45)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'rgba(24,22,15,0.8)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'rgba(24,22,15,0.45)')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Menu
        </Link>
        <button onClick={() => { clearAuth(); router.replace('/') }}
          className="text-xs font-bold transition-colors px-3 py-1.5 rounded-xl"
          style={{ color: 'rgba(24,22,15,0.45)', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'rgba(24,22,15,0.45)'; e.currentTarget.style.background = 'rgba(239,68,68,0.06)' }}>
          Sign out
        </button>
      </div>

      <div className="relative z-10 max-w-lg mx-auto px-4 pt-6 pb-6" style={{ animation: 'revealUp 0.5s both' }}>

        {/* ── Greeting ── */}
        <div className="mb-5">
          <p className="text-sm" style={{ color: 'rgba(24,22,15,0.38)' }}>Your account</p>
          <h1 className="font-black text-3xl leading-tight tracking-tight mt-0.5" style={{ color: '#18160f' }}>
            {firstName ? `Hey, ${firstName} 👋` : 'Welcome back 👋'}
          </h1>
        </div>

        {/* ── Bento top row: profile + loyalty side by side ── */}
        <div className="flex gap-3 mb-3">

          {/* Profile card */}
          <div className="relative rounded-2xl overflow-hidden flex-shrink-0"
            style={{
              width: '148px',
              background: '#fff',
              border: '1px solid rgba(0,0,0,0.07)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
            }}>
            <div className="h-1 w-full"
              style={{ background: 'linear-gradient(90deg, #22c55e, #16a34a)' }} />
            <div className="p-4 flex flex-col items-center text-center gap-3 h-full pb-5">
              <div className="h-16 w-16 rounded-2xl flex items-center justify-center font-black text-2xl text-white mt-1"
                style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', boxShadow: '0 0 20px rgba(34,197,94,0.28)' }}>
                {initials}
              </div>
              <div>
                <p className="font-black text-sm leading-tight" style={{ color: '#18160f' }}>{profile.name ?? 'Guest'}</p>
                <p className="text-[0.6rem] mt-0.5 truncate max-w-[120px]" style={{ color: 'rgba(24,22,15,0.38)' }}>
                  {profile.email ?? profile.phone ?? '—'}
                </p>
              </div>
              {totalOrders > 0 && (
                <div className="w-full rounded-xl py-2 px-3 mt-auto"
                  style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                  <p className="font-black text-lg leading-none" style={{ color: '#18160f' }}>{totalOrders}</p>
                  <p className="text-[0.55rem] font-black uppercase tracking-wider mt-0.5" style={{ color: 'rgba(24,22,15,0.38)' }}>orders</p>
                </div>
              )}
            </div>
          </div>

          {/* Loyalty card */}
          {profile.loyaltyAccount ? (
            <div className="flex-1 min-w-0 rounded-2xl p-4 relative overflow-hidden"
              style={{
                background: '#fff',
                border: `1px solid ${tc}38`,
                boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
              }}>
              <div className="absolute top-0 right-0 w-32 h-32 rounded-full pointer-events-none"
                style={{ background: tc, filter: 'blur(50px)', opacity: 0.1, animation: 'glowPulse 6s ease-in-out infinite' }} />
              <div className="relative z-10 flex flex-col h-full">
                <div className="flex items-start justify-between mb-2">
                  <p className="text-[0.55rem] uppercase tracking-[0.28em] font-black" style={{ color: 'rgba(24,22,15,0.38)' }}>Points</p>
                  <span className="text-[0.55rem] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                    style={{ background: `${tc}1e`, color: tc }}>
                    {current?.label ?? tier}
                  </span>
                </div>
                <p className="font-black leading-none" style={{ fontSize: '3.2rem', color: '#18160f' }}>
                  {pts.toLocaleString()}
                </p>
                <p className="text-[0.6rem] mt-1" style={{ color: 'rgba(24,22,15,0.38)' }}>≈ {fmt(pts * 10)} value</p>

                <div className="mt-auto pt-3">
                  {next ? (
                    <>
                      <div className="h-1 rounded-full overflow-hidden mb-1"
                        style={{ background: 'rgba(0,0,0,0.07)' }}>
                        <div className="h-full rounded-full transition-all duration-1000"
                          style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${tc}88, ${tc})` }} />
                      </div>
                      <p className="text-[0.55rem]" style={{ color: 'rgba(24,22,15,0.38)' }}>
                        {(next.nextAt! - pts).toLocaleString()} pts to {next.label}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs font-black" style={{ color: tc }}>🏆 Top tier!</p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 rounded-2xl p-4 flex flex-col justify-center items-center text-center gap-2"
              style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 12px rgba(0,0,0,0.06)' }}>
              <p className="text-3xl">⭐</p>
              <p className="font-black text-sm" style={{ color: '#18160f' }}>No loyalty yet</p>
              <p className="text-xs" style={{ color: 'rgba(24,22,15,0.38)' }}>Place an order to start earning</p>
            </div>
          )}
        </div>

        {/* ── Lifetime spend stat ── */}
        {totalOrders > 0 && (
          <div className="rounded-2xl px-5 py-3.5 mb-3 flex items-center justify-between"
            style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>Lifetime spend</p>
            <p className="font-black text-lg" style={{ color: '#18160f' }}>{fmt(lifetimeSpend)}</p>
          </div>
        )}

        {/* ── Saved addresses ── */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.28em]"
              style={{ color: 'rgba(15,26,15,0.38)' }}>Saved Locations</p>
            <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
            <button onClick={() => setShowAddAddr(!showAddAddr)}
              className="text-[10px] font-black px-2.5 py-1 rounded-full transition-all"
              style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.2)' }}>
              + Add
            </button>
          </div>

          {showAddAddr && (
            <div className="rounded-2xl p-4 mb-3 space-y-3"
              style={{ background: '#fff', border: '1px solid rgba(34,197,94,0.2)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <div>
                <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>Label (e.g. Home, Work, Gym)</label>
                <input value={addrForm.label} onChange={(e) => setAddrForm({ ...addrForm, label: e.target.value })}
                  placeholder="Home" className="mt-1 w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)' }} />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>Full address</label>
                <input value={addrForm.address} onChange={(e) => setAddrForm({ ...addrForm, address: e.target.value })}
                  placeholder="House #5, Street 12, DHA Phase 2…" className="mt-1 w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)' }} />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={addrForm.isDefault} onChange={(e) => setAddrForm({ ...addrForm, isDefault: e.target.checked })}
                  className="rounded" />
                <span className="text-xs" style={{ color: 'rgba(15,26,15,0.55)' }}>Set as default delivery address</span>
              </label>
              <div className="flex gap-2">
                <button onClick={() => void saveAddress()} disabled={addrSaving || !addrForm.label || !addrForm.address}
                  className="flex-1 rounded-xl py-2.5 text-sm font-black transition-all disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', color: '#fff' }}>
                  {addrSaving ? 'Saving…' : 'Save address'}
                </button>
                <button onClick={() => setShowAddAddr(false)}
                  className="px-4 rounded-xl text-sm transition-all"
                  style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)' }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {addresses.length === 0 && !showAddAddr ? (
            <div className="rounded-2xl p-5 text-center"
              style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <p className="text-2xl mb-2">📍</p>
              <p className="text-sm font-semibold" style={{ color: 'rgba(15,26,15,0.55)' }}>No saved locations yet</p>
              <p className="text-xs mt-1" style={{ color: 'rgba(15,26,15,0.35)' }}>Add your home, work or favourite spots for quick ordering</p>
            </div>
          ) : (
            <div className="space-y-2">
              {addresses.map((addr) => (
                <div key={addr.id} className="rounded-2xl p-4 flex items-center gap-3"
                  style={{ background: '#fff', border: addr.isDefault ? '1px solid rgba(34,197,94,0.3)' : '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
                  <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0 text-sm"
                    style={{ background: addr.isDefault ? 'rgba(34,197,94,0.12)' : 'rgba(0,0,0,0.04)' }}>
                    📍
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-black text-sm" style={{ color: '#0f1a0f' }}>{addr.label}</p>
                      {addr.isDefault && (
                        <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                          style={{ background: 'rgba(34,197,94,0.12)', color: '#16a34a' }}>Default</span>
                      )}
                    </div>
                    <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'rgba(15,26,15,0.45)' }}>{addr.address}</p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {!addr.isDefault && (
                      <button onClick={() => void setDefault(addr.id)}
                        className="text-[10px] font-bold transition-colors"
                        style={{ color: '#16a34a' }}>
                        Set default
                      </button>
                    )}
                    <button onClick={() => void deleteAddress(addr.id)}
                      className="text-[10px] font-bold transition-colors"
                      style={{ color: 'rgba(220,38,38,0.6)' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#dc2626')}
                      onMouseLeave={e => (e.currentTarget.style.color = 'rgba(220,38,38,0.6)')}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Exclusive offers — 3-col bento ── */}
        <div className="mb-3">
          <div className="flex items-center gap-2 mb-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.28em]"
              style={{ color: 'rgba(24,22,15,0.38)' }}>Exclusive for you</p>
            <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {PERSONAL_OFFERS.map((offer, i) => (
              <div key={offer.id}
                className="rounded-2xl p-3 cursor-pointer transition-all hover:scale-[1.03] flex flex-col gap-2"
                style={{
                  background: '#fff', border: '1px solid rgba(0,0,0,0.07)',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                  animation: `revealUp 0.4s ${i * 0.06}s both`,
                }}>
                <div className="text-xl" style={{ animation: `float ${3 + i * 0.5}s ease-in-out infinite` }}>
                  {offer.emoji}
                </div>
                <p className="font-black text-[0.72rem] leading-tight" style={{ color: '#18160f' }}>{offer.title}</p>
                <p className="text-[0.6rem] leading-snug" style={{ color: 'rgba(24,22,15,0.45)' }}>{offer.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Order history ── */}
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.28em]"
              style={{ color: 'rgba(24,22,15,0.38)' }}>Order History</p>
            <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
          </div>

          {profile.orders.length === 0 ? (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <div className="text-4xl mb-3" style={{ animation: 'float 3s ease-in-out infinite' }}>🍽</div>
              <p className="text-sm" style={{ color: 'rgba(24,22,15,0.45)' }}>No orders yet</p>
              <Link href="/"
                className="inline-block mt-3 text-sm font-bold transition-colors"
                style={{ color: '#00a896' }}>
                Start ordering →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {profile.orders.map((order, i) => {
                const sc = STATUS_CONFIG[order.status] ?? STATUS_CONFIG['completed']!
                return (
                  <Link
                    key={order.id}
                    href={`/${order.concept.slug}/order/${order.id}`}
                    className="block rounded-2xl overflow-hidden transition-all hover:scale-[1.005]"
                    style={{
                      background: '#fff',
                      border: '1px solid rgba(0,0,0,0.07)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
                      animation: `revealUp 0.4s ${i * 0.04}s both`,
                    }}>
                    <div className="flex">
                      <div className="w-1 shrink-0" style={{ background: sc.bar }} />
                      <div className="flex items-start justify-between gap-3 p-4 flex-1 min-w-0">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap mb-0.5">
                            <p className="font-bold text-sm" style={{ color: '#18160f' }}>{order.concept.name}</p>
                            <span className="text-[9px] font-black uppercase tracking-[0.18em] px-2 py-0.5 rounded-full"
                              style={{ background: sc.bg, color: sc.text }}>
                              {sc.label}
                            </span>
                          </div>
                          <p className="text-[10px] font-mono mb-1.5" style={{ color: 'rgba(24,22,15,0.32)' }}>
                            #{order.id.slice(-8).toUpperCase()} · {new Date(order.placedAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                          </p>
                          <p className="text-xs line-clamp-1" style={{ color: 'rgba(24,22,15,0.45)' }}>
                            {order.items.map(it => `${it.quantity}× ${it.name}`).join(', ')}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-black text-sm" style={{ color: '#18160f' }}>{fmt(order.totalCents)}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: 'rgba(24,22,15,0.28)' }}>→</p>
                        </div>
                      </div>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>

        {/* ── Refer a friend ── */}
        <ReferralSection token={token} referralCode={profile.referralCode} customerName={profile.name} />

        {/* ── My Bookings ── */}
        <MyBookingsSection token={token} />

        {/* ── My Reviews ── */}
        <MyReviewsSection token={token} />

        {/* ── Favorites — items I order most ── */}
        <MyFavoritesSection token={token} />

        {/* ── Need help? Inline complaint flow ── */}
        <SupportSection orders={profile.orders.slice(0, 10)} />
      </div>
    </main>
  )
}

// ─── Refer a friend ──────────────────────────────────────────────────────────
// Shareable code + invite link + running tally of who's signed up vs.
// completed their first order. The 200-pt dual bonus fires from the
// loyaltyTriggers worker when the referee's firstOrderAt gets set.
interface ReferralSummary {
  totalReferred: number
  completedFirstOrder: number
  pendingPayout: number
  paidOut: number
  earnedPoints: number
}
interface ReferralEntry {
  firstName: string
  referredAt: string | null
  firstOrderAt: string | null
  rewarded: boolean
}

function ReferralSection({
  token, referralCode, customerName,
}: { token: string | null; referralCode: string | null | undefined; customerName: string | null }) {
  const [data, setData] = useState<{ summary: ReferralSummary; referrals: ReferralEntry[] } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/my-referrals`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { summary: ReferralSummary; referrals: ReferralEntry[] } | null) => setData(d))
      .catch(() => {})
  }, [token])

  if (!referralCode) return null  // Older customers may not have a code yet

  const inviteUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/signup?ref=${referralCode}`
    : `https://servd.pk/signup?ref=${referralCode}`
  const shareText = `Hey, try servd — Pakistan's nicest food app. Use my code ${referralCode} when you sign up and we both get PKR 200 off our next orders. ${inviteUrl}`

  function copy(text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      })
    }
  }
  function shareNative() {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(navigator as any).share({ title: 'servd', text: shareText, url: inviteUrl }).catch(() => {})
    } else {
      copy(shareText)
    }
  }

  return (
    <div className="rounded-3xl p-5 sm:p-6"
      style={{
        background: 'linear-gradient(135deg, #fef3c7 0%, #fed7aa 100%)',
        border: '1px solid #fbbf24',
      }}>
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: '#9a3412' }}>
        Refer & earn
      </p>
      <h3 className="text-lg font-black mt-1 mb-2" style={{ color: '#7c2d12' }}>
        Invite a friend, earn <span style={{ color: '#dc2626' }}>+200 pts each</span>
      </h3>
      <p className="text-xs mb-4" style={{ color: '#9a3412' }}>
        They sign up with your code. You both get PKR 200 off — credited the moment they place their first order.
      </p>

      {/* Code + share */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 min-w-0 rounded-xl px-4 py-3 font-mono text-lg font-black tabular-nums tracking-wider text-center"
          style={{ background: '#fff', color: '#7c2d12', border: '2px dashed #fbbf24' }}>
          {referralCode}
        </div>
        <button onClick={() => copy(referralCode)}
          className="rounded-xl px-3 py-3 text-xs font-bold whitespace-nowrap"
          style={{ background: '#7c2d12', color: '#fff' }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={shareNative}
          className="flex-1 rounded-xl px-3 py-2.5 text-xs font-bold"
          style={{ background: '#22c55e', color: '#000' }}>
          Share invite link
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
          target="_blank" rel="noopener noreferrer"
          className="flex-1 rounded-xl px-3 py-2.5 text-xs font-bold text-center"
          style={{ background: '#25D366', color: '#fff' }}>
          WhatsApp
        </a>
      </div>

      {/* Tally */}
      {data && data.summary.totalReferred > 0 && (
        <div className="mt-4 pt-4 border-t" style={{ borderColor: 'rgba(154,52,18,0.2)' }}>
          <div className="grid grid-cols-3 gap-2 text-center">
            <Stat n={data.summary.totalReferred} label="invited" />
            <Stat n={data.summary.completedFirstOrder} label="ordered" />
            <Stat n={data.summary.earnedPoints} label="pts earned" />
          </div>
          {data.summary.pendingPayout > 0 && (
            <p className="mt-3 text-[11px] text-center" style={{ color: '#9a3412' }}>
              {data.summary.pendingPayout} friend{data.summary.pendingPayout === 1 ? '' : 's'} signed up but haven&rsquo;t ordered yet — nudge them!
            </p>
          )}
        </div>
      )}
    </div>
  )
}
function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div>
      <div className="text-2xl font-black" style={{ color: '#7c2d12' }}>{n}</div>
      <div className="text-[10px] font-bold uppercase tracking-wide" style={{ color: '#9a3412' }}>{label}</div>
    </div>
  )
}

// ─── My Bookings (reservations) ──────────────────────────────────────────────
// Hidden entirely when the customer has never made a reservation — keeps the
// page from showing a hollow "you haven't booked yet" state.
interface MyReservationsResponse {
  upcoming: Array<{
    id: string; partySize: number; startTime: string; status: string; notes: string | null
    isVip: boolean; confirmToken: string | null
    concept: { name: string; slug: string; primaryColor: string | null }
    table:   { label: string } | null
  }>
  past: Array<{
    id: string; partySize: number; startTime: string; status: string
    concept: { name: string; slug: string }
  }>
}

function MyBookingsSection({ token }: { token: string | null }) {
  const [data, setData] = useState<MyReservationsResponse | null>(null)
  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/my-reservations`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MyReservationsResponse | null) => setData(d))
      .catch(() => {})
  }, [token])

  if (!data) return null
  if (data.upcoming.length === 0 && data.past.length === 0) return null  // hide entirely if empty

  const fmt = (iso: string) => new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })

  return (
    <div className="rounded-3xl p-5 sm:p-6" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)' }}>
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(24,22,15,0.38)' }}>
        My bookings
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: '#18160f' }}>
        {data.upcoming.length > 0 ? `${data.upcoming.length} upcoming` : 'Past visits'}
      </h3>

      {data.upcoming.length > 0 && (
        <div className="space-y-2 mb-4">
          {data.upcoming.map((r) => (
            <div key={r.id} className="rounded-xl p-3 flex items-center justify-between gap-3"
              style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.15)' }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-black text-sm">{r.concept.name}</span>
                  {r.isVip && <span className="text-[10px] font-bold text-amber-600">★</span>}
                  <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 rounded-full"
                    style={{
                      background: r.status === 'confirmed' ? 'rgba(20,184,166,0.15)' : 'rgba(59,130,246,0.15)',
                      color:      r.status === 'confirmed' ? '#0d9488' : '#2563eb',
                    }}>
                    {r.status}
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={{ color: 'rgba(24,22,15,0.55)' }}>
                  Party of {r.partySize} · {fmt(r.startTime)}
                  {r.table ? ` · table ${r.table.label}` : ''}
                </div>
              </div>
              {r.confirmToken && r.status === 'booked' && (
                <Link href={`/reserve/confirm/${r.confirmToken}`}
                  className="rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap"
                  style={{ background: '#22c55e', color: '#fff' }}>
                  Confirm
                </Link>
              )}
            </div>
          ))}
        </div>
      )}

      {data.past.length > 0 && (
        <details>
          <summary className="text-xs font-bold cursor-pointer" style={{ color: 'rgba(24,22,15,0.55)' }}>
            Past visits ({data.past.length})
          </summary>
          <div className="space-y-1.5 mt-2">
            {data.past.slice(0, 8).map((r) => (
              <div key={r.id} className="text-xs flex items-center justify-between py-1"
                style={{ color: 'rgba(24,22,15,0.55)' }}>
                <span>{r.concept.name} · {r.partySize}px</span>
                <span>{fmt(r.startTime)}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

// ─── My Reviews ──────────────────────────────────────────────────────────────
interface MyReview {
  id: string; rating: number; comment: string | null; tags: string[]
  managerResponse: string | null
  managerResponseAt: string | null
  createdAt: string
  concept: { name: string; slug: string }
  order: { id: string; totalCents: number; placedAt: string }
}
function MyReviewsSection({ token }: { token: string | null }) {
  const [reviews, setReviews] = useState<MyReview[] | null>(null)
  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/my-reviews`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: MyReview[]) => setReviews(d))
      .catch(() => setReviews([]))
  }, [token])

  if (!reviews || reviews.length === 0) return null

  return (
    <div className="rounded-3xl p-5 sm:p-6" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)' }}>
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(24,22,15,0.38)' }}>
        My reviews
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: '#18160f' }}>
        {reviews.length} review{reviews.length === 1 ? '' : 's'}
      </h3>
      <div className="space-y-3">
        {reviews.slice(0, 5).map((r) => (
          <div key={r.id} className="rounded-xl p-3" style={{ background: 'rgba(0,0,0,0.025)' }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-sm">{r.concept.name}</span>
              <span className="text-amber-500 text-sm font-bold">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
            </div>
            {r.comment && (
              <p className="text-xs mt-1.5" style={{ color: 'rgba(24,22,15,0.7)' }}>{r.comment}</p>
            )}
            {r.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {r.tags.map((t) => (
                  <span key={t} className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(34,197,94,0.1)', color: '#15803d' }}>{t}</span>
                ))}
              </div>
            )}
            {r.managerResponse && (
              <div className="mt-2.5 pl-2.5 border-l-2 text-xs" style={{ borderColor: '#22c55e', color: 'rgba(24,22,15,0.65)' }}>
                <div className="font-bold mb-0.5" style={{ color: '#16a34a' }}>From the team:</div>
                {r.managerResponse}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── My Favorites ────────────────────────────────────────────────────────────
interface FavoriteItem {
  menuItemId: string; name: string; priceCents: number
  imageUrl: string | null; isAvailable: boolean
  timesOrdered: number; lastOrderedAt: string
  concept: { name: string; slug: string } | null
}
function MyFavoritesSection({ token }: { token: string | null }) {
  const [items, setItems] = useState<FavoriteItem[] | null>(null)
  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/my-favorites`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : []))
      .then((d: FavoriteItem[]) => setItems(d))
      .catch(() => setItems([]))
  }, [token])

  if (!items || items.length === 0) return null

  return (
    <div className="rounded-3xl p-5 sm:p-6" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)' }}>
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(24,22,15,0.38)' }}>
        Your usual
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: '#18160f' }}>
        Order again, fast
      </h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
        {items.slice(0, 6).map((it) => (
          <Link
            key={it.menuItemId}
            href={it.concept ? `/${it.concept.slug}` : '/browse'}
            className="rounded-xl p-3 text-left transition-all hover:scale-[1.01]"
            style={{ background: 'rgba(0,0,0,0.025)', border: '1px solid rgba(0,0,0,0.05)' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: 'rgba(24,22,15,0.4)' }}>
              {it.concept?.name ?? 'Brand'}
            </div>
            <div className="font-bold text-sm mt-0.5 line-clamp-2" style={{ color: '#18160f' }}>
              {it.name}
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs" style={{ color: 'rgba(24,22,15,0.55)' }}>
                Ordered {it.timesOrdered}×
              </span>
              <span className="text-sm font-black" style={{ color: '#22c55e' }}>
                Rs. {(it.priceCents / 100).toFixed(0)}
              </span>
            </div>
            {!it.isAvailable && (
              <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wider"
                style={{ color: '#dc2626' }}>
                Currently unavailable
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  )
}

// ─── Support / complaints inline section ───────────────────────────────────
function SupportSection({ orders }: { orders: Order[] }) {
  const [open, setOpen] = useState(false)
  const [orderId, setOrderId] = useState('')
  const [category, setCategory] = useState<'wrong_item' | 'missing_item' | 'quality' | 'service' | 'delivery' | 'other'>('quality')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!title.trim() || !description.trim()) return
    setSubmitting(true)
    setError(null)
    try {
      const order = orders.find((o) => o.id === orderId)
      const res = await fetch(`${API_URL}/api/v1/complaints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: orderId || undefined,
          conceptId: order?.concept ? (order as Order & { conceptId?: string }).conceptId ?? undefined : undefined,
          title: title.trim(),
          description: description.trim(),
          category,
          priority: 'medium',
        }),
      })
      if (!res.ok) throw new Error('Could not submit')
      setSuccess(true)
      setTitle(''); setDescription(''); setOrderId('')
      setTimeout(() => setSuccess(false), 4000)
    } catch (e) {
      setError((e as Error).message)
    } finally { setSubmitting(false) }
  }

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 mb-2.5">
        <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'rgba(24,22,15,0.38)' }}>Need help?</p>
        <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
      </div>

      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="w-full rounded-2xl p-4 text-left transition-all hover:scale-[1.005]"
          style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-black text-sm" style={{ color: '#18160f' }}>🎫 Raise an issue</p>
              <p className="text-xs mt-0.5" style={{ color: 'rgba(24,22,15,0.45)' }}>
                Wrong item, late delivery, quality concern — we&apos;ll fix it.
              </p>
            </div>
            <span className="text-xs font-bold" style={{ color: '#16a34a' }}>Open form →</span>
          </div>
        </button>
      ) : (
        <div className="rounded-2xl p-5 space-y-3"
          style={{ background: '#fff', border: '1px solid rgba(34,197,94,0.25)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          <div className="flex items-center justify-between">
            <p className="font-black text-sm" style={{ color: '#18160f' }}>Tell us what went wrong</p>
            <button onClick={() => setOpen(false)} className="text-xs" style={{ color: 'rgba(24,22,15,0.4)' }}>Close</button>
          </div>

          {success && (
            <div className="rounded-xl px-3 py-2 text-xs font-bold"
              style={{ background: 'rgba(34,197,94,0.1)', color: '#16a34a', border: '1px solid rgba(34,197,94,0.25)' }}>
              ✓ Got it — a manager will reach out within 24 hours.
            </div>
          )}

          <div>
            <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>Related order (optional)</label>
            <select value={orderId} onChange={(e) => setOrderId(e.target.value)}
              className="mt-1 w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
              style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)' }}>
              <option value="">— No specific order —</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.concept.name} · #{o.id.slice(-8).toUpperCase()} · {fmt(o.totalCents)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>Category</label>
            <div className="mt-1 grid grid-cols-3 gap-1.5">
              {([
                { key: 'wrong_item',    label: 'Wrong item',    emoji: '❌' },
                { key: 'missing_item',  label: 'Missing item',  emoji: '🤷' },
                { key: 'quality',       label: 'Quality',       emoji: '😞' },
                { key: 'service',       label: 'Service',       emoji: '🤨' },
                { key: 'delivery',      label: 'Delivery',      emoji: '🛵' },
                { key: 'other',         label: 'Other',         emoji: '💬' },
              ] as const).map((c) => (
                <button key={c.key} onClick={() => setCategory(c.key)}
                  className="rounded-xl px-2 py-2 text-xs font-bold transition-all flex flex-col items-center gap-1"
                  style={category === c.key
                    ? { background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.35)', color: '#16a34a' }
                    : { background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)', color: 'rgba(24,22,15,0.6)' }}>
                  <span>{c.emoji}</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>Title *</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Karahi was cold on arrival"
              maxLength={200}
              className="mt-1 w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
              style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)' }} />
          </div>

          <div>
            <label className="text-[10px] font-black uppercase tracking-wide" style={{ color: 'rgba(15,26,15,0.45)' }}>What happened? *</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="More detail helps us fix it for everyone…"
              className="mt-1 w-full rounded-xl px-3 py-2 text-sm focus:outline-none resize-none"
              style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)' }} />
          </div>

          {error && (
            <p className="text-xs" style={{ color: '#dc2626' }}>{error}</p>
          )}

          <button onClick={() => void submit()} disabled={submitting || !title.trim() || !description.trim()}
            className="w-full rounded-xl py-2.5 text-sm font-black transition-all disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg, #22c55e, #16a34a)', color: '#fff' }}>
            {submitting ? 'Sending…' : 'Send to manager'}
          </button>
        </div>
      )}
    </div>
  )
}
