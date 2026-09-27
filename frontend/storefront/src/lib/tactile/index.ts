// The tactile kit — the one shared set of springs, easings and haptics every
// storefront surface presses, releases and pops with. Keeping these numbers in
// one place is what makes the whole storefront feel like one made object
// instead of forty components each inventing their own bounce.
//
// Framer transitions live in SPRING; the CSS side mirrors the easings as
// --ease-out / --ease-spring / --ease-heavy and --dur-press / --dur-release /
// --dur-pop in globals.css.

import type { Transition } from 'framer-motion'

type SpringName = 'press' | 'release' | 'pop' | 'settle' | 'heavy' | 'leash'

export const SPRING: Record<SpringName, Transition> = {
  /** The finger going down: fast, fully damped, no wobble. */
  press: { type: 'spring', stiffness: 800, damping: 32, mass: 0.5 },
  /** The finger coming up: rubber overshoot. */
  release: { type: 'spring', stiffness: 420, damping: 13, mass: 0.7 },
  /** Things arriving: badges, checks, counters. */
  pop: { type: 'spring', stiffness: 520, damping: 16 },
  /** Things coming to rest without drama. */
  settle: { type: 'spring', stiffness: 260, damping: 24 },
  /** Weighted objects: ceramic, heavy cards, sheets. */
  heavy: { type: 'spring', stiffness: 170, damping: 26, mass: 1.3 },
  /** Something held on a leash behind the pointer. */
  leash: { type: 'spring', stiffness: 300, damping: 20, mass: 0.8 },
}

export const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1]
export const EASE_SPRING: [number, number, number, number] = [0.34, 1.56, 0.64, 1]

/** One-shot jelly wobble. Use with `{ duration: 0.5, ease: 'easeOut' }`. */
export const JELLY = {
  scaleX: [1, 1.14, 0.92, 1.04, 0.99, 1],
  scaleY: [1, 0.86, 1.08, 0.97, 1.01, 1],
}

/** SSR-safe read of the OS reduced-motion preference. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

export type TickKind = 'light' | 'success' | 'error' | 'thud'

const TICK_PATTERNS: Record<TickKind, number | number[]> = {
  light: 8,
  thud: 16,
  success: [12, 60, 18],
  error: [28, 50, 28],
}

let lastTick = 0

/**
 * A haptic tick. Silent on the server, on devices without a vibration motor,
 * and under reduced motion. Throttled to one call per 50ms so a burst of
 * nested handlers never buzzes twice for one press.
 */
export function tick(kind: TickKind = 'light'): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  try {
    if (typeof navigator.vibrate !== 'function') return
    if (prefersReducedMotion()) return
    const now = Date.now()
    if (now - lastTick < 50) return
    lastTick = now
    navigator.vibrate(TICK_PATTERNS[kind])
  } catch {
    /* some browsers throw when vibrate is called without a user gesture */
  }
}
