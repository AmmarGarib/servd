'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { BlockedNotice, fetchBlocks, type AccountBlock } from '../account/BlockedNotice'
import { ErrorToast } from '../ui/ErrorToast'
import { MagneticButton } from '../ui/MagneticButton'
import { NETWORK_ERROR, customerErrorMessage, postAuthDest, type ApiErrorBody } from './authFlow'

// The storefront's sign-in form (email/password → /auth/customer/login →
// setAuth). "Forgot your password?" sends ONE code to the account's own phone
// (WhatsApp) and email and sets a new password with it (/auth/customer/password/
// forgot + reset; owner, 2026-10-28: a code only at sign-up and to get back in). Shared by /login and the `signup_form` block (mode 'login') so
// there is exactly one sign-in flow. Styled for the standard white card — callers
// put it on one. Where it sends the customer afterwards (?next= / ?return=,
// same-site paths only) lives in ./authFlow.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const inputCls =
  'servd-field w-full rounded-xl px-4 py-3.5 text-base sm:text-sm font-semibold text-[color:var(--servd-ink)] bg-white border border-[color:var(--servd-line)] placeholder:text-[color:var(--servd-mute)]/70 focus:outline-none focus:border-[color:var(--servd-purple)] transition-all'

export function LoginForm({
  onSuccess, autoFocus = true, idPrefix = 'login',
}: {
  /** Called after a successful sign-in instead of redirecting to postAuthDest(). */
  onSuccess?: () => void
  autoFocus?: boolean
  idPrefix?: string
}) {
  const router  = useRouter()
  const setAuth = useCustomerAuth((s) => s.setAuth)

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [showPassword, setShowPassword] = useState(false)
  // A blocked account is told so right after sign-in (appeals on); the way
  // forward is one button. Empty / null while appeals are off.
  const [blocked, setBlocked] = useState<AccountBlock[] | null>(null)
  const proceed = () => { if (onSuccess) onSuccess(); else router.replace(postAuthDest()) }
  // Forgot password: 'email' (send the code) → 'code' (code + new password).
  const [forgot, setForgot] = useState<null | 'email' | 'code'>(null)
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [notice, setNotice] = useState('')

  async function finishSignIn(data: { token?: string; customer?: { id: string } } | null) {
    if (!data?.token || !data.customer?.id) { setError(customerErrorMessage(500, null, '')); return }
    setAuth(data.token, data.customer.id)
    // Sign-in is never refused. If the account is blocked (and the CEO's
    // appeals switch is on) show the notice first, with a way to carry on.
    const blocks = await fetchBlocks(data.token)
    if (blocks.length > 0) { setBlocked(blocks); return }
    proceed()
  }

  async function post(path: string, body: object): Promise<{ res: Response; data: ({ token?: string; customer?: { id: string } } & ApiErrorBody) | null } | null> {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/customer/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      return { res, data: await res.json().catch(() => null) }
    } catch {
      setError(NETWORK_ERROR)
      return null
    }
  }

  async function sendResetCode(e?: React.FormEvent) {
    e?.preventDefault()
    setError(''); setNotice('')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError('Enter the email of your servd account.'); return }
    setLoading(true)
    try {
      const r = await post('password/forgot', { email: email.trim() })
      if (!r) return
      if (!r.res.ok) { setError(customerErrorMessage(r.res.status, r.data, 'Could not send a code. Try again.')); return }
      setForgot('code'); setCode(''); setNewPassword('')
      setNotice('If that email has a servd account, a 6-digit code is on its way to its WhatsApp and email.')
    } finally { setLoading(false) }
  }

  async function resetPassword(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code.'); return }
    if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      setError('Use at least 8 characters, with a letter and a number.'); return
    }
    setLoading(true)
    try {
      const r = await post('password/reset', { email: email.trim(), code: code.trim(), newPassword })
      if (!r) return
      if (!r.res.ok) {
        setError(r.data?.error?.code === 'INVALID_CODE'
          ? 'That code is not right, or it has expired. Ask for a new one.'
          : customerErrorMessage(r.res.status, r.data, 'Could not reset your password. Try again.'))
        return
      }
      await finishSignIn(r.data)
    } finally { setLoading(false) }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    let res: Response
    try {
      res = await fetch(`${API_URL}/api/v1/auth/customer/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
    } catch (err) {
      console.error('[login] fetch error:', err)
      setError(NETWORK_ERROR)
      setLoading(false)
      return
    }
    try {
      const data = await res.json().catch(() => null) as ({ token?: string; customer?: { id: string } } & ApiErrorBody) | null
      if (!res.ok) {
        // A malformed email or a too-short password fails the API's schema;
        // on sign-in that is simply a wrong email or password.
        setError(data?.error?.code === 'VALIDATION_ERROR'
          ? 'Invalid email or password'
          : customerErrorMessage(res.status, data, 'Invalid email or password'))
        return
      }
      await finishSignIn(data)
    } finally { setLoading(false) }
  }

  if (blocked) {
    return (
      <div className="rounded-2xl p-1">
        <BlockedNotice blocks={blocked} onContinue={proceed} />
      </div>
    )
  }

  const primaryBtn = 'group w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] bg-[var(--servd-purple)] text-[color:var(--servd-on-purple)] hover:bg-[var(--servd-black)]'
  const linkBtn = 'min-h-[44px] text-sm font-bold text-[color:var(--servd-purple)] underline underline-offset-2'

  if (forgot) {
    return (
      <>
        {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
        {forgot === 'email' ? (
          <form onSubmit={e => { void sendResetCode(e) }} className="space-y-4">
            <p className="text-sm text-[color:var(--servd-mute)]">We send a 6-digit code to the WhatsApp and email on your account. Enter it with a new password.</p>
            <div>
              <label htmlFor={`${idPrefix}-forgot-email`} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">Email</label>
              <input id={`${idPrefix}-forgot-email`} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                autoFocus required className={inputCls} />
            </div>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Sending…' : 'Send me a code'}</button>
            <button type="button" onClick={() => { setForgot(null); setError('') }} className={linkBtn}>Back to sign in</button>
          </form>
        ) : (
          <form onSubmit={e => { void resetPassword(e) }} className="space-y-4">
            {notice && <p className="text-sm text-[color:var(--servd-mute)]">{notice}</p>}
            <div>
              <label htmlFor={`${idPrefix}-reset-code`} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">6-digit code</label>
              <input id={`${idPrefix}-reset-code`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus required className={inputCls + ' tracking-[0.3em]'} />
            </div>
            <div>
              <label htmlFor={`${idPrefix}-reset-password`} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">New password</label>
              <input id={`${idPrefix}-reset-password`} type={showPassword ? 'text' : 'password'} autoComplete="new-password" value={newPassword}
                onChange={e => setNewPassword(e.target.value)} required className={inputCls} />
              <p className="mt-1 text-xs text-[color:var(--servd-mute)]">At least 8 characters, with a letter and a number.</p>
            </div>
            <button type="submit" disabled={loading} className={primaryBtn}>{loading ? 'Saving…' : 'Set new password and sign in'}</button>
            <div className="flex flex-wrap gap-x-5">
              <button type="button" disabled={loading} onClick={() => { void sendResetCode() }} className={linkBtn}>Send a new code</button>
              <button type="button" onClick={() => { setForgot(null); setError(''); setNotice('') }} className={linkBtn}>Back to sign in</button>
            </div>
          </form>
        )}
      </>
    )
  }

  return (
    <>
      {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

      <form onSubmit={e => { void handleSubmit(e) }} className="space-y-4">
        <div>
          <label htmlFor={`${idPrefix}-email`} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">Email</label>
          <input id={`${idPrefix}-email`} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="the.goat@servd.pk" autoFocus={autoFocus} required className={inputCls} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-password`} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">Password</label>
          <div className="relative">
            <input id={`${idPrefix}-password`} type={showPassword ? 'text' : 'password'} autoComplete="current-password"
              value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required className={inputCls + ' pr-12'} />
            <button type="button" onClick={() => setShowPassword(v => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-[color:var(--servd-mute)] hover:text-[color:var(--servd-ink)] transition-colors">
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        <MagneticButton type="submit" disabled={loading}
          className="group w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] bg-[var(--servd-purple)] text-[color:var(--servd-on-purple)] hover:bg-[var(--servd-black)]"
          style={{ boxShadow: '0 4px 14px rgba(106,13,173,0.18)' }}>
          {loading ? 'Signing in…' : 'Sign in'}
          {!loading && <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />}
        </MagneticButton>
        <button type="button" onClick={() => { setForgot('email'); setError('') }} className={linkBtn}>Forgot your password?</button>
      </form>
    </>
  )
}
