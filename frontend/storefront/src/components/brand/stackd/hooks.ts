'use client'
// Small motion hooks for the stackd microsite. Everything here writes CSS
// custom properties or flips a class — React never re-renders per frame.

import { useEffect, useRef, useState } from 'react'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)

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
 */
export function useInView<T extends HTMLElement = HTMLElement>(
  opts: { rootMargin?: string; once?: boolean; threshold?: number } = {},
) {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(false)
  const { rootMargin = '0px', once = false, threshold = 0 } = opts
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
      { rootMargin, threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [rootMargin, once, threshold])
  return { ref, inView }
}
