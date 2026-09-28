'use client'
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { BlockAnimation } from '../../lib/blocks'

// Per-element entrance animation for SiteLayout blocks. The wrapper starts
// hidden (.sv-anim) and gets .sv-in — which plays the sv-<name> keyframes in
// globals.css — the first time it scrolls into view. prefers-reduced-motion
// is honoured twice: the CSS shows it without motion, and we skip the
// observer entirely.

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt

export function Animate({
  animation, delayMs, durationMs, children,
}: {
  animation: Exclude<BlockAnimation, 'none'>
  delayMs?: number
  durationMs?: number
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduced || typeof IntersectionObserver === 'undefined') {
      el.classList.add('sv-in')
      return
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        el.classList.add('sv-in')
        io.disconnect()
      }
    }, { threshold: 0.12, rootMargin: '0px 0px -5% 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const style = {
    '--sv-anim-name': `sv-${animation}`,
    '--sv-anim-dur': `${clamp(durationMs, 200, 3000, 600)}ms`,
    '--sv-anim-delay': `${clamp(delayMs, 0, 3000, 0)}ms`,
  } as CSSProperties

  return <div ref={ref} className="sv-anim" style={style}>{children}</div>
}
