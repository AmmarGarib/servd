'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'

// /login — restyled to the on-system --servd-* tokens + Bricolage Grotesque
// display. Replaces the legacy teal→indigo gradient + placeholder "S" mark
// with the real servd wordmark and a single green primary CTA.

function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [message, onDismiss])
  return (
    <div className="fixed top-4 left-1/2 z-[9999] w-[calc(100vw-2rem)] max-w-sm"
      style={{ transform: 'translateX(-50%)', animation: 'slideDownFade 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
      <div className="flex items-start gap-3 rounded-2xl px-4 py-3.5 shadow-xl"
        style={{ background: '#fff1f1', border: '1.5px solid #ef4444', boxShadow: '0 8px 32px rgba(239,68,68,0.18)' }}>
        <span aria-hidden style={{ width: 18, height: 18, borderRadius: 999, background: '#ef4444', flex: 'none', marginTop: 2 }} />
        <p className="flex-1 text-sm font-bold leading-snug" style={{ color: '#c0392b' }}>{message}</p>
        <button onClick={onDismiss} className="text-red-400 hover:text-red-600 text-lg leading-none shrink-0">×</button>
      </div>
    </div>
  )
}

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export default function LoginPage() {
  const router  = useRouter()
  const setAuth = useCustomerAuth((s) => s.setAuth)

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

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
      router.replace('/account')
    } catch (err) {
      console.error('[login] fetch error:', err)
      setError('Could not reach the server. Make sure the API is running.')
    } finally { setLoading(false) }
  }

  const inp = 'w-full rounded-2xl px-4 py-4 text-sm font-semibold focus:outline-none transition-all placeholder:text-black/30'
  const inpStyle = { background: 'white', border: '1.5px solid var(--servd-line)', color: 'var(--servd-ink)' }
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-green)'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(58,14,105,0.16)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-line)'
    e.currentTarget.style.boxShadow   = 'none'
  }

  return (
    <main className="flex flex-col items-center justify-center px-5" style={{ minHeight: '100dvh', background: 'var(--servd-bg)' }}>
      <Link href="/" aria-label="servd home" className="mb-8" style={{
        fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em',
        color: 'var(--servd-black)', textDecoration: 'none', display: 'inline-flex', alignItems: 'baseline', gap: '0.1rem',
      }}>
        servd<span style={{ color: 'var(--servd-green)' }}>.</span>
      </Link>

      <div className="w-full max-w-sm rounded-3xl px-6 py-8" style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', animation: 'fadeSlideUp 0.4s both' }}>
        <h1 className="font-display font-black tracking-tight mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2rem, 6vw, 2.4rem)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>Sign in</h1>
        <p className="text-sm mb-6" style={{ color: 'var(--servd-mute)' }}>Welcome back.</p>

        {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

        <form onSubmit={e => { void handleSubmit(e) }} className="space-y-3">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" autoFocus required
              className={inp} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required
              className={inp} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
          </div>
          <button type="submit" disabled={loading}
            className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
            style={{
              background: loading ? 'var(--servd-surface)' : 'var(--servd-green)',
              color: loading ? 'var(--servd-mute)' : '#0a0a0a',
              boxShadow: loading ? 'none' : '0 6px 18px rgba(58,14,105,0.28)',
            }}>
            {loading ? 'Signing in…' : 'Sign in →'}
          </button>
        </form>

        <p className="text-center text-sm mt-5" style={{ color: 'var(--servd-mute)' }}>
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="font-black" style={{ color: 'var(--servd-green-dark)' }}>Create one →</Link>
        </p>
      </div>

      <Link href="/" className="mt-6 text-xs font-semibold" style={{ color: 'var(--servd-mute)', textDecoration: 'none' }}>
        ← Back to home
      </Link>
    </main>
  )
}
