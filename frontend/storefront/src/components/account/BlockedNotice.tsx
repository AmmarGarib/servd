'use client'
import { useCallback, useEffect, useState } from 'react'
import { useCustomerAuth } from '../../store/customerAuth'

// "Your servd account is blocked" notice + appeal form (strikes and bans,
// owner decision 2026-10-15: SERVD-WIDE — a block is on the account and
// applies at every brand, so this never names a company or a brand).
//
// API (backend modules/storefront/banAppealRoutes.ts, both need the customer
// token):
//   GET  /storefront/account/blocks       → { blocks: Block[] }
//   POST /storefront/account/ban-appeals  → 201 { appealId }
// While the CEO's appeals switch is OFF both answer 404. This component then
// renders NOTHING — no notice, and the page's own BANNED wording stays as it
// was. An empty list renders nothing either.
//
// Used after sign-in / sign-up, on /account, at checkout on a BANNED error,
// and on the reserve and group-order pages. Sign-in is never refused; this is
// shown next to the way forward, not instead of it.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

export interface AccountBlock {
  banId: string
  since: string
  everywhere: boolean
  message: string
  appeal: { status: 'none' | 'open' | 'declined'; at: string | null }
}

/** The signed-in customer's blocks. [] on 404 (appeals off), on any failure,
 *  or when none are in force — the caller then shows nothing. */
export async function fetchBlocks(token: string | null): Promise<AccountBlock[]> {
  if (!token) return []
  try {
    const res = await fetch(`${API_URL}/api/v1/storefront/account/blocks`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    })
    if (!res.ok) return []
    const data = await res.json().catch(() => null) as { blocks?: AccountBlock[] } | null
    return Array.isArray(data?.blocks) ? data.blocks : []
  } catch { return [] }
}

/** Reads a BANNED API error body: the details the checkout keeps. */
export function isBannedBody(body: unknown): boolean {
  return (body as { error?: { code?: string } } | null)?.error?.code === 'BANNED'
}

const REASONS: Array<{ value: 'new_number' | 'mistake' | 'other'; label: string }> = [
  { value: 'new_number', label: 'This number or email is new to me' },
  { value: 'mistake',    label: 'I think this is a mistake' },
  { value: 'other',      label: 'Something else' },
]

function appealError(status: number, code: string | undefined, message: string | undefined): string {
  if (status === 409 || code === 'APPEAL_OPEN') return 'Your request is already with our help desk. We will get back to you.'
  if (status === 429 || code === 'APPEAL_TOO_SOON' || code === 'RATE_LIMITED') {
    return code === 'APPEAL_TOO_SOON' && message
      ? message
      : 'You have asked a few times already. Please try again a little later.'
  }
  if (status === 404) return 'This block is no longer in force. Please refresh the page.'
  if (status === 400 || code === 'VALIDATION_ERROR') return 'Please pick a reason and write 10 to 1000 characters.'
  return 'We couldn’t send your request just now. Please try again in a moment.'
}

const card: React.CSSProperties = {
  background: 'var(--servd-surface)', border: '1px solid var(--servd-line)',
  borderRadius: 16, padding: '1rem 1.1rem', color: 'var(--servd-ink)', textAlign: 'left',
}
const field: React.CSSProperties = {
  width: '100%', borderRadius: 12, padding: '0.7rem 0.85rem', fontSize: '0.9rem',
  background: 'white', color: 'var(--servd-ink)', border: '1px solid var(--servd-line)',
}

function BlockCard({ block, token, conceptSlug }: { block: AccountBlock; token: string | null; conceptSlug?: string }) {
  const [state, setState] = useState<'open' | 'declined' | 'none' | 'sent'>(block.appeal.status)
  const [showForm, setShowForm] = useState(false)
  const [reason, setReason] = useState<'new_number' | 'mistake' | 'other'>('new_number')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const len = message.trim().length
  const valid = len >= 10 && len <= 1000

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || busy || !token) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${API_URL}/api/v1/storefront/account/ban-appeals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ banId: block.banId, reason, message: message.trim(), ...(conceptSlug && { conceptSlug }) }),
      })
      if (res.ok) { setState('sent'); setShowForm(false); return }
      const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
      if (res.status === 409) setState('open')
      setError(appealError(res.status, body?.error?.code, body?.error?.message))
    } catch {
      setError('We couldn’t reach servd just now. Please try again in a moment.')
    } finally { setBusy(false) }
  }

  return (
    <div style={card} role="status">
      <p style={{ fontWeight: 800, fontSize: '0.95rem', margin: 0 }}>Your servd account is blocked</p>
      <p style={{ fontSize: '0.88rem', lineHeight: 1.5, margin: '0.4rem 0 0', color: 'var(--servd-mute)' }}>
        Your account can’t order or book right now. If this number or email is new to you, or you think
        this is a mistake, ask our help desk to review it.
      </p>

      {(state === 'open' || state === 'sent') && (
        <p style={{ fontSize: '0.88rem', fontWeight: 700, margin: '0.7rem 0 0' }}>
          {state === 'sent'
            ? 'Request sent. Our help desk will review it and get back to you.'
            : 'Your request is with our help desk. We will get back to you.'}
        </p>
      )}

      {state === 'declined' && !showForm && (
        <p style={{ fontSize: '0.88rem', fontWeight: 700, margin: '0.7rem 0 0' }}>
          Our help desk looked at your last request and the block stays for now.
        </p>
      )}

      {(state === 'none' || state === 'declined') && !showForm && (
        <button type="button" onClick={() => setShowForm(true)}
          className="servd-btn-primary" style={{ marginTop: '0.8rem', minHeight: 44, padding: '0.6rem 1.1rem', borderRadius: 999, fontWeight: 800, fontSize: '0.88rem' }}>
          {state === 'declined' ? 'Ask again' : 'Ask for a review'}
        </button>
      )}

      {showForm && (
        <form onSubmit={e => { void send(e) }} style={{ marginTop: '0.8rem', display: 'grid', gap: '0.6rem' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 700 }}>
            Reason
            <select value={reason} onChange={e => setReason(e.target.value as typeof reason)} style={{ ...field, marginTop: 4 }}>
              {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          <label style={{ fontSize: '0.78rem', fontWeight: 700 }}>
            Tell us more
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4} maxLength={1000}
              style={{ ...field, marginTop: 4, resize: 'vertical' }} />
            <span style={{ fontWeight: 500, color: 'var(--servd-mute)' }}>{len} / 1000 (at least 10)</span>
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" disabled={!valid || busy}
              className="servd-btn-primary" style={{ minHeight: 44, padding: '0.6rem 1.1rem', borderRadius: 999, fontWeight: 800, fontSize: '0.88rem', opacity: !valid || busy ? 0.5 : 1 }}>
              {busy ? 'Sending…' : 'Send to help desk'}
            </button>
            <button type="button" onClick={() => setShowForm(false)}
              style={{ minHeight: 44, padding: '0.6rem 1rem', fontWeight: 700, fontSize: '0.88rem', color: 'var(--servd-ink)' }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && <p role="alert" style={{ fontSize: '0.85rem', fontWeight: 700, margin: '0.7rem 0 0', color: 'var(--servd-ink)', borderLeft: '2px solid var(--servd-green)', paddingLeft: 8 }}>{error}</p>}
    </div>
  )
}

export function BlockedNotice({
  blocks: given, conceptSlug, onContinue, continueLabel = 'Continue', className,
}: {
  /** Blocks already read by the caller (after sign-in); else read here. */
  blocks?: AccountBlock[]
  /** Brand slug of the page, kept only as a hint on the appeal. */
  conceptSlug?: string
  /** Shown as a button under the notice (after sign-in / sign-up). */
  onContinue?: () => void
  continueLabel?: string
  className?: string
}) {
  const token = useCustomerAuth((s) => s.token)
  const [blocks, setBlocks] = useState<AccountBlock[]>(given ?? [])

  const load = useCallback(async () => {
    const list = await fetchBlocks(token)
    setBlocks(list)
  }, [token])

  useEffect(() => {
    if (given) { setBlocks(given); return }
    void load()
  }, [given, load])

  if (blocks.length === 0) return null
  // One account-wide block is the normal case; show the first, others read the same.
  const first = blocks[0]!
  return (
    <div className={className} style={{ display: 'grid', gap: '0.6rem' }}>
      <BlockCard key={first.banId} block={first} token={token} {...(conceptSlug && { conceptSlug })} />
      {onContinue && (
        <button type="button" onClick={onContinue}
          style={{ minHeight: 44, fontWeight: 800, fontSize: '0.9rem', textDecoration: 'underline', color: 'inherit' }}>
          {continueLabel}
        </button>
      )}
    </div>
  )
}

export default BlockedNotice
