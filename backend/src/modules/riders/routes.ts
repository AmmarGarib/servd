// Rider CRUD + assignment + ratings.
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

  // PATCH /riders/:id/status — go available / busy / offline
  fastify.patch<{ Params: { id: string }; Body: { status: string } }>(
    '/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { status } = z.object({
        status: z.enum(['available', 'busy', 'offline']),
      }).parse(req.body)
      const rider = await loadRiderInScope(req, req.params.id, 'write')
      return prisma.rider.update({ where: { id: rider.id }, data: { status } })
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

  // POST /riders/assign — assign rider to an order. Both must be in the
  // caller's scope AND in the same company. Stops cross-tenant fleet hijacking.
  fastify.post<{ Body: { orderId: string; riderId: string } }>(
    '/assign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { orderId, riderId } = z.object({
        orderId: z.string().uuid(),
        riderId: z.string().uuid(),
      }).parse(req.body)

      const scope = await scopeTenantWhere(req, 'write')
      const [order, rider] = await Promise.all([
        prisma.order.findFirst({
          where: {
            id: orderId,
            concept: { deletedAt: null, ...scope },
          },
          select: { id: true, concept: { select: { tenantId: true } } },
        }),
        prisma.rider.findFirst({
          where: { id: riderId, deletedAt: null, isActive: true, ...scope },
        }),
      ])

      if (!order) throw new NotFoundError('Order', orderId)
      if (!rider) throw new NotFoundError('Rider', riderId)
      // Write scope spans every company a head-office operator belongs to,
      // so "both in scope" is not "same company": the rider must belong to
      // the ORDER's company or one fleet ends up carrying the other's orders.
      if (rider.tenantId !== order.concept.tenantId) {
        throw new AppError('RIDER_NOT_IN_COMPANY', "Rider does not belong to the order's company", 422)
      }

      const [updatedOrder] = await prisma.$transaction([
        prisma.order.update({ where: { id: orderId }, data: { riderId } }),
        prisma.rider.update({ where: { id: riderId }, data: { status: 'busy' } }),
      ])

      return updatedOrder
    },
  )

  // POST /riders/unassign — unassign rider from order (mark delivered)
  fastify.post<{ Body: { orderId: string } }>(
    '/unassign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { orderId } = z.object({ orderId: z.string().uuid() }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!order) throw new NotFoundError('Order', orderId)

      let riderFreeAfter = false
      if (order.riderId) {
        const otherActive = await prisma.order.count({
          where: { riderId: order.riderId, id: { not: orderId }, status: { in: ['confirmed', 'preparing', 'ready'] } },
        })
        riderFreeAfter = otherActive === 0
      }

      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: orderId }, data: { riderId: null, status: 'completed', completedAt: new Date() } })
        if (order.riderId && riderFreeAfter) {
          await tx.rider.update({
            where: { id: order.riderId },
            data: { status: 'available', totalDeliveries: { increment: 1 } },
          })
        }
      })

      return { success: true }
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

  // PATCH /riders/:id/availability — set status and optional notes
  fastify.patch<{ Params: { id: string } }>(
    '/:id/availability',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        status: z.enum(['available', 'busy', 'offline']),
        notes: z.string().max(500).optional(),
      }).parse(req.body)

      const rider = await loadRiderInScope(req, req.params.id, 'write')

      return prisma.rider.update({
        where: { id: rider.id },
        data: {
          status: body.status,
          ...(body.notes !== undefined && { notes: body.notes }),
        },
      })
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
