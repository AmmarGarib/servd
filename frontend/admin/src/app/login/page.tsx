'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthStore } from '../../store/auth'
import { STOREFRONT_URL } from '../../lib/content'
import { PracticeCode } from '../../components/SandboxBanner'
import { PasswordInput } from '../../components/ui/PasswordInput'
import { checkInOnSignIn } from '../../lib/checkInOnSignIn'

const API_URL         = process.env['NEXT_PUBLIC_API_URL']         ?? 'http://localhost:3001'

/** The practice copy's API sends nothing out. After a correct password it
 *  returns the 2FA code it would have sent as `practiceCode` — only there: a
 *  code or reset link asked for by phone / email alone is never echoed (anyone
 *  could ask). The live API never returns it. */
function practiceCodeOf(d: unknown): string {
  const v = (d as { practiceCode?: unknown } | null)?.practiceCode
  return typeof v === 'string' ? v : ''
}

type Mode = 'password' | 'twofactor' | 'changepw' | 'forgot' | 'code'

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
  const [mfaPractice,  setMfaPractice]  = useState('')

  // Change-password step.
  const [cpCurrent, setCpCurrent] = useState('')
  const [cpNew,     setCpNew]     = useState('')
  const [cpNew2,    setCpNew2]    = useState('')
  const [cpDone,    setCpDone]    = useState(false)

  // Forgot-password step. `fgDone` is set whatever the API says, because the
  // API deliberately answers the same way for an address that has no account.
  const [fgDone, setFgDone] = useState(false)

  // Code sign-in for floor staff (cashier, server, cook, expediter), who have
  // no password: phone → one code sent to WhatsApp AND email → session.
  const [codePhone, setCodePhone] = useState('')
  const [codeValue, setCodeValue] = useState('')
  const [codeSent,  setCodeSent]  = useState(false)
  // The code came from a manager (Workforce → "Sign-in code"), not from
  // WhatsApp/email — so skip asking for one to be sent. Asking would fail when
  // sending is down, and when it works it would replace the manager's code.
  const [codeFromManager, setCodeFromManager] = useState(false)

  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)

  // One error style, cleared as soon as anything in the form is edited.
  useEffect(() => { setError('') }, [pwEmail, pwPassword, cpCurrent, cpNew, cpNew2, codePhone, codeValue, mfaCode])

  // A code is submitted once per value: the sixth digit auto-submits, and the
  // ref stops a paste + the form's own submit from sending it twice.
  const codeBusy = useRef(false)
  const mfaRef  = useRef<HTMLInputElement>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const digits6 = (v: string) => v.replace(/\D/g, '').slice(0, 6)

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

      // Two-factor on: no session yet, only a challenge. Move to the code step
      // rather than reading tokens that are not there.
      if (d.twoFactorRequired) {
        setMfaChallenge(d.challengeToken)
        setMfaHint(d.phoneHint ?? '')
        setMfaCode('')
        setMfaPractice(practiceCodeOf(d))
        setMode('twofactor')
        return
      }

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

  async function submitTwoFactor(e?: React.FormEvent, value?: string) {
    e?.preventDefault()
    const code = (value ?? mfaCode).trim()
    if (code.length < 6) { setError('Enter the 6-digit code'); return }
    if (codeBusy.current) return
    codeBusy.current = true
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challengeToken: mfaChallenge, code }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error?.message ?? 'That code did not work')
      setAuth(d.user, d.accessToken, d.refreshToken)
      const punchPage = await checkInOnSignIn(d.user?.role)
      router.replace(d.user?.mustChangePassword ? '/account/password?first=1' : punchPage ?? '/w')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work')
      setTimeout(() => mfaRef.current?.select(), 0)
    } finally {
      codeBusy.current = false
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
    setMfaChallenge(''); setMfaCode(''); setMfaPractice('')
    setCodeSent(false); setCodeValue(''); setCodeFromManager(false)
  }

  async function requestStaffCode(e?: React.FormEvent) {
    e?.preventDefault()
    if (codePhone.replace(/\D/g, '').length < 10) { setError('Enter your 10-digit mobile number'); return }
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/staff/otp/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: codePhone.trim() }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d.error?.message ?? 'Could not send a code')
      // The API answers the same whether or not the number is a staff account,
      // so this screen does too.
      setCodeSent(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send a code')
    } finally {
      setLoading(false)
    }
  }

  async function submitStaffCode(e?: React.FormEvent, value?: string) {
    e?.preventDefault()
    const code = (value ?? codeValue).trim()
    if (code.length < 6) { setError('Enter the 6-digit code'); return }
    if (codeBusy.current) return
    codeBusy.current = true
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/staff/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ phone: codePhone.trim(), code }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error?.message ?? 'That code did not work')
      setAuth(d.user, d.accessToken, d.refreshToken)
      const punchPage = await checkInOnSignIn(d.user?.role)
      router.replace(punchPage ?? '/w')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That code did not work')
      setTimeout(() => codeRef.current?.select(), 0)
    } finally {
      codeBusy.current = false
      setLoading(false)
    }
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
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 sm:p-8" style={{ background: '#ffffff', border: '1px solid var(--border)', boxShadow: '0 8px 32px rgb(var(--ink-rgb) / 0.08)' }}>

          <div className="text-center mb-8">
            <p className="text-xs font-bold text-success uppercase tracking-[0.25em] mb-2">
              Staff Portal
            </p>
            <h1 className="text-2xl font-black text-s-text">
              {mode === 'password'  ? 'Sign in'
                : mode === 'code' ? 'Sign in with a code'
                : mode === 'twofactor' ? 'Enter your code'
                : mode === 'forgot' ? 'Reset your password'
                : 'Change your password'}
            </h1>
            <p className="text-xs text-s-muted mt-1">
              {mode === 'password'  ? 'Authorized personnel only'
                : mode === 'code' ? (codeSent
                    ? (codeFromManager ? 'Enter the code your manager gave you' : 'Same code sent to your WhatsApp and email — use whichever arrives first')
                    : 'For cashiers, servers and kitchen staff')
                : mode === 'twofactor' ? `We sent the same 6-digit code to your WhatsApp (${mfaHint || 'your number'}) and your email — use whichever arrives first`
                : mode === 'forgot' ? 'We will email you a link to set a new one'
                : 'You need your current password to set a new one'}
            </p>
          </div>

          {mode === 'code' ? (
            !codeSent ? (
              <form onSubmit={requestStaffCode}>
                <input type="tel" inputMode="tel" autoComplete="tel" value={codePhone} autoFocus
                  onChange={(e) => setCodePhone(e.target.value)} placeholder="Your mobile number, e.g. 0300 1234567"
                  aria-label="Mobile number" autoCapitalize="none" autoCorrect="off" spellCheck={false} className={field} style={fieldStyle} />
                {error && <p role="alert" className="text-xs mb-3 text-center" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
                <button type="submit" disabled={loading} className={cta} style={ctaStyle}>
                  {loading ? 'Sending…' : 'Send me a code'}
                </button>
                <button type="button"
                  disabled={loading}
                  onClick={() => {
                    if (codePhone.replace(/\D/g, '').length < 10) { setError('Enter your 10-digit mobile number'); return }
                    setError(''); setCodeFromManager(true); setCodeSent(true)
                  }}
                  className={`w-full ${linkCls} disabled:opacity-40`}>
                  I have a code from my manager
                </button>
                <button type="button" onClick={backToSignIn} className={`w-full mt-1 ${linkCls}`}>
                  ← Sign in with a password instead
                </button>
              </form>
            ) : (
              <form onSubmit={submitStaffCode}>
                <input ref={codeRef} type="text" inputMode="numeric" autoComplete="one-time-code" value={codeValue} autoFocus
                  maxLength={6} spellCheck={false} autoCorrect="off"
                  onChange={(e) => { const v = digits6(e.target.value); setCodeValue(v); if (v.length === 6) void submitStaffCode(undefined, v) }}
                  onPaste={(e) => { e.preventDefault(); const v = digits6(e.clipboardData.getData('text')); setCodeValue(v); if (v.length === 6) void submitStaffCode(undefined, v) }}
                  placeholder="000000"
                  aria-label="6-digit code"
                  className="w-full mb-3 rounded-xl px-4 py-3 text-center text-2xl font-black tracking-[0.4em] text-s-text outline-none"
                  style={fieldStyle} />
                {error && <p role="alert" className="text-xs mb-3 text-center" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
                <button type="submit" disabled={loading} className={cta} style={ctaStyle}>
                  {loading ? 'Checking…' : 'Sign in'}
                </button>
                <div className="mt-3 flex items-center justify-between text-xs">
                  <button type="button" onClick={() => { setCodeSent(false); setCodeValue(''); setError(''); setCodeFromManager(false) }} className="text-s-muted hover:text-s-muted">← Change number</button>
                  {!codeFromManager && (
                    <button type="button" disabled={loading} onClick={() => { void requestStaffCode() }} className="text-s-muted hover:text-s-muted">Send again</button>
                  )}
                </div>
                {!codeFromManager && (
                  <p className="text-xs text-s-muted mt-4 text-center leading-relaxed">
                    The code works for 5 minutes.<br />
                    No code arriving? A manager can give you one from Workforce (&ldquo;Sign-in code&rdquo; next to your name).
                  </p>
                )}
              </form>
            )

          ) : mode === 'twofactor' ? (
            <form onSubmit={submitTwoFactor}>
              {mfaPractice && <PracticeCode code={mfaPractice} />}
              <input
                ref={mfaRef}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                maxLength={6}
                spellCheck={false}
                autoCorrect="off"
                aria-label="6-digit code"
                onChange={(e) => { const v = digits6(e.target.value); setMfaCode(v); if (v.length === 6) void submitTwoFactor(undefined, v) }}
                onPaste={(e) => { e.preventDefault(); const v = digits6(e.clipboardData.getData('text')); setMfaCode(v); if (v.length === 6) void submitTwoFactor(undefined, v) }}
                placeholder="000000"
                autoFocus
                className="w-full mb-3 rounded-xl px-4 py-3 text-center text-2xl font-black tracking-[0.4em] text-s-text outline-none"
                style={fieldStyle}
              />
              {error && <p role="alert" className="text-xs mb-3 text-center" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
              <button type="submit" disabled={loading} className={cta} style={ctaStyle}>
                {loading ? 'Checking…' : 'Sign in'}
              </button>
              <button type="button" onClick={backToSignIn}
                className={`w-full mt-1 ${linkCls}`}>
                ← Start over
              </button>
              <p className="text-xs text-s-muted mt-3 text-center leading-relaxed">
                The code works for 5 minutes. To get a new one, start over.<br />
                Didn&rsquo;t ask to sign in? Someone has your password. Change it as soon as you&rsquo;re in.
              </p>
            </form>

          ) : mode === 'forgot' ? (
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
                  onClick={() => { setMode('code'); setError(''); setCodeSent(false) }}
                  className={linkCls}
                >
                  Sign in with a code
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
