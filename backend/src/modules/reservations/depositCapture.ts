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
// Tax (owner + accountant H10, 2026-10-13): a kept no-show deposit is TAXABLE
// brand revenue with the tax INSIDE it. The hold is card-gateway money, so the
// brand's CARD rate (Concept.taxRateCard) applies:
//   T = round(D × taxRateCard / (100 + taxRateCard))
//   Dr 1030 Card / Gateway Receivable   D      (the hold sits with the gateway
//                                               until it settles to the bank)
//   Cr the brand's revenue account      D − T  (revenueCodeForConcept(slug))
//   Cr the brand's output-tax account   T      (outputTaxCodeFor — 2032 SRB
//                                               for a Sindh brand, …)
// No fiscal document is created: a kept deposit is not an order, and the POS
// contract has no non-order document — the sales-tax return declares it.
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
    include: { concept: { select: { name: true, slug: true, tenantId: true, province: true, srbPosId: true, taxRateCard: true } } },
  })
  if (!r) return { captured: false, reason: 'no-deposit' }
  if (r.depositCents <= 0) return { captured: false, reason: 'no-deposit' }
  if (!r.concept.tenantId) return { captured: false, reason: 'no-deposit' }
  const tenantId = r.concept.tenantId
  const noShowAt = args.noShowAt ?? new Date()

  const { postJournalEntry, flagPostingFailed, withLateNote, revenueCodeForConcept, ACCT } = await import('../accounting/journal.js')
  const { outputTaxCodeFor } = await import('../accounting/orderPosting.js')
  const revenueCode = revenueCodeForConcept(r.concept.slug)
  const outputTaxCode = outputTaxCodeFor(r.concept)
  const rate = Math.max(0, r.concept.taxRateCard)
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
      // H10: the tax is inside the kept deposit, at the brand's card rate.
      const D = held.depositCents
      const T = Math.round((D * rate) / (100 + rate))
      const noted = withLateNote(`No-show fee · ${formatBrandName(r.concept.name)} · ${r.guestName}`, [
        // The hold sits with the card gateway until it settles to the bank.
        { accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: D, conceptId: r.conceptId, memo: r.depositRef ? `Deposit hold ${r.depositRef}` : 'Deposit hold' },
        { accountCode: revenueCode, type: 'credit', amountCents: D - T, conceptId: r.conceptId, memo: 'No-show deposit kept' },
        { accountCode: outputTaxCode, type: 'credit', amountCents: T, conceptId: r.conceptId, memo: `Sales tax in no-show deposit (${rate}%)` },
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
