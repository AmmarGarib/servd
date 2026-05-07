import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { ingestOrder, listOrders, getOrder, updateOrderStatus, updateItemStatus } from './service.js'
import { assertConceptAccess, filterConceptIdsForStaff } from '../../lib/conceptAccess.js'
import { audit } from '../../lib/audit.js'
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
