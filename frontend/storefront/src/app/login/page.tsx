'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'

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
        <span style={{ fontSize: '1.1rem', lineHeight: 1.4 }}>⚠️</span>
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

  const inp = 'w-full rounded-2xl px-4 py-4 text-sm font-semibold focus:outline-none transition-all placeholder:text-black/25'
  const inpStyle = { background: '#fff', border: '1.5px solid rgba(0,0,0,0.1)', color: '#18160f' }
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = '#00D4B1'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(0,212,177,0.12)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'rgba(0,0,0,0.1)'
    e.currentTarget.style.boxShadow   = 'none'
  }

  return (
    <main className="flex flex-col items-center justify-center px-5" style={{ minHeight: '100dvh', background: 'transparent' }}>
      <div className="flex items-center gap-2.5 mb-8">
        <div className="h-9 w-9 rounded-xl flex items-center justify-center font-black text-white text-sm"
          style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', boxShadow: '0 4px 14px rgba(0,212,177,0.3)' }}>
          S
        </div>
        <span className="font-black text-xl tracking-tighter text-shimmer">servd</span>
      </div>

      <div className="w-full max-w-sm rounded-3xl px-6 py-8 shadow-xl" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', animation: 'fadeSlideUp 0.4s both' }}>
        <h1 className="text-3xl font-black tracking-tight mb-1" style={{ color: '#18160f' }}>Sign in</h1>
        <p className="text-sm mb-6" style={{ color: 'rgba(24,22,15,0.45)' }}>Welcome back</p>

        {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

        <form onSubmit={e => { void handleSubmit(e) }} className="space-y-3">
          <div>
            <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5" style={{ color: 'rgba(24,22,15,0.35)' }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com" autoFocus required
              className={inp} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5" style={{ color: 'rgba(24,22,15,0.35)' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="••••••••" required
              className={inp} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
          </div>
          <button type="submit" disabled={loading}
            className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#fff', boxShadow: '0 4px 20px rgba(0,212,177,0.25)' }}>
            {loading ? 'Signing in…' : 'Sign In →'}
          </button>
        </form>

        <p className="text-center text-sm mt-5" style={{ color: 'rgba(24,22,15,0.35)' }}>
          Don&apos;t have an account?{' '}
          <Link href="/signup" className="font-black" style={{ color: '#00a896' }}>Create one free →</Link>
        </p>
      </div>
    </main>
  )
}
