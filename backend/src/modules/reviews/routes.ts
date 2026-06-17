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
        concept: {
          select: {
            name: true, slug: true, tenantId: true,
            tenant: { select: { id: true, name: true, slug: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      // Cap pagination — an uncapped ?limit= is a free full-table dump + DoS.
      take: Math.min(Math.max(parseInt(limit ?? '50', 10) || 50, 1), 200),
    })

    const avg = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : null

    return { reviews, average: avg ? Math.round(avg * 10) / 10 : null, total: reviews.length }
  })

  // POST /reviews — customer submits review after order. Auto-credits a
  // 50-point loyalty bonus when submitted within 24h of completion (a small
  // "thanks for caring" gesture that lifts review rate dramatically).
  fastify.post('/', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const body = z.object({
      orderId: z.string().uuid(),
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(1000).optional(),
      // Optional sub-ratings — { food?, service?, value?, speed? }, each 1..5
      categoryRatings: z.object({
        food:    z.number().int().min(1).max(5).optional(),
        service: z.number().int().min(1).max(5).optional(),
        value:   z.number().int().min(1).max(5).optional(),
        speed:   z.number().int().min(1).max(5).optional(),
      }).optional(),
      // Quick-tap chips: 'Loved the bread', 'Quick service', etc.
      tags:    z.array(z.string().min(1).max(60)).max(10).optional(),
    }).parse(req.body)

    const order = await prisma.order.findFirst({
      where: { id: body.orderId, customerId: req.customer!.id, status: 'completed' },
    })
    if (!order) throw new AppError('NOT_FOUND', 'Order not found or not eligible for review', 404)

    const existing = await prisma.orderReview.findUnique({ where: { orderId: body.orderId } })
    if (existing) throw new ConflictError('Order already reviewed')

    // 50pt bonus if submitted within 24h of completion. Skipped if no
    // loyalty account (rare guest path), still allows the review.
    const within24h = order.completedAt
      ? (Date.now() - order.completedAt.getTime()) < 24 * 3600_000
      : false
    const bonusPoints = within24h ? 50 : 0

    const review = await prisma.$transaction(async (tx) => {
      const r = await tx.orderReview.create({
        data: {
          orderId: body.orderId,
          customerId: req.customer!.id,
          conceptId: order.conceptId,
          rating: body.rating,
          comment: body.comment,
          source: 'storefront',
          categoryRatings: body.categoryRatings ?? undefined,
          tags: body.tags ?? [],
          isPositive: body.rating >= 4,
          bonusPointsAwarded: bonusPoints,
        },
      })
      if (bonusPoints > 0) {
        const account = await tx.loyaltyAccount.findUnique({ where: { customerId: req.customer!.id } })
        if (account) {
          await tx.loyaltyAccount.update({
            where: { id: account.id },
            data: {
              pointsBalance: { increment: bonusPoints },
              lifetimePoints: { increment: bonusPoints },
            },
          })
          await tx.loyaltyTransaction.create({
            data: {
              loyaltyAccountId: account.id,
              orderId: body.orderId,
              type: 'earn',
              pointsDelta: bonusPoints,
              description: 'Bonus: posted review within 24h',
            },
          })
        }
      }
      return r
    })

    // Cross-module: refresh customer rollups so reviewCount/avgRating are
    // accurate everywhere immediately.
    const { bumpCustomerRollups } = await import('../../lib/customerRollups.js')
    bumpCustomerRollups(req.customer!.id)

    return reply.status(201).send({ ...review, bonusPointsAwarded: bonusPoints })
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
