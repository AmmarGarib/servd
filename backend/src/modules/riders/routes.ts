import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

const riderSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  vehicleType: z.enum(['bike', 'car', 'bicycle', 'foot']).default('bike'),
  notes: z.string().optional(),
})

export async function riderRoutes(fastify: FastifyInstance) {
  // GET /riders
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return prisma.rider.findMany({
      where: { deletedAt: null },
      include: {
        orders: {
          where: { status: { in: ['confirmed', 'preparing', 'ready'] } },
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
    const rider = await prisma.rider.create({ data: body })
    return reply.status(201).send(rider)
  })

  // PATCH /riders/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = riderSchema.partial().parse(req.body)
      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)
      return prisma.rider.update({ where: { id: req.params.id }, data: body })
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
      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)
      return prisma.rider.update({ where: { id: req.params.id }, data: { status } })
    },
  )

  // DELETE /riders/:id (soft)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.rider.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } })
      return reply.status(204).send()
    },
  )

  // POST /riders/assign — assign rider to an order
  fastify.post<{ Body: { orderId: string; riderId: string } }>(
    '/assign',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { orderId, riderId } = z.object({
        orderId: z.string().uuid(),
        riderId: z.string().uuid(),
      }).parse(req.body)

      const [order, rider] = await Promise.all([
        prisma.order.findUnique({ where: { id: orderId } }),
        prisma.rider.findFirst({ where: { id: riderId, deletedAt: null, isActive: true } }),
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
      const order = await prisma.order.findUnique({ where: { id: orderId } })
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
      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)

      const orders = await prisma.order.findMany({
        where: { riderId: req.params.id, status: 'completed' },
        include: { concept: { select: { name: true } } },
        orderBy: { completedAt: 'desc' },
        take: 50,
      })

      return { rider, orders, totalDeliveries: rider.totalDeliveries }
    },
  )

  // POST /riders/:id/rate — rate a rider after delivery
  // Staff rates on behalf of customer (ALL_STAFF); one rating per order enforced
  // by the @unique constraint on RiderRating.orderId.
  fastify.post<{ Params: { id: string } }>(
    '/:id/rate',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        orderId: z.string().uuid(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      }).parse(req.body)

      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)

      // Verify the order exists and was handled by this rider
      const order = await prisma.order.findFirst({
        where: { id: body.orderId, riderId: req.params.id },
      })
      if (!order) {
        return reply.status(400).send({ error: { code: 'INVALID_ORDER', message: 'Order not found or not assigned to this rider' } })
      }

      // Create the rating; throws P2002 (unique constraint) if already rated
      const ratingRecord = await prisma.riderRating.create({
        data: {
          riderId: req.params.id,
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

      // Recompute avgRating from all existing ratings for this rider
      const agg = await prisma.riderRating.aggregate({
        where: { riderId: req.params.id },
        _avg: { rating: true },
        _count: { rating: true },
      })
      await prisma.rider.update({
        where: { id: req.params.id },
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
      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)

      const ratings = await prisma.riderRating.findMany({
        where: { riderId: req.params.id },
        include: {
          rider: { select: { name: true, avgRating: true } },
        },
        orderBy: { createdAt: 'desc' },
      })

      // Attach basic order info (status, concept) from the Order table
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

      const rider = await prisma.rider.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!rider) throw new NotFoundError('Rider', req.params.id)

      return prisma.rider.update({
        where: { id: req.params.id },
        data: {
          status: body.status,
          ...(body.notes !== undefined && { notes: body.notes }),
        },
      })
    },
  )

  // GET /riders/available — list riders who are currently available
  // Includes last-known location so dispatch can pick the closest.
  // NOTE: registered before /:id routes because Fastify matches in registration order.
  fastify.get(
    '/available',
    { preHandler: requireAuth(...ALL_STAFF) },
    async () => {
      return prisma.rider.findMany({
        where: { deletedAt: null, isActive: true, status: 'available' },
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
