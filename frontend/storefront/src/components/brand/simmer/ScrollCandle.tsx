'use client'
// The candle, on the page's one continuous take.
//
// The flame is tied to how far down the evening you are: small (0.6) when
// the kitchen's note first comes into view, full (1.1) by the time you have
// read it, and its flat halo brightens with it. Scroll drives it, not a
// timer, so any frame of the page has a defined flame.
//
// Writes --flame-scale and --halo on its own wrapper (Candle's groups read
// them); no React render per frame. Registers itself as the lit orange on
// screen, so the page's other orange marks set in ink while it is visible.
// Reduced motion: the variables are never written, the candle is as drawn.

import { useEffect, useRef } from 'react'
import { useMotionValueEvent, useScroll } from 'framer-motion'
import { lerp, seg, usePrefersReducedMotion } from '../../../lib/film/motion'
import { Candle } from './Candle'
import { useRegisterLitCandle } from './litCandles'

export function ScrollCandle({
  height = 190,
  from = 0.4,
  to = 0.7,
}: {
  height?: number
  /** Page-progress window over which the flame grows from 0.6 to 1.1. */
  from?: number
  to?: number
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduced = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll()
  useRegisterLitCandle(ref, true)

  const paint = (p: number) => {
    const el = ref.current
    if (!el) return
    if (reduced) {
      el.style.removeProperty('--flame-scale')
      el.style.removeProperty('--halo')
      return
    }
    const t = seg(p, from, to)
    el.style.setProperty('--flame-scale', lerp(0.6, 1.1, t).toFixed(3))
    el.style.setProperty('--halo', lerp(0.35, 1, t).toFixed(3))
  }
  useMotionValueEvent(scrollYProgress, 'change', paint)
  // First paint (a reload half-way down the page) and reduced-motion flips.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => paint(scrollYProgress.get()), [reduced, from, to])

  return (
    <span ref={ref} style={{ display: 'inline-block', lineHeight: 0 }}>
      <Candle height={height} />
    </span>
  )
}
