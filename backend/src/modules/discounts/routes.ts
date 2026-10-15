import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError } from '../../lib/errors.js'
import { assertConceptOwned, conceptIdsInScope } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { TRASH_MARKETING } from '../trash/providers/masters/marketing.js'

const createDiscountSchema = z.object({
  conceptId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(),
  discountPercent: z.number().min(0.1).max(100),
  deliveryTypes: z.array(z.string()).default(['all']),
  orderTypes: z.array(z.string()).default(['all']),
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  isActive: z.boolean().default(true),
})

/** 422 unless `categoryId` is a live category of `conceptId`. */
async function assertCategoryOf(conceptId: string, categoryId: string): Promise<void> {
  const cat = await prisma.category.findFirst({ where: { id: categoryId, conceptId, deletedAt: null }, select: { id: true } })
  if (!cat) throw new AppError('CATEGORY_NOT_IN_BRAND', 'That category is not part of this brand', 422)
}

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding promos (Discounts page, under Promotions). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('promos')]

// Access (wave 3, UI-06): section discounts sit under Promotions (module
// promos), so the operator routes are MARKETING_TEAM — MANAGERS plus marketing
// and brand_manager — scoped to brands in view via lib/tenantScope.ts.
export async function discountRoutes(fastify: FastifyInstance) {
  // GET /discounts/sections — scoped to active tenant
  fastify.get<{ Querystring: { conceptId?: string; active?: string } }>(
    '/sections',
    { preHandler: marketingGuard },
    async (req) => {
      const now = new Date()
      // Only discounts on a brand in view (lib/tenantScope.ts — an empty scope
      // matches nothing). Discounts with a null conceptId belong to no company
      // and are excluded. A client conceptId only narrows inside that scope.
      const inScope = await conceptIdsInScope(req, 'read')
      const where: Record<string, unknown> = {
        conceptId: { in: req.query.conceptId ? inScope.filter((id) => id === req.query.conceptId) : inScope },
      }
      if (req.query.active === 'true') {
        where.isActive = true
        where.startDate = { lte: now }
        where.endDate = { gte: now }
      }
      return prisma.sectionDiscount.findMany({
        where,
        include: {
          concept: { select: { name: true } },
          category: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  // POST /discounts/sections — verify concept belongs to active tenant
  fastify.post('/sections', { preHandler: marketingGuard }, async (req, reply) => {
    const body = createDiscountSchema.parse(req.body)
    if (new Date(body.startDate) >= new Date(body.endDate)) {
      throw new AppError('INVALID_DATES', 'startDate must be before endDate', 400)
    }
    if (!body.conceptId) {
      return reply.status(400).send({ error: { code: 'CONCEPT_REQUIRED', message: 'conceptId is required for tenant-scoped discounts' } })
    }
    // New discounts bind to a brand of the ACTIVE company (404 otherwise); a
    // section discount's category must be that brand's own.
    await assertConceptOwned(req, body.conceptId, 'create')
    if (body.categoryId) await assertCategoryOf(body.conceptId, body.categoryId)
    const discount = await prisma.sectionDiscount.create({
      data: { ...body, startDate: new Date(body.startDate), endDate: new Date(body.endDate) },
    })
    return reply.status(201).send(discount)
  })

  // PATCH /discounts/sections/:id — verify ownership
  fastify.patch<{ Params: { id: string } }>(
    '/sections/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const owned = await prisma.sectionDiscount.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Discount not found in your active company' } })
      const body = createDiscountSchema.partial().parse(req.body)
      // The discount stays on its brand (it could otherwise be re-pointed at
      // another company's brand); a new category must be that brand's.
      if (body.conceptId !== undefined && body.conceptId !== owned.conceptId) {
        throw new AppError('CONCEPT_IMMUTABLE', 'A discount cannot be moved to another brand — create it there instead', 422)
      }
      if (body.categoryId && owned.conceptId) await assertCategoryOf(owned.conceptId, body.categoryId)
      const data: Record<string, unknown> = { ...body }
      if (body.startDate) data.startDate = new Date(body.startDate)
      if (body.endDate) data.endDate = new Date(body.endDate)
      return prisma.sectionDiscount.update({ where: { id: req.params.id }, data })
    },
  )

  // DELETE /discounts/sections/:id — verify ownership
  fastify.delete<{ Params: { id: string } }>(
    '/sections/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const owned = await prisma.sectionDiscount.findFirst({
        where: { id: req.params.id, conceptId: { in: await conceptIdsInScope(req, 'write') } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Discount not found in your active company' } })
      // Hard delete, but the row is kept whole in the Trash (snapshot) first.
      // SectionDiscount has no company column: the brand's company is the row's.
      await prisma.$transaction(async (tx) => {
        const brand = owned.conceptId
          ? await tx.concept.findUnique({ where: { id: owned.conceptId }, select: { tenantId: true, name: true } })
          : null
        const category = owned.categoryId
          ? await tx.category.findUnique({ where: { id: owned.categoryId }, select: { name: true } })
          : null
        await moveToTrash(tx, req, {
          type: TRASH_MARKETING.discount, entityId: owned.id, tenantId: brand?.tenantId ?? null, conceptId: owned.conceptId,
          title: `${owned.discountPercent}% off${category ? ` ${category.name}` : ' all dishes'}`,
          subtitle: brand?.name ?? null, reason: trashReasonOf(req),
          parent: owned.conceptId ? { type: 'brand', id: owned.conceptId } : null,
          snapshot: takeSnapshot('SectionDiscount', owned),
        })
        await tx.sectionDiscount.delete({ where: { id: owned.id } })
      })
      return reply.status(204).send()
    },
  )

  // GET /discounts/active — storefront: active section discounts for ONE brand.
  //
  // Unauthenticated by design: the public menu needs to show a live discount
  // before anyone signs in. That makes the where-clause the only thing standing
  // between one company's pricing and everybody else's, and it had two holes:
  //
  //   1. `conceptId` was typed as required but never validated. Omit it and
  //      Prisma receives `{ conceptId: undefined }`, which it treats as "no
  //      filter" — the OR collapsed to `[{}, …]`, matching EVERY active
  //      discount in the database, across every company. Same fail-open shape
  //      as the tenantId ?? undefined bug in lib/tenantScope.ts.
  //   2. `{ conceptId: null }` pulled in "all brands" rows. SectionDiscount has
  //      no tenantId, so such a row belongs to no company and would be served
  //      to all of them. POST /sections already refuses to create one
  //      (CONCEPT_REQUIRED) and GET /sections already excludes them for exactly
  //      this reason; this endpoint was the one that still read them.
  //
  // Now: the brand must be named, and only that brand's own rows come back.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/active',
    async (req, reply) => {
      const conceptId = req.query.conceptId
      if (!conceptId || !/^[0-9a-f-]{36}$/i.test(conceptId)) {
        return reply.status(400).send({
          error: { code: 'CONCEPT_REQUIRED', message: 'conceptId is required' },
        })
      }
      const now = new Date()
      const timeStr = now.toTimeString().substring(0, 5) // "HH:MM"
      const discounts = await prisma.sectionDiscount.findMany({
        where: {
          isActive: true,
          startDate: { lte: now },
          endDate: { gte: now },
          conceptId,
        },
      })
      // Filter by time window
      return discounts.filter((d) => d.startTime <= timeStr && timeStr <= d.endTime)
    },
  )
}
