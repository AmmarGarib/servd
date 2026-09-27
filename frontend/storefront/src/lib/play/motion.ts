// Reduced-motion preference, read live. The hook starts false (SSR has no
// media queries) and updates after mount and on every OS setting change.

import { useEffect, useState } from 'react'

const QUERY = '(prefers-reduced-motion: reduce)'

/** Non-hook read, for event handlers and effects. False on the server. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(QUERY).matches
  } catch {
    return false
  }
}

/** Subscribe to reduced-motion changes. Returns an unsubscribe function. */
export function onReducedMotionChange(h: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  let mq: MediaQueryList
  try {
    mq = window.matchMedia(QUERY)
  } catch {
    return () => {}
  }
  const listener = (e: MediaQueryListEvent) => h(e.matches)
  if (typeof mq.addEventListener === 'function') {
    mq.addEventListener('change', listener)
    return () => mq.removeEventListener('change', listener)
  }
  // Safari < 14
  mq.addListener(listener)
  return () => mq.removeListener(listener)
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    setReduced(prefersReducedMotion())
    return onReducedMotionChange(setReduced)
  }, [])
  return reduced
}
