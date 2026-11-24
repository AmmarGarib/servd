// Void a PAID cash voucher (owner, 2026-11-18: "how to void booked cash voucher?" → "finance requests it with a reason
// and you approve it").
//
// Who: finance (role finance holding `accounting`) asks with a reason ≥10 — POST /trustops/cash-vouchers/:id/void →
// 202 { pendingApproval, request }; nothing changes until the CEO approves. The CEO's own void applies at once (200,
// and closes a pending request as approved). One pending request per voucher (409 VOID_PENDING). Approval type
// cash_voucher_void (section ceo, never handed over): POST /void-requests/:id/approve | reject {note ≥10}; the
// requester (or the CEO) may withdraw. Table cash_voucher_void_requests (tenantId = the voucher's company, RLS, merge
// repoint).
//
// What can be voided: a voucher booked in ONE entry when finance paid it (bookedAtPay), paid in cash — from a
// petty-cash box, cash on hand or a bank — with its documents open or checked (status disbursed | posted). Never a
// voucher on credit (void its supplier bill), equipment (CapEx), an old 1357 hold, or one with change / conversions
// recorded (voidBlockOf says which, 422).
//
// A PO's vouchers (owner, 2026-11-18: "Add voiding for PO vouchers too"):
//   * the buyer's cash ADVANCE (purchaseOrderId — the cash went into the buyer's box, Dr 1011): the cash still with him
//     (given − extra already returned) comes back OUT of his box to where it came from — the safe / the bank through
//     recordPettyCashReturnTx (Dr 1010 | the bank / Cr 1011), finance's box through a box → box transfer (no entry).
//     Refused once he paid the supplier from that box (409 VOID_PO_CASH_SPENT) or the box holds less (400
//     INSUFFICIENT_FLOAT). With no advance left the PO's buyer is paid back at its bill (poCash.ts noAdvanceGivenTx):
//     a GRN already approved gets its pay-back voucher in the same transaction.
//   * the buyer's PAY-BACK (reimbursesBillId — its pay was the supplier payment of the bill): that payment is taken off
//     the bill and reversed (procurement voidPayBackPaymentTx: 'supplier.payment.void:<id>' Dr the money / Cr 2010);
//     paid from finance's box, the cash also goes back into that box (top-up source safe: Dr 1011 / Cr 1010, which nets
//     the reversal's Dr 1010 to Dr 1011 / Cr 2010). The bill owes again; the voucher keeps it as voidedBillId
//     (reimbursesBillId cleared) and a FRESH pay-back voucher is raised for what the bill owes, ready to pay.
//
// What a void does (one transaction, the voucher row locked; the CEO's approval is the authority):
//   * paid from a BOX: the cash goes back into the SAME box — a petty-cash top-up (source cash_request) through
//     recordPettyCashTopupTx + postPettyCashMovementTx: Dr 1011 / Cr the expense account the pay debited, under the
//     pay's brand ('pettycash.topup:<movementId>'). The pay's own spend entry stays (history); the two net to zero.
//   * paid from CASH ON HAND / a BANK: the pay entry is reversed ('cashvoucher.pay.reversal:<voucherId>', dated today).
//   Then the voucher is 'voided' (voidedAt / voidedById / voidReason / voidEntryId). Supporting documents stay.
// Nothing is deleted. A spend line of a voided voucher can no longer be moved to another account (409 VOUCHER_VOIDED).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { fmtPkrCents } from '../../lib/money.js'
import { CASH_VOUCHER_PAY_ENTRY, cashRequestPaidAccountTx, postPettyCashMovementTx } from '../accounting/pettyCashPosting.js'
import { reverseJournalEntry } from '../accounting/journal.js'
import { recordPettyCashTopupTx } from './pettyCash.js'

type Db = Prisma.TransactionClient | typeof prisma

const REASON = z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500)
const STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const

const VOID_SELECT = {
  id: true, tenantId: true, number: true, status: true, bookedAtPay: true, paySource: true, payJournalEntryId: true,
  pettyCashMovementId: true, postedJournalEntryId: true, supplierBillId: true, assetClassId: true, capexLineId: true,
  purchaseOrderId: true, reimbursesBillId: true, returnedCents: true, convertedCents: true, amountCents: true,
  payeeName: true, purpose: true, voidedAt: true, boxId: true, payBankAccountId: true, payeeUserId: true,
} satisfies Prisma.CashVoucherSelect
type VoidRow = Prisma.CashVoucherGetPayload<{ select: typeof VOID_SELECT }>

const no = (code: string, message: string, status = 422) => new AppError(code, message, status)

/** Why `v` cannot be voided (null = it can). Read-only. */
export async function voidBlockOf(db: Db, v: VoidRow): Promise<AppError | null> {
  if (v.status === 'voided' || v.voidedAt) return no('ALREADY_VOIDED', `Cash voucher ${v.number} is already voided`, 409)
  if (v.status !== 'disbursed' && v.status !== 'posted') {
    return no('VOUCHER_NOT_PAID', `Cash voucher ${v.number} is not paid — cancel or reject it instead`, 409)
  }
  if (v.purchaseOrderId) return poAdvanceBlock(db, v)
  if (v.reimbursesBillId) return payBackBlock(db, v)
  if (v.paySource === 'credit' || v.supplierBillId) {
    return no('VOID_USE_SUPPLIER_BILL', `Cash voucher ${v.number} was booked on credit as a supplier bill — void that bill instead`)
  }
  if (v.assetClassId || v.capexLineId) {
    return no('VOID_EQUIPMENT', `Cash voucher ${v.number} bought equipment through CapEx — correct it there`)
  }
  if (!v.bookedAtPay || v.postedJournalEntryId) {
    return no('VOID_OLD_FLOW', `Cash voucher ${v.number} was paid under an older flow — correct it with a manual journal`)
  }
  if (v.returnedCents > 0 || v.convertedCents > 0) {
    return no('VOID_HAS_CHANGE', `Cash voucher ${v.number} already has change or a conversion recorded — correct it with a manual journal`)
  }
  if (v.paySource === 'box') {
    if (!v.pettyCashMovementId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    const m = await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { journalEntryId: true, box: { select: { deletedAt: true, name: true } } } })
    if (!m?.journalEntryId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    if (m.box.deletedAt) return no('BOX_REMOVED', `The petty-cash box "${m.box.name}" this voucher was paid from has been removed — correct it with a manual journal`)
    try { await cashRequestPaidAccountTx(db, v.id) } catch (err) { return err instanceof AppError ? err : no('PAYMENT_NOT_BOOKED', (err as Error).message, 409) }
    return null
  }
  if (v.paySource === 'cash_on_hand' || v.paySource === 'bank') {
    if (!v.payJournalEntryId) return no('PAYMENT_NOT_BOOKED', `The payment of cash voucher ${v.number} is not on the books`, 409)
    const reversed = await db.journalEntry.findFirst({ where: { tenantId: v.tenantId, reference: `${CASH_VOUCHER_PAY_ENTRY}.reversal:${v.id}` }, select: { id: true } })
    if (reversed) return no('ALREADY_VOIDED', `The payment of cash voucher ${v.number} is already reversed`, 409)
    return null
  }
  return no('VOID_UNKNOWN_SOURCE', `Cash voucher ${v.number} was paid in a way that cannot be voided here`)
}

/** Where a PO advance's cash sits now: the buyer's box it was paid into. */
async function advanceBoxOf(db: Db, v: VoidRow): Promise<{ id: string; name: string; tenantId: string; floatCents: number; deletedAt: Date | null } | null> {
  if (!v.pettyCashMovementId) return null
  const m = await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { boxId: true } })
  if (!m) return null
  const b = await db.pettyCashBox.findUnique({ where: { id: m.boxId }, select: { id: true, name: true, tenantId: true, floatCents: true, deletedAt: true } })
  return b ? { ...b, tenantId: b.tenantId! } : null
}

/** The PO's bills the buyer already paid from the box the advance went into. */
async function advanceSpentOnBills(db: Db, poId: string, boxId: string): Promise<number> {
  const bills = await db.supplierBill.findMany({ where: { poId, status: { not: 'void' } }, select: { id: true } })
  if (bills.length === 0) return 0
  const apps = await db.supplierPaymentApplication.findMany({ where: { billId: { in: bills.map((b) => b.id) } }, select: { paymentId: true } })
  if (apps.length === 0) return 0
  return db.pettyCashMovement.count({ where: { boxId, type: 'spend', supplierPaymentId: { in: apps.map((a) => a.paymentId) } } })
}

async function poAdvanceBlock(db: Db, v: VoidRow): Promise<AppError | null> {
  if (!v.bookedAtPay) return no('VOID_OLD_FLOW', `Cash voucher ${v.number} was paid under an older flow — correct it with a manual journal`)
  if (v.convertedCents > 0) return no('VOID_HAS_CHANGE', `Cash voucher ${v.number} already has a conversion recorded — correct it with a manual journal`)
  const back = v.amountCents - v.returnedCents
  if (back <= 0) return no('VOID_NOTHING_LEFT', `All the cash of ${v.number} has already been returned — there is nothing to void`, 409)
  const box = await advanceBoxOf(db, v)
  if (!box) return no('PAYMENT_NOT_BOOKED', `The box ${v.number}'s cash went into is not known — return it from Petty cash`, 409)
  if (box.deletedAt) return no('BOX_REMOVED', `The buyer's box "${box.name}" has been removed — correct it with a manual journal`)
  if (await advanceSpentOnBills(db, v.purchaseOrderId!, box.id) > 0) {
    return no('VOID_PO_CASH_SPENT', `The buyer already paid the supplier with ${v.number}'s cash — return any extra with "Return extra cash" instead`, 409)
  }
  if (box.floatCents < back) {
    return no('INSUFFICIENT_FLOAT', `"${box.name}" holds ${fmtPkrCents(box.floatCents)}, less than the ${fmtPkrCents(back)} to take back — count the box first`, 409)
  }
  if (v.paySource === 'box') {
    if (!v.boxId) return no('PAYMENT_NOT_BOOKED', `The box ${v.number} was paid from is not known`, 409)
    const from = await db.pettyCashBox.findUnique({ where: { id: v.boxId }, select: { deletedAt: true, isActive: true, name: true } })
    if (!from || from.deletedAt || !from.isActive) return no('BOX_REMOVED', `The box ${v.number} was paid from is closed — correct it with a manual journal`)
    return null
  }
  if (v.paySource === 'cash_on_hand' || v.paySource === 'bank') return null
  return no('VOID_UNKNOWN_SOURCE', `Cash voucher ${v.number} was paid in a way that cannot be voided here`)
}

/** The supplier payment a pay-back voucher's pay made. */
async function payBackPaymentOf(db: Db, v: VoidRow): Promise<{ id: string; voidedAt: Date | null } | null> {
  if (v.paySource === 'box' && v.pettyCashMovementId) {
    const m = await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { supplierPaymentId: true } })
    if (!m?.supplierPaymentId) return null
    return db.supplierPayment.findUnique({ where: { id: m.supplierPaymentId }, select: { id: true, voidedAt: true } })
  }
  return db.supplierPayment.findFirst({
    where: { reference: { startsWith: `${v.number} — paid back` }, supplier: { tenantId: v.tenantId }, applications: { some: { billId: v.reimbursesBillId! } } },
    select: { id: true, voidedAt: true }, orderBy: { createdAt: 'desc' },
  })
}

async function payBackBlock(db: Db, v: VoidRow): Promise<AppError | null> {
  if (v.status !== 'posted') return no('VOUCHER_NOT_PAID', `Cash voucher ${v.number} is not paid — cancel or reject it instead`, 409)
  const p = await payBackPaymentOf(db, v)
  if (!p) return no('PAYMENT_NOT_BOOKED', `The supplier payment of ${v.number} is not found`, 409)
  if (p.voidedAt) return no('ALREADY_VOIDED', `The supplier payment of ${v.number} is already void`, 409)
  if (v.paySource === 'box') {
    if (!v.boxId) return no('PAYMENT_NOT_BOOKED', `The box ${v.number} was paid from is not known`, 409)
    const from = await db.pettyCashBox.findUnique({ where: { id: v.boxId }, select: { deletedAt: true, isActive: true } })
    if (!from || from.deletedAt || !from.isActive) return no('BOX_REMOVED', `The box ${v.number} was paid from is closed — correct it with a manual journal`)
  } else if (v.paySource !== 'cash_on_hand' && v.paySource !== 'bank') {
    return no('VOID_UNKNOWN_SOURCE', `Cash voucher ${v.number} was paid in a way that cannot be voided here`)
  }
  return null
}

/** Void a PO advance inside `tx`: the cash still with the buyer goes back where it came from. */
async function voidPoAdvanceTx(tx: Prisma.TransactionClient, v: VoidRow, actorId: string, reason: string): Promise<{ entryId: string | null; boxId: string | null; raised: Array<{ id: string; number: string }> }> {
  const { recordPettyCashReturnTx, recordPettyCashTransferTx } = await import('./pettyCash.js')
  const buyerBox = (await advanceBoxOf(tx, v))!
  const back = v.amountCents - v.returnedCents
  const why = `${v.number} voided — PO cash taken back: ${reason}`.slice(0, 200)
  let entryId: string | null = null
  if (v.paySource === 'box') {
    const from = await tx.pettyCashBox.findUniqueOrThrow({ where: { id: v.boxId! }, select: { id: true, name: true, tenantId: true } })
    await recordPettyCashTransferTx(tx, { fromBox: buyerBox, toBox: { ...from, tenantId: from.tenantId! }, amountCents: back, reason: why, createdById: actorId })
  } else {
    const r = await recordPettyCashReturnTx(tx, {
      boxId: buyerBox.id, amountCents: back, destination: v.paySource === 'bank' ? 'bank' : 'safe',
      bankAccountId: v.paySource === 'bank' ? v.payBankAccountId : null, reason: why, actorId,
    })
    entryId = r.movement.journalEntryId ?? null
    if (!entryId) throw new AppError('VOID_NOT_BOOKED', `The cash taken back for ${v.number} could not be booked`, 409)
  }
  // No advance is left: a GRN of this PO already approved gets its pay-back voucher now (poCash.ts).
  const raised: Array<{ id: string; number: string }> = []
  const po = await tx.purchaseOrder.findUnique({ where: { id: v.purchaseOrderId! }, select: { id: true, payByCash: true } })
  if (po?.payByCash) {
    const { raiseReimbursementTx } = await import('../procurement/poCash.js')
    const grns = await tx.goodsReceipt.findMany({
      where: { poId: po.id, grnStatus: 'approved', supplierBillId: { not: null } },
      select: { grnNumber: true, supplierBillId: true, approvedById: true, financeCheckedById: true },
    })
    for (const g of grns) {
      const bill = await tx.supplierBill.findUnique({ where: { id: g.supplierBillId! }, select: { status: true } })
      if (!bill || bill.status === 'void' || bill.status === 'paid') continue
      if (await tx.cashVoucher.findUnique({ where: { reimbursesBillId: g.supplierBillId! }, select: { id: true } })) continue
      const nv = await raiseReimbursementTx(tx, { billId: g.supplierBillId!, poId: po.id, grnNumber: g.grnNumber ?? 'GRN', approverId: g.approvedById ?? actorId, financeCheckedById: g.financeCheckedById })
      if (nv) raised.push({ id: nv.id, number: nv.number })
    }
  }
  return { entryId, boxId: buyerBox.id, raised }
}

/** Void a buyer's pay-back inside `tx`: the supplier payment undone, the bill owes again, a fresh pay-back raised. */
async function voidPayBackTx(tx: Prisma.TransactionClient, v: VoidRow, actorId: string, reason: string, correctTaxCents: number | null = null): Promise<{ entryId: string | null; boxId: string | null; raised: Array<{ id: string; number: string }> }> {
  const { voidPayBackPaymentTx } = await import('../procurement/service.js')
  const p = (await payBackPaymentOf(tx, v))!
  const { entryId } = await voidPayBackPaymentTx(tx, p.id, actorId, `${v.number} voided: ${reason}`.slice(0, 200))
  let boxId: string | null = null
  if (v.paySource === 'box') {
    boxId = v.boxId!
    await recordPettyCashTopupTx(tx, {
      box: { id: boxId }, amountCents: v.amountCents, source: 'safe', cashVoucherId: v.id,
      reason: `${v.number} voided — pay-back cash put back: ${reason}`.slice(0, 500), createdById: actorId,
    })
  }
  const billId = v.reimbursesBillId!
  await tx.cashVoucher.update({ where: { id: v.id }, data: { reimbursesBillId: null, voidedBillId: billId } })
  // The bill's sales tax was wrong (owner, 2026-11-24): the excess is credited on the bill (a tax-only credit note,
  // Dr 2010 / Cr input tax) BEFORE the fresh pay-back is raised, so the new voucher is for the right amount.
  if (correctTaxCents != null) {
    const { billTaxLeftCents, createTaxCreditTx } = await import('../procurement/creditNotes.js')
    const excess = (await billTaxLeftCents(tx, billId)) - correctTaxCents
    if (!(excess > 0)) throw new AppError('NOTHING_TO_CORRECT', 'The bill does not carry more sales tax than that', 422)
    await createTaxCreditTx(tx, { billId, taxCents: excess, note: `${v.number}: ${reason}`, createdBy: actorId })
  }
  const raised: Array<{ id: string; number: string }> = []
  const g = await tx.goodsReceipt.findFirst({
    where: { supplierBillId: billId, poId: { not: null } },
    select: { poId: true, grnNumber: true, approvedById: true, financeCheckedById: true },
  })
  if (g) {
    const { raiseReimbursementTx } = await import('../procurement/poCash.js')
    const nv = await raiseReimbursementTx(tx, { billId, poId: g.poId!, grnNumber: g.grnNumber ?? 'GRN', approverId: g.approvedById ?? actorId, financeCheckedById: g.financeCheckedById })
    if (nv) raised.push({ id: nv.id, number: nv.number })
  }
  return { entryId, boxId, raised }
}

/** Void `voucherId` inside `tx` (the CEO's authority): put the cash back / reverse the pay, mark it voided. */
export async function voidVoucherTx(tx: Prisma.TransactionClient, voucherId: string, actorId: string, reason: string, opts: { correctTaxCents?: number | null } = {}): Promise<{ entryId: string | null; boxId: string | null; raised: Array<{ id: string; number: string }> }> {
  await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${voucherId} FOR UPDATE`
  const v = await tx.cashVoucher.findUniqueOrThrow({ where: { id: voucherId }, select: VOID_SELECT })
  const block = await voidBlockOf(tx, v)
  if (block) throw block
  if (opts.correctTaxCents != null && !v.reimbursesBillId) throw new AppError('TAX_CORRECTION_ONLY_PAYBACK', 'Only a buyer\'s pay-back voucher carries a bill\'s sales tax', 422)
  let entryId: string | null
  let boxId: string | null = null
  let raised: Array<{ id: string; number: string }> = []
  if (v.purchaseOrderId || v.reimbursesBillId) {
    const r = v.purchaseOrderId ? await voidPoAdvanceTx(tx, v, actorId, reason) : await voidPayBackTx(tx, v, actorId, reason, opts.correctTaxCents ?? null)
    entryId = r.entryId; boxId = r.boxId; raised = r.raised
  } else if (v.paySource === 'box') {
    const m = await tx.pettyCashMovement.findUniqueOrThrow({ where: { id: v.pettyCashMovementId! }, select: { boxId: true } })
    boxId = m.boxId
    const top = await recordPettyCashTopupTx(tx, {
      box: { id: m.boxId }, amountCents: v.amountCents, source: 'cash_request', cashVoucherId: v.id,
      reason: `${v.number} voided — cash put back: ${reason}`.slice(0, 500), createdById: actorId,
    })
    const posted = await postPettyCashMovementTx(tx, top.movementId, { postedBy: actorId })
    if (!posted.entryId) throw new AppError('VOID_NOT_BOOKED', `The cash put back for ${v.number} could not be booked`, 409)
    entryId = posted.entryId
  } else {
    const r = await reverseJournalEntry(v.tenantId, CASH_VOUCHER_PAY_ENTRY, v.id, `${v.number} voided: ${reason}`.slice(0, 200), { tx, postedBy: actorId })
    if (!r.posted) throw new AppError('ALREADY_VOIDED', `The payment of cash voucher ${v.number} is already reversed`, 409)
    entryId = r.entryId
  }
  const claimed = await tx.cashVoucher.updateMany({
    where: { id: v.id, status: v.status },
    data: { status: 'voided', voidedAt: new Date(), voidedById: actorId, voidReason: reason, voidEntryId: entryId },
  })
  if (claimed.count === 0) throw new AppError('VOUCHER_CHANGED', `Cash voucher ${v.number} changed meanwhile — reload it`, 409)
  return { entryId, boxId, raised }
}

/** What a void of this voucher does, in words, for the screen. */
export function voidEffectOf(v: Pick<VoidRow, 'purchaseOrderId' | 'reimbursesBillId' | 'paySource'>): string {
  const to = v.paySource === 'box' ? 'the box it was paid from' : v.paySource === 'bank' ? 'the bank' : 'cash on hand'
  if (v.purchaseOrderId) return `the cash still with the buyer comes back out of his box to ${to}; the buyer is then paid back at the PO's bill instead`
  if (v.reimbursesBillId) return `the supplier payment is undone (the money goes back to ${to}), the bill owes again and a new pay-back voucher is raised, ready to pay`
  return `the money goes back to ${to} and the expense is undone`
}

/** What the voucher screen shows about voiding: the pending request, who may ask, and why not. */
export async function voidStateOf(v: VoidRow & { voidedById: string | null; voidReason: string | null }, viewer: { id: string; isAdmin: boolean; financeApprover: boolean }) {
  const pending = await prisma.cashVoucherVoidRequest.findFirst({ where: { voucherId: v.id, tenantId: v.tenantId, status: 'pending' } })
  const names = new Map((await prisma.user.findMany({
    where: { id: { in: [pending?.requestedById, v.voidedById].filter((x): x is string => !!x) } }, select: { id: true, name: true },
  })).map((u) => [u.id, u.name]))
  const paid = v.status === 'disbursed' || v.status === 'posted'
  const block = paid ? await voidBlockOf(prisma, v) : null
  return {
    canRequestVoid: paid && !pending && !block && viewer.financeApprover,
    voidBlockedReason: paid && block ? block.message : null,
    /** Finance / the CEO always see the void card on a paid voucher — with the reason when it cannot be voided. */
    canSeeVoid: paid && viewer.financeApprover,
    voidEffect: paid ? voidEffectOf(v) : null,
    voidRequest: pending
      ? { id: pending.id, reason: pending.reason, correctTaxCents: pending.correctTaxCents, requestedById: pending.requestedById, requestedByName: names.get(pending.requestedById) ?? null, createdAt: pending.createdAt,
        canWithdraw: viewer.isAdmin || pending.requestedById === viewer.id, canDecide: viewer.isAdmin }
      : null,
    voidedByName: v.voidedById ? names.get(v.voidedById) ?? null : null,
  }
}

function auditVoid(req: FastifyRequest, action: string, tenantId: string, entity: string, entityId: string, metadata: Record<string, unknown>) {
  return audit({
    category: 'accounting', action, entity, entityId, tenantId,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
    metadata: { actorRole: req.staffUser!.role, ...metadata },
  })
}

const notPending = () => new AppError('REQUEST_NOT_PENDING', 'This void request is no longer waiting for the CEO.', 409)

export async function voucherVoidRoutes(fastify: FastifyInstance) {
  const { viewerOf, detailOf, loadVoucher } = await import('./cashVouchers.js')

  // POST /:id/void {reason} — finance asks (202); the CEO voids at once (200).
  fastify.post<{ Params: { id: string } }>('/:id/void', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const { reason, correctTaxCents = null } = z.object({ reason: REASON, correctTaxCents: z.number().int().min(0).max(2_000_000_000).nullable().optional() }).parse(req.body ?? {})
    const loaded = await loadVoucher(req, req.params.id)
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new ForbiddenError('Only finance (or the CEO) can void a paid cash voucher')
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: loaded.id }, select: VOID_SELECT })
    const block = await voidBlockOf(prisma, v)
    if (block) throw block
    // "The sales tax was wrong": only a pay-back voucher, and only less tax than the bill still carries.
    if (correctTaxCents != null) {
      if (!v.reimbursesBillId) throw new AppError('TAX_CORRECTION_ONLY_PAYBACK', 'Only a buyer\'s pay-back voucher carries a bill\'s sales tax', 422)
      const left = await (await import('../procurement/creditNotes.js')).billTaxLeftCents(prisma, v.reimbursesBillId)
      if (!(left > correctTaxCents)) throw new AppError('NOTHING_TO_CORRECT', `The bill carries ${fmtPkrCents(left)} of sales tax — enter a smaller figure to correct it`, 422)
    }

    if (viewer.isAdmin) {
      const out = await prisma.$transaction(async (tx) => {
        const r = await voidVoucherTx(tx, v.id, viewer.id, reason, { correctTaxCents })
        await tx.cashVoucherVoidRequest.updateMany({
          where: { voucherId: v.id, status: 'pending' },
          data: { status: 'approved', decidedById: viewer.id, decidedAt: new Date(), decisionNote: 'Voided by the CEO directly' },
        })
        return r
      })
      if (v.purchaseOrderId) await (await import('../procurement/poCashSync.js')).refreshPoCashExcessFlag(v.id, viewer.id).catch(() => undefined)
      await auditVoid(req, 'cash_voucher.void', v.tenantId, 'CashVoucher', v.id, { number: v.number, amountCents: v.amountCents, reason, entryId: out.entryId, boxId: out.boxId, payBacksRaised: out.raised, direct: true, ...(correctTaxCents != null && { correctTaxCents }) })
      return reply.status(200).send(await detailOf(v.id, viewer))
    }

    let row
    try {
      row = await prisma.cashVoucherVoidRequest.create({ data: { tenantId: v.tenantId, voucherId: v.id, reason, requestedById: viewer.id, correctTaxCents } })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new AppError('VOID_PENDING', `A void of ${v.number} is already waiting for the CEO.`, 409)
      throw err
    }
    await auditVoid(req, 'cash_voucher.void_request', v.tenantId, 'CashVoucherVoidRequest', row.id, { voucherId: v.id, number: v.number, amountCents: v.amountCents, reason, ...(correctTaxCents != null && { correctTaxCents }) })
    approvalWaiting('cash_voucher_void', row.id, { round: row.createdAt.toISOString(), actorId: viewer.id })
    return reply.status(202).send({ pendingApproval: true, request: row })
  })

  // GET /void-requests?status=pending — the requests of the companies in view (finance and the CEO).
  fastify.get<{ Querystring: { status?: string } }>('/void-requests', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const viewer = await viewerOf(req)
    if (!viewer.financeApprover) throw new ForbiddenError('Only finance (or the CEO) sees void requests')
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status : undefined
    const rows = await prisma.cashVoucherVoidRequest.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    const vouchers = await prisma.cashVoucher.findMany({
      where: { id: { in: rows.map((r) => r.voucherId) } },
      select: { ...VOID_SELECT, conceptId: true, box: { select: { name: true } } },
    })
    const vById = new Map(vouchers.map((x) => [x.id, x]))
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((x): x is string => !!x))]
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))]
    const [users, tenants] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
    ])
    const u = new Map(users.map((x) => [x.id, x.name]))
    const t = new Map(tenants.map((x) => [x.id, x.name]))
    const items = []
    for (const r of rows) {
      const v = vById.get(r.voucherId)
      let paidAccountCode: string | null = null
      if (v && v.status !== 'voided') { try { paidAccountCode = await cashRequestPaidAccountTx(prisma, v.id) } catch { paidAccountCode = null } }
      const block = r.status === 'pending' && v ? await voidBlockOf(prisma, v) : null
      items.push({
        ...r,
        voucherNumber: v?.number ?? null, payeeName: v?.payeeName ?? null, purpose: v?.purpose ?? null,
        amountCents: v?.amountCents ?? null, paySource: v?.paySource ?? null, boxName: v?.box?.name ?? null, paidAccountCode,
        companyName: t.get(r.tenantId) ?? null,
        requestedByName: u.get(r.requestedById) ?? null,
        decidedByName: r.decidedById ? u.get(r.decidedById) ?? null : null,
        blockedBy: block ? block.message : null,
      })
    }
    return { items }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const r = await prisma.cashVoucherVoidRequest.findFirst({ where: { id, ...(await scopeTenantWhere(req, 'write')) } })
    if (!r) throw new NotFoundError('Void request', id)
    return r
  }
  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('cash_voucher_void', id)
    if (!s) throw new NotFoundError('Void request', id)
    return assertCanApprove(req, approvalInputOf('cash_voucher_void', id, s))
  }

  // POST /void-requests/:id/approve — the CEO voids the voucher now.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw notPending()
    const decidedAt = new Date()
    const out = await prisma.$transaction(async (tx) => {
      const claimed = await tx.cashVoucherVoidRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note ?? null },
      })
      if (claimed.count === 0) throw notPending()
      return voidVoucherTx(tx, r.voucherId, req.staffUser!.id, r.reason, { correctTaxCents: r.correctTaxCents })
    })
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: r.voucherId }, select: { number: true, amountCents: true, purchaseOrderId: true } })
    if (v.purchaseOrderId) await (await import('../procurement/poCashSync.js')).refreshPoCashExcessFlag(r.voucherId, req.staffUser!.id).catch(() => undefined)
    await auditVoid(req, 'cash_voucher.void', r.tenantId, 'CashVoucher', r.voucherId, {
      number: v.number, amountCents: v.amountCents, reason: r.reason, entryId: out.entryId, boxId: out.boxId, payBacksRaised: out.raised, requestId: r.id, requestedBy: r.requestedById, ...(r.correctTaxCents != null && { correctTaxCents: r.correctTaxCents }),
    })
    await auditApproval(req, {
      type: 'cash_voucher_void', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'CashVoucherVoidRequest',
      metadata: { voucherId: r.voucherId, note: body.note ?? null, decidedAt, amount: fmtPkrCents(v.amountCents) },
    })
    return { id: r.id, approved: true, voucherId: r.voucherId, entryId: out.entryId, payBacksRaised: out.raised }
  })

  // POST /void-requests/:id/reject {note ≥10} — the CEO turns it down; the voucher stays as it is.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: REASON }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const decidedAt = new Date()
    const claimed = await prisma.cashVoucherVoidRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt, decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditVoid(req, 'cash_voucher.void_request.reject', r.tenantId, 'CashVoucherVoidRequest', r.id, { voucherId: r.voucherId, requestedBy: r.requestedById, note: body.note })
    await auditApproval(req, {
      type: 'cash_voucher_void', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'CashVoucherVoidRequest',
      metadata: { voucherId: r.voucherId, note: body.note, decidedAt },
    })
    return { id: r.id, rejected: true }
  })

  // POST /void-requests/:id/withdraw — the requester (or the CEO) takes it back.
  fastify.post<{ Params: { id: string } }>('/void-requests/:id/withdraw', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (req.staffUser!.role !== 'admin' && r.requestedById !== req.staffUser!.id) {
      throw new AppError('NOT_YOUR_REQUEST', 'Only the person who asked (or the CEO) may withdraw it.', 403)
    }
    const claimed = await prisma.cashVoucherVoidRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'withdrawn', decidedById: req.staffUser!.id, decidedAt: new Date() },
    })
    if (claimed.count === 0) throw notPending()
    await auditVoid(req, 'cash_voucher.void_request.withdraw', r.tenantId, 'CashVoucherVoidRequest', r.id, { voucherId: r.voucherId, requestedBy: r.requestedById })
    return { id: r.id, withdrawn: true }
  })
}
