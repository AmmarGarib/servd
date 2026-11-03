// Cash for a purchase order (owner, 2026-11-03: "asif takes cash from hasnain. asif buys" — and, asked how the cash is
// handled: "Cash voucher tied to PO").
//
// THE DESIGN (money is booked exactly once; every step reuses an existing engine):
//
//   1. CEO approves the PO (service.ts approvePo) → in the SAME transaction raisePoCashVoucherTx raises ONE cash
//      voucher (CashVoucher.purchaseOrderId @unique, kind 'request', CV-00001 series of the PO's company) for the PO
//      total, in the BUYER's name (the holder), already 'approved' — the PO chain's finance check and the CEO's
//      approval ARE its approvals (financeApprovedById / directorSignedById are stamped from the PO). Posts nothing.
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
//   3. The buyer buys; a manager who did NOT raise the PO receives it (receiving.ts receiveGoods — the existing route;
//      owner 2026-11-03: "raiser cannot mark recvd"):
//         'procurement.receipt:<receiptId>'  Dr 12x0 per class (6045 for non-food) / Cr 2015 GRNI
//
//   4. Finance records the supplier's bill against that receipt (createBill); the buyer (the box's custodian) — or
//      finance — pays it FROM THE BUYER'S BOX: POST /trustops/petty-cash/movements {type 'spend', supplierBillId}
//      (createPaymentTx method cash + recordPettyCashSpendTx nature 'bill' — the existing engines):
//         'supplier.bill:<billId>'      Dr 2015 / Cr 2010
//         'supplier.payment:<id>'       Dr 2010 / Cr 1010, and the box spend nature 'bill'  Dr 1010 / Cr 1011
//      Change stays in the buyer's box (his float) or goes back with a box return (Dr 1010 / Cr 1011).
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
 * Who takes the cash: the login the CEO names, else the buyer who passed the buyer step (a 'procurement' login),
 * else the PO's raiser. Must be an active login of the PO's company (422 CASH_HOLDER_NOT_IN_COMPANY).
 */
export async function prepareCashVoucher(poId: string, namedHolderId: string | null): Promise<PoCashPlan> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true, reference: true, totalCents: true, conceptId: true, createdBy: true, submittedById: true,
      buyerCheckedById: true, financeCheckedById: true, supplier: { select: { name: true, tenantId: true } },
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
  const buyer = po.buyerCheckedById
    ? await prisma.user.findUnique({ where: { id: po.buyerCheckedById }, select: { id: true, role: true } })
    : null
  const holderId = namedHolderId ?? (buyer?.role === 'procurement' ? buyer.id : null) ?? po.createdBy
  if (!holderId) throw new AppError('CASH_HOLDER_REQUIRED', 'Name who takes the cash for this PO', 422)
  const holder = await prisma.user.findFirst({
    where: { id: holderId, deletedAt: null, isActive: true, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true, email: true },
  })
  if (!holder) throw new AppError('CASH_HOLDER_NOT_IN_COMPANY', 'Whoever takes the cash must be an active login of this PO\'s company', 422)
  return {
    poId, tenantId, reference: po.reference ?? `PO ${po.id.slice(-8).toUpperCase()}`, supplierName: po.supplier.name, amountCents,
    conceptId: po.conceptId, holder: { id: holder.id, name: (holder.name ?? holder.email ?? 'Buyer').slice(0, 120) },
    preparedById: po.createdBy, submittedById: po.submittedById, financeCheckedById: po.financeCheckedById,
  }
}

/**
 * Raise the PO's cash voucher inside the approval's transaction (header, step 1). One per PO: a second call for the
 * same PO returns the existing voucher. Numbered under the company's cash-voucher lock (as POST /trustops/cash-vouchers).
 */
export async function raisePoCashVoucherTx(tx: Tx, p: PoCashPlan, approverId: string): Promise<{ id: string; number: string }> {
  const existing = await tx.cashVoucher.findUnique({ where: { purchaseOrderId: p.poId }, select: { id: true, number: true, status: true } })
  if (existing && existing.status !== 'cancelled') return { id: existing.id, number: existing.number }
  if (existing) {
    // A voucher cancelled with an earlier round of this PO (cannot happen today: a cancelled PO is never approved
    // again) — release its link so the new one can be raised.
    await tx.cashVoucher.update({ where: { id: existing.id }, data: { purchaseOrderId: null } })
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${p.tenantId}::text), hashtext('cash-voucher-seq'))`
  const max = await tx.cashVoucher.aggregate({ where: { tenantId: p.tenantId }, _max: { seq: true } })
  const seq = (max._max.seq ?? 0) + 1
  const now = new Date()
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
      status: 'approved',
      preparedById: p.preparedById ?? approverId,
      submittedById: p.submittedById ?? p.preparedById ?? approverId,
      submittedAt: now,
      financeApprovedById: p.financeCheckedById,
      financeApprovedAt: p.financeCheckedById ? now : null,
      directorSignedById: approverId,
      directorSignedAt: now,
      purchaseOrderId: p.poId,
    },
    select: { id: true, number: true },
  })
  await tx.auditLog.create({
    data: {
      category: 'accounting', action: 'cash_voucher.raised_for_po', entity: 'CashVoucher', entityId: v.id, tenantId: p.tenantId,
      userId: approverId, after: { number: v.number, purchaseOrderId: p.poId, reference: p.reference, amountCents: p.amountCents, holderUserId: p.holder.id },
    },
  })
  return v
}
