'use client'
// PartyHero: Act I of "servd, the film", the opening shot.
//
// A tall pinned track (#act-1) with a sticky 100svh frame inside. The
// first two screens of scroll play as one directed shot (see
// hero/timeline.ts for the shot list):
//   title card → push-in (camera dollies, copy rises, letterbox closes, the
//   Order CTA docks in the bottom bar) → roll call (stackd, simmer, Flipd
//   lower thirds, with the camera and the cast acting each one) → hand-off
//   (the cast looks down, the letterbox opens, the act ii slate rises).
//
// Snapshot-proof: every value is scrubbed by scroll position, the title
// never leaves, and a CTA is on screen at every offset. The SVG crowd
// poster paints from the first byte and only fades once the WebGL crowd has
// drawn its first frame; without WebGL it simply stays.
//
// Headline + overview stay operator-editable (Admin → Marketing → Landing
// Hero); the headline splits on its comma so "Every kitchen, one place"
// lands as two beats.
//
// Reduced motion: no pin (the global guard makes the track height auto), no
// shot changes, no transforms; a static composed hero followed by a small
// "starring" list.

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import {
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
  type MotionStyle,
  type MotionValue,
} from 'framer-motion'
import type { HeroConfig } from '../../lib/heroConfig'
import { useBeat, useIsCoarsePointer, usePrefersReducedMotion, useScene } from '../../lib/film/motion'
import { requestCut } from '../../lib/film/cut'
import { sfx } from '../../lib/film/sfx'
import { haptic } from '../../lib/haptics'
import { emitCrowd } from '../characters/crowdBus'
import type { FoodCrowdHandle } from '../characters/FoodCrowd'
import { Slate } from '../film/Slate'
import { SkipScene } from '../film/SkipScene'
import film from '../film/film.module.css'
import { CrowdPoster } from './loader/CrowdPoster'
import { useSessionCast, visibleWindow } from './hero/cast'
import { LowerThird, Starring, THIRD_ORDER } from './hero/LowerThird'
import { PartyHat } from './hero/PartyHat'
import {
  BEATS,
  DOCK_AT,
  HANDOFF,
  PUSH,
  THIRDS,
  THIRD_IN,
  activeThird,
  beatAt,
  focusForBeat,
  shotAt,
} from './hero/timeline'
import h from './hero/hero.module.css'
import s from './party.module.css'

const FoodCrowd = dynamic(
  () => import('../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

const BROWSE = '/browse'

function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(' ')
}

/** framer applies MotionValues to CSS custom properties; the style type just doesn't say so. */
function cssVars(vars: Record<`--${string}`, MotionValue<number>>): MotionStyle {
  return vars as MotionStyle
}

function setInert(el: HTMLElement | null | undefined, on: boolean): void {
  if (!el) return
  el.inert = on
  if (on) el.setAttribute('aria-hidden', 'true')
  else el.removeAttribute('aria-hidden')
}

function isPlainPrimaryClick(e: MouseEvent<HTMLAnchorElement>): boolean {
  return !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

function splitTitle(title: string): [string, string | null] {
  const i = title.indexOf(',')
  if (i <= 0 || i >= title.length - 2) return [title, null]
  return [title.slice(0, i + 1), title.slice(i + 1).trim()]
}

// Each word drops in on its own beat; --i drives the stagger in CSS. The
// drop starts at opacity 0.35, so a frame caught mid-drop still reads.
function BouncyWords({ text, offset = 0 }: { text: string; offset?: number }) {
  return (
    <>
      {text.split(' ').map((w, i) => (
        <span key={`${w}-${i}`} className={s.word} style={{ '--i': i + offset } as CSSProperties}>
          {w}
        </span>
      ))}
    </>
  )
}

// One lower third's slot. It slides in from the left over the first 25% of
// its segment, and drops out behind the bottom letterbox while the next one
// slides in over it.
function ThirdSlot({
  p,
  index,
  slotRef,
  children,
}: {
  p: MotionValue<number>
  index: number
  slotRef: (el: HTMLDivElement | null) => void
  children: ReactNode
}) {
  const r = THIRDS[index] ?? THIRDS[0]
  const x = useTransform(p, [r[0], r[0] + THIRD_IN], ['-110%', '0%'])
  const y = useTransform(p, [r[1], r[1] + THIRD_IN], ['0%', '160%'])
  return (
    <motion.div ref={slotRef} className={h.thirdSlot} style={{ x, y }}>
      {children}
    </motion.div>
  )
}

export function PartyHero({ config }: { config: HeroConfig }) {
  const router = useRouter()
  const trackRef = useRef<HTMLElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const ctasRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  const thirdRefs = useRef<Array<HTMLDivElement | null>>([])
  const apiRef = useRef<FoodCrowdHandle | null>(null)

  // Scroll bookkeeping lives in refs: nothing here re-renders per frame.
  const beatRef = useRef(0)
  const narrowRef = useRef(false)
  const shotHeldRef = useRef(false)
  const leavingRef = useRef(false)
  const dockedRef = useRef<boolean | null>(null)
  const activeRef = useRef<number | null>(null)

  const reduced = usePrefersReducedMotion()
  const coarse = useIsCoarsePointer()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced
  const coarseRef = useRef(coarse)
  coarseRef.current = coarse

  const [excited, setExcited] = useState(false)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState({ start: 0, count: 6 })
  const { cast, cameoSlot } = useSessionCast()

  const [lead, tail] = splitTitle(config.title)
  const leadCount = lead.split(' ').length

  // ── The scene clock ──────────────────────────────────────────────────
  const p = useScene(trackRef, 'pin')

  // DOM, scrubbed (transform / opacity / CSS vars only).
  const push = useTransform(p, [PUSH[0], PUSH[1]], [0, 1])
  const lb = useTransform(p, [PUSH[0], PUSH[1], HANDOFF[0], HANDOFF[1]], [0, 1, 1, 0])
  const rowOpacity = useTransform(p, [DOCK_AT, DOCK_AT + 0.04], [1, 0])
  const rowY = useTransform(p, [DOCK_AT, DOCK_AT + 0.04], [0, 14])
  const dockOpacity = useTransform(p, [DOCK_AT - 0.04, DOCK_AT], [0, 1])
  const dockY = useTransform(p, [DOCK_AT - 0.04, DOCK_AT], [18, 0])
  const slateY = useTransform(p, [HANDOFF[0], 0.92], ['40%', '0%'])
  const slateOpacity = useTransform(p, [HANDOFF[0] - 0.0001, HANDOFF[0], 0.92], [0, 0.35, 1])
  const hatOpacity = useTransform(p, [PUSH[0], PUSH[0] + 0.06], [1, 0])
  // servd's tomato doodles step aside while simmer's single orange dot is on air.
  const tomatoOpacity = useTransform(p, [0.44, 0.48, 0.62, 0.66], [1, 0, 0, 1])

  // Doodles: the star spins with scroll velocity; the tomato dot hops on each beat.
  const { scrollY } = useScroll()
  const velocity = useSpring(useVelocity(scrollY), { stiffness: 260, damping: 40, mass: 0.6 })
  const starRotate = useTransform(velocity, [-2400, 2400], [-140, 140], { clamp: true })
  const dotY = useMotionValue(0)

  // Engine + focus management, per scroll frame (refs only).
  const apply = useCallback((v: number) => {
    if (reducedRef.current) return
    if (!shotHeldRef.current) apiRef.current?.setShot(shotAt(v, narrowRef.current))
    const docked = v >= DOCK_AT
    if (docked !== dockedRef.current) {
      dockedRef.current = docked
      setInert(ctasRef.current, docked)
      setInert(dockRef.current, !docked)
    }
    const active = activeThird(v)
    if (active !== activeRef.current) {
      activeRef.current = active
      thirdRefs.current.forEach((el, i) => setInert(el, i !== active))
    }
  }, [])

  useMotionValueEvent(p, 'change', apply)

  useEffect(() => {
    if (reduced) {
      // Static hero: the CTA row is the only Order CTA; the scrubbed pieces are hidden by CSS.
      setInert(ctasRef.current, false)
      setInert(dockRef.current, true)
      thirdRefs.current.forEach((el) => setInert(el, true))
      dockedRef.current = null
      activeRef.current = null
      return
    }
    beatRef.current = beatAt(p.get())
    apply(p.get())
  }, [reduced, p, apply])

  // One-shots on each beat: the cast acts, plus a tick and a tap.
  useBeat(p, BEATS, (beat) => {
    const prev = beatRef.current
    beatRef.current = beat
    if (reducedRef.current || beat === prev) return
    apiRef.current?.focus(focusForBeat(beat))
    if (beat === BEATS.length) {
      // Hand-off: everyone looks down at what comes next.
      emitCrowd({ type: 'look', x: window.innerWidth / 2, y: window.innerHeight * 1.2 })
    }
    sfx('tick')
    if (coarseRef.current) haptic(6)
    animate(dotY, [0, -22, 0], { duration: 0.45, ease: 'easeOut' })
  })

  // Phones halve the orbit.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const sync = () => {
      narrowRef.current = mq.matches
    }
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  // The poster shows the same slice of the cast the engine will frame.
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const w = el.clientWidth
      const hgt = el.clientHeight
      if (w < 2 || hgt < 2) return
      const next = visibleWindow(w / hgt, cast.length)
      setView((cur) => (cur.start === next.start && cur.count === next.count ? cur : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cast.length])

  const onApi = useCallback(
    (api: FoodCrowdHandle | null) => {
      apiRef.current = api
      if (!api || reducedRef.current) return
      const v = p.get()
      api.setShot(shotAt(v, narrowRef.current))
      api.focus(focusForBeat(beatAt(v)))
    },
    [p],
  )

  const onReady = useCallback(() => setReady(true), [])

  // ── The Order CTA: cheer, push all the way in, then cut to scene two. ──
  function onOrder(e: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainPrimaryClick(e)) return
    e.preventDefault()
    if (leavingRef.current) return
    leavingRef.current = true
    const anchor = e.currentTarget
    emitCrowd({ type: 'cheer' })
    if (!reducedRef.current) {
      shotHeldRef.current = true
      apiRef.current?.setShot({ dolly: 1 })
    }
    haptic(10)
    sfx('pop')
    const go = () => {
      let cut = false
      try {
        cut = requestCut(BROWSE, {
          origin: anchor.getBoundingClientRect(),
          kicker: 'scene two',
          title: 'pick your craving',
        })
      } catch {
        cut = false
      }
      if (!cut) router.push(BROWSE)
      // If the navigation never lands (offline, blocked), give the hero back.
      window.setTimeout(() => {
        leavingRef.current = false
        shotHeldRef.current = false
      }, 1600)
    }
    if (reducedRef.current) go()
    else window.setTimeout(go, 380)
  }

  // "Meet the kitchens": a smooth scroll to act ii, not a navigation.
  function onMeet(e: MouseEvent<HTMLAnchorElement>) {
    if (!isPlainPrimaryClick(e)) return
    const el = document.getElementById('brands')
    if (!el) return
    e.preventDefault()
    const lenis = window.__lenis
    if (lenis && !reducedRef.current) lenis.scrollTo(el, { offset: 0 })
    else el.scrollIntoView({ behavior: reducedRef.current ? 'auto' : 'smooth', block: 'start' })
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  }

  const excite = {
    onMouseEnter: () => setExcited(true),
    onMouseLeave: () => setExcited(false),
    onFocus: () => setExcited(true),
    onBlur: () => setExcited(false),
  }

  const posterCast = cast.slice(view.start, view.start + view.count)
  const hatLeft =
    cameoSlot != null && cameoSlot >= view.start && cameoSlot < view.start + view.count
      ? ((cameoSlot - view.start + 0.5) / view.count) * 100
      : null

  return (
    <section
      ref={trackRef}
      id="act-1"
      data-film-pin=""
      className={s.track}
      aria-labelledby="party-hero-title"
    >
      <div data-film-frame="" className={s.hero}>
        {/* Doodles: decoration only. */}
        <motion.span aria-hidden className={cx(s.doodleSlot, s.doodleStar)} style={{ rotate: starRotate }}>
          <svg className={s.doodleStarSvg} viewBox="0 0 40 40">
            <path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" />
          </svg>
        </motion.span>
        <motion.span aria-hidden className={cx(s.doodleSlot, s.doodleSquiggle)} style={{ opacity: tomatoOpacity }}>
          <svg className={s.doodleSquiggleSvg} viewBox="0 0 80 24">
            <path d="M2 12 C 12 2, 22 22, 32 12 S 52 2, 62 12 S 76 20, 78 12" />
          </svg>
        </motion.span>
        <motion.span aria-hidden className={cx(s.doodleSlot, s.doodleDot)} style={{ y: dotY, opacity: tomatoOpacity }}>
          <svg className={s.doodleDotSvg} viewBox="0 0 20 20">
            <circle cx="10" cy="10" r="8" />
          </svg>
        </motion.span>

        {/* Copy: shrinks and rises on the push-in, never fades. */}
        <motion.div className={s.copy} style={cssVars({ '--push': push })}>
          <p className={s.eyebrow}>
            {cameoSlot != null ? 'servd · karachi · with a surprise guest' : 'servd · karachi · three kitchens'}
          </p>
          <h1 id="party-hero-title" className={s.title}>
            <BouncyWords text={lead} />
            {tail && (
              <span className={s.tail}>
                <BouncyWords text={tail} offset={leadCount} />
                <svg aria-hidden className={s.underline} viewBox="0 0 300 20" preserveAspectRatio="none">
                  <path d="M4 14 C 60 4, 120 18, 180 9 S 280 6, 296 12" />
                </svg>
              </span>
            )}
          </h1>
          {config.overview && <p className={s.lead}>{config.overview}</p>}
          {/* The scrubbed wrapper and the CSS entrance live on different
              elements: a filled CSS animation would override framer's inline opacity. */}
          <motion.div ref={ctasRef} className={s.ctasSlot} style={{ opacity: rowOpacity, y: rowY }}>
            <div className={s.ctas}>
              <Link href={BROWSE} data-no-cut="" className={s.cta} onClick={onOrder} {...excite}>
                Order now
                <svg aria-hidden viewBox="0 0 24 24" width="20" height="20">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              <a href="#brands" data-no-cut="" className={s.ctaGhost} onClick={onMeet}>
                Meet the kitchens
              </a>
            </div>
          </motion.div>
        </motion.div>

        {/* Stage: the SVG poster paints first; the 3D crowd takes over once it has drawn. */}
        <div ref={stageRef} className={s.stage} aria-hidden>
          <div className={s.floor} />
          <CrowdPoster id="act1" cast={posterCast} still={reduced} className={cx(s.poster, ready && s.posterGone)} />
          <div className={s.crowd}>
            <FoodCrowd
              cast={cast}
              excitement={excited ? 1 : 0}
              entrance="walk"
              onReady={onReady}
              onApi={onApi}
            />
          </div>
          {hatLeft != null && (
            <motion.span className={h.hat} style={{ left: `${hatLeft}%`, opacity: hatOpacity }}>
              <PartyHat className={h.hatSvg} />
            </motion.span>
          )}
        </div>

        {/* Letterbox: plum bars close on the push-in and open on the hand-off. */}
        <motion.div aria-hidden className={cx(film.lbTop, s.lb, s.lbTop)} style={cssVars({ '--lb': lb })} />
        <motion.div aria-hidden className={cx(film.lbBottom, s.lb, s.lbBottom)} style={cssVars({ '--lb': lb })} />

        {/* Roll call + the act ii slate share the lower-third slot. */}
        <div className={h.thirds}>
          {THIRD_ORDER.map((brand, i) => (
            <ThirdSlot
              key={brand}
              p={p}
              index={i}
              slotRef={(el) => {
                thirdRefs.current[i] = el
              }}
            >
              <LowerThird brand={brand} index={i} />
            </ThirdSlot>
          ))}
          <motion.div aria-hidden className={h.slateSlot} style={{ y: slateY, opacity: slateOpacity }}>
            <Slate act="ii" title="the kitchens" />
          </motion.div>
        </div>

        {/* The docked mini CTA, in the bottom bar. */}
        <div className={h.dockSlot}>
          <motion.div ref={dockRef} className={h.dockWrap} style={{ opacity: dockOpacity, y: dockY }}>
            <Link href={BROWSE} data-no-cut="" className={h.dock} onClick={onOrder} {...excite}>
              Order now
              <svg aria-hidden viewBox="0 0 24 24" width="18" height="18">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </Link>
          </motion.div>
        </div>

        <div className={h.skipSlot}>
          <SkipScene targetId="brands" />
        </div>
      </div>

      {/* Reduced motion only (CSS): the roll call as a static list. */}
      <Starring />
    </section>
  )
}
