import { isCharacterKind, isMood, type CharacterKind, type Mood } from './types'

/** Window CustomEvent name every crowd listener subscribes to. */
export const CROWD_EVENT = 'servd:crowd'

/**
 * The page-wide crowd bus.
 *
 * - `cheer`: one character (or the whole cast when `kind` is omitted) jumps.
 * - `look`: the crowd glances at a viewport point, in CSS pixels (the same
 *   space as `MouseEvent.clientX/clientY`). The next real pointer move takes
 *   over again.
 * - `react`: pull a face (`kind` narrows it to one character) for `seconds`.
 * - `catch`: a dish was added at a viewport point; the matching character
 *   (or the nearest one) hops proudly and turns toward it. `label` is copy
 *   for whoever shows a bubble (the buddy).
 * - `say`: the buddy's speech bubble, 48 characters at most.
 * - `stage`: a stage crowd or the footer crew entered or left the viewport.
 */
export type CrowdEvent =
  | { type: 'cheer'; kind?: CharacterKind }
  | { type: 'look'; x: number; y: number }
  | { type: 'react'; mood: Mood; kind?: CharacterKind; seconds?: number }
  | { type: 'catch'; x: number; y: number; kind?: CharacterKind; label?: string }
  | { type: 'say'; text: string; seconds?: number }
  | { type: 'stage'; id: string; visible: boolean }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const optKind = (v: unknown): CharacterKind | undefined => (isCharacterKind(v) ? v : undefined)
const optSeconds = (v: unknown): number | undefined => (num(v) && v > 0 ? Math.min(v, 60) : undefined)

/**
 * Validates an untrusted event payload. Returns a clean copy (unknown fields
 * dropped, optional fields omitted when invalid) or `null`. Never throws.
 */
export function parseCrowdEvent(v: unknown): CrowdEvent | null {
  try {
    if (!v || typeof v !== 'object') return null
    const d = v as Record<string, unknown>
    switch (d.type) {
      case 'cheer': {
        const kind = optKind(d.kind)
        return kind ? { type: 'cheer', kind } : { type: 'cheer' }
      }
      case 'look':
        return num(d.x) && num(d.y) ? { type: 'look', x: d.x, y: d.y } : null
      case 'react': {
        if (!isMood(d.mood)) return null
        const e: { type: 'react'; mood: Mood; kind?: CharacterKind; seconds?: number } = { type: 'react', mood: d.mood }
        const kind = optKind(d.kind)
        const seconds = optSeconds(d.seconds)
        if (kind) e.kind = kind
        if (seconds !== undefined) e.seconds = seconds
        return e
      }
      case 'catch': {
        if (!num(d.x) || !num(d.y)) return null
        const e: { type: 'catch'; x: number; y: number; kind?: CharacterKind; label?: string } = { type: 'catch', x: d.x, y: d.y }
        const kind = optKind(d.kind)
        if (kind) e.kind = kind
        if (typeof d.label === 'string' && d.label.trim()) e.label = d.label.trim().slice(0, 48)
        return e
      }
      case 'say': {
        if (typeof d.text !== 'string' || !d.text.trim()) return null
        const e: { type: 'say'; text: string; seconds?: number } = { type: 'say', text: d.text.trim().slice(0, 48) }
        const seconds = optSeconds(d.seconds)
        if (seconds !== undefined) e.seconds = seconds
        return e
      }
      case 'stage':
        return typeof d.id === 'string' && d.id && typeof d.visible === 'boolean' ? { type: 'stage', id: d.id, visible: d.visible } : null
      default:
        return null
    }
  } catch {
    return null
  }
}

export function emitCrowd(e: CrowdEvent): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent<CrowdEvent>(CROWD_EVENT, { detail: e }))
  } catch {
    /* never let a decorative effect break the caller */
  }
}

/**
 * Subscribe to crowd events. Payloads are validated first (a malformed event
 * is dropped), and a throwing handler never reaches the emitter. Returns an
 * unsubscribe function.
 */
export function onCrowd(handler: (e: CrowdEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (ev: Event) => {
    const e = parseCrowdEvent((ev as CustomEvent<unknown>).detail)
    if (!e) return
    try {
      handler(e)
    } catch {
      /* a listener's bug stays with the listener */
    }
  }
  window.addEventListener(CROWD_EVENT, listener)
  return () => window.removeEventListener(CROWD_EVENT, listener)
}
