'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { tick } from '../../lib/tactile'
import styles from './checkout.module.css'

/* OrderStamp — the tracker's greeting. On the first view of an order a
   rubber stamp reading "order in" slams onto the header card:
   scale 1.7 → .94 → 1 at -9deg, opacity 0 → 1 over 460ms, a 2px ink-bleed
   blur settling to 0, and a success haptic at the moment of impact.
   Tomato ink on cream with a double border.

   It fires once per order id (sessionStorage, guarded — private windows and
   blocked storage just fall back to "first view" every time). On a revisit
   the stamp is simply there, already inked.

   simmer variant: no slam. A lowercase "order in" in a 1px bone hairline
   box that fades in and settles 1px. No bounce, no haptic.

   Reduced motion: the stamp appears (opacity only), no scale, no blur. */

type Bezier = [number, number, number, number]
// Accelerate into the card, then spring back off the impact.
const SLAM_EASE: Bezier[] = [[0.55, 0, 1, 0.45], [0.34, 1.56, 0.64, 1]]

const KEY = (id: string) => `servd:order-stamp:${id}`

function seenBefore(orderId: string): boolean {
  try {
    return window.sessionStorage.getItem(KEY(orderId)) === '1'
  } catch {
    return false
  }
}

function markSeen(orderId: string) {
  try {
    window.sessionStorage.setItem(KEY(orderId), '1')
  } catch {
    /* storage blocked — the stamp will just slam again next time */
  }
}

export function OrderStamp({
  orderId,
  variant = 'rubber',
  onImpact,
}: {
  orderId: string
  variant?: 'rubber' | 'simmer'
  /** Called at the moment the stamp lands, so the card can take the weight. */
  onImpact?: () => void
}) {
  const reduce = useReducedMotion()
  // null until mounted: we can't read sessionStorage during SSR, and the
  // stamp must not flash its resting state before deciding to slam.
  const [mode, setMode] = useState<'slam' | 'rest' | null>(null)
  const impactRef = useRef(onImpact)
  impactRef.current = onImpact

  // Decide once per order id. The ref survives React's dev double-invoke,
  // so strict mode doesn't read its own "seen" mark and skip the slam.
  const decided = useRef<string | null>(null)
  useEffect(() => {
    if (decided.current === orderId) return
    decided.current = orderId
    const first = !seenBefore(orderId)
    markSeen(orderId)
    setMode(first ? 'slam' : 'rest')
  }, [orderId])

  useEffect(() => {
    if (mode !== 'slam' || variant === 'simmer' || reduce) return
    const t = window.setTimeout(() => {
      tick('success')
      impactRef.current?.()
    }, 280)
    return () => window.clearTimeout(t)
  }, [mode, variant, reduce])

  if (mode === null) return null

  if (variant === 'simmer') {
    return (
      <motion.span
        className={styles.stampSimmer}
        initial={mode === 'slam' ? { opacity: 0, y: reduce ? 0 : -1 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      >
        order in
      </motion.span>
    )
  }

  if (mode === 'rest' || reduce) {
    return (
      <motion.span
        className={`${styles.stamp} ${styles.stampRest}`}
        initial={mode === 'slam' ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.15 }}
      >
        order in
      </motion.span>
    )
  }

  return (
    <motion.span
      className={styles.stamp}
      role="status"
      initial={{ scale: 1.7, rotate: -9, opacity: 0, filter: 'blur(2px)' }}
      animate={{ scale: [1.7, 0.94, 1], rotate: -9, opacity: [0, 1, 1], filter: ['blur(2px)', 'blur(1.4px)', 'blur(0px)'] }}
      transition={{
        duration: 0.46,
        times: [0, 0.6, 1],
        ease: SLAM_EASE,
      }}
    >
      order in
    </motion.span>
  )
}
