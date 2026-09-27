'use client'

// RollingNumber — an odometer for counts and prices. Each digit sits in its
// own clipped slot; when a digit changes, the new one rolls in from below
// (y 100% → 0 on SPRING.pop) while the old one rolls out the top. Going down
// rolls the other way. Non-digit characters ("PKR", ",", " ") render as plain
// text. Slots are keyed from the right so "PKR 950" → "PKR 1,250" keeps the
// units, tens and hundreds in the same slots.
//
// Screen readers get the whole value once; the animated glyphs are hidden.
// Under reduced motion the digits swap without moving.

import { AnimatePresence, motion, useReducedMotion, type Variants } from 'framer-motion'
import { useRef } from 'react'
import { SPRING } from '../../lib/tactile'
import styles from './order.module.css'

function numericOf(s: string): number {
  const digits = s.replace(/[^0-9.-]/g, '')
  const n = Number.parseFloat(digits)
  return Number.isFinite(n) ? n : 0
}

const roll: Variants = {
  enter: (dir: number) => ({ y: dir >= 0 ? '100%' : '-100%', opacity: 0 }),
  center: { y: '0%', opacity: 1 },
  exit: (dir: number) => ({ y: dir >= 0 ? '-100%' : '100%', opacity: 0 }),
}

const still: Variants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
}

export interface RollingNumberProps {
  value: string | number
  className?: string
  /** Hide from assistive tech entirely (when a parent already labels it). */
  decorative?: boolean
}

export function RollingNumber({ value, className, decorative = false }: RollingNumberProps) {
  const text = String(value)
  const reduced = useReducedMotion()

  // Direction of the last change: up rolls from below, down from above.
  const prev = useRef(text)
  const dir = useRef(1)
  if (prev.current !== text) {
    dir.current = numericOf(text) >= numericOf(prev.current) ? 1 : -1
    prev.current = text
  }
  const d = dir.current

  const chars = Array.from(text)
  const glyphs = chars.map((ch, i) => {
    const slot = chars.length - 1 - i
    if (!/[0-9]/.test(ch)) {
      return <span key={`c${slot}`} className={styles.rollGlyph}>{ch}</span>
    }
    return (
      <span key={`d${slot}`} className={styles.rollSlot}>
        <AnimatePresence initial={false} mode="popLayout" custom={d}>
          <motion.span
            key={ch}
            className={styles.rollGlyph}
            custom={d}
            variants={reduced ? still : roll}
            initial="enter"
            animate="center"
            exit="exit"
            transition={reduced ? { duration: 0.12 } : SPRING.pop}
          >
            {ch}
          </motion.span>
        </AnimatePresence>
      </span>
    )
  })

  if (decorative) {
    return <span className={[styles.roll, className].filter(Boolean).join(' ')} aria-hidden="true">{glyphs}</span>
  }
  return (
    <span className={[styles.roll, className].filter(Boolean).join(' ')}>
      <span className={styles.srOnly}>{text}</span>
      <span aria-hidden="true" className={styles.roll}>{glyphs}</span>
    </span>
  )
}

export default RollingNumber
