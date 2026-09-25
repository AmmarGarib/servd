import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { ingestOrder, listOrders, getOrder, updateOrderStatus, updateItemStatus, cancelOrder } from './service.js'
import { assertConceptAccess, filterConceptIdsForStaff } from '../../lib/conceptAccess.js'
import { conceptWhere, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { getFbrQueue, getSrbQueue } from '../../lib/queue.js'
import type { OrderDTO } from '@servd/types'

// Orders are brand-anchored (Order.conceptId) and a brand belongs to one
// company, so "is this order mine?" is always answered through the concept.
// `assertConceptAccess` is a per-user brand whitelist that NO-OPs for every
// management role — it is not a company check. Every handler below scopes
// the lookup itself, before touching a client-supplied id.

/**
 * `where` fragment: the order's brand belongs to a company in scope for
 * `mode` — 'read' is view-aware (portfolio expands), 'write' is every
 * company the operator belongs to. Foreign ids simply don't match → 404.
 */
async function orderInCompany(req: FastifyRequest, mode: ScopeMode) {
  return { concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) } }
}

/** A staff user belongs to `tenantId` as their primary company or via a membership. */
function userInCompany(tenantId: string) {
  return { OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }
}

const createOrderSchema = z.object({
  source: z.enum(['servd', 'pos', 'cart', 'manual']),
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

// Kitchen / service progress only. Cancelling is POST /orders/:id/cancel — it
// needs a manager, a reason and an audit entry, none of which this route asks
// for (it used to accept 'cancelled' from any staff role with no reason).
const updateOrderStatusSchema = z.object({
  status: z.enum(['received', 'confirmed', 'preparing', 'ready', 'completed', 'refunded']),
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

  // POST /orders — manual order creation (server / cashier manual intake)
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const dto = createOrderSchema.parse(req.body) as OrderDTO
    // A create binds to the ACTIVE company only ('create' scope) — the brand
    // must be one of the active company's (404 otherwise, so a foreign id is
    // never confirmed), and every row attached below must sit in that same
    // company. Otherwise a head-office member of both companies could file a
    // GSX Viva ticket under a GS Foods brand from the wrong tab.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating an order', 422)
    const concept = await prisma.concept.findFirst({
      where: { id: dto.concept_id, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
    })
    if (!concept) throw new NotFoundError('Concept', dto.concept_id)
    await assertConceptAccess(req.staffUser!, dto.concept_id)

    // Cross-company attach guards on the body. table_id + menuItemId are
    // checked against the brand inside ingestOrder (shared with POS /
    // storefront); shift + cashier are company-anchored through User /
    // Location, so they're checked here where the active company is known.
    if (dto.pos_staff_id) {
      const staff = await prisma.user.findFirst({
        where: { id: dto.pos_staff_id, deletedAt: null, ...userInCompany(tenantId) },
        select: { id: true },
      })
      if (!staff) throw new AppError('STAFF_NOT_IN_COMPANY', 'pos_staff_id does not belong to this company', 422)
    }
    if (dto.shift_id) {
      const shift = await prisma.shift.findFirst({
        where: { id: dto.shift_id, OR: [{ location: { tenantId } }, { user: userInCompany(tenantId) }] },
        select: { id: true },
      })
      if (!shift) throw new AppError('SHIFT_NOT_IN_COMPANY', 'shift_id does not belong to this company', 422)
    }

    // SRB alignment: compute GST server-side on the PRE-discount item total
    // (manual orders carry no discount), so taxCents is correct and the SRB
    // filing matches the books — never trust a client-supplied amount for a
    // taxable sale. Mirrors the POS tax rule (cash → taxRateCash, else card).
    const itemTotal = dto.items.reduce((s, it) => {
      const mods = (it.modifiers ?? []).reduce((m, x) => m + x.priceDeltaCents, 0)
      return s + (it.unitPriceCents + mods) * it.quantity
    }, 0)
    const isCash = dto.payment.provider === 'cash'
    const rate = (isCash ? (concept.taxRateCash ?? concept.taxRate) : (concept.taxRateCard ?? concept.taxRate)) / 100
    const taxCents = Math.round(itemTotal * rate)
    const totalCents = itemTotal + taxCents
    dto.payment.amountCents = totalCents

    const result = await ingestOrder(dto)
    if (result.created) {
      await prisma.order.update({ where: { id: result.order.id }, data: { taxCents, totalCents } })
      // File to SRB (+ FBR) once the sale is paid — same fan-out as the POS.
      if (dto.payment.status === 'paid') {
        getFbrQueue()?.add('submit', { orderId: result.order.id }).catch((e: Error) => console.warn('[FBR] manual order enqueue failed:', e.message))
        getSrbQueue()?.add('submit', { orderId: result.order.id }).catch((e: Error) => console.warn('[SRB] manual order enqueue failed:', e.message))
      }
    }
    return reply.status(result.created ? 201 : 200).send({ ...result.order, taxCents, totalCents })
  })

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
        select: { id: true, conceptId: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      await assertConceptAccess(req.staffUser!, order.conceptId)
      return updateOrderStatus(req.params.id, status)
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

  // POST /orders/:id/refund — manager-only refund flow with mandatory reason.
  // Wraps the status change so we always have a reason captured in the audit
  // log. Use this from the admin UI; never auto-refund. (Cancelling an unpaid
  // order is POST /orders/:id/cancel — this route used to take mode 'cancel'
  // as a second way in.)
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/refund',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        reason: z.string().min(3, 'Reason is required').max(500),
        // Only 'refund' is accepted, so a stale client still sending
        // mode 'cancel' is refused instead of refunding the order.
        mode:   z.literal('refund').optional(),
      }).parse(req.body)
      // Company-scoped at the lookup — a foreign order 404s before anything
      // is read, refunded or audited.
      const order = await getOrder(req.params.id, await orderInCompany(req, 'write'))
      await assertConceptAccess(req.staffUser!, order.conceptId)

      const updated = await updateOrderStatus(req.params.id, 'refunded')

      await audit({ category: 'identity',
        action: 'order.refund',
        entity: 'Order',
        entityId: order.id,
        userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
        userEmail: req.staffUser!.email,
        before: { status: order.status, totalCents: order.totalCents },
        after:  { status: 'refunded' },
        metadata: { reason: body.reason, ip: req.ip, conceptSlug: order.conceptId },
      })

      return reply.send({ ok: true, order: updated })
    },
  )
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
