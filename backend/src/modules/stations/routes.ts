import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'

// Stations are brand-anchored (Station.conceptId) — their company is the
// brand's company. Reads are view-aware (the active company, or every company
// the operator belongs to in "All companies" view); edits and deletes reach
// any company the operator is a member of; a create binds only to a brand of
// the ACTIVE company; and a station can never be re-parented onto a brand of
// a different company. A foreign id always reads as 404 so it never confirms
// the row exists.

const createStationSchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().min(1),
  displayOrder: z.number().int().default(0),
})

const updateStationSchema = createStationSchema.partial()

/**
 * Prisma `where` for one live station whose brand is inside `mode`'s company
 * scope. Every by-id handler goes through this so a station reached by a
 * guessed id from another company is indistinguishable from a missing one.
 */
async function ownedStationWhere(req: FastifyRequest, id: string, mode: ScopeMode) {
  return {
    id,
    deletedAt: null,
    concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
  }
}

export async function stationRoutes(fastify: FastifyInstance) {
  // GET /stations?conceptId= — scoped to the companies in view. A supplied
  // conceptId is validated against that scope rather than trusted as the
  // scope itself.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.station.findMany({
        where: {
          deletedAt: null,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
          ...(req.query.conceptId && { conceptId: (await assertConceptOwned(req, req.query.conceptId, 'read')).id }),
        },
        orderBy: [{ conceptId: 'asc' }, { displayOrder: 'asc' }],
        include: { concept: { select: { name: true, slug: true } } },
      })
    },
  )

  // GET /stations/:id — scoped to the companies in view
  fastify.get<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const station = await prisma.station.findFirst({
      where: await ownedStationWhere(req, req.params.id, 'read'),
    })
    if (!station) throw new NotFoundError('Station', req.params.id)
    return station
  })

  // POST /stations — the brand must belong to the ACTIVE company. tenantFilter
  // on a non-GET spans every company the operator belongs to, which is why
  // the create check uses the 'create' scope explicitly.
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = createStationSchema.parse(req.body)
    if (!req.staffUser!.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a station', 422)
    await assertConceptOwned(req, body.conceptId, 'create')
    const station = await prisma.station.create({ data: body })
    return reply.status(201).send(station)
  })

  // PATCH /stations/:id — the station must belong to a company the operator is
  // in, and a new conceptId must be a live brand of that same company.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = updateStationSchema.parse(req.body)
    const owned = await prisma.station.findFirst({
      where: await ownedStationWhere(req, req.params.id, 'write'),
      select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
    })
    if (!owned) throw new NotFoundError('Station', req.params.id)

    if (body.conceptId && body.conceptId !== owned.conceptId) {
      // A station may move between brands, but only within its own company —
      // never across to a brand of another company the operator also belongs
      // to. The write-scope lookup above only matches brands of a member
      // company, so the home tenant is never null in practice; guard anyway so
      // a null could never widen the filter to company-less brands.
      const homeTenantId = owned.concept.tenantId
      if (!homeTenantId) throw new NotFoundError('Concept', body.conceptId)
      const target = await prisma.concept.findFirst({
        where: { id: body.conceptId, deletedAt: null, tenantId: homeTenantId },
        select: { id: true },
      })
      if (!target) throw new AppError('BRAND_NOT_IN_COMPANY', "Brand does not belong to this station's company", 422)
    }

    return prisma.station.update({ where: { id: owned.id }, data: body })
  })

  // DELETE /stations/:id — the station must belong to a company the operator is in
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const owned = await prisma.station.findFirst({
      where: await ownedStationWhere(req, req.params.id, 'write'),
      select: { id: true },
    })
    if (!owned) throw new NotFoundError('Station', req.params.id)
    await prisma.station.update({
      where: { id: owned.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })
}
