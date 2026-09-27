'use client'

// Odometer: renders a pre-formatted string ("PKR 12,400", "3") where every
// digit is a vertical reel that rolls to its new value with the shared "pop"
// spring. Non-digit characters (currency prefix, grouping commas) sit still.
//
// Columns are keyed from the RIGHT, so the units digit stays the units digit
// when the number grows a place ("900" -> "1,200" rolls the last three reels
// and adds the new ones on the left).
//
// A11y: the reels are aria-hidden and nothing here is a live region. The
// real value is carried by a visually hidden copy of the text (and, on the
// basket pill, by the pill's own aria-label).
//
// Reduced motion: no reels at all, the text simply swaps.

import { motion } from 'framer-motion'
import { usePrefersReducedMotion } from '@/lib/play'
import styles from './toss.module.css'

const POP = { type: 'spring' as const, stiffness: 520, damping: 18, restDelta: 0.001 }
const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const

export interface OdometerProps {
  /** The already-formatted value, e.g. fmt(subtotal) or String(count). */
  value: string | number
  className?: string
  /** Visually hidden text for assistive tech. Defaults to the value itself;
   *  pass null when the parent already labels it (the pill's aria-label). */
  srLabel?: string | null
}

export function Odometer({ value, className, srLabel }: OdometerProps) {
  const reduced = usePrefersReducedMotion()
  const text = String(value)
  const chars = Array.from(text)
  const sr = srLabel === undefined ? text : srLabel

  return (
    <span className={[styles.odo, className].filter(Boolean).join(' ')}>
      {reduced ? (
        <span aria-hidden="true" className={styles.odoPlain}>{text}</span>
      ) : (
        <span aria-hidden="true" className={styles.odoRow}>
          {chars.map((ch, i) => {
            const fromRight = chars.length - 1 - i
            const d = DIGITS.indexOf(ch as (typeof DIGITS)[number])
            if (d < 0) {
              return (
                <span key={`s${fromRight}`} className={styles.odoStatic}>
                  {ch === ' ' ? ' ' : ch}
                </span>
              )
            }
            return (
              <span key={`d${fromRight}`} className={styles.odoCol}>
                {/* In-flow sizer: gives the column exactly one digit's width. */}
                <span className={styles.odoSizer}>{ch}</span>
                <motion.span
                  className={styles.odoReel}
                  initial={false}
                  animate={{ y: `${-d * 10}%` }}
                  transition={POP}
                >
                  {DIGITS.map((n) => (
                    <span key={n} className={styles.odoDigit}>{n}</span>
                  ))}
                </motion.span>
              </span>
            )
          })}
        </span>
      )}
      {sr !== null && <span className="sr-only">{sr}</span>}
    </span>
  )
}

export default Odometer
