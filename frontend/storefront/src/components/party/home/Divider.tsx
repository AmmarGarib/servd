'use client'
// Divider — a wavy or scalloped seam between two colour bands. The seam is
// wider than the band and drifts sideways with the camera: its 'pass'
// progress (top enters → bottom leaves) maps to translateX -6% → 6%
// (reversed with `flip`). Static and centred under reduced motion.
// Purely decorative.
import { useRef } from 'react'
import { motion, useTransform } from 'framer-motion'
import { lerp, usePrefersReducedMotion, useScene } from '../../../lib/film/motion'
import s from './home.module.css'

const WAVE = 'M0 32 C100 8 200 8 300 32 S500 56 600 32 S800 8 900 32 S1100 56 1200 32 V60 H0 Z'

// 24 bumps across the tile, bulging up into the colour above.
const SCALLOP = `M0 60 V34 ${Array.from({ length: 24 }, () => 'a25 25 0 0 1 50 0').join(' ')} V60 Z`

const DRIFT = 6 // % of the track's own width

export function Divider({ from, to, variant = 'wave', flip = false }: {
  from: string
  to: string
  variant?: 'wave' | 'scallop'
  flip?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = usePrefersReducedMotion()
  const p = useScene(ref, 'pass')
  const x = useTransform(p, (v) => `${lerp(flip ? DRIFT : -DRIFT, flip ? -DRIFT : DRIFT, v)}%`)
  const d = variant === 'wave' ? WAVE : SCALLOP
  return (
    <div ref={ref} aria-hidden className={s.divider} style={{ background: from }}>
      <motion.div className={s.dividerTrack} style={reduce ? undefined : { x }}>
        <svg viewBox="0 0 1200 60" preserveAspectRatio="none">
          <path d={d} fill={to} />
        </svg>
      </motion.div>
    </div>
  )
}
