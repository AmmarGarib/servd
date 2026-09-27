import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS, MANAGERS } from '../auth/middleware.js'
import { createPosOrder, processPayment, settlePayment, openShift, closeShift, getZReport, voidOrderItem, refundOrder, compOrder, recordCashMovement } from './service.js'
import { PAYOUT_CATEGORIES } from '../accounting/expenseCategories.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, shiftWhere, findShiftInScope, assertShiftOf } from '../../lib/tenantScope.js'
import { buildReceiptHtml, buildReceiptData } from './receipt.js'

// ─── Company scoping ──────────────────────────────────────────────────────────
//
// Which company a shift belongs to is answered by lib/tenantScope.ts
// (shiftOfCompany / findShiftInScope / assertShiftOf): Shift.tenantId, with the
// location and then the cashier as fallbacks ONLY for rows that predate it.
// A guessed shift id from another company 404s exactly like a foreign order.

const posOrderSchema = z.object({
  conceptId: z.string().uuid(),
  // B08: tighten FK fields. Sending "not-a-uuid" used to bubble up as a 500
  // because Prisma rejected the value mid-transaction; now the Zod gate
  // rejects with a clear 400.
  tableId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  items: z.array(
    z.object({
      // menuItemId may legitimately be null for manual line items (open-priced
      // walk-in orders); validate as uuid only when set.
      menuItemId: z.string().uuid().nullable().default(null),
      name: z.string(),
      quantity: z.number().int().min(1),
      unitPriceCents: z.number().int().min(0),
      notes: z.string().optional(),
      course: z.number().int().optional(),
      modifiers: z
        .array(
          z.object({
            name: z.string(),
            priceDeltaCents: z.number().int().default(0),
            modifierId: z.string().uuid().optional(),
          }),
        )
        .default([]),
    }),
  ),
  discountCents: z.number().int().min(0).default(0),
  discountReason: z.string().optional(),
  managerOverridePin: z.string().min(4).max(8).optional(),     // required when discount/override exceeds cashier cap
  // Client-generated key, stable across retries of the SAME ring-up, so a
  // double-tap or an offline-queue resend dedupes to ONE order instead of
  // firing duplicate tickets. Falls back to a timestamp when absent.
  idempotencyKey: z.string().min(8).max(100).optional(),
})

const paymentSchema = z.object({
  orderId: z.string().uuid(),
  shiftId: z.string().uuid(),
  payments: z.array(
    z.object({
      // F-PAY02: dropped wallet methods. No 'comp': a comp is not a tender,
      // it goes through POST /pos/orders/:id/comp (caps, PIN, audit). No
      // 'split': that is the group-order placeholder, not money — split the
      // bill (check-split) and settle each portion.
      method: z.enum(['cash', 'card', 'keenu_qr']),
      amountCents: z.number().int().min(0),
      tenderedCents: z.number().int().optional(),
      // The card terminal's reference number — required for card / QR
      // (owner decision 4).
      gatewayRef: z.string().trim().max(120).optional(),
      gateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'none']).optional(),
    }),
  ),
})

const openShiftSchema = z.object({
  openingFloatCents: z.number().int().min(0).default(0),
})

const closeShiftSchema = z.object({
  closingFloatCents: z.number().int().min(0),
  notes: z.string().optional(),
})

export async function posRoutes(fastify: FastifyInstance) {
  // POST /pos/orders — create an order at the till
  // Cashier must have access to the concept they're ringing under (IDOR §C6).
  fastify.post('/orders', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = posOrderSchema.parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)
    // A ring-up binds a NEW order to a brand, so the brand must belong to the
    // company the operator is acting in — not merely one they're a member of.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before ringing up an order', 422)
    await assertConceptOwned(req, body.conceptId, 'create')

    // Everything the order attaches to must be that brand's / company's own:
    // the table (brand-anchored), every catalogue line (brand-anchored — a
    // foreign item would route the ticket to the other brand's KDS station)
    // and the drawer.
    if (body.tableId) {
      const table = await prisma.table.findFirst({
        where: { id: body.tableId, conceptId: body.conceptId, deletedAt: null },
        select: { id: true },
      })
      if (!table) throw new AppError('TABLE_NOT_IN_BRAND', 'That table does not belong to this brand', 422)
    }
    const menuItemIds = Array.from(new Set(body.items.map((i) => i.menuItemId).filter((x): x is string => !!x)))
    if (menuItemIds.length > 0) {
      const owned = await prisma.menuItem.count({
        where: { id: { in: menuItemIds }, conceptId: body.conceptId, deletedAt: null },
      })
      if (owned !== menuItemIds.length) throw new AppError('ITEM_NOT_IN_BRAND', 'One or more items do not belong to this brand', 422)
    }
    if (body.shiftId) await assertShiftOf(tenantId, body.shiftId, false)

    const order = await createPosOrder({
      ...body,
      staffId: req.staffUser!.id,
      staffRole: req.staffUser!.role,
    })
    return reply.status(201).send(order)
  })

  // POST /pos/payments — take tenders at the till for what is due.
  fastify.post('/payments', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = paymentSchema.parse(req.body)
    const order = await prisma.order.findFirst({
      where: {
        id: body.orderId,
        concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      select: { id: true, concept: { select: { tenantId: true } } },
    })
    if (!order?.concept.tenantId) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
    // The drawer must be an OPEN shift of the order's own company.
    await assertShiftOf(order.concept.tenantId, body.shiftId, true)
    const result = await processPayment(body)
    return reply.status(201).send(result)
  })

  // POST /pos/payments/:id/settle — take the money for ONE pending payment row
  // on an open drawer: a check-split portion, or a storefront cash-on-delivery
  // amount the rider pays into the till (owner decision 4 — it lands on this
  // drawer's Z-report). The one settle (settlePayment), shared with
  // /check-split and the Keenu webhook.
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/settle',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const body = z.object({
        shiftId: z.string().uuid(),
        gatewayRef: z.string().trim().max(120).optional(),
        tenderedCents: z.number().int().min(0).optional(),
      }).parse(req.body)
      const payment = await prisma.payment.findFirst({
        where: { id: req.params.id, order: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        select: { id: true },
      })
      if (!payment) throw new NotFoundError('Payment', req.params.id)
      return settlePayment({ paymentId: payment.id, via: 'till', shiftId: body.shiftId, gatewayRef: body.gatewayRef, tenderedCents: body.tenderedCents })
    },
  )

  // GET /pos/cod-due — delivered cash-on-delivery orders whose cash has not
  // been paid into a drawer yet, for the rider pay-in screen.
  fastify.get('/cod-due', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const rows = await prisma.payment.findMany({
      where: {
        method: 'cash',
        status: 'pending',
        order: { source: { not: 'pos' }, status: 'completed', concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      },
      select: {
        id: true, amountCents: true, createdAt: true,
        order: { select: { id: true, completedAt: true, customerName: true, concept: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    return { payments: rows }
  })

  // GET /pos/shifts/current — the caller's open drawer, or null.
  //
  // The server is the source of truth for "which drawer am I on". Each device
  // used to keep its own shiftId in local storage, so a drawer closed from
  // anywhere else (a manager closing it from /reconciliation, the other till)
  // stranded it: every payment 422'd and every close 400'd with no way out.
  // Clients re-sync from here on launch and focus, and whenever a call comes
  // back SHIFT_CLOSED or SHIFT_NOT_IN_COMPANY. A cashier has at most one open
  // shift (openShift refuses a second), in any company they belong to.
  fastify.get('/shifts/current', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const shift = await prisma.shift.findFirst({
      where: { userId: req.staffUser!.id, status: 'open', ...(await shiftWhere(req, 'write')) },
      orderBy: { openedAt: 'desc' },
      select: { id: true, openedAt: true, openingFloatCents: true, tenantId: true },
    })
    return { shift }
  })

  // POST /pos/shifts/open
  fastify.post('/shifts/open', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const { openingFloatCents } = openShiftSchema.parse(req.body)
    const shift = await openShift(req.staffUser!.id, openingFloatCents, req.staffUser!.tenantId)
    return reply.status(201).send(shift)
  })

  // POST /pos/shifts/close
  fastify.post<{ Params: { id: string } }>(
    '/shifts/:id/close',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { closingFloatCents, notes } = closeShiftSchema.parse(req.body)
      // Closing an EXISTING drawer: any company the operator belongs to.
      const shift = await findShiftInScope(req, req.params.id, 'write')
      // Ownership: a cashier may only close their OWN shift. Closing someone
      // else's drawer (to bury a variance or shift blame onto the closer) is a
      // manager-tier action.
      if (shift.userId !== req.staffUser!.id && !MANAGERS.includes(req.staffUser!.role)) {
        return reply.status(403).send({ error: { code: 'NOT_YOUR_SHIFT', message: 'Only the shift owner or a manager can close this shift' } })
      }
      return closeShift(req.params.id, closingFloatCents, notes)
    },
  )

  // GET /pos/shifts/:id/zreport
  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/zreport',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // View-aware: the active company, or every company in "All companies".
      const shift = await findShiftInScope(req, req.params.id, 'read')
      return getZReport(shift.id)
    },
  )

  // GET /pos/receipt/:orderId — the receipt as printable HTML. Same data as
  // /pos/orders/:orderId/receipt-data (one builder, pos/receipt.ts).
  fastify.get<{ Params: { orderId: string } }>(
    '/receipt/:orderId',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const html = await buildReceiptHtml(req.params.orderId)
      return reply.type('text/html').send(html)
    },
  )

  // POST /pos/orders/:orderId/void — void a single line item.
  // Enforces RefundPolicy.{cashier,manager}VoidLimitCents based on the line's
  // value. Manager override required above the cashier cap.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/void',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        orderItemId: z.string().uuid(),
        reason: z.string().min(1).max(200),
        managerOverridePin: z.string().optional(),     // required when above cashier cap
      }).parse(req.body)
      // Company scope through the shared helper — a null tenantFilter would
      // otherwise match every company-less brand.
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const result = await voidOrderItem({
        orderId: req.params.orderId,
        orderItemId: body.orderItemId,
        reason: body.reason,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
      })
      return reply.status(200).send(result)
    },
  )

  // POST /pos/orders/:orderId/comp — comp the entire order (or a portion).
  // Comp = on-the-house, no payment expected, but tracked as a P&L line.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/comp',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        amountCents: z.number().int().min(1),
        reason: z.string().min(1).max(200),
        // The open drawer the comp is rung on — the Z-report's comps and the
        // shift journal entry's 7030 line only see comps that sit on a shift.
        shiftId: z.string().uuid(),
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
        // A staff meal (owner decision 11): who ate. The meal is comped in
        // full with a manager PIN and appears in the staff-meal log.
        // Either a login id or the HR employee code — the till only knows the code.
        staffMealFor: z.string().min(1).max(64).optional(),
      }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        select: { id: true, concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      // Like a payment: the drawer must be an OPEN shift of the order's own company.
      await assertShiftOf(order.concept.tenantId, body.shiftId, true)
      // A staff meal names a member of THIS company: resolve a code or a login
      // id to the staff member's login, never trust a foreign id.
      let staffMealUserId: string | undefined
      if (body.staffMealFor) {
        const tenantId = order.concept.tenantId
        if (!tenantId) return reply.status(422).send({ error: { code: 'NO_COMPANY', message: 'This brand belongs to no company; a staff meal needs one' } })
        const emp = await prisma.hrEmployee.findFirst({
          where: { tenantId, status: { in: ['active', 'on_leave'] }, OR: [{ employeeCode: body.staffMealFor }, { userId: body.staffMealFor }] },
          select: { userId: true, fullName: true },
        })
        const user = !emp && /^[0-9a-f-]{36}$/i.test(body.staffMealFor)
          ? await prisma.user.findFirst({ where: { id: body.staffMealFor, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }, select: { id: true } })
          : null
        staffMealUserId = emp?.userId ?? user?.id ?? undefined
        if (!staffMealUserId) return reply.status(422).send({ error: { code: 'STAFF_NOT_IN_COMPANY', message: `No staff member "${body.staffMealFor}" with a login in this company — check the employee code` } })
      }
      const result = await compOrder({
        orderId: req.params.orderId,
        shiftId: body.shiftId,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        ...(staffMealUserId && { staffMeal: { staffId: staffMealUserId } }),
      })
      return reply.status(200).send(result)
    },
  )

  // ─── Mid-shift cash movements ──────────────────────────────────────────
  // POST /pos/shifts/:id/cash-movements
  // GET  /pos/shifts/:id/cash-movements
  //
  // Cashier can log a drop (cash to safe), add (small bills in), payout
  // (paid a vendor from drawer), or payin (refund from vendor). Each
  // affects the expected drawer total at close.
  fastify.post<{ Params: { id: string } }>(
    '/shifts/:id/cash-movements',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        type:        z.enum(['drop', 'add', 'payout', 'payin']),
        amountCents: z.number().int().min(1),
        reason:      z.string().min(1).max(200),
        managerOverridePin: z.string().min(4).max(8).optional(),
        // Pay-out to a vendor (owner decision 5): what it paid for, or the
        // supplier bill it pays. Manager PIN and the pay-out cap apply.
        category:       z.enum(PAYOUT_CATEGORIES.map((c) => c.key) as [string, ...string[]]).optional(),
        supplierBillId: z.string().uuid().nullable().optional(),
        vendorName:     z.string().max(120).nullable().optional(),
        receiptUrl:     z.string().url().nullable().optional(),
      }).parse(req.body)

      // Recording against an EXISTING drawer: any company the operator belongs to.
      const shift = await findShiftInScope(req, req.params.id, 'write')
      if (shift.status !== 'open') {
        return reply.status(400).send({ error: { code: 'SHIFT_CLOSED', message: 'Cannot record cash movements on a closed shift' } })
      }
      // Ownership: cash drops/payouts hit the drawer the cashier is accountable
      // for — only the shift owner or a manager may record them.
      if (shift.userId !== req.staffUser!.id && !MANAGERS.includes(req.staffUser!.role)) {
        return reply.status(403).send({ error: { code: 'NOT_YOUR_SHIFT', message: 'Only the shift owner or a manager can record cash movements' } })
      }

      // The PIN is verified, never stored (the old route wrote it to the row).
      const movement = await recordCashMovement({
        shiftId: shift.id,
        type: body.type,
        amountCents: body.amountCents,
        reason: body.reason,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        category: body.category as never,
        supplierBillId: body.supplierBillId ?? null,
        vendorName: body.vendorName ?? null,
        receiptUrl: body.receiptUrl ?? null,
      })
      return reply.status(201).send(movement)
    },
  )

  // GET /pos/payout-categories — what a till pay-out can be for.
  fastify.get('/payout-categories', { preHandler: requireAuth(...CASHIERS) }, async () => ({ categories: PAYOUT_CATEGORIES }))

  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/cash-movements',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const shift = await findShiftInScope(req, req.params.id, 'read')
      const movements = await prisma.cashMovement.findMany({
        where: { shiftId: shift.id },
        orderBy: { recordedAt: 'desc' },
        include: { recordedBy: { select: { name: true } } },
      })
      return { movements }
    },
  )

  // GET /pos/orders/:orderId/receipt-data — the receipt as data, for the
  // tablet's thermal printer (ReceiptOrder in tablet/src/lib/printer.ts).
  // Same builder as the HTML receipt: stored tax and total, modifiers in the
  // subtotal, our TaxInvoice number, and the FBR / SRB ids and SRB QR link.
  fastify.get<{ Params: { orderId: string } }>(
    '/orders/:orderId/receipt-data',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      return buildReceiptData(order.id)
    },
  )

  // POST /pos/orders/:orderId/refund — THE refund engine's route (refundOrder).
  // /refunds, the order page and the till all call this. Caps + manager PIN
  // (403 MANAGER_OVERRIDE_REQUIRED → prompt for a PIN and resend), any amount
  // up to what is still refundable, the cash out of an OPEN drawer (owner
  // decision 3), its own journal entry, and status 'refunded' once in full.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/refund',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        amountCents: z.number().int().min(1),
        reason: z.string().trim().min(3).max(200),
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
        // How the money goes back (defaults to the tender of the sale).
        method: z.enum(['cash', 'card', 'keenu_qr']).optional(),
        // The open drawer a cash refund leaves from (defaults to the
        // refunder's own open drawer).
        shiftId: z.string().uuid().optional(),
      }).parse(req.body)
      // Refunding an EXISTING order: any company the operator belongs to,
      // through the shared helper (never the raw tenantFilter).
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        select: { id: true, concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      // A named drawer must be an OPEN drawer of the order's company.
      if (body.shiftId) await assertShiftOf(order.concept.tenantId, body.shiftId, true)
      const result = await refundOrder({
        orderId: order.id,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        method: body.method,
        shiftId: body.shiftId ?? null,
      })
      return reply.status(200).send(result)
    },
  )
}
