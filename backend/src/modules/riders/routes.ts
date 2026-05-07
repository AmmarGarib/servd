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
}
