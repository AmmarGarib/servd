// Cash for a purchase order.
//
// SINCE 2026-11-18 (owner: "Remove cash advance option, Buyer will get cash after purchase") a cash PO raises NO voucher
// at the CEO's approval: see "Pay the buyer back after the purchase" at the foot of this file (raiseReimbursementTx).
// The advance design below stays ONLY for POs approved before that (cashAfterPurchase false, a voucher with
// purchaseOrderId): their vouchers are still approved, paid into the buyer's box and spent on the bill as before.
//
// (owner, 2026-11-03: "asif takes cash from hasnain. asif buys" — and, asked how the cash is handled: "Cash voucher
// tied to PO").
//
// THE OLD ADVANCE DESIGN (money is booked exactly once; every step reuses an existing engine):
//
//   1. CEO approves the PO (service.ts approvePo) → in the SAME transaction raisePoCashVoucherTx raises ONE cash
//      voucher (CashVoucher.purchaseOrderId @unique, kind 'request', CV-00001 series of the PO's company) for the PO
//      total, in the BUYER's name (the holder — the buyer the approval named, owner 2026-11-05). The CEO's approval of
//      the PO IS the CEO's step (directorSignedById), but FINANCE still approves it (owner, 2026-11-10: "Finance approval
//      getting skipped, fix it"): it is raised 'submitted' and finance's POST /:id/finance-approve moves it straight to
//      'approved' (the CEO already signed). Exceptions, raised 'approved' at once: a PO finance checked under the retired
//      2026-11-03 chain (financeCheckedById), or a PO a finance login raised (the finance-raised rule of 2026-10-24).
//      Posts nothing.
//
//   2. Finance pays it (POST /trustops/cash-vouchers/:id/pay — the normal pay route, finance only). For a PO voucher
//      the pay is NOT an expense (that would double-count: the goods are booked at the dock). It TOPS UP the buyer's
//      petty-cash box (trustops/pettyCash.ts — the box whose custodian is the holder; one is opened at float 0 when
//      the buyer has none):
//         cash on hand  → recordPettyCashTopupTx source 'safe'  'pettycash.topup:<movementId>'  Dr 1011 / Cr 1010
//         a bank        → recordPettyCashTopupTx source 'bank'  'pettycash.topup:<movementId>'  Dr 1011 / Cr <bank>
//         finance's box → recordPettyCashTransferTx box → box (no entry: both sit on 1011)
//      The cash is now in the buyer's custody ON THE BOOKS (1011, his box's float) — never an advance account (1355 /
//      1357 are retired) and never an expense.
//
//   3. The buyer buys, attaches the supplier's invoice and marks the PO completed; the REQUESTER (the PO's raiser —
//      owner, 2026-11-05: "the completed PO + invoice goes back to the original Requester to confirm the items were
//      received") confirms what arrived, which makes the GRN through the receiving engine (poWorkflow.ts
//      confirmReceipt → receiving.ts receiveGoods):
//         'procurement.receipt:<receiptId>'  Dr 12x0 per class (6045 for non-food) / Cr 2015 GRNI
//
//   4. Finance verifies the GRN, the CEO approves it — and that approval creates the supplier's bill from the invoice
//      (poWorkflow.ts approveGrn → createBill's engine): 'supplier.bill:<billId>'  Dr 2015 / Cr 2010. The buyer (the
//      box's custodian) — or finance — then pays it FROM THE BUYER'S BOX: POST /trustops/petty-cash/movements
//      {type 'spend', supplierBillId} (createPaymentTx method cash + recordPettyCashSpendTx nature 'bill'):
//         'supplier.payment:<id>'       Dr 2010 / Cr 1010, and the box spend nature 'bill'  Dr 1010 / Cr 1011
//      Change stays in the buyer's box (his float) or goes back with a box return (Dr 1010 / Cr 1011).
//      A PO the CEO approved without cash (bought on credit) is paid by finance through Supplier payments.
//
// Net effect: cash 1010 → 1011 (buyer) → supplier; stock / expense once at the dock; AP raised and cleared once.
//
// Company: the voucher is the PO's SUPPLIER's company (the PO's company); its holder must be a login of that company.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { INT4_MAX_CENTS, toCents } from '../../lib/money.js'

type Tx = Prisma.TransactionClient

export interface PoCashPlan {
  poId: string
  tenantId: string
  reference: string
  supplierName: string
  amountCents: number
  conceptId: string | null
  holder: { id: string; name: string }
  preparedById: string | null
  submittedById: string | null
  financeCheckedById: string | null
}

/**
 * Who takes the cash: the login the CEO names, else the PO's buyer (approvePo passes the buyer it chose — owner,
 * 2026-11-05), else the PO's raiser. Must be an active login of the PO's company (422 CASH_HOLDER_NOT_IN_COMPANY).
 */
export async function prepareCashVoucher(poId: string, namedHolderId: string | null): Promise<PoCashPlan> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true, reference: true, totalCents: true, conceptId: true, createdBy: true, submittedById: true,
      financeCheckedById: true, buyerUserId: true, supplier: { select: { name: true, tenantId: true, systemKind: true } },
    },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  const tenantId = po.supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before approving its PO', 422)
  const amountCents = toCents(po.totalCents)
  if (!(amountCents > 0)) throw new AppError('PO_TOTAL_ZERO', 'This PO is worth nothing — there is no cash to hand over', 422)
  if (amountCents > INT4_MAX_CENTS) {
    throw new AppError('AMOUNT_TOO_LARGE', 'This PO is too large to be paid in cash — approve it without the cash voucher and pay the supplier by bank', 422)
  }
  const holderId = namedHolderId ?? po.buyerUserId ?? po.createdBy
  if (!holderId) throw new AppError('CASH_HOLDER_REQUIRED', 'Name who takes the cash for this PO', 422)
  const holder = await prisma.user.findFirst({
    where: { id: holderId, deletedAt: null, isActive: true, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true, email: true },
  })
  if (!holder) throw new AppError('CASH_HOLDER_NOT_IN_COMPANY', 'Whoever takes the cash must be an active login of this PO\'s company', 422)
  return {
    poId, tenantId, reference: po.reference ?? `PO ${po.id.slice(-8).toUpperCase()}`, supplierName: po.supplier.systemKind ? 'supplier to be chosen' : po.supplier.name, amountCents,
    conceptId: po.conceptId, holder: { id: holder.id, name: (holder.name ?? holder.email ?? 'Buyer').slice(0, 120) },
    preparedById: po.createdBy, submittedById: po.submittedById, financeCheckedById: po.financeCheckedById,
  }
}

/**
 * Raise the PO's cash voucher inside the approval's transaction (header, step 1). One per PO: a second call for the
 * same PO returns the existing voucher. Numbered under the company's cash-voucher lock (as POST /trustops/cash-vouchers).
 */
export async function raisePoCashVoucherTx(tx: Tx, p: PoCashPlan, approverId: string): Promise<{ id: string; number: string; status: string }> {
  const existing = await tx.cashVoucher.findUnique({ where: { purchaseOrderId: p.poId }, select: { id: true, number: true, status: true } })
  if (existing && existing.status !== 'cancelled') return { id: existing.id, number: existing.number, status: existing.status }
  if (existing) {
    // A voucher cancelled with an earlier round of this PO (cannot happen today: a cancelled PO is never approved
    // again) — release its link so the new one can be raised.
    await tx.cashVoucher.update({ where: { id: existing.id }, data: { purchaseOrderId: null } })
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.tenantId}::text), hashtext('cash-voucher-seq'))`
  const max = await tx.cashVoucher.aggregate({ where: { tenantId: p.tenantId }, _max: { seq: true } })
  const seq = (max._max.seq ?? 0) + 1
  const now = new Date()
  // Finance's step: already signed when finance checked the PO (retired chain) or a finance login raised the PO.
  const raisedByFinance = !p.financeCheckedById && !!p.preparedById && !!(await tx.user.findFirst({
    where: { id: p.preparedById, role: 'finance', isActive: true, deletedAt: null }, select: { id: true },
  }))
  const financeSignerId = p.financeCheckedById ?? (raisedByFinance ? p.preparedById : null)
  const v = await tx.cashVoucher.create({
    data: {
      tenantId: p.tenantId,
      seq,
      number: `CV-${String(seq).padStart(5, '0')}`,
      kind: 'request',
      voucherDate: now,
      payeeName: p.holder.name,
      payeeUserId: p.holder.id,
      purpose: `Cash to buy ${p.reference} from ${p.supplierName}`.slice(0, 500),
      category: null,
      conceptId: p.conceptId,
      amountCents: p.amountCents,
      discountCents: 0,
      status: financeSignerId ? 'approved' : 'submitted',
      preparedById: p.preparedById ?? approverId,
      submittedById: p.submittedById ?? p.preparedById ?? approverId,
      submittedAt: now,
      financeApprovedById: financeSignerId,
      financeApprovedAt: financeSignerId ? now : null,
      directorSignedById: approverId,
      directorSignedAt: now,
      purchaseOrderId: p.poId,
    },
    select: { id: true, number: true, status: true },
  })
  await tx.auditLog.create({
    data: {
      category: 'accounting', action: 'cash_voucher.raised_for_po', entity: 'CashVoucher', entityId: v.id, tenantId: p.tenantId,
      userId: approverId, after: { number: v.number, purchaseOrderId: p.poId, reference: p.reference, amountCents: p.amountCents, holderUserId: p.holder.id },
    },
  })
  return v
}

// ─── Pay the buyer back after the purchase (owner, 2026-11-18) ───────────────
//
// "Remove cash advance option, Buyer will get cash after purchase." A cash PO the CEO approved after this rule is
// `cashAfterPurchase`: nothing is raised at the PO's approval. The buyer buys with his own money, completes the PO,
// the requester confirms (GRN: Dr 12x0 | the chosen expense account / Cr 2015), finance checks, and the CEO's GRN
// approval creates the supplier bill (Dr 2015 / Cr 2010) AND — in the same transaction — raiseReimbursementTx raises
// ONE voucher in the buyer's name for what that bill still owes (CashVoucher.reimbursesBillId @unique; one per GRN, so
// a PO received in two parts gets two). It is raised 'approved' (finance checked the GRN, the CEO approved it). Posts
// nothing.
//
// Finance's pay (cashVouchers.ts payBuyerBack) gives the buyer his money back and SETTLES THE BILL — the buyer already
// paid the supplier, so the money leaving servd is the supplier payment:
//    cash on hand / a bank → createPaymentTx  'supplier.payment:<id>'  Dr 2010 / Cr 1010 | the bank
//    finance's box         → createPaymentTx cash + recordPettyCashSpendTx nature 'bill'  (Dr 2010 / Cr 1010, Dr 1010 / Cr 1011)
// The voucher goes straight to 'posted' (the supplier's invoice on the PO is the document). Booked once: the bill is
// paid by this payment only — a second payment of it (Supplier payments, a box spend) is refused while the voucher is
// open (assertBillNotAwaitingBuyer), and the pay refuses a bill already paid in part (409 BILL_ALREADY_PAID).

/** Raise the buyer's pay-back voucher for a bill (inside the GRN approval's transaction). Idempotent per bill. */
export async function raiseReimbursementTx(tx: Tx, a: {
  billId: string; poId: string; grnNumber: string; approverId: string; financeCheckedById: string | null
}): Promise<{ id: string; number: string; status: string } | null> {
  const existing = await tx.cashVoucher.findUnique({ where: { reimbursesBillId: a.billId }, select: { id: true, number: true, status: true } })
  if (existing) return existing
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: a.poId },
    select: { reference: true, conceptId: true, createdBy: true, buyerUserId: true, supplier: { select: { name: true, tenantId: true } } },
  })
  const bill = await tx.supplierBill.findUniqueOrThrow({ where: { id: a.billId }, select: { totalCents: true, whtCents: true, paidCents: true, creditedCents: true, billNumber: true } })
  const tenantId = po.supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company first', 422)
  const amountCents = toCents(bill.totalCents) - toCents(bill.whtCents) - toCents(bill.paidCents) - toCents(bill.creditedCents)
  if (!(amountCents > 0)) return null
  if (amountCents > INT4_MAX_CENTS) throw new AppError('AMOUNT_TOO_LARGE', 'This bill is too large to be paid back in cash — pay the supplier by bank', 422)
  const holderId = po.buyerUserId ?? po.createdBy
  const holder = holderId ? await tx.user.findUnique({ where: { id: holderId }, select: { id: true, name: true, email: true } }) : null
  if (!holder) throw new AppError('CASH_HOLDER_REQUIRED', 'This PO names no buyer to pay back', 422)
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('cash-voucher-seq'))`
  const max = await tx.cashVoucher.aggregate({ where: { tenantId }, _max: { seq: true } })
  const seq = (max._max.seq ?? 0) + 1
  const now = new Date()
  const ref = po.reference ?? 'PO'
  const v = await tx.cashVoucher.create({
    data: {
      tenantId, seq, number: `CV-${String(seq).padStart(5, '0')}`, kind: 'request', voucherDate: now,
      payeeName: (holder.name ?? holder.email ?? 'Buyer').slice(0, 120), payeeUserId: holder.id,
      purpose: `Pay back ${ref} (${a.grnNumber}, bill ${bill.billNumber}) bought from ${po.supplier.name}`.slice(0, 500),
      category: null, conceptId: po.conceptId, amountCents, discountCents: 0,
      status: 'approved',
      preparedById: po.createdBy ?? a.approverId, submittedById: po.createdBy ?? a.approverId, submittedAt: now,
      financeApprovedById: a.financeCheckedById, financeApprovedAt: a.financeCheckedById ? now : null,
      directorSignedById: a.approverId, directorSignedAt: now,
      reimbursesBillId: a.billId,
    },
    select: { id: true, number: true, status: true },
  })
  await tx.auditLog.create({
    data: {
      category: 'accounting', action: 'cash_voucher.raised_to_pay_back', entity: 'CashVoucher', entityId: v.id, tenantId,
      userId: a.approverId, after: { number: v.number, purchaseOrderId: a.poId, reference: ref, billId: a.billId, amountCents, holderUserId: holder.id },
    },
  })
  return v
}

/**
 * A bill waiting for the buyer's pay-back voucher is paid ONLY by that voucher's pay (booked once). Every other
 * payer of a supplier bill calls this first: 409 BILL_AWAITING_BUYER_PAYBACK while the voucher is unpaid.
 */
export async function assertBillNotAwaitingBuyer(db: Tx | typeof prisma, billIds: string[]): Promise<void> {
  if (billIds.length === 0) return
  const v = await db.cashVoucher.findFirst({
    where: { reimbursesBillId: { in: billIds }, status: { notIn: ['posted', 'cancelled', 'rejected'] } },
    select: { number: true },
  })
  if (v) throw new AppError('BILL_AWAITING_BUYER_PAYBACK', `This bill is paid by paying the buyer back on ${v.number} — pay that voucher instead`, 409)
}
