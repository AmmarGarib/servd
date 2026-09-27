'use client'
// Ticker — two crossed "tape" strips over the seam between the hero floor
// and the kitchens. They drift on their own and speed up (and flip
// direction) with scroll velocity. They can also be grabbed and flung: the
// strip stretches a little under the finger (elastic 0.2), the words follow
// the drag, and a fling adds its velocity to the drift, decaying back to the
// ambient speed over about 1.2s.
//
// Decorative: the whole seam is aria-hidden, nothing in it is focusable and
// the drag is pointer-only; everything the tapes say is said properly
// elsewhere on the page. Reduced motion: static tapes, no drag.
import { useRef, type ReactNode } from 'react'
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
  type PanInfo,
} from 'framer-motion'
import t from './ticker.module.css'

const FOOD = ['smash burgers', 'sandwiches', 'small plates', 'pastries', 'triple-cooked fries', 'craft mocktails', 'desserts', 'light bites']
const PROMISE = ['three kitchens', 'one bag', 'one checkout', 'made in karachi', 'hot stays hot', 'cold stays cold']

/** Fling boost time constant: e^(-1200/300) ≈ 2% left after ~1.2s. */
const FLING_TAU_MS = 300
/** Cap on a fling, in track-% per second, so a wild flick stays readable. */
const MAX_FLING = 60

function wrapPct(min: number, max: number, v: number) {
  const r = max - min
  return ((((v - min) % r) + r) % r) + min
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
const DOODLES = [Star, Squiggle, Dot, Heart]

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
  const fling = useRef(0)
  const dragging = useRef(false)
  const x = useTransform(baseX, (v) => `${wrapPct(-50, 0, v)}%`)

  /** px → % of the track's own width (the unit baseX is in). */
  function toPct(px: number): number {
    const w = trackRef.current?.offsetWidth ?? 0
    return w > 0 ? (px / w) * 100 : 0
  }

  useAnimationFrame((_, delta) => {
    if (reduce || !inView || dragging.current) return
    const dt = delta / 1000
    const f = factor.get()
    if (f < 0) dir.current = -1
    else if (f > 0) dir.current = 1
    let move = dir.current * baseVelocity * dt * (1 + Math.abs(f))
    if (fling.current !== 0) {
      move += fling.current * dt
      fling.current *= Math.exp(-delta / FLING_TAU_MS)
      if (Math.abs(fling.current) < 0.05) fling.current = 0
    }
    baseX.set(baseX.get() + move)
  })

  function onDragStart() {
    dragging.current = true
    fling.current = 0
  }
  function onDrag(_: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) {
    // The grab wrapper itself only stretches 20% of the way (elastic); the
    // words carry the other 80% so they stay under the finger.
    baseX.set(baseX.get() + toPct(info.delta.x * 0.8))
  }
  function onDragEnd(_: PointerEvent | MouseEvent | TouchEvent, info: PanInfo) {
    dragging.current = false
    const v = toPct(info.velocity.x)
    fling.current = Math.max(-MAX_FLING, Math.min(MAX_FLING, v))
    // Settle into the flung direction so the ambient drift doesn't reverse.
    if (Math.abs(v) > 1) dir.current = Math.sign(v) === Math.sign(baseVelocity) ? 1 : -1
  }

  // One "half" holds the words twice so it is always wider than the viewport;
  // the track holds two halves and wraps at -50%.
  const half: ReactNode[] = []
  for (let rep = 0; rep < 2; rep++) {
    words.forEach((w, i) => {
      const D = DOODLES[(i + rep) % DOODLES.length] ?? Star
      half.push(
        <span key={`${rep}-${i}`} className={t.item}>
          <span className={i % 2 ? t.italic : undefined}>{w}</span>
          <D />
        </span>,
      )
    })
  }

  return (
    <div ref={ref} className={`${t.tape} ${className}`}>
      <motion.div
        className={t.grab}
        drag={reduce ? false : 'x'}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.2}
        dragMomentum={false}
        dragSnapToOrigin
        dragTransition={{ bounceStiffness: 520, bounceDamping: 16 }}
        onDragStart={onDragStart}
        onDrag={onDrag}
        onDragEnd={onDragEnd}
      >
        <motion.div ref={trackRef} className={t.track} style={{ x }}>
          <div className={t.half}>{half}</div>
          <div className={t.half}>{half}</div>
        </motion.div>
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
