// Bookable hours for a Karachi calendar day (ONLINE-R3).
//
// GET /reservations/availability read the weekday as
// `new Date('<date>T00:00:00+05:00').getUTCDay()` — Karachi midnight is 19:00
// UTC the day before, so every day was given the PREVIOUS day's hours (Monday
// slots from Sunday's rows, Saturday brunch showing on Sunday). Everything
// here works in Karachi time, the same clock as storefront/serviceHours.ts.
//
// The rules:
//   - a brand with NO ServiceHours rows at all has not set hours yet: the
//     default 11:00–23:00 window applies (as it always did);
//   - a brand that has set hours is bookable only inside that day's
//     reservable windows — a day without rows is closed, it does not fall
//     back to the default;
//   - a window whose close is not after its open runs past midnight
//     (18:00 → 02:00): sittings may END after midnight, but slots on this
//     date only START before it.

import { pktClock } from '../storefront/serviceHours.js'

export const PKT_OFFSET_MS = 5 * 3_600_000
const DEFAULT_WINDOW = { openMin: 11 * 60, closeMin: 23 * 60 }

export interface HoursRow { dayOfWeek: number; openMin: number; closeMin: number; isReservable: boolean }
export interface Window { openMin: number; closeMin: number }

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD date, as a Karachi calendar day. */
export function pktDayOfWeek(date: string): number {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)).getUTCDay()
}

/** Karachi midnight (as a UTC instant) for a YYYY-MM-DD date. */
export function pktDayStart(date: string): Date {
  return new Date(`${date.slice(0, 10)}T00:00:00+05:00`)
}

/** The reservable windows of one Karachi weekday (minutes since PKT midnight). */
export function reservableWindows(rows: HoursRow[], dow: number): Window[] {
  if (rows.length === 0) return [DEFAULT_WINDOW]
  return rows
    .filter((h) => h.dayOfWeek === dow && h.isReservable)
    .map((h) => ({ openMin: h.openMin, closeMin: h.closeMin <= h.openMin ? h.closeMin + 1440 : h.closeMin }))
    .sort((a, b) => a.openMin - b.openMin)
}

/**
 * Does a sitting from `start` lasting `durationMin` fit the brand's bookable
 * hours? Only checked when the brand has set hours (no rows = no rule, the
 * same as online ordering).
 */
export function sittingInHours(rows: HoursRow[], start: Date, durationMin: number): boolean {
  if (rows.length === 0) return true
  const { dow, minutes } = pktClock(start)
  const end = minutes + durationMin
  if (reservableWindows(rows, dow).some((w) => minutes >= w.openMin && end <= w.closeMin)) return true
  // The early hours of an overnight window that opened the day before.
  const prev = (dow + 6) % 7
  return reservableWindows(rows, prev).some((w) => w.closeMin > 1440 && minutes + 1440 >= w.openMin && end + 1440 <= w.closeMin)
}
