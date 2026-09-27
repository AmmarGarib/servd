'use client'
// Open/closed status for the stackd door sign.
//
// ONE TRUTH FOR HOURS: the rules (windows that cross midnight, yesterday's
// late window, "opens tomorrow 8am") live in lib/world/kitchenCore. This file
// keeps its exported API for the stackd components but delegates every
// calculation there, and when the hours API is down it falls back to the
// same world kitchen state that stamps html[data-k-stackd] — so the sign, the
// pastry-case lamp and the chiller LED can never disagree.
//
// stackd renders its own sign rather than the shared OpenStatusBadge, whose
// red-on-tint colours fail contrast on the plum field (#dc2626 on #7C2946 is
// 1.92:1). Copy is lowercase, in stackd's own voice.

import { useEffect, useMemo, useState } from 'react'
import type { HoursData, ServiceHourRow } from '../parts/OpenStatusBadge'
import { computeOpen, formatClock, type KitchenPhase, type KitchenState, type OpenCalc } from '../../../lib/world/kitchenCore'
import { karachiNow } from '../../../lib/world/clock'
import { useKitchen } from '../../../lib/world/kitchens'

export interface OpenStatus {
  open: boolean
  inactive: boolean
  closesAt: string | null
  opensAt: string | null
  /** open · closing (≤45 min left) · opening (≤60 min away) · closed. */
  phase?: KitchenPhase
}

export const DAY_LABELS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Day of week (0 = Sun) and minutes since midnight, Karachi time. */
export function pktNow(): { day: number; mins: number } {
  const { day, mins } = karachiNow()
  return { day, mins }
}

/** '11pm' · '8:30am' — the world clock's format, lowercase. */
export function formatMins(m: number): string {
  return formatClock(m)
}

// 1 Jan 2023 was a Sunday. A Karachi wall-clock (day, mins) maps onto a real
// instant in that week: UTC = local − 5h.
const SUNDAY_UTC = Date.UTC(2023, 0, 1)
function instantFor(day: number, mins: number): Date {
  return new Date(SUNDAY_UTC + day * 86_400_000 + mins * 60_000 - 5 * 3_600_000)
}

function phaseOf(c: OpenCalc): KitchenPhase {
  if (c.open) return c.closesInMin != null && c.closesInMin <= 45 ? 'closing' : 'open'
  return c.opensInMin != null && c.opensInMin <= 60 ? 'opening' : 'closed'
}

function fromCalc(c: OpenCalc): Omit<OpenStatus, 'inactive'> {
  return {
    open: c.open,
    closesAt: c.open && c.closesAtMin != null ? formatClock(c.closesAtMin) : null,
    opensAt: c.open ? null : c.opensAtLabel,
    phase: phaseOf(c),
  }
}

function fromKitchen(k: KitchenState): OpenStatus {
  return { open: k.open, inactive: false, closesAt: k.closesAt, opensAt: k.opensAt, phase: k.phase }
}

export function computeStatus(hours: ServiceHourRow[], day: number, mins: number): Omit<OpenStatus, 'inactive'> {
  return fromCalc(computeOpen(hours, true, instantFor(day, mins)))
}

/**
 * Live status, re-evaluated every minute. Never null: while the hours load,
 * or if the API is down, it reads the world's stackd kitchen (fallback hours
 * daily 8am–11pm) — the same state the page's lamps and LEDs are lit from.
 */
export function useOpenStatus(hoursData: HoursData | null): OpenStatus {
  const kitchen = useKitchen('stackd')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!hoursData) return
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [hoursData])

  return useMemo(() => {
    void tick
    if (!hoursData) return fromKitchen(kitchen)
    if (!hoursData.isActive) return { open: false, inactive: true, closesAt: null, opensAt: null, phase: 'closed' as const }
    // No published hours: the world's rule set is the only truth there is.
    if (hoursData.hours.length === 0) return fromKitchen(kitchen)
    return { ...fromCalc(computeOpen(hoursData.hours, true)), inactive: false }
  }, [hoursData, kitchen, tick])
}

export function statusText(s: OpenStatus): { head: string; sub: string | null } {
  if (s.inactive) return { head: 'closed for now', sub: null }
  if (s.open) {
    return {
      head: s.phase === 'closing' ? 'closing soon' : 'open now',
      sub: s.closesAt ? `closes ${s.closesAt}` : null,
    }
  }
  return {
    head: s.phase === 'opening' ? 'opening soon' : 'closed',
    sub: s.opensAt ? `opens ${s.opensAt}` : null,
  }
}

/** The pastry case's hanging tag when the lights are off. */
export function backWithTheBake(opensAt: string | null): string {
  const when = opensAt ?? '8am'
  const m = /^(tomorrow|mon|tue|wed|thu|fri|sat|sun)\s+(.+)$/i.exec(when)
  if (m) return `back ${m[1]!.toLowerCase()} at ${m[2]} with the bake`
  return `back at ${when} with the bake`
}
