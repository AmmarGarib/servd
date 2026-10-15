'use client'
import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { MANUAL_CONVERT_ATTR, useConversion } from '../blocks/conversion'
import { track } from '../../lib/analytics'

// The servd new-brand waitlist form: details + consent → WhatsApp code →
// "You're on the list." Used by /waitlist and the `waitlist_form` block (pages
// and pop-ups). No session is created; the API files the person into the
// customer master data. Inside a content page / pop-up it fires the
// conversion beacon on the verified join, not on "Send code".

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

/** Canonical consent wording — the API validates the copy we send against its own. */
export const WAITLIST_CONSENT_TEXT =
  'Message me on WhatsApp or email when servd opens a new brand. I can opt out any time.'

const RESEND_SECONDS = 60

/** ?src= on the current URL, sanitised to [a-z0-9_-]{1,40}; undefined when absent. */
export function waitlistSource(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const raw = new URLSearchParams(window.location.search).get('src') ?? ''
  const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40)
  return clean || undefined
}

async function postJson(path: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${API_URL}/api/v1/waitlist/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: Record<string, unknown> = {}
  try { data = (await res.json()) as Record<string, unknown> } catch { /* empty body */ }
  return { ok: res.ok, status: res.status, data }
}

/** A friendly message for a failed call. `codeStep` = the join (code check). */
function friendlyError(status: number, data: Record<string, unknown>, codeStep: boolean): string {
  if (status === 429) return 'Too many tries for now. Please wait a few minutes and try again.'
  const err = (data['error'] && typeof data['error'] === 'object' ? data['error'] : {}) as { code?: unknown; message?: unknown }
  const code = typeof err.code === 'string' ? err.code : ''
  const message = typeof err.message === 'string' ? err.message : ''
  if (codeStep && /CODE|OTP/i.test(code)) return "That code didn't match or has expired. Check WhatsApp and try again."
  if (code === 'VALIDATION_ERROR') return codeStep ? 'Enter the 6-digit code from WhatsApp.' : 'Please check your details and try again.'
  if (status >= 500 || !message) return 'Something went wrong on our side. Please try again.'
  return message
}

type Step = 'details' | 'code' | 'done'

export function WaitlistForm({
  title = 'Be first in line.',
  subtitle = 'Tell us where to reach you and we will message you the day servd opens a new brand.',
  buttonText = 'Send code',
  headingAs: H = 'h2',
}: {
  title?: string
  subtitle?: string
  buttonText?: string
  headingAs?: 'h1' | 'h2'
}) {
  const id = useId()
  const fid = (k: string) => `${id}-${k}`
  const convert = useConversion()

  const [step, setStep] = useState<Step>('details')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [area, setArea] = useState('')
  const [interest, setInterest] = useState('')
  const [consent, setConsent] = useState(false)
  const [code, setCode] = useState('')
  const [phoneHint, setPhoneHint] = useState('')
  const [alreadyOnList, setAlreadyOnList] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const codeRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
    if (step === 'done') doneRef.current?.focus()
  }, [step])

  const details = () => {
    const source = waitlistSource()
    return {
      name: name.trim(),
      phone: phone.trim(),
      ...(email.trim() && { email: email.trim() }),
      ...(area.trim() && { area: area.trim() }),
      ...(interest.trim() && { interest: interest.trim() }),
      ...(source && { source }),
      consent: true,
    }
  }

  async function requestCode(): Promise<boolean> {
    setBusy(true)
    setError('')
    try {
      const r = await postJson('request-code', details())
      if (!r.ok) { setError(friendlyError(r.status, r.data, false)); return false }
      setPhoneHint(typeof r.data['phoneHint'] === 'string' ? r.data['phoneHint'] : '')
      setCooldown(RESEND_SECONDS)
      return true
    } catch {
      setError('Could not reach servd. Check your connection and try again.')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function onDetails(e: FormEvent) {
    e.preventDefault()
    if (name.trim().length < 2) return setError('Please enter your name.')
    if (phone.replace(/\D/g, '').length < 10) return setError('Enter your WhatsApp number, e.g. 0300 1234567.')
    if (email.trim() && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError('That email does not look right. Leave it blank if you prefer.')
    if (!consent) return setError('Please tick the box so we are allowed to message you.')
    if (await requestCode()) { setCode(''); setStep('code') }
  }

  async function onCode(e: FormEvent) {
    e.preventDefault()
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit code from WhatsApp.')
    setBusy(true)
    setError('')
    try {
      const r = await postJson('join', { ...details(), code, consentText: WAITLIST_CONSENT_TEXT })
      if (!r.ok) { setError(friendlyError(r.status, r.data, true)); return }
      setAlreadyOnList(r.data['alreadyOnList'] === true)
      setStep('done')
      convert()
      track('waitlist_join', { method: 'whatsapp' }) // GA4: no phone, no name
    } catch {
      setError('Could not reach servd. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const errorBox = error ? (
    <p role="alert" style={errorStyle}>{error}</p>
  ) : null

  return (
    <div {...{ [MANUAL_CONVERT_ATTR]: '' }} style={cardStyle}>
      {step === 'done' ? (
        <div ref={doneRef} tabIndex={-1} aria-live="polite" style={{ outline: 'none' }}>
          <H style={headingStyle}>You&rsquo;re on the list.</H>
          <p style={leadStyle}>
            {alreadyOnList
              ? 'You were already on it, so nothing changes. We will message you when the next brand opens.'
              : 'We will message you on WhatsApp when servd opens its next brand. Nothing else, and you can opt out any time.'}
          </p>
        </div>
      ) : step === 'code' ? (
        <form onSubmit={(e) => { void onCode(e) }} noValidate>
          <H style={headingStyle}>Check WhatsApp.</H>
          <p style={leadStyle}>
            We sent a 6-digit code to {phoneHint ? <strong>{phoneHint}</strong> : 'your WhatsApp'}.
          </p>
          <Label htmlFor={fid('code')}>Code</Label>
          <input
            ref={codeRef} id={fid('code')} name="code" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
            aria-invalid={!!error} aria-describedby={error ? fid('err') : undefined}
            style={{ ...inputStyle, fontSize: '1.4rem', letterSpacing: '0.4em', textAlign: 'center', fontWeight: 800 }}
          />
          <div id={fid('err')}>{errorBox}</div>
          <button type="submit" disabled={busy} style={primaryButton(busy)}>
            {busy ? 'Checking…' : 'Join the list'}
          </button>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
            <button type="button" style={linkButton} onClick={() => { setError(''); setStep('details') }}>
              Change details
            </button>
            <button
              type="button" style={{ ...linkButton, opacity: cooldown > 0 || busy ? 0.55 : 1 }}
              disabled={cooldown > 0 || busy} onClick={() => { void requestCode() }}
            >
              {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={(e) => { void onDetails(e) }} noValidate>
          <H style={headingStyle}>{title}</H>
          {subtitle ? <p style={leadStyle}>{subtitle}</p> : null}

          <Field id={fid('name')} label="Your name">
            <input id={fid('name')} name="name" value={name} onChange={(e) => setName(e.target.value)}
              autoComplete="name" maxLength={120} required style={inputStyle} />
          </Field>
          <Field id={fid('phone')} label="WhatsApp number">
            <input id={fid('phone')} name="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
              inputMode="tel" autoComplete="tel" placeholder="0300 1234567" maxLength={20} required style={inputStyle} />
          </Field>
          <Field id={fid('email')} label="Email" optional>
            <input id={fid('email')} name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" maxLength={200} style={inputStyle} />
          </Field>
          <Field id={fid('area')} label="Your area" optional>
            <input id={fid('area')} name="area" value={area} onChange={(e) => setArea(e.target.value)}
              autoComplete="address-level3" placeholder="e.g. DHA, Clifton, Gulshan" maxLength={80} style={inputStyle} />
          </Field>
          <Field id={fid('interest')} label="What would you like to see next?" optional>
            <input id={fid('interest')} name="interest" value={interest} onChange={(e) => setInterest(e.target.value)}
              placeholder="A cuisine, a dish, a kind of place" maxLength={200} style={inputStyle} />
          </Field>

          <label htmlFor={fid('consent')} style={consentStyle}>
            <input id={fid('consent')} type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
              required style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0, accentColor: 'var(--servd-green)' }} />
            <span>{WAITLIST_CONSENT_TEXT}</span>
          </label>

          {errorBox}
          <button type="submit" disabled={busy} style={primaryButton(busy)}>
            {busy ? 'Sending…' : buttonText}
          </button>
          <p style={{ ...smallStyle, marginTop: '0.75rem' }}>We will send a one-time code to your WhatsApp to confirm the number.</p>
        </form>
      )}
    </div>
  )
}

function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return <label htmlFor={htmlFor} style={labelStyle}>{children}</label>
}

function Field({ id, label, optional, children }: { id: string; label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <Label htmlFor={id}>
        {label}
        {optional ? <span style={{ fontWeight: 500, opacity: 0.7 }}> (optional)</span> : null}
      </Label>
      {children}
    </div>
  )
}

// ── Styles: a purple card (bone text) with bone fields and a green action ──

const cardStyle: CSSProperties = {
  width: '100%', maxWidth: '28rem', margin: '0 auto', textAlign: 'left',
  background: 'var(--servd-purple)', color: 'var(--servd-on-purple)',
  borderRadius: '1.5rem', padding: 'clamp(1.25rem, 5vw, 2rem)',
  boxShadow: '0 20px 50px rgba(61,31,59,0.25)',
}
const headingStyle: CSSProperties = {
  fontFamily: 'var(--sv-heading-font, var(--font-display))', fontWeight: 900,
  fontSize: 'clamp(1.6rem, 6vw, 2.1rem)', letterSpacing: '-0.03em', lineHeight: 1.05,
  margin: '0 0 0.5rem', color: 'inherit',
}
const leadStyle: CSSProperties = { fontSize: '0.95rem', lineHeight: 1.5, opacity: 0.85, margin: '0 0 1.25rem' }
const smallStyle: CSSProperties = { fontSize: '0.8rem', lineHeight: 1.45, opacity: 0.7, margin: 0 }
const labelStyle: CSSProperties = { display: 'block', fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.35rem' }
const inputStyle: CSSProperties = {
  width: '100%', minHeight: 48, borderRadius: '0.9rem', padding: '0.7rem 0.9rem',
  background: 'var(--servd-bg)', color: 'var(--servd-ink)', border: '2px solid transparent',
  fontSize: '1rem', outlineColor: 'var(--servd-green)',
}
const consentStyle: CSSProperties = {
  display: 'flex', gap: '0.7rem', alignItems: 'flex-start', cursor: 'pointer',
  fontSize: '0.88rem', lineHeight: 1.45, margin: '0.4rem 0 1rem',
}
const errorStyle: CSSProperties = {
  margin: '0.75rem 0 0', padding: '0.65rem 0.85rem', borderRadius: '0.75rem',
  background: '#fff1f1', color: 'var(--servd-danger)', fontSize: '0.88rem', fontWeight: 600,
}
const primaryButton = (busy: boolean): CSSProperties => ({
  width: '100%', minHeight: 52, marginTop: '1rem', borderRadius: 999, border: 'none',
  background: 'var(--servd-green)', color: 'var(--servd-on-green)',
  fontWeight: 900, fontSize: '1rem', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.7 : 1,
})
const linkButton: CSSProperties = {
  background: 'none', border: 'none', padding: '0.5rem 0', minHeight: 44, cursor: 'pointer',
  color: 'var(--servd-on-purple)', fontWeight: 700, fontSize: '0.9rem', textDecoration: 'underline',
}
