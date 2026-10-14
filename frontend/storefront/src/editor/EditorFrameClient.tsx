'use client'

// The editor frame's client: talks to Admin → Storefront over postMessage
// (./protocol.ts), asks the server action to render each posted working copy,
// commits the result in place, and draws the selection / hover outlines and
// the scroll-effect preview over the page. Protocol, origins and security:
// ./README.md.
//
// Commit model: one long-lived tree. Each render result replaces the page node
// inside a transition, so React reconciles it IN PLACE (same element types and
// keys) — sections keep their state, videos keep playing, the scroll position
// stays. Errors: a block that throws shows a placeholder (BlockMarker); a page
// that throws keeps showing the last good page with a slim banner, and the
// boundary resets on the next rev.

import {
  Component, Suspense, startTransition, useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react'
import {
  EDITOR_NS, EDITOR_PROTOCOL, MAX_DOC_CHARS, isAdminMessage, isForeignVersion,
  type FrameDoc, type FrameKit, type FrameRect, type FrameToAdmin, type FrameViewport,
} from './protocol'
import { RENDER_ERROR_TEXT, type FrameRenderInput, type FrameRenderResult } from './types'
import {
  isPlainObject, parseEditorSlug, popupContextSlug, sanitizeBlocks, sanitizeFonts, sanitizeSettings, utf8Bytes,
} from './sanitize'
import type { LivePopup, PopupRules } from '../lib/blocks'
import { MOTION_SPECS, normalizeMotion } from '../lib/motion'
import { clearScrub, scrollStackTo, setScrubProgress, supportsScrollTimeline } from '../components/blocks/motionClient'
import { PopupFrame } from '../components/popups/PopupHost'
import { Loader } from '../components/ui/Loader'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type Outgoing = DistributiveOmit<FrameToAdmin, 'ns' | 'v' | 'from'>

interface Props {
  render: (input: FrameRenderInput) => Promise<FrameRenderResult>
  allowedOrigins: string[]
}

interface View {
  rev: number
  t0: number
  /** The page (or the page behind a pop-up). */
  node: ReactNode
  popup: LivePopup | null
}

interface Preview { id: string; progress: number; shown: boolean }

/** Mutable messaging state (refs, not React state: none of it renders). */
interface Live {
  session: string | null
  parentOrigin: string | null
  latest: FrameDoc | null
  started: number
  inflight: boolean
  cooldownUntil: number
  retryTimer: number
  backdrop: { slug: string; node: ReactNode } | null
  labels: Record<string, string>
  selected: string | null
  hoverId: string | null
  hoverCtx: string | null
  adminHover: string | null
  pendingScroll: string | null
  preview: Preview | null
  lastGood: ReactNode
  hasGood: boolean
  view: View | null
}

const NOOP = () => {}
const RETRY_MS = 2000
const ANNOUNCE_EVERY_MS = 1000
const ANNOUNCE_MAX = 15
const SCROLL_KEYS = new Set(['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '])

const PREVIEW_RULES: PopupRules = {
  popupKind: 'announcement', display: 'modal', trigger: 'before_page',
  pages: [], brands: [], audience: 'everyone', frequency: 'every_visit',
}

const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ── Geometry ────────────────────────────────────────────────────────────────

function childWithClass(el: Element, cls: string): Element | null {
  return Array.from(el.children).find((c) => c.classList.contains(cls)) ?? null
}

function nonEmpty(r: DOMRect): DOMRect | null {
  return r.width > 0 || r.height > 0 ? r : null
}

function union(a: DOMRect | null, b: DOMRect | null): DOMRect | null {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.left, b.left), y = Math.min(a.top, b.top)
  return new DOMRect(x, y, Math.max(a.right, b.right) - x, Math.max(a.bottom, b.bottom) - y)
}

const isContents = (el: Element) => getComputedStyle(el).display === 'contents'

function unionOfChildren(el: Element): DOMRect | null {
  let u: DOMRect | null = null
  for (const c of Array.from(el.children)) {
    u = union(u, isContents(c) ? unionOfChildren(c) : nonEmpty(c.getBoundingClientRect()))
  }
  return u
}

/** The element a marker is measured / scrolled by (README: "rect of a marker"). */
function measuredElement(marker: Element): Element | null {
  if (!isContents(marker)) return marker
  const first = marker.firstElementChild
  if (first?.classList.contains('sv-motion')) {
    return childWithClass(first, 'sv-motion-pin') ?? childWithClass(first, 'sv-motion-target') ?? first
  }
  const firstBoxed = (el: Element): Element | null => {
    for (const c of Array.from(el.children)) {
      if (!isContents(c)) { if (nonEmpty(c.getBoundingClientRect())) return c }
      else { const inner = firstBoxed(c); if (inner) return inner }
    }
    return null
  }
  return firstBoxed(marker)
}

function markerRect(marker: Element): DOMRect | null {
  if (!isContents(marker)) return nonEmpty(marker.getBoundingClientRect())
  const first = marker.firstElementChild
  if (first?.classList.contains('sv-motion')) {
    const el = childWithClass(first, 'sv-motion-pin') ?? childWithClass(first, 'sv-motion-target') ?? first
    return nonEmpty(el.getBoundingClientRect())
  }
  return unionOfChildren(marker)
}

const toRect = (r: DOMRect | null): FrameRect | null =>
  r ? { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } : null

const viewport = (): FrameViewport => ({ w: window.innerWidth, h: window.innerHeight, scrollY: Math.round(window.scrollY) })

function contextLabel(slug: string): string {
  const what = slug === 'servd:header' || slug.endsWith(':header') ? 'top bar'
    : slug === 'servd:footer' || slug.endsWith(':footer') ? 'footer' : 'page'
  return `Live ${what} — click to edit it`
}

// ── Doc checks ──────────────────────────────────────────────────────────────

type DocCheck =
  | { ok: true; doc: FrameDoc }
  | { ok: false; rev: number | null; code: 'TOO_LARGE' | 'BAD_DOC' }

function checkDoc(d: unknown): DocCheck {
  if (!isPlainObject(d)) return { ok: false, rev: null, code: 'BAD_DOC' }
  const rev = d['rev']
  const revOk = typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0
  const goodRev = revOk ? rev : null
  let bytes = 0
  try { bytes = utf8Bytes(JSON.stringify(d)) } catch { return { ok: false, rev: goodRev, code: 'BAD_DOC' } }
  if (bytes > MAX_DOC_CHARS) return { ok: false, rev: goodRev, code: 'TOO_LARGE' }
  const parsed = parseEditorSlug(d['slug'])
  const title = d['title']
  const settings = d['settings']
  if (!revOk || !parsed || (d['variant'] !== 'a' && d['variant'] !== 'b') || !Array.isArray(d['blocks'])
    || (settings !== null && !isPlainObject(settings)) || !Array.isArray(d['fonts'])
    || (title !== null && typeof title !== 'string')) {
    return { ok: false, rev: goodRev, code: 'BAD_DOC' }
  }
  const labels: Record<string, string> = {}
  if (isPlainObject(d['labels'])) {
    for (const [k, v] of Object.entries(d['labels']).slice(0, 2000)) {
      if (validId(k) && typeof v === 'string') labels[k] = v.slice(0, 80)
    }
  }
  return {
    ok: true,
    doc: {
      rev, slug: d['slug'] as string, kind: parsed.kind, title: (title as string | null),
      variant: d['variant'], blocks: d['blocks'], settings: (settings as Record<string, unknown> | null),
      fonts: d['fonts'] as FrameDoc['fonts'], labels,
      // The brand kit editor's draft kit; the server action validates it.
      ...(isPlainObject(d['kit']) && { kit: d['kit'] as unknown as FrameKit }),
    },
  }
}

// ── Boundaries ──────────────────────────────────────────────────────────────

/** One long-lived boundary around the page. It clears its error when a new
 *  rev arrives (resetKeys pattern) — never keyed by rev, which would remount
 *  the whole page on every keystroke. */
class FrameBoundary extends Component<
  { rev: number; fallback: ReactNode; onError: (rev: number, error: unknown) => void; children: ReactNode },
  { error: unknown; rev: number }
> {
  state = { error: null as unknown, rev: this.props.rev }

  static getDerivedStateFromProps(props: { rev: number }, state: { error: unknown; rev: number }) {
    return props.rev !== state.rev ? { rev: props.rev, error: null } : null
  }

  static getDerivedStateFromError(error: unknown) {
    return { error: error ?? new Error('render failed') }
  }

  componentDidCatch(error: unknown) {
    this.props.onError(this.props.rev, error)
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}

class PopupBoundary extends Component<{ children: ReactNode }, { failed: boolean; children: ReactNode }> {
  state = { failed: false, children: this.props.children }

  static getDerivedStateFromProps(props: { children: ReactNode }, state: { children: ReactNode }) {
    return props.children !== state.children ? { failed: false, children: props.children } : null
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div data-sv-popup-failed="" role="note" style={{
        position: 'fixed', left: '50%', bottom: '1rem', transform: 'translateX(-50%)', zIndex: 1000,
        padding: '0.75rem 1rem', borderRadius: 12, border: '1px dashed var(--servd-mute)',
        background: 'var(--servd-bg)', color: 'var(--servd-mute)', font: '500 0.85rem/1.4 var(--font-inter), system-ui, sans-serif',
      }}>
        This pop-up can&apos;t be drawn yet
      </div>
    )
  }
}

function CommitProbe({ rev, onCommit }: { rev: number; onCommit: (rev: number) => void }) {
  useLayoutEffect(() => { onCommit(rev) }, [rev, onCommit])
  return null
}

function Banner({ text }: { text: string }) {
  return (
    <div role="status" style={{
      position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 2147482000,
      maxWidth: 'calc(100vw - 16px)', padding: '6px 12px', borderRadius: 999,
      background: 'var(--servd-purple)', color: 'var(--servd-on-purple)',
      font: '600 12px/1.3 var(--font-inter), system-ui, sans-serif', pointerEvents: 'none',
    }}>
      {text}
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div style={{
      minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: '1rem', padding: '2rem 1.25rem', textAlign: 'center', color: 'var(--servd-mute)',
      font: '500 0.95rem/1.5 var(--font-inter), system-ui, sans-serif',
    }}>
      {children}
    </div>
  )
}

// ── The frame ───────────────────────────────────────────────────────────────

export function EditorFrameClient({ render, allowedOrigins }: Props) {
  const [framed, setFramed] = useState<boolean | null>(null)
  const [view, setView] = useState<View | null>(null)
  const [banner, setBanner] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const boxes = useRef<{ sel: HTMLDivElement; selChip: HTMLSpanElement; hov: HTMLDivElement; ctx: HTMLDivElement; ctxChip: HTMLSpanElement } | null>(null)
  const drawFrame = useRef(0)
  const resizeObs = useRef<ResizeObserver | null>(null)
  const renderRef = useRef(render)
  renderRef.current = render
  const allowed = useRef(allowedOrigins)
  allowed.current = allowedOrigins

  const L = useRef<Live>({
    session: null, parentOrigin: null, latest: null, started: 0, inflight: false, cooldownUntil: 0, retryTimer: 0,
    backdrop: null, labels: {}, selected: null, hoverId: null, hoverCtx: null, adminHover: null,
    pendingScroll: null, preview: null, lastGood: null, hasGood: false, view: null,
  }).current
  L.view = view

  // ── Sending ──
  const post = useCallback((msg: Outgoing, target?: string) => {
    const origin = target ?? L.parentOrigin
    if (!origin) return
    try {
      window.parent.postMessage({ ns: EDITOR_NS, v: EDITOR_PROTOCOL, from: 'frame', ...msg }, origin)
    } catch { /* origin mismatch: dropped by the browser */ }
  }, [L])

  const find = useCallback((id: string): Element | null => {
    const root = rootRef.current
    if (!root) return null
    try { return root.querySelector(`[data-sv-block="${CSS.escape(id)}"]`) } catch { return null }
  }, [])

  const collectIds = useCallback((): string[] => {
    const root = rootRef.current
    if (!root) return []
    const ids = new Set<string>()
    root.querySelectorAll('[data-sv-block]').forEach((el) => {
      const id = el.getAttribute('data-sv-block')
      if (id) ids.add(id)
    })
    return [...ids]
  }, [])

  // ── Overlay ──
  const draw = useCallback(() => {
    drawFrame.current = 0
    const b = boxes.current
    const root = rootRef.current
    if (!b || !root) return
    const measured: Element[] = []
    const place = (box: HTMLDivElement, el: Element | null, chip?: HTMLSpanElement, label?: string) => {
      const r = el ? markerRect(el) : null
      if (!el || !r) { box.style.display = 'none'; return }
      const m = measuredElement(el)
      if (m) measured.push(m)
      box.style.display = 'block'
      box.style.left = `${r.left}px`
      box.style.top = `${r.top}px`
      box.style.width = `${r.width}px`
      box.style.height = `${r.height}px`
      if (chip) {
        chip.textContent = label ?? ''
        chip.style.top = r.top < 26 ? '2px' : '-22px'
        chip.style.left = r.top < 26 ? '2px' : '-2px'
      }
    }
    const selEl = L.selected ? find(L.selected) : null
    place(b.sel, selEl, b.selChip, L.selected ? (L.labels[L.selected] ?? selEl?.getAttribute('data-sv-type') ?? 'Element') : '')
    const hovId = L.hoverId ?? L.adminHover
    place(b.hov, hovId && hovId !== L.selected ? find(hovId) : null)
    let ctxEl: Element | null = null
    if (L.hoverCtx && !L.hoverId) {
      try { ctxEl = root.querySelector(`[data-sv-context="${CSS.escape(L.hoverCtx)}"]`) } catch { ctxEl = null }
    }
    place(b.ctx, ctxEl, b.ctxChip, L.hoverCtx ? contextLabel(L.hoverCtx) : '')
    const ro = resizeObs.current
    if (ro) {
      ro.disconnect()
      for (const m of measured) ro.observe(m)
    }
  }, [L, find])

  const scheduleDraw = useCallback(() => {
    if (!drawFrame.current) drawFrame.current = requestAnimationFrame(draw)
  }, [draw])

  // ── Selection ──
  const selectFromFrame = useCallback((id: string | null) => {
    if (!L.session) return
    L.selected = id
    draw()
    const el = id ? find(id) : null
    post({ type: 'select', session: L.session, id, rect: toRect(el ? markerRect(el) : null), viewport: viewport() })
  }, [L, draw, find, post])

  const scrollToId = useCallback((id: string): boolean => {
    const marker = find(id)
    if (!marker) return false
    const r = markerRect(marker)
    const el = measuredElement(marker)
    if (!r || !el) return true
    const V = window.innerHeight
    const visible = Math.max(0, Math.min(r.bottom, V) - Math.max(r.top, 0))
    if (visible < Math.min(r.height, V) / 2) {
      el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    }
    return true
  }, [find])

  // ── Scroll-effect preview ──
  const clearAllScrubs = useCallback(() => {
    rootRef.current?.querySelectorAll<HTMLElement>('[data-sv-m-scrub]').forEach((w) => clearScrub(w))
  }, [])

  const endPreview = useCallback((reason: 'scrolled' | 'not-found' | null) => {
    const p = L.preview
    L.preview = null
    clearAllScrubs()
    if (p && reason && L.session) post({ type: 'motion-preview-ended', session: L.session, id: p.id, reason })
  }, [L, clearAllScrubs, post])

  const applyPreview = useCallback(() => {
    const p = L.preview
    if (!p) return
    const marker = find(p.id)
    const wrapper = marker ? childWithClass(marker, 'sv-motion') as HTMLElement | null : null
    const m = wrapper ? normalizeMotion({ preset: wrapper.dataset['svMotion'], intensity: wrapper.dataset['svIntensity'] }) : null
    if (!wrapper || !m) { endPreview('not-found'); return }
    const spec = MOTION_SPECS[m.preset]
    if (!p.shown) {
      p.shown = true
      const r = wrapper.getBoundingClientRect()
      if (spec.scrub === 'in-place' && (r.bottom < 0 || r.top > window.innerHeight)) {
        wrapper.scrollIntoView({ block: 'center', behavior: 'instant' })
      }
    }
    if (spec.scrub === 'in-place') {
      // Only one element previews at a time.
      rootRef.current?.querySelectorAll<HTMLElement>('[data-sv-m-scrub]').forEach((w) => { if (w !== wrapper) clearScrub(w) })
      setScrubProgress(wrapper, p.progress)
    } else {
      scrollStackTo(wrapper, p.progress)
    }
    scheduleDraw()
  }, [L, find, endPreview, scheduleDraw])

  // ── Rendering ──
  const commit = useCallback((next: View) => {
    startTransition(() => setView(next))
  }, [])

  const reportFailure = useCallback((rev: number, error: string) => {
    setBanner(error)
    if (L.session) post({ type: 'rendered', session: L.session, rev, ok: false, error, ids: collectIds(), ms: 0 })
  }, [L, post, collectIds])

  const callRender = useCallback(async (input: FrameRenderInput): Promise<FrameRenderResult | null> => {
    try {
      const res: unknown = await renderRef.current(input)
      // Next 14 resolves (not rejects) with `undefined` when the server did not
      // answer with an action result: an action id it no longer knows (a
      // redeploy), a body over the size limit, a rejected Origin check.
      if (isPlainObject(res) && typeof res['ok'] === 'boolean' && typeof res['rev'] === 'number') return res as unknown as FrameRenderResult
      throw new Error('The Server Action gave no result.')
    } catch (e) {
      // The action itself failed: network, body too large, or (after a
      // storefront redeploy) an action id this page no longer knows. Reload
      // once per session for the last one; the admin re-sends init on `ready`.
      const message = e instanceof Error ? e.message : String(e)
      if (/server action/i.test(message) && L.session) {
        const key = `sv-editor-reloaded:${L.session}`
        let tried = true
        try { tried = window.sessionStorage.getItem(key) === '1'; if (!tried) window.sessionStorage.setItem(key, '1') } catch { tried = true }
        if (!tried) { window.location.reload(); return null }
      }
      reportFailure(input.rev, 'The live page could not be updated.')
      return null
    }
  }, [L, reportFailure])

  const pumpRef = useRef<() => void>(NOOP)

  const handleResult = useCallback((res: FrameRenderResult): boolean => {
    if (res.ok) return true
    reportFailure(res.rev, res.error || RENDER_ERROR_TEXT[res.code])
    if (res.code === 'RATE_LIMITED') {
      L.cooldownUntil = Date.now() + RETRY_MS
      L.started = -1   // run the latest doc again after the pause
    }
    return false
  }, [L, reportFailure])

  const pump = useCallback(async () => {
    if (L.inflight) return
    const doc = L.latest
    if (!doc || doc.rev === L.started) return
    const wait = L.cooldownUntil - Date.now()
    if (wait > 0) {
      if (!L.retryTimer) L.retryTimer = window.setTimeout(() => { L.retryTimer = 0; pumpRef.current() }, wait)
      return
    }
    L.inflight = true
    L.started = doc.rev
    const t0 = performance.now()
    try {
      if (doc.kind === 'popup') {
        const settings = sanitizeSettings(doc.settings, 'popup')
        const ctxSlug = popupContextSlug(settings)
        if (L.backdrop?.slug !== ctxSlug) {
          const res = await callRender({ rev: doc.rev, slug: ctxSlug, edited: null, variant: 'a' })
          if (res?.ok) L.backdrop = { slug: ctxSlug, node: res.node }
          else if (res) handleResult(res)
        }
        const blocks = sanitizeBlocks(doc.variant === 'b' && settings?.ab ? settings.ab.blocks : doc.blocks)
        const popup: LivePopup = {
          slug: doc.slug, version: 0, title: doc.title, blocks,
          rules: settings?.popup ?? PREVIEW_RULES, fonts: sanitizeFonts(doc.fonts),
        }
        commit({ rev: doc.rev, t0, node: L.backdrop?.node ?? null, popup })
      } else {
        const res = await callRender({
          rev: doc.rev, slug: doc.slug, variant: doc.variant,
          edited: { title: doc.title, blocks: doc.blocks, settings: doc.settings, fonts: doc.fonts },
          ...(doc.kit && { kit: doc.kit }),
        })
        if (res && handleResult(res) && res.ok) commit({ rev: res.rev, t0, node: res.node, popup: null })
      }
    } finally {
      L.inflight = false
      if (L.latest && L.latest.rev !== L.started) pumpRef.current()
    }
  }, [L, callRender, handleResult, commit])
  pumpRef.current = () => { void pump() }

  const onCommitted = useCallback((rev: number) => {
    const v = L.view
    if (v && v.rev === rev) {
      L.lastGood = v.node
      L.hasGood = true
    }
    const root = rootRef.current
    const failed: string[] = []
    root?.querySelectorAll('[data-sv-block-failed]').forEach((el) => {
      const id = el.closest('[data-sv-block]')?.getAttribute('data-sv-block')
      if (id) failed.push(L.labels[id] ?? id)
    })
    if (root?.querySelector('[data-sv-popup-failed]')) failed.push('the pop-up')
    const error = failed.length ? `Some elements can't be drawn yet: ${failed.slice(0, 5).join(', ')}.` : null
    setBanner(error)
    draw()
    applyPreview()
    if (L.pendingScroll) {
      const id = L.pendingScroll
      L.pendingScroll = null
      scrollToId(id)
    }
    if (L.session) {
      post({
        type: 'rendered', session: L.session, rev, ok: !error, error, ids: collectIds(),
        ms: v ? Math.round(performance.now() - v.t0) : 0,
      })
    }
  }, [L, draw, applyPreview, scrollToId, post, collectIds])

  const onPageError = useCallback((rev: number, error: unknown) => {
    const detail = error instanceof Error && error.message ? ` ${error.message.slice(0, 200)}` : ''
    reportFailure(rev, `${RENDER_ERROR_TEXT.RENDER}${detail}`)
  }, [reportFailure])

  // ── Incoming ──
  const acceptDoc = useCallback((raw: unknown) => {
    const c = checkDoc(raw)
    if (!c.ok) {
      const text = c.code === 'TOO_LARGE' ? RENDER_ERROR_TEXT.TOO_LARGE : RENDER_ERROR_TEXT.BAD_INPUT
      if (c.rev !== null) reportFailure(c.rev, text)
      else post({ type: 'error', session: L.session, code: c.code, message: text })
      return
    }
    L.latest = c.doc
    L.labels = c.doc.labels
    pumpRef.current()
  }, [L, post, reportFailure])

  useEffect(() => {
    const isFramed = window.parent !== window
    setFramed(isFramed)
    if (!isFramed) return

    // Announce until the admin answers with init (never to '*').
    const targets = (): string[] => {
      try {
        const o = new URL(document.referrer).origin
        if (allowed.current.includes(o)) return [o]
      } catch { /* no referrer */ }
      return allowed.current
    }
    let sent = 0
    const announce = () => {
      if (L.session || sent >= ANNOUNCE_MAX) { window.clearInterval(timer); return }
      sent += 1
      for (const t of targets()) post({ type: 'ready', session: null, protocol: EDITOR_PROTOCOL, scrollTimeline: supportsScrollTimeline() }, t)
    }
    const timer = window.setInterval(announce, ANNOUNCE_EVERY_MS)
    announce()

    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent) return
      if (!allowed.current.includes(ev.origin)) return
      if (L.parentOrigin && ev.origin !== L.parentOrigin) return
      const data: unknown = ev.data
      if (isForeignVersion(data)) {
        post({ type: 'error', session: null, code: 'PROTOCOL', message: 'This storefront speaks editor protocol 1.' }, ev.origin)
        return
      }
      if (!isAdminMessage(data)) return
      const d = data as unknown as Record<string, unknown>
      if (data.type === 'init') {
        if (!validId(d['session'])) return
        const fresh = d['session'] !== L.session
        L.parentOrigin = ev.origin
        L.session = d['session'] as string
        if (fresh) {
          L.latest = null
          L.started = 0
          L.preview = null
          L.pendingScroll = null
          clearAllScrubs()
        }
        L.selected = validId(d['selectedId']) ? d['selectedId'] : null
        if (L.selected) L.pendingScroll = L.selected
        window.clearInterval(timer)
        acceptDoc(d['doc'])
        return
      }
      if (!L.session || d['session'] !== L.session) return
      switch (data.type) {
        case 'doc':
          acceptDoc(d['doc'])
          break
        case 'select': {
          const id = d['id'] === null ? null : validId(d['id']) ? d['id'] : undefined
          if (id === undefined) return
          L.selected = id
          draw()
          if (id && d['scroll'] === true && !scrollToId(id)) L.pendingScroll = id
          break
        }
        case 'hover': {
          const id = d['id'] === null ? null : validId(d['id']) ? d['id'] : undefined
          if (id === undefined) return
          L.adminHover = id
          scheduleDraw()
          break
        }
        case 'motion-preview': {
          const id = d['id']
          if (!validId(id)) return
          const progress = d['progress']
          if (progress === null) { if (L.preview?.id === id) endPreview(null); return }
          if (typeof progress !== 'number' || !Number.isFinite(progress)) return
          const p = Math.min(1, Math.max(0, progress))
          L.preview = { id, progress: p, shown: L.preview?.id === id ? L.preview.shown : false }
          applyPreview()
          break
        }
        case 'ping':
          post({ type: 'ready', session: L.session, protocol: EDITOR_PROTOCOL, scrollTimeline: supportsScrollTimeline() })
          break
        default:
          break   // unknown types are ignored (forward compatible)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('message', onMessage)
      if (L.retryTimer) window.clearTimeout(L.retryTimer)
      L.retryTimer = 0
    }
  }, [L, post, acceptDoc, draw, scheduleDraw, scrollToId, applyPreview, endPreview, clearAllScrubs])

  // ── Overlay boxes, input capture, redraw triggers ──
  useEffect(() => {
    if (!framed) return
    const overlay = overlayRef.current
    if (!overlay) return
    const mk = <K extends 'div' | 'span'>(tag: K, css: string) => {
      const el = document.createElement(tag)
      el.style.cssText = css
      return el
    }
    const BOX = 'position:absolute;display:none;box-sizing:border-box;'
    const CHIP = 'position:absolute;white-space:nowrap;padding:5px 8px;border-radius:6px;font:600 11px/1 var(--font-inter),system-ui,sans-serif;'
    const sel = mk('div', `${BOX}border:2px solid var(--servd-green);box-shadow:0 0 0 3px color-mix(in srgb, var(--servd-ink) 55%, transparent);border-radius:2px;`)
    const selChip = mk('span', `${CHIP}background:var(--servd-green);color:var(--servd-on-green);`)
    sel.appendChild(selChip)
    const hov = mk('div', `${BOX}border:1px dashed var(--servd-purple);box-shadow:0 0 0 3px color-mix(in srgb, var(--servd-bg) 70%, transparent);`)
    const ctx = mk('div', `${BOX}border:1px dotted var(--servd-mute);`)
    const ctxChip = mk('span', `${CHIP}background:var(--servd-surface);color:var(--servd-ink);border:1px solid var(--servd-line);`)
    ctx.appendChild(ctxChip)
    overlay.append(ctx, hov, sel)
    boxes.current = { sel, selChip, hov, ctx, ctxChip }
    resizeObs.current = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(scheduleDraw) : null

    // Content that fills in after a commit (lazy client sections) re-measures.
    const root = rootRef.current
    let mutFrame = 0
    const mo = root && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(() => {
        if (mutFrame) return
        mutFrame = requestAnimationFrame(() => {
          mutFrame = 0
          draw()
          if (L.preview) applyPreview()
        })
      })
      : null
    mo?.observe(root!, { childList: true, subtree: true })

    let hoverFrame = 0
    let lastTarget: Element | null = null
    const updateHover = () => {
      hoverFrame = 0
      const t = lastTarget
      const marker = t?.closest?.('[data-sv-block]') ?? null
      const id = marker?.getAttribute('data-sv-block') ?? null
      const ctxSlug = id ? null : (t?.closest?.('[data-sv-context]')?.getAttribute('data-sv-context') ?? null)
      if (id === L.hoverId && ctxSlug === L.hoverCtx) return
      const changed = id !== L.hoverId
      L.hoverId = id
      L.hoverCtx = ctxSlug
      if (id) L.adminHover = null
      draw()
      if (changed && L.session) {
        post({ type: 'hover', session: L.session, id, rect: toRect(marker ? markerRect(marker) : null), viewport: viewport() })
      }
    }
    const onMove = (e: MouseEvent) => {
      lastTarget = e.target instanceof Element ? e.target : null
      if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover)
    }
    const onLeave = () => {
      lastTarget = null
      if (!hoverFrame) hoverFrame = requestAnimationFrame(updateHover)
    }
    const onClick = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.type !== 'click') return
      const t = e.target instanceof Element ? e.target : null
      const marker = t?.closest('[data-sv-block]')
      if (marker) { selectFromFrame(marker.getAttribute('data-sv-block')); return }
      const slug = t?.closest('[data-sv-context]')?.getAttribute('data-sv-context')
      if (slug) {
        if (L.session && parseEditorSlug(slug)) post({ type: 'context', session: L.session, slug })
        return
      }
      selectFromFrame(null)
    }
    const onSubmit = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    const onDrag = (e: DragEvent) => { e.preventDefault() }
    const endInPlacePreview = () => {
      const p = L.preview
      if (!p) return
      const wrapper = find(p.id)
      const w = wrapper ? childWithClass(wrapper, 'sv-motion') as HTMLElement | null : null
      const m = w ? normalizeMotion({ preset: w.dataset['svMotion'], intensity: w.dataset['svIntensity'] }) : null
      if (!m || MOTION_SPECS[m.preset].scrub === 'in-place') endPreview('scrolled')
    }
    const onKey = (e: KeyboardEvent) => {
      const t = e.target instanceof Element ? e.target : null
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (!L.selected) return
        const parent = find(L.selected)?.parentElement?.closest('[data-sv-block]') ?? null
        selectFromFrame(parent?.getAttribute('data-sv-block') ?? null)
        return
      }
      const typing = !!t?.closest('input, textarea, select, [contenteditable="true"]')
      if ((e.key === 'Enter' || e.key === ' ') && t?.closest('a, button, [role=button], summary')) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      if (!typing && SCROLL_KEYS.has(e.key)) endInPlacePreview()
    }
    const onScroll = () => scheduleDraw()

    const opts = { capture: true } as const
    window.addEventListener('click', onClick, opts)
    window.addEventListener('auxclick', onClick, opts)
    window.addEventListener('submit', onSubmit, opts)
    window.addEventListener('keydown', onKey, opts)
    window.addEventListener('dragstart', onDrag, opts)
    window.addEventListener('mousemove', onMove, { capture: true, passive: true })
    window.addEventListener('wheel', endInPlacePreview, { capture: true, passive: true })
    window.addEventListener('touchmove', endInPlacePreview, { capture: true, passive: true })
    window.addEventListener('scroll', onScroll, { capture: true, passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      window.removeEventListener('click', onClick, opts)
      window.removeEventListener('auxclick', onClick, opts)
      window.removeEventListener('submit', onSubmit, opts)
      window.removeEventListener('keydown', onKey, opts)
      window.removeEventListener('dragstart', onDrag, opts)
      window.removeEventListener('mousemove', onMove, { capture: true })
      window.removeEventListener('wheel', endInPlacePreview, { capture: true })
      window.removeEventListener('touchmove', endInPlacePreview, { capture: true })
      window.removeEventListener('scroll', onScroll, { capture: true })
      window.removeEventListener('resize', onScroll)
      document.documentElement.removeEventListener('mouseleave', onLeave)
      mo?.disconnect()
      resizeObs.current?.disconnect()
      resizeObs.current = null
      if (hoverFrame) cancelAnimationFrame(hoverFrame)
      if (mutFrame) cancelAnimationFrame(mutFrame)
      if (drawFrame.current) cancelAnimationFrame(drawFrame.current)
      drawFrame.current = 0
      overlay.replaceChildren()
      boxes.current = null
    }
  }, [framed, L, draw, scheduleDraw, selectFromFrame, post, find, applyPreview, endPreview])

  if (framed === false) {
    return (
      <Centered>
        <p>This page shows a live preview inside Admin → Storefront. Open the page there.</p>
      </Centered>
    )
  }

  const loading = (
    <Centered>
      <Loader />
      <p>Loading the page…</p>
    </Centered>
  )
  const popup = view?.popup ?? null
  const bar = popup?.rules.display === 'bar'
  const popupNode = popup ? (
    <PopupBoundary>
      <PopupFrame key={popup.slug} popup={popup} onClose={NOOP} track={false} editor />
    </PopupBoundary>
  ) : null
  const lastGood = L.hasGood ? L.lastGood : loading

  return (
    <>
      <div id="sv-editor-root" ref={rootRef}>
        {bar && popupNode}
        {view ? (
          <FrameBoundary rev={view.rev} onError={onPageError} fallback={lastGood}>
            <Suspense fallback={lastGood}>
              {view.node}
              <CommitProbe rev={view.rev} onCommit={onCommitted} />
            </Suspense>
          </FrameBoundary>
        ) : loading}
        {!bar && popupNode}
      </div>
      {banner && <Banner text={banner} />}
      <div id="sv-editor-overlay" ref={overlayRef} aria-hidden="true" style={{
        position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000, overflow: 'hidden',
      }} />
    </>
  )
}
