// Scroll velocity for toys that react to a hard flick (the crowd flinches,
// doodles jiggle). One passive window scroll listener, attached lazily on
// first use and sampled once per animation frame.
//
// Works with Lenis on or off: Lenis keeps the document as the native scroller
// and only interpolates window.scrollY, so native scroll events still fire.

const FLICK_THRESHOLD = 2200 // px/s
const FLICK_COOLDOWN = 600 // ms
const EMA = 0.25
const IDLE_MS = 120 // no scroll for this long means we are at rest

let attached = false
let scheduled = false
let lastY = 0
let lastT = 0
let velocity = 0
let lastFlick = -Infinity
const flickHandlers = new Set<(v: number) => void>()

function sample(): void {
  scheduled = false
  const now = performance.now()
  const y = window.scrollY
  const dt = now - lastT
  if (lastT === 0 || dt > IDLE_MS) {
    // First frame after rest: take a baseline, no velocity yet.
    lastY = y
    lastT = now
    velocity = 0
    return
  }
  if (dt <= 0) return
  const instant = ((y - lastY) / dt) * 1000
  velocity += EMA * (instant - velocity)
  lastY = y
  lastT = now
  if (Math.abs(velocity) > FLICK_THRESHOLD && now - lastFlick >= FLICK_COOLDOWN && flickHandlers.size > 0) {
    lastFlick = now
    const v = velocity
    flickHandlers.forEach((h) => {
      try {
        h(v)
      } catch {
        /* a decorative listener must not break the others */
      }
    })
  }
}

function onScroll(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(sample)
}

function ensureAttached(): void {
  if (attached || typeof window === 'undefined') return
  attached = true
  lastY = window.scrollY
  window.addEventListener('scroll', onScroll, { passive: true })
}

/** Smoothed scroll velocity in px/s, signed (+ = scrolling down). 0 at rest. */
export function getScrollVelocity(): number {
  if (typeof window === 'undefined') return 0
  ensureAttached()
  if (lastT === 0 || performance.now() - lastT > IDLE_MS) return 0
  return velocity
}

/** Fires when |v| > 2200 px/s, at most once every 600ms. Returns unsubscribe. */
export function onScrollFlick(h: (v: number) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  ensureAttached()
  flickHandlers.add(h)
  return () => {
    flickHandlers.delete(h)
  }
}
