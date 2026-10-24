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
// SITES (owner, 2026-10-24, D4 — per-site stock): every lot belongs to ONE
// location of its company (lib/stockSite.ts is the rule for which), and a draw
// takes only the lots of the site it names. consumeFifoTx and addLotTx take
// `locationId` (required; null = the company's stock home, or the company
// pool when it has no location at all); a location of another company is 422
// LOCATION_NOT_IN_COMPANY. returnToLotsTx / relabelToWasteTx write back into
// the very lots they name, so their rows carry those lots' site. Shortfalls
// are recorded and settled per site. A lot with no site met by a write at a
// site (history from before this build) is first moved to the stock home
// (adoptOrphanLotsTx). The per-site on-hand cache stock_balances is kept here
// with every lot change (InventoryItem.currentStock stays the company total,
// so every company reader keeps working), and self-checked per site.
// Transfers between sites of one company: transferOutTx (FIFO from the source
// lots, at lot cost, never clamped) and transferInTx (new lots at the
// destination at the shipped cost, each keeping its source lot's age); a
// cancel after ship returns the stock to its source lots (returnToLotsTx kind
// 'transfer_in'). Stock in transit is off the lots but still in the company's
// 12x0 — lotValuation adds it back for the company total.
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
import { ensureSiteCutover, rebuildStockBalancesTx, relocateStrandedLotsTx, stockHomeOf, strandedSiteIdsTx } from './stockSite.js'

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
  | 'transfer_out' | 'transfer_in' | 'prep_make'

/** Lot-in kinds (addLotTx). 'prep_make' = a prep batch's yield, a lot of the prep item (owner 2026-10-24, D3). */
export type LotInKind = 'receipt' | 'opening' | 'count_gain' | 'fifo_cutover' | 'legacy_return' | 'prep_make'
export type LotSourceType = 'goods_receipt_line' | 'count_gain' | 'opening' | 'fifo_cutover' | 'legacy_return' | 'prep_batch'

/** Kinds consumeFifoTx draws with. */
const CONSUME_KINDS: ReadonlySet<string> = new Set(['sale', 'count_loss', 'waste', 'prep_draw', 'supplier_return', 'transfer_out'])
/** Kinds returnToLotsTx puts back with ('transfer_in': a transfer cancelled after it shipped, back into its source lots). */
const RETURN_KINDS: ReadonlySet<string> = new Set(['sale_return', 'supplier_return', 'legacy_return', 'transfer_in'])
/** Movement kinds of a transfer between sites (stock in transit = −Σ their value). */
export const TRANSFER_KINDS = ['transfer_out', 'transfer_in'] as const

/** The movement kinds that make up an order's cost of sales (accounting/cogs.ts). Settles are posted on their own. */
export const ORDER_COGS_KINDS = ['sale', 'sale_return', 'sale_void'] as const

/** sourceType conventions the postings read movements back by (see the header). */
export const STOCK_SOURCE = {
  orderItemSale:   'order_item.sale',      // sale rows — sourceId OrderItem.id
  wasteLog:        'waste_log',            // waste (and a sold line's sale_void) rows — sourceId WasteLog.id
  countLine:       'physical_count_line',  // count_loss / count_gain / opening rows — sourceId PhysicalCountLine.id
  prepBatch:       'prep_batch',           // an ad-hoc batch's prep_draw rows; a recipe batch's prep_make lot — sourceId PrepBatch.id
  prepInput:       'prep_batch.input',     // a RECIPE batch's raw prep_draw rows (12x0 → 12x0 into the prep item; never cost of sales) — sourceId PrepBatch.id
  transferShip:    'stock_transfer.ship',  // transfer_out rows — sourceId StockTransfer.id
  transferReceive: 'stock_transfer.receive', // transfer_in lots — sourceId StockTransfer.id
  transferCancel:  'stock_transfer.cancel',  // transfer_in rows back into the source lots — sourceId StockTransfer.id
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
  if (!(await readFifoCutoverAt(prisma, tenantId))) {
    // Imported lazily: fifoCutover.ts imports this file.
    const { ensureFifoCutover } = await import('../modules/inventory/fifoCutover.js')
    await ensureFifoCutover(tenantId)
  }
  // Per-site stock (2026-10-24): the company's lots with no site go to its stock home, once.
  await ensureSiteCutover(tenantId)
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

/** currentStock must equal Σ lot remainingQty before a write (see the header); with a site, its balance row too. */
async function assertStockOnLots(tx: Tx, item: StockItem, site?: string | null): Promise<void> {
  if (site) {
    const [lots, bal] = await Promise.all([
      tx.stockLot.aggregate({ where: { inventoryItemId: item.id, locationId: site }, _sum: { remainingQty: true } }),
      tx.stockBalance.findUnique({ where: { inventoryItemId_locationId: { inventoryItemId: item.id, locationId: site } }, select: { qty: true } }),
    ])
    const onLots = lots._sum.remainingQty ?? 0
    const cached = bal?.qty ?? 0
    if (Math.abs(cached - onLots) > 1e-6 + 1e-9 * Math.max(Math.abs(onLots), Math.abs(cached))) {
      throw new AppError(
        'STOCK_SITE_NOT_ON_LOTS',
        `${item.name}: the site's stock on hand (${fmtQty(cached)} ${item.unit}) is not what its lots hold (${fmtQty(onLots)} ${item.unit}) — stock was changed outside lib/stockLedger.ts.`,
        500,
      )
    }
  }
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

/** The cache after a change: currentStock = Σ remainingQty; unitCostCents = the FIFO head; the per-site balances. */
async function syncItemTx(tx: Tx, itemId: string): Promise<void> {
  const agg = await tx.stockLot.aggregate({ where: { inventoryItemId: itemId }, _sum: { remainingQty: true } })
  let stock = agg._sum.remainingQty ?? 0
  if (Math.abs(stock) < LOT_OPEN_EPS) stock = 0
  const cost = await fifoHeadCost(tx, itemId)
  const it = await tx.inventoryItem.update({
    where: { id: itemId }, data: { currentStock: stock, ...(cost != null ? { unitCostCents: cost } : {}) }, select: { tenantId: true },
  })
  if (it.tenantId) await rebuildStockBalancesTx(tx, it.tenantId, [itemId])
}

// ─── Sites ───────────────────────────────────────────────────────────────────

/**
 * The site a write lands on (see the header): a named location must be the
 * item's company's (422 LOCATION_NOT_IN_COMPANY); none named = the stock home
 * (null only for a company with no location). With a site, the item's lots
 * with no site (history from before per-site stock) first move to the home.
 */
async function resolveSiteTx(tx: Tx, item: StockItem, locationId: string | null): Promise<string | null> {
  let site = locationId
  if (site) {
    const ok = await tx.location.findFirst({ where: { id: site, tenantId: item.tenantId }, select: { id: true } })
    if (!ok) throw new AppError('LOCATION_NOT_IN_COMPANY', `That location does not belong to ${item.name}'s company — stock never moves across companies`, 422)
    // A deleted outlet or the "General" holding place holds no stock: it lands at the stock home.
    if ((await strandedSiteIdsTx(tx, item.tenantId)).includes(site)) site = await stockHomeOf(tx, item.tenantId)
  } else {
    site = await stockHomeOf(tx, item.tenantId)
  }
  if (site) await adoptOrphanLotsTx(tx, item)
  return site
}

/**
 * Lots of the item with no site, or at a deleted / holding location, go to the company's stock home; every
 * lot-carrying movement of the item takes its lot's site (stockSite.ts relocateStrandedLotsTx). Under the item lock.
 */
async function adoptOrphanLotsTx(tx: Tx, item: StockItem): Promise<void> {
  const stranded = await strandedSiteIdsTx(tx, item.tenantId)
  const orphans = await tx.stockLot.count({
    where: { inventoryItemId: item.id, OR: [{ locationId: null }, ...(stranded.length > 0 ? [{ locationId: { in: stranded } }] : [])] },
  })
  if (orphans === 0) return
  const home = await stockHomeOf(tx, item.tenantId)
  if (!home) return
  await relocateStrandedLotsTx(tx, item.tenantId, home, [item.id])
}

/** On hand at one site (Σ its lots; `site` null = the company pool of a company with no location). */
export async function siteOnHand(db: Db, itemId: string, site: string | null): Promise<number> {
  const agg = await db.stockLot.aggregate({ where: { inventoryItemId: itemId, locationId: site }, _sum: { remainingQty: true } })
  const q = agg._sum.remainingQty ?? 0
  return Math.abs(q) < LOT_OPEN_EPS ? 0 : q
}

/** On hand per item at one site (null = no-site lots), for many items. A site's view of every reader. */
export async function siteOnHandMany(db: Db, itemIds: string[], site: string | null): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (itemIds.length === 0) return out
  const rows = await db.stockLot.groupBy({
    by: ['inventoryItemId'], where: { inventoryItemId: { in: itemIds }, locationId: site }, _sum: { remainingQty: true },
  })
  for (const r of rows) {
    const q = r._sum.remainingQty ?? 0
    out.set(r.inventoryItemId, Math.abs(q) < LOT_OPEN_EPS ? 0 : q)
  }
  return out
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
 * equal to the lots now, by construction). The COMPANY total (no
 * `locationId`) includes stock in transit between its sites — off the lots,
 * still in its 12x0 (−Σ transfer movement value); a site's (`locationId`)
 * is only what its lots hold.
 */
export async function lotValuation(db: Db, tenantId: string, asOf?: Date, o: { locationId?: string } = {}): Promise<Record<CostClass, number>> {
  const out = zeroByClass()
  const site = o.locationId ? { locationId: o.locationId } : {}
  if (!asOf) {
    const rows = await db.stockLot.groupBy({ by: ['costClass'], where: { tenantId, ...site }, _sum: { remainingValueCents: true } })
    for (const r of rows) out[asClass(r.costClass)] += sumCents(r._sum.remainingValueCents)
  } else {
    const rows = await db.stockMovement.groupBy({ by: ['costClass'], where: { tenantId, ...site, occurredAt: { lte: asOf } }, _sum: { valueCents: true } })
    for (const r of rows) out[asClass(r.costClass)] += sumCents(r._sum.valueCents)
  }
  if (!o.locationId) {
    const transit = await inTransitByClass(db, tenantId, asOf)
    for (const c of COST_CLASSES) out[c] += transit[c]
  }
  return out
}

/** Stock in transit between a company's sites, by class (shipped, not yet received or cancelled). */
export async function inTransitByClass(db: Db, tenantId: string, asOf?: Date): Promise<Record<CostClass, number>> {
  const out = zeroByClass()
  const rows = await db.stockMovement.groupBy({
    by: ['costClass'],
    where: { tenantId, kind: { in: [...TRANSFER_KINDS] }, ...(asOf ? { occurredAt: { lte: asOf } } : {}) },
    _sum: { valueCents: true },
  })
  for (const r of rows) out[asClass(r.costClass)] += -sumCents(r._sum.valueCents)
  return out
}

// ─── Drawing from lots ───────────────────────────────────────────────────────

interface OpenLot {
  id: string
  tenantId: string
  locationId: string | null
  inventoryItemId: string
  costClass: string
  unitCostCents: number
  remainingQty: number
  remainingValueCents: number
}

const OPEN_LOT_SELECT = {
  id: true, tenantId: true, locationId: true, inventoryItemId: true, costClass: true, unitCostCents: true, remainingQty: true, remainingValueCents: true,
} satisfies Prisma.StockLotSelect

async function openLotsTx(tx: Tx, itemId: string, site: string | null): Promise<OpenLot[]> {
  const lots = await tx.stockLot.findMany({
    where: { inventoryItemId: itemId, locationId: site, remainingQty: { gt: LOT_OPEN_EPS } },
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
  /** The site whose lots are drawn (required; null = the company's stock home — see the header). */
  locationId: string | null
  orderId?: string; orderItemId?: string; conceptId?: string | null; theoreticalQty?: number
  brandShares?: Array<{ conceptId: string; share: number }>; occurredAt: Date; createdById?: string | null
  /** Draw these lots first (a supplier return takes the bill's own lots), then FIFO — only lots at the site. */
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

  const site = await resolveSiteTx(tx, item, a.locationId)
  await assertStockOnLots(tx, item, site)
  let lots = await openLotsTx(tx, item.id, site)
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
      `Only ${fmtQty(onHand)} ${item.unit} of ${item.name} on hand${site ? ' at this site' : ''} — ${fmtQty(a.qty)} ${item.unit} cannot be taken. Count it or receive it first.`,
      422,
    )
  }

  const theo = (q: number): number | null =>
    a.theoreticalQty == null || !Number.isFinite(a.theoreticalQty) ? null : (a.theoreticalQty * q) / a.qty
  const shares = a.brandShares ? brandSharesJson(a.brandShares) : undefined
  const common = {
    tenantId: item.tenantId, inventoryItemId: item.id, kind: a.kind, sourceType: a.sourceType, sourceId: a.sourceId,
    conceptId: a.conceptId ?? null, locationId: site, orderId: a.orderId ?? null, orderItemId: a.orderItemId ?? null,
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

interface Group { itemId: string; lotId: string; qty: number; value: number; rowIds: string[]; costClass: CostClass }

/** Merge rows per (item, lot); lot-less and zero rows are skipped. Amounts are magnitudes. */
function groupRows(rows: MovementRow[]): Group[] {
  const out = new Map<string, Group>()
  for (const r of rows) {
    if (!r.lotId) continue
    const q = Math.abs(r.qty)
    const v = Math.abs(r.valueCents)
    if (q < STOCK_EPS && v === 0) continue
    const key = `${r.inventoryItemId}|${r.lotId}`
    const g = out.get(key) ?? { itemId: r.inventoryItemId, lotId: r.lotId, qty: 0, value: 0, rowIds: [], costClass: r.costClass }
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
  rows: MovementRow[]; kind: 'sale_return' | 'supplier_return' | 'legacy_return' | 'transfer_in'; sourceType: string; sourceId: string; occurredAt: Date
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
    // A transfer cancelled after the item changed class while the stock travelled: it comes back in the class it was
    // shipped in (in transit nets to zero by class), then moves to the lot's class with the class-change posting.
    const shippedClass = a.kind === 'transfer_in' && g.costClass !== lot.costClass ? g.costClass : null
    await tx.stockMovement.create({
      data: {
        tenantId: company, inventoryItemId: g.itemId, lotId: lot.id, lotKey: lot.id, kind: a.kind,
        qty: g.qty, valueCents: g.value, unitCostCents: lot.unitCostCents, costClass: shippedClass ?? lot.costClass,
        orderId: orig?.orderId ?? null, orderItemId: orig?.orderItemId ?? null, conceptId: orig?.conceptId ?? null,
        locationId: lot.locationId,
        sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: a.occurredAt, createdById: a.createdById ?? null,
      },
    })
    if (shippedClass && g.value !== 0) {
      const base = {
        tenantId: company, inventoryItemId: g.itemId, lotId: lot.id, kind: 'class_reclass', qty: 0, unitCostCents: lot.unitCostCents, locationId: lot.locationId,
        sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: a.occurredAt, createdById: a.createdById ?? null,
      }
      await tx.stockMovement.create({ data: { ...base, lotKey: `${lot.id}:from`, valueCents: -g.value, costClass: shippedClass } })
      await tx.stockMovement.create({ data: { ...base, lotKey: `${lot.id}:to`, valueCents: g.value, costClass: lot.costClass } })
      const { postItemReclassTx } = await import('../modules/accounting/inventoryPosting.js')
      await postItemReclassTx(tx, { itemId: g.itemId, auditLogId: `${a.sourceType}:${a.sourceId}:${lot.id}`, fromClass: shippedClass, toClass: asClass(lot.costClass), valueCents: g.value })
    }
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
      orderId: orig.orderId, orderItemId: orig.orderItemId, locationId: lot.locationId,
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
 * The share of the lot's units still ON HAND changes their value (a
 * 'cost_adjust' movement, qty 0) — the caller posts it to the class
 * inventory account; the share already used (`usedCents`) never touches a
 * lot — the caller posts it to 5060 (brand split by usage). On hand (stock by
 * site, 2026-10-24) = the lot's remainingQty + its units in transit to
 * another outlet + what is left of the lots they arrived in: the price
 * difference follows the units — the destination lots get their own
 * 'cost_adjust', units still travelling a lot-less 'transfer_out' row on their
 * transfer (lotKey 'reprice:<lotId>:<sourceType>:<sourceId>'; transferInTx /
 * a cancel carry it into the lot they land in). The lot's valueIn / unit cost
 * move by the whole delta; the head cost is refreshed. Idempotent per
 * (sourceType, sourceId, lot).
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
  const transitKey = `reprice:${lot.id}:${a.sourceType}:${a.sourceId}`

  const prior = await tx.stockMovement.findFirst({
    where: { tenantId: lot.tenantId, sourceType: a.sourceType, sourceId: a.sourceId, inventoryItemId: lot.inventoryItemId, kind: 'cost_adjust', lotKey: lot.id },
    select: { valueCents: true },
  })
  if (prior) {
    // Replay: the source lot's part + its destination lots' parts + the in-transit parts.
    const [dest, transit] = await Promise.all([
      tx.stockMovement.aggregate({
        where: {
          tenantId: lot.tenantId, sourceType: a.sourceType, sourceId: a.sourceId, inventoryItemId: lot.inventoryItemId, kind: 'cost_adjust',
          lot: { sourceType: 'transfer_in', sourceId: { endsWith: `:${lot.id}` } },
        },
        _sum: { valueCents: true },
      }),
      tx.stockMovement.aggregate({ where: { tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, kind: 'transfer_out', lotKey: transitKey }, _sum: { valueCents: true } }),
    ])
    const onHand = toCents(prior.valueCents) + sumCents(dest._sum.valueCents) - sumCents(transit._sum.valueCents)
    return { onHandCents: onHand, usedCents: a.deltaCents - onHand }
  }
  if (a.deltaCents === 0) return { onHandCents: 0, usedCents: 0 }

  // Where the lot's units are now: the lot itself, travelling (per transfer), arrived (per destination lot).
  const parts: Array<{ kind: 'lot' | 'dest' | 'transit'; id: string; qty: number; value: number; locationId: string | null; costClass: string; transferId?: string }> = [
    { kind: 'lot', id: lot.id, qty: lot.remainingQty < LOT_OPEN_EPS ? 0 : lot.remainingQty, value: toCents(lot.remainingValueCents), locationId: lot.locationId, costClass: lot.costClass },
  ]
  const outs = await tx.stockMovement.groupBy({
    by: ['sourceId'], where: { tenantId: lot.tenantId, lotId: lot.id, kind: 'transfer_out', sourceType: STOCK_SOURCE.transferShip }, _sum: { qty: true, valueCents: true },
  })
  if (outs.length > 0) {
    const transferIds = outs.map((o) => o.sourceId)
    const [arrived, cancelled] = await Promise.all([
      tx.stockLot.findMany({
        where: { tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, sourceType: 'transfer_in', sourceId: { in: transferIds.map((t) => `${t}:${lot.id}`) } },
        select: { id: true, sourceId: true, remainingQty: true, remainingValueCents: true, locationId: true, costClass: true },
      }),
      tx.stockMovement.findMany({
        where: { tenantId: lot.tenantId, lotId: lot.id, kind: 'transfer_in', sourceType: STOCK_SOURCE.transferCancel, sourceId: { in: transferIds } },
        select: { sourceId: true }, distinct: ['sourceId'],
      }),
    ])
    const back = new Set(cancelled.map((c) => c.sourceId))
    for (const o of outs) {
      const d = arrived.find((l) => l.sourceId === `${o.sourceId}:${lot.id}`)
      if (d) {
        if (d.remainingQty > LOT_OPEN_EPS) {
          parts.push({ kind: 'dest', id: d.id, qty: d.remainingQty, value: toCents(d.remainingValueCents), locationId: d.locationId, costClass: d.costClass })
        }
      } else if (!back.has(o.sourceId) && -(o._sum.qty ?? 0) > LOT_OPEN_EPS) {
        parts.push({ kind: 'transit', id: o.sourceId, qty: -(o._sum.qty ?? 0), value: -sumCents(o._sum.valueCents), locationId: null, costClass: lot.costClass, transferId: o.sourceId })
      }
    }
  }
  const heldQty = parts.reduce((t, p) => t + p.qty, 0)
  const fraction = lot.qtyIn > 0 ? Math.min(1, Math.max(0, heldQty / lot.qtyIn)) : 0
  const onHandTarget = heldQty < LOT_OPEN_EPS ? 0 : fraction >= 1 ? a.deltaCents : Math.round(a.deltaCents * fraction)
  // Split exactly by quantity (the last part takes the rounding); a credit never takes a part below zero value.
  let left = onHandTarget
  let onHand = 0
  const held = parts.filter((p) => p.qty > LOT_OPEN_EPS || p.kind === 'lot')
  const shares = held.map((p, idx) => {
    const last = idx === held.length - 1
    let share = last ? left : (heldQty > 0 ? Math.round((onHandTarget * p.qty) / heldQty) : 0)
    if (p.value + share < 0) share = -p.value
    left -= share
    onHand += share
    return { p, share }
  })
  const used = a.deltaCents - onHand
  const valueIn = toCents(lot.valueInCents) + a.deltaCents
  const unitCost = lot.qtyIn > 0 ? Math.max(0, Math.round(valueIn / lot.qtyIn)) : lot.unitCostCents
  assertInt4Fits(unitCost, `${item.name}'s re-priced unit cost`)

  const at = new Date()
  for (const { p, share } of shares) {
    if (p.kind === 'lot') {
      await tx.stockLot.update({ where: { id: lot.id }, data: { remainingValueCents: p.value + share, valueInCents: valueIn, unitCostCents: unitCost } })
      // Always written: it is the replay key of this re-pricing.
      await tx.stockMovement.create({
        data: {
          tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, lotId: lot.id, lotKey: lot.id, kind: 'cost_adjust', locationId: lot.locationId,
          qty: 0, valueCents: share, unitCostCents: unitCost, costClass: lot.costClass, sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: at,
        },
      })
    } else if (p.kind === 'dest') {
      if (share === 0) continue
      const d = await tx.stockLot.findUniqueOrThrow({ where: { id: p.id }, select: { valueInCents: true, qtyIn: true, unitCostCents: true } })
      const dIn = toCents(d.valueInCents) + share
      const dUnit = d.qtyIn > 0 ? Math.max(0, Math.round(dIn / d.qtyIn)) : d.unitCostCents
      await tx.stockLot.update({ where: { id: p.id }, data: { remainingValueCents: p.value + share, valueInCents: dIn, unitCostCents: dUnit } })
      await tx.stockMovement.create({
        data: {
          tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, lotId: p.id, lotKey: p.id, kind: 'cost_adjust', locationId: p.locationId,
          qty: 0, valueCents: share, unitCostCents: dUnit, costClass: p.costClass, sourceType: a.sourceType, sourceId: a.sourceId, occurredAt: at,
        },
      })
    } else {
      if (share === 0) continue
      await tx.stockMovement.create({
        data: {
          tenantId: lot.tenantId, inventoryItemId: lot.inventoryItemId, lotId: null, lotKey: transitKey, kind: 'transfer_out',
          qty: 0, valueCents: -share, unitCostCents: unitCost, costClass: p.costClass,
          sourceType: STOCK_SOURCE.transferShip, sourceId: p.transferId!, occurredAt: at,
        },
      })
    }
  }
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
    select: { id: true, tenantId: true, locationId: true, costClass: true, unitCostCents: true, remainingQty: true, remainingValueCents: true },
  })
  const at = a.occurredAt ?? new Date()
  for (const l of lots) {
    if (l.tenantId !== item.tenantId) throw crossCompany(`Lot ${l.id}`)
    const v = toCents(l.remainingValueCents)
    if (v !== 0 || l.remainingQty > LOT_OPEN_EPS) {
      const from = asClass(l.costClass)
      byFromClass[from] += v
      const base = {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: l.id, kind: 'class_reclass', qty: 0, unitCostCents: l.unitCostCents, locationId: l.locationId,
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
  /** The site the lot lands at (required; null = the company's stock home — see the header). */
  locationId: string | null
  receiptLineId?: string; receivedAt: Date; createdById?: string | null
  /** Stored on the lot-in movement (a count gain's brand split, as posted). */
  brandShares?: Array<{ conceptId: string; share: number }>
  /** The lot's cost class when it is not the item's own (a prep lot keeps its inputs' class). */
  costClass?: CostClass
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

  const site = await resolveSiteTx(tx, item, a.locationId)
  if (a.kind !== 'fifo_cutover') {
    const hasLots = a.kind === 'opening' ? (await tx.stockLot.count({ where: { inventoryItemId: item.id } })) > 0 : true
    if (hasLots) await assertStockOnLots(tx, item, site)
  }

  const costClass = a.costClass ?? costClassOf(item.category)
  const lot = await tx.stockLot.create({
    data: {
      tenantId: item.tenantId, inventoryItemId: item.id, locationId: site,
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
      locationId: site, sourceType: a.movementSourceType, sourceId: a.movementSourceId,
      occurredAt: a.receivedAt, createdById: a.createdById ?? null,
      ...(a.brandShares ? { brandShares: brandSharesJson(a.brandShares) } : {}),
    },
    select: { id: true },
  })

  let settled: { valueCents: number } | undefined
  let issued: { valueCents: number } | undefined
  if (a.kind === 'prep_make') {
    // A prep batch's yield settles the site's open sale shortfalls of the prep item, like a delivery would.
    const lotNow = { id: lot.id, tenantId: item.tenantId, locationId: site, inventoryItemId: item.id, costClass, unitCostCents: a.unitCostCents, remainingQty: a.qty, remainingValueCents: value }
    const s = await settleShortfallsTx(tx, item, lotNow, a.receivedAt)
    if (s > 0) settled = { valueCents: s }
  }
  if (a.kind === 'receipt') {
    await recordPurchasePriceTx(tx, item, a)
    const lotNow = { id: lot.id, tenantId: item.tenantId, locationId: site, inventoryItemId: item.id, costClass, unitCostCents: a.unitCostCents, remainingQty: a.qty, remainingValueCents: value }
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

/**
 * THE rule for which sale shortfalls are no longer owed (food that was never
 * eaten): a line voided (a fully-short line's void writes no movement — the
 * line's own status says it), a line since returned or wasted for THAT item
 * (a "Box given" undo gives back the packaging, not the food), an order
 * cancelled / rejected, a "Box given" tap since undone (its draw was its
 * packaging; the line no longer carries that tap). The settle of a new lot
 * (settleShortfallsTx) and the open-shortfall list (modules/inventory/
 * siteStock.ts) both read it. Returns the dead sale-row ids.
 */
export async function deadShortfallSaleIdsTx(db: Db, tenantId: string, sales: Array<{
  id: string; inventoryItemId: string; orderId: string | null; orderItemId: string | null; sourceType: string; sourceId: string
}>): Promise<Set<string>> {
  const out = new Set<string>()
  if (sales.length === 0) return out
  const lineIds = [...new Set(sales.map((x) => x.orderItemId).filter((x): x is string => !!x))]
  const orderIds = [...new Set(sales.map((x) => x.orderId).filter((x): x is string => !!x))]
  const [lines, undoneRows, deadOrders] = await Promise.all([
    lineIds.length === 0 ? [] : db.orderItem.findMany({ where: { id: { in: lineIds } }, select: { id: true, status: true, voidedAt: true, boxGiven: true, boxGivenAt: true } }),
    lineIds.length === 0 ? [] : db.stockMovement.findMany({
      where: {
        tenantId, orderItemId: { in: lineIds }, inventoryItemId: { in: [...new Set(sales.map((x) => x.inventoryItemId))] },
        kind: { in: ['sale_return', 'sale_void'] }, sourceType: { not: 'order_item.box_given_undo' },
      },
      select: { orderItemId: true, inventoryItemId: true },
      distinct: ['orderItemId', 'inventoryItemId'],
    }),
    orderIds.length === 0 ? [] : db.order.findMany({ where: { id: { in: orderIds }, status: { in: ['cancelled', 'rejected'] } }, select: { id: true } }),
  ])
  const lineById = new Map(lines.map((l) => [l.id, l]))
  const undone = new Set(undoneRows.map((r) => `${r.orderItemId}|${r.inventoryItemId}`))
  const deadOrder = new Set(deadOrders.map((o) => o.id))
  for (const x of sales) {
    const l = x.orderItemId ? lineById.get(x.orderItemId) : undefined
    const voided = !!l && (!!l.voidedAt || l.status === 'voided')
    const returned = !!x.orderItemId && undone.has(`${x.orderItemId}|${x.inventoryItemId}`)
    const tapUndone = x.sourceType === 'order_item.box_given' && !!x.orderItemId
      && (!l || !l.boxGiven || `${l.id}@${l.boxGivenAt ? l.boxGivenAt.getTime() : 0}` !== x.sourceId)
    if (voided || returned || tapUndone || (x.orderId && deadOrder.has(x.orderId))) out.add(x.id)
  }
  return out
}

/** Settle open sale shortfalls of the item from a new receipt lot (see addLotTx). Returns the value settled. */
async function settleShortfallsTx(tx: Tx, item: StockItem, lot: LotNow, receivedAt: Date): Promise<number> {
  const from = new Date(receivedAt.getTime() - SHORTFALL_SETTLE_DAYS * DAY_MS)
  const sales = await tx.stockMovement.findMany({
    where: { tenantId: item.tenantId, inventoryItemId: item.id, locationId: lot.locationId, kind: 'sale', shortfallQty: { gt: STOCK_EPS }, occurredAt: { gte: from } },
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
  const dead = await deadShortfallSaleIdsTx(tx, item.tenantId, sales.map((x) => ({ ...x, inventoryItemId: item.id })))

  let qtyLeft = lot.remainingQty
  let valueLeft = lot.remainingValueCents
  let settledValue = 0
  const byConcept = new Map<string, { conceptId: string | null; costClass: CostClass; cents: number }>()
  for (const s of sales) {
    if (qtyLeft < STOCK_EPS) break
    if (dead.has(s.id)) continue
    const open = (s.shortfallQty ?? 0) - (settledBy.get(s.id) ?? 0)
    if (open < STOCK_EPS) continue
    const d = planDraws([{ ...lot, remainingQty: qtyLeft, remainingValueCents: valueLeft }], open).draws[0]
    if (!d) continue
    await tx.stockMovement.create({
      data: {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: 'shortfall_settle',
        qty: -d.take, valueCents: -d.value, unitCostCents: lot.unitCostCents, costClass: lot.costClass,
        settlesMovementId: s.id, orderId: s.orderId, orderItemId: s.orderItemId, conceptId: s.conceptId, locationId: lot.locationId,
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
      tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: 'issue_on_receipt', locationId: lot.locationId,
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

// ─── Transfers between sites ─────────────────────────────────────────────────

/**
 * A shipped stock transfer arrives (see the header): for every lot the ship
 * drew from ('transfer_out', sourceType STOCK_SOURCE.transferShip + transfer
 * id), a new lot at `toLocationId` with the same quantity, value, unit cost,
 * class and age (receivedAt of the source lot, so FIFO order carries over),
 * lot source 'transfer_in' '<transferId>:<sourceLotId>', movement kind
 * 'transfer_in'. Settles the destination's open sale shortfalls like a
 * delivery — unless `settle: false`: a receipt with a shortfall books the
 * loss from these lots FIRST, then calls settleTransferLotsTx (else the
 * settle could take the very units the loss must draw — NEGATIVE_STOCK).
 * Posts nothing (same company, same 12x0) except a class change: a lot lands
 * in the item's CURRENT cost class, and when it was shipped in another one a
 * 'class_reclass' pair (lotKey '<lotId>:from' / ':to') and the class-change
 * posting (postItemReclassTx) move its value. Idempotent per transfer.
 * Returns the new lot ids and the value moved.
 */
export async function transferInTx(tx: Tx, a: {
  tenantId: string; inventoryItemId: string; transferId: string; toLocationId: string; receivedAt: Date; createdById?: string | null
  settle?: boolean
}): Promise<{ lotIds: string[]; qty: number; valueCents: number }> {
  const item = await itemForWrite(tx, a.inventoryItemId, a.tenantId)
  const site = await resolveSiteTx(tx, item, a.toLocationId)
  if (!site) throw new AppError('LOCATION_REQUIRED', 'A transfer arrives at a site', 422)
  const outs = await tx.stockMovement.findMany({
    where: { tenantId: item.tenantId, inventoryItemId: item.id, kind: 'transfer_out', sourceType: STOCK_SOURCE.transferShip, sourceId: a.transferId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { lotId: true, lotKey: true, qty: true, valueCents: true, unitCostCents: true, costClass: true, lot: { select: { receivedAt: true } } },
  })
  // Price differences re-priced onto the units in transit (repriceLotTx: lot-less rows, lotKey 'reprice:<lotId>:…').
  const adjBySourceLot = new Map<string, number>()
  for (const o of outs) {
    if (o.lotId || !o.lotKey.startsWith('reprice:')) continue
    const lotId = o.lotKey.split(':')[1]!
    adjBySourceLot.set(lotId, (adjBySourceLot.get(lotId) ?? 0) + -toCents(o.valueCents))
  }
  const toClass = costClassOf(item.category)
  const lotIds: string[] = []
  let qty = 0
  let value = 0
  const prior = await tx.stockLot.findMany({
    where: { tenantId: item.tenantId, inventoryItemId: item.id, sourceType: 'transfer_in', sourceId: { startsWith: `${a.transferId}:` } },
    select: { id: true, qtyIn: true, valueInCents: true },
  })
  if (prior.length > 0) {
    return { lotIds: prior.map((p) => p.id), qty: prior.reduce((t, p) => t + p.qtyIn, 0), valueCents: prior.reduce((t, p) => t + toCents(p.valueInCents), 0) }
  }
  await assertStockOnLots(tx, item, site)
  for (const o of outs) {
    if (!o.lotId) continue
    const q = -o.qty
    const v = -toCents(o.valueCents) + (adjBySourceLot.get(o.lotId) ?? 0)
    adjBySourceLot.delete(o.lotId)
    if (!(q > STOCK_EPS) && v === 0) continue
    const unitCost = q > STOCK_EPS ? Math.max(0, Math.round(v / q)) : o.unitCostCents
    const lot = await tx.stockLot.create({
      data: {
        tenantId: item.tenantId, inventoryItemId: item.id, locationId: site, sourceType: 'transfer_in', sourceId: `${a.transferId}:${o.lotId}`,
        costClass: toClass, receivedAt: o.lot?.receivedAt ?? a.receivedAt, qtyIn: q, remainingQty: q, unitCostCents: unitCost,
        valueInCents: v, remainingValueCents: v,
      },
      select: { id: true },
    })
    // The arrival in the class it was SHIPPED in (in transit nets to zero by class) …
    await tx.stockMovement.create({
      data: {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, lotKey: lot.id, kind: 'transfer_in',
        qty: q, valueCents: v, unitCostCents: unitCost, costClass: o.costClass, locationId: site,
        sourceType: STOCK_SOURCE.transferReceive, sourceId: a.transferId, occurredAt: a.receivedAt, createdById: a.createdById ?? null,
      },
    })
    // … moved to the item's current class when the item changed class while it travelled.
    if (o.costClass !== toClass && v !== 0) {
      const base = {
        tenantId: item.tenantId, inventoryItemId: item.id, lotId: lot.id, kind: 'class_reclass', qty: 0, unitCostCents: unitCost, locationId: site,
        sourceType: STOCK_SOURCE.transferReceive, sourceId: a.transferId, occurredAt: a.receivedAt, createdById: a.createdById ?? null,
      }
      await tx.stockMovement.create({ data: { ...base, lotKey: `${lot.id}:from`, valueCents: -v, costClass: o.costClass } })
      await tx.stockMovement.create({ data: { ...base, lotKey: `${lot.id}:to`, valueCents: v, costClass: toClass } })
      const { postItemReclassTx } = await import('../modules/accounting/inventoryPosting.js')
      await postItemReclassTx(tx, { itemId: item.id, auditLogId: `transfer:${a.transferId}:${lot.id}`, fromClass: asClass(o.costClass), toClass, valueCents: v })
    }
    lotIds.push(lot.id)
    qty += q
    value += v
  }
  await syncItemTx(tx, item.id)
  if (a.settle !== false) await settleTransferLotsTx(tx, { tenantId: item.tenantId, inventoryItemId: item.id, lotIds, at: a.receivedAt })
  return { lotIds, qty, valueCents: value }
}

/** Settle the destination site's open sale shortfalls from what is left of arrived transfer lots (see transferInTx). */
export async function settleTransferLotsTx(tx: Tx, a: { tenantId: string; inventoryItemId: string; lotIds: string[]; at: Date }): Promise<number> {
  if (a.lotIds.length === 0) return 0
  const item = await itemForWrite(tx, a.inventoryItemId, a.tenantId)
  let settled = 0
  for (const id of a.lotIds) {
    const l = await tx.stockLot.findUniqueOrThrow({ where: { id }, select: OPEN_LOT_SELECT })
    if (l.remainingQty < STOCK_EPS) continue
    settled += await settleShortfallsTx(tx, item, { ...l, remainingValueCents: toCents(l.remainingValueCents) }, a.at)
  }
  await syncItemTx(tx, item.id)
  return settled
}

/** The transfer_out rows of a shipped transfer still off the lots (net of a cancel's give-back) — for a cancel. */
export async function transferOutRowsTx(tx: Tx, tenantId: string, transferId: string): Promise<MovementRow[]> {
  const rows = await tx.stockMovement.findMany({
    where: { tenantId, kind: 'transfer_out', sourceType: STOCK_SOURCE.transferShip, sourceId: transferId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { ...ROW_SELECT, lotKey: true },
  })
  // A price difference re-priced onto the units in transit (lot-less 'reprice:<lotId>:…' rows) goes back with them.
  const out = rows.filter((r) => r.lotId).map(toRow)
  for (const r of rows) {
    if (r.lotId || !r.lotKey.startsWith('reprice:')) continue
    const target = out.find((o) => o.lotId === r.lotKey.split(':')[1])
    if (target) target.valueCents += toCents(r.valueCents)
  }
  return out
}
