// Supplier bill / payment / credit note → journal posting (finance wave B:
// goods booked on arrival against 2015 GRNI, bills on FIFO lots — H16/H17).
//
// Everything here posts INSIDE the transaction that saves its document (pass
// `{ tx }`; procurement createBill / voidBill / createPaymentTx and
// creditNotes.ts do): a PERIOD_LOCKED (or any other refusal) rolls the save
// back with it. Every entry is in the SUPPLIER's company and idempotent on
// 'sourceType:sourceId'.
//
// ─── How stock reaches the books (owner decision 30 is replaced by FIFO) ────
//
// The goods receipt books the stock: procurement/receiving.ts opens one FIFO
// lot per receipt line (StockLot, at the PO price, the dock price, or the
// price a bill already charged for that quantity) and posts Dr 12x0 / Cr 2015
// GRNI ('procurement.receipt:<receiptId>', accounting/inventoryPosting.ts).
// The bill then CLEARS 2015 — it never debits inventory directly:
//
//   'supplier.bill:<billId>'                       (billDate, in createBill's tx)
//     Dr 2015      each stock line's quantity matched FIFO to unbilled receipt
//                  lines of its PO line (or to its receiptLineId) × the cost
//                  the receipt booked it at — a GrniMatch 'live' row per
//                  receipt line, GoodsReceiptLine.billedQty raised;
//     Dr/Cr 12x0   the price difference (billed − receipt cost) on the share of
//                  the lot still on hand — stockLedger.repriceLotTx re-prices
//                  the lot, so lots and 1210/1220/1230 keep agreeing;
//     Dr/Cr 5060   the share of that difference on stock already cooked, split
//                  by brand usage (H20);
//     Dr 2015      at the BILLED price for quantity billed before it arrived
//                  (GrniMatch 'pending', PO lines only, ≤ ordered − received,
//                  else 422 OVER_BILLED) — the receipt opens that quantity's lot
//                  at the billed price and its 2015 credit nets this debit;
//     Dr 6xxx      each line that is not stock, to its own expenseAccountCode;
//     Dr 132x      the tax, on the input account of the authority that charged
//                  it (inputTaxCodeFor(bill.taxAuthority), H8);
//     Cr 2040      the withholding fixed on the bill (lib/withholding.ts);
//     Cr 2010      the rest.
//
//   Void ('supplier.bill.void:<billId>' the reversal, dated today) re-opens
//   GRNI; every live match's lot re-pricing is undone (repriceLotTx in
//   reverse) and 'supplier.bill.void.price:<billId>' trues up 12x0 against
//   5060 for the part cooked in between. A LEGACY bill (recorded before the
//   company's FIFO cut-over — no live GrniMatch rows; it debited 1210
//   directly) posts 'supplier.bill.void.legacy:<billId>': Dr 1210 back what
//   the reversal took out, Cr 2015 for the received quantity it had matched
//   (at the receipt cost) and for its cut-over billed-ahead quantity, 5060 the
//   difference — so the inventory accounts keep equalling the lots.
//
// The moving-average machinery (re-averaging InventoryItem.unitCostCents on a
// bill, carrying a bill's variance until its goods arrive, the
// 'supplier.bill.variance*' audit rows) is gone: the one-time catch-up of
// missed carried variances runs as step 0 of each company's FIFO cut-over
// (inventory/fifoCutover.ts). The old audit rows stay readable.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT, postJournalEntry, reverseJournalEntry, type JournalLineInput } from './journal.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { assertInt4Fits, sumCents, toCents, type DbMoney } from '../../lib/money.js'
import { CLASS_ACCOUNTS, CLASS_LABEL, COST_CLASSES, costClassOf, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { brandUsageShares, splitCents } from '../../lib/brandShare.js'
import {
  addLotTx, consumeFifoTx, readFifoCutoverAt, repriceLotTx, returnToLotsTx, PURCHASE_PRICE_SOURCES, type MovementRow,
} from '../../lib/stockLedger.js'
import { computeWithholding, WHT_SECTION_LABEL, whtSectionOrNull, type WhtSection } from '../../lib/withholding.js'
import { AUTHORITIES, inputTaxCodeFor, isAuthorityKey } from './taxAuthorities.js'

type Tx = Prisma.TransactionClient
type Db = Prisma.TransactionClient | PrismaClient

/** 5060 Inventory Cost Adjustment — every price difference on stock already used. */
export const INVENTORY_COST_ADJUSTMENT = ACCT.COST_ADJUSTMENT

const EPS = 1e-9
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtQty = (q: number) => String(Math.round(q * 1000) / 1000)
const asClass = (v: string | null | undefined): CostClass => ((COST_CLASSES as readonly string[]).includes(v ?? '') ? (v as CostClass) : 'food')

type PostResult = { posted: boolean; entryId: string | null; reason?: string }

/** Run `fn` in the caller's transaction, or in a fresh one. */
async function inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tx) return fn(tx)
  return prisma.$transaction((t) => fn(t), { timeout: 30_000 })
}

const billRef = (billId: string) => `supplier.bill:${billId}`
const creditNoteRef = (id: string) => `supplier.credit_note:${id}`

/** Repricing sources (StockMovement 'cost_adjust' rows, idempotent per lot). */
const MATCH_REPRICE = 'supplier.bill.match'
const MATCH_REPRICE_VOID = 'supplier.bill.match.void'
const CN_REPRICE = 'supplier.credit_note'
const CN_REPRICE_VOID = 'supplier.credit_note.void'

function assertBalanced(lines: JournalLineInput[], ref: string): void {
  const dr = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const cr = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  if (dr !== cr) throw new AppError('JOURNAL_UNBALANCED', `${ref}: debits (${dr}) ≠ credits (${cr})`, 500)
}

/** One journal line for a signed amount: positive = debit, negative = credit, zero = none. */
function signed(accountCode: string, cents: number, memo: string, conceptId: string | null = null): JournalLineInput[] {
  if (!cents) return []
  return [{ accountCode, type: cents > 0 ? 'debit' : 'credit', amountCents: Math.abs(cents), memo: memo.slice(0, 250), conceptId }]
}

/** Signed 12x0 lines per class (positive = debit). */
function classLines(byClass: Record<CostClass, number>, memo: (c: CostClass) => string): JournalLineInput[] {
  return COST_CLASSES.flatMap((c) => signed(CLASS_ACCOUNTS[c].inv, byClass[c] ?? 0, memo(c)))
}

/** Signed 5060 lines, each item's amount split by its brands' recipe use (H20; brand-less when none). Positive = debit. */
async function costAdjustLines(tx: Tx, tenantId: string, byItem: Map<string, number>, memo: string): Promise<JournalLineInput[]> {
  const out: JournalLineInput[] = []
  const now = new Date()
  for (const [itemId, cents] of byItem) {
    if (!cents) continue
    const shares = itemId ? await brandUsageShares(tx, tenantId, itemId, now) : []
    for (const p of splitCents(cents, shares)) out.push(...signed(ACCT.COST_ADJUSTMENT, p.cents, memo, p.conceptId))
  }
  return out
}

function addTo(map: Map<string, number>, key: string, cents: number): void {
  if (cents) map.set(key, (map.get(key) ?? 0) + cents)
}

/**
 * True when a document of the company dated `createdAt` is pre-FIFO: the
 * company has not been cut over yet, or the document was recorded before the
 * cut-over (its stock effects were counted by the cut-over itself).
 */
async function isLegacyDoc(db: Db, tenantId: string, createdAt: Date): Promise<boolean> {
  const at = await readFifoCutoverAt(db, tenantId)
  return !at || createdAt.getTime() < at.getTime()
}

/** Net debit (debit − credit) on `code` within one posted entry. */
async function entryNetDebit(tx: Tx, entryId: string, code: string): Promise<number> {
  const lines = await tx.journalLine.findMany({
    where:  { journalEntryId: entryId, account: { code } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}

// ─── Withholding (the ONE resolver: lib/withholding.ts) ──────────────────────

export interface SupplierTaxFields { filerStatus: string; whtExemptUntil: Date | null }

/**
 * Income-tax withholding (s.153 / s.155) on a supplier bill: delegates to
 * lib/withholding.ts computeWithholding (the company's rates by section ×
 * filer status, the supplier's exemption certificate on the bill date, the
 * company's withholding switch). Fixed ONCE when the bill is recorded
 * (createBill stores whtCents / whtSection / whtRateBps) and booked from those
 * stored figures, so AP and every "still due" are the same number.
 */
export async function withholdingForBill(db: Db, a: {
  tenantId: string; supplier: SupplierTaxFields; subtotalCents: number; section: WhtSection | null; at: Date
}): Promise<{ whtCents: number; rateBps: number; section: WhtSection | null }> {
  const section = whtSectionOrNull(a.section)
  if (!(a.subtotalCents > 0) || !section) return { whtCents: 0, rateBps: 0, section }
  const r = await computeWithholding(db, {
    tenantId: a.tenantId, supplier: a.supplier, section, baseCents: a.subtotalCents, at: a.at,
  })
  return { whtCents: r.whtCents, rateBps: r.rateBps, section: r.section }
}

function whtMemo(bill: { billNumber: string; whtSection: string | null; whtRateBps: number | null; whtCents: DbMoney; subtotalCents: DbMoney }): string {
  const section = whtSectionOrNull(bill.whtSection)
  const rate = bill.whtRateBps != null
    ? (bill.whtRateBps / 100).toFixed(2)
    : toCents(bill.subtotalCents) > 0 ? ((toCents(bill.whtCents) / toCents(bill.subtotalCents)) * 100).toFixed(2) : '0.00'
  return `WHT ${section ? `${WHT_SECTION_LABEL[section]} ` : ''}${rate}% on bill ${bill.billNumber}`
}

/** The input-tax code of a bill's authority (1320 FBR … 1324 BRA). */
function inputCodeOfAuthority(authority: string | null | undefined): string {
  return isAuthorityKey(authority) ? inputTaxCodeFor(authority) : ACCT.GST_INPUT
}

function authorityLabel(authority: string | null | undefined): string {
  return isAuthorityKey(authority) ? AUTHORITIES[authority].label : 'FBR'
}

// ─── Receipt lines, lots and matches ─────────────────────────────────────────

interface ReceiptLineRow {
  id: string
  receiptId: string
  inventoryItemId: string | null
  poLineId: string | null
  receivedQty: number
  billedQty: number
  lotUnitCostCents: number | null
  poUnitCostCents: number | null
  writtenOffAt: Date | null
  receipt: { tenantId: string | null; supplierId: string; receivedAt: Date }
}

const RL_SELECT = {
  id: true, receiptId: true, inventoryItemId: true, poLineId: true, receivedQty: true, billedQty: true,
  lotUnitCostCents: true, poUnitCostCents: true, writtenOffAt: true,
  receipt: { select: { tenantId: true, supplierId: true, receivedAt: true } },
} satisfies Prisma.GoodsReceiptLineSelect

/** The cost a receipt line's still-unbilled quantity was received at (per purchase unit). */
function receiptCostOf(rl: { lotUnitCostCents: number | null; poUnitCostCents: number | null }): number {
  return rl.lotUnitCostCents ?? rl.poUnitCostCents ?? 0
}

interface LotRef { id: string; qtyIn: number; costClass: CostClass; cutover: boolean }

/**
 * The lot a match on receipt line `rl` prices: the lot the match's own
 * pending quantity opened ('<rlId>:<matchId>'), else the line's PO / dock lot,
 * else any lot of the line; a pre-FIFO receipt line has none — its stock is in
 * the item's cut-over lot. Null when there is no lot at all.
 */
async function lotForMatch(tx: Tx, tenantId: string, rl: { id: string; inventoryItemId: string | null }, matchId: string | null): Promise<LotRef | null> {
  const sel = { id: true, qtyIn: true, costClass: true, sourceType: true } satisfies Prisma.StockLotSelect
  const pick = (l: { id: string; qtyIn: number; costClass: string; sourceType: string } | null): LotRef | null =>
    l ? { id: l.id, qtyIn: l.qtyIn, costClass: asClass(l.costClass), cutover: l.sourceType === 'fifo_cutover' } : null
  if (matchId) {
    const own = await tx.stockLot.findFirst({ where: { tenantId, sourceType: 'goods_receipt_line', sourceId: `${rl.id}:${matchId}` }, select: sel })
    if (own) return pick(own)
  }
  const rest = await tx.stockLot.findFirst({
    where: { tenantId, sourceType: 'goods_receipt_line', sourceId: { in: [`${rl.id}:po`, `${rl.id}:dock`] } }, select: sel,
  })
  if (rest) return pick(rest)
  const any = await tx.stockLot.findFirst({ where: { tenantId, receiptLineId: rl.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: sel })
  if (any) return pick(any)
  if (!rl.inventoryItemId) return null
  return pick(await tx.stockLot.findFirst({ where: { tenantId, inventoryItemId: rl.inventoryItemId, sourceType: 'fifo_cutover' }, select: sel }))
}

/** The part of a price difference `diff` on `qty` that re-prices `lot` (a lot can absorb at most its own quantity), and the quantity basis. */
function lotShareOf(diff: number, qty: number, lot: LotRef): { share: number; basis: number } {
  const basis = Math.min(qty, lot.qtyIn)
  if (!(basis > EPS)) return { share: 0, basis: 0 }
  const share = qty <= lot.qtyIn + EPS ? diff : Math.round((diff * lot.qtyIn) / qty)
  return { share, basis }
}

/**
 * What the receipt line brought in, valued as the receipt booked it: Σ its
 * lots' receipt movements, else (a pre-FIFO line, opened at the cut-over) its
 * quantity not billed by legacy bills × its cost.
 */
async function receiptLineValueTx(tx: Tx, rl: ReceiptLineRow): Promise<number> {
  const lots = await tx.stockLot.findMany({ where: { receiptLineId: rl.id }, select: { id: true } })
  if (lots.length > 0) {
    const agg = await tx.stockMovement.aggregate({ where: { lotId: { in: lots.map((l) => l.id) }, kind: 'receipt' }, _sum: { valueCents: true } })
    return sumCents(agg._sum.valueCents)
  }
  const live = await tx.grniMatch.aggregate({ where: { receiptLineId: rl.id, status: 'live' }, _sum: { qty: true } })
  const legacyBilled = Math.max(0, rl.billedQty - (live._sum.qty ?? 0))
  return Math.round(Math.max(0, rl.receivedQty - legacyBilled) * receiptCostOf(rl))
}

/** A purchase price row when a bill re-prices an item's stock (ItemPriceHistory holds purchase prices only). */
async function recordBillPriceTx(tx: Tx, a: { itemId: string; supplierId: string; poLineId: string | null; unitCostCents: number }): Promise<void> {
  const prev = await tx.itemPriceHistory.findFirst({
    where: { inventoryItemId: a.itemId, source: { in: [...PURCHASE_PRICE_SOURCES] } },
    orderBy: { recordedAt: 'desc' },
    select: { newCostCents: true },
  })
  if (prev && prev.newCostCents === a.unitCostCents) return
  await tx.itemPriceHistory.create({
    data: {
      inventoryItemId: a.itemId, supplierId: a.supplierId, oldCostCents: prev?.newCostCents ?? null,
      newCostCents: a.unitCostCents, source: 'bill_match', poLineId: a.poLineId,
    },
  })
}

/** Lock the bill's purchase orders and receipt lines (bill → POs → receipt lines → items; receiving locks PO → items). */
async function lockBillDocsTx(tx: Tx, poLineIds: string[], receiptLineIds: string[]): Promise<void> {
  const pl = [...new Set(poLineIds.filter(Boolean))]
  const rl = [...new Set(receiptLineIds.filter(Boolean))]
  if (pl.length > 0 || rl.length > 0) {
    await tx.$queryRaw`
      SELECT id FROM purchase_orders WHERE id IN (
        SELECT "purchaseOrderId" FROM purchase_order_lines WHERE id = ANY(${pl}::text[])
          OR id IN (SELECT "poLineId" FROM goods_receipt_lines WHERE id = ANY(${rl}::text[]) AND "poLineId" IS NOT NULL)
      ) ORDER BY id FOR UPDATE`
    await tx.$queryRaw`
      SELECT id FROM goods_receipt_lines WHERE id = ANY(${rl}::text[]) OR "poLineId" = ANY(${pl}::text[]) ORDER BY id FOR UPDATE`
  }
}

// ─── Supplier bill ───────────────────────────────────────────────────────────

type BillForPosting = Prisma.SupplierBillGetPayload<{
  include: { supplier: true; lines: { include: { poLine: { select: { inventoryItemId: true } } } } }
}>

/**
 * Post a supplier bill to its supplier's company's ledger (header). In
 * `opts.tx` when given — createBill passes its own, so the bill, its GRNI
 * matches, its lot re-pricing and its entry commit or fail together (a
 * closed month is PERIOD_LOCKED 422; quantity billed beyond what was received
 * and ordered is 422 OVER_BILLED). Idempotent: a bill already on the books is
 * a no-op (its matches were written with it).
 */
export async function postSupplierBill(billId: string, opts: { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    // One posting of a bill at a time.
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const bill = await tx.supplierBill.findUnique({
      where: { id: billId },
      include: { supplier: true, lines: { include: { poLine: { select: { inventoryItemId: true } } } } },
    })
    if (!bill) return { posted: false, entryId: null, reason: 'bill_not_found' }
    if (bill.status === 'void') return { posted: false, entryId: null, reason: 'bill_voided' }
    // A credit note is a SupplierBill row too, but it books the other way.
    if (bill.kind !== 'bill') return { posted: false, entryId: null, reason: 'not_a_bill' }
    const tenantId = bill.supplier.tenantId
    if (!tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }
    if (toCents(bill.subtotalCents) === 0 && toCents(bill.taxCents) === 0) return { posted: false, entryId: null, reason: 'zero_amount' }
    const existing = await tx.journalEntry.findFirst({ where: { reference: billRef(bill.id), tenantId }, select: { id: true } })
    if (existing) return { posted: false, entryId: existing.id, reason: 'already_posted' }

    if (await isLegacyDoc(tx, tenantId, bill.createdAt)) return postLegacyBillTx(tx, bill, tenantId)
    return postFifoBillTx(tx, bill, tenantId)
  })
}

/** The tax, WHT and AP lines every bill entry ends with. */
function billTail(bill: BillForPosting): JournalLineInput[] {
  const taxCents = toCents(bill.taxCents)
  const whtCents = toCents(bill.whtCents)
  const lines: JournalLineInput[] = []
  if (taxCents > 0) {
    lines.push({
      accountCode: inputCodeOfAuthority(bill.taxAuthority), type: 'debit', amountCents: taxCents,
      memo: `Input tax (${authorityLabel(bill.taxAuthority)}) on bill ${bill.billNumber}`,
    })
  }
  // Withholding (s.153 / s.155): the supplier is paid net of it; servd owes it
  // to FBR. The bill's own stored figure, so this entry and "still due" agree.
  if (whtCents > 0) lines.push({ accountCode: ACCT.WHT_PAYABLE, type: 'credit', amountCents: whtCents, memo: whtMemo(bill) })
  lines.push({
    accountCode: ACCT.AP_SUPPLIERS, type: 'credit', amountCents: toCents(bill.totalCents) - whtCents,
    memo: `${bill.supplier.name} bill ${bill.billNumber}${whtCents > 0 ? ' (net of WHT)' : ''}`,
  })
  return lines
}

/**
 * A bill recorded before the company's FIFO cut-over (or a company not cut
 * over yet): the old shape — its whole subtotal to 1210 (stock was one pool
 * then, and the cut-over counted its quantities as billed).
 */
async function postLegacyBillTx(tx: Tx, bill: BillForPosting, tenantId: string): Promise<PostResult> {
  const lines: JournalLineInput[] = [
    ...signed(ACCT.INVENTORY_FOOD, toCents(bill.subtotalCents), `Bill ${bill.billNumber} (recorded before the FIFO cut-over)`),
    ...billTail(bill),
  ]
  assertBalanced(lines, billRef(bill.id))
  const r = await postJournalEntry({
    tenantId, sourceType: 'supplier.bill', sourceId: bill.id,
    description: `Supplier bill ${bill.billNumber} from ${bill.supplier.name}`,
    entryDate: bill.billDate, postedBy: 'system', lines,
  }, { tx })
  return { posted: r.posted, entryId: r.entryId }
}

async function postFifoBillTx(tx: Tx, bill: BillForPosting, tenantId: string): Promise<PostResult> {
  const stockLines = bill.lines.filter((l) => !!(l.inventoryItemId ?? l.poLine?.inventoryItemId))
  await lockBillDocsTx(
    tx,
    stockLines.filter((l) => !l.receiptLineId).map((l) => l.poLineId ?? ''),
    stockLines.map((l) => l.receiptLineId ?? ''),
  )

  let grniCents = 0
  const absorbedByClass = zeroByClass()
  const usedByItem = new Map<string, number>()
  const expenseByCode = new Map<string, number>()
  const billedRl = new Map<string, number>()   // receipt line → quantity this bill matched so far

  for (const line of bill.lines) {
    const lineCents = toCents(line.lineTotalCents)
    const itemId = line.inventoryItemId ?? line.poLine?.inventoryItemId ?? null
    if (!itemId) {
      if (!line.expenseAccountCode) {
        throw new AppError('EXPENSE_ACCOUNT_REQUIRED', `"${line.description}" is not a stock item — pick the expense account it is booked to`, 422)
      }
      addTo(expenseByCode, line.expenseAccountCode, lineCents)
      continue
    }
    if (!line.poLineId && !line.receiptLineId) {
      throw new AppError('STOCK_LINE_NEEDS_RECEIPT', `"${line.description}" is a stock item — receive it at the dock first, then bill it against the receipt or its PO line`, 422)
    }
    if (!(line.quantity > 0)) continue

    // Unbilled receipt lines this line matches: its own, else every receipt of
    // its PO line, oldest first.
    const rls: ReceiptLineRow[] = line.receiptLineId
      ? await tx.goodsReceiptLine.findMany({ where: { id: line.receiptLineId }, select: RL_SELECT })
      : await tx.goodsReceiptLine.findMany({
          where: { poLineId: line.poLineId! },
          orderBy: [{ receipt: { receivedAt: 'asc' } }, { id: 'asc' }],
          select: RL_SELECT,
        })
    let qtyLeft = line.quantity
    let centsLeft = lineCents
    for (const rl of rls) {
      if (qtyLeft < EPS) break
      const rlCompany = rl.receipt.tenantId ?? tenantId
      if (rlCompany !== tenantId || rl.receipt.supplierId !== bill.supplierId || (rl.inventoryItemId && rl.inventoryItemId !== itemId)) {
        throw new AppError('RECEIPT_LINE_MISMATCH', `"${line.description}" does not match that receipt — it must be ${bill.supplier.name}'s delivery of the same item`, 422)
      }
      if (rl.writtenOffAt) continue
      const billedBefore = rl.billedQty + (billedRl.get(rl.id) ?? 0)
      const open = rl.receivedQty - billedBefore
      if (open < EPS) continue
      const take = Math.min(open, qtyLeft)
      const last = take >= qtyLeft - EPS
      const billed = last ? centsLeft : Math.round((lineCents * take) / line.quantity)
      const cost = receiptCostOf(rl)
      // The match that bills the line's last unbilled quantity clears exactly
      // what the receipt booked (no rounding residue left in 2015).
      let grni: number
      if (billedBefore + take >= rl.receivedQty - EPS) {
        const others = await tx.grniMatch.aggregate({ where: { receiptLineId: rl.id, status: 'live' }, _sum: { grniCents: true } })
        grni = Math.max(0, (await receiptLineValueTx(tx, { ...rl, billedQty: billedBefore })) - sumCents(others._sum.grniCents))
      } else {
        grni = Math.round(take * cost)
      }
      const billedUnit = Math.round(billed / take)
      assertInt4Fits(billedUnit, `"${line.description}"'s billed unit cost`)
      const diff = billed - grni
      const match = await tx.grniMatch.create({
        data: {
          tenantId, billId: bill.id, billLineId: line.id, receiptLineId: rl.id, poLineId: rl.poLineId ?? line.poLineId,
          qty: take, receiptUnitCostCents: cost, billedUnitCostCents: billedUnit, grniCents: grni, priceDiffCents: diff, status: 'live',
        },
        select: { id: true },
      })
      await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { billedQty: { increment: take } } })
      billedRl.set(rl.id, (billedRl.get(rl.id) ?? 0) + take)
      grniCents += grni

      if (diff !== 0) {
        const lot = await lotForMatch(tx, tenantId, { id: rl.id, inventoryItemId: itemId }, null)
        let absorbed = 0
        let used = diff
        let cls = costClassOf(null)
        if (lot) {
          cls = lot.costClass
          const { share, basis } = lotShareOf(diff, take, lot)
          if (share !== 0) {
            const r = await repriceLotTx(tx, { lotId: lot.id, deltaCents: share, qtyBasis: basis, sourceType: MATCH_REPRICE, sourceId: match.id })
            absorbed = r.onHandCents
            used = diff - r.onHandCents
          }
        }
        absorbedByClass[cls] += absorbed
        addTo(usedByItem, itemId, used)
        await tx.grniMatch.update({ where: { id: match.id }, data: { absorbedCents: absorbed, usedCents: used } })
        await recordBillPriceTx(tx, { itemId, supplierId: bill.supplierId, poLineId: rl.poLineId ?? line.poLineId, unitCostCents: billedUnit })
      }
      qtyLeft -= take
      centsLeft -= billed
    }

    if (qtyLeft > EPS) {
      // Billed before it arrived: a PO line's ordered quantity not yet
      // received (and not already billed ahead by another bill).
      if (!line.poLineId) {
        throw new AppError('OVER_BILLED', `"${line.description}": only ${fmtQty(line.quantity - qtyLeft)} of that receipt is left to bill`, 422)
      }
      const pl = await tx.purchaseOrderLine.findUnique({ where: { id: line.poLineId }, select: { quantityOrdered: true, quantityReceived: true } })
      const pending = await tx.grniMatch.aggregate({ where: { poLineId: line.poLineId, status: 'pending', tenantId }, _sum: { qty: true } })
      const room = (pl ? pl.quantityOrdered - pl.quantityReceived : 0) - (pending._sum.qty ?? 0)
      if (qtyLeft > room + EPS) {
        throw new AppError(
          'OVER_BILLED',
          `"${line.description}": ${fmtQty(qtyLeft)} billed but only ${fmtQty(Math.max(0, room))} is still to arrive on its purchase order — receive it first, or bill what was ordered`,
          422,
        )
      }
      const billedUnit = Math.round(centsLeft / qtyLeft)
      assertInt4Fits(billedUnit, `"${line.description}"'s billed unit cost`)
      await tx.grniMatch.create({
        data: {
          tenantId, billId: bill.id, billLineId: line.id, receiptLineId: null, poLineId: line.poLineId,
          qty: qtyLeft, receiptUnitCostCents: null, billedUnitCostCents: billedUnit, grniCents: centsLeft, status: 'pending',
        },
      })
      grniCents += centsLeft
    }
  }

  const ref = `bill ${bill.billNumber}`
  const lines: JournalLineInput[] = [
    ...signed(ACCT.GRNI, grniCents, `Goods received, now billed — ${bill.supplier.name} ${ref}`),
    ...classLines(absorbedByClass, (c) => `Price difference on ${ref} — ${CLASS_LABEL[c]} still on hand`),
    ...(await costAdjustLines(tx, tenantId, usedByItem, `Price difference on ${ref} for stock already used`)),
    ...[...expenseByCode].flatMap(([code, cents]) => signed(code, cents, `${bill.supplier.name} ${ref}`)),
    ...billTail(bill),
  ]
  assertBalanced(lines, billRef(bill.id))
  const r = await postJournalEntry({
    tenantId, sourceType: 'supplier.bill', sourceId: bill.id,
    description: `Supplier bill ${bill.billNumber} from ${bill.supplier.name}`,
    entryDate: bill.billDate, postedBy: 'system', lines,
  }, { tx })
  return { posted: r.posted, entryId: r.entryId }
}

// ─── Bill void ───────────────────────────────────────────────────────────────

/**
 * Reverse a voided bill's entry (dated today) and undo what it did to GRNI
 * and the lots — in `opts.tx`, so voidBill and its reversal commit together
 * (header). A bill that never reached the ledger has nothing to reverse.
 * Errors propagate: a void the ledger can't follow (today is in a closed
 * period) is refused.
 */
export async function postSupplierBillVoid(
  billId: string,
  reason: string,
  opts: { tx?: Tx; postedBy?: string } = {},
): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const bill = await tx.supplierBill.findUnique({
      where:   { id: billId },
      include: { supplier: { select: { tenantId: true, name: true } }, lines: { include: { poLine: { select: { inventoryItemId: true } } } } },
    })
    const tenantId = bill?.supplier.tenantId
    if (!bill || !tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }
    const original = await tx.journalEntry.findFirst({ where: { reference: billRef(billId), tenantId }, select: { id: true } })
    if (!original) return { posted: false, entryId: null, reason: 'bill_not_posted' }
    const already = await tx.journalEntry.findFirst({ where: { reference: `supplier.bill.void:${billId}`, tenantId }, select: { id: true } })
    if (already) return { posted: false, entryId: already.id, reason: 'already_reversed' }

    // Lock the bill's POs and receipt lines (as posting and receiving do)
    // BEFORE reading its matches: a receipt settling one of its pending
    // matches either commits first (and is read as live here) or waits. A
    // legacy bill the cut-over tied through its PO locks those lines too.
    const preMatches = await tx.grniMatch.findMany({ where: { billId, status: { not: 'void' } }, select: { receiptLineId: true } })
    const { readCutoverTies } = await import('../inventory/fifoCutover.js')
    const ties = (await readCutoverTies(tx, tenantId))[billId] ?? []
    await lockBillDocsTx(
      tx,
      bill.lines.map((l) => l.poLineId ?? ''),
      [...bill.lines.map((l) => l.receiptLineId ?? ''), ...preMatches.map((m) => m.receiptLineId ?? ''), ...ties.map((t) => t.receiptLineId)],
    )
    const matches = await tx.grniMatch.findMany({
      where: { billId, status: { not: 'void' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    // A void re-opens GRNI on the receipt lines the bill matched. One since
    // written off (the CEO's "never to be billed") would be re-opened with no
    // document able to clear it — no list, no bill, no second write-off — so
    // the void is refused: correct the bill with a credit note instead.
    const reopened = [...new Set(matches.filter((m) => m.status === 'live' && m.receiptLineId).map((m) => m.receiptLineId!))]
    if (reopened.length > 0) {
      const off = await tx.goodsReceiptLine.findFirst({ where: { id: { in: reopened }, writtenOffAt: { not: null } }, select: { id: true } })
      if (off) throw receiptWrittenOff()
    }

    const postedBy = opts.postedBy ?? 'system'
    const result = await reverseJournalEntry(tenantId, 'supplier.bill', billId, reason, { tx, suffix: 'void', postedBy })

    const cutoverAt = await readFifoCutoverAt(tx, tenantId)
    if (!cutoverAt) {
      // The company is not on FIFO lots yet: the reversal is all (its cut-over
      // will count what is received and billed then).
      for (const m of matches) await tx.grniMatch.update({ where: { id: m.id }, data: { status: 'void' } })
      return { posted: result.posted, entryId: result.entryId }
    }
    if (bill.createdAt.getTime() < cutoverAt.getTime()) {
      await voidLegacyBillTx(tx, { bill, tenantId, originalEntryId: original.id, matches, postedBy, ties })
      return { posted: result.posted, entryId: result.entryId }
    }

    // A FIFO bill: the reversal re-opened GRNI (Cr 2015) and took back the
    // 12x0 / 5060 split as posted. Each live match's lot re-pricing is undone
    // now; what the lots move by now differs from what was absorbed then by
    // the stock used in between → 12x0 against 5060.
    const trueByClass = zeroByClass()
    const adjByItem = new Map<string, number>()
    for (const m of matches) {
      if (m.status === 'live' && m.receiptLineId) {
        const rl = await tx.goodsReceiptLine.findUnique({ where: { id: m.receiptLineId }, select: { id: true, inventoryItemId: true, billedQty: true } })
        if (rl) await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { billedQty: Math.max(0, rl.billedQty - m.qty) } })
        const diff = toCents(m.priceDiffCents)
        if (rl && diff !== 0) {
          const lot = await lotForMatch(tx, tenantId, rl, null)
          const absorbed = toCents(m.absorbedCents)
          let now = 0
          if (lot) {
            const { share, basis } = lotShareOf(diff, m.qty, lot)
            if (share !== 0) now = (await repriceLotTx(tx, { lotId: lot.id, deltaCents: -share, qtyBasis: basis, sourceType: MATCH_REPRICE_VOID, sourceId: m.id })).onHandCents
          }
          const x = now + absorbed
          trueByClass[lot?.costClass ?? 'food'] += x
          addTo(adjByItem, rl.inventoryItemId ?? '', -x)
        }
      }
      await tx.grniMatch.update({ where: { id: m.id }, data: { status: 'void' } })
    }
    const lines: JournalLineInput[] = [
      ...classLines(trueByClass, (c) => `Bill ${bill.billNumber} voided — ${CLASS_LABEL[c]} price difference undone on stock still on hand`),
      ...(await costAdjustLines(tx, tenantId, adjByItem, `Bill ${bill.billNumber} voided — price difference on stock used since it was billed`)),
    ]
    if (lines.length > 0) {
      assertBalanced(lines, `supplier.bill.void.price:${billId}`)
      await postJournalEntry({
        tenantId, sourceType: 'supplier.bill.void.price', sourceId: billId,
        description: `Lot cost restored after voiding bill ${bill.billNumber}`, postedBy, lines,
      }, { tx })
    }
    return { posted: result.posted, entryId: result.entryId }
  })
}

/** 409: the void would re-open a delivery line the CEO wrote off. */
function receiptWrittenOff(): AppError {
  return new AppError(
    'RECEIPT_WRITTEN_OFF',
    'A delivery this bill was matched to has since been written off as never to be billed — correct the bill with a credit note instead of voiding it',
    409,
  )
}

/**
 * Void of a bill recorded before the FIFO cut-over (header). Its 1210 debit D
 * splits into the part TIED to receipt lines — lines naming a PO line, and a
 * description-only bill the cut-over tied through its PO (fifoCutover.ts
 * 'foodcost.cutoverTies') — and the untied rest:
 *   - tied: 1210 keeps it (the reversal took it out, the lots never had it
 *     removed), GRNI re-opens for the received quantity it had matched (R, at
 *     the receipt cost — billedQty falls back: its matches, its PO lines
 *     newest receipt first, its cut-over ties) and for its cut-over
 *     billed-ahead quantity still pending (P, undoing the cut-over's Dr 2015);
 *     5060 takes D_tied − R − P;
 *   - untied (a duplicate or mis-keyed description-only bill naming no PO):
 *     the lots never held that value, so it never lands in 5060 — the
 *     reversal's Cr 1210 stands while the company has not aligned its
 *     inventory (the alignment's fresh lots-vs-GL difference absorbs it);
 *     after 'inventory.fifo_align' it goes back where the alignment put the
 *     difference: Dr 1210 / Cr 3020.
 * Pending matches the cut-over opened for it are voided; one a receipt has
 * since settled re-opens that receipt's GRNI at its lot value. A receipt line
 * written off since is never re-opened: 409 RECEIPT_WRITTEN_OFF.
 */
async function voidLegacyBillTx(tx: Tx, a: {
  bill: Prisma.SupplierBillGetPayload<{ include: { supplier: { select: { tenantId: true; name: true } }; lines: { include: { poLine: { select: { inventoryItemId: true } } } } } }>
  tenantId: string; originalEntryId: string; postedBy: string
  matches: Array<{ id: string; billLineId: string; receiptLineId: string | null; qty: number; grniCents: DbMoney; status: string }>
  ties: Array<{ receiptLineId: string; qty: number }>
}): Promise<void> {
  const { bill, tenantId } = a
  const D = await entryNetDebit(tx, a.originalEntryId, ACCT.INVENTORY_FOOD)
  let R = 0
  let P = 0
  for (const m of a.matches) {
    if (m.status === 'pending') P += toCents(m.grniCents)
    else if (m.receiptLineId) {
      R += toCents(m.grniCents)
      const rl = await tx.goodsReceiptLine.findUnique({ where: { id: m.receiptLineId }, select: { billedQty: true, writtenOffAt: true } })
      if (rl?.writtenOffAt) throw receiptWrittenOff()
      if (rl) await tx.goodsReceiptLine.update({ where: { id: m.receiptLineId }, data: { billedQty: Math.max(0, rl.billedQty - m.qty) } })
    }
    await tx.grniMatch.update({ where: { id: m.id }, data: { status: 'void' } })
  }
  // Received quantity the bill matched under the old rules (the cut-over set
  // billedQty for it): newest receipt first, at most what is billed there by
  // no live match.
  for (const line of bill.lines) {
    if (!line.poLineId || !(line.quantity > 0)) continue
    const viaMatches = a.matches.filter((m) => m.billLineId === line.id).reduce((s, m) => s + m.qty, 0)
    let left = line.quantity - viaMatches
    if (left < EPS) continue
    const rls = await tx.goodsReceiptLine.findMany({
      where: { poLineId: line.poLineId },
      orderBy: [{ receipt: { receivedAt: 'desc' } }, { id: 'desc' }],
      select: { id: true, billedQty: true, lotUnitCostCents: true, poUnitCostCents: true, writtenOffAt: true },
    })
    for (const rl of rls) {
      if (left < EPS) break
      const live = await tx.grniMatch.aggregate({ where: { receiptLineId: rl.id, status: 'live' }, _sum: { qty: true } })
      const legacyBilled = rl.billedQty - (live._sum.qty ?? 0)
      if (legacyBilled < EPS) continue
      if (rl.writtenOffAt) throw receiptWrittenOff()
      const dec = Math.min(legacyBilled, left)
      await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { billedQty: Math.max(0, rl.billedQty - dec) } })
      R += Math.round(dec * receiptCostOf(rl))
      left -= dec
    }
  }
  // The receipt lines the cut-over tied a description-only bill to (its PO).
  for (const t of a.ties) {
    const rl = await tx.goodsReceiptLine.findUnique({
      where: { id: t.receiptLineId }, select: { id: true, billedQty: true, lotUnitCostCents: true, poUnitCostCents: true, writtenOffAt: true },
    })
    if (!rl) continue
    const live = await tx.grniMatch.aggregate({ where: { receiptLineId: rl.id, status: 'live' }, _sum: { qty: true } })
    const legacyBilled = rl.billedQty - (live._sum.qty ?? 0)
    const dec = Math.min(Math.max(0, legacyBilled), t.qty)
    if (dec < EPS) continue
    if (rl.writtenOffAt) throw receiptWrittenOff()
    await tx.goodsReceiptLine.update({ where: { id: rl.id }, data: { billedQty: Math.max(0, rl.billedQty - dec) } })
    R += Math.round(dec * receiptCostOf(rl))
  }
  // D split by line value: what is tied to receipts vs what is not.
  const valueOf = (l: { lineTotalCents: DbMoney }) => Math.max(0, toCents(l.lineTotalCents))
  const total = bill.lines.reduce((t, l) => t + valueOf(l), 0)
  const tiedValue = bill.lines.filter((l) => !!l.poLineId || a.ties.length > 0).reduce((t, l) => t + valueOf(l), 0)
  const Dtied = total > 0 ? Math.round((D * tiedValue) / total) : D
  const Duntied = D - Dtied
  const aligned = Duntied !== 0
    && !!(await tx.journalEntry.findFirst({ where: { tenantId, reference: `inventory.fifo_align:${tenantId}` }, select: { id: true } }))
  const lines: JournalLineInput[] = [
    ...signed(ACCT.INVENTORY_FOOD, Dtied, `Bill ${bill.billNumber} voided — the stock it billed stays in the lots`),
    ...signed(ACCT.GRNI, -(R + P), `Bill ${bill.billNumber} voided — goods received not invoiced re-opened`),
    ...signed(ACCT.COST_ADJUSTMENT, R + P - Dtied, `Bill ${bill.billNumber} voided — its price over the receipt cost`),
    ...(aligned ? [
      ...signed(ACCT.INVENTORY_FOOD, Duntied, `Bill ${bill.billNumber} voided — a bill no delivery backs; inventory was aligned with the lots`),
      ...signed(ACCT.RETAINED_EARNINGS, -Duntied, `Bill ${bill.billNumber} voided — back to the FIFO alignment's prior-period difference`),
    ] : []),
  ]
  if (lines.length === 0) return
  assertBalanced(lines, `supplier.bill.void.legacy:${bill.id}`)
  await postJournalEntry({
    tenantId, sourceType: 'supplier.bill.void.legacy', sourceId: bill.id,
    description: `Bill ${bill.billNumber} (recorded before the FIFO cut-over) voided — GRNI re-opened, 1210 kept with the lots`,
    postedBy: a.postedBy, lines,
  }, { tx })
}

// ─── Supplier payments ───────────────────────────────────────────────────────

/**
 * Post a supplier payment (Dr AP 2010 / Cr the cash or bank account the money
 * left) to its supplier's company — in `opts.tx` when given (procurement
 * createPaymentTx passes its own: a payment dated in a closed month is
 * PERIOD_LOCKED 422, not saved). The credit is lib/bankAccounts.ts
 * moneyAccountCode (cash → 1010; bank / cheque / wallet → the named bank's
 * chart code of the supplier's company).
 */
export async function postSupplierPayment(paymentId: string, opts: { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const payment = await tx.supplierPayment.findUnique({
      where: { id: paymentId },
      include: { supplier: true },
    })
    if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }
    if (payment.voidedAt) return { posted: false, entryId: null, reason: 'payment_voided' }

    const paymentTenantId = payment.supplier.tenantId
    if (!paymentTenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }

    const { code: cashAccount } = await moneyAccountCode(tx, paymentTenantId, {
      method: payment.method, bankAccountId: payment.bankAccountId,
    })

    const amount = toCents(payment.amountCents)
    const lines: JournalLineInput[] = [
      { accountCode: ACCT.AP_SUPPLIERS, type: 'debit',  amountCents: amount, memo: `Payment to ${payment.supplier.name}` },
      { accountCode: cashAccount,       type: 'credit', amountCents: amount, memo: `${payment.method} via ${payment.reference ?? 'no ref'}` },
    ]

    const result = await postJournalEntry({
      tenantId: paymentTenantId,
      sourceType: 'supplier.payment',
      sourceId: payment.id,
      description: `Supplier payment to ${payment.supplier.name} (${payment.method})`,
      entryDate: payment.paymentDate,
      postedBy: 'system',
      lines,
    }, { tx })
    return { posted: result.posted, entryId: result.entryId }
  })
}

/**
 * Reverse a voided supplier payment's entry (dated today), in `opts.tx`.
 * Idempotent: 'supplier.payment.void:<id>' posts at most once.
 */
export async function postSupplierPaymentVoid(
  paymentId: string,
  reason: string,
  opts: { tx?: Tx; postedBy?: string } = {},
): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const payment = await tx.supplierPayment.findUnique({
      where:  { id: paymentId },
      select: { id: true, supplier: { select: { tenantId: true } } },
    })
    const tenantId = payment?.supplier.tenantId
    if (!payment || !tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }
    const original = await tx.journalEntry.findFirst({ where: { reference: `supplier.payment:${paymentId}`, tenantId }, select: { id: true } })
    if (!original) return { posted: false, entryId: null, reason: 'payment_not_posted' }
    const already = await tx.journalEntry.findFirst({ where: { reference: `supplier.payment.void:${paymentId}`, tenantId }, select: { id: true } })
    if (already) return { posted: false, entryId: already.id, reason: 'already_reversed' }
    const result = await reverseJournalEntry(tenantId, 'supplier.payment', paymentId, reason, {
      tx, suffix: 'void', postedBy: opts.postedBy ?? 'system',
    })
    return { posted: result.posted, entryId: result.entryId }
  })
}

// ─── Supplier credit notes / returns (finance gaps 14a, on lots) ─────────────
//
// A credit note is a SupplierBill of kind 'credit_note' against its original
// bill (procurement/creditNotes.ts). It books in its own month (billDate), in
// the supplier's company, 'supplier.credit_note:<id>':
//
//   Dr 2010 AP          CN total − WHT share
//   Dr 2040 WHT         the bill's withholding reduced pro rata
//   Cr 12x0             goods sent back: the FIFO value taken out of the lots
//                       (stockLedger.consumeFifoTx 'supplier_return', the
//                       bill's own lots first, then FIFO); a price credit on
//                       goods kept: the share of the bill's lots still on hand
//                       (repriceLotTx, negative)
//   Cr / Dr 5060        the rest of each stock line's credit (stock already
//                       used, or a return credited above / below lot value)
//   Cr 2015             a short delivery (or a price credit) on quantity the
//                       bill billed AHEAD of receipt: the pending match shrinks
//   Cr 6xxx             a line that is not stock, to the bill line's own code
//                       (5060 on an item-less line of a bill from before the
//                       FIFO cut-over — 1210 moves only with the lots)
//   Cr 132x             the CN's tax, on the input code the original bill's
//                       entry debited (inputTaxCodeOfBill)
//
// What it did to the lots and matches is written down (an 'accounting' audit
// row 'supplier.credit_note.stock', version 2), so a void undoes exactly that.

export type CreditNoteReason = 'return' | 'price' | 'short' | 'damaged' | 'rebate'

const CN_STOCK_ACTION = 'supplier.credit_note.stock'

interface CnRecordV2 {
  version: 2
  reason: CreditNoteReason
  originalBillId: string
  reprices: Array<{ lotId: string; itemId: string; deltaCents: number; qtyBasis: number; onHandCents: number; costClass: CostClass }>
  pending: Array<{ matchId: string; qty: number; grniCents: number }>
  returnedItems: string[]
}

/** The legacy (pre-FIFO) record shape — read by the void of an old credit note. */
type CreditNoteStockLineV1 = {
  lineId: string; inventoryItemId: string | null; returnQty: number; inventoryCents: number
  adjustmentCents: number; movedCents: number; stockBacked: boolean
}

/**
 * The input-tax code a bill's own entry debited — the authority's 1320–1324
 * (G7 done: input tax by authority, H8). A credit note reverses on that code.
 */
async function inputTaxCodeOfBill(tx: Tx, tenantId: string, billId: string): Promise<string> {
  const lines = await tx.journalLine.findMany({
    where:  { type: 'debit', journalEntry: { tenantId, reference: billRef(billId) }, account: { code: { startsWith: '132' } } },
    select: { amountCents: true, account: { select: { code: true } } },
  })
  let best: { code: string; cents: number } | null = null
  for (const l of lines) {
    const cents = toCents(l.amountCents)
    if (!best || cents > best.cents) best = { code: l.account.code, cents }
  }
  if (best) return best.code
  const bill = await tx.supplierBill.findUnique({ where: { id: billId }, select: { taxAuthority: true } })
  return inputCodeOfAuthority(bill?.taxAuthority)
}

/**
 * The bill's lots for an item, with the quantity each of the bill's live
 * matches billed on it (a supplier return takes them first; a price credit
 * re-prices them).
 */
export async function billLotsForItem(db: Tx, tenantId: string, billId: string, itemId: string): Promise<Array<{ lot: LotRef; qty: number; remainingQty: number }>> {
  const matches = await db.grniMatch.findMany({
    where: { billId, status: 'live', receiptLineId: { not: null }, receiptLine: { inventoryItemId: itemId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, qty: true, receiptLineId: true, settledAt: true },
  })
  const out = new Map<string, { lot: LotRef; qty: number; remainingQty: number }>()
  for (const m of matches) {
    const lot = await lotForMatch(db, tenantId, { id: m.receiptLineId!, inventoryItemId: itemId }, m.settledAt ? m.id : null)
    if (!lot || lot.cutover) continue
    const row = out.get(lot.id) ?? { lot, qty: 0, remainingQty: 0 }
    row.qty += m.qty
    out.set(lot.id, row)
  }
  if (out.size > 0) {
    const lots = await db.stockLot.findMany({ where: { id: { in: [...out.keys()] } }, select: { id: true, remainingQty: true } })
    for (const l of lots) out.get(l.id)!.remainingQty = l.remainingQty
  }
  return [...out.values()]
}

/** Split `cents` over `weights` (≥ 0) — rounded parts that sum exactly. */
function prorate(cents: number, weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + w, 0)
  if (!(total > 0)) return weights.map((_, i) => (i === 0 ? cents : 0))
  let left = cents
  return weights.map((w, i) => {
    if (i === weights.length - 1) return left
    const part = Math.round((cents * w) / total)
    left -= part
    return part
  })
}

/**
 * Post a supplier credit note (header above) in `opts.tx` (procurement
 * createCreditNote passes its own: a credit note dated in a closed month is
 * PERIOD_LOCKED 422 and nothing is saved, stock included). Idempotent on
 * 'supplier.credit_note:<id>'. `reason` decides how a stock line without a
 * return is treated ('short' = goods billed but never arrived).
 */
export async function postSupplierCreditNote(
  creditNoteId: string,
  opts: { tx?: Tx; postedBy?: string; reason?: CreditNoteReason } = {},
): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${creditNoteId} FOR UPDATE`
    const cn = await tx.supplierBill.findUnique({
      where:   { id: creditNoteId },
      include: { supplier: { select: { tenantId: true, name: true } }, lines: true },
    })
    if (!cn || cn.kind !== 'credit_note' || !cn.originalBillId) return { posted: false, entryId: null, reason: 'not_a_credit_note' }
    if (cn.status === 'void') return { posted: false, entryId: null, reason: 'credit_note_voided' }
    const tenantId = cn.supplier.tenantId
    if (!tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }
    const existing = await tx.journalEntry.findFirst({ where: { reference: creditNoteRef(cn.id), tenantId }, select: { id: true } })
    if (existing) return { posted: false, entryId: existing.id, reason: 'already_posted' }

    const original = await tx.supplierBill.findUnique({
      where:  { id: cn.originalBillId },
      select: { id: true, billNumber: true, createdAt: true, lines: { select: { description: true, inventoryItemId: true, expenseAccountCode: true, poLineId: true, receiptLineId: true } } },
    })
    if (!original) return { posted: false, entryId: null, reason: 'bill_not_found' }
    // Serialise with receipts settling the bill's pending matches (PO lock).
    await lockBillDocsTx(tx, original.lines.map((l) => l.poLineId ?? ''), original.lines.map((l) => l.receiptLineId ?? ''))
    // The credit undoes part of the bill's entry; a bill that never reached
    // the ledger has nothing to undo.
    const billEntry = await tx.journalEntry.findFirst({ where: { reference: billRef(original.id), tenantId }, select: { id: true } })
    if (!billEntry) {
      throw new AppError('BILL_NOT_POSTED', `Bill ${original.billNumber} is not on the books yet — post it first (Procurement → post unposted), then credit it`, 422)
    }
    const legacyBill = await isLegacyDoc(tx, tenantId, original.createdAt)
    const reason: CreditNoteReason = opts.reason ?? 'price'
    const at = new Date()
    const record: CnRecordV2 = { version: 2, reason, originalBillId: original.id, reprices: [], pending: [], returnedItems: [] }

    const creditByClass = zeroByClass()            // 12x0, positive = credit
    const adjByItem = new Map<string, number>()    // 5060, positive = credit
    const creditByCode = new Map<string, number>() // other credits (2015, 6xxx, 1210 legacy)
    const label = `credit note ${cn.billNumber} (bill ${original.billNumber})`

    // Merge per item: one draw / one re-price per (item, kind).
    const returns = new Map<string, { qty: number; cents: number }>()
    const kept = new Map<string, { qty: number; cents: number; short: boolean }>()
    for (const line of cn.lines) {
      const cents = toCents(line.lineTotalCents)
      const itemId = line.inventoryItemId
      if (!itemId) {
        const billLine = original.lines.find((l) => !l.inventoryItemId && l.description === line.description) ?? original.lines.find((l) => !l.inventoryItemId)
        // A pre-cut-over bill line with no item (the admin form's): 1210 now
        // moves only with the lots, so its credit is a cost adjustment
        // (5060, brand-less) — as the credit note's void already treats it.
        const code = billLine?.expenseAccountCode ?? (legacyBill ? ACCT.COST_ADJUSTMENT : null)
        if (!code) throw new AppError('EXPENSE_ACCOUNT_REQUIRED', `"${line.description}" — the bill line it credits has no expense account`, 422)
        addTo(creditByCode, code, cents)
        continue
      }
      const returnQty = line.returnQty != null && line.returnQty > 0 ? line.returnQty : 0
      if (returnQty > 0) {
        const g = returns.get(itemId) ?? { qty: 0, cents: 0 }
        g.qty += returnQty
        g.cents += cents
        returns.set(itemId, g)
      } else {
        const g = kept.get(itemId) ?? { qty: 0, cents: 0, short: reason === 'short' }
        g.qty += line.quantity
        g.cents += cents
        kept.set(itemId, g)
      }
    }

    // Goods sent back: out of the lots, the bill's own first.
    for (const [itemId, g] of returns) {
      const preferLotIds = legacyBill ? [] : (await billLotsForItem(tx, tenantId, original.id, itemId)).map((x) => x.lot.id)
      const r = await consumeFifoTx(tx, {
        tenantId, inventoryItemId: itemId, qty: g.qty, kind: 'supplier_return', sourceType: 'supplier.credit_note', sourceId: cn.id,
        clamp: false, occurredAt: at, createdById: opts.postedBy ?? null, preferLotIds,
      })
      let valueOut = 0
      for (const row of r.rows) {
        creditByClass[row.costClass] += -row.valueCents
        valueOut += -row.valueCents
      }
      addTo(adjByItem, itemId, g.cents - valueOut)
      record.returnedItems.push(itemId)
    }

    // Goods kept: a short delivery or a price credit.
    for (const [itemId, g] of kept) {
      let centsLeft = g.cents
      // 1. Quantity the bill billed ahead of receipt (pending matches) — a
      //    short delivery takes it first; a price credit only when nothing
      //    of the bill's was received.
      const lots = legacyBill ? [] : await billLotsForItem(tx, tenantId, original.id, itemId)
      if (g.short || lots.length === 0) {
        const pend = await tx.grniMatch.findMany({
          where: { billId: original.id, status: 'pending', billLine: { OR: [{ inventoryItemId: itemId }, { poLine: { inventoryItemId: itemId } }] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
        let qtyLeft = g.qty
        for (const pm of pend) {
          if (centsLeft <= 0 || qtyLeft < EPS) break
          const pmGrni = toCents(pm.grniCents)
          const takeQty = g.short ? Math.min(pm.qty, qtyLeft) : pm.qty
          const share = g.short ? Math.min(centsLeft, takeQty >= pm.qty - EPS ? pmGrni : Math.round((pmGrni * takeQty) / pm.qty)) : Math.min(centsLeft, pmGrni)
          if (share <= 0 && takeQty < EPS) continue
          const newQty = g.short ? pm.qty - takeQty : pm.qty
          const newGrni = pmGrni - share
          await tx.grniMatch.update({
            where: { id: pm.id },
            data: newQty < EPS
              ? { qty: 0, grniCents: 0, status: 'void' }
              : { qty: newQty, grniCents: newGrni, billedUnitCostCents: Math.max(0, Math.round(newGrni / newQty)) },
          })
          record.pending.push({ matchId: pm.id, qty: g.short ? takeQty : 0, grniCents: share })
          addTo(creditByCode, ACCT.GRNI, share)
          centsLeft -= share
          qtyLeft -= takeQty
        }
      }
      if (centsLeft <= 0) continue
      // 2. A price credit on the bill's lots (or a short line on a received one).
      if (lots.length > 0) {
        const parts = prorate(centsLeft, lots.map((l) => l.qty))
        for (let i = 0; i < lots.length; i++) {
          const { lot, qty } = lots[i]!
          const part = parts[i]!
          if (!part) continue
          const basis = Math.min(qty, lot.qtyIn)
          const r = await repriceLotTx(tx, { lotId: lot.id, deltaCents: -part, qtyBasis: basis, sourceType: CN_REPRICE, sourceId: cn.id })
          creditByClass[lot.costClass] += -r.onHandCents
          addTo(adjByItem, itemId, part + r.onHandCents)
          record.reprices.push({ lotId: lot.id, itemId, deltaCents: -part, qtyBasis: basis, onHandCents: r.onHandCents, costClass: lot.costClass })
        }
      } else if (legacyBill && g.short) {
        // A legacy bill's goods that never arrived: the old bill booked them
        // to 1210, but no lot ever held them — 5060 by brand use, never 1210
        // (which moves only with the lots after the cut-over).
        addTo(adjByItem, itemId, centsLeft)
      } else {
        // Nothing of the bill's on lots (a legacy bill, or stock no longer
        // traceable): the item's cut-over lot takes the share still on hand,
        // the rest is a cost adjustment.
        const cut = await tx.stockLot.findFirst({ where: { tenantId, inventoryItemId: itemId, sourceType: 'fifo_cutover' }, select: { id: true, qtyIn: true, costClass: true } })
        if (cut && cut.qtyIn > EPS) {
          const lot: LotRef = { id: cut.id, qtyIn: cut.qtyIn, costClass: asClass(cut.costClass), cutover: true }
          const { share, basis } = lotShareOf(-centsLeft, g.qty, lot)
          let onHand = 0
          if (share !== 0) {
            const r = await repriceLotTx(tx, { lotId: lot.id, deltaCents: share, qtyBasis: basis, sourceType: CN_REPRICE, sourceId: cn.id })
            onHand = r.onHandCents
            record.reprices.push({ lotId: lot.id, itemId, deltaCents: share, qtyBasis: basis, onHandCents: onHand, costClass: lot.costClass })
          }
          creditByClass[lot.costClass] += -onHand
          addTo(adjByItem, itemId, centsLeft + onHand)
        } else {
          addTo(adjByItem, itemId, centsLeft)
        }
      }
    }

    await tx.auditLog.create({
      data: {
        category: 'accounting', tenantId, action: CN_STOCK_ACTION, entity: 'SupplierBill', entityId: cn.id,
        metadata: record as unknown as Prisma.InputJsonValue,
      },
    })

    const totalCents = toCents(cn.totalCents)
    const whtCents   = toCents(cn.whtCents)
    const taxCents   = toCents(cn.taxCents)
    const negate = (m: Map<string, number>) => new Map([...m].map(([k, v]) => [k, -v]))
    const negClass = zeroByClass()
    for (const c of COST_CLASSES) negClass[c] = -creditByClass[c]
    const lines: JournalLineInput[] = [
      { accountCode: ACCT.AP_SUPPLIERS, type: 'debit', amountCents: totalCents - whtCents, memo: `${cn.supplier.name} ${label}${whtCents > 0 ? ' (net of WHT)' : ''}` },
      ...signed(ACCT.WHT_PAYABLE, whtCents, `WHT withheld on bill ${original.billNumber}, reduced by ${label}`),
      ...classLines(negClass, (c) => `Goods credited on ${label} (${CLASS_LABEL[c]})`),
      ...(await costAdjustLines(tx, tenantId, negate(adjByItem), `Price difference on ${label} for stock already used`)),
      ...[...creditByCode].flatMap(([code, cents]) => signed(code, -cents, code === ACCT.GRNI ? `Billed ahead, never to arrive — ${label}` : `Credited on ${label}`)),
      ...signed(await inputTaxCodeOfBill(tx, tenantId, original.id), -taxCents, `Input tax reversed on ${label}`),
    ]
    assertBalanced(lines, creditNoteRef(cn.id))
    const result = await postJournalEntry({
      tenantId,
      sourceType: 'supplier.credit_note',
      sourceId: cn.id,
      description: `Supplier credit note ${cn.billNumber} from ${cn.supplier.name} against bill ${original.billNumber}`,
      entryDate: cn.billDate,
      postedBy: opts.postedBy ?? 'system',
      lines,
    }, { tx })
    return { posted: result.posted, entryId: result.entryId }
  })
}

/**
 * Void a credit note's books, in `opts.tx` (procurement voidCreditNote passes
 * its own — a reversal the ledger refuses refuses the void): reverse its entry
 * (dated today, 'supplier.credit_note.void'), put returned stock back into the
 * lots it came from, undo its lot re-pricing and restore the pending matches
 * it shrank; what the lots no longer take back (stock used since) is trued up
 * 12x0 against 5060 ('supplier.credit_note.void.price'). Idempotent.
 */
export async function postSupplierCreditNoteVoid(
  creditNoteId: string,
  reason: string,
  opts: { tx?: Tx; postedBy?: string } = {},
): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${creditNoteId} FOR UPDATE`
    const cn = await tx.supplierBill.findUnique({
      where:  { id: creditNoteId },
      select: { id: true, kind: true, billNumber: true, supplierId: true, supplier: { select: { tenantId: true } } },
    })
    const tenantId = cn?.supplier.tenantId
    if (!cn || cn.kind !== 'credit_note' || !tenantId) return { posted: false, entryId: null, reason: 'not_a_credit_note' }
    const original = await tx.journalEntry.findFirst({ where: { reference: creditNoteRef(cn.id), tenantId }, select: { id: true } })
    if (!original) return { posted: false, entryId: null, reason: 'credit_note_not_posted' }
    const already = await tx.journalEntry.findFirst({ where: { reference: `supplier.credit_note.void:${cn.id}`, tenantId }, select: { id: true } })
    if (already) return { posted: false, entryId: already.id, reason: 'already_reversed' }

    const postedBy = opts.postedBy ?? 'system'
    const result = await reverseJournalEntry(tenantId, 'supplier.credit_note', cn.id, reason, { tx, suffix: 'void', postedBy })

    const row = await tx.auditLog.findFirst({
      where:  { entity: 'SupplierBill', entityId: cn.id, action: CN_STOCK_ACTION },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    })
    const meta = (row?.metadata ?? {}) as Partial<CnRecordV2> & { lines?: CreditNoteStockLineV1[] }
    const trueByClass = zeroByClass()   // 12x0, positive = debit
    const adjByItem = new Map<string, number>()
    const at = new Date()

    if (meta.version === 2) {
      // Returned goods back into the lots they came from — the reversal
      // re-debits 12x0 by exactly that value.
      const draws = await tx.stockMovement.findMany({
        where: { tenantId, sourceType: 'supplier.credit_note', sourceId: cn.id, kind: 'supplier_return' },
        select: { id: true, lotId: true, inventoryItemId: true, qty: true, valueCents: true, costClass: true },
      })
      if (draws.length > 0) {
        const rows: MovementRow[] = draws.map((d) => ({ id: d.id, lotId: d.lotId, inventoryItemId: d.inventoryItemId, qty: d.qty, valueCents: toCents(d.valueCents), costClass: asClass(d.costClass) }))
        await returnToLotsTx(tx, { rows, kind: 'supplier_return', sourceType: 'supplier.credit_note.void', sourceId: cn.id, occurredAt: at, tenantId, createdById: postedBy === 'system' ? null : postedBy })
      }
      for (const rp of meta.reprices ?? []) {
        const r = await repriceLotTx(tx, { lotId: rp.lotId, deltaCents: -rp.deltaCents, qtyBasis: rp.qtyBasis, sourceType: CN_REPRICE_VOID, sourceId: cn.id })
        // The reversal debited 12x0 by −onHand (what the credit took off the
        // lots); the lots took back r.onHand.
        const x = r.onHandCents + rp.onHandCents
        trueByClass[asClass(rp.costClass)] += x
        addTo(adjByItem, rp.itemId, -x)
      }
      for (const p of meta.pending ?? []) {
        const pm = await tx.grniMatch.findUnique({ where: { id: p.matchId } })
        if (!pm) continue
        if (pm.status === 'pending' || pm.status === 'void') {
          const qty = (pm.status === 'void' ? 0 : pm.qty) + p.qty
          const grni = (pm.status === 'void' ? 0 : toCents(pm.grniCents)) + p.grniCents
          await tx.grniMatch.update({
            where: { id: pm.id },
            data: { qty, grniCents: grni, status: 'pending', billedUnitCostCents: qty > EPS ? Math.max(0, Math.round(grni / qty)) : pm.billedUnitCostCents },
          })
        } else {
          // Settled by a receipt since: the restored part is billed ahead again.
          await tx.grniMatch.create({
            data: {
              tenantId, billId: pm.billId, billLineId: pm.billLineId, receiptLineId: null, poLineId: pm.poLineId,
              qty: p.qty, billedUnitCostCents: pm.billedUnitCostCents, grniCents: p.grniCents, status: 'pending',
            },
          })
        }
      }
    } else {
      // A credit note recorded before the FIFO cut-over: the reversal debited
      // 1210 with what each line credited it. Returned goods come back as a
      // legacy-return lot at that value; a price credit's 1210 part is not
      // traceable to lots any more → 5060.
      const lines = meta.lines ?? []
      const backByItem = new Map<string, { qty: number; cents: number }>()
      let reversed = 0
      for (const l of lines) {
        reversed += l.inventoryCents
        if (l.inventoryItemId && l.stockBacked && l.returnQty > 0) {
          const g = backByItem.get(l.inventoryItemId) ?? { qty: 0, cents: 0 }
          g.qty += l.returnQty
          g.cents += l.inventoryCents
          backByItem.set(l.inventoryItemId, g)
        }
      }
      trueByClass.food -= reversed
      for (const [itemId, g] of backByItem) {
        const value = Math.max(0, g.cents)
        const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { category: true, tenantId: true } })
        if (!item || item.tenantId !== tenantId || !(g.qty > EPS)) continue
        await addLotTx(tx, {
          tenantId, inventoryItemId: itemId, qty: g.qty, unitCostCents: Math.max(0, Math.round(value / g.qty)), valueCents: value,
          kind: 'legacy_return', lotSourceType: 'legacy_return', lotSourceId: `credit_note:${cn.id}`,
          movementSourceType: 'supplier.credit_note.void', movementSourceId: cn.id, receivedAt: at,
          createdById: postedBy === 'system' ? null : postedBy,
        })
        trueByClass[costClassOf(item.category)] += value
      }
      // 5060 balances what 12x0 did not take back.
      const net = COST_CLASSES.reduce((s, c) => s + trueByClass[c], 0)
      addTo(adjByItem, '', -net)
    }

    const lines: JournalLineInput[] = [
      ...classLines(trueByClass, (c) => `Credit note ${cn.billNumber} voided — ${CLASS_LABEL[c]} lots restored`),
      ...(await costAdjustLines(tx, tenantId, adjByItem, `Credit note ${cn.billNumber} voided — stock used since it was recorded`)),
    ]
    if (lines.length > 0) {
      assertBalanced(lines, `supplier.credit_note.void.price:${cn.id}`)
      await postJournalEntry({
        tenantId,
        sourceType: 'supplier.credit_note.void.price',
        sourceId: cn.id,
        description: `Lot cost restored after voiding credit note ${cn.billNumber}`,
        postedBy,
        lines,
      }, { tx })
    }
    return { posted: result.posted, entryId: result.entryId }
  })
}

