import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

const createStationSchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().min(1),
  displayOrder: z.number().int().default(0),
})

const updateStationSchema = createStationSchema.partial()

export async function stationRoutes(fastify: FastifyInstance) {
  // GET /stations?conceptId= — scoped to active tenant
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.station.findMany({
        where: {
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: { concept: { select: { name: true, slug: true } } },
      })
    },
  )

  // GET /stations/:id — scoped to active tenant
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const station = await prisma.station.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!station) throw new NotFoundError('Station', req.params.id)
    return station
  })

  // POST /stations — verify the concept belongs to the user's active tenant
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = createStationSchema.parse(req.body)
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const station = await prisma.station.create({ data: body })
    return reply.status(201).send(station)
  })

  // PATCH /stations/:id — verify station belongs to active tenant
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = updateStationSchema.parse(req.body)
    const owned = await prisma.station.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Station not found in your active company' } })
    return prisma.station.update({ where: { id: req.params.id }, data: body })
  })

  // DELETE /stations/:id — verify station belongs to active tenant
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const owned = await prisma.station.findFirst({
      where: {
        id: req.params.id,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Station not found in your active company' } })
    await prisma.station.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })
}
