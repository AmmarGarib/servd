// THE ONE RULE SET for "is this kitchen open right now?"
//
// Before this file the storefront answered that question five different ways
// (lib/hours.ts, brand/parts/OpenStatusBadge, brand/stackd/hours.ts,
// brand/flipd/hours.ts, KitchenBoard's private hook), and they disagreed —
// most of them dropped windows that cross midnight, and one read the host's
// timezone instead of Karachi's. New code asks this file. The older helpers
// either delegate here or are deprecated (lib/hours.ts).
//
// simmer/serviceClock.ts keeps its own "service date" concept (1am on a
// wednesday is still tuesday's table) but its hours MUST agree with
// FALLBACK_HOURS.simmer below: doors 7pm, late until 2:30am, dark on monday.
//
// Pure and server-safe: the root layout calls fallbackKitchens() on the server
// to stamp <html data-k-*>, and lib/world/kitchens.ts re-runs it on the client
// with the live hours from the API.

import type { ServiceHourRow } from '../../components/brand/parts/OpenStatusBadge'
import { formatBrandName } from '../concept'
import { karachiNow } from './clock'

export type KitchenSlug = 'stackd' | 'simmer' | 'flipd'
export const KITCHEN_SLUGS: readonly KitchenSlug[] = ['stackd', 'simmer', 'flipd']

export type KitchenPhase = 'open' | 'closing' | 'opening' | 'closed'

export interface KitchenState {
  slug: KitchenSlug
  /** Display name, already through formatBrandName ('stackd', 'simmer', 'Flipd'). */
  name: string
  open: boolean
  phase: KitchenPhase
  closesInMin: number | null
  opensInMin: number | null
  /** '11pm', '2:30am', 'midnight'. */
  closesAt: string | null
  /** '7pm' (today) | 'tomorrow 8am' | 'tue 7pm'. */
  opensAt: string | null
  /** Neutral status line: 'open · closes 11pm' | 'closing in 25 min' |
   *  'opens in 20 min' | 'opens 7pm' | 'closed today'. */
  label: string
  source: 'live' | 'fallback'
}

export interface OpenCalc {
  open: boolean
  /** Minute of the Karachi day the current window ends (0 = midnight). */
  closesAtMin: number | null
  opensAtLabel: string | null
  closesInMin: number | null
  opensInMin: number | null
}

/** Within this many minutes of closing, an open kitchen is 'closing'. */
export const CLOSING_SOON_MIN = 45
/** Within this many minutes of opening, a closed kitchen is 'opening'. */
export const OPENING_SOON_MIN = 60

const DAY = 1440
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

const DISPLAY_NAME: Record<KitchenSlug, string> = {
  stackd: 'stackd',
  simmer: 'simmer',
  flipd: 'Flipd',
}

/** '11pm' · '8:30am' · 'noon' · 'midnight'. Accepts minutes past 1440. */
export function formatClock(mins: number): string {
  const m = ((Math.round(mins) % DAY) + DAY) % DAY
  if (m === 0) return 'midnight'
  if (m === 720) return 'noon'
  const h = Math.floor(m / 60)
  const mm = m % 60
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}${mm ? `:${String(mm).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

interface Span { start: number; end: number }

/**
 * Lay every window out on one timeline measured in minutes from TODAY's
 * Karachi midnight: yesterday's windows sit at -1440.., next week's at up to
 * +10080. A window whose close is at or before its open (or past 1440) runs
 * over midnight into the next day. Overlapping and touching windows merge, so
 * "until midnight" followed by "from midnight" reads as one stretch.
 */
function timeline(rows: ServiceHourRow[], today: number): Span[] {
  const spans: Span[] = []
  for (let off = -1; off <= 7; off++) {
    const dow = (((today + off) % 7) + 7) % 7
    for (const r of rows) {
      if (r.dayOfWeek !== dow) continue
      if (!Number.isFinite(r.openMin) || !Number.isFinite(r.closeMin)) continue
      const open = Math.max(0, Math.min(DAY - 1, Math.round(r.openMin)))
      let close = Math.round(r.closeMin)
      if (close <= open) close += DAY
      close = Math.min(close, open + DAY) // a window is at most a whole day
      spans.push({ start: off * DAY + open, end: off * DAY + close })
    }
  }
  spans.sort((a, b) => a.start - b.start)
  const merged: Span[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end)
    else merged.push({ ...s })
  }
  return merged
}

function opensLabel(start: number, today: number): string {
  const off = Math.floor(start / DAY)
  const at = formatClock(start)
  if (off <= 0) return at
  if (off === 1) return `tomorrow ${at}`
  return `${WEEKDAYS[(today + off) % 7]} ${at}`
}

/**
 * Open right now? Handles windows crossing midnight (closeMin <= openMin, or
 * closeMin > 1440) including yesterday's late window still running after
 * midnight. isActive=false is closed with no times. No rows at all is open
 * with no times (the operator has not configured hours).
 */
export function computeOpen(rows: ServiceHourRow[], isActive: boolean, now: Date = new Date()): OpenCalc {
  if (!isActive) return { open: false, closesAtMin: null, opensAtLabel: null, closesInMin: null, opensInMin: null }
  if (rows.length === 0) return { open: true, closesAtMin: null, opensAtLabel: null, closesInMin: null, opensInMin: null }

  const { day, mins } = karachiNow(now)
  const spans = timeline(rows, day)

  const current = spans.find((s) => s.start <= mins && mins < s.end)
  if (current) {
    const left = current.end - mins
    // Longer than a day of runway means round-the-clock: no closing time.
    if (left > DAY) return { open: true, closesAtMin: null, opensAtLabel: null, closesInMin: null, opensInMin: null }
    return { open: true, closesAtMin: current.end % DAY, opensAtLabel: null, closesInMin: left, opensInMin: null }
  }

  const next = spans.find((s) => s.start > mins)
  if (!next) return { open: false, closesAtMin: null, opensAtLabel: null, closesInMin: null, opensInMin: null }
  return {
    open: false,
    closesAtMin: null,
    opensAtLabel: opensLabel(next.start, day),
    closesInMin: null,
    opensInMin: next.start - mins,
  }
}

function everyDay(openMin: number, closeMin: number, isReservable: boolean, days: number[] = [0, 1, 2, 3, 4, 5, 6]): ServiceHourRow[] {
  return days.map((dayOfWeek) => ({ dayOfWeek, openMin, closeMin, isReservable }))
}

/**
 * Used whenever the API is unreachable, still loading, or a brand has no hours
 * configured. Keep simmer in step with components/brand/simmer/serviceClock.ts.
 */
export const FALLBACK_HOURS: Record<KitchenSlug, ServiceHourRow[]> = {
  // stackd: café hours, 08:00–23:00 daily.
  stackd: everyDay(8 * 60, 23 * 60, false),
  // simmer: tue–sun, doors 19:00, late service until 02:30 the next morning.
  // Monday is dark — sunday's late service still runs into monday's small hours.
  simmer: everyDay(19 * 60, 26 * 60 + 30, true, [0, 2, 3, 4, 5, 6]),
  // Flipd: the grill runs noon to midnight daily.
  flipd: everyDay(12 * 60, 24 * 60, false),
}

export function kitchenState(
  slug: KitchenSlug,
  rows: ServiceHourRow[] | null,
  isActive: boolean = true,
  now: Date = new Date(),
): KitchenState {
  const source: KitchenState['source'] = rows ? 'live' : 'fallback'
  const calc = computeOpen(rows ?? FALLBACK_HOURS[slug], isActive, now)

  let phase: KitchenPhase
  if (calc.open) phase = calc.closesInMin !== null && calc.closesInMin <= CLOSING_SOON_MIN ? 'closing' : 'open'
  else phase = calc.opensInMin !== null && calc.opensInMin <= OPENING_SOON_MIN ? 'opening' : 'closed'

  const closesAt = calc.closesAtMin !== null ? formatClock(calc.closesAtMin) : null
  const opensAt = calc.opensAtLabel

  let label: string
  switch (phase) {
    case 'open':
      label = closesAt ? `open · closes ${closesAt}` : 'open now'
      break
    case 'closing':
      label = `closing in ${Math.max(1, calc.closesInMin ?? 0)} min`
      break
    case 'opening':
      label = `opens in ${Math.max(1, calc.opensInMin ?? 0)} min`
      break
    default:
      label = !isActive ? 'closed today' : opensAt ? `opens ${opensAt}` : 'closed today'
  }

  return {
    slug,
    name: formatBrandName(DISPLAY_NAME[slug]),
    open: calc.open,
    phase,
    closesInMin: calc.closesInMin,
    opensInMin: calc.opensInMin,
    closesAt,
    opensAt,
    label,
    source,
  }
}

/** All three kitchens on their fallback hours. What the server stamps. */
export function fallbackKitchens(now: Date = new Date()): KitchenState[] {
  return KITCHEN_SLUGS.map((s) => kitchenState(s, null, true, now))
}

/** Narrow an arbitrary string (a route slug, a DB slug) to a kitchen, or null. */
export function asKitchenSlug(v: string | null | undefined): KitchenSlug | null {
  const s = (v ?? '').trim().toLowerCase()
  if (s === 'stax') return 'stackd' // /stax* redirects to stackd
  return (KITCHEN_SLUGS as readonly string[]).includes(s) ? (s as KitchenSlug) : null
}
