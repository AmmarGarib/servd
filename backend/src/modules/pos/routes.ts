import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS, MANAGERS } from '../auth/middleware.js'
import { createPosOrder, processPayment, openShift, closeShift, getZReport, voidOrderItem, refundOrder, compOrder } from './service.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { buildReceiptHtml } from './receipt.js'

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
})

const paymentSchema = z.object({
  orderId: z.string().uuid(),
  shiftId: z.string().uuid(),
  payments: z.array(
    z.object({
      method: z.enum(['cash', 'card', 'keenu_qr', 'split', 'comp']),   // F-PAY02: dropped wallet methods
      amountCents: z.number().int().min(0),
      tenderedCents: z.number().int().optional(),
      gatewayRef: z.string().optional(),
      gateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'none']).optional(),
    }),
  ),
  complimentaryReason: z.string().optional(),
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
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const order = await createPosOrder({
      ...body,
      staffId: req.staffUser!.id,
      staffRole: req.staffUser!.role,
    })
    return reply.status(201).send(order)
  })

  // POST /pos/payments
  fastify.post('/payments', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = paymentSchema.parse(req.body)
    const order = await prisma.order.findFirst({
      where: {
        id: body.orderId,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
    const result = await processPayment(body)
    return reply.status(201).send(result)
  })

  // POST /pos/shifts/open
  fastify.post('/shifts/open', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const { openingFloatCents } = openShiftSchema.parse(req.body)
    const shift = await openShift(req.staffUser!.id, openingFloatCents)
    return reply.status(201).send(shift)
  })

  // POST /pos/shifts/close
  fastify.post<{ Params: { id: string } }>(
    '/shifts/:id/close',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { closingFloatCents, notes } = closeShiftSchema.parse(req.body)
      const shift = await prisma.shift.findFirst({
        where: { id: req.params.id, user: { tenantId: req.staffUser!.tenantId } },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found in your active company' } })
      return closeShift(req.params.id, closingFloatCents, notes)
    },
  )

  // GET /pos/shifts/:id/zreport
  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/zreport',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const shift = await prisma.shift.findFirst({
        where: { id: req.params.id, user: { tenantId: req.staffUser!.tenantId } },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found in your active company' } })
      return getZReport(req.params.id)
    },
  )

  // GET /pos/receipt/:orderId — returns printable HTML receipt
  fastify.get<{ Params: { orderId: string } }>(
    '/receipt/:orderId',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
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
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
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
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
      }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const result = await compOrder({
        orderId: req.params.orderId,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
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
      }).parse(req.body)

      const shift = await prisma.shift.findFirst({
        where: { id: req.params.id, user: { tenantId: req.staffUser!.tenantId } },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found in your active company' } })
      if (shift.status !== 'open') {
        return reply.status(400).send({ error: { code: 'SHIFT_CLOSED', message: 'Cannot record cash movements on a closed shift' } })
      }

      const movement = await prisma.cashMovement.create({
        data: {
          shiftId: req.params.id,
          type: body.type,
          amountCents: body.amountCents,
          reason: body.reason,
          recordedById: req.staffUser!.id,
          managerOverridePin: body.managerOverridePin,
        },
      })
      return reply.status(201).send(movement)
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/cash-movements',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const shift = await prisma.shift.findFirst({
        where: { id: req.params.id, user: { tenantId: req.staffUser!.tenantId } },
      })
      if (!shift) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Shift not found in your active company' } })
      const movements = await prisma.cashMovement.findMany({
        where: { shiftId: req.params.id },
        orderBy: { recordedAt: 'desc' },
        include: { recordedBy: { select: { name: true } } },
      })
      return { movements }
    },
  )

  // GET /pos/orders/:orderId/receipt-data — JSON receipt for tablet thermal
  // printing. Mirror of /pos/receipt/:orderId (HTML version), shaped to match
  // the ReceiptOrder interface in tablet/src/lib/printer.ts.
  fastify.get<{ Params: { orderId: string } }>(
    '/orders/:orderId/receipt-data',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
        include: {
          items: { include: { modifiers: true } },
          concept: { select: { name: true } },
          customer: { select: { name: true } },
          table: { select: { label: true } },
          payments: { where: { status: 'paid' } },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })

      const paidCents = order.payments.reduce((s, p) => s + p.amountCents, 0)
      const primaryTender = order.payments[0]?.method ?? null
      const subtotalCents = order.items.reduce((s, it) => s + it.unitPriceCents * it.quantity, 0)

      return {
        number:        order.id.slice(-6).toUpperCase(),
        conceptName:   order.concept.name,
        customerName:  order.customer?.name ?? order.customerName ?? null,
        table:         order.table?.label ?? null,
        source:        order.source,
        items:         order.items.map((it) => ({
          name:      it.name,
          qty:       it.quantity,
          price:     it.unitPriceCents,
          modifiers: it.modifiers.map((m) => m.name).filter(Boolean),
        })),
        subtotalCents,
        taxCents:      order.taxCents,
        totalCents:    order.totalCents,
        paidCents,
        tenderType:    primaryTender,
        placedAt:      order.placedAt.toISOString(),
      }
    },
  )

  // POST /pos/orders/:orderId/refund — issue a refund against a paid order.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/refund',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        amountCents: z.number().int().min(1),
        reason: z.string().min(1).max(200),
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
      }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const result = await refundOrder({
        orderId: req.params.orderId,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
      })
      return reply.status(200).send(result)
    },
  )
}
