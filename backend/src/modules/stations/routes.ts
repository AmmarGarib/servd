import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { requireModule } from '../notifications/requireModule.js'
import { STATION_REQUESTERS, raiseStationChange, stationChangeRoutes } from './changeRequests.js'
import { assertStationIdle, checkStationUpdate, createStationSchema, updateStationSchema } from './rules.js'

// Stations are brand-anchored (Station.conceptId) — their company is the
// brand's company. Reads are view-aware (the active company, or every company
// the operator belongs to in "All companies" view); edits and deletes reach
// any company the operator is a member of; a create binds only to a brand of
// the ACTIVE company; and a station can never be re-parented onto a brand of
// a different company. A foreign id always reads as 404 so it never confirms
// the row exists.

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
  // Raised station changes and the CEO's decisions (owner C3) — ./changeRequests.ts.
  await fastify.register(stationChangeRoutes)

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
  // The CEO's create applies at once. The F&B manager and the chef (owner C3,
  // 2026-10-26) RAISE it instead: 202 { pendingApproval, request } — it is
  // made when the CEO approves (./changeRequests.ts).
  fastify.post('/', { preHandler: [requireAuth(...ADMIN_ONLY, ...STATION_REQUESTERS), requireModule('kds_config')] }, async (req, reply) => {
    const body = createStationSchema.parse(req.body)
    if (!req.staffUser!.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a station', 422)
    await assertConceptOwned(req, body.conceptId, 'create')
    if (req.staffUser!.role !== 'admin') {
      const request = await raiseStationChange(req, { kind: 'create', conceptId: body.conceptId, changes: body })
      return reply.status(202).send({ pendingApproval: true, request })
    }
    const station = await prisma.station.create({ data: body })
    return reply.status(201).send(station)
  })

  // PATCH /stations/:id — the station must belong to a company the operator is
  // in, and a new conceptId must be a live brand of that same company.
  // Switching a station off, or moving it to another brand, takes it off the
  // screens its dishes and tickets are routed to — refused like a delete
  // while anything still routes there (assertStationIdle). Switching it back
  // on is always allowed.
  // The CEO's change applies at once; the F&B manager's and the chef's waits
  // for the CEO (202, owner C3) and is re-checked when approved.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: [requireAuth(...ADMIN_ONLY, ...STATION_REQUESTERS), requireModule('kds_config')] }, async (req, reply) => {
    const body = updateStationSchema.parse(req.body)
    const owned = await prisma.station.findFirst({
      where: await ownedStationWhere(req, req.params.id, 'write'),
      select: { id: true, name: true, isActive: true, conceptId: true, displayOrder: true, concept: { select: { tenantId: true } } },
    })
    if (!owned) throw new NotFoundError('Station', req.params.id)
    await checkStationUpdate(owned, body)
    if (req.staffUser!.role !== 'admin') {
      const request = await raiseStationChange(req, { kind: 'update', conceptId: owned.conceptId, station: owned, changes: body })
      return reply.status(202).send({ pendingApproval: true, request })
    }
    return prisma.station.update({ where: { id: owned.id }, data: body })
  })

  // DELETE /stations/:id — the station must belong to a company the operator
  // is in, and nothing may still route work to it (assertStationIdle).
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const owned = await prisma.station.findFirst({
      where: await ownedStationWhere(req, req.params.id, 'write'),
      select: { id: true, name: true, isActive: true, conceptId: true, concept: { select: { tenantId: true } } },
    })
    if (!owned) throw new NotFoundError('Station', req.params.id)

    await assertStationIdle(owned, 'delete it')

    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'station', entityId: owned.id, tenantId: owned.concept.tenantId, conceptId: owned.conceptId,
        title: owned.name, reason: trashReasonOf(req), meta: { previous: { isActive: owned.isActive } },
      })
      await tx.station.update({
        where: { id: owned.id },
        data: { deletedAt: new Date(), isActive: false },
      })
    })
    return reply.status(204).send()
  })
}
