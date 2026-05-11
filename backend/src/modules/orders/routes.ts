import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { ingestOrder, listOrders, getOrder, updateOrderStatus, updateItemStatus } from './service.js'
import { assertConceptAccess, filterConceptIdsForStaff } from '../../lib/conceptAccess.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'
import type { OrderDTO } from '@servd/types'

const createOrderSchema = z.object({
  source: z.enum(['servd', 'foodpanda', 'pos', 'cart', 'manual']),
  external_id: z.string().default(() => `manual-${Date.now()}`),
  concept_id: z.string().uuid(),
  placed_at: z.string().datetime().default(() => new Date().toISOString()),
  customer_id: z.string().uuid().nullable().default(null),
  customer_name: z.string().nullable().default(null),
  table_id: z.string().uuid().nullable().optional(),
  pos_staff_id: z.string().uuid().nullable().optional(),
  shift_id: z.string().uuid().nullable().optional(),
  items: z.array(
    z.object({
      externalItemId: z.string().default('manual'),
      menuItemId: z.string().uuid().nullable().default(null),
      name: z.string(),
      quantity: z.number().int().min(1),
      unitPriceCents: z.number().int().min(0),
      modifiers: z
        .array(z.object({ name: z.string(), priceDeltaCents: z.number().int() }))
        .default([]),
      notes: z.string().optional(),
      course: z.number().int().optional(),
    }),
  ),
  payment: z.object({
    provider: z.enum(['keenu', 'jazzcash', 'easypaisa', 'platform', 'cash']).nullable().default(null),
    amountCents: z.number().int().min(0),
    status: z.enum(['paid', 'pending', 'refunded']).default('pending'),
  }),
  loyalty_points_earned: z.number().nullable().default(null),
  delivery_notes: z.string().nullable().default(null),
  estimated_pickup: z.string().datetime().nullable().default(null),
})

const updateOrderStatusSchema = z.object({
  status: z.enum(['received', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled', 'refunded']),
})

const updateItemStatusSchema = z.object({
  status: z.enum(['pending', 'preparing', 'ready', 'bumped', 'held', 'recalled', 'voided']),
})

export async function orderRoutes(fastify: FastifyInstance) {
  // GET /orders
  fastify.get<{
    Querystring: {
      conceptId?: string
      source?: string
      status?: string
      dateFrom?: string
      dateTo?: string
      cursor?: string
      limit?: string
    }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { limit, conceptId, ...rest } = req.query
    const scopedConceptIds = await filterConceptIdsForStaff(
      req.staffUser!,
      conceptId ? [conceptId] : null,
    )
    // Tenant scope: intersect the staff's allowed concepts with concepts
    // belonging to the active tenant. Falls back to *only* tenant concepts
    // when the staff has no per-concept restriction (admin/manager bypass).
    const tenantConcepts = await prisma.concept.findMany({
      where: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      select: { id: true },
    })
    const tenantConceptIds = tenantConcepts.map((c) => c.id)
    const finalConceptIds = scopedConceptIds
      ? scopedConceptIds.filter((id) => tenantConceptIds.includes(id))
      : tenantConceptIds
    return listOrders({
      ...rest,
      conceptId: conceptId && tenantConceptIds.includes(conceptId) ? conceptId : undefined,
      conceptIds: finalConceptIds,
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  })

  // GET /orders/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const order = await getOrder(req.params.id)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      // Verify the order's concept is within the active tenant.
      const concept = await prisma.concept.findFirst({
        where: { id: order.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
      })
      if (!concept) {
        const { NotFoundError } = await import('../../lib/errors.js')
        throw new NotFoundError('Order', req.params.id)
      }
      return order
    },
  )

  // POST /orders — manual order creation
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const dto = createOrderSchema.parse(req.body) as OrderDTO
    await assertConceptAccess(req.staffUser!, dto.concept_id)
    // Verify concept belongs to active tenant before ingesting.
    const concept = await prisma.concept.findFirst({
      where: { id: dto.concept_id, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const result = await ingestOrder(dto)
    return reply.status(result.created ? 201 : 200).send(result.order)
  })

  // GET /orders/curbside — active curbside queue. Cars-here-first, then
  // cars-still-coming. Powers the admin /orders/curbside dashboard.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/curbside',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId } = req.query
      if (conceptId) await assertConceptAccess(req.staffUser!, conceptId)

      const orders = await prisma.order.findMany({
        where: {
          ...(conceptId && { conceptId }),
          // Tenant scope: through Concept relation
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
          curbsideVehicle: { not: null },
          // Hide ones we already finished
          curbsideRunnerOutAt: null,
          status: { notIn: ['cancelled', 'refunded'] },
          // Created in the last 12 hours (don't load ancient stale rows)
          placedAt: { gte: new Date(Date.now() - 12 * 3_600_000) },
        },
        orderBy: [
          // arrived first, sorted by arrival time
          { curbsideArrivedAt: 'asc' },
          // then en-route, sorted by placement
          { placedAt: 'asc' },
        ],
        select: {
          id: true, status: true, totalCents: true, placedAt: true,
          customerName: true,
          curbsideVehicle: true, curbsidePlate: true, curbsideSpot: true,
          curbsideArrivedAt: true,
          concept: { select: { name: true, slug: true } },
        },
      })

      return {
        arrived:  orders.filter((o) => o.curbsideArrivedAt != null),
        enRoute:  orders.filter((o) => o.curbsideArrivedAt == null),
      }
    },
  )

  // POST /orders/:id/curbside/running-out — staff hits this when a runner
  // grabs the bag and heads to the car. Stamps curbsideRunnerOutAt so the
  // order drops off the curbside queue.
  fastify.post<{ Params: { id: string } }>(
    '/:id/curbside/running-out',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, conceptId: true, curbsideVehicle: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404)
      if (!order.curbsideVehicle) throw new AppError('NOT_CURBSIDE', 'Order is not a curbside order', 422)
      await assertConceptAccess(req.staffUser!, order.conceptId)

      return prisma.order.update({
        where: { id: order.id },
        data: { curbsideRunnerOutAt: new Date() },
      })
    },
  )

  // PATCH /orders/:id/status
  fastify.patch<{ Params: { id: string } }>(
    '/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { status } = updateOrderStatusSchema.parse(req.body)
      const order = await getOrder(req.params.id)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      const concept = await prisma.concept.findFirst({
        where: { id: order.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
      })
      if (!concept) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      return updateOrderStatus(req.params.id, status as never)
    },
  )

  // ─── Naughty list triggers ──────────────────────────────────────────────
  // POST /orders/:id/cod-unpaid — staff/cashier marks a cash-on-delivery
  // order as never paid (driver came back with food OR cash never collected).
  // Records a strike + appends a note.
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cod-unpaid',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {})
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, conceptId: true, customerId: true, totalCents: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      if (!order.customerId) {
        return reply.status(422).send({ error: { code: 'NO_CUSTOMER', message: 'Cash-unpaid strike requires a linked customer.' } })
      }

      const { recordStrike } = await import('../../lib/strikes.js')
      // High-value orders sting more — sev=2 means 2 incidents → ban.
      const severity = order.totalCents >= 500_000 /* PKR 5,000+ */ ? 2 : 1
      await recordStrike({
        customerId: order.customerId,
        kind: 'cod_unpaid',
        sourceType: 'order',
        sourceId: order.id,
        severity,
        reason: body.reason ?? 'Cash on delivery — not paid',
        recordedById: req.staffUser?.id,
      })

      await audit({
        action: 'order.cod_unpaid', entity: 'Order', entityId: order.id,
        userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
        metadata: { reason: body.reason, severity, totalCents: order.totalCents },
      })
      return { ok: true, severity }
    },
  )

  // POST /orders/:id/refused-at-door — driver/staff marks a delivery as
  // refused on arrival. Order goes to 'cancelled' (food was prepared but
  // refused), and the customer gets a strike. Optional `reason` captures
  // what the driver was told ("looked rude", "different person at door", etc.)
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/refused-at-door',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {})
      const order = await prisma.order.findUnique({
        where: { id: req.params.id },
        select: { id: true, conceptId: true, customerId: true, totalCents: true, status: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      if (!order.customerId) {
        return reply.status(422).send({ error: { code: 'NO_CUSTOMER', message: 'Refused-at-door strike requires a linked customer.' } })
      }

      // Flip order to cancelled with reason — the food's already cooked, so
      // accounting still records the COGS hit but no revenue.
      await prisma.order.update({
        where: { id: order.id },
        data: { status: 'cancelled', completedAt: new Date() },
      })

      const { recordStrike } = await import('../../lib/strikes.js')
      const severity = order.totalCents >= 500_000 ? 2 : 1
      await recordStrike({
        customerId: order.customerId,
        kind: 'cod_refused',
        sourceType: 'order',
        sourceId: order.id,
        severity,
        reason: body.reason ?? 'Customer refused order at the door.',
        recordedById: req.staffUser?.id,
      })

      await audit({
        action: 'order.refused_at_door', entity: 'Order', entityId: order.id,
        userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
        metadata: { reason: body.reason, severity, totalCents: order.totalCents },
      })
      return { ok: true, severity }
    },
  )

  // POST /orders/:id/refund — manager-only refund flow with mandatory reason.
  // Wraps the status change so we always have a reason captured in the audit
  // log. Use this from the admin UI; never auto-refund.
  fastify.post<{ Params: { id: string }; Body: { reason: string; mode?: 'refund' | 'cancel' } }>(
    '/:id/refund',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        reason: z.string().min(3, 'Reason is required').max(500),
        mode:   z.enum(['refund', 'cancel']).default('refund'),
      }).parse(req.body)
      const order = await getOrder(req.params.id)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      const concept = await prisma.concept.findFirst({
        where: { id: order.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
      })
      if (!concept) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })

      const targetStatus = body.mode === 'cancel' ? 'cancelled' : 'refunded'
      const updated = await updateOrderStatus(req.params.id, targetStatus as never)

      await audit({
        action: `order.${body.mode}`,
        entity: 'Order',
        entityId: order.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        before: { status: order.status, totalCents: order.totalCents },
        after:  { status: targetStatus },
        metadata: { reason: body.reason, ip: req.ip, conceptSlug: order.conceptId },
      })

      return reply.send({ ok: true, order: updated })
    },
  )
}

// Separate route prefix for order items
export async function orderItemRoutes(fastify: FastifyInstance) {
  // PATCH /order-items/:id/status — bump/hold/recall/fire
  // Concept access is enforced: a cashier scoped to concept A cannot mutate
  // ticket state for items in concept B by guessing/scraping the item id.
  fastify.patch<{ Params: { id: string } }>(
    '/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { status } = updateItemStatusSchema.parse(req.body)
      const { prisma } = await import('../../lib/prisma.js')
      const item = await prisma.orderItem.findFirst({
        where: {
          id: req.params.id,
          order: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
        },
        select: { order: { select: { conceptId: true } } },
      })
      if (!item) {
        const { NotFoundError } = await import('../../lib/errors.js')
        throw new NotFoundError('OrderItem', req.params.id)
      }
      await assertConceptAccess(req.staffUser!, item.order.conceptId)
      return updateItemStatus(req.params.id, status as never, req.staffUser?.id)
    },
  )

  // PATCH /order-items/:id/bump-photo — attach plating photo URL after bump
  fastify.patch<{ Params: { id: string }; Body: { url: string } }>(
    '/:id/bump-photo',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { url } = z.object({ url: z.string().url() }).parse(req.body)
      const { prisma } = await import('../../lib/prisma.js')
      const item = await prisma.orderItem.findFirst({
        where: {
          id: req.params.id,
          order: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
        },
        select: { order: { select: { conceptId: true } } },
      })
      if (!item) {
        const { NotFoundError } = await import('../../lib/errors.js')
        throw new NotFoundError('OrderItem', req.params.id)
      }
      await assertConceptAccess(req.staffUser!, item.order.conceptId)
      await prisma.orderItem.update({
        where: { id: req.params.id },
        data: { bumpPhotoUrl: url },
      })
      return reply.send({ ok: true })
    },
  )
}

// Course management — fire the next course on an order. Items with course=N
// flip from 'pending' to 'preparing'; items with course>N stay pending until
// the course before them is fully bumped.
export async function orderCourseRoutes(fastify: FastifyInstance) {
  // POST /orders/:id/fire-course — body: { course: 2 } fires items at course 2.
  fastify.post<{ Params: { id: string }; Body: { course: number } }>(
    '/:id/fire-course',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { course } = z.object({ course: z.number().int().min(1).max(20) }).parse(req.body)
      const { prisma } = await import('../../lib/prisma.js')
      // Verify order belongs to active tenant before firing.
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const items = await prisma.orderItem.findMany({
        where: { orderId: req.params.id, course, status: 'pending' },
        select: { id: true },
      })
      if (items.length === 0) {
        return reply.status(404).send({ error: { code: 'NO_ITEMS', message: `No pending items at course ${course}` } })
      }
      await prisma.orderItem.updateMany({
        where: { id: { in: items.map((i) => i.id) } },
        data:  { status: 'preparing', firedAt: new Date() },
      })
      return reply.send({ ok: true, fired: items.length, course })
    },
  )

  // GET /orders/:id/courses — summary of items per course + their status
  fastify.get<{ Params: { id: string } }>(
    '/:id/courses',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { prisma } = await import('../../lib/prisma.js')
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const items = await prisma.orderItem.findMany({
        where: { orderId: req.params.id },
        select: { id: true, name: true, quantity: true, course: true, status: true, firedAt: true, completedAt: true },
        orderBy: [{ course: 'asc' }, { name: 'asc' }],
      })
      // Group by course
      const map = new Map<number, typeof items>()
      for (const it of items) {
        const c = it.course ?? 1
        const arr = map.get(c) ?? ([] as typeof items)
        arr.push(it)
        map.set(c, arr)
      }
      return Array.from(map.entries()).map(([course, list]) => {
        const allBumped = list.every((i) => ['bumped', 'voided'].includes(i.status))
        const anyFired  = list.some((i)  => i.firedAt !== null)
        return { course, items: list, fired: anyFired, complete: allBumped }
      })
    },
  )
}
