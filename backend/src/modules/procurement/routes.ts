import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF, FINANCE_TEAM, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { NotFoundError, AppError, ForbiddenError } from '../../lib/errors.js'
import { supplierScopeWhere, findSupplierInScope, activeTenantOr422 } from './scope.js'
import type { UserRole } from '@prisma/client'

// Company scope: every procurement row belongs to its supplier's company, so
// every route below scopes through the supplier (./scope.ts). Reads use
// 'read' (view-aware); anything that changes a supplier or attaches a new row
// to one uses 'write' (a company the operator belongs to). An operator with
// no company sees and touches nothing. Foreign ids are 404.
//
// Who (role gate; module 'procurement' is enforced on top by moduleAccess):
//   PROCUREMENT_TEAM (managers + the buyer role 'procurement'): suppliers,
//     POs (raise / submit / send / mark sent / cancel), and READ access to
//     bills, payments, the 3-way match, AP aging, reorder and price history.
//     The buyer role holds the procurement module, so these used to load the
//     page and then 403 on every PO, bill and reorder call.
//   MANAGERS: receiving (receiveGoods' own rule), recording / voiding bills,
//     paying and allocating, a supplier's opening balance or company move —
//     money moves and the books, kept apart from whoever raised the order.
//   ADMIN_ONLY: approve / reject, the approval threshold, the backfill.
//   AP_READERS (PROCUREMENT_TEAM + finance, wave 3 UI-07): READ the payables
//     — supplier list (every supplier of the company, not just assigned
//     ones), supplier statements, POs, bills, the 3-way match and supplier
//     payments. Finance owns the books (Accounting → AP aging, petty cash
//     paying a bill) but holds no 'procurement' module; the module gate on
//     these read paths must admit 'accounting' as well (lib/moduleAccess.ts
//     GATED_PREFIXES — as /procurement/ap-aging already does). Finance
//     raises, approves, receives, bills and pays NOTHING here — those stay
//     with the roles above.
import {
  createPo, submitPo, approvePo, rejectPo, cancelPo, sendPoToSupplier, markPoSent,
  createBill, voidBill, matchBill,
  createPayment, allocatePayment,
  agingReport, supplierAging, reorderSuggestions,
  getApprovalThresholdCents, setApprovalThresholdCents,
  MAX_AMOUNT_CENTS, amountTooLargeError,
} from './service.js'
import { receiveGoods } from './receiving.js'
import { syncSupplierOpeningBalance } from './openingBalance.js'
import { postSupplierBill, postSupplierPayment } from '../accounting/supplierPosting.js'

const AP_READERS = Array.from(new Set([...PROCUREMENT_TEAM, 'finance'])) as UserRole[]

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

// A money input in paisa that fits a money column (INT4, at most
// PKR 21,474,836.47). Above that it is 422 AMOUNT_TOO_LARGE with a plain
// message, not a raw 500 at insert (BOOKS-06 follow-up). Computed totals
// (quantity × unit cost, bill and PO totals) are checked in service.ts.
const cents = (what: string, opts: { positive?: boolean } = {}) => {
  const base = opts.positive ? z.number().int().positive() : z.number().int().nonnegative()
  return base.transform((v) => {
    if (v > MAX_AMOUNT_CENTS) throw amountTooLargeError(what, v)
    return v
  })
}

const poLineSchema = z.object({
  inventoryItemId: z.string().uuid(),
  quantityOrdered: z.number().positive().finite(),
  unitCostCents:   cents('A unit cost'),
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
  quantity:        z.number().positive().finite(),
  unitCostCents:   cents('A unit cost'),
})

const billCreateSchema = z.object({
  supplierId:    z.string().uuid(),
  poId:          z.string().uuid().optional().nullable(),
  billNumber:    z.string().min(1),
  billDate:      z.string(),
  dueDate:       z.string().optional().nullable(),
  taxCents:      cents('The bill\'s tax').optional(),
  notes:         z.string().optional().nullable(),
  attachmentUrl: z.string().optional().nullable(),
  lines:         z.array(billLineSchema).min(1),
})

const paymentApplicationSchema = z.object({
  billId:             z.string().uuid(),
  amountAppliedCents: cents('An amount applied to a bill', { positive: true }),
})

const paymentCreateSchema = z.object({
  supplierId:   z.string().uuid(),
  paymentDate:  z.string(),
  method:       z.enum(['cash', 'bank_transfer', 'cheque', 'wallet']),
  reference:    z.string().optional().nullable(),
  amountCents:  cents('This payment', { positive: true }),
  notes:        z.string().optional().nullable(),
  applications: z.array(paymentApplicationSchema).optional(),
})

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function procurementRoutes(fastify: FastifyInstance) {
  // ── Suppliers ──────────────────────────────────────────────────────────────

  fastify.get('/suppliers', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = req.staffUser!
    // Finance reads every supplier of its companies (AP), as the buyer does.
    const isManager = ['admin', 'manager', 'management', 'foh_management', 'boh_management', 'procurement', 'finance'].includes(user.role)
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

  // A supplier's opening balance posts to the ledger (Dr 3020 / Cr 2010) and a
  // company move carries its POs and bills with it — managers only. The buyer
  // can add and edit everything else (the edit form re-sends both unchanged,
  // so only a CHANGE is refused).
  const assertManagerFields = (
    req: FastifyRequest,
    body: { openingBalanceCents?: number; tenantId?: string | null },
    existing: { openingBalanceCents: number; tenantId: string | null } | null,
  ) => {
    if ((MANAGERS as string[]).includes(req.staffUser!.role)) return
    if (body.openingBalanceCents !== undefined && body.openingBalanceCents !== (existing?.openingBalanceCents ?? 0)) {
      throw new ForbiddenError('Only a manager can set a supplier\'s opening balance.')
    }
    if (existing && body.tenantId !== undefined && body.tenantId !== existing.tenantId) {
      throw new ForbiddenError('Only a manager can move a supplier to another company.')
    }
  }

  fastify.post('/suppliers', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req, reply) => {
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
      openingBalanceCents: cents('The opening balance').optional(),
      // Explicit company picker from the Add Supplier modal. In portfolio
      // view the frontend renders a required dropdown so the CEO doesn't
      // have to bounce out of portfolio to add suppliers per company.
      // Falls back to req.staffUser.tenantId when omitted.
      tenantId:            z.string().min(1).optional(),
    }).parse(req.body)
    assertManagerFields(req, body, null)

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
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
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
        openingBalanceCents: cents('The opening balance').optional(),
      }).parse(req.body)
      assertManagerFields(req, body, existing)
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
    { preHandler: requireAuth(...AP_READERS) },
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
    { preHandler: requireAuth(...AP_READERS) },
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
    { preHandler: requireAuth(...AP_READERS) },
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

  fastify.post('/purchase-orders', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req, reply) => {
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
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
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
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      await guardPo(req, req.params.id)
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      return cancelPo(req.params.id, req.staffUser!.id, reason)
    },
  )

  // Send an approved PO: email and/or WhatsApp. 'sent' only when it went out.
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/send',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => { await guardPo(req, req.params.id); return sendPoToSupplier(req.params.id, req.staffUser!.id) },
  )

  // The buyer sent it themselves (phone, own WhatsApp, in person) — record how.
  fastify.post<{ Params: { id: string } }>(
    '/purchase-orders/:id/mark-sent',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
    async (req) => {
      await guardPo(req, req.params.id)
      const body = z.object({
        channel: z.enum(['phone', 'whatsapp', 'email', 'in_person']),
        note:    z.string().max(200).nullable().optional(),
      }).parse(req.body ?? {})
      return markPoSent(req.params.id, req.staffUser!.id, body)
    },
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
  fastify.get('/ap-aging', { preHandler: requireAuth(...FINANCE_TEAM, 'procurement') }, async (req) => {
    const scope = await resolveTenantScope(req)
    return agingReport(scope.tenantIds)
  })

  fastify.get<{ Querystring: { supplierId?: string; status?: string; overdue?: string } }>(
    '/bills',
    { preHandler: requireAuth(...AP_READERS) },
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
    { preHandler: requireAuth(...AP_READERS) },
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
    // createBill then checks the PO, PO lines and items are this supplier's,
    // and posts the bill in the same transaction that saves it (a closed
    // month is PERIOD_LOCKED 422 — nothing saved half-way).
    await findSupplierInScope(req, body.supplierId, 'write', { live: true })
    const bill = await createBill({ ...body, createdBy: req.staffUser!.id })
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

  // Read-only views of a bill (the 3-way match) scope like the bill list.
  async function guardBillRead(req: FastifyRequest, billId: string) {
    const bill = await prisma.supplierBill.findFirst({
      where:  { id: billId, supplier: await supplierScopeWhere(req, 'read') },
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
      // The ledger reversal commits with the void (service.ts voidBill).
      return voidBill(req.params.id, req.staffUser!.id, reason)
    },
  )

  fastify.get<{ Params: { id: string } }>(
    '/bills/:id/match',
    { preHandler: requireAuth(...AP_READERS) },
    async (req) => { await guardBillRead(req, req.params.id); return matchBill(req.params.id) },
  )

  // ── Supplier Payments ──────────────────────────────────────────────────────

  fastify.get<{ Querystring: { supplierId?: string } }>(
    '/payments',
    { preHandler: requireAuth(...AP_READERS) },
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
    // Posted in the same transaction (service.ts createPaymentTx): a payment
    // dated in a closed month is PERIOD_LOCKED 422 and is not saved.
    const payment = await createPayment({ ...body, createdBy: req.staffUser!.id })
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

  fastify.get('/reorder', { preHandler: requireAuth(...PROCUREMENT_TEAM) }, async (req) => {
    const scope = await resolveTenantScope(req)
    return reorderSuggestions(scope.tenantIds)
  })

  fastify.get<{ Querystring: { itemId?: string; supplierId?: string; limit?: string } }>(
    '/price-history',
    { preHandler: requireAuth(...PROCUREMENT_TEAM) },
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

  // ── Backfill: bills / payments that never reached the ledger ───────────────

  // POST /procurement/post-unposted — bills and payments saved before posting
  // moved into the save's transaction, whose after-commit post failed (most
  // often a closed month). Admin; dry run by default. Each posts in its own
  // transaction at its own date; one in a closed month is listed with the
  // reason, never forced into another period.
  fastify.post('/post-unposted', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ dryRun: z.boolean().default(true) }).parse(req.body ?? {})
    const tenantIds = (await resolveTenantScope(req)).tenantIds
    if (tenantIds.length === 0) return { dryRun: body.dryRun, rows: [] }
    const [bills, payments, entries] = await Promise.all([
      prisma.supplierBill.findMany({
        where:   { status: { notIn: ['void', 'draft'] }, supplier: { tenantId: { in: tenantIds } } },
        select:  { id: true, billNumber: true, billDate: true, totalCents: true, subtotalCents: true, taxCents: true, supplier: { select: { name: true, tenantId: true } } },
        orderBy: { billDate: 'asc' },
      }),
      prisma.supplierPayment.findMany({
        where:   { supplier: { tenantId: { in: tenantIds } } },
        select:  { id: true, paymentDate: true, amountCents: true, supplier: { select: { name: true, tenantId: true } } },
        orderBy: { paymentDate: 'asc' },
      }),
      prisma.journalEntry.findMany({
        where:  { tenantId: { in: tenantIds }, reference: { startsWith: 'supplier.' } },
        select: { tenantId: true, reference: true },
      }),
    ])
    const onBooks = new Set(entries.map((e) => `${e.tenantId}|${e.reference}`))
    type Row = { kind: 'bill' | 'payment'; id: string; label: string; date: Date; amountCents: number; outcome: string }
    const rows: Row[] = []
    const run = async (row: Omit<Row, 'outcome'>, ref: string, tenantId: string, post: () => Promise<{ posted: boolean; reason?: string }>) => {
      if (onBooks.has(`${tenantId}|${ref}`)) return
      if (body.dryRun) { rows.push({ ...row, outcome: 'would_post' }); return }
      try {
        const r = await post()
        rows.push({ ...row, outcome: r.posted ? 'posted' : (r.reason ?? 'skipped') })
      } catch (err) {
        const e = err as AppError
        rows.push({ ...row, outcome: `${e.code ?? 'error'}: ${e.message}` })
      }
    }
    for (const b of bills) {
      if (b.subtotalCents === 0 && b.taxCents === 0) continue
      await run({ kind: 'bill', id: b.id, label: `${b.supplier.name} bill ${b.billNumber}`, date: b.billDate, amountCents: b.totalCents },
        `supplier.bill:${b.id}`, b.supplier.tenantId!, () => postSupplierBill(b.id))
    }
    for (const p of payments) {
      await run({ kind: 'payment', id: p.id, label: `Payment to ${p.supplier.name}`, date: p.paymentDate, amountCents: p.amountCents },
        `supplier.payment:${p.id}`, p.supplier.tenantId!, () => postSupplierPayment(p.id))
    }
    return { dryRun: body.dryRun, rows }
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
      thresholdCents: cents('The approval limit'),
      tenantId:       z.string().min(1).optional(),
    }).parse(req.body)
    const tenantId = activeTenantOr422(req, picked ?? null)
    await setApprovalThresholdCents(tenantId, thresholdCents)
    return { tenantId, thresholdCents }
  })
}
