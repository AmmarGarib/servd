import type { CharacterKind } from './types'

/** Window CustomEvent name every FoodCrowd listens on. */
export const CROWD_EVENT = 'servd:crowd'

/**
 * Page-wide cues for every mounted crowd (and the companion).
 *
 * - `cheer`: one character (or the whole cast when `kind` is omitted) jumps.
 * - `look`: the crowd glances at a viewport point, in CSS pixels
 *   (same space as `MouseEvent.clientX/clientY`). The next real pointer
 *   move takes over again.
 * - `focus`: that character steps forward and waves; the others turn their
 *   heads to it. `kind: null` puts everyone back in the line.
 * - `wave`: an arm wave in place.
 * - `gasp`: a small hop back, eyes wide, arms up (empty / closed states).
 * - `catch`: arms up, a happy squash and a small jump (item landed in the bag).
 */
export type CrowdEvent =
  | { type: 'cheer'; kind?: CharacterKind }
  | { type: 'look'; x: number; y: number }
  | { type: 'focus'; kind: CharacterKind | null }
  | { type: 'wave'; kind?: CharacterKind }
  | { type: 'gasp'; kind?: CharacterKind }
  | { type: 'catch'; kind?: CharacterKind }

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
    if (detail && typeof detail === 'object' && 'type' in detail) {
      try {
        handler(detail)
      } catch {
        /* a decorative listener must never throw into the dispatcher */
      }
    }
  }
  window.addEventListener(CROWD_EVENT, listener)
  return () => window.removeEventListener(CROWD_EVENT, listener)
}
