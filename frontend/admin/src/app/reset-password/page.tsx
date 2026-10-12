'use client'
// Where the emailed reset link lands.
//
// Public by design — the token IS the credential, so this page cannot require
// a session (the whole point is that the person has no way to get one). It is
// in AuthGuard's PUBLIC_PATHS for that reason.
//
// The token is checked before the form is shown, so an expired or already-used
// link says so immediately rather than after someone has typed a new password
// twice.

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

const MIN_LENGTH = 12

function ResetPasswordInner() {
  const router = useRouter()
  const token = useSearchParams().get('token') ?? ''

  const [state, setState] = useState<'checking' | 'ready' | 'bad' | 'done'>('checking')
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!token) { setState('bad'); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_URL}/api/v1/auth/password/reset?token=${encodeURIComponent(token)}`)
        const d = await res.json().catch(() => ({ valid: false }))
        if (!cancelled) setState(d.valid ? 'ready' : 'bad')
      } catch {
        // Can't reach the API. Show the form rather than claiming the link is
        // dead — submitting will surface the real error.
        if (!cancelled) setState('ready')
      }
    })()
    return () => { cancelled = true }
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (pw1 !== pw2) { setError('The two passwords do not match'); return }
    setError(''); setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/password/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword: pw1 }),
      })
      if (res.status === 204) {
        setState('done')
        setPw1(''); setPw2('')
        return
      }
      const d = await res.json().catch(() => ({}))
      throw new Error(d.error?.message ?? 'Could not set your password')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set your password')
    } finally {
      setLoading(false)
    }
  }

  const field = 'w-full mb-3 rounded-xl px-4 py-3 text-s-text outline-none'
  const fieldStyle = { background: 'rgb(var(--fg-rgb) / 0.04)', border: '1px solid rgb(var(--fg-rgb) / 0.1)' }
  const cta = 'w-full rounded-xl py-3 text-sm font-black transition-opacity disabled:opacity-40'
  const ctaStyle = { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' }

  return (
    <div className="min-h-screen bg-s-bg flex flex-col">
      <div className="flex items-center gap-2 px-6 pt-5">
        <span className="text-lg font-black text-s-text">servd</span>
      </div>

      <div className="flex-1 flex items-center justify-center px-6">
        <div className="w-full max-w-sm">
          <h1 className="text-xl font-black text-s-text mb-1 text-center">Set a new password</h1>

          {state === 'checking' && (
            <p className="text-xs text-s-dim text-center mt-6">Checking your link…</p>
          )}

          {state === 'bad' && (
            <div className="text-center mt-6">
              <p className="text-sm text-s-text mb-2">This link is no longer valid.</p>
              <p className="text-xs text-s-dim mb-5 leading-relaxed">
                Reset links work once and expire after 30 minutes. Ask for a
                fresh one and use the newest email.
              </p>
              <Link href="/login" className={cta + ' block text-center'} style={ctaStyle}>
                Back to sign in
              </Link>
            </div>
          )}

          {state === 'done' && (
            <div className="text-center mt-6">
              <p className="text-sm font-bold text-success mb-2">Password set.</p>
              <p className="text-xs text-s-dim mb-5 leading-relaxed">
                Every other device signed in as you has been signed out.
              </p>
              <button type="button" onClick={() => router.push('/login')} className={cta} style={ctaStyle}>
                Sign in
              </button>
            </div>
          )}

          {state === 'ready' && (
            <form onSubmit={submit} className="mt-6">
              <input
                type="password" value={pw1} onChange={(e) => setPw1(e.target.value)}
                placeholder="New password" autoComplete="new-password" autoFocus
                className={field} style={fieldStyle}
              />
              <input
                type="password" value={pw2} onChange={(e) => setPw2(e.target.value)}
                placeholder="Repeat new password" autoComplete="new-password"
                className="w-full mb-4 rounded-xl px-4 py-3 text-s-text outline-none" style={fieldStyle}
              />
              <p className="text-[10px] text-s-dim mb-3 text-center">At least {MIN_LENGTH} characters.</p>
              {error && <p className="text-xs text-center mb-3" style={{ color: 'var(--erp-danger)' }}>{error}</p>}
              <button type="submit" className={cta} style={ctaStyle}
                disabled={loading || pw1.length < MIN_LENGTH}>
                {loading ? 'Setting…' : 'Set password'}
              </button>
              <Link href="/login"
                className="block w-full mt-3 text-xs text-s-dim hover:text-s-muted transition-colors text-center">
                &larr; Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  // useSearchParams needs a Suspense boundary in the app router, or the whole
  // route opts into client-side rendering and the build warns.
  return (
    <Suspense fallback={<div className="min-h-screen bg-s-bg" />}>
      <ResetPasswordInner />
    </Suspense>
  )
}
