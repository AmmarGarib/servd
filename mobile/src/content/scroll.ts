// Tiny scroll-progress bus. Screens that render content report how far down
// their ScrollView the customer is; PopupHost listens for `scroll` triggers.

import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

type Listener = (pct: number) => void
const listeners = new Set<Listener>()

export function onScrollProgress(fn: Listener): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Pass as a ScrollView `onScroll` (with scrollEventThrottle ~100). */
export function reportScroll(e: NativeSyntheticEvent<NativeScrollEvent>): void {
  if (listeners.size === 0) return
  const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
  const scrollable = contentSize.height - layoutMeasurement.height
  const pct = scrollable <= 0 ? 100 : Math.max(0, Math.min(100, (contentOffset.y / scrollable) * 100))
  for (const fn of listeners) fn(pct)
}
