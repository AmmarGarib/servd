'use client'

import { useState } from 'react'
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

  const start = async () => {
    if (!conceptSlug || !name) return
    // Group orders now require a logged-in customer (anonymous group submit
    // was an unpaid-kitchen-ticket primitive). Bounce to login first.
    if (!token) {
      const next = encodeURIComponent(`/group-order?brand=${conceptSlug}`)
      router.push(`/login?next=${next}`)
      return
    }
    setBusy(true); setErr(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/group-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ conceptSlug, initiatorName: name }),
      })
      if (!res.ok) throw new Error('Could not start group')
      const go = await res.json() as { shareCode: string }
      router.push(`/group-order/${go.shareCode}?me=${encodeURIComponent(name)}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  const join = () => {
    if (!code || !joinName) return
    router.push(`/group-order/${code.toUpperCase()}?me=${encodeURIComponent(joinName)}`)
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
        <button onClick={() => setMode('start')} aria-pressed={mode === 'start'}
          className="px-4 py-2 rounded-full font-bold text-sm transition-colors"
          style={mode === 'start'
            ? { background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: '1px solid var(--servd-green)' }
            : { background: 'white', color: 'var(--servd-mute)', border: '1px solid var(--servd-line)' }}>
          Start a group
        </button>
        <button onClick={() => setMode('join')} aria-pressed={mode === 'join'}
          className="px-4 py-2 rounded-full font-bold text-sm transition-colors"
          style={mode === 'join'
            ? { background: 'var(--servd-green)', color: 'var(--servd-on-green)', border: '1px solid var(--servd-green)' }
            : { background: 'white', color: 'var(--servd-mute)', border: '1px solid var(--servd-line)' }}>
          Join with code
        </button>
      </div>

      {mode === 'start' && (
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          {/* Brand picker — grid of actual brand cards. Replaces the
              dev-facing 'type a slug' input. */}
          <p className="text-xs uppercase tracking-widest font-bold mb-3" style={{ color: 'var(--servd-mute)', letterSpacing: '0.22em' }}>
            Pick a kitchen
          </p>
          {brands.length === 0 ? (
            <p style={{ color: 'var(--servd-mute)', marginBottom: '1rem' }}>No kitchens are open right now.</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
              {brands.map((b) => {
                const selected = conceptSlug === b.slug
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setConceptSlug(b.slug)}
                    aria-pressed={selected}
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

          <label className="block mb-3">
            <span className="block text-xs font-bold mb-1" style={{ color: 'var(--servd-mute)', letterSpacing: '0.22em', textTransform: 'uppercase' }}>Your name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="servd-input" placeholder="e.g. Sara K." />
          </label>
          {err && <p className="text-sm" style={{ color: 'var(--servd-danger)' }}>{err}</p>}
          <button onClick={start} disabled={busy || !conceptSlug || !name} className="servd-btn-primary w-full mt-2">
            {busy ? 'Creating…' : conceptSlug ? `Start group at ${brands.find((b) => b.slug === conceptSlug)?.name ?? conceptSlug}` : 'Pick a kitchen first'}
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div className="servd-card" style={{ padding: '1.5rem' }}>
          <label className="block mb-3">
            <span className="block text-xs font-bold mb-1" style={{ color: 'var(--servd-mute)', letterSpacing: '0.22em', textTransform: 'uppercase' }}>Group code</span>
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="6 chars"
              className="servd-input font-mono uppercase tracking-widest" maxLength={8} />
          </label>
          <label className="block mb-3">
            <span className="block text-xs font-bold mb-1" style={{ color: 'var(--servd-mute)', letterSpacing: '0.22em', textTransform: 'uppercase' }}>Your name</span>
            <input value={joinName} onChange={(e) => setJoinName(e.target.value)} className="servd-input" placeholder="e.g. Imran R." />
          </label>
          <button onClick={join} disabled={!code || !joinName} className="servd-btn-primary w-full mt-2">
            Join group
          </button>
        </div>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--servd-mute)' }}>
        After ordering, the host can split the bill at the POS — each diner pays their own.
      </p>
    </div>
  )
}
