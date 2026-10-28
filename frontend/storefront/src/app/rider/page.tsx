'use client'
// servd.pk/rider — sign in (docs/rider-app.md). Riders have full accounts (owner, 2026-10-28): mobile number +
// password. The WhatsApp code is only for the FIRST sign-in and a forgotten password — it comes with a new password
// and sets it. A manager must first add the rider in admin → Riders; the API answers an unknown number exactly as
// it answers a known one, so this screen does too ("if this number is registered…").

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { RiderApiError, friendlyError, riderApi } from '../../lib/riderApi'
import { useRiderSession } from '../../lib/riderSession'
import { formatPhone, isPkMobile, normalisePhone } from './_lib/format'
import { Banner, Button } from './_components/ui'

const CODE_LENGTH = 6
const RESEND_AFTER_S = 30

// The focus ring is Tailwind's ring-4 in servd green (its default is blue).
const inputStyle = {
  background: 'var(--servd-bg)',
  color: 'var(--servd-ink)',
  border: '2px solid var(--servd-purple)',
  '--tw-ring-color': 'color-mix(in srgb, var(--servd-green) 60%, transparent)',
} as CSSProperties

const labelCls = 'text-[14px] font-black uppercase tracking-[0.12em]'
const fieldCls = 'w-full rounded-2xl px-4 text-[20px] font-bold outline-none focus:ring-4'

/** The API's own rule (riderAuth/routes.ts newPasswordSchema). */
function passwordProblem(pw: string): string | null {
  if (pw.length < 8) return 'Use at least 8 characters.'
  if (!/[a-zA-Z]/.test(pw)) return 'Add at least one letter.'
  if (!/[0-9]/.test(pw)) return 'Add at least one number.'
  return null
}

export default function RiderSignInPage() {
  const router = useRouter()
  const [step, setStep] = useState<'signin' | 'code'>('signin')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendIn, setResendIn] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)
  const submitting = useRef(false)

  // Resend countdown.
  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  // A hung request must never lock the screen: after 15s let the rider retry.
  useEffect(() => {
    if (!busy) return
    const t = setTimeout(() => {
      submitting.current = false
      setBusy(false)
      setError('Taking too long. Try again.')
    }, 15000)
    return () => clearTimeout(t)
  }, [busy])

  useEffect(() => {
    if (step === 'code') codeRef.current?.focus()
  }, [step])

  const normalised = normalisePhone(phone)

  function phoneOk(): boolean {
    if (isPkMobile(normalised)) return true
    setError('Use a Pakistani mobile like 0300 1234567')
    return false
  }

  async function run(work: () => Promise<void>) {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    try { await work() } finally { submitting.current = false; setBusy(false) }
  }

  function signIn(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!phoneOk()) return
    if (!password) { setError('Enter your password.'); return }
    void run(async () => {
      try {
        const session = await riderApi.signIn(normalised, password)
        useRiderSession.getState().setSession(session)
        router.replace('/rider/jobs')
      } catch (err) {
        setPassword('')
        setError(err instanceof RiderApiError && err.code === 'INVALID_CREDENTIALS'
          ? 'Wrong number or password. First time here, or forgot it? Get a code below to set your password.'
          : friendlyError(err))
      }
    })
  }

  function sendCode() {
    setError(null)
    if (!phoneOk()) return
    void run(async () => {
      try {
        await riderApi.requestCode(normalised)
        setStep('code')
        setCode('')
        setNewPassword('')
        setConfirm('')
        setResendIn(RESEND_AFTER_S)
      } catch (err) {
        setError(friendlyError(err))
      }
    })
  }

  function setAndSignIn(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) { setError(`Enter the ${CODE_LENGTH}-digit code from WhatsApp.`); return }
    const problem = passwordProblem(newPassword)
    if (problem) { setError(problem); return }
    if (newPassword !== confirm) { setError('The two passwords do not match.'); return }
    void run(async () => {
      try {
        const session = await riderApi.setPassword(normalised, code, newPassword)
        useRiderSession.getState().setSession(session)
        router.replace('/rider/jobs')
      } catch (err) {
        if (err instanceof RiderApiError && err.code === 'INVALID_CODE') {
          setCode('')
          codeRef.current?.focus()
          setError('That code is not right, or it has expired. Check WhatsApp, or send a new code.')
        } else {
          setError(friendlyError(err))
        }
      }
    })
  }

  const backToSignIn = () => { setStep('signin'); setCode(''); setError(null) }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 pb-10 pt-8">
      <div>
        <h1 className="text-[32px] font-extrabold leading-[1.05] tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
          {step === 'signin' ? 'Sign in to ride' : 'Set your password'}
        </h1>
        <p className="mt-2 text-[16px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
          {step === 'signin'
            ? 'Your mobile number and your password.'
            : <>If <strong style={{ color: 'var(--servd-ink)' }}>{formatPhone(normalised)}</strong> is registered as a servd rider, a {CODE_LENGTH}-digit code is on its way on WhatsApp. Enter it and choose your password.{' '}
              <button type="button" className="font-bold underline min-h-[44px]" style={{ color: 'var(--servd-purple)' }} onClick={backToSignIn}>
                Wrong number? Change
              </button></>}
        </p>
      </div>

      {step === 'signin' ? (
        <form onSubmit={signIn} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>Mobile number</span>
            <input
              type="tel" inputMode="tel" autoComplete="username" placeholder="0300 1234567"
              value={phone} onChange={(e) => { setPhone(e.target.value); if (error) setError(null) }}
              className={fieldCls} style={{ ...inputStyle, minHeight: 64 }} aria-invalid={!!error}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>Password</span>
            <div className="relative">
              <input
                type={showPw ? 'text' : 'password'} autoComplete="current-password"
                value={password} onChange={(e) => { setPassword(e.target.value); if (error) setError(null) }}
                className={`${fieldCls} pr-20`} style={{ ...inputStyle, minHeight: 64 }} aria-invalid={!!error}
              />
              <button type="button" onClick={() => setShowPw((v) => !v)} aria-pressed={showPw}
                className="absolute right-2 top-1/2 -translate-y-1/2 min-h-[44px] px-3 text-[14px] font-bold" style={{ color: 'var(--servd-purple)' }}>
                {showPw ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button type="submit" size="xl" busy={busy} disabled={!phone.trim() || !password}>
            Sign in
          </Button>
          <Button intent="ghost" size="md" disabled={busy || !phone.trim()} onClick={sendCode}>
            First time, or forgot your password? Get a code on WhatsApp
          </Button>
        </form>
      ) : (
        <form onSubmit={setAndSignIn} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>{CODE_LENGTH}-digit code</span>
            <input
              ref={codeRef} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code"
              maxLength={CODE_LENGTH} placeholder={'0'.repeat(CODE_LENGTH)}
              value={code} onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH)); if (error) setError(null) }}
              className="w-full rounded-2xl px-4 text-center text-[34px] font-black tracking-[0.4em] outline-none focus:ring-4"
              style={{ ...inputStyle, minHeight: 72 }} aria-invalid={!!error}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>New password</span>
            <input
              type={showPw ? 'text' : 'password'} autoComplete="new-password"
              value={newPassword} onChange={(e) => { setNewPassword(e.target.value); if (error) setError(null) }}
              className={fieldCls} style={{ ...inputStyle, minHeight: 60 }}
            />
            <span className="text-[14px]" style={{ color: 'var(--servd-mute)' }}>At least 8 characters, with a letter and a number.</span>
          </label>
          <label className="flex flex-col gap-2">
            <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>Type it again</span>
            <input
              type={showPw ? 'text' : 'password'} autoComplete="new-password"
              value={confirm} onChange={(e) => { setConfirm(e.target.value); if (error) setError(null) }}
              className={fieldCls} style={{ ...inputStyle, minHeight: 60 }}
            />
          </label>
          <label className="flex items-center gap-2 text-[15px] min-h-[44px]" style={{ color: 'var(--servd-mute)' }}>
            <input type="checkbox" checked={showPw} onChange={(e) => setShowPw(e.target.checked)} style={{ accentColor: 'var(--servd-green)' }} />
            Show passwords
          </label>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button type="submit" size="xl" busy={busy} disabled={code.length !== CODE_LENGTH || !newPassword || !confirm}>
            Set password and sign in
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <Button intent="ghost" size="md" disabled={busy || resendIn > 0} onClick={sendCode}>
              {resendIn > 0 ? `New code in ${resendIn}s` : 'Send a new code'}
            </Button>
            <Button intent="ghost" size="md" disabled={busy} onClick={backToSignIn}>
              Back to sign in
            </Button>
          </div>
        </form>
      )}

      <p className="mt-auto text-[14px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
        New rider? Your manager adds you in servd first. Then get a code here with the number they used and choose your password.
      </p>
    </div>
  )
}
