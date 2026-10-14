// The ONE no-show path (D4).
//
// A host tapping "No-show" on the reservations page and the auto sweep in
// workers/reservationReminders.ts used to do different things: the worker
// captured the deposit and offered the freed slot to the waitlist, the manual
// route did neither (and the deposit-capture route that would have covered it
// had no UI). Both callers now go through markNoShow, so a no-show always:
//
//   1. claims the transition atomically (booked/confirmed → no_show, never a
//      seated/completed/cancelled row, never twice),
//   2. captures a held deposit as a no-show fee (journal: Dr 1030 card /
//      gateway receivable / Cr 4210 No-show Deposits Kept — other income, no
//      sales tax, no fiscal document; H10, depositCapture.ts),
//   3. records a strike on the customer and refreshes their rollups,
//   4. offers the freed slot to the next waitlist guest,
//   5. tells open admin screens.
//
// Steps 2-5 are best-effort: the status change is the fact of record, and a
// failed capture / strike / promotion is logged without undoing it.

import type { Reservation } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { emitReservationEvent } from '../../lib/ws.js'
import { bumpCustomerRollups } from '../../lib/customerRollups.js'
import { recordStrike } from '../../lib/strikes.js'
import { captureReservationDeposit } from './depositCapture.js'
import { tryPromoteWaitlist } from './waitlistPromotion.js'

/** Statuses a reservation can be marked no-show from. */
export const NO_SHOW_FROM = ['booked', 'confirmed'] as const

export interface MarkNoShowOptions {
  /** Stored as the reservation's cancelReason. */
  reason: string
  /** Staff user id for a manual no-show; null for the auto sweep. */
  actorId: string | null
  actorEmail?: string | null
  /** True when the auto sweep (not a person) decided this. Only changes wording. */
  auto?: boolean
}

export type MarkNoShowResult =
  | { marked: true; reservation: Reservation; depositCapturedCents: number }
  | { marked: false; reservation: Reservation | null }

export async function markNoShow(reservationId: string, opts: MarkNoShowOptions): Promise<MarkNoShowResult> {
  // Conditional claim: two hosts (or a host and the sweep) racing on the same
  // booking produce exactly one no-show, one capture and one strike.
  const claimed = await prisma.reservation.updateMany({
    where: { id: reservationId, status: { in: [...NO_SHOW_FROM] }, seatedAt: null },
    data:  { status: 'no_show', cancelReason: opts.reason },
  })
  if (claimed.count === 0) {
    const current = await prisma.reservation.findUnique({ where: { id: reservationId } })
    return { marked: false, reservation: current }
  }

  let row = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })

  let depositCapturedCents = 0
  if (row.depositCents > 0) {
    try {
      const res = await captureReservationDeposit({
        reservationId: row.id,
        postedBy: opts.actorId ?? 'system',
        reason: `${opts.reason} — deposit captured`,
        staffUser: opts.actorId ? { id: opts.actorId, email: opts.actorEmail ?? null } : null,
      })
      if (res.captured) depositCapturedCents = res.amountCents
      row = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } })
    } catch (err) {
      // The booking stays no_show (the floor must see the truth); the capture
      // can be re-run by finance from the reservation id in this log line.
      console.error(`[markNoShow] deposit capture failed for reservation ${row.id}:`, (err as Error).message)
    }
  }

  emitReservationEvent('reservation:no-show', {
    reservationId: row.id,
    conceptId:     row.conceptId,
    startTime:     row.startTime.toISOString(),
    status:        row.status,
  })

  bumpCustomerRollups(row.customerId)
  if (row.customerId) {
    // recordStrike never throws (logs internally).
    await recordStrike({
      customerId:   row.customerId,
      kind:         'reservation_no_show',
      sourceType:   'reservation',
      sourceId:     row.id,
      reason:       opts.auto
        ? 'Auto-detected no-show — booking expired without seating.'
        : 'Staff marked as no-show.',
      recordedById: opts.actorId,
    })
  }

  tryPromoteWaitlist(row).catch((err: Error) => {
    console.warn(`[markNoShow] waitlist promotion failed for reservation ${row.id}:`, err.message)
  })

  return { marked: true, reservation: row, depositCapturedCents }
}
