'use client'
// SkipScene — a 44px pill at the bottom-right of a pinned scene's sticky
// frame. Long scroll-scrubbed scenes are a choice, never a trap: this jumps
// straight to what comes after and moves focus there. Renders nothing under
// reduced motion, where pinned scenes collapse to their final frame anyway.

import { usePrefersReducedMotion } from '../../lib/film/motion'
import s from './film.module.css'

export function SkipScene({
  targetId,
  label = 'skip scene',
  tone = 'light',
}: {
  targetId: string
  label?: string
  tone?: 'light' | 'dark'
}) {
  const reduced = usePrefersReducedMotion()
  if (reduced) return null

  const skip = () => {
    const el = document.getElementById(targetId)
    if (!el) return
    const lenis = typeof window !== 'undefined' ? window.__lenis : undefined
    if (lenis) lenis.scrollTo(el, { offset: 0 })
    else el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
    el.focus({ preventScroll: true })
  }

  return (
    <button type="button" className={`${s.skip} ${s[tone] ?? ''}`} onClick={skip} data-no-cut="">
      {label}
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3 3l5 5-5 5M9 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export default SkipScene
