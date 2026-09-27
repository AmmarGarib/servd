import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { listOrders, getOrder, updateOrderStatus, updateItemStatus, cancelOrder, completionDoor } from './service.js'
import { assertConceptAccess, filterConceptIdsForStaff } from '../../lib/conceptAccess.js'
import { conceptWhere, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

// Orders are brand-anchored (Order.conceptId) and a brand belongs to one
// company, so "is this order mine?" is always answered through the concept.
// `assertConceptAccess` is a per-user brand whitelist that NO-OPs for every
// management role — it is not a company check. Every handler below scopes
// the lookup itself, before touching a client-supplied id.
//
// There is no POST /orders. Every channel creates orders through ingestOrder
// (the till via /pos/orders, the storefront, group orders, WhatsApp); a staff
// "manual intake" here used to skip the till's discount caps, service charge
// and idempotency, and could book a paid Payment on no shift.

/**
 * `where` fragment: the order's brand belongs to a company in scope for
 * `mode` — 'read' is view-aware (portfolio expands), 'write' is every
 * company the operator belongs to. Foreign ids simply don't match → 404.
 */
async function orderInCompany(req: FastifyRequest, mode: ScopeMode) {
  return { concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) } }
}

// Kitchen / service progress only. Cancelling is POST /orders/:id/cancel — it
// needs a manager, a reason and an audit entry, none of which this route asks
// for (it used to accept 'cancelled' from any staff role with no reason).
// Refunding is POST /pos/orders/:orderId/refund, the one refund engine — this
// route used to accept 'refunded' from ANY staff token, with no reason, no
// caps, no audit and no money moving.
const updateOrderStatusSchema = z.object({
  status: z.enum(['received', 'confirmed', 'preparing', 'ready', 'completed']),
})

const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Reason is required').max(500),
})

// Kitchen moves only. Voiding a line is POST /pos/orders/:orderId/void — it
// enforces the void caps and manager PIN at /configuration/refund-policy,
// requires a reason and is audited; this route used to accept 'voided' from
// any staff role with none of that.
const updateItemStatusSchema = z.object({
  status: z.enum(['pending', 'preparing', 'ready', 'bumped', 'held', 'recalled']),
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
    // Company scope first: a client conceptId must be a brand the operator
    // can see (404 otherwise — never confirm a foreign brand exists); absent
    // → every brand in view (portfolio-aware).
    const owned = await conceptWhere(req, conceptId, 'read')
    const tenantConceptIds = typeof owned.conceptId === 'string' ? [owned.conceptId] : owned.conceptId.in
    // Then the per-user brand whitelist (no-op for management roles).
    const scopedConceptIds = await filterConceptIdsForStaff(
      req.staffUser!,
      conceptId ? [conceptId] : null,
    )
    const finalConceptIds = scopedConceptIds
      ? scopedConceptIds.filter((id) => tenantConceptIds.includes(id))
      : tenantConceptIds
    // Empty scope → empty page. listOrders also refuses to run unscoped, but
    // there's no reason to hit the DB for it.
    if (finalConceptIds.length === 0) return { data: [], cursor: null, hasMore: false }
    return listOrders({
      ...rest,
      conceptIds: finalConceptIds,
      limit: limit ? parseInt(limit, 10) : undefined,
    })
  })

  // GET /orders/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Company-scoped at the lookup itself — a foreign id 404s without the
      // row ever being fetched.
      const order = await getOrder(req.params.id, await orderInCompany(req, 'read'))
      await assertConceptAccess(req.staffUser!, order.conceptId)
      return order
    },
  )

  // GET /orders/curbside — active curbside queue. Cars-here-first, then
  // cars-still-coming. Powers the admin /orders/curbside dashboard.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/curbside',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId } = req.query
      // Company scope through the brand: a client conceptId must be ours
      // (404 otherwise); absent → every brand in view.
      const brand = await conceptWhere(req, conceptId, 'read')
      if (conceptId) await assertConceptAccess(req.staffUser!, conceptId)

      const orders = await prisma.order.findMany({
        where: {
          ...brand,
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
      // Lookup is scoped by company — assertConceptAccess alone bypasses the
      // concept ACL for management-tier roles, which would otherwise let a
      // manager in company A mutate orders in company B.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, curbsideVehicle: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
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
      // Company-scoped lookup FIRST — never fetch (or reveal the existence of)
      // an order outside the caller's companies before the scope check.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, source: true, fulfilmentType: true, rawPayload: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      await assertConceptAccess(req.staffUser!, order.conceptId)
      // Completion has one door per kind of order (decision 8). A staff
      // "Complete" here is only the expo hand-off door (pickup / dine-in
      // ordered online); it can't complete a delivery before the drop-off or
      // a till sale before it is paid.
      if (status === 'completed') {
        const door = completionDoor(order)
        if (door === 'delivery') {
          throw new AppError('COMPLETE_ON_DELIVERY', 'A delivery completes when the rider marks it delivered (or the customer\'s OTP is verified) — use Dispatch.', 409)
        }
        if (door === 'payment') {
          throw new AppError('COMPLETE_ON_PAYMENT', 'A till sale completes when it is paid at the till.', 409)
        }
      }
      return updateOrderStatus(req.params.id, status, {
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        via: 'status_update',
      })
    },
  )

  // POST /orders/:id/cancel — the staff cancel. Managers only, reason required,
  // audited; goes through cancelOrder like every other way an order can end
  // without a sale (expo reject, refused-at-door, the auto-cancel sweep).
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { reason } = cancelOrderSchema.parse(req.body)
      // Company-scoped lookup first — a foreign order 404s before anything
      // is read, cancelled or audited.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      const updated = await cancelOrder(order.id, {
        reason,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        metadata: { ip: req.ip },
      })
      return reply.send({ ok: true, order: updated })
    },
  )

  // PATCH /orders/:id/notes — add/update an admin note on an order
  fastify.patch<{ Params: { id: string }; Body: { notes: string } }>(
    '/:id/notes',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { notes } = z.object({ notes: z.string().max(1000) }).parse(req.body)
      // Company-scoped lookup — see /curbside/running-out for the rationale.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      return prisma.order.update({ where: { id: req.params.id }, data: { deliveryNotes: notes }, select: { id: true, deliveryNotes: true } })
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
      // Company-scoped — assertConceptAccess bypasses for management roles.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, customerId: true, totalCents: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
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

      await audit({ category: 'identity',
        action: 'order.cod_unpaid', entity: 'Order', entityId: order.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
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
      // Company-scoped — assertConceptAccess bypasses for management roles, so
      // the lookup itself must enforce the company boundary.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, customerId: true, totalCents: true, status: true },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      if (!order.customerId) {
        return reply.status(422).send({ error: { code: 'NO_CUSTOMER', message: 'Refused-at-door strike requires a linked customer.' } })
      }
      // Only an order still in service can be refused. This used to overwrite
      // ANY status with 'cancelled' — a completed sale kept its revenue and
      // journal entry while showing as cancelled (and was stamped completedAt
      // as it went). A completed order that comes back is a refund.
      if (!['received', 'confirmed', 'preparing', 'ready'].includes(order.status)) {
        throw new AppError(
          'ORDER_NOT_IN_SERVICE',
          order.status === 'completed'
            ? 'This order is already completed — refund it instead of marking it refused.'
            : `This order is already ${order.status}.`,
          409,
        )
      }

      // Cancel through the one cancel path — the food's already cooked, so
      // there is no revenue to book, and whatever the customer paid with
      // wallet or gift card is given back.
      const severity = order.totalCents >= 500_000 ? 2 : 1
      const reason = body.reason?.trim() || 'Customer refused order at the door.'
      await cancelOrder(order.id, {
        reason,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        action: 'order.refused_at_door',
        metadata: { severity, totalCents: order.totalCents },
      })

      const { recordStrike } = await import('../../lib/strikes.js')
      await recordStrike({
        customerId: order.customerId,
        kind: 'cod_refused',
        sourceType: 'order',
        sourceId: order.id,
        severity,
        reason,
        recordedById: req.staffUser?.id,
      })
      return { ok: true, severity }
    },
  )

  // There is no POST /orders/:id/refund. Refunds go through the ONE refund
  // engine, POST /pos/orders/:orderId/refund (refundOrder in pos/service.ts):
  // refund-policy caps and the manager PIN, partial amounts, the money on the
  // drawer it leaves (owner decision 3), its own journal entry, the SRB
  // sales-return, and — once refunded in full — status 'refunded' with the
  // customer-side restores and the credit note. This route flipped the status
  // with none of the money side, so a till refund never reached the books.
}

// Separate route prefix for order items
export async function orderItemRoutes(fastify: FastifyInstance) {
  // PATCH /order-items/:id/status — bump/hold/recall/fire (never void — see schema)
  // Concept access is enforced: a cashier scoped to concept A cannot mutate
  // ticket state for items in concept B by guessing/scraping the item id.
  fastify.patch<{ Params: { id: string } }>(
    '/:id/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { status } = updateItemStatusSchema.parse(req.body)
      const { prisma } = await import('../../lib/prisma.js')
      // Company scope reached through order → concept.
      const item = await prisma.orderItem.findFirst({
        where: { id: req.params.id, order: await orderInCompany(req, 'write') },
        select: { order: { select: { conceptId: true } } },
      })
      if (!item) throw new NotFoundError('OrderItem', req.params.id)
      await assertConceptAccess(req.staffUser!, item.order.conceptId)
      return updateItemStatus(req.params.id, status, req.staffUser?.id)
    },
  )

  // PATCH /order-items/:id/bump-photo — attach plating photo URL after bump
  fastify.patch<{ Params: { id: string }; Body: { url: string } }>(
    '/:id/bump-photo',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { url } = z.object({ url: z.string().url() }).parse(req.body)
      const { prisma } = await import('../../lib/prisma.js')
      // Company scope reached through order → concept.
      const item = await prisma.orderItem.findFirst({
        where: { id: req.params.id, order: await orderInCompany(req, 'write') },
        select: { order: { select: { conceptId: true } } },
      })
      if (!item) throw new NotFoundError('OrderItem', req.params.id)
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
      // Verify the order belongs to one of the operator's companies before firing.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true },
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
        where: { id: req.params.id, ...(await orderInCompany(req, 'read')) },
        select: { id: true },
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
