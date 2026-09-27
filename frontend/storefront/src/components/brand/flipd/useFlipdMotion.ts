'use client'
// Motion plumbing for the Flipd microsite. Everything here is cheap on
// purpose: one passive scroll listener per pinned section, IntersectionObserver
// for everything else, and React state only ever changes on a THRESHOLD
// crossing — never per frame. The per-frame work is a single CSS variable
// write; the compositor does the rest.

import { useEffect, useRef, useState } from 'react'

/** True when the reader has asked for reduced motion. SSR-safe (false). */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return reduced
}

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
 *  - `data-in` is set the first time any sliver of the section is on screen
 *    and never removed: CSS keys every entrance (ticket swings, sticker slaps,
 *    word drops) off `[data-armed][data-in]`.
 *  - `data-live` is set only while the section is on screen, so looping
 *    decoration (marquees, steam, bulbs, doodles) can pause off-screen with
 *    `animation-play-state`.
 *
 * Reveal hygiene (the screenshot test: jump anywhere, wait 900 ms, nothing in
 * view may still be hidden):
 *  - The server / no-JS render is the final state. `data-armed` — the only
 *    thing that lets CSS hold an element back — is set after mount.
 *  - A section already on screen at mount is never armed: it gets `data-in`
 *    straight away and simply stays as it was painted.
 *  - The trigger is a sliver (threshold ≤ 0.05) with the root grown 12% below
 *    the fold, so a section starts its ≤ 450 ms entrance just before it
 *    arrives rather than after a quarter of it is already showing.
 */
const MAX_THRESHOLD = 0.05

export function useSectionMotion<T extends HTMLElement>(threshold = 0.02) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      el.dataset.in = '1'
      el.dataset.live = '1'
      return
    }
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight || document.documentElement.clientHeight
    const onScreen = r.bottom > 0 && r.top < vh
    if (onScreen) {
      el.dataset.in = '1'
      el.dataset.live = '1'
    } else if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      el.dataset.armed = '1'
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return
        if (e.isIntersecting) {
          el.dataset.in = '1'
          el.dataset.live = '1'
        } else {
          delete el.dataset.live
        }
      },
      { threshold: Math.min(Math.max(threshold, 0), MAX_THRESHOLD), rootMargin: '0px 0px 12% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return ref
}

/** True on touch-first devices (coarse primary pointer). SSR-safe (false). */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(pointer: coarse)')
    if (!mq) return
    const on = () => setCoarse(mq.matches)
    on()
    mq.addEventListener?.('change', on)
    return () => mq.removeEventListener?.('change', on)
  }, [])
  return coarse
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
