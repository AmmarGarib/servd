// "Received, not billed" — goods received not invoiced (2015 GRNI, H17).
// Registered at /procurement/grni (module gate: procurement OR accounting,
// lib/moduleAccess.ts). Every receipt line belongs to its receipt's company
// (GoodsReceipt.tenantId, else its supplier's); a foreign line or supplier is
// 404.
//
//   GET  /                         open receipt lines (received − billed), value,
//                                  age, stale (> 30 days), pending bill matches
//                                  (billed before arrival), write-off requests
//   GET  /unbilled-lines           the bill form's "Fill from receipt" picker
//   POST /:receiptLineId/write-off-request   finance / procurement / management
//                                  ask to write the line off (the supplier will
//                                  never bill it); a request the CEO raises
//                                  applies at once
//   POST /:receiptLineId/write-off/approve   CEO: posts
//                                  'procurement.grni_writeoff:<lineId>' Dr 2015 /
//                                  Cr 5060 (accounting/inventoryPosting.ts)
//   POST /:receiptLineId/write-off/reject    CEO, with a note
// Audit rows are filed under the receipt's company. The approvals inbox reads
// GET /?writeOffRequested=1 (type 'grni_writeoff').

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, PrismaClient, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, PROCUREMENT_TEAM } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { sumCents } from '../../lib/money.js'
import { postGrniWriteOffTx } from '../accounting/inventoryPosting.js'
import { findSupplierInScope } from './scope.js'

const AP_READERS = Array.from(new Set([...PROCUREMENT_TEAM, 'finance'])) as UserRole[]
/** Who may ASK for a write-off (the CEO approves every one). */
export const GRNI_WRITE_OFF_REQUESTERS = ['admin', 'owner', 'management', 'finance', 'procurement'] as UserRole[]

const STALE_DAYS = 30
const DAY_MS = 86_400_000
const OPEN_EPS = 1e-6

interface OpenLineRow { id: string; tenantId: string }

/** Ids (and companies) of the open receipt lines in `tenantIds`. */
async function openLineIds(tenantIds: string[], o: { supplierId?: string; olderThan?: Date; writeOffRequested?: boolean; includeSettled?: boolean } = {}): Promise<OpenLineRow[]> {
  if (tenantIds.length === 0) return []
  return prisma.$queryRaw<OpenLineRow[]>`
    SELECT l.id, COALESCE(r."tenantId", s."tenantId") AS "tenantId"
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.id = l."receiptId"
      JOIN suppliers s ON s.id = r."supplierId"
     WHERE COALESCE(r."tenantId", s."tenantId") = ANY(${tenantIds}::text[])
       AND l."writtenOffAt" IS NULL
       AND r."settledByType" IS NULL
       AND l."receivedQty" - l."billedQty" > ${OPEN_EPS}
       AND (${o.supplierId ?? null}::text IS NULL OR r."supplierId" = ${o.supplierId ?? null}::text)
       AND (${o.olderThan?.toISOString() ?? null}::timestamp IS NULL OR r."receivedAt" < ${o.olderThan?.toISOString() ?? null}::timestamp)
       AND (${o.writeOffRequested ? 1 : 0}::int = 0 OR l."writeOffRequestedAt" IS NOT NULL)
     ORDER BY r."receivedAt" ASC, l.id ASC
     LIMIT 2000`
}

type Db = Prisma.TransactionClient | PrismaClient

/**
 * THE open GRNI value of receipt lines — one rule, read by this page and by
 * the food-cost valuation (reports/foodCost.ts): a line's lots' receipt value
 * − what live bill matches cleared; a pre-FIFO line (no lots): open qty × cost.
 */
export async function grniLineOpenValues(
  db: Db,
  lines: Array<{ id: string; receivedQty: number; billedQty: number; lotUnitCostCents: number | null; poUnitCostCents: number | null }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (lines.length === 0) return out
  const receivedByLine = new Map<string, number>()
  const matchedByLine = new Map<string, number>()
  const ids = lines.map((l) => l.id)
  for (let i = 0; i < ids.length; i += 1000) {
    const part = ids.slice(i, i + 1000)
    const lots = await db.stockLot.findMany({ where: { receiptLineId: { in: part } }, select: { id: true, receiptLineId: true } })
    const lineOfLot = new Map(lots.map((l) => [l.id, l.receiptLineId!]))
    const received = lots.length === 0 ? [] : await db.stockMovement.groupBy({
      by: ['lotId'], where: { lotId: { in: lots.map((l) => l.id) }, kind: 'receipt' }, _sum: { valueCents: true },
    })
    for (const r of received) {
      const line = r.lotId ? lineOfLot.get(r.lotId) : undefined
      if (line) receivedByLine.set(line, (receivedByLine.get(line) ?? 0) + sumCents(r._sum.valueCents))
    }
    const matched = await db.grniMatch.groupBy({ by: ['receiptLineId'], where: { receiptLineId: { in: part }, status: 'live' }, _sum: { grniCents: true } })
    for (const m of matched) if (m.receiptLineId) matchedByLine.set(m.receiptLineId, sumCents(m._sum.grniCents))
  }
  for (const l of lines) {
    const rec = receivedByLine.get(l.id)
    out.set(l.id, rec != null
      ? Math.max(0, rec - (matchedByLine.get(l.id) ?? 0))
      : Math.round(Math.max(0, l.receivedQty - l.billedQty) * (l.lotUnitCostCents ?? l.poUnitCostCents ?? 0)))
  }
  return out
}

/** The receipt line, in the operator's write scope (its company is one they belong to), else 404. */
async function lineInWriteScope(req: FastifyRequest, id: string) {
  const line = await prisma.goodsReceiptLine.findUnique({
    where: { id },
    select: {
      id: true, description: true, receivedQty: true, billedQty: true, writeOffRequestedAt: true, writeOffRequestedById: true,
      writeOffReason: true, writtenOffAt: true, receiptId: true,
    },
  })
  if (!line) throw new NotFoundError('GoodsReceiptLine', id)
  // The receipt is read on its own: under the company lock (RLS) another
  // company's receipt is hidden, and a required include of it was a 500.
  const receipt = await prisma.goodsReceipt.findUnique({
    where: { id: line.receiptId }, select: { id: true, tenantId: true, supplierId: true, settledByType: true },
  })
  if (!receipt) throw new NotFoundError('GoodsReceiptLine', id)
  const { receiptId: _receiptId, ...rest } = line
  return lineWithTenant(req, id, { ...rest, receipt })
}

async function lineWithTenant<L extends { receipt: { tenantId: string | null; supplierId: string } }>(req: FastifyRequest, id: string, line: L) {
  const tenantId = line.receipt.tenantId
    ?? (await prisma.supplier.findUnique({ where: { id: line.receipt.supplierId }, select: { tenantId: true } }))?.tenantId ?? null
  if (!tenantId || !req.staffUser!.memberTenantIds.includes(tenantId)) throw new NotFoundError('GoodsReceiptLine', id)
  return { ...line, tenantId }
}

async function writeAudit(req: FastifyRequest, action: string, line: { id: string; tenantId: string }, metadata: Record<string, unknown>) {
  await audit({
    category: 'accounting', action, entity: 'GoodsReceiptLine', entityId: line.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: line.tenantId, metadata,
  })
}

/** approval.decide for a write-off decision (grant 'role': ADMIN_ONLY guard); the approve notice reaches the
 *  requester through the funnel. After the commit; never fails the decision. */
async function decidedAudit(req: FastifyRequest, line: { id: string; tenantId: string }, decision: 'approve' | 'reject', note: string | null, requestedById?: string | null) {
  try {
    await auditApproval(req, {
      type: 'grni_writeoff', id: line.id, tenantId: line.tenantId, decision, grant: { via: 'role' }, entity: 'GoodsReceiptLine',
      // A reject CLEARS writeOffRequestedById: name the requester (read before the write) for the notice.
      metadata: { decidedAt: new Date().toISOString(), ...(note ? { reason: note } : {}), ...(requestedById ? { waitingUserIds: [requestedById] } : {}) },
    })
  } catch (err) {
    console.warn(`[grni] approval.decide not recorded: ${(err as Error).message}`)
  }
}

/** Post the write-off and stamp the line, in one transaction under the line's lock. */
async function applyWriteOff(lineId: string, actorId: string, reason: string | null, claimRequest: boolean) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM goods_receipt_lines WHERE id = ${lineId} FOR UPDATE`
    const fresh = await tx.goodsReceiptLine.findUniqueOrThrow({ where: { id: lineId }, select: { writtenOffAt: true, writeOffRequestedAt: true } })
    if (fresh.writtenOffAt) throw new AppError('NOTHING_OPEN', 'This receipt line is already written off', 409)
    if (claimRequest) {
      if (fresh.writeOffRequestedAt) throw new AppError('WRITE_OFF_PENDING', 'A write-off of this line is already waiting for the CEO', 409)
    } else if (!fresh.writeOffRequestedAt) {
      throw new AppError('NO_WRITE_OFF_REQUEST', 'Nobody has asked to write this line off', 409)
    }
    const posted = await postGrniWriteOffTx(tx, lineId, { id: actorId })
    const now = new Date()
    await tx.goodsReceiptLine.update({
      where: { id: lineId },
      data: {
        ...(claimRequest ? { writeOffRequestedAt: now, writeOffRequestedById: actorId, writeOffReason: reason } : {}),
        writtenOffAt: now, writtenOffById: actorId, writeOffEntryId: posted.entryId,
      },
    })
    return posted
  }, { timeout: 30_000 })
}

export async function grniRoutes(fastify: FastifyInstance) {
  const listQuery = z.object({
    tenantId:          z.string().min(1).optional(),
    supplierId:        z.string().min(1).optional(),
    olderThanDays:     z.coerce.number().int().min(0).max(3650).optional(),
    writeOffRequested: z.enum(['1', 'true']).optional(),
  })

  fastify.get('/', { preHandler: requireAuth(...AP_READERS) }, async (req) => {
    const q = listQuery.parse(req.query ?? {})
    const scope = await resolveTenantScope(req)
    if (q.tenantId && !scope.tenantIds.includes(q.tenantId)) throw new NotFoundError('Company', q.tenantId)
    const tenantIds = q.tenantId ? [q.tenantId] : scope.tenantIds
    if (q.supplierId) {
      const s = await prisma.supplier.findFirst({ where: { id: q.supplierId, tenantId: { in: tenantIds } }, select: { id: true } })
      if (!s) throw new NotFoundError('Supplier', q.supplierId)
    }
    const now = Date.now()
    const ids = await openLineIds(tenantIds, {
      supplierId: q.supplierId,
      olderThan: q.olderThanDays != null ? new Date(now - q.olderThanDays * DAY_MS) : undefined,
      writeOffRequested: !!q.writeOffRequested,
    })
    const companyOf = new Map(ids.map((r) => [r.id, r.tenantId]))
    const lines = ids.length === 0 ? [] : await prisma.goodsReceiptLine.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: {
        id: true, receiptId: true, inventoryItemId: true, poLineId: true, description: true, unit: true, receivedQty: true, billedQty: true,
        lotUnitCostCents: true, poUnitCostCents: true, writeOffRequestedAt: true, writeOffRequestedById: true, writeOffReason: true,
        receipt: { select: { receivedAt: true, supplierId: true, poId: true, locationId: true } },
      },
    })
    const values = await grniLineOpenValues(prisma, lines)
    const supplierIds = [...new Set(lines.map((l) => l.receipt.supplierId))]
    const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]))
    const rows = lines
      .map((l) => {
        const ageDays = Math.floor((now - l.receipt.receivedAt.getTime()) / DAY_MS)
        return {
          receiptLineId: l.id, receiptId: l.receiptId, tenantId: companyOf.get(l.id) ?? null,
          supplierId: l.receipt.supplierId, supplierName: suppliers.get(l.receipt.supplierId) ?? null,
          poId: l.receipt.poId, poLineId: l.poLineId, locationId: l.receipt.locationId,
          inventoryItemId: l.inventoryItemId, description: l.description, unit: l.unit,
          receivedQty: l.receivedQty, billedQty: l.billedQty, openQty: Math.max(0, l.receivedQty - l.billedQty),
          unitCostCents: l.lotUnitCostCents ?? l.poUnitCostCents ?? 0, openValueCents: values.get(l.id) ?? 0,
          receivedAt: l.receipt.receivedAt, ageDays, stale: ageDays > STALE_DAYS,
          writeOffRequest: l.writeOffRequestedAt
            ? { requestedAt: l.writeOffRequestedAt, requestedById: l.writeOffRequestedById, reason: l.writeOffReason }
            : null,
        }
      })
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())

    // Billed before it arrived: pending bill matches (Dr 2015 at the billed price).
    const pending = tenantIds.length === 0 || q.writeOffRequested ? [] : await prisma.grniMatch.findMany({
      where: { tenantId: { in: tenantIds }, status: 'pending', ...(q.supplierId ? { bill: { supplierId: q.supplierId } } : {}) },
      orderBy: { createdAt: 'asc' },
      take: 500,
      select: {
        id: true, tenantId: true, qty: true, billedUnitCostCents: true, grniCents: true, createdAt: true, poLineId: true,
        bill: { select: { id: true, billNumber: true, billDate: true, supplier: { select: { id: true, name: true } } } },
        billLine: { select: { description: true } },
      },
    })
    const role = req.staffUser!.role as UserRole
    return {
      tenantIds,
      staleDays: STALE_DAYS,
      // What the page may offer: the CEO approves / rejects a write-off;
      // the requester roles may ask for one. The routes enforce both.
      canApprove: ADMIN_ONLY.includes(role),
      canRequestWriteOff: GRNI_WRITE_OFF_REQUESTERS.includes(role),
      lines: rows,
      totals: {
        openValueCents: rows.reduce((s, r) => s + r.openValueCents, 0),
        staleValueCents: rows.filter((r) => r.stale).reduce((s, r) => s + r.openValueCents, 0),
        pendingBilledCents: pending.reduce((s, p) => s + sumCents(p.grniCents), 0),
      },
      pendingBillMatches: pending.map((p) => ({
        matchId: p.id, tenantId: p.tenantId, billId: p.bill.id, billNumber: p.bill.billNumber, billDate: p.bill.billDate,
        supplierId: p.bill.supplier.id, supplierName: p.bill.supplier.name, poLineId: p.poLineId,
        description: p.billLine.description, qty: p.qty, billedUnitCostCents: p.billedUnitCostCents, billedCents: sumCents(p.grniCents),
        billedAt: p.createdAt,
      })),
    }
  })

  // The bill form's picker: a supplier's receipt lines still to bill.
  fastify.get('/unbilled-lines', { preHandler: requireAuth(...AP_READERS) }, async (req) => {
    const q = z.object({ supplierId: z.string().min(1) }).parse(req.query ?? {})
    const supplier = await findSupplierInScope(req, q.supplierId, 'read')
    if (!supplier.tenantId) return []
    const ids = await openLineIds([supplier.tenantId], { supplierId: supplier.id })
    if (ids.length === 0) return []
    const lines = await prisma.goodsReceiptLine.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
      select: {
        id: true, receiptId: true, poLineId: true, inventoryItemId: true, description: true, unit: true,
        receivedQty: true, billedQty: true, lotUnitCostCents: true, poUnitCostCents: true,
        receipt: { select: { receivedAt: true, poId: true } },
      },
    })
    return lines
      .map((l) => ({
        receiptLineId: l.id, receiptId: l.receiptId, poId: l.receipt.poId, poLineId: l.poLineId, receivedAt: l.receipt.receivedAt,
        inventoryItemId: l.inventoryItemId, description: l.description, unit: l.unit,
        openQty: Math.max(0, l.receivedQty - l.billedQty), unitCostCents: l.lotUnitCostCents ?? l.poUnitCostCents ?? 0,
      }))
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  })

  const reasonBody = z.object({ reason: z.string().trim().min(3).max(500) })

  // Finance / procurement / management ask; the CEO approves. A CEO's own request applies at once.
  fastify.post<{ Params: { receiptLineId: string } }>(
    '/:receiptLineId/write-off-request',
    { preHandler: requireAuth(...GRNI_WRITE_OFF_REQUESTERS) },
    async (req) => {
      const { reason } = reasonBody.parse(req.body ?? {})
      const line = await lineInWriteScope(req, req.params.receiptLineId)
      if (line.receipt.settledByType || line.writtenOffAt || !(line.receivedQty - line.billedQty > OPEN_EPS)) {
        throw new AppError('NOTHING_OPEN', 'Nothing on this receipt line is waiting for a bill', 409)
      }
      if (req.staffUser!.role === 'admin') {
        const posted = await applyWriteOff(line.id, req.staffUser!.id, reason, true)
        await writeAudit(req, 'procurement.grni_writeoff.apply', line, { reason, raisedByCeo: true, entryId: posted.entryId, valueCents: posted.valueCents })
        return { receiptLineId: line.id, status: 'written_off', entryId: posted.entryId, valueCents: posted.valueCents }
      }
      const claimed = await prisma.goodsReceiptLine.updateMany({
        where: { id: line.id, writeOffRequestedAt: null, writtenOffAt: null },
        data: { writeOffRequestedAt: new Date(), writeOffRequestedById: req.staffUser!.id, writeOffReason: reason },
      })
      if (claimed.count === 0) throw new AppError('WRITE_OFF_PENDING', 'A write-off of this line is already waiting for the CEO', 409)
      await writeAudit(req, 'procurement.grni_writeoff.request', line, { reason })
      // The bell (queued, after the claim): the CEO has a write-off to decide. A re-request after a reject is a new round.
      const asked = await prisma.goodsReceiptLine.findUnique({ where: { id: line.id }, select: { writeOffRequestedAt: true } })
      approvalWaiting('grni_writeoff', line.id, { round: `request:${(asked?.writeOffRequestedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
      return { receiptLineId: line.id, status: 'requested' }
    },
  )

  fastify.post<{ Params: { receiptLineId: string } }>(
    '/:receiptLineId/write-off/approve',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const line = await lineInWriteScope(req, req.params.receiptLineId)
      const posted = await applyWriteOff(line.id, req.staffUser!.id, null, false)
      await writeAudit(req, 'procurement.grni_writeoff.approve', line, {
        requestedById: line.writeOffRequestedById, reason: line.writeOffReason, entryId: posted.entryId, valueCents: posted.valueCents,
      })
      await decidedAudit(req, line, 'approve', null)
      return { receiptLineId: line.id, status: 'written_off', entryId: posted.entryId, valueCents: posted.valueCents }
    },
  )

  fastify.post<{ Params: { receiptLineId: string } }>(
    '/:receiptLineId/write-off/reject',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      const { note } = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
      const line = await lineInWriteScope(req, req.params.receiptLineId)
      const cleared = await prisma.goodsReceiptLine.updateMany({
        where: { id: line.id, writeOffRequestedAt: { not: null }, writtenOffAt: null },
        data: { writeOffRequestedAt: null, writeOffRequestedById: null, writeOffReason: null },
      })
      if (cleared.count === 0) throw new AppError('NO_WRITE_OFF_REQUEST', 'Nobody has asked to write this line off', 409)
      await writeAudit(req, 'procurement.grni_writeoff.reject', line, { note, requestedById: line.writeOffRequestedById, reason: line.writeOffReason })
      await decidedAudit(req, line, 'reject', note, line.writeOffRequestedById)
      return { receiptLineId: line.id, status: 'rejected' }
    },
  )
}

export default grniRoutes
