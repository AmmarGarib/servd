'use client'
// Open/closed status for the stackd door sign.
//
// Mirrors computeStatus/pktNow in ../parts/OpenStatusBadge.tsx, which are not
// exported. The shared badge hard-codes red-on-tint colours that fail contrast
// on the plum field (#dc2626 on #7C2946 is 1.92:1), so stackd renders its own
// sign from the same data. If those helpers get exported, import them here.

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

function windowsFor(hours: ServiceHourRow[], day: number) {
  return hours.filter((h) => h.dayOfWeek === day).sort((a, b) => a.openMin - b.openMin)
}

function nextOpening(hours: ServiceHourRow[], day: number): string | null {
  for (let offset = 1; offset <= 6; offset++) {
    const d = (day + offset) % 7
    const w = windowsFor(hours, d)
    if (w.length > 0) return `${offset === 1 ? 'tomorrow' : DAY_LABELS[d]} ${formatMins(w[0]!.openMin)}`
  }
  return null
}

export function computeStatus(hours: ServiceHourRow[], day: number, mins: number): Omit<OpenStatus, 'inactive'> {
  const today = windowsFor(hours, day)
  for (const w of today) {
    if (mins >= w.openMin && mins < w.closeMin) return { open: true, closesAt: formatMins(w.closeMin), opensAt: null }
  }
  const later = today.find((w) => w.openMin > mins)
  if (later) return { open: false, closesAt: null, opensAt: `today ${formatMins(later.openMin)}` }
  return { open: false, closesAt: null, opensAt: nextOpening(hours, day) }
}

/** Live status, re-evaluated every minute. Null while hours are loading. */
export function useOpenStatus(hoursData: HoursData | null): OpenStatus | null {
  const [status, setStatus] = useState<OpenStatus | null>(null)
  useEffect(() => {
    if (!hoursData) {
      setStatus(null)
      return
    }
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

export function statusText(s: OpenStatus): { head: string; sub: string | null } {
  if (s.inactive) return { head: 'Temporarily closed', sub: null }
  if (s.open) return { head: 'Open now', sub: s.closesAt ? `closes ${s.closesAt}` : null }
  return { head: 'Closed', sub: s.opensAt ? `opens ${s.opensAt}` : null }
}
