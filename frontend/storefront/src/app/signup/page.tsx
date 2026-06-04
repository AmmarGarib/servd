'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { useCustomerAuth } from '../../store/customerAuth'
import { ErrorToast } from '../../components/ui/ErrorToast'

// /signup — restyled to the on-system --servd-* tokens + Bricolage Grotesque
// display. SVG-iconed benefit chips (no emoji structural icons), per-input
// autoComplete hints so the OS surfaces the right autofill + SMS one-time
// code, six-box OTP entry, password show/hide toggle, inline validation.

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
  const [showPassword, setShowPassword] = useState(false)

  // Per-field inline validation state. Populated on blur (not keystroke)
  // so the user finishes typing before they get yelled at; cleared on
  // change so corrections immediately remove the error.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const setFieldError = (k: string, msg: string) => setFieldErrors((m) => ({ ...m, [k]: msg }))
  const clearFieldError = (k: string) => setFieldErrors((m) => { const n = { ...m }; delete n[k]; return n })

  // Six-box OTP entry: each digit lives in its own narrow input, focus
  // auto-advances on input and auto-reverses on backspace, paste fills
  // all six at once. Matches the OS / fintech UI convention customers
  // expect for code entry.
  const otpRefs = useRef<Array<HTMLInputElement | null>>([])
  const handleOtpChange = (idx: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    if (!digits) {
      // Backspace into empty box — clear this index and step back.
      const next = otp.split('')
      next[idx] = ''
      setOtp(next.join(''))
      return
    }
    if (digits.length > 1) {
      // Paste: fill from this index forward.
      const merged = (otp.slice(0, idx) + digits).slice(0, 6).padEnd(6, '').trim()
      setOtp(merged)
      const lastFilled = Math.min(idx + digits.length, 5)
      otpRefs.current[lastFilled]?.focus()
      return
    }
    const next = otp.padEnd(6, ' ').split('')
    next[idx] = digits
    setOtp(next.join('').trim())
    if (idx < 5) otpRefs.current[idx + 1]?.focus()
  }
  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otp[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus()
    }
    if (e.key === 'ArrowLeft' && idx > 0) otpRefs.current[idx - 1]?.focus()
    if (e.key === 'ArrowRight' && idx < 5) otpRefs.current[idx + 1]?.focus()
  }

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
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(58,14,105,0.16)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-line)'
    e.currentTarget.style.boxShadow   = 'none'
  }
  const primaryBtnStyle = (busy: boolean) => ({
    background: busy ? 'var(--servd-surface)' : 'var(--servd-green)',
    color: busy ? 'var(--servd-mute)' : '#0a0a0a',
    boxShadow: busy ? 'none' : '0 6px 18px rgba(58,14,105,0.28)',
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
              <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(58,14,105,0.08)', border: '1px solid rgba(58,14,105,0.25)' }}>
                <Link href="/login" className="text-sm font-black" style={{ color: 'var(--servd-green-dark)' }}>→ Sign in to your existing account</Link>
              </div>
            )}

            <form onSubmit={e => { void handleStep1(e) }} className="space-y-3" noValidate>
              <Field id="signup-name" label="Full name" type="text" autoComplete="name"
                value={name} onChange={(v) => { setName(v); clearFieldError('name') }}
                onValidate={() => name.trim().length < 2 ? setFieldError('name', 'Please enter your full name') : clearFieldError('name')}
                placeholder="Your name" autoFocus error={fieldErrors['name']}
                inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

              <Field id="signup-email" label="Email" type="email" autoComplete="email"
                value={email} onChange={(v) => { setEmail(v); clearFieldError('email') }}
                onValidate={() => /\S+@\S+\.\S+/.test(email.trim()) ? clearFieldError('email') : setFieldError('email', 'Please enter a valid email')}
                placeholder="you@example.com" error={fieldErrors['email']}
                inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

              <Field id="signup-phone" label="Mobile (WhatsApp)" type="tel" autoComplete="tel"
                inputMode="tel"
                value={phone} onChange={(v) => { setPhone(v); clearFieldError('phone') }}
                onValidate={() => phone.replace(/\D/g, '').length < 10 ? setFieldError('phone', 'Phone needs at least 10 digits') : clearFieldError('phone')}
                placeholder="0300 1234567" error={fieldErrors['phone']}
                inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

              <PasswordField id="signup-password" label="Password" autoComplete="new-password"
                value={password} onChange={(v) => { setPassword(v); clearFieldError('password') }}
                onValidate={() => password.length < 8 ? setFieldError('password', 'At least 8 characters') : clearFieldError('password')}
                placeholder="8+ characters" error={fieldErrors['password']}
                show={showPassword} onToggle={() => setShowPassword(v => !v)}
                inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

              <PasswordField id="signup-confirm" label="Confirm password" autoComplete="new-password"
                value={confirm} onChange={(v) => { setConfirm(v); clearFieldError('confirm') }}
                onValidate={() => confirm !== password ? setFieldError('confirm', "Passwords don't match") : clearFieldError('confirm')}
                placeholder="Repeat password" error={fieldErrors['confirm']}
                show={showPassword} onToggle={() => setShowPassword(v => !v)}
                inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

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
                <label className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>6-digit code</label>
                {/* Hidden input carries the autoComplete="one-time-code" hint
                    so iOS surfaces the SMS code from the notification banner.
                    The visible six boxes are the actual interactive UI. */}
                <input type="text" inputMode="numeric" autoComplete="one-time-code"
                  pattern="[0-9]*" maxLength={6} value={otp}
                  onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
                  tabIndex={-1} aria-hidden="true" />
                <div className="flex gap-2 justify-between">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <input
                      key={i}
                      ref={(el) => { otpRefs.current[i] = el }}
                      type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1}
                      value={otp[i] ?? ''}
                      onChange={(e) => handleOtpChange(i, e.target.value)}
                      onKeyDown={(e) => handleOtpKeyDown(i, e)}
                      onPaste={(e) => {
                        e.preventDefault()
                        const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
                        if (pasted) {
                          setOtp(pasted.padEnd(6, '').trim())
                          const target = Math.min(pasted.length, 5)
                          setTimeout(() => otpRefs.current[target]?.focus(), 0)
                        }
                      }}
                      autoFocus={i === 0}
                      aria-label={`Digit ${i + 1} of 6`}
                      className="w-11 h-14 text-center text-xl font-black rounded-xl focus:outline-none transition-all"
                      style={inpStyle}
                      onFocus={onFocus}
                      onBlur={onBlur}
                    />
                  ))}
                </div>
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

// ─── Form field helpers ────────────────────────────────────────────────────
// Field — plain labeled input with inline error placement (per WCAG: error
// adjacent to the field that caused it, not buried in a global toast).
interface FieldProps {
  id: string
  label: string
  type: string
  autoComplete: string
  value: string
  onChange: (v: string) => void
  onValidate: () => void
  placeholder?: string
  autoFocus?: boolean
  inputMode?: 'text' | 'tel' | 'email' | 'numeric'
  error?: string
  inp: (extra?: string) => string
  inpStyle: React.CSSProperties
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void
}
function Field(p: FieldProps) {
  return (
    <div>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>{p.label}</label>
      <input id={p.id} type={p.type} autoComplete={p.autoComplete}
        inputMode={p.inputMode}
        value={p.value} onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder} autoFocus={p.autoFocus} required
        aria-invalid={!!p.error} aria-describedby={p.error ? `${p.id}-err` : undefined}
        className={p.inp()} style={p.inpStyle}
        onFocus={p.onFocus}
        onBlur={(e) => { p.onBlur(e); p.onValidate() }} />
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: '#c0392b' }}>{p.error}</p>
      )}
    </div>
  )
}

interface PasswordFieldProps extends Omit<FieldProps, 'type' | 'inputMode'> {
  show: boolean
  onToggle: () => void
}
function PasswordField(p: PasswordFieldProps) {
  return (
    <div>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5" style={{ color: 'var(--servd-mute)' }}>{p.label}</label>
      <div className="relative">
        <input id={p.id} type={p.show ? 'text' : 'password'} autoComplete={p.autoComplete}
          value={p.value} onChange={(e) => p.onChange(e.target.value)}
          placeholder={p.placeholder} autoFocus={p.autoFocus} required
          aria-invalid={!!p.error} aria-describedby={p.error ? `${p.id}-err` : undefined}
          className={p.inp() + ' pr-12'} style={p.inpStyle}
          onFocus={p.onFocus}
          onBlur={(e) => { p.onBlur(e); p.onValidate() }} />
        <button type="button" onClick={p.onToggle}
          aria-label={p.show ? 'Hide password' : 'Show password'}
          aria-pressed={p.show}
          className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-lg"
          style={{ color: 'var(--servd-mute)' }}>
          {p.show ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          )}
        </button>
      </div>
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: '#c0392b' }}>{p.error}</p>
      )}
    </div>
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
