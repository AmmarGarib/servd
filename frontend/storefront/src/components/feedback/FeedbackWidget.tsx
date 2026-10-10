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
//
// The trigger must never sit on top of the page's own actions. It is a 44px
// icon button on phones (the labelled pill from 640px — styles are
// `.sv-feedback` in globals.css), it is not shown at all on the form and
// ordering screens (ROUTES_HIDDEN_ON), and it steps aside while a form field
// has focus or any footer is on screen — the brand footers' "back to servd."
// link and form submit buttons sit exactly where it floats.

import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const COOLDOWN_DAYS = 14
const STORAGE_KEY = 'servd-feedback-cooldown'

// Each entry hides the widget on that route and everything under it. The
// waitlist / reservation forms and the brand ordering screens (/stackd,
// /simmer, /flipd — menu, checkout, order tracking) carry their own primary
// action at the bottom of the screen.
const ROUTES_HIDDEN_ON = [
  '/login', '/signup', '/auth', '/waitlist', '/reserve',
  '/stackd', '/simmer', '/flipd',
  '/orders/[id]/review',
]
// '[id]' matches one path segment; a route matches itself or any sub-path.
const HIDDEN_ROUTE_PATTERNS = ROUTES_HIDDEN_ON.map(
  (r) => new RegExp(`^${r.replace(/\[[^\]]+\]/g, '[^/]+')}(?:/|$)`),
)

function hiddenOnRoute(pathname: string): boolean {
  return HIDDEN_ROUTE_PATTERNS.some((re) => re.test(pathname))
}

// Inputs that are buttons/toggles rather than somewhere to type.
const NON_TEXT_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'])

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type)
  return el.isContentEditable
}

/** True while a text field / textarea / select has focus. */
function useTyping(enabled: boolean): boolean {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    if (!enabled) return
    setTyping(isTypingTarget(document.activeElement))
    const onFocusIn = (e: FocusEvent) => setTyping(isTypingTarget(e.target))
    // relatedTarget is where focus is going (null when it leaves the page).
    const onFocusOut = (e: FocusEvent) => setTyping(isTypingTarget(e.relatedTarget))
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [enabled])
  return typing
}

/** Whether any page footer is in the viewport: null until that is known.
 *  Footers mount and unmount with client navigation (servd's, a brand's), so
 *  the set is re-scanned whenever the DOM gains or loses nodes.
 *
 *  The answer only comes from the observer's first callback, a frame after
 *  mount, so it starts as null ("not known yet", which the caller treats as
 *  concealed) rather than false — otherwise the button painted at full
 *  opacity on a page whose footer was already on screen (a short page, a 404,
 *  a reload restored to the bottom) and then faded out. It goes back to null
 *  while the hook is off (the sheet open) for the same reason on close. */
function useFooterInView(enabled: boolean): boolean | null {
  const [inView, setInView] = useState<boolean | null>(null)
  useEffect(() => {
    if (!enabled) { setInView(null); return }
    if (typeof IntersectionObserver === 'undefined') { setInView(false); return }
    const observed = new Set<Element>()
    const visible = new Set<Element>()
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target)
        else visible.delete(entry.target)
      }
      setInView(visible.size > 0)
    })
    const scan = () => {
      const current = new Set(document.querySelectorAll('footer, [role="contentinfo"]'))
      let removed = false
      let added = false
      observed.forEach((el) => {
        if (!current.has(el)) { io.unobserve(el); observed.delete(el); visible.delete(el); removed = true }
      })
      current.forEach((el) => {
        if (!observed.has(el)) { io.observe(el); observed.add(el); added = true }
      })
      // No footer on the page: nothing will ever report, so it is not in view.
      if (observed.size === 0) setInView(false)
      // A newly observed footer reports in the observer's first callback (with
      // the whole visible set), so wait for that; a removal alone is final now.
      else if (removed && !added) setInView(visible.size > 0)
    }
    scan()
    let frame = 0
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(scan)
    })
    mo.observe(document.body, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      mo.disconnect()
      io.disconnect()
    }
  }, [enabled])
  return inView
}

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
    let cooldown: string | null = null
    try { cooldown = localStorage.getItem(STORAGE_KEY) } catch { /* storage blocked */ }
    if (cooldown && parseInt(cooldown, 10) > Date.now()) {
      setHidden(true)
      return
    }
    if (hiddenOnRoute(pathname)) {
      setHidden(true)
      return
    }
    setHidden(false)
  }, [pathname])

  const watching = !hidden && !open
  const typing = useTyping(watching)
  const footerInView = useFooterInView(watching)

  if (hidden) return null

  // Out of the way, but still mounted so it can fade back in. Two ways:
  //  - 'typing': a form field has focus. visibility:hidden (in the CSS), so it
  //    is out of the tab order and the accessibility tree too.
  //  - 'footer': a footer is on screen (or that is not known yet). Only faded
  //    and click-through, still focusable and still announced: the button sits
  //    after the footer in the DOM, and focus on a footer link scrolls the
  //    footer into view, so visibility:hidden here would drop it from the tab
  //    order exactly when it is next. It shows again while it has focus.
  const concealed = typing ? 'typing' : footerInView !== false ? 'footer' : undefined

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
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Feedback"
          className="sv-feedback"
          data-concealed={concealed}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          <span className="sv-feedback-label">Feedback</span>
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
