'use client'
// Open/closed status for Flipd's diner sign.
//
// There is ONE rule set for "is this kitchen open" on servd now:
// lib/world/kitchenCore (computeOpen, via kitchenState) (PKT, windows per weekday, windows that cross
// midnight, yesterday's late window). This file keeps its old exports so the
// Flipd pages don't change shape, but the computation is delegated there —
// the diner neon, the home kitchen board, the buddy and the doors scenes all
// agree about whether the grill is on.
//
// Flipd still renders its own sign (the shared badge's red-on-tint fails
// 4.5:1 on every Flipd ground), so this also builds the KitchenState the
// voice layer needs for the sign's line.

import { useEffect, useMemo, useState } from 'react'
import type { HoursData, ServiceHourRow } from '../parts/OpenStatusBadge'
import { kitchenState, type KitchenPhase, type KitchenState } from '../../../lib/world/kitchenCore'
import { useKitchen } from '../../../lib/world/kitchens'

export interface OpenStatus {
  open: boolean
  inactive: boolean
  closesAt: string | null
  opensAt: string | null
  /** open · closing (≤ 45 min left) · opening (≤ 60 min to go) · closed */
  phase: KitchenPhase
  closesInMin: number | null
  opensInMin: number | null
  /** The same status as a world KitchenState, for kitchenLine(). */
  kitchen: KitchenState
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function pktNow(): { day: number; mins: number } {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const pkt = new Date(utcMs + 5 * 60 * 60_000)
  return { day: pkt.getDay(), mins: pkt.getHours() * 60 + pkt.getMinutes() }
}

export function formatMins(m: number): string {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  const period = h < 12 ? 'AM' : 'PM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${mm.toString().padStart(2, '0')} ${period}`
}

export function windowsFor(hours: ServiceHourRow[], day: number) {
  return hours.filter((h) => h.dayOfWeek === day).sort((a, b) => a.openMin - b.openMin)
}

/** Status from the brand's published hours, on kitchenCore's rules (which
 *  also cover inactive = closed and no published hours = open). */
function statusFromHours(data: HoursData, now: Date): OpenStatus {
  return { ...statusFromKitchen(kitchenState('flipd', data.hours, data.isActive, now)), inactive: !data.isActive }
}

/** Status from the world's kitchen store (its fallback hours until live). */
function statusFromKitchen(k: KitchenState): OpenStatus {
  return {
    open: k.open, inactive: false, closesAt: k.closesAt, opensAt: k.opensAt,
    phase: k.phase, closesInMin: k.closesInMin, opensInMin: k.opensInMin,
    kitchen: k,
  }
}

/**
 * Live status, re-evaluated every 30 s. Never null: until the brand's own
 * hours arrive (or when the API is down) it reads the world's kitchen state
 * for Flipd, so the sign is never blank and always agrees with the rest of
 * the site.
 */
export function useOpenStatus(hoursData: HoursData | null): OpenStatus {
  const kitchen = useKitchen('flipd')
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    if (!hoursData) return
    setNow(new Date())
    const id = window.setInterval(() => setNow(new Date()), 30_000)
    const onVis = () => { if (document.visibilityState === 'visible') setNow(new Date()) }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [hoursData])
  return useMemo(
    () => (hoursData && now ? statusFromHours(hoursData, now) : statusFromKitchen(kitchen)),
    [hoursData, now, kitchen],
  )
}

/** Today's weekday in PKT, client-only (null during SSR to avoid a mismatch). */
export function usePktToday(): number | null {
  const [day, setDay] = useState<number | null>(null)
  useEffect(() => { setDay(pktNow().day) }, [])
  return day
}
