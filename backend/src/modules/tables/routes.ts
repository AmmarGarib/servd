import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

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

export async function tableRoutes(fastify: FastifyInstance) {
  // GET /tables?conceptId=
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      return prisma.table.findMany({
        where: {
          deletedAt: null,
          // Scope to active tenant — only return tables for concepts under
          // the user's currently-selected company.
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
      const table = await prisma.table.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!table) throw new NotFoundError('Table', req.params.id)
      return prisma.table.update({
        where: { id: req.params.id },
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

  // POST /tables — verify the concept belongs to the user's active tenant
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createTableSchema.parse(req.body)
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const table = await prisma.table.create({ data: body })
    return reply.status(201).send(table)
  })

  // DELETE /tables/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.table.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
      return reply.status(204).send()
    },
  )
}
