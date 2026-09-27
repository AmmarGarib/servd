'use client'
// Route fade. A template remounts on every navigation, so each new page eases
// in over 180ms.
//
// OPACITY ONLY. No transform, filter or will-change here, ever: a transformed
// ancestor becomes the containing block for every position:fixed descendant
// (the cart pill, drawers, modals, SimmerCursor) and re-anchors them to the
// page instead of the viewport.
//
// The first page of a document load does not fade: the server HTML must be
// visible before any JS runs, so it renders at full opacity and matches the
// hydrating client exactly. Under reduced motion nothing animates at all.

import { useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { prefersReducedMotion } from '../lib/play/motion'

let navigated = false

export default function Template({ children }: { children: ReactNode }) {
  const [fade] = useState(() => typeof window !== 'undefined' && navigated && !prefersReducedMotion())

  useEffect(() => {
    navigated = true
  }, [])

  return (
    <motion.div
      initial={fade ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  )
}
