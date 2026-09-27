import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { verifyCustomerToken } from '../auth/service.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, type ScopeMode, activeTenantId } from '../../lib/tenantScope.js'

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

// ── Company scope ────────────────────────────────────────────────────────────
// A promo code belongs to ONE company (PromoCode.tenantId, stamped at create).
// conceptId narrows it to one brand of that company; a null conceptId means
// "every brand of ITS company", never every company. Before tenantId existed,
// a brand-less promo was listed, editable and redeemable across companies —
// one company could mint a 100%-off code valid at another company's brands.
// (Promo maths — what the percentage applies to — is a separate batch.)


async function findPromoInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const promo = await prisma.promoCode.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!promo) throw new NotFoundError('PromoCode', id)
  return promo
}

export async function promoRoutes(fastify: FastifyInstance) {
  // GET /promos — the companies in view.
  fastify.get<{ Querystring: { conceptId?: string; active?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.promoCode.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
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
    // New promos bind to the ACTIVE company; a brand, if named, must be its.
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const promo = await prisma.promoCode.create({ data: { ...body, tenantId, startAt: new Date(body.startAt), endAt: new Date(body.endAt) } })
    return reply.status(201).send(promo)
  })

  // PATCH /promos/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = createPromoSchema.partial().parse(req.body)
      const owned = await findPromoInScope(req, req.params.id, 'write')
      // Re-pointing the promo at a brand: only a brand of the promo's OWN
      // company. The promo never changes company.
      if (body.conceptId) {
        const concept = owned.tenantId
          ? await prisma.concept.findFirst({ where: { id: body.conceptId, tenantId: owned.tenantId, deletedAt: null }, select: { id: true } })
          : null
        if (!concept) throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand is not part of this promo\'s company', 422)
      }
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
      await findPromoInScope(req, req.params.id, 'write')
      await prisma.promoCode.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // POST /promos/validate — storefront: check if code is valid for a cart
  // Unauthenticated by design — the storefront checks a code before the
  // customer commits to anything — but rate limited, because an endpoint that
  // answers "is this a real code" instantly and without limit is a promo-code
  // oracle: guess against it until something comes back valid, then read the
  // discount terms straight out of the response.
  fastify.post<{ Body: { code: string; conceptId: string; orderCents: number; customerId?: string } }>(
    '/validate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const { code, conceptId, orderCents } = req.body
      const now = new Date()

      // customerId is taken from the SESSION, not the body. As a body field on
      // an unauthenticated route it let anyone probe whether a given customer
      // had already used a given code — and it is the per-customer limit
      // itself, so a caller could simply omit it to look past their own.
      let customerId: string | undefined
      const bearer = req.headers.authorization
      if (bearer?.startsWith('Bearer ')) {
        try { customerId = verifyCustomerToken(bearer.slice(7)).sub } catch { /* anonymous */ }
      }

      // The brand must be named and real: a promo only applies at brands of
      // the company that issued it, and another company's code answers
      // exactly like an unknown one (no cross-company oracle).
      const concept = typeof conceptId === 'string' && conceptId
        ? await prisma.concept.findFirst({ where: { id: conceptId, deletedAt: null }, select: { id: true, tenantId: true } })
        : null
      const promo = typeof code === 'string' ? await prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } }) : null

      if (!promo || !promo.isActive || !concept?.tenantId || promo.tenantId !== concept.tenantId) {
        throw new AppError('INVALID_PROMO', 'Promo code not found or inactive', 400)
      }
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
          order: { concept: { ...(await scopeTenantWhere(req, 'read')), deletedAt: null } },
        },
        include: { promoCode: { select: { code: true } }, order: { select: { id: true, placedAt: true } } },
        orderBy: { usedAt: 'desc' },
        take: limit,
      })
    },
  )
}
