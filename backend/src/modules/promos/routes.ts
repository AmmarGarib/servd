import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, type ScopeMode, activeTenantId } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { TRASH_MARKETING } from '../trash/providers/masters/marketing.js'

// discountValue units (ONL-01, lib/promoEval.ts): a 'percentage' promo stores
// the percent (0 < v ≤ 100); a 'fixed' promo stores PAISA (cents), a whole
// number — the admin form converts the rupees it shows. Checked on create and
// on every edit (against the promo's own type when the edit doesn't change it).
function assertDiscountValue(discountType: string, discountValue: number): void {
  if (discountType === 'percentage' && !(discountValue > 0 && discountValue <= 100)) {
    throw new AppError('INVALID_DISCOUNT', 'A percentage discount must be more than 0 and at most 100', 400)
  }
  if (discountType === 'fixed' && !(Number.isInteger(discountValue) && discountValue >= 1)) {
    throw new AppError('INVALID_DISCOUNT', 'A fixed discount is a whole number of paisa (PKR 150 = 15000)', 400)
  }
}

// A code is unique within its company (ONL-12, @@unique([tenantId, code])).
// The clash is answered as a 409 naming nothing about any other company — the
// check only ever looks inside the promo's own company.
const CODE_TAKEN = () => new AppError('PROMO_CODE_TAKEN', 'Your company already has a promo with this code', 409)
function isUniqueClash(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002'
}

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
  const promo = await prisma.promoCode.findFirst({ where: { id, deletedAt: null, ...(await scopeTenantWhere(req, mode)) } })
  if (!promo) throw new NotFoundError('PromoCode', id)
  return promo
}

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding promos (Promotions page). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('promos')]

// Access (wave 3, UI-06): promos are the Marketing workspace's job (module
// promos), so every route here is MARKETING_TEAM — MANAGERS plus marketing and
// brand_manager — and every one stays company-scoped as above.
export async function promoRoutes(fastify: FastifyInstance) {
  // GET /promos — the companies in view.
  fastify.get<{ Querystring: { conceptId?: string; active?: string } }>(
    '/',
    { preHandler: marketingGuard },
    async (req) => {
      return prisma.promoCode.findMany({
        where: {
          deletedAt: null, // a trashed code lives in the Trash, not in this list
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
  fastify.post('/', { preHandler: marketingGuard }, async (req, reply) => {
    const body = createPromoSchema.parse(req.body)
    if (new Date(body.startAt) >= new Date(body.endAt)) {
      throw new AppError('INVALID_DATES', 'startAt must be before endAt', 400)
    }
    assertDiscountValue(body.discountType, body.discountValue)
    // New promos bind to the ACTIVE company; a brand, if named, must be its.
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    // Only LIVE codes clash: one in the Trash does not block a new code with the
    // same text (restoring the old one then asks for a new code, TRASH_CLASH).
    if (await prisma.promoCode.findFirst({ where: { tenantId, code: body.code, deletedAt: null }, select: { id: true } })) throw CODE_TAKEN()
    try {
      const promo = await prisma.promoCode.create({ data: { ...body, tenantId, startAt: new Date(body.startAt), endAt: new Date(body.endAt) } })
      return reply.status(201).send(promo)
    } catch (err) {
      // Two creates of the same code racing past the check above.
      if (isUniqueClash(err)) throw CODE_TAKEN()
      throw err
    }
  })

  // PATCH /promos/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: marketingGuard },
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
      if (body.discountType !== undefined || body.discountValue !== undefined) {
        assertDiscountValue(body.discountType ?? owned.discountType, body.discountValue ?? owned.discountValue)
      }
      if (body.code !== undefined && body.code !== owned.code) {
        const clash = await prisma.promoCode.findFirst({
          where: { tenantId: owned.tenantId, code: body.code, deletedAt: null, id: { not: owned.id } },
          select: { id: true },
        })
        if (clash) throw CODE_TAKEN()
      }
      const data: Record<string, unknown> = { ...body }
      if (body.startAt) data.startAt = new Date(body.startAt)
      if (body.endAt) data.endAt = new Date(body.endAt)
      try {
        return await prisma.promoCode.update({ where: { id: owned.id }, data })
      } catch (err) {
        if (isUniqueClash(err)) throw CODE_TAKEN()
        throw err
      }
    },
  )

  // DELETE /promos/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const promo = await findPromoInScope(req, req.params.id, 'write')
      // To the Trash (owner, 2026-10-15). Orders and usages point at a code, so
      // it is soft-deleted AND switched off: even an older image after a
      // rollback (which ignores deletedAt) cannot redeem it. A used code is
      // never erased for good (providers/masters/marketing.ts).
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: TRASH_MARKETING.promo_code, entityId: promo.id, tenantId: promo.tenantId, conceptId: promo.conceptId,
          title: promo.code,
          subtitle: promo.discountType === 'percentage' ? `${promo.discountValue}% off` : `PKR ${(promo.discountValue / 100).toFixed(0)} off`,
          reason: trashReasonOf(req),
          meta: { previous: { isActive: promo.isActive } },
        })
        await tx.promoCode.update({ where: { id: promo.id }, data: { deletedAt: new Date(), isActive: false } })
      })
      return reply.status(204).send()
    },
  )

  // (POST /promos/validate is gone: it had no caller and its own copy of the
  // promo maths. The one evaluation is lib/promoEval.ts, used by checkout and
  // GET /storefront/promo-preview.)

  // GET /promos/usages — usage log (tenant-scoped via the order's concept).
  fastify.get<{ Querystring: { promoCodeId?: string; limit?: string } }>(
    '/usages',
    { preHandler: marketingGuard },
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
