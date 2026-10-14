// Reservation deposit capture. Called only from markNoShow (noShow.ts), which
// both the manual no-show route and the auto-no-show worker use (D4).
//
// Capture = the guest didn't show up, so we forfeit their hold as a no-show
// fee. In ONE transaction, in the reservation's brand's company:
//   1. claim the deposit — depositCents → 0 only while it is still held, so a
//      later release can never "release" forfeited money, and two sweeps (or a
//      release racing the capture) capture at most once;
//   2. post 'reservation.deposit_capture:<reservationId>', dated the no-show,
//      every line tagged with the brand. A refusal (a closed period, a missing
//      account) rolls the claim back, so the deposit stays held and is flagged
//      posting_failed in that company (re-posted from Backfill unposted).
//
// Tax (H10 — accountant Hasnain, 2026-10-14): a kept no-show deposit is
// UNTAXED COMPENSATION, not a supply — other income, no output tax:
//   Dr 1030 Card / Gateway Receivable   D   (the hold is card-gateway money; it
//                                            sits with the gateway until it
//                                            settles to the bank)
//   Cr 4210 No-show Deposits Kept       D   (other income — below operating
//                                            revenue on the P&L; never the
//                                            brand's revenue account)
// Both lines keep the brand tag (conceptId) for reporting. Its reversal
// ('reservation.deposit_capture.reversal:', reverseJournalEntry) mirrors the
// lines. Captures posted before H10 (brand revenue + output tax inside, at
// the card rate) stay as they were booked; the sales-tax return still
// declares those ('pre-H10'), and nothing new.
// No fiscal document is ever created: a kept deposit is not an order and not
// a sale (the till's completeOrder is never called here).
//
// Idempotency: no deposit held (depositCents <= 0 — released, captured or
// never held) is a no-op, and the posting is keyed on the reservation id.

import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { formatBrandName } from '../../lib/brandName.js'

export type DepositCaptureResult =
  | { captured: false; reason: 'no-deposit' | 'already-no-show' }
  | { captured: true; amountCents: number; reservationId: string }

interface CaptureArgs {
  reservationId: string
  postedBy: string             // user id, or 'system' for the auto-no-show worker
  reason?: string              // optional cancelReason override (e.g. "Auto: no-show after window")
  staffUser?: { id?: string | null; email?: string | null } | null
  /** When the booking became a no-show (the entry's date). Defaults to now — markNoShow calls this right after its claim. */
  noShowAt?: Date
  /** A re-post from Backfill unposted into a later month names the original date (owner decision 6). */
  memoNote?: string
}

export async function captureReservationDeposit(args: CaptureArgs): Promise<DepositCaptureResult> {
  const r = await prisma.reservation.findUnique({
    where: { id: args.reservationId },
    include: { concept: { select: { name: true, tenantId: true } } },
  })
  if (!r) return { captured: false, reason: 'no-deposit' }
  if (r.depositCents <= 0) return { captured: false, reason: 'no-deposit' }
  if (!r.concept.tenantId) return { captured: false, reason: 'no-deposit' }
  const tenantId = r.concept.tenantId
  const noShowAt = args.noShowAt ?? new Date()

  const { postJournalEntry, flagPostingFailed, withLateNote, ACCT } = await import('../accounting/journal.js')
  let amountCents: number
  try {
    const claimed = await prisma.$transaction(async (tx) => {
      // Re-read under the claim: the amount captured is the amount held NOW.
      const held = await tx.reservation.findUnique({ where: { id: r.id }, select: { depositCents: true } })
      if (!held || held.depositCents <= 0) return 0
      const won = await tx.reservation.updateMany({
        where: { id: r.id, depositCents: held.depositCents },
        data: { depositCents: 0, status: 'no_show', cancelReason: args.reason ?? 'No-show — deposit captured' },
      })
      if (won.count === 0) return 0
      // H10: untaxed compensation — the whole deposit is other income (4210).
      const D = held.depositCents
      const noted = withLateNote(`No-show fee · ${formatBrandName(r.concept.name)} · ${r.guestName}`, [
        // The hold sits with the card gateway until it settles to the bank.
        { accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: D, conceptId: r.conceptId, memo: r.depositRef ? `Deposit hold ${r.depositRef}` : 'Deposit hold' },
        { accountCode: ACCT.NO_SHOW_DEPOSITS_KEPT, type: 'credit', amountCents: D, conceptId: r.conceptId, memo: 'No-show deposit kept — compensation, no sales tax (H10)' },
      ], args.memoNote)
      await postJournalEntry({
        tenantId,
        sourceType: 'reservation.deposit_capture',
        sourceId: r.id,
        description: noted.description,
        entryDate: noShowAt,
        postedBy: args.postedBy,
        lines: noted.lines,
      }, { tx })
      return held.depositCents
    })
    amountCents = claimed
  } catch (err) {
    await flagPostingFailed({
      tenantId,
      sourceType: 'reservation.deposit_capture',
      sourceId: r.id,
      entityType: 'Reservation',
      entityId: r.id,
      reason: (err as Error).message || 'posting failed',
      title: `No-show deposit of PKR ${(r.depositCents / 100).toFixed(0)} was not captured`,
      conceptId: r.conceptId,
      amountCents: r.depositCents,
    })
    throw err
  }
  if (amountCents <= 0) return { captured: false, reason: 'no-deposit' }

  await audit({ category: 'identity',
    action: 'reservation.deposit_capture',
    entity: 'Reservation',
    entityId: r.id,
    userId: args.staffUser?.id ?? null,
    tenantId,
    userEmail: args.staffUser?.email ?? null,
    before: { depositCents: amountCents, status: r.status },
    after:  { status: 'no_show', depositCents: 0, captured: amountCents },
  })

  return { captured: true, amountCents, reservationId: r.id }
}
