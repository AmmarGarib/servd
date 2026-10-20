// Active tender guards (spec §7.10; Raast QR 2026-10-12, spec §2 [A]).
//
// While the card machine works on a bill, or a Raast QR intent waits for the
// customer's transfer, nothing else may settle it: another tender, a comp, a
// gift card, loyalty, a check split, a cancel / void or the shift close would
// race the machine / the bank SMS and could take the money twice. W4 calls
// these under the order lock in processPayment, settlePayment('till'),
// compOrder, applyGiftCardTender, checkSplit and the shift close handler —
// every one of those call sites is now blocked by a waiting Raast intent too,
// with no change at the call site.

import type { Prisma, TerminalChargeStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'

type Tx = Prisma.TransactionClient

/** Statuses during which a charge may still take money (the partial unique index's set). */
export const ACTIVE_CHARGE_STATUSES: TerminalChargeStatus[] = ['pending', 'sent', 'approved', 'cancel_requested', 'unknown']

/**
 * 409 TERMINAL_CHARGE_ACTIVE {chargeId} when the order has an active
 * card-machine charge (other than `exceptChargeId`), and 409 RAAST_AWAITING
 * {receiptId} when a Raast QR intent of the order is still 'awaiting' the
 * customer's transfer (other than `exceptRaastReceiptId` — the intent being
 * paid).
 */
export async function assertNoActiveTerminalChargeTx(
  tx: Tx,
  orderId: string,
  exceptChargeId?: string | null,
  exceptRaastReceiptId?: string | null,
  exceptKeenuPushId?: string | null,
): Promise<void> {
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
  const raast = await tx.raastReceipt.findFirst({
    where: { orderId, status: 'awaiting', ...(exceptRaastReceiptId && { id: { not: exceptRaastReceiptId } }) },
    select: { id: true },
  })
  if (raast) {
    throw new AppError(
      'RAAST_AWAITING',
      'This bill is waiting for a Raast QR transfer — wait for the bank SMS, enter the reference by hand, or cancel Raast before doing anything else with it',
      409,
      { receiptId: raast.id },
    )
  }
  // Till flow (2026-10-20): a bill pushed to Keenu whose outcome is not known
  // yet is Keenu's to settle — nothing else touches it (pos/keenuPush.ts).
  const o = await tx.order.findUnique({ where: { id: orderId }, select: { settlementChannel: true, settlementMeta: true } })
  const push = o?.settlementChannel === 'keenu' ? (o.settlementMeta as { keenu?: { state?: string; pushId?: string } } | null)?.keenu : null
  if (push && (push.state === 'pending' || push.state === 'needs_attention') && push.pushId !== exceptKeenuPushId) {
    throw new AppError(
      'KEENU_PUSH_PENDING',
      'This bill was pushed to Keenu and its outcome is not known yet — check it on the till before doing anything else with it',
      409,
      { pushId: push.pushId },
    )
  }
}

/** The same guard under its tender-neutral name. */
export const assertNoActiveTenderTx = assertNoActiveTerminalChargeTx

/**
 * 409 SHIFT_HAS_ACTIVE_CHARGE {charges} when a drawer still has card-machine
 * charges (or refunds) in flight; 409 SHIFT_HAS_AWAITING_RAAST {receipts}
 * when a Raast QR intent on it still waits for the customer's transfer.
 */
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
  const raast = await prisma.raastReceipt.findMany({
    where: { shiftId, status: 'awaiting' },
    select: { id: true, orderId: true, status: true, amountCents: true },
    take: 20,
  })
  if (raast.length > 0) {
    throw new AppError(
      'SHIFT_HAS_AWAITING_RAAST',
      `${raast.length} Raast QR payment(s) on this drawer are still waiting for the customer's transfer — confirm or cancel them before closing`,
      409,
      { receipts: raast },
    )
  }
}
