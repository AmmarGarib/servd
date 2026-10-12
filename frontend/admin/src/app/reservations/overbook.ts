// Booking past capacity from the host stand (ONL-R2-04) — the pure pieces the
// "New reservation" dialog uses, kept free of React so they can be tested.
//
// The server (backend/src/modules/reservations/routes.ts) answers a booking
// that fits no table with 409 SLOT_FULL and
// `details: { overbookAllowed: true, managerRequired }` — managerRequired is
// false when the signed-in user is a manager (an override approver). The
// dialog then asks for a reason (3–300 characters) and, when managerRequired,
// a manager's PIN (4–8), and sends the same booking again with
// `{ overbook: true, overbookReason, managerOverridePin? }`. The server
// re-checks everything: the PIN must belong to a manager of the BRAND's own
// company, a refused PIN stores nothing, and the overbook is audited with the
// approver. A booking that turned out to fit after all comes back as an
// ordinary one (`overbooked: false`, a table assigned).
//
// The PIN refusals use the same words as every other PIN prompt in the admin
// (components/pos/pinErrors.ts).

import { ApiError } from '../../lib/api'
import { managerPinLockedMessage, WRONG_PIN_MESSAGE } from '../../components/pos/pinErrors'

export interface SlotFull {
  /** The server's own sentence (why no table fits, and what to do). */
  message: string
  /** A manager PIN is needed (the signed-in user is not a manager). */
  managerRequired: boolean
}

/** SLOT_FULL with an overbook allowed → what the prompt needs; anything else → null. */
export function slotFullPrompt(err: unknown): SlotFull | null {
  if (!(err instanceof ApiError) || err.code !== 'SLOT_FULL') return null
  const d = err.details as { overbookAllowed?: unknown; managerRequired?: unknown } | null | undefined
  if (d?.overbookAllowed !== true) return null
  // Unknown → ask for the PIN; the server decides either way.
  return { message: err.message, managerRequired: d.managerRequired !== false }
}

export const OVERBOOK_REASON_MIN = 3
export const OVERBOOK_REASON_MAX = 300

/** Can the overbook be sent? A reason of 3+ characters, and a 4–8 character PIN when one is needed. */
export function overbookReady(reason: string, pin: string, managerRequired: boolean): boolean {
  const r = reason.trim()
  if (r.length < OVERBOOK_REASON_MIN || r.length > OVERBOOK_REASON_MAX) return false
  if (!managerRequired) return true
  const p = pin.trim()
  return p.length >= 4 && p.length <= 8
}

/** The fields added to the same booking body to overbook it (the server's exact names). */
export function overbookFields(reason: string, pin: string, managerRequired: boolean): {
  overbook: true; overbookReason: string; managerOverridePin?: string
} {
  return {
    overbook: true,
    overbookReason: reason.trim(),
    ...(managerRequired && pin.trim() && { managerOverridePin: pin.trim() }),
  }
}

/** Plain words for an overbook the server refused; null when it is not one of these. */
export function overbookRefusalText(err: unknown): string | null {
  const locked = managerPinLockedMessage(err)
  if (locked) return locked
  if (!(err instanceof ApiError)) return null
  switch (err.code) {
    case 'INVALID_MANAGER_PIN': return WRONG_PIN_MESSAGE
    case 'MANAGER_OVERRIDE_REQUIRED': return 'Booking past capacity needs a manager — a manager signs in, or enters their PIN here.'
    default: return null
  }
}

export interface CreatedBooking {
  table?: { id: string; label: string } | null
  overbooked?: boolean
  waitlist?: boolean
}

/** The line the dialog shows once the booking is made: which table it got, or that it has none yet. */
export function bookedLine(r: CreatedBooking): string {
  if (r.waitlist) return 'Added to the waiting list — no table is held.'
  const label = r.table?.label
  if (r.overbooked) {
    return label
      ? `Booked past capacity on table ${label}. The reason is on the booking and in the audit log.`
      : 'Booked past capacity — no table is assigned yet. Push tables together and seat the party when they arrive. The reason is on the booking and in the audit log.'
  }
  return label ? `Booked — table ${label}.` : 'Booked — no table assigned yet.'
}

// ─── The reservation policy, in the host's words (O-RV-1) ────────────────────
//
// POST /reservations applies the company's reservation policy
// (/configuration/reservation-policy) to every booking except a walk-in:
// 400 TOO_SOON (less than minAdvanceHours ahead — default 2), TOO_FAR (more
// than maxAdvanceDays), PARTY_TOO_LARGE (over maxPartySize). A walk-in skips
// those but is refused WALKINS_DISABLED when walk-ins are off. These run
// BEFORE the capacity check, so a booking refused here never reaches the
// overbook prompt — the form's default time must clear the notice period.
// The tablet's New booking sheet (tablet/app/(staff)/reservations.tsx)
// carries the same two helpers.

const PKT_OFFSET_MS = 5 * 3_600_000
const QUARTER_MS = 15 * 60_000
/** Slack on top of the notice period, so a few minutes spent filling the form never tips the default into TOO_SOON. */
const DEFAULT_SLACK_MS = 5 * 60_000

/**
 * The first bookable slot: now + the policy's notice (+ a little slack),
 * rounded UP to the next quarter hour, as a Karachi date and time. Rolls to
 * the next day after late evening — never a time in the past.
 */
export function defaultBookingSlot(minAdvanceHours: number, nowMs: number = Date.now()): { date: string; time: string } {
  const notice = Number.isFinite(minAdvanceHours) && minAdvanceHours > 0 ? minAdvanceHours : 0
  const earliest = nowMs + notice * 3_600_000 + DEFAULT_SLACK_MS
  const slot = Math.ceil(earliest / QUARTER_MS) * QUARTER_MS
  const iso = new Date(slot + PKT_OFFSET_MS).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/** Plain words for a booking the reservation policy refused; null when it is not one of these. */
export function policyRefusalText(
  err: unknown,
  opts: { minAdvanceHours?: number | null; canWalkIn?: boolean } = {},
): string | null {
  if (!(err instanceof ApiError)) return null
  const n = (re: RegExp) => { const m = re.exec(err.message); return m ? Number(m[1]) : null }
  switch (err.code) {
    case 'TOO_SOON': {
      const h = opts.minAdvanceHours ?? n(/at least (\d+) hours?/)
      const notice = h == null ? 'more notice' : `at least ${h} hour${h === 1 ? '' : 's'}’ notice`
      return `Bookings need ${notice} — pick a later time${opts.canWalkIn ? ', or tick Walk-in for a party being seated now' : ''}.`
    }
    case 'TOO_FAR': {
      const d = n(/more than (\d+) days/)
      return `That is too far ahead — bookings open ${d == null ? 'a limited number of' : d} days in advance. Pick an earlier date.`
    }
    case 'PARTY_TOO_LARGE': {
      const max = n(/Maximum party size is (\d+)/)
      return `That party is larger than one booking takes${max == null ? '' : ` (at most ${max})`}. Split it into two bookings, or a manager raises the limit in Reservation policy.`
    }
    case 'WALKINS_DISABLED':
      return 'Walk-ins are switched off for this restaurant — untick Walk-in and book it for a time, or a manager turns walk-ins on in Reservation policy.'
    default: return null
  }
}
