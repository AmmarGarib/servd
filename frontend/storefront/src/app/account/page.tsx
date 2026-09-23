'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'
import { LoadingScreen } from '../../components/ui/Loader'
import { fmt } from '../../lib/ui'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Order {
  id: string; status: string; totalCents: number; placedAt: string
  concept: { name: string; slug: string }
  items: Array<{ name: string; quantity: number }>
}
interface LoyaltyAccount { pointsBalance: number; tier: string }
interface LoyaltyTransaction {
  id: string
  type: 'earn' | 'redeem' | 'expire' | 'adjust'
  pointsDelta: number
  description: string | null
  createdAt: string
  orderId: string | null
}
interface CustomerProfile {
  name: string | null; email: string | null; phone: string | null
  phoneVerifiedAt?: string | null; emailVerifiedAt?: string | null
  referralCode?: string | null
  loyaltyAccount: LoyaltyAccount | null; orders: Order[]
}
interface CustomerAddress {
  id: string; label: string; address: string; lat?: number | null; lng?: number | null; isDefault: boolean
}

// STATUS_CONFIG moved to lib/orderStatus.ts so /orders + /[concept]/order/[id]
// share the same colours and labels. statusFor handles unknown statuses.
import { statusFor } from '../../lib/orderStatus'
const TIER_COLOR: Record<string, string> = { bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffd700' }
const TIER_THRESHOLDS = [
  { name: 'bronze', label: 'Bronze', nextAt: 1000 },
  { name: 'silver', label: 'Silver', nextAt: 5000 },
  { name: 'gold',   label: 'Gold',   nextAt: null },
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

  const fetchAccount = useCallback(() => {
    if (!token) return
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
      .then(([prof, addrs]) => {
        if (prof) setProfile(prof)
        setAddresses(addrs as CustomerAddress[])
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [token, router, clearAuth])

  useEffect(() => {
    if (!token) { router.replace('/login'); return }
    fetchAccount()
  }, [token, router, fetchAccount])

  // Re-fetch loyalty balance when tab regains focus (catches post-checkout state).
  useEffect(() => {
    const handleFocus = () => { fetchAccount() }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [fetchAccount])

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
    <main className="flex min-h-dvh items-center justify-center" style={{ background: 'transparent' }}>
      <LoadingScreen label="Loading account…" minHeight="auto" />
    </main>
  )

  if (error || !profile) return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4"
      style={{ background: 'transparent' }}>
      <div className="text-5xl">⚠</div>
      <p className="text-sm" style={{ color: '#dc2626' }}>{error || 'Account not found'}</p>
      <Link href="/browse"
        className="rounded-2xl font-black px-8 py-3.5 text-sm transition-all hover:scale-[1.02]"
        style={{ background: 'var(--servd-green)', color: '#fff', boxShadow: '0 4px 20px rgba(58,14,105,0.3)' }}>
        Browse brands
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
    <main className="min-h-dvh pb-16 relative" style={{ background: 'transparent' }}>

      {/* Subtle tier color accent */}
      <div className="fixed pointer-events-none select-none" style={{
        top: '-60px', right: '-40px', width: '380px', height: '380px',
        background: `radial-gradient(circle, ${tc}14 0%, transparent 70%)`,
      }} />

      {/* Header */}
      <div className="relative z-10 px-4 pt-5 pb-4 flex items-center justify-between"
        style={{ borderBottom: '1px solid rgba(22,163,74,0.12)', background: 'rgba(240,253,244,0.96)', backdropFilter: 'blur(20px)' }}>
        <Link href="/browse"
          className="flex items-center gap-1.5 text-sm font-semibold transition-colors"
          style={{ color: 'var(--servd-mute)' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--servd-ink)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--servd-mute)')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Browse brands
        </Link>
        <button onClick={() => { clearAuth(); router.replace('/browse') }}
          className="text-xs font-bold transition-colors px-3 py-1.5 rounded-xl"
          style={{ color: 'var(--servd-mute)', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; e.currentTarget.style.background = 'rgba(239,68,68,0.1)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--servd-mute)'; e.currentTarget.style.background = 'rgba(239,68,68,0.06)' }}>
          Sign out
        </button>
      </div>

      <div className="relative z-10 max-w-lg lg:max-w-3xl mx-auto px-4 pt-6 pb-6" style={{ animation: 'revealUp 0.5s both' }}>

        {/* ── Greeting ── */}
        <div className="mb-5">
          <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>Your account</p>
          <h1 className="font-display font-black text-3xl leading-tight tracking-tight mt-0.5" style={{ fontFamily: 'var(--font-display)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>
            {firstName ? `Hi, ${firstName}.` : 'Welcome back.'}
          </h1>
        </div>

        {/* ── Unverified contact — the second channel for when WhatsApp drops ── */}
        {token && (
          <VerifyContactBanner token={token} profile={profile} onVerified={fetchAccount} />
        )}

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
              style={{ background: 'var(--servd-green)' }} />
            <div className="p-4 flex flex-col items-center text-center gap-3 h-full pb-5">
              <div className="h-16 w-16 rounded-2xl flex items-center justify-center font-black text-2xl text-white mt-1"
                style={{ background: 'var(--servd-green)', boxShadow: '0 0 20px rgba(58,14,105,0.28)' }}>
                {initials}
              </div>
              <div>
                <p className="font-black text-sm leading-tight" style={{ color: 'var(--servd-ink)' }}>{profile.name ?? 'Guest'}</p>
                <p className="text-[0.6rem] mt-0.5 truncate max-w-[120px]" style={{ color: 'var(--servd-mute)' }}>
                  {profile.email ?? profile.phone ?? '—'}
                </p>
              </div>
              {totalOrders > 0 && (
                <div className="w-full rounded-xl py-2 px-3 mt-auto"
                  style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.06)' }}>
                  <p className="font-black text-lg leading-none" style={{ color: 'var(--servd-ink)' }}>{totalOrders}</p>
                  <p className="text-[0.55rem] font-black uppercase tracking-wider mt-0.5" style={{ color: 'var(--servd-mute)' }}>orders</p>
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
                  <p className="text-[0.55rem] uppercase tracking-[0.28em] font-black" style={{ color: 'var(--servd-mute)' }}>Points</p>
                  <span className="text-[0.55rem] font-black uppercase tracking-wider px-2 py-0.5 rounded-full"
                    style={{ background: `${tc}1e`, color: tc }}>
                    {current?.label ?? tier}
                  </span>
                </div>
                <p className="font-black leading-none tabular-nums" style={{ fontSize: 'clamp(2rem, 9vw, 3.2rem)', color: 'var(--servd-ink)' }}>
                  {pts.toLocaleString()}
                </p>
                <p className="text-[0.6rem] mt-1" style={{ color: 'var(--servd-mute)' }}>≈ {fmt(pts * 10)} value</p>

                <div className="mt-auto pt-3">
                  {next ? (
                    <>
                      <div className="h-1 rounded-full overflow-hidden mb-1"
                        style={{ background: 'rgba(0,0,0,0.07)' }}>
                        <div className="h-full rounded-full transition-all duration-1000"
                          style={{ width: `${progress}%`, background: `linear-gradient(90deg, ${tc}88, ${tc})` }} />
                      </div>
                      <p className="text-[0.55rem]" style={{ color: 'var(--servd-mute)' }}>
                        {(next.nextAt! - pts).toLocaleString()} pts to {next.label}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs font-black inline-flex items-center gap-1.5" style={{ color: tc }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path d="M6 9V2h12v7c0 2.21-1.79 4-4 4h-1v3l3 1v3H8v-3l3-1v-3h-1c-2.21 0-4-1.79-4-4z"/>
                      </svg>
                      Top tier
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 rounded-2xl p-4 flex flex-col justify-center items-center text-center gap-2"
              style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ color: 'var(--servd-green-dark)' }} aria-hidden="true">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
              <p className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>No loyalty yet</p>
              <p className="text-xs" style={{ color: 'var(--servd-mute)' }}>Place an order to start earning</p>
            </div>
          )}
        </div>

        {/* ── Lifetime spend stat ── */}
        {totalOrders > 0 && (
          <div className="rounded-2xl px-5 py-3.5 mb-3 flex items-center justify-between"
            style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
            <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>Lifetime spend</p>
            <p className="font-black text-lg" style={{ color: 'var(--servd-ink)' }}>{fmt(lifetimeSpend)}</p>
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
              style={{ background: 'rgba(58,14,105,0.1)', color: 'var(--servd-green-dark)', border: '1px solid rgba(58,14,105,0.2)' }}>
              + Add
            </button>
          </div>

          {showAddAddr && (
            <div className="rounded-2xl p-4 mb-3 space-y-3"
              style={{ background: '#fff', border: '1px solid rgba(58,14,105,0.2)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
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
                  style={{ background: 'var(--servd-green)', color: 'white' }}>
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
              style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--servd-mute)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline-block', marginBottom: '0.5rem' }} aria-hidden="true">
                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                <circle cx="12" cy="10" r="3"/>
              </svg>
              <p className="text-sm font-semibold" style={{ color: 'var(--servd-ink)' }}>No saved locations yet</p>
              <p className="text-xs mt-1" style={{ color: 'var(--servd-mute)' }}>Add your home, work or favourite spots for quick ordering</p>
            </div>
          ) : (
            <div className="space-y-2">
              {addresses.map((addr) => (
                <div key={addr.id} className="rounded-2xl p-4 flex items-center gap-3"
                  style={{ background: 'white', border: addr.isDefault ? '1px solid rgba(58,14,105,0.3)' : '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
                  <div className="h-9 w-9 rounded-xl flex items-center justify-center shrink-0"
                    style={{ background: addr.isDefault ? 'rgba(58,14,105,0.12)' : 'var(--servd-surface)', color: addr.isDefault ? 'var(--servd-green-dark)' : 'var(--servd-mute)' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
                      <circle cx="12" cy="10" r="3"/>
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="font-black text-sm" style={{ color: '#0f1a0f' }}>{addr.label}</p>
                      {addr.isDefault && (
                        <span className="text-[9px] font-black uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                          style={{ background: 'rgba(58,14,105,0.12)', color: 'var(--servd-green-dark)' }}>Default</span>
                      )}
                    </div>
                    <p className="text-xs line-clamp-1 mt-0.5" style={{ color: 'rgba(15,26,15,0.45)' }}>{addr.address}</p>
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {!addr.isDefault && (
                      <button onClick={() => void setDefault(addr.id)}
                        className="text-[10px] font-bold transition-colors"
                        style={{ color: 'var(--servd-green-dark)' }}>
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

        {/* ── How to earn more ── */}
        <div className="mb-3 rounded-2xl p-4"
          style={{ background: 'linear-gradient(135deg, rgba(58,14,105,0.06) 0%, rgba(58,14,105,0.06) 100%)', border: '1px solid rgba(58,14,105,0.15)' }}>
          <div className="flex items-center gap-2 mb-2">
            <p className="text-[9px] font-black uppercase tracking-[0.28em]"
              style={{ color: 'var(--servd-mute)' }}>How to earn</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              {
                title: 'Order', desc: '1 pt per Rs. 10 spent',
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                  </svg>
                ),
              },
              {
                title: 'Review', desc: '+50 pts per review',
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                ),
              },
              {
                title: 'Refer', desc: '+200 pts per friend',
                icon: (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                    <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                ),
              },
            ].map((tip, i) => (
              <div key={tip.title}
                className="rounded-xl p-3 flex flex-col gap-1.5"
                style={{
                  background: 'rgba(255,255,255,0.7)',
                  border: '1px solid rgba(58,14,105,0.12)',
                  animation: `revealUp 0.4s ${i * 0.06}s both`,
                  color: 'var(--servd-green-dark)',
                }}>
                {tip.icon}
                <p className="font-black text-[0.72rem] leading-tight" style={{ color: 'var(--servd-ink)' }}>{tip.title}</p>
                <p className="text-[0.6rem] leading-snug" style={{ color: 'var(--servd-mute)' }}>{tip.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Order history ── */}
        <div>
          <div className="flex items-center gap-2 mb-2.5">
            <p className="text-[9px] font-black uppercase tracking-[0.28em]"
              style={{ color: 'var(--servd-mute)' }}>Order History</p>
            <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
          </div>

          {profile.orders.length === 0 ? (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--servd-mute)"
                strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                style={{ margin: '0 auto 0.75rem' }}>
                <path d="M3 11h18"/>
                <path d="M12 11v9"/>
                <path d="M5 11a7 7 0 0 1 14 0"/>
                <path d="M3 20h18"/>
              </svg>
              <p className="text-sm" style={{ color: 'var(--servd-mute)' }}>No orders yet</p>
              <Link href="/browse"
                className="inline-block mt-3 text-sm font-bold transition-colors"
                style={{ color: 'var(--servd-green-dark)' }}>
                Browse brands →
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {profile.orders.map((order, i) => {
                const sc = statusFor(order.status)
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
                            <p className="font-bold text-sm" style={{ color: 'var(--servd-ink)' }}>{order.concept.name}</p>
                            <span className="text-[9px] font-black uppercase tracking-[0.18em] px-2 py-0.5 rounded-full"
                              style={{ background: sc.bg, color: sc.text }}>
                              {sc.label}
                            </span>
                          </div>
                          <p className="text-[10px] font-mono mb-1.5" style={{ color: 'var(--servd-dim)' }}>
                            #{order.id.slice(-8).toUpperCase()} · {new Date(order.placedAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short' })}
                          </p>
                          <p className="text-xs line-clamp-1" style={{ color: 'var(--servd-mute)' }}>
                            {order.items.map(it => `${it.quantity}× ${it.name}`).join(', ')}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>{fmt(order.totalCents)}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: 'var(--servd-dim)' }}>→</p>
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

        {/* ── Loyalty transaction history ── */}
        {profile.loyaltyAccount && <LoyaltyTransactionsSection token={token} />}

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
          style={{ background: '#7c2d12', color: '#0a0a0a' }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={shareNative}
          className="flex-1 rounded-xl px-3 py-2.5 text-xs font-bold"
          style={{ background: 'var(--servd-green)', color: 'white' }}>
          Share invite link
        </button>
        <a href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
          target="_blank" rel="noopener noreferrer"
          className="flex-1 rounded-xl px-3 py-2.5 text-xs font-bold text-center"
          style={{ background: '#25D366', color: '#0a0a0a' }}>
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

// ─── Loyalty transaction history ─────────────────────────────────────────────
// Fetches the full loyalty account (with transactions) from the loyalty module.
// Shows last 10 transactions: earn (+green) / redeem (-red) / other.
// Rendered as a collapsible panel below the referral section, only when the
// customer has a loyalty account.

interface LoyaltyAccountFull {
  pointsBalance: number
  tier: string
  transactions: LoyaltyTransaction[]
}

function LoyaltyTransactionsSection({ token }: { token: string | null }) {
  const [account, setAccount] = useState<LoyaltyAccountFull | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/loyalty/account`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() as Promise<LoyaltyAccountFull> : null))
      .then((d) => setAccount(d))
      .catch(() => {})
  }, [token])

  if (!account || account.transactions.length === 0) return null

  const recent = account.transactions.slice(0, 10)

  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 mb-2.5">
        <p className="text-[9px] font-black uppercase tracking-[0.28em]"
          style={{ color: 'var(--servd-mute)' }}>Points History</p>
        <div className="h-px flex-1" style={{ background: 'rgba(0,0,0,0.07)' }} />
        <button
          onClick={() => setOpen(!open)}
          className="text-[10px] font-black px-2.5 py-1 rounded-full transition-all"
          style={{ background: 'rgba(58,14,105,0.1)', color: 'var(--servd-green-dark)', border: '1px solid rgba(58,14,105,0.2)' }}>
          {open ? 'Hide' : `Show ${recent.length}`}
        </button>
      </div>

      {open && (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          {recent.map((tx, i) => {
            const isEarn   = tx.pointsDelta > 0
            const isRedeem = tx.pointsDelta < 0
            const pts      = Math.abs(tx.pointsDelta)
            return (
              <div key={tx.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
                style={{
                  borderBottom: i < recent.length - 1 ? '1px solid rgba(0,0,0,0.05)' : 'none',
                }}>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="h-7 w-7 rounded-xl flex items-center justify-center shrink-0 text-xs"
                    style={{
                      background: isEarn ? 'rgba(58,14,105,0.1)' : isRedeem ? 'rgba(239,68,68,0.1)' : 'rgba(0,0,0,0.05)',
                    }}>
                    {isEarn ? '↑' : isRedeem ? '↓' : '~'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold truncate" style={{ color: 'var(--servd-ink)' }}>
                      {tx.description ?? (isEarn ? 'Points earned' : isRedeem ? 'Points redeemed' : 'Adjustment')}
                    </p>
                    <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--servd-mute)' }}>
                      {new Date(tx.createdAt).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                </div>
                <span className="font-black text-sm shrink-0 tabular-nums"
                  style={{ color: isEarn ? 'var(--servd-green-dark)' : isRedeem ? '#dc2626' : 'var(--servd-mute)' }}>
                  {isEarn ? '+' : isRedeem ? '−' : ''}{pts.toLocaleString()} pts
                </span>
              </div>
            )
          })}
        </div>
      )}
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
  const [cancelling, setCancelling] = useState<string | null>(null)  // reservationId being cancelled
  const [cancelled,  setCancelled]  = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!token) return
    fetch(`${API_URL}/api/v1/storefront/my-reservations`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MyReservationsResponse | null) => setData(d))
      .catch(() => {})
  }, [token])

  async function cancelReservation(reservationId: string, confirmToken: string | null) {
    if (!confirmToken) return
    setCancelling(reservationId)
    try {
      const res = await fetch(`${API_URL}/api/v1/reservations/public/${confirmToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
      if (res.ok) {
        setCancelled((prev) => new Set([...prev, reservationId]))
      }
    } catch { /* network error — silent */ }
    finally { setCancelling(null) }
  }

  if (!data) return null
  if (data.upcoming.length === 0 && data.past.length === 0) return null  // hide entirely if empty

  const fmtDate = (iso: string) => new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })

  return (
    <div className="rounded-3xl p-5 sm:p-6 mt-3" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.06)' }}>
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'var(--servd-mute)' }}>
        My bookings
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: 'var(--servd-ink)' }}>
        {data.upcoming.filter((r) => !cancelled.has(r.id)).length > 0 ? `${data.upcoming.filter((r) => !cancelled.has(r.id)).length} upcoming` : 'Past visits'}
      </h3>

      {data.upcoming.length > 0 && (
        <div className="space-y-2 mb-4">
          {data.upcoming.map((r) => {
            const isCancelled = cancelled.has(r.id)
            const isCancelling = cancelling === r.id
            const canCancel = (r.status === 'booked' || r.status === 'confirmed') && !!r.confirmToken && !isCancelled

            return (
              <div key={r.id} className="rounded-xl p-3 flex items-start gap-3"
                style={{
                  background: isCancelled ? 'rgba(239,68,68,0.05)' : 'rgba(58,14,105,0.05)',
                  border: isCancelled ? '1px solid rgba(239,68,68,0.15)' : '1px solid rgba(58,14,105,0.15)',
                  opacity: isCancelled ? 0.65 : 1,
                }}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-sm">{r.concept.name}</span>
                    {r.isVip && <span className="text-[10px] font-bold text-amber-600">★ VIP</span>}
                    <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 rounded-full"
                      style={{
                        background: isCancelled
                          ? 'rgba(239,68,68,0.15)'
                          : r.status === 'confirmed' ? 'rgba(20,184,166,0.15)' : 'rgba(59,130,246,0.15)',
                        color: isCancelled
                          ? '#dc2626'
                          : r.status === 'confirmed' ? '#0d9488' : '#2563eb',
                      }}>
                      {isCancelled ? 'Cancelled' : r.status}
                    </span>
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--servd-mute)' }}>
                    Party of {r.partySize} · {fmtDate(r.startTime)}
                    {r.table ? ` · table ${r.table.label}` : ''}
                  </div>
                  {r.notes && !isCancelled && (
                    <div className="text-[10px] mt-1 italic" style={{ color: 'var(--servd-mute)' }}>{r.notes}</div>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  {r.confirmToken && r.status === 'booked' && !isCancelled && (
                    <Link href={`/reserve/confirm/${r.confirmToken}`}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap text-center"
                      style={{ background: 'var(--servd-green)', color: 'white' }}>
                      Confirm
                    </Link>
                  )}
                  {canCancel && (
                    <button
                      onClick={() => void cancelReservation(r.id, r.confirmToken)}
                      disabled={isCancelling}
                      className="rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap transition-all disabled:opacity-50"
                      style={{ background: 'rgba(239,68,68,0.08)', color: '#dc2626', border: '1px solid rgba(239,68,68,0.2)' }}>
                      {isCancelling ? 'Cancelling…' : 'Cancel'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {data.past.length > 0 && (
        <details>
          <summary className="text-xs font-bold cursor-pointer" style={{ color: 'var(--servd-mute)' }}>
            Past visits ({data.past.length})
          </summary>
          <div className="space-y-1.5 mt-2">
            {data.past.slice(0, 8).map((r) => (
              <div key={r.id} className="text-xs flex items-center justify-between py-1"
                style={{ color: 'var(--servd-mute)' }}>
                <span>{r.concept.name} · {r.partySize}px</span>
                <span>{fmtDate(r.startTime)}</span>
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
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'var(--servd-mute)' }}>
        My reviews
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: 'var(--servd-ink)' }}>
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
              <p className="text-xs mt-1.5" style={{ color: 'var(--servd-ink)' }}>{r.comment}</p>
            )}
            {r.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {r.tags.map((t) => (
                  <span key={t} className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(58,14,105,0.1)', color: '#15803d' }}>{t}</span>
                ))}
              </div>
            )}
            {r.managerResponse && (
              <div className="mt-2.5 pl-2.5 border-l-2 text-xs" style={{ borderColor: 'var(--servd-green)', color: 'var(--servd-ink)' }}>
                <div className="font-bold mb-0.5" style={{ color: 'var(--servd-green-dark)' }}>From the team:</div>
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
      <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'var(--servd-mute)' }}>
        Your usual
      </p>
      <h3 className="text-lg font-black mt-1 mb-3" style={{ color: 'var(--servd-ink)' }}>
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
              style={{ color: 'var(--servd-mute)' }}>
              {it.concept?.name ?? 'Brand'}
            </div>
            <div className="font-bold text-sm mt-0.5 line-clamp-2" style={{ color: 'var(--servd-ink)' }}>
              {it.name}
            </div>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs" style={{ color: 'var(--servd-mute)' }}>
                Ordered {it.timesOrdered}×
              </span>
              <span className="text-sm font-black" style={{ color: 'var(--servd-green)' }}>
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
        <p className="text-[9px] font-black uppercase tracking-[0.28em]" style={{ color: 'var(--servd-mute)' }}>Need help?</p>
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
              <p className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>🎫 Raise an issue</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--servd-mute)' }}>
                Wrong item, late delivery, quality concern — we&apos;ll fix it.
              </p>
            </div>
            <span className="text-xs font-bold" style={{ color: 'var(--servd-green-dark)' }}>Open form →</span>
          </div>
        </button>
      ) : (
        <div className="rounded-2xl p-5 space-y-3"
          style={{ background: '#fff', border: '1px solid rgba(58,14,105,0.25)', boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}>
          <div className="flex items-center justify-between">
            <p className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>Tell us what went wrong</p>
            <button onClick={() => setOpen(false)} className="text-xs" style={{ color: 'var(--servd-mute)' }}>Close</button>
          </div>

          {success && (
            <div className="rounded-xl px-3 py-2 text-xs font-bold"
              style={{ background: 'rgba(58,14,105,0.1)', color: 'var(--servd-green-dark)', border: '1px solid rgba(58,14,105,0.25)' }}>
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
                { key: 'wrong_item',    label: 'Wrong item'    },
                { key: 'missing_item',  label: 'Missing item'  },
                { key: 'quality',       label: 'Quality'       },
                { key: 'service',       label: 'Service'       },
                { key: 'delivery',      label: 'Delivery'      },
                { key: 'other',         label: 'Other'         },
              ] as const).map((c) => (
                <button key={c.key} onClick={() => setCategory(c.key)}
                  className="rounded-xl px-2 py-3 text-xs font-bold transition-all flex items-center justify-center text-center"
                  style={category === c.key
                    ? { background: 'rgba(58,14,105,0.1)', border: '1px solid rgba(58,14,105,0.35)', color: 'var(--servd-green-dark)' }
                    : { background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.08)', color: 'var(--servd-mute)' }}>
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
            style={{ background: 'var(--servd-green)', color: 'white' }}>
            {submitting ? 'Sending…' : 'Send to manager'}
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Verify-later ────────────────────────────────────────────────────────────
// Signup verifies every channel a code reached. If WhatsApp (or email) was down
// at the time, that channel is left unverified — this is how it gets finished.
// One channel at a time, so the customer is never juggling two codes here.
function VerifyContactBanner({ token, profile, onVerified }: {
  token: string
  profile: CustomerProfile
  onVerified: () => void
}) {
  const pending: Array<'phone' | 'email'> = []
  if (profile.phone && !profile.phoneVerifiedAt) pending.push('phone')
  if (profile.email && !profile.emailVerifiedAt) pending.push('email')
  const [active, setActive] = useState<'phone' | 'email' | null>(null)
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  if (pending.length === 0) return null

  const call = async (path: string, body: object) => {
    const res = await fetch(`${API_URL}/api/v1/auth/customer/contact/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({})) as { error?: { message?: string } }
    if (!res.ok) throw new Error(data.error?.message ?? 'Something went wrong')
    return data
  }

  const send = async (channel: 'phone' | 'email') => {
    setBusy(true); setMsg('')
    try { await call('request', { channel }); setActive(channel); setCode('') }
    catch (e) { setMsg((e as Error).message) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!active) return
    setBusy(true); setMsg('')
    try { await call('confirm', { channel: active, code }); setActive(null); setCode(''); onVerified() }
    catch (e) { setMsg((e as Error).message) }
    finally { setBusy(false) }
  }

  const labelFor = (c: 'phone' | 'email') => c === 'phone' ? `WhatsApp (${profile.phone})` : `email (${profile.email})`
  return (
    <div className="mb-4 rounded-2xl p-4" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.08)' }}>
      <p className="font-black text-sm" style={{ color: 'var(--servd-ink)' }}>Finish verifying your account</p>
      <p className="text-xs mt-1" style={{ color: 'var(--servd-mute)' }}>
        We keep two ways to reach you, so order updates and sign-in codes still arrive if one is down.
      </p>
      {active === null ? (
        <div className="flex flex-wrap gap-2 mt-3">
          {pending.map((c) => (
            <button key={c} disabled={busy} onClick={() => { void send(c) }}
              className="text-xs font-bold px-3 py-2 rounded-xl disabled:opacity-50"
              style={{ background: 'var(--servd-green)', color: '#fff' }}>
              Verify {labelFor(c)}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2 mt-3">
          <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" placeholder={`Code from ${active === 'phone' ? 'WhatsApp' : 'email'}`}
            aria-label="Verification code"
            className="flex-1 min-w-0 px-3 py-2 rounded-xl text-sm" style={{ border: '1px solid rgba(0,0,0,0.15)' }} />
          <button disabled={busy || code.length < 6} onClick={() => { void confirm() }}
            className="text-xs font-bold px-3 py-2 rounded-xl disabled:opacity-50"
            style={{ background: 'var(--servd-green)', color: '#fff' }}>
            Verify
          </button>
        </div>
      )}
      {msg && <p className="text-xs mt-2" style={{ color: '#dc2626' }}>{msg}</p>}
    </div>
  )
}
