import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const createPromoSchema = z.object({
  code: z.string().min(1).max(50).toUpperCase(),
  description: z.string().optional(),
  conceptId: z.string().uuid().optional(),
  discountType: z.enum(['percentage', 'fixed']).default('percentage'),
  discountValue: z.number().positive(),
  minOrderCents: z.number().int().positive().optional(),
  maxDiscountCents: z.number().int().positive().optional(),
  maxUsageCount: z.number().int().positive().optional(),
  perCustomerLimit: z.number().int().min(1).default(1),
  channel: z.enum(['app', 'web', 'both']).default('both'),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  isActive: z.boolean().default(true),
})

export async function promoRoutes(fastify: FastifyInstance) {
  // GET /promos — scoped to the active tenant via concept.
  fastify.get<{ Querystring: { conceptId?: string; active?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.promoCode.findMany({
        where: {
          // Cross-tenant null-conceptId promos are still surfaced (tenant-portable).
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
          ],
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
          ...(req.query.active === 'true' && { isActive: true }),
        },
        include: { concept: { select: { name: true, slug: true } } },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  // POST /promos
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createPromoSchema.parse(req.body)
    if (new Date(body.startAt) >= new Date(body.endAt)) {
      throw new AppError('INVALID_DATES', 'startAt must be before endAt', 400)
    }
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const promo = await prisma.promoCode.create({ data: { ...body, startAt: new Date(body.startAt), endAt: new Date(body.endAt) } })
    return reply.status(201).send(promo)
  })

  // PATCH /promos/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = createPromoSchema.partial().parse(req.body)
      const owned = await prisma.promoCode.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
          ],
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Promo not found in your active company' } })
      const data: Record<string, unknown> = { ...body }
      if (body.startAt) data.startAt = new Date(body.startAt)
      if (body.endAt) data.endAt = new Date(body.endAt)
      return prisma.promoCode.update({ where: { id: req.params.id }, data })
    },
  )

  // DELETE /promos/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.promoCode.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
          ],
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Promo not found in your active company' } })
      await prisma.promoCode.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // POST /promos/validate — storefront: check if code is valid for a cart
  fastify.post<{ Body: { code: string; conceptId: string; orderCents: number; customerId?: string } }>(
    '/validate',
    async (req) => {
      const { code, conceptId, orderCents, customerId } = req.body
      const now = new Date()

      const promo = await prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } })

      if (!promo || !promo.isActive) throw new AppError('INVALID_PROMO', 'Promo code not found or inactive', 400)
      if (promo.startAt > now) throw new AppError('PROMO_NOT_STARTED', 'Promo code is not yet active', 400)
      if (promo.endAt < now) throw new AppError('PROMO_EXPIRED', 'Promo code has expired', 400)
      if (promo.conceptId && promo.conceptId !== conceptId) throw new AppError('PROMO_WRONG_CONCEPT', 'Promo code not valid for this brand', 400)
      if (promo.maxUsageCount != null && promo.usedCount >= promo.maxUsageCount) throw new AppError('PROMO_EXHAUSTED', 'Promo code usage limit reached', 400)
      if (promo.minOrderCents != null && orderCents < promo.minOrderCents) {
        throw new AppError('PROMO_MIN_ORDER', `Minimum order of PKR ${(promo.minOrderCents / 100).toFixed(0)} required`, 400)
      }

      if (customerId) {
        const usages = await prisma.promoCodeUsage.count({ where: { promoCodeId: promo.id, customerId } })
        if (usages >= promo.perCustomerLimit) throw new AppError('PROMO_LIMIT_REACHED', 'You have already used this promo code', 400)
      }

      let discountCents: number
      if (promo.discountType === 'percentage') {
        discountCents = Math.round(orderCents * (promo.discountValue / 100))
        if (promo.maxDiscountCents != null) discountCents = Math.min(discountCents, promo.maxDiscountCents)
      } else {
        discountCents = Math.min(promo.discountValue * 100, orderCents)
      }

      return {
        valid: true,
        promoCodeId: promo.id,
        code: promo.code,
        discountCents,
        description: promo.description,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
      }
    },
  )

  // GET /promos/usages — usage log (tenant-scoped via the order's concept).
  fastify.get<{ Querystring: { promoCodeId?: string; limit?: string } }>(
    '/usages',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      return prisma.promoCodeUsage.findMany({
        where: {
          ...(req.query.promoCodeId ? { promoCodeId: req.query.promoCodeId } : {}),
          order: { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
        },
        include: { promoCode: { select: { code: true } }, order: { select: { id: true, placedAt: true } } },
        orderBy: { usedAt: 'desc' },
        take: limit,
      })
    },
  )
}
