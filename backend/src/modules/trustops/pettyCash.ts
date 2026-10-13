// Petty cash — the pieces shared by the petty-cash routes (routes.ts) and the
// cash vouchers (cashVouchers.ts).
//
//   • CASH_KEEPERS / CASH_GUARD — who may run petty cash (see routes.ts for
//     the wave-3 reasoning): the manager tiers plus finance, finance only
//     while it holds the 'accounting' module.
//   • The movement writers — THE only code that writes a PettyCashMovement or
//     moves a box's float. Every one of them goes through writeMovementTx, so
//     the ledger posting (when it comes) is added in ONE place:
//       recordPettyCashSpendTx    — a spend (manual, or a disbursed voucher)
//       recordPettyCashTopupTx    — a top-up, and a new box's opening float
//       recordPettyCashTransferTx — box → box, same company (two movements)
//       recordPettyCashCountTx    — a physical count (reconcile)
//
// LEDGER: petty cash posts NOTHING yet — pending owner decisions C1/C2/C5
// (finance gaps, 2026-10-13: whether petty cash gets its own balance-sheet
// line and where the money already in the boxes came from; how a director's
// cash voucher is booked; the spend categories). Only a spend that pays a
// supplier bill is booked, by procurement createPaymentTx before the spend
// helper runs (Dr 2010 / Cr 1010). When the decisions land, the posting goes
// into writeMovementTx — inside the caller's transaction, so a closed period
// rolls the movement and the float back together.

import { randomBytes } from 'node:crypto'
import type { Prisma, PettyCashMovement, UserRole } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import { requireAuth, FINANCE_TEAM } from '../auth/middleware.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { assertInt4Fits } from '../../lib/money.js'

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

/** What a movement row says it is. The API's /movements takes only topup|spend. */
export type PettyCashMovementType = 'topup' | 'spend' | 'reconcile' | 'transfer'

interface MovementRow {
  boxId: string
  type: PettyCashMovementType
  /** Signed paisa: + into the box, − out of it. */
  amountCents: number
  category?: string | null
  reason: string
  receiptUrl?: string | null
  vendorName?: string | null
  approvedById?: string | null
  supplierPaymentId?: string | null
  createdById: string
}

/**
 * THE one place a petty-cash movement row is written. Every writer below calls
 * it inside its transaction, after the float has moved.
 */
async function writeMovementTx(tx: Prisma.TransactionClient, row: MovementRow): Promise<PettyCashMovement> {
  assertInt4Fits(row.amountCents, 'A petty-cash movement')
  const movement = await tx.pettyCashMovement.create({
    data: {
      boxId: row.boxId,
      type: row.type,
      amountCents: row.amountCents,
      category: row.category ?? null,
      reason: row.reason,
      receiptUrl: row.receiptUrl ?? null,
      vendorName: row.vendorName ?? null,
      approvedById: row.approvedById ?? null,
      supplierPaymentId: row.supplierPaymentId ?? null,
      createdById: row.createdById,
    },
  })
  // TODO(C1/C2/C5): post the movement here — postPettyCashMovementTx(tx,
  // movement), keyed on the movement id, in the box's company — once the
  // owner decides how petty cash is booked (see the header).
  return movement
}

/**
 * Move a box's float by `delta` (signed) and return the new float. Money out
 * only when the float still covers it — checked and applied in ONE conditional
 * update, so two writers racing on the same box can never take it below zero
 * (400 INSUFFICIENT_FLOAT; the caller's transaction rolls back). Relative,
 * never "set to what we read", so a racing writer is never overwritten.
 */
async function moveFloatTx(tx: Prisma.TransactionClient, boxId: string, delta: number): Promise<number> {
  const moved = await tx.pettyCashBox.updateMany({
    where: { id: boxId, deletedAt: null, ...(delta < 0 && { floatCents: { gte: -delta } }) },
    data: { floatCents: { increment: delta } },
  })
  if (moved.count === 0) {
    const current = await tx.pettyCashBox.findFirst({ where: { id: boxId, deletedAt: null }, select: { floatCents: true } })
    if (!current) throw new NotFoundError('PettyCashBox', boxId)
    throw insufficientFloatError(-delta, current.floatCents)
  }
  const after = await tx.pettyCashBox.findUniqueOrThrow({ where: { id: boxId }, select: { floatCents: true } })
  return after.floatCents
}

function assertPositiveAmount(amount: number, what: string): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new AppError('BAD_AMOUNT', `${what} must be a whole amount above zero`, 400)
  }
  assertInt4Fits(amount, what)
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
 * 'spend' movement. The manual spend (POST /trustops/petty-cash/movements) and
 * a disbursed cash voucher both come here.
 */
export async function recordPettyCashSpendTx(
  tx: Prisma.TransactionClient,
  input: PettyCashSpendInput,
): Promise<{ movement: PettyCashMovement; newFloatCents: number }> {
  assertPositiveAmount(input.amountCents, 'A petty-cash spend')
  const newFloatCents = await moveFloatTx(tx, input.box.id, -input.amountCents)
  const movement = await writeMovementTx(tx, {
    boxId: input.box.id,
    type: 'spend',
    amountCents: -input.amountCents,
    category: input.category,
    reason: input.reason,
    receiptUrl: input.receiptUrl,
    vendorName: input.vendorName,
    approvedById: input.approvedById,
    supplierPaymentId: input.supplierPaymentId,
    createdById: input.createdById,
  })
  return { movement, newFloatCents }
}

export interface PettyCashTopupInput {
  box: { id: string }
  /** What goes into the box, in paisa — positive. */
  amountCents: number
  reason: string
  category?: string | null
  receiptUrl?: string | null
  vendorName?: string | null
  /** The approver whose PIN lifted the box's top-up limit, if any. */
  approvedById?: string | null
  createdById: string
}

/** Record a top-up inside `tx` (also a new box's opening float): raise the float, write the 'topup' movement. */
export async function recordPettyCashTopupTx(
  tx: Prisma.TransactionClient,
  input: PettyCashTopupInput,
): Promise<{ movement: PettyCashMovement; newFloatCents: number }> {
  assertPositiveAmount(input.amountCents, 'A petty-cash top-up')
  const current = await tx.pettyCashBox.findFirst({ where: { id: input.box.id, deletedAt: null }, select: { floatCents: true } })
  if (!current) throw new NotFoundError('PettyCashBox', input.box.id)
  assertInt4Fits(current.floatCents + input.amountCents, 'The box\'s float after this top-up')
  const newFloatCents = await moveFloatTx(tx, input.box.id, input.amountCents)
  const movement = await writeMovementTx(tx, {
    boxId: input.box.id,
    type: 'topup',
    amountCents: input.amountCents,
    category: input.category,
    reason: input.reason,
    receiptUrl: input.receiptUrl,
    vendorName: input.vendorName,
    approvedById: input.approvedById,
    createdById: input.createdById,
  })
  return { movement, newFloatCents }
}

export interface PettyCashTransferInput {
  fromBox: { id: string; name: string; tenantId: string }
  toBox: { id: string; name: string; tenantId: string }
  amountCents: number
  reason: string
  createdById: string
}

export interface PettyCashTransferResult {
  /** The shared reference both movements carry in their reason ("TRF-…"). */
  ref: string
  out: PettyCashMovement
  in: PettyCashMovement
  fromFloatCents: number
  toFloatCents: number
}

/**
 * Move cash from one box to another of the SAME company inside `tx`: two
 * 'transfer' movements (− on the source, + on the destination) carrying one
 * shared reference in their reason, the source's float claimed conditionally.
 * Both rows are locked in id order first, so two opposite transfers cannot
 * deadlock. No ledger effect even once petty cash posts: both boxes sit on
 * the same account.
 */
export async function recordPettyCashTransferTx(
  tx: Prisma.TransactionClient,
  input: PettyCashTransferInput,
): Promise<PettyCashTransferResult> {
  assertPositiveAmount(input.amountCents, 'A petty-cash transfer')
  if (input.fromBox.id === input.toBox.id) throw new AppError('SAME_BOX', 'Pick two different boxes', 400)
  if (input.fromBox.tenantId !== input.toBox.tenantId) {
    throw new AppError('BOX_NOT_IN_COMPANY', 'Both boxes must belong to the same company', 422)
  }
  const ids = [input.fromBox.id, input.toBox.id].sort()
  await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id IN (${ids[0]!}, ${ids[1]!}) ORDER BY id FOR UPDATE`
  const dest = await tx.pettyCashBox.findFirst({ where: { id: input.toBox.id, deletedAt: null }, select: { floatCents: true } })
  if (!dest) throw new NotFoundError('PettyCashBox', input.toBox.id)
  assertInt4Fits(dest.floatCents + input.amountCents, 'The receiving box\'s float after this transfer')

  const ref = `TRF-${randomBytes(4).toString('hex').toUpperCase()}`
  const fromFloatCents = await moveFloatTx(tx, input.fromBox.id, -input.amountCents)
  const out = await writeMovementTx(tx, {
    boxId: input.fromBox.id,
    type: 'transfer',
    amountCents: -input.amountCents,
    reason: `Transfer ${ref} to ${input.toBox.name}: ${input.reason}`,
    createdById: input.createdById,
  })
  const toFloatCents = await moveFloatTx(tx, input.toBox.id, input.amountCents)
  const inbound = await writeMovementTx(tx, {
    boxId: input.toBox.id,
    type: 'transfer',
    amountCents: input.amountCents,
    reason: `Transfer ${ref} from ${input.fromBox.name}: ${input.reason}`,
    createdById: input.createdById,
  })
  return { ref, out, in: inbound, fromFloatCents, toFloatCents }
}

export interface PettyCashCountInput {
  boxId: string
  countedCents: number
  notes?: string | null
  createdById: string
}

/**
 * Record a physical count inside `tx`: the variance (counted − float, against
 * the float AS LOCKED, so a spend landing during the count is never folded
 * into it) is written as a 'reconcile' movement and the float becomes the
 * count. Returns the box as it stood before the count.
 */
export async function recordPettyCashCountTx(
  tx: Prisma.TransactionClient,
  input: PettyCashCountInput,
): Promise<{ movement: PettyCashMovement; box: { id: string; name: string; tenantId: string | null; conceptId: string | null; floatCents: number }; varianceCents: number }> {
  if (!Number.isSafeInteger(input.countedCents) || input.countedCents < 0) {
    throw new AppError('BAD_AMOUNT', 'A count must be a whole amount, zero or more', 400)
  }
  assertInt4Fits(input.countedCents, 'The counted cash')
  await tx.$queryRaw`SELECT id FROM petty_cash_boxes WHERE id = ${input.boxId} FOR UPDATE`
  const box = await tx.pettyCashBox.findFirst({
    where: { id: input.boxId, deletedAt: null },
    select: { id: true, name: true, tenantId: true, conceptId: true, floatCents: true },
  })
  if (!box) throw new NotFoundError('PettyCashBox', input.boxId)
  const varianceCents = input.countedCents - box.floatCents
  await moveFloatTx(tx, box.id, varianceCents)
  const movement = await writeMovementTx(tx, {
    boxId: box.id,
    type: 'reconcile',
    amountCents: varianceCents,
    reason: input.notes ?? 'Reconciliation',
    createdById: input.createdById,
  })
  return { movement, box, varianceCents }
}
