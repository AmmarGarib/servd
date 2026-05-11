'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'

function ErrorToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [message, onDismiss])
  return (
    <div
      className="fixed top-4 left-1/2 z-[9999] w-[calc(100vw-2rem)] max-w-sm"
      style={{ transform: 'translateX(-50%)', animation: 'slideDownFade 0.25s cubic-bezier(0.22,1,0.36,1) both' }}>
      <div className="flex items-start gap-3 rounded-2xl px-4 py-3.5 shadow-2xl"
        style={{ background: '#1a0505', border: '1.5px solid #ef4444', boxShadow: '0 8px 32px rgba(239,68,68,0.35)' }}>
        <span style={{ fontSize: '1.1rem', lineHeight: 1.4 }}>⚠️</span>
        <p className="flex-1 text-sm font-bold leading-snug" style={{ color: '#fca5a5' }}>{message}</p>
        <button onClick={onDismiss} className="text-red-400/60 hover:text-red-300 text-lg leading-none shrink-0">×</button>
      </div>
    </div>
  )
}

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export default function SignupPage() {
  const router  = useRouter()
  const params  = useSearchParams()
  const setAuth = useCustomerAuth((s) => s.setAuth)

  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [emailTaken, setEmailTaken] = useState(false)
  // Referral code from ?ref=ABC12345 query param. Editable by user (in case
  // they have someone else's code and arrived via a non-referral link).
  const [referralCode, setReferralCode] = useState((params?.get('ref') ?? '').toUpperCase())

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setEmailTaken(false)
    if (password.length < 6) { setError('Password must be at least 6 characters'); return }
    if (password !== confirm)  { setError('Passwords do not match'); return }
    setError('')
    setLoading(true)
    try {
      const res  = await fetch(`${API_URL}/api/v1/auth/customer/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
          ...(referralCode.trim() && { referralCode: referralCode.trim().toUpperCase() }),
        }),
      })
      const data = await res.json() as { token?: string; customer?: { id: string }; error?: { message?: string; code?: string } }
      if (!res.ok) {
        if (res.status === 409 || data.error?.code === 'EMAIL_TAKEN') {
          setEmailTaken(true)
          setError('An account with this email already exists.')
        } else {
          setError(data.error?.message ?? 'Registration failed. Please try again.')
        }
        return
      }
      setAuth(data.token!, data.customer!.id)
      router.replace('/account')
    } catch (err) {
      console.error('[signup] fetch error:', err)
      setError('Could not reach the server. Make sure the API is running.')
    } finally {
      setLoading(false)
    }
  }

  const inp = (base = '') =>
    `w-full rounded-2xl px-4 py-4 text-sm font-semibold focus:outline-none transition-all placeholder:text-black/25 ${base}`
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
    <main className="flex flex-col items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: 'transparent' }}>

      <div className="flex items-center gap-2.5 mb-8">
        <div className="h-9 w-9 rounded-xl flex items-center justify-center font-black text-white text-sm"
          style={{ background: 'linear-gradient(135deg, #00D4B1, #6366F1)', boxShadow: '0 4px 14px rgba(0,212,177,0.3)' }}>
          S
        </div>
        <span className="font-black text-xl tracking-tighter text-shimmer">servd</span>
      </div>

      <div className="w-full max-w-sm rounded-3xl px-6 py-8 shadow-xl" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.07)', animation: 'fadeSlideUp 0.4s both' }}>
        <h1 className="text-3xl font-black tracking-tight mb-1" style={{ color: '#18160f' }}>Create account</h1>
        <p className="text-sm mb-6" style={{ color: 'rgba(24,22,15,0.45)' }}>Join free — earn points on every order</p>

        {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
        {emailTaken && error && (
          <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(0,168,150,0.07)', border: '1px solid rgba(0,168,150,0.2)' }}>
            <Link href="/login" className="text-sm font-black" style={{ color: '#00a896' }}>→ Sign in to your existing account</Link>
          </div>
        )}

        <form onSubmit={e => { void handleSubmit(e) }} className="space-y-3">
          {([['text','Full name','Your name',name,setName], ['email','Email','you@example.com',email,setEmail],
             ['password','Password','6+ characters',password,setPassword], ['password','Confirm password','Repeat password',confirm,setConfirm]] as const).map(([type, label, ph, val, set], i) => (
            <div key={label}>
              <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5" style={{ color: 'rgba(24,22,15,0.35)' }}>{label}</label>
              <input type={type} value={val} onChange={e => (set as (v: string) => void)(e.target.value)}
                placeholder={ph} autoFocus={i === 0} required
                className={inp()} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
            </div>
          ))}
          <button type="submit" disabled={loading}
            className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
            style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#fff', boxShadow: '0 4px 20px rgba(0,212,177,0.25)' }}>
            {loading ? 'Creating account…' : 'Create Account →'}
          </button>
        </form>

        <div className="grid grid-cols-3 gap-2 mt-5">
          {[{ icon: '⭐', label: 'Earn Points' }, { icon: '📍', label: 'Track Orders' }, { icon: '🎁', label: 'Promos' }].map(b => (
            <div key={b.label} className="flex flex-col items-center gap-1.5 py-3 rounded-2xl"
              style={{ background: 'rgba(0,0,0,0.03)', border: '1px solid rgba(0,0,0,0.07)' }}>
              <span style={{ fontSize: '1.1rem' }}>{b.icon}</span>
              <span className="text-[10px] font-bold" style={{ color: 'rgba(24,22,15,0.4)' }}>{b.label}</span>
            </div>
          ))}
        </div>

        <p className="text-center text-sm mt-5" style={{ color: 'rgba(24,22,15,0.35)' }}>
          Already have an account?{' '}
          <Link href="/login" className="font-black" style={{ color: '#00a896' }}>Sign in →</Link>
        </p>
      </div>
    </main>
  )
}
