'use client'

// Global feedback widget. Floating bottom-right button that opens a sheet
// with three modes:
//   1. NPS — "How likely to recommend?" 0..10 grid
//   2. CSAT — "How was your most recent experience?" 1..5 emoji
//   3. Open — "Got an idea?" freeform comment
//
// Submits to POST /api/v1/feedback. Anonymous submissions are allowed; the
// auth token is included if available (so feedback links to the customer).
//
// Local-storage gate: if a user submits within the last 14 days, we hide
// the widget so we're not nagging — they can re-open it via /account.

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const COOLDOWN_DAYS = 14
const STORAGE_KEY = 'servd-feedback-cooldown'

const ROUTES_HIDDEN_ON = ['/login', '/signup', '/auth', '/reserve/claim', '/orders/[id]/review']

export function FeedbackWidget() {
  const pathname = usePathname() ?? ''
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

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Send feedback"
          style={{
            position: 'fixed', right: '1rem', bottom: '1rem', zIndex: 50,
            background: '#000', color: '#fff', border: 'none',
            borderRadius: '999px', padding: '0.85rem 1.25rem',
            fontSize: '0.85rem', fontWeight: 700,
            boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            display: 'flex', alignItems: 'center', gap: '0.4rem',
            cursor: 'pointer',
          }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          Feedback
        </button>
      )}

      {open && (
        <div
          onClick={reset}
          style={{
            position: 'fixed', inset: 0, zIndex: 60, display: 'flex',
            alignItems: 'flex-end', justifyContent: 'center',
            background: 'rgba(0,0,0,0.4)',
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff', width: '100%', maxWidth: '32rem',
              borderRadius: '1.5rem 1.5rem 0 0', padding: '1.5rem 1.5rem 2rem',
              boxShadow: '0 -8px 32px rgba(0,0,0,0.18)',
            }}>
            {/* Drag handle */}
            <div style={{
              width: '3rem', height: '0.25rem', borderRadius: '999px',
              background: '#e5e7eb', margin: '0 auto 1.25rem',
            }} />

            {done ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🙏</div>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.5rem' }}>Thanks for telling us.</h3>
                <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
                  Every word lands somewhere real. We&rsquo;ll do better.
                </p>
                <button onClick={reset} className="servd-btn-primary" style={{ minWidth: '10rem' }}>Done</button>
              </div>
            ) : mode === 'menu' ? (
              <>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.25rem' }}>Tell us anything.</h3>
                <p style={{ color: 'var(--servd-mute)', marginBottom: '1.25rem', fontSize: '0.85rem' }}>
                  Quick honest feedback &mdash; we read every word.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <ModeButton emoji="🌟" label="Would you recommend us?" sub="30 sec · NPS" onClick={() => setMode('nps')} />
                  <ModeButton emoji="😊" label="How was your experience?"  sub="10 sec · CSAT" onClick={() => setMode('csat')} />
                  <ModeButton emoji="💡" label="Got an idea?"              sub="freeform"      onClick={() => setMode('open')} />
                </div>
              </>
            ) : mode === 'nps' ? (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '1rem' }}>
                  How likely are you to recommend servd to a friend?
                </h3>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: '0.25rem',
                  marginBottom: '0.5rem',
                }}>
                  {Array.from({ length: 11 }, (_, n) => (
                    <button key={n} onClick={() => setScore(n)} type="button"
                      style={{
                        aspectRatio: '1', minWidth: 0,
                        border: `1.5px solid ${score === n ? '#000' : 'var(--servd-line)'}`,
                        background: score === n ? '#000' : '#fff',
                        color: score === n ? '#fff' : '#374151',
                        borderRadius: '0.5rem', fontWeight: 700, cursor: 'pointer',
                        fontSize: 'clamp(0.7rem, 2vw, 0.85rem)',
                      }}>
                      {n}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--servd-mute)', marginBottom: '1rem' }}>
                  <span>Not at all</span>
                  <span>Very likely</span>
                </div>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000}
                  placeholder={score != null && score <= 6 ? 'What would have made it a 9 or 10?' : 'Tell us why (optional)'}
                  style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--servd-line)', borderRadius: '0.5rem', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical', marginBottom: '1rem' }} />
                <SubmitRow onBack={() => setMode('menu')} canSubmit={score != null} submit={submit} submitting={submitting} />
              </>
            ) : mode === 'csat' ? (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '1rem' }}>How was your most recent experience?</h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                  {[
                    { n: 1, emoji: '😡', label: 'Bad' },
                    { n: 2, emoji: '🙁', label: 'Meh' },
                    { n: 3, emoji: '😐', label: 'OK'  },
                    { n: 4, emoji: '🙂', label: 'Good' },
                    { n: 5, emoji: '😍', label: 'Loved it' },
                  ].map((o) => (
                    <button key={o.n} onClick={() => setScore(o.n)} type="button"
                      style={{
                        padding: '0.85rem 0.5rem',
                        border: `1.5px solid ${score === o.n ? '#000' : 'var(--servd-line)'}`,
                        background: score === o.n ? '#fef3c7' : '#fff',
                        borderRadius: '0.75rem', textAlign: 'center', cursor: 'pointer',
                      }}>
                      <div style={{ fontSize: '1.5rem' }}>{o.emoji}</div>
                      <div style={{ fontSize: '0.7rem', fontWeight: 600, marginTop: '0.25rem', color: '#374151' }}>{o.label}</div>
                    </button>
                  ))}
                </div>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000}
                  placeholder="Anything we should know? (optional)"
                  style={{ width: '100%', padding: '0.6rem', border: '1px solid var(--servd-line)', borderRadius: '0.5rem', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical', marginBottom: '1rem' }} />
                <SubmitRow onBack={() => setMode('menu')} canSubmit={score != null} submit={submit} submitting={submitting} />
              </>
            ) : (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '0.25rem' }}>What&rsquo;s on your mind?</h3>
                <p style={{ color: 'var(--servd-mute)', marginBottom: '1rem', fontSize: '0.8rem' }}>
                  An idea, a complaint, a wish — anything. Anonymous if you want.
                </p>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={5} maxLength={2000}
                  placeholder="Type away…"
                  style={{ width: '100%', padding: '0.75rem', border: '1px solid var(--servd-line)', borderRadius: '0.5rem', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical', marginBottom: '1rem' }} />
                <SubmitRow onBack={() => setMode('menu')} canSubmit={comment.trim().length > 0} submit={submit} submitting={submitting} />
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function ModeButton({ emoji, label, sub, onClick }: { emoji: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} type="button" style={{
      display: 'flex', alignItems: 'center', gap: '0.85rem', textAlign: 'left',
      padding: '0.85rem 1rem',
      background: '#f9fafb', border: '1px solid var(--servd-line)', borderRadius: '0.85rem',
      cursor: 'pointer', width: '100%',
    }}>
      <span style={{ fontSize: '1.5rem' }}>{emoji}</span>
      <span style={{ flex: 1 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#111827' }}>{label}</div>
        <div style={{ fontSize: '0.7rem', color: 'var(--servd-mute)', marginTop: '0.1rem' }}>{sub}</div>
      </span>
      <span style={{ color: 'var(--servd-mute)' }}>→</span>
    </button>
  )
}

function SubmitRow({ onBack, canSubmit, submit, submitting }: {
  onBack: () => void; canSubmit: boolean; submit: () => void; submitting: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button onClick={onBack} type="button"
        style={{
          flex: '0 0 auto', padding: '0.7rem 1rem', borderRadius: '0.6rem',
          border: '1px solid var(--servd-line)', background: '#fff', color: '#374151',
          fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
        }}>
        Back
      </button>
      <button onClick={submit} disabled={!canSubmit || submitting} type="button"
        className="servd-btn-primary"
        style={{ flex: 1, opacity: !canSubmit || submitting ? 0.5 : 1 }}>
        {submitting ? 'Sending…' : 'Send'}
      </button>
    </div>
  )
}
