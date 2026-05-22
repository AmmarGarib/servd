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

  // GET /expo/queue — everything expo needs in one round-trip:
  //   • awaitingFire — `received` (not yet confirmed); each row has the
  //     fulfilmentType so expo knows what they're committing to.
  //   • inProgress   — `preparing`; each item carries its step counters
  //     (done/total) so expo sees a per-order progress like 3/5, 4/5.
  //   • ready        — `ready`; expo's "Served / Dispatch / Picked up"
  //     button lives here, copy switches by fulfilmentType.
  //   • stations     — live load per station (already on the right sidebar).
  fastify.get(
    '/queue',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantFilter
      const conceptScope = { tenantId, deletedAt: null }
      const orderInclude = {
        concept:  { select: { id: true, name: true, slug: true } },
        customer: { select: { id: true, name: true, phone: true } },
        table:    { select: { id: true, label: true } },
        rider:    { select: { id: true, name: true, phone: true } },
        items: {
          select: {
            id: true, name: true, quantity: true, notes: true, status: true,
            steps: { select: { id: true, status: true } },
          },
        },
      } as const

      const [awaitingFire, inProgress, ready, stations] = await Promise.all([
        prisma.order.findMany({
          where: { status: 'received', concept: conceptScope, deletedAt: null },
          include: orderInclude,
          orderBy: { placedAt: 'asc' },
          take: 50,
        }),
        prisma.order.findMany({
          where: { status: { in: ['confirmed', 'preparing'] }, concept: conceptScope, deletedAt: null },
          include: orderInclude,
          orderBy: { placedAt: 'asc' },
          take: 80,
        }),
        prisma.order.findMany({
          where: { status: 'ready', concept: conceptScope, deletedAt: null },
          include: orderInclude,
          orderBy: { placedAt: 'asc' },
          take: 40,
        }),
        prisma.station.findMany({
          where: { concept: conceptScope, isActive: true },
          select: {
            id: true, name: true,
            concept: { select: { slug: true } },
            _count: { select: { orderItems: { where: { status: { in: ['pending', 'preparing'] } } } } },
          },
          orderBy: { displayOrder: 'asc' },
        }),
      ])

      // Per-order step roll-up: counts steps across all items + a "current
      // station" string for the inProgress row. Items without recipe steps
      // contribute 1 implicit step each (legacy routing).
      function summarise(order: typeof inProgress[number]) {
        let totalSteps = 0
        let doneSteps  = 0
        const activeStations = new Set<string>()
        for (const it of order.items) {
          if (it.steps.length > 0) {
            totalSteps += it.steps.length
            for (const s of it.steps) {
              if (s.status === 'done' || s.status === 'voided') doneSteps++
              if (s.status === 'preparing') {
                // Pull the station name from the existing /stations cache below.
              }
            }
          } else {
            // Legacy item: treat as 1 step; complete when item is bumped.
            totalSteps += 1
            if (it.status === 'bumped' || it.status === 'voided') doneSteps += 1
          }
        }
        return { totalSteps, doneSteps, activeStations: Array.from(activeStations) }
      }

      return {
        awaitingFire: awaitingFire.map((o) => ({ ...o, ...summarise(o) })),
        inProgress:   inProgress.map((o)   => ({ ...o, ...summarise(o) })),
        ready:        ready.map((o)        => ({ ...o, ...summarise(o) })),
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
      const tenantId = req.staffUser!.tenantFilter
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

      // Per-item: two flows.
      //
      //   Step flow (item has recipe steps)
      //     Instantiate OrderItemStep rows; deps-clear ones start preparing,
      //     the rest sit waiting until cascade fires them. Each preparing
      //     step's station gets a socket event.
      //
      //   Legacy flow (item has no recipe steps yet)
      //     Flip the item to `preparing`, set firedAt, and ping its station
      //     so the line cook sees it land. Without this the item stayed at
      //     `pending` and nothing rendered on the per-station KDS — looked
      //     like fire was broken even though the order header advanced.
      //
      // Items with neither recipe steps NOR a stationId (menu item never got
      // routed in /menu) end up tracked but unrouted — surfaced back to the
      // operator below so they know why "nothing happened".
      const ws = getIOSafe()
      const now = new Date()
      const unroutedItems: Array<{ id: string; name: string }> = []
      for (const item of order.items) {
        const steps = item.menuItem?.recipe?.recipeSteps ?? []
        const serviceSteps = steps.filter((s) => s.phase === 'service_cook' || s.phase === 'service_assemble')

        if (serviceSteps.length > 0) {
          // ─── Step flow ────────────────────────────────────────────────
          await prisma.orderItem.update({
            where: { id: item.id },
            data: { status: 'preparing', firedAt: now },
          })
          await prisma.orderItemStep.createMany({
            data: serviceSteps.map((s) => ({
              orderItemId:      item.id,
              recipeStepId:     s.id,
              stationId:        s.stationId,
              dependsOnStepIds: s.dependsOnIds,
              status:           s.dependsOnIds.length === 0 ? 'preparing' : 'waiting',
              firedAt:          s.dependsOnIds.length === 0 ? now : null,
            })),
          })
          const firstSteps = serviceSteps.filter((s) => s.dependsOnIds.length === 0)
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
        } else {
          // ─── Legacy flow ──────────────────────────────────────────────
          await prisma.orderItem.update({
            where: { id: item.id },
            data: { status: 'preparing', firedAt: now },
          })
          if (item.stationId && ws) {
            ws.to(`station:${item.stationId}`).emit('expo:fire', {
              orderId:    order.id,
              itemId:     item.id,
              stepId:     null,
              stationId:  item.stationId,
              instruction: item.name,
              estimatedSeconds: null,
            })
          } else if (!item.stationId) {
            unroutedItems.push({ id: item.id, name: item.name })
          }
        }
      }

      // Soft warning back to the caller. The order DID fire (status flipped,
      // legacy items are now preparing), but these specific items have no
      // station so the line will never see them. Operator should fix the
      // menu items' station assignment.
      if (unroutedItems.length > 0) {
        req.log.warn({ orderId: order.id, unroutedItems }, 'expo.fire: items have no station — fix in /menu')
      }

      // Audit trail picks up `expo.fire` events with the note for context.
      if (body.note) {
        try {
          const { audit } = await import('../../lib/audit.js')
          await audit({
            userId:   req.staffUser!.id,
            entity:   'Order',
            entityId: order.id,
            action:   'expo.fire',
            metadata: { note: body.note },
          })
        } catch {
          // Audit failures are non-fatal — we'd rather lose the breadcrumb than
          // block the kitchen.
        }
      }

      return reply.status(200).send({
        ok: true,
        fired: order.items.length,
        unroutedItems,   // empty array unless some items had no station
      })
    },
  )

  // GET /expo/station/:stationId/queue — what does this station currently
  // need to cook? Unions two things so the migration to step-routing can
  // be gradual:
  //
  //   1. New flow: active OrderItemSteps fired to this station.
  //   2. Legacy:   OrderItems whose `stationId` is this and status is still
  //                pending/preparing (no recipe steps configured yet).
  //
  // Each entry carries enough order context for the KDS card to render.
  fastify.get<{ Params: { stationId: string } }>(
    '/station/:stationId/queue',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantFilter
      const stationId = req.params.stationId

      const steps = await prisma.orderItemStep.findMany({
        where: {
          stationId,
          status: { in: ['preparing', 'waiting'] },        // surface waiting too so the cook can see what's coming
          orderItem: { order: { concept: { tenantId } } },
        },
        include: {
          recipeStep: { select: { instruction: true, instructionUrdu: true, phase: true, estimatedSeconds: true } },
          orderItem:  {
            include: {
              order: {
                select: {
                  id: true, customerName: true, source: true, placedAt: true,
                  fulfilmentType: true,
                  concept: { select: { name: true, slug: true } },
                  customer: { select: { name: true } },
                  table:    { select: { label: true } },
                },
              },
            },
          },
        },
        orderBy: { firedAt: 'asc' },
      })

      const legacy = await prisma.orderItem.findMany({
        where: {
          stationId,
          status: { in: ['pending', 'preparing'] },
          order: { concept: { tenantId } },
          // Skip items that already have OrderItemStep rows — those are
          // routed through the step engine, no double-counting.
          steps: { none: {} },
        },
        include: {
          order: {
            select: {
              id: true, customerName: true, source: true, placedAt: true,
              fulfilmentType: true,
              concept: { select: { name: true, slug: true } },
              customer: { select: { name: true } },
              table:    { select: { label: true } },
            },
          },
        },
        orderBy: { firedAt: 'asc' },
      })

      return {
        steps: steps.map((s) => ({
          stepId:           s.id,
          itemId:           s.orderItemId,
          // MenuItem id is what /recipes/by-item/:id keys on — the expandable
          // instruction panel on the card needs it to fetch the recipe.
          menuItemId:       s.orderItem.menuItemId,
          itemName:         s.orderItem.name,
          qty:              s.orderItem.quantity,
          itemNotes:        s.orderItem.notes,
          status:           s.status,
          firedAt:          s.firedAt,
          instruction:      s.recipeStep.instruction,
          instructionUrdu:  s.recipeStep.instructionUrdu,
          phase:            s.recipeStep.phase,
          estimatedSeconds: s.recipeStep.estimatedSeconds,
          order: {
            id:             s.orderItem.order.id,
            customerName:   s.orderItem.order.customer?.name ?? s.orderItem.order.customerName,
            source:         s.orderItem.order.source,
            placedAt:       s.orderItem.order.placedAt,
            fulfilmentType: s.orderItem.order.fulfilmentType,
            tableLabel:     s.orderItem.order.table?.label ?? null,
            concept:        s.orderItem.order.concept,
          },
        })),
        legacy: legacy.map((it) => ({
          itemId:    it.id,
          menuItemId: it.menuItemId,
          itemName:  it.name,
          qty:       it.quantity,
          itemNotes: it.notes,
          status:    it.status,
          firedAt:   it.firedAt,
          order: {
            id:             it.order.id,
            customerName:   it.order.customer?.name ?? it.order.customerName,
            source:         it.order.source,
            placedAt:       it.order.placedAt,
            fulfilmentType: it.order.fulfilmentType,
            tableLabel:     it.order.table?.label ?? null,
            concept:        it.order.concept,
          },
        })),
      }
    },
  )

  // POST /expo/steps/:id/bump — a station confirms its step. The cascade
  // engine flips this step to `done`, promotes any newly-eligible
  // dependants to `preparing`, and emits expo:fire to their stations.
  fastify.post<{ Params: { id: string } }>(
    '/steps/:id/bump',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req, reply) => {
      const { bumpStep, broadcastCascade } = await import('./stepCascade.js')
      const step = await prisma.orderItemStep.findUnique({
        where: { id: req.params.id },
        include: { orderItem: { include: { order: { include: { concept: true } } } } },
      })
      if (!step) throw new NotFoundError('OrderItemStep', req.params.id)
      // Cross-tenant guard — a cook on the Bukhari tenant can't bump a step
      // on a Clifton order even if they guessed the ID.
      if (step.orderItem.order.concept.tenantId !== req.staffUser!.tenantId) {
        return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Not your tenant' } })
      }

      const result = await bumpStep(req.params.id, req.staffUser!.id)
      broadcastCascade(result, step.orderItemId)

      // Item-level completion: if the cascade closed out the last step on
      // the item, route through updateItemStatus so the existing order-
      // complete + financial-entry side-effects fire.
      if (result.itemBumped && step.orderItem.status !== 'bumped') {
        const { updateItemStatus } = await import('../orders/service.js')
        try {
          await updateItemStatus(step.orderItemId, 'bumped', req.staffUser!.id)
        } catch (e) {
          // State-machine may reject if the item already moved — that's fine.
          if ((e as { code?: string })?.code !== 'INVALID_TRANSITION') throw e
        }
      }

      return reply.status(200).send(result)
    },
  )

  // POST /expo/orders/:id/handoff — expo signs off a `ready` order to the
  // next stage of the journey. Copy on the front-end button switches by
  // fulfilmentType, but the server action is the same: flip to completed
  // (server takes to table / customer collects at counter / rider takes the
  // delivery). For deliveries we also stamp the order with a hand-off
  // timestamp so the dispatch queue can pick it up.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/handoff',
    { preHandler: requireAuthOrPin(...ALL_STAFF) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantFilter
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, concept: { tenantId, deletedAt: null }, deletedAt: null },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      // Only `ready` orders can be handed off. If expo presses too early,
      // the state machine refuses with a clear 409 — better than completing
      // an order with un-bumped items.
      if (order.status !== 'ready') {
        throw new AppError(
          'NOT_READY',
          `Order is ${order.status} — wait for the kitchen to finish before handing off.`,
          409,
        )
      }
      const { updateOrderStatus } = await import('../orders/service.js')
      await updateOrderStatus(req.params.id, 'completed')
      try {
        const { audit } = await import('../../lib/audit.js')
        await audit({
          userId:   req.staffUser!.id,
          entity:   'Order',
          entityId: order.id,
          action:   'expo.handoff',
          metadata: { fulfilmentType: order.fulfilmentType },
        })
      } catch { /* */ }
      return reply.status(200).send({ ok: true, fulfilmentType: order.fulfilmentType })
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
      const tenantId = req.staffUser!.tenantFilter
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
          userId:   req.staffUser!.id,
          entity:   'Order',
          entityId: order.id,
          action:   'expo.reject',
          metadata: { reason: body.reason },
        })
      } catch { /* */ }
      return reply.status(200).send({ ok: true })
    },
  )
}
