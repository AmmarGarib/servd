// Supplier credit notes / returns (finance gaps 14a).
//
// ONE AP subledger: a credit note is a SupplierBill of kind 'credit_note'
// against its original bill (originalBillId) — never a second document table.
// Its lines are SupplierBillLine rows copied from the bill's lines (the same
// description and stock item; returnQty = stock sent back to the supplier;
// never a PO line, so the 3-way match and the bill price-variance logic only
// ever see bills). Its money columns mean:
//   subtotal / tax / total   what the supplier credits (positive amounts)
//   whtCents                 the share of the bill's withholding it reverses
//   creditedCents            how much of it has been applied to bills
// and its status is 'open' (something left to apply), 'applied' or 'void'.
//
// Lifecycle (every step under the credit note's row lock, then the bills'):
//   create   POST /procurement/bills/:id/credit-notes — lines picked from the
//            bill (qty / price per reason), optional stock return, posted in
//            the same transaction (accounting/supplierPosting.ts
//            postSupplierCreditNote): a closed month is PERIOD_LOCKED 422 and
//            nothing is saved. By default it is applied to its own bill at
//            once, up to what that bill still owes; the rest stays a credit.
//   apply    to any open bill of the same supplier (bill.creditedCents goes
//            up, its status follows billDueCents) — no ledger change: the
//            credit note already debited AP 2010 in full.
//   unapply  the reverse, also with no ledger change.
//   void     only while nothing is applied: reverses the entry (dated today),
//            puts returned stock back into the lots it came from and undoes
//            the lot re-pricing.
//
// Stock is on FIFO lots (finance wave B): goods sent back leave the BILL's own
// lots first (then FIFO); a price credit re-prices the bill's lots (the share
// already cooked goes to 5060) — accounting/supplierPosting.ts.
//
// Caps: a credit note can never credit more than the bill — per bill line
// (lines with the same stock item and description count together), in total,
// in tax and in quantity sent back. Goods sent back are also capped at what is
// left in the bill's own lots (a bill from before the FIFO cut-over has none:
// the stock on hand caps it).

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { billLotsForItem, postSupplierCreditNote, postSupplierCreditNoteVoid, type CreditNoteReason } from '../accounting/supplierPosting.js'
import { ensureFifoReady } from '../../lib/stockLedger.js'
import { assertPayableBill, billDueCents, creditNoteAvailableCents, lockBills, settledStatus } from './service.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

export const CREDIT_NOTE_REASONS = ['return', 'price', 'short', 'damaged', 'rebate'] as const satisfies readonly CreditNoteReason[]

export const CREDIT_NOTE_REASON_LABEL: Record<CreditNoteReason, string> = {
  return:  'Goods returned',
  price:   'Price correction',
  short:   'Short delivery',
  damaged: 'Damaged goods',
  rebate:  'Rebate',
}

/** Reasons that credit a QUANTITY of the bill (at most what was billed). */
const QUANTITY_REASONS = new Set<CreditNoteReason>(['return', 'short', 'damaged'])
/** Reasons where goods can physically go back to the supplier (stock drops). */
const STOCK_BACK_REASONS = new Set<CreditNoteReason>(['return', 'damaged'])

const EPS = 1e-9
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

function lineKey(stockItemId: string | null, description: string): string {
  return `${stockItemId ?? ''}|${description}`
}

// ─── What is left to credit on a bill ────────────────────────────────────────

export interface CreditableLine {
  billLineId:     string
  description:    string
  quantity:       number
  unitCostCents:  number
  lineTotalCents: number
  /** The stock item behind the line (its own, else its PO line's), if any. */
  stockItemId:    string | null
  /** Already credited / sent back on live credit notes (lines with the same item and description count together). */
  creditedCents:  number
  returnedQty:    number
  /** What a new credit note can still credit on this line. */
  leftCents:      number
  returnableQty:  number
}

export interface CreditableBill {
  lines:            CreditableLine[]
  creditedCents:    number
  subtotalLeftCents: number
  taxLeftCents:     number
  whtCreditedCents: number
}

async function creditsAgainst(db: Db, billId: string) {
  const creditNotes = await db.supplierBill.findMany({
    where:   { originalBillId: billId, kind: 'credit_note', status: { not: 'void' } },
    include: { lines: true },
  })
  const creditedByKey = new Map<string, number>()
  const returnedByKey = new Map<string, number>()
  let subtotal = 0
  let tax = 0
  let wht = 0
  for (const cn of creditNotes) {
    subtotal += toCents(cn.subtotalCents)
    tax += toCents(cn.taxCents)
    wht += toCents(cn.whtCents)
    for (const l of cn.lines) {
      const k = lineKey(l.inventoryItemId, l.description)
      creditedByKey.set(k, (creditedByKey.get(k) ?? 0) + toCents(l.lineTotalCents))
      returnedByKey.set(k, (returnedByKey.get(k) ?? 0) + (l.returnQty ?? 0))
    }
  }
  return { creditNotes, creditedByKey, returnedByKey, subtotal, tax, wht }
}

type BillForCredit = Prisma.SupplierBillGetPayload<{ include: { lines: { include: { poLine: { select: { inventoryItemId: true } } } } } }>

/**
 * Quantity left in the bill's own lots per stock item (absent = the bill has
 * no lots for it — recorded before the FIFO cut-over, or billed ahead).
 */
async function lotsLeftByItem(db: Tx, bill: BillForCredit & { supplier?: { tenantId: string | null } | null }, tenantId: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!tenantId) return out
  const itemIds = [...new Set(bill.lines.map((l) => l.inventoryItemId ?? l.poLine?.inventoryItemId ?? null).filter((x): x is string => !!x))]
  for (const itemId of itemIds) {
    const lots = await billLotsForItem(db, tenantId, bill.id, itemId)
    if (lots.length > 0) out.set(itemId, lots.reduce((s, l) => s + Math.max(0, l.remainingQty), 0))
  }
  return out
}

function creditableOf(bill: BillForCredit, prior: Awaited<ReturnType<typeof creditsAgainst>>, lotsLeft: Map<string, number> = new Map()): CreditableBill {
  const groupTotal = new Map<string, number>()
  const groupQty = new Map<string, number>()
  const base = bill.lines.map((l) => {
    const stockItemId = l.inventoryItemId ?? l.poLine?.inventoryItemId ?? null
    const k = lineKey(stockItemId, l.description)
    groupTotal.set(k, (groupTotal.get(k) ?? 0) + toCents(l.lineTotalCents))
    groupQty.set(k, (groupQty.get(k) ?? 0) + l.quantity)
    return { l, stockItemId, k }
  })
  const lines = base.map(({ l, stockItemId, k }) => {
    const creditedCents = prior.creditedByKey.get(k) ?? 0
    const returnedQty = prior.returnedByKey.get(k) ?? 0
    return {
      billLineId:     l.id,
      description:    l.description,
      quantity:       l.quantity,
      unitCostCents:  toCents(l.unitCostCents),
      lineTotalCents: toCents(l.lineTotalCents),
      stockItemId,
      creditedCents,
      returnedQty,
      leftCents:      Math.max(0, Math.min(toCents(l.lineTotalCents), (groupTotal.get(k) ?? 0) - creditedCents)),
      returnableQty:  stockItemId
        ? Math.max(0, Math.min(l.quantity, (groupQty.get(k) ?? 0) - returnedQty, lotsLeft.get(stockItemId) ?? Number.POSITIVE_INFINITY))
        : 0,
    }
  })
  return {
    lines,
    creditedCents:     prior.subtotal + prior.tax,
    subtotalLeftCents: Math.max(0, toCents(bill.subtotalCents) - prior.subtotal),
    taxLeftCents:      Math.max(0, toCents(bill.taxCents) - prior.tax),
    whtCreditedCents:  prior.wht,
  }
}

/** A bill's lines with what is left to credit on each (the credit-note form reads this). */
export async function creditableBill(billId: string, db: Db = prisma): Promise<CreditableBill | null> {
  const bill = await db.supplierBill.findUnique({
    where:   { id: billId },
    include: { supplier: { select: { tenantId: true } }, lines: { include: { poLine: { select: { inventoryItemId: true } } } } },
  })
  if (!bill || bill.kind !== 'bill') return null
  const lotsLeft = await lotsLeftByItem(db as Tx, bill, bill.supplier.tenantId)
  return creditableOf(bill, await creditsAgainst(db, billId), lotsLeft)
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateCreditNoteInput {
  billId:        string
  /** The supplier's own credit-note number. */
  number:        string
  date:          string
  reason:        CreditNoteReason
  lines:         Array<{ billLineId: string; qty?: number | null; unitCostCents?: number | null }>
  taxCents?:     number
  /** Goods physically sent back: stock of each stock line drops by its qty. */
  returnStock?:  boolean
  /** Apply it to its own bill at once (default), up to what the bill still owes. */
  applyToBill?:  boolean
  notes?:        string | null
  createdBy:     string
}

export async function createCreditNote(input: CreateCreditNoteInput) {
  const number = input.number.trim()
  if (!number) throw new AppError('NUMBER_REQUIRED', 'Enter the supplier\'s credit note number', 400)
  const date = new Date(input.date)
  if (Number.isNaN(date.getTime())) throw new AppError('INVALID_DATE', 'The credit note date is not a date', 400)
  if (input.lines.length === 0) throw new AppError('NO_LINES', 'Pick at least one line of the bill to credit', 400)
  if (new Set(input.lines.map((l) => l.billLineId)).size !== input.lines.length) {
    throw new AppError('DUPLICATE_LINE', 'Each bill line can appear only once on a credit note', 400)
  }
  const reason = input.reason
  if (input.returnStock && !STOCK_BACK_REASONS.has(reason)) {
    throw new AppError('RETURN_NEEDS_GOODS_BACK', `Only returned or damaged goods go back to the supplier — for a ${CREDIT_NOTE_REASON_LABEL[reason].toLowerCase()}, untick "goods sent back"`, 422)
  }
  const taxCents = input.taxCents ?? 0
  assertMoneyFits(taxCents, 'The credit note\'s tax')

  // Goods go back out of FIFO lots: the company's one-time cut-over runs
  // first if it has not (outside the transaction).
  const owner = await prisma.supplierBill.findUnique({ where: { id: input.billId }, select: { supplier: { select: { tenantId: true } } } })
  if (owner?.supplier.tenantId) await ensureFifoReady(owner.supplier.tenantId)

  try {
    return await prisma.$transaction(async (tx) => {
      // The bill's row lock serialises two credit notes against it (the caps
      // below read the earlier ones) and a void of the bill.
      await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${input.billId} FOR UPDATE`
      const bill = await tx.supplierBill.findUnique({
        where:   { id: input.billId },
        include: { supplier: { select: { id: true, name: true, tenantId: true } }, lines: { include: { poLine: { select: { inventoryItemId: true } } } } },
      })
      if (!bill) throw new NotFoundError('SupplierBill', input.billId)
      if (bill.kind !== 'bill') throw new AppError('NOT_A_BILL', 'A credit note is raised against a bill, not another credit note', 422)
      if (bill.status === 'void' || bill.status === 'draft') {
        throw new AppError('BILL_NOT_OPEN', `Bill ${bill.billNumber} is ${bill.status} — there is nothing to credit`, 422)
      }
      if (!bill.supplier.tenantId) {
        throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before recording its credit notes', 422)
      }

      const prior = await creditsAgainst(tx, bill.id)
      const lotsLeft = await lotsLeftByItem(tx, bill, bill.supplier.tenantId)
      const view = creditableOf(bill, prior, lotsLeft)

      const built = input.lines.map((l, i) => {
        const orig = view.lines.find((x) => x.billLineId === l.billLineId)
        if (!orig) throw new AppError('BILL_LINE_NOT_FOUND', `Line ${i + 1} is not a line of bill ${bill.billNumber}`, 422)
        const qty = l.qty ?? orig.quantity
        if (!(qty > 0) || !Number.isFinite(qty)) throw new AppError('INVALID_QUANTITY', `${orig.description}: the quantity must be more than zero`, 400)
        if (QUANTITY_REASONS.has(reason) && qty > orig.quantity + EPS) {
          throw new AppError('OVER_CREDIT_QTY', `${orig.description}: only ${orig.quantity} was billed`, 422)
        }
        let unit: number
        if (reason === 'price' || reason === 'rebate') {
          if (l.unitCostCents == null) {
            throw new AppError('AMOUNT_REQUIRED', `${orig.description}: say how much per unit the supplier is crediting`, 422)
          }
          unit = l.unitCostCents
        } else {
          unit = l.unitCostCents ?? orig.unitCostCents
        }
        if (!Number.isInteger(unit) || unit <= 0) throw new AppError('INVALID_AMOUNT', `${orig.description}: the credit per unit must be more than zero`, 400)
        if (unit > orig.unitCostCents) {
          throw new AppError('OVER_CREDIT', `${orig.description}: the credit per unit is more than the bill charged (${pkr(orig.unitCostCents)})`, 422)
        }
        const total = Math.round(qty * unit)
        if (total <= 0) throw new AppError('INVALID_AMOUNT', `${orig.description}: the credit comes to nothing`, 400)
        assertMoneyFits(total, `${orig.description} (quantity × credit per unit)`)
        const returnQty = input.returnStock && orig.stockItemId ? qty : null
        return { orig, qty, unit, total, returnQty }
      })

      if (input.returnStock && !built.some((b) => b.returnQty != null)) {
        throw new AppError('NO_STOCK_TO_RETURN', 'None of these lines is a stock item, so no stock goes back — untick "goods sent back"', 422)
      }

      // Never more than the bill: per line group, in quantity sent back, in
      // total and in tax.
      const groups = new Map<string, { cents: number; returnQty: number; left: number; returnable: number; description: string }>()
      for (const b of built) {
        const k = lineKey(b.orig.stockItemId, b.orig.description)
        const sameKey = view.lines.filter((x) => lineKey(x.stockItemId, x.description) === k)
        const g = groups.get(k) ?? {
          cents: 0, returnQty: 0, description: b.orig.description,
          left: sameKey.reduce((s, x) => s + x.lineTotalCents, 0) - (prior.creditedByKey.get(k) ?? 0),
          returnable: Math.min(
            sameKey.reduce((s, x) => s + x.quantity, 0) - (prior.returnedByKey.get(k) ?? 0),
            b.orig.stockItemId ? (lotsLeft.get(b.orig.stockItemId) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY,
          ),
        }
        g.cents += b.total
        g.returnQty += b.returnQty ?? 0
        groups.set(k, g)
      }
      for (const g of groups.values()) {
        if (g.returnQty > g.returnable + EPS) {
          throw new AppError('OVER_RETURN', `${g.description}: only ${Math.max(0, g.returnable)} is left to send back`, 422)
        }
        if (g.cents > g.left) {
          throw new AppError('OVER_CREDIT', `${g.description}: only ${pkr(Math.max(0, g.left))} of it is left to credit`, 422)
        }
      }
      const subtotalCents = built.reduce((s, b) => s + b.total, 0)
      if (subtotalCents > view.subtotalLeftCents) {
        throw new AppError('CREDIT_EXCEEDS_BILL', `Only ${pkr(view.subtotalLeftCents)} of bill ${bill.billNumber} is left to credit`, 422)
      }
      if (taxCents > view.taxLeftCents) {
        throw new AppError('CREDIT_TAX_EXCEEDS_BILL', `Only ${pkr(view.taxLeftCents)} of the bill's tax is left to credit`, 422)
      }
      const totalCents = subtotalCents + taxCents
      assertMoneyFits(totalCents, 'This credit note\'s total')

      // The withholding fixed on the bill, reduced pro rata to the goods
      // credited; the credit that takes the bill's last goods takes what is
      // left of it exactly (no rounding residue).
      const billSubtotal = toCents(bill.subtotalCents)
      const billWht = toCents(bill.whtCents)
      const whtLeft = Math.max(0, billWht - prior.wht)
      let whtCents = billSubtotal > 0 ? Math.round(billWht * subtotalCents / billSubtotal) : 0
      if (prior.subtotal + subtotalCents >= billSubtotal) whtCents = whtLeft
      whtCents = Math.max(0, Math.min(whtCents, whtLeft))

      const cn = await tx.supplierBill.create({
        data: {
          supplierId:     bill.supplierId,
          kind:           'credit_note',
          originalBillId: bill.id,
          billNumber:     number,
          billDate:       date,
          dueDate:        date,
          status:         'open',
          subtotalCents,
          taxCents,
          totalCents,
          whtCents,
          notes:          `${CREDIT_NOTE_REASON_LABEL[reason]}${input.notes ? ` — ${input.notes}` : ''}`,
          createdBy:      input.createdBy,
          lines: {
            create: built.map((b) => ({
              inventoryItemId: b.orig.stockItemId,
              poLineId:        null,
              description:     b.orig.description,
              quantity:        b.qty,
              unitCostCents:   b.unit,
              lineTotalCents:  b.total,
              returnQty:       b.returnQty,
            })),
          },
        },
      })

      // Stock, item cost and the entry — same transaction.
      const posting = await postSupplierCreditNote(cn.id, { tx, postedBy: input.createdBy, reason })

      let appliedCents = 0
      if (input.applyToBill !== false) {
        const owed = billDueCents(bill)
        appliedCents = Math.min(creditNoteAvailableCents(cn), owed)
        if (appliedCents > 0) await applyCreditTx(tx, cn.id, [{ billId: bill.id, amountCents: appliedCents }], input.createdBy)
      }

      const saved = await tx.supplierBill.findUniqueOrThrow({ where: { id: cn.id }, include: { lines: true } })
      return { creditNote: saved, tenantId: bill.supplier.tenantId, billNumber: bill.billNumber, appliedCents, entryId: posting.entryId }
    }, { timeout: 30_000 })
  } catch (err) {
    const e = err as Prisma.PrismaClientKnownRequestError
    if (e.code === 'P2002') {
      throw new AppError('DUPLICATE_BILL', `Number ${number} is already used by a bill or credit note from this supplier`, 409)
    }
    throw err
  }
}

// ─── Apply / unapply ─────────────────────────────────────────────────────────

/** Apply a credit note to bills of its supplier, inside the caller's transaction. */
async function applyCreditTx(
  tx: Tx,
  creditNoteId: string,
  applications: Array<{ billId: string; amountCents: number }>,
  userId: string,
) {
  applications.forEach((a) => assertMoneyFits(a.amountCents, 'An amount applied to a bill'))
  if (new Set(applications.map((a) => a.billId)).size !== applications.length) {
    throw new AppError('DUPLICATE_BILL', 'Each bill can appear only once', 400)
  }
  await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${creditNoteId} FOR UPDATE`
  const cn = await tx.supplierBill.findUnique({
    where:   { id: creditNoteId },
    include: { supplier: { select: { tenantId: true } }, creditsGiven: true },
  })
  if (!cn || cn.kind !== 'credit_note') throw new NotFoundError('SupplierCreditNote', creditNoteId)
  if (cn.status === 'void') throw new AppError('CREDIT_NOTE_VOID', `Credit note ${cn.billNumber} is void`, 422)
  const tenantId = cn.supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company first', 422)
  const adding = applications.reduce((s, a) => s + a.amountCents, 0)
  const available = creditNoteAvailableCents(cn)
  if (adding > available) {
    throw new AppError('OVER_ALLOCATED', `Only ${pkr(available)} of credit note ${cn.billNumber} is left to apply`, 422)
  }

  const bills = await lockBills(tx, applications.map((a) => a.billId))
  for (const a of applications) {
    const bill = bills.find((b) => b.id === a.billId)
    if (!bill) throw new NotFoundError('SupplierBill', a.billId)
    assertPayableBill(bill, cn.supplierId)
    const owed = billDueCents(bill)
    if (a.amountCents > owed) {
      throw new AppError('OVER_APPLIED', `Bill ${bill.billNumber} only has ${pkr(Math.max(0, owed))} due`, 422)
    }
    const prior = cn.creditsGiven.find((x) => x.billId === a.billId)
    if (prior) {
      await tx.supplierCreditApplication.update({ where: { id: prior.id }, data: { amountCents: { increment: a.amountCents } } })
    } else {
      await tx.supplierCreditApplication.create({
        data: { tenantId, creditNoteId, billId: a.billId, amountCents: a.amountCents, createdBy: userId },
      })
    }
    const updated = await tx.supplierBill.update({ where: { id: a.billId }, data: { creditedCents: { increment: a.amountCents } } })
    const status = settledStatus(updated)
    if (status !== updated.status) await tx.supplierBill.update({ where: { id: a.billId }, data: { status } })
  }
  const after = await tx.supplierBill.update({ where: { id: creditNoteId }, data: { creditedCents: { increment: adding } } })
  const status = creditNoteAvailableCents(after) <= 0 ? 'applied' : 'open'
  if (status !== after.status) await tx.supplierBill.update({ where: { id: creditNoteId }, data: { status } })
  return { creditNoteId, appliedCents: adding, status, tenantId }
}

/** Apply a credit note to one or more open bills of the same supplier. No ledger change. */
export async function applyCreditNote(
  creditNoteId: string,
  applications: Array<{ billId: string; amountCents: number }>,
  userId: string,
) {
  if (applications.length === 0) throw new AppError('NO_LINES', 'Pick a bill to apply the credit to', 400)
  return prisma.$transaction((tx) => applyCreditTx(tx, creditNoteId, applications, userId))
}

/** Take a credit note off a bill: the bill owes that much again, the credit is free to apply elsewhere. No ledger change. */
export async function unapplyCreditNote(creditNoteId: string, billId: string) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${creditNoteId} FOR UPDATE`
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const application = await tx.supplierCreditApplication.findUnique({
      where: { creditNoteId_billId: { creditNoteId, billId } },
    })
    if (!application) throw new AppError('NOT_APPLIED', 'This credit note is not applied to that bill', 422)
    const amount = toCents(application.amountCents)
    await tx.supplierCreditApplication.delete({ where: { id: application.id } })
    const bill = await tx.supplierBill.update({ where: { id: billId }, data: { creditedCents: { decrement: amount } } })
    const billStatus = settledStatus(bill)
    if (billStatus !== bill.status) await tx.supplierBill.update({ where: { id: billId }, data: { status: billStatus } })
    const cn = await tx.supplierBill.update({ where: { id: creditNoteId }, data: { creditedCents: { decrement: amount }, status: 'open' } })
    return { creditNoteId, billId, amountCents: amount, billStatus, creditNote: cn }
  })
}

// ─── Void ────────────────────────────────────────────────────────────────────

/**
 * Void a credit note entered in error — only while it is applied to no bill
 * (422 CREDIT_NOTE_APPLIED: unapply it first). The reversal, stock going back
 * and item cost being restored commit with the void (a closed period today
 * refuses it). Idempotent: voiding a void credit note returns it unchanged.
 */
export async function voidCreditNote(creditNoteId: string, userId: string, reason: string) {
  // Returned goods go back into FIFO lots (the company's cut-over first, outside the transaction).
  const owner = await prisma.supplierBill.findUnique({ where: { id: creditNoteId }, select: { supplier: { select: { tenantId: true } } } })
  if (owner?.supplier.tenantId) await ensureFifoReady(owner.supplier.tenantId)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${creditNoteId} FOR UPDATE`
    const cn = await tx.supplierBill.findUnique({
      where:   { id: creditNoteId },
      include: { creditsGiven: { select: { id: true } } },
    })
    if (!cn || cn.kind !== 'credit_note') throw new NotFoundError('SupplierCreditNote', creditNoteId)
    if (cn.status === 'void') return { creditNote: cn, alreadyVoid: true as const, reversal: null }
    if (cn.creditsGiven.length > 0 || toCents(cn.creditedCents) !== 0) {
      throw new AppError('CREDIT_NOTE_APPLIED', 'This credit note is applied to bills — unapply it from each bill first', 422)
    }
    const updated = await tx.supplierBill.update({
      where: { id: creditNoteId },
      data:  { status: 'void', voidedAt: new Date(), voidReason: reason },
    })
    const reversal = await postSupplierCreditNoteVoid(creditNoteId, reason, { tx, postedBy: userId })
    return { creditNote: updated, alreadyVoid: false as const, reversal }
  }, { timeout: 30_000 })
}
