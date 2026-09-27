// A tiny window event bus for the play layer. Any package can emit; the
// PlayLayer (and anything else that cares) listens. Decorative by nature, so
// nothing here may ever throw into a caller.

import type { StickerId } from './stickers'

export const PLAY_EVENT = 'servd:play'

export type Palette = 'servd' | 'stackd' | 'flipd'

export type PlayEvent =
  | { type: 'collect'; id: StickerId; x?: number; y?: number; fresh: boolean }
  | { type: 'poke'; source: string; x?: number; y?: number }
  | { type: 'celebrate'; x?: number; y?: number; palette?: Palette; power?: 'small' | 'big' }

export function emitPlay(e: PlayEvent): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent<PlayEvent>(PLAY_EVENT, { detail: e }))
  } catch {
    /* never let a decorative effect break the caller */
  }
}

/** Subscribe to play events. Returns an unsubscribe function. */
export function onPlay(h: (e: PlayEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (ev: Event) => {
    const detail = (ev as CustomEvent<PlayEvent>).detail
    if (detail && typeof detail === 'object' && 'type' in detail) {
      try {
        h(detail)
      } catch {
        /* one bad listener must not break the others */
      }
    }
  }
  window.addEventListener(PLAY_EVENT, listener)
  return () => window.removeEventListener(PLAY_EVENT, listener)
}

/** Event the sticker book listens on; fire it with openStickerBook(). */
export const OPEN_BOOK_EVENT = 'servd:open-sticker-book'

export function openStickerBook(): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(OPEN_BOOK_EVENT))
  } catch {
    /* ignore */
  }
}

/**
 * Attribute that marks an element as a toy. Its value is the verb the cursor
 * hint shows: 'poke' | 'drag' | 'flip' | 'pull' | 'peel' | 'throw' | 'tap'.
 */
export const TOY_ATTR = 'data-toy'

export type ToyVerb = 'poke' | 'drag' | 'flip' | 'pull' | 'peel' | 'throw' | 'tap'

export const TOY_VERBS: readonly ToyVerb[] = ['poke', 'drag', 'flip', 'pull', 'peel', 'throw', 'tap']

// The crowd bus belongs to the crowd engine (components/characters/crowdBus).
// The play layer only needs to fire 'cheer' and 'party' at it, and dispatching
// on the shared event name keeps this module independent of that file's exact
// type union (the 'party' and 'big' additions land with the crowd package).
const CROWD_EVENT = 'servd:crowd'

export function emitCrowdSignal(e: { type: 'cheer'; big?: boolean } | { type: 'party' }): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(CROWD_EVENT, { detail: e }))
  } catch {
    /* ignore */
  }
}
