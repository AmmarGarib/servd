'use client'

// The live page in the middle of the storefront builder (D4 stage 1).
//
// An <iframe> of the storefront's /editor-frame route. The editor posts the
// operator's UNSAVED working copy into it (postMessage, protocol v1 in
// lib/editorProtocol.ts — a byte-identical copy of the storefront's
// src/editor/protocol.ts); the frame renders it through the storefront's own
// live renderer and reports back what was clicked or hovered. Nothing is
// saved by this: saving, submitting and approving are unchanged.
//
// Security: messages go to STOREFRONT_ORIGIN only (never '*'), and a message
// is accepted only from that origin AND from this iframe's window AND (after
// the handshake) carrying this mount's session. The iframe is sandboxed
// (scripts + same-origin for its own server action; no forms, pop-ups,
// top navigation or modals). The storefront frames itself only for the admin
// origins (CSP frame-ancestors from ADMIN_ORIGINS).
//
// The editor never depends on this: with no answer in 12 s the centre says
// so and Layers + the inspector keep working.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Monitor, RotateCw, Smartphone, Tablet, X } from 'lucide-react'
import type { Block } from '../../lib/blocks'
import {
  cleanSettings, contextPartName, editorFrameUrl, isValidSlug, kindForSlug, STOREFRONT_ORIGIN,
  type BrandKit, type PageSettings, type Variant,
} from '../../lib/content'
import { storefrontHost } from '../../lib/sections'
import {
  EDITOR_NS, EDITOR_PROTOCOL, isFrameMessage, MAX_DOC_CHARS, newSession,
  type AdminToFrame, type FrameDoc, type FrameToAdmin,
} from '../../lib/editorProtocol'

// ─── Devices ─────────────────────────────────────────────────────────────────

export type Device = 'phone' | 'tablet' | 'desktop'

/** The viewport the page is drawn at (CSS px inside the frame). */
const DEVICES: Record<Device, { label: string; w: number; h: number }> = {
  phone:   { label: 'Phone',   w: 390,  h: 844 },
  tablet:  { label: 'Tablet',  w: 820,  h: 1180 },
  desktop: { label: 'Desktop', w: 1280, h: 800 },
}
const DEVICE_KEY = 'sf-editor-device'
const PAD = 24

function readDevice(isPopup: boolean): Device {
  const fallback: Device = isPopup ? 'phone' : 'desktop'
  try {
    const raw = window.localStorage.getItem(DEVICE_KEY)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as Record<string, unknown>
    const v = saved[isPopup ? 'popup' : 'page']
    return v === 'phone' || v === 'tablet' || v === 'desktop' ? v : fallback
  } catch {
    return fallback
  }
}

function saveDevice(isPopup: boolean, d: Device) {
  try {
    let saved: Record<string, unknown> = {}
    try { saved = JSON.parse(window.localStorage.getItem(DEVICE_KEY) ?? '{}') as Record<string, unknown> } catch { /* reset */ }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}
    saved[isPopup ? 'popup' : 'page'] = d
    window.localStorage.setItem(DEVICE_KEY, JSON.stringify(saved))
  } catch { /* private mode: not remembered */ }
}

// ─── Public types ────────────────────────────────────────────────────────────

/** connecting: waiting for the frame's hello. live: talking. offline: no
 *  answer in 12 s. version: the storefront runs another protocol version.
 *  unconfigured: the storefront address is not a usable URL. */
export type FrameConnection = 'connecting' | 'live' | 'offline' | 'version' | 'unconfigured'

export interface FrameStatus {
  connection: FrameConnection
  /** A posted change hasn't been drawn yet. */
  updating: boolean
  /** The last change couldn't be drawn (the edit is kept). */
  error: string | null
  /** The newest edit was never sent (too large): the page shows an older
   *  version, so nothing may be previewed on it. */
  stale: boolean
}

export type SelectionSource = 'admin' | 'frame'

export interface LiveCanvasHandle {
  /** Play the selected element's scroll effect at `progress` (0..1); null = live. */
  previewMotion: (id: string, progress: number | null) => void
  /** Reload the frame (a new session). */
  reload: () => void
}

interface Props {
  slug: string
  doc: { title: string; blocks: Block[]; settings: PageSettings }
  variant: Variant
  /** Library fonts the doc uses (family -> url), as the live page would load them. */
  fonts: Array<{ family: string; url: string }>
  /** Block id -> what the editor calls it (the frame's outline chip). */
  labels: Record<string, string>
  /** A brand kit being edited: the frame paints that brand with this draft
   *  kit over the live one (FrameDoc.kit). Nothing is saved by it. */
  kit?: { brand: string; kit: BrandKit }
  selection: { id: string | null; source: SelectionSource; nonce: number }
  hover: { id: string | null; source: SelectionSource }
  /** Extra toolbar controls (A/B variant switch, the pop-up's display hint). */
  toolbarExtra?: React.ReactNode
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
  onOpenContext: (slug: string) => void
  onMotionPreviewEnded: (id: string, reason: 'scrolled' | 'not-found') => void
  onRendered: (rev: number, ok: boolean, error: string | null, ids: string[]) => void
  onStatus: (status: FrameStatus) => void
  /** The frame (re)connected: anything previewed is gone. */
  onReconnect: () => void
}

// ─── Validation of what the frame sends ──────────────────────────────────────

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 100
const idOrNull = (v: unknown): string | null | undefined => (v === null ? null : isId(v) ? v : undefined)

const ERROR_TEXT: Record<string, string> = {
  TOO_LARGE: "This page is too large to preview.",
  BAD_DOC: "The editor sent something the page can't read.",
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length
}

const OFFLINE_AFTER_MS = 12_000
const DOC_THROTTLE_MS = 250
/** A hello that crossed our init in flight is not a reload. */
const INIT_ECHO_MS = 1_500

export const LiveCanvas = forwardRef<LiveCanvasHandle, Props>(function LiveCanvas(props, ref) {
  const { slug, doc, variant, fonts, labels, kit, selection, hover, toolbarExtra } = props
  const kind = kindForSlug(slug)
  const isPopup = kind === 'popup'
  const src = editorFrameUrl()

  // Latest callbacks, so the message listener is registered once per mount.
  const cb = useRef(props)
  cb.current = props

  // ─── Device + scale ──────────────────────────────────────────────────────
  const [device, setDeviceState] = useState<Device>(isPopup ? 'phone' : 'desktop')
  useEffect(() => { setDeviceState(readDevice(isPopup)) }, [isPopup])
  const setDevice = (d: Device) => { setDeviceState(d); saveDevice(isPopup, d) }

  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const dev = DEVICES[device]
  const W = Math.max(0, stage.w - PAD)
  const H = Math.max(0, stage.h - PAD)
  const k = W > 0 && H > 0 ? Math.min(1, W / dev.w, H / dev.h) : 0
  const boxW = Math.floor(dev.w * k)
  const boxH = Math.floor(dev.h * k)

  // ─── Session + connection ────────────────────────────────────────────────
  const [mount, setMount] = useState(0)
  const session = useMemo(() => newSession(), [mount]) // eslint-disable-line react-hooks/exhaustive-deps
  const sessionRef = useRef(session)
  sessionRef.current = session
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const [connection, setConnection] = useState<FrameConnection>(src ? 'connecting' : 'unconfigured')
  const connRef = useRef(connection)
  connRef.current = connection
  const [postedRev, setPostedRev] = useState(0)
  const [renderedRev, setRenderedRev] = useState(0)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [tooLarge, setTooLarge] = useState(false)
  const tooLargeRef = useRef(false)
  const [contextSlug, setContextSlug] = useState<string | null>(null)

  const revRef = useRef(0)
  const postedRevRef = useRef(0)
  const renderedRevRef = useRef(0)
  const lastSentJson = useRef<string | null>(null)
  const lastPostAt = useRef(0)
  const throttle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initAt = useRef(0)
  /** The frame said hello but hasn't had an init yet (e.g. the doc was too large). */
  const needInit = useRef(false)
  const postedHover = useRef<string | null>(null)

  const post = useCallback((msg: AdminToFrame) => {
    const win = iframeRef.current?.contentWindow
    if (!win || !STOREFRONT_ORIGIN) return
    win.postMessage(msg, STOREFRONT_ORIGIN)
  }, [])

  // ─── The doc as the frame gets it ────────────────────────────────────────
  const body = useMemo(() => {
    const settings = cleanSettings(doc.settings, isPopup) as unknown as Record<string, unknown>
    // `kit` is FrameDoc.kit in the contract; typed here so this file does not
    // depend on the protocol copy having been refreshed yet.
    const b: Omit<FrameDoc, 'rev'> & { kit?: { brand: string; kit: BrandKit } } = {
      slug,
      // The frame always shows a page/part, never the kit row itself.
      kind: kind as FrameDoc['kind'],
      title: doc.title.trim() || null,
      variant,
      blocks: doc.blocks,
      settings: Object.keys(settings).length ? settings : null,
      fonts,
      labels,
      ...(kit ? { kit } : {}),
    }
    const json = JSON.stringify(b)
    return { doc: b, json, size: utf8Length(json) }
  }, [slug, kind, isPopup, doc, variant, fonts, labels, kit])
  const bodyRef = useRef(body)
  bodyRef.current = body

  /** Post the current doc (init after a hello, else doc). False when too large. */
  const sendDoc = useCallback((type: 'init' | 'doc'): boolean => {
    const cur = bodyRef.current
    // A little head-room for the envelope and rev.
    if (cur.size + 200 > MAX_DOC_CHARS) {
      tooLargeRef.current = true
      setTooLarge(true)
      lastSentJson.current = null
      return false
    }
    tooLargeRef.current = false
    setTooLarge(false)
    const rev = ++revRef.current
    const frameDoc: FrameDoc = { ...cur.doc, rev }
    const base = { ns: EDITOR_NS, v: EDITOR_PROTOCOL, from: 'admin' as const, session: sessionRef.current }
    if (type === 'init') {
      post({ ...base, type: 'init', doc: frameDoc, selectedId: cb.current.selection.id, mode: 'select' })
      initAt.current = Date.now()
      needInit.current = false
    } else {
      post({ ...base, type: 'doc', doc: frameDoc })
    }
    lastSentJson.current = cur.json
    lastPostAt.current = Date.now()
    postedRevRef.current = rev
    setPostedRev(rev)
    return true
  }, [post])

  const flushDoc = useCallback(() => {
    throttle.current = null
    if (connRef.current !== 'live') return
    if (bodyRef.current.json === lastSentJson.current) return
    sendDoc(needInit.current ? 'init' : 'doc')
  }, [sendDoc])

  // Edits: the first change goes at once, then at most one post per 250 ms
  // (the latest wins; the frame itself renders single-flight, latest wins).
  useEffect(() => {
    if (connRef.current !== 'live') return
    if (body.json === lastSentJson.current) return
    if (throttle.current) return
    const wait = lastPostAt.current + DOC_THROTTLE_MS - Date.now()
    if (wait <= 0) flushDoc()
    else throttle.current = setTimeout(flushDoc, wait)
  }, [body.json, flushDoc])

  // ─── A fresh mount: reset, wait for the hello, give up after 12 s ────────
  useEffect(() => {
    revRef.current = 0
    postedRevRef.current = 0
    renderedRevRef.current = 0
    lastSentJson.current = null
    postedHover.current = null
    initAt.current = 0
    needInit.current = false
    connRef.current = src ? 'connecting' : 'unconfigured'
    setPostedRev(0)
    setRenderedRev(0)
    setRenderError(null)
    setContextSlug(null)
    if (!src) { setConnection('unconfigured'); return }
    setConnection('connecting')
    const t = setTimeout(() => {
      if (connRef.current === 'connecting') setConnection('offline')
    }, OFFLINE_AFTER_MS)
    return () => {
      clearTimeout(t)
      if (throttle.current) { clearTimeout(throttle.current); throttle.current = null }
    }
  }, [mount, src])

  // ─── Messages from the frame ─────────────────────────────────────────────
  useEffect(() => {
    if (!STOREFRONT_ORIGIN) return
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== STOREFRONT_ORIGIN) return
      const frameWin = iframeRef.current?.contentWindow
      if (!frameWin || ev.source !== frameWin) return
      const raw = ev.data as Record<string, unknown> | null
      // Same namespace, another protocol version: the storefront was
      // deployed with a different editor. Say so instead of half-working.
      if (raw && typeof raw === 'object' && raw['ns'] === EDITOR_NS && raw['from'] === 'frame' && raw['v'] !== EDITOR_PROTOCOL) {
        setConnection('version')
        return
      }
      if (!isFrameMessage(ev.data)) return
      const m = ev.data as FrameToAdmin
      if (m.type !== 'ready' && m.session !== sessionRef.current) return

      switch (m.type) {
        case 'ready': {
          if (m.protocol !== EDITOR_PROTOCOL) { setConnection('version'); return }
          if (m.session === sessionRef.current) { setConnection('live'); return }   // answer to a ping
          if (m.session !== null) return                                              // someone else's session
          if (connRef.current === 'live' && Date.now() - initAt.current < INIT_ECHO_MS) return
          // The frame is still waiting for an init we refused as too large:
          // its repeated hellos change nothing. The init goes out as soon as
          // an edit brings the doc back under the cap (flushDoc).
          if (connRef.current === 'live' && needInit.current && tooLargeRef.current) return
          // First hello, or the frame reloaded: (re)start it with our session.
          // Only a frame that had an init before had anything to lose.
          const hadInit = initAt.current > 0
          connRef.current = 'live'
          setConnection('live')
          setRenderError(null)
          postedHover.current = null
          if (throttle.current) { clearTimeout(throttle.current); throttle.current = null }
          needInit.current = true
          sendDoc('init')
          if (hadInit) cb.current.onReconnect()
          return
        }
        case 'rendered': {
          if (typeof m.rev !== 'number' || !Number.isInteger(m.rev) || m.rev < renderedRevRef.current || m.rev > revRef.current) return
          const ok = m.ok === true
          const ids = Array.isArray(m.ids) ? m.ids.filter(isId) : []
          const error = ok ? null : (typeof m.error === 'string' && m.error.trim() ? m.error.slice(0, 300) : "Part of the page couldn't be drawn.")
          renderedRevRef.current = m.rev
          setRenderedRev(m.rev)
          setRenderError(error)
          cb.current.onRendered(m.rev, ok, error, ids)
          return
        }
        case 'select': {
          const id = idOrNull(m.id)
          if (id === undefined) return
          cb.current.onSelect(id)
          return
        }
        case 'hover': {
          const id = idOrNull(m.id)
          if (id === undefined) return
          // The frame now shows this hover itself: a later Layers hover of
          // another id must be posted, the same id need not be.
          postedHover.current = id
          cb.current.onHover(id)
          return
        }
        case 'context': {
          if (!isValidSlug(m.slug) || kindForSlug(m.slug) === 'popup') return
          setContextSlug(m.slug)
          return
        }
        case 'motion-preview-ended': {
          if (!isId(m.id) || (m.reason !== 'scrolled' && m.reason !== 'not-found')) return
          cb.current.onMotionPreviewEnded(m.id, m.reason)
          return
        }
        case 'error': {
          if (m.code === 'PROTOCOL') { setConnection('version'); return }
          if (m.code === 'TOO_LARGE' || m.code === 'BAD_DOC') {
            // The doc was refused before rendering: that change is done (it
            // failed), so the editor must not wait on it.
            const rawRev = (m as unknown as Record<string, unknown>)['rev']
            const rev = typeof rawRev === 'number' && Number.isInteger(rawRev) && rawRev <= revRef.current ? rawRev : postedRevRef.current
            if (rev < renderedRevRef.current) return
            const text = ERROR_TEXT[m.code] ?? "Part of the page couldn't be drawn."
            renderedRevRef.current = rev
            setRenderedRev(rev)
            setRenderError(text)
            cb.current.onRendered(rev, false, text, [])
          }
          return
        }
        default:
          return   // unknown types: ignored (forward compatible)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sendDoc])

  // ─── Selection and hover that start in the editor ────────────────────────
  useEffect(() => {
    if (selection.source !== 'admin' || connRef.current !== 'live') return
    post({ ns: EDITOR_NS, v: EDITOR_PROTOCOL, from: 'admin', type: 'select', session: sessionRef.current, id: selection.id, scroll: selection.id !== null })
  }, [selection.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // A hover that came from the frame is never echoed back.
    if (hover.source !== 'admin' || connRef.current !== 'live') return
    if (hover.id === postedHover.current) return
    postedHover.current = hover.id
    post({ ns: EDITOR_NS, v: EDITOR_PROTOCOL, from: 'admin', type: 'hover', session: sessionRef.current, id: hover.id })
  }, [hover.id, hover.source, post])

  // ─── Scroll-effect preview (rAF-throttled) ───────────────────────────────
  const pendingPreview = useRef<{ id: string; progress: number | null } | null>(null)
  const previewFrame = useRef<number | null>(null)
  useEffect(() => () => { if (previewFrame.current !== null) cancelAnimationFrame(previewFrame.current) }, [])

  useImperativeHandle(ref, () => ({
    previewMotion: (id, progress) => {
      if (!isId(id)) return
      let p: number | null = null
      if (progress !== null) {
        if (typeof progress !== 'number' || !Number.isFinite(progress)) return
        p = Math.max(0, Math.min(1, progress))
      }
      pendingPreview.current = { id, progress: p }
      if (previewFrame.current !== null) return
      previewFrame.current = requestAnimationFrame(() => {
        previewFrame.current = null
        const next = pendingPreview.current
        pendingPreview.current = null
        if (!next || connRef.current !== 'live') return
        post({ ns: EDITOR_NS, v: EDITOR_PROTOCOL, from: 'admin', type: 'motion-preview', session: sessionRef.current, id: next.id, progress: next.progress })
      })
    },
    reload: () => setMount((n) => n + 1),
  }), [post])

  // ─── Status for the builder ──────────────────────────────────────────────
  const updating = connection === 'live' && renderedRev < postedRev
  const shownError = tooLarge ? ERROR_TEXT['TOO_LARGE']! : renderError
  useEffect(() => {
    cb.current.onStatus({ connection, updating, error: shownError, stale: tooLarge })
  }, [connection, updating, shownError, tooLarge])

  // A context notice fades on its own.
  useEffect(() => {
    if (!contextSlug) return
    const t = setTimeout(() => setContextSlug(null), 10_000)
    return () => clearTimeout(t)
  }, [contextSlug])

  const statusChip = connection === 'unconfigured' || connection === 'offline' || connection === 'version'
    ? { text: 'Offline', cls: 's-badge-muted' }
    : connection === 'connecting'
      ? { text: 'Connecting…', cls: 's-badge-muted' }
      : updating
        ? { text: 'Updating…', cls: 's-badge-blue' }
        : shownError
          ? { text: "Couldn't show this change", cls: 's-badge-amber' }
          : { text: 'Live page', cls: 's-badge-teal' }

  const host = storefrontHost()

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
        <div className="inline-flex rounded-lg border border-s-border bg-s-surface p-0.5" role="group" aria-label="Device">
          {(['phone', 'tablet', 'desktop'] as const).map((d) => {
            const Icon = d === 'phone' ? Smartphone : d === 'tablet' ? Tablet : Monitor
            return (
              <button key={d} type="button" onClick={() => setDevice(d)} aria-pressed={device === d} title={DEVICES[d].label}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-semibold ${device === d ? 'bg-primary text-primary-on' : 'text-s-muted hover:text-s-text'}`}>
                <Icon size={13} aria-hidden /> <span className="hidden xl:inline">{DEVICES[d].label}</span>
              </button>
            )
          })}
        </div>
        <span className="text-s-muted tabular-nums">{dev.label} · {dev.w}×{dev.h}{k > 0 ? ` · ${Math.round(k * 100)}%` : ''}</span>
        <span className={statusChip.cls} title={shownError ?? undefined} aria-live="polite">{statusChip.text}</span>
        <button type="button" onClick={() => setMount((n) => n + 1)} disabled={!src} className="s-btn-ghost text-xs inline-flex items-center gap-1" title="Reload the live page">
          <RotateCw size={12} aria-hidden /> Reload
        </button>
        {toolbarExtra}
      </div>

      {shownError && connection === 'live' && !updating && (
        <p className="rounded-lg border border-s-amber/40 bg-s-amber-dim px-3 py-1.5 text-[11px] text-s-amber" role="status">
          {shownError} Your edit is kept.
        </p>
      )}

      {/* Stage */}
      <div ref={stageRef} className="relative flex-1 min-h-0 overflow-hidden rounded-xl border border-s-border bg-s-bg-soft">
        {src && k > 0 && (
          <div className="absolute overflow-hidden rounded-lg border border-s-border bg-s-surface shadow-card"
            style={{ width: boxW, height: boxH, left: Math.max(0, Math.floor((stage.w - boxW) / 2)), top: Math.max(0, Math.floor((stage.h - boxH) / 2)) }}>
            <iframe
              key={mount}
              ref={iframeRef}
              src={src}
              title="Live page preview"
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="strict-origin"
              allow=""
              style={{ width: dev.w, height: dev.h, border: 0, display: 'block', transform: `scale(${k})`, transformOrigin: '0 0' }}
            />
          </div>
        )}

        {contextSlug && connection === 'live' && (
          <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-s-border bg-s-overlay px-3 py-2 text-xs text-s-text shadow-card" role="status">
            <span className="flex-1 min-w-0">That is the live {contextPartName(contextSlug)}. It has its own page in the editor.</span>
            <button type="button" onClick={() => { const s = contextSlug; setContextSlug(null); cb.current.onOpenContext(s) }} className="s-btn-secondary text-xs">Open it</button>
            <button type="button" onClick={() => setContextSlug(null)} aria-label="Dismiss" className="text-s-muted hover:text-s-text"><X size={14} /></button>
          </div>
        )}

        {(connection === 'offline' || connection === 'version' || connection === 'unconfigured') && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-s-bg-soft/95 p-6">
            <div className="s-card max-w-md space-y-3 p-5 text-sm" role="alert">
              {connection === 'version'
                ? <p className="text-s-text">The storefront runs a different editor version. Reload after the update.</p>
                : connection === 'unconfigured'
                  ? <p className="text-s-text">The live page can&apos;t be shown: the storefront address ({host}) isn&apos;t a web address. You can keep working: pick elements in Layers, edit them on the right and save your draft.</p>
                  : <p className="text-s-text">The live page can&apos;t be shown right now. The storefront at {host} didn&apos;t answer. You can keep working: pick elements in Layers, edit them on the right and save your draft.</p>}
              {connection !== 'unconfigured' && (
                <button type="button" onClick={() => setMount((n) => n + 1)} className="s-btn-primary text-xs">Try again</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
})
