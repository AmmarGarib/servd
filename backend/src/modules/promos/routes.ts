import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
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
// Promo maths (what a percentage applies to: the food subtotal, owner
// decision 10) lives in lib/promoEval.ts.


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

  // (POST /promos/validate is gone: it had no caller and its own copy of the
  // promo maths. The one evaluation is lib/promoEval.ts, used by checkout and
  // GET /storefront/promo-preview.)

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
