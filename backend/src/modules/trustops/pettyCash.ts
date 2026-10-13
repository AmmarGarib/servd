// Petty cash — the pieces shared by the petty-cash routes (routes.ts) and the
// cash vouchers (cashVouchers.ts).
//
//   • CASH_KEEPERS / CASH_GUARD — who may run petty cash (see routes.ts for
//     the wave-3 reasoning): the manager tiers plus finance, finance only
//     while it holds the 'accounting' module.
//   • recordPettyCashSpendTx — THE one way a spend leaves a box. The manual
//     spend (POST /trustops/petty-cash/movements) and a disbursed cash voucher
//     both go through it, so the float rule and the movement row are the same.
//
// Petty-cash spends are NOT posted to the ledger yet (accounting/
// expenseCategories.ts header: "once the cash domain wires it"). A spend that
// pays a supplier bill is booked by procurement createPaymentTx before this
// helper runs; everything else is a movement + a lower float, nothing more.

import type { Prisma, PettyCashMovement, UserRole } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import { requireAuth, FINANCE_TEAM } from '../auth/middleware.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'

export const CASH_KEEPERS: UserRole[] = FINANCE_TEAM
/** The Module Access half of CASH_GUARD (manager tiers exempt). */
export const CASH_MODULE_GATE = moduleGateForNewRoles(['accounting'])
export const CASH_GUARD = [requireAuth(...CASH_KEEPERS), CASH_MODULE_GATE]

/**
 * True when the signed-in user would pass CASH_GUARD — for routes that also
 * admit someone else (a box's custodian), so they run `requireAuth(ALL_STAFF)`
 * and decide here. Never throws for "no": only a real failure propagates.
 */
export async function passesCashGuard(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su || !CASH_KEEPERS.includes(su.role)) return false
  try {
    await CASH_MODULE_GATE(req)
    return true
  } catch (err) {
    if (err instanceof ForbiddenError) return false
    throw err
  }
}

const pkrWhole = (cents: number) => `PKR ${(cents / 100).toFixed(0)}`

/** 400 INSUFFICIENT_FLOAT — the one wording, for the pre-check and the claim. */
export function insufficientFloatError(spendCents: number, floatCents: number): AppError {
  return new AppError(
    'INSUFFICIENT_FLOAT',
    `This spend of ${pkrWhole(spendCents)} exceeds box float of ${pkrWhole(floatCents)}.`,
    400,
  )
}

export interface PettyCashSpendInput {
  /** The box, already resolved in the caller's company scope. */
  box: { id: string }
  /** What leaves the box, in paisa — positive. Stored negative on the movement. */
  amountCents: number
  category?: string | null
  reason: string
  vendorName?: string | null
  approvedById?: string | null
  createdById: string
  receiptUrl?: string | null
  /** Set when the spend paid a supplier bill (procurement createPaymentTx). */
  supplierPaymentId?: string | null
}

/**
 * Record a petty-cash spend inside `tx`: lower the box's float and write the
 * 'spend' movement. The float only drops when it covers the spend — checked
 * and applied in ONE conditional update, so two spends racing on the same box
 * can never take it below zero (400 INSUFFICIENT_FLOAT, and the caller's
 * transaction rolls back whatever it did before).
 */
export async function recordPettyCashSpendTx(
  tx: Prisma.TransactionClient,
  input: PettyCashSpendInput,
): Promise<{ movement: PettyCashMovement; newFloatCents: number }> {
  const amount = input.amountCents
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', 'A petty-cash spend must be a whole amount above zero', 400)
  }
  const claimed = await tx.pettyCashBox.updateMany({
    where: { id: input.box.id, deletedAt: null, floatCents: { gte: amount } },
    data: { floatCents: { decrement: amount } },
  })
  if (claimed.count === 0) {
    const current = await tx.pettyCashBox.findFirst({
      where: { id: input.box.id, deletedAt: null },
      select: { floatCents: true },
    })
    if (!current) throw new NotFoundError('PettyCashBox', input.box.id)
    throw insufficientFloatError(amount, current.floatCents)
  }
  const movement = await tx.pettyCashMovement.create({
    data: {
      boxId: input.box.id,
      type: 'spend',
      amountCents: -amount,
      category: input.category ?? null,
      reason: input.reason,
      receiptUrl: input.receiptUrl ?? null,
      vendorName: input.vendorName ?? null,
      approvedById: input.approvedById ?? null,
      supplierPaymentId: input.supplierPaymentId ?? null,
      createdById: input.createdById,
    },
  })
  const after = await tx.pettyCashBox.findUniqueOrThrow({ where: { id: input.box.id }, select: { floatCents: true } })
  return { movement, newFloatCents: after.floatCents }
}
