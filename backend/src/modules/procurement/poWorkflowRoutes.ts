// Routes of the PO → GRN workflow (owner, 2026-11-05; contract: ./poWorkflow.ts). Registered from procurementRoutes
// (prefix /procurement), so every path below is under /procurement and Module Access applies
// (lib/moduleAccess.ts GATED_PREFIXES: /procurement/purchase-orders and /procurement/my-tasks need 'procurement';
// /procurement/grns admits 'procurement' or 'accounting' — finance verifies GRNs with 'accounting').
//
//   PUT  /purchase-orders/:id/buyer            {buyerUserId}                         the CEO only
//   GET  /purchase-orders/:id/buyer-options    the logins the CEO may name as the buyer (the CEO only)
//   POST /purchase-orders/:id/complete         {invoiceNumber, invoiceDate, lines?, note?}   the PO's buyer (or the CEO)
//   POST /purchase-orders/:id/confirm-receipt  {lines:[{poLineId, quantityReceived}], locationId?, notes?}  the requester (or the CEO)
//   POST /purchase-orders/:id/reject-receipt   {note ≥10}                            the requester (or the CEO)
//   GET  /my-tasks                             → { toBuy, toConfirm, toFix } — only the caller's own
//   GET  /grns?status=&poId=&queue=finance|ceo  list (queue = the caller's approval queue, for the inbox)
//   GET  /grns/:id                             detail: PO lines ordered vs received vs invoiced, files, bill
//   POST /grns/:id/finance-pass {note?}        finance (accounting) — never the requester / buyer
//   POST /grns/:id/return       {note ≥10}     finance at finance_review, the CEO at either step → buyer_fix
//   POST /grns/:id/resubmit     {invoiceNumber?, invoiceDate?, lines?, note?}   the buyer (or the CEO)
//   POST /grns/:id/approve                     the CEO → the supplier bill
//
// Company: every id is resolved in the caller's companies first (another company's → 404).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { APPROVAL_RIGHTS, approvalInputOf, approvalSubject, assertCanApprove, auditApproval, type ApprovalGrant } from '../../lib/approvalRights.js'
import { requireModule } from '../notifications/requireModule.js'
import { toCents, zMoneyCents } from '../../lib/money.js'
import { TAX_AUTHORITY_KEYS } from '../accounting/taxAuthorities.js'
import { lineDisplay, lineValueCents } from './poUnits.js'
import { scopeTenantIds } from './scope.js'
import { AP_READERS } from './routes.js'
import {
  setPoBuyer, completePo, confirmReceipt, rejectReceipt, grnFinancePass, grnReturn, grnPullBack, grnResubmit, approveGrn, myTasks,
  assertNote, PO_FILE_OWNER,
} from './poWorkflow.js'

type GuardPo = (req: FastifyRequest, poId: string) => Promise<{ id: string; status: string; createdBy: string | null; supplier: { tenantId: string | null } }>

const zRate = z.object({ poLineId: z.string().uuid(), rateCents: z.number().int().min(0) })
const zYmd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD')
const financeAccounting = requireModule('accounting')

export async function registerPoWorkflowRoutes(fastify: FastifyInstance, deps: { guardPo: GuardPo }): Promise<void> {
  const { guardPo } = deps
  const actorOf = (req: FastifyRequest) => ({ id: req.staffUser!.id, role: req.staffUser!.role as string })

  // ── Buyer ──────────────────────────────────────────────────────────────────

  fastify.put<{ Params: { id: string } }>('/purchase-orders/:id/buyer', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    await guardPo(req, req.params.id)
    const { buyerUserId } = z.object({ buyerUserId: z.string().min(1).max(64) }).parse(req.body ?? {})
    const r = await setPoBuyer(req.params.id, actorOf(req), buyerUserId)
    await audit({
      category: 'accounting', action: 'po.buyer_assigned', entity: 'PurchaseOrder', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
      before: { buyerUserId: r.from }, after: { buyerUserId: r.buyerUserId },
    })
    return { id: r.id, buyerUserId: r.buyerUserId }
  })

  // The logins the CEO may name as the buyer (approve dialog / reassign): active logins of the PO's company, buyers
  // ('procurement') first. The CEO only; another company's PO is 404.
  fastify.get<{ Params: { id: string } }>('/purchase-orders/:id/buyer-options', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const po = await guardPo(req, req.params.id)
    const tenantId = po.supplier.tenantId
    if (!tenantId) return []
    const users = await prisma.user.findMany({
      where: { deletedAt: null, isActive: true, accountStatus: 'active', OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
      select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' }, take: 500,
    })
    return users.sort((a, b) => Number(b.role === 'procurement') - Number(a.role === 'procurement'))
  })

  fastify.post<{ Params: { id: string } }>('/purchase-orders/:id/complete', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const po = await guardPo(req, req.params.id)
    const body = z.object({
      invoiceNumber: z.string().max(100),
      invoiceDate: zYmd,
      taxCents: zMoneyCents('The sales tax').nullable().optional(),
      taxAuthority: z.enum(TAX_AUTHORITY_KEYS).nullable().optional(),
      lines: z.array(zRate).max(200).optional(),
      note: z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const r = await completePo(po.id, actorOf(req), body)
    await audit({
      category: 'accounting', action: 'po.completed', entity: 'PurchaseOrder', entityId: po.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
      metadata: { invoiceNumber: r.invoiceNumber, invoiceDate: body.invoiceDate, taxCents: body.taxCents ?? null, taxAuthority: body.taxAuthority ?? null, rateChanges: r.rateChanges },
    })
    return { id: r.id, status: r.status, invoiceNumber: r.invoiceNumber, rateChanges: r.rateChanges }
  })

  // ── Requester ──────────────────────────────────────────────────────────────

  fastify.post<{ Params: { id: string } }>('/purchase-orders/:id/confirm-receipt', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const po = await guardPo(req, req.params.id)
    const body = z.object({
      lines: z.array(z.object({
        poLineId: z.string().uuid(),
        quantityReceived: z.number().min(0),
        useBy: zYmd.nullable().optional(),
        notes: z.string().max(200).nullable().optional(),
      })).min(1).max(200),
      locationId: z.string().min(1).nullable().optional(),
      notes: z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const r = await confirmReceipt(po.id, actorOf(req), body)
    await audit({
      category: 'accounting', action: 'po.receipt_confirmed', entity: 'PurchaseOrder', entityId: po.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: po.supplier.tenantId,
      metadata: { grnId: r.grn.id, grnNumber: r.grn.grnNumber, status: r.status },
    })
    return reply.status(201).send(r)
  })

  fastify.post<{ Params: { id: string } }>('/purchase-orders/:id/reject-receipt', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const po = await guardPo(req, req.params.id)
    const { note } = z.object({ note: z.string().max(500).nullable().optional() }).parse(req.body ?? {})
    const r = await rejectReceipt(po.id, actorOf(req), note ?? '')
    await audit({
      category: 'accounting', action: 'po.receipt_rejected', entity: 'PurchaseOrder', entityId: po.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: po.supplier.tenantId,
      metadata: { note: note?.trim() ?? null, status: r.status },
    })
    return r
  })

  // ── My tasks ───────────────────────────────────────────────────────────────

  fastify.get('/my-tasks', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const su = req.staffUser!
    const members = new Set(su.memberTenantIds ?? [])
    const ids = (await scopeTenantIds(req, 'read')).filter((t) => members.has(t) || su.role === 'admin')
    return myTasks(su.id, ids)
  })

  // ── GRNs ───────────────────────────────────────────────────────────────────

  /** The GRN, in the caller's companies (`mode`), or 404. */
  async function guardGrn(req: FastifyRequest, grnId: string, mode: 'read' | 'write') {
    const ids = await scopeTenantIds(req, mode)
    const g = await prisma.goodsReceipt.findFirst({ where: { id: grnId, grnNumber: { not: null }, tenantId: { in: ids } }, select: { id: true, tenantId: true, grnStatus: true, poId: true } })
    if (!g) throw new NotFoundError('GoodsReceipt', grnId)
    return g
  }

  /** The step's right (lib/approvalRights.ts grn_finance / grn): role, module, member, separation of duties. */
  async function grnRight(req: FastifyRequest, grnId: string, type: 'grn_finance' | 'grn', action: string): Promise<{ grant: ApprovalGrant; tenantId: string | null }> {
    const s = await approvalSubject(type, grnId)
    if (!s) throw new NotFoundError('GoodsReceipt', grnId)
    const su = req.staffUser!
    if (!s.companyIds.some((t) => (su.memberTenantIds ?? []).includes(t))) throw new NotFoundError('GoodsReceipt', grnId)
    if (!(APPROVAL_RIGHTS[type].roles as readonly string[]).includes(su.role)) {
      throw new AppError('GRN_STEP_NOT_YOURS', type === 'grn_finance' ? 'This GRN is waiting for finance' : 'This GRN is waiting for the CEO', 403)
    }
    if (su.role === 'finance') await financeAccounting(req)
    let grant: ApprovalGrant
    try {
      grant = await assertCanApprove(req, approvalInputOf(type, grnId, s, { entity: 'GoodsReceipt', action }))
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 404) throw new NotFoundError('GoodsReceipt', grnId)
      throw err
    }
    return { grant, tenantId: s.ownerTenantId }
  }

  /** List rows: the GRN, its supplier, its PO, the value booked at receipt and the value the bill will carry. */
  async function shapeGrns(rows: Array<Awaited<ReturnType<typeof readGrns>>[number]>, viewerId: string, viewerRole: string, queue: 'finance' | 'ceo' | null) {
    if (rows.length === 0) return []
    const poIds = [...new Set(rows.map((g) => g.poId!).filter(Boolean))]
    const [pos, entries, sups] = await Promise.all([
      prisma.purchaseOrder.findMany({ where: { id: { in: poIds } }, select: { id: true, reference: true, createdBy: true, buyerUserId: true, completedById: true, payByCash: true, status: true, lines: true } }),
      prisma.journalEntry.findMany({ where: { reference: { in: rows.map((g) => `procurement.receipt:${g.id}`) } }, select: { reference: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } } }),
      prisma.supplier.findMany({ where: { id: { in: [...new Set(rows.map((g) => g.supplierId))] } }, select: { id: true, name: true } }),
    ])
    const poById = new Map(pos.map((p) => [p.id, p]))
    const userIds = [...new Set(rows.flatMap((g) => { const p = poById.get(g.poId!); return [p?.createdBy, p?.buyerUserId, g.financeCheckedById, g.approvedById, g.receivedById] }).filter((x): x is string => !!x))]
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
    const nameOf = (id: string | null | undefined) => (id ? users.find((u) => u.id === id)?.name ?? null : null)
    const bills = await prisma.supplierBill.findMany({ where: { id: { in: rows.map((g) => g.supplierBillId).filter((x): x is string => !!x) } }, select: { id: true, billNumber: true, status: true, totalCents: true } })
    return rows.map((g) => {
      const po = poById.get(g.poId!) ?? null
      const je = entries.find((e) => e.reference === `procurement.receipt:${g.id}`)
      const valueCents = je ? je.lines.filter((l) => l.type === 'credit' && l.account.code === '2015').reduce((s, l) => s + toCents(l.amountCents), 0) : 0
      const invoicedCents = g.lines.reduce((s, l) => {
        const pl = po?.lines.find((x) => x.id === l.poLineId)
        return s + (pl ? lineValueCents({ quantityOrdered: l.receivedQty, unitCostCents: pl.unitCostCents, orderUnitFactor: pl.orderUnitFactor, orderUnitCostCents: pl.orderUnitCostCents }) : 0)
      }, 0)
      const own = viewerRole !== 'admin' && queue != null && [po?.createdBy, po?.buyerUserId, po?.completedById, ...(queue === 'ceo' ? [g.financeCheckedById] : [])].includes(viewerId)
      const bill = bills.find((b) => b.id === g.supplierBillId) ?? null
      return {
        id: g.id, tenantId: g.tenantId, grnNumber: g.grnNumber, grnStatus: g.grnStatus, invoiceNumber: g.invoiceNumber,
        invoiceDate: g.invoiceDate ? g.invoiceDate.toISOString().slice(0, 10) : null, receivedAt: g.receivedAt,
        returnNote: g.returnNote, returnCount: g.returnCount, financeCheckedById: g.financeCheckedById, financeCheckedAt: g.financeCheckedAt,
        approvedById: g.approvedById, approvedAt: g.approvedAt, supplierBillId: g.supplierBillId,
        bill: bill ? { ...bill, totalCents: toCents(bill.totalCents) } : null,
        valueCents, invoicedCents, own,
        invoiceTaxCents: g.invoiceTaxCents == null ? null : toCents(g.invoiceTaxCents), invoiceTaxAuthority: g.invoiceTaxAuthority,
        supplier: sups.find((s) => s.id === g.supplierId) ?? null,
        po: po ? { id: po.id, reference: po.reference, createdBy: po.createdBy, buyerUserId: po.buyerUserId, completedById: po.completedById, payByCash: po.payByCash, status: po.status } : null,
        names: { createdBy: nameOf(po?.createdBy), buyer: nameOf(po?.buyerUserId), receivedBy: nameOf(g.receivedById), financeChecked: nameOf(g.financeCheckedById), approvedBy: nameOf(g.approvedById) },
      }
    })
  }
  const readGrns = (where: Prisma.GoodsReceiptWhereInput) =>
    prisma.goodsReceipt.findMany({ where: { ...where, grnNumber: { not: null } }, include: { lines: true }, orderBy: { receivedAt: 'desc' }, take: 200 })

  fastify.get<{ Querystring: { status?: string; poId?: string; queue?: string } }>('/grns', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const su = req.staffUser!
    const q = z.object({
      status: z.enum(['finance_review', 'buyer_fix', 'ceo_review', 'approved']).optional(),
      poId: z.string().uuid().optional(),
      queue: z.enum(['finance', 'ceo']).optional(),
    }).parse(req.query ?? {})
    if (q.queue) {
      // The caller's own approval queue (the inbox reads it): the step's roles only, in their member companies.
      const type = q.queue === 'finance' ? 'grn_finance' : 'grn'
      if (!(APPROVAL_RIGHTS[type].roles as readonly string[]).includes(su.role)) throw new AppError('FORBIDDEN', 'Not your queue', 403)
      if (su.role === 'finance') await financeAccounting(req)
      const members = new Set(su.memberTenantIds ?? [])
      const ids = (await resolveTenantScope(req)).tenantIds.filter((t) => members.has(t))
      const rows = await readGrns({ tenantId: { in: ids }, grnStatus: q.queue === 'finance' ? 'finance_review' : 'ceo_review' })
      return shapeGrns(rows.reverse(), su.id, su.role, q.queue)
    }
    if (!(AP_READERS as readonly string[]).includes(su.role)) throw new AppError('FORBIDDEN', `Role '${su.role}' is not allowed for this resource`, 403)
    const ids = await scopeTenantIds(req, 'read')
    const rows = await readGrns({ tenantId: { in: ids }, ...(q.status ? { grnStatus: q.status } : {}), ...(q.poId ? { poId: q.poId } : {}) })
    return shapeGrns(rows, su.id, su.role, null)
  })

  fastify.get<{ Params: { id: string } }>('/grns/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const su = req.staffUser!
    const head = await guardGrn(req, req.params.id, 'read')
    const po = head.poId ? await prisma.purchaseOrder.findUnique({ where: { id: head.poId }, select: { createdBy: true, buyerUserId: true } }) : null
    // AP readers, and the PO's own requester / buyer.
    if (!(AP_READERS as readonly string[]).includes(su.role) && po?.createdBy !== su.id && po?.buyerUserId !== su.id) {
      throw new AppError('FORBIDDEN', `Role '${su.role}' is not allowed for this resource`, 403)
    }
    const g = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: head.id }, include: { lines: true } })
    const [shaped] = await shapeGrns([g], su.id, su.role, null)
    const poFull = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: g.poId! },
      include: { lines: { include: { inventoryItem: { select: { name: true, unit: true } } } }, activityLog: { include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' } } },
    })
    const lines = poFull.lines.map((pl) => {
      const rl = g.lines.filter((l) => l.poLineId === pl.id)
      const here = rl.reduce((s, l) => s + l.receivedQty, 0)
      const d = lineDisplay(pl, pl.inventoryItem.unit)
      const per = pl.orderUnit && pl.orderUnitFactor > 0 ? pl.orderUnitFactor : 1
      return {
        poLineId: pl.id, item: pl.inventoryItem.name, stockUnit: pl.inventoryItem.unit, unit: d.unit, rateCents: d.rateCents,
        ordered: pl.quantityOrdered, orderedInUnit: d.quantity, receivedAllGrns: pl.quantityReceived,
        receivedHere: here, receivedHereInUnit: Math.round((here / per) * 1e6) / 1e6,
        invoicedCents: lineValueCents({ quantityOrdered: here, unitCostCents: pl.unitCostCents, orderUnitFactor: pl.orderUnitFactor, orderUnitCostCents: pl.orderUnitCostCents }),
      }
    })
    const files = await prisma.cashVoucherAttachment.findMany({
      where: { kind: 'record_file', ownerType: PO_FILE_OWNER, ownerId: poFull.id, tenantId: g.tenantId ?? undefined },
      select: { id: true, fileName: true, mime: true, sizeBytes: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    })
    const activity = poFull.activityLog.filter((a) => (a.details as { grnId?: string } | null)?.grnId === g.id)
    return { ...shaped, lines, files, activity, poNotes: poFull.notes, poTotalCents: toCents(poFull.totalCents) }
  })

  fastify.post<{ Params: { id: string } }>('/grns/:id/finance-pass', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = z.object({ note: z.string().max(500).nullable().optional() }).parse(req.body ?? {})
    const { grant, tenantId } = await grnRight(req, req.params.id, 'grn_finance', 'verify a GRN')
    const r = await grnFinancePass(req.params.id, actorOf(req), note ?? null)
    await auditApproval(req, { type: 'grn_finance', id: req.params.id, tenantId, decision: 'approve', grant, entity: 'GoodsReceipt', metadata: { final: false, from: 'finance_review', to: 'ceo_review', ...(note ? { note } : {}) } })
    return { id: r.id, grnStatus: r.grnStatus }
  })

  fastify.post<{ Params: { id: string } }>('/grns/:id/return', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { note } = z.object({ note: z.string().max(500).nullable().optional() }).parse(req.body ?? {})
    const n = assertNote(note, 'Say what the buyer must correct')
    const head = await guardGrn(req, req.params.id, 'read')
    if (head.grnStatus !== 'finance_review' && head.grnStatus !== 'ceo_review') {
      throw new AppError('INVALID_STATE', `This GRN is ${String(head.grnStatus).replace(/_/g, ' ')} — nothing to return`, 409)
    }
    const type = head.grnStatus === 'finance_review' ? 'grn_finance' : 'grn'
    const { grant, tenantId } = await grnRight(req, req.params.id, type, 'return a GRN')
    const r = await grnReturn(req.params.id, actorOf(req), n, head.grnStatus)
    await auditApproval(req, { type, id: req.params.id, tenantId, decision: 'return', grant, entity: 'GoodsReceipt', metadata: { note: n, from: r.from, to: 'buyer_fix' } })
    return { id: r.id, grnStatus: r.grnStatus }
  })

  fastify.post<{ Params: { id: string } }>('/grns/:id/pull-back', { preHandler: requireAuth('finance', 'admin') }, async (req) => {
    const head = await guardGrn(req, req.params.id, 'write')
    if (req.staffUser!.role === 'finance') await financeAccounting(req)
    if (head.grnStatus !== 'ceo_review') throw new AppError('INVALID_STATE', `This GRN is ${String(head.grnStatus).replace(/_/g, ' ')} — only one waiting for the CEO can be pulled back`, 409)
    const r = await grnPullBack(req.params.id, actorOf(req))
    return { id: r.id, grnStatus: r.grnStatus }
  })

  fastify.post<{ Params: { id: string } }>('/grns/:id/resubmit', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const head = await guardGrn(req, req.params.id, 'write')
    const body = z.object({
      invoiceNumber: z.string().max(100).optional(),
      invoiceDate: zYmd.optional(),
      taxCents: zMoneyCents('The sales tax').nullable().optional(),
      taxAuthority: z.enum(TAX_AUTHORITY_KEYS).nullable().optional(),
      lines: z.array(zRate).max(200).optional(),
      note: z.string().max(500).nullable().optional(),
    }).parse(req.body ?? {})
    const r = await grnResubmit(head.id, actorOf(req), body)
    await audit({
      category: 'accounting', action: 'grn.resubmitted', entity: 'GoodsReceipt', entityId: head.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: head.tenantId,
      metadata: { invoiceNumber: body.invoiceNumber ?? null, invoiceDate: body.invoiceDate ?? null, taxCents: body.taxCents, taxAuthority: body.taxAuthority, rateChanges: r.rateChanges },
    })
    return { id: r.id, grnStatus: r.grnStatus }
  })

  fastify.post<{ Params: { id: string } }>('/grns/:id/approve', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { grant, tenantId } = await grnRight(req, req.params.id, 'grn', 'approve a GRN')
    const r = await approveGrn(req.params.id, actorOf(req))
    await auditApproval(req, { type: 'grn', id: req.params.id, tenantId, decision: 'approve', grant, entity: 'GoodsReceipt', metadata: { final: true, supplierBillId: r.supplierBillId, billNumber: r.billNumber, totalCents: r.totalCents } })
    return r
  })
}
