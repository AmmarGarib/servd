import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'

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

export async function discountRoutes(fastify: FastifyInstance) {
  // GET /discounts/sections — scoped to active tenant
  fastify.get<{ Querystring: { conceptId?: string; active?: string } }>(
    '/sections',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const now = new Date()
      const where: Record<string, unknown> = {
        // Only show discounts attached to a concept under the active tenant.
        // (Discounts with null conceptId would be cross-tenant and are excluded.)
        concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      }
      if (req.query.conceptId) where.conceptId = req.query.conceptId
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
  fastify.post('/sections', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createDiscountSchema.parse(req.body)
    if (new Date(body.startDate) >= new Date(body.endDate)) {
      throw new AppError('INVALID_DATES', 'startDate must be before endDate', 400)
    }
    if (!body.conceptId) {
      return reply.status(400).send({ error: { code: 'CONCEPT_REQUIRED', message: 'conceptId is required for tenant-scoped discounts' } })
    }
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const discount = await prisma.sectionDiscount.create({
      data: { ...body, startDate: new Date(body.startDate), endDate: new Date(body.endDate) },
    })
    return reply.status(201).send(discount)
  })

  // PATCH /discounts/sections/:id — verify ownership
  fastify.patch<{ Params: { id: string } }>(
    '/sections/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.sectionDiscount.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Discount not found in your active company' } })
      const body = createDiscountSchema.partial().parse(req.body)
      const data: Record<string, unknown> = { ...body }
      if (body.startDate) data.startDate = new Date(body.startDate)
      if (body.endDate) data.endDate = new Date(body.endDate)
      return prisma.sectionDiscount.update({ where: { id: req.params.id }, data })
    },
  )

  // DELETE /discounts/sections/:id — verify ownership
  fastify.delete<{ Params: { id: string } }>(
    '/sections/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.sectionDiscount.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Discount not found in your active company' } })
      await prisma.sectionDiscount.delete({ where: { id: req.params.id } })
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
