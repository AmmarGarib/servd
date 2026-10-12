import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { conceptWhere, assertConceptOwned } from '../../lib/tenantScope.js'

export async function reviewRoutes(fastify: FastifyInstance) {
  // GET /reviews — staff: list all reviews with filters
  fastify.get<{
    Querystring: { conceptId?: string; rating?: string; dateFrom?: string; dateTo?: string; limit?: string }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { conceptId, rating, dateFrom, dateTo, limit } = req.query
    // Company scope. There was none: any staff member of any company got every
    // company's reviews, and each row carries the reviewer's name, email and
    // phone through the order include below. A client-supplied conceptId was
    // taken on trust too, so naming another company's brand returned its
    // reviews directly. conceptWhere resolves ownership before it is used.
    const scope = await conceptWhere(req, conceptId, 'read')
    const reviews = await prisma.orderReview.findMany({
      where: {
        ...scope,
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

    // Points are per company (ONL-04): the bonus is in the programme of the
    // reviewed order's brand's company, through THE earn (loyalty/service),
    // which creates that company's account if needed and lets the liability
    // be booked once the review commits.
    const { creditPointsTx, bookEarn } = await import('../loyalty/service.js')
    const orderCompany = (await prisma.concept.findUnique({ where: { id: order.conceptId }, select: { tenantId: true } }))?.tenantId ?? null
    let bonusTxId: string | null = null
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
      if (bonusPoints > 0 && orderCompany) {
        const credited = await creditPointsTx(tx, {
          customerId: req.customer!.id,
          tenantId: orderCompany,
          orderId: body.orderId,
          points: bonusPoints,
          description: 'Bonus: posted review within 24h',
        })
        bonusTxId = credited.txId
      }
      return r
    })
    // The bonus is a liability like any earn (Dr 6060 / Cr 2060), in the
    // order's company — it used to move points with no entry.
    await bookEarn(bonusTxId)

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

    // The brand has to be one this operator's company owns, and the order has
    // to belong to that brand. Neither was checked, so a staff member at one
    // company could post a review of any rating onto another company's brand —
    // dragging down (or propping up) a competitor's public average, since these
    // rows feed the storefront rating.
    await assertConceptOwned(req, body.conceptId, 'create')
    const order = await prisma.order.findFirst({
      where: { id: body.orderId, conceptId: body.conceptId, deletedAt: null },
      select: { id: true },
    })
    if (!order) throw new NotFoundError('Order', body.orderId)

    const existing = await prisma.orderReview.findUnique({ where: { orderId: body.orderId } })
    if (existing) throw new ConflictError('Order already reviewed')

    const review = await prisma.orderReview.create({ data: body })
    return reply.status(201).send(review)
  })
}
