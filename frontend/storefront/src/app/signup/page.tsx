'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { ErrorToast } from '../../components/ui/ErrorToast'
import { SmokeyBackground } from '../../components/ui/SmokeyBackground'
import { TactileButton, type TactileState } from '../../components/tactile/TactileButton'
import a from '../../components/auth/auth.module.css'

// /signup — glassmorphism card over the servd-purple WebGL shader.
//
// Two steps: details → code. ONE code is sent to WhatsApp and email at the same
// time; the customer types whichever copy arrives first. WhatsApp here is an
// unofficial channel that can drop; when it does, the email copy carries the
// signup and the number is verified later from /account.
//
// Presentation: fields grow their focus ring instead of snapping, the submits
// are rubber TactileButtons (loading → hop dots, a failure → shake), and the
// field a failure points at is marked aria-invalid and shakes once. A code
// error shakes the code boxes. The request/verify flow is untouched.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

type BadField = 'name' | 'email' | 'phone' | 'password' | 'confirm' | 'code'

/** True for a moment each time `signal` becomes a new truthy value, long
 *  enough for a one-shot shake to play. */
function usePulse(signal: unknown, ms = 460): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    if (!signal) { setOn(false); return }
    setOn(true)
    const t = window.setTimeout(() => setOn(false), ms)
    return () => window.clearTimeout(t)
  }, [signal, ms])
  return on
}

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

  const [otp,             setOtp]             = useState('')   // WhatsApp code
  type ChannelStatus = 'sent' | 'cooldown' | 'failed'
  const [channels,        setChannels]        = useState<{ phone: ChannelStatus; email: ChannelStatus } | null>(null)
  const [resendCooldown,  setResendCooldown]  = useState(0)
  const phoneLive = channels?.phone === 'sent' || channels?.phone === 'cooldown'
  const emailLive = channels?.email === 'sent' || channels?.email === 'cooldown'

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [emailTaken, setEmailTaken] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // Presentation only: which field the last failure points at.
  const [bad, setBad] = useState<BadField | null>(null)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const setFieldError = (k: string, msg: string) => setFieldErrors((m) => ({ ...m, [k]: msg }))
  const clearFieldError = (k: string) => setFieldErrors((m) => { const n = { ...m }; delete n[k]; return n })

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function requestCodes(): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/customer/request-signup-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), email: email.trim() }),
      })
      const data = await res.json() as {
        phone?: { status: ChannelStatus }; email?: { status: ChannelStatus }
        error?: { message?: string; code?: string }
      }
      if (!res.ok) {
        setError(data.error?.message ?? 'Could not send codes — please check your details')
        return false
      }
      setChannels({ phone: data.phone!.status, email: data.email!.status })
      setResendCooldown(30)
      return true
    } catch {
      setError('Could not reach the server. Please try again.')
      return false
    }
  }

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    setEmailTaken(false)
    setError('')
    setBad(null)
    if (password.length < 8) { setBad('password'); setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setBad('confirm'); setError('Passwords do not match'); return }
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 10) { setBad('phone'); setError('Enter a valid mobile number'); return }
    if (!/\S+@\S+\.\S+/.test(email.trim())) { setBad('email'); setError('Enter a valid email'); return }
    setLoading(true)
    const sent = await requestCodes()
    setLoading(false)
    if (sent) setStep('otp')
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBad(null)
    if (otp.length < 6) { setBad('code'); setError('Enter the 6-digit code'); return }
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
          code:    otp.trim(),
          ...(referralCode.trim() && { referralCode: referralCode.trim().toUpperCase() }),
        }),
      })
      const data = await res.json() as { token?: string; customer?: { id: string }; error?: { message?: string; code?: string } }
      if (!res.ok) {
        if (res.status === 409 || data.error?.code === 'EMAIL_TAKEN') {
          setEmailTaken(true)
          setBad('email')
          setError('An account with this email already exists.')
          setStep('details')
        } else if (data.error?.code?.includes('OTP') || data.error?.code?.endsWith('CODE_REQUIRED')) {
          setBad('code')
          setError(data.error?.message ?? 'Invalid or expired code')
        } else {
          setError(data.error?.message ?? 'Registration failed. Please try again.')
        }
        return
      }
      setAuth(data.token!, data.customer!.id)
      // Honour ?next=/?return= (checkout / order tracker) — same-origin only.
      const dest = params.get('next') || params.get('return')
      router.replace(dest && dest.startsWith('/') && !dest.startsWith('//') ? dest : '/account')
    } catch {
      setError('Could not reach the server. Make sure the API is running.')
    } finally {
      setLoading(false)
    }
  }

  // ── Glass styling shared with the field helpers ──
  // The focus ring grows in CSS (auth.module.css), so no JS style swaps.
  const inp = (extra = '') => `${a.field} ${extra}`.trim()

  const failed = usePulse(error)
  const shakeOn = (f: BadField) => failed && bad === f
  const btnState: TactileState = loading ? 'loading' : failed ? 'error' : 'idle'
  const clearBad = (f: BadField) => setBad((b) => (b === f ? null : b))

  return (
    <main className="relative flex items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: '#1E1420' }}>
      <SmokeyBackground color="#4E2A4F" backdropBlur="sm" />

      <div className="relative z-10 w-full max-w-sm">
        <Link href="/" aria-label="servd home" className="mb-6 block text-center"
          style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em', color: 'white', textDecoration: 'none' }}>
          servd<span style={{ color: '#C9A6F0' }}>.</span>
        </Link>

        <div className={`w-full rounded-3xl px-7 py-8 bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl ${a.card}`}>
          {step === 'details' ? (
            <>
              <h1 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Create account</h1>
              <p className="text-sm mb-6 text-white/60">Free. Earn points on every order.</p>

              {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
              {emailTaken && (
                <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.25)' }}>
                  <Link href="/login" className="text-sm font-black text-white">→ Sign in to your existing account</Link>
                </div>
              )}

              <form onSubmit={e => { if (loading) { e.preventDefault(); return } void handleStep1(e) }} className="space-y-3" noValidate>
                <Field id="signup-name" label="Full name" type="text" autoComplete="name"
                  value={name} onChange={(v) => { setName(v); clearFieldError('name'); clearBad('name') }}
                  onValidate={() => name.trim().length < 2 ? setFieldError('name', 'Please enter your full name') : clearFieldError('name')}
                  placeholder="Your name" autoFocus error={fieldErrors['name']}
                  bad={bad === 'name'} shake={shakeOn('name')} inp={inp} />

                <Field id="signup-email" label="Email" type="email" autoComplete="email"
                  value={email} onChange={(v) => { setEmail(v); clearFieldError('email'); clearBad('email') }}
                  onValidate={() => /\S+@\S+\.\S+/.test(email.trim()) ? clearFieldError('email') : setFieldError('email', 'Please enter a valid email')}
                  placeholder="you@example.com" error={fieldErrors['email']}
                  bad={bad === 'email'} shake={shakeOn('email')} inp={inp} />

                <Field id="signup-phone" label="Mobile (WhatsApp)" type="tel" autoComplete="tel"
                  inputMode="tel"
                  value={phone} onChange={(v) => { setPhone(v); clearFieldError('phone'); clearBad('phone') }}
                  onValidate={() => phone.replace(/\D/g, '').length < 10 ? setFieldError('phone', 'Phone needs at least 10 digits') : clearFieldError('phone')}
                  placeholder="0300 1234567" error={fieldErrors['phone']}
                  bad={bad === 'phone'} shake={shakeOn('phone')} inp={inp} />

                <PasswordField id="signup-password" label="Password" autoComplete="new-password"
                  value={password} onChange={(v) => { setPassword(v); clearFieldError('password'); clearBad('password') }}
                  onValidate={() => password.length < 8 ? setFieldError('password', 'At least 8 characters') : clearFieldError('password')}
                  placeholder="8+ characters" error={fieldErrors['password']}
                  show={showPassword} onToggle={() => setShowPassword(v => !v)}
                  bad={bad === 'password'} shake={shakeOn('password')} inp={inp} />

                <PasswordField id="signup-confirm" label="Confirm password" autoComplete="new-password"
                  value={confirm} onChange={(v) => { setConfirm(v); clearFieldError('confirm'); clearBad('confirm') }}
                  onValidate={() => confirm !== password ? setFieldError('confirm', "Passwords don't match") : clearFieldError('confirm')}
                  placeholder="Repeat password" error={fieldErrors['confirm']}
                  show={showPassword} onToggle={() => setShowPassword(v => !v)}
                  bad={bad === 'confirm'} shake={shakeOn('confirm')} inp={inp} />

                <p className="text-[11px] leading-snug pt-1 text-white/55">
                  We&rsquo;ll send a 6-digit code to your WhatsApp and your email.
                </p>
                <TactileButton type="submit" state={btnState} loadingLabel="Sending code…" className={`${a.submit} mt-1`}>
                  Continue <span className={a.submitArrow} aria-hidden="true">→</span>
                </TactileButton>
              </form>
            </>
          ) : (
            <>
              <h1 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Verify it&rsquo;s you</h1>
              <p className="text-sm mb-6 text-white/60">
                {phoneLive && emailLive
                  ? 'We sent one code to your WhatsApp and your email. Enter it below.'
                  : 'Enter the code we sent you.'}
              </p>

              {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

              <form onSubmit={e => { if (loading) { e.preventDefault(); return } void handleStep2(e) }} className="space-y-4">
                <CodeBoxes
                  label="Your code"
                  sublabel={[phoneLive && 'WhatsApp', emailLive && 'email'].filter(Boolean).join(' and ') + ' — same code, use whichever arrives first'}
                  value={otp} onChange={(v) => { setOtp(v); clearBad('code') }}
                  autoFocus invalid={bad === 'code'} shake={shakeOn('code')} />
                {channels?.phone === 'failed' && (
                  <p className="text-[11px] leading-snug text-white/60 rounded-2xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    WhatsApp isn&rsquo;t reachable right now, so the code went to your email only. You can verify your number later from your account.
                  </p>
                )}
                {channels?.email === 'failed' && (
                  <p className="text-[11px] leading-snug text-white/60 rounded-2xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    The code only reached your WhatsApp just now. You can verify your email later from your account.
                  </p>
                )}

                <TactileButton type="submit" state={btnState} loadingLabel="Verifying…"
                  disabled={!loading && otp.length < 6}
                  className={`${a.submit} mt-1`}>
                  Verify &amp; create account
                </TactileButton>

                <div className="flex items-center justify-between text-xs -mx-2">
                  <button type="button" onClick={() => { setStep('details'); setOtp(''); setError('') }}
                    className={`inline-flex items-center min-h-[44px] px-2 font-bold text-white/55 hover:text-white ${a.press}`}>
                    ← Change details
                  </button>
                  <button type="button" disabled={resendCooldown > 0 || loading}
                    onClick={() => { void requestCodes() }}
                    className={`inline-flex items-center min-h-[44px] px-2 font-bold text-white hover:text-white/80 disabled:opacity-40 ${a.press}`}>
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
                    style={{ background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.18)' }}>
                    <span style={{ color: 'rgba(255,255,255,0.85)', display: 'inline-flex' }}>{b.icon}</span>
                    <span className="text-[10px] font-bold text-white/60">{b.label}</span>
                  </div>
                ))}
              </div>

              <p className="text-center text-sm mt-5 text-white/60">
                Already have an account?{' '}
                <Link href="/login" className="font-black text-white hover:text-white/80 transition-colors">Sign in →</Link>
              </p>
            </>
          )}
        </div>

        <Link href="/" className="mt-6 block text-center text-xs font-semibold text-white/50 hover:text-white/80 transition-colors" style={{ textDecoration: 'none' }}>
          ← Back to home
        </Link>
      </div>
    </main>
  )
}

// ─── Six-box code input ────────────────────────────────────────────────────
// One per channel. Own refs, so two of them on the page don't fight over focus.
function CodeBoxes(p: {
  label: string
  sublabel: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  invalid?: boolean
  shake?: boolean
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const set = (idx: number, raw: string) => {
    const digits = raw.replace(/\D/g, '')
    const cur = p.value.padEnd(6, ' ').split('')
    if (!digits) { cur[idx] = ' '; p.onChange(cur.join('').trimEnd()); return }
    if (digits.length > 1) {
      const merged = (p.value.slice(0, idx) + digits).slice(0, 6)
      p.onChange(merged)
      refs.current[Math.min(merged.length, 5)]?.focus()
      return
    }
    cur[idx] = digits
    p.onChange(cur.join('').replace(/ /g, '').slice(0, 6))
    if (idx < 5) refs.current[idx + 1]?.focus()
  }
  return (
    <div>
      <label className="block text-[10px] font-black uppercase tracking-[0.22em] mb-0.5 text-white/55">{p.label}</label>
      <p className="text-[11px] mb-1.5 text-white/45 truncate">{p.sublabel}</p>
      <div className={`flex gap-1.5 sm:gap-2 ${p.shake ? 't-shake' : ''}`}>
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={(el) => { refs.current[i] = el }}
            type="text" inputMode="numeric" pattern="[0-9]*" maxLength={1}
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            value={p.value[i] ?? ''}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Backspace' && !p.value[i] && i > 0) refs.current[i - 1]?.focus()
              if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus()
              if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus()
            }}
            onPaste={(e) => {
              e.preventDefault()
              const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
              if (pasted) { p.onChange(pasted); setTimeout(() => refs.current[Math.min(pasted.length, 5)]?.focus(), 0) }
            }}
            autoFocus={p.autoFocus && i === 0}
            aria-label={`${p.label}, digit ${i + 1} of 6`}
            aria-invalid={p.invalid || undefined}
            className={`${a.field} ${a.digit} ${p.value[i] ? a.digitFilled : ''}`}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Form field helpers ────────────────────────────────────────────────────
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
  /** The last submit failed on this field. */
  bad?: boolean
  /** Play the one-shot shake now. */
  shake?: boolean
  inp: (extra?: string) => string
}
function Field(p: FieldProps) {
  return (
    <div className={p.shake ? 't-shake' : undefined}>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">{p.label}</label>
      <input id={p.id} type={p.type} autoComplete={p.autoComplete}
        inputMode={p.inputMode}
        value={p.value} onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder} autoFocus={p.autoFocus} required
        aria-invalid={!!p.error || !!p.bad} aria-describedby={p.error ? `${p.id}-err` : undefined}
        className={p.inp()}
        onBlur={() => { p.onValidate() }} />
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: '#ffb4ab' }}>{p.error}</p>
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
    <div className={p.shake ? 't-shake' : undefined}>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">{p.label}</label>
      <div className="relative">
        <input id={p.id} type={p.show ? 'text' : 'password'} autoComplete={p.autoComplete}
          value={p.value} onChange={(e) => p.onChange(e.target.value)}
          placeholder={p.placeholder} autoFocus={p.autoFocus} required
          aria-invalid={!!p.error || !!p.bad} aria-describedby={p.error ? `${p.id}-err` : undefined}
          className={p.inp(a.fieldPad)}
          onBlur={() => { p.onValidate() }} />
        <button type="button" onClick={p.onToggle}
          aria-label={p.show ? 'Hide password' : 'Show password'}
          aria-pressed={p.show}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-white/50 hover:text-white/80 transition-colors">
          {p.show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: '#ffb4ab' }}>{p.error}</p>
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
