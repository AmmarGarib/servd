// servd's ingredient PRICES (owner, 2026-10-29: "this sheet needs to be a pure ingredient availability and pricing
// sheet … this list purely exists for people to create recipes on servd and see avg cost on that recipe basis
// historical prices of those items"; answers: ONE servd price, latest cost with the average shown beside).
//
// ONE price per servd ingredient (IngredientMaster), DELIBERATELY servd-wide — the owner's decision: every company's
// purchases of the ingredient count, and the price history names the company and supplier. Read only; nothing here
// writes, posts or touches stock. Stock value, FIFO lots, cost of sales and food-cost actuals stay each company's
// own, at the price it paid (lib/stockLedger.ts) — this is for RECIPE costing and the Ingredients sheet only.
//
// Prices are held per BASE unit of the ingredient's family (g / ml / pcs — lib/ingredientMaster.ts unitFamily), so
// a kg-bought item and a g-bought item of one ingredient compare. Shown per kg / litre / pcs (displayUnitOf).
//
//   latest  = the newest delivery (a goods-receipt stock lot) of the ingredient anywhere in servd; with none, the
//             newest billed price (item_price_history 'bill_match'), else the newest manual cost, else the highest
//             typed estimate on a linked item.
//   average = the quantity-weighted average of deliveries in the last AVERAGE_DAYS days (null with none).

import { Prisma } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { unitFamily } from './ingredientMaster.js'

export const AVERAGE_DAYS = 90

type Db = Prisma.TransactionClient | typeof serviceClient

export interface MasterPrice {
  /** Paisa per base unit (g / ml / pcs) — fractional. */
  latestPerBase: number | null
  latestAt: Date | null
  latestSource: 'delivery' | 'bill' | 'manual' | 'estimate' | null
  latestSupplier: string | null
  latestCompany: string | null
  /** Quantity-weighted average of deliveries in the last AVERAGE_DAYS days, paisa per base unit. */
  avgPerBase: number | null
  avgDeliveries: number
}

/** How a family's price is SHOWN: per kg, per litre, per pcs (or the ingredient's own unit). */
export function displayUnitOf(stockUnit: string): { unit: string; baseUnits: number } {
  const f = unitFamily(stockUnit)
  if (f.family === 'mass') return { unit: 'kg', baseUnits: 1000 }
  if (f.family === 'volume') return { unit: 'litre', baseUnits: 1000 }
  if (f.family === 'count') return { unit: 'pcs', baseUnits: 1 }
  return { unit: f.base, baseUnits: 1 }
}

interface ItemRow { id: string; masterIngredientId: string | null; unit: string; unitCostCents: number | null; tenantId: string | null }

async function linkedItems(db: Db, masterIds: string[]): Promise<ItemRow[]> {
  if (masterIds.length === 0) return []
  return db.inventoryItem.findMany({
    where: { masterIngredientId: { in: masterIds } },
    select: { id: true, masterIngredientId: true, unit: true, unitCostCents: true, tenantId: true },
  })
}

/** Supplier name of each goods-receipt line (receipt → supplierId → supplier). */
async function supplierOfLines(db: Db, lineIds: string[]): Promise<Map<string, string | null>> {
  if (lineIds.length === 0) return new Map()
  const lines = await db.goodsReceiptLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, receiptId: true } })
  const receipts = await db.goodsReceipt.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.receiptId))] } }, select: { id: true, supplierId: true } })
  const suppliers = await db.supplier.findMany({ where: { id: { in: [...new Set(receipts.map((r) => r.supplierId))] } }, select: { id: true, name: true } })
  const supName = new Map(suppliers.map((x) => [x.id, x.name]))
  const recSup = new Map(receipts.map((r) => [r.id, supName.get(r.supplierId) ?? null]))
  return new Map(lines.map((l) => [l.id, recSup.get(l.receiptId) ?? null]))
}

const perBaseOf = (cents: number, itemUnit: string) => {
  const per = unitFamily(itemUnit).perUnit
  return per > 0 ? cents / per : cents
}

/** The servd price of each ingredient (see the header). */
export async function masterPricesMany(masterIds: string[], db: Db = serviceClient): Promise<Map<string, MasterPrice>> {
  const ids = [...new Set(masterIds)]
  const out = new Map<string, MasterPrice>()
  if (ids.length === 0) return out
  const items = await linkedItems(db, ids)
  const itemById = new Map(items.map((i) => [i.id, i]))
  const itemIds = items.map((i) => i.id)
  for (const id of ids) out.set(id, { latestPerBase: null, latestAt: null, latestSource: null, latestSupplier: null, latestCompany: null, avgPerBase: null, avgDeliveries: 0 })
  if (itemIds.length === 0) return out

  const since = new Date(Date.now() - AVERAGE_DAYS * 86_400_000)
  const lots = await db.stockLot.findMany({
    where: { inventoryItemId: { in: itemIds }, sourceType: 'goods_receipt_line' },
    select: { inventoryItemId: true, unitCostCents: true, qtyIn: true, receivedAt: true, tenantId: true, receiptLineId: true },
    orderBy: [{ receivedAt: 'desc' }, { createdAt: 'desc' }],
  })
  // The newest delivery per ingredient, and the 90-day weighted sums.
  const newest = new Map<string, (typeof lots)[number]>()
  const sums = new Map<string, { value: number; qty: number; n: number }>()
  for (const l of lots) {
    const item = itemById.get(l.inventoryItemId)
    if (!item?.masterIngredientId) continue
    const m = item.masterIngredientId
    if (!newest.has(m)) newest.set(m, l)
    if (l.receivedAt >= since && l.qtyIn > 0) {
      const per = unitFamily(item.unit).perUnit || 1
      const s = sums.get(m) ?? { value: 0, qty: 0, n: 0 }
      s.value += Number(l.unitCostCents) * l.qtyIn
      s.qty += l.qtyIn * per
      s.n += 1
      sums.set(m, s)
    }
  }
  // Supplier and company names of the newest deliveries.
  const supplierOfLine = await supplierOfLines(db, [...newest.values()].map((l) => l.receiptLineId).filter((x): x is string => !!x))
  const tenantIds = [...new Set([...newest.values()].map((l) => l.tenantId))]
  const tenants = tenantIds.length ? await db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }) : []
  const companyName = new Map(tenants.map((t) => [t.id, t.name]))

  for (const [m, l] of newest) {
    const item = itemById.get(l.inventoryItemId)!
    const p = out.get(m)!
    p.latestPerBase = perBaseOf(Number(l.unitCostCents), item.unit)
    p.latestAt = l.receivedAt
    p.latestSource = 'delivery'
    p.latestSupplier = l.receiptLineId ? (supplierOfLine.get(l.receiptLineId) ?? null) : null
    p.latestCompany = companyName.get(l.tenantId) ?? null
  }
  for (const [m, s] of sums) {
    const p = out.get(m)!
    p.avgPerBase = s.qty > 0 ? s.value / s.qty : null
    p.avgDeliveries = s.n
  }

  // No delivery yet: the newest billed price, else the newest manual cost, else the typed estimate.
  const missing = ids.filter((m) => out.get(m)!.latestPerBase == null)
  if (missing.length) {
    const missingItems = items.filter((i) => i.masterIngredientId && missing.includes(i.masterIngredientId))
    const hist = missingItems.length ? await db.itemPriceHistory.findMany({
      where: { inventoryItemId: { in: missingItems.map((i) => i.id) }, source: { in: ['bill_match', 'manual_adjust'] } },
      select: { inventoryItemId: true, newCostCents: true, recordedAt: true, source: true, supplier: { select: { name: true } } },
      orderBy: { recordedAt: 'desc' },
    }) : []
    for (const m of missing) {
      const p = out.get(m)!
      const mine = hist.filter((h) => itemById.get(h.inventoryItemId)?.masterIngredientId === m)
      const pick = mine.find((h) => h.source === 'bill_match') ?? mine.find((h) => h.source === 'manual_adjust')
      if (pick) {
        const item = itemById.get(pick.inventoryItemId)!
        p.latestPerBase = perBaseOf(pick.newCostCents, item.unit)
        p.latestAt = pick.recordedAt
        p.latestSource = pick.source === 'bill_match' ? 'bill' : 'manual'
        p.latestSupplier = pick.supplier?.name ?? null
        continue
      }
      const typed = missingItems.filter((i) => i.masterIngredientId === m && i.unitCostCents != null)
        .map((i) => perBaseOf(i.unitCostCents!, i.unit))
      if (typed.length) { p.latestPerBase = Math.max(...typed); p.latestSource = 'estimate' }
    }
  }
  return out
}

export interface PricePoint {
  at: Date
  source: 'delivery' | 'bill' | 'manual'
  /** Paisa per display unit (per kg / litre / pcs). */
  priceCents: number
  displayUnit: string
  /** Quantity delivered, in display units (deliveries only). */
  qty: number | null
  supplier: string | null
  company: string | null
}

/** Every price of one ingredient across servd, newest first (deliveries, bills, manual costs). */
export async function masterPriceHistory(masterId: string, stockUnit: string, limit = 200, db: Db = serviceClient): Promise<PricePoint[]> {
  const items = await linkedItems(db, [masterId])
  if (items.length === 0) return []
  const itemById = new Map(items.map((i) => [i.id, i]))
  const disp = displayUnitOf(stockUnit)
  const toDisplay = (cents: number, unit: string) => perBaseOf(cents, unit) * disp.baseUnits
  const lots = await db.stockLot.findMany({
    where: { inventoryItemId: { in: items.map((i) => i.id) }, sourceType: 'goods_receipt_line' },
    select: { inventoryItemId: true, unitCostCents: true, qtyIn: true, receivedAt: true, tenantId: true, receiptLineId: true },
    orderBy: { receivedAt: 'desc' }, take: limit,
  })
  const hist = await db.itemPriceHistory.findMany({
    where: { inventoryItemId: { in: items.map((i) => i.id) }, source: { in: ['bill_match', 'manual_adjust'] } },
    select: { inventoryItemId: true, newCostCents: true, recordedAt: true, source: true, supplier: { select: { name: true } } },
    orderBy: { recordedAt: 'desc' }, take: limit,
  })
  const supplierOfLine = await supplierOfLines(db, lots.map((l) => l.receiptLineId).filter((x): x is string => !!x))
  const tenantIds = [...new Set([...lots.map((l) => l.tenantId), ...items.map((i) => i.tenantId).filter((t): t is string => !!t)])]
  const tenants = tenantIds.length ? await db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }) : []
  const companyName = new Map(tenants.map((t) => [t.id, t.name]))
  const points: PricePoint[] = [
    ...lots.map((l) => {
      const item = itemById.get(l.inventoryItemId)!
      return {
        at: l.receivedAt, source: 'delivery' as const, priceCents: toDisplay(Number(l.unitCostCents), item.unit), displayUnit: disp.unit,
        qty: (l.qtyIn * (unitFamily(item.unit).perUnit || 1)) / disp.baseUnits,
        supplier: l.receiptLineId ? (supplierOfLine.get(l.receiptLineId) ?? null) : null, company: companyName.get(l.tenantId) ?? null,
      }
    }),
    ...hist.map((h) => {
      const item = itemById.get(h.inventoryItemId)!
      return {
        at: h.recordedAt, source: h.source === 'bill_match' ? 'bill' as const : 'manual' as const,
        priceCents: toDisplay(h.newCostCents, item.unit), displayUnit: disp.unit, qty: null,
        supplier: h.supplier?.name ?? null, company: item.tenantId ? (companyName.get(item.tenantId) ?? null) : null,
      }
    }),
  ]
  return points.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
}
