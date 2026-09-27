'use client'

// Tray & Toss: the flight of an added item into the basket pill.
//
// tossToBasket() is imperative on purpose. It is called from click handlers
// (card quick-add, the modal's Add button) and paints a short-lived clone
// straight into document.body, so a toss never re-renders the menu.
//
// Flight (560ms, WAAPI, three nested layers so each axis keeps its own curve):
//   outer  -> translateX with cubic-bezier(.3,.7,.2,1)
//   middle -> translateY: a gravity arc that peaks 120px above the start,
//             built from a parabola (time-to-peak derived from the drop)
//   inner  -> rotate 0 -> 540deg, scale 1 -> 0.45, linear
//
// On landing it fires a `servd:basket-catch` window event. The pill listens
// (useBasketCatch) to squash, roll its odometer, thunk, buzz and cheer.
//
// Rapid adds queue their clones 90ms apart. Reduced motion (or calm mode on
// simmer's reduced path) skips the flight: the catch fires at once and the
// pill does a short opacity flash instead.

import { useEffect, useRef } from 'react'
import styles from './toss.module.css'

export const BASKET_PILL_ATTR = 'data-basket-pill'
export const BASKET_CATCH_EVENT = 'servd:basket-catch'

export type TossTone = 'servd' | 'stackd' | 'flipd' | 'simmer'

export interface BasketCatch {
  /** Landing point, viewport px (the pill's centre). */
  x: number
  y: number
  /** True when no flight ran (reduced motion / no pill on screen). */
  instant: boolean
  label: string
}

export interface TossOptions {
  tone?: TossTone
  /** Calm flight (simmer): a straight glide and fade, no spin, no arc. */
  calm?: boolean
}

type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

const DURATION = 560
const STAGGER = 90
const DISC = 56
const EASE_X = 'cubic-bezier(.3,.7,.2,1)'
// Quadratic ease-out / ease-in: the two halves of a thrown arc.
const EASE_RISE = 'cubic-bezier(.33,.66,.66,1)'
const EASE_FALL = 'cubic-bezier(.33,0,.66,.33)'

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

let nextSlot = 0
let inFlight = 0

/** How many clones are airborne or queued right now. */
export function tossesInFlight(): number {
  return inFlight
}

function dispatchCatch(detail: BasketCatch) {
  try {
    window.dispatchEvent(new CustomEvent<BasketCatch>(BASKET_CATCH_EVENT, { detail }))
  } catch {
    /* decorative: never break the caller */
  }
}

function findPill(): DOMRect | null {
  const el = document.querySelector<HTMLElement>(`[${BASKET_PILL_ATTR}]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return r
}

/** The pill mounts on the render after the first add, so give it a few frames. */
function waitForPill(timeoutMs = 360): Promise<DOMRect | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = () => {
      const r = findPill()
      if (r) return resolve(r)
      if (performance.now() - started > timeoutMs) return resolve(null)
      requestAnimationFrame(tick)
    }
    // Two frames first so React has committed the add.
    requestAnimationFrame(() => requestAnimationFrame(tick))
  })
}

function buildClone(imageUrl: string | null, label: string, tone: TossTone) {
  const outer = document.createElement('div')
  outer.className = styles.flyOuter ?? ''
  outer.setAttribute('aria-hidden', 'true')
  outer.dataset['tone'] = tone
  const middle = document.createElement('div')
  middle.className = styles.flyMiddle ?? ''
  const disc = document.createElement('div')
  disc.className = styles.flyDisc ?? ''
  if (imageUrl) {
    const img = document.createElement('img')
    img.src = imageUrl
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    img.className = styles.flyImg ?? ''
    // A broken photo falls back to the letter disc rather than an empty ring.
    img.addEventListener('error', () => {
      img.remove()
      disc.classList.add(styles.flyLetterDisc ?? '')
      disc.textContent = firstLetter(label)
    })
    disc.appendChild(img)
  } else {
    disc.classList.add(styles.flyLetterDisc ?? '')
    disc.textContent = firstLetter(label)
  }
  middle.appendChild(disc)
  outer.appendChild(middle)
  return { outer, middle, disc }
}

function firstLetter(label: string): string {
  const ch = Array.from(label.trim())[0] ?? '+'
  return ch.toUpperCase()
}

/** Keyframes for a parabola from 0 through `peak` (negative = up) to `drop`. */
function arcFrames(drop: number, peak: number): Keyframe[] {
  // y(t) = peak + g (t - tp)^2, y(0) = 0, y(1) = drop
  //  => (1 - tp) / tp = sqrt((drop - peak) / -peak)
  const r = Math.sqrt(Math.max(0, drop - peak) / Math.max(1, -peak))
  const tp = Math.min(0.8, Math.max(0.15, 1 / (1 + r)))
  return [
    { transform: 'translateY(0px)', offset: 0, easing: EASE_RISE },
    { transform: `translateY(${peak.toFixed(1)}px)`, offset: tp, easing: EASE_FALL },
    { transform: `translateY(${drop.toFixed(1)}px)`, offset: 1 },
  ]
}

async function fly(from: RectLike, imageUrl: string | null, label: string, opts: TossOptions): Promise<void> {
  const target = await waitForPill()
  if (!target) {
    const r = from
    dispatchCatch({ x: r.left + r.width / 2, y: r.top + r.height / 2, instant: true, label })
    return
  }
  const tx = target.left + target.width / 2
  const ty = target.top + target.height / 2
  const sx = from.left + from.width / 2
  const sy = from.top + from.height / 2
  const dx = tx - sx
  const dy = ty - sy
  const tone = opts.tone ?? 'servd'
  const { outer, middle, disc } = buildClone(imageUrl, label, tone)
  outer.style.left = `${sx - DISC / 2}px`
  outer.style.top = `${sy - DISC / 2}px`
  document.body.appendChild(outer)

  const anims: Animation[] = []
  try {
    if (opts.calm) {
      // simmer: an unhurried glide, no spin and no bounce.
      const calm = { duration: 420, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' as const }
      anims.push(outer.animate([{ transform: 'translateX(0px)' }, { transform: `translateX(${dx}px)` }], calm))
      anims.push(middle.animate([{ transform: 'translateY(0px)' }, { transform: `translateY(${dy}px)` }], calm))
      anims.push(disc.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: 'scale(0.5)', opacity: 0.2 },
      ], calm))
    } else {
      const peak = Math.min(-120, dy - 40)
      anims.push(outer.animate(
        [{ transform: 'translateX(0px)' }, { transform: `translateX(${dx.toFixed(1)}px)` }],
        { duration: DURATION, easing: EASE_X, fill: 'forwards' },
      ))
      anims.push(middle.animate(arcFrames(dy, peak), { duration: DURATION, fill: 'forwards' }))
      anims.push(disc.animate(
        [
          { transform: 'rotate(0deg) scale(1)' },
          { transform: 'rotate(540deg) scale(0.45)' },
        ],
        { duration: DURATION, easing: 'linear', fill: 'forwards' },
      ))
    }
    await Promise.all(anims.map((a) => a.finished))
  } catch {
    /* cancelled (tab hidden, element removed): still land it */
  } finally {
    outer.remove()
  }
  // Re-measure: the pill may have moved (mini crowd, safe area) mid-flight.
  const landed = findPill() ?? target
  dispatchCatch({ x: landed.left + landed.width / 2, y: landed.top + landed.height / 2, instant: false, label })
}

/**
 * Throw an item from `fromRect` into the basket pill ([data-basket-pill]).
 * Resolves once the item has landed (or instantly under reduced motion).
 */
export function tossToBasket(
  fromRect: RectLike,
  imageUrl: string | null,
  label: string,
  opts: TossOptions = {},
): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const from: RectLike = { left: fromRect.left, top: fromRect.top, width: fromRect.width, height: fromRect.height }

  if (prefersReducedMotion() || typeof Element.prototype.animate !== 'function') {
    inFlight += 1
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        inFlight = Math.max(0, inFlight - 1)
        const pill = findPill()
        const r = pill ?? from
        dispatchCatch({ x: r.left + r.width / 2, y: r.top + r.height / 2, instant: true, label })
        resolve()
      }))
    })
  }

  const now = performance.now()
  const start = Math.max(now, nextSlot)
  nextSlot = start + STAGGER
  inFlight += 1
  return new Promise((resolve) => {
    window.setTimeout(() => {
      fly(from, imageUrl, label, opts)
        .catch(() => undefined)
        .finally(() => {
          inFlight = Math.max(0, inFlight - 1)
          resolve()
        })
    }, start - now)
  })
}

/** Subscribe to landings. The handler is kept fresh without re-subscribing. */
export function useBasketCatch(handler: (c: BasketCatch) => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const listener = (ev: Event) => {
      const detail = (ev as CustomEvent<BasketCatch>).detail
      if (detail && typeof detail.x === 'number') ref.current(detail)
    }
    window.addEventListener(BASKET_CATCH_EVENT, listener)
    return () => window.removeEventListener(BASKET_CATCH_EVENT, listener)
  }, [])
}
