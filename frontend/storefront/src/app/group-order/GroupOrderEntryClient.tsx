'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCustomerAuth } from '../../store/customerAuth'
import type { Concept } from '../../lib/concept'
import { formatBrandName } from '../../lib/concept'
import { KitchenPicker } from '../../sections/servd/Kitchens'
import { NicknameField, saveNickname, useNicknameCheck } from '../../components/account/NicknameField'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// A group code is exactly 6 characters of this alphabet (the backend's
// genShareCode: no 0/1/I/O). Anything else cannot exist, so say so here.
const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/

interface Props {
  /** The public brands (GET /storefront/concepts — the one public-brand rule). */
  concepts: Concept[]
  /** The home page's kitchen-card tiles (servd:home → servd.kitchens), so the cards match. */
  tiles: Record<string, unknown>[]
}

export function GroupOrderEntryClient({ concepts, tiles }: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const token = useCustomerAuth((s) => s.token)
  const [mode, setMode] = useState<'start' | 'join'>(params.get('code') ? 'join' : 'start')

  // Your name in the group is your servd name (owner, 2026-10-26). Signed in
  // without one: pick it here, it is saved to the account first.
  const [nickname, setNickname] = useState<string | null>(null)
  const [accountLoaded, setAccountLoaded] = useState(false)
  const [nickValue, setNickValue] = useState('')
  const nickCheck = useNicknameCheck(token && accountLoaded && !nickname ? token : null, nickValue, null)
  useEffect(() => {
    if (!token) { setAccountLoaded(false); setNickname(null); return }
    fetch(`${API_URL}/api/v1/storefront/account`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((a: { nickname?: string | null } | null) => { setNickname(a?.nickname ?? null); setAccountLoaded(true) })
      .catch(() => setAccountLoaded(true))
  }, [token])

  // Start
  const [conceptSlug, setConceptSlug] = useState(params.get('brand') ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Join
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase())
  const [joinErr, setJoinErr] = useState<string | null>(null)

  const picked = concepts.find((c) => c.slug === conceptSlug)
  const needNick = !!token && accountLoaded && !nickname

  const start = async () => {
    if (!conceptSlug) return
    // Group orders need a signed-in customer. Bounce to login first.
    if (!token) {
      router.push(`/login?next=${encodeURIComponent(`/group-order?brand=${conceptSlug}`)}`)
      return
    }
    if (busy) return
    if (needNick && (!nickValue.trim() || nickCheck.state === 'bad')) return
    setBusy(true); setErr(null)
    try {
      if (needNick) {
        const e = await saveNickname(token, nickValue)
        if (e) throw new Error(e)
        setNickname(nickValue.trim())
      }
      const res = await fetch(`${API_URL}/api/v1/group-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conceptSlug }),
      })
      if (!res.ok) {
        // 409 BRAND_CLOSED carries "<Brand> is closed right now. Opens at …".
        const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
        throw new Error(body?.error?.code === 'BRAND_CLOSED' && body.error.message ? body.error.message : 'Could not start group')
      }
      const go = await res.json() as { shareCode: string }
      router.push(`/group-order/${go.shareCode}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  const join = () => {
    const c = code.trim().toUpperCase()
    if (!c) return
    if (!CODE_RE.test(c)) {
      setJoinErr('Group codes are 6 letters and numbers (no 0, 1, I or O). Check the code and try again.')
      return
    }
    setJoinErr(null)
    // The room signs you in (if needed), joins you under your servd name, and
    // says so if the code is wrong.
    router.push(`/group-order/${c}`)
  }

  return (
    <div className="container section">
      <p className="eyebrow eyebrow-accent">Group order</p>
      <h1 className="display" style={{ fontSize: 'clamp(2.25rem, 6vw, 3.75rem)', margin: '0.5rem 0 0.75rem' }}>
        Eat together.<br />
        <span className="display-italic">One bill. Or split.</span>
      </h1>
      <p style={{ color: 'var(--servd-mute)', marginBottom: '2rem', maxWidth: '32rem' }}>
        Start a shared cart, send the link, everyone adds their own — checkout once.
      </p>

      {/* Mode tabs */}
      <div className="flex gap-2 mb-6">
        <button type="button" onClick={() => setMode('start')} aria-pressed={mode === 'start'}
          className="px-4 py-2 min-h-11 rounded-full font-bold text-sm transition-colors"
          style={mode === 'start'
            ? { background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: '1px solid var(--servd-green)' }
            : { background: 'white', color: 'var(--servd-mute)', border: '1px solid var(--servd-line)' }}>
          Start a group
        </button>
        <button type="button" onClick={() => setMode('join')} aria-pressed={mode === 'join'}
          className="px-4 py-2 min-h-11 rounded-full font-bold text-sm transition-colors"
          style={mode === 'join'
            ? { background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: '1px solid var(--servd-green)' }
            : { background: 'white', color: 'var(--servd-mute)', border: '1px solid var(--servd-line)' }}>
          Join with code
        </button>
      </div>

      {mode === 'start' && (
        <form className="servd-card" style={{ padding: '1.5rem' }} noValidate
          onSubmit={(e) => { e.preventDefault(); void start() }}>
          {/* Brand picker — grid of actual brand cards. Replaces the
              dev-facing 'type a slug' input. */}
          <p id="kitchen-label" className="text-xs uppercase tracking-widest font-bold mb-3" style={{ color: 'var(--servd-mute)', letterSpacing: '0.22em' }}>
            Pick a kitchen
          </p>
          {concepts.length === 0 ? (
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1rem' }}>No kitchens are open right now.</p>
          ) : (
            <div style={{ marginBottom: '2.5rem', paddingTop: '0.5rem' }}>
              <KitchenPicker concepts={concepts} tiles={tiles} selected={conceptSlug} onPick={setConceptSlug} labelledBy="kitchen-label" />
            </div>
          )}

          {token && nickname && (
            <p className="text-sm mb-3" style={{ color: 'var(--servd-mute)' }}>You&rsquo;ll show in the group as <strong style={{ color: 'var(--servd-ink)' }}>@{nickname}</strong>.</p>
          )}
          {needNick && (
            <div className="mb-3">
              <NicknameField id="group-start-nickname" value={nickValue} onChange={setNickValue} check={nickCheck} />
            </div>
          )}
          {!token && (
            <p className="text-sm mb-3" style={{ color: 'var(--servd-mute)' }}>Everyone in a group joins with their servd account.</p>
          )}
          {err && <p role="alert" className="text-sm" style={{ color: 'var(--servd-danger)' }}>{err}</p>}
          <button type="submit" disabled={busy || !conceptSlug || (needNick && (!nickValue.trim() || nickCheck.state === 'bad'))} className="servd-btn-rect servd-btn-primary w-full mt-2">
            {busy ? 'Creating…' : !picked ? 'Pick a kitchen first' : token ? `Start group at ${formatBrandName(picked.name)}` : `Sign in to start at ${formatBrandName(picked.name)}`}
          </button>
        </form>
      )}

      {mode === 'join' && (
        <form className="servd-card" style={{ padding: '1.5rem' }} noValidate
          onSubmit={(e) => { e.preventDefault(); join() }}>
          <label className="sv-field mb-3">
            <span className="sv-field-label">Group code</span>
            <input value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setJoinErr(null) }}
              placeholder="6 characters" name="code" id="group-code"
              autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="next"
              aria-invalid={joinErr ? true : undefined} aria-describedby={joinErr ? 'group-code-err' : undefined}
              className="sv-field-input servd-field font-mono uppercase tracking-widest" maxLength={6} />
          </label>
          {joinErr && <p id="group-code-err" role="alert" className="text-sm" style={{ color: 'var(--servd-danger)' }}>{joinErr}</p>}
          <button type="submit" disabled={!code} className="servd-btn-rect servd-btn-primary w-full mt-2">
            Join group
          </button>
          <p className="mt-3 text-xs" style={{ color: 'var(--servd-mute)' }}>You join with your servd account, under your servd name.</p>
        </form>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--servd-mute)' }}>
        After ordering, the host can split the bill at the POS — each diner pays their own.
      </p>
    </div>
  )
}
