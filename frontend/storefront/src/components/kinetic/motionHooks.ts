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
