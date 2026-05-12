'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'
const STOREFRONT_URL  = process.env['NEXT_PUBLIC_STOREFRONT_URL']  ?? 'http://localhost:3002'

type Mode = 'pin' | 'signup'

/**
 * The single staff login page. Two modes:
 *
 *   pin    — Default. Every active staff member signs in with a 4-digit PIN.
 *            The CEO's PIN is 1973; every other staff PIN is the last 4 digits
 *            of the phone number they registered.
 *
 *   signup — A new hire fills name, email, phone, role. We create a User row
 *            with status='pending'; PIN is auto-derived from their phone.
 *            The CEO sees them in the pending-approvals list and flips them
 *            active, after which their PIN works.
 *
 * No email/password login at all — the CEO doesn't want it, and the PIN flow
 * is uniform across kitchen, FOH, and back-office.
 */
export default function StaffLoginPage() {
  const router  = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [mode, setMode] = useState<Mode>('pin')

  // ── PIN state
  const [pin,     setPin]     = useState('')
  const [error,   setError]   = useState('')
  const [status,  setStatus]  = useState('')
  const [loading, setLoading] = useState(false)

  // ── Signup state
  const [name,        setName]        = useState('')
  const [email,       setEmail]       = useState('')
  const [phone,       setPhone]       = useState('')
  const [role,        setRole]        = useState<'manager' | 'cashier' | 'kitchen' | 'expediter' | 'marketing'>('cashier')
  const [reason,      setReason]      = useState('')
  const [signupDone,  setSignupDone]  = useState<{ name: string; pin: string } | null>(null)

  async function getCoords(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        ()    => resolve(null),
        { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: true },
      )
    })
  }

  async function submitPin(pinVal: string) {
    setError(''); setLoading(true)
    setStatus('Getting your location…')
    const coords = await getCoords()
    setStatus('Signing in…')
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/pin`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ pin: pinVal, ...coords }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: { message?: string } }
        throw new Error(d.error?.message ?? 'PIN not recognised')
      }
      const data = await res.json() as { token: string; accessToken?: string; user: { id: string; name: string; role: string } }
      setAuth(data.user, data.accessToken ?? data.token)
      router.replace('/dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'PIN not recognised')
      setPin('')
    } finally {
      setLoading(false); setStatus('')
    }
  }

  async function submitSignup(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/staff/signup`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          role,
          ...(reason.trim() && { reason: reason.trim() }),
        }),
      })
      const data = await res.json() as { name?: string; phone?: string; error?: { message?: string; code?: string } }
      if (!res.ok) {
        throw new Error(data.error?.message ?? 'Could not create account')
      }
      // Compute the PIN the server derived (last 4 of phone) so we can show
      // it back to the new hire. They'll need it once approved.
      const derivedPin = phone.replace(/\D/g, '').slice(-4)
      setSignupDone({ name: data.name ?? name, pin: derivedPin })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create account')
    } finally {
      setLoading(false)
    }
  }

  function pressDigit(d: string) {
    if (pin.length >= 8 || loading) return
    const next = pin + d
    setPin(next)
    if (next.length >= 4) setTimeout(() => void submitPin(next), 120)
  }

  function pressBack() { if (!loading) setPin((p) => p.slice(0, -1)) }

  const PAD = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  // ── Signup-success screen ─────────────────────────────────────────────────
  if (mode === 'signup' && signupDone) {
    return (
      <div className="min-h-screen bg-s-bg flex flex-col items-center justify-center px-4">
        <div className="w-full max-w-sm rounded-3xl p-8 text-center"
          style={{ background: 'rgba(0,212,177,0.06)', border: '1px solid rgba(0,212,177,0.2)' }}>
          <p className="text-4xl mb-3">⏳</p>
          <h1 className="text-xl font-black text-s-text mb-2">Welcome, {signupDone.name}</h1>
          <p className="text-sm text-s-muted leading-relaxed mb-5">
            Your account is created and waiting for the CEO to approve it.
          </p>
          <div className="rounded-2xl p-4 mb-5"
            style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <p className="text-[10px] uppercase tracking-wider font-bold text-s-dim mb-1">Your PIN</p>
            <p className="text-3xl font-black tracking-[0.4em] text-s-text">{signupDone.pin}</p>
            <p className="text-[10px] text-s-dim mt-2">Last 4 digits of your phone — write it down.</p>
          </div>
          <button onClick={() => { setMode('pin'); setSignupDone(null); setName(''); setEmail(''); setPhone(''); setReason('') }}
            className="w-full rounded-xl py-3 text-sm font-black transition-all active:scale-[0.98]"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
            Back to PIN pad
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-s-bg flex flex-col">

      {/* Brand bar */}
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg flex items-center justify-center font-black text-white text-xs"
            style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', boxShadow: '0 0 14px rgba(0,212,177,0.3)' }}>
            S
          </div>
          <span className="text-sm font-black tracking-tight text-s-text">servd</span>
        </div>
        <a href={STOREFRONT_URL} className="text-xs text-s-dim hover:text-s-muted transition-colors">
          Order food →
        </a>
      </div>

      {/* Centre card */}
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-xs">

          {/* Title */}
          <div className="text-center mb-8">
            <p className="text-[11px] font-bold text-s-muted uppercase tracking-[0.25em] mb-2">
              Staff Portal
            </p>
            <h1 className="text-2xl font-black text-s-text">
              {mode === 'pin' ? 'Enter your PIN' : 'Apply to join'}
            </h1>
            <p className="text-xs text-s-dim mt-1">
              {mode === 'pin' ? 'Authorized personnel only' : 'CEO will review your request'}
            </p>
          </div>

          {mode === 'pin' ? (
            <>
              {/* PIN dots */}
              <div className="flex justify-center gap-3 mb-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i}
                    className="h-3 w-3 rounded-full border-2 transition-all duration-100"
                    style={{
                      background:   i < pin.length ? '#00D4B1'             : 'transparent',
                      borderColor:  i < pin.length ? '#00D4B1'             : 'rgba(255,255,255,0.15)',
                      transform:    i < pin.length ? 'scale(1.15)'         : 'scale(1)',
                      boxShadow:    i < pin.length ? '0 0 8px rgba(0,212,177,0.5)' : 'none',
                    }} />
                ))}
              </div>

              {/* Status / error */}
              <div className="h-6 flex items-center justify-center mb-4 px-2">
                {error ? (
                  <p className="text-xs text-s-red font-semibold text-center">{error}</p>
                ) : status ? (
                  <p className="text-xs text-s-muted">{status}</p>
                ) : null}
              </div>

              {/* Numpad */}
              <div className="grid grid-cols-3 gap-2.5">
                {PAD.map((key, idx) => {
                  if (key === '') return <div key={idx} />
                  if (key === '⌫') return (
                    <button key={idx} onClick={pressBack} disabled={loading || pin.length === 0}
                      aria-label="Delete last digit"
                      className="h-16 rounded-2xl border transition-all select-none"
                      style={{
                        background:   'rgba(255,255,255,0.04)',
                        borderColor:  'rgba(255,255,255,0.08)',
                        color:        'rgba(255,255,255,0.35)',
                        fontSize:     '18px',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.07)'; e.currentTarget.style.color = 'rgba(255,255,255,0.65)' }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; e.currentTarget.style.color = 'rgba(255,255,255,0.35)' }}>
                      ⌫
                    </button>
                  )
                  return (
                    <button key={idx} onClick={() => pressDigit(key)} disabled={loading}
                      aria-label={`Digit ${key}`}
                      className="h-16 rounded-2xl border font-bold text-xl transition-all select-none disabled:opacity-30"
                      style={{
                        background:  'rgba(255,255,255,0.04)',
                        borderColor: 'rgba(255,255,255,0.08)',
                        color:       'rgba(255,255,255,0.82)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background   = 'rgba(0,212,177,0.08)'
                        e.currentTarget.style.borderColor  = 'rgba(0,212,177,0.25)'
                        e.currentTarget.style.color        = '#00D4B1'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background   = 'rgba(255,255,255,0.04)'
                        e.currentTarget.style.borderColor  = 'rgba(255,255,255,0.08)'
                        e.currentTarget.style.color        = 'rgba(255,255,255,0.82)'
                      }}>
                      {key}
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <form onSubmit={(e) => { void submitSignup(e) }} className="space-y-3">
              <div className="h-6 flex items-center justify-center -mt-2 mb-1 px-2">
                {error && <p className="text-xs text-s-red font-semibold text-center">{error}</p>}
              </div>

              {([
                ['name',  'Full name',       'text', 'Your name',        name,  setName],
                ['email', 'Email',           'email','you@example.com',  email, setEmail],
                ['phone', 'Mobile (your PIN = last 4 digits)', 'tel', '0300 1234567', phone, setPhone],
              ] as const).map(([id, label, type, ph, val, set]) => (
                <div key={id}>
                  <label htmlFor={`signup-${id}`} className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
                    style={{ color: 'rgba(255,255,255,0.4)' }}>{label}</label>
                  <input id={`signup-${id}`} type={type} value={val} onChange={(e) => (set as (v: string) => void)(e.target.value)}
                    placeholder={ph} required autoComplete="off"
                    className="w-full rounded-xl px-4 py-3 text-sm font-semibold focus:outline-none transition-all"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }} />
                </div>
              ))}

              <div>
                <label htmlFor="signup-role" className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>Role</label>
                <select id="signup-role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}
                  className="w-full rounded-xl px-4 py-3 text-sm font-semibold focus:outline-none transition-all cursor-pointer"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }}>
                  <option value="manager">🧑‍💼 Manager</option>
                  <option value="cashier">💳 Cashier</option>
                  <option value="kitchen">🍳 Kitchen</option>
                  <option value="expediter">🪧 Expediter</option>
                  <option value="marketing">🚀 Marketing</option>
                </select>
              </div>

              <div>
                <label htmlFor="signup-reason" className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>Note to CEO (optional)</label>
                <textarea id="signup-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                  placeholder="e.g. starting Monday — head chef referral"
                  className="w-full rounded-xl px-4 py-3 text-sm font-semibold focus:outline-none transition-all resize-none"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }} />
              </div>

              <button type="submit" disabled={loading || !name || !email || !phone}
                className="w-full rounded-xl py-3.5 font-black text-sm transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={{
                  background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)',
                  color: '#000',
                  boxShadow: '0 4px 20px rgba(0,212,177,0.25)',
                }}>
                {loading ? 'Submitting…' : 'Submit for approval'}
              </button>
            </form>
          )}

          {/* Mode toggle */}
          <button type="button"
            onClick={() => { setMode((m) => m === 'pin' ? 'signup' : 'pin'); setError(''); setPin('') }}
            className="w-full mt-6 text-center text-xs font-bold transition-colors"
            style={{ color: 'rgba(255,255,255,0.4)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#00D4B1')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}>
            {mode === 'pin'
              ? 'New staff? Apply to join →'
              : '← Already approved? Back to PIN'}
          </button>

        </div>
      </div>
    </div>
  )
}
