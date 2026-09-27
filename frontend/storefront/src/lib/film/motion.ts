// The film grammar: scroll-scrubbed scenes and the shared easing vocabulary.
//
// Every scene on the storefront is scrubbed by scroll position rather than
// fired once on a timer (the snapshot-proof rule): content inside the
// viewport always has a defined, readable state. `useScene` hands back a
// 0..1 MotionValue for a scene element; consumers map it with useTransform.
// Under reduced motion it is pinned at 1, so every scene renders its final,
// composed frame.

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useMotionValue, useMotionValueEvent, useScroll, type MotionValue } from 'framer-motion'

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'
const COARSE_QUERY = '(hover: none)'

function useMediaQuery(query: string): boolean {
  // false on SSR and on the first client render, so hydration always matches.
  const [matches, setMatches] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const update = () => setMatches(mql.matches)
    update()
    // Safari < 14 only has the deprecated addListener.
    if (mql.addEventListener) mql.addEventListener('change', update)
    else mql.addListener(update)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', update)
      else mql.removeListener(update)
    }
  }, [query])
  return matches
}

/** Reactive prefers-reduced-motion. false on SSR / first render. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery(REDUCED_QUERY)
}

/** Reactive `(hover: none)` — phones and tablets. false on SSR / first render. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery(COARSE_QUERY)
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** 0..1 progress of p inside [a, b], clamped. */
export function seg(p: number, a: number, b: number): number {
  if (b === a) return p >= b ? 1 : 0
  return clamp01((p - a) / (b - a))
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export const EASE_CUT: [number, number, number, number] = [0.76, 0, 0.24, 1]
export const EASE_SETTLE: [number, number, number, number] = [0.22, 1, 0.36, 1]
export const SPRING_POP = { type: 'spring', stiffness: 420, damping: 26 } as const

type Offset = NonNullable<Parameters<typeof useScroll>[0]>['offset']

const OFFSETS: Record<'pin' | 'enter' | 'pass', Offset> = {
  pin: ['start start', 'end end'],
  enter: ['start end', 'start 0.35'],
  pass: ['start end', 'end start'],
}

/** Scroll progress 0..1 for a scene element.
 *  'pin'   → offset ['start start','end end']  (tall track with a sticky frame inside)
 *  'enter' → offset ['start end','start 0.35'] (0 when the top touches the viewport bottom, 1 at 35%)
 *  'pass'  → offset ['start end','end start']  (full traversal)
 *  Under reduced motion returns a MotionValue fixed at 1 (final state). */
export function useScene(ref: RefObject<HTMLElement>, mode: 'pin' | 'enter' | 'pass'): MotionValue<number> {
  const reduced = usePrefersReducedMotion()
  // Hooks run unconditionally; the returned value is chosen afterwards.
  const { scrollYProgress } = useScroll({ target: ref, offset: OFFSETS[mode] })
  const still = useMotionValue(1)
  return reduced ? still : scrollYProgress
}

/** beatIndex = number of thresholds <= p (0..thresholds.length); cb runs only when it changes. */
export function useBeat(p: MotionValue<number>, thresholds: number[], cb: (beatIndex: number) => void): void {
  const last = useRef<number | null>(null)
  const cbRef = useRef(cb)
  const thRef = useRef(thresholds)
  cbRef.current = cb
  thRef.current = thresholds

  const beatOf = (v: number) => {
    let n = 0
    for (const t of thRef.current) if (v >= t) n++
    return n
  }

  // Seed without firing, so a page restored mid-scroll doesn't replay every
  // beat on its first frame.
  useEffect(() => {
    if (last.current === null) last.current = beatOf(p.get())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p])

  useMotionValueEvent(p, 'change', (v) => {
    const b = beatOf(v)
    if (b === last.current) return
    last.current = b
    cbRef.current(b)
  })
}
