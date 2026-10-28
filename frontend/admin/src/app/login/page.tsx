'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { STOREFRONT_URL } from '../../lib/content'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { checkInOnSignIn } from '../../lib/checkInOnSignIn'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'

type Mode = 'password' | 'changepw' | 'forgot'

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
 *   password  — the default and the only way in. (The two-step code step was
 *               retired, owner 2026-10-26.)
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
  // A sign-in lasts one shift (owner B1, 2026-10-26): lib/api.ts sends an ended
  // session here with ?ended=shift. Read once on load (no Suspense needed).
  const [shiftEnded, setShiftEnded] = useState(false)
  useEffect(() => {
    try { setShiftEnded(new URLSearchParams(window.location.search).get('ended') === 'shift') } catch { /* ignore */ }
  }, [])

  // One error style, cleared as soon as anything in the form is edited.
  useEffect(() => { setError('') }, [pwEmail, pwPassword, cpCurrent, cpNew, cpNew2])

  const field = 'w-full mb-3 rounded-xl px-4 py-3 text-s-text outline-none'
  const pwField = 'w-full rounded-xl px-4 py-3 text-s-text outline-none'
  const emailProps = { type: 'email', inputMode: 'email', autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false, autoComplete: 'username', 'aria-label': 'Email', placeholder: 'Email' } as const
  const linkCls = 'py-2.5 text-xs text-s-muted hover:text-s-muted transition-colors'
  const fieldStyle = { background: 'var(--elevated)', border: '1px solid var(--border-strong)' }
  const cta = 'w-full rounded-xl py-3 text-sm font-black transition-opacity disabled:opacity-40'
  const ctaStyle = {
    background: 'var(--erp-primary)',
    color: 'var(--erp-on-primary)',
    boxShadow: '0 4px 20px rgb(var(--erp-primary-rgb) / 0.25)',
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    if (!pwEmail.trim()) { setError('Enter your email'); return }
    if (!pwPassword) { setError('Enter your password'); return }
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

      setAuth(d.user, d.accessToken, d.refreshToken)
      // Nudge, never a block: an account created with a generated (or
      // reissued) password is flagged on the login response, and lands on the
      // page that replaces it — but it is signed in, and can skip it. Blocking
      // on this flag is how people get stranded on deploy day.
      const punchPage = await checkInOnSignIn(d.user?.role)
      router.replace(d.user?.mustChangePassword ? '/account/password?first=1' : punchPage ?? '/w')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  async function submitForgot(e: React.FormEvent) {
    e.preventDefault()
    if (!pwEmail.trim()) { setError('Enter your email'); return }
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
    if (!pwEmail.trim()) { setError('Enter your email'); return }
    if (!cpCurrent) { setError('Enter your current password'); return }
    if (cpNew.length < 12) { setError('At least 12 characters'); return }
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
  }

  return (
    <div className="min-h-screen bg-s-bg flex flex-col">

      {/* Brand bar */}
      <div className="flex items-center justify-between px-6 pt-5">
        <div className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/servd-logo.png" alt="servd" width={44} height={44} className="h-11 w-11 block" />
        </div>
        <a href={STOREFRONT_URL} className="text-xs text-s-muted hover:text-s-muted transition-colors">
          Order food →
        </a>
      </div>

      {/* Centre card */}
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 sm:p-8" style={{ background: 'var(--surface)', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgb(var(--ink-rgb) / 0.08)' }}>

          <div className="text-center mb-8">
            <p className="text-xs font-bold text-success uppercase tracking-[0.25em] mb-2">
              Staff Portal
            </p>
            <h1 className="text-2xl font-black text-s-text">
              {mode === 'password'  ? 'Sign in'
                : mode === 'forgot' ? 'Reset your password'
                : 'Change your password'}
            </h1>
            <p className="text-xs text-s-muted mt-1">
              {mode === 'password'  ? 'Authorized personnel only'
                : mode === 'forgot' ? 'We will email you a link to set a new one'
                : 'You need your current password to set a new one'}
            </p>
          </div>

          {shiftEnded && mode === 'password' && (
            <p role="status" className="text-xs mb-4 rounded-xl px-3 py-2 text-center leading-relaxed"
              style={{ background: 'color-mix(in srgb, var(--erp-primary) 8%, transparent)', color: 'var(--erp-primary)' }}>
              Your shift ended — sign in again. A sign-in lasts one shift.
            </p>
          )}

          {mode === 'forgot' ? (
            fgDone ? (
              <div className="text-center">
                <p className="text-sm text-s-text mb-2">Check your email.</p>
                <p className="text-xs text-s-muted mb-5 leading-relaxed">
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
                <p className="text-xs text-s-muted mb-4 leading-relaxed text-center">
                  Enter the email you sign in with and we&rsquo;ll send you a link
                  to set a new password.
                </p>
                <input
                  {...emailProps} value={pwEmail} onChange={(e) => setPwEmail(e.target.value)} autoFocus
                  className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none" style={fieldStyle}
                />
                {error && <p role="alert" className="text-xs text-center mb-3" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
                <button type="submit" className={cta} style={ctaStyle}
                  disabled={loading}>
                  {loading ? 'Sending…' : 'Send reset link'}
                </button>
                <button type="button" onClick={backToSignIn}
                  className={`w-full mt-1 ${linkCls}`}>
                  &larr; Back to sign in
                </button>
              </form>
            )

          ) : mode === 'changepw' ? (
            cpDone ? (
              <div className="text-center">
                <p className="text-sm font-bold text-success mb-2">Password changed.</p>
                <p className="text-xs text-s-muted mb-5 leading-relaxed">
                  Every other device signed in as you has been signed out.
                </p>
                <button type="button" onClick={backToSignIn} className={cta} style={ctaStyle}>
                  Sign in
                </button>
              </div>
            ) : (
              <form onSubmit={submitChangePassword}>
                <input
                  {...emailProps} value={pwEmail} onChange={(e) => setPwEmail(e.target.value)} autoFocus
                  className={field} style={fieldStyle}
                />
                <PasswordInput
                  value={cpCurrent} onChange={(e) => setCpCurrent(e.target.value)}
                  placeholder="Current password" aria-label="Current password" autoComplete="current-password"
                  wrapperClassName="mb-3" className={pwField} style={fieldStyle}
                />
                <PasswordInput
                  value={cpNew} onChange={(e) => setCpNew(e.target.value)}
                  placeholder="New password" aria-label="New password" autoComplete="new-password"
                  wrapperClassName="mb-3" className={pwField} style={fieldStyle}
                />
                <PasswordInput
                  value={cpNew2} onChange={(e) => setCpNew2(e.target.value)}
                  placeholder="Repeat new password" aria-label="Repeat new password" autoComplete="new-password"
                  wrapperClassName="mb-4" className={pwField} style={fieldStyle}
                />
                <p className="text-xs text-s-muted mb-3 text-center">At least 12 characters.</p>
                {error && <p role="alert" className="text-xs text-center mb-3" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
                <button type="submit" className={cta} style={ctaStyle}
                  disabled={loading}>
                  {loading ? 'Changing…' : 'Change password'}
                </button>
                <button type="button" onClick={backToSignIn}
                  className={`w-full mt-1 ${linkCls}`}>
                  ← Back to sign in
                </button>
              </form>
            )

          ) : (
            <form onSubmit={submitPassword}>
              <input
                {...emailProps} value={pwEmail} onChange={(e) => setPwEmail(e.target.value)} autoFocus
                className={field} style={fieldStyle}
              />
              <PasswordInput
                value={pwPassword} onChange={(e) => setPwPassword(e.target.value)}
                placeholder="Password" aria-label="Password" autoComplete="current-password"
                wrapperClassName="mb-4" className={pwField} style={fieldStyle}
              />
              {error && <p role="alert" className="text-xs text-center mb-3" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
              <button type="submit" className={cta} style={ctaStyle}
                disabled={loading}>
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4">
                <button
                  type="button"
                  onClick={() => { setMode('forgot'); setError(''); setFgDone(false) }}
                  className={linkCls}
                >
                  Forgot my password
                </button>
                <span className="text-xs text-s-muted">&middot;</span>
                <button
                  type="button"
                  onClick={() => { setMode('changepw'); setError(''); setCpDone(false) }}
                  className={linkCls}
                >
                  Change my password
                </button>
              </div>
            </form>
          )}

          <p className="text-xs text-s-muted mt-8 text-center leading-relaxed">
            Need an account? Ask the CEO to add you from Workforce — they will
            hand you a password to sign in with.
          </p>
        </div>
      </div>
    </div>
  )
}
