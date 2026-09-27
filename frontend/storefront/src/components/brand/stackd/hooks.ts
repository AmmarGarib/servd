'use client'
// Small motion hooks for the stackd microsite. Everything here writes CSS
// custom properties or flips a class — React never re-renders per frame.
//
// Reveal hygiene (the screenshot test): the server-rendered state is always
// the FINAL state. Entrances are only armed after mount (`useArmed`), trigger
// early (threshold 0, a positive bottom rootMargin) and finish in ≤450 ms, so
// a reader who jump-scrolls anywhere never lands on an empty plum field.

import { useEffect, useRef, useState } from 'react'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** The rootMargin every stackd reveal uses: fire just before the element arrives. */
export const REVEAL_MARGIN = '0px 0px 10% 0px'

/**
 * True once mounted in a browser that allows motion. Entrances key off this,
 * so no-JS and reduced-motion readers get the finished state and never a
 * hidden one.
 */
export function useArmed(): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!prefersReducedMotion()) setArmed(true)
  }, [])
  return armed
}

/**
 * 0..1 progress of an element travelling up the viewport, written to `--p`.
 *
 * `start` / `end` are viewport fractions for the element's TOP edge: p = 0
 * when the top sits at start*vh, p = 1 when it has climbed to end*vh.
 * The scroll listener is only attached while the element is near the
 * viewport. Reduced motion pins p at 1 (the finished state).
 */
export function useViewProgress<T extends HTMLElement = HTMLElement>(
  opts: { start?: number; end?: number; onChange?: (p: number) => void } = {},
) {
  const ref = useRef<T | null>(null)
  const cb = useRef(opts.onChange)
  cb.current = opts.onChange
  const start = opts.start ?? 0.9
  const end = opts.end ?? 0.25

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (prefersReducedMotion()) {
      el.style.setProperty('--p', '1')
      cb.current?.(1)
      return
    }
    let raf = 0
    let active = false
    const update = () => {
      raf = 0
      const r = el.getBoundingClientRect()
      const vh = window.innerHeight || 1
      const p = clamp01((start * vh - r.top) / ((start - end) * vh))
      el.style.setProperty('--p', p.toFixed(4))
      cb.current?.(p)
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }
    const attach = () => {
      if (active) return
      active = true
      window.addEventListener('scroll', onScroll, { passive: true })
      window.addEventListener('resize', onScroll, { passive: true })
      update()
    }
    const detach = () => {
      if (!active) return
      active = false
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      update()
    }
    update()
    if (typeof IntersectionObserver === 'undefined') {
      attach()
      return detach
    }
    const io = new IntersectionObserver(
      ([e]) => (e?.isIntersecting ? attach() : detach()),
      { rootMargin: '30% 0px 30% 0px' },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      detach()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [start, end])

  return ref
}

/**
 * Whether an element is (or once was, with `once`) near the viewport.
 * Defaults to true without IntersectionObserver so nothing stays hidden.
 * Defaults follow the reveal rules: threshold 0, fire 10% early.
 */
export function useInView<T extends Element = HTMLElement>(
  opts: { rootMargin?: string; once?: boolean; threshold?: number } = {},
) {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  const { rootMargin = REVEAL_MARGIN, once = false, threshold = 0 } = opts
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return
        if (e.isIntersecting) {
          setInView(true)
          if (once) io.disconnect()
        } else if (!once) setInView(false)
      },
      { rootMargin, threshold: Math.min(threshold, 0.05) },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin, once, threshold])
  return { ref, inView }
}

/**
 * A pulse flag: true for `ms` each time `key` changes after the first render.
 * Used for one-shot flourishes (the door sign flipping when the kitchen opens
 * or closes). Never fires under reduced motion.
 */
export function useChangePulse(key: unknown, ms: number): boolean {
  const [on, setOn] = useState(false)
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (prefersReducedMotion()) return
    setOn(true)
    const id = window.setTimeout(() => setOn(false), ms)
    return () => window.clearTimeout(id)
  }, [key, ms])
  return on
}
