// Brand moves wait for the CEO (owner, 2026-10-27: "moving stock between brands needs my approval").
//
// ONE store: the StockTransfer row itself (brandMove true) — no second table. A brand move raised by anyone but the
// CEO (role `admin`) is a row in status 'requested' and moves NOTHING until the CEO approves:
//   • POST /stock-transfers/brand-move by a manager → 202 { pendingApproval: true, request } (a 'requested' row at
//     one outlet); the CEO's own call still moves at once (201).
//   • POST /stock-transfers with brands (the normal flow) → 'requested' as before, but only the CEO approves it.
// Approval type `stock_brand_move` (lib/approvalRights.ts: section ceo, ADMIN_ONLY, never delegable); its queue is
// GET /stock-transfers?status=requested&brandMove=true; the managers' stock_transfer queue never lists brand moves.
//   • APPROVE (POST /:id/brand-move/approve, or PATCH /:id/approve by the CEO): a move at ONE outlet (from = to) is
//     applied in the approval's own transaction through brandMoveTx (the row claimed requested → received; stock
//     re-checked NOW — 409 INSUFFICIENT_STOCK and nothing moves; ONE 'inventory.brand_move:<id>' entry); a move
//     between outlets goes requested → approved and managers then ship / receive it as any transfer.
//   • REJECT (POST /:id/brand-move/reject {note ≥10}, or the CEO's PATCH /:id/cancel with a reason ≥10) → cancelled.
//   • WITHDRAW (POST /:id/brand-move/withdraw, or the requester's PATCH /:id/cancel) → cancelled; the requester only.
//   • A brand move the CEO did not approve is never shipped by anyone but the CEO (403 BRAND_MOVE_CEO_ONLY) — a row
//     a manager approved before this rule waits for the CEO.
// Other managers can neither approve, reject nor cancel a waiting brand move (403 BRAND_MOVE_CEO_ONLY).

import type { FastifyRequest } from 'fastify'
import type { StockTransfer } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval, type ApprovalGrant } from '../../lib/approvalRights.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { brandMoveTx } from './brandMove.js'

const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }
export const MIN_REJECT_NOTE = 10

/** The CEO (role admin) — the only approver of a brand move. */
export const isCeo = (req: FastifyRequest) => req.staffUser?.role === 'admin'

export const ceoOnly = (what: string) =>
  new AppError('BRAND_MOVE_CEO_ONLY', `Moving stock between brands needs the CEO's approval — only the CEO may ${what}.`, 403)

async function grantFor(req: FastifyRequest, id: string): Promise<ApprovalGrant> {
  const s = await approvalSubject('stock_brand_move', id)
  if (!s) throw new NotFoundError('StockTransfer', id)
  return assertCanApprove(req, approvalInputOf('stock_brand_move', id, s))
}

/**
 * The CEO approves a waiting brand move. `stock` = the transfer's item (with its company) and the quantity in the
 * item's stock unit (routes.ts transferStock). One outlet: applied now; two outlets: approved for ship / receive.
 */
export async function approveBrandMove(
  req: FastifyRequest, t: StockTransfer, stock: { item: { id: string; unit: string; tenantId: string }; qty: number },
): Promise<{ transfer: StockTransfer; movedValueCents: number | null }> {
  if (!t.brandMove) throw new AppError('NOT_A_BRAND_MOVE', 'This transfer does not move stock between brands.', 422)
  if (!isCeo(req)) throw ceoOnly('approve it')
  const grant = await grantFor(req, t.id)
  if (t.status !== 'requested') throw new AppError('NOT_PENDING', `This brand move is no longer waiting for approval (it is '${t.status}').`, 409)
  const actorId = req.staffUser!.id
  const at = new Date()
  let movedValueCents: number | null = null
  if (t.fromLocationId === t.toLocationId) {
    await ensureFifoReady(stock.item.tenantId)
    const r = await prisma.$transaction((tx) => brandMoveTx(tx, {
      tenantId: stock.item.tenantId, inventoryItemId: stock.item.id, locationId: t.fromLocationId,
      fromConceptId: t.fromConceptId, toConceptId: t.toConceptId, qty: stock.qty, unit: stock.item.unit,
      actorId, at, reason: t.reason, pendingTransferId: t.id,
    }), TX_OPTS)
    movedValueCents = r.valueCents
  } else {
    const moved = await prisma.stockTransfer.updateMany({
      where: { id: t.id, status: 'requested', brandMove: true },
      data: { status: 'approved', approvedById: actorId, approvedAt: at },
    })
    if (moved.count === 0) throw new AppError('NOT_PENDING', 'This brand move is no longer waiting for approval — reload it.', 409)
  }
  await auditApproval(req, {
    type: 'stock_brand_move', id: t.id, tenantId: stock.item.tenantId, decision: 'approve', grant, entity: 'StockTransfer',
    metadata: {
      decidedAt: at.toISOString(), applied: t.fromLocationId === t.toLocationId, fromConceptId: t.fromConceptId, toConceptId: t.toConceptId,
      qty: stock.qty, unit: stock.item.unit, ...(movedValueCents != null ? { movedValueCents } : {}),
    },
  })
  return { transfer: await prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } }), movedValueCents }
}

/** The CEO turns a waiting brand move down (note ≥10), or the requester withdraws it. Nothing moved, nothing moves. */
export async function closeBrandMove(
  req: FastifyRequest, t: StockTransfer, how: 'reject' | 'withdraw', note: string | null | undefined,
): Promise<StockTransfer> {
  if (!t.brandMove) throw new AppError('NOT_A_BRAND_MOVE', 'This transfer does not move stock between brands.', 422)
  const text = (note ?? '').trim()
  let grant: ApprovalGrant | null = null
  if (how === 'reject') {
    if (!isCeo(req)) throw ceoOnly('reject it')
    if (text.length < MIN_REJECT_NOTE) throw new AppError('NOTE_TOO_SHORT', `Say why (at least ${MIN_REJECT_NOTE} characters) — the requester is told.`, 422)
    grant = await grantFor(req, t.id)
  } else if (t.requestedById !== req.staffUser!.id) {
    throw new AppError('NOT_YOUR_REQUEST', 'Only the person who raised this brand move may withdraw it.', 403)
  }
  if (t.status !== 'requested') throw new AppError('NOT_PENDING', `This brand move is no longer waiting for approval (it is '${t.status}').`, 409)
  const at = new Date()
  const moved = await prisma.stockTransfer.updateMany({
    where: { id: t.id, status: 'requested', brandMove: true },
    data: { status: 'cancelled', cancelledAt: at, cancelledById: req.staffUser!.id, cancelReason: text || (how === 'withdraw' ? 'Withdrawn by the requester' : null) },
  })
  if (moved.count === 0) throw new AppError('NOT_PENDING', 'This brand move is no longer waiting for approval — reload it.', 409)
  const s = await approvalSubject('stock_brand_move', t.id)
  await auditApproval(req, {
    type: 'stock_brand_move', id: t.id, tenantId: s?.ownerTenantId ?? null, decision: how === 'reject' ? 'reject' : 'cancel',
    grant: grant ?? { via: 'role' }, entity: 'StockTransfer', metadata: { decidedAt: at.toISOString(), ...(text ? { note: text } : {}) },
  })
  return prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })
}

/** May this brand move be shipped by the caller? Only once the CEO approved it (or by the CEO). */
export async function assertBrandMoveShippable(req: FastifyRequest, t: StockTransfer): Promise<void> {
  if (!t.brandMove || isCeo(req)) return
  const approver = t.approvedById ? await prisma.user.findUnique({ where: { id: t.approvedById }, select: { role: true } }) : null
  if (approver?.role !== 'admin') throw ceoOnly('ship a brand move the CEO has not approved')
}
