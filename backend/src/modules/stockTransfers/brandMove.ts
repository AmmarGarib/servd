// Moving stock between brands (owner B13 (a), 2026-10-26: "Each brand keeps its own stock even when it shares a
// kitchen; moving stock between brands moves the cost between the brands' P&Ls automatically").
//
// A brand move is a STOCK TRANSFER (this module's one engine — never a second one) with `brandMove` true: whose lots
// ship (`fromConceptId`, NULL = the shared lots) and who owns them on arrival (`toConceptId`, NULL = shared). It may
// stay at ONE outlet (from = to location). brandMoveTx below runs the whole move in the caller's transaction:
//   • a StockTransfer row, status 'received' at once (requested / approved / shipped / received all stamped by the
//     actor — the instant route and a brand count use it; the normal request → approve → ship → receive flow takes
//     the same brand fields);
//   • the ship: lib/stockLedger.ts consumeFifoTx 'transfer_out' from the FROM brand's lots only (FIFO at lot cost,
//     never clamped — 409 INSUFFICIENT_STOCK);
//   • the arrival: transferInTx at the same outlet with `toConceptId` — new lots at the shipped cost and age, and ONE
//     balanced entry 'inventory.brand_move:<transferId>' (Dr 12x0 tagged the new brand / Cr 12x0 tagged the old).
// No P&L at the move: the brand that sells the stock later carries its cost in its own cost of sales.
// One company only: both brands are the item's company's (422 BRAND_NOT_IN_COMPANY), the outlet too (422
// LOCATION_NOT_IN_COMPANY). Inter-company supply is a later build.

import type { Prisma } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { assertBrandOfCompany, consumeFifoTx, lockItemsTx, STOCK_EPS, STOCK_SOURCE, transferInTx } from '../../lib/stockLedger.js'

type Tx = Prisma.TransactionClient

export interface BrandMoveInput {
  tenantId: string
  inventoryItemId: string
  locationId: string
  fromConceptId: string | null
  toConceptId: string | null
  /** In the item's stock unit. */
  qty: number
  /** The unit stored on the transfer row (the item's stock unit). */
  unit: string
  actorId: string
  at: Date
  reason?: string | null
  /** The CEO's approval of a waiting brand move (brandMoveApproval.ts): claim THIS 'requested' row instead of
   *  creating one (409 NOT_PENDING when it moved on); `actorId` is the approver. */
  pendingTransferId?: string
}

/** The checks of a brand move before anything is written (also run when a manager raises one for the CEO). */
export async function checkBrandMoveTx(tx: Tx, a: Pick<BrandMoveInput, 'tenantId' | 'locationId' | 'fromConceptId' | 'toConceptId' | 'qty'>): Promise<void> {
  if ((a.fromConceptId ?? null) === (a.toConceptId ?? null)) {
    throw new AppError('SAME_BRAND', 'A brand move goes from one brand to another — pick two different brands (or shared stock)', 422)
  }
  if (!(a.qty > STOCK_EPS)) throw new AppError('INVALID_QTY', 'A brand move needs a quantity above zero', 422)
  await assertBrandOfCompany(tx, a.tenantId, a.fromConceptId)
  await assertBrandOfCompany(tx, a.tenantId, a.toConceptId)
  const loc = await tx.location.findFirst({ where: { id: a.locationId, tenantId: a.tenantId, deletedAt: null }, select: { id: true } })
  if (!loc) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet does not belong to this company — stock never moves across companies', 422)
}

/** Run a brand move in the caller's transaction (see the header). Call ensureFifoReady(tenantId) BEFORE the transaction. */
export async function brandMoveTx(tx: Tx, a: BrandMoveInput): Promise<{ transferId: string; qty: number; valueCents: number }> {
  await checkBrandMoveTx(tx, a)
  const stamps = {
    status: 'received', approvedById: a.actorId, shippedById: a.actorId, receivedById: a.actorId,
    approvedAt: a.at, shippedAt: a.at, receivedAt: a.at, receivedQuantity: a.qty,
  }
  let t: { id: string }
  if (a.pendingTransferId) {
    // The CEO's approval: the waiting row moves requested → received in this transaction, or nothing does.
    const claimed = await tx.stockTransfer.updateMany({ where: { id: a.pendingTransferId, status: 'requested', brandMove: true }, data: stamps })
    if (claimed.count === 0) throw new AppError('NOT_PENDING', 'This brand move is no longer waiting for approval — reload it.', 409)
    t = { id: a.pendingTransferId }
  } else {
    t = await tx.stockTransfer.create({
      data: {
        inventoryItemId: a.inventoryItemId, fromLocationId: a.locationId, toLocationId: a.locationId,
        fromConceptId: a.fromConceptId, toConceptId: a.toConceptId, brandMove: true,
        quantity: a.qty, unit: a.unit, reason: a.reason ?? null, requestedById: a.actorId, requestedAt: a.at, ...stamps,
      },
      select: { id: true },
    })
  }
  await lockItemsTx(tx, [a.inventoryItemId])
  let shipped
  try {
    shipped = await consumeFifoTx(tx, {
      tenantId: a.tenantId, inventoryItemId: a.inventoryItemId, qty: a.qty, kind: 'transfer_out', sourceType: STOCK_SOURCE.transferShip, sourceId: t.id,
      clamp: false, locationId: a.locationId, occurredAt: a.at, createdById: a.actorId,
      lotOwner: { conceptId: a.fromConceptId, shared: false },
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'NEGATIVE_STOCK') {
      throw new AppError('INSUFFICIENT_STOCK', `Not enough to move — ${(err as Error).message}`, 409)
    }
    throw err
  }
  await transferInTx(tx, {
    tenantId: a.tenantId, inventoryItemId: a.inventoryItemId, transferId: t.id, toLocationId: a.locationId, receivedAt: a.at,
    createdById: a.actorId, toConceptId: a.toConceptId,
  })
  return { transferId: t.id, qty: shipped.takenQty, valueCents: shipped.valueCents }
}
