'use client'

/**
 * The buddy: one small SVG food character that keeps you company, bottom-left,
 * on every servd hub page (never on a brand microsite, never on simmer).
 *
 *  - On the home page it waits for the hero to leave, then hops in. Everywhere
 *    else it is there from the first paint (screenshot-safe: pure SVG + CSS).
 *  - When the footer's closing-shift crew comes into view it waves and hops
 *    down "home" to them, and comes back when the footer leaves.
 *  - It catches every add-to-cart: `emitCrowd({ type: 'catch', x, y, label })`
 *    flies a sticker token from the Add button into its arms.
 *  - It keeps Karachi time: it sleeps at night until you poke it.
 *  - Tap it for a "right now" card with live kitchen status.
 *
 * Everything decorative is aria-hidden; announcements go through one polite
 * live region. Reduced motion: static poses, no flight, no hops, no tuck
 * animation.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type RefObject,
} from 'react'
import { CrowdCameo, type CameoPose } from './cast/CrowdCameo'
import { onCrowd, emitCrowd, type CrowdEvent } from '../characters/crowdBus'
import { kindForDish, type CharacterKind } from '../characters/types'
import { useWorld } from '../../lib/world/useWorld'
import { useKitchens } from '../../lib/world/kitchens'
import { kitchenLine, openCountLine } from '../../lib/world/voice'
import type { KitchenSlug } from '../../lib/world/kitchenCore'
import { formatBrandName } from '../../lib/concept'
import { useOnBrandMicrosite } from '../../lib/host'
import { companionFor } from './companionRoutes'
import s from './companion.module.css'

const STORAGE_KEY = 'servd:buddy'
const FLIGHT_MS = 620
const CATCH_LEAD_MS = 150
const CATCH_SPACING_MS = 180
const SUMMON_MS = 380
const BUBBLE_CATCH_MS = 2200
const WAKE_MS = 10_000
const TUCK_RETURN_MS = 500
/** Drawn at desktop size; CSS scales it to 60px at ≤640px so SSR is exact. */
const BUDDY_PX = 84

const KITCHEN_HREF: Record<KitchenSlug, string> = {
  stackd: '/stackd',
  simmer: '/brand/simmer',
  flipd: '/flipd',
}

type Look = 'center' | 'left' | 'right' | 'up'
type Mood = Extract<CrowdEvent, { type: 'react' }>['mood']

interface Token {
  id: number
  kind: CharacterKind
  x: number
  y: number
  bubble: string
  announce: string
}

function truncate(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function moodPose(mood: Mood): CameoPose {
  switch (mood) {
    case 'surprised':
    case 'proud':
    case 'happy':
      return 'cheer'
    case 'concerned':
      return 'worried'
    case 'curious':
      return 'peek'
    case 'sleepy':
      return 'sleep'
    default:
      return 'idle'
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const sync = () => setReduced(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return reduced
}

function vibrate() {
  try {
    navigator.vibrate?.(8)
  } catch {
    /* unsupported or blocked — the catch is still a catch */
  }
}

export function Companion({ initialBrandSlug }: { initialBrandSlug?: string | null }) {
  const pathname = usePathname() ?? '/'
  const onMicrosite = useOnBrandMicrosite(initialBrandSlug ?? null)
  const world = useWorld()
  const kitchens = useKitchens()
  const reduced = useReducedMotion()
  const route = companionFor(pathname, world.dayPart)
  const isHome = pathname === '/'
  const active = route.show && !onMicrosite

  const cardId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const squashRef = useRef<HTMLSpanElement>(null)

  // ── visibility ────────────────────────────────────────────────────────────
  const [off, setOff] = useState(false)
  const [scrolledPast, setScrolledPast] = useState(false)
  const [heroStage, setHeroStage] = useState<boolean | null>(null)
  const [footerIn, setFooterIn] = useState(false)
  const [pastTop, setPastTop] = useState(false)
  const [summoned, setSummoned] = useState(false)
  const [tucked, setTucked] = useState(false)
  const [open, setOpen] = useState(false)
  const footerFromBus = useRef(false)

  // ── expression ────────────────────────────────────────────────────────────
  const [flash, setFlash] = useState<CameoPose | null>(null)
  const [look, setLook] = useState<Look>('center')
  const [awakeUntil, setAwakeUntil] = useState(0)
  const [bubble, setBubble] = useState<{ text: string; key: number } | null>(null)
  const [announce, setAnnounce] = useState('')
  const [tokens, setTokens] = useState<Token[]>([])
  const [swapped, setSwapped] = useState(false)

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t)
      fn()
    }, ms)
    timers.current.add(t)
    return t
  }, [])
  useEffect(() => {
    const set = timers.current
    return () => {
      set.forEach(clearTimeout)
      set.clear()
    }
  }, [])

  // Session opt-out.
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(STORAGE_KEY) === 'off') setOff(true)
    } catch {
      /* storage blocked: the buddy just stays */
    }
  }, [])

  // A new page: close the card, forget the old hero.
  useEffect(() => {
    setOpen(false)
    setHeroStage(null)
    setSummoned(false)
  }, [pathname])

  // Kind swaps after mount (the clock lands, or a new kitchen) pop in, rather
  // than silently changing costume.
  const kindRef = useRef(route.kind)
  useEffect(() => {
    if (kindRef.current !== route.kind) {
      kindRef.current = route.kind
      setSwapped(true)
    }
  }, [route.kind])

  // ── scroll: hero exit, footer guard, mobile tuck ─────────────────────────
  useEffect(() => {
    if (!active) return
    let raf = 0
    let lastY = window.scrollY
    let lastT = performance.now()
    let tuckTimer: ReturnType<typeof setTimeout> | undefined
    const mobile = window.matchMedia?.('(max-width: 640px)')

    const measure = () => {
      raf = 0
      const y = window.scrollY
      const now = performance.now()
      const dy = y - lastY
      const dt = Math.max(1, now - lastT)
      lastY = y
      lastT = now
      setScrolledPast(isHome && y > window.innerHeight * 0.6)
      setPastTop(y > 120)

      if (mobile?.matches) {
        if (dy > 0 && dy / dt > 0.6 && y > 80) setTucked(true)
        else if (dy < 0) setTucked(false)
        if (tuckTimer) clearTimeout(tuckTimer)
        tuckTimer = setTimeout(() => setTucked(false), TUCK_RETURN_MS)
      }
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
      if (tuckTimer) clearTimeout(tuckTimer)
    }
  }, [active, isHome])

  // Footer fallback: if the footer crew never reports in on the bus, watch
  // the <footer> ourselves.
  useEffect(() => {
    if (!active || typeof IntersectionObserver === 'undefined') return
    const footer = document.querySelector('footer')
    if (!footer) return
    const io = new IntersectionObserver(
      (entries) => {
        if (footerFromBus.current) return
        const e = entries[entries.length - 1]
        if (e) setFooterIn(e.isIntersecting)
      },
      { threshold: 0.3 },
    )
    io.observe(footer)
    return () => io.disconnect()
  }, [active, pathname])

  const heroGone = scrolledPast || heroStage === false
  // Only go home at the footer after a real scroll: on a short page the
  // footer is in view from the start and the buddy should still be there.
  const goneHome = footerIn && pastTop
  const visible = active && !off && (summoned || ((!isHome || heroGone) && !goneHome))
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const state: 'in' | 'out' | 'tucked' = !visible ? 'out' : tucked && !open ? 'tucked' : 'in'

  // Heading home: wave first, then the CSS hop does the rest.
  const wasGoneHome = useRef(goneHome)
  useEffect(() => {
    if (goneHome && !wasGoneHome.current) {
      setOpen(false)
      setFlash('wave')
      later(() => setFlash(null), 900)
    }
    wasGoneHome.current = goneHome
  }, [goneHome, later])

  // ── pose machine ──────────────────────────────────────────────────────────
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flashPose = useCallback(
    (pose: CameoPose, ms: number) => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current)
        timers.current.delete(flashTimer.current)
      }
      setFlash(pose)
      flashTimer.current = later(() => {
        flashTimer.current = null
        setFlash(null)
      }, ms)
    },
    [later],
  )

  const now = Date.now()
  const night = world.ready && world.dayPart === 'night'
  const sleeping = night && !open && now >= awakeUntil
  const pose: CameoPose = flash ?? (sleeping ? 'sleep' : 'idle')
  const lively = world.ready && !sleeping && world.energy >= 0.8

  // Re-render when the wake window runs out so he nods back off.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (awakeUntil <= Date.now()) return
    const t = setTimeout(() => forceTick((n) => n + 1), awakeUntil - Date.now() + 20)
    return () => clearTimeout(t)
  }, [awakeUntil])

  const showBubble = useCallback(
    (text: string, ms: number) => {
      setBubble({ text, key: Date.now() })
      later(() => setBubble((b) => (b && Date.now() - b.key >= ms - 20 ? null : b)), ms)
    },
    [later],
  )

  // ── idle acts every 8–14 s (faster when the kitchens are busy) ───────────
  const mouseLooking = useRef(false)
  useEffect(() => {
    if (!visible || reduced || sleeping || open) return
    const [lo, hi] = lively ? [5000, 9000] : [8000, 14000]
    let cancelled = false
    let t: ReturnType<typeof setTimeout>
    const schedule = () => {
      t = setTimeout(act, lo + Math.random() * (hi - lo))
    }
    const act = () => {
      if (cancelled) return
      const acts: Array<() => void> = [
        () => flashPose('wave', 1400),
        () => {
          if (mouseLooking.current) return
          setLook(Math.random() < 0.7 ? 'right' : 'up')
          later(() => !mouseLooking.current && setLook('center'), 1800)
        },
      ]
      if (route.kind === 'coffee') acts.push(() => flashPose('sip', 1800))
      const pick = acts[Math.floor(Math.random() * acts.length)]
      pick?.()
      schedule()
    }
    schedule()
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [visible, reduced, sleeping, open, lively, route.kind, flashPose, later])

  // ── mouse look ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible || reduced || sleeping) return
    const fine = window.matchMedia?.('(hover: hover) and (pointer: fine)')
    if (!fine?.matches) return
    let raf = 0
    let px = 0
    let py = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    let current: Look = 'center'
    const apply = () => {
      raf = 0
      const el = buttonRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const dx = px - (r.left + r.width / 2)
      const dy = py - (r.top + r.height / 2)
      let next: Look
      if (Math.hypot(dx, dy) < 60) next = 'center'
      else if (dy < 0 && Math.abs(dx) < Math.abs(dy) * 0.6) next = 'up'
      else next = dx >= 0 ? 'right' : 'left'
      if (next !== current) {
        current = next
        setLook(next)
      }
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return
      mouseLooking.current = true
      px = e.clientX
      py = e.clientY
      if (!raf) raf = requestAnimationFrame(apply)
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        mouseLooking.current = false
        current = 'center'
        setLook('center')
      }, 2600)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      if (raf) cancelAnimationFrame(raf)
      if (idle) clearTimeout(idle)
      mouseLooking.current = false
    }
  }, [visible, reduced, sleeping])

  // ── the catch ─────────────────────────────────────────────────────────────
  const nextLaunch = useRef(0)
  const tokenSeq = useRef(0)
  const summonTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const routeRef = useRef(route)
  routeRef.current = route
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const offRef = useRef(off)
  offRef.current = off
  const activeRef = useRef(active)
  activeRef.current = active

  const holdSummon = useCallback(
    (ms: number) => {
      setSummoned(true)
      if (summonTimer.current) {
        clearTimeout(summonTimer.current)
        timers.current.delete(summonTimer.current)
      }
      summonTimer.current = later(() => {
        summonTimer.current = null
        setSummoned(false)
      }, ms)
    },
    [later],
  )

  const land = useCallback(
    (t: Pick<Token, 'bubble' | 'announce'>) => {
      const el = squashRef.current
      if (el && !reducedRef.current && typeof el.animate === 'function') {
        el.animate(
          [
            { transform: 'scale(1, 1)' },
            { transform: 'scale(1.1, 0.82)', offset: 0.3 },
            { transform: 'scale(0.97, 1.08)', offset: 0.68 },
            { transform: 'scale(1, 1)' },
          ],
          { duration: 260, easing: 'ease-out' },
        )
      }
      flashPose('cheer', 1300)
      showBubble(t.bubble, BUBBLE_CATCH_MS)
      setAnnounce(t.announce)
      vibrate()
    },
    [flashPose, showBubble],
  )

  const onTokenNear = useCallback(() => flashPose('catch', CATCH_LEAD_MS + 200), [flashPose])
  const onTokenDone = useCallback(
    (tok: Token) => {
      setTokens((list) => list.filter((x) => x.id !== tok.id))
      land(tok)
      holdSummon(3200)
    },
    [land, holdSummon],
  )

  const handleCatch = useCallback(
    (e: Extract<CrowdEvent, { type: 'catch' }>) => {
      if (!activeRef.current || offRef.current) return
      const r = routeRef.current
      const label = (e.label ?? '').trim()
      const bubbleText = label ? `+1 ${truncate(label.toLowerCase(), 26)}` : '+1 in the bag'
      const announceText = label ? `added ${label.toLowerCase()}` : 'added to your bag'
      const brandSlug = r.brand === 'servd' ? null : r.brand
      const kind = e.kind ?? (label ? kindForDish(label, brandSlug) : undefined) ?? r.kind

      setTucked(false)
      if (reducedRef.current) {
        if (!visibleRef.current) holdSummon(3200)
        land({ bubble: bubbleText, announce: announceText })
        return
      }

      const needSummon = !visibleRef.current
      holdSummon(3200 + FLIGHT_MS)
      const now = performance.now()
      const at = Math.max(now + (needSummon ? SUMMON_MS : 0), nextLaunch.current + CATCH_SPACING_MS)
      nextLaunch.current = at
      const x = Number.isFinite(e.x) ? e.x : window.innerWidth / 2
      const y = Number.isFinite(e.y) ? e.y : window.innerHeight / 2
      const token: Token = { id: ++tokenSeq.current, kind, x, y, bubble: bubbleText, announce: announceText }
      later(() => setTokens((list) => [...list, token]), Math.max(0, at - now))
    },
    [holdSummon, land, later],
  )

  // ── the bus ───────────────────────────────────────────────────────────────
  useEffect(() => {
    return onCrowd((e: CrowdEvent) => {
      switch (e.type) {
        case 'stage':
          if (e.id === 'hero') setHeroStage(e.visible)
          else if (e.id === 'footer') {
            footerFromBus.current = true
            setFooterIn(e.visible)
          }
          break
        case 'catch':
          handleCatch(e)
          break
        case 'say': {
          const text = truncate(e.text, 48)
          showBubble(text, Math.max(1, e.seconds ?? 4) * 1000)
          setAnnounce(text)
          break
        }
        case 'react':
          flashPose(moodPose(e.mood), Math.max(0.6, e.seconds ?? 2.4) * 1000)
          break
        case 'cheer':
          if (!e.kind || e.kind === routeRef.current.kind) flashPose('cheer', 1200)
          break
        case 'look': {
          if (mouseLooking.current) break
          const el = buttonRef.current
          if (!el) break
          const r = el.getBoundingClientRect()
          const dx = e.x - (r.left + r.width / 2)
          const dy = e.y - (r.top + r.height / 2)
          setLook(dy < 0 && Math.abs(dx) < Math.abs(dy) * 0.6 ? 'up' : dx >= 0 ? 'right' : 'left')
          later(() => !mouseLooking.current && setLook('center'), 1600)
          break
        }
        default:
          break
      }
    })
  }, [handleCatch, showBubble, flashPose, later])

  // ── the "right now" card ─────────────────────────────────────────────────
  const close = useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
      }
    }
    const onDown = (e: PointerEvent) => {
      const root = rootRef.current
      if (!root || root.contains(e.target as Node)) return
      const focusInside = root.contains(document.activeElement)
      close(focusInside)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, close])

  const onBuddy = () => {
    if (sleeping) {
      // Poked awake: a start, then ten seconds of being very much awake. The
      // stage crowd flinches with him.
      setAwakeUntil(Date.now() + WAKE_MS)
      flashPose('cheer', 900)
      emitCrowd({ type: 'react', mood: 'surprised', seconds: 1.4 })
    }
    setOpen((v) => !v)
  }

  const hide = () => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, 'off')
    } catch {
      /* no storage: hidden for this page view only */
    }
    setOpen(false)
    setOff(true)
  }

  const countLine = useMemo(
    () => openCountLine(kitchens.openCount, kitchens.total, world.dayPart),
    [kitchens.openCount, kitchens.total, world.dayPart],
  )

  if (!active || off) return null

  return (
    <>
      <div ref={rootRef} className={s.root} data-brand={route.brand} data-state={state}>
        <div className={s.hop} data-state={state} aria-hidden={state === 'out' ? true : undefined}>
          {bubble && !open ? (
            <span key={bubble.key} className={s.bubble} aria-hidden="true">
              {bubble.text}
            </span>
          ) : null}

          {open ? (
            <div id={cardId} className={s.card} role="region" aria-label="right now">
              <p className={s.cardEyebrow}>
                right now{world.ready ? ` · ${world.clock}` : ''}
              </p>
              <p className={s.cardTitle}>{countLine}</p>
              <ul className={s.rows}>
                {kitchens.list.map((k) => (
                  <li key={k.slug}>
                    <Link
                      href={KITCHEN_HREF[k.slug]}
                      className={s.row}
                      onClick={() => setOpen(false)}
                    >
                      <span className={s.dot} data-phase={k.phase} aria-hidden="true" />
                      <span className={s.rowText}>
                        <span className={s.rowName}>{formatBrandName(k.name)}</span>
                        <span className={s.rowLine}>{kitchenLine(k, world.dayPart)}</span>
                      </span>
                      <svg className={s.rowArrow} viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  </li>
                ))}
              </ul>
              <button type="button" className={s.hideBtn} onClick={hide}>
                hide buddy
              </button>
            </div>
          ) : null}

          <button
            ref={buttonRef}
            type="button"
            className={s.buddy}
            aria-label="right now: which kitchens are open"
            aria-expanded={open}
            aria-controls={open ? cardId : undefined}
            tabIndex={state === 'out' ? -1 : 0}
            onClick={onBuddy}
            data-lively={lively && pose === 'idle' && !reduced ? '1' : undefined}
          >
            <span ref={squashRef} className={s.squash}>
              <span className={s.sway}>
                <span key={route.kind} className={`${s.scaleBox} ${swapped ? s.swapIn : ''}`}>
                  <CrowdCameo
                    kind={route.kind}
                    size={BUDDY_PX}
                    pose={pose}
                    look={pose === 'sleep' ? 'center' : look}
                    animate={!reduced}
                  />
                </span>
              </span>
            </span>
          </button>
        </div>
      </div>

      {tokens.length > 0 ? (
        <div className={s.tokenLayer} aria-hidden="true">
          {tokens.map((t) => (
            <FlyingToken
              key={t.id}
              token={t}
              target={rootRef}
              onNear={onTokenNear}
              onDone={onTokenDone}
            />
          ))}
        </div>
      ) : null}

      <span className={s.srOnly} aria-live="polite" role="status">
        {announce}
      </span>
    </>
  )
}

/**
 * One die-cut sticker token flying a parabola from the Add button into the
 * buddy's hands. Web Animations API with offset keyframes: compositor-only
 * (transform), 620 ms, one full turn, 1 → 0.7 scale.
 */
function FlyingToken({
  token,
  target,
  onNear,
  onDone,
}: {
  token: Token
  /** The fixed, untransformed root: where the buddy stands once he is in,
   *  even while he is still mid-hop or tucked. */
  target: RefObject<HTMLDivElement>
  onNear: () => void
  onDone: (t: Token) => void
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const done = useRef(false)

  useLayoutEffect(() => {
    const el = ref.current
    const tgt = target.current
    const finish = () => {
      if (done.current) return
      done.current = true
      onDone(token)
    }
    if (!el || !tgt || typeof el.animate !== 'function') {
      onNear()
      finish()
      return
    }
    const r = tgt.getBoundingClientRect()
    const tx = r.left + r.width * 0.5
    const ty = r.top + r.height * 0.52
    const x0 = token.x
    const y0 = token.y
    const dist = Math.hypot(tx - x0, ty - y0)
    const lift = Math.min(220, Math.max(70, dist * 0.35))
    const steps = 16
    const frames: Keyframe[] = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = x0 + (tx - x0) * t
      const y = y0 + (ty - y0) * t - lift * 4 * t * (1 - t)
      const scale = 1 - 0.3 * t
      frames.push({
        offset: t,
        transform: `translate(${(x - 22).toFixed(1)}px, ${(y - 22).toFixed(1)}px) rotate(${(360 * t).toFixed(1)}deg) scale(${scale.toFixed(3)})`,
      })
    }
    const anim = el.animate(frames, { duration: FLIGHT_MS, easing: 'cubic-bezier(.3,.1,.5,1)', fill: 'forwards' })
    const near = setTimeout(onNear, FLIGHT_MS - CATCH_LEAD_MS)
    anim.onfinish = finish
    anim.oncancel = finish
    return () => {
      // Not finish(): under StrictMode's effect re-run the flight restarts,
      // and on a real unmount the whole layer is gone anyway.
      clearTimeout(near)
      anim.onfinish = null
      anim.oncancel = null
      anim.cancel()
    }
    // A token flies exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <span
      ref={ref}
      className={s.token}
      style={{ transform: `translate(${token.x - 22}px, ${token.y - 22}px)` }}
    >
      <CrowdCameo kind={token.kind} size={30} pose="cheer" animate={false} />
    </span>
  )
}
