// A PO's cash advance pays its bill by itself (owner, 2026-11-20: "How about you route those cash vouchers to supplier
// bills and update the status?" → "Yes, do it").
//
// THE GAP: under the old advance design (poCash.ts, POs approved before 2026-11-18) finance pays the PO's cash voucher
// INTO the buyer's petty-cash box, and the CEO's GRN approval creates the supplier's bill — but the bill only turned
// Paid once somebody recorded a box spend "Pays a supplier bill". Nobody did, so bills stayed Open, payables stayed up
// and the buyer's box still showed cash he had already handed to the supplier.
//
// THE RULE: a bill of a PO whose advance voucher was PAID is paid from the box that voucher topped up — through the
// SAME engine as the manual step (procurement createPaymentTx method cash + trustops recordPettyCashSpendTx nature
// 'bill': 'supplier.payment:<id>' Dr 2010 / Cr 1010 and the box spend Dr 1010 / Cr 1011). Never a second payment
// path. The amount is the smallest of:
//     what the bill still owes (billDueCents — net of withholding, payments and credit notes),
//     what is left of the advance (given − returned − already spent from that box on this PO's bills),
//     what the box holds now.
// Nothing left of any of them = nothing is paid (and nothing is written). A partly covered bill goes Partially paid;
// the rest is paid by hand as before.
//
// NEVER: a pay-back voucher's bill (CashVoucher.reimbursesBillId — finance's pay of that voucher IS its payment), a
// voided / unpaid / rejected advance, a void or paid bill, a credit note, a bill of another company than the voucher.
//
// WHEN: after the CEO's GRN approval commits (poWorkflow.ts approveGrn), after finance pays a PO voucher whose bill
// already exists (cashVouchers.ts payPoCashVoucher), and at every boot for bills already waiting (index.ts) — the
// boot sweep is idempotent: a paid bill is skipped, and what was already spent on the PO is taken off the advance.
// It never fails its caller: a refusal (closed month, a box switched off) leaves the bill open and is logged.
//
// Company: everything is the BILL's supplier's company; the voucher and the box must be that company's.

import type { Prisma } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { toCents, fmtPkrCents } from '../../lib/money.js'
import { audit } from '../../lib/audit.js'

/** A PO voucher whose cash reached the buyer's box (poCashSync.ts PAID). */
const ADVANCE_PAID = ['disbursed', 'settled', 'converted', 'posted'] as const

export interface AdvanceSettled { billId: string; billNumber: string; paidCents: number; supplierPaymentId: string; voucherNumber: string; tenantId: string }

/** Pay ONE bill from its PO's paid advance. Null when there is nothing to do. Throws only on a real refusal. */
export async function settleBillFromAdvance(billId: string): Promise<AdvanceSettled | null> {
  // Read with the service client: this runs from a route in the bill's company, from another company's request never
  // (callers pass ids they own), and at boot with no request at all.
  const head = await serviceClient.supplierBill.findUnique({
    where: { id: billId },
    select: { id: true, poId: true, kind: true, status: true, supplier: { select: { tenantId: true } } },
  })
  if (!head?.poId || head.kind !== 'bill' || !head.supplier.tenantId) return null
  if (head.status !== 'open' && head.status !== 'partially_paid') return null
  const tenantId = head.supplier.tenantId
  const voucher = await serviceClient.cashVoucher.findUnique({
    where: { purchaseOrderId: head.poId },
    select: { id: true, number: true, tenantId: true, status: true, amountCents: true, returnedCents: true, pettyCashMovementId: true, payeeUserId: true },
  })
  if (!voucher || voucher.tenantId !== tenantId || !voucher.pettyCashMovementId || !voucher.payeeUserId) return null
  if (!(ADVANCE_PAID as readonly string[]).includes(voucher.status)) return null
  // The buyer is paid back at this bill instead (owner, 2026-11-18): that voucher's pay is the payment.
  if (await serviceClient.cashVoucher.findUnique({ where: { reimbursesBillId: billId }, select: { id: true } })) return null

  const { runWithRlsContext } = await import('../../lib/rlsContext.js')
  const done = await runWithRlsContext({ tenantIds: [tenantId] }, () => prisma.$transaction(async (tx) => settleTx(tx, billId, voucher.id, tenantId), { timeout: 20_000, maxWait: 10_000 }))
  if (!done) return null
  await audit({
    category: 'accounting', action: 'supplier_bill.paid_from_po_advance', entity: 'SupplierBill', entityId: billId,
    userId: done.buyerId, tenantId,
    after: { billNumber: done.billNumber, paidCents: done.paidCents, supplierPaymentId: done.supplierPaymentId, voucherId: voucher.id, voucherNumber: voucher.number, boxId: done.boxId, automatic: true },
  })
  const { refreshPoCashExcessFlag } = await import('./poCashSync.js')
  await refreshPoCashExcessFlag(voucher.id, null)
  return { billId, billNumber: done.billNumber, paidCents: done.paidCents, supplierPaymentId: done.supplierPaymentId, voucherNumber: voucher.number, tenantId }
}

async function settleTx(tx: Prisma.TransactionClient, billId: string, voucherId: string, tenantId: string) {
  // One settle per voucher at a time: two bills of one PO never both spend the same advance.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'po_advance_settle:' + voucherId}))`
  const voucher = await tx.cashVoucher.findUnique({
    where: { id: voucherId },
    select: { id: true, number: true, tenantId: true, status: true, amountCents: true, returnedCents: true, pettyCashMovementId: true, payeeUserId: true, purchaseOrderId: true },
  })
  if (!voucher?.purchaseOrderId || !voucher.pettyCashMovementId || !voucher.payeeUserId || voucher.tenantId !== tenantId) return null
  if (!(ADVANCE_PAID as readonly string[]).includes(voucher.status)) return null
  const bill = await tx.supplierBill.findFirst({
    where: { id: billId, poId: voucher.purchaseOrderId, kind: 'bill', status: { in: ['open', 'partially_paid'] }, supplier: { tenantId } },
    select: { id: true, billNumber: true, supplierId: true, totalCents: true, whtCents: true, paidCents: true, creditedCents: true, supplier: { select: { name: true } } },
  })
  if (!bill) return null
  const topup = await tx.pettyCashMovement.findUnique({ where: { id: voucher.pettyCashMovementId }, select: { boxId: true } })
  if (!topup) return null
  const box = await tx.pettyCashBox.findFirst({
    where: { id: topup.boxId, tenantId, isActive: true, deletedAt: null },
    select: { id: true, name: true, floatCents: true },
  })
  if (!box) return null

  const { billDueCents, createPaymentTx } = await import('./service.js')
  const due = billDueCents(bill)
  // What this box already paid on this PO's bills (live payments only) comes off the advance.
  const spends = await tx.pettyCashMovement.findMany({ where: { boxId: box.id, type: 'spend', supplierPaymentId: { not: null } }, select: { supplierPaymentId: true } })
  const paymentIds = spends.map((s) => s.supplierPaymentId!).filter(Boolean)
  const applied = paymentIds.length
    ? await tx.supplierPaymentApplication.findMany({
      where: { paymentId: { in: paymentIds }, payment: { voidedAt: null }, bill: { poId: voucher.purchaseOrderId } },
      select: { amountAppliedCents: true },
    })
    : []
  const spent = applied.reduce((s, a) => s + toCents(a.amountAppliedCents), 0)
  const left = voucher.amountCents - voucher.returnedCents - spent
  const amount = Math.min(due, left, box.floatCents)
  if (amount <= 0) return null

  const po = await tx.purchaseOrder.findUnique({ where: { id: voucher.purchaseOrderId }, select: { reference: true } })
  const reason = `${voucher.number} cash for ${po?.reference ?? 'the purchase order'} — paid ${bill.supplier.name}, bill ${bill.billNumber} (${fmtPkrCents(amount)})`
  const payment = await createPaymentTx(tx, {
    supplierId: bill.supplierId,
    paymentDate: new Date().toISOString(),
    method: 'cash',
    reference: `petty cash: ${box.name}`,
    amountCents: amount,
    notes: reason,
    applications: [{ billId: bill.id, amountAppliedCents: amount }],
    createdBy: voucher.payeeUserId,
  })
  const { recordPettyCashSpendTx } = await import('../trustops/pettyCash.js')
  await recordPettyCashSpendTx(tx, {
    box, amountCents: amount, reason, vendorName: bill.supplier.name,
    supplierPaymentId: payment.id, createdById: voucher.payeeUserId, nature: 'bill',
  })
  return { billNumber: bill.billNumber, paidCents: amount, supplierPaymentId: payment.id, boxId: box.id, buyerId: voucher.payeeUserId }
}

/** After commit, never failing the caller: settle one bill, logging a refusal. */
export async function settleBillFromAdvanceQuietly(billId: string): Promise<AdvanceSettled | null> {
  try {
    return await settleBillFromAdvance(billId)
  } catch (err) {
    console.warn(`[poAdvance] bill ${billId} not paid from its PO's advance: ${(err as Error).message}`)
    return null
  }
}

/** Every open bill of the voucher's PO (finance just paid the advance, or the boot sweep). */
export async function settleBillsOfVoucher(voucherId: string): Promise<AdvanceSettled[]> {
  const v = await serviceClient.cashVoucher.findUnique({ where: { id: voucherId }, select: { purchaseOrderId: true } })
  if (!v?.purchaseOrderId) return []
  const bills = await serviceClient.supplierBill.findMany({
    where: { poId: v.purchaseOrderId, kind: 'bill', status: { in: ['open', 'partially_paid'] } },
    select: { id: true }, orderBy: { billDate: 'asc' },
  })
  const out: AdvanceSettled[] = []
  for (const b of bills) {
    const r = await settleBillFromAdvanceQuietly(b.id)
    if (r) out.push(r)
  }
  return out
}

/** Boot, every start (idempotent): bills already waiting on a paid advance, per company. */
export async function sweepAdvanceBills(): Promise<AdvanceSettled[]> {
  const vouchers = await serviceClient.cashVoucher.findMany({
    where: { purchaseOrderId: { not: null }, status: { in: [...ADVANCE_PAID] }, pettyCashMovementId: { not: null } },
    select: { id: true }, orderBy: { createdAt: 'asc' },
  })
  const out: AdvanceSettled[] = []
  for (const v of vouchers) out.push(...await settleBillsOfVoucher(v.id))
  return out
}
