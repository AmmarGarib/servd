// Reservation deposit capture — shared helper used by both the manual
// "deposit-capture" route AND the auto-no-show worker.
//
// Capture = the guest didn't show up, so we forfeit their hold as a no-show
// fee. We post a journal entry:
//   Dr Bank / Cr Service Charges Revenue (4100)
// because this is forfeit fee revenue, NOT a sale of food.
//
// Idempotency: if depositCents <= 0 (already released or never held), the
// capture is a no-op. Safe to call from a worker that may sweep the same row
// twice on a retry.

import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'

export type DepositCaptureResult =
  | { captured: false; reason: 'no-deposit' | 'already-no-show' }
  | { captured: true; amountCents: number; reservationId: string }

interface CaptureArgs {
  reservationId: string
  postedBy: string             // user id, or 'system' for the auto-no-show worker
  reason?: string              // optional cancelReason override (e.g. "Auto: no-show after window")
  staffUser?: { id?: string | null; email?: string | null } | null
}

export async function captureReservationDeposit(args: CaptureArgs): Promise<DepositCaptureResult> {
  const r = await prisma.reservation.findUnique({
    where: { id: args.reservationId },
    include: { concept: { select: { name: true, tenantId: true } } },
  })
  if (!r) return { captured: false, reason: 'no-deposit' }
  if (r.depositCents <= 0) return { captured: false, reason: 'no-deposit' }

  // Post the journal entry (idempotency guarded by sourceType+sourceId in journal lib)
  const { postJournalEntry, ACCT } = await import('../accounting/journal.js')
  if (!r.concept.tenantId) return { captured: false, reason: 'no-deposit' }
  await postJournalEntry({
    tenantId: r.concept.tenantId,
    sourceType: 'reservation.deposit_capture',
    sourceId: r.id,
    description: `No-show fee · ${r.concept.name} · ${r.guestName}`,
    postedBy: args.postedBy,
    lines: [
      { accountCode: ACCT.BANK,                   type: 'debit',  amountCents: r.depositCents },
      { accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'credit', amountCents: r.depositCents, memo: 'No-show forfeit' },
    ],
  })

  await prisma.reservation.update({
    where: { id: r.id },
    data: {
      status: 'no_show',
      cancelReason: args.reason ?? 'No-show — deposit captured',
    },
  })

  await audit({
    action: 'reservation.deposit_capture',
    entity: 'Reservation',
    entityId: r.id,
    userId: args.staffUser?.id ?? null,
    userEmail: args.staffUser?.email ?? null,
    before: { depositCents: r.depositCents, status: r.status },
    after:  { status: 'no_show', captured: r.depositCents },
  })

  return { captured: true, amountCents: r.depositCents, reservationId: r.id }
}
