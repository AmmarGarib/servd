'use client'

// One "pick your servd name" field with a live availability check (owner,
// 2026-10-26). Used by the first-visit sheet and the account page.
//   GET /storefront/account/nickname-available?q=  → { available, reason, message }
//   PUT /storefront/account/nickname { nickname }  → 409 NICKNAME_TAKEN | 422 NICKNAME_INVALID

import { useEffect, useState } from 'react'
import { nicknameShapeProblem, NICKNAME_MAX } from '../../lib/nickname'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

type Check = { state: 'idle' | 'checking' | 'ok' | 'bad'; message: string }

export function useNicknameCheck(token: string | null, value: string, current: string | null): Check {
  const [check, setCheck] = useState<Check>({ state: 'idle', message: '' })
  useEffect(() => {
    const v = value.trim()
    if (!v) { setCheck({ state: 'idle', message: '' }); return }
    if (current && v === current) { setCheck({ state: 'ok', message: 'This is your servd name.' }); return }
    const shape = nicknameShapeProblem(v)
    if (shape) { setCheck({ state: 'bad', message: shape }); return }
    if (!token) return
    setCheck({ state: 'checking', message: 'Checking…' })
    const ctl = new AbortController()
    const t = setTimeout(() => {
      fetch(`${API_URL}/api/v1/storefront/account/nickname-available?q=${encodeURIComponent(v)}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal,
      })
        .then((r) => r.ok ? r.json() : null)
        .then((d: { available?: boolean; message?: string | null } | null) => {
          if (!d) { setCheck({ state: 'idle', message: '' }); return }
          setCheck(d.available ? { state: 'ok', message: 'Available.' } : { state: 'bad', message: d.message ?? 'That name is taken.' })
        })
        .catch(() => { /* aborted or offline: the save will say */ })
    }, 350)
    return () => { clearTimeout(t); ctl.abort() }
  }, [token, value, current])
  return check
}

/** Save it. Resolves to an error message, or null on success. */
export async function saveNickname(token: string, nickname: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/account/nickname`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ nickname: nickname.trim() }),
    })
    if (res.ok) return null
    const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    if (body?.error?.code === 'NICKNAME_TAKEN') return 'That name is taken. Try another.'
    return body?.error?.message ?? 'We couldn’t save that name. Try again.'
  } catch {
    return 'No connection. Try again.'
  }
}

export function NicknameField({ id, value, onChange, check, autoFocus }: {
  id: string
  value: string
  onChange: (v: string) => void
  check: Check
  autoFocus?: boolean
}) {
  const color = check.state === 'ok' ? 'var(--servd-green-dark)' : check.state === 'bad' ? 'var(--servd-danger)' : 'var(--servd-mute)'
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-bold mb-1.5" style={{ color: 'var(--servd-ink)' }}>Your servd name</label>
      <div style={{ position: 'relative' }}>
        <span aria-hidden style={{ position: 'absolute', left: '0.9rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--servd-mute)', fontWeight: 700 }}>@</span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/\s/g, ''))}
          maxLength={NICKNAME_MAX}
          autoFocus={autoFocus}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="the.goat"
          aria-invalid={check.state === 'bad'}
          aria-describedby={`${id}-hint`}
          className="servd-field w-full rounded-xl py-3.5 pr-4 text-base font-semibold focus:outline-none"
          style={{ paddingLeft: '2rem', background: '#fff', border: `1px solid ${check.state === 'bad' ? 'var(--servd-danger)' : 'var(--servd-line)'}`, color: 'var(--servd-ink)' }}
        />
      </div>
      <p id={`${id}-hint`} aria-live="polite" className="mt-1.5 text-[11px] font-semibold" style={{ color, minHeight: '1rem' }}>
        {check.message || '3–20 letters, numbers, dots or underscores.'}
      </p>
    </div>
  )
}
