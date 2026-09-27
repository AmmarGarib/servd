// collect(): the one call every toy makes when its sticker is earned.
//
// A fresh find emits `fresh: true` and the PlayLayer flies the sticker from
// `at` (viewport px; defaults to the viewport centre) into the tin. A repeat
// find emits `fresh: false` and the PlayLayer only shows a tiny pop at `at`,
// so poking a toy you already solved still answers you.

import type { StickerId } from './stickers'
import { emitPlay } from './bus'
import { usePlay } from './store'

export function collect(id: StickerId, at?: { x: number; y: number }): boolean {
  if (typeof window === 'undefined') return false
  let fresh = false
  try {
    fresh = usePlay.getState().award(id)
  } catch {
    fresh = false
  }
  emitPlay({ type: 'collect', id, x: at?.x, y: at?.y, fresh })
  return fresh
}
