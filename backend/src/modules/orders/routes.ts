import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { OrderStatus } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, CASHIERS, MANAGERS } from '../auth/middleware.js'
import { requireManagerApproval } from '../pos/service.js'
import { listOrders, getOrder, updateOrderStatus, updateItemStatus, cancelOrder, completionDoor, fireCourse, bumpPaidTillSale } from './service.js'
import { assertConceptAccess, filterConceptIdsForStaff } from '../../lib/conceptAccess.js'
import { conceptWhere, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { redactDeliveryOtp } from '../../lib/deliveryOtp.js'

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
//
// The customer's delivery hand-over code (deliveryOtp) is stripped from every
// order returned here unless the operator is admin / management: anyone who
// can read it can "deliver" without going to the door (lib/deliveryOtp.ts).

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
  // §17.4: a non-manager (cashier / server) cancels only with a manager PIN.
  managerOverridePin: z.string().min(4).max(8).optional(),
})

// Kitchen moves only. Voiding a line is POST /pos/orders/:orderId/void — it
// enforces the void caps and manager PIN at /configuration/refund-policy,
// requires a reason and is audited; this route used to accept 'voided' from
// any staff role with none of that.
const updateItemStatusSchema = z.object({
  status: z.enum(['pending', 'preparing', 'ready', 'bumped', 'held', 'recalled']),
})

const orderStatusSchema = z.nativeEnum(OrderStatus)

/**
 * `?status=` for GET /orders: one OrderStatus or a comma list of them
 * (blanks ignored). Absent / empty → no filter. Anything else → 400
 * VALIDATION_ERROR naming the allowed values.
 */
export function parseStatusFilter(raw: unknown): OrderStatus[] | null {
  if (raw == null || raw === '') return null
  // ?status=a&status=b arrives as an array — same as "a,b".
  if (Array.isArray(raw) && raw.every((r) => typeof r === 'string')) raw = raw.join(',')
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'status must be a single value or a comma-separated list', 400)
  }
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const bad = parts.filter((p) => !orderStatusSchema.safeParse(p).success)
  if (bad.length > 0) {
    const allowed = Object.values(OrderStatus)
    throw new AppError(
      'VALIDATION_ERROR',
      `Unknown order status: ${bad.join(', ')}. Allowed: ${allowed.join(', ')}`,
      400,
      { field: 'status', invalid: bad, allowed },
    )
  }
  return [...new Set(parts as OrderStatus[])]
}

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
    const { limit, conceptId, status, ...rest } = req.query
    // ONL-R2-07: an unknown status ('out_for_delivery') reached Prisma and
    // answered 500. Validate it here — one status or a comma list — and
    // answer 400 naming the allowed values.
    const statuses = parseStatusFilter(status)
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
    const page = await listOrders({
      ...rest,
      ...(statuses && { status: statuses.join(',') }),
      conceptIds: finalConceptIds,
      limit: limit ? parseInt(limit, 10) : undefined,
    })
    const role = req.staffUser!.role
    return { ...page, data: page.data.map((o) => redactDeliveryOtp(o, role)) }
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
      return redactDeliveryOtp(order, req.staffUser!.role)
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
        select: { id: true, conceptId: true, status: true, source: true, fulfilmentType: true, rawPayload: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      await assertConceptAccess(req.staffUser!, order.conceptId)
      // A till sale paid before the kitchen finished is already 'completed'
      // (decision 8) and sits on expo by its lines (UI-05). Its status can't
      // go back to 'ready': the kitchen's progress is its items — bump them
      // (PATCH /order-items/:id/status) and expo hands it off when every line
      // is done. Said plainly, instead of the bare state-machine 409 (R4).
      // READY there (the tablet KDS's "ticket done" on its FIRED lane) means
      // exactly that, so it bumps the order's fired lines instead — the
      // order's status stays 'completed' (bumpPaidTillSale).
      if (order.status === 'completed' && status === 'ready' && completionDoor(order) === 'payment') {
        const bumped = await bumpPaidTillSale(order.id, req.staffUser!.id)
        return redactDeliveryOtp(bumped, req.staffUser!.role)
      }
      if (order.status === 'completed' && status !== 'completed' && completionDoor(order) === 'payment') {
        throw new AppError('PAID_AT_TILL', 'This order is already paid at the till — bump its items; expo hands it off once every item is done.', 409)
      }
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
      const updated = await updateOrderStatus(req.params.id, status, {
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        via: 'status_update',
      })
      return redactDeliveryOtp(updated, req.staffUser!.role)
    },
  )

  // POST /orders/:id/cancel — the staff cancel (cancel / void a whole order).
  // §17.4: only a MANAGER cancels — the signed-in user is one, or a cashier /
  // server sends a valid manager PIN of the order's own company (403
  // MANAGER_OVERRIDE_REQUIRED without one, INVALID_MANAGER_PIN for a wrong or
  // other-company PIN). Reason required, the approver always recorded (audit
  // and the order's pre-bills, which become 'cancelled'); goes through
  // cancelOrder like every other way an order can end without a sale (expo
  // reject, refused-at-door, the auto-cancel sweep). Nothing goes to the
  // fiscal POS — there was no sale.
  fastify.post<{ Params: { id: string }; Body: { reason: string; managerOverridePin?: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { reason, managerOverridePin } = cancelOrderSchema.parse(req.body)
      // Company-scoped lookup first — a foreign order 404s before anything
      // is read, cancelled or audited (and before any PIN is tried).
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      const { approverId, viaPin } = await requireManagerApproval({
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin,
        tenantId: order.concept.tenantId,
        action: 'Cancelling an order',
        orderId: order.id,
      })
      const updated = await cancelOrder(order.id, {
        reason,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        approverId,
        metadata: { ip: req.ip, approvedByPin: viaPin },
      })
      return reply.send({ ok: true, order: redactDeliveryOtp(updated, req.staffUser!.role) })
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
  // POST /orders/:id/cod-unpaid — a manager reports that a delivered
  // cash-on-delivery order's cash never reached the till. Only a real COD:
  // an online (non-till) order, completed, with its cash row still pending
  // (not paid into a drawer). Records ONE strike per order (a second report
  // of the same order is a no-op, so it cannot stack into a ban) and audits
  // in the ORDER's company. It used to take any order from any staff role,
  // and two calls on a PKR 5,000+ order banned the customer.
  //
  // The BOOKS are untouched: what happens to the sale when the cash never
  // arrives (customer owes / rider owes / write-off / not delivered) is
  // pending owner decision G1 — the payment stays pending, the sale stays
  // booked, and the order stays on /pos/cod-due until the cash is taken in.
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cod-unpaid',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {})
      // Company-scoped — assertConceptAccess bypasses for management roles.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: {
          id: true, conceptId: true, customerId: true, totalCents: true, status: true, source: true,
          concept: { select: { tenantId: true } },
          payments: { where: { method: 'cash', amountCents: { gt: 0 } }, select: { id: true, status: true, amountCents: true } },
        },
      })
      if (!order) throw new AppError('NOT_FOUND', 'Order not found in your active company', 404)
      await assertConceptAccess(req.staffUser!, order.conceptId)
      if (order.source === 'pos' || order.payments.length === 0) {
        throw new AppError('NOT_CASH_ON_DELIVERY', 'This order was not paid cash on delivery', 422)
      }
      if (order.status !== 'completed') {
        throw new AppError('ORDER_NOT_COMPLETED', `This order is ${order.status} — only a delivered (completed) order can be reported unpaid`, 409)
      }
      const unpaid = order.payments.filter((p) => p.status === 'pending')
      if (unpaid.length === 0) {
        throw new AppError('COD_ALREADY_PAID', 'No cash is still owed on this order — it has been paid in or handed back', 409)
      }
      if (!order.customerId) {
        throw new AppError('NO_CUSTOMER', 'Cash-unpaid strike requires a linked customer.', 422)
      }

      const { recordStrike } = await import('../../lib/strikes.js')
      // High-value orders sting more — sev=2 means 2 incidents → ban.
      const severity = order.totalCents >= 500_000 /* PKR 5,000+ */ ? 2 : 1
      const strike = await recordStrike({
        customerId: order.customerId,
        kind: 'cod_unpaid',
        sourceType: 'order',
        sourceId: order.id,
        severity,
        reason: body.reason ?? 'Cash on delivery — not paid',
        recordedById: req.staffUser?.id,
      })

      const unpaidCents = unpaid.reduce((s, p) => s + p.amountCents, 0)
      await audit({ category: 'identity',
        action: 'order.cod_unpaid', entity: 'Order', entityId: order.id,
        userId: req.staffUser?.id ?? null, tenantId: order.concept.tenantId, userEmail: req.staffUser?.email ?? null,
        metadata: { reason: body.reason, severity, totalCents: order.totalCents, unpaidCents, duplicate: strike.duplicate },
      })
      return { ok: true, severity, duplicate: strike.duplicate, unpaidCents }
    },
  )

  // POST /orders/:id/refused-at-door — driver/staff marks a delivery as
  // refused on arrival. Order goes to 'cancelled' (food was prepared but
  // refused), and the customer gets a strike. Optional `reason` captures
  // what the driver was told ("looked rude", "different person at door", etc.)
  fastify.post<{ Params: { id: string }; Body: { reason?: string; managerOverridePin?: string } }>(
    '/:id/refused-at-door',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        reason: z.string().max(500).optional(),
        // §17.4: a rung-up (till) order is only cancelled with a manager.
        managerOverridePin: z.string().min(4).max(8).optional(),
      }).parse(req.body ?? {})
      // Company-scoped — assertConceptAccess bypasses for management roles, so
      // the lookup itself must enforce the company boundary.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, customerId: true, totalCents: true, status: true, source: true, concept: { select: { tenantId: true } } },
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

      // §17.4: refusing a RUNG-UP order (rung at the till — a delivery the
      // till sent out) cancels the whole order, which needs a manager. An
      // online order refused at the door stays as it was (the rider / staff
      // member reports it; the actor is recorded).
      const approval = order.source === 'pos'
        ? await requireManagerApproval({
          actorId: req.staffUser!.id,
          actorRole: req.staffUser!.role,
          managerOverridePin: body.managerOverridePin,
          tenantId: order.concept.tenantId,
          action: 'Cancelling a rung-up order',
          orderId: order.id,
        })
        : { approverId: req.staffUser!.id, viaPin: false }

      // Cancel through the one cancel path — the food's already cooked, so
      // there is no revenue to book, and whatever the customer paid with
      // wallet or gift card is given back.
      const severity = order.totalCents >= 500_000 ? 2 : 1
      const reason = body.reason?.trim() || 'Customer refused order at the door.'
      await cancelOrder(order.id, {
        reason,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        approverId: approval.approverId,
        action: 'order.refused_at_door',
        metadata: { severity, totalCents: order.totalCents, approvedByPin: approval.viaPin },
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
  // drawer it leaves (owner decision 3), its own journal entry, the fiscal
  // return document, and — once refunded in full — status 'refunded' with the
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
// (no course = course 1) flip from 'pending' to 'preparing'; later courses
// stay pending until expo fires them here. The pacing worker only ever paces
// the first course and never fires a later one ahead of an earlier one
// (orders/service.ts scheduleCoursePacing).
/** Who may override course pacing ("fire all now") — the same rule as expo's Fire: the manager tiers and the expediter. */
const FIRE_ALL_ROLES: string[] = [...MANAGERS, 'expediter']

export async function orderCourseRoutes(fastify: FastifyInstance) {
  // POST /orders/:id/fire-course — body: { course: 2 } fires items at course 2.
  //
  // The order's FIRST course is paced (K-RV-01): only its due lines fire, the
  // rest come back as `paced` [{ id, name, scheduledFireAt }] for the pacing
  // worker — this route used to fire them all and bypass expo's pacing for any
  // staff role. `fireAll: true` ("fire all now") is the override: managers and
  // the expediter only (403 FIRE_ALL_NOT_ALLOWED, same rule as expo's Fire),
  // audited as 'expo.fire_all' with the ORDER's company. Any course of an
  // order expo has not fired yet is refused (409 FIRE_FROM_EXPO).
  fastify.post<{ Params: { id: string }; Body: { course: number; fireAll?: boolean } }>(
    '/:id/fire-course',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        course: z.number().int().min(1).max(20),
        fireAll: z.boolean().optional(),
      }).parse(req.body)
      const { course } = body
      const fireAll = body.fireAll === true
      const { prisma } = await import('../../lib/prisma.js')
      // Verify the order belongs to one of the operator's companies before firing.
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, ...(await orderInCompany(req, 'write')) },
        select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      await assertConceptAccess(req.staffUser!, order.conceptId)
      if (fireAll && !FIRE_ALL_ROLES.includes(req.staffUser!.role)) {
        throw new AppError('FIRE_ALL_NOT_ALLOWED', 'Only a manager or the expediter can fire paced dishes early.', 403)
      }
      // A pre-order still held off the kitchen goes early only by a manager or
      // the expediter: firing it releases it and takes its stock now.
      if (!FIRE_ALL_ROLES.includes(req.staffUser!.role)) {
        const { preOrderHeldUntil, preOrderHeldError } = await import('./service.js')
        const heldUntil = await preOrderHeldUntil(order.id)
        if (heldUntil) throw preOrderHeldError(heldUntil)
      }
      // Through the one firing engine (expo/fire.ts fireOrderItems, via
      // fireCourse): pending, never-voided lines only, recipe steps laid out
      // on their stations, item:updated to each station room and the
      // company's order room — this used to be a bare updateMany that no
      // screen heard about (BOH-16).
      const { fired, unroutedItems, paced } = await fireCourse(order.id, course, { fireAll })
      if (fireAll && fired.length > 0) {
        await audit({ category: 'identity',
          userId:    req.staffUser!.id,
          userEmail: req.staffUser!.email,
          // The order's own company, not the operator's active one ('write'
          // scope spans every company the operator belongs to).
          tenantId:  order.concept.tenantId ?? null,
          entity:    'Order',
          entityId:  order.id,
          action:    'expo.fire_all',
          metadata:  { course, fired: fired.map((f) => f.id), via: 'fire_course' },
        })
      }
      if (fired.length === 0 && paced.length === 0) {
        return reply.status(404).send({ error: { code: 'NO_ITEMS', message: `No pending items at course ${course}` } })
      }
      // Nothing due yet but dishes paced: 200 with the times, not a "not found".
      return reply.send({ ok: true, fired: fired.length, course, paced, unroutedItems })
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
        select: { id: true, conceptId: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      await assertConceptAccess(req.staffUser!, order.conceptId)
      const items = await prisma.orderItem.findMany({
        where: { orderId: req.params.id },
        // scheduledFireAt: a PACED line's fire time, so the Courses page still
        // says "fires at HH:MM" after a reload (it used to know only what the
        // last fire response returned).
        select: { id: true, name: true, quantity: true, course: true, status: true, firedAt: true, completedAt: true, scheduledFireAt: true },
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
