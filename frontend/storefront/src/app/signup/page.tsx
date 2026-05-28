'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'

// /signup — restyled to the on-system --servd-* tokens + Bricolage Grotesque
// display. Replaces the legacy teal→indigo gradient + placeholder "S" mark
// with the real servd wordmark, --servd-green primary CTA, and three
// SVG-iconed benefit chips (no emoji structural icons).

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

/**
 * F19 signup flow — two-step:
 *   Step 1: collect name, email, password, phone, referral code. Server
 *           dispatches a WhatsApp OTP for the phone and we move to step 2.
 *   Step 2: collect the 6-digit code. Submitting calls register with phone
 *           + otpCode; server re-verifies and stamps phoneVerifiedAt.
 *
 * Resend after 30s cooldown. Never echo the code back to the client.
 */
export default function SignupPage() {
  const router  = useRouter()
  const params  = useSearchParams()
  const setAuth = useCustomerAuth((s) => s.setAuth)

  const [step,    setStep]    = useState<'details' | 'otp'>('details')

  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [phone,    setPhone]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [referralCode, _setReferralCode] = useState((params?.get('ref') ?? '').toUpperCase())

  const [otp,             setOtp]             = useState('')
  const [_otpSentAt,      setOtpSentAt]       = useState<number | null>(null)
  const [resendCooldown,  setResendCooldown]  = useState(0)

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [emailTaken, setEmailTaken] = useState(false)

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

  const inp = (extra = '') =>
    `w-full rounded-2xl px-4 py-4 text-sm font-semibold focus:outline-none transition-all placeholder:text-black/30 ${extra}`
  const inpStyle = { background: 'white', border: '1.5px solid var(--servd-line)', color: 'var(--servd-ink)' }
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-green)'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(30,58,138,0.16)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-line)'
    e.currentTarget.style.boxShadow   = 'none'
  }
  const primaryBtnStyle = (busy: boolean) => ({
    background: busy ? 'var(--servd-surface)' : 'var(--servd-green)',
    color: busy ? 'var(--servd-mute)' : '#0a0a0a',
    boxShadow: busy ? 'none' : '0 6px 18px rgba(30,58,138,0.28)',
  })

  return (
    <main className="flex flex-col items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: 'var(--servd-bg)' }}>

      <Link href="/" aria-label="servd home" className="mb-8" style={{
        fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em',
        color: 'var(--servd-black)', textDecoration: 'none', display: 'inline-flex', alignItems: 'baseline', gap: '0.1rem',
      }}>
        servd<span style={{ color: 'var(--servd-green)' }}>.</span>
      </Link>

      <div className="w-full max-w-sm rounded-3xl px-6 py-8" style={{ background: 'white', border: '1px solid var(--servd-line)', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', animation: 'fadeSlideUp 0.4s both' }}>
        {step === 'details' ? (
          <>
            <h1 className="font-display font-black tracking-tight mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2rem, 6vw, 2.4rem)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>Create account</h1>
            <p className="text-sm mb-6" style={{ color: 'var(--servd-mute)' }}>Free. Earn points on every order.</p>

            {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
            {emailTaken && (
              <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(30,58,138,0.08)', border: '1px solid rgba(30,58,138,0.25)' }}>
                <Link href="/login" className="text-sm font-black" style={{ color: 'var(--servd-green-dark)' }}>→ Sign in to your existing account</Link>
              </div>
            )}

            <form onSubmit={e => { void handleStep1(e) }} className="space-y-3">
              {([
                ['text',     'Full name',         'Your name',       name,     setName],
                ['email',    'Email',             'you@example.com', email,    setEmail],
                ['tel',      'Mobile (WhatsApp)', '0300 1234567',    phone,    setPhone],
                ['password', 'Password',          '8+ characters',   password, setPassword],
                ['password', 'Confirm password',  'Repeat password', confirm,  setConfirm],
              ] as const).map(([type, label, ph, val, set], i) => (
                <div key={label}>
                  <label className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>{label}</label>
                  <input type={type} value={val} onChange={e => (set as (v: string) => void)(e.target.value)}
                    placeholder={ph} autoFocus={i === 0} required
                    className={inp()} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
                </div>
              ))}
              <p className="text-[11px] leading-snug pt-1" style={{ color: 'var(--servd-mute)' }}>
                We&rsquo;ll send a 6-digit code to your WhatsApp to verify the number.
              </p>
              <button type="submit" disabled={loading}
                className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={primaryBtnStyle(loading)}>
                {loading ? 'Sending code…' : 'Continue →'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="font-display font-black tracking-tight mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(2rem, 6vw, 2.4rem)', color: 'var(--servd-ink)', letterSpacing: '-0.03em' }}>Verify your number</h1>
            <p className="text-sm mb-6" style={{ color: 'var(--servd-mute)' }}>
              We sent a code to <span className="font-semibold" style={{ color: 'var(--servd-ink)' }}>{phone}</span>
            </p>

            {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

            <form onSubmit={e => { void handleStep2(e) }} className="space-y-3">
              <div>
                <label htmlFor="otp-input" className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>6-digit code</label>
                <input id="otp-input" type="text" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                  value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, ''))}
                  placeholder="••••••" autoFocus required
                  className={inp('tracking-[0.4em] text-center text-lg font-black')} style={inpStyle} onFocus={onFocus} onBlur={onBlur} />
              </div>

              <button type="submit" disabled={loading || otp.length < 4}
                className="w-full rounded-2xl py-4 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                style={primaryBtnStyle(loading)}>
                {loading ? 'Verifying…' : 'Verify & create account'}
              </button>

              <div className="flex items-center justify-between pt-2 text-xs">
                <button type="button" onClick={() => { setStep('details'); setOtp(''); setError('') }}
                  className="font-bold" style={{ color: 'var(--servd-mute)' }}>
                  ← Change number
                </button>
                <button type="button" disabled={resendCooldown > 0 || loading}
                  onClick={() => { void requestOtp() }}
                  className="font-bold disabled:opacity-40"
                  style={{ color: 'var(--servd-green-dark)' }}>
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
                </button>
              </div>
            </form>
          </>
        )}

        {step === 'details' && (
          <>
            <div className="grid grid-cols-3 gap-2 mt-5">
              {[
                { icon: <StarIcon />,  label: 'Earn points' },
                { icon: <PinIcon />,   label: 'Track orders' },
                { icon: <GiftIcon />,  label: 'Member perks' },
              ].map((b) => (
                <div key={b.label} className="flex flex-col items-center gap-1.5 py-3 rounded-2xl"
                  style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)' }}>
                  <span style={{ color: 'var(--servd-green-dark)', display: 'inline-flex' }}>{b.icon}</span>
                  <span className="text-[10px] font-bold" style={{ color: 'var(--servd-mute)' }}>{b.label}</span>
                </div>
              ))}
            </div>

            <p className="text-center text-sm mt-5" style={{ color: 'var(--servd-mute)' }}>
              Already have an account?{' '}
              <Link href="/login" className="font-black" style={{ color: 'var(--servd-green-dark)' }}>Sign in →</Link>
            </p>
          </>
        )}
      </div>

      <Link href="/" className="mt-6 text-xs font-semibold" style={{ color: 'var(--servd-mute)', textDecoration: 'none' }}>
        ← Back to home
      </Link>
    </main>
  )
}

// ── Inline SVG icons — no emoji as structural icons per the design system. ──
function StarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  )
}
function PinIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}
function GiftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 12 20 22 4 22 4 12"/>
      <rect x="2" y="7" width="20" height="5"/>
      <line x1="12" y1="22" x2="12" y2="7"/>
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/>
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>
    </svg>
  )
}
