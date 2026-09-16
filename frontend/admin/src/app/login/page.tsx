'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'
const STOREFRONT_URL  = process.env['NEXT_PUBLIC_STOREFRONT_URL']  ?? 'http://localhost:3002'

type Mode = 'password' | 'twofactor' | 'changepw' | 'forgot'

/**
 * The single staff login page. Email + password, and nothing else.
 *
 * PIN sign-in is gone. It was the default here, and it minted a full session
 * from four digits typed on a shared tablet — fine for a line cook, not fine
 * when the same session can read the P&L. Every member of staff now has their
 * own device, so the shared-tablet case that justified it no longer exists.
 *
 * Staff self-signup is gone too. Its whole value was that a new hire chose a
 * PIN and could sign in the moment the CEO approved them; under email+password
 * it would create a pending row with a random password nobody ever sees, so an
 * approved hire still could not get in. Accounts are created from Workforce,
 * where the generated password is shown once to hand over.
 *
 * Modes:
 *   password  — the default and the only way in.
 *   twofactor — the WhatsApp OTP step, for accounts enrolled in it.
 *   changepw  — reachable from the sign-in form WITHOUT a session, because
 *               someone handed a generated password needs to replace it before
 *               they have anything else to sign in with.
 *   forgot    — for when you don't know the current password either. Mails a
 *               one-shot link (and WhatsApps it, if there's a number on file).
 *               This is the only path that does not require knowing SOMETHING,
 *               which is why it existed nowhere until now: the owner's account
 *               could only be recovered by another admin.
 */
export default function StaffLoginPage() {
  const router  = useRouter()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [mode, setMode] = useState<Mode>('password')

  const [pwEmail,    setPwEmail]    = useState('')
  const [pwPassword, setPwPassword] = useState('')

  // Second-factor step. The challenge token is what the API handed back instead
  // of a session; the code is what arrives on WhatsApp. Neither is a credential
  // on its own — the challenge is good for ten minutes and only for
  // /auth/2fa/verify.
  const [mfaChallenge, setMfaChallenge] = useState('')
  const [mfaHint,      setMfaHint]      = useState('')
  const [mfaCode,      setMfaCode]      = useState('')

  // Change-password step.
  const [cpCurrent, setCpCurrent] = useState('')
  const [cpNew,     setCpNew]     = useState('')
  const [cpNew2,    setCpNew2]    = useState('')
  const [cpDone,    setCpDone]    = useState(false)

  // Forgot-password step. `fgDone` is set whatever the API says, because the
  // API deliberately answers the same way for an address that has no account.
  const [fgDone, setFgDone] = useState(false)

  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  const field = 'w-full mb-3 rounded-xl px-4 py-3 text-s-text outline-none'
  const fieldStyle = { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }
  const cta = 'w-full rounded-xl py-3 text-sm font-black transition-opacity disabled:opacity-40'
  const ctaStyle = {
    background: 'linear-gradient(135deg, #00D4B1, #6366F1)',
    color: '#000',
    boxShadow: '0 4px 20px rgba(0,212,177,0.25)',
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: pwEmail.trim().toLowerCase(), password: pwPassword }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error?.message ?? 'Invalid credentials')

      // Two-factor on: no session yet, only a challenge. Move to the code step
      // rather than reading tokens that are not there.
      if (d.twoFactorRequired) {
        setMfaChallenge(d.challengeToken)
        setMfaHint(d.phoneHint ?? '')
        setMfaCode('')
        setMode('twofactor')
        return
      }

      setAuth(d.user, d.accessToken, d.refreshToken)
      // Nudge, never a block: an account created with a generated password is
      // flagged, but it still signs in. Blocking on this flag is how people get
      // stranded on deploy day.
      router.replace(d.user?.mustChangePassword ? '/account/password' : '/modules')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  async function submitTwoFactor(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
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

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/password/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: pwEmail.trim().toLowerCase() }),
      })
      if (res.status === 503) {
        // The server has no way to send anything. That is a fact about the
        // server, not about this account, so showing it leaks nothing — and
        // "check your email" would send someone to watch an inbox that is
        // never going to receive anything.
        const d = await res.json().catch(() => ({}))
        setError(d.error?.message ?? 'Password reset is unavailable right now.')
        return
      }
      // Otherwise: shown whether or not the address has an account. The API
      // answers identically for both, and a UI that distinguished them here
      // would put back the enumeration oracle the API just avoided.
      setFgDone(true)
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function submitChangePassword(e: React.FormEvent) {
    e.preventDefault()
    if (cpNew !== cpNew2) { setError('The two new passwords do not match'); return }
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/password/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: pwEmail.trim().toLowerCase(),
          currentPassword: cpCurrent,
          newPassword: cpNew,
        }),
      })
      if (res.status === 204) {
        setCpDone(true)
        setPwPassword('')
        setCpCurrent(''); setCpNew(''); setCpNew2('')
        return
      }
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error?.message ?? 'Could not change your password')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change your password')
    } finally {
      setLoading(false)
    }
  }

  function backToSignIn() {
    setMode('password'); setError(''); setCpDone(false); setFgDone(false)
    setMfaChallenge(''); setMfaCode('')
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

          <div className="text-center mb-8">
            <p className="text-[11px] font-bold text-s-muted uppercase tracking-[0.25em] mb-2">
              Staff Portal
            </p>
            <h1 className="text-2xl font-black text-s-text">
              {mode === 'password'  ? 'Sign in'
                : mode === 'twofactor' ? 'Check WhatsApp'
                : 'Change your password'}
            </h1>
            <p className="text-xs text-s-dim mt-1">
              {mode === 'password'  ? 'Authorized personnel only'
                : mode === 'twofactor' ? `We sent a 6-digit code to ${mfaHint || 'your number'}`
                : 'You need your current password to set a new one'}
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
                style={fieldStyle}
              />
              {error && <p className="text-xs text-red-400 mb-3 text-center">{error}</p>}
              <button type="submit" disabled={loading || mfaCode.length < 6} className={cta} style={ctaStyle}>
                {loading ? 'Checking…' : 'Sign in'}
              </button>
              <button type="button" onClick={backToSignIn}
                className="w-full mt-3 text-xs text-s-dim hover:text-s-muted transition-colors">
                ← Start over
              </button>
              <p className="text-[10px] text-s-dim mt-4 text-center leading-relaxed">
                Didn&rsquo;t ask to sign in? Someone has your password. Change it as soon as you&rsquo;re in.
              </p>
            </form>

          ) : mode === 'forgot' ? (
            fgDone ? (
              <div className="text-center">
                <p className="text-sm text-s-text mb-2">Check your email.</p>
                <p className="text-xs text-s-dim mb-5 leading-relaxed">
                  If that address has an account, a reset link is on its way
                  there &mdash; and to its WhatsApp, if we have a number for it.
                  The link works once and expires in 30 minutes.
                </p>
                <button type="button" onClick={backToSignIn} className={cta} style={ctaStyle}>
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={submitForgot}>
                <p className="text-xs text-s-dim mb-4 leading-relaxed text-center">
                  Enter the email you sign in with and we&rsquo;ll send you a link
                  to set a new password.
                </p>
                <input
                  type="email" value={pwEmail} onChange={(e) => setPwEmail(e.target.value)}
                  placeholder="Email" autoComplete="username" autoFocus
                  className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none" style={fieldStyle}
                />
                {error && <p className="text-xs text-center mb-3" style={{ color: '#F87171' }}>{error}</p>}
                <button type="submit" className={cta} style={ctaStyle}
                  disabled={loading || !pwEmail.trim()}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
                <button type="button" onClick={backToSignIn}
                  className="w-full mt-3 text-xs text-s-dim hover:text-s-muted transition-colors">
                  &larr; Back to sign in
                </button>
              </form>
            )

          ) : mode === 'changepw' ? (
            cpDone ? (
              <div className="text-center">
                <p className="text-sm text-s-text mb-2">Password changed.</p>
                <p className="text-xs text-s-dim mb-5 leading-relaxed">
                  Every other device signed in as you has been signed out.
                </p>
                <button type="button" onClick={backToSignIn} className={cta} style={ctaStyle}>
                  Sign in
                </button>
              </div>
            ) : (
              <form onSubmit={submitChangePassword}>
                <input
                  type="email" value={pwEmail} onChange={(e) => setPwEmail(e.target.value)}
                  placeholder="Email" autoComplete="username" autoFocus
                  className={field} style={fieldStyle}
                />
                <input
                  type="password" value={cpCurrent} onChange={(e) => setCpCurrent(e.target.value)}
                  placeholder="Current password" autoComplete="current-password"
                  className={field} style={fieldStyle}
                />
                <input
                  type="password" value={cpNew} onChange={(e) => setCpNew(e.target.value)}
                  placeholder="New password" autoComplete="new-password"
                  className={field} style={fieldStyle}
                />
                <input
                  type="password" value={cpNew2} onChange={(e) => setCpNew2(e.target.value)}
                  placeholder="Repeat new password" autoComplete="new-password"
                  className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none" style={fieldStyle}
                />
                <p className="text-[10px] text-s-dim mb-3 text-center">At least 12 characters.</p>
                {error && <p className="text-xs text-center mb-3" style={{ color: '#F87171' }}>{error}</p>}
                <button type="submit" className={cta} style={ctaStyle}
                  disabled={loading || !pwEmail.trim() || !cpCurrent || cpNew.length < 12}>
                  {loading ? 'Changing…' : 'Change password'}
                </button>
                <button type="button" onClick={backToSignIn}
                  className="w-full mt-3 text-xs text-s-dim hover:text-s-muted transition-colors">
                  ← Back to sign in
                </button>
              </form>
            )

          ) : (
            <form onSubmit={submitPassword}>
              <input
                type="email" value={pwEmail} onChange={(e) => setPwEmail(e.target.value)}
                placeholder="Email" autoComplete="username" autoFocus
                className={field} style={fieldStyle}
              />
              <input
                type="password" value={pwPassword} onChange={(e) => setPwPassword(e.target.value)}
                placeholder="Password" autoComplete="current-password"
                className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none" style={fieldStyle}
              />
              {error && <p className="text-xs text-center mb-3" style={{ color: '#F87171' }}>{error}</p>}
              <button type="submit" className={cta} style={ctaStyle}
                disabled={loading || !pwEmail.trim() || pwPassword.length < 8}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <div className="mt-4 flex items-center justify-center gap-4">
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setError(''); setFgDone(false) }}
                  className="text-xs text-s-dim hover:text-s-muted transition-colors"
                >
                  Forgot my password
                </button>
                <span className="text-xs text-s-dim">&middot;</span>
                <button
                  type="button"
                  onClick={() => { setMode('changepw'); setError(''); setCpDone(false) }}
                  className="text-xs text-s-dim hover:text-s-muted transition-colors"
                >
                  Change my password
                </button>
              </div>
            </form>
          )}

          <p className="text-[10px] text-s-dim mt-8 text-center leading-relaxed">
            Need an account? Ask the CEO to add you from Workforce — they will
            hand you a password to sign in with.
          </p>
        </div>
      </div>
    </div>
  )
}
