'use client'

// servd.feedback — the floating feedback button and its sheet (SiteLayout
// `servd:feedback`, Admin → Storefront → Feedback button). app/layout.tsx
// renders it on every page through components/feedback/FeedbackSlot.tsx.
// Three modes:
//   1. NPS — "How likely to recommend?" 0..10 grid
//   2. CSAT — "How was your most recent experience?" five ratings, worst to best
//   3. Open — "Got an idea?" freeform comment
//
// Every word is a field. No emoji (owner, 2026-10-10: "Make sections right
// now with words and I'll have marketing design icons for us to use"): each
// place that had one has an optional image field, shown beside its word when
// set; empty = the word alone. The images are decorative (alt="") because the
// word is always there.
//
// Submits to POST /api/v1/feedback. Anonymous submissions are allowed; the
// auth token is included if available (so feedback links to the customer).
// The CSAT score is the rating's position (1–5) — the API requires 1–5 — so
// a ratings list cut short is padded from the defaults.
//
// Local-storage gate: if a user submits within the last `cooldownDays` days
// (default 14), we hide the widget so we're not nagging — they can re-open it
// via /account.
//
// The trigger must never sit on top of the page's own actions. It is a 44px
// icon button on phones (the labelled pill from 640px — styles are
// `.sv-feedback` in globals.css), it is not shown at all on the form and
// ordering screens (ROUTES_HIDDEN_ON), and it steps aside while a form field
// has focus or any footer is on screen — the brand footers' "back to servd."
// link and form submit buttons sit exactly where it floats.
//
// On /preview (the draft of this section, opened from the editor) it always
// shows, the footer does not push it aside, and Send goes straight to the
// thank-you screen: nothing is posted and no cooldown is stored.

import { useState, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'
import type { SectionProps } from '../types'
import { list, safeSrc, str } from '../safe'
import { FEEDBACK_DEFAULTS } from './feedbackDefaults'
import { isEditorFramePath } from '../../lib/editorFrame'
import { useDialog } from '../../lib/useDialog'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'
const STORAGE_KEY = 'servd-feedback-cooldown'

type Mode = 'nps' | 'csat' | 'open'
const MODES: readonly Mode[] = ['nps', 'csat', 'open']
const isMode = (v: unknown): v is Mode => MODES.includes(v as Mode)

// Each entry hides the widget on that route and everything under it. The
// waitlist / reservation forms and the brand ordering screens (/stackd,
// /simmer, /flipd — menu, checkout, order tracking) carry their own primary
// action at the bottom of the screen.
const ROUTES_HIDDEN_ON = [
  '/login', '/signup', '/auth', '/waitlist', '/reserve',
  '/stackd', '/simmer', '/flipd',
  '/orders/[id]/review',
  '/rider',
]
// '[id]' matches one path segment; a route matches itself or any sub-path.
const HIDDEN_ROUTE_PATTERNS = ROUTES_HIDDEN_ON.map(
  (r) => new RegExp(`^${r.replace(/\[[^\]]+\]/g, '[^/]+')}(?:/|$)`),
)

function hiddenOnRoute(pathname: string): boolean {
  return HIDDEN_ROUTE_PATTERNS.some((re) => re.test(pathname))
}

// The editor frame (Admin → Storefront's live page) counts as a preview: the
// button always shows there and never posts.
const isPreviewPath = (pathname: string) =>
  pathname === '/preview' || pathname.startsWith('/preview/') || isEditorFramePath(pathname)

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

// ─── Fields ────────────────────────────────────────────────────────────────

/** A label that must not be blank (a button or heading with no name): the
 *  field, else today's copy. */
function required(v: unknown, fallback: string): string {
  return str(v).trim() || fallback
}

interface ModeItem { mode: Mode; label: string; sub: string; icon: string }

/** The menu's choices: known kinds only, each once, in the editor's order.
 *  None usable (all removed, or none given a kind yet) = the defaults. */
function modeItems(v: unknown): ModeItem[] {
  const seen = new Set<Mode>()
  const out: ModeItem[] = []
  for (const it of list<{ mode?: unknown; label?: unknown; sub?: unknown; icon?: unknown }>(v)) {
    if (!isMode(it.mode) || seen.has(it.mode)) continue
    seen.add(it.mode)
    const d = FEEDBACK_DEFAULTS.modes.find((m) => m.mode === it.mode)!
    out.push({ mode: it.mode, label: required(it.label, d.label), sub: str(it.sub), icon: safeSrc(it.icon) })
  }
  return out.length
    ? out
    : FEEDBACK_DEFAULTS.modes.map((m) => ({ mode: m.mode as Mode, label: m.label, sub: m.sub, icon: '' }))
}

interface Rating { n: number; label: string; icon: string }

/** Always five, worst to best: the score is the position. A shorter list is
 *  padded from the defaults; anything past five is ignored. */
function ratingItems(v: unknown): Rating[] {
  const given = list<{ label?: unknown; icon?: unknown }>(v)
  return FEEDBACK_DEFAULTS.csatRatings.map((d, i) => ({
    n: i + 1,
    label: required(given[i]?.label, d.label),
    icon: safeSrc(given[i]?.icon),
  }))
}

function cooldownDaysOf(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? Math.min(365, n) : FEEDBACK_DEFAULTS.cooldownDays
}

// ─── Widget ────────────────────────────────────────────────────────────────

export function Feedback({ fields }: SectionProps) {
  const D = FEEDBACK_DEFAULTS
  const triggerLabel = required(fields.triggerLabel, D.triggerLabel)
  const triggerName = str(fields.triggerAriaLabel).trim() || triggerLabel
  const modes = modeItems(fields.modes)
  const ratings = ratingItems(fields.csatRatings)
  const doneIcon = safeSrc(fields.doneIcon)
  const menuSub = str(fields.menuSub)
  const npsLow = str(fields.npsLow)
  const npsHigh = str(fields.npsHigh)
  const openSub = str(fields.openSub)
  const doneBody = str(fields.doneBody)
  const labels = {
    back: required(fields.backLabel, D.backLabel),
    send: required(fields.sendLabel, D.sendLabel),
    sending: required(fields.sendingLabel, D.sendingLabel),
  }
  const cooldownDays = cooldownDaysOf(fields.cooldownDays)

  const pathname = usePathname() ?? ''
  const previewing = isPreviewPath(pathname)
  const [open, setOpen]     = useState(false)
  const [mode, setMode]     = useState<Mode | 'menu'>('menu')
  const [score, setScore]   = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone]     = useState(false)
  const [hidden, setHidden] = useState(true)  // SSR-safe — render nothing until client mount
  const [sendError, setSendError] = useState('')
  const sheetRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const reset = () => {
    setOpen(false); setMode('menu'); setScore(null); setComment(''); setDone(false); setSendError('')
  }
  // Escape, focus in / trap / restore to the trigger, no scroll behind.
  useDialog({ open: open && !hidden, ref: sheetRef, onClose: reset, restoreTo: () => triggerRef.current })

  useEffect(() => {
    if (isPreviewPath(pathname)) {
      setHidden(false)
      return
    }
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
  const footerInView = useFooterInView(watching && !previewing)

  if (hidden) return null

  // Out of the way, but still mounted so it can fade back in. Two ways:
  //  - 'typing': a form field has focus. visibility:hidden (in the CSS), so it
  //    is out of the tab order and the accessibility tree too.
  //  - 'footer': a footer is on screen (or that is not known yet). Only faded
  //    and click-through, still focusable and still announced: the button sits
  //    after the footer in the DOM, and focus on a footer link scrolls the
  //    footer into view, so visibility:hidden here would drop it from the tab
  //    order exactly when it is next. It shows again while it has focus.
  //    Never on /preview, where the short preview page always has the footer
  //    on screen and the button is the thing being reviewed.
  const concealed = typing ? 'typing' : !previewing && footerInView !== false ? 'footer' : undefined

  async function submit() {
    if (mode === 'menu') return
    if (previewing) { setDone(true); return }
    setSubmitting(true)
    setSendError('')
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
        // Hide widget for cooldownDays so we don't keep prompting.
        try { localStorage.setItem(STORAGE_KEY, String(Date.now() + cooldownDays * 86_400_000)) } catch { /* storage blocked */ }
      } else {
        setSendError('We could not send that. Please try again.')
      }
    } catch { setSendError('Could not reach servd. Check your connection and try again.') }
    finally { setSubmitting(false) }
  }

  // Back clears the score too: an NPS 9 carried into the 1–5 rating would be
  // sent as a rating the visitor never picked (or refused by the API).
  const back = () => { setMode('menu'); setScore(null); setSendError('') }
  const textareaStyle = { width: '100%', border: '1px solid var(--servd-line)', borderRadius: '0.5rem', fontSize: '0.9rem', fontFamily: 'inherit', resize: 'vertical', marginBottom: '1rem' } as const
  const placeholderOf = (v: unknown) => {
    const p = str(v)
    return p ? { placeholder: p } : {}
  }

  return (
    <>
      {/* Floating trigger */}
      {!open && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={triggerName}
          className="sv-feedback"
          data-concealed={concealed}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
          </svg>
          <span className="sv-feedback-label">{triggerLabel}</span>
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
            ref={sheetRef} role="dialog" aria-modal="true" aria-label={required(fields.menuTitle, D.menuTitle)} tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxHeight: '100dvh', overflowY: 'auto', overscrollBehavior: 'contain', outline: 'none',
              background: '#fff', width: '100%', maxWidth: '32rem',
              borderRadius: '1.5rem 1.5rem 0 0', padding: '1.5rem 1.5rem 2rem',
              border: 'var(--servd-hard-border)', borderBottom: 'none', boxShadow: '6px -6px 0 var(--servd-hard-ink)',
            }}>
            {/* Drag handle */}
            <div style={{
              width: '3rem', height: '0.25rem', borderRadius: '999px',
              background: '#e5e7eb', margin: '0 auto 1.25rem',
            }} />

            {done ? (
              <div style={{ textAlign: 'center', padding: '1rem 0' }}>
                {doneIcon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={doneIcon} alt="" width={40} height={40}
                    style={{ display: 'block', width: 40, height: 40, objectFit: 'contain', margin: '0 auto 0.5rem' }} />
                )}
                <h3 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: '0.5rem' }}>{required(fields.doneTitle, D.doneTitle)}</h3>
                {doneBody && (
                  <p style={{ color: 'var(--servd-mute)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>{doneBody}</p>
                )}
                <button onClick={reset} className="servd-btn-primary" style={{ minWidth: '10rem' }}>{required(fields.doneLabel, D.doneLabel)}</button>
              </div>
            ) : mode === 'menu' ? (
              <>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.25rem' }}>{required(fields.menuTitle, D.menuTitle)}</h3>
                {menuSub && (
                  <p style={{ color: 'var(--servd-mute)', marginBottom: '1.25rem', fontSize: '0.85rem' }}>{menuSub}</p>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {modes.map((m) => (
                    <ModeButton key={m.mode} icon={m.icon} label={m.label} sub={m.sub} onClick={() => setMode(m.mode)} />
                  ))}
                </div>
              </>
            ) : mode === 'nps' ? (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '1rem' }}>
                  {required(fields.npsQuestion, D.npsQuestion)}
                </h3>
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(11, 1fr)', gap: '0.25rem',
                  marginBottom: '0.5rem',
                }}>
                  {Array.from({ length: 11 }, (_, n) => (
                    <button key={n} onClick={() => setScore(n)} type="button" aria-pressed={score === n}
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
                {(npsLow || npsHigh) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--servd-mute)', marginBottom: '1rem' }}>
                    <span>{npsLow}</span>
                    <span>{npsHigh}</span>
                  </div>
                )}
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000} aria-label={required(fields.npsQuestion, D.npsQuestion)}
                  {...placeholderOf(score != null && score <= 6 ? fields.npsPlaceholderLow : fields.npsPlaceholder)}
                  style={{ ...textareaStyle, padding: '0.6rem' }} />
                <SubmitRow onBack={back} canSubmit={score != null} submit={submit} submitting={submitting} labels={labels} error={sendError} />
              </>
            ) : mode === 'csat' ? (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '1rem' }}>{required(fields.csatQuestion, D.csatQuestion)}</h3>
                {/* minmax(0, 1fr): five equal columns that never grow past the
                    sheet, so a long word wraps instead of pushing the row wide
                    (five fit on a 320px phone). */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: '0.375rem', marginBottom: '1rem' }}>
                  {ratings.map((o) => (
                    <button key={o.n} onClick={() => setScore(o.n)} type="button" aria-pressed={score === o.n}
                      style={{
                        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        minWidth: 0, minHeight: '3.5rem',
                        padding: o.icon ? '0.85rem 0.25rem' : '0.6rem 0.25rem',
                        border: `1.5px solid ${score === o.n ? '#000' : 'var(--servd-line)'}`,
                        background: score === o.n ? '#fef3c7' : '#fff',
                        borderRadius: '0.75rem', textAlign: 'center', cursor: 'pointer',
                      }}>
                      {o.icon && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={o.icon} alt="" width={32} height={32}
                          style={{ display: 'block', width: 32, height: 32, objectFit: 'contain' }} />
                      )}
                      <span style={{
                        display: 'block', maxWidth: '100%', color: '#374151', lineHeight: 1.15,
                        overflowWrap: 'anywhere', hyphens: 'auto',
                        ...(o.icon
                          ? { fontSize: '0.7rem', fontWeight: 600, marginTop: '0.25rem' }
                          : { fontSize: 'clamp(0.72rem, 3.2vw, 0.85rem)', fontWeight: 700 }),
                      }}>
                        {o.label}
                      </span>
                    </button>
                  ))}
                </div>
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={2} maxLength={1000} aria-label={required(fields.csatQuestion, D.csatQuestion)}
                  {...placeholderOf(fields.csatPlaceholder)}
                  style={{ ...textareaStyle, padding: '0.6rem' }} />
                <SubmitRow onBack={back} canSubmit={score != null} submit={submit} submitting={submitting} labels={labels} error={sendError} />
              </>
            ) : (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 800, marginBottom: '0.25rem' }}>{required(fields.openTitle, D.openTitle)}</h3>
                {openSub && (
                  <p style={{ color: 'var(--servd-mute)', marginBottom: '1rem', fontSize: '0.8rem' }}>{openSub}</p>
                )}
                <textarea
                  value={comment} onChange={(e) => setComment(e.target.value)}
                  rows={5} maxLength={2000} aria-label={required(fields.openTitle, D.openTitle)}
                  {...placeholderOf(fields.openPlaceholder)}
                  style={{ ...textareaStyle, padding: '0.75rem' }} />
                <SubmitRow onBack={back} canSubmit={comment.trim().length > 0} submit={submit} submitting={submitting} labels={labels} error={sendError} />
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function ModeButton({ icon, label, sub, onClick }: { icon: string; label: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} type="button" style={{
      display: 'flex', alignItems: 'center', gap: '0.85rem', textAlign: 'left',
      padding: '0.85rem 1rem',
      background: '#f9fafb', border: '1px solid var(--servd-line)', borderRadius: '0.85rem',
      cursor: 'pointer', width: '100%',
    }}>
      {icon && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={icon} alt="" width={28} height={28}
          style={{ display: 'block', width: 28, height: 28, objectFit: 'contain', flexShrink: 0 }} />
      )}
      <span style={{ flex: 1 }}>
        <span style={{ display: 'block', fontSize: '0.9rem', fontWeight: 700, color: '#111827' }}>{label}</span>
        {sub && <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--servd-mute)', marginTop: '0.1rem' }}>{sub}</span>}
      </span>
      <span aria-hidden="true" style={{ color: 'var(--servd-mute)' }}>→</span>
    </button>
  )
}

function SubmitRow({ onBack, canSubmit, submit, submitting, labels, error }: {
  onBack: () => void; canSubmit: boolean; submit: () => void; submitting: boolean
  labels: { back: string; send: string; sending: string }; error?: string
}) {
  return (
    <>
    {error && (
      <p role="alert" style={{ margin: '0 0 0.75rem', padding: '0.6rem 0.8rem', borderRadius: '0.6rem', background: '#fff1f1', color: 'var(--servd-danger)', fontSize: '0.85rem', fontWeight: 600 }}>
        {error} <button type="button" onClick={submit} disabled={submitting}
          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', fontWeight: 800, textDecoration: 'underline', cursor: 'pointer', color: 'inherit' }}>Retry</button>
      </p>
    )}
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button onClick={onBack} type="button"
        style={{
          flex: '0 0 auto', padding: '0.7rem 1rem', borderRadius: '0.6rem',
          border: '1px solid var(--servd-line)', background: '#fff', color: '#374151',
          fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
        }}>
        {labels.back}
      </button>
      <button onClick={submit} disabled={!canSubmit || submitting} type="button"
        className="servd-btn-primary"
        style={{ flex: 1, opacity: !canSubmit || submitting ? 0.5 : 1 }}>
        {submitting ? labels.sending : labels.send}
      </button>
    </div>
    </>
  )
}
