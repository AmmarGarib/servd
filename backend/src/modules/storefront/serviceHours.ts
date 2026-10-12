// Karachi wall-clock rules for the storefront (ONL-13, ONL-14).
//
// The server runs in UTC (no TZ in the Dockerfile or compose file), so
// anything that reads `new Date().getHours()` is five hours behind the
// restaurant: a 19:00–23:30 dinner section was hidden at 19:30 Karachi time
// while the 12:00–16:00 lunch section showed. Every storefront time rule goes
// through this file instead, which works in Pakistan Standard Time (UTC+5 —
// Asia/Karachi has kept no daylight saving since 2009; the reservations module
// uses the same +05:00).
//
// Opening hours are the brand's ServiceHours rows (admin → Configuration →
// Hours, the one writer): minutes since PKT midnight, several windows a day
// allowed. A window whose close is not after its open runs past midnight
// (18:00 → 02:00), so the early hours of the next day belong to it. A brand
// with no hours configured is treated as open — nothing here may take a brand
// offline that the operator never scheduled.
//
// Reservation blockouts do NOT close ordering (ONLINE-R4). Admin →
// Reservations → Blockouts labels its default kind "Closure (no bookings)" and
// suggests it for a private buyout, so reading every `closure` row as "brand
// closed" silently stopped all delivery and pickup orders for a buyout
// evening. Until there is an explicit "closed to orders too" choice on that
// form, online ordering follows the opening hours only; the pure helpers below
// still take closures for when it exists.

import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { formatBrandName } from '../../lib/brandName.js'

const PKT_OFFSET_MS = 5 * 3_600_000
const DAY_MS = 86_400_000

export interface PktClock {
  /** 0 = Sunday … 6 = Saturday, in Karachi. */
  dow: number
  /** Minutes since Karachi midnight. */
  minutes: number
  /** "HH:MM" in Karachi. */
  hhmm: string
}

export function pktClock(at: Date): PktClock {
  const shifted = new Date(at.getTime() + PKT_OFFSET_MS)
  const h = shifted.getUTCHours()
  const m = shifted.getUTCMinutes()
  return {
    dow: shifted.getUTCDay(),
    minutes: h * 60 + m,
    hhmm: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
  }
}

/** The UTC instant of Karachi midnight on the Karachi day containing `at`. */
function pktMidnight(at: Date): number {
  const shifted = at.getTime() + PKT_OFFSET_MS
  return shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - PKT_OFFSET_MS
}

function parseHhmm(v: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(v ?? '')
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 24 || min > 59) return null
  return h * 60 + min
}

/**
 * Is a menu section with this daily time restriction showing at `at`?
 * No start = no restriction. The end minute is inclusive (as it always was).
 * A start later than the end runs past midnight (22:00 → 02:00).
 */
export function sectionVisibleAt(
  start: string | null | undefined,
  end: string | null | undefined,
  at: Date,
): boolean {
  const s = parseHhmm(start)
  if (s == null) return true
  const e = parseHhmm(end) ?? 24 * 60
  const now = pktClock(at).minutes
  return s <= e ? now >= s && now <= e : now >= s || now <= e
}

export interface HoursRow { dayOfWeek: number; openMin: number; closeMin: number }
export interface ClosureRow { startTime: Date; endTime: Date }

/** Pure: open at `at` under these hours and closures? */
export function openAt(hours: HoursRow[], closures: ClosureRow[], at: Date): boolean {
  if (closures.some((c) => c.startTime <= at && at < c.endTime)) return false
  if (hours.length === 0) return true
  const { dow, minutes } = pktClock(at)
  const prev = (dow + 6) % 7
  return hours.some((h) => {
    const overnight = h.closeMin <= h.openMin
    if (h.dayOfWeek === dow) return minutes >= h.openMin && (overnight || minutes < h.closeMin)
    if (h.dayOfWeek === prev && overnight) return minutes < h.closeMin
    return false
  })
}

/** Pure: the first instant after `at` (within a week) when the brand opens. */
export function nextOpening(hours: HoursRow[], closures: ClosureRow[], at: Date): Date | null {
  const day0 = pktMidnight(at)
  const candidates: number[] = []
  for (let k = 0; k <= 8; k++) {
    const midnight = day0 + k * DAY_MS
    const dow = pktClock(new Date(midnight)).dow
    for (const h of hours) if (h.dayOfWeek === dow) candidates.push(midnight + h.openMin * 60_000)
    if (hours.length === 0) candidates.push(midnight)
  }
  for (const c of closures) candidates.push(c.endTime.getTime())
  const t = at.getTime()
  for (const c of [...new Set(candidates)].filter((x) => x > t).sort((a, b) => a - b)) {
    if (openAt(hours, closures, new Date(c))) return new Date(c)
  }
  return null
}

export interface OrderingState {
  open: boolean
  /** When the brand next opens (null when open, or nothing in the next week). */
  opensAt: Date | null
  /** "Opens at 10:00 tomorrow" — for the storefront to show as-is. */
  message: string | null
}

function opensAtPhrase(opensAt: Date, at: Date): string {
  const time = pktClock(opensAt).hhmm
  const days = Math.round((pktMidnight(opensAt) - pktMidnight(at)) / DAY_MS)
  if (days === 0) return `Opens at ${time} today`
  if (days === 1) return `Opens at ${time} tomorrow`
  const weekday = new Date(opensAt.getTime()).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'long' })
  return `Opens at ${time} on ${weekday}`
}

/** Whether a brand takes orders for `at` (now, or a scheduled time), in PKT. */
export async function orderingState(concept: { id: string; name: string }, at: Date): Promise<OrderingState> {
  const hours = await prisma.serviceHours.findMany({
    where: { conceptId: concept.id },
    select: { dayOfWeek: true, openMin: true, closeMin: true },
  })
  // Opening hours only — see the note at the top (ONLINE-R4).
  const closures: ClosureRow[] = []
  if (openAt(hours, closures, at)) return { open: true, opensAt: null, message: null }
  const opensAt = nextOpening(hours, closures, at)
  const brand = formatBrandName(concept.name)
  return {
    open: false,
    opensAt,
    message: opensAt ? `${brand} is closed right now. ${opensAtPhrase(opensAt, at)}.` : `${brand} is closed right now.`,
  }
}

/**
 * How far ahead a pre-order may be placed (ONL-R2-03). scheduledFor had no
 * upper bound: an order for 300 days out was accepted, stock was deducted and
 * the ticket sat in the kitchen's queue. A week covers every real "order for
 * Friday" and keeps the brand's opening hours (checked at that time by
 * assertOpenForOrders) meaningful.
 */
export const MAX_PREORDER_AHEAD_MS = 7 * DAY_MS

/**
 * The time an order is for: its scheduled time when that is in the future
 * (a pre-order), otherwise now. A scheduled time in the past is just "now".
 * 422 SCHEDULE_TOO_FAR when it is more than MAX_PREORDER_AHEAD_MS ahead; 400
 * INVALID_SCHEDULE when it is not a date at all (it used to fall back to
 * "now" silently, which turned a typo into an order for right now).
 */
export function orderTime(scheduledFor: string | null | undefined, now: Date = new Date()): { at: Date; scheduled: boolean } {
  if (scheduledFor) {
    const t = new Date(scheduledFor)
    if (Number.isNaN(t.getTime())) {
      throw new AppError('INVALID_SCHEDULE', 'scheduledFor is not a valid date and time', 400)
    }
    if (t.getTime() > now.getTime() + MAX_PREORDER_AHEAD_MS) {
      throw new AppError(
        'SCHEDULE_TOO_FAR',
        'Orders can be scheduled up to 7 days ahead. Pick an earlier time.',
        422,
        { maxScheduledFor: new Date(now.getTime() + MAX_PREORDER_AHEAD_MS).toISOString() },
      )
    }
    if (t.getTime() > now.getTime()) return { at: t, scheduled: true }
  }
  return { at: now, scheduled: false }
}

/**
 * 400 ITEM_UNAVAILABLE when any of these items sits in a time-limited menu
 * section that isn't showing at `at` (Karachi time). The same rule checkout
 * applies item by item (resolveCheckoutItems); exported for the other paths
 * that put storefront items on a ticket — the group-order add-item and submit
 * routes (ONLINE-R6) — so every entry point agrees with the menu.
 */
export async function assertItemsServedAt(conceptId: string, menuItemIds: string[], at: Date): Promise<void> {
  const ids = [...new Set(menuItemIds)]
  if (ids.length === 0) return
  const rows = await prisma.menuItem.findMany({
    where: { id: { in: ids }, conceptId },
    select: { name: true, category: { select: { timeRestrictionStart: true, timeRestrictionEnd: true } } },
  })
  for (const r of rows) {
    const s = r.category
    if (s && !sectionVisibleAt(s.timeRestrictionStart, s.timeRestrictionEnd, at)) {
      throw new AppError('ITEM_UNAVAILABLE', `${r.name} is only served ${s.timeRestrictionStart}–${s.timeRestrictionEnd ?? '24:00'}`, 400)
    }
  }
}

/** 409 BRAND_CLOSED unless the brand takes orders at `at`. */
export async function assertOpenForOrders(
  concept: { id: string; name: string },
  at: Date,
  scheduled: boolean,
): Promise<void> {
  const state = await orderingState(concept, at)
  if (state.open) return
  const brand = formatBrandName(concept.name)
  const message = scheduled
    ? `${brand} is closed at the time you picked. Choose a time when it's open.`
    : state.message ?? `${brand} is closed right now.`
  throw new AppError('BRAND_CLOSED', message, 409, { opensAt: state.opensAt?.toISOString() ?? null })
}
