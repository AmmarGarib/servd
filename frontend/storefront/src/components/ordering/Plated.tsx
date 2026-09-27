'use client'

// Plated — a menu card is set down on the table as it scrolls in: it rises
// 24px, grows from 0.96 and firms up from 0.5 opacity, all scrubbed by its own
// 'enter' progress (P1 useScene: 0 when its top touches the viewport bottom,
// 1 at 35%). Never starts invisible, so a snapshot at any scroll offset shows
// a readable card. Under reduced motion useScene holds at 1 (final state).

import { useRef, type ReactNode } from 'react'
import { motion, useTransform } from 'framer-motion'
import { useScene } from '@/lib/film/motion'
import o from './ordering.module.css'

export function Plated({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const p = useScene(ref, 'enter')
  const y = useTransform(p, [0, 1], [24, 0])
  const scale = useTransform(p, [0, 1], [0.96, 1])
  const opacity = useTransform(p, [0, 1], [0.5, 1])
  return (
    <motion.div ref={ref} className={o.plated} style={{ y, scale, opacity }}>
      {children}
    </motion.div>
  )
}
