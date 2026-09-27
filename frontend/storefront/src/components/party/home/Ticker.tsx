'use client'
// Ticker: two crossed "tape" strips over the seam between the hero floor
// and the kitchens. They drift on their own, and speed up (and flip
// direction) with scroll velocity. They're decorative: the words are
// aria-hidden, and everything they say is said properly elsewhere on the page.
//
// The food tape knows the hour. Every word is tagged with the day-parts it
// belongs to and, where it has one, its kitchen. CSS on the server-stamped
// html[data-daypart] and html[data-k-<slug>] attributes hides whatever
// doesn't fit right now: morning pastries, lunch sandwiches, dinner smash
// burgers, and at night "kitchens asleep", with a closed kitchen's words
// dropped. It's right on the first paint and needs no re-render. Each
// day-part keeps one kitchen-less word, so the tape is never empty.
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
} from 'framer-motion'
import t from './ticker.module.css'

type Part = 'morning' | 'lunch' | 'afternoon' | 'dinner' | 'late' | 'night'
type Word = { w: string; k?: 'stackd' | 'simmer' | 'flipd'; dp: Part[] }

// stackd: pastries, coffee, sandwiches, mocktails. Flipd: burgers, fries.
// simmer: small plates. No brand names on the tape.
const FOOD: Word[] = [
  { w: 'warm pastries', k: 'stackd', dp: ['morning', 'afternoon'] },
  { w: 'first coffee', k: 'stackd', dp: ['morning'] },
  { w: 'good morning karachi', dp: ['morning'] },
  { w: 'sandwiches', k: 'stackd', dp: ['morning', 'lunch', 'afternoon'] },
  { w: 'smash burgers', k: 'flipd', dp: ['lunch', 'afternoon', 'dinner', 'late'] },
  { w: 'lunch, sorted', dp: ['lunch'] },
  { w: 'fries', k: 'flipd', dp: ['lunch', 'afternoon'] },
  { w: 'iced coffee', k: 'stackd', dp: ['afternoon'] },
  { w: 'triple-cooked fries', k: 'flipd', dp: ['dinner', 'late'] },
  { w: 'craft mocktails', k: 'stackd', dp: ['afternoon', 'dinner', 'late'] },
  { w: 'small plates', k: 'simmer', dp: ['dinner', 'late'] },
  { w: 'dinner rush', dp: ['dinner'] },
  { w: 'late night', dp: ['late'] },
  { w: 'kitchens asleep', dp: ['night'] },
  { w: 'back at 8am', dp: ['night'] },
]
const PROMISE = ['three kitchens', 'one bag', 'one checkout', 'made in karachi', 'hot stays hot', 'cold stays cold']
const PROMISE_WORDS: Word[] = PROMISE.map((w) => ({ w, dp: ['morning', 'lunch', 'afternoon', 'dinner', 'late', 'night'] }))

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

function Row({ words, baseVelocity, className, reps = 2 }: { words: Word[]; baseVelocity: number; className: string; reps?: number }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { margin: '120px 0px' })
  const baseX = useMotionValue(0)
  const { scrollY } = useScroll()
  const velocity = useVelocity(scrollY)
  const smooth = useSpring(velocity, { damping: 50, stiffness: 400 })
  const factor = useTransform(smooth, [0, 1000], [0, 4], { clamp: false })
  const dir = useRef(1)
  const x = useTransform(baseX, (v) => `${wrapPct(-50, 0, v)}%`)

  useAnimationFrame((_, delta) => {
    if (reduce || !inView) return
    const f = factor.get()
    if (f < 0) dir.current = -1
    else if (f > 0) dir.current = 1
    const move = dir.current * baseVelocity * (delta / 1000) * (1 + Math.abs(f))
    baseX.set(baseX.get() + move)
  })

  // One "half" repeats the words so it is always wider than the viewport,
  // even at night when only a few are showing. The track holds two halves
  // and wraps at -50%.
  const half: ReactNode[] = []
  for (let rep = 0; rep < reps; rep++) {
    words.forEach((w, i) => {
      const D = DOODLES[(i + rep) % DOODLES.length] ?? Star
      half.push(
        <span key={`${rep}-${i}`} className={t.item} data-dp={w.dp.join(' ')} data-k={w.k}>
          <span className={i % 2 ? t.italic : undefined}>{w.w}</span>
          <D />
        </span>,
      )
    })
  }

  return (
    <div ref={ref} className={`${t.tape} ${className}`}>
      <motion.div className={t.track} style={{ x }}>
        <div className={t.half}>{half}</div>
        <div className={t.half}>{half}</div>
      </motion.div>
    </div>
  )
}

export function Ticker() {
  return (
    <div aria-hidden className={t.seam}>
      <Row words={PROMISE_WORDS} baseVelocity={2.2} className={t.tapeBack ?? ''} />
      <Row words={FOOD} baseVelocity={-3} className={t.tapeFront ?? ''} reps={4} />
    </div>
  )
}
