'use client'
// The route curtain: a thin panel in the DESTINATION's ground colour that
// sweeps in from the click point, holds while the next route resolves, then
// lifts away.
//
//   simmer  #06392F, flat — no characters, no gradient (brand bible)
//   stackd  the plum field
//   Flipd   the mustard field
//   hub     the current world sky
//
// Triggered by a window capture-phase click listener on same-origin <a> whose
// pathname differs from the current one (capture, because Next's <Link>
// calls preventDefault in React's own listener, which would otherwise hide
// every client navigation from us). It never runs on a hard load, is off
// under reduced motion, is aria-hidden, and cannot trap the page: it reveals
// on the pathname change, the moment a route loader says it is showing, or
// after 1200 ms regardless.

import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { BRAND_REWRITE_PATHS, resolveBrandSlug } from '../../lib/brandDomains'
import { asKitchenSlug, type KitchenSlug } from '../../lib/world/kitchenCore'
import s from './world.module.css'

type Dest = KitchenSlug | 'hub'
type Phase = 'idle' | 'cover' | 'reveal'

interface CurtainState { phase: Phase; dest: Dest; x: number; y: number; n: number }

const COVER_MS = 200
const REVEAL_MS = 260
const SAFETY_MS = 1200

const GROUND: Record<Dest, string> = {
  simmer: '#06392F',
  stackd: 'var(--stackd-plum, #7C2946)',
  flipd: 'var(--flipd-mustard, #FED561)',
  hub: 'var(--world-sky-b, #FFD447)',
}

const INTERACTIVE = 'button, input, select, textarea, label, summary, [role="button"], [data-no-curtain]'

function destinationOf(url: URL): Dest {
  const segs = url.pathname.split('/').filter(Boolean)
  if (segs[0] === 'brand') return asKitchenSlug(segs[1]) ?? 'hub'
  const direct = asKitchenSlug(segs[0])
  if (direct) return direct
  // On a brand's own domain, '/', '/menu', '/about', '/visit' are that brand.
  const hostSlug = asKitchenSlug(resolveBrandSlug(window.location.host))
  if (hostSlug && BRAND_REWRITE_PATHS.has(url.pathname)) return hostSlug
  return 'hub'
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

export function RouteCurtain() {
  const pathname = usePathname()
  const [st, setSt] = useState<CurtainState>({ phase: 'idle', dest: 'hub', x: 0, y: 0, n: 0 })
  const fromPath = useRef<string | null>(null)
  const coverAt = useRef(0)
  const timers = useRef<number[]>([])

  const clearTimers = useCallback(() => {
    for (const t of timers.current) window.clearTimeout(t)
    timers.current = []
  }, [])

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }, [])

  const reveal = useCallback((immediate = false) => {
    if (fromPath.current === null) return
    fromPath.current = null
    clearTimers()
    // Never lift a half-drawn cover: let the sweep finish first.
    const wait = immediate ? 0 : Math.max(0, COVER_MS - (performance.now() - coverAt.current))
    later(() => {
      setSt((p) => (p.phase === 'cover' ? { ...p, phase: 'reveal' } : p))
      later(() => setSt((p) => (p.phase === 'reveal' ? { ...p, phase: 'idle' } : p)), REVEAL_MS + 40)
    }, wait)
  }, [clearTimers, later])

  // The trigger.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0) return
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : null
      const a = target?.closest('a')
      if (!a || !(a instanceof HTMLAnchorElement)) return
      // A button inside a card link (add to bag) is not a navigation.
      const inner = target?.closest(INTERACTIVE)
      if (inner && a.contains(inner)) return
      if (a.hasAttribute('download')) return
      if (a.target && a.target !== '_self') return
      const raw = a.getAttribute('href')
      if (!raw || raw.startsWith('#')) return
      let url: URL
      try { url = new URL(a.href, window.location.href) } catch { return }
      if (url.origin !== window.location.origin) return
      if (url.pathname === window.location.pathname) return
      if (reducedMotion()) return

      clearTimers()
      fromPath.current = window.location.pathname
      coverAt.current = performance.now()
      setSt((p) => ({ phase: 'cover', dest: destinationOf(url), x: e.clientX, y: e.clientY, n: p.n + 1 }))
      later(() => reveal(true), SAFETY_MS)
    }
    window.addEventListener('click', onClick, true)
    return () => window.removeEventListener('click', onClick, true)
  }, [clearTimers, later, reveal])

  // The route resolved.
  useEffect(() => {
    if (fromPath.current !== null && pathname !== fromPath.current) reveal()
  }, [pathname, reveal])

  // A route loader is up: get out of its way at once.
  useEffect(() => {
    function onLoader(e: Event) {
      const d = (e as CustomEvent<{ state?: string } | undefined>).detail
      if (d?.state === 'show') reveal(true)
    }
    // Back from the bfcache mid-curtain: start clean.
    function onPageShow(e: PageTransitionEvent) {
      if (!e.persisted) return
      fromPath.current = null
      clearTimers()
      setSt((p) => ({ ...p, phase: 'idle' }))
    }
    window.addEventListener('servd:loader', onLoader)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      window.removeEventListener('servd:loader', onLoader)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [clearTimers, reveal])

  useEffect(() => () => clearTimers(), [clearTimers])

  if (st.phase === 'idle') return null

  const style = {
    '--curtain-ground': GROUND[st.dest],
    '--cx': `${Math.round(st.x)}px`,
    '--cy': `${Math.round(st.y)}px`,
  } as CSSProperties

  const cls = [
    s.curtain,
    st.dest === 'hub' ? s.curtainHub : '',
    st.phase === 'cover' ? s.covering : s.revealing,
  ].filter(Boolean).join(' ')

  return <div key={st.n} aria-hidden="true" className={cls} style={style} data-dest={st.dest} />
}

export default RouteCurtain
