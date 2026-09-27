'use client'
// Motion plumbing for the Flipd microsite. Everything here is cheap on
// purpose: one passive scroll listener per pinned section, IntersectionObserver
// for everything else, and React state only ever changes on a THRESHOLD
// crossing — never per frame. The per-frame work is a single CSS variable
// write; the compositor does the rest.

import { useEffect, useRef, useState } from 'react'

/** True when the reader has asked for reduced motion. SSR-safe (false).
 *  Kept as an export for existing callers; the one implementation lives in
 *  the film kit so every surface reacts to the same media query. */
export { usePrefersReducedMotion } from '../../../lib/film/motion'

/**
 * Pinned-section progress. Writes `--scroll-progress` (0..1) on the element
 * and calls `onCross(index, forward)` whenever progress crosses one of
 * `marks` — which is how the hero knows a part has seated or the burger has
 * hit the datum without re-rendering on every scroll frame.
 */
export function useBuildProgress<T extends HTMLElement>(
  marks: number[],
  onCross: (index: number, forward: boolean) => void,
) {
  const ref = useRef<T | null>(null)
  const cb = useRef(onCross)
  cb.current = onCross
  const marksKey = marks.join(',')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ms = marksKey.split(',').map(Number)
    let last = -1
    let raf = 0

    const update = () => {
      raf = 0
      const rect = el.getBoundingClientRect()
      const total = rect.height - window.innerHeight
      const p = total <= 0 ? 1 : Math.max(0, Math.min(1, -rect.top / total))
      el.style.setProperty('--scroll-progress', p.toFixed(4))
      if (last >= 0) {
        ms.forEach((m, i) => {
          if (last < m && p >= m) cb.current(i, true)
          else if (last >= m && p < m) cb.current(i, false)
        })
      } else {
        // First measurement: report every mark we are already past, so a
        // reload halfway down the hero lands in the right state.
        ms.forEach((m, i) => { if (p >= m) cb.current(i, true) })
      }
      last = p
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update) }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    update()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [marksKey])

  return ref
}

/**
 * Reveal-once + live-while-visible, for a whole section.
 *
 *  - `data-in` is set the first time ANY pixel of the section is on screen
 *    and never removed. CSS keys the sticker slaps and doodle draws off it;
 *    headings and body copy are never gated on it, so a snapshot at any
 *    scroll offset shows a readable section (the old 20% threshold with a
 *    negative root margin left whole viewports of navy on phones).
 *  - `data-live` is set only while the section is on screen, so looping
 *    decoration (marquees, steam, bulbs, doodles, the MiniBuild loop) can
 *    pause off-screen.
 *
 * `threshold` is extra: 0 is always observed, so a larger value only adds a
 * callback, it never delays `data-in`.
 */
export function useSectionMotion<T extends HTMLElement>(threshold = 0, rootMargin = '0px') {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      el.dataset.in = '1'
      el.dataset.live = '1'
      return
    }
    // "Armed" lets CSS stage decoration BEFORE its entrance. It is only set
    // once JS is running, so without JS (or before hydration) every section
    // renders in its final state.
    el.dataset.armed = '1'
    const thresholds = threshold > 0 ? [0, threshold] : [0]
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return
        if (e.isIntersecting || e.intersectionRatio > 0) {
          el.dataset.in = '1'
          el.dataset.live = '1'
        } else {
          delete el.dataset.live
        }
      },
      { threshold: thresholds, rootMargin },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [threshold, rootMargin])
  return ref
}

/**
 * Boolean in-view state for things that need to run JS while visible (the
 * court-side ball the crowd watches). Re-renders only on enter/leave.
 */
export function useInView<T extends HTMLElement>(rootMargin = '0px') {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { rootMargin })
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin])
  return [ref, inView] as const
}
