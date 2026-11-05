// Test helpers for purchase orders (the service functions directly; the routes' rights are tested in
// poApprovalChain.test.ts).
//
//   approvePoChain — submit → the CEO approves (owner, 2026-11-05: the PO → GRN workflow). Bought on the supplier's
//     credit by default (no cash voucher); `payByCash: true` raises the PO's cash voucher as the CEO's approval does.
//     Such a PO is received ONLY by its requester's confirmation (buyAndConfirm).
//   approveLegacyPo — the same, then marked as a PO approved BEFORE the workflow (grnWorkflow false): the dock and the
//     PO receive route still receive it. For tests of the receiving mechanics themselves (stock, lots, GRNI).
//   buyAndConfirm — the buyer attaches an invoice file and completes it; the requester confirms receipt (a GRN).
import { submitPo, approvePo } from '../src/modules/procurement/service.js'
import { completePo, confirmReceipt } from '../src/modules/procurement/poWorkflow.js'
import { serviceClient as prisma } from '../src/lib/prisma.js'

export async function approvePoChain(poId: string, by: string, o: { payByCash?: boolean; buyerUserId?: string } = {}) {
  await submitPo(poId, by)
  return approvePo(poId, by, undefined, { payByCash: o.payByCash ?? false, buyerUserId: o.buyerUserId ?? by })
}

export async function approveLegacyPo(poId: string, by: string, o: { payByCash?: boolean } = {}) {
  const r = await approvePoChain(poId, by, o)
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { grnWorkflow: false } })
  return r
}

/** A tiny PDF as an invoice file on the PO (the record-file store). */
export async function attachInvoiceFile(poId: string, uploadedById: string) {
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { supplier: { select: { tenantId: true } } } })
  return prisma.cashVoucherAttachment.create({
    data: {
      tenantId: po.supplier.tenantId!, kind: 'record_file', ownerType: 'purchase_order', ownerId: poId,
      mime: 'application/pdf', fileName: 'invoice.pdf', sizeBytes: 8, data: Buffer.from('%PDF-1.4'), uploadedById,
    },
  })
}

export async function buyAndConfirm(
  poId: string,
  o: { buyer: { id: string; role: string }; requester: { id: string; role: string }; invoiceNumber?: string; locationId?: string | null; qty?: (poLineId: string, ordered: number, received: number) => number },
) {
  await attachInvoiceFile(poId, o.buyer.id)
  await completePo(poId, o.buyer, { invoiceNumber: o.invoiceNumber ?? `INV-${poId.slice(0, 8)}`, invoiceDate: new Date().toISOString().slice(0, 10) })
  const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId } })
  return confirmReceipt(poId, o.requester, {
    locationId: o.locationId ?? null,
    lines: lines.map((l) => ({ poLineId: l.id, quantityReceived: o.qty ? o.qty(l.id, l.quantityOrdered, l.quantityReceived) : l.quantityOrdered - l.quantityReceived })),
  })
}
