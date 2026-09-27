import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF, FINANCE_TEAM } from '../auth/middleware.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { NotFoundError, AppError, ForbiddenError } from '../../lib/errors.js'
import { supplierScopeWhere, findSupplierInScope, activeTenantOr422 } from './scope.js'

// Company scope: every procurement row belongs to its supplier's company, so
// every route below scopes through the supplier (./scope.ts). Reads use
// 'read' (view-aware); anything that changes a supplier or attaches a new row
// to one uses 'write' (a company the operator belongs to). An operator with
// no company sees and touches nothing. Foreign ids are 404.
import {
  createPo, submitPo, approvePo, rejectPo, cancelPo, sendPoToSupplier,
  createBill, voidBill, matchBill,
  createPayment, allocatePayment,
  agingReport, supplierAging, reorderSuggestions,
  getApprovalThresholdCents, setApprovalThresholdCents,
} from './service.js'
import { receiveGoods } from './receiving.js'
import { syncSupplierOpeningBalance } from './openingBalance.js'

// Post a supplier's opening balance to its company's ledger (a delta — see
// openingBalance.ts). A failure (e.g. the month is locked) is logged; the AP
// aging shows the amount as openingUnpostedCents until it posts.
async function syncOpening(req: FastifyRequest, supplierId: string) {
  try {
    await syncSupplierOpeningBalance(supplierId, { postedBy: req.staffUser?.id })
  } catch (err) {
    req.log.error({ err: (err as Error).message, supplierId }, 'syncSupplierOpeningBalance failed')
  }
}

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
    const tenantWhere = await supplierScopeWhere(req, 'read')
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
      // Explicit company picker from the Add Supplier modal. In portfolio
      // view the frontend renders a required dropdown so the CEO doesn't
      // have to bounce out of portfolio to add suppliers per company.
      // Falls back to req.staffUser.tenantId when omitted.
      tenantId:            z.string().min(1).optional(),
    }).parse(req.body)

    // A new supplier always belongs to a company: the picked one (which must
    // be one of the operator's) or the active one. Never a company-less row —
    // that used to happen for staff with no company, and an orphan is visible
    // to every company.
    let tenantId: string
    try {
      tenantId = activeTenantOr422(req, body.tenantId ?? null)
    } catch (err) {
      if ((err as AppError).code === 'COMPANY_NOT_ALLOWED') {
        throw new ForbiddenError('You can only create a supplier inside a company you belong to.')
      }
      throw err
    }

    // Strip body.tenantId before spreading — Prisma needs the resolved value,
    // not the body field which may be undefined.
    const { tenantId: _bodyTenantId, ...rest } = body
    const supplier = await prisma.supplier.create({
      data: { ...rest, tenantId },
      include: {
        assignedStaff: { select: { id: true, name: true } },
        tenant:        { select: { id: true, name: true, slug: true } },
      },
    })
    if (supplier.openingBalanceCents !== 0) await syncOpening(req, supplier.id)
    return reply.status(201).send(supplier)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/suppliers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const existing = await findSupplierInScope(req, req.params.id, 'write')
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
        tenantId:            z.string().min(1).nullable().optional(),
        paymentTermsDays:    z.number().int().min(0).max(365).optional(),
        leadTimeDays:        z.number().int().min(0).max(365).optional(),
        openingBalanceCents: z.number().int().nonnegative().optional(),
      }).parse(req.body)
      // A supplier moves between the operator's companies, never out of them:
      // clearing its company would make it (and its POs, bills and threads)
      // visible to every company.
      if (body.tenantId === null) {
        throw new AppError('SUPPLIER_COMPANY_REQUIRED', 'A supplier must belong to a company', 422)
      }
      if (body.tenantId && !req.staffUser!.memberTenantIds.includes(body.tenantId)) {
        throw new ForbiddenError('You can only transfer a supplier into a company you belong to.')
      }
      // The assigned buyer must work for the supplier's company.
      const targetTenant = body.tenantId ?? existing.tenantId
      if (body.assignedStaffId && targetTenant) {
        const staff = await prisma.user.findFirst({
          where: {
            id: body.assignedStaffId,
            deletedAt: null,
            OR: [{ tenantId: targetTenant }, { tenantMemberships: { some: { tenantId: targetTenant } } }],
          },
          select: { id: true },
        })
        if (!staff) throw new AppError('STAFF_NOT_IN_COMPANY', 'That staff member does not work for this supplier\'s company', 422)
      }
      const updated = await prisma.supplier.update({
        where: { id: req.params.id },
        data:  body,
        include: {
          assignedStaff: { select: { id: true, name: true } },
          tenant:        { select: { id: true, name: true, slug: true } },
        },
      })
      // A new opening balance, or a move to another company, re-posts it.
      if (body.openingBalanceCents !== undefined || body.tenantId !== undefined) {
        await syncOpening(req, updated.id)
      }
      return updated
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/suppliers/:id/statement',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const supplier = await findSupplierInScope(req, req.params.id, 'read')
      const [bills, payments, aging] = await Promise.all([
        prisma.supplierBill.findMany({ where: { supplierId: req.params.id }, orderBy: { billDate: 'desc' } }),
        prisma.supplierPayment.findMany({ where: { supplierId: req.params.id }, orderBy: { paymentDate: 'desc' }, include: { applications: true } }),
        supplierAging(req.params.id),
      ])
      // ONE balance, the AP aging row's total: open bills net of withholding
      // plus the posted opening balance, less unapplied payments — which is
      // this supplier's AP 2010 balance in the ledger. The opening balance is
      // counted once, inside it (openingBalance.ts posts it).
      const outstanding = aging?.total ?? 0
      return {
        supplier,
        outstanding,
        ledgerOutstanding: outstanding,   // same figure; kept for older clients
        openingBalanceCents: supplier.openingBalanceCents,
        openingUnpostedCents: aging?.openingUnpostedCents ?? 0,
        aging,
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
      const tenantWhere = await supplierScopeWhere(req, 'read')
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
      const po = await prisma.purchaseOrder.findFirst({
        where: { id: req.params.id, supplier: await supplierScopeWhere(req, 'read') },
        include: {
          supplier:    { include: { tenant: { select: { id: true, name: true, slug: true } } } },
          lines:       { include: { inventoryItem: true, discrepancies: true } },
          activityLog: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
          bills:       true,
        },
      })
      if (!po) throw new NotFoundError('PurchaseOrder', req.params.id)
      return po
    },
  )

  fastify.post('/purchase-orders', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = poCreateSchema.parse(req.body)
    // Don't let the operator post a PO against a supplier they can't see.
    // createPo then checks every line's item is the supplier's company's.
    await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    const po = await createPo({ ...body, createdBy: req.staffUser!.id })
    return reply.status(201).send(po)
  })

  // Helper used by every PO lifecycle endpoint: the PO, through its
  // supplier's company, or 404.
  async function guardPo(req: FastifyRequest, poId: string) {
    const po = await prisma.purchaseOrder.findFirst({
      where:  { id: poId, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true },
    })
    if (!po) throw new NotFoundError('PurchaseOrder', poId)
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

  // Receive against a PO — the same receiveGoods() the dock page
  // (POST /crosschecks/receiving) calls: writes the GoodsReceipt, the PO line
  // quantities, stock and moving-average cost in one transaction, with the
  // photo threshold and the raiser-can't-receive rule (CEO exempt).
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await guardPo(req, req.params.id)
      const body = z.object({
        photoUrl: z.string().url().nullable().optional(),
        notes:    z.string().max(500).nullable().optional(),
        lines: z.array(z.object({
          poLineId:           z.string().uuid(),
          quantityReceived:   z.number().min(0),
          discrepancyReason:  z.enum(['short_shipment', 'over_shipment', 'damaged', 'wrong_item', 'quality_issue']).optional(),
          // `discrepancyNotes` is the older name for the line note.
          discrepancyNotes:   z.string().max(200).optional(),
          notes:              z.string().max(200).nullable().optional(),
        })).min(1),
      }).parse(req.body)
      const result = await receiveGoods({
        actor:    req.staffUser!,
        poId:     req.params.id,
        photoUrl: body.photoUrl ?? null,
        notes:    body.notes ?? null,
        lines:    body.lines.map((l) => ({
          poLineId:          l.poLineId,
          quantityReceived:  l.quantityReceived,
          discrepancyReason: l.discrepancyReason ?? null,
          notes:             l.notes ?? l.discrepancyNotes ?? null,
        })),
      })
      return reply.status(201).send({ ok: true, status: result.poStatus, receipt: result.receipt, flagged: result.flagged })
    },
  )

  // ── Bills (AP) ─────────────────────────────────────────────────────────────

  // GET /procurement/ap-aging — THE accounts-payable aging (service.ts
  // agingReport): net of withholding, by due date, unapplied payments as
  // credits, opening balances on their own, suppliers with no company apart.
  // Behind the Accounting AP aging page and the Procurement Aging tab; open to
  // finance as well as managers (module: procurement OR accounting).
  fastify.get('/ap-aging', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return agingReport(scope.tenantIds)
  })

  fastify.get<{ Querystring: { supplierId?: string; status?: string; overdue?: string } }>(
    '/bills',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantWhere = await supplierScopeWhere(req, 'read')
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
      const bill = await prisma.supplierBill.findFirst({
        where: { id: req.params.id, supplier: await supplierScopeWhere(req, 'read') },
        include: {
          supplier: true,
          po:       true,
          lines:    { include: { inventoryItem: true, poLine: { include: { inventoryItem: true } } } },
          applications: { include: { payment: true } },
        },
      })
      if (!bill) throw new NotFoundError('SupplierBill', req.params.id)
      return bill
    },
  )

  fastify.post('/bills', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = billCreateSchema.parse(req.body)
    // createBill then checks the PO, PO lines and items are this supplier's.
    await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    const bill = await createBill({ ...body, createdBy: req.staffUser!.id })
    const { postSupplierBill } = await import('../accounting/supplierPosting.js')
    postSupplierBill(bill.id).catch((err) =>
      req.log.error({ err: (err as Error).message, billId: bill.id }, 'postSupplierBill failed'),
    )
    return reply.status(201).send(bill)
  })

  // Bill guard — used by void / match / payment-allocate. Looks up the bill,
  // scopes it through its supplier's company (404 when foreign).
  async function guardBill(req: FastifyRequest, billId: string) {
    const bill = await prisma.supplierBill.findFirst({
      where:  { id: billId, supplier: await supplierScopeWhere(req, 'write') },
      select: { id: true },
    })
    if (!bill) throw new NotFoundError('SupplierBill', billId)
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
      const tenantWhere = await supplierScopeWhere(req, 'read')
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
    // createPayment then checks every applied bill is this supplier's.
    await findSupplierInScope(req, body.supplierId, 'write', { live: true })
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
      const payment = await prisma.supplierPayment.findFirst({
        where:  { id: req.params.id, supplier: await supplierScopeWhere(req, 'write') },
        select: { id: true },
      })
      if (!payment) throw new NotFoundError('SupplierPayment', req.params.id)
      const body = z.object({ applications: z.array(paymentApplicationSchema).min(1) }).parse(req.body)
      return allocatePayment(req.params.id, body.applications)
    },
  )

  // ── Aging + reorder + price history ────────────────────────────────────────

  fastify.get('/reorder', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return reorderSuggestions(scope.tenantIds)
  })

  fastify.get<{ Querystring: { itemId?: string; supplierId?: string; limit?: string } }>(
    '/price-history',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      // Anchored on the item (company master data): only this company's
      // items' prices, and — when a supplier is on the row — only a supplier
      // in scope. A row with no supplier (a manual cost edit) is the item's
      // company's; it used to come through for every company.
      const itemWhere     = await scopeTenantWhere(req, 'read')
      const supplierWhere = await supplierScopeWhere(req, 'read')
      return prisma.itemPriceHistory.findMany({
        where: {
          inventoryItem: itemWhere,
          OR: [
            { supplier: supplierWhere },
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
    const tenantWhere = await supplierScopeWhere(req, 'read')
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

  // Per company: `procurement.approvalThresholdCents:<tenantId>`, read with
  // the old company-less key as the fallback until the company saves its own
  // (service.ts getApprovalThresholdCents). It used to be one global row, so
  // one company's admin changed every company's approval limit.
  const thresholdQuery = z.object({ tenantId: z.string().min(1).optional() })

  fastify.get('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const tenantId = activeTenantOr422(req, thresholdQuery.parse(req.query ?? {}).tenantId ?? null)
    return { tenantId, thresholdCents: await getApprovalThresholdCents(tenantId) }
  })

  fastify.put('/settings/approval-threshold', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const { thresholdCents, tenantId: picked } = z.object({
      thresholdCents: z.number().int().nonnegative(),
      tenantId:       z.string().min(1).optional(),
    }).parse(req.body)
    const tenantId = activeTenantOr422(req, picked ?? null)
    await setApprovalThresholdCents(tenantId, thresholdCents)
    return { tenantId, thresholdCents }
  })
}
