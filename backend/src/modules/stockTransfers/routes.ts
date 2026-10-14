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
// Stock (finance wave B): stock is one FIFO pool per company — per-outlet
// stock is the next build — so a transfer moves nothing between lots. What
// did NOT arrive (received below sent) left the company's stock: it is booked
// on receipt as WASTE, reason 'transit_loss' — drawn FIFO from the lots
// ('waste'), a WasteLog in the item's company tagged with the sending outlet,
// and 'inventory.waste:<wasteLogId>' (Dr 5040 / Cr the class inventory,
// accounting/inventoryPosting.ts postWasteLog) behind a savepoint, flagged
// posting_failed after commit when refused. A shortfall needs a reason; more
// than was sent is 422 OVER_RECEIVED.

import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { assertInt4Fits } from '../../lib/money.js'
import { consumeFifoTx, ensureFifoReady, lockItemsTx, STOCK_EPS, STOCK_SOURCE } from '../../lib/stockLedger.js'
import { postInventoryDocInSavepoint, WASTE_SOURCE_TYPE } from '../accounting/inventoryPosting.js'
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
}).refine((v) => v.fromLocationId !== v.toLocationId, {
  message: 'fromLocationId and toLocationId must differ',
})

export async function stockTransferRoutes(fastify: FastifyInstance) {
  // GET /stock-transfers — list, with status + location + item filters
  fastify.get<{ Querystring: { status?: string; fromLocationId?: string; toLocationId?: string; limit?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { status, fromLocationId, toLocationId, limit } = req.query
      return prisma.stockTransfer.findMany({
        where: {
          // Company scope first; the client filters only narrow within it.
          ...(await transferScopeWhere(req, 'read')),
          ...(status         && { status }),
          ...(fromLocationId && { fromLocationId }),
          ...(toLocationId   && { toLocationId }),
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
    const createWhere = await scopeTenantWhere(req, 'create')
    const locations = await prisma.location.findMany({
      where: { id: { in: [body.fromLocationId, body.toLocationId] }, deletedAt: null, ...createWhere },
      select: { id: true },
    })
    if (locations.length !== 2) {
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

    const transfer = await prisma.stockTransfer.create({
      data: {
        ...body,
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
    return reply.status(201).send(transfer)
  })

  // PATCH /stock-transfers/:id/approve
  fastify.patch<{ Params: { id: string } }>('/:id/approve', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return transition(req.params.id, 'requested', 'approved', { approvedById: req.staffUser!.id, approvedAt: new Date() }, req)
  })

  // PATCH /stock-transfers/:id/ship — sender confirms driver picked up
  fastify.patch<{ Params: { id: string } }>('/:id/ship', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return transition(req.params.id, 'approved', 'shipped', { shippedById: req.staffUser!.id, shippedAt: new Date() }, req)
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
      let lossQty = 0
      if (shortfall > 0) {
        if (!item.tenantId) {
          throw new AppError('ITEM_HAS_NO_COMPANY', `${item.name} belongs to no company — assign it one before booking the transit loss.`, 422)
        }
        const q = toPurchaseUnits(shortfall, t.unit, item.unit)
        if (q == null) throw new AppError('UNIT_MISMATCH', `${item.name} is stocked in ${item.unit}; the transfer's ${t.unit} can't be converted to it`, 422)
        lossQty = q
        await ensureFifoReady(item.tenantId)
      }

      const actorId = req.staffUser!.id
      const res = await prisma.$transaction(async (tx) => {
        // The status move is conditional: two receivers cannot both book the loss.
        const moved = await tx.stockTransfer.updateMany({
          where: { id: t.id, status: 'shipped' },
          data: { status: 'received', receivedById: actorId, receivedAt: new Date(), receivedQuantity: received },
        })
        if (moved.count === 0) throw new AppError('BAD_STATE', 'This transfer was received or cancelled meanwhile.', 409)
        if (!(lossQty > STOCK_EPS) || !item.tenantId) return { wasteLogId: null, ledger: null, failure: null, at: new Date() }

        const tenantId = item.tenantId
        await lockItemsTx(tx, [item.id])
        const wasteLogId = randomUUID()
        const at = new Date()
        const r = await consumeFifoTx(tx, {
          tenantId, inventoryItemId: item.id, qty: lossQty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: wasteLogId,
          clamp: false, locationId: t.fromLocationId, occurredAt: at, createdById: actorId,
        })
        assertInt4Fits(r.valueCents, `The transit loss of ${item.name}`)
        await tx.wasteLog.create({
          data: {
            id: wasteLogId, tenantId, locationId: t.fromLocationId, inventoryItemId: item.id,
            quantity: lossQty, unit: item.unit, reason: 'transit_loss', estimatedCostCents: r.valueCents,
            notes: `Transfer ${t.id.slice(-8).toUpperCase()}: sent ${t.quantity} ${t.unit}, received ${received} ${t.unit} — ${reason}`.slice(0, 1000),
            recordedById: actorId, recordedAt: at,
          },
        })
        const post = await postInventoryDocInSavepoint(tx, WASTE_SOURCE_TYPE, wasteLogId, { tenantId, actorId, amountCents: r.valueCents })
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

  // PATCH /stock-transfers/:id/cancel — abort (any non-received status)
  fastify.patch<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
      const t = await findOwnedTransfer(req, req.params.id)
      if (t.status === 'received') throw new AppError('IMMUTABLE', 'Cannot cancel a received transfer', 422)
      if (t.status === 'cancelled') return t
      // Conditional on the status read (stock-04): a receive that committed
      // meanwhile (with its transit-loss waste and entry) is never overwritten
      // by a cancel that read the transfer before it.
      const moved = await prisma.stockTransfer.updateMany({
        where: { id: t.id, status: t.status },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: req.staffUser!.id, cancelReason: body.reason ?? null },
      })
      if (moved.count === 0) throw new AppError('BAD_STATE', 'This transfer was received, cancelled or moved on meanwhile — reload it.', 409)
      const updated = await prisma.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })
      await audit({ category: 'identity',
        action: 'stock-transfer.cancel', entity: 'StockTransfer', entityId: t.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        before: { status: t.status }, after: { status: 'cancelled' }, metadata: { reason: body.reason },
      })
      return updated
    },
  )
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
