// Stock postings — every food-cost ledger entry that is not a supplier bill or
// a sale (finance wave B, food cost on FIFO lots, H16-H20).
//
// Every function here:
//   • takes the company from the SOURCE row (the receipt's, the waste log's,
//     the count's, the batch's, the lot's) — never the operator's;
//   • asserts debits == credits before posting, under an idempotent key
//     '<sourceType>:<sourceId>' (postJournalEntry: a replay is a no-op);
//   • uses the class accounts of lib/inventoryClass.ts (food 1210/5010,
//     beverage 1220/5020, packaging 1230/5030);
//   • splits a brand-less amount into brand-tagged pairs by each brand's recipe
//     use of the item (lib/brandShare.ts, H20) and STORES the split it used on
//     the movement rows (StockMovement.brandShares), so the food-cost report
//     reads what was posted;
//   • never changes stock (lots change only through lib/stockLedger.ts).
//
//   1  procurement.receipt:<receiptId>          Dr 12x0 per class / Cr 2015 GRNI            (in the receipt's tx; cash-settled receipts post nothing)
//   2  inventory.waste:<wasteLogId>             Dr 1290 / Cr 12x0 at the FIFO value taken    (brand = the log's, else usage split)
//   3  inventory.count:<countId>                spot: Dr/Cr 1290 vs 12x0; opening: Dr 12x0 / Cr 3010 owner's capital (H19 — never 1290 / 5050)
//   4  inventory.prep_draw:<batchId>            Dr 50x0 / Cr 12x0 at the FIFO value drawn    (ad-hoc batches; usage split)
//   5  procurement.grni_writeoff:<lineId>       Dr 2015 / Cr 5060 for the open unbilled value (usage split)
//   6  inventory.item_reclass:<itemId>:<auditId> Dr new class inventory / Cr old class inventory
//   7  inventory.class_reclass:<tenantId>       Dr 1220 / Dr 1230 / Cr 1210                  (cut-over, once)
//   8  procurement.grni_opening:<tenantId>      Dr 12x0 / Cr 2015 received-unbilled; Dr 2015 / Cr 12x0 billed-ahead (cut-over, once)
//   9  inventory.fifo_align:<tenantId>          Dr/Cr 12x0 vs 3020, prior-period difference  (CEO, once, dry run first)
//  10  inventory.shortfall_settle:<lotId>       Dr 50x0 per brand / Cr 12x0                  (a late receipt settling earlier sales)
//  11  inventory.issue_on_receipt:<lotId>       Dr 50x0 (usage split) / Cr 12x0              (unmeasured consumables)
//
// H20 (owner, 2026-10-14 — "suspense, CEO clears"): waste and count
// differences (2, 3 and inventory/voidWaste.ts postVoidWaste) wait in 1290
// Stock Differences Suspense with their reason; the CEO approves them into
// 5040 / 5050 from Finance → Stock differences (modules/stockDifferences:
// 'stock_difference.clear:<journalLineId>', dated the approval day).
// stockDifferenceAccount() below is THE switch point.
//
// Waste, counts and prep draws are posted inside their document's
// transaction behind a savepoint (postInventoryDocInSavepoint): a refused
// posting never undoes the document — the caller flags it after commit
// (flagPostingFailed) and Reconciliation → Backfill unposted re-posts it
// (reconciliation/backfillOrders.ts REPOSTERS) with RepostOptions. Their
// "nothing to post" reasons are the REPOSTERS' nothingToPost keys.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { sumCents, toCents } from '../../lib/money.js'
import { withSavepoint } from '../../lib/savepoint.js'
import { ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { CLASS_ACCOUNTS, CLASS_LABEL, COST_CLASSES, costClassOf, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { brandSharesJson, brandUsageShares, parseBrandShares, splitCents, type BrandShare } from '../../lib/brandShare.js'
import { lotValuation, readFifoCutoverAt, STOCK_SOURCE } from '../../lib/stockLedger.js'
import {
  ACCT, lateDatingFor, postJournalEntry, withLateNote,
  type JournalLineInput, type PostingFailure, type RepostOptions,
} from './journal.js'
import { unbookedSalesCostByClass } from './cogs.js'

type Tx = Prisma.TransactionClient
type Db = Prisma.TransactionClient | PrismaClient

/** The REPOSTERS' result shape (reconciliation/backfillOrders.ts RepostResult). */
export type PostResult = { posted: boolean; entryId: string | null; reason?: string; amountCents?: number }

export const WASTE_SOURCE_TYPE = 'inventory.waste'
export const COUNT_SOURCE_TYPE = 'inventory.count'
export const PREP_DRAW_SOURCE_TYPE = 'inventory.prep_draw'

/**
 * Waste of a SOLD line (void after fire, cancel after fire, returned food) is
 * booked once per line under 'pos.void_waste:<orderItemId>' by
 * inventory/voidWaste.ts — never again per waste log here. Same list as
 * voidWaste.ts VOID_WASTE_REASONS; kept as literals (not imported) because
 * voidWaste.ts posts through this module, and a top-level read of an import
 * inside that cycle would fail at load.
 */
const SOLD_LINE_WASTE_REASONS: ReadonlySet<string> = new Set(['void_after_fire', 'cancelled_after_fire', 'returned_food'])

const asClass = (v: string): CostClass => ((COST_CLASSES as readonly string[]).includes(v) ? (v as CostClass) : 'food')
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtQty = (q: number) => String(Math.round(q * 1000) / 1000)

// ─── H20: suspense or straight to cost ──────────────────────────────────────

/**
 * Companies whose waste and count differences go STRAIGHT to cost of sales
 * (5040 / 5050) instead of waiting for the CEO in 1290. Empty: the owner's
 * decision (2026-10-14) is suspense for every company.
 */
const STRAIGHT_TO_COST: ReadonlySet<string> = new Set<string>()

/**
 * THE switch point (H20): the account a waste ('waste' — waste logs and
 * sold-line waste) or a count difference ('count') is booked to on the
 * cost side — 1290 Stock Differences Suspense (default, every company) until
 * the CEO approves it (modules/stockDifferences), else 5040 Waste / 5050
 * Inventory Variance directly. The other side (12x0, or 50x0 when the order's
 * cost was already booked) never changes.
 */
export function stockDifferenceAccount(tenantId: string, kind: 'waste' | 'count'): string {
  if (!STRAIGHT_TO_COST.has(tenantId)) return ACCT.STOCK_DIFF_SUSPENSE
  return kind === 'waste' ? ACCT.WASTE : ACCT.INVENTORY_VARIANCE
}

/** The description's tail when a difference waits for the CEO. */
const awaitingCeo = (code: string) => (code === ACCT.STOCK_DIFF_SUSPENSE ? ' — in stock differences (1290) until the CEO approves it' : '')

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Run in the caller's transaction, else in a new one (so stored shares and the entry land together). */
function inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return tx ? fn(tx) : prisma.$transaction((t) => fn(t))
}

function assertBalanced(lines: JournalLineInput[], ref: string): void {
  const dr = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const cr = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  if (dr !== cr) throw new AppError('JOURNAL_UNBALANCED', `${ref}: debits (${dr}) ≠ credits (${cr})`, 500)
}

/**
 * Dr `debit` / Cr `credit` for each brand part of `split` (both lines tagged
 * with the brand; a negative part is the reversed pair).
 */
function brandPairs(debit: string, credit: string, split: Array<{ conceptId: string | null; cents: number }>, memo: { dr: string; cr: string }): JournalLineInput[] {
  const out: JournalLineInput[] = []
  for (const p of split) {
    if (p.cents === 0) continue
    const c = Math.abs(p.cents)
    const [d, k] = p.cents > 0 ? [debit, credit] : [credit, debit]
    out.push({ accountCode: d, type: 'debit',  amountCents: c, memo: memo.dr.slice(0, 250), conceptId: p.conceptId })
    out.push({ accountCode: k, type: 'credit', amountCents: c, memo: memo.cr.slice(0, 250), conceptId: p.conceptId })
  }
  return out
}

function crossCompany(what: string): AppError {
  return new AppError('CROSS_COMPANY_STOCK', `${what} belongs to another company — stock never posts across companies`, 500)
}

interface ShareRow { id: string; brandShares: Prisma.JsonValue | null }

/**
 * The brand split of a brand-less amount: the shares stored on its movement
 * rows, else the usage shares now (H20) — stored on the rows when `store`.
 */
async function sharesFor(db: Db, tenantId: string, itemId: string | null, at: Date, rows: ShareRow[], store: boolean): Promise<BrandShare[]> {
  for (const r of rows) {
    const s = parseBrandShares(r.brandShares)
    if (s) return s
  }
  if (!itemId) return []
  const shares = await brandUsageShares(db, tenantId, itemId, at)
  if (store && rows.length > 0) {
    await db.stockMovement.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { brandShares: brandSharesJson(shares) } })
  }
  return shares
}

/** A brand named on a document must be of the document's company. */
async function assertConceptInCompany(db: Db, conceptId: string | null, tenantId: string): Promise<void> {
  if (!conceptId) return
  const c = await db.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true, name: true } })
  if (!c || c.tenantId !== tenantId) throw crossCompany(`Brand ${c?.name ?? conceptId}`)
}

/** A receipt's supplier (GoodsReceipt has no relation to it — read by id). */
async function supplierOf(db: Db, supplierId: string): Promise<{ name: string; tenantId: string | null }> {
  const s = await db.supplier.findUnique({ where: { id: supplierId }, select: { name: true, tenantId: true } })
  if (!s) throw new AppError('SUPPLIER_NOT_FOUND', `Supplier ${supplierId} not found`, 404)
  return s
}

/** A system posting's date (owner decision 6); refused when the books are closed even through today. */
async function systemDate(tx: Tx, tenantId: string, natural: Date): Promise<{ entryDate: Date; memoNote?: string }> {
  const d = await lateDatingFor(tx, tenantId, natural)
  if ('lockedThroughToday' in d) {
    throw new AppError('PERIOD_LOCKED', 'The books are closed through today — nothing can post until today is open.', 422)
  }
  return d
}

// ─── 1. Goods receipt (H17) ──────────────────────────────────────────────────

/**
 * 'procurement.receipt:<receiptId>': Dr 1210/1220/1230 per class for the
 * value of the lots the receipt opened (their 'receipt' movements — a
 * pending-bill quantity's lot is at the billed price, so its 2015 credit nets
 * that bill's pending debit) / Cr 2015. Brand-less, dated receivedAt, in the
 * company of the receipt (its supplier's). A cash-settled receipt (decision
 * P6) posts NOTHING — the cash document books Dr 12x0 / Cr its cash account.
 * Runs in the receipt's transaction; a refusal throws (the receipt rolls back).
 */
export async function postGoodsReceiptTx(tx: Tx, receiptId: string): Promise<{ posted: boolean; reason?: 'settled_by_cash'; entryId?: string }> {
  const receipt = await tx.goodsReceipt.findUnique({
    where: { id: receiptId },
    select: { id: true, tenantId: true, supplierId: true, receivedAt: true, receivedById: true, settledByType: true },
  })
  if (!receipt) throw new AppError('RECEIPT_NOT_FOUND', `Goods receipt ${receiptId} not found`, 404)
  if (receipt.settledByType) return { posted: false, reason: 'settled_by_cash' }
  const supplier = await supplierOf(tx, receipt.supplierId)
  const tenantId = receipt.tenantId ?? supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', `Assign ${supplier.name} to a company before receiving from it`, 422)
  if (supplier.tenantId && supplier.tenantId !== tenantId) throw crossCompany(`Supplier ${supplier.name}`)

  const lineIds = (await tx.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: { id: true } })).map((l) => l.id)
  const lots = lineIds.length === 0 ? [] : await tx.stockLot.findMany({
    where: { receiptLineId: { in: lineIds } },
    select: { id: true, tenantId: true },
  })
  for (const l of lots) if (l.tenantId !== tenantId) throw crossCompany(`Lot ${l.id}`)
  const ins = lots.length === 0 ? [] : await tx.stockMovement.findMany({
    where: { lotId: { in: lots.map((l) => l.id) }, kind: 'receipt' },
    select: { valueCents: true, costClass: true },
  })
  const byClass = zeroByClass()
  for (const m of ins) byClass[asClass(m.costClass)] += toCents(m.valueCents)
  const total = COST_CLASSES.reduce((s, c) => s + byClass[c], 0)
  if (total <= 0) return { posted: false }

  const ref = `GRN ${receipt.id.slice(-8).toUpperCase()}`
  const lines: JournalLineInput[] = []
  for (const c of COST_CLASSES) {
    if (byClass[c] > 0) lines.push({ accountCode: CLASS_ACCOUNTS[c].inv, type: 'debit', amountCents: byClass[c], memo: `Goods received (${CLASS_LABEL[c]}) — ${supplier.name}, ${ref}`.slice(0, 250) })
  }
  lines.push({ accountCode: ACCT.GRNI, type: 'credit', amountCents: total, memo: `Received, not yet billed — ${supplier.name}, ${ref}`.slice(0, 250) })
  assertBalanced(lines, `procurement.receipt:${receipt.id}`)
  const r = await postJournalEntry({
    tenantId, sourceType: 'procurement.receipt', sourceId: receipt.id,
    description: `Goods received from ${supplier.name} (${ref}) — ${pkr(total)}`,
    entryDate: receipt.receivedAt, postedBy: receipt.receivedById, lines,
  }, { tx })
  return { posted: r.posted, entryId: r.entryId }
}

// ─── 2. Waste ────────────────────────────────────────────────────────────────

/**
 * 'inventory.waste:<wasteLogId>': Dr 1290 Stock Differences Suspense (H20 —
 * stockDifferenceAccount; 5040 only for a company set straight to cost) / Cr
 * the class inventory at
 * WasteLog.estimatedCostCents (the FIFO value taken; a pre-FIFO log without it
 * is valued at the item's cost × quantity), in the log's company (= the
 * item's), dated recordedAt. Brand = the log's conceptId, else the usage split
 * (stored on the log's 'waste' movements). Sold-line waste is 'booked_by_void'.
 * `opts.tx` posts inside the caller's transaction (wrap it in a savepoint —
 * postInventoryDocInSavepoint); a refusal throws.
 */
export async function postWasteLog(wasteLogId: string, opts: RepostOptions & { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const log = await tx.wasteLog.findUnique({
      where: { id: wasteLogId },
      select: {
        id: true, tenantId: true, conceptId: true, reason: true, quantity: true, unit: true, estimatedCostCents: true,
        recordedAt: true, recordedById: true, inventoryItemId: true,
        inventoryItem: { select: { name: true, tenantId: true, category: true, unitCostCents: true } },
      },
    })
    if (!log) return { posted: false, entryId: null, reason: 'waste_log_not_found' }
    if (SOLD_LINE_WASTE_REASONS.has(log.reason)) return { posted: false, entryId: null, reason: 'booked_by_void' }
    const tenantId = log.tenantId ?? log.inventoryItem.tenantId
    if (!tenantId) return { posted: false, entryId: null, reason: 'item_has_no_company' }
    if (log.inventoryItem.tenantId && log.inventoryItem.tenantId !== tenantId) throw crossCompany(log.inventoryItem.name)

    const cost = log.estimatedCostCents ?? Math.round((log.inventoryItem.unitCostCents ?? 0) * log.quantity)
    if (!(cost > 0)) return { posted: false, entryId: null, reason: 'zero_cost' }
    await assertConceptInCompany(tx, log.conceptId, tenantId)

    const rows = await tx.stockMovement.findMany({
      where: { tenantId, sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, kind: 'waste', inventoryItemId: log.inventoryItemId },
      select: { id: true, costClass: true, brandShares: true },
    })
    const cls = rows[0] ? asClass(rows[0].costClass) : costClassOf(log.inventoryItem.category)
    const split = log.conceptId
      ? [{ conceptId: log.conceptId, cents: cost }]
      : splitCents(cost, await sharesFor(tx, tenantId, log.inventoryItemId, log.recordedAt, rows, true))
    const what = `${fmtQty(log.quantity)} ${log.unit} ${log.inventoryItem.name} (${log.reason})`
    const costSide = stockDifferenceAccount(tenantId, 'waste')
    const lines = brandPairs(costSide, CLASS_ACCOUNTS[cls].inv, split, {
      dr: `Waste: ${what}`, cr: `Inventory derecognised (waste, ${CLASS_LABEL[cls]}, ${log.reason}) — ${log.inventoryItem.name}`,
    })
    assertBalanced(lines, `inventory.waste:${log.id}`)
    const late = withLateNote(`Waste — ${log.inventoryItem.name} (${log.reason}), ${pkr(cost)}${awaitingCeo(costSide)}`, lines, opts.memoNote)
    const r = await postJournalEntry({
      tenantId, sourceType: WASTE_SOURCE_TYPE, sourceId: log.id, description: late.description,
      entryDate: opts.entryDate ?? log.recordedAt, postedBy: opts.postedBy ?? log.recordedById ?? 'system', lines: late.lines,
    }, { tx })
    return { posted: r.posted, entryId: r.entryId, amountCents: cost }
  })
}

// ─── 3. Stock counts ─────────────────────────────────────────────────────────

type CountAdjustment =
  | { ok: false; reason: 'count_not_found' | 'count_has_no_company' }
  | {
      ok: true; tenantId: string; kind: string; countedAt: Date; countedById: string
      lines: JournalLineInput[]; shortCents: number; overCents: number
    }

/**
 * A count's ledger lines from its STORED values (PhysicalCountLine.valueCents,
 * signed: negative short — the FIFO value of the count_loss — positive over —
 * the count_gain lot — or an opening lot). Spot (H20 — stockDifferenceAccount,
 * 1290 until the CEO approves it; 5050 only for a company set straight to
 * cost): short Dr 1290 / Cr 12x0, over Dr 12x0 / Cr 1290, brand split from
 * the shares stored on the line's
 * movements (else usage now — stored when `store`). Opening (H19, accountant
 * 2026-10-14): Dr 12x0 / Cr 3010 owner's capital, brand-less, never 5050. A pre-FIFO line with no stored value is
 * valued at the item's unit cost × the difference (the old rule). Lines of
 * another company's item are skipped.
 */
async function buildCountAdjustment(db: Db, countId: string, store: boolean): Promise<CountAdjustment> {
  const count = await db.physicalCount.findUnique({
    where: { id: countId },
    select: {
      id: true, tenantId: true, kind: true, countedAt: true, countedById: true,
      lines: { select: { id: true, inventoryItemId: true, systemQty: true, physicalQty: true, valueCents: true } },
    },
  })
  if (!count) return { ok: false, reason: 'count_not_found' }
  if (!count.tenantId) return { ok: false, reason: 'count_has_no_company' }
  const tenantId = count.tenantId
  const items = await db.inventoryItem.findMany({
    where: { id: { in: count.lines.map((l) => l.inventoryItemId) } },
    select: { id: true, name: true, unit: true, unitCostCents: true, tenantId: true, category: true },
  })
  const itemById = new Map(items.map((i) => [i.id, i]))
  const moves = count.lines.length === 0 ? [] : await db.stockMovement.findMany({
    where: { tenantId, sourceType: STOCK_SOURCE.countLine, sourceId: { in: count.lines.map((l) => l.id) } },
    select: { id: true, sourceId: true, costClass: true, brandShares: true },
  })

  const lines: JournalLineInput[] = []
  let shortCents = 0
  let overCents = 0
  const diffSide = stockDifferenceAccount(tenantId, 'count')
  for (const l of count.lines) {
    const item = itemById.get(l.inventoryItemId)
    if (!item || item.tenantId !== tenantId) continue   // never value another company's item into this company's books
    const stored = l.valueCents == null ? null : toCents(l.valueCents)
    const value = stored ?? (count.kind === 'spot' ? Math.round((l.physicalQty - l.systemQty) * (item.unitCostCents ?? 0)) : 0)
    if (value === 0) continue
    const rows = moves.filter((m) => m.sourceId === l.id)
    const cls = rows[0] ? asClass(rows[0].costClass) : costClassOf(item.category)
    const inv = CLASS_ACCOUNTS[cls].inv
    const memo = `${item.name}: system ${fmtQty(l.systemQty)} ${item.unit}, counted ${fmtQty(l.physicalQty)} ${item.unit}`
    if (count.kind === 'opening') {
      const v = Math.abs(value)
      overCents += v
      lines.push({ accountCode: inv, type: 'debit', amountCents: v, memo: `Opening stock — ${memo}`.slice(0, 250) })
      lines.push({ accountCode: ACCT.OWNERS_CAPITAL, type: 'credit', amountCents: v, memo: `Opening stock found by the first count (H19, owner's capital) — ${item.name}`.slice(0, 250) })
      continue
    }
    const shares = await sharesFor(db, tenantId, item.id, count.countedAt, rows, store)
    if (value < 0) {
      shortCents += -value
      lines.push(...brandPairs(diffSide, inv, splitCents(-value, shares), { dr: `Count short — ${memo}`, cr: `Count short — ${memo}` }))
    } else {
      overCents += value
      lines.push(...brandPairs(inv, diffSide, splitCents(value, shares), { dr: `Count over — ${memo}`, cr: `Count over — ${memo}` }))
    }
  }
  return { ok: true, tenantId, kind: count.kind, countedAt: count.countedAt, countedById: count.countedById, lines, shortCents, overCents }
}

/** A count's adjustment lines without posting (the backfill's preview reads it). Same shape as the old countPosting.ts export. */
export async function stockCountAdjustment(countId: string, db: Db = prisma): Promise<CountAdjustment> {
  return buildCountAdjustment(db, countId, false)
}

/**
 * 'inventory.count:<countId>' in the count's company, dated countedAt (or as
 * `opts` re-dates a refused one). Reasons: count_not_found,
 * count_has_no_company, no_variance. `opts.tx` posts inside the caller's
 * transaction (savepoint it); a refusal throws.
 */
export async function postStockCount(countId: string, opts: RepostOptions & { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const adj = await buildCountAdjustment(tx, countId, true)
    if (!adj.ok) return { posted: false, entryId: null, reason: adj.reason }
    if (adj.lines.length === 0) return { posted: false, entryId: null, reason: 'no_variance' }
    assertBalanced(adj.lines, `inventory.count:${countId}`)
    const description = adj.kind === 'opening'
      ? `Opening stock count — ${pkr(adj.overCents)} to owner's capital (H19)`
      : `Stock count adjustment — short ${pkr(adj.shortCents)}, over ${pkr(adj.overCents)}${awaitingCeo(stockDifferenceAccount(adj.tenantId, 'count'))}`
    const late = withLateNote(description, adj.lines, opts.memoNote)
    const r = await postJournalEntry({
      tenantId: adj.tenantId, sourceType: COUNT_SOURCE_TYPE, sourceId: countId, description: late.description,
      entryDate: opts.entryDate ?? adj.countedAt, postedBy: opts.postedBy ?? adj.countedById, lines: late.lines,
    }, { tx })
    return { posted: r.posted, entryId: r.entryId, amountCents: adj.shortCents - adj.overCents }
  })
}

// ─── 4. Ad-hoc prep draw ─────────────────────────────────────────────────────

/**
 * 'inventory.prep_draw:<batchId>': an AD-HOC prep batch (no recipe) drew its
 * inputs from the lots: Dr 50x0 / Cr 12x0 per item at the value drawn (its
 * 'prep_draw' movements; else PrepBatch.drawValueCents as food), brand split
 * by usage (stored on the movements). In the batch's company, dated createdAt.
 * Reasons: batch_not_found, not_ad_hoc (a sub-recipe batch is a yield record —
 * the sale explosion consumes its inputs), batch_has_no_company, zero_value.
 */
export async function postPrepDraw(batchId: string, opts: RepostOptions & { tx?: Tx } = {}): Promise<PostResult> {
  return inTx(opts.tx, async (tx) => {
    const batch = await tx.prepBatch.findUnique({
      where: { id: batchId },
      select: { id: true, tenantId: true, recipeId: true, itemName: true, drawValueCents: true, createdAt: true, staffId: true },
    })
    if (!batch) return { posted: false, entryId: null, reason: 'batch_not_found' }
    if (batch.recipeId) return { posted: false, entryId: null, reason: 'not_ad_hoc' }
    if (!batch.tenantId) return { posted: false, entryId: null, reason: 'batch_has_no_company' }
    const tenantId = batch.tenantId

    const rows = await tx.stockMovement.findMany({
      where: { tenantId, sourceType: STOCK_SOURCE.prepBatch, sourceId: batch.id, kind: 'prep_draw' },
      select: { id: true, inventoryItemId: true, costClass: true, valueCents: true, brandShares: true },
    })
    const lines: JournalLineInput[] = []
    let total = 0
    if (rows.length > 0) {
      const names = new Map((await tx.inventoryItem.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.inventoryItemId))] } }, select: { id: true, name: true },
      })).map((i) => [i.id, i.name]))
      const byItemClass = new Map<string, { itemId: string; cls: CostClass; cents: number; rows: ShareRow[] }>()
      for (const r of rows) {
        const cls = asClass(r.costClass)
        const key = `${r.inventoryItemId}|${cls}`
        const g = byItemClass.get(key) ?? { itemId: r.inventoryItemId, cls, cents: 0, rows: [] }
        g.cents += -toCents(r.valueCents)
        g.rows.push(r)
        byItemClass.set(key, g)
      }
      for (const g of byItemClass.values()) {
        if (g.cents === 0) continue
        total += g.cents
        const shares = await sharesFor(tx, tenantId, g.itemId, batch.createdAt, g.rows, true)
        const name = names.get(g.itemId) ?? g.itemId
        lines.push(...brandPairs(CLASS_ACCOUNTS[g.cls].cogs, CLASS_ACCOUNTS[g.cls].inv, splitCents(g.cents, shares), {
          dr: `Prep draw — ${name} for ${batch.itemName}`, cr: `Inventory drawn for prep (${CLASS_LABEL[g.cls]}) — ${name}`,
        }))
      }
    } else {
      total = toCents(batch.drawValueCents) ?? 0
      if (total > 0) {
        lines.push({ accountCode: ACCT.FOOD_COST, type: 'debit', amountCents: total, memo: `Prep draw — ${batch.itemName}`.slice(0, 250) })
        lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: total, memo: `Inventory drawn for prep — ${batch.itemName}`.slice(0, 250) })
      }
    }
    if (!(total > 0) || lines.length === 0) return { posted: false, entryId: null, reason: 'zero_value' }
    assertBalanced(lines, `inventory.prep_draw:${batch.id}`)
    const late = withLateNote(`Prep draw — ${batch.itemName}, ${pkr(total)}`, lines, opts.memoNote)
    const r = await postJournalEntry({
      tenantId, sourceType: PREP_DRAW_SOURCE_TYPE, sourceId: batch.id, description: late.description,
      entryDate: opts.entryDate ?? batch.createdAt, postedBy: opts.postedBy ?? batch.staffId, lines: late.lines,
    }, { tx })
    return { posted: r.posted, entryId: r.entryId, amountCents: total }
  })
}

// ─── Waste / count / prep inside their document's transaction ────────────────

export type InventoryDocPosting = typeof WASTE_SOURCE_TYPE | typeof COUNT_SOURCE_TYPE | typeof PREP_DRAW_SOURCE_TYPE

const DOC_POSTING: Record<InventoryDocPosting, { entityType: string; title: string; post: (id: string, tx: Tx) => Promise<PostResult> }> = {
  'inventory.waste':     { entityType: 'WasteLog',      title: 'Waste did not reach the ledger',                  post: (id, tx) => postWasteLog(id, { tx }) },
  'inventory.count':     { entityType: 'PhysicalCount', title: 'Stock count adjustment did not reach the ledger', post: (id, tx) => postStockCount(id, { tx }) },
  'inventory.prep_draw': { entityType: 'PrepBatch',     title: 'Prep draw did not reach the ledger',              post: (id, tx) => postPrepDraw(id, { tx }) },
}

/**
 * Post a waste log / count / prep batch inside its document's transaction
 * behind a savepoint: a refused posting rolls back only its own writes, the
 * document stands. Returns the ledger result for the response and, on a
 * refusal, the PostingFailure the caller raises AFTER commit:
 * `if (failure) await flagPostingFailed(failure)` (the existing REPOSTERS
 * re-post it).
 */
export async function postInventoryDocInSavepoint(
  tx: Tx, kind: InventoryDocPosting, id: string,
  o: { tenantId: string | null; actorId?: string | null; conceptId?: string | null; amountCents?: number | null } = { tenantId: null },
): Promise<{ ledger: { posted: boolean; entryId?: string; reason?: string; error?: string }; failure: PostingFailure | null }> {
  const meta = DOC_POSTING[kind]
  const r = await withSavepoint(tx, 'inventory_doc_posting', () => meta.post(id, tx))
  if (r.ok) {
    return { ledger: { posted: r.value.posted, ...(r.value.entryId ? { entryId: r.value.entryId } : {}), ...(r.value.reason ? { reason: r.value.reason } : {}) }, failure: null }
  }
  const code = (r.error as { code?: string }).code
  const reason = `${code ? `${code}: ` : ''}${r.error.message}`
  return {
    ledger: { posted: false, error: r.error.message },
    failure: {
      tenantId: o.tenantId, sourceType: kind, sourceId: id, entityType: meta.entityType, entityId: id,
      reason, title: meta.title, actorId: o.actorId ?? null, conceptId: o.conceptId ?? null, amountCents: o.amountCents ?? null,
    },
  }
}

// ─── 5. GRNI write-off ───────────────────────────────────────────────────────

/**
 * 'procurement.grni_writeoff:<receiptLineId>': the supplier will never bill
 * what was received — Dr 2015 for the line's open unbilled value / Cr 5060
 * split by brand usage. Open value = the line's lot-in value (its 'receipt'
 * movements) − what live bill matches cleared; a pre-FIFO line with no lots =
 * (received − billed) × its cost. In the receipt's company, dated now. 409
 * NOTHING_OPEN when nothing is open. The request / CEO approval flow is the
 * caller's (procurement/grniRoutes.ts).
 */
export async function postGrniWriteOffTx(tx: Tx, receiptLineId: string, actor: { id: string }): Promise<{ entryId: string; valueCents: number }> {
  const line = await tx.goodsReceiptLine.findUnique({
    where: { id: receiptLineId },
    select: {
      id: true, inventoryItemId: true, description: true, receivedQty: true, billedQty: true, lotUnitCostCents: true, poUnitCostCents: true,
      receipt: { select: { id: true, tenantId: true, supplierId: true } },
      lots: { select: { id: true, tenantId: true } },
    },
  })
  if (!line) throw new AppError('RECEIPT_LINE_NOT_FOUND', `Receipt line ${receiptLineId} not found`, 404)
  const supplier = await supplierOf(tx, line.receipt.supplierId)
  const tenantId = line.receipt.tenantId ?? supplier.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', `Assign ${supplier.name} to a company first`, 422)
  for (const l of line.lots) if (l.tenantId !== tenantId) throw crossCompany(`Lot ${l.id}`)

  let open: number
  if (line.lots.length > 0) {
    const received = await tx.stockMovement.aggregate({
      where: { lotId: { in: line.lots.map((l) => l.id) }, kind: 'receipt' },
      _sum: { valueCents: true },
    })
    const matched = await tx.grniMatch.aggregate({
      where: { receiptLineId: line.id, status: 'live', tenantId },
      _sum: { grniCents: true },
    })
    open = sumCents(received._sum.valueCents) - sumCents(matched._sum.grniCents)
  } else {
    const qty = Math.max(0, line.receivedQty - line.billedQty)
    open = Math.round(qty * (line.lotUnitCostCents ?? line.poUnitCostCents ?? 0))
  }
  if (!(open > 0)) throw new AppError('NOTHING_OPEN', 'Nothing on this receipt line is waiting for a bill', 409)

  const shares = line.inventoryItemId ? await brandUsageShares(tx, tenantId, line.inventoryItemId, new Date()) : []
  const what = `${line.description} — ${supplier.name}, GRN ${line.receipt.id.slice(-8).toUpperCase()}`
  const lines: JournalLineInput[] = [
    { accountCode: ACCT.GRNI, type: 'debit', amountCents: open, memo: `Received, never to be billed — ${what}`.slice(0, 250) },
    ...splitCents(open, shares).map((p) => ({
      accountCode: ACCT.COST_ADJUSTMENT, type: 'credit' as const, amountCents: p.cents, conceptId: p.conceptId,
      memo: `Unbilled receipt written off — ${what}`.slice(0, 250),
    })),
  ]
  assertBalanced(lines, `procurement.grni_writeoff:${line.id}`)
  const r = await postJournalEntry({
    tenantId, sourceType: 'procurement.grni_writeoff', sourceId: line.id,
    description: `Received not invoiced written off — ${what}, ${pkr(open)}`, postedBy: actor.id, entryDate: new Date(), lines,
  }, { tx })
  return { entryId: r.entryId, valueCents: open }
}

// ─── 6-8. Class changes and the cut-over ─────────────────────────────────────

/**
 * 'inventory.item_reclass:<itemId>:<auditLogId>': an item's category moved
 * it from one class to another — Dr the new class inventory / Cr the old at
 * the value of its open lots (stockLedger reclassItemLotsTx moves the lots).
 * In the item's company, dated now, inside the edit's transaction (a refusal
 * is 422 and nothing changes).
 */
export async function postItemReclassTx(tx: Tx, a: { itemId: string; auditLogId: string; fromClass: CostClass; toClass: CostClass; valueCents: number }): Promise<void> {
  if (a.fromClass === a.toClass || a.valueCents === 0) return
  if (!Number.isInteger(a.valueCents)) throw new AppError('JOURNAL_NOT_INTEGER', 'A class change value must be whole paisa', 500)
  const item = await tx.inventoryItem.findUnique({ where: { id: a.itemId }, select: { name: true, tenantId: true } })
  if (!item) throw new AppError('ITEM_NOT_FOUND', `Inventory item ${a.itemId} not found`, 404)
  if (!item.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', `${item.name} belongs to no company`, 422)
  const memo = `${item.name}: ${CLASS_LABEL[a.fromClass]} → ${CLASS_LABEL[a.toClass]}`
  const lines = brandPairs(CLASS_ACCOUNTS[a.toClass].inv, CLASS_ACCOUNTS[a.fromClass].inv, [{ conceptId: null, cents: a.valueCents }], {
    dr: `Stock moved class — ${memo}`, cr: `Stock moved class — ${memo}`,
  })
  assertBalanced(lines, `inventory.item_reclass:${a.itemId}`)
  await postJournalEntry({
    tenantId: item.tenantId, sourceType: 'inventory.item_reclass', sourceId: `${a.itemId}:${a.auditLogId}`,
    description: `Stock class change — ${memo}, ${pkr(Math.abs(a.valueCents))}`, entryDate: new Date(), lines,
  }, { tx })
}

function assertByClass(byClass: Record<CostClass, number>, what: string): void {
  for (const c of COST_CLASSES) {
    const v = byClass[c] ?? 0
    if (!Number.isInteger(v) || v < 0) throw new AppError('INVALID_AMOUNT', `${what}: ${c} must be whole paisa, zero or more`, 500)
  }
}

/**
 * 'inventory.class_reclass:<tenantId>' (FIFO cut-over, once): the cut-over
 * value of drinks and packaging leaves 1210 for its own class — Dr 1220
 * (beverage) and Dr 1230 (packaging) / Cr 1210. Brand-less, dated now.
 */
export async function postClassReclassTx(tx: Tx, tenantId: string, byClass: Record<CostClass, number>): Promise<void> {
  assertByClass(byClass, 'Class reclass')
  const bev = byClass.beverage ?? 0
  const pack = byClass.packaging ?? 0
  if (bev + pack === 0) return
  const lines: JournalLineInput[] = []
  if (bev > 0) lines.push({ accountCode: ACCT.INVENTORY_BEVERAGE, type: 'debit', amountCents: bev, memo: 'FIFO cut-over: drinks stock out of 1210' })
  if (pack > 0) lines.push({ accountCode: ACCT.INVENTORY_PACKAGING, type: 'debit', amountCents: pack, memo: 'FIFO cut-over: packaging stock out of 1210' })
  lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: bev + pack, memo: 'FIFO cut-over: drinks and packaging to their own accounts' })
  assertBalanced(lines, `inventory.class_reclass:${tenantId}`)
  await postJournalEntry({
    tenantId, sourceType: 'inventory.class_reclass', sourceId: tenantId,
    description: `FIFO cut-over — drinks ${pkr(bev)} and packaging ${pkr(pack)} moved out of Inventory – Food`, entryDate: new Date(), lines,
  }, { tx })
}

/**
 * 'procurement.grni_opening:<tenantId>' (FIFO cut-over, once): per class,
 * Dr 12x0 / Cr 2015 for PO quantity received but not billed (at the PO cost —
 * the old receipts booked nothing), and Dr 2015 / Cr 12x0 for quantity billed
 * ahead of receipt (at the billed price — the old bills booked 12x0). Dated now.
 */
export async function postGrniOpeningTx(tx: Tx, tenantId: string, a: { received: Record<CostClass, number>; billedAhead: Record<CostClass, number> }): Promise<void> {
  assertByClass(a.received, 'GRNI opening (received)')
  assertByClass(a.billedAhead, 'GRNI opening (billed ahead)')
  const lines: JournalLineInput[] = []
  for (const c of COST_CLASSES) {
    const rec = a.received[c] ?? 0
    const ahead = a.billedAhead[c] ?? 0
    if (rec > 0) {
      lines.push({ accountCode: CLASS_ACCOUNTS[c].inv, type: 'debit', amountCents: rec, memo: `FIFO cut-over: ${CLASS_LABEL[c]} received, not yet billed` })
      lines.push({ accountCode: ACCT.GRNI, type: 'credit', amountCents: rec, memo: `FIFO cut-over: ${CLASS_LABEL[c]} received, not yet billed` })
    }
    if (ahead > 0) {
      lines.push({ accountCode: ACCT.GRNI, type: 'debit', amountCents: ahead, memo: `FIFO cut-over: ${CLASS_LABEL[c]} billed, not yet received` })
      lines.push({ accountCode: CLASS_ACCOUNTS[c].inv, type: 'credit', amountCents: ahead, memo: `FIFO cut-over: ${CLASS_LABEL[c]} billed, not yet received` })
    }
  }
  if (lines.length === 0) return
  assertBalanced(lines, `procurement.grni_opening:${tenantId}`)
  await postJournalEntry({
    tenantId, sourceType: 'procurement.grni_opening', sourceId: tenantId,
    description: 'FIFO cut-over — goods received not invoiced opened (H17)', entryDate: new Date(), lines,
  }, { tx })
}

// ─── 9. FIFO alignment ───────────────────────────────────────────────────────

/**
 * 'inventory.fifo_align:<tenantId>' — the CEO aligns 1210 / 1220 / 1230 with
 * the lots once, after the cut-over: per class, difference = lot value +
 * reconciling items − GL balance, posted Dr/Cr 12x0 against 3020 (a prior-
 * period difference; the report shows it on its own line, never as
 * unexplained). Reconciling items = cost already out of the lots but not yet
 * booked (open orders, and till orders whose home drawer's close is not
 * posted — an open ticket whose first drawer closed is already booked; cogs.ts
 * unbookedSalesCostByClass), or what the caller passes (the valuation
 * report's own figure). `dryRun` only computes. 409 CUTOVER_NOT_RUN before the
 * cut-over; 409 ALREADY_ALIGNED once posted. Nothing to align → posted false.
 */
export async function postFifoAlign(
  tenantId: string,
  o: { dryRun: boolean; actor: { id: string }; reconcilingByClass?: Record<CostClass, number> },
): Promise<{ byClass: Record<CostClass, number>; posted: boolean }> {
  if (!(await readFifoCutoverAt(prisma, tenantId))) {
    throw new AppError('CUTOVER_NOT_RUN', 'This company\'s stock has not been cut over to FIFO lots yet — nothing to align.', 409)
  }
  const ref = `inventory.fifo_align:${tenantId}`
  const already = () => prisma.journalEntry.findFirst({ where: { tenantId, reference: ref }, select: { id: true } })
  if (await already()) throw new AppError('ALREADY_ALIGNED', 'Inventory was already aligned with the FIFO lots — it is done once.', 409)

  const compute = async (db: Db): Promise<Record<CostClass, number>> => {
    const lots = await lotValuation(db, tenantId)
    const rec = o.reconcilingByClass ?? await unbookedSalesCostByClass(db, tenantId)
    const gl = await ledgerBalancesByCode(tenantId, COST_CLASSES.map((c) => CLASS_ACCOUNTS[c].inv), { db })
    const out = zeroByClass()
    for (const c of COST_CLASSES) out[c] = lots[c] + (rec[c] ?? 0) - (gl.get(CLASS_ACCOUNTS[c].inv) ?? 0)
    return out
  }
  if (o.dryRun) return { byClass: await compute(prisma), posted: false }

  return prisma.$transaction(async (tx) => {
    const byClass = await compute(tx)
    const lines: JournalLineInput[] = []
    for (const c of COST_CLASSES) {
      const d = byClass[c]
      if (d === 0) continue
      const memo = `FIFO alignment (${CLASS_LABEL[c]}): lots ${d > 0 ? 'above' : 'below'} the books — prior-period difference`
      lines.push(...brandPairs(CLASS_ACCOUNTS[c].inv, ACCT.RETAINED_EARNINGS, [{ conceptId: null, cents: d }], { dr: memo, cr: memo }))
    }
    if (lines.length === 0) return { byClass, posted: false }
    assertBalanced(lines, ref)
    const r = await postJournalEntry({
      tenantId, sourceType: 'inventory.fifo_align', sourceId: tenantId,
      description: 'Inventory aligned with the FIFO lots (prior-period difference to retained earnings)',
      entryDate: new Date(), postedBy: o.actor.id, lines,
    }, { tx })
    if (!r.posted) throw new AppError('ALREADY_ALIGNED', 'Inventory was already aligned with the FIFO lots — it is done once.', 409)
    return { byClass, posted: true }
  })
}

// ─── 10-11. Postings made by stockLedger.addLotTx ────────────────────────────

/**
 * 'inventory.shortfall_settle:<lotId>': a receipt lot settled sales that had
 * cooked stock not yet on the books — Dr 50x0 / Cr 12x0 per (brand, class), at
 * this lot's value. In the lot's company, dated its receivedAt (owner decision
 * 6 if that month is closed).
 */
export async function postShortfallSettleTx(tx: Tx, a: { lotId: string; byConcept: Array<{ conceptId: string | null; costClass: CostClass; cents: number }> }): Promise<void> {
  const lot = await tx.stockLot.findUnique({
    where: { id: a.lotId },
    select: { tenantId: true, receivedAt: true, inventoryItem: { select: { name: true } } },
  })
  if (!lot) throw new AppError('LOT_NOT_FOUND', `Stock lot ${a.lotId} not found`, 404)
  const lines: JournalLineInput[] = []
  let total = 0
  for (const b of a.byConcept) {
    if (!Number.isInteger(b.cents) || b.cents < 0) throw new AppError('INVALID_AMOUNT', 'A settled amount must be whole paisa, zero or more', 500)
    if (b.cents === 0) continue
    total += b.cents
    const cls = asClass(b.costClass)
    lines.push(...brandPairs(CLASS_ACCOUNTS[cls].cogs, CLASS_ACCOUNTS[cls].inv, [{ conceptId: b.conceptId, cents: b.cents }], {
      dr: `COGS (${CLASS_LABEL[cls]}) — ${lot.inventoryItem.name} cooked before its delivery was entered`,
      cr: `Inventory used (${CLASS_LABEL[cls]}) — ${lot.inventoryItem.name}, settled from the late delivery`,
    }))
  }
  if (lines.length === 0) return
  assertBalanced(lines, `inventory.shortfall_settle:${a.lotId}`)
  const when = await systemDate(tx, lot.tenantId, lot.receivedAt)
  const late = withLateNote(`Sales cooked before the delivery was entered — ${lot.inventoryItem.name}, ${pkr(total)}`, lines, when.memoNote)
  await postJournalEntry({
    tenantId: lot.tenantId, sourceType: 'inventory.shortfall_settle', sourceId: a.lotId,
    description: late.description, entryDate: when.entryDate, lines: late.lines,
  }, { tx })
}

/**
 * 'inventory.issue_on_receipt:<lotId>': an unmeasured consumable (oil, salt)
 * was issued to cost on arrival — Dr 50x0 / Cr 12x0 at the value issued, split
 * by the brand shares stored on its 'issue_on_receipt' movement (brand-less
 * when none). In the lot's company, dated its receivedAt.
 */
export async function postIssueOnReceiptTx(tx: Tx, a: { lotId: string }): Promise<void> {
  const rows = await tx.stockMovement.findMany({
    where: { lotId: a.lotId, kind: 'issue_on_receipt' },
    select: { id: true, tenantId: true, inventoryItemId: true, valueCents: true, costClass: true, brandShares: true, occurredAt: true },
  })
  if (rows.length === 0) return
  const first = rows[0]!
  const lot = await tx.stockLot.findUnique({ where: { id: a.lotId }, select: { tenantId: true, inventoryItem: { select: { name: true } } } })
  if (!lot) throw new AppError('LOT_NOT_FOUND', `Stock lot ${a.lotId} not found`, 404)
  for (const r of rows) if (r.tenantId !== lot.tenantId) throw crossCompany(`Lot ${a.lotId}`)
  const value = -rows.reduce((s, r) => s + toCents(r.valueCents), 0)
  if (value <= 0) return
  const cls = asClass(first.costClass)
  const shares = await sharesFor(tx, lot.tenantId, first.inventoryItemId, first.occurredAt, rows, true)
  const lines = brandPairs(CLASS_ACCOUNTS[cls].cogs, CLASS_ACCOUNTS[cls].inv, splitCents(value, shares), {
    dr: `Issued on receipt (${CLASS_LABEL[cls]}) — ${lot.inventoryItem.name}`, cr: `Inventory issued on receipt — ${lot.inventoryItem.name}`,
  })
  assertBalanced(lines, `inventory.issue_on_receipt:${a.lotId}`)
  const when = await systemDate(tx, lot.tenantId, first.occurredAt)
  const late = withLateNote(`Issued to cost on receipt — ${lot.inventoryItem.name}, ${pkr(value)}`, lines, when.memoNote)
  await postJournalEntry({
    tenantId: lot.tenantId, sourceType: 'inventory.issue_on_receipt', sourceId: a.lotId,
    description: late.description, entryDate: when.entryDate, lines: late.lines,
  }, { tx })
}
