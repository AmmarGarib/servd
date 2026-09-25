// Enterprise procurement service
//
// Owns:
//  - Purchase order lifecycle (create → submit → approve → send → receive → close)
//  - Receiving with weighted-average cost + price history + variance log
//  - Supplier bills (AP), 3-way matching (PO ↔ receipt ↔ bill)
//  - Multi-bill payment allocation
//  - Aging report
//  - Reorder suggestions
//  - PO email dispatch + audit trail

import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { sendEmail } from '../../lib/notify.js'
import { withholdingForBill } from '../accounting/supplierPosting.js'
import type { Prisma } from '@prisma/client'

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Approval threshold from Settings table. Above this, POs require admin approval.
 * Stored in paisa. Default 50,000 PKR = 5,000,000 paisa.
 */
async function getApprovalThresholdCents(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: 'procurement.approvalThresholdCents' } })
  if (!row?.value) return 5_000_000
  const n = parseInt(row.value, 10)
  return Number.isFinite(n) ? n : 5_000_000
}

// ─── PO lifecycle ────────────────────────────────────────────────────────────

export interface CreatePoInput {
  supplierId: string
  expectedDate?: string | null
  reference?: string | null
  notes?: string | null
  lines: Array<{ inventoryItemId: string; quantityOrdered: number; unitCostCents: number; notes?: string | null }>
  createdBy: string
}

export async function createPo(input: CreatePoInput) {
  if (input.lines.length === 0) {
    throw new AppError('NO_LINES', 'A PO needs at least one line', 400)
  }

  const totalCents = input.lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityOrdered), 0)

  const po = await prisma.purchaseOrder.create({
    data: {
      supplierId:   input.supplierId,
      expectedDate: input.expectedDate ? new Date(input.expectedDate) : null,
      reference:    input.reference   ?? null,
      notes:        input.notes       ?? null,
      totalCents,
      createdBy:    input.createdBy,
      status:       'draft',
      lines: {
        create: input.lines.map((l) => ({
          inventoryItemId: l.inventoryItemId,
          quantityOrdered: l.quantityOrdered,
          unitCostCents:   l.unitCostCents,
          notes:           l.notes ?? null,
        })),
      },
      activityLog: {
        create: { userId: input.createdBy, action: 'created', details: { totalCents, lineCount: input.lines.length } },
      },
    },
    include: { supplier: true, lines: { include: { inventoryItem: true } } },
  })

  return po
}

/** Submit a draft PO for approval (or auto-approve if under threshold). */
export async function submitPo(poId: string, userId: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'draft') throw new AppError('INVALID_STATE', `Cannot submit PO in status ${po.status}`, 400)

  const threshold = await getApprovalThresholdCents()
  const needsApproval = po.totalCents >= threshold

  return prisma.$transaction(async (tx) => {
    const newStatus = needsApproval ? 'pending_approval' : 'sent'
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: needsApproval
        ? { status: 'pending_approval' }
        : { status: 'sent', approvedById: userId, approvedAt: new Date(), sentAt: new Date() },
    })
    await tx.poActivityLog.create({
      data: { purchaseOrderId: poId, userId, action: 'submitted', details: { needsApproval, threshold, total: po.totalCents } },
    })
    if (!needsApproval) {
      await tx.poActivityLog.create({
        data: { purchaseOrderId: poId, userId, action: 'auto_approved', details: { reason: 'below_threshold' } },
      })
    }
    return { id: poId, status: newStatus, needsApproval }
  })
}

export async function approvePo(poId: string, approverId: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'pending_approval') throw new AppError('INVALID_STATE', `Cannot approve PO in status ${po.status}`, 400)

  return prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: poId },
      data:  { status: 'sent', approvedById: approverId, approvedAt: new Date(), sentAt: new Date() },
    })
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: approverId, action: 'approved' } })
    return { id: poId, status: 'sent' }
  })
}

export async function rejectPo(poId: string, approverId: string, reason: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status !== 'pending_approval') throw new AppError('INVALID_STATE', `Cannot reject PO in status ${po.status}`, 400)

  return prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: poId },
      data:  { status: 'draft', rejectedReason: reason },
    })
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: approverId, action: 'rejected', details: { reason } } })
    return { id: poId, status: 'draft' }
  })
}

export async function cancelPo(poId: string, userId: string, reason: string) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { lines: true } })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (po.status === 'cancelled') throw new AppError('INVALID_STATE', 'Already cancelled', 400)
  if (po.status === 'received') throw new AppError('INVALID_STATE', 'Cannot cancel a fully received PO', 400)

  const hasReceiving = po.lines.some((l) => l.quantityReceived > 0)
  if (hasReceiving) throw new AppError('INVALID_STATE', 'Cannot cancel — some lines have been received. Adjust manually.', 400)

  return prisma.$transaction(async (tx) => {
    await tx.purchaseOrder.update({
      where: { id: poId },
      data:  { status: 'cancelled', cancelledById: userId, cancelledAt: new Date(), cancelReason: reason },
    })
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId, action: 'cancelled', details: { reason } } })
    return { id: poId, status: 'cancelled' }
  })
}

/** Mark a PO as sent, including emailing the supplier. */
export async function sendPoToSupplier(poId: string, userId: string) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { supplier: true, lines: { include: { inventoryItem: true } } },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (!po.supplier.email) throw new AppError('NO_EMAIL', `Supplier ${po.supplier.name} has no email on file`, 400)

  const fmt = (c: number) => `PKR ${(c / 100).toLocaleString()}`
  const linesHtml = po.lines.map((l) => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #eee;">${l.inventoryItem.name}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${l.quantityOrdered} ${l.inventoryItem.unit}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${fmt(l.unitCostCents)}</td>
      <td style="padding:6px;border-bottom:1px solid #eee;text-align:right;">${fmt(l.unitCostCents * l.quantityOrdered)}</td>
    </tr>`).join('')

  const html = `
    <div style="font-family:sans-serif;max-width:640px;">
      <h2>Purchase Order ${po.reference ? `#${po.reference}` : `#${po.id.slice(0, 8).toUpperCase()}`}</h2>
      <p>Hi ${po.supplier.name},</p>
      <p>Please find our purchase order below. Confirm receipt at your earliest convenience.</p>
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:16px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;text-align:left;">Item</th>
            <th style="padding:8px;text-align:right;">Qty</th>
            <th style="padding:8px;text-align:right;">Unit Cost</th>
            <th style="padding:8px;text-align:right;">Total</th>
          </tr>
        </thead>
        <tbody>${linesHtml}</tbody>
        <tfoot>
          <tr><td colspan="3" style="padding:12px;text-align:right;font-weight:bold;">Total</td>
              <td style="padding:12px;text-align:right;font-weight:bold;">${fmt(po.totalCents)}</td></tr>
        </tfoot>
      </table>
      ${po.expectedDate ? `<p><strong>Expected delivery:</strong> ${po.expectedDate.toDateString()}</p>` : ''}
      ${po.notes ? `<p><strong>Notes:</strong> ${po.notes}</p>` : ''}
      <p style="color:#888;font-size:12px;margin-top:32px;">Sent via servd procurement.</p>
    </div>`

  await sendEmail(po.supplier.email, `Purchase Order from servd — ${fmt(po.totalCents)}`, html)

  await prisma.$transaction([
    prisma.purchaseOrder.update({
      where: { id: poId },
      data:  { sentAt: new Date(), sentToEmail: po.supplier.email, status: po.status === 'draft' ? 'sent' : po.status },
    }),
    prisma.poActivityLog.create({
      data: { purchaseOrderId: poId, userId, action: 'sent', details: { to: po.supplier.email } },
    }),
  ])

  return { sentTo: po.supplier.email }
}

// ─── Receiving ───────────────────────────────────────────────────────────────

export interface ReceiveInput {
  poId: string
  userId: string
  lines: Array<{ poLineId: string; quantityReceived: number; discrepancyReason?: string; discrepancyNotes?: string }>
}

export async function receivePo(input: ReceiveInput) {
  const po = await prisma.purchaseOrder.findUnique({
    where:   { id: input.poId },
    include: { lines: true },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', input.poId)
  if (po.status === 'cancelled') throw new AppError('PO_CANCELLED', 'Cannot receive a cancelled PO', 400)
  if (po.status === 'received')  throw new AppError('PO_RECEIVED',  'PO is already fully received', 400)

  for (const recv of input.lines) {
    if (recv.quantityReceived <= 0) {
      throw new AppError('INVALID_QTY', 'Received quantity must be positive', 400)
    }
  }

  return prisma.$transaction(async (tx) => {
    for (const recv of input.lines) {
      const poLine = po.lines.find((l) => l.id === recv.poLineId)
      if (!poLine) throw new AppError('LINE_NOT_FOUND', `Line ${recv.poLineId} not part of this PO`, 400)

      // Update line received qty
      await tx.purchaseOrderLine.update({
        where: { id: recv.poLineId },
        data:  { quantityReceived: { increment: recv.quantityReceived } },
      })

      // Update inventory + weighted-average cost
      const item = await tx.inventoryItem.findUnique({ where: { id: poLine.inventoryItemId } })
      if (item) {
        const oldStock    = item.currentStock
        const newStock    = oldStock + recv.quantityReceived
        const oldCost     = item.unitCostCents ?? poLine.unitCostCents
        const newUnitCost = newStock > 0
          ? Math.round((oldCost * oldStock + poLine.unitCostCents * recv.quantityReceived) / newStock)
          : poLine.unitCostCents

        await tx.inventoryItem.update({
          where: { id: poLine.inventoryItemId },
          data:  { currentStock: { increment: recv.quantityReceived }, unitCostCents: newUnitCost },
        })

        // Price history — only record if cost actually changed
        if (oldCost !== newUnitCost) {
          await tx.itemPriceHistory.create({
            data: {
              inventoryItemId: poLine.inventoryItemId,
              supplierId:      po.supplierId,
              oldCostCents:    oldCost,
              newCostCents:    newUnitCost,
              source:          'po_receive',
              poLineId:        poLine.id,
            },
          })
        }
      }

      // Variance log: short shipment, over shipment, or explicit reason given
      const cumulativeReceived = poLine.quantityReceived + recv.quantityReceived
      const variance = cumulativeReceived - poLine.quantityOrdered
      if (recv.discrepancyReason || variance < 0 || variance > 0) {
        const reason =
          recv.discrepancyReason ??
          (variance < 0 ? 'short_shipment' : 'over_shipment')
        await tx.receivingDiscrepancy.create({
          data: {
            poLineId:     poLine.id,
            expectedQty:  poLine.quantityOrdered,
            receivedQty:  cumulativeReceived,
            reason,
            notes:        recv.discrepancyNotes ?? null,
            recordedById: input.userId,
          },
        })
      }
    }

    // Recompute PO status: fully received vs partial
    const allReceived = po.lines.every((l) => {
      const recv = input.lines.find((r) => r.poLineId === l.id)
      const cum  = l.quantityReceived + (recv?.quantityReceived ?? 0)
      return cum >= l.quantityOrdered
    })

    await tx.purchaseOrder.update({
      where: { id: input.poId },
      data:  {
        status:       allReceived ? 'received' : 'partial',
        receivedDate: new Date(),
      },
    })

    await tx.poActivityLog.create({
      data: {
        purchaseOrderId: input.poId,
        userId:          input.userId,
        action:          allReceived ? 'received' : 'received_partial',
        details:         { lineCount: input.lines.length },
      },
    })

    return { ok: true, status: allReceived ? 'received' : 'partial' }
  })
}

// ─── Bills (Accounts Payable) ────────────────────────────────────────────────

export interface CreateBillInput {
  supplierId:    string
  poId?:         string | null
  billNumber:    string
  billDate:      string
  dueDate?:      string | null   // if absent, computed from supplier paymentTermsDays
  taxCents?:     number
  notes?:        string | null
  attachmentUrl?: string | null
  lines: Array<{
    inventoryItemId?: string | null
    poLineId?:        string | null
    description:      string
    quantity:         number
    unitCostCents:    number
  }>
  createdBy: string
}

export async function createBill(input: CreateBillInput) {
  if (input.lines.length === 0) throw new AppError('NO_LINES', 'A bill needs at least one line', 400)

  const supplier = await prisma.supplier.findUnique({ where: { id: input.supplierId } })
  if (!supplier) throw new NotFoundError('Supplier', input.supplierId)

  const subtotalCents = input.lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantity), 0)
  const taxCents      = input.taxCents ?? 0
  const totalCents    = subtotalCents + taxCents
  // Withholding is fixed now, from the supplier's company's settings, and the
  // ledger books this same figure (postSupplierBill) — see SupplierBill.whtCents.
  const whtCents      = await withholdingForBill(subtotalCents, supplier.tenantId)

  const billDate = new Date(input.billDate)
  const dueDate  = input.dueDate
    ? new Date(input.dueDate)
    : new Date(billDate.getTime() + supplier.paymentTermsDays * 24 * 60 * 60 * 1000)

  try {
    const bill = await prisma.supplierBill.create({
      data: {
        supplierId:   input.supplierId,
        poId:         input.poId      ?? null,
        billNumber:   input.billNumber,
        billDate,
        dueDate,
        subtotalCents,
        taxCents,
        totalCents,
        whtCents,
        notes:        input.notes         ?? null,
        attachmentUrl: input.attachmentUrl ?? null,
        createdBy:    input.createdBy,
        status:       'open',
        lines: {
          create: input.lines.map((l) => ({
            inventoryItemId: l.inventoryItemId ?? null,
            poLineId:        l.poLineId        ?? null,
            description:     l.description,
            quantity:        l.quantity,
            unitCostCents:   l.unitCostCents,
            lineTotalCents:  Math.round(l.unitCostCents * l.quantity),
          })),
        },
      },
      include: { supplier: true, lines: true, po: true },
    })
    return bill
  } catch (err) {
    const e = err as Prisma.PrismaClientKnownRequestError
    if (e.code === 'P2002') {
      throw new AppError('DUPLICATE_BILL', `Bill number ${input.billNumber} already exists for this supplier`, 409)
    }
    throw err
  }
}

export async function voidBill(billId: string, userId: string, reason: string) {
  const bill = await prisma.supplierBill.findUnique({
    where:   { id: billId },
    include: { applications: true },
  })
  if (!bill) throw new NotFoundError('SupplierBill', billId)
  if (bill.status === 'void') throw new AppError('INVALID_STATE', 'Bill is already void', 400)
  if (bill.applications.length > 0) {
    throw new AppError('HAS_PAYMENTS', 'Cannot void a bill with applied payments — unapply payments first', 400)
  }

  return prisma.supplierBill.update({
    where: { id: billId },
    data:  { status: 'void', voidedAt: new Date(), voidReason: reason, notes: bill.notes ? `${bill.notes}\n[voided by ${userId}]` : `[voided by ${userId}]` },
  })
}

/**
 * 3-way match check for a bill: compares billed vs ordered vs received.
 * Returns line-by-line match status — UI uses this to flag mismatches.
 */
export async function matchBill(billId: string) {
  const bill = await prisma.supplierBill.findUnique({
    where:   { id: billId },
    include: {
      lines: {
        include: { poLine: { include: { inventoryItem: true } }, inventoryItem: true },
      },
      po: true,
    },
  })
  if (!bill) throw new NotFoundError('SupplierBill', billId)

  const lineResults = bill.lines.map((bl) => {
    if (!bl.poLine) {
      return {
        billLineId: bl.id,
        description: bl.description,
        match: 'unmatched' as const,
        reason: 'No PO line linked',
      }
    }
    const ordered  = bl.poLine.quantityOrdered
    const received = bl.poLine.quantityReceived
    const billed   = bl.quantity
    const orderedCost  = bl.poLine.unitCostCents
    const billedCost   = bl.unitCostCents

    const issues: string[] = []
    if (Math.abs(billed - received) > 0.001)     issues.push(`Billed ${billed}, received ${received}`)
    if (Math.abs(orderedCost - billedCost) > 1) issues.push(`Billed ${billedCost}p/unit, ordered ${orderedCost}p/unit`)

    return {
      billLineId:  bl.id,
      description: bl.description,
      match:       (issues.length === 0 ? 'matched' : 'mismatch') as 'matched' | 'mismatch',
      ordered, received, billed, orderedCost, billedCost,
      issues,
    }
  })

  return {
    billId,
    poId:         bill.poId,
    overallMatch: lineResults.every((r) => r.match === 'matched') ? 'matched' : 'mismatch' as 'matched' | 'mismatch',
    lines:        lineResults,
  }
}

// ─── What a bill still owes ──────────────────────────────────────────────────
//
// ONE rule, net of withholding: the supplier is owed totalCents − whtCents
// (that is what AP 2010 was credited with), less what has been applied. The
// payment paths, the bill status, the AP aging, the supplier statement and a
// petty-cash spend against a bill all use it. They used to use the gross
// total, so a bill paid net of withholding stayed 'partially_paid' for ever
// and showed as owing the WHT the ledger had already moved to FBR.

type BillAmounts = { totalCents: number; whtCents: number; paidCents: number }

/** What the supplier is still owed on this bill. */
export function billDueCents(b: BillAmounts): number {
  return b.totalCents - b.whtCents - b.paidCents
}

/** The status a bill's payments put it in (void and draft are left alone). */
function paidStatus(b: BillAmounts & { status: string }): string {
  if (b.status === 'void' || b.status === 'draft') return b.status
  if (b.paidCents > 0 && billDueCents(b) <= 0) return 'paid'
  return b.paidCents > 0 ? 'partially_paid' : b.status
}

// ─── Supplier Payments ───────────────────────────────────────────────────────

export interface CreatePaymentInput {
  supplierId:  string
  paymentDate: string
  method:      'cash' | 'bank_transfer' | 'cheque' | 'wallet'
  reference?:  string | null
  amountCents: number
  notes?:      string | null
  /** Optional: pre-allocate to specific bills. If absent, payment is created unallocated. */
  applications?: Array<{ billId: string; amountAppliedCents: number }>
  createdBy: string
}

export async function createPayment(input: CreatePaymentInput) {
  return prisma.$transaction((tx) => createPaymentTx(tx, input))
}

/**
 * createPayment inside the caller's transaction — for a cash spend recorded
 * elsewhere (a petty-cash box paying a supplier's bill) that must write the
 * SupplierPayment and its own row atomically. The caller posts the ledger
 * entry (postSupplierPayment) after commit, as the /procurement route does.
 */
export async function createPaymentTx(tx: Prisma.TransactionClient, input: CreatePaymentInput) {
  if (input.amountCents <= 0) throw new AppError('INVALID_AMOUNT', 'Amount must be positive', 400)

  const allocations = input.applications ?? []
  const totalAllocated = allocations.reduce((s, a) => s + a.amountAppliedCents, 0)
  if (totalAllocated > input.amountCents) {
    throw new AppError('OVER_ALLOCATED', 'Allocations exceed payment amount', 400)
  }

  // Validate all bills belong to the same supplier and aren't void/paid
  if (allocations.length > 0) {
    const bills = await tx.supplierBill.findMany({
      where: { id: { in: allocations.map((a) => a.billId) } },
    })
    for (const a of allocations) {
      const b = bills.find((x) => x.id === a.billId)
      if (!b)                              throw new NotFoundError('SupplierBill', a.billId)
      if (b.supplierId !== input.supplierId) throw new AppError('SUPPLIER_MISMATCH', `Bill ${b.billNumber} belongs to a different supplier`, 400)
      if (b.status === 'void')             throw new AppError('BILL_VOID',  `Bill ${b.billNumber} is void`,        400)
      if (b.status === 'paid')             throw new AppError('BILL_PAID',  `Bill ${b.billNumber} is fully paid`, 400)

      const remaining = billDueCents(b)
      if (a.amountAppliedCents > remaining) {
        throw new AppError('OVER_APPLIED', `Cannot apply ${a.amountAppliedCents} to bill ${b.billNumber} — only ${remaining} due`, 400)
      }
    }
  }

  const payment = await tx.supplierPayment.create({
    data: {
      supplierId:  input.supplierId,
      paymentDate: new Date(input.paymentDate),
      method:      input.method,
      reference:   input.reference ?? null,
      amountCents: input.amountCents,
      appliedCents: totalAllocated,
      notes:       input.notes ?? null,
      createdBy:   input.createdBy,
      applications: { create: allocations.map((a) => ({ billId: a.billId, amountAppliedCents: a.amountAppliedCents })) },
    },
    include: { applications: true },
  })

  // Update bill paid totals + statuses
  for (const a of allocations) {
    const bill = await tx.supplierBill.update({
      where: { id: a.billId },
      data:  { paidCents: { increment: a.amountAppliedCents } },
    })
    const newStatus = paidStatus(bill)
    if (newStatus !== bill.status) {
      await tx.supplierBill.update({ where: { id: bill.id }, data: { status: newStatus } })
    }
  }

  return payment
}

/** Allocate an existing unallocated payment to bills. */
export async function allocatePayment(
  paymentId: string,
  applications: Array<{ billId: string; amountAppliedCents: number }>,
) {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.supplierPayment.findUnique({
      where:   { id: paymentId },
      include: { applications: true },
    })
    if (!payment) throw new NotFoundError('SupplierPayment', paymentId)

    const alreadyApplied = payment.applications.reduce((s, a) => s + a.amountAppliedCents, 0)
    const adding         = applications.reduce((s, a) => s + a.amountAppliedCents, 0)
    if (alreadyApplied + adding > payment.amountCents) {
      throw new AppError('OVER_ALLOCATED', 'New allocations exceed remaining payment amount', 400)
    }

    for (const a of applications) {
      const bill = await tx.supplierBill.findUnique({ where: { id: a.billId } })
      if (!bill) throw new NotFoundError('SupplierBill', a.billId)
      if (bill.supplierId !== payment.supplierId) throw new AppError('SUPPLIER_MISMATCH', 'Bill belongs to different supplier', 400)
      if (bill.status === 'void') throw new AppError('BILL_VOID', `Bill ${bill.billNumber} is void`, 400)
      const remaining = billDueCents(bill)
      if (a.amountAppliedCents > remaining) {
        throw new AppError('OVER_APPLIED', `Bill ${bill.billNumber} only has ${remaining} due`, 400)
      }

      await tx.supplierPaymentApplication.create({
        data: { paymentId, billId: a.billId, amountAppliedCents: a.amountAppliedCents },
      })
      const updated = await tx.supplierBill.update({
        where: { id: a.billId },
        data:  { paidCents: { increment: a.amountAppliedCents } },
      })
      const newStatus = paidStatus(updated)
      if (newStatus !== updated.status) {
        await tx.supplierBill.update({ where: { id: updated.id }, data: { status: newStatus } })
      }
    }

    await tx.supplierPayment.update({
      where: { id: paymentId },
      data:  { appliedCents: { increment: adding } },
    })

    return { ok: true }
  })
}

// ─── AP aging ────────────────────────────────────────────────────────────────
//
// THE accounts-payable aging: the Accounting AP aging page, the Procurement
// Aging tab, the emailed ap_aging report and the supplier statement all read
// it. There used to be three agings (two bucketed by due date with different
// shapes — one of which crashed its tab — and the email by bill date) and a
// fourth "outstanding" on the statement; none of them tied to the ledger.
//
// Per supplier, it ties to ledger AP 2010:
//   buckets   each open bill's billDueCents (net of withholding), aged by
//             days past its DUE date (current / 1-30 / 31-60 / 61-90 / 90+)
//   credits   payments not yet applied to a bill, plus any bill paid beyond
//             what it owed — both already debited to AP in full
//   total     Σ buckets − credits   ← the supplier's AP balance in the ledger
//   opening   Supplier.openingBalanceCents, shown on its own: it was never
//             posted to the ledger, so it is not in `total`
// Suppliers with no company are never posted to any ledger; they are listed
// under `unassigned`, never inside a company's totals.

export type AgingBucketKey = 'current' | '1_30' | '31_60' | '61_90' | '90_plus'

export interface AgingRow {
  supplierId: string
  supplierName: string
  tenantId: string | null
  bills: number
  current: number
  '1_30': number
  '31_60': number
  '61_90': number
  '90_plus': number
  creditsCents: number
  total: number
  openingCents: number
}

export type AgingTotals = Omit<AgingRow, 'supplierId' | 'supplierName' | 'tenantId'>

export interface AgingReport {
  asOf: string
  bySupplier: AgingRow[]
  total: AgingTotals
  unassigned: { bySupplier: AgingRow[]; total: AgingTotals }
}

function agingBucket(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return '1_30'
  if (daysPastDue <= 60) return '31_60'
  if (daysPastDue <= 90) return '61_90'
  return '90_plus'
}

const emptyTotals = (): AgingTotals => ({ bills: 0, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0, creditsCents: 0, total: 0, openingCents: 0 })

async function agingRows(supplierWhere: Prisma.SupplierWhereInput, asOf: Date): Promise<AgingRow[]> {
  const suppliers = await prisma.supplier.findMany({
    where: supplierWhere,
    select: {
      id: true, name: true, tenantId: true, openingBalanceCents: true,
      bills: {
        where: { status: { notIn: ['void', 'draft'] } },
        select: { dueDate: true, totalCents: true, whtCents: true, paidCents: true, status: true },
      },
      payments: { select: { amountCents: true, appliedCents: true } },
    },
  })

  const rows: AgingRow[] = []
  for (const s of suppliers) {
    const row: AgingRow = {
      supplierId: s.id, supplierName: s.name, tenantId: s.tenantId,
      bills: 0, current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0,
      creditsCents: 0, total: 0, openingCents: s.openingBalanceCents,
    }
    for (const b of s.bills) {
      const due = billDueCents(b)
      if (due < 0) { row.creditsCents += -due; continue }   // paid beyond what it owed
      if (due === 0) continue
      row[agingBucket(Math.floor((asOf.getTime() - b.dueDate.getTime()) / 86_400_000))] += due
      row.bills += 1
    }
    for (const p of s.payments) row.creditsCents += Math.max(0, p.amountCents - p.appliedCents)
    row.total = row.current + row['1_30'] + row['31_60'] + row['61_90'] + row['90_plus'] - row.creditsCents
    if (row.bills > 0 || row.creditsCents > 0 || row.openingCents !== 0) rows.push(row)
  }
  return rows.sort((a, b) => b.total - a.total)
}

function totalsOf(rows: AgingRow[]): AgingTotals {
  const t = emptyTotals()
  for (const r of rows) {
    t.bills += r.bills
    t.current += r.current; t['1_30'] += r['1_30']; t['31_60'] += r['31_60']; t['61_90'] += r['61_90']; t['90_plus'] += r['90_plus']
    t.creditsCents += r.creditsCents; t.total += r.total; t.openingCents += r.openingCents
  }
  return t
}

/**
 * AP aging for the companies in `tenantIds` (the request's scope). Fails
 * closed: an empty scope is an empty report, never every company's.
 */
export async function agingReport(
  tenantIds: string[],
  opts: { includeUnassigned?: boolean; asOf?: Date } = {},
): Promise<AgingReport> {
  const asOf = opts.asOf ?? new Date()
  if (tenantIds.length === 0) {
    return { asOf: asOf.toISOString(), bySupplier: [], total: emptyTotals(), unassigned: { bySupplier: [], total: emptyTotals() } }
  }
  const [rows, orphanRows] = await Promise.all([
    agingRows({ tenantId: { in: tenantIds } }, asOf),
    opts.includeUnassigned === false ? Promise.resolve([]) : agingRows({ tenantId: null }, asOf),
  ])
  return {
    asOf: asOf.toISOString(),
    bySupplier: rows,
    total: totalsOf(rows),
    unassigned: { bySupplier: orphanRows, total: totalsOf(orphanRows) },
  }
}

/** One supplier's aging row (the statement's "outstanding"). */
export async function supplierAging(supplierId: string, asOf = new Date()): Promise<AgingRow | null> {
  const [row] = await agingRows({ id: supplierId }, asOf)
  return row ?? null
}

// ─── Reorder Suggestions ─────────────────────────────────────────────────────

/**
 * Items below par level, grouped by their primary supplier. Each group is a
 * draft PO ready to fire. Considers in-flight POs to avoid double-ordering.
 */
export async function reorderSuggestions(tenantIds?: string[]) {
  // Tenant scope filters inventory items via their preferred supplier.
  // Inventory items themselves don't carry a tenantId column — they're
  // scoped indirectly through the supplier they're sourced from. Items with
  // no preferred supplier come through unscoped (par-sheet defaults).
  const supplierFilter = tenantIds && tenantIds.length > 0
    ? { OR: [{ tenantId: { in: tenantIds } }, { tenantId: null }] }
    : null
  const items = await prisma.inventoryItem.findMany({
    where:   {
      deletedAt: null,
      ...(supplierFilter ? { OR: [{ supplier: supplierFilter }, { supplierId: null }] } : {}),
    },
    include: { supplier: { select: { id: true, name: true } } },
  })

  // In-flight: not yet fully received, not cancelled
  const openLines = await prisma.purchaseOrderLine.findMany({
    where: {
      purchaseOrder: { status: { in: ['draft', 'pending_approval', 'sent', 'partial'] } },
    },
    include: { purchaseOrder: { select: { status: true } } },
  })
  const onOrder = new Map<string, number>()
  for (const l of openLines) {
    const remaining = Math.max(0, l.quantityOrdered - l.quantityReceived)
    onOrder.set(l.inventoryItemId, (onOrder.get(l.inventoryItemId) ?? 0) + remaining)
  }

  const groups = new Map<string, {
    supplierId: string | null
    supplierName: string
    lines: Array<{
      inventoryItemId: string
      name: string
      unit: string
      currentStock: number
      parLevel: number
      onOrder: number
      suggestedQty: number
      unitCostCents: number
    }>
  }>()

  for (const item of items) {
    const incoming = onOrder.get(item.id) ?? 0
    const projected = item.currentStock + incoming
    if (projected >= item.parLevel) continue
    if (item.parLevel <= 0) continue // no par set — skip

    const suggestedQty = Math.ceil(item.parLevel - projected)
    if (suggestedQty <= 0) continue

    const key = item.supplierId ?? '__unassigned__'
    const group = groups.get(key) ?? {
      supplierId:   item.supplierId,
      supplierName: item.supplier?.name ?? 'Unassigned',
      lines: [],
    }
    group.lines.push({
      inventoryItemId: item.id,
      name:            item.name,
      unit:            item.unit,
      currentStock:    item.currentStock,
      parLevel:        item.parLevel,
      onOrder:         incoming,
      suggestedQty,
      unitCostCents:   item.unitCostCents ?? 0,
    })
    groups.set(key, group)
  }

  return Array.from(groups.values())
    .map((g) => ({
      ...g,
      estimatedTotalCents: g.lines.reduce((s, l) => s + l.suggestedQty * l.unitCostCents, 0),
    }))
    .sort((a, b) => b.estimatedTotalCents - a.estimatedTotalCents)
}
