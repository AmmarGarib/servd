'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff } from 'lucide-react'
import { useCustomerAuth } from '../../store/customerAuth'
import { BlockedNotice, fetchBlocks, type AccountBlock } from '../account/BlockedNotice'
import { ErrorToast } from '../ui/ErrorToast'
import { MagneticButton } from '../ui/MagneticButton'
import { isPkMobile, normalisePhone } from '../../lib/phone'
import { NETWORK_ERROR, customerErrorMessage, postAuthDest, useAuthReturnPath, withReturnPath, type ApiErrorBody } from './authFlow'

// The storefront's one-code sign-up (details → code). ONE code is sent to
// WhatsApp and email at the same time; the customer types whichever copy
// arrives first. WhatsApp here is an unofficial channel that can drop; when it
// does, the email copy carries the signup and the number is verified later
// from /account. Shared by /signup and the `signup_form` block (mode
// 'signup'), so there is exactly one sign-up flow. Styled for a dark purple
// surface — callers put it on one.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** ?ref=CODE on the current URL, read at submit time. */
function referralCode(): string {
  if (typeof window === 'undefined') return ''
  return (new URLSearchParams(window.location.search).get('ref') ?? '').trim().toUpperCase()
}

export function SignupForm({
  title = 'Create account',
  subtitle = 'Free. Earn points on every order.',
  headingAs: H = 'h1',
  onSuccess,
  autoFocus = true,
  idPrefix = 'signup',
}: {
  title?: string
  subtitle?: string
  headingAs?: 'h1' | 'h2'
  /** Called after the account is created instead of redirecting. */
  onSuccess?: () => void
  autoFocus?: boolean
  idPrefix?: string
}) {
  const router  = useRouter()
  const setAuth = useCustomerAuth((s) => s.setAuth)
  // ?next= / ?return= (checkout, order tracker) — carried onto the "Sign in"
  // links so hopping to /login keeps the customer's way back.
  const loginHref = withReturnPath('/login', useAuthReturnPath())

  const [step,    setStep]    = useState<'details' | 'otp'>('details')
  // A blocked account is told so right after sign-in (appeals on); the way
  // forward is one button. Empty / null while appeals are off.
  const [blocked, setBlocked] = useState<AccountBlock[] | null>(null)
  const proceed = () => { if (onSuccess) onSuccess(); else router.replace(postAuthDest()) }

  const [name,     setName]     = useState('')
  const [email,    setEmail]    = useState('')
  const [phone,    setPhone]    = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')

  // The one code (6 fixed slots; never joined or trimmed, so a gap stays a gap).
  const [codes,           setCodesRaw]        = useState<string[]>(() => Array(6).fill(''))
  const otp = codes.join('')
  const codeRefs = useRef<Array<HTMLInputElement | null>>([])
  const autoSent = useRef(false)
  const [codeError,       setCodeError]       = useState('')
  const [resending,       setResending]       = useState(false)
  const [resendNote,      setResendNote]      = useState('')
  const setCodes = useCallback((next: string[]) => { autoSent.current = false; setCodeError(''); setCodesRaw(next) }, [])
  const focusBox = (i: number) => setTimeout(() => codeRefs.current[i]?.focus(), 0)
  type ChannelStatus = 'sent' | 'cooldown' | 'failed'
  const [channels,        setChannels]        = useState<{ phone: ChannelStatus; email: ChannelStatus } | null>(null)
  const [resendCooldown,  setResendCooldown]  = useState(0)
  const phoneLive = channels?.phone === 'sent' || channels?.phone === 'cooldown'
  const emailLive = channels?.email === 'sent' || channels?.email === 'cooldown'

  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [emailTaken, setEmailTaken] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const setFieldError = (k: string, msg: string) => setFieldErrors((m) => ({ ...m, [k]: msg }))
  const clearFieldError = (k: string) => setFieldErrors((m) => { const n = { ...m }; delete n[k]; return n })

  useEffect(() => {
    if (resendCooldown <= 0) return
    const t = setTimeout(() => setResendCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [resendCooldown])

  async function requestCodes(onError: (m: string) => void = setError): Promise<boolean> {
    let res: Response
    try {
      res = await fetch(`${API_URL}/api/v1/auth/customer/request-signup-codes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), email: email.trim() }),
      })
    } catch {
      onError(NETWORK_ERROR)
      return false
    }
    const data = await res.json().catch(() => null) as ({
      phone?: { status: ChannelStatus }; email?: { status: ChannelStatus }
    } & ApiErrorBody) | null
    if (!res.ok || !data?.phone || !data.email) {
      onError(customerErrorMessage(res.ok ? 500 : res.status, data, 'We couldn’t send your code. Please check your details and try again.'))
      return false
    }
    setChannels({ phone: data.phone.status, email: data.email.status })
    setResendCooldown(30)
    return true
  }

  // One rule per field, shared by blur, live re-check and submit.
  const rules: Record<string, (v: string) => string> = {
    name:     (v) => v.trim().length < 2 ? 'Please enter your full name' : '',
    email:    (v) => /\S+@\S+\.\S+/.test(v.trim()) ? '' : 'Please enter a valid email',
    phone:    (v) => isPkMobile(normalisePhone(v)) ? '' : 'Use a Pakistani mobile like 0300 1234567',
    password: (v) => v.length < 8 ? 'At least 8 characters'
      : (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) ? 'Use a letter and a number as well' : '',
    confirm:  (v) => v !== password ? "Passwords don't match" : '',
  }
  const values: Record<string, string> = { name, email, phone, password, confirm }
  const check = (k: string, v: string, pw = password) => {
    const msg = k === 'confirm' ? (!v ? 'Repeat your password' : v !== pw ? "Passwords don't match" : '') : rules[k]!(v)
    if (msg) setFieldError(k, msg); else clearFieldError(k)
    return msg
  }
  // Once a field shows an error, re-check it as the customer types so it clears
  // the moment it is valid.
  const live = (k: string, v: string) => { if (fieldErrors[k]) check(k, v) }
  const formatPhoneOnBlur = () => {
    const n = normalisePhone(phone)
    if (isPkMobile(n)) setPhone(`0${n.slice(2, 5)} ${n.slice(5)}`)
  }

  async function handleStep1(e: React.FormEvent) {
    e.preventDefault()
    setEmailTaken(false)
    setError('')
    // Every field, in screen order; all inline errors at once, focus on the first.
    const order = ['name', 'email', 'phone', 'password', 'confirm']
    const bad = order.filter((k) => check(k, values[k]!))
    if (bad.length) { document.getElementById(`${idPrefix}-${bad[0]}`)?.focus(); return }
    setLoading(true)
    const sent = await requestCodes()
    setLoading(false)
    if (sent) setStep('otp')
  }

  async function handleStep2(e?: React.FormEvent) {
    e?.preventDefault()
    setError('')
    setResendNote('')
    if (otp.length < 6) { setCodeError('Enter the 6-digit code'); focusBox(Math.max(0, codes.findIndex((c) => !c))); return }
    setLoading(true)
    let res: Response
    try {
      res = await fetch(`${API_URL}/api/v1/auth/customer/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:    name.trim(),
          email:   email.trim(),
          password,
          phone:   phone.trim(),
          code:    otp.trim(),
          ...(referralCode() && { referralCode: referralCode() }),
        }),
      })
    } catch {
      setError(NETWORK_ERROR)
      setLoading(false)
      return
    }
    try {
      const data = await res.json().catch(() => null) as ({ token?: string; customer?: { id: string } } & ApiErrorBody) | null
      if (!res.ok) {
        if (res.status === 409 || data?.error?.code === 'EMAIL_TAKEN') {
          setEmailTaken(true)
          setError('An account with this email already exists.')
          setStep('details')
        } else if (data?.error?.code?.includes('OTP') || data?.error?.code?.endsWith('CODE_REQUIRED')) {
          setCodeError(customerErrorMessage(res.status, data, 'Invalid or expired code'))
          autoSent.current = false
          setCodesRaw(Array(6).fill(''))
          focusBox(0)
        } else {
          setError(customerErrorMessage(res.status, data, 'We couldn’t create your account. Please try again.'))
        }
        return
      }
      // A 200 without a session is the API's answer for an email that may
      // already have an account (it won't say which, so nobody can probe
      // for addresses). Point the customer at sign-in instead of crashing.
      if (!data?.token || !data.customer?.id) {
        setEmailTaken(true)
        setError('If this email already has a servd account, sign in to it instead.')
        setStep('details')
        return
      }
      setAuth(data.token, data.customer.id)
      // Honour ?next=/?return= (checkout / order tracker) — same-origin only.
      // Sign-in is never refused. If the account is blocked (and the CEO's
      // appeals switch is on) show the notice first, with a way to carry on.
      const blocks = await fetchBlocks(data.token)
      if (blocks.length > 0) { setBlocked(blocks); return }
      proceed()
    } finally {
      setLoading(false)
    }
  }

  // ── Glass styling shared with the field helpers ──
  const inp = (extra = '') =>
    `servd-field w-full rounded-xl px-4 py-3.5 text-base sm:text-sm font-semibold text-[color:var(--servd-ink)] placeholder:text-[color:var(--servd-mute)]/70 focus:outline-none transition-all ${extra}`
  const inpStyle: React.CSSProperties = { background: '#fff', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' }
  const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-purple)'
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(106,13,173,0.15)'
  }
  const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = 'var(--servd-line)'
    e.currentTarget.style.boxShadow   = 'none'
  }
  const primaryBtnStyle = (busy: boolean): React.CSSProperties => ({
    background: busy ? 'var(--servd-surface)' : 'var(--servd-purple)',
    color: busy ? 'var(--servd-mute)' : 'var(--servd-on-purple)',
    boxShadow: busy ? 'none' : '0 4px 14px rgba(106,13,173,0.18)',
  })

  // Fill in the 6th digit and it goes — once per attempt.
  useEffect(() => {
    if (step !== 'otp') return
    if (codes.some((c) => !c)) { autoSent.current = false; return }
    if (autoSent.current || loading) return
    autoSent.current = true
    void handleStep2()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codes, step])

  async function resend() {
    setResending(true); setResendNote(''); setCodeError('')
    const ok = await requestCodes(setCodeError)
    setResending(false)
    if (ok) {
      setCodes(Array(6).fill(''))
      setResendNote('New code sent to WhatsApp and email')
      focusBox(0)
    }
  }

  if (blocked) {
    return (
      <div className="rounded-2xl p-1">
        <BlockedNotice blocks={blocked} onContinue={proceed} />
      </div>
    )
  }

  return (
    <>
      {step === 'details' ? (
        <>
          <H className="font-black tracking-tight text-[color:var(--servd-ink)] mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>{title}</H>
          <p className="text-sm mb-6 text-[color:var(--servd-mute)]">{subtitle}</p>

          {error && <ErrorToast message={error} onDismiss={() => setError('')} />}
          {emailTaken && (
            <div className="mb-4 rounded-2xl px-4 py-3" style={{ background: 'var(--servd-surface)', border: '1px solid var(--servd-line)' }}>
              <Link href={loginHref} className="text-sm font-black text-[color:var(--servd-ink)]">→ Sign in to your existing account</Link>
            </div>
          )}

          <form onSubmit={e => { void handleStep1(e) }} className="space-y-3" noValidate>
            <Field id={`${idPrefix}-name`} label="Full name" type="text" autoComplete="name"
              value={name} onChange={(v) => { setName(v); live('name', v) }}
              onValidate={() => { check('name', name) }}
              placeholder="Your name" autoFocus={autoFocus} error={fieldErrors['name']}
              inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

            <Field id={`${idPrefix}-email`} label="Email" type="email" autoComplete="email"
              value={email} onChange={(v) => { setEmail(v); live('email', v) }}
              onValidate={() => { check('email', email) }}
              placeholder="you@example.com" error={fieldErrors['email']}
              inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

            <Field id={`${idPrefix}-phone`} label="Mobile (WhatsApp)" type="tel" autoComplete="tel"
              inputMode="tel"
              value={phone} onChange={(v) => { setPhone(v); live('phone', v) }}
              onValidate={() => { if (!check('phone', phone)) formatPhoneOnBlur() }}
              placeholder="0300 1234567" error={fieldErrors['phone']}
              inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

            <PasswordField id={`${idPrefix}-password`} label="Password" autoComplete="new-password"
              value={password} onChange={(v) => { setPassword(v); live('password', v); if (confirm) check('confirm', confirm, v) }}
              onValidate={() => { check('password', password) }}
              hint={<PasswordHint value={password} />}
              placeholder="8+ characters" error={fieldErrors['password']}
              show={showPassword} onToggle={() => setShowPassword(v => !v)}
              inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

            <PasswordField id={`${idPrefix}-confirm`} label="Confirm password" autoComplete="new-password"
              value={confirm} onChange={(v) => { setConfirm(v); live('confirm', v) }}
              onValidate={() => { check('confirm', confirm) }}
              placeholder="Repeat password" error={fieldErrors['confirm']}
              show={showPassword} onToggle={() => setShowPassword(v => !v)}
              inp={inp} inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />

            <p className="text-[11px] leading-snug pt-1 text-[color:var(--servd-mute)]">
              We&rsquo;ll send a 6-digit code to your WhatsApp and your email.
            </p>
            <MagneticButton type="submit" disabled={loading}
              className="w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
              style={primaryBtnStyle(loading)}>
              {loading ? 'Sending code…' : 'Continue →'}
            </MagneticButton>
          </form>
        </>
      ) : (
        <>
          <H className="font-black tracking-tight text-[color:var(--servd-ink)] mb-1" style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(1.9rem, 6vw, 2.3rem)', letterSpacing: '-0.03em' }}>Verify it&rsquo;s you</H>
          <p className="text-sm mb-6 text-[color:var(--servd-mute)]">
            {phoneLive && emailLive
              ? 'We sent one code to your WhatsApp and your email. Enter it below.'
              : 'Enter the code we sent you.'}
          </p>

          {error && <ErrorToast message={error} onDismiss={() => setError('')} />}

          <form onSubmit={e => { void handleStep2(e) }} className="space-y-4">
            <CodeBoxes
              label="Your code"
              sublabel={[phoneLive && 'WhatsApp', emailLive && 'email'].filter(Boolean).join(' and ') + ' — same code, use whichever arrives first'}
              value={codes} onChange={setCodes} refs={codeRefs}
              error={codeError} note={resendNote}
              autoFocus inpStyle={inpStyle} onFocus={onFocus} onBlur={onBlur} />
            {channels?.phone === 'failed' && (
              <p className="text-[11px] leading-snug text-[color:var(--servd-mute)] rounded-2xl px-3 py-2" style={{ background: 'var(--servd-surface)' }}>
                WhatsApp isn&rsquo;t reachable right now, so the code went to your email only. You can verify your number later from your account.
              </p>
            )}
            {channels?.email === 'failed' && (
              <p className="text-[11px] leading-snug text-[color:var(--servd-mute)] rounded-2xl px-3 py-2" style={{ background: 'var(--servd-surface)' }}>
                The code only reached your WhatsApp just now. You can verify your email later from your account.
              </p>
            )}

            <MagneticButton type="submit" disabled={loading || otp.length < 6}
              className="w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-all disabled:opacity-40 active:scale-[0.98] mt-1"
              style={primaryBtnStyle(loading)}>
              {loading ? 'Verifying…' : 'Verify & create account'}
            </MagneticButton>

            <div className="flex items-center justify-between text-xs -mx-2">
              <button type="button" onClick={() => { setStep('details'); setCodes(Array(6).fill('')); setError(''); setResendNote('') }}
                className="inline-flex items-center min-h-[44px] px-2 font-bold text-[color:var(--servd-mute)] hover:text-[color:var(--servd-ink)] transition-colors">
                ← Change details
              </button>
              <button type="button" disabled={resendCooldown > 0 || loading || resending}
                onClick={() => { void resend() }}
                className="inline-flex items-center min-h-[44px] px-2 font-bold text-[color:var(--servd-ink)] hover:text-[color:var(--servd-ink)] disabled:opacity-40 transition-colors">
                {resending ? 'Sending…' : resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend code'}
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
                <span style={{ color: 'var(--servd-purple)', display: 'inline-flex' }}>{b.icon}</span>
                <span className="text-[10px] font-bold text-[color:var(--servd-mute)]">{b.label}</span>
              </div>
            ))}
          </div>

          <p className="text-center text-sm mt-5 mb-3 text-[color:var(--servd-mute)]">Already have an account?</p>
          <Link href={loginHref}
            className="flex items-center justify-center w-full rounded-xl py-3.5 font-black text-[0.95rem] transition-colors"
            style={{ background: 'var(--servd-green-soft)', color: 'var(--servd-purple)', border: '1.5px solid var(--servd-purple)', textDecoration: 'none' }}>
            Sign in
          </Link>
        </>
      )}
    </>
  )
}

// ─── Six-box code input ────────────────────────────────────────────────────
// A fixed 6-slot array: clearing a slot leaves a gap, nothing shifts. Focus
// selects the digit so typing replaces it; a multi-digit value (one-time-code
// autofill, paste) fills forward from the box it landed in.
function CodeBoxes(p: {
  label: string
  sublabel: string
  value: string[]
  onChange: (v: string[]) => void
  refs: React.MutableRefObject<Array<HTMLInputElement | null>>
  error?: string
  note?: string
  autoFocus?: boolean
  inpStyle: React.CSSProperties
  onFocus: (e: React.FocusEvent<HTMLInputElement>) => void
  onBlur: (e: React.FocusEvent<HTMLInputElement>) => void
}) {
  const go = (i: number) => p.refs.current[Math.max(0, Math.min(5, i))]?.focus()
  const fill = (from: number, digits: string) => {
    const next = [...p.value]
    let k = 0
    for (; k < digits.length && from + k < 6; k++) next[from + k] = digits[k]!
    p.onChange(next)
    go(from + k)
  }
  const clear = (i: number) => { const next = [...p.value]; next[i] = ''; p.onChange(next) }
  return (
    <div>
      <label id="signup-code-label" className="block text-xs font-bold mb-0.5 text-[color:var(--servd-ink)]">{p.label}</label>
      <p className="text-[11px] mb-1.5 text-[color:var(--servd-mute)] truncate">{p.sublabel}</p>
      <div className="flex gap-1.5 sm:gap-2" role="group" aria-labelledby="signup-code-label">
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={(el) => { p.refs.current[i] = el }}
            type="text" inputMode="numeric" pattern="[0-9]*"
            autoComplete={i === 0 ? 'one-time-code' : 'off'}
            value={p.value[i] ?? ''}
            onChange={(e) => {
              let raw = e.target.value.replace(/\D/g, '')
              const old = p.value[i] ?? ''
              // Caret left of an existing digit: two characters, keep the new one.
              if (old && raw.length === 2) raw = raw.replace(old, '') || raw.slice(-1)
              if (!raw) { clear(i); return }
              if (raw.length === 1) {
                const next = [...p.value]; next[i] = raw; p.onChange(next); go(i + 1)
              } else fill(i, raw.slice(0, 6))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Backspace') {
                e.preventDefault()
                if (p.value[i]) clear(i)
                else if (i > 0) { const next = [...p.value]; next[i - 1] = ''; p.onChange(next); go(i - 1) }
              } else if (e.key === 'Delete') { e.preventDefault(); clear(i) }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1) }
              else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1) }
            }}
            onPaste={(e) => {
              e.preventDefault()
              const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
              if (pasted) fill(i, pasted)
            }}
            autoFocus={p.autoFocus && i === 0}
            aria-label={`${p.label}, digit ${i + 1} of 6`}
            aria-invalid={!!p.error}
            className="servd-field flex-1 min-w-0 max-w-[2.75rem] h-14 text-center text-xl font-black rounded-xl focus:outline-none transition-all text-[color:var(--servd-ink)]"
            style={p.error ? { ...p.inpStyle, border: '1px solid var(--servd-danger)' } : p.inpStyle}
            onFocus={(e) => { e.currentTarget.select(); p.onFocus(e) }}
            onBlur={p.onBlur}
          />
        ))}
      </div>
      {p.error && <p role="alert" className="mt-1.5 text-[11px] font-semibold" style={{ color: 'var(--servd-danger)' }}>{p.error}</p>}
      <p aria-live="polite" className="mt-1.5 text-[11px] font-semibold text-[color:var(--servd-mute)] empty:hidden">{p.note}</p>
    </div>
  )
}

/** Password rules, each turning green as it is met. */
function PasswordHint({ value }: { value: string }) {
  const part = (ok: boolean, text: string) => (
    <span style={{ color: ok ? 'var(--servd-green-dark)' : undefined }} className={ok ? 'font-bold' : ''}>{text}</span>
  )
  return (
    <p className="mt-1 text-[11px] text-[color:var(--servd-mute)]">
      {part(value.length >= 8, '8+ characters')} with {part(/[a-zA-Z]/.test(value), 'a letter')} and {part(/[0-9]/.test(value), 'a number')}
    </p>
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
      <label htmlFor={p.id} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">{p.label}</label>
      <input id={p.id} type={p.type} autoComplete={p.autoComplete}
        inputMode={p.inputMode}
        value={p.value} onChange={(e) => p.onChange(e.target.value)}
        placeholder={p.placeholder} autoFocus={p.autoFocus} required
        aria-invalid={!!p.error} aria-describedby={p.error ? `${p.id}-err` : undefined}
        className={p.inp()} style={p.inpStyle}
        onFocus={p.onFocus}
        onBlur={(e) => { p.onBlur(e); p.onValidate() }} />
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--servd-danger)' }}>{p.error}</p>
      )}
    </div>
  )
}

interface PasswordFieldProps extends Omit<FieldProps, 'type' | 'inputMode'> {
  hint?: React.ReactNode
  show: boolean
  onToggle: () => void
}
function PasswordField(p: PasswordFieldProps) {
  return (
    <div>
      <label htmlFor={p.id} className="block text-xs font-bold mb-1.5 text-[color:var(--servd-ink)]">{p.label}</label>
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
          className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center min-h-[44px] min-w-[44px] rounded-lg text-[color:var(--servd-mute)] hover:text-[color:var(--servd-ink)] transition-colors">
          {p.show ? <EyeOff size={18} /> : <Eye size={18} />}
        </button>
      </div>
      {p.hint}
      {p.error && (
        <p id={`${p.id}-err`} role="alert" className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--servd-danger)' }}>{p.error}</p>
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
