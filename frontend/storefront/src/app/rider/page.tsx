'use client'
// servd.pk/rider — sign in (docs/rider-app.md): phone number → a 6-digit code
// on WhatsApp → signed in. A manager must first add the rider in admin →
// Riders; the API answers an unknown number exactly as it answers a known one,
// so this screen does too ("if this number is registered…").

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

export default function RiderSignInPage() {
  const router = useRouter()
  const [step, setStep] = useState<'phone' | 'code'>('phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
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

  async function sendCode(e?: FormEvent) {
    e?.preventDefault()
    if (busy) return
    setError(null)
    if (!isPkMobile(normalised)) {
      setError('Use a Pakistani mobile like 0300 1234567')
      return
    }
    setBusy(true)
    try {
      await riderApi.requestCode(normalised)
      setStep('code')
      setCode('')
      setResendIn(RESEND_AFTER_S)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  async function verify(value: string) {
    if (submitting.current) return
    setError(null)
    if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(value)) {
      setError(`Enter the ${CODE_LENGTH}-digit code from WhatsApp.`)
      return
    }
    submitting.current = true
    setBusy(true)
    try {
      const session = await riderApi.verifyCode(normalised, value)
      useRiderSession.getState().setSession(session)
      router.replace('/rider/jobs')
    } catch (err) {
      setCode('')
      codeRef.current?.focus()
      if (err instanceof RiderApiError && err.code === 'INVALID_CODE') {
        setError('That code is not right, or it has expired. Check WhatsApp, or send a new code.')
      } else {
        setError(friendlyError(err))
      }
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  function onCodeChange(v: string) {
    const digits = v.replace(/\D/g, '').slice(0, CODE_LENGTH)
    setCode(digits)
    if (error) setError(null)
    // Pasted or auto-filled the whole code: sign in straight away.
    if (digits.length === CODE_LENGTH) void verify(digits)
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 pb-10 pt-8">
      <div>
        <h1 className="text-[32px] font-extrabold leading-[1.05] tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
          {step === 'phone' ? 'Sign in to ride' : 'Enter your code'}
        </h1>
        <p className="mt-2 text-[16px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
          {step === 'phone'
            ? 'Use the mobile number your manager added for you. We send a code on WhatsApp.'
            : <>If <strong style={{ color: 'var(--servd-ink)' }}>{formatPhone(normalised)}</strong> is registered as a servd rider, a {CODE_LENGTH}-digit code is on its way on WhatsApp.{' '}
              <button type="button" className="font-bold underline min-h-[44px]" style={{ color: 'var(--servd-purple)' }}
                onClick={() => { setStep('phone'); setCode(''); setError(null) }}>
                Wrong number? Change
              </button></>}
        </p>
      </div>

      {step === 'phone' ? (
        <form onSubmit={(e) => void sendCode(e)} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className="text-[14px] font-black uppercase tracking-[0.12em]" style={{ color: 'var(--servd-mute)' }}>
              Mobile number
            </span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="0300 1234567"
              value={phone}
              onChange={(e) => { setPhone(e.target.value); if (error) setError(null) }}
              className="w-full rounded-2xl px-4 text-[22px] font-bold outline-none focus:ring-4"
              style={{ ...inputStyle, minHeight: 64 }}
              aria-invalid={!!error}
            />
          </label>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button type="submit" size="xl" busy={busy} disabled={!phone.trim()}>
            Send code on WhatsApp
          </Button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void verify(code) }} className="flex flex-col gap-4" noValidate>
          <label className="flex flex-col gap-2">
            <span className="text-[14px] font-black uppercase tracking-[0.12em]" style={{ color: 'var(--servd-mute)' }}>
              {CODE_LENGTH}-digit code
            </span>
            <input
              ref={codeRef}
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              placeholder={'0'.repeat(CODE_LENGTH)}
              value={code}
              onChange={(e) => onCodeChange(e.target.value)}
              className="w-full rounded-2xl px-4 text-center text-[34px] font-black tracking-[0.4em] outline-none focus:ring-4"
              style={{ ...inputStyle, minHeight: 72 }}
              aria-invalid={!!error}
            />
          </label>
          {error ? <Banner tone="danger" title={error} /> : null}
          <Button type="submit" size="xl" busy={busy} disabled={code.length !== CODE_LENGTH}>
            Sign in
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <Button intent="ghost" size="md" disabled={busy || resendIn > 0} onClick={() => void sendCode()}>
              {resendIn > 0 ? `New code in ${resendIn}s` : 'Send a new code'}
            </Button>
            <Button
              intent="ghost"
              size="md"
              disabled={busy}
              onClick={() => { setStep('phone'); setCode(''); setError(null) }}
            >
              Change number
            </Button>
          </div>
        </form>
      )}

      <p className="mt-auto text-[14px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
        New rider? Your manager adds you in servd first. Then sign in here with the number they used.
      </p>
    </div>
  )
}
