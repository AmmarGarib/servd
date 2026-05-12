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

/**
 * F19 signup flow — two-step:
 *
 *   Step 1: collect name, email, password, phone, referral code. We request
 *           a WhatsApp OTP for the phone and move to step 2 once it dispatches.
 *   Step 2: collect the 6-digit code. Submitting it calls the registration
 *           endpoint with phone+otpCode; the server re-verifies the OTP and
 *           stamps phoneVerifiedAt on the new Customer row.
 *
 * The user can resend after a 30-second cooldown (server-enforced) or edit
 * their phone number to start over. We never echo the code back to the client.
 */
export default function SignupPage() {
  const router  = useRouter()
  const params  = useSearchParams()
  const setAuth = useCustomerAuth((s) => s.setAuth)

  const [step,    setStep]    = useState<'details' | 'otp'>('details')

  // Step 1 fields
  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [phone,    setPhone]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [referralCode, setReferralCode] = useState((params?.get('ref') ?? '').toUpperCase())

  // Step 2 fields
  const [otp,      setOtp]      = useState('')
  const [otpSentAt, setOtpSentAt] = useState<number | null>(null)
  const [resendCooldown, setResendCooldown] = useState(0)

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [emailTaken, setEmailTaken] = useState(false)

  // Tick down the resend cooldown every second so the button re-enables itself
  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function requestOtp(): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/customer/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), purpose: 'signup' }),
      })
      const data = await res.json() as { error?: { message?: string; code?: string } }
      if (!res.ok) {
        setError(data.error?.message ?? 'Could not send code — please check the number')
        return false
      }
      setOtpSentAt(Date.now())
      setResendCooldown(30)
      return true
    } catch {
      setError('Could not reach the server. Make sure the API is running.')
      return false
    }
  }

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    setEmailTaken(false)
    setError('')

    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 10) { setError('Enter a valid mobile number'); return }

    setLoading(true)
    const sent = await requestOtp()
    setLoading(false)
    if (sent) setStep('otp')
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (otp.length < 4) { setError('Enter the 6-digit code'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/customer/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:    name.trim(),
          email:   email.trim(),
          password,
          phone:   phone.trim(),
          otpCode: otp.trim(),
          ...(referralCode.trim() && { referralCode: referralCode.trim().toUpperCase() }),
        }),
      })
      const data = await res.json() as { token?: string; customer?: { id: string }; error?: { message?: string; code?: string } }
      if (!res.ok) {
        if (res.status === 409 || data.error?.code === 'EMAIL_TAKEN') {
          setEmailTaken(true)
          setError('An account with this email already exists.')
          setStep('details')
        } else if (data.error?.code === 'OTP_WRONG' || data.error?.code === 'OTP_EXPIRED' || data.error?.code === 'OTP_NOT_FOUND') {
          // Stay on the OTP step so they can retype the code.
          setError(data.error?.message ?? 'Invalid or expired code')
        } else {
          setError(data.error?.message ?? 'Registration failed. Please try again.')
        }
        return
      }
      setAuth(data.token!, data.customer!.id)
      router.replace('/account')
    } catch {
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
        {step === 'details' ? (
          <>
            <h1 className="text-3xl font-black tracking-tight mb-1" style={{ color: '#18160f' }}>Create account</h1>
            <p className="text-sm mb-6" style={{ color: 'rgba(24,22,15,0.45)' }}>Join free — earn points on every order</p>

            {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
            {emailTaken && error && (
              <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(0,168,150,0.07)', border: '1px solid rgba(0,168,150,0.2)' }}>
                <Link href="/login" className="text-sm font-black" style={{ color: '#00a896' }}>→ Sign in to your existing account</Link>
              </div>
            )}

            <form onSubmit={e => { void handleStep1(e) }} className="space-y-3">
              {([
                ['text',     'Full name',        'Your name',     name,     setName],
                ['email',    'Email',            'you@example.com', email,  setEmail],
                ['tel',      'Mobile (WhatsApp)', '0300 1234567',  phone,    setPhone],
                ['password', 'Password',         '8+ characters', password, setPassword],
                ['password', 'Confirm password', 'Repeat password', confirm, setConfirm],
              ] as const).map(([type, label, ph, val, set], i) => (
                <div key={label}>
                  <label className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5" style={{ color: 'rgba(24,22,15,0.35)' }}>{label}</label>
                  <input type={type} value={val} onChange={e => (set as (v: string) => void)(e.target.value)}
                    placeholder={ph} autoFocus={i === 0} required
                    className={inp()} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
                </div>
              ))}
              <p className="text-[11px] leading-snug pt-1" style={{ color: 'rgba(24,22,15,0.4)' }}>
                We&rsquo;ll send a 6-digit code to your WhatsApp to verify the number.
              </p>
              <button type="submit" disabled={loading}
                className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#fff', boxShadow: '0 4px 20px rgba(0,212,177,0.25)' }}>
                {loading ? 'Sending code…' : 'Continue →'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-black tracking-tight mb-1" style={{ color: '#18160f' }}>Verify your number</h1>
            <p className="text-sm mb-6" style={{ color: 'rgba(24,22,15,0.45)' }}>
              We sent a code to <span className="font-semibold" style={{ color: '#18160f' }}>{phone}</span>
            </p>

            {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

            <form onSubmit={e => { void handleStep2(e) }} className="space-y-3">
              <div>
                <label htmlFor="otp-input" className="block text-[10px] font-black uppercase tracking-[0.2em] mb-1.5" style={{ color: 'rgba(24,22,15,0.35)' }}>6-digit code</label>
                <input id="otp-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••" autoFocus required
                  className={inp('tracking-[0.4em] text-center text-lg font-black')} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
              </div>

              <button type="submit" disabled={loading || otp.length < 4}
                className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#fff', boxShadow: '0 4px 20px rgba(0,212,177,0.25)' }}>
                {loading ? 'Verifying…' : 'Verify & Create Account'}
              </button>

              <div className="flex items-center justify-between pt-2 text-xs">
                <button type="button" onClick={() => { setStep('details'); setOtp(''); setError('') }}
                  className="font-bold" style={{ color: 'rgba(24,22,15,0.55)' }}>
                  ← Change number
                </button>
                <button type="button" disabled={resendCooldown > 0 || loading}
                  onClick={() => { void requestOtp() }}
                  className="font-bold disabled:opacity-40"
                  style={{ color: '#00a896' }}>
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 'details' && (
          <>
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
          </>
        )}
      </div>
    </main>
  )
}
