'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useCustomerAuth } from '../../store/customerAuth'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

interface BrandCard {
  id: string
  name: string
  slug: string
  accent: string
  heroImage: string | null
}

// The host's typed name survives the sign-in bounce (the bounce keeps only
// ?brand= in ?next). Per tab; storage can be blocked, so every access is guarded.
const NAME_KEY = 'servd:group-host-name'
const readSavedName = (): string => { try { return sessionStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }
const saveName = (v: string) => { try { sessionStorage.setItem(NAME_KEY, v) } catch { /* storage blocked */ } }
const forgetName = () => { try { sessionStorage.removeItem(NAME_KEY) } catch { /* storage blocked */ } }

// A group code is exactly 6 characters of this alphabet (the backend's
// genShareCode: no 0/1/I/O). Anything else cannot exist, so say so here.
const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/

interface Props {
  brands: BrandCard[]
}

export function GroupOrderEntryClient({ brands }: Props) {
  const router = useRouter()
  const params = useSearchParams()
  const token = useCustomerAuth((s) => s.token)
  const [mode, setMode] = useState<'start' | 'join'>('start')

  // Start
  const [conceptSlug, setConceptSlug] = useState(params.get('brand') ?? '')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Join
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase())
  const [joinName, setJoinName] = useState('')
  const [joinErr, setJoinErr] = useState<string | null>(null)
  const [joinBusy, setJoinBusy] = useState(false)

  // Back from the sign-in bounce: put the typed name back.
  useEffect(() => {
    const saved = readSavedName()
    if (saved) setName((n) => n || saved)
  }, [])

  const start = async () => {
    if (!conceptSlug || !name.trim()) return
    // Group orders now require a logged-in customer (anonymous group submit
    // was an unpaid-kitchen-ticket primitive). Bounce to login first.
    if (!token) {
      saveName(name.trim())
      const next = encodeURIComponent(`/group-order?brand=${conceptSlug}`)
      router.push(`/login?next=${next}`)
      return
    }
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/group-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conceptSlug, initiatorName: name.trim() }),
      })
      if (!res.ok) {
        // 409 BRAND_CLOSED carries "<Brand> is closed right now. Opens at …".
        const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
        throw new Error(body?.error?.code === 'BRAND_CLOSED' && body.error.message ? body.error.message : 'Could not start group')
      }
      const go = await res.json() as { shareCode: string }
      forgetName()
      router.push(`/group-order/${go.shareCode}?me=${encodeURIComponent(name.trim())}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  const join = async () => {
    const c = code.trim().toUpperCase()
    if (!c || !joinName.trim() || joinBusy) return
    if (!CODE_RE.test(c)) {
      setJoinErr('Group codes are 6 letters and numbers (no 0, 1, I or O). Check the code and try again.')
      return
    }
    setJoinErr(null)
    // The lookup endpoint needs a signed-in customer. When we have one, check
    // the group exists before leaving the page; any other answer (offline,
    // rate limit) just goes on — the group page does its own check.
    if (token) {
      setJoinBusy(true)
      try {
        const res = await fetch(`${API_URL}/api/v1/group-orders/${encodeURIComponent(c)}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.status === 404) {
          setJoinErr('No group with that code. Ask the host to send it again.')
          return
        }
      } catch { /* the group page will say */ } finally { setJoinBusy(false) }
    }
    router.push(`/group-order/${c}?me=${encodeURIComponent(joinName.trim())}`)
  }

  // Arrow keys move through the kitchens like a radio group.
  const onPickerKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir || brands.length === 0) return
    e.preventDefault()
    const i = brands.findIndex((b) => b.slug === conceptSlug)
    const next = brands[(i + dir + brands.length) % brands.length]!
    setConceptSlug(next.slug)
    requestAnimationFrame(() => document.getElementById(`kitchen-${next.id}`)?.focus())
  }

  return (
    <div className="container-narrow section">
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
          {brands.length === 0 ? (
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1rem' }}>No kitchens are open right now.</p>
          ) : (
            <div role="radiogroup" aria-labelledby="kitchen-label" onKeyDown={onPickerKey}
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {brands.map((b, idx) => {
                const selected = conceptSlug === b.slug
                // One tab stop: the chosen kitchen, or the first when none is.
                const stop = selected || (!conceptSlug && idx === 0)
                return (
                  <button
                    key={b.id}
                    id={`kitchen-${b.id}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={stop ? 0 : -1}
                    onClick={() => setConceptSlug(b.slug)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'stretch',
                      padding: 0, borderRadius: '0.85rem', overflow: 'hidden', cursor: 'pointer',
                      background: 'white',
                      border: selected ? `2px solid ${b.accent}` : '2px solid var(--servd-line)',
                      transition: 'border-color 160ms ease',
                      textAlign: 'left',
                    }}>
                    <div aria-hidden style={{
                      aspectRatio: '4 / 3',
                      background: b.accent,
                      position: 'relative',
                      overflow: 'hidden',
                    }}>
                      {/* The card crop as a lazy <img> (decorative), not a
                          CSS background that downloads on page load. */}
                      {b.heroImage && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={b.heroImage}
                          alt=""
                          width={640}
                          height={480}
                          loading="lazy"
                          decoding="async"
                          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
                        />
                      )}
                    </div>
                    <div style={{
                      padding: '0.6rem 0.8rem',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: '0.5rem',
                    }}>
                      <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1rem', color: 'var(--servd-ink)' }}>
                        {b.name}
                      </span>
                      {selected && (
                        <span aria-hidden style={{
                          width: '1rem', height: '1rem', borderRadius: '999px',
                          background: b.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 6l3 3 5-6"/>
                          </svg>
                        </span>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          )}

          <label className="sv-field mb-3">
            <span className="sv-field-label">Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="sv-field-input servd-field" placeholder="e.g. Sara K."
              name="name" autoComplete="given-name" maxLength={120} enterKeyHint="go" />
          </label>
          {err && <p role="alert" className="text-sm" style={{ color: 'var(--servd-danger)' }}>{err}</p>}
          <button type="submit" disabled={busy || !conceptSlug || !name.trim()} className="servd-btn-primary w-full mt-2">
            {busy ? 'Creating…' : conceptSlug ? `Start group at ${brands.find((b) => b.slug === conceptSlug)?.name ?? conceptSlug}` : 'Pick a kitchen first'}
          </button>
        </form>
      )}

      {mode === 'join' && (
        <form className="servd-card" style={{ padding: '1.5rem' }} noValidate
          onSubmit={(e) => { e.preventDefault(); void join() }}>
          <label className="sv-field mb-3">
            <span className="sv-field-label">Group code</span>
            <input value={code}
              onChange={(e) => { setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '')); setJoinErr(null) }}
              placeholder="6 characters" name="code" id="group-code"
              autoComplete="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="next"
              aria-invalid={joinErr ? true : undefined} aria-describedby={joinErr ? 'group-code-err' : undefined}
              className="sv-field-input servd-field font-mono uppercase tracking-widest" maxLength={6} />
          </label>
          <label className="sv-field mb-3">
            <span className="sv-field-label">Your name</span>
            <input value={joinName} onChange={(e) => setJoinName(e.target.value)} className="sv-field-input servd-field" placeholder="e.g. Imran R."
              name="name" autoComplete="given-name" maxLength={120} enterKeyHint="go" />
          </label>
          {joinErr && <p id="group-code-err" role="alert" className="text-sm" style={{ color: 'var(--servd-danger)' }}>{joinErr}</p>}
          <button type="submit" disabled={joinBusy || !code || !joinName.trim()} className="servd-btn-primary w-full mt-2">
            {joinBusy ? 'Checking…' : 'Join group'}
          </button>
        </form>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--servd-mute)' }}>
        After ordering, the host can split the bill at the POS — each diner pays their own.
      </p>
    </div>
  )
}
