// Supplier bill / payment / waste → journal posting.
//
// Bill creation: increases inventory (or expense) + GST input + AP.
// Payment: reduces AP + cash/bank.
// Waste: derecognises inventory to waste expense.
//
// All idempotent on (sourceType, sourceId).
//
// Bills and payments post INSIDE the transaction that saves them (pass
// `{ tx }`; procurement createBill / createPaymentTx / voidBill do). They used
// to post after commit, fire-and-forget: a bill dated in a closed month was
// saved (201) but never reached the ledger, so AP aging and ledger AP 2010
// disagreed with nothing but a log line to show for it. Now a PERIOD_LOCKED
// (or any other posting failure) rolls the save back with it.
//
// ─── Supplier price variance (bill ≠ the cost the stock was received at) ────
//
// How the ledger values stock: a bill debits Inventory 1210 with what the
// supplier charged; sales and waste relieve 1210 at the item's unitCostCents,
// the moving average of what deliveries cost (owner decision 30). Receiving
// against a PO books the stock at the PO line's price — so when the bill
// comes in above (or below) the PO price, 1210 held money no stock stood
// behind and recipe costing kept the old price.
//
// The bill is what the delivery actually cost, so it re-averages the item
// (ItemPriceHistory source 'bill_match', which the inventory module already
// counts as a delivery cost): the difference is added to the value of the
// stock still on hand. The slice of the billed quantity that is no longer on
// hand was already costed out at the old price — that part goes to 5060
// Inventory Cost Adjustment (COGS group). The bill entry then debits 1210 with
// exactly what stock valuation moved by, so 1210 and Σ stock × cost agree.
// Voiding the bill undoes the re-average the same way (revalueForBillVariance
// with the opposite sign) and trues up 5060 for anything used in between.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, reverseJournalEntry, type JournalLineInput } from './journal.js'
import { getOperationsConfig } from '../../lib/setup-config.js'

type Tx = Prisma.TransactionClient

/** 5060 Inventory Cost Adjustment (lib/chartOfAccounts.ts) — COGS group. */
export const INVENTORY_COST_ADJUSTMENT = '5060'

/** Run `fn` in the caller's transaction, or in a fresh one. */
async function inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (tx) return fn(tx)
  return prisma.$transaction((t) => fn(t))
}

const billRef = (billId: string) => `supplier.bill:${billId}`

// ─── Price variance → item cost ──────────────────────────────────────────────

interface VarianceLine {
  inventoryItemId: string
  poLineId:        string
  quantity:        number   // the billed quantity
  varianceCents:   number   // signed: billed line total − the same quantity at the received cost
}

/**
 * A bill's price variance, per line linked to a PO line: what the supplier
 * charged for the line minus the same quantity at the price receiving booked
 * the stock at (the PO line's unitCostCents — receiving.ts). Lines with no PO
 * line have no received cost to compare to and are left as billed.
 */
async function billVarianceLines(tx: Tx, bill: {
  lines: Array<{ poLineId: string | null; quantity: number; lineTotalCents: number }>
}, tenantId: string): Promise<VarianceLine[]> {
  const poLineIds = bill.lines.map((l) => l.poLineId).filter((x): x is string => !!x)
  if (poLineIds.length === 0) return []
  const poLines = await tx.purchaseOrderLine.findMany({
    where:  { id: { in: poLineIds } },
    select: { id: true, unitCostCents: true, inventoryItemId: true, inventoryItem: { select: { tenantId: true } } },
  })
  const out: VarianceLine[] = []
  for (const l of bill.lines) {
    if (!l.poLineId || !(l.quantity > 0)) continue
    const pl = poLines.find((x) => x.id === l.poLineId)
    // Only the bill's own company's stock is ever revalued.
    if (!pl || pl.inventoryItem.tenantId !== tenantId) continue
    const varianceCents = l.lineTotalCents - Math.round(pl.unitCostCents * l.quantity)
    if (varianceCents === 0) continue
    out.push({ inventoryItemId: pl.inventoryItemId, poLineId: pl.id, quantity: l.quantity, varianceCents })
  }
  return out
}

/**
 * Add `varianceCents` (signed) to the value of each item's stock on hand, at
 * most the share of it that belongs to the quantity still on hand
 * (min(on hand, billed qty) / billed qty). Re-averages unitCostCents, records
 * ItemPriceHistory, and returns how much stock valuation actually moved
 * (Σ round((new − old) × on hand)) — the caller expenses the rest to 5060.
 */
async function revalueForBillVariance(tx: Tx, lines: VarianceLine[], opts: {
  supplierId: string
  source: 'bill_match' | 'bill_void'
}): Promise<number> {
  let absorbedCents = 0
  for (const l of lines) {
    await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${l.inventoryItemId} FOR UPDATE`
    const item = await tx.inventoryItem.findUnique({
      where:  { id: l.inventoryItemId },
      select: { id: true, currentStock: true, unitCostCents: true },
    })
    if (!item || item.unitCostCents == null) continue
    const onHand = Math.max(0, item.currentStock)
    if (!(onHand > 0)) continue
    const share   = Math.min(onHand, l.quantity) / l.quantity
    const target  = l.varianceCents * share
    const oldCost = item.unitCostCents
    const newCost = Math.max(0, Math.round((oldCost * onHand + target) / onHand))
    if (newCost === oldCost) continue
    await tx.inventoryItem.update({ where: { id: item.id }, data: { unitCostCents: newCost } })
    await tx.itemPriceHistory.create({
      data: {
        inventoryItemId: item.id,
        supplierId:      opts.supplierId,
        oldCostCents:    oldCost,
        newCostCents:    newCost,
        source:          opts.source,
        poLineId:        l.poLineId,
      },
    })
    absorbedCents += Math.round((newCost - oldCost) * onHand)
  }
  return absorbedCents
}

/** Net debit (debit − credit) on `code` within one posted entry. */
async function entryNetDebit(tx: Tx, entryId: string, code: string): Promise<number> {
  const lines = await tx.journalLine.findMany({
    where:  { journalEntryId: entryId, account: { code } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
}

/**
 * Income-tax withholding (s.153/153A) on a supplier bill, from the supplier's
 * company's Operations config. Fixed ONCE, when the bill is recorded
 * (procurement createBill stores it on SupplierBill.whtCents), and booked
 * from that stored figure — so the ledger's AP and every "still due" figure
 * are the same number. A supplier with no company never posts, so it
 * withholds nothing (and never reads another company's settings).
 */
export async function withholdingForBill(subtotalCents: number, tenantId: string | null): Promise<number> {
  if (!tenantId || subtotalCents <= 0) return 0
  const ops = await getOperationsConfig(tenantId)
  if (!ops.withholdingTaxEnabled || !(ops.withholdingTaxPct > 0)) return 0
  return Math.round(subtotalCents * ops.withholdingTaxPct)
}

type PostResult = { posted: boolean; entryId: string | null; reason?: string }

/** 5060 when the company's chart has it active, else 5010 Food Cost (required by /health). */
async function costAdjustmentCode(tx: Tx, tenantId: string): Promise<string> {
  const acct = await tx.account.findFirst({
    where:  { tenantId, code: INVENTORY_COST_ADJUSTMENT, isActive: true },
    select: { id: true },
  })
  return acct ? INVENTORY_COST_ADJUSTMENT : ACCT.FOOD_COST
}

/**
 * Post a supplier bill to its supplier's company's ledger — in `opts.tx` when
 * given (createBill passes its own, so the bill and its entry commit or fail
 * together; a closed month is PERIOD_LOCKED 422 and nothing is saved).
 * Idempotent: a bill already on the books is a no-op, and its price variance
 * is applied to item cost exactly once, with the entry.
 */
export async function postSupplierBill(billId: string, opts: { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    // One posting of a bill at a time — a retry racing the first post must
    // not re-average the item cost twice.
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${billId} FOR UPDATE`
    const bill = await tx.supplierBill.findUnique({
      where: { id: billId },
      include: { supplier: true, lines: true },
    })
    if (!bill) return { posted: false, entryId: null, reason: 'bill_not_found' }
    if (bill.status === 'void') return { posted: false, entryId: null, reason: 'bill_voided' }

    // Supplier bills post into the supplier's own company.
    const tenantId = bill.supplier.tenantId
    if (!tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }
    if (bill.subtotalCents === 0 && bill.taxCents === 0) return { posted: false, entryId: null, reason: 'zero_amount' }

    const existing = await tx.journalEntry.findFirst({ where: { reference: billRef(bill.id), tenantId }, select: { id: true } })
    if (existing) return { posted: false, entryId: existing.id, reason: 'already_posted' }

    // Price variance against the received cost (header comment): re-average
    // what is still on hand; the rest was already used → 5060.
    const variance = await billVarianceLines(tx, bill, tenantId)
    const varianceCents = variance.reduce((s, v) => s + v.varianceCents, 0)
    const absorbedCents = variance.length > 0
      ? await revalueForBillVariance(tx, variance, { supplierId: bill.supplierId, source: 'bill_match' })
      : 0
    const usedCents = varianceCents - absorbedCents

    // v1: book all inventory purchases to Food. Beverage/Packaging splits will
    // come once InventoryItem grows a `category` field — see schema TODO.
    // 1210 moves by exactly what stock valuation moved by: the bill less the
    // variance share that was already costed out.
    const lines: JournalLineInput[] = []
    const inventoryCents = bill.subtotalCents - usedCents
    if (inventoryCents !== 0) {
      lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: inventoryCents > 0 ? 'debit' : 'credit', amountCents: Math.abs(inventoryCents), memo: `Bill ${bill.billNumber}` })
    }
    if (usedCents !== 0) {
      lines.push({
        accountCode: await costAdjustmentCode(tx, tenantId),
        type: usedCents > 0 ? 'debit' : 'credit',
        amountCents: Math.abs(usedCents),
        memo: `Price difference on bill ${bill.billNumber} for stock already used`,
      })
    }
    if (bill.taxCents > 0) {
      lines.push({ accountCode: ACCT.GST_INPUT, type: 'debit', amountCents: bill.taxCents, memo: `Input GST on bill ${bill.billNumber}` })
    }

    // Withholding tax — section 153/153A. We deduct at source: supplier is
    // paid net of WHT, and we book a payable to FBR for the deducted amount.
    // The amount is the bill's own whtCents (fixed when it was recorded), so
    // this entry and the bill's "still due" can never disagree. The
    // `withholdingTaxRecoverable` flag is informational (memo only).
    // Math: Inventory dr X, AP cr (X-WHT), WHT_PAYABLE cr WHT  → balanced.
    const whtCents = bill.whtCents
    if (whtCents > 0) {
      const ops = await getOperationsConfig(tenantId)
      const pct = bill.subtotalCents > 0 ? (whtCents / bill.subtotalCents) * 100 : 0
      lines.push({
        accountCode: ACCT.WHT_PAYABLE,
        type: 'credit',
        amountCents: whtCents,
        memo: `WHT ${pct.toFixed(2)}% on ${bill.billNumber}${ops.withholdingTaxRecoverable ? ' (recoverable)' : ''}`,
      })
    }

    const apPayable = bill.totalCents - whtCents
    lines.push({ accountCode: ACCT.AP_SUPPLIERS, type: 'credit', amountCents: apPayable, memo: `${bill.supplier.name} bill ${bill.billNumber}${whtCents > 0 ? ' (net of WHT)' : ''}` })

    const result = await postJournalEntry({
      tenantId,
      sourceType: 'supplier.bill',
      sourceId: bill.id,
      description: `Supplier bill ${bill.billNumber} from ${bill.supplier.name}`,
      entryDate: bill.billDate,
      postedBy: 'system',
      lines,
    }, { tx })
    return { posted: result.posted, entryId: result.entryId }
  })
}

/**
 * Reverse a voided bill's entry (dated today) and undo its price-variance
 * re-average — in `opts.tx`, so voidBill and its reversal commit together.
 * A bill that never reached the ledger has nothing to reverse. Errors
 * propagate: a void the ledger can't follow (e.g. today is in a closed
 * period) is refused rather than leaving AP 2010 owing a void bill.
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
      include: { supplier: { select: { tenantId: true } }, lines: true },
    })
    const tenantId = bill?.supplier.tenantId
    if (!bill || !tenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }

    const original = await tx.journalEntry.findFirst({ where: { reference: billRef(billId), tenantId }, select: { id: true } })
    if (!original) return { posted: false, entryId: null, reason: 'bill_not_posted' }
    const already = await tx.journalEntry.findFirst({ where: { reference: `supplier.bill.void:${billId}`, tenantId }, select: { id: true } })
    if (already) return { posted: false, entryId: already.id, reason: 'already_reversed' }

    const result = await reverseJournalEntry(tenantId, 'supplier.bill', billId, reason, {
      tx, suffix: 'void', postedBy: opts.postedBy ?? 'system',
    })

    // Undo the re-average. What the bill put into stock value is what its
    // 1210 line carried beyond the received cost; take the variance back out
    // of what is on hand now. If some of that stock was used in between (at
    // the re-averaged cost), 5060 gives the difference back, so 1210 keeps
    // following stock valuation.
    const variance = await billVarianceLines(tx, bill, tenantId)
    if (variance.length > 0) {
      const varianceCents = variance.reduce((s, v) => s + v.varianceCents, 0)
      const absorbedAtBill = (await entryNetDebit(tx, original.id, ACCT.INVENTORY_FOOD)) - bill.subtotalCents + varianceCents
      const absorbedNow = await revalueForBillVariance(
        tx,
        variance.map((v) => ({ ...v, varianceCents: -v.varianceCents })),
        { supplierId: bill.supplierId, source: 'bill_void' },
      )
      const trueUp = absorbedNow + absorbedAtBill
      if (trueUp !== 0) {
        const code = await costAdjustmentCode(tx, tenantId)
        const memo = `Price difference on void bill ${bill.billNumber} for stock used since it was billed`
        await postJournalEntry({
          tenantId,
          sourceType: 'supplier.bill.void.price',
          sourceId: billId,
          description: `Item cost restored after voiding bill ${bill.billNumber}`,
          postedBy: opts.postedBy ?? 'system',
          lines: trueUp > 0
            ? [{ accountCode: ACCT.INVENTORY_FOOD, type: 'debit',  amountCents: trueUp, memo },
               { accountCode: code,                type: 'credit', amountCents: trueUp, memo }]
            : [{ accountCode: code,                type: 'debit',  amountCents: -trueUp, memo },
               { accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: -trueUp, memo }],
        }, { tx })
      }
    }
    return { posted: result.posted, entryId: result.entryId }
  })
}

/**
 * Post a supplier payment (Dr AP 2010 / Cr cash or bank) to its supplier's
 * company — in `opts.tx` when given (procurement createPaymentTx passes its
 * own: a payment dated in a closed month is PERIOD_LOCKED 422, not saved).
 */
export async function postSupplierPayment(paymentId: string, opts: { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const payment = await tx.supplierPayment.findUnique({
      where: { id: paymentId },
      include: { supplier: true },
    })
    if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }

    const paymentTenantId = payment.supplier.tenantId
    if (!paymentTenantId) return { posted: false, entryId: null, reason: 'supplier_has_no_company' }

    // method → cash account
    const cashAccount =
      payment.method === 'cash'   ? ACCT.CASH_ON_HAND :
      /* bank_transfer/cheque/wallet */ ACCT.BANK

    const lines: JournalLineInput[] = [
      { accountCode: ACCT.AP_SUPPLIERS, type: 'debit',  amountCents: payment.amountCents, memo: `Payment to ${payment.supplier.name}` },
      { accountCode: cashAccount,       type: 'credit', amountCents: payment.amountCents, memo: `${payment.method} via ${payment.reference ?? 'no ref'}` },
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

export async function postWasteLog(wasteLogId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const log = await prisma.wasteLog.findUnique({
    where: { id: wasteLogId },
    include: { inventoryItem: true },
  })
  if (!log) return { posted: false, entryId: null, reason: 'waste_log_not_found' }

  const cost = log.estimatedCostCents ?? Math.round((log.inventoryItem.unitCostCents ?? 0) * log.quantity)
  if (cost <= 0) return { posted: false, entryId: null, reason: 'zero_cost' }

  const lines: JournalLineInput[] = [
    { accountCode: ACCT.WASTE,           type: 'debit',  amountCents: cost, memo: `Waste: ${log.reason} — ${log.inventoryItem.name}` },
    { accountCode: ACCT.INVENTORY_FOOD,  type: 'credit', amountCents: cost, memo: `Inventory derecognised (waste)` },
  ]

  // Waste posts into the company that owns the stock.
  const wasteTenantId = log.inventoryItem.tenantId
  if (!wasteTenantId) return { posted: false, entryId: null, reason: 'item_has_no_company' }

  const result = await postJournalEntry({
    tenantId: wasteTenantId,
    sourceType: 'inventory.waste',
    sourceId: log.id,
    description: `Waste — ${log.inventoryItem.name} (${log.reason})`,
    entryDate: log.recordedAt,
    postedBy: log.recordedById ?? 'system',
    lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}
