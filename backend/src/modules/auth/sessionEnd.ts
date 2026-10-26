// A staff sign-in lasts ONE SHIFT (owner B1, 2026-10-26: "Signin can last 1
// shift. At shift open u must manually sign in from your workspace … at shift
// close servd should auto sign u out no matter who u are. However people can
// login to servd outside the office").
//
// When a staff session ends — computed ONCE, at sign-in (staffSessionEndsAt),
// and written into the refresh and access tokens (`se` claim + their JWT exp):
//   • a person with an HR record and a shift today (their roster / swap /
//     /scheduling change / the company default rota — hr/rota.ts rotaFor, the
//     ONE rota reader): the end of that shift (a shift past midnight ends the
//     next morning; yesterday's overnight shift still running counts);
//   • nobody else (the CEO, IT, no HR record, a day off, on leave, or signing
//     in after today's shift is over — e.g. from home): the end of the Karachi
//     day (midnight PKT);
//   • never more than 24 hours after sign-in.
// Till staff end earlier too: closing their drawer ends their sessions
// (endSessionsForClosedDrawer, called by POST /pos/shifts/:id/close and by
// the 5-minute sweep for drawers closed any other way) — after a short grace
// so the Z-report can still be seen and printed.
//
// Customers and riders are not staff sessions: unchanged.

import { serviceClient as prisma } from '../../lib/prisma.js'
import { rotaFor, toMinutes, ymd } from '../hr/rota.js'

const PKT_OFFSET_MS = 5 * 3600_000
const DAY_MS = 86_400_000
export const MAX_SESSION_MS = 24 * 3600_000
/** After a drawer closes, its cashier's sessions live this much longer (Z-report). */
export const SHIFT_CLOSE_GRACE_MS = 5 * 60_000

/** The Karachi calendar day (YYYY-MM-DD) of an instant. */
export function karachiDay(at: Date): string {
  return ymd(new Date(at.getTime() + PKT_OFFSET_MS))
}

/** 00:00 PKT at the START of the Karachi day `day` as an instant. */
function karachiMidnight(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getTime() - PKT_OFFSET_MS
}

/** Midnight PKT at the END of the Karachi day containing `at`. */
export function endOfKarachiDay(at: Date): Date {
  return new Date(karachiMidnight(karachiDay(at)) + DAY_MS)
}

/** Each segment of a rota cell as [start, end] instants (an end at or before the start runs past midnight). */
function segmentWindows(day: string, segments: Array<{ start: string; end: string }>): Array<[number, number]> {
  const base = karachiMidnight(day)
  const out: Array<[number, number]> = []
  for (const s of segments) {
    const a = toMinutes(s.start), b = toMinutes(s.end)
    if (a == null || b == null) continue
    const start = base + a * 60_000
    const end = base + (b > a ? b : b + 1440) * 60_000
    out.push([start, end])
  }
  return out
}

/**
 * When a session that starts now (for this login) ends. Never throws: any
 * problem reading the rota falls back to the end of the Karachi day.
 */
export async function staffSessionEndsAt(userId: string, now: Date = new Date()): Promise<Date> {
  const cap = now.getTime() + MAX_SESSION_MS
  const fallback = Math.min(endOfKarachiDay(now).getTime(), cap)
  try {
    // Active HR records of this login (one per company it is employed in).
    const emps = await prisma.hrEmployee.findMany({
      where: { userId, status: { in: ['active', 'on_leave'] } },
      select: { id: true, userId: true, tenantId: true },
    })
    if (emps.length === 0) return new Date(fallback)
    const today = karachiDay(now)
    const yesterday = karachiDay(new Date(now.getTime() - DAY_MS))
    let shiftEnd: number | null = null
    for (const e of emps) {
      const cells = await rotaFor(e.tenantId, [{ id: e.id, userId: e.userId }], yesterday, today)
      for (const c of cells) {
        if (c.kind !== 'shift') continue
        for (const [start, end] of segmentWindows(c.date, c.segments)) {
          // A shift still to come or under way: yesterday's only when it runs past midnight into now.
          if (end <= now.getTime()) continue
          if (c.date === yesterday && start > now.getTime()) continue
          // The nearest end: the shift under way (or about to start), not a later one today.
          if (shiftEnd == null || end < shiftEnd) shiftEnd = end
        }
      }
    }
    // No shift left today (day off, leave, signing in after the shift): end of the Karachi day.
    if (shiftEnd == null) return new Date(fallback)
    return new Date(Math.min(shiftEnd, cap))
  } catch (err) {
    console.warn('[auth] session end: rota unreadable, ending at midnight PKT —', (err as Error).message)
    return new Date(fallback)
  }
}

/**
 * True when a token issued at `iatSec` belongs to a session the login's
 * drawer close has ended (User.sessionsEndedAt + the grace).
 */
export function endedByDrawerClose(sessionsEndedAt: Date | null | undefined, iatSec: number | undefined, now: Date = new Date()): boolean {
  if (!sessionsEndedAt || iatSec === undefined) return false
  const cut = sessionsEndedAt.getTime()
  return iatSec * 1000 < cut && now.getTime() >= cut + SHIFT_CLOSE_GRACE_MS
}

/**
 * A till drawer closed: the drawer's own cashier's sessions end (after the
 * grace). Idempotent and only ever moves the stamp forward. Never throws.
 */
export async function endSessionsForClosedDrawer(userId: string, closedAt: Date): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { id: userId, OR: [{ sessionsEndedAt: null }, { sessionsEndedAt: { lt: closedAt } }] },
      data: { sessionsEndedAt: closedAt },
    })
  } catch (err) {
    console.warn('[auth] could not end sessions after drawer close —', (err as Error).message)
  }
}

/**
 * The 5-minute sweep: drawers closed in the last hour by any path stamp their
 * cashier's sessions as ended (the close route already does it; this is the
 * backstop). Sessions past their shift end need nothing: the token expires.
 */
export async function sweepClosedDrawerSessions(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 3600_000)
  const shifts = await prisma.shift.findMany({
    where: { status: 'closed', closedAt: { gte: since, lte: now } },
    select: { userId: true, closedAt: true },
  })
  let n = 0
  for (const s of shifts) {
    if (!s.userId || !s.closedAt) continue
    await endSessionsForClosedDrawer(s.userId, s.closedAt)
    n++
  }
  return n
}
