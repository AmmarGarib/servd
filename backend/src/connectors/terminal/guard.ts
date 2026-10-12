// Active card-machine charge guards (spec §7.10).
//
// While the card machine is working on a bill, nothing else may settle it:
// another tender, a comp, a gift card, a check split or the shift close would
// race the machine and could take the money twice. W4 calls these under the
// order lock in processPayment, settlePayment('till'), compOrder,
// applyGiftCardTender, checkSplit and the shift close handler.

import type { Prisma, TerminalChargeStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'

type Tx = Prisma.TransactionClient

/** Statuses during which a charge may still take money (the partial unique index's set). */
export const ACTIVE_CHARGE_STATUSES: TerminalChargeStatus[] = ['pending', 'sent', 'approved', 'cancel_requested', 'unknown']

/** 409 TERMINAL_CHARGE_ACTIVE {chargeId} when the order has an active card-machine charge (other than `exceptChargeId`). */
export async function assertNoActiveTerminalChargeTx(tx: Tx, orderId: string, exceptChargeId?: string | null): Promise<void> {
  const active = await tx.terminalCharge.findFirst({
    where: { orderId, kind: 'charge', status: { in: ACTIVE_CHARGE_STATUSES }, ...(exceptChargeId && { id: { not: exceptChargeId } }) },
    select: { id: true },
  })
  if (active) {
    throw new AppError(
      'TERMINAL_CHARGE_ACTIVE',
      'The card machine is still working on this bill — wait for it, cancel it, or resolve it before taking another tender',
      409,
      { chargeId: active.id },
    )
  }
}

/** 409 SHIFT_HAS_ACTIVE_CHARGE {charges} when a drawer still has card-machine charges (or refunds) in flight. */
export async function assertShiftHasNoActiveCharges(shiftId: string): Promise<void> {
  const rows = await prisma.terminalCharge.findMany({
    where: { shiftId, status: { in: ACTIVE_CHARGE_STATUSES } },
    select: { id: true, orderId: true, status: true, amountCents: true },
    take: 20,
  })
  if (rows.length > 0) {
    throw new AppError(
      'SHIFT_HAS_ACTIVE_CHARGE',
      `${rows.length} card-machine charge(s) on this drawer are not finished — finish, cancel or resolve them before closing`,
      409,
      { charges: rows },
    )
  }
}
