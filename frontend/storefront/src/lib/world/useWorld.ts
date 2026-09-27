'use client'
// The world's mood on the client: day-part (with the ?daypart= override),
// Karachi clock label, and how many kitchens are cooking.
//
// Before mount it returns lunch with ready:false, identical on server and
// client, so nothing that reads it can cause a hydration mismatch. VISUAL
// tinting must never wait for this hook — it comes from the server-stamped
// html[data-daypart] / [data-world-dark] attributes (WorldSync keeps them
// live). Only copy and behaviour should wait for `ready`.

import { useSyncExternalStore } from 'react'
import {
  dayPartFor,
  karachiClockLabel,
  karachiNow,
  moodFor,
  parseDayPart,
  type DayPart,
  type WorldMood,
} from './clock'
import { useKitchens } from './kitchens'

export const DAYPART_PARAM = 'daypart'
export const DAYPART_COOKIE = 'servd_daypart'

export type World = WorldMood & {
  ready: boolean
  openCount: number
  override: DayPart | null
  /** '9:42pm'; '' until mounted. */
  clock: string
}

interface ClockSnap { ready: boolean; dayPart: DayPart; override: DayPart | null; clock: string }

const SERVER_CLOCK: ClockSnap = { ready: false, dayPart: 'lunch', override: null, clock: '' }
const TICK_MS = 30_000

function readCookie(name: string): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))
    return m ? decodeURIComponent(m[1] ?? '') : null
  } catch {
    return null
  }
}

/** ?daypart= wins (and 'live' means none); otherwise the session cookie. */
export function readDayPartOverride(): DayPart | null {
  if (typeof window === 'undefined') return null
  try {
    const q = new URLSearchParams(window.location.search).get(DAYPART_PARAM)
    if (q !== null) return q.trim().toLowerCase() === 'live' ? null : parseDayPart(q)
  } catch {
    /* fall through to the cookie */
  }
  return parseDayPart(readCookie(DAYPART_COOKIE))
}

let snap: ClockSnap = SERVER_CLOCK
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function recompute(): void {
  const override = readDayPartOverride()
  const now = new Date()
  const next: ClockSnap = {
    ready: true,
    override,
    dayPart: override ?? dayPartFor(karachiNow(now).mins),
    clock: karachiClockLabel(now),
  }
  if (next.ready === snap.ready && next.dayPart === snap.dayPart && next.override === snap.override && next.clock === snap.clock) return
  snap = next
  for (const l of listeners) l()
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') recompute()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  if (listeners.size === 1) {
    timer = setInterval(recompute, TICK_MS)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('popstate', recompute)
    queueMicrotask(recompute)
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) {
      if (timer) clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('popstate', recompute)
    }
  }
}

const getSnapshot = (): ClockSnap => snap
const getServerSnapshot = (): ClockSnap => SERVER_CLOCK

/** Force a re-read (e.g. after a client navigation changed ?daypart=). */
export function refreshWorld(): void {
  if (typeof window !== 'undefined') recompute()
}

export function useWorld(): World {
  const c = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const k = useKitchens()
  const openCount = c.ready ? k.openCount : 3
  const mood = moodFor(c.dayPart, openCount)
  return { ...mood, ready: c.ready, openCount, override: c.override, clock: c.clock }
}
