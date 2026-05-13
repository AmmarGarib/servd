import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { NotFoundError, ForbiddenError } from '../../lib/errors.js'

// Tenant-aware supplier filter. Returns a Prisma where-clause fragment that
// covers (a) suppliers belonging to one of the operator's tenants AND
// (b) legacy/orphan suppliers with no tenantId — those still show up so a
// CEO can transfer them, flagged by a "⚠ No company" badge in the UI.
async function supplierTenantFilter(req: FastifyRequest) {
  const scope = await resolveTenantScope(req)
  if (scope.tenantIds.length === 0) return {}
  return {
    OR: [
      { tenantId: { in: scope.tenantIds } },
      { tenantId: null },
    ],
  }
}

// Guard for writes against a specific supplier — throws ForbiddenError if the
// supplier belongs to a tenant the operator can't access. Orphan suppliers
// (tenantId null) are editable so they can be claimed.
async function assertSupplierAccess(req: FastifyRequest, supplierId: string) {
  const scope = await resolveTenantScope(req)
  const sup = await prisma.supplier.findUnique({
    where: { id: supplierId },
    select: { tenantId: true },
  })
  if (!sup) throw new NotFoundError('Supplier', supplierId)
  if (sup.tenantId && scope.tenantIds.length > 0 && !scope.tenantIds.includes(sup.tenantId)) {
    throw new ForbiddenError('Supplier belongs to a company you don\'t have access to.')
  }
}
import {
  createPo, submitPo, approvePo, rejectPo, cancelPo, sendPoToSupplier, receivePo,
  createBill, voidBill, matchBill,
  createPayment, allocatePayment,
  agingReport, reorderSuggestions,
} from './service.js'

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const poLineSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantityOrdered: z.number().positive(),
  unitCostCents:   z.number().int().nonnegative(),
  notes:           z.string().optional().nullable(),
})

const poCreateSchema = z.object({
  supplierId:   z.string().uuid(),
  expectedDate: z.string().optional().nullable(),
  reference:    z.string().optional().nullable(),
  notes:        z.string().optional().nullable(),
  lines:        z.array(poLineSchema).min(1),
})

const billLineSchema = z.object({
  inventoryItemId: z.string().uuid().optional().nullable(),
  poLineId:        z.string().uuid().optional().nullable(),
  description:     z.string().min(1),
  quantity:        z.number().positive(),
  unitCostCents:   z.number().int().nonnegative(),
})

const billCreateSchema = z.object({
  supplierId:    z.string().uuid(),
  poId:          z.string().uuid().optional().nullable(),
  billNumber:    z.string().min(1),
  billDate:      z.string(),
  dueDate:       z.string().optional().nullable(),
  taxCents:      z.number().int().nonnegative().optional(),
  notes:         z.string().optional().nullable(),
  attachmentUrl: z.string().optional().nullable(),
  lines:         z.array(billLineSchema).min(1),
})

const paymentApplicationSchema = z.object({
  billId:             z.string().uuid(),
  amountAppliedCents: z.number().int().positive(),
})

const paymentCreateSchema = z.object({
  supplierId:   z.string().uuid(),
  paymentDate:  z.string(),
  method:       z.enum(['cash', 'bank_transfer', 'cheque', 'wallet']),
  reference:    z.string().optional().nullable(),
  amountCents:  z.number().int().positive(),
  notes:        z.string().optional().nullable(),
  applications: z.array(paymentApplicationSchema).optional(),
})

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function procurementRoutes(fastify: FastifyInstance) {
  // ── Suppliers ──────────────────────────────────────────────────────────────

  fastify.get('/suppliers', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = req.staffUser!
    const isManager = ['admin', 'manager', 'management', 'foh_management', 'boh_management', 'procurement'].includes(user.role)
    const tenantWhere = await supplierTenantFilter(req)
    const scopeWhere = isManager
      ? { deletedAt: null, ...tenantWhere }
      : { deletedAt: null, assignedStaffId: user.id, ...tenantWhere }
    return prisma.supplier.findMany({
      where: scopeWhere,
      include: {
        assignedStaff: { select: { id: true, name: true } },
        // Tenant relation in portfolio mode so the Monitor UI can render
        // the indigo brand chip on each supplier card.
        tenant: { select: { id: true, name: true, slug: true } },
        _count: { select: { purchaseOrders: true, inventoryItems: true, bills: true, payments: true, conversations: true } },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    })
  })

  fastify.post('/suppliers', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:                z.string().min(1),
      phone:               z.string().optional(),
      whatsappPhone:       z.string().optional(),
      email:               z.string().email().optional(),
      address:             z.string().optional(),
      taxId:               z.string().optional(),
      notes:               z.string().optional(),
      paymentTermsDays:    z.number().int().min(0).max(365).optional(),
      leadTimeDays:        z.number().int().min(0).max(365).optional(),
      openingBalanceCents: z.number().int().nonnegative().optional(),
    }).parse(req.body)
    // Anchor every new supplier to the operator's currently-active tenant.
    // Portfolio writes are gated client-side; by the time we get here,
    // tenantId is the single company the CEO picked.
    const tenantId = req.staffUser!.tenantId
    const supplier = await prisma.supplier.create({
      data: { ...body, ...(tenantId ? { tenantId } : {}) },
    })
    return reply.status(201).send(supplier)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/suppliers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await assertSupplierAccess(req, req.params.id)
      const body = z.object({
        name:                z.string().min(1).optional(),
        phone:               z.string().optional(),
        whatsappPhone:       z.string().optional(),
        email:               z.string().email().optional(),
        address:             z.string().optional(),
        taxId:               z.string().optional(),
        notes:               z.string().optional(),
        category:            z.string().max(50).optional(),
        assignedStaffId:     z.string().uuid().nullable().optional(),
        // Explicit company transfer — validated against the operator's
        // tenant memberships, mirrors the workforce hub pattern.
        tenantId:            z.string().uuid().nullable().optional(),
        paymentTermsDays:    z.number().int().min(0).max(365).optional(),
        leadTimeDays:        z.number().int().min(0).max(365).optional(),
        openingBalanceCents: z.number().int().nonnegative().optional(),
      }).parse(req.body)
      if (body.tenantId) {
        const scope = await resolveTenantScope(req)
        if (!scope.tenantIds.includes(body.tenantId)) {
          throw new ForbiddenError('You can only transfer a supplier into a company you belong to.')
        }
      }
      return prisma.supplier.update({
        where: { id: req.params.id },
        data:  body,
        include: {
          assignedStaff: { select: { id: true, name: true } },
          tenant:        { select: { id: true, name: true, slug: true } },
        },
      })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/suppliers/:id/statement',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await assertSupplierAccess(req, req.params.id)
      const supplier = await prisma.supplier.findUnique({ where: { id: req.params.id } })
      if (!supplier) throw new NotFoundError('Supplier', req.params.id)
      const [bills, payments] = await Promise.all([
        prisma.supplierBill.findMany({ where: { supplierId: req.params.id }, orderBy: { billDate: 'desc' } }),
        prisma.supplierPayment.findMany({ where: { supplierId: req.params.id }, orderBy: { paymentDate: 'desc' }, include: { applications: true } }),
      ])
      const billed = bills.reduce((s, b) => s + (b.status === 'void' ? 0 : b.totalCents), 0)
      const paid   = bills.reduce((s, b) => s + b.paidCents, 0)
      return {
        supplier,
        outstanding: supplier.openingBalanceCents + billed - paid,
        bills,
        payments,
      }
    },
  )

  // ── Purchase Orders ────────────────────────────────────────────────────────

  fastify.get<{ Querystring: { supplierId?: string; status?: string; limit?: string } }>(
    '/purchase-orders',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      // Scope by supplier.tenantId — that's the single tenant anchor for
      // every procurement entity. PO returns include the supplier so the
      // result already carries the tenant context downstream consumers need.
      const tenantWhere = await supplierTenantFilter(req)
      return prisma.purchaseOrder.findMany({
        where: {
          supplier: tenantWhere,
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status     && { status: req.query.status }),
        },
        include: {
          supplier: { select: { name: true, email: true, tenantId: true, tenant: { select: { id: true, name: true, slug: true } } } },
          lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/purchase-orders/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: {
          supplier:    { include: { tenant: { select: { id: true, name: true, slug: true } } } },
          lines:       { include: { inventoryItem: true, discrepancies: true } },
          activityLog: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
          bills:       true,
        },
      })
      if (!po) throw new NotFoundError('PurchaseOrder', req.params.id)
      await assertSupplierAccess(req, po.supplierId)
      return po
    },
  )

  fastify.post('/purchase-orders', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = poCreateSchema.parse(req.body)
    // Don't let the operator post a PO against a supplier they can't see.
    await assertSupplierAccess(req, body.supplierId)
    const po = await createPo({ ...body, createdBy: req.staffUser!.id })
    return reply.status(201).send(po)
  })

  // Helper used by every PO lifecycle endpoint: resolve the PO's supplier
  // first, then reuse `assertSupplierAccess` so tenant scoping is identical.
  async function guardPo(req: FastifyRequest, poId: string) {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, select: { supplierId: true } })
    if (!po) throw new NotFoundError('PurchaseOrder', poId)
    await assertSupplierAccess(req, po.supplierId)
  }

  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/submit',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => { await guardPo(req, req.params.id); return submitPo(req.params.id, req.staffUser!.id) },
  )

  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/approve',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => { await guardPo(req, req.params.id); return approvePo(req.params.id, req.staffUser!.id) },
  )

  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/purchase-orders/:id/reject',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      await guardPo(req, req.params.id)
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      return rejectPo(req.params.id, req.staffUser!.id, reason)
    },
  )

  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/purchase-orders/:id/cancel',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await guardPo(req, req.params.id)
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      return cancelPo(req.params.id, req.staffUser!.id, reason)
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/send',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => { await guardPo(req, req.params.id); return sendPoToSupplier(req.params.id, req.staffUser!.id) },
  )

  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await guardPo(req, req.params.id)
      const body = z.object({
        lines: z.array(z.object({
          poLineId:           z.string().uuid(),
          quantityReceived:   z.number().positive(),
          discrepancyReason:  z.enum(['short_shipment', 'over_shipment', 'damaged', 'wrong_item', 'quality_issue']).optional(),
          discrepancyNotes:   z.string().optional(),
        })).min(1),
      }).parse(req.body)
      return receivePo({ poId: req.params.id, userId: req.staffUser!.id, lines: body.lines })
    },
  )

  // ── Bills (AP) ─────────────────────────────────────────────────────────────

  // GET /procurement/ap-aging — accounts payable aging buckets
  // (current / 1-30 / 31-60 / 61-90 / 90+ days past due) by supplier.
  fastify.get('/ap-aging', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const now = new Date()
    const tenantWhere = await supplierTenantFilter(req)
    const open = await prisma.supplierBill.findMany({
      where: {
        status: { in: ['open', 'partially_paid'] },
        supplier: tenantWhere,
      },
      select: {
        id: true, billNumber: true, supplierId: true, dueDate: true,
        totalCents: true, paidCents: true,
        supplier: { select: { name: true } },
      },
    })

    const bucketize = (days: number): 'current' | '1_30' | '31_60' | '61_90' | '90_plus' => {
      if (days <= 0) return 'current'
      if (days <= 30) return '1_30'
      if (days <= 60) return '31_60'
      if (days <= 90) return '61_90'
      return '90_plus'
    }

    type Bucket = { current: number; '1_30': number; '31_60': number; '61_90': number; '90_plus': number; total: number; bills: number }
    const bySupplier = new Map<string, { supplierName: string } & Bucket>()

    let total: Bucket = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0, bills: 0 }

    for (const b of open) {
      const remainingCents = b.totalCents - b.paidCents
      if (remainingCents <= 0) continue
      const daysPastDue = Math.floor((now.getTime() - b.dueDate.getTime()) / 86_400_000)
      const bucket = bucketize(daysPastDue)
      const slot = bySupplier.get(b.supplierId) ?? {
        supplierName: b.supplier.name, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, total: 0, bills: 0,
      }
      slot[bucket]   += remainingCents
      slot.total     += remainingCents
      slot.bills     += 1
      bySupplier.set(b.supplierId, slot)

      total[bucket]  += remainingCents
      total.total    += remainingCents
      total.bills    += 1
    }

    const bySupplierArr = Array.from(bySupplier.entries()).map(([supplierId, v]) => ({ supplierId, ...v }))
      .sort((a, b) => b.total - a.total)

    return { bySupplier: bySupplierArr, total, asOf: now.toISOString() }
  })

  fastify.get<{ Querystring: { supplierId?: string; status?: string; overdue?: string } }>(
    '/bills',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantWhere = await supplierTenantFilter(req)
      return prisma.supplierBill.findMany({
        where: {
          supplier: tenantWhere,
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status     && { status: req.query.status }),
          ...(req.query.overdue === 'true' && {
            status:  { in: ['open', 'partially_paid'] },
            dueDate: { lt: new Date() },
          }),
        },
        include: { supplier: { select: { name: true } }, po: { select: { id: true, reference: true } } },
        orderBy: { billDate: 'desc' },
        take: 200,
      })
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/bills/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const bill = await prisma.supplierBill.findUnique({
        where: { id: req.params.id },
        include: {
          supplier: true,
          po:       true,
          lines:    { include: { inventoryItem: true, poLine: { include: { inventoryItem: true } } } },
          applications: { include: { payment: true } },
        },
      })
      if (!bill) throw new NotFoundError('SupplierBill', req.params.id)
      await assertSupplierAccess(req, bill.supplierId)
      return bill
    },
  )

  fastify.post('/bills', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = billCreateSchema.parse(req.body)
    await assertSupplierAccess(req, body.supplierId)
    const bill = await createBill({ ...body, createdBy: req.staffUser!.id })
    const { postSupplierBill } = await import('../accounting/supplierPosting.js')
    postSupplierBill(bill.id).catch((err) =>
      req.log.error({ err: (err as Error).message, billId: bill.id }, 'postSupplierBill failed'),
    )
    return reply.status(201).send(bill)
  })

  // Bill guard — used by void / match / payment-allocate. Looks up the bill,
  // hands off to assertSupplierAccess via supplier relation.
  async function guardBill(req: FastifyRequest, billId: string) {
    const bill = await prisma.supplierBill.findUnique({ where: { id: billId }, select: { supplierId: true } })
    if (!bill) throw new NotFoundError('SupplierBill', billId)
    await assertSupplierAccess(req, bill.supplierId)
  }

  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/bills/:id/void',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      await guardBill(req, req.params.id)
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      const result = await voidBill(req.params.id, req.staffUser!.id, reason)
      const { postSupplierBillVoid } = await import('../accounting/supplierPosting.js')
      postSupplierBillVoid(req.params.id, reason).catch((err) =>
        req.log.error({ err: (err as Error).message, billId: req.params.id }, 'postSupplierBillVoid failed'),
      )
      return result
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/bills/:id/match',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => { await guardBill(req, req.params.id); return matchBill(req.params.id) },
  )

  // ── Supplier Payments ──────────────────────────────────────────────────────

  fastify.get<{ Querystring: { supplierId?: string } }>(
    '/payments',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantWhere = await supplierTenantFilter(req)
      return prisma.supplierPayment.findMany({
        where: {
          supplier: tenantWhere,
          ...(req.query.supplierId ? { supplierId: req.query.supplierId } : {}),
        },
        include: {
          supplier:     { select: { name: true } },
          applications: { include: { bill: { select: { billNumber: true, totalCents: true } } } },
        },
        orderBy: { paymentDate: 'desc' },
        take: 200,
      })
    },
  )

  fastify.post('/payments', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = paymentCreateSchema.parse(req.body)
    await assertSupplierAccess(req, body.supplierId)
    const payment = await createPayment({ ...body, createdBy: req.staffUser!.id })
    const { postSupplierPayment } = await import('../accounting/supplierPosting.js')
    postSupplierPayment(payment.id).catch((err) =>
      req.log.error({ err: (err as Error).message, paymentId: payment.id }, 'postSupplierPayment failed'),
    )
    return reply.status(201).send(payment)
  })

  fastify.post<{ Params: { id: string }; Body: { applications: Array<{ billId: string; amountAppliedCents: number }> } }>(
    '/payments/:id/allocate',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const payment = await prisma.supplierPayment.findUnique({ where: { id: req.params.id }, select: { supplierId: true } })
      if (!payment) throw new NotFoundError('SupplierPayment', req.params.id)
      await assertSupplierAccess(req, payment.supplierId)
      const body = z.object({ applications: z.array(paymentApplicationSchema).min(1) }).parse(req.body)
      return allocatePayment(req.params.id, body.applications)
    },
  )

  // ── Aging + reorder + price history ────────────────────────────────────────
  //
  // agingReport / reorderSuggestions are implemented in service.ts and don't
  // currently take a tenant filter. Wrapping them here would require lifting
  // the filter into the service signature — left as a follow-up. For now
  // they still aggregate across tenants; only managers can see them.

  fastify.get('/aging', { preHandler: requireAuth(...MANAGERS) }, async () => agingReport())

  fastify.get('/reorder', { preHandler: requireAuth(...MANAGERS) }, async () => reorderSuggestions())

  fastify.get<{ Querystring: { itemId?: string; supplierId?: string; limit?: string } }>(
    '/price-history',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      // Scope via the supplier relation when present. Rows with a null
      // supplierId (manual price entries unscoped to a vendor) still come
      // through — those are tenant-agnostic.
      const tenantWhere = await supplierTenantFilter(req)
      return prisma.itemPriceHistory.findMany({
        where: {
          OR: [
            { supplier: tenantWhere },
            { supplierId: null },
          ],
          ...(req.query.itemId     && { inventoryItemId: req.query.itemId }),
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
        },
        include: {
          inventoryItem: { select: { name: true, unit: true } },
          supplier:      { select: { name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: limit,
      })
    },
  )

  // ── Approvals queue ────────────────────────────────────────────────────────

  fastify.get('/approvals', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const tenantWhere = await supplierTenantFilter(req)
    return prisma.purchaseOrder.findMany({
      where: { status: 'pending_approval', supplier: tenantWhere },
      include: {
        supplier: { select: { name: true } },
        lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    })
  })

  // ── Settings: approval threshold ───────────────────────────────────────────

  fastify.get('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const row = await prisma.setting.findUnique({ where: { key: 'procurement.approvalThresholdCents' } })
    return { thresholdCents: row?.value ? parseInt(row.value, 10) : 5_000_000 }
  })

  fastify.put('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const { thresholdCents } = z.object({ thresholdCents: z.number().int().nonnegative() }).parse(req.body)
    await prisma.setting.upsert({
      where:  { key: 'procurement.approvalThresholdCents' },
      create: { key: 'procurement.approvalThresholdCents', value: String(thresholdCents) },
      update: { value: String(thresholdCents) },
    })
    return { thresholdCents }
  })
}
