'use client'
// Open/closed status for Flipd's diner sign.
//
// Same rules as computeStatus/pktNow in ../parts/OpenStatusBadge.tsx (PKT,
// windows per weekday, no published hours = open, inactive = closed), which
// are not exported. Flipd renders its own sign because the shared badge's
// red-on-tint (#dc2626) fails 4.5:1 on every Flipd ground — mustard, bone and
// blue alike. If those helpers get exported, import them here instead.

import { useEffect, useState } from 'react'
import type { HoursData, ServiceHourRow } from '../parts/OpenStatusBadge'

export interface OpenStatus {
  open: boolean
  inactive: boolean
  closesAt: string | null
  opensAt: string | null
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

function computeStatus(hours: ServiceHourRow[], day: number, mins: number) {
  const today = windowsFor(hours, day)
  for (const w of today) {
    if (mins >= w.openMin && mins < w.closeMin) return { open: true, closesAt: formatMins(w.closeMin), opensAt: null }
  }
  const later = today.find((w) => w.openMin > mins)
  if (later) return { open: false, closesAt: null, opensAt: `today ${formatMins(later.openMin)}` }
  for (let offset = 1; offset <= 6; offset++) {
    const d = (day + offset) % 7
    const w = windowsFor(hours, d)
    if (w.length > 0) {
      return { open: false, closesAt: null, opensAt: `${offset === 1 ? 'tomorrow' : DAY_LABELS[d]} ${formatMins(w[0]!.openMin)}` }
    }
  }
  return { open: false, closesAt: null, opensAt: null }
}

/** Live status, re-evaluated every minute. Null while hours are loading. */
export function useOpenStatus(hoursData: HoursData | null): OpenStatus | null {
  const [status, setStatus] = useState<OpenStatus | null>(null)
  useEffect(() => {
    if (!hoursData) { setStatus(null); return }
    const tick = () => {
      if (!hoursData.isActive) return setStatus({ open: false, inactive: true, closesAt: null, opensAt: null })
      if (hoursData.hours.length === 0) return setStatus({ open: true, inactive: false, closesAt: null, opensAt: null })
      const { day, mins } = pktNow()
      setStatus({ ...computeStatus(hoursData.hours, day, mins), inactive: false })
    }
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [hoursData])
  return status
}

/** Today's weekday in PKT, client-only (null during SSR to avoid a mismatch). */
export function usePktToday(): number | null {
  const [day, setDay] = useState<number | null>(null)
  useEffect(() => { setDay(pktNow().day) }, [])
  return day
}
