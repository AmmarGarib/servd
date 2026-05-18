'use client'
import { useEffect, useRef } from 'react'

/**
 * useScrollReveal — attaches .is-revealed to a container once its
 * children's .reveal-on-scroll elements enter the viewport. The default
 * threshold (0.18) means roughly the top sliver of the element has to be
 * visible before reveal fires.
 *
 * Mount this at a section level; the IntersectionObserver wires up all
 * children inside the ref'd element.
 */
export function useScrollReveal<T extends HTMLElement = HTMLElement>(options: IntersectionObserverInit = {}) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const el = ref.current
    if (!el) return
    const targets = el.querySelectorAll<HTMLElement>('.reveal-on-scroll')
    if (targets.length === 0) return
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-revealed')
          io.unobserve(e.target)         // reveal once, never undo
        }
      }
    }, { threshold: 0.18, rootMargin: '0px 0px -10% 0px', ...options })
    targets.forEach((t) => io.observe(t))
    return () => io.disconnect()
  }, [])
  return ref
}

/**
 * useScrollParallax — translates a single element at a fraction of the
 * page scroll speed. Bind it to the element you want to drift (typically
 * a kinetic shape behind the hero). The element should already carry
 * .kinetic-parallax + style={{ '--parallax': '0.3' }} so the CSS picks
 * up the offset.
 *
 * The hook keeps a single requestAnimationFrame loop and only pushes a
 * style var, so 6 parallax elements all share the same RAF rather than
 * stacking 6 listeners.
 */
const _parallaxNodes = new Set<HTMLElement>()
let _parallaxRaf = 0
function _parallaxTick() {
  const y = window.scrollY
  for (const node of _parallaxNodes) {
    node.style.setProperty('--scroll-y', `${y}px`)
  }
  _parallaxRaf = 0
}
function _onScroll() {
  if (_parallaxRaf) return
  _parallaxRaf = requestAnimationFrame(_parallaxTick)
}

export function useScrollParallax<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    _parallaxNodes.add(el)
    if (_parallaxNodes.size === 1) {
      window.addEventListener('scroll', _onScroll, { passive: true })
      _onScroll()
    }
    return () => {
      _parallaxNodes.delete(el)
      if (_parallaxNodes.size === 0) {
        window.removeEventListener('scroll', _onScroll)
        if (_parallaxRaf) { cancelAnimationFrame(_parallaxRaf); _parallaxRaf = 0 }
      }
    }
  }, [])
  return ref
}

/**
 * useScrollProgress — tracks 0..1 progress of how far the viewport has
 * travelled through a tall sticky section.
 *
 * Mental model: you have a `<section style={{ height: '300vh' }}>`. Inside
 * that section sits a single sticky child that pins for the full scroll
 * (`position: sticky; top: 0; height: 100vh`). As the user scrolls, the
 * outer section moves but the sticky child stays put. `progress` tells
 * you what fraction of the section has scrolled past — 0 at section top,
 * 1 at section bottom. Use the value to drive transforms / opacities on
 * the pinned child for cinematic scroll-driven animation.
 *
 * The hook writes progress to a CSS custom property (--scroll-progress)
 * on the ref'd element so plain CSS can read it without re-rendering.
 * It also returns the numeric progress for components that want to
 * branch behaviour (e.g. unmount the burger once progress > 0.9).
 */
export function useScrollProgress<T extends HTMLElement = HTMLElement>(options?: {
  /** When to start the 0..1 mapping. Default 0 (section top hits viewport top). */
  startAt?: number
  /** When to clamp at 1. Default 1 (section bottom hits viewport top). */
  endAt?: number
}) {
  const ref = useRef<T | null>(null)
  const progressRef = useRef(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const startAt = options?.startAt ?? 0
    const endAt   = options?.endAt   ?? 1

    let raf = 0
    function update() {
      raf = 0
      const rect = el!.getBoundingClientRect()
      const vh   = window.innerHeight
      // section pinned-progress = (vh - rect.top) / (rect.height) clamped 0..1.
      // rect.top starts at vh (section below viewport), goes negative as it scrolls past.
      const total = rect.height - vh
      if (total <= 0) {
        el!.style.setProperty('--scroll-progress', '0')
        progressRef.current = 0
        return
      }
      const raw = Math.max(0, Math.min(1, -rect.top / total))
      // Remap to the requested [startAt, endAt] band so callers can use
      // the same hook for "starts a third of the way down" effects.
      const remap = Math.max(0, Math.min(1, (raw - startAt) / (endAt - startAt)))
      el!.style.setProperty('--scroll-progress', remap.toFixed(4))
      progressRef.current = remap
    }
    function onScroll() {
      if (raf) return
      raf = requestAnimationFrame(update)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    update()
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [options?.startAt, options?.endAt])
  return { ref, progressRef }
}

/**
 * useCursorMagnet — element drifts toward the cursor when the cursor is
 * inside its bounding box. Pulled gently — divisor controls strength
 * (smaller = stronger pull).
 *
 * Disabled on touch devices via pointer-coarse media query; mobile users
 * shouldn't have anything chasing nothing.
 */
export function useCursorMagnet<T extends HTMLElement = HTMLElement>(strength = 0.18) {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Skip on touch / coarse pointer devices.
    if (window.matchMedia?.('(pointer: coarse)').matches) return

    function onMove(e: MouseEvent) {
      const rect = el!.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      el!.style.setProperty('--magnet-x', `${(e.clientX - cx) * strength}px`)
      el!.style.setProperty('--magnet-y', `${(e.clientY - cy) * strength}px`)
    }
    function onLeave() {
      el!.style.setProperty('--magnet-x', '0px')
      el!.style.setProperty('--magnet-y', '0px')
    }

    const parent = el.parentElement ?? el
    parent.addEventListener('mousemove', onMove)
    parent.addEventListener('mouseleave', onLeave)
    return () => {
      parent.removeEventListener('mousemove', onMove)
      parent.removeEventListener('mouseleave', onLeave)
    }
  }, [strength])
  return ref
}
