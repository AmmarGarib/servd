// Scroll effects in the app (D4 stage 1).
//
// The web storefront plays a block's `motion` (parallax, fade as you scroll,
// …) as a scroll-driven effect. The app has no scroll effects yet (owner
// question pending), so it plays the closest one-shot ENTRANCE instead. The
// block's own `animation` always wins, so every block saved before scroll
// effects existed renders exactly as it did. An unknown or malformed motion
// value — a preset added on the web after this build shipped, junk JSON —
// means "no animation": the content is static and fully visible, never hidden.

import { useSyncExternalStore } from 'react'
import { AccessibilityInfo } from 'react-native'
import { MOTION_PRESETS, type Animation, type MotionPreset } from './types'

/** The entrance the app plays for each scroll effect. */
export const MOTION_ENTRANCE: Readonly<Record<MotionPreset, Animation>> = {
  'parallax':     'fade-in',
  'fade':         'fade-in',
  'grow':         'zoom-in',
  'pin-reveal':   'fade-up',
  'sticky-stack': 'fade-up',
  'side-pan':     'slide-left',
  'text-reveal':  'fade-up',
}

function isPreset(v: unknown): v is MotionPreset {
  return typeof v === 'string' && (MOTION_PRESETS as readonly string[]).includes(v)
}

/** The motion's preset when `motion` is a plain object with a known preset, else null. */
export function motionPreset(motion: unknown): MotionPreset | null {
  if (!motion || typeof motion !== 'object' || Array.isArray(motion)) return null
  let preset: unknown
  try { preset = (motion as Record<string, unknown>)['preset'] } catch { return null }
  return isPreset(preset) ? preset : null
}

/** The block's own entrance (`animation`, any string but 'none'), else null. */
export function ownEntrance(block: unknown): Animation | null {
  try {
    if (!block || typeof block !== 'object') return null
    const own = (block as Record<string, unknown>)['animation']
    return typeof own === 'string' && own !== 'none' ? (own as Animation) : null
  } catch {
    return null
  }
}

/**
 * Which entrance a block plays in the app.
 *   1. its own `animation` (any string but 'none') — unchanged, as before;
 *   2. else a known `motion` preset mapped to an entrance, unless the device
 *      asks for reduced motion;
 *   3. else 'none' (static, fully visible).
 * Never throws.
 */
export function entranceFor(block: unknown, reduceMotion: boolean): Animation {
  const own = ownEntrance(block)
  if (own) return own
  if (reduceMotion === true) return 'none'
  try {
    const preset = motionPreset((block as Record<string, unknown>)['motion'])
    if (preset) return MOTION_ENTRANCE[preset]
  } catch {
    // A getter that throws, a proxy, … — treat as no animation.
  }
  return 'none'
}

// The device's "reduce motion" setting, shared by every block: one native
// listener while anything is subscribed. The last known value is kept, so a
// block mounted later starts in the right state instead of flashing an
// entrance first. Unknown while loading = false.
let reduceMotionNow = false
const reduceListeners = new Set<() => void>()
let reduceSub: { remove: () => void } | null = null

function setReduceMotion(v: unknown): void {
  const next = v === true
  if (next === reduceMotionNow) return
  reduceMotionNow = next
  for (const fn of reduceListeners) fn()
}

function subscribeReduceMotion(fn: () => void): () => void {
  reduceListeners.add(fn)
  if (reduceListeners.size === 1) {
    try {
      AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion, () => { /* keep the last value */ })
    } catch { /* not available on this platform */ }
    try {
      reduceSub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)
    } catch { reduceSub = null }
  }
  return () => {
    reduceListeners.delete(fn)
    if (reduceListeners.size === 0) {
      try { reduceSub?.remove() } catch { /* ignore */ }
      reduceSub = null
    }
  }
}

const readReduceMotion = () => reduceMotionNow

/** The device's "reduce motion" setting, kept up to date. */
export function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, readReduceMotion, readReduceMotion)
}
