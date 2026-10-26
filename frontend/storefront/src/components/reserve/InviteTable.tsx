'use client'

// "Invite your table" (owner, 2026-10-26): the booker makes a link, shares it,
// and sees who joined. Everyone who opens the link signs in (or creates a
// servd account) and joins as a guest. One component for the account page
// (tone 'servd') and Simmer's booking page (tone 'simmer': simmer-brand rules —
// no white, no gradients, no exclamation marks, lowercase voice).
//   POST   /reservations/mine/:id/invite   → { inviteUrl, seatsLeft, guests }
//   GET    /reservations/mine/:id/invite   → { active, seatsLeft, guests }
//   DELETE /reservations/mine/:id/invite   (stop the link)
//   DELETE /reservations/mine/:id/guests/:guestId

import { useCallback, useEffect, useState } from 'react'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Guest { id: string; nickname: string | null; firstName: string; joinedAt: string }
interface InviteState { active: boolean; seatsLeft: number; partySize: number; guests: Guest[] }

const TONES = {
  servd: {
    panel: { background: 'var(--servd-surface)', border: '1px solid var(--servd-line)', color: 'var(--servd-ink)' },
    mute: 'var(--servd-mute)',
    primary: { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)' },
    quiet: { background: 'transparent', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)' },
    danger: 'var(--servd-danger)',
    font: 'inherit',
  },
  simmer: {
    panel: { background: 'transparent', border: '1px solid color-mix(in srgb, var(--simmer-bone) 30%, transparent)', color: 'var(--simmer-bone)' },
    mute: 'color-mix(in srgb, var(--simmer-bone) 70%, transparent)',
    primary: { background: 'var(--simmer-orange)', color: 'var(--simmer-green)' },
    quiet: { background: 'transparent', color: 'var(--simmer-bone)', border: '1px solid color-mix(in srgb, var(--simmer-bone) 40%, transparent)' },
    danger: 'var(--simmer-bone)',
    font: 'var(--simmer-body)',
  },
} as const

export function InviteTable({ token, reservationId, tone = 'servd', partySize }: {
  token: string
  reservationId: string
  tone?: keyof typeof TONES
  partySize?: number
}) {
  const t = TONES[tone]
  const lc = (s: string) => (tone === 'simmer' ? s.toLowerCase() : s)
  const [state, setState] = useState<InviteState | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const r = await fetch(`${API_URL}/api/v1/reservations/mine/${reservationId}/invite`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    if (r?.ok) setState(await r.json() as InviteState)
  }, [token, reservationId])
  useEffect(() => { void load() }, [load])

  const makeLink = async () => {
    setBusy(true); setNote('')
    try {
      const r = await fetch(`${API_URL}/api/v1/reservations/mine/${reservationId}/invite`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const body = await r.json().catch(() => null) as ({ inviteUrl?: string; error?: { message?: string } } & Partial<InviteState>) | null
      if (!r.ok || !body?.inviteUrl) { setNote(body?.error?.message ?? 'We couldn’t make a link. Try again.'); return }
      // Same page origin as the visitor (servd.pk or a preview), the path from the API.
      const path = new URL(body.inviteUrl).pathname
      setUrl(`${window.location.origin}${path}`)
      setState((s) => ({ active: true, seatsLeft: body.seatsLeft ?? s?.seatsLeft ?? 0, partySize: body.partySize ?? s?.partySize ?? partySize ?? 0, guests: body.guests ?? s?.guests ?? [] }))
    } catch { setNote('No connection. Try again.') } finally { setBusy(false) }
  }

  const share = async () => {
    if (!url) return
    const text = tone === 'simmer' ? 'a seat is waiting for you at simmer. join my table' : 'Join my table on servd'
    try {
      if (navigator.share) { await navigator.share({ title: text, text, url }); return }
    } catch { /* cancelled: fall through to copy */ }
    try { await navigator.clipboard.writeText(url); setNote(lc('Link copied.')) } catch { setNote(url) }
  }

  const stop = async () => {
    setBusy(true)
    await fetch(`${API_URL}/api/v1/reservations/mine/${reservationId}/invite`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    setUrl(null); setNote(lc('Link stopped. Anyone who already joined stays.')); setBusy(false); void load()
  }

  const remove = async (g: Guest) => {
    await fetch(`${API_URL}/api/v1/reservations/mine/${reservationId}/guests/${g.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => null)
    void load()
  }

  const btn = { borderRadius: 'var(--servd-btn-radius, 0.5rem)', padding: '0.7rem 1rem', fontWeight: 800, fontSize: '0.9rem', minHeight: 44, fontFamily: t.font } as const

  return (
    <div style={{ ...t.panel, borderRadius: '0.75rem', padding: '1rem', fontFamily: t.font }}>
      <p style={{ fontWeight: 800, margin: 0 }}>{lc('Invite your table')}</p>
      <p style={{ color: t.mute, fontSize: '0.85rem', margin: '0.25rem 0 0.75rem' }}>
        {state
          ? lc(`${state.seatsLeft} of ${Math.max(0, state.partySize - 1)} seats still open. Everyone joins with their servd account.`)
          : lc('Send your guests a link. Everyone joins with their servd account.')}
      </p>

      {url ? (
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input readOnly value={url} aria-label={lc('Invite link')} onFocus={(e) => e.currentTarget.select()}
            style={{ flex: '1 1 12rem', minWidth: 0, ...t.quiet, borderRadius: '0.5rem', padding: '0.6rem 0.75rem', fontSize: '0.8rem', fontFamily: 'inherit' }} />
          <button type="button" onClick={() => { void share() }} style={{ ...btn, ...t.primary }}>{lc('Share link')}</button>
        </div>
      ) : (
        <button type="button" disabled={busy || (state?.seatsLeft ?? 1) === 0} onClick={() => { void makeLink() }}
          style={{ ...btn, ...t.primary, width: '100%', opacity: busy ? 0.6 : 1 }}>
          {busy ? lc('Making link…') : state?.active ? lc('Get a new link') : lc('Get invite link')}
        </button>
      )}
      {state?.active && !url && (
        <p style={{ color: t.mute, fontSize: '0.75rem', margin: '0.5rem 0 0' }}>
          {lc('Your link is live. A new link stops the old one.')}{' '}
          <button type="button" onClick={() => { void stop() }} style={{ color: t.danger, textDecoration: 'underline', background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer' }}>{lc('Stop the link')}</button>
        </p>
      )}
      {note && <p role="status" style={{ color: t.mute, fontSize: '0.8rem', margin: '0.5rem 0 0', wordBreak: 'break-all' }}>{note}</p>}

      {state && state.guests.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0' }} aria-label={lc('Who joined')}>
          {state.guests.map((g) => (
            <li key={g.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', padding: '0.4rem 0', borderTop: `1px solid ${tone === 'simmer' ? 'color-mix(in srgb, var(--simmer-bone) 20%, transparent)' : 'var(--servd-line)'}` }}>
              <span style={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.nickname ? `@${g.nickname}` : g.firstName}</span>
              <button type="button" onClick={() => { void remove(g) }} style={{ color: t.mute, background: 'none', border: 0, fontSize: '0.8rem', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit' }}>{lc('Remove')}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
