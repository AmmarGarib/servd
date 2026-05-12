// Expo routes — the kitchen pass-station's view of incoming work.
//
// Pre-confirm (status='received'): every new order sits here until the expo
// hits "Confirm & Fire". That triggers item dispatch to whichever station
// their recipe's first step says, marks the order `preparing`.
//
// Post-fire: items walk through their RecipeStep graph — when a step is
// bumped, its dependents fire. The whole thing is intentionally simple:
// we don't try to predict; we just notify when the deps clear.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, requireAuthOrPin, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { getIOSafe } from '../../lib/ws.js'

export async function expoRoutes(fastify: FastifyInstance) {

  // GET /expo/queue — orders waiting on expo + items currently routed to each
  // station + a lightweight master par sheet. One round-trip so the expo
  // screen renders without a flash of empty state.
  fastify.get(
    '/queue',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId

      // Incoming queue: anything `received` (not yet expo-confirmed) within
      // the operator's tenant. POS orders skip this list (cashier already
      // fired them at the counter); only delivery / storefront / external
      // sources need the expo gate.
      const queue = await prisma.order.findMany({
        where: {
          status: 'received',
          concept: { tenantId, deletedAt: null },
          deletedAt: null,
        },
        include: {
          concept: { select: { id: true, name: true, slug: true } },
          items:   { select: { id: true, name: true, quantity: true, notes: true, status: true } },
          customer:{ select: { id: true, name: true, phone: true } },
        },
        orderBy: { placedAt: 'asc' },
        take: 50,
      })

      // Live load per station: count of items currently `preparing` or `pending`
      // at each station, scoped to tenant. Cheap GROUP BY.
      const stations = await prisma.station.findMany({
        where: { concept: { tenantId, deletedAt: null }, isActive: true },
        select: {
          id: true, name: true,
          concept: { select: { slug: true } },
          _count: {
            select: {
              orderItems: {
                where: { status: { in: ['pending', 'preparing'] } },
              },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      })

      return {
        queue,
        stations: stations.map((s) => ({
          id:    s.id,
          name:  s.name,
          conceptSlug: s.concept.slug,
          activeItems: s._count.orderItems,
        })),
      }
    },
  )

  // POST /expo/orders/:id/fire — expo confirms an incoming order. Moves the
  // order from `received` → `preparing`, fires the first step of each item's
  // recipe to its station. If an item has no recipe steps configured (legacy
  // menu items), it lands on the item's `stationId` directly — same as the
  // pre-step behaviour.
  fastify.post<{ Params: { id: string }; Body: { note?: string } }>(
    '/orders/:id/fire',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId
      const body = z.object({ note: z.string().max(280).optional() }).parse(req.body ?? {})

      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId, deletedAt: null },
          deletedAt: null,
        },
        include: {
          items: {
            include: {
              menuItem: {
                include: { recipe: { include: { recipeSteps: true } } },
              },
            },
          },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      if (order.status !== 'received') {
        throw new AppError(
          'INVALID_TRANSITION',
          `Order is already ${order.status} — only 'received' orders can be fired`,
          409,
        )
      }

      // Use the existing state machine path so audit + WS events fire correctly.
      // updateOrderStatus enforces the legal transition.
      const { updateOrderStatus } = await import('../orders/service.js')
      await updateOrderStatus(req.params.id, 'preparing')

      // Per-item: route to the first ready step. "Ready" means
      // `dependsOnIds` is empty (no prerequisites). For items without a
      // recipe, fall back to the OrderItem.stationId set at order ingestion.
      const ws = getIOSafe()
      for (const item of order.items) {
        const steps = item.menuItem?.recipe?.recipeSteps ?? []
        const firstSteps = steps.filter((s) => s.phase === 'service_cook' && s.dependsOnIds.length === 0)
        if (firstSteps.length === 0) {
          // Legacy / no recipe steps — keep current routing.
          continue
        }
        // Mark item as preparing and broadcast to each starting station.
        await prisma.orderItem.update({
          where: { id: item.id },
          data: { status: 'preparing', firedAt: new Date() },
        })
        for (const step of firstSteps) {
          if (!step.stationId || !ws) continue
          ws.to(`station:${step.stationId}`).emit('expo:fire', {
            orderId:    order.id,
            itemId:     item.id,
            stepId:     step.id,
            stationId:  step.stationId,
            instruction: step.instruction,
            estimatedSeconds: step.estimatedSeconds,
          })
        }
      }

      // Audit trail picks up `expo.fire` events with the note for context.
      if (body.note) {
        try {
          const { audit } = await import('../../lib/audit.js')
          await audit({
            actorId: req.staffUser!.id,
            entity:  'Order',
            entityId: order.id,
            action:  'expo.fire',
            metadata: { note: body.note },
          })
        } catch {
          // Audit failures are non-fatal — we'd rather lose the breadcrumb than
          // block the kitchen.
        }
      }

      return reply.status(200).send({ ok: true, fired: order.items.length })
    },
  )

  // POST /expo/orders/:id/reject — expo declines an incoming order (out of
  // stock, blacklisted customer, etc.). Cancels the order; refund/notify
  // logic is downstream.
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/orders/:id/reject',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ reason: z.string().min(1).max(280) }).parse(req.body)
      const tenantId = req.staffUser!.tenantId
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId, deletedAt: null },
          deletedAt: null,
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      const { updateOrderStatus } = await import('../orders/service.js')
      await updateOrderStatus(req.params.id, 'rejected')
      try {
        const { audit } = await import('../../lib/audit.js')
        await audit({
          actorId: req.staffUser!.id,
          entity:  'Order',
          entityId: order.id,
          action:  'expo.reject',
          metadata: { reason: body.reason },
        })
      } catch { /* */ }
      return reply.status(200).send({ ok: true })
    },
  )
}
