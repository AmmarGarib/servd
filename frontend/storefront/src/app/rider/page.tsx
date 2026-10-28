'use client'
// servd.pk/rider — sign in (docs/rider-app.md). Riders sign in like staff (owner, 2026-10-28: "Riders same as
// staff — Gsfoods email + password"): an @gsfoods.pk email + the password their manager issues on admin → Riders.
// No WhatsApp code. A forgotten password is a new one from the manager.

import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { RiderApiError, friendlyError, riderApi } from '../../lib/riderApi'
import { useRiderSession } from '../../lib/riderSession'
import { Banner, Button } from './_components/ui'

// The focus ring is Tailwind's ring-4 in servd green (its default is blue).
const inputStyle = {
  background: 'var(--servd-bg)',
  color: 'var(--servd-ink)',
  border: '2px solid var(--servd-purple)',
  '--tw-ring-color': 'color-mix(in srgb, var(--servd-green) 60%, transparent)',
} as CSSProperties

const labelCls = 'text-[14px] font-black uppercase tracking-[0.12em]'
const fieldCls = 'w-full rounded-2xl px-4 text-[20px] font-bold outline-none focus:ring-4'

export default function RiderSignInPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)

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

  async function signIn(e: FormEvent) {
    e.preventDefault()
    if (submitting.current) return
    setError(null)
    const em = email.trim().toLowerCase()
    if (!/^[^\s@]+@gsfoods\.pk$/.test(em)) { setError('Use your @gsfoods.pk email.'); return }
    if (!password) { setError('Enter your password.'); return }
    submitting.current = true
    setBusy(true)
    try {
      const session = await riderApi.signIn(em, password)
      useRiderSession.getState().setSession(session)
      router.replace('/rider/jobs')
    } catch (err) {
      setPassword('')
      setError(err instanceof RiderApiError && err.code === 'INVALID_CREDENTIALS'
        ? 'Wrong email or password. Forgot it? Ask your manager for a new password.'
        : friendlyError(err))
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-6 px-4 pb-10 pt-8">
      <div>
        <h1 className="text-[32px] font-extrabold leading-[1.05] tracking-tight" style={{ fontFamily: 'var(--font-display)' }}>
          Sign in to ride
        </h1>
        <p className="mt-2 text-[16px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
          Your @gsfoods.pk email and your password.
        </p>
      </div>

      <form onSubmit={(e) => void signIn(e)} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-2">
          <span className={labelCls} style={{ color: 'var(--servd-mute)' }}>Email</span>
          <input
            type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false}
            placeholder="name@gsfoods.pk"
            value={email} onChange={(e) => { setEmail(e.target.value); if (error) setError(null) }}
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
        <Button type="submit" size="xl" busy={busy} disabled={!email.trim() || !password}>
          Sign in
        </Button>
      </form>

      <p className="mt-auto text-[14px] leading-snug" style={{ color: 'var(--servd-mute)' }}>
        New rider, or forgot your password? Your manager adds you in servd and gives you your password.
      </p>
    </div>
  )
}
