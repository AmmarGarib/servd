'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { ErrorToast } from '../ui/ErrorToast'
import { MagneticButton } from '../ui/MagneticButton'
import { NETWORK_ERROR, customerErrorMessage, postAuthDest, type ApiErrorBody } from './authFlow'

// The storefront's sign-in form (email/password → /auth/customer/login →
// setAuth). Shared by /login and the `signup_form` block (mode 'login') so
// there is exactly one sign-in flow. Styled for a dark purple surface — callers
// put it on one. Where it sends the customer afterwards (?next= / ?return=,
// same-site paths only) lives in ./authFlow.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const inputCls =
  'w-full rounded-2xl px-4 py-3.5 text-sm font-semibold text-white bg-white/10 border border-white/20 placeholder:text-white/35 focus:outline-none focus:border-white/60 focus:bg-white/[0.16] transition-all'

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
      if (!data?.token || !data.customer?.id) { setError(customerErrorMessage(500, null, '')); return }
      setAuth(data.token, data.customer.id)
      if (onSuccess) onSuccess()
      else router.replace(postAuthDest())
    } finally { setLoading(false) }
  }

  return (
    <>
      {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

      <form onSubmit={e => { void handleSubmit(e) }} className="space-y-4">
        <div>
          <label htmlFor={`${idPrefix}-email`} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">Email</label>
          <input id={`${idPrefix}-email`} type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="you@example.com" autoFocus={autoFocus} required className={inputCls} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-password`} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">Password</label>
          <div className="relative">
            <input id={`${idPrefix}-password`} type={showPassword ? 'text' : 'password'} autoComplete="current-password"
              value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required className={inputCls + ' pr-12'} />
            <button type="button" onClick={() => setShowPassword(v => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-white/50 hover:text-white/80 transition-colors">
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        <MagneticButton type="submit" disabled={loading}
          className="group w-full rounded-2xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] bg-[var(--servd-green)] text-[color:var(--servd-on-green)] hover:bg-[var(--servd-green-hover)]"
          style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
          {loading ? 'Signing in…' : 'Sign in'}
          {!loading && <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />}
        </MagneticButton>
      </form>
    </>
  )
}
