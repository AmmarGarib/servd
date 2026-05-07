import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError, ConflictError } from '../../lib/errors.js'

export async function reviewRoutes(fastify: FastifyInstance) {
  // GET /reviews — staff: list all reviews with filters
  fastify.get<{
    Querystring: { conceptId?: string; rating?: string; dateFrom?: string; dateTo?: string; limit?: string }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { conceptId, rating, dateFrom, dateTo, limit } = req.query
    const reviews = await prisma.orderReview.findMany({
      where: {
        ...(conceptId && { conceptId }),
        ...(rating && { rating: parseInt(rating, 10) }),
        ...(dateFrom || dateTo ? {
          createdAt: {
            ...(dateFrom && { gte: new Date(dateFrom) }),
            ...(dateTo && { lte: new Date(dateTo) }),
          },
        } : {}),
      },
      include: {
        // Pull customer ids/contact through the order so the "Reach out"
        // button on review cards can spawn a CustomerConversation directly.
        order: {
          select: {
            id: true, source: true, customerName: true, placedAt: true,
            customer: { select: { id: true, name: true, email: true, phone: true } },
          },
        },
        concept: { select: { name: true, slug: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit ? parseInt(limit, 10) : 50,
    })

    const avg = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : null

    return { reviews, average: avg ? Math.round(avg * 10) / 10 : null, total: reviews.length }
  })

  // POST /reviews — customer submits review after order
  fastify.post('/', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const body = z.object({
      orderId: z.string().uuid(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(1000).optional(),
    }).parse(req.body)

    const order = await prisma.order.findFirst({
      where: { id: body.orderId, customerId: req.customer!.id, status: 'completed' },
    })
    if (!order) throw new AppError('NOT_FOUND', 'Order not found or not eligible for review', 404)

    const existing = await prisma.orderReview.findUnique({ where: { orderId: body.orderId } })
    if (existing) throw new ConflictError('Order already reviewed')

    const review = await prisma.orderReview.create({
      data: {
        orderId: body.orderId,
        customerId: req.customer!.id,
        conceptId: order.conceptId,
        rating: body.rating,
        comment: body.comment,
        source: 'storefront',
      },
    })
    return reply.status(201).send(review)
  })

  // POST /reviews/manual — staff creates review manually (e.g. from phone call)
  fastify.post('/manual', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      orderId: z.string().uuid(),
      conceptId: z.string().uuid(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(1000).optional(),
      source: z.string().default('manual'),
    }).parse(req.body)

    const review = await prisma.orderReview.create({ data: body })
    return reply.status(201).send(review)
  })
}
