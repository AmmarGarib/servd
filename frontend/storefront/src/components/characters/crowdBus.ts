import type { CharacterKind } from './types'

/** Window CustomEvent name every FoodCrowd listens on. */
export const CROWD_EVENT = 'servd:crowd'

/**
 * - `cheer`: one character (or the whole cast when `kind` is omitted) jumps.
 *   `big` = a 1.4x jump with a spin and arms up; for a single `kind`, both of
 *   its neighbours hop 80ms later.
 * - `look`: the crowd glances at a viewport point, in CSS pixels
 *   (same space as `MouseEvent.clientX/clientY`). The next real pointer
 *   move takes over again.
 * - `party`: every character does three staggered spin jumps (~2.2s), eyes
 *   wide, then settles. Under reduced motion it is a still happy-face swap.
 */
export type CrowdEvent =
  | { type: 'cheer'; kind?: CharacterKind; big?: boolean }
  | { type: 'look'; x: number; y: number }
  | { type: 'party' }

export function emitCrowd(e: CrowdEvent): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent<CrowdEvent>(CROWD_EVENT, { detail: e }))
  } catch {
    /* never let a decorative effect break the caller */
  }
}

/** Subscribe to crowd events. Returns an unsubscribe function. */
export function onCrowd(handler: (e: CrowdEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<CrowdEvent>).detail
    if (detail && typeof detail === 'object' && 'type' in detail) handler(detail)
  }
  window.addEventListener(CROWD_EVENT, listener)
  return () => window.removeEventListener(CROWD_EVENT, listener)
}
