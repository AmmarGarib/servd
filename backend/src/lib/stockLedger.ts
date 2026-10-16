// THE stock writer — food cost on FIFO lots (finance wave B, H16).
//
// Owner: costing is REAL-TIME at the price actually paid for the stock being
// cooked. Every stock change in servd goes through this file and nothing else:
//
//   • StockLot      — one lot of one item at one cost (a receipt line, a count
//                     gain, an opening count, the one-time cut-over, a legacy
//                     return). FIFO order = receivedAt, then id.
//   • StockMovement — the lot ledger, APPEND-ONLY. Every change writes rows in
//                     the caller's transaction: what moved, from/to which lot,
//                     quantity (purchase units, signed), value (paisa, signed),
//                     class, brand, outlet, order line and source document.
//   • InventoryItem.currentStock is a CACHE of Σ lot remainingQty (kept by
//     every function here), so the auto-86 and every reader keep working;
//     InventoryItem.unitCostCents is the FIFO HEAD cost (the oldest open lot,
//     else the latest lot, else the typed estimate) — the price of the stock
//     that will be cooked next, which recipe / pricing screens show.
//
// Rules every function keeps:
//   • Company: lot.tenantId === item.tenantId === the caller's tenantId, else
//     500 CROSS_COMPANY_STOCK. An item with no company (tenantId NULL) is
//     refused on EVERY write: 422 ITEM_HAS_NO_COMPANY — company-less stock
//     never gets lots.
//   • Locks: item rows are locked in id order (lockItemsTx) before any lot is
//     read or written; every lot writer goes through here, so the item lock
//     serialises all of an item's lots. A caller touching several items locks
//     them ALL first with lockItemsTx (id order — never one by one in another
//     order, or two transactions can deadlock).
//   • Exact values: a draw that empties a lot takes its whole
//     remainingValueCents (|qty| < 1e-9 counts as zero), so lots and the
//     12x0 inventory accounts never drift by rounding. Σ movement value of a
//     lot == its remainingValueCents, always.
//   • Idempotent: a replay of the same (source, item, kind) writes nothing and
//     returns what the first call wrote (backed by the unique key on
//     (tenantId, sourceType, sourceId, inventoryItemId, kind, lotKey)). ONE
//     call per (source, item, kind): merge a document's quantities per item
//     before calling.
//   • Self-check: before a write, the item's currentStock must equal Σ lot
//     remainingQty — else 500 STOCK_NOT_ON_LOTS (the company's FIFO cut-over
//     has not run, or something wrote currentStock directly). Only the
//     cut-over's own lots (and an opening lot on an item that has never had a
//     lot) are exempt.
//   • Postings never change stock, and lots never change except here. The
//     two postings made FROM here (a late receipt settling earlier sale
//     shortfalls; an issue-on-receipt item) go through
//     modules/accounting/inventoryPosting.ts in the same transaction.
//
// ensureFifoReady(tenantId) MUST be called by every caller BEFORE it opens its
// transaction: on a company's first stock write it runs the one-time FIFO
// cut-over (modules/inventory/fifoCutover.ts), which locks ALL of that
// company's items in one big transaction.
//
// Movement source conventions (STOCK_SOURCE below) — the postings read the
// rows back by them: a sale line 'order_item.sale' + OrderItem.id; a waste
// 'waste_log' + WasteLog.id (create the log first or pre-generate its id); a
// count line 'physical_count_line' + PhysicalCountLine.id (lot source
// 'count_gain' / 'opening' + the line id); an ad-hoc prep batch 'prep_batch' +
// PrepBatch.id.

import { Prisma, type PrismaClient } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { costClassOf, COST_CLASSES, zeroByClass, type CostClass } from './inventoryClass.js'
import { assertInt4Fits, assertMoneyFits, sumCents, toCents } from './money.js'
import { brandSharesJson, brandUsageShares, type BrandShare } from './brandShare.js'

type Tx = Prisma.TransactionClient
type Db = Prisma.TransactionClient | PrismaClient

// ─── Constants and types ─────────────────────────────────────────────────────

/** A receipt lot settles the open sale shortfalls of the item from this many days before it (critic (c); default ON). */
export const SHORTFALL_SETTLE_DAYS = 7
/** |qty| below this counts as zero. */
export const STOCK_EPS = 1e-9
/** A lot is open while remainingQty is above this (= the partial index stock_lots_open_fifo). */
const LOT_OPEN_EPS = 0.000001
const DAY_MS = 86_400_000

export type MovementKind =
  | 'receipt' | 'opening' | 'fifo_cutover' | 'count_gain' | 'count_loss' | 'sale' | 'sale_return' | 'sale_void' | 'waste' | 'prep_draw'
  | 'supplier_return' | 'cost_adjust' | 'class_reclass' | 'legacy_return' | 'issue_on_receipt' | 'shortfall_settle'
// 'transfer_out' | 'transfer_in' are allowed by the DB CHECK but RESERVED for per-outlet stock (the next build) — never written in wave B

/** Lot-in kinds (addLotTx). */
export type LotInKind = 'receipt' | 'opening' | 'count_gain' | 'fifo_cutover' | 'legacy_return'
export type LotSourceType = 'goods_receipt_line' | 'count_gain' | 'opening' | 'fifo_cutover' | 'legacy_return'

/** Kinds consumeFifoTx draws with. */
const CONSUME_KINDS: ReadonlySet<string> = new Set(['sale', 'count_loss', 'waste', 'prep_draw', 'supplier_return'])
/** Kinds returnToLotsTx puts back with. */
const RETURN_KINDS: ReadonlySet<string> = new Set(['sale_return', 'supplier_return', 'legacy_return'])

/** The movement kinds that make up an order's cost of sales (accounting/cogs.ts). Settles are posted on their own. */
export const ORDER_COGS_KINDS = ['sale', 'sale_return', 'sale_void'] as const

/** sourceType conventions the postings read movements back by (see the header). */
export const STOCK_SOURCE = {
  orderItemSale:   'order_item.sale',      // sale rows — sourceId OrderItem.id
  wasteLog:        'waste_log',            // waste (and a sold line's sale_void) rows — sourceId WasteLog.id
  countLine:       'physical_count_line',  // count_loss / count_gain / opening rows — sourceId PhysicalCountLine.id
  prepBatch:       'prep_batch',           // prep_draw rows — sourceId PrepBatch.id
  receiptLine:     'goods_receipt_line',   // receipt rows — sourceId GoodsReceiptLine.id
  shortfallSettle: 'shortfall_settle',     // sourceId = the sale row it settles (written here)
  issueOnReceipt:  'issue_on_receipt',     // sourceId = the lot (written here)
} as const

/** ItemPriceHistory sources that are PURCHASE prices (the only kind it holds since wave B). */
export const PURCHASE_PRICE_SOURCES = ['po_receive', 'dock_receive', 'bill_match'] as const

export interface MovementRow { id: string; lotId: string | null; inventoryItemId: string; qty: number; valueCents: number; costClass: CostClass }

export interface ConsumeResult {
  /** Quantity taken from lots (purchase units, positive). */
  takenQty: number
  /** Needed but not on the books (clamp=true only). */
  shortfallQty: number
  /** Lot value taken (paisa, positive). */
  valueCents: number
  /** The rows written (signed: qty and value negative). A clamped shortfall adds one lot-less row (qty 0, value 0). */
  rows: MovementRow[]
}

// ─── FIFO cut-over marker ────────────────────────────────────────────────────

/** Setting key prefix of a company's FIFO cut-over instant (ISO string). fifoCutover.ts writes it. */
export const FIFO_CUTOVER_SETTING = 'foodcost.fifoCutoverAt'
export function fifoCutoverKey(tenantId: string): string {
  return `${FIFO_CUTOVER_SETTING}:${tenantId}`
}

/** When the company's FIFO cut-over ran; null = not yet. */
export async function readFifoCutoverAt(db: Db, tenantId: string): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: fifoCutoverKey(tenantId) }, select: { value: true } })
  if (!row) return null
  const at = new Date(row.value)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * Make sure the company's stock is held as FIFO lots: when the cut-over marker
 * is missing, run the one-time cut-over. Call it BEFORE opening a transaction
 * (it locks every item of the company in one big transaction). Idempotent and
 * cheap once the marker exists (one Setting read).
 */
export async function ensureFifoReady(tenantId: string): Promise<void> {
  if (!tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', 'Stock belongs to a company — none was given', 422)
  if (await readFifoCutoverAt(prisma, tenantId)) return
  // Imported lazily: fifoCutover.ts imports this file.
  const { ensureFifoCutover } = await import('../modules/inventory/fifoCutover.js')
  await ensureFifoCutover(tenantId)
}

// ─── Locks, items, the cache ─────────────────────────────────────────────────

/** Lock the item rows (FOR UPDATE) in id order. Lock EVERY item a document touches before its first stock write. */
export async function lockItemsTx(tx: Tx, itemIds: string[]): Promise<void> {
  const ids = [...new Set(itemIds.filter(Boolean))].sort()
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
}

const ITEM_SELECT = {
  id: true, tenantId: true, name: true, unit: true, category: true, currentStock: true, unitCostCents: true, issueOnReceipt: true,
} satisfies Prisma.InventoryItemSelect

interface StockItem {
  id: string
  tenantId: string
  name: string
  unit: string
  category: string | null
  currentStock: number
  unitCostCents: number | null
  issueOnReceipt: boolean
}

function crossCompany(what: string): AppError {
  return new AppError('CROSS_COMPANY_STOCK', `${what} belongs to another company — stock never moves across companies`, 500)
}

function itemHasNoCompany(name: string): AppError {
  return new AppError('ITEM_HAS_NO_COMPANY', `${name} belongs to no company — assign it to a company before moving its stock`, 422)
}

/** Lock + load + company check of one item. */
async function itemForWrite(tx: Tx, itemId: string, tenantId: string | undefined): Promise<StockItem> {
  await lockItemsTx(tx, [itemId])
  const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: ITEM_SELECT })
  if (!item) throw new AppError('ITEM_NOT_FOUND', `Inventory item ${itemId} not found`, 404)
  if (!item.tenantId) throw itemHasNoCompany(item.name)
  if (tenantId !== undefined && item.tenantId !== tenantId) throw crossCompany(item.name)
  return { ...item, tenantId: item.tenantId }
}

function asClass(v: string): CostClass {
  return (COST_CLASSES as readonly string[]).includes(v) ? (v as CostClass) : 'food'
}

const fmtQty = (q: number) => String(Math.round(q * 1000) / 1000)

/** currentStock must equal Σ lot remainingQty before a write (see the header). */
async function assertStockOnLots(tx: Tx, item: StockItem): Promise<void> {
  const agg = await tx.stockLot.aggregate({ where: { inventoryItemId: item.id }, _sum: { remainingQty: true } })
  const onLots = agg._sum.remainingQty ?? 0
  const tol = 1e-6 + 1e-9 * Math.max(Math.abs(onLots), Math.abs(item.currentStock))
  if (Math.abs(item.currentStock - onLots) > tol) {
    throw new AppError(
      'STOCK_NOT_ON_LOTS',
      `${item.name}: stock on hand (${fmtQty(item.currentStock)} ${item.unit}) is not held as FIFO lots (${fmtQty(onLots)} ${item.unit}). `
        + 'The company\'s FIFO cut-over has not run (call ensureFifoReady first), or stock was changed outside lib/stockLedger.ts.',
      500,
    )
  }
}

/** The FIFO head cost: the oldest open lot, else the latest lot, else null (keep the typed estimate). */
async function fifoHeadCost(db: Db, itemId: string): Promise<number | null> {
  const head = await db.stockLot.findFirst({
    where: { inventoryItemId: itemId, remainingQty: { gt: LOT_OPEN_EPS } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: { unitCostCents: true },
  })
  if (head) return head.unitCostCents
  const latest = await db.stockLot.findFirst({
    where: { inventoryItemId: itemId },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    select: { unitCostCents: true },
  })
  return latest?.unitCostCents ?? null
}

/**
 * InventoryItem.unitCostCents = the FIFO head cost (oldest open lot, else the
 * latest lot, else the typed estimate stays). Writes NO ItemPriceHistory —
 * that holds purchase prices only (addLotTx for receipts, bill re-pricing).
 */
export async function refreshItemCostTx(tx: Tx, itemId: string): Promise<void> {
  const cost = await fifoHeadCost(tx, itemId)
  if (cost == null) return
  // (A null estimate is not matched by NOT — SQL NULL — hence the OR.)
  await tx.inventoryItem.updateMany({
    where: { id: itemId, OR: [{ unitCostCents: null }, { NOT: { unitCostCents: cost } }] },
    data: { unitCostCents: cost },
  })
}

/** The cache after a change: currentStock = Σ remainingQty; unitCostCents = the FIFO head. */
async function syncItemTx(tx: Tx, itemId: string): Promise<void> {
  const agg = await tx.stockLot.aggregate({ where: { inventoryItemId: itemId }, _sum: { remainingQty: true } })
  let stock = agg._sum.remainingQty ?? 0
  if (Math.abs(stock) < LOT_OPEN_EPS) stock = 0
  const cost = await fifoHeadCost(tx, itemId)
  await tx.inventoryItem.update({ where: { id: itemId }, data: { currentStock: stock, ...(cost != null ? { unitCostCents: cost } : {}) } })
}

// ─── Reading ─────────────────────────────────────────────────────────────────

const ROW_SELECT = {
  id: true, lotId: true, inventoryItemId: true, qty: true, valueCents: true, costClass: true, shortfallQty: true,
} satisfies Prisma.StockMovementSelect

type RawRow = Prisma.StockMovementGetPayload<{ select: typeof ROW_SELECT }>

function toRow(m: RawRow): MovementRow {
  return { id: m.id, lotId: m.lotId, inventoryItemId: m.inventoryItemId, qty: m.qty, valueCents: toCents(m.valueCents), costClass: asClass(m.costClass) }
}

/**
 * The latest PURCHASE price of an item (per purchase unit): the latest receipt
 * lot's unit cost (re-priced by its bill, if any), else the latest purchase
 * row of ItemPriceHistory, else null. Values count gains and shortfall memos.
 */
export async function latestPurchaseCostCents(db: Db, itemId: string): Promise<number | null> {
  const lot = await db.stockLot.findFirst({
    where: { inventoryItemId: itemId, sourceType: 'goods_receipt_line' },
    orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    select: { unitCostCents: true },
  })
  if (lot) return lot.unitCostCents
  const h = await db.itemPriceHistory.findFirst({
    where: { inventoryItemId: itemId, source: { in: [...PURCHASE_PRICE_SOURCES] } },
    orderBy: { recordedAt: 'desc' },
    select: { newCostCents: true },
  })
  return h?.newCostCents ?? null
}

/**
 * Stock value by class. Now: Σ open lot remainingValueCents. As of a date:
 * Σ movement valueCents with occurredAt ≤ asOf (the lot ledger replayed —
 * equal to the lots now, by construction).
 */
export async function lotValuation(db: Db, tenantId: string, asOf?: Date): Promise<Record<CostClass, number>> {
  const out = zeroByClass()
  if (!asOf) {
    const rows = await db.stockLot.groupBy({ by: ['costClass'], where: { tenantId }, _sum: { remainingValueCents: true } })
    for (const r of rows) out[asClass(r.costClass)] += sumCents(r._sum.remainingValueCents)
  } else {
    const rows = await db.stockMovement.groupBy({ by: ['costClass'], where: { tenantId, occurredAt: { lte: asOf } }, _sum: { valueCents: true } })
    for (const r of rows) out[asClass(r.costClass)] += sumCents(r._sum.valueCents)
  }
  return out
}

// ─── Drawing from lots ───────────────────────────────────────────────────────

interface OpenLot {
  id: string
  tenantId: string
  inventoryItemId: string
  costClass: string
  unitCostCents: number
  remainingQty: number
  remainingValueCents: number
}

const OPEN_LOT_SELECT = {
  id: true, tenantId: true, inventoryItemId: true, costClass: true, unitCostCents: true, remainingQty: true, remainingValueCents: true,
} satisfies Prisma.StockLotSelect

async function openLotsTx(tx: Tx, itemId: string): Promise<OpenLot[]> {
  const lots = await tx.stockLot.findMany({
    where: { inventoryItemId: itemId, remainingQty: { gt: LOT_OPEN_EPS } },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    select: OPEN_LOT_SELECT,
  })
  return lots.map((l) => ({ ...l, remainingValueCents: toCents(l.remainingValueCents) }))
}

interface Draw { lot: OpenLot; take: number; value: number; empties: boolean }

/** Take `qty` from `lots` in the order given. A draw that empties a lot takes its whole remaining value. */
function planDraws(lots: OpenLot[], qty: number): { draws: Draw[]; short: number } {
  const draws: Draw[] = []
  let need = qty
  for (const lot of lots) {
    if (need < STOCK_EPS) break
    const take = Math.min(lot.remainingQty, need)
    if (take < STOCK_EPS) continue
    const empties = lot.remainingQty - take < STOCK_EPS
    const value = empties
      ? lot.remainingValueCents
      : Math.min(lot.remainingValueCents, Math.max(0, Math.round((lot.remainingValueCents * take) / lot.remainingQty)))
    draws.push({ lot, take: empties ? lot.remainingQty : take, value, empties })
    need -= take
  }
  return { draws, short: need < STOCK_EPS ? 0 : need }
}

async function applyDrawToLot(tx: Tx, d: Draw): Promise<void> {
  await tx.stockLot.update({
    where: { id: d.lot.id },
    data: d.empties
      ? { remainingQty: 0, remainingValueCents: 0 }
      : { remainingQty: d.lot.remainingQty - d.take, remainingValueCents: d.lot.remainingValueCents - d.value },
  })
}

/**
 * Take `qty` (purchase units) of an item out of its lots, oldest first, in the
 * caller's transaction. kind: sale | count_loss | waste | prep_draw |
 * supplier_return. `clamp` (sales only) takes what the lots hold and records
 * the rest on a lot-less row as shortfallQty with a memo value at the latest
 * purchase price (settled by the next receipt within SHORTFALL_SETTLE_DAYS);
 * without clamp a shortfall is 422 NEGATIVE_STOCK and nothing is written.
 * `preferLotIds` (supplier returns: the bill's own lots) are drawn first, in
 * that order, then FIFO. Sale rows carry `theoreticalQty` (the recipe
 * quantity, spread across the rows) — the brand usage shares read it.
 * A replay of the same (sourceType, sourceId, item, kind) writes nothing and
 * returns the first call's rows.
 */
export async function consumeFifoTx(tx: Tx, a: {
  tenantId: string; inventoryItemId: string; qty: number; kind: MovementKind; sourceType: string; sourceId: string; clamp: boolean
  orderId?: string; orderItemId?: string; conceptId?: string | null; locationId?: string | null; theoreticalQty?: number
  brandShares?: Array<{ conceptId: string; share: number }>; occurredAt: Date; createdById?: string | null
  /** Draw these lots first (a supplier return takes the bill's own lots), then FIFO. */
  preferLotIds?: string[]
}): Promise<ConsumeResult> {
  if (!CONSUME_KINDS.has(a.kind)) throw new AppError('BAD_MOVEMENT_KIND', `consumeFifoTx cannot write a '${a.kind}' movement`, 500)
  if (a.clamp && a.kind !== 'sale') throw new AppError('CLAMP_SALES_ONLY', 'Only a sale may take more than the lots hold', 500)
  if (!a.sourceType || !a.sourceId) throw new AppError('STOCK_MISSING_SOURCE', 'A stock movement needs its source document', 500)
  if (!Number.isFinite(a.qty) || a.qty < 0) throw new AppError('INVALID_QTY', 'A stock quantity must be zero or more', 422)

  const item = await itemForWrite(tx, a.inventoryItemId, a.tenantId)

  const prior = await tx.stockMovement.findMany({
    where: { tenantId: item.tenantId, sourceType: a.sourceType, sourceId: a.sourceId, inventoryItemId: item.id, kind: a.kind },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: ROW_SELECT,
  })
  if (prior.length > 0) {
    return {
      takenQty: -prior.reduce((s, r) => s + r.qty, 0),
      shortfallQty: prior.reduce((s, r) => s + (r.shortfallQty ?? 0), 0),
      valueCents: -prior.reduce((s, r) => s + toCents(r.valueCents), 0),
      rows: prior.map(toRow),
    }
  }
  if (a.qty < STOCK_EPS) return { takenQty: 0, shortfallQty: 0, valueCents: 0, rows: [] }

  await assertStockOnLots(tx, item)
  let lots = await openLotsTx(tx, item.id)
  for (const l of lots) if (l.tenantId !== item.tenantId) throw crossCompany(`A lot of ${item.name}`)
  if (a.preferLotIds && a.preferLotIds.length > 0) {
    const byId = new Map(lots.map((l) => [l.id, l]))
    const first: OpenLot[] = []
    for (const id of a.preferLotIds) {
      const l = byId.get(id)
      if (l && !first.includes(l)) first.push(l)
    }
    if (first.length < new Set(a.preferLotIds).size) {
      // A named lot that is not an open lot of THIS item: refuse a foreign one, ignore an empty one.
      const named = await tx.stockLot.findMany({ where: { id: { in: a.preferLotIds } }, select: { id: true, tenantId: true, inventoryItemId: true } })
      for (const n of named) if (n.tenantId !== item.tenantId || n.inventoryItemId !== item.id) throw crossCompany(`Lot ${n.id}`)
    }
    lots = [...first, ...lots.filter((l) => !first.includes(l))]
  }

  const { draws, short } = planDraws(lots, a.qty)
  if (short > 0 && !a.clamp) {
    const onHand = lots.reduce((s, l) => s + l.remainingQty, 0)
    throw new AppError(
      'NEGATIVE_STOCK',
      `Only ${fmtQty(onHand)} ${item.unit} of ${item.name} on hand — ${fmtQty(a.qty)} ${item.unit} cannot be taken. Count it or receive it first.`,
      422,
    )
  }

  const theo = (q: number): number | null =>
    a.theoreticalQty == null || !Number.isFinite(a.theoreticalQty) ? null : (a.theoreticalQty * q) / a.qty
  const shares = a.brandShares ? brandSharesJson(a.brandShares) : undefined
  const common = {
    tenantId: item.tenantId, inventoryItemId: item.id, kind: a.kind, sourceType: a.sourceType, sourceId: a.sourceId,
    conceptId: a.conceptId ?? null, locationId: a.locationId ?? null, orderId: a.orderId ?? null, orderItemId: a.orderItemId ?? null,
    occurredAt: a.occurredAt, createdById: a.createdById ?? null,
    ...(shares !== undefined ? { brandShares: shares } : {}),
  }

  const rows: MovementRow[] = []
  let value = 0
  let taken = 0
  for (const d of draws) {
    await applyDrawToLot(tx, d)
    const m = await tx.stockMovement.create({
      data: {
        ...common, lotId: d.lot.id, lotKey: d.lot.id, qty: -d.take, valueCents: -d.value,
        unitCostCents: d.lot.unitCostCents, costClass: d.lot.costClass, theoreticalQty: theo(d.take),
      },
      select: ROW_SELECT,
    })
    rows.push(toRow(m))
    value += d.value
    taken += d.take
  }
  if (short > 0) {
    const memoCost = (await latestPurchaseCostCents(tx, item.id)) ?? item.unitCostCents
    const memoValue = memoCost == null ? null : Math.round(memoCost * short)
    if (memoValue != null) assertMoneyFits(memoValue, `${item.name} shortfall memo`)
    const m = await tx.stockMovement.create({
      data: {
        ...common, lotId: null, lotKey: '', qty: 0, valueCents: 0,
        unitCostCents: memoCost ?? 0, costClass: costClassOf(item.category), theoreticalQty: theo(short),
        shortfallQty: short, shortfallValueCents: memoValue,
      },
      select: ROW_SELECT,
    })
    rows.push(toRow(m))
  }
  await syncItemTx(tx, item.id)
  return { takenQty: taken, shortfallQty: short, valueCents: value, rows }
}

// ─── Putting back, relabelling ───────────────────────────────────────────────

interface Group { itemId: string; lotId: string; qty: number; value: number; rowIds: string[] }

/** Merge rows per (item, lot); lot-less and zero rows are skipped. Amounts are magnitudes. */
function groupRows(rows: MovementRow[]): Group[] {
  const out = new Map<string, Group>()
  for (const r of rows) {
    if (!r.lotId) continue
    const q = Math.abs(r.qty)
    const v = Math.abs(r.valueCents)
    if (q < STOCK_EPS && v === 0) continue
    const key = `${r.inventoryItemId}|${r.lotId}`
    const g = out.get(key) ?? { itemId: r.inventoryItemId, lotId: r.lotId, qty: 0, value: 0, rowIds: [] }
    g.qty += q
    g.value += v
    if (r.id) g.rowIds.push(r.id)
    out.set(key, g)
  }
  return [...out.values()]
}

/** Lock and company-check the items and lots of `groups`. Returns items and lots by id. */
async function lockGroups(tx: Tx, groups: Group[], tenantId: string | undefined) {
  const itemIds = [...new Set(groups.map((g) => g.itemId))]
  await lockItemsTx(tx, itemIds)
  const items = await tx.inventoryItem.findMany({ where: { id: { in: itemIds } }, select: ITEM_SELECT })
  const itemById = new Map(items.map((i) => [i.id, i]))
  let company = tenantId
  for (const id of itemIds) {
    const it = itemById.get(id)
    if (!it) throw new AppError('ITEM_NOT_FOUND', `Inventory item ${id} not found`, 404)
    if (!it.tenantId) throw itemHasNoCompany(it.name)
    if (company === undefined) company = it.tenantId
    if (it.tenantId !== company) throw crossCompany(it.name)
  }
  const lots = await tx.stockLot.findMany({
    where: { id: { in: groups.map((g) => g.lotId) } },
    select: { ...OPEN_LOT_SELECT, qtyIn: true },
  })
  const lotById = new Map(lots.map((l) => [l.id, { ...l, remainingValueCents: toCents(l.remainingValueCents) }]))
  for (const g of groups) {
    const l = lotById.get(g.lotId)
    if (!l) throw new AppError('LOT_NOT_FOUND', `Stock lot ${g.lotId} not found`, 404)
    if (l.inventoryItemId !== g.itemId || l.tenantId !== company) throw crossCompany(`Lot ${l.id}`)
  }
  return { company: company!, itemById, lotById }
}

/** Order / line / brand / outlet of the original rows, by row id. */
async function rowContext(tx: Tx, ids: string[]) {
  const rows = ids.length === 0 ? [] : await tx.stockMovement.findMany({
    where: { id: { in: ids } },
    select: { id: true, tenantId: true, kind: true, lotId: true, orderId: true, orderItemId: true, conceptId: true, locationId: true },
  })
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * Put rows back into the SAME lots they came from (an unfired void or cancel:
 * 'sale_return'; a credit-note void: 'supplier_return'). Writes one movement
 * per (item, lot) with the magnitudes of `rows` (pass the net-out rows: what
 * is still out of each lot). Order / line / brand / outlet are copied from the
 * original row (by row id). Lot-less (shortfall) rows have nothing to return.
 * Idempotent per (sourceType, sourceId, item, lot). `tenantId`, when given,
 * must be the rows' company.
 */
export async function returnToLotsTx(tx: Tx, a: {
  rows: MovementRow[]; kind: 'sale_return' | 'supplier_return' | 'legacy_return'; sourceType: string; sourceId: string; occurredAt: Date
  tenantId?: string; createdById?: string | null
}): Promise<{ valueCents: number }> {
  if (!RETURN_KINDS.has(a.kind)) throw new AppError('BAD_MOVEMENT_KIND', `returnToLotsTx cannot write a '${a.kind}' movement`, 500)
  if (!a.sourceType || !a.sourceId) throw new AppError('STOCK_MISSING_SOURCE', 'A stock movement needs its source document', 500)
  const groups = groupRows(a.rows)
  if (groups.length === 0) return { valueCents: 0 }
  const { company, itemById, lotById } = await lockGroups(tx, groups, a.tenantId)

  const existing = await tx.stockMovement.findMany({
    where: { tenantId: company, sourceType: a.sourceType, sourceId: a.sourceId, kind: a.kind, inventoryItemId: { in: [...itemById.keys()] } },
    select: { inventoryItemId: true, lotKey: true },
  })
  const done = new Set(existing.map((e) => `${e.inventoryItemId}|${e.lotKey}`))
  const todo = groups.filter((g) => !done.has(`${g.itemId}|${g.lotId}`))
  const ctx = await rowContext(tx, todo.flatMap((g) => g.rowIds))
  for (const id of new Set(todo.map((g) => g.itemId))) {
    const it = itemById.get(id)!
    await assertStockOnLots(tx, { ...it, tenantId: it.tenantId! })
  }

  let value = 0
  for (const g of groups) value += g.value
  for (const g of todo) {
    const lot = lotById.get(g.lotId)!
    const remaining = lot.remainingQty + g.qty
    if (remaining > lot.qtyIn + 1e-6 * Math.max(1, lot.qtyIn)) {
      throw new AppError('RETURN_EXCEEDS_LOT', `Returning ${fmtQty(g.qty)} to lot ${lot.id} would hold more than it received (${fmtQty(lot.qtyIn)})`, 500)
    }
    await tx.stockLot.update({
      where: { id: lot.id },
      data: { remainingQty: remaining, remainingValueCents: lot.remainingValueCents + g.value },
    })
    lot.remainingQty = remaining
    lot.remainingValueCents += g.value
    const orig = g.rowIds.map((id) => ctx.get(id)).find((r) => r && r.tenantId === company)
    await tx.stockMovement.create({
      data: {
        tenantId: company, inventoryItemId: g.itemId, lotId: lot.id, lotKey: lot.id, kind: a.kind,
        qty: g.qty, valueCents: g.value, unitCostCents: lot.unitCostCents, costClass: lot.costClass,
        orderId: orig?.orderId ?? null, orderItemId: orig?.orderItemId ?? null, conceptId: orig?.conceptId ?? null,
        locationId: orig?.locationId ?? null,
        sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: a.occurredAt, createdById: a.createdById ?? null,
      },
    })
  }
  for (const id of new Set(todo.map((g) => g.itemId))) await syncItemTx(tx, id)
  return { valueCents: value }
}

/**
 * A sold line that was cooked and will never be eaten (void after fire, cancel
 * after fire, returned food) becomes WASTE without touching stock: for each
 * (item, lot) of `rows` (the line's net-out sale rows) write a 'sale_void'
 * row (+qty, +value — nets the sale out of the order's cost of sales, order /
 * line / brand copied from the sale row) and a 'waste' row (−qty, −value,
 * brand `conceptId`), both keyed on the item's WasteLog ('waste_log' +
 * wasteLogIdByItem[itemId]). Lots and currentStock do not change. Idempotent
 * per (waste log, item, lot).
 */
export async function relabelToWasteTx(tx: Tx, a: {
  rows: MovementRow[]; wasteLogIdByItem: Record<string, string>; conceptId: string | null; occurredAt: Date
  tenantId?: string; createdById?: string | null
}): Promise<{ valueCents: number }> {
  const groups = groupRows(a.rows)
  if (groups.length === 0) return { valueCents: 0 }
  for (const g of groups) {
    if (!a.wasteLogIdByItem[g.itemId]) throw new AppError('WASTE_LOG_REQUIRED', `No waste log given for item ${g.itemId}`, 500)
  }
  const { company, itemById, lotById } = await lockGroups(tx, groups, a.tenantId)
  const ctx = await rowContext(tx, groups.flatMap((g) => g.rowIds))
  const wasteIds = [...new Set(Object.values(a.wasteLogIdByItem))]
  const existing = await tx.stockMovement.findMany({
    where: {
      tenantId: company, sourceType: STOCK_SOURCE.wasteLog, sourceId: { in: wasteIds }, kind: { in: ['sale_void', 'waste'] },
      inventoryItemId: { in: [...itemById.keys()] },
    },
    select: { inventoryItemId: true, lotKey: true, kind: true },
  })
  const done = new Set(existing.map((e) => `${e.kind}|${e.inventoryItemId}|${e.lotKey}`))

  let value = 0
  for (const g of groups) {
    value += g.value
    const lot = lotById.get(g.lotId)!
    const orig = g.rowIds.map((id) => ctx.get(id)).find((r) => r && r.tenantId === company && r.lotId === g.lotId)
    if (!orig) throw new AppError('RELABEL_ROW_UNKNOWN', `The sale rows of lot ${g.lotId} were not found — pass the line's own movement rows`, 500)
    const base = {
      tenantId: company, inventoryItemId: g.itemId, lotId: lot.id, lotKey: lot.id, unitCostCents: lot.unitCostCents, costClass: lot.costClass,
      orderId: orig.orderId, orderItemId: orig.orderItemId, locationId: orig.locationId,
      sourceType: STOCK_SOURCE.wasteLog, sourceId: a.wasteLogIdByItem[g.itemId]!, occurredAt: a.occurredAt, createdById: a.createdById ?? null,
    }
    if (!done.has(`sale_void|${g.itemId}|${lot.id}`)) {
      await tx.stockMovement.create({ data: { ...base, kind: 'sale_void', qty: g.qty, valueCents: g.value, conceptId: orig.conceptId } })
    }
    if (!done.has(`waste|${g.itemId}|${lot.id}`)) {
      await tx.stockMovement.create({ data: { ...base, kind: 'waste', qty: -g.qty, valueCents: -g.value, conceptId: a.conceptId } })
    }
  }
  return { valueCents: value }
}

// ─── Re-pricing, class change ────────────────────────────────────────────────

/**
 * A bill priced a lot differently from its receipt cost: `deltaCents` =
 * (billed − lot cost) × `qtyBasis` (the matched quantity, ≤ the lot's qtyIn).
 * The share still on hand (remainingQty / qtyIn) changes the lot's remaining
 * value (a 'cost_adjust' movement, qty 0) — the caller posts it to the class
 * inventory account; the share already used (`usedCents`) never touches the
 * lot — the caller posts it to 5060 (brand split by usage). The lot's
 * valueIn / unit cost move by the whole delta; the head cost is refreshed.
 * Idempotent per (sourceType, sourceId, lot).
 */
export async function repriceLotTx(tx: Tx, a: { lotId: string; deltaCents: number; qtyBasis: number; sourceType: string; sourceId: string }): Promise<{ onHandCents: number; usedCents: number }> {
  if (!Number.isInteger(a.deltaCents)) throw new AppError('JOURNAL_NOT_INTEGER', 'A price difference must be whole paisa', 500)
  assertMoneyFits(a.deltaCents, 'The price difference')
  if (!a.sourceType || !a.sourceId) throw new AppError('STOCK_MISSING_SOURCE', 'A stock movement needs its source document', 500)
  const head = await tx.stockLot.findUnique({ where: { id: a.lotId }, select: { inventoryItemId: true, tenantId: true } })
  if (!head) throw new AppError('LOT_NOT_FOUND', `Stock lot ${a.lotId} not found`, 404)
  const item = await itemForWrite(tx, head.inventoryItemId, head.tenantId)
  const lot = await tx.stockLot.findUniqueOrThrow({
    where: { id: a.lotId },
    select: { ...OPEN_LOT_SELECT, qtyIn: true, valueInCents: true },
  })
  if (lot.tenantId !== item.tenantId) throw crossCompany(`Lot ${lot.id}`)
  if (!(a.qtyBasis > 0) || a.qtyBasis > lot.qtyIn + 1e-6 * Math.max(1, lot.qtyIn)) {
    throw new AppError('REPRICE_QTY_INVALID', `Re-pricing ${fmtQty(a.qtyBasis)} of a lot that received ${fmtQty(lot.qtyIn)}`, 500)
  }

  const prior = await tx.stockMovement.findFirst({
    where: { tenantId: lot.tenantId, sourceType: a.sourceType, sourceId: a.sourceId, inventoryItemId: lot.inventoryItemId, kind: 'cost_adjust', lotKey: lot.id },
    select: { valueCents: true },
  })
  if (prior) {
    const onHand = toCents(prior.valueCents)
    return { onHandCents: onHand, usedCents: a.deltaCents - onHand }
  }
  if (a.deltaCents === 0) return { onHandCents: 0, usedCents: 0 }

  const remainingValue = toCents(lot.remainingValueCents)
  const fraction = lot.qtyIn > 0 ? Math.min(1, Math.max(0, lot.remainingQty / lot.qtyIn)) : 0
  let onHand = lot.remainingQty < LOT_OPEN_EPS ? 0 : fraction >= 1 ? a.deltaCents : Math.round(a.deltaCents * fraction)
  if (remainingValue + onHand < 0) onHand = -remainingValue   // a credit never takes a lot below zero value
  const used = a.deltaCents - onHand
  const valueIn = toCents(lot.valueInCents) + a.deltaCents
  const unitCost = lot.qtyIn > 0 ? Math.max(0, Math.round(valueIn / lot.qtyIn)) : lot.unitCostCents
  assertInt4Fits(unitCost, `${item.name}'s re-priced unit cost`)

  await tx.stockLot.update({
    where: { id: lot.id },
    data: { remainingValueCents: remainingValue + onHand, valueInCents: valueIn, unitCostCents: unitCost },
  })
  await tx.stockMovement.create({
    data: {
      tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, lotId: lot.id, lotKey: lot.id, kind: 'cost_adjust',
      qty: 0, valueCents: onHand, unitCostCents: unitCost, costClass: lot.costClass,
      sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: new Date(),
    },
  })
  await refreshItemCostTx(tx, lot.inventoryItemId)
  return { onHandCents: onHand, usedCents: used }
}

/**
 * An item's category moved it to another cost class: every lot of the item
 * takes the new class, and each open lot's remaining value moves class with a
 * 'class_reclass' pair (−value in the old class, +value in the new, qty 0;
 * lotKey '<lotId>:from' / ':to') so the lot ledger replays by class. The caller
 * posts postItemReclassTx with the value per old class, in the same
 * transaction. Idempotent per (sourceType, sourceId, item).
 */
export async function reclassItemLotsTx(tx: Tx, a: {
  tenantId: string; itemId: string; toClass: CostClass; sourceType: string; sourceId: string; occurredAt?: Date; createdById?: string | null
}): Promise<{ byFromClass: Record<CostClass, number>; valueCents: number }> {
  const item = await itemForWrite(tx, a.itemId, a.tenantId)
  const byFromClass = zeroByClass()
  const prior = await tx.stockMovement.findMany({
    where: { tenantId: item.tenantId, sourceType: a.sourceType, sourceId: a.sourceId, inventoryItemId: item.id, kind: 'class_reclass' },
    select: { valueCents: true, costClass: true },
  })
  if (prior.length > 0) {
    for (const p of prior) {
      const v = toCents(p.valueCents)
      if (v < 0) byFromClass[asClass(p.costClass)] += -v
    }
    return { byFromClass, valueCents: COST_CLASSES.reduce((s, c) => s + byFromClass[c], 0) }
  }
  const lots = await tx.stockLot.findMany({
    where: { inventoryItemId: item.id, NOT: { costClass: a.toClass } },
    select: { id: true, tenantId: true, costClass: true, unitCostCents: true, remainingQty: true, remainingValueCents: true },
  })
  const at = a.occurredAt ?? new Date()
  for (const l of lots) {
    if (l.tenantId !== item.tenantId) throw crossCompany(`Lot ${l.id}`)
    const v = toCents(l.remainingValueCents)
    if (v !== 0 || l.remainingQty > LOT_OPEN_EPS) {
      const from = asClass(l.costClass)
      byFromClass[from] += v
      const base = {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: l.id, kind: 'class_reclass', qty: 0, unitCostCents: l.unitCostCents,
        sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: at, createdById: a.createdById ?? null,
      }
      await tx.stockMovement.create({ data: { ...base, lotKey: `${l.id}:from`, valueCents: -v, costClass: from } })
      await tx.stockMovement.create({ data: { ...base, lotKey: `${l.id}:to`, valueCents: v, costClass: a.toClass } })
    }
  }
  if (lots.length > 0) await tx.stockLot.updateMany({ where: { id: { in: lots.map((l) => l.id) } }, data: { costClass: a.toClass } })
  return { byFromClass, valueCents: COST_CLASSES.reduce((s, c) => s + byFromClass[c], 0) }
}

// ─── Adding a lot ────────────────────────────────────────────────────────────

/**
 * Bring stock in as a new lot (receipt, opening count, count gain, the
 * cut-over, a legacy return), with its lot-in movement, in the caller's
 * transaction. valueCents defaults to round(qty × unitCostCents); pass it to
 * book an exact amount (a cash buy's total). Idempotent per (lotSourceType,
 * lotSourceId, item): a replay returns the lot and writes nothing.
 *
 * A RECEIPT lot also:
 *   • writes ItemPriceHistory (a purchase price: 'po_receive' / 'dock_receive')
 *     when the price differs from the last purchase price;
 *   • settles the item's open sale shortfalls of the last SHORTFALL_SETTLE_DAYS
 *     (before its receivedAt, or since) FIFO from itself — one
 *     'shortfall_settle' row per sale row settled, valued at this lot, posted
 *     Dr 50x0 / Cr 12x0 per brand (postShortfallSettleTx) — skipping lines
 *     voided (even a fully-short one, which wrote no movement) or since
 *     returned / wasted for that item, cancelled orders, and "Box given"
 *     taps since undone;
 *   • when the item is issue-on-receipt (unmeasured consumables), is consumed
 *     in full at once ('issue_on_receipt', brand shares by usage) and posted
 *     Dr 50x0 / Cr 12x0 (postIssueOnReceiptTx).
 */
export async function addLotTx(tx: Tx, a: {
  tenantId: string; inventoryItemId: string; qty: number; unitCostCents: number; valueCents?: number
  kind: LotInKind; lotSourceType: LotSourceType; lotSourceId: string; movementSourceType: string; movementSourceId: string
  receiptLineId?: string; locationId?: string | null; receivedAt: Date; createdById?: string | null
  /** Stored on the lot-in movement (a count gain's brand split, as posted). */
  brandShares?: Array<{ conceptId: string; share: number }>
}): Promise<{ lotId: string; movementId: string; settled?: { valueCents: number }; issued?: { valueCents: number } }> {
  if (!a.lotSourceId || !a.movementSourceType || !a.movementSourceId) {
    throw new AppError('STOCK_MISSING_SOURCE', 'A stock lot needs its source document', 500)
  }
  if (!Number.isFinite(a.qty) || !(a.qty > STOCK_EPS)) throw new AppError('INVALID_QTY', 'A stock lot needs a quantity above zero', 422)
  if (!Number.isInteger(a.unitCostCents) || a.unitCostCents < 0) throw new AppError('INVALID_COST', 'A unit cost must be whole paisa, zero or more', 422)
  const item = await itemForWrite(tx, a.inventoryItemId, a.tenantId)
  // An ingredient parked in the Trash (Sourcing clean-up, inventory/unusedCleanup.ts) takes no new stock: it would
  // hold value no sheet shows. Read under the item lock, so a clean-up that committed first is seen.
  if (a.kind !== 'fifo_cutover' && await tx.inventoryItem.count({ where: { id: item.id, deletedAt: { not: null } } })) {
    throw new AppError('ITEM_IN_TRASH', `${item.name} is in the Trash — restore it from the Trash before stock comes in`, 422)
  }
  assertInt4Fits(a.unitCostCents, `${item.name}'s unit cost`)
  const value = a.valueCents ?? Math.round(a.qty * a.unitCostCents)
  if (!Number.isInteger(value) || value < 0) throw new AppError('INVALID_COST', 'A lot value must be whole paisa, zero or more', 422)
  assertMoneyFits(value, `${item.name} (quantity × unit cost)`)

  if (a.receiptLineId) {
    // The receipt line is the receiving company's document: the receipt's company (else its supplier's) must be the item's.
    const line = await tx.goodsReceiptLine.findUnique({ where: { id: a.receiptLineId }, select: { inventoryItemId: true, receipt: { select: { tenantId: true, supplierId: true } } } })
    if (!line) throw new AppError('RECEIPT_LINE_NOT_FOUND', `Receipt line ${a.receiptLineId} not found`, 404)
    const lineCompany = line.receipt.tenantId
      ?? (await tx.supplier.findUnique({ where: { id: line.receipt.supplierId }, select: { tenantId: true } }))?.tenantId ?? null
    if (lineCompany !== item.tenantId || (line.inventoryItemId && line.inventoryItemId !== item.id)) throw crossCompany(`Receipt line ${a.receiptLineId}`)
  }

  const existing = await tx.stockLot.findUnique({
    where: { tenantId_sourceType_sourceId_inventoryItemId: { tenantId: item.tenantId, sourceType: a.lotSourceType, sourceId: a.lotSourceId, inventoryItemId: item.id } },
    select: { id: true },
  })
  if (existing) {
    const m = await tx.stockMovement.findFirst({ where: { lotId: existing.id, kind: a.kind }, orderBy: { createdAt: 'asc' }, select: { id: true } })
    return { lotId: existing.id, movementId: m?.id ?? '' }
  }

  if (a.kind !== 'fifo_cutover') {
    const hasLots = a.kind === 'opening' ? (await tx.stockLot.count({ where: { inventoryItemId: item.id } })) > 0 : true
    if (hasLots) await assertStockOnLots(tx, item)
  }

  const costClass = costClassOf(item.category)
  const lot = await tx.stockLot.create({
    data: {
      tenantId: item.tenantId, inventoryItemId: item.id, locationId: a.locationId ?? null,
      sourceType: a.lotSourceType, sourceId: a.lotSourceId, receiptLineId: a.receiptLineId ?? null,
      costClass, receivedAt: a.receivedAt, qtyIn: a.qty, remainingQty: a.qty, unitCostCents: a.unitCostCents,
      valueInCents: value, remainingValueCents: value,
    },
    select: { id: true },
  })
  const movement = await tx.stockMovement.create({
    data: {
      tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: a.kind,
      qty: a.qty, valueCents: value, unitCostCents: a.unitCostCents, costClass,
      locationId: a.locationId ?? null, sourceType: a.movementSourceType, sourceId: a.movementSourceId,
      occurredAt: a.receivedAt, createdById: a.createdById ?? null,
      ...(a.brandShares ? { brandShares: brandSharesJson(a.brandShares) } : {}),
    },
    select: { id: true },
  })

  let settled: { valueCents: number } | undefined
  let issued: { valueCents: number } | undefined
  if (a.kind === 'receipt') {
    await recordPurchasePriceTx(tx, item, a)
    const lotNow = { id: lot.id, tenantId: item.tenantId, inventoryItemId: item.id, costClass, unitCostCents: a.unitCostCents, remainingQty: a.qty, remainingValueCents: value }
    const s = await settleShortfallsTx(tx, item, lotNow, a.receivedAt)
    if (s > 0) settled = { valueCents: s }
    if (item.issueOnReceipt) {
      const i = await issueOnReceiptTx(tx, item, lotNow, a.receivedAt, a.createdById ?? null)
      if (i > 0) issued = { valueCents: i }
    }
  }
  await syncItemTx(tx, item.id)
  return { lotId: lot.id, movementId: movement.id, ...(settled ? { settled } : {}), ...(issued ? { issued } : {}) }
}

/** A receipt's price, as a purchase price row — only when it differs from the last one (or it is the first). */
async function recordPurchasePriceTx(tx: Tx, item: StockItem, a: { unitCostCents: number; receiptLineId?: string; receivedAt: Date }): Promise<void> {
  const line = a.receiptLineId
    ? await tx.goodsReceiptLine.findUnique({ where: { id: a.receiptLineId }, select: { poLineId: true, receipt: { select: { supplierId: true } } } })
    : null
  const prev = await tx.itemPriceHistory.findFirst({
    where: { inventoryItemId: item.id, source: { in: [...PURCHASE_PRICE_SOURCES] } },
    orderBy: { recordedAt: 'desc' },
    select: { newCostCents: true },
  })
  if (prev && prev.newCostCents === a.unitCostCents) return
  await tx.itemPriceHistory.create({
    data: {
      inventoryItemId: item.id,
      supplierId: line?.receipt.supplierId ?? null,
      oldCostCents: prev?.newCostCents ?? item.unitCostCents ?? null,
      newCostCents: a.unitCostCents,
      source: line?.poLineId ? 'po_receive' : 'dock_receive',
      poLineId: line?.poLineId ?? null,
      recordedAt: a.receivedAt,
    },
  })
}

type LotNow = OpenLot

/** Settle open sale shortfalls of the item from a new receipt lot (see addLotTx). Returns the value settled. */
async function settleShortfallsTx(tx: Tx, item: StockItem, lot: LotNow, receivedAt: Date): Promise<number> {
  const from = new Date(receivedAt.getTime() - SHORTFALL_SETTLE_DAYS * DAY_MS)
  const sales = await tx.stockMovement.findMany({
    where: { tenantId: item.tenantId, inventoryItemId: item.id, kind: 'sale', shortfallQty: { gt: STOCK_EPS }, occurredAt: { gte: from } },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    select: { id: true, shortfallQty: true, orderId: true, orderItemId: true, conceptId: true, locationId: true, sourceType: true, sourceId: true },
  })
  if (sales.length === 0) return 0

  const settledSoFar = await tx.stockMovement.groupBy({
    by: ['settlesMovementId'],
    where: { tenantId: item.tenantId, kind: 'shortfall_settle', settlesMovementId: { in: sales.map((s) => s.id) } },
    _sum: { qty: true },
  })
  const settledBy = new Map(settledSoFar.map((r) => [r.settlesMovementId, -(r._sum.qty ?? 0)]))
  // Food that was never eaten: a line voided (a fully-short line's void
  // writes no movement — the line's own status says it), a line since
  // returned or wasted for THIS item (a "Box given" undo gives back the
  // packaging, not the food), an order cancelled, a "Box given" tap since
  // undone (its draw was its packaging; the line no longer carries that tap).
  const lineIds = [...new Set(sales.map((s) => s.orderItemId).filter((x): x is string => !!x))]
  const [lines, undoneLines] = lineIds.length === 0 ? [[], []] : await Promise.all([
    tx.orderItem.findMany({ where: { id: { in: lineIds } }, select: { id: true, status: true, voidedAt: true, boxGiven: true, boxGivenAt: true } }),
    tx.stockMovement.findMany({
      where: {
        tenantId: item.tenantId, orderItemId: { in: lineIds }, inventoryItemId: item.id, kind: { in: ['sale_return', 'sale_void'] },
        sourceType: { not: 'order_item.box_given_undo' },
      },
      select: { orderItemId: true },
      distinct: ['orderItemId'],
    }),
  ])
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const undone = new Set(undoneLines.map((r) => r.orderItemId))
  const tapUndone = (s: { orderItemId: string | null; sourceType: string; sourceId: string }): boolean => {
    if (s.sourceType !== 'order_item.box_given' || !s.orderItemId) return false
    const l = lineById.get(s.orderItemId)
    return !l || !l.boxGiven || `${l.id}@${l.boxGivenAt ? l.boxGivenAt.getTime() : 0}` !== s.sourceId
  }
  const lineVoided = (id: string | null): boolean => {
    const l = id ? lineById.get(id) : undefined
    return !!l && (!!l.voidedAt || l.status === 'voided')
  }
  const orderIds = [...new Set(sales.map((s) => s.orderId).filter((x): x is string => !!x))]
  const deadOrders = orderIds.length === 0 ? [] : await tx.order.findMany({
    where: { id: { in: orderIds }, status: { in: ['cancelled', 'rejected'] } },
    select: { id: true },
  })
  const dead = new Set(deadOrders.map((o) => o.id))

  let qtyLeft = lot.remainingQty
  let valueLeft = lot.remainingValueCents
  let settledValue = 0
  const byConcept = new Map<string, { conceptId: string | null; costClass: CostClass; cents: number }>()
  for (const s of sales) {
    if (qtyLeft < STOCK_EPS) break
    if ((s.orderItemId && (undone.has(s.orderItemId) || lineVoided(s.orderItemId))) || (s.orderId && dead.has(s.orderId)) || tapUndone(s)) continue
    const open = (s.shortfallQty ?? 0) - (settledBy.get(s.id) ?? 0)
    if (open < STOCK_EPS) continue
    const d = planDraws([{ ...lot, remainingQty: qtyLeft, remainingValueCents: valueLeft }], open).draws[0]
    if (!d) continue
    await tx.stockMovement.create({
      data: {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: 'shortfall_settle',
        qty: -d.take, valueCents: -d.value, unitCostCents: lot.unitCostCents, costClass: lot.costClass,
        settlesMovementId: s.id, orderId: s.orderId, orderItemId: s.orderItemId, conceptId: s.conceptId, locationId: s.locationId,
        sourceType: STOCK_SOURCE.shortfallSettle, sourceId: s.id, occurredAt: receivedAt,
      },
    })
    qtyLeft = d.empties ? 0 : qtyLeft - d.take
    valueLeft -= d.value
    settledValue += d.value
    const cls = asClass(lot.costClass)
    const key = `${s.conceptId ?? ''}|${cls}`
    const b = byConcept.get(key) ?? { conceptId: s.conceptId, costClass: cls, cents: 0 }
    b.cents += d.value
    byConcept.set(key, b)
  }
  if (qtyLeft === lot.remainingQty) return 0
  await tx.stockLot.update({
    where: { id: lot.id },
    data: qtyLeft < STOCK_EPS ? { remainingQty: 0, remainingValueCents: 0 } : { remainingQty: qtyLeft, remainingValueCents: valueLeft },
  })
  lot.remainingQty = qtyLeft < STOCK_EPS ? 0 : qtyLeft
  lot.remainingValueCents = qtyLeft < STOCK_EPS ? 0 : valueLeft
  if (settledValue > 0) {
    const { postShortfallSettleTx } = await import('../modules/accounting/inventoryPosting.js')
    await postShortfallSettleTx(tx, { lotId: lot.id, byConcept: [...byConcept.values()].filter((b) => b.cents > 0) })
  }
  return settledValue
}

/** Consume what is left of a new receipt lot of an issue-on-receipt item (see addLotTx). Returns the value issued. */
async function issueOnReceiptTx(tx: Tx, item: StockItem, lot: LotNow, receivedAt: Date, createdById: string | null): Promise<number> {
  if (lot.remainingQty < STOCK_EPS && lot.remainingValueCents === 0) return 0
  const shares: BrandShare[] = await brandUsageShares(tx, item.tenantId, item.id, receivedAt)
  const value = lot.remainingValueCents
  await tx.stockMovement.create({
    data: {
      tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: 'issue_on_receipt',
      qty: -lot.remainingQty, valueCents: -value, unitCostCents: lot.unitCostCents, costClass: lot.costClass,
      brandShares: brandSharesJson(shares),
      sourceType: STOCK_SOURCE.issueOnReceipt, sourceId: lot.id, occurredAt: receivedAt, createdById,
    },
  })
  await tx.stockLot.update({ where: { id: lot.id }, data: { remainingQty: 0, remainingValueCents: 0 } })
  lot.remainingQty = 0
  lot.remainingValueCents = 0
  if (value > 0) {
    const { postIssueOnReceiptTx } = await import('../modules/accounting/inventoryPosting.js')
    await postIssueOnReceiptTx(tx, { lotId: lot.id })
  }
  return value
}
