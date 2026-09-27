'use client'
// Home primitives: the band Divider and useReveal, the one reveal rule every
// home section uses.
//
// Divider: a wavy or scalloped seam between two colour bands. The shape tiles
// in fixed 1200px tiles and the track drifts one tile per 72 s (about
// 17px/s, whatever the viewport). It's paused under reduced motion and is
// purely decorative. `from` and `to` accept any CSS colour, including var(),
// so a band whose ground follows the day (the kitchen board) stays seamless.
//
// useReveal is reveal hygiene, the screenshot test. The SSR / no-JS state is
// the FINAL state. After mount, only a block that is still below the fold is
// armed (opacity .4, 24px low). It is shown as soon as its top edge is within
// 10% of the viewport, with a CSS transition of 330 ms plus at most a 120 ms
// stagger. Anything already on screen, or scrolled past, at mount never
// moves. Under reduced motion nothing is ever armed.
import { useEffect, useRef, useState, type RefObject } from 'react'
import s from './home.module.css'

const WAVE = 'M0 32 C100 8 200 8 300 32 S500 56 600 32 S800 8 900 32 S1100 56 1200 32 V60 H0 Z'

// 24 bumps across the tile, bulging up into the colour above.
const SCALLOP = `M0 60 V34 ${Array.from({ length: 24 }, () => 'a25 25 0 0 1 50 0').join(' ')} V60 Z`

export function Divider({ from, to, variant = 'wave', flip = false }: {
  from: string
  to: string
  variant?: 'wave' | 'scallop'
  flip?: boolean
}) {
  const d = variant === 'wave' ? WAVE : SCALLOP
  return (
    <div aria-hidden className={s.divider} style={{ background: from }}>
      <div className={s.dividerTrack} data-flip={flip ? '1' : undefined}>
        {[0, 1, 2].map((k) => (
          <svg key={k} viewBox="0 0 1200 60" preserveAspectRatio="none">
            <path d={d} style={{ fill: to }} />
          </svg>
        ))}
      </div>
    </div>
  )
}

export type RevealState = 'final' | 'armed' | 'shown'

/**
 * Arms a block for a short entrance only when it mounts below the fold.
 * Spread the result onto the element: `<div ref={ref} data-reveal={state}
 * className={s.rv}>`. The styles live in home.module.css (`.rv`).
 */
export function useReveal<T extends Element>(): [RefObject<T>, RevealState] {
  const ref = useRef<T>(null)
  const [state, setState] = useState<RevealState>('final')

  useEffect(() => {
    const el = ref.current
    if (!el || typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return
    try {
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    } catch {
      return
    }
    const r = el.getBoundingClientRect()
    // On screen already (or above it): stay final, never re-animate.
    if (r.top < window.innerHeight) return
    setState('armed')
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setState('shown')
          io.disconnect()
        }
      },
      // threshold 0 plus a positive bottom margin: fires just BEFORE the
      // block's top edge crosses into view, so a jump-scroll lands on a
      // block that is already mid-transition.
      { threshold: 0, rootMargin: '0px 0px 10% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return [ref, state]
}
