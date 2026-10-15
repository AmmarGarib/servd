import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'

const TABLE_STATUSES = ['available', 'seated', 'ordered', 'eating', 'check', 'reserved'] as const

const createTableSchema = z.object({
  conceptId: z.string().uuid(),
  label: z.string().min(1),
  capacity: z.number().int().min(1).default(4),
  floorSection: z.string().optional(),
})

const updateTableSchema = z.object({
  status: z.enum(TABLE_STATUSES).optional(),
  label: z.string().optional(),
  capacity: z.number().int().min(1).optional(),
  floorSection: z.string().optional(),
  // Occupancy fields — set when seating a party, cleared on checkout
  currentPartySize: z.number().int().min(1).nullable().optional(),
  currentOrderId: z.string().uuid().nullable().optional(),
  estimatedDepartureAt: z.string().datetime().nullable().optional(),
})

// Tables are brand-anchored (Table.conceptId) and reach their company through
// the brand. A table may only be edited or deleted when its brand belongs to
// a company the operator is a member of ('write' scope); a foreign or unknown
// id 404s so it never confirms another company's table exists.
async function findOwnedTable(req: FastifyRequest, id: string) {
  const table = await prisma.table.findFirst({
    where: {
      id,
      deletedAt: null,
      concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    },
  })
  if (!table) throw new NotFoundError('Table', id)
  return table
}

export async function tableRoutes(fastify: FastifyInstance) {
  // GET /tables?conceptId=
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // A client-supplied conceptId narrows the list but never widens the
      // scope — a brand outside the current view 404s instead of leaking.
      if (req.query.conceptId) await assertConceptOwned(req, req.query.conceptId, 'read')
      return prisma.table.findMany({
        where: {
          deletedAt: null,
          // Scope to the active company (or every member company in
          // "All companies" view) — only tables for brands in that scope.
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        include: { concept: { select: { name: true, slug: true } } },
        orderBy: [{ floorSection: 'asc' }, { label: 'asc' }],
      })
    },
  )

  // PATCH /tables/:id — update status, details, or live occupancy
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = updateTableSchema.parse(req.body)
      const table = await findOwnedTable(req, req.params.id)
      // A table can only be pinned to an order of its own brand — otherwise a
      // guessed order id could tie another company's ticket to this table.
      if (body.currentOrderId) {
        const order = await prisma.order.findFirst({
          where: { id: body.currentOrderId, conceptId: table.conceptId, deletedAt: null },
          select: { id: true },
        })
        if (!order) throw new AppError('ORDER_NOT_IN_BRAND', 'Order does not belong to this table\'s brand', 422)
      }
      return prisma.table.update({
        where: { id: table.id },
        data: {
          ...body,
          estimatedDepartureAt: body.estimatedDepartureAt
            ? new Date(body.estimatedDepartureAt)
            : body.estimatedDepartureAt === null
            ? null
            : undefined,
        },
      })
    },
  )

  // POST /tables — the brand must belong to the ACTIVE company. A create
  // never spans companies, so a brand of another member company 404s.
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createTableSchema.parse(req.body)
    if (!req.staffUser!.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a table', 422)
    await assertConceptOwned(req, body.conceptId, 'create')
    const table = await prisma.table.create({ data: body })
    return reply.status(201).send(table)
  })

  // DELETE /tables/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const table = await findOwnedTable(req, req.params.id)
      const concept = await prisma.concept.findUnique({ where: { id: table.conceptId }, select: { tenantId: true } })
      const floor = table.floorId
        ? await prisma.floor.findFirst({ where: { id: table.floorId, deletedAt: null }, select: { id: true } })
        : null
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: 'table', entityId: table.id, tenantId: concept?.tenantId ?? null, conceptId: table.conceptId,
          title: table.label, subtitle: table.floorSection || null, reason: trashReasonOf(req),
          parent: floor ? { type: 'floor', id: floor.id } : null,
          meta: { floorId: floor?.id ?? null },
        })
        await tx.table.update({ where: { id: table.id }, data: { deletedAt: new Date() } })
      })
      return reply.status(204).send()
    },
  )
}
