'use client'
import { useState, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { ErrorToast } from '../../components/ui/ErrorToast'
import { SmokeyBackground } from '../../components/ui/SmokeyBackground'
import { MagneticButton } from '../../components/ui/MagneticButton'
import { voice } from '../../lib/voice'
import { finaleTheme, brandFromReturnPath } from '../../components/checkout/brandTheme'

// /signup — glassmorphism card over the servd-purple WebGL shader.
//
// Two steps: details → code. ONE code is sent to WhatsApp and email at the same
// time; the customer types whichever copy arrives first. WhatsApp here is an
// unofficial channel that can drop; when it does, the email copy carries the
// signup and the number is verified later from /account.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

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

  // Brand-aware dressing from ?next= / ?return= (e.g. /stackd/checkout).
  // Presentation only: the post-signup redirect below is unchanged.
  const returnPath = params?.get('next') || params?.get('return') || null
  const brand = brandFromReturnPath(returnPath)
  const theme = finaleTheme(brand)
  const kicker = voice(brand).loginKicker
  const carry = returnPath && returnPath.startsWith('/') && !returnPath.startsWith('//')
    ? `?next=${encodeURIComponent(returnPath)}` : ''

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
    if (password.length < 8) { setError('Password must be at least 8 characters'); return }
    if (password !== confirm) { setError('Passwords do not match'); return }
    const digits = phone.replace(/\D/g, '')
    if (digits.length < 10) { setError('Enter a valid mobile number'); return }
    if (!/\S+@\S+\.\S+/.test(email.trim())) { setError('Enter a valid email'); return }
    setLoading(true)
    const sent = await requestCodes()
    setLoading(false)
    if (sent) setStep('otp')
  }

  async function handleStep2(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (otp.length < 6) { setError('Enter the 6-digit code'); return }
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
          setError('An account with this email already exists.')
          setStep('details')
        } else if (data.error?.code?.includes('OTP') || data.error?.code?.endsWith('CODE_REQUIRED')) {
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
  const inp = (extra = '') =>
    `w-full rounded-2xl px-4 py-3.5 text-sm font-semibold text-white placeholder:text-white/35 focus:outline-none transition-all ${extra}`
  const inpStyle: React.CSSProperties = { background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.20)', color: 'white' }
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.6)'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(255,255,255,0.12)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.20)'
    e.currentTarget.style.boxShadow   = 'none'
  }
  const primaryBtnStyle = (busy: boolean): React.CSSProperties => ({
    background: busy ? 'rgba(255,255,255,0.12)' : 'white',
    color: busy ? 'rgba(255,255,255,0.6)' : '#4E2A4F',
    boxShadow: busy ? 'none' : '0 8px 24px rgba(0,0,0,0.25)',
  })

  return (
    <main className="relative flex items-center justify-center px-5 py-12" style={{ minHeight: '100dvh', background: theme.smokeBase }}>
      <SmokeyBackground color={theme.smoke} backdropBlur="sm" />

      <div className="relative z-10 w-full max-w-sm">
        {brand === 'servd' ? (
          <Link href="/" aria-label="servd home" className="mb-3 block text-center"
            style={{ fontFamily: 'var(--font-display)', fontSize: '1.85rem', fontWeight: 800, letterSpacing: '-0.045em', color: 'white', textDecoration: 'none' }}>
            servd<span style={{ color: '#C9A6F0' }}>.</span>
          </Link>
        ) : (
          <Link href={`/${brand}`} aria-label={`${theme.name} home`} className="mb-3 block text-center"
            style={{ fontFamily: theme.display, fontSize: '2rem', fontWeight: brand === 'stackd' ? 700 : 400, letterSpacing: brand === 'simmer' ? '0.02em' : '-0.01em', color: theme.loginInk, textDecoration: 'none' }}>
            {theme.name}
          </Link>
        )}
        <p className="mb-5 text-center text-[11px] font-bold tracking-[0.24em]"
          style={{ color: theme.loginInk, opacity: 0.78, fontFamily: brand === 'simmer' ? theme.body : "'JetBrains Mono', ui-monospace, monospace", textTransform: 'lowercase' }}>
          {kicker}
        </p>

        <div className="w-full rounded-3xl px-7 py-8 bg-white/10 backdrop-blur-xl border border-white/20 shadow-2xl" style={{ animation: 'fadeSlideUp 0.4s both' }}>
          {step === 'details' ? (
            <>
              <h1 className="font-black tracking-tight text-white mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Create account</h1>
              <p className="text-sm mb-6 text-white/60">Free. Earn points on every order.</p>

              {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
              {emailTaken && (
                <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.25)' }}>
                  <Link href={`/login${carry}`} className="text-sm font-black text-white">→ Sign in to your existing account</Link>
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

                <p className="text-[11px] leading-snug pt-1 text-white/55">
                  We&rsquo;ll send a 6-digit code to your WhatsApp and your email.
                </p>
                <MagneticButton type="submit" disabled={loading}
                  className="w-full rounded-2xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                  style={primaryBtnStyle(loading)}>
                  {loading ? 'Sending code…' : 'Continue →'}
                </MagneticButton>
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

              <form onSubmit={e => { void handleStep2(e) }} className="space-y-4">
                <CodeBoxes
                  label="Your code"
                  sublabel={[phoneLive && 'WhatsApp', emailLive && 'email'].filter(Boolean).join(' and ') + ' — same code, use whichever arrives first'}
                  value={otp} onChange={setOtp}
                  autoFocus inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />
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

                <MagneticButton type="submit" disabled={loading || otp.length < 6}
                  className="w-full rounded-2xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
                  style={primaryBtnStyle(loading)}>
                  {loading ? 'Verifying…' : 'Verify & create account'}
                </MagneticButton>

                <div className="flex items-center justify-between text-xs -mx-2">
                  <button type="button" onClick={() => { setStep('details'); setOtp(''); setError('') }}
                    className="inline-flex items-center min-h-[44px] px-2 font-bold text-white/55 hover:text-white transition-colors">
                    ← Change details
                  </button>
                  <button type="button" disabled={resendCooldown > 0 || loading}
                    onClick={() => { void requestCodes() }}
                    className="inline-flex items-center min-h-[44px] px-2 font-bold text-white hover:text-white/80 disabled:opacity-40 transition-colors">
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
                <Link href={`/login${carry}`} className="font-black text-white hover:text-white/80 transition-colors">Sign in →</Link>
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
  inpStyle: React.CSSProperties
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void
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
      <div className="flex gap-1.5 sm:gap-2">
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
            className="flex-1 min-w-0 max-w-[2.75rem] h-14 text-center text-xl font-black rounded-xl focus:outline-none transition-all text-white"
            style={p.inpStyle}
            onFocus={p.onFocus}
            onBlur={p.onBlur}
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
  inp: (extra?: string) => string
  inpStyle: React.CSSProperties
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void
}
function Field(p: FieldProps) {
  return (
    <div>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">{p.label}</label>
      <input id={p.id} type={p.type} autoComplete={p.autoComplete}
        inputMode={p.inputMode}
        value={p.value} onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder} autoFocus={p.autoFocus} required
        aria-invalid={!!p.error} aria-describedby={p.error ? `${p.id}-err` : undefined}
        className={p.inp()} style={p.inpStyle}
        onFocus={p.onFocus}
        onBlur={(e) => { p.onBlur(e); p.onValidate() }} />
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
    <div>
      <label htmlFor={p.id} className="block text-[10px] font-black uppercase tracking-[0.22em] mb-1.5 text-white/55">{p.label}</label>
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
