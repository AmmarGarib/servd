'use client'
// The nav's circular "s" badge, with a face. Two small googly eyes follow the
// cursor (desktop only, within 2px), blink every 6-9s, and the whole badge
// squashes and winks when it is pressed. The badge sits inside the home Link,
// so it never changes navigation; the nav lives in the root layout and keeps
// animating across the route change.
//
// Reduced motion: the eyes are painted but static. No tracking, no blink, no
// squash. Quiet routes (simmer): no face at all, and the badge keeps still.

import { useCallback, useEffect, useRef } from 'react'
import { motion, useAnimationControls } from 'framer-motion'
import { usePrefersReducedMotion, useQuiet } from '@/lib/play'
import s from './nav.module.css'

const POP = { type: 'spring' as const, stiffness: 520, damping: 18 }
const MAX_LOOK = 2 // px the pupils may travel from centre

export function LogoBadge({ pressSignal }: { pressSignal: number }) {
  const quiet = useQuiet()
  const reduced = usePrefersReducedMotion() || quiet
  const controls = useAnimationControls()
  const badgeRef = useRef<HTMLSpanElement>(null)
  const leftEyeRef = useRef<SVGGElement>(null)
  const rightEyeRef = useRef<SVGGElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // ── Cursor tracking (fine pointers, rAF-throttled) ─────────────────────
  useEffect(() => {
    if (reduced || typeof window === 'undefined') return
    let fine = false
    try {
      fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches
    } catch {
      fine = false
    }
    if (!fine) return

    let px = 0
    let py = 0
    let queued = false
    const apply = () => {
      queued = false
      const badge = badgeRef.current
      const svg = svgRef.current
      if (!badge || !svg) return
      const r = badge.getBoundingClientRect()
      const dx = px - (r.left + r.width / 2)
      const dy = py - (r.top + r.height * 0.35)
      const dist = Math.hypot(dx, dy) || 1
      const reach = Math.min(MAX_LOOK, dist / 40)
      const t = `translate(${((dx / dist) * reach).toFixed(2)} ${((dy / dist) * reach).toFixed(2)})`
      svg.querySelectorAll('[data-pupil]').forEach((p) => p.setAttribute('transform', t))
    }
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      px = e.clientX
      py = e.clientY
      if (!queued) {
        queued = true
        requestAnimationFrame(apply)
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      svgRef.current?.querySelectorAll('[data-pupil]').forEach((p) => p.setAttribute('transform', 'translate(0 0)'))
    }
  }, [reduced])

  // ── Blink every 6-9s ───────────────────────────────────────────────────
  const shut = useCallback((eyes: Array<SVGGElement | null>, ms: number) => {
    eyes.forEach((g) => { if (g) g.style.transform = 'scaleY(0.1)' })
    window.setTimeout(() => {
      eyes.forEach((g) => { if (g) g.style.transform = '' })
    }, ms)
  }, [])

  useEffect(() => {
    if (reduced) return
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (!document.hidden) shut([leftEyeRef.current, rightEyeRef.current], 90)
        schedule()
      }, 6000 + Math.random() * 3000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [reduced, shut])

  // ── Press: squash-and-stretch, then the pop spring, plus a wink ────────
  // Compared against the last seen signal (not a "first run" flag) so a
  // Strict Mode double-mount never plays the squash on load.
  const seenPress = useRef(pressSignal)
  useEffect(() => {
    if (pressSignal === seenPress.current) return
    seenPress.current = pressSignal
    if (reduced) return
    shut([rightEyeRef.current], 200)
    let cancelled = false
    void (async () => {
      await controls.start({ scaleX: 1.2, scaleY: 0.8, transition: { duration: 0.07, ease: 'easeOut' } })
      if (!cancelled) await controls.start({ scaleX: 1, scaleY: 1, transition: POP })
    })()
    return () => { cancelled = true }
  }, [pressSignal, reduced, controls, shut])

  return (
    <motion.span ref={badgeRef} aria-hidden="true" className={s.badge} animate={controls} initial={false}>
      {!quiet && <svg ref={svgRef} className={s.eyes} viewBox="0 0 36 36" focusable="false">
        <g ref={leftEyeRef} className={s.eye}>
          <circle cx="12.5" cy="12.5" r="4.7" className={s.eyeWhite} />
          <circle data-pupil="" cx="12.5" cy="12.8" r="2.1" className={s.pupil} />
        </g>
        <g ref={rightEyeRef} className={s.eye}>
          <circle cx="23.5" cy="12.5" r="4.7" className={s.eyeWhite} />
          <circle data-pupil="" cx="23.5" cy="12.8" r="2.1" className={s.pupil} />
        </g>
      </svg>}
      <span className={s.badgeLetter}>s</span>
    </motion.span>
  )
}
