'use client'

// Global feedback widget. Floating bottom-right button that opens a sheet
// with three modes:
//   1. NPS — "How likely to recommend?" 0..10 grid
//   2. CSAT — "How was your most recent experience?" 1..5 drawn faces
//   3. Open — "Got an idea?" freeform comment
//
// Submits to POST /api/v1/feedback. Anonymous submissions are allowed; the
// auth token is included if available (so feedback links to the customer).
//
// Local-storage gate: if a user submits within the last 14 days, we hide
// the widget so we're not nagging — they can re-open it via /account.

import { useState, useEffect, type CSSProperties, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { useBrandSlug } from '../../lib/host'
import { BRAND_REWRITE_PATHS } from '../../lib/brandDomains'
import s from '../world/companion.module.css'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const COOLDOWN_DAYS = 14
const STORAGE_KEY = 'servd-feedback-cooldown'

const ROUTES_HIDDEN_ON = ['/login', '/signup', '/auth', '/reserve/claim', '/orders/[id]/review']

// ── Skins ────────────────────────────────────────────────────────────────────
// The control wears the room it's in: servd's cream sticker on the hub, bone
// on tiber for simmer (no white, no shadow, lowercase), cream on plum for
// stackd, Flipd blue on bone for the diner.
type Skin = 'servd' | 'simmer' | 'stackd' | 'flipd'

interface Palette {
  surface: string; ink: string; mute: string; line: string
  field: string; accent: string; accentInk: string; selected: string; selectedInk: string
  scrim: string; font?: string; lowercase?: boolean
}

const PALETTES: Record<Skin, Palette> = {
  servd:  { surface: '#FFF9EC', ink: '#2E1530', mute: 'rgba(78,42,79,0.72)', line: 'rgba(78,42,79,0.24)',
            field: '#FFFDF7', accent: '#4E2A4F', accentInk: '#FFF4D6', selected: '#FFE58A', selectedInk: '#2E1530',
            scrim: 'rgba(46,21,48,0.45)' },
  simmer: { surface: '#06392F', ink: '#EDE6D3', mute: 'rgba(237,230,211,0.74)', line: 'rgba(237,230,211,0.32)',
            field: '#0A4639', accent: '#EDE6D3', accentInk: '#06392F', selected: 'rgba(237,230,211,0.16)', selectedInk: '#EDE6D3',
            scrim: 'rgba(14,14,14,0.55)', font: "var(--simmer-body, 'Times New Roman', Times, serif)", lowercase: true },
  stackd: { surface: '#FCE8CE', ink: '#5A1E33', mute: 'rgba(90,30,51,0.74)', line: 'rgba(90,30,51,0.26)',
            field: '#FFF4E4', accent: '#7C2946', accentInk: '#FCE8CE', selected: '#9BD3DD', selectedInk: '#3A1322',
            scrim: 'rgba(58,19,34,0.45)' },
  flipd:  { surface: '#EDE6D3', ink: '#090D17', mute: 'rgba(9,13,23,0.68)', line: 'rgba(9,13,23,0.2)',
            field: '#F6F1E4', accent: '#2092E9', accentInk: '#090D17', selected: '#2092E9', selectedInk: '#090D17',
            scrim: 'rgba(9,13,23,0.5)' },
}

function skinFor(pathname: string, hostSlug: string | null): Skin {
  // On a brand domain the microsite paths are the brand's own room.
  if (hostSlug && BRAND_REWRITE_PATHS.has(pathname)) {
    if (hostSlug === 'simmer' || hostSlug === 'stackd' || hostSlug === 'flipd') return hostSlug
  }
  const segs = pathname.split('/').filter(Boolean).map((x) => x.toLowerCase())
  const slug = segs[0] === 'brand' || segs[0] === 'brands' || segs[0] === 'reserve' ? segs[1] : segs[0]
  if (slug === 'simmer' || slug?.startsWith('simmer-')) return 'simmer'
  if (slug === 'stackd' || slug?.startsWith('stackd-')) return 'stackd'
  if (slug === 'flipd' || slug?.startsWith('flipd-')) return 'flipd'
  return 'servd'
}

export function FeedbackWidget() {
  const pathname = usePathname() ?? ''
  // Resolves after mount — the widget itself only renders after mount, so the
  // skin is right on its first paint.
  const hostSlug = useBrandSlug(null)
  const skin = skinFor(pathname, hostSlug)
  const p = PALETTES[skin]
  const [open, setOpen]     = useState(false)
  const [mode, setMode]     = useState<'nps' | 'csat' | 'open' | 'menu'>('menu')
  const [score, setScore]   = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]     = useState(false)
  const [hidden, setHidden] = useState(true)  // SSR-safe — render nothing until client mount

  useEffect(() => {
    const cooldown = localStorage.getItem(STORAGE_KEY)
    if (cooldown && parseInt(cooldown, 10) > Date.now()) {
      setHidden(true)
      return
    }
    if (ROUTES_HIDDEN_ON.some((r) => pathname.startsWith(r.replace('[id]', '')))) {
      setHidden(true)
      return
    }
    setHidden(false)
  }, [pathname])

  if (hidden) return null

  async function submit() {
    setSubmitting(true)
    try {
      const token = typeof window !== 'undefined'
        ? JSON.parse(localStorage.getItem('servd-customer-auth') ?? '{}')?.state?.token
        : null
      const res = await fetch(`${API_URL}/api/v1/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({
          kind: mode,
          score: mode !== 'open' ? score : null,
          comment: comment.trim() || null,
          context: { page: pathname },
        }),
      })
      if (res.ok) {
        setDone(true)
        // Hide widget for COOLDOWN_DAYS so we don't keep prompting.
        localStorage.setItem(STORAGE_KEY, String(Date.now() + COOLDOWN_DAYS * 86_400_000))
      }
    } catch { /* swallow — non-blocking feedback */ }
    finally { setSubmitting(false) }
  }

  function reset() {
    setOpen(false); setMode('menu'); setScore(null); setComment(''); setDone(false)
  }

  const h3: CSSProperties = { fontSize: '1.08rem', fontWeight: skin === 'simmer' ? 400 : 800, color: p.ink, lineHeight: 1.25 }
  const sub: CSSProperties = { color: p.mute, fontSize: '0.85rem' }
  const field: CSSProperties = {
    width: '100%', padding: '0.65rem 0.75rem', border: `1.5px solid ${p.line}`, borderRadius: '0.75rem',
    background: p.field, color: p.ink, fontSize: '0.92rem', fontFamily: 'inherit', resize: 'vertical', marginBottom: '1rem',
  }

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Send feedback"
          className={s.fb}
          data-skin={skin}>
          <Icon size={18}>
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </Icon>
          <span className={s.fbLabel}>{skin === 'simmer' ? 'feedback' : 'Feedback'}</span>
        </button>
      )}

      {open && (
        <div
          onClick={reset}
          style={{
            position: 'fixed', inset: 0, zIndex: 60, display: 'flex',
            alignItems: 'flex-end', justifyContent: 'center',
            background: p.scrim,
          }}>
          <div
            role="dialog"
            aria-modal="true"
            aria-label={skin === 'simmer' ? 'feedback' : 'Feedback'}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: p.surface, color: p.ink, width: '100%', maxWidth: '32rem',
              borderRadius: '1.5rem 1.5rem 0 0', padding: '1.5rem 1.5rem calc(2rem + env(safe-area-inset-bottom, 0px))',
              border: skin === 'simmer' ? `1px solid ${p.line}` : `2px solid ${p.accent}`, borderBottom: 'none',
              boxShadow: skin === 'simmer' ? 'none' : '0 -8px 32px rgba(0,0,0,0.18)',
              fontFamily: p.font,
              textTransform: p.lowercase ? 'lowercase' : undefined,
            }}>
            {/* Drag handle */}
            <div style={{
              width: '3rem', height: '0.25rem', borderRadius: '999px',
              background: p.line, margin: '0 auto 1.25rem',
            }} />

            {done ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                <span aria-hidden="true" style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: '3rem', height: '3rem', borderRadius: '50%', marginBottom: '0.75rem',
                  background: p.selected, color: p.selectedInk,
                }}>
                  <Icon><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" /></Icon>
                </span>
                <h3 style={{ ...h3, fontSize: '1.25rem', marginBottom: '0.5rem' }}>Thanks for telling us.</h3>
                <p style={{ ...sub, marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                  Every word lands somewhere real. We&rsquo;ll do better.
                </p>
                <PrimaryButton p={p} onClick={reset} style={{ minWidth: '10rem' }}>Done</PrimaryButton>
              </div>
            ) : mode === 'menu' ? (
              <>
                <h3 style={{ ...h3, fontSize: '1.1rem', marginBottom: '0.25rem' }}>Tell us anything.</h3>
                <p style={{ ...sub, marginBottom: '1.25rem' }}>
                  Quick honest feedback &mdash; we read every word.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <ModeButton p={p} icon={ICON_STAR} label="Would you recommend us?" sub="30 sec · NPS" onClick={() => setMode('nps')} />
                  <ModeButton p={p} icon={ICON_SMILE} label="How was your experience?" sub="10 sec · CSAT" onClick={() => setMode('csat')} />
                  <ModeButton p={p} icon={ICON_BULB} label="Got an idea?" sub="freeform" onClick={() => setMode('open')} />
                </div>
              </>
            ) : mode === 'nps' ? (
              <>
                <h3 style={{ ...h3, marginBottom: '1rem' }}>
                  How likely are you to recommend servd to a friend?
                </h3>
                <div role="radiogroup" aria-label="Score from 0 to 10" style={{
                  display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: '0.25rem',
                  marginBottom: '0.5rem',
                }}>
                  {Array.from({ length: 11 }, (_, n) => (
                    <button key={n} onClick={() => setScore(n)} type="button"
                      role="radio" aria-checked={score === n}
                      style={{
                        aspectRatio: '1', minWidth: 0, minHeight: '2rem',
                        border: `1.5px solid ${score === n ? p.accent : p.line}`,
                        background: score === n ? p.accent : p.field,
                        color: score === n ? p.accentInk : p.ink,
                        borderRadius: '0.5rem', fontWeight: 700, cursor: 'pointer',
                        fontSize: 'clamp(0.7rem, 2vw, 0.85rem)', fontFamily: 'inherit',
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: p.mute, marginBottom: '1rem' }}>
                  <span>Not at all</span>
                  <span>Very likely</span>
                </div>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000}
                  aria-label="Tell us why"
                  placeholder={score != null && score <= 6 ? 'What would have made it a 9 or 10?' : 'Tell us why (optional)'}
                  style={field} />
                <SubmitRow p={p} onBack={() => setMode('menu')} canSubmit={score != null} submit={submit} submitting={submitting} />
              </>
            ) : mode === 'csat' ? (
              <>
                <h3 style={{ ...h3, marginBottom: '1rem' }}>How was your most recent experience?</h3>
                <div role="radiogroup" aria-label="Rate your experience" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.4rem', marginBottom: '1rem' }}>
                  {CSAT.map((o) => (
                    <button key={o.n} onClick={() => setScore(o.n)} type="button"
                      role="radio" aria-checked={score === o.n}
                      style={{
                        padding: '0.75rem 0.25rem', minWidth: 0,
                        border: `1.5px solid ${score === o.n ? p.accent : p.line}`,
                        background: score === o.n ? p.selected : p.field,
                        color: score === o.n ? p.selectedInk : p.ink,
                        borderRadius: '0.85rem', textAlign: 'center', cursor: 'pointer',
                        fontFamily: 'inherit',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem',
                      }}>
                      <Face n={o.n} />
                      <span style={{ fontSize: '0.72rem', fontWeight: 600 }}>{o.label}</span>
                    </button>
                  ))}
                </div>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000}
                  aria-label="Anything we should know"
                  placeholder="Anything we should know? (optional)"
                  style={field} />
                <SubmitRow p={p} onBack={() => setMode('menu')} canSubmit={score != null} submit={submit} submitting={submitting} />
              </>
            ) : (
              <>
                <h3 style={{ ...h3, marginBottom: '0.25rem' }}>What&rsquo;s on your mind?</h3>
                <p style={{ ...sub, marginBottom: '1rem', fontSize: '0.8rem' }}>
                  An idea, a complaint, a wish — anything. Anonymous if you want.
                </p>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={5} maxLength={2000}
                  aria-label="Your feedback"
                  placeholder="Type away…"
                  style={{ ...field, padding: '0.75rem' }} />
                <SubmitRow p={p} onBack={() => setMode('menu')} canSubmit={comment.trim().length > 0} submit={submit} submitting={submitting} />
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

// ── Icons: inline SVG, stroke 2, currentColor, 20px ─────────────────────────
function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={{ flex: 'none', display: 'block' }}>
      {children}
    </svg>
  )
}

const ICON_STAR = (
  <path d="M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2L12 17l-5.6 3 1.1-6.2L2.9 9.4l6.3-.9L12 2.8z" />
)
const ICON_SMILE = (
  <>
    <circle cx="12" cy="12" r="9.2" />
    <path d="M8 14.2c1 1.4 2.4 2.1 4 2.1s3-.7 4-2.1" />
    <path d="M9 9.6h.01M15 9.6h.01" />
  </>
)
const ICON_BULB = (
  <>
    <path d="M9 18h6M10 21.2h4" />
    <path d="M12 2.8a6.2 6.2 0 0 0-3.8 11.1c.6.5 1 1.2 1 2V16h5.6v-.1c0-.8.4-1.5 1-2A6.2 6.2 0 0 0 12 2.8z" />
  </>
)

const CSAT: { n: number; label: string }[] = [
  { n: 1, label: 'Bad' },
  { n: 2, label: 'Meh' },
  { n: 3, label: 'OK' },
  { n: 4, label: 'Good' },
  { n: 5, label: 'Loved it' },
]

/** A simple drawn face: same head and eyes, the mouth curve does the talking. */
function Face({ n }: { n: number }) {
  // Mouth control-point offset: negative frowns, positive smiles.
  const curve = [0, -3.4, -1.6, 0, 1.8, 3.6][n] ?? 0
  const mouthY = 15.4 - curve / 3
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9.2" />
      {n === 1 ? (
        <path d="M7.6 8.4l2.4 1.2M16.4 8.4L14 9.6" />
      ) : null}
      <path d="M9 10.2h.01M15 10.2h.01" strokeWidth="2.6" />
      {n === 5 ? (
        <path d="M7.8 13.6c1.1 2.2 2.5 3.2 4.2 3.2s3.1-1 4.2-3.2z" fill="currentColor" fillOpacity="0.18" />
      ) : (
        <path d={`M8.2 ${mouthY.toFixed(2)} Q12 ${(mouthY + curve).toFixed(2)} 15.8 ${mouthY.toFixed(2)}`} />
      )}
    </svg>
  )
}

function PrimaryButton({ p, onClick, disabled, children, style }: {
  p: Palette; onClick: () => void; disabled?: boolean; children: ReactNode; style?: CSSProperties
}) {
  return (
    <button onClick={onClick} disabled={disabled} type="button"
      style={{
        minHeight: '44px', padding: '0.75rem 1.25rem', borderRadius: '999px',
        border: `2px solid ${p.accent}`, background: p.accent, color: p.accentInk,
        fontWeight: 800, fontSize: '0.92rem', fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer',
        textTransform: 'inherit',
        ...style,
      }}>
      {children}
    </button>
  )
}

function ModeButton({ p, icon, label, sub, onClick }: {
  p: Palette; icon: ReactNode; label: string; sub: string; onClick: () => void
}) {
  return (
    <button onClick={onClick} type="button" style={{
      display: 'flex', alignItems: 'center', gap: '0.85rem', textAlign: 'left',
      padding: '0.85rem 1rem', minHeight: '44px',
      background: p.field, border: `1.5px solid ${p.line}`, borderRadius: '0.95rem',
      color: p.ink, cursor: 'pointer', width: '100%', fontFamily: 'inherit', textTransform: 'inherit',
    }}>
      <span aria-hidden="true" style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        width: '2.25rem', height: '2.25rem', borderRadius: '50%',
        background: p.selected, color: p.selectedInk,
      }}>
        <Icon>{icon}</Icon>
      </span>
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: '0.92rem', fontWeight: 700 }}>{label}</span>
        <span style={{ display: 'block', fontSize: '0.72rem', color: p.mute, marginTop: '0.1rem' }}>{sub}</span>
      </span>
      <span aria-hidden="true" style={{ color: p.mute }}>
        <Icon size={18}><path d="M9 6l6 6-6 6" /></Icon>
      </span>
    </button>
  )
}

function SubmitRow({ p, onBack, canSubmit, submit, submitting }: {
  p: Palette; onBack: () => void; canSubmit: boolean; submit: () => void; submitting: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button onClick={onBack} type="button"
        style={{
          flex: '0 0 auto', padding: '0.7rem 1rem', minHeight: '44px', borderRadius: '999px',
          border: `1.5px solid ${p.line}`, background: 'transparent', color: p.ink,
          fontWeight: 600, fontSize: '0.85rem', fontFamily: 'inherit', cursor: 'pointer', textTransform: 'inherit',
        }}>
        Back
      </button>
      <PrimaryButton p={p} onClick={submit} disabled={!canSubmit || submitting}
        style={{ flex: 1, opacity: !canSubmit || submitting ? 0.5 : 1 }}>
        {submitting ? 'Sending…' : 'Send'}
      </PrimaryButton>
    </div>
  )
}
