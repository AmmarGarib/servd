'use client'
// Ticker — two crossed "tape" strips over the seam between the hero floor
// and the kitchens. They drift on their own and speed up (and flip
// direction) with scroll velocity.
//
// Toys: grab a tape and drag it sideways; let go hard and it spins, the
// boost bleeding back to cruising speed over ~1.6s (fling it backwards and
// it keeps going backwards). The doodles on the tape pop on press and come
// back a few seconds later — they feed the same 'doodle-pop' count as the
// hero doodles, which are the keyboard path (this whole strip is
// aria-hidden: everything it says is said properly elsewhere on the page).
import { useCallback, useEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import {
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
} from 'framer-motion'
import { popDoodle } from '../doodlePop'
import t from './ticker.module.css'

const FOOD = ['smash burgers', 'sandwiches', 'small plates', 'pastries', 'triple-cooked fries', 'craft mocktails', 'desserts', 'light bites']
const PROMISE = ['three kitchens', 'one bag', 'one checkout', 'made in karachi', 'hot stays hot', 'cold stays cold']

/** Fling boost e-folding time: e^(-1.6/0.4) ≈ 2% left after ~1.6s. */
const BOOST_TAU_S = 0.4
/** Cap on a fling, in % of the track per second (the track wraps at 50%). */
const MAX_FLING = 90
/** How long a popped tape doodle stays gone. */
const DOODLE_HIDE_MS = 3000
/** Past this share of the tape's width, one drag stretches like a rubber band. */
const DRAG_REACH = 0.5
const RUBBER = 0.15

function wrapPct(min: number, max: number, v: number) {
  const r = max - min
  return ((((v - min) % r) + r) % r) + min
}

/** Displacement past `limit` only counts for `RUBBER` of itself. */
function rubberBand(d: number, limit: number) {
  const a = Math.abs(d)
  if (a <= limit) return d
  return Math.sign(d) * (limit + (a - limit) * RUBBER)
}

const Star = () => (
  <svg viewBox="0 0 40 40" className={t.doodle} data-kind="star"><path d="M20 2 L24 16 L38 20 L24 24 L20 38 L16 24 L2 20 L16 16 Z" /></svg>
)
const Squiggle = () => (
  <svg viewBox="0 0 80 24" className={t.doodle} data-kind="squiggle"><path d="M4 12 C 14 2, 24 22, 34 12 S 54 2, 64 12 S 74 20, 76 12" /></svg>
)
const Dot = () => (
  <svg viewBox="0 0 20 20" className={t.doodle} data-kind="dot"><circle cx="10" cy="10" r="8" /></svg>
)
const Heart = () => (
  <svg viewBox="0 0 32 28" className={t.doodle} data-kind="heart"><path d="M16 26 C 6 18, 2 13, 2 8 A 6.5 6.5 0 0 1 16 6 A 6.5 6.5 0 0 1 30 8 C 30 13, 26 18, 16 26 Z" /></svg>
)
const DOODLES: ComponentType[] = [Star, Squiggle, Dot, Heart]

/** The doodle's own ink, read from the rendered SVG so each tape's palette carries over. */
function inkOf(el: Element): string {
  const svg = el.querySelector('svg')
  if (!svg) return '#FF5A3C'
  const cs = window.getComputedStyle(svg)
  const kind = svg.getAttribute('data-kind')
  const paint = kind === 'squiggle' ? cs.stroke : cs.fill
  return paint && paint !== 'none' && !paint.startsWith('url(') ? paint : '#FF5A3C'
}

function Row({ words, baseVelocity, className }: { words: string[]; baseVelocity: number; className: string }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '120px 0px' })
  const baseX = useMotionValue(0)
  const { scrollY } = useScroll()
  const velocity = useVelocity(scrollY)
  const smooth = useSpring(velocity, { damping: 50, stiffness: 400 })
  const factor = useTransform(smooth, [0, 1000], [0, 4], { clamp: false })
  const dir = useRef(1)
  const boost = useRef(0)
  const x = useTransform(baseX, (v) => `${wrapPct(-50, 0, v)}%`)

  // Drag state lives in refs: it changes every pointermove.
  const drag = useRef<{
    id: number
    startClientX: number
    startX: number
    trackW: number
    reach: number
    samples: Array<{ t: number; x: number }>
  } | null>(null)
  const [dragging, setDragging] = useState(false)

  // Popped doodles, keyed per rendered instance (two halves × two reps × words).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())
  const hideTimers = useRef<number[]>([])
  useEffect(() => {
    const list = hideTimers.current
    return () => {
      list.forEach((id) => window.clearTimeout(id))
      list.length = 0
    }
  }, [])

  useAnimationFrame((_, delta) => {
    if (reduce || !inView || drag.current) return
    const dt = Math.min(delta, 64) / 1000
    const f = factor.get()
    if (f < 0) dir.current = -1
    else if (f > 0) dir.current = 1
    const cruise = dir.current * baseVelocity * (1 + Math.abs(f))
    const b = boost.current
    boost.current = Math.abs(b) < 0.01 ? 0 : b * Math.exp(-dt / BOOST_TAU_S)
    baseX.set(baseX.get() + (cruise + b) * dt)
  })

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (reduce || drag.current) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const track = trackRef.current
    const tape = ref.current
    if (!track || !tape) return
    const trackW = track.scrollWidth || track.getBoundingClientRect().width
    if (trackW <= 0) return
    drag.current = {
      id: e.pointerId,
      startClientX: e.clientX,
      startX: baseX.get(),
      trackW,
      reach: tape.getBoundingClientRect().width * DRAG_REACH,
      samples: [{ t: performance.now(), x: e.clientX }],
    }
    boost.current = 0
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety */
    }
    setDragging(true)
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = rubberBand(e.clientX - d.startClientX, d.reach)
    baseX.set(d.startX + (dx / d.trackW) * 100)
    const now = performance.now()
    d.samples.push({ t: now, x: e.clientX })
    // Keep ~100ms of history for the release velocity.
    while (d.samples.length > 2 && now - (d.samples[0]?.t ?? now) > 100) d.samples.shift()
  }

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    setDragging(false)
    if (cancelled) return
    const first = d.samples[0]
    const now = performance.now()
    const last = d.samples[d.samples.length - 1]
    if (!first || !last || now - last.t > 80) return // held still, then let go: no fling
    const dtS = Math.max((last.t - first.t) / 1000, 0.016)
    const pxPerS = (last.x - first.x) / dtS
    let v = (pxPerS / d.trackW) * 100 // % of track per second
    if (Math.abs(v) < Math.abs(baseVelocity) * 0.5) return
    v = Math.max(-MAX_FLING, Math.min(MAX_FLING, v))
    // Cruise in the direction of the fling; the rest of the speed is boost.
    const nextDir = Math.sign(v) === Math.sign(baseVelocity) ? 1 : -1
    dir.current = nextDir
    boost.current = v - nextDir * baseVelocity
  }, [baseVelocity])

  function onDoodleDown(key: string, e: ReactPointerEvent<HTMLSpanElement>) {
    if (hidden.has(key)) return
    popDoodle({ x: e.clientX, y: e.clientY }, inkOf(e.currentTarget))
    setHidden((prev) => new Set(prev).add(key))
    hideTimers.current.push(
      window.setTimeout(() => {
        setHidden((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }, DOODLE_HIDE_MS),
    )
  }

  // One "half" holds the words twice so it is always wider than the viewport;
  // the track holds two halves and wraps at -50%.
  function half(h: number): ReactNode[] {
    const out: ReactNode[] = []
    for (let rep = 0; rep < 2; rep++) {
      words.forEach((w, i) => {
        const D = DOODLES[(i + rep) % DOODLES.length] ?? Star
        const key = `${h}-${rep}-${i}`
        const gone = hidden.has(key)
        out.push(
          <span key={key} className={t.item}>
            <span className={i % 2 ? t.italic : undefined}>{w}</span>
            <span
              className={t.pop}
              data-toy="poke"
              data-gone={gone || undefined}
              onPointerDown={(e) => onDoodleDown(key, e)}
            >
              <D />
            </span>
          </span>,
        )
      })
    }
    return out
  }

  return (
    <div
      ref={ref}
      className={`${t.tape} ${className}`}
      data-toy={reduce ? undefined : 'drag'}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, false)}
      onPointerCancel={(e) => endDrag(e, true)}
      onLostPointerCapture={(e) => endDrag(e, false)}
    >
      <motion.div ref={trackRef} className={t.track} style={{ x }}>
        <div className={t.half}>{half(0)}</div>
        <div className={t.half}>{half(1)}</div>
      </motion.div>
    </div>
  )
}

export function Ticker() {
  return (
    <div aria-hidden className={t.seam}>
      <Row words={PROMISE} baseVelocity={2.2} className={t.tapeBack ?? ''} />
      <Row words={FOOD} baseVelocity={-3} className={t.tapeFront ?? ''} />
    </div>
  )
}
