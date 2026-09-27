'use client'
// One orange per viewport, enforced at runtime.
//
// The bible allows one orange signal on screen at a time. A lit candle IS
// that signal, so every other orange mark on the page (the rail ember, the
// sign-off full stop) asks this tiny store whether a lit candle is on screen
// and, if so, sets itself in ink instead (bone on tiber, tiber on bone).
//
// Each lit candle registers while it is intersecting the viewport; the store
// is a counter with subscribers, read through useSyncExternalStore so a
// change re-renders only the marks that care — a handful of renders per
// scroll pass, never per frame.

import { useEffect, useSyncExternalStore, type RefObject } from 'react'

let lit = 0
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

function subscribe(cb: () => void) {
  subs.add(cb)
  return () => { subs.delete(cb) }
}
const snapshot = () => lit > 0
const serverSnapshot = () => false

/** True while any lit simmer candle is on screen. */
export function useLitCandleOnScreen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

/** Registers the element as a lit candle while it is on screen and `active`. */
export function useRegisterLitCandle(ref: RefObject<HTMLElement>, active: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el || !active || typeof IntersectionObserver === 'undefined') return
    let counted = false
    const set = (on: boolean) => {
      if (on === counted) return
      counted = on
      lit += on ? 1 : -1
      emit()
    }
    const io = new IntersectionObserver(([e]) => set(!!e && e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => {
      io.disconnect()
      set(false)
    }
  }, [ref, active])
}
