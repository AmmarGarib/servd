// Rider roster: CRUD, history and ratings. Assigning, unassigning, marking
// delivered and setting a rider's availability are /dispatch (the one set of
// rules, dispatch/service.ts) — this module used to carry its own
// /riders/assign, /riders/unassign and two status PATCHes that disagreed
// with it.
//
// Tenant model: every Rider carries a tenantId (added in migration
// 20260602100000_rider_tenant_id) so a manager in tenant A cannot enumerate,
// mutate, rate, or unassign tenant B's riders. Every query in this module is
// scoped through `scopeTenantWhere` ('read' on GETs — portfolio-aware; 'write'
// on mutations — every company the operator belongs to). Creates bind to the
// ACTIVE company only, and an order may only be handed to a rider of the
// order's own company.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'

const riderSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  vehicleType: z.enum(['bike', 'car', 'bicycle', 'foot']).default('bike'),
  notes: z.string().optional(),
})

// Helper: assert a Rider exists in the caller's company scope, or throw 404.
// Goes through scopeTenantWhere rather than the raw tenantFilter so a staff
// user with no company resolves to an empty `in: []` rather than
// `tenantId: null` (which would match legacy company-less rows).
async function loadRiderInScope(req: FastifyRequest, riderId: string, mode: ScopeMode) {
  const rider = await prisma.rider.findFirst({
    where: { id: riderId, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
  })
  if (!rider) throw new NotFoundError('Rider', riderId)
  return rider
}

export async function riderRoutes(fastify: FastifyInstance) {
  // GET /riders
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    return prisma.rider.findMany({
      where: { deletedAt: null, ...scope },
      include: {
        orders: {
          where: {
            status: { in: ['confirmed', 'preparing', 'ready'] },
            concept: { deletedAt: null, ...scope },
          },
          select: { id: true, status: true, conceptId: true, placedAt: true,
            concept: { select: { name: true } }, customer: { select: { name: true } }, customerName: true },
          take: 1,
          orderBy: { placedAt: 'desc' },
        },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    })
  })

  // POST /riders — a new rider belongs to the ACTIVE company (honours
  // x-servd-active-tenant). tenantFilter is the wrong source here: on a
  // non-GET it expands to every company the operator belongs to.
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = riderSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a rider', 422)
    const rider = await prisma.rider.create({ data: { ...body, tenantId } })
    return reply.status(201).send(rider)
  })

  // PATCH /riders/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = riderSchema.partial().parse(req.body)
      const rider = await loadRiderInScope(req, req.params.id, 'write')
      return prisma.rider.update({ where: { id: rider.id }, data: body })
    },
  )

  // DELETE /riders/:id (soft)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const rider = await loadRiderInScope(req, req.params.id, 'write')
      await prisma.rider.update({ where: { id: rider.id }, data: { deletedAt: new Date(), isActive: false } })
      return reply.status(204).send()
    },
  )

  // GET /riders/:id/history — delivery history for a rider
  fastify.get<{ Params: { id: string } }>(
    '/:id/history',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const rider = await loadRiderInScope(req, req.params.id, 'read')

      const orders = await prisma.order.findMany({
        where: {
          riderId: rider.id,
          status: 'completed',
          // Defence in depth: rider tenant === order tenant should always
          // hold, but enforce on the query so a mis-assigned legacy row
          // never leaks across tenants.
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        include: { concept: { select: { name: true } } },
        orderBy: { completedAt: 'desc' },
        take: 50,
      })

      return { rider, orders, totalDeliveries: rider.totalDeliveries }
    },
  )

  // POST /riders/:id/rate — rate a rider after delivery
  fastify.post<{ Params: { id: string } }>(
    '/:id/rate',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        orderId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      }).parse(req.body)

      const rider = await loadRiderInScope(req, req.params.id, 'write')

      const order = await prisma.order.findFirst({
        where: {
          id: body.orderId,
          riderId: rider.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!order) {
        return reply.status(400).send({ error: { code: 'INVALID_ORDER', message: 'Order not found or not assigned to this rider' } })
      }

      const ratingRecord = await prisma.riderRating.create({
        data: {
          riderId: rider.id,
          orderId: body.orderId,
          rating: body.rating,
          comment: body.comment,
        },
      }).catch((err: { code?: string }) => {
        if (err.code === 'P2002') {
          throw Object.assign(new Error('Order already rated'), { statusCode: 409, code: 'ALREADY_RATED' })
        }
        throw err
      })

      const agg = await prisma.riderRating.aggregate({
        where: { riderId: rider.id },
        _avg: { rating: true },
        _count: { rating: true },
      })
      await prisma.rider.update({
        where: { id: rider.id },
        data: { avgRating: agg._avg.rating ?? null },
      })

      return reply.status(201).send({
        rating: ratingRecord,
        avgRating: agg._avg.rating,
        totalRatings: agg._count.rating,
      })
    },
  )

  // GET /riders/:id/ratings — rating history for a rider (managers)
  fastify.get<{ Params: { id: string } }>(
    '/:id/ratings',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const rider = await loadRiderInScope(req, req.params.id, 'read')

      const ratings = await prisma.riderRating.findMany({
        where: { riderId: rider.id },
        include: {
          rider: { select: { name: true, avgRating: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      const orderIds = ratings.map((r) => r.orderId)
      const orders = await prisma.order.findMany({
        where: {
          id: { in: orderIds },
          // Same defence in depth as /:id/history — a legacy mis-assigned
          // rating must not surface another company's order.
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true, status: true, placedAt: true, completedAt: true, concept: { select: { name: true } } },
      })
      const orderMap = new Map(orders.map((o) => [o.id, o]))

      return {
        rider: { id: rider.id, name: rider.name, avgRating: rider.avgRating, totalDeliveries: rider.totalDeliveries },
        ratings: ratings.map((r) => ({ ...r, order: orderMap.get(r.orderId) ?? null })),
      }
    },
  )

  // GET /riders/available — list riders who are currently available
  fastify.get(
    '/available',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      return prisma.rider.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          status: 'available',
          ...(await scopeTenantWhere(req, 'read')),
        },
        select: {
          id: true,
          name: true,
          phone: true,
          vehicleType: true,
          status: true,
          avgRating: true,
          totalDeliveries: true,
          lastLat: true,
          lastLng: true,
          lastHeading: true,
          lastReportedAt: true,
        },
        orderBy: { name: 'asc' },
      })
    },
  )
}
