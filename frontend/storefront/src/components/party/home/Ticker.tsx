'use client'
// Ticker — two crossed "tape" strips over the seam between the hero floor
// and the kitchens (the cut between act i and act ii). They drift on their
// own; scroll velocity drives them like a camera whip-pan: a sprung
// velocity sets a speed multiplier (1 → 3) and a skew (±6deg) shared by
// both tapes, and the drift direction follows the scroll direction.
//
// Decorative: the words are aria-hidden; everything they say is said
// properly elsewhere on the page. Reduced motion: static tapes, no skew.
import { useRef, type ReactNode } from 'react'
import {
  motion,
  useAnimationFrame,
  useInView,
  useMotionValue,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
} from 'framer-motion'
import { usePrefersReducedMotion } from '../../../lib/film/motion'
import t from './ticker.module.css'

const FOOD = ['smash burgers', 'sandwiches', 'small plates', 'pastries', 'triple-cooked fries', 'craft mocktails', 'desserts', 'light bites']
const PROMISE = ['three kitchens', 'one bag', 'one checkout', 'made in karachi', 'hot stays hot', 'cold stays cold']

/** px/s of scroll velocity at which the tapes hit full speed and full skew. */
const FULL_TILT = 2000
const MAX_SKEW = 6

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

interface Drive {
  /** Sprung scroll velocity, px/s (signed). */
  vel: MotionValue<number>
  /** 1 at rest → 3 at full tilt. */
  speed: MotionValue<number>
  /** -6 → 6 deg, follows the scroll direction. */
  skew: MotionValue<number>
  reduce: boolean
}

function Row({ words, baseVelocity, className, drive }: {
  words: string[]
  baseVelocity: number
  className: string
  drive: Drive
}) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '120px 0px' })
  const baseX = useMotionValue(0)
  const dir = useRef(1)
  const x = useTransform(baseX, (v) => `${wrapPct(-50, 0, v)}%`)
  // The back tape leans the other way so the pair reads as crossed.
  const skewX = useTransform(drive.skew, (v) => (baseVelocity < 0 ? v : -v))

  useAnimationFrame((_, delta) => {
    if (drive.reduce || !inView) return
    const v = drive.vel.get()
    if (v < -5) dir.current = -1
    else if (v > 5) dir.current = 1
    const move = dir.current * baseVelocity * (delta / 1000) * drive.speed.get()
    baseX.set(baseX.get() + move)
  })

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
      <motion.div className={t.track} style={drive.reduce ? undefined : { x, skewX }}>
        <div className={t.half}>{half}</div>
        <div className={t.half}>{half}</div>
      </motion.div>
    </div>
  )
}

export function Ticker() {
  const reduce = usePrefersReducedMotion()
  const { scrollY } = useScroll()
  const velocity = useVelocity(scrollY)
  const vel = useSpring(velocity, { damping: 50, stiffness: 400 })
  const speed = useTransform(vel, (v) => 1 + Math.min(2, (Math.abs(v) / FULL_TILT) * 2))
  const skew = useTransform(vel, [-FULL_TILT, 0, FULL_TILT], [-MAX_SKEW, 0, MAX_SKEW])
  const drive: Drive = { vel, speed, skew, reduce }

  return (
    <div aria-hidden className={t.seam}>
      <Row words={PROMISE} baseVelocity={2.2} className={t.tapeBack ?? ''} drive={drive} />
      <Row words={FOOD} baseVelocity={-3} className={t.tapeFront ?? ''} drive={drive} />
    </div>
  )
}
