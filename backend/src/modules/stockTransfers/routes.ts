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
// ACTIVE company so a transfer can never span GS Foods ↔ GSX Viva.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'

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
    // The item must be the active company's own, or a shared sourcing item
    // (tenantId NULL — the inventory module's convention for master-sheet rows).
    const item = await prisma.inventoryItem.findFirst({
      where: { id: body.inventoryItemId, deletedAt: null, OR: [createWhere, { tenantId: null }] },
      select: { id: true },
    })
    if (!item) throw new NotFoundError('InventoryItem', body.inventoryItemId)

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

  // PATCH /stock-transfers/:id/receive — receiver confirms; actual qty optional
  fastify.patch<{ Params: { id: string }; Body: { receivedQuantity?: number } }>(
    '/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ receivedQuantity: z.number().positive().optional() }).parse(req.body ?? {})
      return transition(
        req.params.id, 'shipped', 'received',
        { receivedById: req.staffUser!.id, receivedAt: new Date(), ...(body.receivedQuantity != null && { receivedQuantity: body.receivedQuantity }) },
        req,
      )
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
      const updated = await prisma.stockTransfer.update({
        where: { id: t.id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: req.staffUser!.id, cancelReason: body.reason ?? null },
      })
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
  const updated = await prisma.stockTransfer.update({
    where: { id },
    data: { status: next, ...patch },
  })
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
