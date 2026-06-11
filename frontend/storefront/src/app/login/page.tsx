'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowRight, Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { ErrorToast } from '../../components/ui/ErrorToast'
import { SmokeyBackground } from '../../components/ui/SmokeyBackground'
import { MagneticButton } from '../../components/ui/MagneticButton'

// /login — glassmorphism card over an interactive servd-purple WebGL shader.
// Auth flow (email/password → /auth/customer/login → setAuth → /account) is
// unchanged; only the presentation is new.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const inputCls =
  'w-full rounded-2xl px-4 py-3.5 text-sm font-semibold text-white bg-white/10 border border-white/20 placeholder:text-white/35 focus:outline-none focus:border-white/60 focus:bg-white/[0.16] transition-all'

// Where to send the user after auth. Checkout sends ?next=, the order tracker
// sends ?return= — honour both. Only same-origin relative paths (open-redirect
// guard: no absolute URLs, no protocol-relative //host).
function postAuthDest(): string {
  if (typeof window === 'undefined') return '/account'
  const sp = new URLSearchParams(window.location.search)
  const p = sp.get('next') || sp.get('return')
  if (p && p.startsWith('/') && !p.startsWith('//')) return p
  return '/account'
}

export default function LoginPage() {
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
    try {
      const res  = await fetch(`${API_URL}/api/v1/auth/customer/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      })
      const data = await res.json() as { token?: string; customer?: { id: string }; error?: { message?: string } }
      if (!res.ok) { setError(data.error?.message ?? 'Invalid email or password'); return }
      setAuth(data.token!, data.customer!.id)
      router.replace(postAuthDest())
    } catch (err) {
      console.error('[login] fetch error:', err)
      setError('Could not reach the server. Make sure the API is running.')
    } finally { setLoading(false) }
  }

  return (
    <main className="relative flex items-center justify-center px-5" style={{ minHeight: '100dvh', background: '#160726' }}>
      <SmokeyBackground color="#3A0E69" backdropBlur="sm" />

      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 block text-center"
          style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em', color: 'white', textDecoration: 'none' }}>
          servd<span style={{ color: '#C9A6F0' }}>.</span>
        </Link>

        <div className="w-full rounded-3xl px-7 py-8 bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl" style={{ animation: 'fadeSlideUp 0.4s both' }}>
          <h1 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Sign in</h1>
          <p className="text-sm mb-6 text-white/60">Welcome back.</p>

          {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

          <form onSubmit={e => { void handleSubmit(e) }} className="space-y-4">
            <div>
              <label htmlFor="login-email" className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">Email</label>
              <input id="login-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com" autoFocus required className={inputCls} />
            </div>
            <div>
              <label htmlFor="login-password" className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">Password</label>
              <div className="relative">
                <input id="login-password" type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••" required className={inputCls + ' pr-12'} />
                <button type="button" onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg text-white/50 hover:text-white/80 transition-colors">
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <MagneticButton type="submit" disabled={loading}
              className="group w-full rounded-2xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] bg-white text-[#3A0E69] hover:bg-white/90"
              style={{ boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
              {loading ? 'Signing in…' : 'Sign in'}
              {!loading && <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-1" />}
            </MagneticButton>
          </form>

          <p className="text-center text-sm mt-6 text-white/60">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="font-black text-white hover:text-white/80 transition-colors">Create one →</Link>
          </p>
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-white/50 hover:text-white/80 transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </main>
  )
}
