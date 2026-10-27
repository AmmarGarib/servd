// Stock transfer workflow API.
//
// Status flow:
//   requested → approved → shipped → received          (happy path)
//                ↓                       ↓
//            cancelled               (any time before received)
//
// Permissions:
//   - requested  : managers at the FROM-location request
//   - approved   : managers at the TO-location approve
//   - shipped    : managers at the FROM-location stamp when driver picks up
//   - received   : managers at the TO-location confirm receipt + actual qty
//   - cancelled  : managers at either side until status='received'
//
// We don't yet enforce per-location-manager scoping — this MVP trusts
// authenticated managers to act in good faith. Enforcement queued for the
// per-location inventory refactor.
//
// Company scoping IS enforced. A transfer has no tenantId of its own — it is
// owned through its two locations (Location.tenantId, company master data).
// Reads/writes reach a transfer only when one of its locations belongs to a
// company in scope; a create pins both locations (and the item) to the
// ACTIVE company so a transfer can never span GS Foods ↔ GSX Viva. A
// company-less item is refused (422 ITEM_HAS_NO_COMPANY): its stock is on no
// company's lots.
//
// Stock BY SITE (owner, 2026-10-24, D4). A transfer moves stock between two
// sites of ONE company (two companies: 422 TRANSFER_CROSS_COMPANY — the
// inter-company engine is a later build):
//   • SHIP takes the quantity out of the sending site's lots, FIFO, at lot
//     cost ('transfer_out', lib/stockLedger.ts consumeFifoTx), never clamped:
//     short → 409 INSUFFICIENT_STOCK and nothing moves. The stock is then IN
//     TRANSIT (off the lots, still in the company's 12x0 — lotValuation adds
//     it back; no posting: same company, same account).
//   • RECEIVE puts it into new lots at the receiving site at the shipped cost
//     (transferInTx, 'transfer_in'). What did NOT arrive (received below
//     sent; a reason is required) is WASTE at the receiving site, reason
//     'transfer_shortfall', drawn from those new lots and posted
//     'inventory.waste:<wasteLogId>' (Dr 1290 / Cr the class inventory —
//     postWasteLog) behind a savepoint, flagged posting_failed after commit
//     when refused. More than was sent is 422 OVER_RECEIVED.
//   • CANCEL after ship gives the stock back to the very lots it left
//     (returnToLotsTx kind 'transfer_in', 'stock_transfer.cancel').
// A transfer shipped before per-site stock (no 'transfer_out' rows) keeps the
// old rule on receipt: its shortfall is 'transit_loss' waste at the sending
// site.
//
// BRANDS (owner B13 (a), 2026-10-26): a transfer may move stock between BRANDS
// of the company (`brandMove`: fromConceptId → toConceptId, NULL = shared
// lots), at the same outlet (from = to location — allowed only for a brand
// move) or between outlets. The ship draws ONLY the from-brand's lots; the
// arrival opens the to-brand's lots and posts 'inventory.brand_move:<id>'
// (Dr 12x0 new brand / Cr 12x0 old brand — no P&L at the move). A plain
// transfer (no brands) draws every lot and its arrived lots keep their brand.
// POST /stock-transfers/brand-move does a brand move at one outlet at once
// (brandMove.ts brandMoveTx — the same engine, all steps stamped).
//
// THE CEO APPROVES BRAND MOVES (owner, 2026-10-27): a brand move raised by
// anyone but the CEO waits ('requested', approval type stock_brand_move) and
// moves nothing until the CEO approves — brandMoveApproval.ts is the contract.

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { approvalSubject, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { assertInt4Fits } from '../../lib/money.js'
import {
  assertBrandOfCompany, consumeFifoTx, ensureFifoReady, lockItemsTx, returnToLotsTx, settleTransferLotsTx, STOCK_EPS, STOCK_SOURCE, transferInTx, transferOutRowsTx,
} from '../../lib/stockLedger.js'
import { postInventoryDocInSavepoint, WASTE_SOURCE_TYPE } from '../accounting/inventoryPosting.js'
import { costsHiddenFor } from '../inventory/routes.js'
import { brandMoveTx, checkBrandMoveTx } from './brandMove.js'
import { approveBrandMove, assertBrandMoveShippable, ceoOnly, closeBrandMove, isCeo, MIN_REJECT_NOTE } from './brandMoveApproval.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { flagPostingFailed } from '../accounting/journal.js'

/** A transfer's shortfall reason, like every waste and count difference, is read by the CEO before its cost is settled (H20). */
const MIN_REASON = 3
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }

// Prisma `where` fragment: the transfer touches a location of a company in
// scope for `mode` ('read' = view-aware, 'write' = every member company).
// OR over both ends so a legacy cross-company row stays visible to each side.
async function transferScopeWhere(req: FastifyRequest, mode: ScopeMode) {
  const locationWhere = await scopeTenantWhere(req, mode)
  return { OR: [{ fromLocation: locationWhere }, { toLocation: locationWhere }] }
}

// Resolve a transfer the operator may edit, or 404 (never confirm a foreign
// id exists).
async function findOwnedTransfer(req: FastifyRequest, id: string) {
  const t = await prisma.stockTransfer.findFirst({
    where: { id, ...(await transferScopeWhere(req, 'write')) },
  })
  if (!t) throw new NotFoundError('StockTransfer', id)
  return t
}

const createSchema = z.object({
  inventoryItemId: z.string().uuid(),
  fromLocationId:  z.string().uuid(),
  toLocationId:    z.string().uuid(),
  quantity:        z.number().positive().max(1_000_000),
  unit:            z.string().min(1).max(20),
  reason:          z.string().max(300).optional(),
  notes:           z.string().max(1000).optional(),
  // Brand stock (owner B13 (a)): a brand move names both sides (null = the shared lots).
  fromConceptId:   z.string().uuid().nullable().optional(),
  toConceptId:     z.string().uuid().nullable().optional(),
}).refine((v) => v.fromLocationId !== v.toLocationId || v.fromConceptId !== undefined || v.toConceptId !== undefined, {
  message: 'fromLocationId and toLocationId must differ (or move the stock between two brands)',
})

export async function stockTransferRoutes(fastify: FastifyInstance) {
  // GET /stock-transfers — list, with status + location + item filters
  fastify.get<{ Querystring: { status?: string; fromLocationId?: string; toLocationId?: string; limit?: string; brandMove?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { status, fromLocationId, toLocationId, limit, brandMove } = req.query
      return prisma.stockTransfer.findMany({
        where: {
          // Company scope first; the client filters only narrow within it.
          ...(await transferScopeWhere(req, 'read')),
          ...(status         && { status }),
          ...(fromLocationId && { fromLocationId }),
          ...(toLocationId   && { toLocationId }),
          // The approvals inbox: brand moves are the CEO's queue (stock_brand_move), the rest the managers'.
          ...(brandMove === 'true' ? { brandMove: true } : brandMove === 'false' ? { brandMove: false } : {}),
        },
        orderBy: { requestedAt: 'desc' },
        take: limit ? Math.min(parseInt(limit, 10), 200) : 50,
        include: {
          inventoryItem: { select: { name: true, unit: true, currentStock: true } },
          fromLocation:  { select: { name: true, slug: true } },
          toLocation:    { select: { name: true, slug: true } },
        },
      })
    },
  )

  // POST /stock-transfers — create (status='requested')
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createSchema.parse(req.body)

    // Both ends must be live locations of the ACTIVE company — a transfer
    // never spans companies, and a guessed foreign location id must not bind.
    if (!req.staffUser!.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before requesting a transfer', 422)
    // Two sites of two companies the operator belongs to: stock never moves across companies here.
    const both = await prisma.location.findMany({
      where: { id: { in: [body.fromLocationId, body.toLocationId] }, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { tenantId: true },
    })
    if (both.length === 2 && both[0]!.tenantId !== both[1]!.tenantId) {
      throw new AppError('TRANSFER_CROSS_COMPANY', 'A stock transfer moves stock between two outlets of ONE company — these belong to two companies', 422)
    }
    const createWhere = await scopeTenantWhere(req, 'create')
    const locations = await prisma.location.findMany({
      where: { id: { in: [body.fromLocationId, body.toLocationId] }, deletedAt: null, ...createWhere },
      select: { id: true },
    })
    if (locations.length !== new Set([body.fromLocationId, body.toLocationId]).size) {
      throw new AppError('LOCATION_NOT_IN_COMPANY', 'Both locations must belong to the active company', 422)
    }
    // The item must be the active company's own. A company-less legacy item
    // holds no lots in any company — assign it a company first.
    const item = await prisma.inventoryItem.findFirst({
      where: { id: body.inventoryItemId, deletedAt: null, OR: [createWhere, { tenantId: null }] },
      select: { id: true, name: true, tenantId: true },
    })
    if (!item) throw new NotFoundError('InventoryItem', body.inventoryItemId)
    if (!item.tenantId) {
      throw new AppError('ITEM_HAS_NO_COMPANY', `${item.name} belongs to no company yet — assign it one (Inventory → Unassigned) before moving it.`, 422)
    }
    // A brand move: both sides named (null = shared), different, brands of the item's company (never across companies).
    const brandMove = body.fromConceptId !== undefined || body.toConceptId !== undefined
    if (brandMove) {
      if (body.fromConceptId === undefined || body.toConceptId === undefined) {
        throw new AppError('BRAND_MOVE_NEEDS_BOTH', 'A brand move names the brand it comes from and the brand it goes to (null = shared stock)', 400)
      }
      if (body.fromConceptId === body.toConceptId) throw new AppError('SAME_BRAND', 'Pick two different brands (or shared stock)', 422)
      await assertBrandOfCompany(prisma, item.tenantId, body.fromConceptId)
      await assertBrandOfCompany(prisma, item.tenantId, body.toConceptId)
    }

    const transfer = await prisma.stockTransfer.create({
      data: {
        ...body,
        fromConceptId: body.fromConceptId ?? null,
        toConceptId: body.toConceptId ?? null,
        brandMove,
        requestedById: req.staffUser!.id,
        status: 'requested',
      },
      include: {
        inventoryItem: { select: { name: true, unit: true } },
        fromLocation:  { select: { name: true } },
        toLocation:    { select: { name: true } },
      },
    })
    await audit({ category: 'identity',
      action: 'stock-transfer.request',
      entity: 'StockTransfer',
      entityId: transfer.id,
      userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null,
      userEmail: req.staffUser?.email ?? null,
      after: { quantity: transfer.quantity, item: transfer.inventoryItem.name, from: transfer.fromLocation.name, to: transfer.toLocation.name },
    })
    // The bell (queued, after the write): the managers who may approve it.
    // A brand move waits for the CEO (stock_brand_move); a plain transfer for the managers.
    approvalWaiting(brandMove ? 'stock_brand_move' : 'stock_transfer', transfer.id, { round: `request:${transfer.requestedAt.toISOString()}`, actorId: req.staffUser!.id })
    return reply.status(201).send(brandMove ? { ...transfer, pendingApproval: true } : transfer)
  })

  // PATCH /stock-transfers/:id/approve
  fastify.patch<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    // A brand move is the CEO's to approve (brandMoveApproval.ts) — never a manager's.
    const owned = await findOwnedTransfer(req, req.params.id)
    if (owned.brandMove) return brandMoveApproved(req, owned)
    const approvedAt = new Date()
    const moved = await transition(req.params.id, 'requested', 'approved', { approvedById: req.staffUser!.id, approvedAt }, req)
    await decidedNotice(req, req.params.id, 'approve', approvedAt)
    return moved
  })

  // PATCH /stock-transfers/:id/ship — sender confirms driver picked up. The
  // quantity leaves the sending site's lots now (see the header): short → 409
  // INSUFFICIENT_STOCK and the transfer stays approved.
  fastify.patch<{ Params: { id: string } }>('/:id/ship', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const t = await findOwnedTransfer(req, req.params.id)
    if (t.status !== 'approved') {
      throw new AppError('BAD_STATE', `Cannot transition from '${t.status}' to 'shipped'. Expected 'approved'.`, 409)
    }
    await assertBrandMoveShippable(req, t)
    const { item, qty } = await transferStock(t)
    await ensureFifoReady(item.tenantId)
    const actorId = req.staffUser!.id
    const shippedAt = new Date()
    const shipped = await prisma.$transaction(async (tx) => {
      const moved = await tx.stockTransfer.updateMany({
        where: { id: t.id, status: 'approved' },
        data: { status: 'shipped', shippedById: actorId, shippedAt },
      })
      if (moved.count === 0) throw new AppError('BAD_STATE', 'This transfer is no longer \'approved\' — reload it.', 409)
      await lockItemsTx(tx, [item.id])
      try {
        const r = await consumeFifoTx(tx, {
          tenantId: item.tenantId, inventoryItemId: item.id, qty, kind: 'transfer_out', sourceType: STOCK_SOURCE.transferShip, sourceId: t.id,
          clamp: false, locationId: t.fromLocationId, occurredAt: shippedAt, createdById: actorId,
          // Brand stock: a brand move ships ONLY the from-brand's lots (null = the shared ones).
          lotOwner: t.brandMove ? { conceptId: t.fromConceptId, shared: false } : 'any',
        })
        return { qty: r.takenQty, valueCents: r.valueCents }
      } catch (err) {
        if ((err as { code?: string }).code === 'NEGATIVE_STOCK') {
          throw new AppError('INSUFFICIENT_STOCK', `Not enough ${item.name} at the sending outlet — ${(err as Error).message}`, 409)
        }
        throw err
      }
    }, TX_OPTS)
    const updated = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })
    await audit({ category: 'identity',
      action: 'stock-transfer.shipped', entity: 'StockTransfer', entityId: t.id,
      userId: actorId, tenantId: item.tenantId, userEmail: req.staffUser?.email ?? null,
      before: { status: 'approved' }, after: { status: 'shipped' }, metadata: { shippedQty: shipped.qty, unit: item.unit },
    })
    return costsHiddenFor(req) ? updated : { ...updated, shippedValueCents: shipped.valueCents }
  })

  // PATCH /stock-transfers/:id/receive — receiver confirms the quantity that
  // arrived (default: all of it). Above what was sent → 422 OVER_RECEIVED. A
  // shortfall needs a reason (422 SHORTFALL_REASON_REQUIRED) and is booked as
  // transit-loss waste in the item's company, in the same transaction as the
  // receipt (see the header).
  fastify.patch<{ Params: { id: string } }>(
    '/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        receivedQuantity: z.number().min(0).max(1_000_000).optional(),
        shortfallReason:  z.string().max(300).optional(),
      }).parse(req.body ?? {})
      const t = await findOwnedTransfer(req, req.params.id)
      if (t.status !== 'shipped') {
        throw new AppError('BAD_STATE', `Cannot transition from '${t.status}' to 'received'. Expected 'shipped'.`, 409)
      }
      const received = body.receivedQuantity ?? t.quantity
      const tol = 1e-9 * Math.max(1, t.quantity)
      if (received > t.quantity + tol) {
        throw new AppError('OVER_RECEIVED', `Only ${t.quantity} ${t.unit} was sent — ${received} ${t.unit} cannot have arrived. Check the count.`, 422)
      }
      const shortfall = received < t.quantity - tol ? t.quantity - received : 0
      const reason = body.shortfallReason?.trim() ?? ''
      if (shortfall > 0 && reason.length < MIN_REASON) {
        throw new AppError(
          'SHORTFALL_REASON_REQUIRED',
          `${t.quantity - received} ${t.unit} of what was sent did not arrive — say why (at least ${MIN_REASON} characters). It is booked as transit loss.`,
          422,
        )
      }

      const item = await prisma.inventoryItem.findUniqueOrThrow({
        where: { id: t.inventoryItemId },
        select: { id: true, name: true, unit: true, tenantId: true },
      })
      if (!item.tenantId) {
        throw new AppError('ITEM_HAS_NO_COMPANY', `${item.name} belongs to no company — assign it one before receiving it.`, 422)
      }
      let lossQty = 0
      if (shortfall > 0) {
        const q = toPurchaseUnits(shortfall, t.unit, item.unit)
        if (q == null) throw new AppError('UNIT_MISMATCH', `${item.name} is stocked in ${item.unit}; the transfer's ${t.unit} can't be converted to it`, 422)
        lossQty = q
      }
      await ensureFifoReady(item.tenantId)

      const actorId = req.staffUser!.id
      const res = await prisma.$transaction(async (tx) => {
        // The status move is conditional: two receivers cannot both book the loss.
        const moved = await tx.stockTransfer.updateMany({
          where: { id: t.id, status: 'shipped' },
          data: { status: 'received', receivedById: actorId, receivedAt: new Date(), receivedQuantity: received },
        })
        if (moved.count === 0) throw new AppError('BAD_STATE', 'This transfer was received or cancelled meanwhile.', 409)
        const tenantId = item.tenantId!
        await lockItemsTx(tx, [item.id])
        const at = new Date()
        // Per-site stock: what was shipped lands in new lots at the receiving site (none for a transfer shipped
        // before per-site stock — its shortfall keeps the old rule below).
        // The loss is booked from the arrived lots FIRST; only then do they settle the site's earlier shortfalls.
        const landed = await transferInTx(tx, {
          tenantId, inventoryItemId: item.id, transferId: t.id, toLocationId: t.toLocationId, receivedAt: at, createdById: actorId, settle: false,
          // Brand stock: a brand move's lots arrive as the to-brand's (and re-tag the cost); a plain transfer keeps each lot's brand.
          ...(t.brandMove ? { toConceptId: t.toConceptId } : {}),
        })
        const perSite = landed.lotIds.length > 0
        const settle = () => settleTransferLotsTx(tx, { tenantId, inventoryItemId: item.id, lotIds: landed.lotIds, at })
        if (!(lossQty > STOCK_EPS)) { await settle(); return { wasteLogId: null, ledger: null, failure: null, at } }

        const wasteLogId = randomUUID()
        // Shipped before per-site stock: the old rule — its loss leaves the company's pool, now the stock home (null).
        const wasteSite = perSite ? t.toLocationId : t.fromLocationId
        const r = await consumeFifoTx(tx, {
          tenantId, inventoryItemId: item.id, qty: lossQty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: wasteLogId,
          clamp: false, locationId: perSite ? t.toLocationId : null, occurredAt: at, createdById: actorId, ...(perSite ? { preferLotIds: landed.lotIds } : {}),
          // The loss comes out of the very lots that arrived, whoever owns them.
          lotOwner: 'any',
        })
        assertInt4Fits(r.valueCents, `The transit loss of ${item.name}`)
        await tx.wasteLog.create({
          data: {
            id: wasteLogId, tenantId, locationId: wasteSite, inventoryItemId: item.id, conceptId: t.brandMove ? t.toConceptId : null,
            quantity: lossQty, unit: item.unit, reason: perSite ? 'transfer_shortfall' : 'transit_loss', estimatedCostCents: r.valueCents,
            notes: `Transfer ${t.id.slice(-8).toUpperCase()}: sent ${t.quantity} ${t.unit}, received ${received} ${t.unit} — ${reason}`.slice(0, 1000),
            recordedById: actorId, recordedAt: at,
          },
        })
        const post = await postInventoryDocInSavepoint(tx, WASTE_SOURCE_TYPE, wasteLogId, { tenantId, actorId, amountCents: r.valueCents, conceptId: t.brandMove ? t.toConceptId : null })
        await settle()
        return { wasteLogId, ledger: post.ledger, failure: post.failure, at }
      }, TX_OPTS)
      if (res.failure) {
        await flagPostingFailed({
          ...res.failure, title: `Transit loss of ${item.name} did not reach the ledger`,
          metadata: { ...(res.failure.metadata ?? {}), documentDate: res.at.toISOString(), stockTransferId: t.id },
        })
      }

      await audit({ category: 'identity',
        action: 'stock-transfer.received',
        entity: 'StockTransfer',
        entityId: t.id,
        userId: actorId, tenantId: item.tenantId ?? req.staffUser?.tenantId ?? null,
        userEmail: req.staffUser?.email ?? null,
        before: { status: 'shipped' }, after: { status: 'received', receivedQuantity: received },
        metadata: shortfall > 0 ? { shortfall, shortfallReason: reason, wasteLogId: res.wasteLogId } : undefined,
      })
      const updated = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })
      return {
        ...updated,
        ...(res.wasteLogId ? { transitLoss: { wasteLogId: res.wasteLogId, quantity: lossQty, unit: item.unit, ledger: res.ledger } } : {}),
      }
    },
  )

  // POST /stock-transfers/brand-move — move stock between two brands at ONE outlet, at once (owner B13 (a)). The
  // active company's item and outlet; brands of that company (null = shared stock); 409 INSUFFICIENT_STOCK when the
  // from-brand does not hold it. Managers. Same engine as a transfer (brandMove.ts); audit 'stock-transfer.brand_move'.
  fastify.post('/brand-move', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      inventoryItemId: z.string().uuid(),
      locationId:      z.string().uuid(),
      fromConceptId:   z.string().uuid().nullable(),
      toConceptId:     z.string().uuid().nullable(),
      quantity:        z.number().positive().max(1_000_000),
      unit:            z.string().min(1).max(20).optional(),
      reason:          z.string().trim().max(300).optional(),
    }).parse(req.body)
    const tenantId = activeTenantId(req, 'a brand move is one company\'s stock')
    const item = await prisma.inventoryItem.findFirst({
      where: { id: body.inventoryItemId, tenantId, deletedAt: null }, select: { id: true, name: true, unit: true, tenantId: true },
    })
    if (!item) throw new NotFoundError('InventoryItem', body.inventoryItemId)
    const unit = body.unit ?? item.unit
    const qty = toPurchaseUnits(body.quantity, unit, item.unit)
    if (qty == null) throw new AppError('UNIT_MISMATCH', `${item.name} is stocked in ${item.unit}; ${unit} can't be converted to it`, 422)
    const actorId = req.staffUser!.id

    // Anyone but the CEO: the move waits for the CEO and nothing moves now (owner, 2026-10-27).
    if (!isCeo(req)) {
      await checkBrandMoveTx(prisma, { tenantId, locationId: body.locationId, fromConceptId: body.fromConceptId, toConceptId: body.toConceptId, qty })
      const request = await prisma.stockTransfer.create({
        data: {
          inventoryItemId: item.id, fromLocationId: body.locationId, toLocationId: body.locationId,
          fromConceptId: body.fromConceptId, toConceptId: body.toConceptId, brandMove: true,
          quantity: qty, unit: item.unit, reason: body.reason ?? null, requestedById: actorId, status: 'requested',
        },
      })
      await audit({ category: 'identity',
        action: 'stock-transfer.brand_move_requested', entity: 'StockTransfer', entityId: request.id,
        userId: actorId, tenantId, userEmail: req.staffUser?.email ?? null,
        after: { item: item.name, qty, unit: item.unit, fromConceptId: body.fromConceptId, toConceptId: body.toConceptId, locationId: body.locationId },
      })
      approvalWaiting('stock_brand_move', request.id, { round: `request:${request.requestedAt.toISOString()}`, actorId })
      return reply.status(202).send({ pendingApproval: true, request })
    }

    await ensureFifoReady(tenantId)
    const r = await prisma.$transaction((tx) => brandMoveTx(tx, {
      tenantId, inventoryItemId: item.id, locationId: body.locationId, fromConceptId: body.fromConceptId, toConceptId: body.toConceptId,
      qty, unit: item.unit, actorId, at: new Date(), reason: body.reason ?? null,
    }), TX_OPTS)
    await audit({ category: 'identity',
      action: 'stock-transfer.brand_move', entity: 'StockTransfer', entityId: r.transferId,
      userId: actorId, tenantId, userEmail: req.staffUser?.email ?? null,
      after: { item: item.name, qty: r.qty, unit: item.unit, fromConceptId: body.fromConceptId, toConceptId: body.toConceptId, locationId: body.locationId },
    })
    const t = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: r.transferId } })
    return reply.status(201).send(costsHiddenFor(req) ? t : { ...t, movedValueCents: r.valueCents })
  })

  // POST /stock-transfers/:id/brand-move/approve | reject {note ≥10} | withdraw — the CEO's decision on a waiting
  // brand move (approval type stock_brand_move), or the requester's withdrawal. Contract: brandMoveApproval.ts.
  fastify.post<{ Params: { id: string } }>('/:id/brand-move/approve', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const t = await findOwnedTransfer(req, req.params.id)
    return brandMoveApproved(req, t)
  })
  fastify.post<{ Params: { id: string } }>('/:id/brand-move/reject', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {})
    const t = await findOwnedTransfer(req, req.params.id)
    return closeBrandMove(req, t, 'reject', body.note)
  })
  fastify.post<{ Params: { id: string } }>('/:id/brand-move/withdraw', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const t = await findOwnedTransfer(req, req.params.id)
    return closeBrandMove(req, t, 'withdraw', null)
  })

  // PATCH /stock-transfers/:id/cancel — abort (any non-received status)
  fastify.patch<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
      const t = await findOwnedTransfer(req, req.params.id)
      if (t.status === 'received') throw new AppError('IMMUTABLE', 'Cannot cancel a received transfer', 422)
      if (t.status === 'cancelled') return t
      // A brand move waiting for the CEO: the requester withdraws it, the CEO rejects it (reason ≥10), nobody else.
      if (t.brandMove && t.status === 'requested') {
        if (t.requestedById === req.staffUser!.id && !isCeo(req)) return closeBrandMove(req, t, 'withdraw', body.reason)
        if (!isCeo(req)) throw ceoOnly('turn down a brand move someone else raised')
        if ((body.reason ?? '').trim().length < MIN_REJECT_NOTE && t.requestedById === req.staffUser!.id) return closeBrandMove(req, t, 'withdraw', body.reason)
        return closeBrandMove(req, t, 'reject', body.reason)
      }
      // Conditional on the status read (stock-04): a receive that committed
      // meanwhile (with its transit-loss waste and entry) is never overwritten
      // by a cancel that read the transfer before it. A shipped transfer gives
      // its stock back to the very lots it left, in the same transaction.
      const item = await prisma.inventoryItem.findUnique({ where: { id: t.inventoryItemId }, select: { tenantId: true } })
      if (t.status === 'shipped' && item?.tenantId) await ensureFifoReady(item.tenantId)
      await prisma.$transaction(async (tx) => {
        const moved = await tx.stockTransfer.updateMany({
          where: { id: t.id, status: t.status },
          data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: req.staffUser!.id, cancelReason: body.reason ?? null },
        })
        if (moved.count === 0) throw new AppError('BAD_STATE', 'This transfer was received, cancelled or moved on meanwhile — reload it.', 409)
        if (t.status !== 'shipped' || !item?.tenantId) return
        await lockItemsTx(tx, [t.inventoryItemId])
        const rows = await transferOutRowsTx(tx, item.tenantId, t.id)
        if (rows.length === 0) return
        await returnToLotsTx(tx, {
          rows, kind: 'transfer_in', sourceType: STOCK_SOURCE.transferCancel, sourceId: t.id, occurredAt: new Date(),
          tenantId: item.tenantId, createdById: req.staffUser!.id,
        })
      }, TX_OPTS)
      const updated = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })
      await audit({ category: 'identity',
        action: 'stock-transfer.cancel', entity: 'StockTransfer', entityId: t.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        before: { status: t.status }, after: { status: 'cancelled' }, metadata: { reason: body.reason },
      })
      await decidedNotice(req, t.id, 'cancel', updated.cancelledAt ?? new Date(), body.reason)
      return updated
    },
  )
}

/** The CEO approves a waiting brand move (brandMoveApproval.ts); costs shown as the inventory screens show them. */
async function brandMoveApproved(req: FastifyRequest, t: Awaited<ReturnType<typeof findOwnedTransfer>>) {
  if (!t.brandMove) throw new AppError('NOT_A_BRAND_MOVE', 'This transfer does not move stock between brands.', 422)
  if (!isCeo(req)) throw ceoOnly('approve it')
  const stock = await transferStock(t)
  const r = await approveBrandMove(req, t, stock)
  return costsHiddenFor(req) || r.movedValueCents == null ? r.transfer : { ...r.transfer, movedValueCents: r.movedValueCents }
}

/** The one approval.decide funnel (lib/approvalRights.ts auditApproval): writes the audit
 *  row and tells the requester (the bell). The route's own guard is a plain role list, so
 *  the grant is 'role'. Runs after the status move committed; it can never fail the action. */
async function decidedNotice(req: FastifyRequest, id: string, decision: 'approve' | 'cancel', at: Date, reason?: string | null) {
  try {
    const s = await approvalSubject('stock_transfer', id)
    await auditApproval(req, {
      type: 'stock_transfer', id, tenantId: s?.ownerTenantId ?? null, decision, grant: { via: 'role' }, entity: 'StockTransfer',
      metadata: { decidedAt: at.toISOString(), ...(reason ? { reason } : {}) },
    })
  } catch (err) {
    console.warn(`[stock-transfers] approval.decide not recorded: ${(err as Error).message}`)
  }
}

// Internal: enforce a status transition. Throws 409 if the row is in the
// wrong state — protects against double-clicks and out-of-order workflows.
async function transition(
  id: string,
  expected: string,
  next: string,
  patch: Record<string, unknown>,
  req: FastifyRequest,
) {
  // Scoped lookup: a transfer of a company the operator isn't in is a 404.
  const t = await findOwnedTransfer(req, id)
  if (t.status !== expected) {
    throw new AppError(
      'BAD_STATE',
      `Cannot transition from '${t.status}' to '${next}'. Expected '${expected}'.`,
      409,
    )
  }
  // Conditional: two clicks (or a cancel) racing this move — only one wins.
  const moved = await prisma.stockTransfer.updateMany({
    where: { id, status: expected },
    data: { status: next, ...patch },
  })
  if (moved.count === 0) throw new AppError('BAD_STATE', `This transfer is no longer '${expected}' — reload it.`, 409)
  const updated = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })
  await audit({ category: 'identity',
    action: `stock-transfer.${next}`,
    entity: 'StockTransfer',
    entityId: id,
    userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null,
    userEmail: req.staffUser?.email ?? null,
    before: { status: expected }, after: { status: next },
  })
  return updated
}

/** The transfer's item (must have a company) and its quantity in the item's stock unit (422 UNIT_MISMATCH). */
async function transferStock(t: { inventoryItemId: string; quantity: number; unit: string }) {
  const it = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: t.inventoryItemId }, select: { id: true, name: true, unit: true, tenantId: true } })
  if (!it.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', `${it.name} belongs to no company yet — assign it one before moving it.`, 422)
  const qty = toPurchaseUnits(t.quantity, t.unit, it.unit)
  if (qty == null) throw new AppError('UNIT_MISMATCH', `${it.name} is stocked in ${it.unit}; the transfer's ${t.unit} can't be converted to it`, 422)
  return { item: { ...it, tenantId: it.tenantId }, qty }
}
