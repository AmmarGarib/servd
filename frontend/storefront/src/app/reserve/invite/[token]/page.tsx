'use client'

// /reserve/invite/<token> — join someone's table (owner, 2026-10-26: "To join
// the group ppl have to make an account"). Anyone can see what the invite is
// for; joining needs a signed-in servd account (sign in / create one, then
// come straight back here). A Simmer table is shown in Simmer's own look
// (simmer-brand rules: lowercase, Amarante + Times, no white, no gradients, no
// exclamation marks, one orange signal); every other brand in servd's.
//   GET  /reservations/invites/:token        → { brand, startTime, partySize, seatsLeft, host, joined, isHost }
//   POST /reservations/invites/:token/join   → 201 | 409 BOOKING_FULL | 410 BOOKING_CLOSED | 409 HOST_IS_BOOKER

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useCustomerAuth } from '../../../../store/customerAuth'
import { withReturnPath } from '@/components/auth/authFlow'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface Invite {
  brand: { name: string; slug: string }
  startTime: string
  partySize: number
  seatsLeft: number
  host: string | null
  joined: boolean
  isHost: boolean
}

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

export default function ReserveInvitePage() {
  const { token } = useParams<{ token: string }>()
  const session = useCustomerAuth((s) => s.token)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [problem, setProblem] = useState<'gone' | 'closed' | 'error' | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_URL}/api/v1/reservations/invites/${encodeURIComponent(token)}`, {
        headers: session ? { Authorization: `Bearer ${session}` } : {},
      })
      if (r.status === 404) { setProblem('gone'); return }
      if (r.status === 410) { setProblem('closed'); return }
      if (!r.ok) { setProblem('error'); return }
      setInvite(await r.json() as Invite); setProblem(null)
    } catch { setProblem('error') }
  }, [token, session])
  useEffect(() => { void load() }, [load])

  const simmer = invite?.brand.slug === 'simmer'
  const lc = (s: string) => (simmer ? s.toLowerCase() : s)

  const join = async () => {
    if (!session || busy) return
    setBusy(true); setNote('')
    try {
      const r = await fetch(`${API_URL}/api/v1/reservations/invites/${encodeURIComponent(token)}/join`, {
        method: 'POST', headers: { Authorization: `Bearer ${session}` },
      })
      const body = await r.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      if (r.ok) { await load(); return }
      if (r.status === 410) { setProblem('closed'); return }
      setNote(body?.error?.code === 'BOOKING_FULL' ? 'This table is full. Ask the host to add a seat.' : (body?.error?.message ?? 'That didn’t go through. Try again.'))
    } catch { setNote('No connection. Try again.') } finally { setBusy(false) }
  }

  const here = `/reserve/invite/${token}`

  const theme = simmer
    ? { page: 'simmer-page', bg: undefined as string | undefined, ink: 'var(--simmer-bone)', mute: 'color-mix(in srgb, var(--simmer-bone) 65%, transparent)', head: 'amarante', primary: { background: 'var(--simmer-orange)', color: 'var(--simmer-green)' }, link: 'var(--simmer-bone)' }
    : { page: '', bg: 'var(--servd-bg)', ink: 'var(--servd-ink)', mute: 'var(--servd-mute)', head: '', primary: { background: 'var(--servd-purple)', color: 'var(--servd-on-purple)' }, link: 'var(--servd-purple)' }

  const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', minHeight: 52, border: 0, borderRadius: simmer ? 0 : 'var(--servd-btn-radius, 0.5rem)', fontWeight: simmer ? 400 : 800, fontSize: '1.05rem', textDecoration: 'none', cursor: 'pointer', ...theme.primary }

  let body: React.ReactNode
  if (problem === 'gone') body = <Msg title="This invite link no longer works." text="Ask the host for a new one." mute={theme.mute} />
  else if (problem === 'closed') body = <Msg title="This table has passed." text="The booking was cancelled or has already happened." mute={theme.mute} />
  else if (problem === 'error') body = <Msg title="We couldn’t open this invite." text="Check your connection and reload the page." mute={theme.mute} />
  else if (!invite) body = <p style={{ color: theme.mute }}>Loading…</p>
  else {
    body = (
      <>
        {simmer && (
          <header style={{ textAlign: 'center', marginBottom: '2rem' }}>
            <p className="wordmark" style={{ fontSize: '2.4rem', margin: 0 }}>simmer</p>
            <p className="utility" style={{ fontSize: '0.72rem', color: theme.mute, margin: '0.4rem 0 0' }}>simmer down.</p>
          </header>
        )}
        <p style={{ color: theme.mute, fontSize: '0.8rem', letterSpacing: '0.2em', textTransform: simmer ? 'lowercase' : 'uppercase', margin: 0 }}>
          {lc(invite.host ? `@${invite.host} invited you` : 'You’re invited')}
        </p>
        <h1 className={theme.head} style={{ fontSize: 'clamp(1.9rem, 7vw, 2.5rem)', fontWeight: simmer ? 400 : 800, lineHeight: 1.1, margin: '0.4rem 0 0.75rem' }}>
          {lc(`A table at ${invite.brand.name}`)}
        </h1>
        <p style={{ color: theme.mute, lineHeight: 1.6, margin: '0 0 1.75rem' }}>
          {lc(`${when(invite.startTime)}. ${invite.partySize} at the table, ${invite.seatsLeft} ${invite.seatsLeft === 1 ? 'seat' : 'seats'} still open.`)}
        </p>

        {invite.isHost ? (
          <p style={{ color: theme.mute }}>{lc('This is your own table. Share this link with your guests.')}</p>
        ) : invite.joined ? (
          <>
            <p style={{ fontWeight: 700 }}>{lc('You’re on the table.')}</p>
            <p style={{ color: theme.mute, marginTop: '0.5rem' }}>
              <Link href="/account" style={{ color: theme.link, textDecoration: 'underline' }}>{lc('See my bookings')}</Link>
            </p>
          </>
        ) : !session ? (
          <>
            <p style={{ color: theme.mute, marginBottom: '1rem' }}>{lc('Join with your servd account. You’ll come straight back here.')}</p>
            <Link href={withReturnPath('/signup', here)} style={btn}>{lc('Create a servd account')}</Link>
            <p style={{ marginTop: '0.9rem', textAlign: 'center' }}>
              <Link href={withReturnPath('/login', here)} style={{ color: theme.link, textDecoration: 'underline' }}>{lc('I have an account — sign in')}</Link>
            </p>
          </>
        ) : (
          <button type="button" onClick={() => { void join() }} disabled={busy || invite.seatsLeft === 0} style={{ ...btn, opacity: busy || invite.seatsLeft === 0 ? 0.5 : 1 }}>
            {busy ? lc('Joining…') : invite.seatsLeft === 0 ? lc('The table is full') : lc('Join the table')}
          </button>
        )}
        {note && <p role="alert" style={{ marginTop: '1rem', color: simmer ? theme.ink : 'var(--servd-danger)' }}>{lc(note)}</p>}
      </>
    )
  }

  return (
    <div className={theme.page} style={{ minHeight: '80dvh', background: theme.bg, color: theme.ink, padding: '3.5rem 1rem 4rem' }}>
      <div style={{ maxWidth: '30rem', margin: '0 auto' }}>{body}</div>
    </div>
  )
}

function Msg({ title, text, mute }: { title: string; text: string; mute: string }) {
  return (
    <>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: '0 0 0.5rem' }}>{title}</h1>
      <p style={{ color: mute }}>{text}</p>
    </>
  )
}
