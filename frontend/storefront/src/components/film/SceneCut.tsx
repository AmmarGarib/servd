'use client'
// SceneCut — every page change on the storefront plays as a set-piece cut.
//
//   cover   420ms  the clicked element's own rectangle grows into a full-frame
//                  title card for the destination (clip-path inset → 0)
//   hold           the router navigates underneath; we wait for the pathname
//                  to change (+2 frames), at least 140ms and never more than
//                  1400ms, then jump the page to the top
//   reveal  480ms  the card opens in the destination brand's own manner:
//                  servd lifts on a wavy hem · stackd peels off like a sticker
//                  · Flipd splits as a checker shutter · simmer's doors part
//   done           Lenis restarts, focus lands on #main, the title is
//                  announced to screen readers
//
// Interception is a window capture-phase click listener. It only ever calls
// preventDefault (never stopPropagation), so an anchor's own onClick still
// runs, and next/link sees `defaultPrevented` and skips its own navigation.
// Back/forward never cuts, and under reduced motion nothing is intercepted.
//
// Mounted once, in the root layout, after <main>.

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { motion, type Transition } from 'framer-motion'
import {
  __emitCut,
  __registerCutRunner,
  cutThemeFor,
  cutTitleFor,
  filmCase,
  type CutOptions,
  type CutTheme,
} from '../../lib/film/cut'
import { EASE_CUT, SPRING_POP, usePrefersReducedMotion } from '../../lib/film/motion'
import { sfx } from '../../lib/film/sfx'
import { TitleCard } from './Slate'
import { BrandArt } from '../party/loader/BrandLoader'
import { CrowdPoster } from '../party/loader/CrowdPoster'
import s from './film.module.css'

const COVER_S = 0.42
const REVEAL_S = 0.48
const HOLD_MIN_MS = 140
const HOLD_MAX_MS = 1400
const CLIP_FULL = 'inset(0px 0px 0px 0px round 0px)'
const THEMES: readonly CutTheme[] = ['servd', 'simmer', 'stackd', 'flipd']

type Phase = 'cover' | 'hold' | 'reveal'

interface Shot {
  id: number
  href: string        // path + search + hash, same-origin
  path: string        // pathname only, for the "did we arrive" check
  hasHash: boolean
  theme: CutTheme
  kicker: string
  title: string
  stamp?: string
  clipFrom: string
  replace: boolean
}

const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/'

function reducedNow(): boolean {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/** clip-path inset() that frames `rect` inside the viewport. */
function clipFor(rect: DOMRect | null | undefined): string {
  const w = document.documentElement.clientWidth || window.innerWidth
  const h = window.innerHeight
  let r = rect
  if (!r || !(r.width > 0 && r.height > 0)) {
    r = new DOMRect(w / 2 - 0.5, h / 2 - 0.5, 1, 1)
  }
  const cl = (v: number, max: number) => Math.max(0, Math.min(max, v))
  const top = cl(r.top, h - 1)
  const left = cl(r.left, w - 1)
  const right = cl(w - r.right, w - left - 1)
  const bottom = cl(h - r.bottom, h - top - 1)
  const px = (v: number) => `${Math.round(v * 10) / 10}px`
  return `inset(${px(top)} ${px(right)} ${px(bottom)} ${px(left)} round 24px)`
}

/** Should this anchor click become a cut? Returns the resolved URL or null. */
function qualify(a: HTMLAnchorElement): URL | null {
  const target = a.getAttribute('target')
  if (target && target !== '_self') return null
  if (a.hasAttribute('download')) return null
  if ((a.getAttribute('rel') ?? '').split(/\s+/).includes('external')) return null
  if (a.closest('[data-no-cut]')) return null
  const raw = a.getAttribute('href')
  if (!raw || raw.startsWith('#')) return null
  let url: URL
  try { url = new URL(a.href, window.location.href) } catch { return null }
  if (url.origin !== window.location.origin) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return null
  const last = url.pathname.split('/').pop() ?? ''
  if (/\.[a-z0-9]{1,8}$/i.test(last)) return null
  if (norm(url.pathname) === norm(window.location.pathname)) return null
  return url
}

export function SceneCut() {
  const router = useRouter()
  const pathname = usePathname() ?? '/'
  const reduced = usePrefersReducedMotion()

  const [shot, setShot] = useState<Shot | null>(null)
  const [phase, setPhase] = useState<Phase>('cover')
  const [announce, setAnnounce] = useState('')

  const running = useRef(false)
  const shotRef = useRef<Shot | null>(null)
  const phaseRef = useRef<Phase>('cover')
  const pathRef = useRef(pathname)
  const hold = useRef<{ from: string; at: number; settled: boolean } | null>(null)
  const timers = useRef<number[]>([])
  const rafs = useRef<number[]>([])
  const idRef = useRef(0)

  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)) }
  const frame = (fn: () => void) => { rafs.current.push(window.requestAnimationFrame(fn)) }
  const clearAll = () => {
    timers.current.forEach((t) => window.clearTimeout(t))
    rafs.current.forEach((r) => window.cancelAnimationFrame(r))
    timers.current = []
    rafs.current = []
  }

  const go = (p: Phase) => { phaseRef.current = p; setPhase(p) }

  /* ── start ──────────────────────────────────────────────────────── */
  const start = useCallback((href: string, opts: CutOptions): boolean => {
    if (running.current || reducedNow()) return false
    let url: URL
    try { url = new URL(href, window.location.href) } catch { return false }
    if (url.origin !== window.location.origin) return false

    const rel = `${url.pathname}${url.search}${url.hash}`
    const named = cutTitleFor(rel)
    const theme = opts.theme && THEMES.includes(opts.theme) ? opts.theme : cutThemeFor(rel)
    const next: Shot = {
      id: ++idRef.current,
      href: rel,
      path: url.pathname,
      hasHash: url.hash.length > 1,
      theme,
      kicker: filmCase(opts.kicker ?? named.kicker),
      title: filmCase(opts.title ?? named.title),
      stamp: opts.stamp || undefined,
      clipFrom: clipFor(opts.origin),
      replace: !!opts.replace,
    }

    running.current = true
    shotRef.current = next
    hold.current = null
    clearAll()
    // Give the router the whole cover as a head start on the next route.
    try { router.prefetch(rel) } catch { /* prefetch is a hint */ }
    go('cover')
    setShot(next)
    __emitCut('cover', rel, theme)
    try { sfx('whoosh', { theme }) } catch { /* foley is optional */ }
    return true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router])

  /* ── finish / abort ─────────────────────────────────────────────── */
  const finish = useCallback((focus: boolean) => {
    const cur = shotRef.current
    clearAll()
    try { window.__lenis?.start() } catch { /* ignore */ }
    running.current = false
    shotRef.current = null
    hold.current = null
    setShot(null)
    go('cover')
    if (!cur) return
    if (focus) {
      const main = document.getElementById('main')
      if (main) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
        try { main.focus({ preventScroll: true }) } catch { main.focus() }
      }
      // Clear first so the same title twice in a row is still announced.
      setAnnounce('')
      frame(() => setAnnounce(`${cur.kicker} ${cur.title}`.trim()))
    }
    __emitCut('done', cur.href, cur.theme)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── hold → reveal ──────────────────────────────────────────────── */
  const toReveal = useCallback(() => {
    const cur = shotRef.current
    const h = hold.current
    if (!cur || !h || h.settled) return
    h.settled = true
    const wait = Math.max(0, HOLD_MIN_MS - (performance.now() - h.at))
    later(() => {
      frame(() => frame(() => {
        if (shotRef.current !== cur) return
        if (!cur.hasHash) {
          try { window.__lenis?.scrollTo(0, { immediate: true, force: true }) } catch { /* ignore */ }
          window.scrollTo(0, 0)
        }
        go('reveal')
        __emitCut('reveal', cur.href, cur.theme)
      }))
    }, wait)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCovered = useCallback(() => {
    const cur = shotRef.current
    if (!cur || phaseRef.current !== 'cover') return
    go('hold')
    __emitCut('hold', cur.href, cur.theme)
    try { window.__lenis?.stop() } catch { /* ignore */ }
    hold.current = { from: pathRef.current, at: performance.now(), settled: false }
    try {
      // We scroll to the top ourselves once the new page is in; let Next
      // handle it only when there is a #fragment to land on.
      if (cur.replace) router.replace(cur.href, { scroll: cur.hasHash })
      else router.push(cur.href, { scroll: cur.hasHash })
    } catch {
      window.location.assign(cur.href)
      return
    }
    // Never trap the viewer behind the card.
    later(toReveal, HOLD_MAX_MS)
    // A cut to the page we're already on (a requestCut with a new ?query)
    // has no pathname change to wait for.
    if (norm(cur.path) === norm(pathRef.current)) toReveal()
  }, [router, toReveal])

  const onRevealed = useCallback(() => {
    if (phaseRef.current !== 'reveal') return
    finish(true)
  }, [finish])

  /* ── arrival: the pathname changed under the card ───────────────── */
  useEffect(() => {
    pathRef.current = pathname
    const h = hold.current
    if (phaseRef.current === 'hold' && h && norm(pathname) !== norm(h.from)) toReveal()
  }, [pathname, toReveal])

  /* ── the runner requestCut() calls ──────────────────────────────── */
  useEffect(() => {
    __registerCutRunner((href, opts) => start(href, opts))
    return () => __registerCutRunner(null)
  }, [start])

  /* ── interception ───────────────────────────────────────────────── */
  useEffect(() => {
    if (reduced) return
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const el = e.target instanceof Element ? e.target : null
      const a = el?.closest('a[href]')
      if (!(a instanceof HTMLAnchorElement)) return
      const url = qualify(a)
      if (!url) return
      // A second click (or Enter) mid-cut must not start a second navigation.
      if (running.current) { e.preventDefault(); return }
      if (reducedNow()) return
      let origin = a.getBoundingClientRect()
      if (!(origin.width > 0 && origin.height > 0) && el) origin = el.getBoundingClientRect()
      const d = a.dataset
      const opts: CutOptions = { origin }
      if (d['cutKicker'] !== undefined) opts.kicker = d['cutKicker']
      if (d['cutTitle'] !== undefined) opts.title = d['cutTitle']
      if (d['cutStamp']) opts.stamp = d['cutStamp']
      const th = d['cutTheme'] as CutTheme | undefined
      if (th && THEMES.includes(th)) opts.theme = th
      if (start(`${url.pathname}${url.search}${url.hash}`, opts)) e.preventDefault()
    }
    window.addEventListener('click', onClick, { capture: true })
    return () => window.removeEventListener('click', onClick, { capture: true })
  }, [reduced, start])

  /* ── back/forward: never a cut; drop one in flight ──────────────── */
  useEffect(() => {
    const onPop = () => { if (running.current) finish(false) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [finish])

  // Unmount safety: never leave Lenis stopped.
  useEffect(() => () => {
    clearAll()
    if (running.current) { try { window.__lenis?.start() } catch { /* ignore */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <>
      <div className="film-sr-live" aria-live="polite" role="status">{announce}</div>
      {shot && (
        <motion.div
          key={shot.id}
          className={s.cut}
          aria-hidden="true"
          data-film-cut={shot.theme}
          data-phase={phase}
          initial={{ clipPath: shot.clipFrom }}
          animate={{ clipPath: CLIP_FULL }}
          transition={{ duration: COVER_S, ease: EASE_CUT }}
          onAnimationComplete={onCovered}
        >
          <Frame shot={shot} phase={phase} onRevealed={onRevealed} />
        </motion.div>
      )}
    </>
  )
}

/* ── The frame and its four reveals ─────────────────────────────── */

function Card({ shot, id }: { shot: Shot; id: string }) {
  const stamp = shot.stamp ? (
    <motion.span
      className={s.stamp}
      initial={{ scale: 1.4, opacity: 0, rotate: -8 }}
      animate={{ scale: 1, opacity: 1, rotate: -8 }}
      transition={{ ...SPRING_POP, delay: COVER_S * 0.55 }}
    >
      {shot.stamp}
    </motion.span>
  ) : undefined
  return (
    <TitleCard
      theme={shot.theme}
      kicker={shot.kicker}
      title={shot.title}
      stamp={stamp}
      rise
      art={<BrandArt theme={shot.theme} />}
      floor={shot.theme === 'servd' ? <CrowdPoster id={id} /> : undefined}
    />
  )
}

function Frame({ shot, phase, onRevealed }: { shot: Shot; phase: Phase; onRevealed: () => void }) {
  const open = phase === 'reveal'
  const tr: Transition = { duration: REVEAL_S, ease: EASE_CUT }
  const done = open ? onRevealed : undefined

  if (shot.theme === 'servd') {
    // The butter sheet lifts off the top, trailing a wavy hem.
    return (
      <motion.div
        className={`${s.panel} ${s.withHem}`}
        initial={false}
        animate={{ y: open ? '-100%' : '0%' }}
        transition={tr}
        onAnimationComplete={done}
      >
        <div className={s.sheet}><Card shot={shot} id={`cut${shot.id}`} /></div>
        <svg className={s.hem} viewBox="0 0 1200 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <path d="M0 0H1200V22C1150 22 1125 48 1075 48S1000 22 950 22S875 48 825 48S750 22 700 22S625 48 575 48S500 22 450 22S375 48 325 48S250 22 200 22S125 48 75 48S25 22 0 22Z" fill="#FFD447" />
        </svg>
      </motion.div>
    )
  }

  if (shot.theme === 'stackd') {
    // A sticker peel: it lifts from the bottom-left corner, then slides off
    // to the top-right.
    return (
      <motion.div
        className={`${s.panel} ${open ? s.peeling : ''}`}
        style={{ originX: 0, originY: 1 }}
        initial={false}
        animate={open
          ? { rotate: [0, -8, -12], x: ['0%', '3%', '75%'], y: ['0%', '-5%', '-125%'] }
          : { rotate: 0, x: '0%', y: '0%' }}
        transition={open ? { duration: REVEAL_S, times: [0, 0.32, 1], ease: ['easeOut', [0.64, 0, 0.78, 0]] } : { duration: 0 }}
        onAnimationComplete={done}
      >
        <Card shot={shot} id={`cut${shot.id}`} />
      </motion.div>
    )
  }

  // flipd: a checker shutter (top/bottom) · simmer: doors (left/right).
  const flipd = shot.theme === 'flipd'
  const [a, b] = flipd ? [s.halfT, s.halfB] : [s.halfL, s.halfR]
  const away = (dir: -1 | 1) => (flipd ? { y: open ? `${dir * 100}%` : '0%' } : { x: open ? `${dir * 100}%` : '0%' })
  return (
    <div className={`${s.panel} ${open ? s.parting : ''}`}>
      <motion.div className={`${s.half} ${a}`} initial={false} animate={away(-1)} transition={tr} onAnimationComplete={done}>
        <div className={s.inner}><Card shot={shot} id={`cut${shot.id}a`} /></div>
        {flipd ? <span className={s.lip} /> : <span className={s.seam} />}
      </motion.div>
      <motion.div className={`${s.half} ${b}`} initial={false} animate={away(1)} transition={tr}>
        <div className={s.inner}><Card shot={shot} id={`cut${shot.id}b`} /></div>
        {flipd ? <span className={s.lip} /> : <span className={s.seam} />}
      </motion.div>
    </div>
  )
}

export default SceneCut
