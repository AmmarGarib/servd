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
// A bill for goods not yet (all) received applies its variance only to the
// received quantity and carries the rest until it arrives (BOH-R2-02, see
// "What a bill absorbed, recorded" below). Voiding the bill takes back out of
// stock what it put in that is still there — stock used oldest first, so
// stock received after the bill is never re-priced by the void — and trues up
// 5060 for the part used in between.

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
  purchaseOrderId: string
  quantity:        number   // the billed quantity
  varianceCents:   number   // signed: billed line total − the same quantity at the received cost
}

/**
 * A bill's price variance, per line linked to a PO line: what the supplier
 * charged for the line minus the same quantity at the price receiving booked
 * the stock at (the PO line's unitCostCents — receiving.ts). Lines with no PO
 * line have no received cost to compare to and are left as billed. Lines with
 * no variance are listed too (`withZero`), because they still match received
 * quantity (BOH-R2-02).
 */
async function billVarianceLines(tx: Tx, bill: {
  lines: Array<{ poLineId: string | null; quantity: number; lineTotalCents: number }>
}, tenantId: string, opts: { withZero?: boolean } = {}): Promise<VarianceLine[]> {
  const poLineIds = bill.lines.map((l) => l.poLineId).filter((x): x is string => !!x)
  if (poLineIds.length === 0) return []
  const poLines = await tx.purchaseOrderLine.findMany({
    where:  { id: { in: poLineIds } },
    select: { id: true, purchaseOrderId: true, unitCostCents: true, inventoryItemId: true, inventoryItem: { select: { tenantId: true } } },
  })
  const out: VarianceLine[] = []
  for (const l of bill.lines) {
    if (!l.poLineId || !(l.quantity > 0)) continue
    const pl = poLines.find((x) => x.id === l.poLineId)
    // Only the bill's own company's stock is ever revalued.
    if (!pl || pl.inventoryItem.tenantId !== tenantId) continue
    const varianceCents = l.lineTotalCents - Math.round(pl.unitCostCents * l.quantity)
    if (varianceCents === 0 && !opts.withZero) continue
    out.push({ inventoryItemId: pl.inventoryItemId, poLineId: pl.id, purchaseOrderId: pl.purchaseOrderId, quantity: l.quantity, varianceCents })
  }
  return out
}

/**
 * Move the value of an item's stock on hand by `targetCents` (signed),
 * re-averaging unitCostCents and recording ItemPriceHistory. Returns how much
 * stock valuation actually moved (round((new − old) × on hand)); nothing when
 * nothing is on hand. The cost never goes below zero.
 */
async function revalueItem(tx: Tx, input: {
  inventoryItemId: string
  poLineId:        string
  targetCents:     number
  supplierId:      string
  source:          'bill_match' | 'bill_void'
}): Promise<{ moved: number; onHand: number }> {
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${input.inventoryItemId} FOR UPDATE`
  const item = await tx.inventoryItem.findUnique({
    where:  { id: input.inventoryItemId },
    select: { id: true, currentStock: true, unitCostCents: true },
  })
  const onHand = Math.max(0, item?.currentStock ?? 0)
  if (!item || item.unitCostCents == null || input.targetCents === 0 || !(onHand > 0)) return { moved: 0, onHand }
  const oldCost = item.unitCostCents
  const newCost = Math.max(0, Math.round((oldCost * onHand + input.targetCents) / onHand))
  if (newCost === oldCost) return { moved: 0, onHand }
  await tx.inventoryItem.update({ where: { id: item.id }, data: { unitCostCents: newCost } })
  await tx.itemPriceHistory.create({
    data: {
      inventoryItemId: item.id,
      supplierId:      input.supplierId,
      oldCostCents:    oldCost,
      newCostCents:    newCost,
      source:          input.source,
      poLineId:        input.poLineId,
    },
  })
  return { moved: Math.round((newCost - oldCost) * onHand), onHand }
}

/**
 * LEGACY (bills posted before BOH-R2-02 recorded what they absorbed): add
 * `varianceCents` (signed) to the value of each item's stock on hand, at most
 * the share of it that belongs to the quantity still on hand
 * (min(on hand, billed qty) / billed qty). Only the void of such a bill uses
 * it now.
 */
async function revalueForBillVariance(tx: Tx, lines: VarianceLine[], opts: {
  supplierId: string
  source: 'bill_match' | 'bill_void'
}): Promise<number> {
  let absorbedCents = 0
  for (const l of lines) {
    const item = await tx.inventoryItem.findUnique({ where: { id: l.inventoryItemId }, select: { currentStock: true } })
    const onHand = Math.max(0, item?.currentStock ?? 0)
    if (!(onHand > 0)) continue
    const share = Math.min(onHand, l.quantity) / l.quantity
    absorbedCents += (await revalueItem(tx, {
      inventoryItemId: l.inventoryItemId, poLineId: l.poLineId,
      targetCents: Math.round(l.varianceCents * share), supplierId: opts.supplierId, source: opts.source,
    })).moved
  }
  return absorbedCents
}

// ─── What a bill absorbed, recorded (BOH-R2-02) ──────────────────────────────
//
// A bill can arrive before its goods are all received. Its price variance
// applies only to the quantity of the PO line received and not yet matched by
// another bill — min(billed, received-to-date − matched). Of that, the part
// still on hand re-averages the item; the part already used goes to 5060. The
// rest of the billed quantity is CARRIED: its variance stays in 1210 with the
// bill (the goods are owed, in transit) and is applied when that quantity is
// received (applyCarriedBillVarianceTx, called by receiving) — split the same
// way as at posting: the share of the received quantity still on hand after
// the receipt re-averages the item, the share that only filled stock already
// sold below zero goes to 5060 (BK2-RV-1). Without the split a bill booked
// before its goods spread its whole variance over whatever was left (stock
// -9 + 10 received = 1 kg carrying 10 kg of variance), or, with nothing left,
// kept it in 1210 with no stock behind it. What each line absorbed, used and carried is written down at
// posting (an 'accounting' audit row 'supplier.bill.variance' on the bill,
// plus one 'supplier.bill.variance_applied' row per later receipt, each with
// the stock it was spread over), so a void takes back out of stock exactly
// what the bill put in and is still there — each slice less the share of its
// stock used since, counting stock received after the slice as what is on
// hand first (RB-2) — never a share of the whole variance re-derived from
// today's stock (which over-reversed after a later receipt).

const VARIANCE_ACTION = 'supplier.bill.variance'
const APPLIED_ACTION  = 'supplier.bill.variance_applied'

interface BillVarianceRecordLine {
  poLineId:        string
  inventoryItemId: string
  billedQty:       number
  receivedQty:     number   // billed quantity matched against received stock at posting
  varianceCents:   number   // the line's whole variance
  absorbedCents:   number   // stock valuation moved at posting
  onHandAtPosting: number   // the stock it was spread over
  usedCents:       number   // expensed to 5060 at posting
  carriedQty:      number   // billed quantity not yet received at posting
  carriedCents:    number   // its variance, held in 1210 until received
}
interface AppliedRecord {
  poLineId:      string
  qty:           number
  targetCents:   number
  absorbedCents: number
  onHand:        number
  usedCents?:    number          // expensed to 5060 at the receipt (BK2-RV-1); absent on older rows = 0
  receiptId?:    string | null   // the goods receipt that applied it (when the caller passed it)
  at?:           Date            // when it was applied (the audit row's createdAt; not stored in metadata)
}

async function varianceRecordsOf(tx: Tx, billIds: string[]) {
  if (billIds.length === 0) return { recorded: new Map<string, BillVarianceRecordLine[]>(), recordedAt: new Map<string, Date>(), applied: new Map<string, AppliedRecord[]>() }
  const rows = await tx.auditLog.findMany({
    where:   { entity: 'SupplierBill', entityId: { in: billIds }, action: { in: [VARIANCE_ACTION, APPLIED_ACTION] } },
    orderBy: { createdAt: 'asc' },
    select:  { entityId: true, action: true, metadata: true, createdAt: true },
  })
  const recorded   = new Map<string, BillVarianceRecordLine[]>()
  const recordedAt = new Map<string, Date>()
  const applied    = new Map<string, AppliedRecord[]>()
  for (const r of rows) {
    const m = (r.metadata ?? {}) as { lines?: BillVarianceRecordLine[] } & Partial<AppliedRecord>
    if (r.action === VARIANCE_ACTION) { recorded.set(r.entityId!, m.lines ?? []); recordedAt.set(r.entityId!, r.createdAt) }
    else if (m.poLineId) applied.set(r.entityId!, [...(applied.get(r.entityId!) ?? []), { ...(m as AppliedRecord), at: r.createdAt }])
  }
  return { recorded, recordedAt, applied }
}

/**
 * Quantity of an item received (goods receipts, with or without a PO) strictly
 * after `after`, leaving out `excludeReceiptId` (the receipt a slice was itself
 * spread over). Used by a bill void to tell stock that was there when a slice
 * re-priced it from stock that arrived later (RB-2).
 */
async function receivedSince(tx: Tx, inventoryItemId: string, after: Date, excludeReceiptId: string | null): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ qty: number | null }>>`
    SELECT COALESCE(SUM(l."receivedQty"), 0)::float8 AS qty
      FROM goods_receipt_lines l
      JOIN goods_receipts r ON r.id = l."receiptId"
     WHERE l."inventoryItemId" = ${inventoryItemId}
       AND r."receivedAt" > ${after}
       AND (${excludeReceiptId}::text IS NULL OR r.id <> ${excludeReceiptId}::text)`
  return Math.max(0, Number(rows[0]?.qty ?? 0))
}

/**
 * Quantity of a PO line already matched by OTHER live bills: what each
 * recorded at posting plus what later receipts applied; a bill posted before
 * the record existed counts its billed quantity (the old assumption).
 */
async function matchedByOtherBills(tx: Tx, poLineId: string, billId: string): Promise<number> {
  const others = await tx.supplierBillLine.findMany({
    where:  { poLineId, billId: { not: billId }, bill: { status: { not: 'void' } } },
    select: { billId: true, quantity: true },
  })
  if (others.length === 0) return 0
  const { recorded, applied } = await varianceRecordsOf(tx, Array.from(new Set(others.map((o) => o.billId))))
  let matched = 0
  const counted = new Set<string>()
  for (const o of others) {
    const rec = recorded.get(o.billId)
    if (!rec) { matched += o.quantity; continue }
    if (counted.has(o.billId)) continue
    counted.add(o.billId)
    matched += rec.filter((l) => l.poLineId === poLineId).reduce((s, l) => s + l.receivedQty, 0)
    matched += (applied.get(o.billId) ?? []).filter((a) => a.poLineId === poLineId).reduce((s, a) => s + a.qty, 0)
  }
  return matched
}

/**
 * Receiving `quantity` of a PO line applies the variance the line's live bills
 * carried for it (oldest bill first). 1210 already holds it (the bill debited
 * it). Of each slice, the share of the received quantity still on hand after
 * the receipt (min(stock now, quantity) / quantity — stock that was below zero
 * swallowed the rest, already costed out at the old price) re-averages the
 * item; the rest, and the rounding gap, is expensed Dr/Cr 5060 against 1210 in
 * the bill's company, the way postSupplierBill splits it at posting — so the
 * item's cost and 1210 come out the same whether the bill or the goods came
 * first (BK2-RV-1). The 5060 entry is dated now (the receipt) in this
 * transaction: a closed period refuses the receipt (PERIOD_LOCKED), as it
 * refuses a bill. Call inside the receiving transaction, after the stock and
 * PO line are updated. Returns what stock valuation moved by.
 */
export async function applyCarriedBillVarianceTx(tx: Tx, input: {
  poLineId:   string
  quantity:   number
  supplierId: string
  receiptId?: string | null
  /** How much of `quantity` is still on hand, when the caller knows better than stock now (the catch-up below). */
  onHandQty?: number
}): Promise<number> {
  if (!(input.quantity > 0)) return 0
  // Serialise with a void of the line's bills (RB-5): postSupplierBillVoid
  // locks the bill, then its POs, then the items — the same PO lock receiving
  // already holds (re-taking it in the same transaction is free). The bills'
  // status is read below, after the lock, so a void that committed first is
  // seen as void, and a void that waits sees this receipt's applied slice.
  await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = (SELECT "purchaseOrderId" FROM purchase_order_lines WHERE id = ${input.poLineId}) FOR UPDATE`
  const billLines = await tx.supplierBillLine.findMany({
    where:   { poLineId: input.poLineId, bill: { status: { not: 'void' } } },
    select:  { billId: true, bill: { select: { createdAt: true, billNumber: true, supplier: { select: { tenantId: true } } } } },
    orderBy: { bill: { createdAt: 'asc' } },
  })
  const billIds = Array.from(new Set(billLines.map((b) => b.billId)))
  if (billIds.length === 0) return 0
  const { recorded, applied } = await varianceRecordsOf(tx, billIds)
  // Idempotent per receipt: a receipt that already applied this line's
  // carried variance applies nothing again.
  if (input.receiptId && billIds.some((b) => (applied.get(b) ?? []).some((a) => a.poLineId === input.poLineId && a.receiptId === input.receiptId))) return 0
  // How much of the received quantity is still on hand: stock after the
  // receipt, at most the quantity received (stock below zero before the
  // receipt was already sold at the old cost). Read under the item lock
  // receiving holds (re-taken here for any other caller).
  const poLine = await tx.purchaseOrderLine.findUnique({ where: { id: input.poLineId }, select: { inventoryItemId: true } })
  if (!poLine) return 0
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${poLine.inventoryItemId} FOR UPDATE`
  const stock = await tx.inventoryItem.findUnique({ where: { id: poLine.inventoryItemId }, select: { currentStock: true } })
  const onHandQty   = input.onHandQty ?? Math.max(0, stock?.currentStock ?? 0)
  const onHandShare = Math.min(Math.max(0, onHandQty), input.quantity) / input.quantity
  let left = input.quantity
  let movedCents = 0
  for (const billId of billIds) {
    if (!(left > 0)) break
    const rec = (recorded.get(billId) ?? []).filter((l) => l.poLineId === input.poLineId)
    // What earlier receipts applied for this PO line, consumed against the
    // bill's record lines in order (receipts fill them in that order) — so a
    // bill with two lines on one PO line applies the second line's carried
    // variance too, not just the first's.
    const done = (applied.get(billId) ?? []).filter((a) => a.poLineId === input.poLineId)
    let doneQty   = done.reduce((s, a) => s + a.qty, 0)
    let doneCents = done.reduce((s, a) => s + a.targetCents, 0)
    for (const line of rec) {
      if (!(left > 0)) break
      if (!(line.carriedQty > 1e-9)) continue
      if (doneQty >= line.carriedQty - 1e-9) { doneQty -= line.carriedQty; doneCents -= line.carriedCents; continue }
      const remainingQty   = line.carriedQty - doneQty
      const remainingCents = line.carriedCents - doneCents
      doneQty = 0; doneCents = 0
      const qty = Math.min(left, remainingQty)
      const targetCents = qty >= remainingQty - 1e-9 ? remainingCents : Math.round(remainingCents * qty / remainingQty)
      left -= qty
      const onHandTarget = onHandShare >= 1 ? targetCents : Math.round(targetCents * onHandShare)
      const { moved: absorbedCents, onHand } = await revalueItem(tx, {
        inventoryItemId: line.inventoryItemId, poLineId: input.poLineId, targetCents: onHandTarget,
        supplierId: input.supplierId, source: 'bill_match',
      })
      movedCents += absorbedCents
      // The slice less what stock valuation moved: the share used before it
      // arrived, plus the rounding gap — out of 1210 into 5060.
      const usedCents = targetCents - absorbedCents
      const bill = billLines.find((b) => b.billId === billId)?.bill
      const tenantId = bill?.supplier.tenantId ?? null
      const appliedRow = await tx.auditLog.create({
        data: {
          category: 'accounting', tenantId, action: APPLIED_ACTION, entity: 'SupplierBill', entityId: billId,
          metadata: { poLineId: input.poLineId, qty, targetCents, absorbedCents, onHand, usedCents, receiptId: input.receiptId ?? null } as Prisma.InputJsonValue,
        },
      })
      if (usedCents !== 0 && tenantId) {
        const code = await costAdjustmentCode(tx, tenantId)
        const memo = `Price difference on bill ${bill?.billNumber ?? billId} for received stock already used`
        await postJournalEntry({
          tenantId,
          sourceType: 'supplier.bill.variance.receipt',
          sourceId:   appliedRow.id,
          description: `Bill ${bill?.billNumber ?? billId}: price difference on goods received after the bill`,
          postedBy: 'system',
          lines: usedCents > 0
            ? [{ accountCode: code,                type: 'debit',  amountCents: usedCents,  memo },
               { accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: usedCents,  memo }]
            : [{ accountCode: ACCT.INVENTORY_FOOD, type: 'debit',  amountCents: -usedCents, memo },
               { accountCode: code,                type: 'credit', amountCents: -usedCents, memo }],
        }, { tx })
      }
    }
  }
  return movedCents
}

/**
 * One-off catch-up (BK2-RV-2). Until receiving applied a bill's carried
 * variance itself (RB-3), nothing in production did: a bill booked before its
 * goods kept the carried slice in 1210 for every receipt made before that
 * release. Per PO line of the company's live bills that still carry quantity:
 * the received quantity no live bill has matched yet (received − matched at
 * posting − applied by receipts − legacy bills' billed quantity), at most the
 * carried quantity not yet applied, is applied now through
 * applyCarriedBillVarianceTx (oldest bill first). The share of it still on
 * hand — stock now less what this item received after the line's last
 * receipt — re-averages the item; the rest goes to 5060, dated today.
 * Idempotent: a second run finds nothing unmatched. One company at a time,
 * each PO line in its own transaction; `dryRun` only reports.
 */
export async function applyMissedCarriedBillVariances(opts: { tenantIds: string[]; dryRun: boolean }): Promise<{
  rows: Array<{ tenantId: string; poLineId: string; quantity: number; onHandQty: number; movedCents: number | null }>
  summary: { lines: number; quantity: number }
}> {
  const rows: Array<{ tenantId: string; poLineId: string; quantity: number; onHandQty: number; movedCents: number | null }> = []
  for (const tenantId of opts.tenantIds) {
    const live = await prisma.supplierBill.findMany({
      where:  { status: { not: 'void' }, supplier: { tenantId } },
      select: { id: true },
    })
    const { recorded } = await prisma.$transaction((tx) => varianceRecordsOf(tx, live.map((b) => b.id)))
    const poLineIds = new Set<string>()
    for (const lines of recorded.values()) for (const l of lines) if (l.carriedQty > 1e-9) poLineIds.add(l.poLineId)
    for (const poLineId of poLineIds) {
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = (SELECT "purchaseOrderId" FROM purchase_order_lines WHERE id = ${poLineId}) FOR UPDATE`
        const pl = await tx.purchaseOrderLine.findUnique({
          where:  { id: poLineId },
          select: { quantityReceived: true, inventoryItemId: true, purchaseOrderId: true, purchaseOrder: { select: { supplierId: true } } },
        })
        if (!pl) return
        const billIds = Array.from(new Set((await tx.supplierBillLine.findMany({
          where: { poLineId, bill: { status: { not: 'void' }, supplier: { tenantId } } }, select: { billId: true },
        })).map((b) => b.billId)))
        const { recorded: rec, applied } = await varianceRecordsOf(tx, billIds)
        let carriedLeft = 0
        for (const id of billIds) {
          carriedLeft += (rec.get(id) ?? []).filter((l) => l.poLineId === poLineId).reduce((s, l) => s + l.carriedQty, 0)
          carriedLeft -= (applied.get(id) ?? []).filter((a) => a.poLineId === poLineId).reduce((s, a) => s + a.qty, 0)
        }
        const unmatched = pl.quantityReceived - await matchedByOtherBills(tx, poLineId, '')
        const quantity  = Math.min(Math.max(0, unmatched), Math.max(0, carriedLeft))
        if (!(quantity > 1e-9)) return
        // Stock used oldest first: of the goods this line brought in, what is
        // still here is stock now less what the item received since.
        const last = await tx.goodsReceipt.findFirst({
          where:   { poId: pl.purchaseOrderId, lines: { some: { inventoryItemId: pl.inventoryItemId } } },
          orderBy: { receivedAt: 'desc' },
          select:  { id: true, receivedAt: true },
        })
        await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${pl.inventoryItemId} FOR UPDATE`
        const item = await tx.inventoryItem.findUnique({ where: { id: pl.inventoryItemId }, select: { currentStock: true } })
        const since = last ? await receivedSince(tx, pl.inventoryItemId, last.receivedAt, last.id) : 0
        const onHandQty = Math.min(quantity, Math.max(0, (item?.currentStock ?? 0) - since))
        const movedCents = opts.dryRun ? null : await applyCarriedBillVarianceTx(tx, {
          poLineId, quantity, supplierId: pl.purchaseOrder.supplierId, receiptId: null, onHandQty,
        })
        rows.push({ tenantId, poLineId, quantity, onHandQty, movedCents })
      }, { timeout: 30_000 })
    }
  }
  return { rows, summary: { lines: rows.length, quantity: rows.reduce((s, r) => s + r.quantity, 0) } }
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

    // Price variance against the received cost (header comment, BOH-R2-02):
    // only on the quantity received and not matched by another bill; of that,
    // re-average what is still on hand and expense what was used (5060); the
    // rest is carried in 1210 until it is received.
    const variance = await billVarianceLines(tx, bill, tenantId, { withZero: true })
    const record: BillVarianceRecordLine[] = []
    if (variance.length > 0) {
      // Serialise with receiving (which locks the PO first, then items).
      const poIds = Array.from(new Set(variance.map((v) => v.purchaseOrderId)))
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ANY(${poIds}::text[]) ORDER BY id FOR UPDATE`
    }
    // Received quantity this bill's own earlier lines have already matched,
    // per PO line — two lines of one bill on the same PO line must not both
    // match the same received kilos (RB-4).
    const matchedByThisBill = new Map<string, number>()
    for (const v of variance) {
      const pl = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: v.poLineId }, select: { quantityReceived: true } })
      const available   = Math.max(0, pl.quantityReceived - await matchedByOtherBills(tx, v.poLineId, bill.id) - (matchedByThisBill.get(v.poLineId) ?? 0))
      const receivedQty = Math.min(v.quantity, available)
      matchedByThisBill.set(v.poLineId, (matchedByThisBill.get(v.poLineId) ?? 0) + receivedQty)
      const receivedCents = receivedQty >= v.quantity ? v.varianceCents : Math.round(v.varianceCents * receivedQty / v.quantity)
      const item = await tx.inventoryItem.findUnique({ where: { id: v.inventoryItemId }, select: { currentStock: true } })
      const onHand = Math.max(0, item?.currentStock ?? 0)
      const onHandQty = Math.min(onHand, receivedQty)
      const absorbedCents = receivedQty > 0 && onHandQty > 0
        ? (await revalueItem(tx, {
            inventoryItemId: v.inventoryItemId, poLineId: v.poLineId,
            targetCents: onHandQty >= receivedQty ? receivedCents : Math.round(receivedCents * onHandQty / receivedQty),
            supplierId: bill.supplierId, source: 'bill_match',
          })).moved
        : 0
      record.push({
        poLineId: v.poLineId, inventoryItemId: v.inventoryItemId,
        billedQty: v.quantity, receivedQty, varianceCents: v.varianceCents,
        absorbedCents, onHandAtPosting: onHand, usedCents: receivedCents - absorbedCents,
        carriedQty: v.quantity - receivedQty, carriedCents: v.varianceCents - receivedCents,
      })
    }
    const usedCents = record.reduce((s, l) => s + l.usedCents, 0)
    if (record.length > 0) {
      await tx.auditLog.create({
        data: {
          category: 'accounting', tenantId, action: VARIANCE_ACTION, entity: 'SupplierBill', entityId: bill.id,
          metadata: { lines: record } as unknown as Prisma.InputJsonValue,
        },
      })
    }

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
    // Lock the bill's purchase orders in the order postSupplierBill and
    // receiving use (bill → POs → items), before reading what the bill
    // applied (RB-5): a receipt applying this bill's carried variance either
    // commits first (and its slice is read below) or waits and then sees the
    // bill void (applyCarriedBillVarianceTx reads the status under the lock).
    const linePoIds = bill.lines.map((l) => l.poLineId).filter((x): x is string => !!x)
    if (linePoIds.length > 0) {
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id IN (SELECT DISTINCT "purchaseOrderId" FROM purchase_order_lines WHERE id = ANY(${linePoIds}::text[])) ORDER BY id FOR UPDATE`
    }

    const original = await tx.journalEntry.findFirst({ where: { reference: billRef(billId), tenantId }, select: { id: true } })
    if (!original) return { posted: false, entryId: null, reason: 'bill_not_posted' }
    const already = await tx.journalEntry.findFirst({ where: { reference: `supplier.bill.void:${billId}`, tenantId }, select: { id: true } })
    if (already) return { posted: false, entryId: already.id, reason: 'already_reversed' }

    const result = await reverseJournalEntry(tenantId, 'supplier.bill', billId, reason, {
      tx, suffix: 'void', postedBy: opts.postedBy ?? 'system',
    })

    // Undo the re-average: take out of stock value EXACTLY what the bill put
    // in — at posting and by later receipts of carried quantity (BOH-R2-02) —
    // never a share re-derived from today's stock. A carried variance never
    // applied left stock alone, and the reversal takes it out of 1210 with the
    // rest. If some of the re-valued stock was used in between (at the
    // re-averaged cost), or a receipt expensed part of a carried slice to 5060
    // (BK2-RV-1), 5060 gives the difference back, so 1210 keeps following
    // stock valuation.
    const { recorded, recordedAt, applied } = await varianceRecordsOf(tx, [billId])
    const record = recorded.get(billId)
    let trueUp = 0
    if (record) {
      // Per PO line (a bill may carry two lines on one PO line): each slice
      // the bill put into stock value — at posting, and per receipt of
      // carried quantity — with the stock it was spread over and when.
      const postedAt = recordedAt.get(billId) ?? null
      const byPoLine = new Map<string, { inventoryItemId: string; slices: Array<{ cents: number; onHand: number; at: Date | null; receiptId: string | null }> }>()
      for (const line of record) {
        const g = byPoLine.get(line.poLineId) ?? { inventoryItemId: line.inventoryItemId, slices: [] }
        g.slices.push({ cents: line.absorbedCents, onHand: line.onHandAtPosting, at: postedAt, receiptId: null })
        byPoLine.set(line.poLineId, g)
      }
      for (const [poLineId, g] of byPoLine) {
        for (const a of (applied.get(billId) ?? []).filter((x) => x.poLineId === poLineId)) {
          g.slices.push({ cents: a.absorbedCents, onHand: a.onHand, at: a.at ?? null, receiptId: a.receiptId ?? null })
        }
        const slices = g.slices.filter((x) => x.cents !== 0)
        if (slices.length === 0) continue
        const item = await tx.inventoryItem.findUnique({ where: { id: g.inventoryItemId }, select: { currentStock: true } })
        const onHandNow = Math.max(0, item?.currentStock ?? 0)
        const put = slices.reduce((s, x) => s + x.cents, 0)
        // What of a slice is still in stock (RB-2): stock is used oldest
        // first, so what is on hand now is the newest stock — anything
        // received after the slice is NOT the stock it re-priced. The slice's
        // stock still on hand is on hand now less what arrived since, at
        // most the stock it was spread over; the rest was used (costed out
        // at the re-averaged price) and 5060 gives that part back. (Only
        // goods receipts count as stock arriving; a count that raised stock
        // is not a delivery and is left out.)
        let stillInStock = 0
        for (const x of slices) {
          if (!(x.onHand > 0)) continue
          const since = x.at ? await receivedSince(tx, g.inventoryItemId, x.at, x.receiptId) : 0
          const stillQty = Math.min(x.onHand, Math.max(0, onHandNow - since))
          stillInStock += Math.round(x.cents * stillQty / x.onHand)
        }
        const { moved } = await revalueItem(tx, {
          inventoryItemId: g.inventoryItemId, poLineId, targetCents: -stillInStock,
          supplierId: bill.supplierId, source: 'bill_void',
        })
        // The reversal took `put` out of 1210; stock moved by `moved` (≤ 0).
        trueUp += put + moved
      }
      // What later receipts expensed to 5060 out of the carried variance
      // (BK2-RV-1) was a separate entry the reversal does not touch, while the
      // reversal took the whole carried variance out of 1210: give it back.
      trueUp += (applied.get(billId) ?? []).reduce((s, a) => s + (a.usedCents ?? 0), 0)
    } else {
      // Legacy bill, posted before the record existed: the old derivation.
      const variance = await billVarianceLines(tx, bill, tenantId)
      if (variance.length > 0) {
        const varianceCents = variance.reduce((s, v) => s + v.varianceCents, 0)
        const absorbedAtBill = (await entryNetDebit(tx, original.id, ACCT.INVENTORY_FOOD)) - bill.subtotalCents + varianceCents
        const absorbedNow = await revalueForBillVariance(
          tx,
          variance.map((v) => ({ ...v, varianceCents: -v.varianceCents })),
          { supplierId: bill.supplierId, source: 'bill_void' },
        )
        trueUp = absorbedNow + absorbedAtBill
      }
    }
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
