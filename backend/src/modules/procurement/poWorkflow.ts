// The PO → GRN workflow (owner, 2026-11-05) — REPLACES the buyer → finance → CEO PO chain of 2026-11-03.
//
// "Requester creates a PO … automatically goes to the CEO for approval. Once approved, the PO goes to the designated
// Buyer. If no Buyer is assigned, it goes to the PO creator for purchasing. Buyer buys, uploads the supplier's
// invoice/bill, marks the PO Completed. The completed PO + invoice goes back to the original Requester to confirm the
// items were received. On confirmation the system generates a GRN linked to the PO and the supplier invoice. GRN goes
// to Finance to verify … After Finance, the GRN goes to the CEO for final approval. Once the CEO approves the GRN, it
// goes back to Finance for payment of the supplier balance." Every stage routes to its person; no stage is skipped;
// a rejection returns to the previous stage with mandatory remarks (≥ 10 characters); every step is logged on the
// PO's activity log (GRN steps carry grnId).
//
//   PO   draft ──submit──▶ pending_approval ──CEO approves (service.ts approvePo: names the buyer, cash voucher)──▶
//        approved | sent | partial  (the BUYER's stage: buyerUserId)
//          ──buyer completes (completePo: invoice no. + date + ≥1 invoice file, real supplier, optional actual rates)──▶
//        completed  (the REQUESTER's stage: createdBy)
//          ──requester confirms (confirmReceipt → receiving.ts receiveGoods {confirmation})──▶ received | partial
//            (a partial PO is back with the buyer for the rest — a second GRN)
//          ──requester: "Not received" (rejectReceipt, note)──▶ back to the buyer's stage
//
//   GRN  (GoodsReceipt.grnNumber, made by the confirmation: Dr 12x0 / Cr 2015 GRNI — 'procurement.receipt:<id>')
//        finance_review ──finance passes (role finance + accounting; never the requester / buyer)──▶ ceo_review
//        ceo_review ──CEO approves (approveGrn)──▶ approved: the supplier BILL is created in the same transaction
//            through procurement's bill engine (prepareBill + insertBillTx + afterBillCreated): number = the invoice
//            number, date = the invoice date, due = date + the supplier's terms, a line per GRN receipt line at the PO
//            line's CURRENT rate ('supplier.bill:<id>' Dr 2015 / Cr 2010; a price differing from the receipt is the
//            bill engine's GRNI match + lot reprice). Never a direct 2010 journal.
//        finance_review | ceo_review ──return (note)──▶ buyer_fix ──buyer resubmits (invoice / rates corrected)──▶
//            finance_review
//   Pay: a PO the CEO approved with cash (payByCash) is paid from the buyer's petty-cash box (POST
//        /trustops/petty-cash/movements {type 'spend', supplierBillId}); a credit PO by finance through Supplier
//        payments. No new payment engine.
//
// Company: a PO is its supplier's company's (scope.ts); a GRN carries tenantId. The routes scope every id first
// (foreign → 404); these functions check WHO (the buyer, the requester) and claim the status.

import type { Prisma } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { assertInt4Fits, assertMoneyFits, toCents } from '../../lib/money.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { queueStaffNotify, notifyStaffMany, type NotifyInput } from '../../lib/staffNotify.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { fmtPktDate } from '../accounting/dates.js'
import { lineValueCents } from './poUnits.js'
import { isAuthorityKey, type AuthorityKey } from '../accounting/taxAuthorities.js'
import { CASH_PURCHASE_SUPPLIER_KIND, receiveGoods } from './receiving.js'
import { prepareBill, insertBillTx, afterBillCreated, supplierNotChosenError } from './service.js'

type Tx = Prisma.TransactionClient

/** The buyer's stage: approved by the CEO, maybe sent, maybe part-received. */
export const BUYER_STAGE = ['approved', 'sent', 'partial'] as const
export const GRN_STATUSES = ['finance_review', 'buyer_fix', 'ceo_review', 'approved'] as const
export type GrnStatus = typeof GRN_STATUSES[number]

export const PO_FILE_OWNER = 'purchase_order'
const RECORD_FILE_KIND = 'record_file'

export const NOTE_MIN = 10
export function assertNote(note: string | null | undefined, what = 'Say why'): string {
  const n = (note ?? '').trim()
  if (n.length < NOTE_MIN) throw new AppError('NOTE_REQUIRED', `${what} (at least ${NOTE_MIN} characters)`, 422)
  return n.slice(0, 500)
}

export interface Actor { id: string; role: string }
const isCeo = (a: Actor) => a.role === 'admin'

/** A rate the buyer actually paid, per the unit the line was ordered in (poUnits.ts). */
/** quantity (owner, 2026-11-11: "how he can edit/revise amounts/quantities/rates") = what the buyer really bought,
 *  in the line's order unit — only when completing (never below what has already been received). */
export interface LineRate { poLineId: string; rateCents: number; quantity?: number | null }

const YMD = /^\d{4}-\d{2}-\d{2}$/
function invoiceDateOf(s: string): Date {
  if (!YMD.test(s)) throw new AppError('INVALID_DATE', 'The invoice date is YYYY-MM-DD', 422)
  const d = new Date(`${s}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new AppError('INVALID_DATE', 'The invoice date is not a date', 422)
  if (s > fmtPktDate(new Date())) throw new AppError('INVOICE_DATE_IN_FUTURE', 'The invoice date cannot be after today', 422)
  return d
}
/** The invoice's sales tax: whole paisa, zero or more (null = none entered). */
function invoiceTaxOf(v: number | null | undefined): number | null {
  if (v == null) return null
  if (!Number.isInteger(v) || v < 0) throw new AppError('INVALID_AMOUNT', 'The sales tax must be whole paisa, zero or more', 400)
  assertMoneyFits(v, "The invoice's sales tax")
  return v
}

function invoiceNumberOf(s: string): string {
  const n = s.trim()
  if (!n) throw new AppError('INVOICE_NUMBER_REQUIRED', "Enter the supplier's invoice number", 422)
  if (n.length > 100) throw new AppError('INVOICE_NUMBER_TOO_LONG', 'The invoice number is at most 100 characters', 422)
  return n
}

/** Lock the PO row and read it (with its lines and supplier). */
async function lockPoTx(tx: Tx, poId: string) {
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${poId} FOR UPDATE`
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: true, supplier: { select: { id: true, name: true, tenantId: true, systemKind: true, paymentTermsDays: true } } },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  return po
}

/**
 * The buyer's actual rates (per each line's order unit): the line's stored costs and the PO total are recomputed;
 * returns what changed (old → new) for the activity log. 422 LINE_NOT_ON_PO / AMOUNT_TOO_LARGE.
 */
async function applyLineRatesTx(tx: Tx, po: { id: string; lines: Array<{ id: string; quantityOrdered: number; quantityReceived: number; unitCostCents: number; orderUnit: string | null; orderUnitFactor: number; orderUnitCostCents: number | null }> }, rates: readonly LineRate[] | undefined, opts: { allowQuantity?: boolean } = {}) {
  const changes: Array<{ poLineId: string; fromRateCents: number; toRateCents: number; unit: string | null; fromQuantity?: number; toQuantity?: number }> = []
  if (!rates || rates.length === 0) return changes
  const seen = new Set<string>()
  const lines = po.lines.map((l) => ({ ...l }))
  for (const r of rates) {
    if (seen.has(r.poLineId)) throw new AppError('DUPLICATE_LINE', 'A PO line appears twice', 400)
    seen.add(r.poLineId)
    const l = lines.find((x) => x.id === r.poLineId)
    if (!l) throw new AppError('LINE_NOT_ON_PO', 'That line is not on this purchase order', 422)
    if (!Number.isInteger(r.rateCents) || r.rateCents < 0) throw new AppError('INVALID_AMOUNT', 'A rate is whole paisa, zero or more', 400)
    assertInt4Fits(r.rateCents, 'The rate')
    const ordered = l.orderUnitCostCents != null && l.orderUnitFactor > 0
    const factor = ordered ? l.orderUnitFactor : 1
    const from = ordered ? l.orderUnitCostCents! : l.unitCostCents
    const fromQty = Math.round((l.quantityOrdered / factor) * 1e6) / 1e6
    let toQty = fromQty
    if (r.quantity != null) {
      if (!opts.allowQuantity) throw new AppError('QUANTITY_NOT_EDITABLE', 'The quantity is changed only when the PO is marked completed', 422)
      if (!Number.isFinite(r.quantity) || r.quantity <= 0) throw new AppError('INVALID_QUANTITY', 'A quantity bought is more than zero', 400)
      toQty = Math.round(r.quantity * 1e6) / 1e6
      if (toQty * factor + 1e-9 < l.quantityReceived) {
        throw new AppError('QUANTITY_BELOW_RECEIVED', `${l.quantityReceived / factor} ${l.orderUnit ?? ''} of this line has already been received — the quantity cannot be lower`.replace('  ', ' '), 422)
      }
    }
    const qtyChanged = Math.abs(toQty - fromQty) > 1e-9
    if (from === r.rateCents && !qtyChanged) continue
    if (ordered) {
      l.orderUnitCostCents = r.rateCents
      l.unitCostCents = Math.round(r.rateCents / l.orderUnitFactor)
    } else {
      l.unitCostCents = r.rateCents
    }
    if (qtyChanged) l.quantityOrdered = Math.round(toQty * factor * 1e6) / 1e6
    assertInt4Fits(l.unitCostCents, 'The unit cost')
    assertMoneyFits(lineValueCents(l), 'The line (quantity × rate)')
    changes.push({ poLineId: l.id, fromRateCents: from, toRateCents: r.rateCents, unit: ordered ? l.orderUnit : null, ...(qtyChanged ? { fromQuantity: fromQty, toQuantity: toQty } : {}) })
    await tx.purchaseOrderLine.update({
      where: { id: l.id },
      data: { unitCostCents: l.unitCostCents, ...(ordered ? { orderUnitCostCents: l.orderUnitCostCents } : {}), ...(qtyChanged ? { quantityOrdered: l.quantityOrdered } : {}) },
    })
  }
  if (changes.length > 0) {
    const total = lines.reduce((s, l) => s + lineValueCents(l), 0)
    assertMoneyFits(total, "This purchase order's total")
    await tx.purchaseOrder.update({ where: { id: po.id }, data: { totalCents: total } })
  }
  return changes
}

// ─── Buyer ───────────────────────────────────────────────────────────────────

/** The CEO hands an approved PO to another buyer (an active login of its company). Logged. */
export async function setPoBuyer(poId: string, actor: Actor, buyerUserId: string) {
  if (!isCeo(actor)) throw new ForbiddenError('Only the CEO assigns the buyer of a PO')
  const po0 = await prisma.purchaseOrder.findUnique({ where: { id: poId }, select: { supplier: { select: { tenantId: true } } } })
  if (!po0) throw new NotFoundError('PurchaseOrder', poId)
  const tenantId = po0.supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company first', 422)
  const u = await prisma.user.findFirst({
    where: { id: buyerUserId, deletedAt: null, isActive: true, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
    select: { id: true, name: true },
  })
  if (!u) throw new AppError('BUYER_NOT_IN_COMPANY', "The buyer must be an active login of this PO's company", 422)
  const r = await prisma.$transaction(async (tx) => {
    const po = await lockPoTx(tx, poId)
    if (!(BUYER_STAGE as readonly string[]).includes(po.status)) {
      throw new AppError('INVALID_STATE', `This PO is ${po.status.replace(/_/g, ' ')} — the buyer is changed only while it is being bought`, 409)
    }
    if (po.buyerUserId === u.id) return { id: poId, buyerUserId: u.id, from: po.buyerUserId, tenantId, changed: false }
    await tx.purchaseOrder.update({ where: { id: poId }, data: { buyerUserId: u.id, buyerAssignedAt: new Date() } })
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: actor.id, action: 'buyer_assigned', details: { from: po.buyerUserId, to: u.id, toName: u.name } } })
    return { id: poId, buyerUserId: u.id, from: po.buyerUserId, tenantId, changed: true }
  })
  if (r.changed) poTaskNotice('to_buy', poId, actor.id)
  return r
}

/** The invoice files attached since the PO's last GRN (the evidence of THIS purchase). */
async function invoiceFilesSince(poId: string, tenantId: string, since: Date | null): Promise<number> {
  return prisma.cashVoucherAttachment.count({
    where: { kind: RECORD_FILE_KIND, ownerType: PO_FILE_OWNER, ownerId: poId, tenantId, ...(since ? { createdAt: { gt: since } } : {}) },
  })
}

/** taxCents = the sales tax on the supplier's invoice (owner, 2026-11-05), taxAuthority = who charged it (null = the
 *  supplier's usual one); both go onto the GRN and the bill. */
export interface CompleteInput { invoiceNumber: string; invoiceDate: string; taxCents?: number | null; taxAuthority?: AuthorityKey | null; lines?: LineRate[]; note?: string | null }

/**
 * The buyer bought it (owner: "Buyer buys, uploads the supplier's invoice/bill, marks the PO Completed"): approved |
 * sent | partial → completed. Only the PO's buyer (or the CEO); the real supplier chosen (422 PO_SUPPLIER_NOT_CHOSEN);
 * at least one invoice file attached to the PO since its last GRN (422 INVOICE_REQUIRED); invoice no. + date (not
 * after today). Optional actual rates per line (the originals are logged). Claimed under the PO lock (409).
 */
export async function completePo(poId: string, actor: Actor, input: CompleteInput) {
  const invoiceNumber = invoiceNumberOf(input.invoiceNumber)
  const invoiceDate = invoiceDateOf(input.invoiceDate)
  const taxCents = invoiceTaxOf(input.taxCents)
  const head = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: { status: true, grnWorkflow: true, buyerUserId: true, supplier: { select: { tenantId: true, systemKind: true } } },
  })
  if (!head) throw new NotFoundError('PurchaseOrder', poId)
  if (!head.grnWorkflow) throw new AppError('INVALID_STATE', 'This PO was approved before the purchase workflow — receive it at the dock', 409)
  if (!isCeo(actor) && head.buyerUserId !== actor.id) throw new AppError('PO_NOT_YOUR_TASK', 'Only the buyer of this PO (or the CEO) marks it completed', 403)
  if (!(BUYER_STAGE as readonly string[]).includes(head.status)) {
    throw new AppError('INVALID_STATE', `This PO is ${head.status.replace(/_/g, ' ')} — only a PO being bought is completed`, 409)
  }
  if (head.supplier.systemKind === CASH_PURCHASE_SUPPLIER_KIND) throw supplierNotChosenError('completed')
  const tenantId = head.supplier.tenantId!
  const lastGrn = await prisma.goodsReceipt.findFirst({ where: { poId, grnNumber: { not: null } }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } })
  if ((await invoiceFilesSince(poId, tenantId, lastGrn?.receivedAt ?? null)) === 0) {
    throw new AppError('INVOICE_REQUIRED', "Attach the supplier's invoice / bill to the PO first", 422)
  }
  const now = new Date()
  const r = await prisma.$transaction(async (tx) => {
    const po = await lockPoTx(tx, poId)
    if (!(BUYER_STAGE as readonly string[]).includes(po.status)) throw new AppError('INVALID_STATE', 'This PO changed meanwhile — reload it', 409)
    if (!isCeo(actor) && po.buyerUserId !== actor.id) throw new AppError('PO_NOT_YOUR_TASK', 'Only the buyer of this PO (or the CEO) marks it completed', 403)
    if (po.supplier.systemKind === CASH_PURCHASE_SUPPLIER_KIND) throw supplierNotChosenError('completed')
    const changes = await applyLineRatesTx(tx, po, input.lines, { allowQuantity: true })
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: 'completed', invoiceNumber, invoiceDate, invoiceTaxCents: taxCents, invoiceTaxAuthority: input.taxAuthority ?? null, completedById: actor.id, completedAt: now, receiptReturnNote: null },
    })
    await tx.poActivityLog.create({
      data: {
        purchaseOrderId: poId, userId: actor.id, action: 'completed',
        details: { from: po.status, to: 'completed', invoiceNumber, invoiceDate: input.invoiceDate, taxCents, taxAuthority: input.taxAuthority ?? null, ...(changes.length ? { rateChanges: changes } : {}), ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}) } as Prisma.InputJsonValue,
      },
    })
    return { id: poId, status: 'completed', from: po.status, invoiceNumber, rateChanges: changes, tenantId }
  })
  poTaskNotice('to_confirm', poId, actor.id)
  return r
}

// ─── Requester ───────────────────────────────────────────────────────────────

export interface ConfirmInput {
  lines: Array<{ poLineId: string; quantityReceived: number; useBy?: string | null; notes?: string | null }>
  locationId?: string | null
  notes?: string | null
}

/**
 * The requester confirms what arrived (owner: "YES the requester confirms receipt") of a completed PO: the
 * existing receiving engine (receiving.ts receiveGoods with `confirmation`) writes the receipt, the lots, the PO line
 * quantities and Dr 12x0 / Cr 2015 GRNI, and makes it a GRN (finance_review). PO → received | partial (partial goes
 * back to the buyer for the rest). Only the PO's raiser (or the CEO).
 */
export async function confirmReceipt(poId: string, actor: Actor, input: ConfirmInput) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: { status: true, grnWorkflow: true, createdBy: true, invoiceNumber: true, invoiceDate: true, invoiceTaxCents: true, invoiceTaxAuthority: true },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', poId)
  if (!po.grnWorkflow) throw new AppError('INVALID_STATE', 'This PO was approved before the purchase workflow — receive it at the dock', 409)
  if (!isCeo(actor) && po.createdBy !== actor.id) throw new AppError('PO_NOT_YOUR_TASK', 'Only whoever raised this PO (or the CEO) confirms its receipt', 403)
  if (po.status !== 'completed' || !po.invoiceNumber || !po.invoiceDate) {
    throw new AppError('PO_NOT_COMPLETED', `This PO is ${po.status.replace(/_/g, ' ')} — the buyer has not marked it completed`, 409)
  }
  const result = await receiveGoods({
    actor, poId, locationId: input.locationId ?? null, notes: input.notes ?? null,
    lines: input.lines.map((l) => ({ poLineId: l.poLineId, quantityReceived: l.quantityReceived, useBy: l.useBy ?? null, notes: l.notes ?? null })),
    confirmation: { invoiceNumber: po.invoiceNumber, invoiceDate: po.invoiceDate, invoiceTaxCents: po.invoiceTaxCents == null ? null : toCents(po.invoiceTaxCents), invoiceTaxAuthority: po.invoiceTaxAuthority },
  })
  const grn = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: result.receipt.id }, select: { id: true, grnNumber: true, grnStatus: true, tenantId: true } })
  const { approvalWaiting } = await import('../approvals/notify.js')
  approvalWaiting('grn_finance', grn.id, { round: `finance_review:r0:${grn.id}`, actorId: actor.id })
  return { id: poId, status: result.poStatus, grn, flagged: result.flagged }
}

/**
 * The requester says it did not arrive as completed (owner: "a rejection at any stage returns to the relevant
 * previous stage with MANDATORY remarks"): completed → back to the buyer (partial when something already came, else
 * sent / approved), the note kept on the PO and logged; the buyer is told.
 */
export async function rejectReceipt(poId: string, actor: Actor, noteIn: string) {
  const note = assertNote(noteIn, 'Say what did not arrive or is wrong')
  const head = await prisma.purchaseOrder.findUnique({ where: { id: poId }, select: { createdBy: true, grnWorkflow: true } })
  if (!head) throw new NotFoundError('PurchaseOrder', poId)
  if (!head.grnWorkflow) throw new AppError('INVALID_STATE', 'This PO is not in the purchase workflow', 409)
  if (!isCeo(actor) && head.createdBy !== actor.id) throw new AppError('PO_NOT_YOUR_TASK', 'Only whoever raised this PO (or the CEO) sends it back', 403)
  const r = await prisma.$transaction(async (tx) => {
    const po = await lockPoTx(tx, poId)
    if (po.status !== 'completed') throw new AppError('PO_NOT_COMPLETED', `This PO is ${po.status.replace(/_/g, ' ')} — nothing to send back`, 409)
    const back = po.lines.some((l) => l.quantityReceived > 0) ? 'partial' : po.sentAt ? 'sent' : 'approved'
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: { status: back, receiptReturnNote: note, receiptReturnedById: actor.id, receiptReturnedAt: new Date() },
    })
    await tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId: actor.id, action: 'receipt_rejected', details: { from: 'completed', to: back, note } } })
    return { id: poId, status: back, from: 'completed' }
  })
  poTaskNotice('to_buy', poId, actor.id, note)
  return r
}

// ─── GRN ─────────────────────────────────────────────────────────────────────

async function lockGrnTx(tx: Tx, grnId: string) {
  await tx.$queryRaw`SELECT id FROM goods_receipts WHERE id = ${grnId} FOR UPDATE`
  const g = await tx.goodsReceipt.findUnique({ where: { id: grnId } })
  if (!g || !g.grnNumber || !g.poId) throw new NotFoundError('GoodsReceipt', grnId)
  return g as typeof g & { poId: string; grnNumber: string }
}

const logGrnTx = (tx: Tx, poId: string, userId: string, action: string, details: Record<string, unknown>) =>
  tx.poActivityLog.create({ data: { purchaseOrderId: poId, userId, action, details: details as Prisma.InputJsonValue } })

/** Finance verified the GRN (the route proved the right): finance_review → ceo_review. */
export async function grnFinancePass(grnId: string, actor: Actor, note?: string | null) {
  const now = new Date()
  const r = await prisma.$transaction(async (tx) => {
    const g = await lockGrnTx(tx, grnId)
    if (g.grnStatus !== 'finance_review') throw new AppError('INVALID_STATE', `This GRN is ${String(g.grnStatus).replace(/_/g, ' ')} — not waiting for finance`, 409)
    await tx.goodsReceipt.update({ where: { id: grnId }, data: { grnStatus: 'ceo_review', financeCheckedById: actor.id, financeCheckedAt: now } })
    await logGrnTx(tx, g.poId, actor.id, 'grn_finance_checked', { grnId, grnNumber: g.grnNumber, from: 'finance_review', to: 'ceo_review', ...(note?.trim() ? { note: note.trim().slice(0, 500) } : {}) })
    return { id: grnId, grnStatus: 'ceo_review' as const, returnCount: g.returnCount, tenantId: g.tenantId }
  })
  const { approvalWaiting } = await import('../approvals/notify.js')
  approvalWaiting('grn', grnId, { round: `ceo_review:r${r.returnCount}:${now.toISOString()}`, actorId: actor.id })
  return r
}

/**
 * Finance (at finance_review) or the CEO (at ceo_review, or overriding finance) returns the GRN to the buyer with a
 * note: → buyer_fix (the buyer corrects the invoice number / date / rates / files and resubmits).
 */
export async function grnReturn(grnId: string, actor: Actor, noteIn: string, expected: 'finance_review' | 'ceo_review') {
  const note = assertNote(noteIn, 'Say what the buyer must correct')
  const r = await prisma.$transaction(async (tx) => {
    const g = await lockGrnTx(tx, grnId)
    if (g.grnStatus !== expected) throw new AppError('INVALID_STATE', 'This GRN changed meanwhile — reload it', 409)
    await tx.goodsReceipt.update({
      where: { id: grnId },
      data: { grnStatus: 'buyer_fix', returnNote: note, returnedById: actor.id, returnedAt: new Date(), returnCount: { increment: 1 }, financeCheckedById: null, financeCheckedAt: null },
    })
    await logGrnTx(tx, g.poId, actor.id, 'grn_returned', { grnId, grnNumber: g.grnNumber, from: expected, to: 'buyer_fix', note })
    return { id: grnId, grnStatus: 'buyer_fix' as const, from: expected, poId: g.poId }
  })
  poTaskNotice('to_fix', r.poId, actor.id, note, grnId)
  return r
}

/**
 * Pull back (owner, 2026-11-07: "give option to Finance to pull back drafts from CEO's approval box to edit or change
 * details"): finance takes a GRN it passed (ceo_review) back to its own step before the CEO decides — it leaves the
 * CEO's inbox and finance may verify it again or return it to the buyer.
 */
export async function grnPullBack(grnId: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const g = await lockGrnTx(tx, grnId)
    if (g.grnStatus !== 'ceo_review') throw new AppError('INVALID_STATE', `This GRN is ${String(g.grnStatus).replace(/_/g, ' ')} — only one waiting for the CEO can be pulled back`, 409)
    await tx.goodsReceipt.update({ where: { id: grnId }, data: { grnStatus: 'finance_review', financeCheckedById: null, financeCheckedAt: null } })
    await logGrnTx(tx, g.poId, actor.id, 'grn_pulled_back', { grnId, grnNumber: g.grnNumber, from: 'ceo_review', to: 'finance_review' })
    return { id: grnId, grnStatus: 'finance_review' as const }
  })
}

export interface ResubmitInput { invoiceNumber?: string; invoiceDate?: string; taxCents?: number | null; taxAuthority?: AuthorityKey | null; lines?: LineRate[]; note?: string | null }

/** The buyer corrected the GRN's invoice: buyer_fix → finance_review. Only the PO's buyer (or the CEO). */
export async function grnResubmit(grnId: string, actor: Actor, input: ResubmitInput) {
  const invoiceNumber = input.invoiceNumber != null ? invoiceNumberOf(input.invoiceNumber) : null
  const invoiceDate = input.invoiceDate != null ? invoiceDateOf(input.invoiceDate) : null
  const taxCents = input.taxCents !== undefined ? invoiceTaxOf(input.taxCents) : undefined
  const now = new Date()
  const r = await prisma.$transaction(async (tx) => {
    const g = await lockGrnTx(tx, grnId)
    const po = await lockPoTx(tx, g.poId)
    if (!isCeo(actor) && po.buyerUserId !== actor.id) throw new AppError('PO_NOT_YOUR_TASK', 'Only the buyer of this PO (or the CEO) corrects its GRN', 403)
    if (g.grnStatus !== 'buyer_fix') throw new AppError('INVALID_STATE', `This GRN is ${String(g.grnStatus).replace(/_/g, ' ')} — not returned to the buyer`, 409)
    // Only lines this GRN received may be re-priced here.
    const rlPoLines = new Set((await tx.goodsReceiptLine.findMany({ where: { receiptId: grnId }, select: { poLineId: true } })).map((l) => l.poLineId))
    for (const l of input.lines ?? []) if (!rlPoLines.has(l.poLineId)) throw new AppError('LINE_NOT_ON_GRN', 'That line is not on this GRN', 422)
    const changes = await applyLineRatesTx(tx, po, input.lines)
    await tx.goodsReceipt.update({
      where: { id: grnId },
      data: {
        grnStatus: 'finance_review', ...(invoiceNumber ? { invoiceNumber } : {}), ...(invoiceDate ? { invoiceDate } : {}),
        ...(taxCents !== undefined ? { invoiceTaxCents: taxCents } : {}), ...(input.taxAuthority !== undefined ? { invoiceTaxAuthority: input.taxAuthority } : {}),
      },
    })
    await logGrnTx(tx, g.poId, actor.id, 'grn_resubmitted', {
      grnId, grnNumber: g.grnNumber, from: 'buyer_fix', to: 'finance_review',
      ...(invoiceNumber && invoiceNumber !== g.invoiceNumber ? { invoiceNumber: { from: g.invoiceNumber, to: invoiceNumber } } : {}),
      ...(invoiceDate && input.invoiceDate !== (g.invoiceDate ? g.invoiceDate.toISOString().slice(0, 10) : null) ? { invoiceDate: { from: g.invoiceDate?.toISOString().slice(0, 10) ?? null, to: input.invoiceDate } } : {}),
      ...(taxCents !== undefined && taxCents !== (g.invoiceTaxCents == null ? null : toCents(g.invoiceTaxCents)) ? { taxCents: { from: g.invoiceTaxCents == null ? null : toCents(g.invoiceTaxCents), to: taxCents } } : {}),
      ...(input.taxAuthority !== undefined && input.taxAuthority !== g.invoiceTaxAuthority ? { taxAuthority: { from: g.invoiceTaxAuthority, to: input.taxAuthority } } : {}),
      ...(changes.length ? { rateChanges: changes } : {}),
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
    })
    return { id: grnId, grnStatus: 'finance_review' as const, returnCount: g.returnCount, rateChanges: changes }
  })
  const { approvalWaiting } = await import('../approvals/notify.js')
  approvalWaiting('grn_finance', grnId, { round: `finance_review:r${r.returnCount}:${now.toISOString()}`, actorId: actor.id })
  return r
}

/**
 * The CEO's final approval (the route proved the right): ceo_review → approved, and the supplier bill is created in
 * the SAME transaction through the bill engine (header). 409 BILL_NUMBER_TAKEN when the supplier already has a bill
 * with the invoice number; a bill dated in a closed month is refused by the posting (nothing is saved).
 */
export async function approveGrn(grnId: string, actor: Actor) {
  const g = await prisma.goodsReceipt.findUnique({
    where: { id: grnId },
    include: { lines: true },
  })
  if (!g || !g.grnNumber || !g.poId) throw new NotFoundError('GoodsReceipt', grnId)
  if (g.grnStatus !== 'ceo_review') throw new AppError('INVALID_STATE', `This GRN is ${String(g.grnStatus).replace(/_/g, ' ')} — not waiting for the CEO`, 409)
  if (!g.invoiceNumber || !g.invoiceDate) throw new AppError('INVOICE_REQUIRED', 'This GRN has no invoice number / date', 422)
  const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: g.poId }, include: { lines: true } })
  const taken = await prisma.supplierBill.findFirst({ where: { supplierId: g.supplierId, billNumber: g.invoiceNumber }, select: { id: true } })
  if (taken) throw new AppError('BILL_NUMBER_TAKEN', `${g.invoiceNumber} is already a bill of this supplier — the buyer must correct the invoice number (return the GRN)`, 409)
  const lines = g.lines.filter((l) => l.receivedQty > 0 && l.poLineId).map((l) => {
    const pl = po.lines.find((x) => x.id === l.poLineId)!
    return {
      inventoryItemId: l.inventoryItemId, poLineId: pl.id, receiptLineId: l.id,
      description: l.description ?? 'Item',
      quantity: l.receivedQty, unitCostCents: pl.unitCostCents,
      lineTotalCents: lineValueCents({ quantityOrdered: l.receivedQty, unitCostCents: pl.unitCostCents, orderUnitFactor: pl.orderUnitFactor, orderUnitCostCents: pl.orderUnitCostCents }),
    }
  })
  if (lines.length === 0) throw new AppError('NO_LINES', 'Nothing was received on this GRN', 422)
  const prepared = await prepareBill({
    supplierId: g.supplierId, poId: g.poId, billNumber: g.invoiceNumber, billDate: g.invoiceDate.toISOString().slice(0, 10),
    notes: `${g.grnNumber} of ${po.reference ?? 'PO'}`, lines, createdBy: actor.id, actorRole: actor.role, viaGrn: true,
    // The invoice's sales tax (input tax, booked by authority by the bill engine); no authority = the supplier's usual one.
    taxCents: g.invoiceTaxCents == null ? 0 : toCents(g.invoiceTaxCents),
    taxAuthority: isAuthorityKey(g.invoiceTaxAuthority) ? g.invoiceTaxAuthority : null,
  })
  await ensureFifoReady(prepared.tenantId)
  const now = new Date()
  const bill = await prisma.$transaction(async (tx) => {
    const claimed = await tx.goodsReceipt.updateMany({
      where: { id: grnId, grnStatus: 'ceo_review' },
      data: { grnStatus: 'approved', approvedById: actor.id, approvedAt: now },
    })
    if (claimed.count === 0) throw new AppError('INVALID_STATE', 'This GRN was decided meanwhile — reload it', 409)
    let b
    try {
      b = await insertBillTx(tx, prepared)
    } catch (err) {
      if (err instanceof AppError && err.code === 'DUPLICATE_BILL') throw new AppError('BILL_NUMBER_TAKEN', err.message, 409)
      throw err
    }
    await tx.goodsReceipt.update({ where: { id: grnId }, data: { supplierBillId: b.id } })
    await logGrnTx(tx, g.poId!, actor.id, 'grn_approved', { grnId, grnNumber: g.grnNumber, from: 'ceo_review', to: 'approved', supplierBillId: b.id, billNumber: b.billNumber, totalCents: toCents(b.totalCents) })
    return b
  }, { timeout: 30_000 })
  await afterBillCreated(prepared, bill)
  grnPayNotice(grnId, actor.id)
  return { id: grnId, grnStatus: 'approved' as const, supplierBillId: bill.id, billNumber: bill.billNumber, totalCents: toCents(bill.totalCents), payByCash: po.payByCash }
}

// ─── My tasks ────────────────────────────────────────────────────────────────

/** The caller's own tasks in their companies (owner: "users see only pending tasks assigned to them"). */
export async function myTasks(userId: string, tenantIds: string[]) {
  if (tenantIds.length === 0) return { toBuy: [], toConfirm: [], toFix: [] }
  const supplier = { tenantId: { in: tenantIds } }
  const poInclude = {
    supplier: { select: { id: true, name: true, tenantId: true, systemKind: true } },
    lines: { include: { inventoryItem: { select: { name: true, unit: true } } } },
  } satisfies Prisma.PurchaseOrderInclude
  const [toBuy, toConfirm, fixGrns] = await Promise.all([
    prisma.purchaseOrder.findMany({ where: { buyerUserId: userId, grnWorkflow: true, status: { in: [...BUYER_STAGE] }, supplier }, include: poInclude, orderBy: { approvedAt: 'asc' }, take: 200 }),
    prisma.purchaseOrder.findMany({ where: { createdBy: userId, grnWorkflow: true, status: 'completed', supplier }, include: poInclude, orderBy: { completedAt: 'asc' }, take: 200 }),
    prisma.goodsReceipt.findMany({
      where: { grnStatus: 'buyer_fix', tenantId: { in: tenantIds }, poId: { not: null } },
      include: { lines: true },
      orderBy: { returnedAt: 'asc' }, take: 200,
    }),
  ])
  const fixPos = fixGrns.length ? await prisma.purchaseOrder.findMany({ where: { id: { in: fixGrns.map((g) => g.poId!) }, buyerUserId: userId }, include: poInclude }) : []
  const poById = new Map(fixPos.map((p) => [p.id, p]))
  const files = await prisma.cashVoucherAttachment.groupBy({
    by: ['ownerId'], where: { kind: RECORD_FILE_KIND, ownerType: PO_FILE_OWNER, ownerId: { in: [...toBuy, ...toConfirm, ...fixPos].map((p) => p.id) } }, _count: { _all: true },
  })
  const fileCount = new Map(files.map((f) => [f.ownerId!, f._count._all]))
  const shapePo = <T extends { id: string; totalCents: unknown }>(p: T) => ({ ...p, totalCents: toCents(p.totalCents as never), invoiceFiles: fileCount.get(p.id) ?? 0 })
  return {
    toBuy: toBuy.map(shapePo),
    toConfirm: toConfirm.map(shapePo),
    toFix: fixGrns.filter((g) => poById.has(g.poId!)).map((g) => ({ ...g, po: shapePo(poById.get(g.poId!)!) })),
  }
}

// ─── The bell (queued after commit; never fails the action) ─────────────────

type PoTask = 'to_buy' | 'to_confirm' | 'to_fix'

/** Tell the person a task just landed on: the buyer (to buy / to fix) or the requester (to confirm). */
export function poTaskNotice(task: PoTask, poId: string, actorId: string | null, note?: string | null, grnId?: string | null): void {
  queueStaffNotify(async () => {
    const po = await serviceClient.purchaseOrder.findUnique({
      where: { id: poId },
      select: { id: true, reference: true, status: true, createdBy: true, buyerUserId: true, updatedAt: true, supplier: { select: { name: true, tenantId: true } } },
    })
    if (!po) return 0
    const ref = po.reference ?? `PO ${po.id.slice(-8).toUpperCase()}`
    let userId: string | null
    let title: string
    if (task === 'to_confirm') {
      if (po.status !== 'completed') return 0
      userId = po.createdBy
      title = `${ref} bought — confirm what you received`
    } else if (task === 'to_buy') {
      if (!(BUYER_STAGE as readonly string[]).includes(po.status)) return 0
      userId = po.buyerUserId
      title = note ? `${ref} sent back by the requester — not received as completed` : `${ref} approved — buy it from ${po.supplier.name}`
    } else {
      userId = po.buyerUserId
      title = `${ref}: the GRN was returned — correct the invoice`
    }
    if (!userId) return 0
    const row: NotifyInput = {
      userId, tenantId: po.supplier.tenantId, kind: 'task.next', severity: note ? 'warning' : 'info', title,
      body: note ? `Note: ${note}` : null, link: '/procurement?tab=tasks', entityType: 'purchase_order', entityId: po.id, actorId,
      dedupeKey: `task.next:po:${po.id}:${task}:${grnId ?? ''}:${po.updatedAt.toISOString()}`.slice(0, 200),
    }
    return notifyStaffMany([row])
  })
}

/** The CEO approved the GRN: finance (with accounting) pays the supplier — from the buyer's box or Supplier payments. */
function grnPayNotice(grnId: string, actorId: string): void {
  queueStaffNotify(async () => {
    const g = await serviceClient.goodsReceipt.findUnique({ where: { id: grnId }, select: { tenantId: true, grnNumber: true, poId: true, supplierBillId: true, supplierId: true, grnStatus: true } })
    if (!g?.tenantId || g.grnStatus !== 'approved' || !g.poId) return 0
    const [po, sup] = await Promise.all([
      serviceClient.purchaseOrder.findUnique({ where: { id: g.poId }, select: { payByCash: true, reference: true, buyerUserId: true } }),
      serviceClient.supplier.findUnique({ where: { id: g.supplierId }, select: { name: true } }),
    ])
    const users = await serviceClient.user.findMany({
      where: { role: 'finance', isActive: true, accountStatus: 'active', deletedAt: null, OR: [{ tenantId: g.tenantId }, { tenantMemberships: { some: { tenantId: g.tenantId } } }] },
      select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
    })
    const ids: string[] = []
    for (const u of users) {
      if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has('accounting')) ids.push(u.id)
    }
    if (po?.payByCash && po.buyerUserId) ids.push(po.buyerUserId)
    const body = po?.payByCash
      ? "Paid by cash: pay the bill from the buyer's petty-cash box (Petty cash → spend → supplier bill)."
      : 'Pay the supplier through Supplier payments.'
    const rows: NotifyInput[] = [...new Set(ids)].map((userId) => ({
      userId, tenantId: g.tenantId, kind: 'task.next', severity: 'info', title: `GRN approved — pay ${sup?.name ?? 'the supplier'} (${g.grnNumber})`,
      body, link: '/procurement?tab=bills', entityType: 'goods_receipt', entityId: grnId, actorId,
      dedupeKey: `task.next:grn:${grnId}:pay`,
    }))
    return notifyStaffMany(rows)
  })
}
