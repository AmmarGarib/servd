// Rider CRUD + assignment + ratings.
//
// Tenant model: every Rider carries a tenantId (added in migration
// 20260602100000_rider_tenant_id) so a manager in tenant A cannot enumerate,
// mutate, rate, or unassign tenant B's riders. Every query in this module
// filters by `tenantId IN req.staffUser!.tenantFilter` accordingly.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const riderSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  vehicleType: z.enum(['bike', 'car', 'bicycle', 'foot']).default('bike'),
  notes: z.string().optional(),
})

// `tenantFilter` from auth middleware is `string | { in: string[] } | null`.
// Prisma's scalar-where input accepts that shape directly. A `null` filter
// means the staff user has no tenant assignment — they should see nothing.
type TenantFilter = string | { in: string[] } | null

// Helper: assert a Rider exists in the caller's tenant scope, or throw 404.
async function loadRiderInTenant(riderId: string, tenantFilter: TenantFilter) {
  if (tenantFilter == null) throw new NotFoundError('Rider', riderId)
  const rider = await prisma.rider.findFirst({
    where: { id: riderId, deletedAt: null, tenantId: tenantFilter },
  })
  if (!rider) throw new NotFoundError('Rider', riderId)
  return rider
}

// On create, tenantId must be a single string — not the portfolio array. If
// the caller is in portfolio view they must explicitly switch into a tenant
// first; we don't guess which tenant a brand-new rider should belong to.
function resolveSingleTenant(tenantFilter: TenantFilter): string {
  if (typeof tenantFilter === 'string') return tenantFilter
  if (tenantFilter && 'in' in tenantFilter && tenantFilter.in.length === 1) return tenantFilter.in[0]!
  throw new AppError(
    'TENANT_AMBIGUOUS',
    'Switch into a single tenant before creating a rider — portfolio view cannot decide where the rider belongs.',
    400,
  )
}

export async function riderRoutes(fastify: FastifyInstance) {
  // GET /riders
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return prisma.rider.findMany({
      where: { deletedAt: null, tenantId: req.staffUser!.tenantFilter ?? { in: [] } },
      include: {
        orders: {
          where: {
            status: { in: ['confirmed', 'preparing', 'ready'] },
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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

  // POST /riders
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = riderSchema.parse(req.body)
    const tenantId = resolveSingleTenant(req.staffUser!.tenantFilter)
    const rider = await prisma.rider.create({ data: { ...body, tenantId } })
    return reply.status(201).send(rider)
  })

  // PATCH /riders/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = riderSchema.partial().parse(req.body)
      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)
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
      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)
      return prisma.rider.update({ where: { id: rider.id }, data: { status } })
    },
  )

  // DELETE /riders/:id (soft)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)
      await prisma.rider.update({ where: { id: rider.id }, data: { deletedAt: new Date(), isActive: false } })
      return reply.status(204).send()
    },
  )

  // POST /riders/assign — assign rider to an order. Both must be in the
  // caller's tenant. Stops cross-tenant fleet hijacking.
  fastify.post<{ Body: { orderId: string; riderId: string } }>(
    '/assign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { orderId, riderId } = z.object({
        orderId: z.string().uuid(),
        riderId: z.string().uuid(),
      }).parse(req.body)

      const [order, rider] = await Promise.all([
        prisma.order.findFirst({
          where: {
            id: orderId,
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          },
        }),
        prisma.rider.findFirst({
          where: { id: riderId, deletedAt: null, isActive: true, tenantId: req.staffUser!.tenantFilter ?? { in: [] } },
        }),
      ])

      if (!order) throw new NotFoundError('Order', orderId)
      if (!rider) throw new NotFoundError('Rider', riderId)

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
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)

      const orders = await prisma.order.findMany({
        where: {
          riderId: rider.id,
          status: 'completed',
          // Defence in depth: rider tenant === order tenant should always
          // hold, but enforce on the query so a mis-assigned legacy row
          // never leaks across tenants.
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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

      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)

      const order = await prisma.order.findFirst({
        where: {
          id: body.orderId,
          riderId: rider.id,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)

      const ratings = await prisma.riderRating.findMany({
        where: { riderId: rider.id },
        include: {
          rider: { select: { name: true, avgRating: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      const orderIds = ratings.map((r) => r.orderId)
      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
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

      const rider = await loadRiderInTenant(req.params.id, req.staffUser!.tenantFilter)

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
          tenantId: req.staffUser!.tenantFilter ?? { in: [] },
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
