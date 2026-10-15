'use client'
// ─── Your sign-in — password and manager-override PIN ───────────────────────
//
// Where the login page sends someone whose password was generated or reissued
// by someone else (the login response carries `mustChangePassword`; ?first=1).
// A nudge, never a block: they are already signed in and can skip it.
//
//   • Password — POST /auth/password/change-authed (current + new). Every
//     OTHER session is signed out; this device gets a fresh session back, so
//     the person is not thrown out mid-task.
//   • Override PIN — POST /auth/pin/change. Managers set their FIRST PIN with
//     their password, and change it later with the current PIN, so the CEO no
//     longer chooses (and knows) everyone's PIN.
//
// Floor staff sign in with a code and have no password; the page says so.

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { PasswordInput } from '../../../components/ui/PasswordInput'

interface Account {
  id: string
  name: string
  email: string | null
  role: string
  usesCodeLogin: boolean
  mustChangePassword: boolean
  hasPin: boolean
  canHoldPin: boolean
}

interface Session {
  accessToken: string
  refreshToken: string
  user: { id: string; name: string; email: string | null; role: string; mustChangePassword: boolean }
}

const MIN_PASSWORD = 12
const inputCls = 'w-full rounded-lg border border-s-border bg-s-bg px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'
const ctaCls = 'rounded-lg px-3 py-2 text-xs font-black bg-primary text-primary-on hover:opacity-90 disabled:opacity-50'

function AccountPasswordInner() {
  const router = useRouter()
  const first = useSearchParams().get('first') === '1'
  const { data: me, isLoading } = useQuery<Account>({
    queryKey: ['auth', 'account'],
    queryFn: () => api.get<Account>('/auth/account'),
  })

  return (
    <div className="min-h-screen bg-s-bg text-s-text">
      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8 space-y-5">
        <div>
          <h1 className="text-2xl font-black">Your sign-in</h1>
          <p className="text-sm text-s-muted mt-1">{me ? `${me.name}${me.email ? ` · ${me.email}` : ''}` : ' '}</p>
        </div>

        {isLoading && <p className="text-sm text-s-muted">Loading…</p>}

        {me && first && me.mustChangePassword && (
          <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm">
            <p className="font-bold">Choose your own password</p>
            <p className="text-xs text-s-muted mt-1">
              The password you just used was issued to you by someone else, so they know it.
              Replace it now with one only you know.
            </p>
          </div>
        )}

        {me?.usesCodeLogin ? (
          <section className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-sm font-bold">You sign in with a code</p>
            <p className="text-xs text-s-muted mt-1">
              Cashiers, servers and kitchen staff have no password: each sign-in sends a code to your WhatsApp and email.
              If it does not arrive, a manager can give you one from Workforce.
            </p>
          </section>
        ) : me ? (
          <PasswordSection first={first} onDone={() => { if (first) router.replace('/w') }} />
        ) : null}

        {me?.canHoldPin && <PinSection hasPin={me.hasPin} />}

        {first && me?.mustChangePassword && (
          <button type="button" onClick={() => router.replace('/w')}
            className="text-xs text-s-muted hover:text-s-text underline">
            Not now — remind me next time I sign in
          </button>
        )}
      </div>
    </div>
  )
}

function PasswordSection({ first, onDone }: { first: boolean; onDone: () => void }) {
  const qc = useQueryClient()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const change = useMutation({
    mutationFn: () => api.post<Session>('/auth/password/change-authed', { currentPassword: current, newPassword: next }),
    onSuccess: (s) => {
      // Every other session was signed out with the old password; this one
      // was re-issued in the response.
      if (s?.user && s.accessToken) setAuth(s.user, s.accessToken, s.refreshToken)
      setCurrent(''); setNext(''); setAgain(''); setErr(null); setDone(true)
      void qc.invalidateQueries({ queryKey: ['auth', 'account'] })
    },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not change your password'),
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (next.length < MIN_PASSWORD) return setErr(`Use at least ${MIN_PASSWORD} characters.`)
    if (next !== again) return setErr('The two new passwords do not match.')
    change.mutate()
  }

  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-4">
      <p className="text-sm font-bold">Password</p>
      {done ? (
        <div className="mt-2">
          <p className="text-xs text-emerald-700 font-bold">Password changed.</p>
          <p className="text-xs text-s-muted mt-1">Every other device signed in as you has been signed out. This one stays signed in.</p>
          {first && (
            <button type="button" onClick={onDone} className={`${ctaCls} mt-3`}>Continue</button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-3 space-y-2.5">
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)}
            placeholder="Current password" autoComplete="current-password" className={inputCls} />
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)}
            placeholder="New password" autoComplete="new-password" className={inputCls} />
          <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)}
            placeholder="Repeat new password" autoComplete="new-password" className={inputCls} />
          <p className="text-[11px] text-s-muted">At least {MIN_PASSWORD} characters, and not containing your email name.</p>
          {err && <p className="text-xs font-bold text-red-700">{err}</p>}
          <button type="submit" disabled={change.isPending || !current || !next || !again} className={ctaCls}>
            {change.isPending ? 'Changing…' : 'Change password'}
          </button>
        </form>
      )}
    </section>
  )
}

function PinSection({ hasPin }: { hasPin: boolean }) {
  const qc = useQueryClient()
  const [proof, setProof] = useState('')     // current PIN, or the password for a first PIN
  const [pin, setPin] = useState('')
  const [pin2, setPin2] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => api.post<{ message: string }>('/auth/pin/change', {
      ...(hasPin ? { currentPin: proof } : { password: proof }),
      newPin: pin,
    }),
    onSuccess: (r) => {
      setProof(''); setPin(''); setPin2(''); setErr(null)
      setDone(r?.message ?? 'PIN saved.')
      void qc.invalidateQueries({ queryKey: ['auth', 'account'] })
    },
    onError: (e: unknown) => { setDone(null); setErr(e instanceof Error ? e.message : 'Could not save your PIN') },
  })

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null); setDone(null)
    if (!/^\d{4,8}$/.test(pin)) return setErr('A PIN is 4 to 8 digits.')
    if (pin !== pin2) return setErr('The two PINs do not match.')
    save.mutate()
  }

  return (
    <section className="rounded-xl border border-s-border bg-s-surface p-4">
      <p className="text-sm font-bold">Manager-override PIN</p>
      <p className="text-xs text-s-muted mt-1">
        Typed at the till to approve an over-cap discount, void, comp, refund, petty-cash top-up or staff meal.
        {hasPin ? ' Enter your current PIN to change it.' : ' You have not set one yet — confirm with your password to choose it.'}
      </p>
      <form onSubmit={submit} className="mt-3 space-y-2.5">
        {hasPin ? (
          <PasswordInput numeric value={proof} maxLength={8}
            onChange={(e) => setProof(e.target.value.replace(/\D/g, ''))}
            placeholder="Current PIN" autoComplete="off" className={inputCls} />
        ) : (
          <PasswordInput value={proof} onChange={(e) => setProof(e.target.value)}
            placeholder="Your password" autoComplete="current-password" className={inputCls} />
        )}
        <PasswordInput numeric value={pin} maxLength={8}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="New PIN (4–8 digits)" autoComplete="off" className={inputCls} />
        <PasswordInput numeric value={pin2} maxLength={8}
          onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))}
          placeholder="Repeat new PIN" autoComplete="off" className={inputCls} />
        <p className="text-[11px] text-s-muted">Not guessable: no repeated digits (1111), runs (1234) or years.</p>
        {err && <p className="text-xs font-bold text-red-700">{err}</p>}
        {done && <p className="text-xs font-bold text-emerald-700">{done}</p>}
        <button type="submit" disabled={save.isPending || !proof || !pin || !pin2} className={ctaCls}>
          {save.isPending ? 'Saving…' : hasPin ? 'Change PIN' : 'Set PIN'}
        </button>
      </form>
    </section>
  )
}

export default function AccountPasswordPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-s-muted">Loading…</div>}>
      <AccountPasswordInner />
    </Suspense>
  )
}
