'use client'
// Small shared pieces for the Flipd microsite: the crowd, the order button
// that makes the crowd cheer, the marquee, word drops and the marker doodles.

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { CSSProperties, ReactNode, MouseEvent as ReactMouseEvent } from 'react'
import { emitCrowd } from '../../characters/crowdBus'
import type { CharacterKind } from '../../characters/types'
import { useSectionMotion } from './useFlipdMotion'
import { useKitchen } from '../../../lib/world/kitchens'
import { useWorld } from '../../../lib/world/useWorld'
import s from './flipd.module.css'

// three.js is client-only and code-split: the page is complete and usable
// before it arrives, and without WebGL the crowd simply is not there.
const FoodCrowd = dynamic(
  () => import('../../characters/FoodCrowd').then((m) => m.FoodCrowd),
  { ssr: false },
)

export const FLIPD_CAST: CharacterKind[] = ['fries', 'burger', 'shake']

/**
 * The court-side crowd, standing on a diner counter. Decorative
 * (aria-hidden, no pointer events); the parent box sets the size — wide and
 * short suits it.
 *
 * The crowd keeps Flipd's hours: while the grill is cold they doze on the
 * counter (a real poke — hovering Order, a cheer — still wakes them), and
 * while it is on they are awake, with the lunch and dinner rushes lifting
 * their energy. Same kitchen state as the neon sign and the home board.
 */
export function FlipdCrowd({
  excitement = 0,
  className,
  style,
  counter = true,
}: {
  excitement?: number
  className?: string
  style?: CSSProperties
  counter?: boolean
}) {
  const kitchen = useKitchen('flipd')
  const world = useWorld()
  const cold = !kitchen.open
  const rush = kitchen.open && (world.dayPart === 'lunch' || world.dayPart === 'dinner')
  // A deliberate wind-up (≥ .9, hovering Order) always gets through; the
  // ambient level follows the grill.
  const level = excitement >= 0.9
    ? excitement
    : cold
      ? Math.min(excitement, 0.12)
      : Math.max(excitement, rush ? world.energy * 0.5 : 0)
  return (
    <div aria-hidden className={`${s.crowdWrap} ${className ?? ''}`} style={style} data-grill={cold ? 'cold' : 'hot'}>
      {/* The box must have a DEFINITE height: the canvas sizes itself to its
          host, so a content-sized box grows to the canvas's own intrinsic
          height and the crowd spills out of the bottom. */}
      <div className={s.crowdBox}>
        <FoodCrowd cast={FLIPD_CAST} excitement={level} world sleepy={cold ? 0.85 : 0} />
      </div>
      {counter && (
        <>
          <div className={s.counter} />
          <div className={s.counterFront} />
        </>
      )}
    </div>
  )
}

export function Arrow() {
  return (
    <svg aria-hidden viewBox="0 0 24 24">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  )
}

/**
 * The primary order link. Hover/focus winds the crowd up; a plain click makes
 * every crowd on the page cheer, then navigates. Modified clicks (new tab,
 * etc.) and keyboard activation with reduced motion behave natively.
 */
export function OrderLink({
  href,
  children,
  className,
  onExcite,
}: {
  href: string
  children: ReactNode
  className?: string
  onExcite?: (on: boolean) => void
}) {
  const router = useRouter()
  function onClick(e: ReactMouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    e.preventDefault()
    emitCrowd({ type: 'cheer' })
    window.setTimeout(() => router.push(href), 480)
  }
  return (
    <Link
      href={href}
      className={className ?? s.btn}
      onClick={onClick}
      onMouseEnter={() => onExcite?.(true)}
      onMouseLeave={() => onExcite?.(false)}
      onFocus={() => onExcite?.(true)}
      onBlur={() => onExcite?.(false)}
    >
      {children}
      <Arrow />
    </Link>
  )
}

/** Splits a line into words that drop in once the section is on screen. */
export function Words({ text, offset = 0 }: { text: string; offset?: number }) {
  const words = text.split(' ')
  return (
    <>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} className={s.word} style={{ '--i': i + offset } as CSSProperties}>
          {w}
          {i < words.length - 1 ? ' ' : ''}
        </span>
      ))}
    </>
  )
}

export function Star({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 40 40" className={className}>
      <path d="M20 2 L24.5 15.5 L38 20 L24.5 24.5 L20 38 L15.5 24.5 L2 20 L15.5 15.5 Z" />
    </svg>
  )
}

/**
 * The marquee band: chase-light bulbs top and bottom, and brand lines
 * scrolling between them. The lines are the book's own facts, repeated as
 * signage, so the whole band is aria-hidden — it says nothing the page does
 * not already say.
 */
export function Marquee({ items, duration = 38, reverse = false }: { items: string[]; duration?: number; reverse?: boolean }) {
  const ref = useSectionMotion<HTMLDivElement>(0)
  const run = (
    <span className={s.marqueeItem}>
      {items.map((t) => (
        <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: '1.1rem' }}>
          {t}
          <Star className={s.marqueeStar} />
        </span>
      ))}
    </span>
  )
  return (
    <div ref={ref} className={s.marquee} aria-hidden>
      <div className={s.bulbs} />
      <div
        className={s.track}
        style={{ '--dur': `${duration}s`, animationDirection: reverse ? 'reverse' : undefined } as CSSProperties}
      >
        {run}
        {run}
        {run}
        {run}
      </div>
      <div className={`${s.bulbs} ${s.bulbsReverse}`} />
    </div>
  )
}

// ── Marker doodles ──────────────────────────────────────────────────────
// Hand-drawn in the badge's own line weight, navy only. They "boil"
// (see .doodle) and are pure decoration.

type DoodleProps = { className?: string; style?: CSSProperties }

export function DoodleBurst({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 60 60" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <path d="M30 6v12M30 42v12M6 30h12M42 30h12M13 13l8 8M39 39l8 8M47 13l-8 8M21 39l-8 8" />
    </svg>
  )
}

/** The three speed lines that sit either side of the badge. */
export function DoodleSpeed({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 70 30" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <path d="M4 6h52M14 15h52M4 24h40" />
    </svg>
  )
}

export function DoodleSquiggle({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 90 26" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <path d="M3 14 C 13 3, 23 25, 33 13 S 53 2, 63 13 S 80 22, 87 11" />
    </svg>
  )
}

export function DoodleStar({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 40 40" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <path d="M20 3 L24 16 L37 20 L24 24 L20 37 L16 24 L3 20 L16 16 Z" />
    </svg>
  )
}

/** Sesame seeds, as on the crown. */
export function DoodleSeeds({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 60 40" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <ellipse cx="10" cy="10" rx="4" ry="2.6" transform="rotate(-25 10 10)" />
      <ellipse cx="32" cy="8" rx="4" ry="2.6" transform="rotate(20 32 8)" />
      <ellipse cx="50" cy="18" rx="4" ry="2.6" transform="rotate(-10 50 18)" />
      <ellipse cx="20" cy="28" rx="4" ry="2.6" transform="rotate(35 20 28)" />
      <ellipse cx="42" cy="33" rx="4" ry="2.6" transform="rotate(-30 42 33)" />
    </svg>
  )
}

/** A spatula — the flip. */
export function DoodleSpatula({ className, style }: DoodleProps) {
  return (
    <svg aria-hidden viewBox="0 0 80 40" className={`${s.doodle} ${className ?? ''}`} style={style}>
      <path d="M4 30 L34 22" />
      <path d="M34 14 L70 6 L76 26 L40 34 Z" />
      <path d="M46 16 L64 12M48 24 L66 20" />
    </svg>
  )
}

export { s as flipdStyles }
