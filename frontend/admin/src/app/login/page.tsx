'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'
const STOREFRONT_URL  = process.env['NEXT_PUBLIC_STOREFRONT_URL']  ?? 'http://localhost:3002'

type Mode = 'pin' | 'email'

export default function StaffLoginPage() {
  const router  = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [mode,    setMode]    = useState<Mode>('pin')
  const [pin,     setPin]     = useState('')
  const [email,   setEmail]   = useState('')
  const [password,setPassword]= useState('')
  const [error,   setError]   = useState('')
  const [status,  setStatus]  = useState('')   // status line shown while loading
  const [loading, setLoading] = useState(false)

  async function getCoords(): Promise<{ lat: number; lng: number } | null> {
    if (!navigator.geolocation) return null
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        ()    => resolve(null),   // denied or unavailable — let API decide
        { timeout: 8000, maximumAge: 60_000, enableHighAccuracy: true },
      )
    })
  }

  async function submitPin(pinVal: string) {
    setError(''); setLoading(true)

    // Try to get location (non-blocking — API enforces if config requires it)
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
        throw new Error(d.error?.message ?? 'Invalid PIN')
      }
      const data = await res.json() as { token: string; accessToken?: string; user: { id: string; name: string; role: string } }
      setAuth(data.user, data.accessToken ?? data.token)
      router.replace('/dashboard')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid PIN')
      setPin('')
    } finally {
      setLoading(false); setStatus('')
    }
  }

  // Email + password is the CEO / back-office sign-in path. Kitchen + cashier
  // staff use the PIN pad above. The page defaults to PIN since that's the
  // far more frequent flow on shared screens — the email form sits behind a
  // toggle to keep the visual weight on the numpad.
  async function submitEmailPassword(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true); setStatus('Signing in…')
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: email.trim(), password }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: { message?: string } }
        throw new Error(d.error?.message ?? 'Invalid email or password')
      }
      const data = await res.json() as { accessToken: string; refreshToken?: string; user: { id: string; name: string; role: string } }
      setAuth(data.user, data.accessToken, data.refreshToken)
      router.replace('/dashboard')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed')
      setPassword('')
    } finally {
      setLoading(false); setStatus('')
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
              {mode === 'pin' ? 'Enter your PIN' : 'Sign in'}
            </h1>
            <p className="text-xs text-s-dim mt-1">Authorized personnel only</p>
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
              <div className="h-6 flex items-center justify-center mb-4">
                {error ? (
                  <p className="text-xs text-s-red font-semibold text-center px-2">{error}</p>
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
                      className="h-16 rounded-2xl border transition-all active:scale-95 select-none"
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
                      className="h-16 rounded-2xl border font-bold text-xl transition-all active:scale-95 select-none disabled:opacity-30"
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
            <form onSubmit={(e) => { void submitEmailPassword(e) }} className="space-y-3">
              <div className="h-6 flex items-center justify-center -mt-2 mb-2">
                {error ? (
                  <p className="text-xs text-s-red font-semibold text-center px-2">{error}</p>
                ) : status ? (
                  <p className="text-xs text-s-muted">{status}</p>
                ) : null}
              </div>

              <div>
                <label htmlFor="login-email" className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>Email</label>
                <input id="login-email" type="email" autoComplete="username" required autoFocus
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl px-4 py-3.5 text-sm font-semibold focus:outline-none transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }} />
              </div>

              <div>
                <label htmlFor="login-password" className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5"
                  style={{ color: 'rgba(255,255,255,0.4)' }}>Password</label>
                <input id="login-password" type="password" autoComplete="current-password" required
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl px-4 py-3.5 text-sm font-semibold focus:outline-none transition-all"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1.5px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.9)' }} />
              </div>

              <button type="submit" disabled={loading || !email || !password}
                className="w-full rounded-xl py-3.5 font-black text-sm transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={{
                  background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)',
                  color: '#000',
                  boxShadow: '0 4px 20px rgba(0,212,177,0.25)',
                }}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}

          {/* Mode toggle — sits below the input area so it never steals the
              eye from the primary CTA. Kitchen/cashier stays on PIN; admin /
              CEO / back-office picks email. */}
          <button type="button"
            onClick={() => { setMode((m) => m === 'pin' ? 'email' : 'pin'); setError(''); setPin(''); setPassword('') }}
            className="w-full mt-6 text-center text-xs font-bold transition-colors"
            style={{ color: 'rgba(255,255,255,0.4)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#00D4B1')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}>
            {mode === 'pin'
              ? 'Admin / CEO? Sign in with email →'
              : '← Back to PIN pad'}
          </button>

        </div>
      </div>
    </div>
  )
}
