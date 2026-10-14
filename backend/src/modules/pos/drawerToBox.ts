// Till drawer → petty-cash box (finance wave B, H2): cash taken out of an open
// drawer to fill a box. THE one writer for that move, called inside the
// petty-cash top-up's transaction (trustops/pettyCash.ts recordPettyCashTopupTx,
// source 'till').
//
// It is a 'payout'-type CashMovement on the drawer — never a 'drop': a drop is
// cash on its way to the bank (accounting/depositPosting.ts counts drops in the
// expected deposit and credits 1010 for them), so a box top-up written as a
// drop would raise a false deposit variance and leave 1015 with a stray
// balance. As a pay-out it lowers the drawer's expected cash and shows on the
// Z-report as a pay-out; the deposit expectation is unchanged.
//
// It carries no manager PIN, no category and posts no 'pos.payout' entry: the
// petty-cash top-up books it ONCE, as 'pettycash.till_topup:<cashMovementId>'
// Dr 1011 Petty cash / Cr 1015 Drawer (accounting/pettyCashPosting.ts). The
// shift close skips any pay-out whose entry reference ends ':<movementId>'
// (accounting/shiftPosting.ts), so it is never booked again at the close.
// CashMovement has no category column: the reason starts with
// PETTY_CASH_TOPUP_REASON so the drawer's list reads it.
//
// pos/service.ts recordCashMovement (the till's own pay-out, with its PIN, cap
// and expense posting) is untouched.

import type { Prisma } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { assertInt4Fits } from '../../lib/money.js'
import { assertShiftOf } from '../../lib/tenantScope.js'
import { drawerExpectationOf } from '../../lib/drawer.js'

/** The pay-out "category" of a drawer → box move (CashMovement has no column for it). */
export const PETTY_CASH_TOPUP_CATEGORY = 'petty_cash_topup'
/** How every drawer → box pay-out's reason starts. */
export const PETTY_CASH_TOPUP_REASON = 'Petty cash top-up'

/**
 * Take `amountCents` out of open drawer `shiftId` of company `tenantId` into a
 * petty-cash box, inside `tx`:
 *   • 422 SHIFT_NOT_IN_COMPANY / SHIFT_CLOSED unless it is an open shift of
 *     that company (assertShiftOf);
 *   • the shift row is locked, then 422 INSUFFICIENT_DRAWER_CASH when the
 *     drawer should hold less than the amount (blind count: the total is
 *     never shown);
 *   • writes the 'payout' CashMovement and returns its id.
 */
export async function recordDrawerToBoxTx(
  tx: Prisma.TransactionClient,
  a: { shiftId: string; tenantId: string; amountCents: number; reason: string; createdById: string },
): Promise<{ cashMovementId: string }> {
  if (!Number.isSafeInteger(a.amountCents) || a.amountCents <= 0) {
    throw new AppError('BAD_AMOUNT', 'The amount taken from the drawer must be a whole amount above zero', 400)
  }
  assertInt4Fits(a.amountCents, 'The amount taken from the drawer')
  await assertShiftOf(a.tenantId, a.shiftId, true)
  // One writer at a time on this drawer's cash (two box top-ups from one
  // drawer cannot both pass the check below).
  await tx.$queryRaw`SELECT id FROM shifts WHERE id = ${a.shiftId} FOR UPDATE`
  const shift = await tx.shift.findUnique({
    where: { id: a.shiftId },
    select: {
      status: true,
      openingFloatCents: true,
      payments: { select: { method: true, status: true, amountCents: true } },
      cashMovements: { select: { type: true, amountCents: true } },
    },
  })
  if (!shift || shift.status !== 'open') throw new AppError('SHIFT_CLOSED', 'This drawer is closed — pick an open drawer', 422)
  const expected = drawerExpectationOf(shift)
  if (a.amountCents > expected.expectedCents) {
    throw new AppError('INSUFFICIENT_DRAWER_CASH', 'That is more cash than this drawer should hold', 422)
  }
  const reason = `${PETTY_CASH_TOPUP_REASON}: ${a.reason}`.slice(0, 200)
  const movement = await tx.cashMovement.create({
    data: {
      shiftId: a.shiftId,
      type: 'payout',
      amountCents: a.amountCents,
      reason,
      recordedById: a.createdById,
    },
    select: { id: true },
  })
  return { cashMovementId: movement.id }
}
