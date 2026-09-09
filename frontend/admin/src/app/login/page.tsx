'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { isExecutive } from '../../lib/appRoles'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'
const STOREFRONT_URL  = process.env['NEXT_PUBLIC_STOREFRONT_URL']  ?? 'http://localhost:3002'

type Mode = 'pin' | 'password' | 'signup' | 'twofactor'

/**
 * The single staff login page. Two modes:
 *
 *   pin    — Default. Staff sign in with a 4–8 digit PIN. Most staff use the
 *            last 4 digits of their registered phone; the CEO and any
 *            admin-issued PINs are 6 digits. The pad accepts up to 8 and
 *            submits on the explicit "Sign in" button (it deliberately does
 *            NOT auto-fire at 4 — that locked out longer-PIN users).
 *
 *   signup — A new hire fills name, email, phone, role. We create a User row
 *            with status='pending'; PIN is auto-derived from their phone.
 *            The CEO sees them in the pending-approvals list and flips them
 *            active, after which their PIN works.
 *
 *   password — Email + password. REQUIRED for owner, management and finance
 *            accounts: a 4-digit PIN typed on a shared tablet is fine for a
 *            line cook, but it must not mint a session that can read the P&L
 *            or run payroll, so the server refuses PIN login for those roles.
 *            Everyone else can use either.
 */
export default function StaffLoginPage() {
  const router  = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [mode, setMode] = useState<Mode>('pin')

  // ── Password state (owner / management / finance sign in this way)
  const [pwEmail,    setPwEmail]    = useState('')
  const [pwPassword, setPwPassword] = useState('')

  // Second-factor step. The challenge token is what the API handed back instead
  // of a session; the code is what arrives on WhatsApp. Neither is a credential
  // on its own — the challenge is only good for ten minutes and only for
  // /auth/2fa/verify.
  const [mfaChallenge, setMfaChallenge] = useState('')
  const [mfaHint,      setMfaHint]      = useState('')
  const [mfaCode,      setMfaCode]      = useState('')

  // ── PIN state
  const [pin,     setPin]     = useState('')
  const [pinName, setPinName] = useState('')   // staff name entered before the PIN
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
        credentials: 'include',                          // accept the httpOnly session cookie
        body:    JSON.stringify({ identifier: pinName.trim(), pin: pinVal, ...coords }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: { message?: string } }
        throw new Error(d.error?.message ?? 'PIN not recognised')
      }
      const data = await res.json() as {
        token: string                                // alias of accessToken (legacy)
        accessToken?: string
        refreshToken?: string
        user: { id: string; name: string; role: string }
      }
      setAuth(data.user, data.accessToken ?? data.token, data.refreshToken)
      // Non-CEO staff land on the Time Clock kiosk first — clocking in is the
      // first thing they do every shift. CEO (admin role) bypasses straight
      // to the dashboard.
      // Everyone lands on the module hub — it is the map of the whole system.
      // Floor staff who only hold the time-clock atom still see the hub; their
      // modules simply render as locked.
      router.replace('/modules')
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
    // PINs are variable length (4–8 digits): most staff use the 4-digit
    // last-of-phone PIN, the CEO and any admin-issued PINs are 6 digits.
    // The client can't know the length, so we DON'T auto-submit at 4 — that
    // truncated a 6-digit PIN and then froze the pad on `loading`, locking
    // longer-PIN users out. Auto-submit only when the field is full (8), the
    // one length where no further input is possible; otherwise the user taps
    // "Sign in" when done.
    if (next.length === 8) setTimeout(() => void submitPin(next), 120)
  }

  function pressBack() { if (!loading) { setError(''); setPin((p) => p.slice(0, -1)) } }

  function trySubmit() {
    if (loading || pin.length < 4) return
    void submitPin(pin)
  }

  // Physical-keyboard support — the CEO often signs in from a laptop, not the
  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: pwEmail.trim().toLowerCase(), password: pwPassword }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error?.message ?? 'Invalid credentials')

      // Account has two-factor on: no session yet, just a challenge. Move to
      // the code step rather than trying to read tokens that aren't there.
      if (d.twoFactorRequired) {
        setMfaChallenge(d.challengeToken)
        setMfaHint(d.phoneHint ?? '')
        setMfaCode('')
        setMode('twofactor')
        return
      }

      setAuth(d.user, d.accessToken, d.refreshToken)
      router.replace('/modules')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  async function submitTwoFactor(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challengeToken: mfaChallenge, code: mfaCode.trim() }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error?.message ?? 'That code did not work')
      setAuth(d.user, d.accessToken, d.refreshToken)
      router.replace('/modules')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work')
    } finally {
      setLoading(false)
    }
  }

  // tablet keypad. Digits type, Backspace deletes, Enter submits (when ≥4).
  useEffect(() => {
    if (mode !== 'pin' || signupDone) return
    function onKey(e: KeyboardEvent) {
      if (loading) return
      // Don't hijack the keyboard while the user is typing in a field (e.g. the
      // name box) — let Backspace and every other key edit that field normally.
      // The pad shortcuts only apply when nothing editable is focused; tapping a
      // pad key blurs the name input, after which the keyboard drives the PIN.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key.length === 1 && e.key >= '0' && e.key <= '9') { e.preventDefault(); pressDigit(e.key) }
      else if (e.key === 'Backspace') { e.preventDefault(); pressBack() }
      else if (e.key === 'Enter')     { e.preventDefault(); trySubmit() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, loading, mode, signupDone])

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
            <p className="text-[10px] uppercase tracking-wider font-bold text-s-dim mb-1">Your login PIN</p>
            <p className="text-3xl font-black tracking-[0.4em] text-s-text">{signupDone.pin}</p>
            <p className="text-[10px] text-s-dim mt-2">This is the last 4 digits of your phone number — it's your permanent login PIN. Sign in with your name (or email) + this PIN once the CEO approves your account.</p>
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
              {mode === 'pin' ? 'Enter your PIN'
                : mode === 'password' ? 'Sign in'
                : mode === 'twofactor' ? 'Check WhatsApp'
                : 'Apply to join'}
            </h1>
            <p className="text-xs text-s-dim mt-1">
              {mode === 'pin' ? 'Authorized personnel only'
                : mode === 'password' ? 'Owner, management and finance accounts'
                : mode === 'twofactor' ? `We sent a 6-digit code to ${mfaHint || 'your number'}`
                : 'CEO will review your request'}
            </p>
          </div>

          {mode === 'twofactor' ? (
            <form onSubmit={submitTwoFactor}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                autoFocus
                className="w-full mb-3 rounded-xl px-4 py-3 text-center text-2xl font-black tracking-[0.4em] text-s-text outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              {error && <p className="text-xs text-red-400 mb-3 text-center">{error}</p>}
              <button
                type="submit"
                disabled={loading || mfaCode.length < 6}
                className="w-full rounded-xl py-3 text-sm font-black transition-all active:scale-[0.98] disabled:opacity-40"
                style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}
              >
                {loading ? 'Checking…' : 'Sign in'}
              </button>
              <button
                type="button"
                onClick={() => { setMode('password'); setError(''); setMfaChallenge(''); setMfaCode('') }}
                className="w-full mt-3 text-xs text-s-dim hover:text-s-muted transition-colors"
              >
                ← Start over
              </button>
              <p className="text-[10px] text-s-dim mt-4 text-center leading-relaxed">
                Didn&rsquo;t ask to sign in? Someone has your password. Change it as soon as you&rsquo;re in.
              </p>
            </form>
          ) : mode === 'password' ? (
            <form onSubmit={submitPassword}>
              <input
                type="email"
                value={pwEmail}
                onChange={(e) => setPwEmail(e.target.value)}
                placeholder="Email"
                autoComplete="username"
                autoFocus
                className="w-full mb-3 rounded-xl px-4 py-3 text-s-text outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              <input
                type="password"
                value={pwPassword}
                onChange={(e) => setPwPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              {error && <p className="text-xs text-center mb-3" style={{ color: '#F87171' }}>{error}</p>}
              <button
                type="submit"
                disabled={loading || !pwEmail.trim() || pwPassword.length < 8}
                className="w-full rounded-xl py-3 text-sm font-black transition-opacity disabled:opacity-40"
                style={{
                  background: 'linear-gradient(135deg, #00D4B1, #6366F1)',
                  color: '#000',
                  boxShadow: '0 4px 20px rgba(0,212,177,0.25)',
                }}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : mode === 'pin' ? (
            <>
              {/* Name first — lets the server check ONE PIN and lock out a
                  single bad guesser. */}
              <input
                type="text"
                value={pinName}
                onChange={(e) => setPinName(e.target.value)}
                placeholder="Your name"
                autoComplete="off"
                className="w-full mb-4 rounded-xl px-4 py-3 text-center text-s-text outline-none"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
              />

              {/* PIN dots — grow with the entered digits so longer (6-digit)
                  PINs get real feedback past the 4th digit. Minimum 4 outline
                  placeholders, expands up to the 8-digit max as you type. */}
              <div className="flex justify-center gap-3 mb-2">
                {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
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

              {/* Sign in — explicit submit. Required because PINs vary in
                  length (4–8) and the pad no longer auto-fires at 4. Enabled
                  once the minimum 4 digits are in. */}
              <button
                onClick={trySubmit}
                disabled={loading || pin.length < 4}
                className="w-full mt-3 rounded-2xl py-4 text-sm font-black transition-all active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed"
                style={{
                  background: (loading || pin.length < 4)
                    ? 'rgba(255,255,255,0.06)'
                    : 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)',
                  color: (loading || pin.length < 4) ? 'rgba(255,255,255,0.4)' : '#000',
                }}>
                {loading ? (status || 'Signing in…') : 'Sign in'}
              </button>
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

          {/* Mode toggles */}
          <div className="mt-6 space-y-2">
            <button type="button"
              onClick={() => { setMode(mode === 'password' ? 'pin' : 'password'); setError(''); setPin('') }}
              className="w-full text-center text-xs font-bold transition-colors"
              style={{ color: 'rgba(255,255,255,0.55)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#00D4B1')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.55)')}>
              {mode === 'password'
                ? '← Back to PIN'
                : 'Owner / management / finance? Sign in with password →'}
            </button>
            <button type="button"
              onClick={() => { setMode((m) => m === 'signup' ? 'pin' : 'signup'); setError(''); setPin('') }}
              className="w-full text-center text-xs font-bold transition-colors"
              style={{ color: 'rgba(255,255,255,0.4)' }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#00D4B1')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'rgba(255,255,255,0.4)')}>
              {mode === 'signup'
                ? '← Already approved? Back to PIN'
                : 'New staff? Apply to join →'}
            </button>
          </div>

        </div>
      </div>
    </div>
  )
}
