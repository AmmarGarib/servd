'use client'
// Divider — a wavy or scalloped seam between two colour bands. The shape
// tiles, so the track drifts sideways very slowly (CSS, paused for reduced
// motion).
//
// Toy: tap or click the band and the seam ripples like jelly (the path
// morphs between precomputed shapes over 600ms). The first tap on each
// divider per session also throws a small celebration. Pointer only — the
// band stays aria-hidden and unfocusable; under reduced motion it is inert.
import { motion, useAnimationControls, useReducedMotion } from 'framer-motion'
import type { MouseEvent } from 'react'
import { celebrate } from '@/lib/play'
import s from './home.module.css'

/** The "jelly" overshoot, matching the footer CTA. */
const JELLY = [0.34, 1.56, 0.64, 1] as const

/** A wave whose crests sit `amp` above and below the 32px midline. */
function wave(amp: number): string {
  const up = 32 - amp
  const dn = 32 + amp
  return `M0 32 C100 ${up} 200 ${up} 300 32 S500 ${dn} 600 32 S800 ${up} 900 32 S1100 ${dn} 1200 32 V60 H0 Z`
}

/** 24 bumps across the tile, bulging up into the colour above. */
function scallop(base: number, r: number): string {
  return `M0 60 V${base} ${Array.from({ length: 24 }, () => `a${r} ${r} 0 0 1 50 0`).join(' ')} V60 Z`
}

// Rest shape, then a big swell and an inverted rebound. Every shape of a
// variant has the same commands, so framer can interpolate the numbers.
const SHAPES = {
  wave: { rest: wave(24), swell: wave(34), rebound: wave(-12) },
  scallop: { rest: scallop(34, 25), swell: scallop(24, 25), rebound: scallop(38, 44) },
} as const

// Module fallback for when sessionStorage is unavailable.
const tappedThisSession = new Set<string>()

function firstTapThisSession(key: string): boolean {
  if (tappedThisSession.has(key)) return false
  tappedThisSession.add(key)
  try {
    const k = `servd-divider:${key}`
    if (window.sessionStorage.getItem(k)) return false
    window.sessionStorage.setItem(k, '1')
  } catch {
    /* private mode etc. — the in-memory set still holds for this page life */
  }
  return true
}

export function Divider({ from, to, variant = 'wave', flip = false }: {
  from: string
  to: string
  variant?: 'wave' | 'scallop'
  flip?: boolean
}) {
  const reduce = useReducedMotion()
  const controls = useAnimationControls()
  const shape = SHAPES[variant]
  const key = `${variant}:${from}:${to}`

  function ripple(e: MouseEvent<HTMLDivElement>) {
    if (reduce) return
    if (e.button !== 0) return
    void controls.start({
      d: [shape.rest, shape.swell, shape.rebound, shape.rest],
      transition: { duration: 0.6, times: [0, 0.3, 0.65, 1], ease: [JELLY, JELLY, JELLY] },
    })
    if (firstTapThisSession(key)) void celebrate({ x: e.clientX, y: e.clientY, power: 'small' })
  }

  return (
    <div aria-hidden className={s.divider} style={{ background: from }} data-toy="tap" onClick={ripple}>
      <div
        className={s.dividerTrack}
        style={flip ? { animationDirection: 'reverse' } : undefined}
      >
        {[0, 1].map((k) => (
          <svg key={k} viewBox="0 0 1200 60" preserveAspectRatio="none" focusable="false">
            <motion.path d={shape.rest} fill={to} animate={controls} />
          </svg>
        ))}
      </div>
    </div>
  )
}
