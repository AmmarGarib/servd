'use client'
// Divider — a wavy or scalloped seam between two colour bands. The shape
// tiles, so the track drifts sideways very slowly (CSS, paused for reduced
// motion). When the seam scrolls in, the bumps squash up from 70% height
// with a pop spring, so the seams land the way the sections do. The squash
// is anchored to the bottom edge and the band behind it is the upper
// colour, so there is never a gap. Purely decorative.
import { motion } from 'framer-motion'
import { SPRING } from '../../../lib/tactile'
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
      <motion.div
        className={s.dividerSquash}
        initial={{ scaleY: 0.7 }}
        whileInView={{ scaleY: 1 }}
        viewport={{ once: true, amount: 0.2, margin: '0px 0px -8% 0px' }}
        transition={SPRING.pop}
      >
        <div
          className={s.dividerTrack}
          style={flip ? { animationDirection: 'reverse' } : undefined}
        >
          {[0, 1].map((k) => (
            <svg key={k} viewBox="0 0 1200 60" preserveAspectRatio="none">
              <path d={d} fill={to} />
            </svg>
          ))}
        </div>
      </motion.div>
    </div>
  )
}
