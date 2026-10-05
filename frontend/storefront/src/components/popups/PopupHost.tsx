'use client'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import type { LivePopup, PopupRules, SiteLayoutRead } from '../../lib/blocks'
import { fetchLivePopups, fontFaceCss, trackLayout } from '../../lib/blocks'
import { useCustomerAuth } from '../../store/customerAuth'
import { PopupBlocks } from './PopupBlocks'

// Storefront pop-ups (SiteLayout kind 'popup'), mounted once in the root
// layout. Fetches the live pop-ups, evaluates each one's PopupRules against the
// current path / brand / visitor, arms its trigger, and shows at most ONE at a
// time. Views and conversions (first click on a link/button, or a form submit)
// are tracked like pages, always as variant 'a'.

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? ''

// First path segments that are servd routes, not a brand's /<concept>/… pages.
const RESERVED = new Set([
  'account', 'auth', 'brand', 'brands', 'browse', 'group-order', 'locations', 'login', 'order',
  'orders', 'press', 'reserve', 'signup', 'pages', 'preview', 'checkout', 'api',
])

type OrderState = 'unknown' | 'loading' | 'none' | 'some' | 'error'

function brandFromPath(pathname: string): string | null {
  const seg = pathname.split('/').filter(Boolean)
  if (seg[0] === 'brand') return seg[1] ?? null
  if (seg[0] && !RESERVED.has(seg[0])) return seg[0]
  return null
}

function matchesPattern(path: string, pattern: string): boolean {
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p)
  const pat = pattern.trim()
  if (!pat) return false
  if (pat.endsWith('*')) return path.startsWith(pat.slice(0, -1))
  return norm(path) === norm(pat)
}

const storeKey = (p: LivePopup) => `sv_popup:${p.slug}:${p.version}`

function isDue(p: LivePopup): boolean {
  try {
    const key = storeKey(p)
    if (p.rules.frequency === 'every_visit') return !window.sessionStorage.getItem(key)
    const last = Number(window.localStorage.getItem(key) ?? 0)
    if (!last) return true
    if (p.rules.frequency === 'once') return false
    return Date.now() - last > 24 * 60 * 60 * 1000 // daily
  } catch {
    return true
  }
}

function stampShown(p: LivePopup) {
  try {
    const key = storeKey(p)
    if (p.rules.frequency === 'every_visit') window.sessionStorage.setItem(key, '1')
    else window.localStorage.setItem(key, String(Date.now()))
  } catch { /* storage blocked: frequency falls back to per-load */ }
}

export function PopupHost({ initialBrandSlug }: { initialBrandSlug?: string | null }) {
  const pathname = usePathname() ?? '/'
  const token = useCustomerAuth((s) => s.token)
  const [popups, setPopups] = useState<LivePopup[] | null>(null)
  const [active, setActive] = useState<LivePopup | null>(null)
  const [orders, setOrders] = useState<OrderState>('unknown')
  const activeRef = useRef<LivePopup | null>(null)

  useEffect(() => {
    let alive = true
    void fetchLivePopups(API_URL).then((list) => { if (alive) setPopups(list) })
    return () => { alive = false }
  }, [])

  // never_ordered needs the customer's order count — only fetched when a live
  // pop-up actually targets that audience.
  useEffect(() => {
    if (!token) { setOrders('unknown'); return }
    if (!popups?.some((p) => p.rules.audience === 'never_ordered')) return
    let alive = true
    setOrders('loading')
    fetch(`${API_URL}/api/v1/storefront/account`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: { orders?: unknown[] }) => {
        if (alive) setOrders(Array.isArray(body.orders) && body.orders.length > 0 ? 'some' : 'none')
      })
      .catch(() => { if (alive) setOrders('error') })
    return () => { alive = false }
  }, [token, popups])

  const close = useCallback(() => { activeRef.current = null; setActive(null) }, [])

  useEffect(() => {
    if (!popups || popups.length === 0 || pathname.startsWith('/preview')) {
      if (activeRef.current) close()
      return
    }
    const brand = initialBrandSlug ?? brandFromPath(pathname)
    const paths = [pathname]
    if (initialBrandSlug) paths.push(`/brand/${initialBrandSlug}${pathname === '/' ? '' : pathname}`)
    const now = Date.now()

    const targets = (r: PopupRules): boolean => {
      if (r.startsAt && Date.parse(r.startsAt) > now) return false
      if (r.endsAt && Date.parse(r.endsAt) < now) return false
      const pages = Array.isArray(r.pages) ? r.pages : []
      if (pages.length > 0 && !pages.some((pat) => paths.some((p) => matchesPattern(p, pat)))) return false
      const brands = Array.isArray(r.brands) ? r.brands : []
      if (brands.length > 0 && (!brand || !brands.includes(brand))) return false
      switch (r.audience) {
        case 'signed_out':    return !token
        case 'signed_in':     return !!token
        // Unknown order history (lookup failed) → treated as signed_in.
        case 'never_ordered': return !!token && (orders === 'none' || orders === 'error')
        default:              return true
      }
    }

    // Navigated somewhere the open pop-up doesn't target → close it.
    if (activeRef.current && !targets(activeRef.current.rules)) close()

    const show = (p: LivePopup) => {
      if (activeRef.current || !isDue(p)) return
      activeRef.current = p
      stampShown(p)
      setActive(p)
    }

    const cleanups: Array<() => void> = []
    const finePointer = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false
    for (const p of popups) {
      const r = p.rules
      if (!targets(r) || !isDue(p)) continue
      switch (r.trigger) {
        case 'before_page':
          show(p)
          break
        case 'after_seconds': {
          const t = window.setTimeout(() => show(p), Math.max(0, r.delaySeconds ?? 5) * 1000)
          cleanups.push(() => window.clearTimeout(t))
          break
        }
        case 'exit_intent': {
          if (!finePointer) break // no mouse to leave on touch screens
          const onOut = (e: MouseEvent) => { if (!e.relatedTarget && e.clientY <= 0) show(p) }
          document.addEventListener('mouseout', onOut)
          cleanups.push(() => document.removeEventListener('mouseout', onOut))
          break
        }
        case 'scroll': {
          const target = Math.min(100, Math.max(0, r.scrollPct ?? 50))
          const onScroll = () => {
            const max = document.documentElement.scrollHeight - window.innerHeight
            const pct = max > 0 ? (window.scrollY / max) * 100 : 100
            if (pct >= target) show(p)
          }
          window.addEventListener('scroll', onScroll, { passive: true })
          cleanups.push(() => window.removeEventListener('scroll', onScroll))
          break
        }
      }
    }
    return () => cleanups.forEach((fn) => fn())
  }, [popups, pathname, token, orders, initialBrandSlug, close])

  if (!active) return null
  return <PopupFrame key={`${active.slug}:${active.version}`} popup={active} onClose={close} track />
}

/** One pop-up in its display (modal / bar / corner). */
function PopupFrame({ popup, onClose, track }: { popup: LivePopup; onClose: () => void; track: boolean }) {
  const display = popup.rules.display ?? 'modal'
  const converted = useRef(false)
  const viewed = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!track || viewed.current) return
    viewed.current = true
    trackLayout(API_URL, popup.slug, popup.version, 'a', 'view')
  }, [popup, track])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    let restore: string | null = null
    if (display === 'modal') {
      restore = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      cardRef.current?.focus()
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      if (restore !== null) document.body.style.overflow = restore
    }
  }, [display, onClose])

  const convert = () => {
    if (!track || converted.current) return
    converted.current = true
    trackLayout(API_URL, popup.slug, popup.version, 'a', 'convert')
  }
  const onClickCapture = (e: React.MouseEvent) => {
    const t = e.target as Element | null
    if (!t?.closest?.('a, button') || t.closest('[data-sv-close]')) return
    convert()
  }

  const faces = fontFaceCss(popup.fonts ?? [])
  const blocks = Array.isArray(popup.blocks) ? popup.blocks : []
  const label = popup.title ?? 'Announcement'
  const common = { onClickCapture, onSubmitCapture: convert }
  const fontStyle = faces ? <style dangerouslySetInnerHTML={{ __html: faces }} /> : null

  if (display === 'bar') {
    return (
      <div role="region" aria-label={label} className="sv-popup" {...common}
        style={{ position: 'relative', background: 'var(--servd-purple)', color: 'var(--servd-on-purple)', paddingRight: '3rem' }}>
        {fontStyle}
        <PopupBlocks blocks={blocks} compact />
        <CloseButton onClose={onClose} light style={{ position: 'absolute', top: '50%', right: '0.5rem', transform: 'translateY(-50%)' }} />
      </div>
    )
  }

  if (display === 'corner') {
    return (
      <div role="dialog" aria-label={label} className="sv-popup sv-popup-card" {...common}
        style={{
          position: 'fixed', zIndex: 1000, right: 'max(1rem, env(safe-area-inset-right))', bottom: 'max(1rem, env(safe-area-inset-bottom))',
          width: 'min(calc(100vw - 2rem), 22rem)', maxHeight: '70dvh', overflowY: 'auto',
          background: '#fff', color: 'var(--servd-ink)', borderRadius: '1.25rem',
          boxShadow: '0 18px 50px rgba(0,0,0,0.22)', padding: '1.25rem 1rem 1rem',
        }}>
        {fontStyle}
        <CloseButton onClose={onClose} style={{ position: 'absolute', top: '0.35rem', right: '0.35rem' }} />
        <PopupBlocks blocks={blocks} />
      </div>
    )
  }

  return (
    <div className="sv-popup-backdrop" onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(10,10,10,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
      }}>
      <div ref={cardRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={label}
        className="sv-popup sv-popup-card" {...common}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative', width: 'min(100%, 34rem)', maxHeight: '90dvh', overflowY: 'auto',
          background: '#fff', color: 'var(--servd-ink)', borderRadius: '1.5rem',
          boxShadow: '0 30px 80px rgba(0,0,0,0.35)', padding: '2.25rem 1.25rem 1.5rem', outline: 'none',
        }}>
        {fontStyle}
        <CloseButton onClose={onClose} style={{ position: 'absolute', top: '0.5rem', right: '0.5rem' }} />
        <PopupBlocks blocks={blocks} />
      </div>
    </div>
  )
}

function CloseButton({ onClose, light, style }: { onClose: () => void; light?: boolean; style?: React.CSSProperties }) {
  return (
    <button type="button" data-sv-close onClick={onClose} aria-label="Close"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 44, height: 44, borderRadius: 999, border: 'none', cursor: 'pointer',
        background: 'transparent', color: light ? '#fff' : 'var(--servd-ink)', zIndex: 2, ...style,
      }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    </button>
  )
}

const PREVIEW_RULES: PopupRules = {
  popupKind: 'announcement', display: 'modal', trigger: 'before_page',
  pages: [], brands: [], audience: 'everyone', frequency: 'every_visit',
}

/** /preview for a pop-up draft: shows it in its display, no rules, no stats. */
export function PopupPreview({ layout }: { layout: SiteLayoutRead }) {
  const [open, setOpen] = useState(true)
  const popup: LivePopup = {
    slug: layout.slug, version: layout.version, title: layout.title,
    blocks: layout.blocks ?? [], rules: layout.settings?.popup ?? PREVIEW_RULES, fonts: layout.fonts,
  }
  const reopen: ReactNode = (
    <div className="container" style={{ padding: '4rem 1.25rem', textAlign: 'center', color: 'var(--servd-mute)' }}>
      <p style={{ marginBottom: '1rem' }}>
        Display: {popup.rules.display} · trigger: {popup.rules.trigger.replace('_', ' ')}
      </p>
      {!open && (
        <button type="button" onClick={() => setOpen(true)}
          style={{ padding: '0.7rem 1.4rem', borderRadius: 999, border: 'none', background: 'var(--servd-green)', color: 'var(--servd-on-green)', fontWeight: 800, cursor: 'pointer' }}>
          Show pop-up again
        </button>
      )}
    </div>
  )
  return (
    <>
      {open && <PopupFrame popup={popup} onClose={() => setOpen(false)} track={false} />}
      {reopen}
    </>
  )
}
