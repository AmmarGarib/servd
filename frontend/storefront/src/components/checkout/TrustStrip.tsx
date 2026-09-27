'use client'

import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import styles from './checkout.module.css'

/* TrustStrip — the three facts that sit right above Place order (per the
   CRO pass: "will this work / what if it doesn't / can I get out"). Each
   line is fact, not puffery; the copy is unchanged from the inline version.

   Motion: each line fades up as it enters view (armed at low opacity, never
   blank) and its check draws on with pathLength — 300ms, 90ms stagger.
   Reduced motion: static. */

const LINES: Array<{ key: string; body: ReactNode }> = [
  {
    key: 'price',
    body: <><strong style={{ color: 'var(--servd-ink)' }}>One clear price.</strong> What you see is what you pay — no surprise fees.</>,
  },
  {
    key: 'cancel',
    body: <><strong style={{ color: 'var(--servd-ink)' }}>Cancel free</strong> until the kitchen confirms.</>,
  },
  {
    key: 'cash',
    body: <><strong style={{ color: 'var(--servd-ink)' }}>Cash on delivery</strong> if you prefer.</>,
  },
]

export function TrustStrip() {
  const reduce = useReducedMotion()

  return (
    <div className="rounded-xl p-3.5" style={{ background: 'rgba(58,14,105,0.04)', border: '1px solid rgba(58,14,105,0.12)' }}>
      <ul className="space-y-1.5 text-xs" style={{ color: 'var(--servd-mute)' }}>
        {LINES.map((line, i) => (
          <motion.li
            key={line.key}
            className={styles.trustLine}
            initial={reduce ? false : { opacity: 0.35, y: 6 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.36, delay: i * 0.09, ease: [0.22, 1, 0.36, 1] }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--servd-green-dark)" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-0.5">
              <motion.polyline
                points="20 6 9 17 4 12"
                initial={reduce ? false : { pathLength: 0 }}
                whileInView={reduce ? undefined : { pathLength: 1 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.3, delay: 0.12 + i * 0.09, ease: [0.22, 1, 0.36, 1] }}
              />
            </svg>
            <span>{line.body}</span>
          </motion.li>
        ))}
      </ul>
    </div>
  )
}
