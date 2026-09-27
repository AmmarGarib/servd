import type { CharacterKind } from './types'

/** Window CustomEvent name every FoodCrowd listens on. */
export const CROWD_EVENT = 'servd:crowd'

/**
 * - `cheer`: a happy jump plus each character's own flourish.
 *   `kind` picks one character, `kinds` picks several. With neither, the
 *   whole cast cheers. A `kinds` array is taken literally, so an empty one
 *   (e.g. `brandKinds('simmer')`) cheers nobody.
 * - `perk`: the named characters (or everyone) lean toward the cursor, widen
 *   their eyes and do one small hop; they stay keen for `ms` (default 1200),
 *   then settle back.
 * - `hint`: the leftmost visible character hops, turns to you and winks —
 *   a nudge toward whatever the page wants noticed.
 * - `wave`: a left-to-right stadium wave.
 * - `look`: the crowd glances at a viewport point, in CSS pixels
 *   (same space as `MouseEvent.clientX/clientY`). The next real pointer
 *   move takes over again.
 */
export type CrowdEvent =
  | { type: 'cheer'; kind?: CharacterKind; kinds?: CharacterKind[] }
  | { type: 'perk'; kinds?: CharacterKind[]; ms?: number }
  | { type: 'hint' }
  | { type: 'wave' }
  | { type: 'look'; x: number; y: number }

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

const BRAND_KINDS: Record<string, readonly CharacterKind[]> = {
  flipd: ['burger', 'fries', 'shake'],
  stackd: ['coffee', 'sandwich', 'croissant'],
}

/**
 * The characters that belong to a brand, for "the matching characters cheer".
 * flipd → burger, fries, shake. stackd → coffee, sandwich, croissant.
 * Anything else (simmer included — no characters there) → [].
 * Accepts legacy slugs (`stax…` → stackd) and any casing.
 */
export function brandKinds(slug: string | null | undefined): CharacterKind[] {
  if (!slug) return []
  let s = String(slug).trim().toLowerCase()
  if (s.startsWith('stax') && !s.startsWith('stax-padel')) s = 'stackd'
  const hit = BRAND_KINDS[s]
  return hit ? [...hit] : []
}
