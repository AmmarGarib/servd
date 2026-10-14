// Waitlist auto-promotion.
//
// When a reservation cancels or no-shows, the system tries to offer the freed
// slot to a matching waitlist guest. The offer is delivered via SMS + email,
// has a 30-minute TTL, and contains a one-click claim link to
// /reserve/claim/:token on the storefront. If the guest claims, their
// waitlist row atomically becomes a confirmed booking with the freed slot.
//
// Eligibility (matching a freed slot to a waitlist row):
//   - same conceptId
//   - waitlist row's status is `booked` AND waitlist=true (still waiting)
//   - waitlist row's partySize <= freed.partySize (their group fits the table)
//   - waitlist row's requested startTime is within ±2h of the freed slot
//     (we don't drag a 12 PM lunch booker into a 10 PM dinner slot)
//   - the waitlist row doesn't already have an open promotion offer
//
// Idempotency:
//   - Only ONE waitlist row gets offered per call. Caller fires this from
//     the cancellation handler; if it fails or the offer expires, the next
//     cancel triggers another attempt.
//   - The token uniqueness constraint prevents accidental duplicate offers.

import { randomBytes } from 'crypto'
import { prisma } from '../../lib/prisma.js'
import { sendPhoneMessage, sendEmail } from '../../lib/notify.js'
import { customerScope } from '../../lib/outboundScope.js'
import { emitReservationEvent } from '../../lib/ws.js'
import { formatBrandName } from '../../lib/brandName.js'

const PROMOTION_TTL_MIN = 30
const TIME_WINDOW_MS    = 2 * 60 * 60 * 1000   // candidates must want a time within ±2h of freed slot

interface FreedSlot {
  id: string
  conceptId: string
  partySize: number
  startTime: Date
  endTime: Date
  tableId: string | null
}

export async function tryPromoteWaitlist(freed: FreedSlot): Promise<{ promoted: false; reason: string } | { promoted: true; reservationId: string; token: string }> {
  // Pull the next-up waitlist row that matches.
  const candidate = await prisma.reservation.findFirst({
    where: {
      conceptId: freed.conceptId,
      status: 'booked',
      waitlist: true,
      partySize: { lte: freed.partySize },
      promotionToken: null,                // not already offered
      // Their requested start is within ±2h of the freed slot.
      startTime: {
        gte: new Date(freed.startTime.getTime() - TIME_WINDOW_MS),
        lte: new Date(freed.startTime.getTime() + TIME_WINDOW_MS),
      },
    },
    orderBy: { createdAt: 'asc' },           // FIFO — whoever joined first
    include: { concept: { select: { name: true, tenantId: true } } },
  })

  if (!candidate) {
    return { promoted: false, reason: 'no eligible waitlist row' }
  }
  if (!candidate.guestPhone && !candidate.guestEmail) {
    return { promoted: false, reason: 'candidate has no contact info' }
  }

  // CSPRNG token — Math.random's xorshift state is leaked by a single emission,
  // which would let an attacker race to claim a promoted waitlist slot.
  const token = randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + PROMOTION_TTL_MIN * 60_000)

  const promoted = await prisma.reservation.update({
    where: { id: candidate.id },
    data: {
      promotionToken:            token,
      promotionExpiresAt:        expiresAt,
      promotionOfferedStartTime: freed.startTime,
      promotionOfferedEndTime:   freed.endTime,
      promotionOfferedTableId:   freed.tableId,
    },
  })

  const storefrontUrl = process.env['STOREFRONT_URL'] ?? 'https://order.servd.pk'
  const claimUrl = `${storefrontUrl}/reserve/claim/${token}`
  const when = freed.startTime.toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })

  // Best-effort delivery. We don't block on either channel — if SMS fails but
  // email succeeds, the guest still gets the offer.
  if (candidate.guestPhone) {
    void sendPhoneMessage(
      candidate.guestPhone,
      `${formatBrandName(candidate.concept.name)}: a table just opened up for ${candidate.partySize} on ${when} PKT. Confirm in 30 min: ${claimUrl}`,
      'reservation.waitlist_promoted',
      customerScope(candidate.concept.tenantId),
    ).catch(() => {})
  }
  if (candidate.guestEmail) {
    const html = `<p>Hi ${candidate.guestName},</p>
      <p>Good news — a table for <strong>${candidate.partySize}</strong> just opened up at <strong>${formatBrandName(candidate.concept.name)}</strong> on <strong>${when} PKT</strong>.</p>
      <p>You have <strong>30 minutes</strong> to grab it.</p>
      <p><a href="${claimUrl}" style="background:#22c55e;color:#000;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">Confirm my table →</a></p>
      <p style="color:#666;font-size:12px">If you can't make it, just ignore this email — we'll offer the slot to the next person on the list.</p>`
    void sendEmail(
      candidate.guestEmail,
      `${formatBrandName(candidate.concept.name)} — a table just opened up`,
      html,
      'reservation.waitlist_promoted',
      customerScope(candidate.concept.tenantId),
    ).catch(() => {})
  }

  emitReservationEvent('reservation:waitlist-promoted', {
    reservationId: promoted.id,
    conceptId:     promoted.conceptId,
    startTime:     freed.startTime.toISOString(),
    status:        promoted.status,
  })

  return { promoted: true, reservationId: promoted.id, token }
}

// Sweep expired promotion offers (called every minute by the reservation
// worker). Clears the promotion fields so the row goes back to "open
// waitlist" — and we try to promote a different candidate, since the freed
// slot is presumably still empty at that point.
export async function sweepExpiredPromotions(): Promise<void> {
  const now = new Date()
  const expired = await prisma.reservation.findMany({
    where: {
      promotionToken: { not: null },
      promotionExpiresAt: { lt: now },
    },
    select: {
      id: true, conceptId: true, partySize: true,
      promotionOfferedStartTime: true, promotionOfferedEndTime: true, promotionOfferedTableId: true,
    },
  })

  for (const exp of expired) {
    await prisma.reservation.update({
      where: { id: exp.id },
      data: {
        promotionToken: null,
        promotionExpiresAt: null,
        promotionOfferedStartTime: null,
        promotionOfferedEndTime: null,
        promotionOfferedTableId: null,
      },
    })
    // Try to offer the slot to the next eligible waitlist row, if anyone's
    // still waiting and the slot is still in the future.
    if (exp.promotionOfferedStartTime && exp.promotionOfferedEndTime && exp.promotionOfferedStartTime > now) {
      tryPromoteWaitlist({
        id: 'expired-' + exp.id,
        conceptId: exp.conceptId,
        partySize: exp.partySize,
        startTime: exp.promotionOfferedStartTime,
        endTime:   exp.promotionOfferedEndTime,
        tableId:   exp.promotionOfferedTableId,
      }).catch(() => {})
    }
  }
}
