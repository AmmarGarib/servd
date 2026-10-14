// THE food-cost variance report (finance wave B, owner decisions 2026-10-13):
// actual vs recipe at the price actually paid (FIFO lots), split food /
// drinks / packaging, per company, per brand, per ingredient and by order
// type. ONE engine — the admin page (/reports/food-cost), the Accounting hub's
// gauge and the scheduled 'food_cost' email all read it. The old
// GET /recipes/food-cost is gone; nothing else computes food cost.
//
// Per company and period (PKT days), every figure in paisa, cost positive:
//
//   revenue      brand sales — accounting/reports.ts brandSalesByConcept (40xx
//                net of 7010 / 7020; 4100 service charge, 4110 delivery fees
//                and 42xx other income are NOT in it). One definition.
//   actual       the ledger's cost of sales 5010–5060 — accounting/reports.ts
//                costOfSalesByConcept (its food / drinks / packaging split of
//                5040 / 5050 / 5060). One definition.
//   theoretical  the orders SOLD in the period (completed or refunded — a
//                refund never un-cooks the meal), at the lots they actually
//                relieved: −Σ value of their 'sale' / 'sale_return' /
//                'sale_void' movements (the recipe, its sub-recipes, add-ons,
//                and the Packaging section where packagingApplies — takeaway /
//                delivery, a packaging-vessel brand, or a dine-in line marked
//                "Box given"), plus the SHORTFALL MEMO (what was cooked while
//                the lots were empty, valued at the latest purchase price).
//                The comp and staff-meal shares of an order (its 'comp'
//                payments, gatewayMeta.comp.kind, pro rata on the total) are
//                their own buckets, not theoretical.
//   explained    comps, staff meals, waste by reason, prep draws, issued on
//                receipt, late receipts that settled earlier shortfalls, price
//                adjustments (5060). Waste, prep, counts, issue and settles are
//                read from the STOCK DOCUMENTS (the movements of waste logs,
//                counts, prep batches, lots) — not only from 5040 / 5050 — so
//                they stay right while a difference waits for the CEO (H20,
//                the 1290 suspense) or a refused posting is re-posted.
//   unexplained  spot-count variance, the shortfall memo reversed ("cooked
//                before it was on the books") and any other entry to 5010–5050
//                (a manual journal).
//   alignment    the FIFO cut-over: orders placed before it booked at the old
//                plate cost ('pre-FIFO order') — its own line, never
//                unexplained. The one-time alignment itself posts to 3020 and
//                never touches cost of sales (shown on the Valuation tab).
//   timing       what the ledger has not booked yet or booked for another
//                period: sales (open orders, till orders whose drawer close is
//                not posted) and stock documents (awaiting the CEO, a refused
//                posting).
//
//   theoretical + explained + unexplained + alignment + timing == actual
//
// exactly, per brand and per company (the identity is computed and checked).
// The Q factor (Recipe.qFactorPct) is shown as an allowance 'in menu pricing,
// not stock' — never inside any figure above (H18).
//
// Brand view: lines tagged with a brand are MEASURED; brand-less waste /
// counts / prep / issue split by the shares stored on their movements
// (lib/brandShare.ts, H20, exactly as posted) are ALLOCATED; what is neither
// is head office's.
//
// Company separation: every query names the company; a block per company,
// never blended. Revenue and every % only when `revenueVisible`
// (FINANCIALS_VIEWERS) — everyone else gets quantities and PKR at cost.

import type { Prisma, PrismaClient, ScheduledReport } from '@prisma/client'
import { sumCents, toCents } from '../../lib/money.js'
import { AppError } from '../../lib/errors.js'
import { CLASS_ACCOUNTS, CLASS_LABEL, COST_CLASSES, costClassOf, type CostClass } from '../../lib/inventoryClass.js'
import { parseBrandShares, splitCents } from '../../lib/brandShare.js'
import { lotValuation, ORDER_COGS_KINDS, readFifoCutoverAt, STOCK_SOURCE } from '../../lib/stockLedger.js'
import { menuItemPlateCosts, type RecipeCost } from '../../lib/recipeCost.js'
import { ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { shiftOfCompany } from '../../lib/tenantScope.js'
import { brandSalesByConcept, costOfSalesByConcept, HEAD_OFFICE_LABEL } from '../accounting/reports.js'
import { PRE_FIFO_MEMO, unbookedSalesCostByClass } from '../accounting/cogs.js'
import { ACCT } from '../accounting/journal.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { readCutover } from '../inventory/fifoCutover.js'
import { ORDER_COGS_FIX_SOURCES } from '../orders/stock.js'
import { grniLineOpenValues } from '../procurement/grniRoutes.js'
import { FINANCIALS_VIEWERS } from '../auth/middleware.js'
import type { CloseCheck } from '../accounting/closeCheckTypes.js'

type Db = Prisma.TransactionClient | PrismaClient

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** Food / drinks / packaging, paisa. drinks = the 'beverage' cost class. */
export interface ClassCents { foodCents: number; drinksCents: number; packagingCents: number; totalCents: number }

export type FoodCostStatus = 'no_data' | 'incomplete' | 'good' | 'warning' | 'critical'

export const FOOD_COST_STATUS_LABEL: Readonly<Record<FoodCostStatus, string>> = {
  no_data: 'No sales', incomplete: 'Incomplete data', good: 'On target', warning: 'Watch', critical: 'Over target',
}

/** Waste reasons (WasteLog.reason). returned_food stays empty until the parked delivery work resumes — the bucket is kept. */
export const WASTE_REASONS = [
  'spoilage', 'over_prep', 'expired', 'damaged', 'other', 'void_after_fire', 'cancelled_after_fire', 'returned_food', 'transit_loss', 'remake',
] as const
export type WasteReason = typeof WASTE_REASONS[number]
export const WASTE_REASON_LABEL: Readonly<Record<WasteReason, string>> = {
  spoilage: 'Spoilage', over_prep: 'Over-prep', expired: 'Expired', damaged: 'Damaged', other: 'Other waste',
  void_after_fire: 'Voided after firing', cancelled_after_fire: 'Cancelled after firing', returned_food: 'Returned food',
  transit_loss: 'Lost in transfer', remake: 'Remakes',
}

/** The Q factor's label everywhere it is shown (H18). */
export const Q_ALLOWANCE_LABEL = 'in menu pricing, not stock'

/** A bucket a brand MEASURED (lines tagged with it) or was ALLOCATED (brand-less documents split by usage, H20). */
export interface MeasuredAllocated { measuredCents: number; allocatedCents: number; totalCents: number }

export interface FoodCostBuckets {
  comps: ClassCents
  staffMeals: ClassCents
  waste: { byReason: Record<WasteReason, MeasuredAllocated>; total: MeasuredAllocated }
  prepDraws: MeasuredAllocated
  issueOnReceipt: MeasuredAllocated
  shortfallSettles: MeasuredAllocated
  /** 5060: bills priced off the receipt cost (used share), GRNI write-offs, credit notes. */
  priceAdjustments: number
  /** Spot counts: short positive, over negative. Unexplained. */
  countVariance: MeasuredAllocated
  /** The shortfall memo reversed: recipe value cooked while the lots were empty. Unexplained (≤ 0). */
  notOnBooks: number
  /** Any other entry to 5010–5050 (a manual journal). Unexplained. */
  otherEntries: number
}

export interface FoodCostTiming {
  /** Ledger sale cost of sales − the lots the period's sold orders relieved (open orders, open or unposted drawers, earlier sales booked now). */
  salesCents: number
  /** Ledger 5040 / 5050 / stock-document postings − the stock documents of the period (awaiting the CEO, refused postings). */
  stockDocsCents: number
  totalCents: number
}

export interface McByOrderType {
  fulfilmentType: 'dine_in' | 'takeout' | 'delivery'
  label: string
  orders: number
  /** Recipe material cost for these sales at today's recipe cost: food + drinks + packaging where the rule applies to the order type (no "Box given"). */
  targetMcCents: number
  /** What the lots gave (food / drinks / packaging, incl. "Box given" packaging) + the shortfall memo. */
  actualMc: ClassCents
  /** Item sales at menu price (revenue-visible only). */
  itemSalesCents?: number
  targetMcPct?: number | null
  actualMcPct?: number | null
}

export interface FoodCostWarning {
  code: 'pre_cutover' | 'no_recipe' | 'null_cost_lot' | 'sub_recipe_no_yield' | 'unapproved_recipe' | 'modifier_no_recipe'
    | 'foreign_lines' | 'open_orders' | 'open_shifts' | 'packaging_missing' | 'by_outlet' | 'ledger_check' | 'docs_not_booked'
  /** 'incomplete' makes the status 'incomplete'; 'timing' explains the timing line; 'warn' is shown only. */
  severity: 'incomplete' | 'warn' | 'timing'
  message: string
  count: number
  names?: string[]
  link?: string
}

export interface FoodCostItemRow {
  menuItemId: string
  name: string
  conceptId: string
  qtySold: number
  hasRecipe: boolean
  /** Recipe at the lots relieved + shortfall memo, every sale of the item (comps included). */
  costCents: number
  revenueCents?: number
  costPct?: number | null
  targetPct?: number | null
}

export interface FoodCostBrandBlock {
  conceptId: string | null
  name: string
  serviceVessel: string | null
  status: FoodCostStatus
  statusLabel: string
  revenueCents?: number
  targetPct?: number | null
  theoreticalPct?: number | null
  actualPct?: number | null
  avtPoints?: number | null
  theoretical: ClassCents
  actual: ClassCents | null
  buckets: FoodCostBuckets
  explainedCents: number
  unexplainedCents: number
  alignmentCents: number
  timing: FoodCostTiming | null
  qAllowanceCents: number
  mcByOrderType: McByOrderType[]
  /** theoretical + explained + unexplained + alignment + timing − actual (0 when the books tie). Null by outlet. */
  identityDiffCents: number | null
}

export interface FoodCostCompanyBlock extends Omit<FoodCostBrandBlock, 'conceptId' | 'name' | 'serviceVessel'> {
  tenantId: string
  companyName: string
  period: { from: string; to: string }
  revenueHidden: boolean
  cutoverAt: string | null
  conceptId: string | null
  locationId: string | null
  allowance: { qFactorCents: number; label: string }
  alignment: { preFifoOrdersCents: number; alignedAt: string | null; label: string }
  brands: FoodCostBrandBlock[]
  items: FoodCostItemRow[]
  warnings: FoodCostWarning[]
  openOrders: number
  openShifts: number
}

// ─── Small helpers ───────────────────────────────────────────────────────────

type ClassKey = 'foodCents' | 'drinksCents' | 'packagingCents'
const KEY_OF: Readonly<Record<CostClass, ClassKey>> = { food: 'foodCents', beverage: 'drinksCents', packaging: 'packagingCents' }
const asClass = (v: string | null | undefined): CostClass => ((COST_CLASSES as readonly string[]).includes(v ?? '') ? (v as CostClass) : 'food')

function zc(): ClassCents { return { foodCents: 0, drinksCents: 0, packagingCents: 0, totalCents: 0 } }
function addTo(c: ClassCents, cls: CostClass, cents: number): void {
  c[KEY_OF[cls]] += cents
  c.totalCents += cents
}
function addCls(a: ClassCents, b: ClassCents): void {
  a.foodCents += b.foodCents; a.drinksCents += b.drinksCents; a.packagingCents += b.packagingCents; a.totalCents += b.totalCents
}
function zma(): MeasuredAllocated { return { measuredCents: 0, allocatedCents: 0, totalCents: 0 } }
function addMa(m: MeasuredAllocated, cents: number, allocated: boolean): void {
  if (allocated) m.allocatedCents += cents
  else m.measuredCents += cents
  m.totalCents += cents
}
function addMaInto(a: MeasuredAllocated, b: MeasuredAllocated): void {
  a.measuredCents += b.measuredCents; a.allocatedCents += b.allocatedCents; a.totalCents += b.totalCents
}
function zBuckets(): FoodCostBuckets {
  const byReason = {} as Record<WasteReason, MeasuredAllocated>
  for (const r of WASTE_REASONS) byReason[r] = zma()
  return {
    comps: zc(), staffMeals: zc(), waste: { byReason, total: zma() }, prepDraws: zma(), issueOnReceipt: zma(), shortfallSettles: zma(),
    priceAdjustments: 0, countVariance: zma(), notOnBooks: 0, otherEntries: 0,
  }
}
function addBuckets(a: FoodCostBuckets, b: FoodCostBuckets): void {
  addCls(a.comps, b.comps); addCls(a.staffMeals, b.staffMeals)
  for (const r of WASTE_REASONS) addMaInto(a.waste.byReason[r], b.waste.byReason[r])
  addMaInto(a.waste.total, b.waste.total)
  addMaInto(a.prepDraws, b.prepDraws); addMaInto(a.issueOnReceipt, b.issueOnReceipt); addMaInto(a.shortfallSettles, b.shortfallSettles)
  a.priceAdjustments += b.priceAdjustments
  addMaInto(a.countVariance, b.countVariance)
  a.notOnBooks += b.notOnBooks
  a.otherEntries += b.otherEntries
}
const explainedOf = (b: FoodCostBuckets) =>
  b.comps.totalCents + b.staffMeals.totalCents + b.waste.total.totalCents + b.prepDraws.totalCents + b.issueOnReceipt.totalCents
  + b.shortfallSettles.totalCents + b.priceAdjustments
const unexplainedOf = (b: FoodCostBuckets) => b.countVariance.totalCents + b.notOnBooks + b.otherEntries

const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null)
const isWasteReason = (r: string): r is WasteReason => (WASTE_REASONS as readonly string[]).includes(r)

const FULFILMENT_LABEL: Readonly<Record<McByOrderType['fulfilmentType'], string>> = { dine_in: 'Dine-in', takeout: 'Takeaway', delivery: 'Delivery' }
const FULFILMENTS: ReadonlyArray<McByOrderType['fulfilmentType']> = ['dine_in', 'takeout', 'delivery']

/** The sourceType of a journal entry reference '<sourceType>:<sourceId>'. */
function sourceTypeOf(reference: string | null): string {
  if (!reference) return ''
  const i = reference.indexOf(':')
  return i < 0 ? reference : reference.slice(0, i)
}

/** Sale-side entries: the completion / drawer close, and the cost-of-sales fixes of orders/stock.ts. */
const SALE_SOURCES: ReadonlySet<string> = new Set(['order.complete', 'shift.close', ...ORDER_COGS_FIX_SOURCES])
/** Stock-document entries that book 5010–5030 (5040 / 5050 are stock documents whatever their source). */
const DOC_SOURCES: ReadonlySet<string> = new Set(['inventory.prep_draw', 'inventory.issue_on_receipt', 'inventory.shortfall_settle', 'inventory.waste', 'pos.void_waste', 'inventory.count'])
const COS_CODES = [ACCT.FOOD_COST, ACCT.BEVERAGE_COST, ACCT.PACKAGING_COST, ACCT.WASTE, ACCT.INVENTORY_VARIANCE, ACCT.COST_ADJUSTMENT]

/** Kinds of the stock documents read for the explained / unexplained buckets. */
const DOC_KINDS = ['waste', 'count_loss', 'count_gain', 'prep_draw', 'issue_on_receipt', 'shortfall_settle'] as const

/** 1290 Stock differences (H20): waste / count differences waiting for the CEO before they reach cost of sales. */
const STOCK_DIFF_SUSPENSE_CODE = ACCT.STOCK_DIFF_SUSPENSE

const OPEN_ORDER_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const
const SOLD_STATUSES = ['completed', 'refunded'] as const

function chunk<T>(xs: T[], n = 2000): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** A comp payment's kind ('comp' | 'staff_meal'), from gatewayMeta.comp.kind. */
function compKindOf(meta: Prisma.JsonValue | null): 'comp' | 'staff_meal' {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const c = (meta as Record<string, unknown>)['comp']
    if (c && typeof c === 'object' && !Array.isArray(c) && (c as Record<string, unknown>)['kind'] === 'staff_meal') return 'staff_meal'
  }
  return 'comp'
}

/** Split `cents` in two shares (rounded) and the rest — sums exactly. */
function shareSplit(cents: number, compShare: number, staffShare: number): { comp: number; staff: number; rest: number } {
  const comp = Math.round(cents * compShare)
  const staff = Math.round(cents * staffShare)
  return { comp, staff, rest: cents - comp - staff }
}

/** Per-brand accumulator (key '' = head office / unallocated). */
interface Acc {
  theoretical: ClassCents
  buckets: FoodCostBuckets
  shortfallMemo: number
  legacy: number
  saleLedger: number
  docLedger: number
  docs: number
  relieved: number
  actual: ClassCents
  revenue: number
  itemRevenue: number
  targetWeight: number
  targetRevenue: number
  qAllowance: number
  mc: Map<McByOrderType['fulfilmentType'], { orders: number; target: number; actual: ClassCents; sales: number }>
}
function zAcc(): Acc {
  return {
    theoretical: zc(), buckets: zBuckets(), shortfallMemo: 0, legacy: 0, saleLedger: 0, docLedger: 0, docs: 0, relieved: 0,
    actual: zc(), revenue: 0, itemRevenue: 0, targetWeight: 0, targetRevenue: 0, qAllowance: 0, mc: new Map(),
  }
}
function mcSlot(acc: Acc, f: McByOrderType['fulfilmentType']) {
  let s = acc.mc.get(f)
  if (!s) { s = { orders: 0, target: 0, actual: zc(), sales: 0 }; acc.mc.set(f, s) }
  return s
}
function addAcc(a: Acc, b: Acc): void {
  addCls(a.theoretical, b.theoretical); addBuckets(a.buckets, b.buckets)
  a.shortfallMemo += b.shortfallMemo; a.legacy += b.legacy; a.saleLedger += b.saleLedger; a.docLedger += b.docLedger
  a.docs += b.docs; a.relieved += b.relieved; addCls(a.actual, b.actual); a.revenue += b.revenue; a.itemRevenue += b.itemRevenue
  a.targetWeight += b.targetWeight; a.targetRevenue += b.targetRevenue; a.qAllowance += b.qAllowance
  for (const [f, s] of b.mc) {
    const t = mcSlot(a, f)
    t.orders += s.orders; t.target += s.target; addCls(t.actual, s.actual); t.sales += s.sales
  }
}

function statusOf(a: { revenue: number; actual: number | null; targetPct: number | null; incomplete: boolean }): FoodCostStatus {
  if (!(a.revenue > 0)) return 'no_data'
  if (a.incomplete || a.targetPct == null || a.actual == null) return 'incomplete'
  const actualPct = (a.actual / a.revenue) * 100
  if (actualPct <= a.targetPct) return 'good'
  if (actualPct <= a.targetPct + 5) return 'warning'
  return 'critical'
}

// ─── The summary ─────────────────────────────────────────────────────────────

export interface FoodCostQuery {
  tenantIds: string[]
  from: Date
  to: Date
  conceptId?: string
  locationId?: string
  revenueVisible: boolean
}

/** One block per company in `tenantIds` — companies are never blended. */
export async function foodCostSummary(db: Db, a: FoodCostQuery): Promise<FoodCostCompanyBlock[]> {
  const out: FoodCostCompanyBlock[] = []
  for (const tenantId of [...new Set(a.tenantIds)]) out.push(await companyBlock(db, tenantId, a))
  return out
}

/** The warnings of one company's period (the summary's list). */
export async function foodCostWarnings(db: Db, a: { tenantId: string; from: Date; to: Date; conceptId?: string; locationId?: string }): Promise<FoodCostWarning[]> {
  const [block] = await foodCostSummary(db, { ...a, tenantIds: [a.tenantId], revenueVisible: false })
  return block?.warnings ?? []
}

async function companyBlock(db: Db, tenantId: string, a: FoodCostQuery): Promise<FoodCostCompanyBlock> {
  const { from, to } = a
  const conceptId = a.conceptId ?? null
  const locationId = a.locationId ?? null
  const byOutlet = !!locationId
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
  const concepts = await db.concept.findMany({
    where: { tenantId, ...(conceptId ? { id: conceptId } : {}) },
    select: { id: true, name: true, serviceVessel: true, deletedAt: true },
  })
  const conceptById = new Map(concepts.map((c) => [c.id, c]))
  const inScope = (c: string | null) => (conceptId ? c === conceptId : true)
  const accs = new Map<string, Acc>()
  const acc = (c: string | null): Acc => {
    const k = c ?? ''
    let x = accs.get(k)
    if (!x) { x = zAcc(); accs.set(k, x) }
    return x
  }
  const cutoverAt = await readFifoCutoverAt(db, tenantId)

  // ── 1. The ledger: brand sales and cost of sales (the ONE definitions) ──
  let ledgerTotalByBrand = new Map<string, number>()
  if (!byOutlet) {
    const [sales, cos] = await Promise.all([
      brandSalesByConcept(db, [tenantId], { from, to }),
      costOfSalesByConcept(db, [tenantId], { from, to }),
    ])
    for (const [c, v] of sales) if (inScope(c)) acc(c).revenue += v
    for (const [c, s] of cos) {
      if (!inScope(c)) continue
      const x = acc(c).actual
      x.foodCents += s.foodCents; x.drinksCents += s.drinksCents; x.packagingCents += s.packagingCents
      x.totalCents += s.foodCents + s.drinksCents + s.packagingCents
    }
    // Every cost-of-sales line, classified by its entry's source.
    const lines = await db.journalLine.findMany({
      where: {
        journalEntry: { tenantId, entryDate: { gte: from, lte: to } },
        account: { tenantId, code: { in: COS_CODES } },
        ...(conceptId ? { conceptId } : {}),
      },
      select: { type: true, amountCents: true, conceptId: true, memo: true, account: { select: { code: true } }, journalEntry: { select: { reference: true } } },
    })
    ledgerTotalByBrand = new Map()
    for (const l of lines) {
      const amt = sumCents(l.amountCents)
      const signed = l.type === 'debit' ? amt : -amt
      if (signed === 0) continue
      const x = acc(l.conceptId)
      const k = l.conceptId ?? ''
      ledgerTotalByBrand.set(k, (ledgerTotalByBrand.get(k) ?? 0) + signed)
      const code = l.account.code
      const src = sourceTypeOf(l.journalEntry.reference)
      if (code === ACCT.COST_ADJUSTMENT) x.buckets.priceAdjustments += signed
      else if (code === ACCT.WASTE || code === ACCT.INVENTORY_VARIANCE) x.docLedger += signed
      else if (SALE_SOURCES.has(src)) {
        if ((l.memo ?? '').includes(PRE_FIFO_MEMO)) x.legacy += signed
        else x.saleLedger += signed
      } else if (DOC_SOURCES.has(src)) x.docLedger += signed
      else x.buckets.otherEntries += signed
    }
  }

  // ── 2. The orders sold in the period: theoretical, comps, staff meals ──
  const orders = await db.order.findMany({
    where: {
      concept: { tenantId }, ...(conceptId ? { conceptId } : {}), ...(locationId ? { locationId } : {}),
      status: { in: [...SOLD_STATUSES] }, completedAt: { gte: from, lte: to },
    },
    select: {
      id: true, conceptId: true, fulfilmentType: true, totalCents: true,
      payments: { select: { method: true, amountCents: true, status: true, gatewayMeta: true } },
      items: { select: { id: true, menuItemId: true, name: true, quantity: true, unitPriceCents: true, status: true, modifiers: { select: { modifierId: true, name: true } } } },
    },
  })
  const orderIds = orders.map((o) => o.id)
  type LineSum = { byClass: Record<CostClass, { value: number; memo: number }>; any: boolean }
  const zLine = (): LineSum => ({ byClass: { food: { value: 0, memo: 0 }, beverage: { value: 0, memo: 0 }, packaging: { value: 0, memo: 0 } }, any: false })
  const perOrder = new Map<string, LineSum>()
  const perLine = new Map<string, LineSum>()
  for (const ids of chunk(orderIds)) {
    const sums = await db.stockMovement.groupBy({
      by: ['orderId', 'orderItemId', 'costClass'],
      where: { tenantId, orderId: { in: ids }, kind: { in: [...ORDER_COGS_KINDS] } },
      _sum: { valueCents: true, shortfallValueCents: true },
    })
    for (const s of sums) {
      if (!s.orderId) continue
      const cls = asClass(s.costClass)
      const value = -sumCents(s._sum.valueCents)
      const memo = sumCents(s._sum.shortfallValueCents)
      for (const [map, key] of [[perOrder, s.orderId], [perLine, s.orderItemId ?? `order:${s.orderId}`]] as const) {
        let x = map.get(key)
        if (!x) { x = zLine(); map.set(key, x) }
        x.byClass[cls].value += value
        x.byClass[cls].memo += memo
        x.any = true
      }
    }
  }
  const soldMenuItemIds = [...new Set(orders.flatMap((o) => o.items.filter((i) => i.status !== 'voided' && i.menuItemId).map((i) => i.menuItemId!)))]
  const plateCosts: Map<string, RecipeCost> = soldMenuItemIds.length ? await menuItemPlateCosts(soldMenuItemIds, db) : new Map()
  const recipeRows = soldMenuItemIds.length === 0 ? [] : await db.recipe.findMany({
    where: { menuItemId: { in: soldMenuItemIds } },
    select: { id: true, menuItemId: true, status: true, targetFoodCostPct: true, menuItem: { select: { name: true } } },
  })
  const recipeOf = new Map(recipeRows.map((r) => [r.menuItemId!, r]))

  const items = new Map<string, FoodCostItemRow & { revenue: number; target: number | null }>()
  for (const o of orders) {
    const x = acc(o.conceptId)
    const sums = perOrder.get(o.id)
    const total = Math.max(0, o.totalCents)
    let comp = 0
    let staff = 0
    for (const p of o.payments) {
      if (p.method !== 'comp' || p.status !== 'paid' || p.amountCents <= 0) continue
      if (compKindOf(p.gatewayMeta) === 'staff_meal') staff += p.amountCents
      else comp += p.amountCents
    }
    const compShare = total > 0 ? Math.min(1, comp / total) : (comp > 0 ? 1 : 0)
    const staffShare = total > 0 ? Math.min(1 - compShare, staff / total) : (staff > 0 && comp === 0 ? 1 : 0)
    const f = (FULFILMENTS as readonly string[]).includes(o.fulfilmentType) ? o.fulfilmentType as McByOrderType['fulfilmentType'] : 'dine_in'
    const mc = mcSlot(x, f)
    mc.orders += 1
    if (sums) {
      for (const cls of COST_CLASSES) {
        const { value, memo } = sums.byClass[cls]
        x.relieved += value
        x.shortfallMemo += memo
        const s = shareSplit(value + memo, compShare, staffShare)
        addTo(x.buckets.comps, cls, s.comp)
        addTo(x.buckets.staffMeals, cls, s.staff)
        addTo(x.theoretical, cls, s.rest)
        addTo(mc.actual, cls, value + memo)
      }
    }
    for (const it of o.items) {
      if (it.status === 'voided') continue
      const lineRevenue = it.unitPriceCents * it.quantity
      mc.sales += lineRevenue
      if (!it.menuItemId) continue
      const cost = plateCosts.get(it.menuItemId)
      const recipe = recipeOf.get(it.menuItemId)
      x.itemRevenue += lineRevenue
      if (recipe) {
        x.targetWeight += recipe.targetFoodCostPct * lineRevenue
        x.targetRevenue += lineRevenue
      }
      if (cost) {
        mc.target += Math.round(cost.targetMcCents[f] * it.quantity)
        // Q per portion = this recipe's Q share of its per-portion cost.
        const qPer = cost.totalCents > 0 ? (cost.qCents * cost.perPortionCents) / cost.totalCents : 0
        x.qAllowance += Math.round(qPer * it.quantity)
      }
      const ls = perLine.get(it.id)
      let lineCost = 0
      if (ls) for (const cls of COST_CLASSES) lineCost += ls.byClass[cls].value + ls.byClass[cls].memo
      const row = items.get(it.menuItemId) ?? {
        menuItemId: it.menuItemId, name: recipe?.menuItem?.name ?? it.name, conceptId: o.conceptId, qtySold: 0, hasRecipe: !!recipe,
        costCents: 0, revenue: 0, target: recipe ? recipe.targetFoodCostPct : null,
      }
      row.qtySold += it.quantity
      row.costCents += lineCost
      row.revenue += lineRevenue
      items.set(it.menuItemId, row)
    }
  }
  for (const x of accs.values()) x.buckets.notOnBooks = -x.shortfallMemo

  // ── 3. The stock documents of the period (waste, counts, prep, issue, settles) ──
  const docRows = await db.stockMovement.findMany({
    where: {
      tenantId, occurredAt: { gte: from, lte: to }, kind: { in: [...DOC_KINDS] },
      ...(locationId ? { locationId } : {}),
    },
    select: { id: true, kind: true, inventoryItemId: true, valueCents: true, costClass: true, conceptId: true, brandShares: true, sourceType: true, sourceId: true, lotId: true },
  })
  const wasteLogIds = [...new Set(docRows.filter((r) => r.kind === 'waste' && r.sourceType === STOCK_SOURCE.wasteLog).map((r) => r.sourceId))]
  const reasonOf = new Map<string, string>()
  for (const ids of chunk(wasteLogIds)) {
    for (const w of await db.wasteLog.findMany({ where: { id: { in: ids } }, select: { id: true, reason: true } })) reasonOf.set(w.id, w.reason)
  }
  type Doc = { bucket: 'waste' | 'count' | 'prep' | 'issue' | 'settle'; reason: WasteReason; cents: number; conceptId: string | null; shares: Prisma.JsonValue | null }
  const docs = new Map<string, Doc>()
  for (const r of docRows) {
    let key: string
    let bucket: Doc['bucket']
    let reason: WasteReason = 'other'
    if (r.kind === 'waste') {
      if (r.sourceType !== STOCK_SOURCE.wasteLog) continue
      bucket = 'waste'
      const rr = reasonOf.get(r.sourceId) ?? 'other'
      reason = isWasteReason(rr) ? rr : 'other'
      key = `waste|${r.sourceId}|${r.inventoryItemId}`
    } else if (r.kind === 'count_loss' || r.kind === 'count_gain') {
      if (r.sourceType !== STOCK_SOURCE.countLine) continue
      bucket = 'count'
      key = `count|${r.sourceId}`
    } else if (r.kind === 'prep_draw') {
      if (r.sourceType !== STOCK_SOURCE.prepBatch) continue
      bucket = 'prep'
      key = `prep|${r.sourceId}|${r.inventoryItemId}|${asClass(r.costClass)}`
    } else if (r.kind === 'issue_on_receipt') {
      bucket = 'issue'
      key = `issue|${r.lotId ?? r.id}`
    } else {
      bucket = 'settle'
      key = `settle|${r.id}`
    }
    const d = docs.get(key) ?? { bucket, reason, cents: 0, conceptId: r.conceptId, shares: null }
    d.cents += -toCents(r.valueCents)
    if (!d.conceptId && r.conceptId) d.conceptId = r.conceptId
    if (d.shares == null && r.brandShares != null) d.shares = r.brandShares
    docs.set(key, d)
  }
  for (const d of docs.values()) {
    if (d.cents === 0) continue
    const parts: Array<{ conceptId: string | null; cents: number; allocated: boolean }> = []
    if (d.conceptId) parts.push({ conceptId: d.conceptId, cents: d.cents, allocated: false })
    else {
      const shares = parseBrandShares(d.shares)
      if (shares && shares.length > 0) for (const p of splitCents(d.cents, shares)) parts.push({ ...p, allocated: p.conceptId != null })
      else parts.push({ conceptId: null, cents: d.cents, allocated: false })
    }
    for (const p of parts) {
      if (!inScope(p.conceptId)) continue
      const x = acc(p.conceptId)
      x.docs += p.cents
      const b = x.buckets
      if (d.bucket === 'waste') { addMa(b.waste.byReason[d.reason], p.cents, p.allocated); addMa(b.waste.total, p.cents, p.allocated) }
      else if (d.bucket === 'count') addMa(b.countVariance, p.cents, p.allocated)
      else if (d.bucket === 'prep') addMa(b.prepDraws, p.cents, p.allocated)
      else if (d.bucket === 'issue') addMa(b.issueOnReceipt, p.cents, p.allocated)
      else addMa(b.shortfallSettles, p.cents, p.allocated)
    }
  }

  // ── 4. Warnings ──
  const counts = await openCounts(db, tenantId, { conceptId, locationId, to })
  const { warnings, noRecipeBrands } = await buildWarnings(db, tenantId, {
    from, to, conceptId, locationId, cutoverAt, orders, recipeRows, ...counts,
  })

  // ── 5. Blocks ──
  const brandBlock = (key: string, x: Acc, incomplete: boolean): FoodCostBrandBlock => {
    const c = key ? conceptById.get(key) : null
    const theoTotal = x.theoretical.totalCents
    const explained = explainedOf(x.buckets)
    const unexplained = unexplainedOf(x.buckets)
    const timing: FoodCostTiming | null = byOutlet ? null : {
      salesCents: x.saleLedger - x.relieved,
      stockDocsCents: x.docLedger - x.docs,
      totalCents: x.saleLedger - x.relieved + x.docLedger - x.docs,
    }
    const actual = byOutlet ? null : x.actual
    const identityDiffCents = byOutlet || !timing || !actual ? null
      : theoTotal + explained + unexplained + x.legacy + timing.totalCents - actual.totalCents
    const targetPct = x.targetRevenue > 0 ? Math.round((x.targetWeight / x.targetRevenue) * 10) / 10 : null
    const status = statusOf({ revenue: x.revenue, actual: actual?.totalCents ?? null, targetPct, incomplete })
    const mcByOrderType: McByOrderType[] = FULFILMENTS.map((f) => {
      const s = x.mc.get(f) ?? { orders: 0, target: 0, actual: zc(), sales: 0 }
      return {
        fulfilmentType: f, label: FULFILMENT_LABEL[f], orders: s.orders, targetMcCents: s.target, actualMc: s.actual,
        ...(a.revenueVisible ? { itemSalesCents: s.sales, targetMcPct: pct(s.target, s.sales), actualMcPct: pct(s.actual.totalCents, s.sales) } : {}),
      }
    })
    const theoPct = pct(theoTotal, x.revenue)
    const actualPct = actual ? pct(actual.totalCents, x.revenue) : null
    return {
      conceptId: key || null,
      name: c?.name ?? (key ? key : HEAD_OFFICE_LABEL),
      serviceVessel: c?.serviceVessel ?? null,
      status, statusLabel: FOOD_COST_STATUS_LABEL[status],
      ...(a.revenueVisible ? {
        revenueCents: x.revenue, targetPct, theoreticalPct: theoPct, actualPct,
        avtPoints: theoPct != null && actualPct != null ? Math.round((actualPct - theoPct) * 10) / 10 : null,
      } : {}),
      theoretical: x.theoretical, actual, buckets: x.buckets,
      explainedCents: explained, unexplainedCents: unexplained, alignmentCents: x.legacy,
      timing, qAllowanceCents: x.qAllowance, mcByOrderType, identityDiffCents,
    }
  }

  // Missing stock data (cut-over, no-cost lots, foreign lines, sub-recipes
  // without a yield) leaves every brand incomplete; a dish sold with no
  // recipe only its own brand.
  const incomplete = warnings.some((w) => w.severity === 'incomplete')
  const stockIncomplete = warnings.some((w) => w.severity === 'incomplete' && w.code !== 'no_recipe')
  const total = zAcc()
  for (const x of accs.values()) addAcc(total, x)
  // A ledger line the class split and the classification disagree on (never expected) is a warning, not a silent gap.
  if (!byOutlet) {
    let classified = 0
    for (const v of ledgerTotalByBrand.values()) classified += v
    if (classified !== total.actual.totalCents) {
      warnings.push({ code: 'ledger_check', severity: 'warn', count: 1, message: `The cost-of-sales lines (${classified}) and the class split (${total.actual.totalCents}) differ — tell finance.` })
    }
  }
  const companyBrand = brandBlock('', total, incomplete)
  const brandKeys = [...accs.keys()].sort((p, q) => {
    if (!p) return 1
    if (!q) return -1
    return (conceptById.get(p)?.name ?? p).localeCompare(conceptById.get(q)?.name ?? q)
  })
  const brands = brandKeys.map((k) => brandBlock(k, accs.get(k)!, stockIncomplete || noRecipeBrands.has(k)))
  const itemRows: FoodCostItemRow[] = [...items.values()]
    .sort((p, q) => q.costCents - p.costCents)
    .slice(0, 500)
    .map(({ revenue, target, ...r }) => ({
      ...r,
      ...(a.revenueVisible ? { revenueCents: revenue, costPct: pct(r.costCents, revenue), targetPct: target } : {}),
    }))
  const alignedEntry = await db.journalEntry.findFirst({ where: { tenantId, reference: `inventory.fifo_align:${tenantId}` }, select: { entryDate: true } })

  const { conceptId: _c, name: _n, serviceVessel: _s, ...companyFields } = companyBrand
  return {
    ...companyFields,
    tenantId,
    companyName: tenant?.name ?? tenantId,
    period: { from: from.toISOString(), to: to.toISOString() },
    revenueHidden: !a.revenueVisible,
    cutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
    conceptId, locationId,
    allowance: { qFactorCents: total.qAllowance, label: Q_ALLOWANCE_LABEL },
    alignment: {
      preFifoOrdersCents: total.legacy,
      alignedAt: alignedEntry ? alignedEntry.entryDate.toISOString() : null,
      label: 'FIFO cut-over: orders placed before it, booked at the old plate cost (the one-time alignment posts to retained earnings, never to cost of sales)',
    },
    brands,
    items: itemRows,
    warnings,
    openOrders: counts.openOrders,
    openShifts: counts.openShifts,
  }
}

async function openCounts(db: Db, tenantId: string, o: { conceptId: string | null; locationId: string | null; to: Date }): Promise<{ openOrders: number; openShifts: number }> {
  const [openOrders, openShifts] = await Promise.all([
    db.order.count({
      where: {
        concept: { tenantId }, ...(o.conceptId ? { conceptId: o.conceptId } : {}), ...(o.locationId ? { locationId: o.locationId } : {}),
        status: { in: [...OPEN_ORDER_STATUSES] }, placedAt: { lte: o.to },
      },
    }),
    db.shift.count({ where: { status: 'open', ...shiftOfCompany({ tenantId }), ...(o.locationId ? { locationId: o.locationId } : {}) } }),
  ])
  return { openOrders, openShifts }
}

const names = (xs: Array<string | null | undefined>, n = 12) => [...new Set(xs.filter((x): x is string => !!x))].slice(0, n)

async function buildWarnings(db: Db, tenantId: string, c: {
  from: Date; to: Date; conceptId: string | null; locationId: string | null; cutoverAt: Date | null
  orders: Array<{ conceptId: string; items: Array<{ menuItemId: string | null; name: string; quantity: number; status: string; modifiers: Array<{ modifierId: string | null; name: string }> }> }>
  recipeRows: Array<{ id: string; menuItemId: string | null; status: string; menuItem: { name: string } | null }>
  openOrders: number; openShifts: number
}): Promise<{ warnings: FoodCostWarning[]; noRecipeBrands: Set<string> }> {
  const w: FoodCostWarning[] = []
  if (!c.cutoverAt) {
    w.push({ code: 'pre_cutover', severity: 'incomplete', count: 1, message: 'This company\'s stock is not on FIFO lots yet — there is no lot data to cost sales at the price paid.' })
  } else if (c.from.getTime() < c.cutoverAt.getTime()) {
    w.push({ code: 'pre_cutover', severity: 'incomplete', count: 1, message: `No FIFO data before ${fmtPktDate(c.cutoverAt)} — sales before the cut-over were costed at the old plate cost.` })
  }
  if (c.locationId) {
    w.push({ code: 'by_outlet', severity: 'warn', count: 1, message: 'By outlet: theoretical, waste and counts are this outlet\'s; the ledger (actual) is per company until per-outlet stock (the next build).' })
  }
  const sold = c.orders.flatMap((o) => o.items.filter((i) => i.status !== 'voided'))
  const withRecipe = new Set(c.recipeRows.map((r) => r.menuItemId))
  const noRecipe = sold.filter((i) => i.menuItemId && !withRecipe.has(i.menuItemId))
  const noRecipeBrands = new Set(c.orders.filter((o) => o.items.some((i) => i.status !== 'voided' && i.menuItemId && !withRecipe.has(i.menuItemId))).map((o) => o.conceptId))
  if (noRecipe.length > 0) {
    w.push({ code: 'no_recipe', severity: 'incomplete', count: new Set(noRecipe.map((i) => i.menuItemId)).size, names: names(noRecipe.map((i) => i.name)), link: '/accounting/recipes',
      message: 'Menu items were sold with no recipe — nothing was taken from stock for them, so their cost is missing.' })
  }
  const unapproved = c.recipeRows.filter((r) => r.status !== 'production')
  if (unapproved.length > 0) {
    w.push({ code: 'unapproved_recipe', severity: 'warn', count: unapproved.length, names: names(unapproved.map((r) => r.menuItem?.name)), link: '/accounting/recipes',
      message: 'Dishes on sale are costed from recipes that are not approved yet.' })
  }
  // Sub-recipes without a batch yield (any depth below the sold dishes): their lines can't be scaled, so they take nothing.
  const seen = new Set<string>()
  let frontier = c.recipeRows.map((r) => r.id)
  const noYield: string[] = []
  while (frontier.length > 0) {
    const next: string[] = []
    const lines = await db.recipeIngredient.findMany({ where: { recipeId: { in: frontier }, prepRecipeId: { not: null } }, select: { prepRecipeId: true } })
    const subIds = [...new Set(lines.map((l) => l.prepRecipeId!).filter((id) => !seen.has(id)))]
    if (subIds.length === 0) break
    for (const s of await db.recipe.findMany({ where: { id: { in: subIds } }, select: { id: true, name: true, yieldGrams: true } })) {
      seen.add(s.id)
      if (!(s.yieldGrams && s.yieldGrams > 0)) noYield.push(s.name ?? s.id)
      next.push(s.id)
    }
    frontier = next
  }
  if (noYield.length > 0) {
    w.push({ code: 'sub_recipe_no_yield', severity: 'incomplete', count: noYield.length, names: names(noYield), link: '/accounting/recipes',
      message: 'Sub-recipes with no batch yield — the dishes using them take none of their ingredients.' })
  }
  const modifierIds = [...new Set(sold.flatMap((i) => i.modifiers.map((m) => m.modifierId)).filter((x): x is string => !!x))]
  if (modifierIds.length > 0) {
    const costed = new Set((await db.recipe.findMany({ where: { modifierId: { in: modifierIds } }, select: { modifierId: true } })).map((r) => r.modifierId))
    const bare = sold.flatMap((i) => i.modifiers).filter((m) => m.modifierId && !costed.has(m.modifierId))
    if (bare.length > 0) {
      w.push({ code: 'modifier_no_recipe', severity: 'warn', count: new Set(bare.map((m) => m.modifierId)).size, names: names(bare.map((m) => m.name)), link: '/configuration/modifiers',
        message: 'Add-ons were sold with no recipe — if they use stock, give them ingredients.' })
    }
  }
  const nullLots = await db.stockLot.findMany({
    where: { tenantId, unitCostCents: 0, remainingQty: { gt: 0.000001 }, ...(c.locationId ? { locationId: c.locationId } : {}) },
    select: { inventoryItem: { select: { name: true } } },
    take: 200,
  })
  const nullUsed = await db.stockMovement.findMany({
    where: { tenantId, unitCostCents: 0, occurredAt: { gte: c.from, lte: c.to }, kind: { in: ['sale', 'waste', 'prep_draw', 'count_loss'] }, qty: { lt: 0 } },
    select: { inventoryItemId: true },
    take: 200,
  })
  if (nullLots.length > 0 || nullUsed.length > 0) {
    const usedNames = nullUsed.length === 0 ? [] : (await db.inventoryItem.findMany({ where: { id: { in: [...new Set(nullUsed.map((m) => m.inventoryItemId))] } }, select: { name: true } })).map((i) => i.name)
    const all = names([...nullLots.map((l) => l.inventoryItem.name), ...usedNames])
    w.push({ code: 'null_cost_lot', severity: 'incomplete', count: all.length, names: all, link: '/inventory',
      message: 'Stock is held (or was used) at no cost — the cut-over found no price for it. Its cost is missing until a priced delivery replaces it.' })
  }
  const foreign = await db.exceptionFlag.findMany({
    where: { tenantId, kind: 'recipe_foreign_stock', status: { in: ['open', 'acknowledged'] } },
    select: { title: true },
    take: 50,
  })
  if (foreign.length > 0) {
    w.push({ code: 'foreign_lines', severity: 'incomplete', count: foreign.length, names: names(foreign.map((f) => f.title)), link: '/exceptions?kind=recipe_foreign_stock',
      message: 'Recipes draw items of another company (or of none) — those lines are skipped, so their cost is missing.' })
  }
  const vesselBrands = await db.concept.findMany({
    where: { tenantId, serviceVessel: 'packaging', deletedAt: null, ...(c.conceptId ? { id: c.conceptId } : {}) },
    select: { id: true },
  })
  if (vesselBrands.length > 0) {
    const bare = await db.recipe.findMany({
      where: {
        kind: 'plate', menuItem: { conceptId: { in: vesselBrands.map((b) => b.id) }, deletedAt: null },
        ingredients: { none: { section: 'packaging' } },
      },
      select: { menuItem: { select: { name: true } } },
      take: 200,
    })
    if (bare.length > 0) {
      w.push({ code: 'packaging_missing', severity: 'warn', count: bare.length, names: names(bare.map((r) => r.menuItem?.name)), link: '/accounting/recipes',
        message: 'This brand serves in packaging, but these recipes have no packaging line — add the vessel.' })
    }
  }
  if (c.openOrders > 0) {
    w.push({ code: 'open_orders', severity: 'timing', count: c.openOrders, link: '/orders',
      message: `${c.openOrders} open order(s): their stock is out of the lots but not in cost of sales until they complete (timing).` })
  }
  if (c.openShifts > 0) {
    w.push({ code: 'open_shifts', severity: 'timing', count: c.openShifts, link: '/pos',
      message: `${c.openShifts} open till drawer(s): their sales reach cost of sales when the drawer is closed (timing).` })
  }
  return { warnings: w, noRecipeBrands }
}

// ─── Per ingredient ──────────────────────────────────────────────────────────

export interface QtyCents { qty: number; cents: number }

export interface IngredientVarianceRow {
  inventoryItemId: string
  name: string
  unit: string
  costClass: CostClass
  classLabel: string
  opening: QtyCents
  received: QtyCents
  theoretical: QtyCents
  comps: QtyCents
  staffMeals: QtyCents
  waste: QtyCents
  wasteByReason: Partial<Record<WasteReason, QtyCents>>
  prep: QtyCents
  issueOnReceipt: QtyCents
  count: QtyCents
  shortfall: QtyCents
  settled: QtyCents
  other: QtyCents
  closing: QtyCents
  /** Count variance (short +, over −) + cooked while not on the books. */
  unexplained: QtyCents
  flags: { noCost: boolean; notOnAnyRecipe: boolean; shortfall: boolean; notCountedInPeriod: boolean }
}

export type IngredientSort = 'unexplained' | 'theoretical' | 'waste' | 'name'

const zq = (): QtyCents => ({ qty: 0, cents: 0 })
const addQ = (x: QtyCents, qty: number, cents: number) => { x.qty += qty; x.cents += cents }
const roundQ = (x: QtyCents): QtyCents => ({ qty: Math.round(x.qty * 1000) / 1000, cents: x.cents })

/**
 * Per inventory item of ONE company over the period: opening, received,
 * theoretical (sold orders; comps and staff meals apart), waste by reason,
 * prep, counts, shortfall, closing — quantities in purchase units and PKR at
 * the lot cost. Cost side (+ = out of stock). `conceptId` keeps rows tagged to
 * the brand plus its share of brand-less documents; `locationId` the outlet's.
 */
export async function ingredientVariance(db: Db, a: {
  tenantId: string; from: Date; to: Date; conceptId?: string; locationId?: string; costClass?: CostClass; sort?: IngredientSort
}): Promise<IngredientVarianceRow[]> {
  const { tenantId, from, to } = a
  const itemsAll = await db.inventoryItem.findMany({
    where: { tenantId },
    select: { id: true, name: true, unit: true, category: true, unitCostCents: true, deletedAt: true },
  })
  const items = itemsAll.filter((i) => !a.costClass || costClassOf(i.category) === a.costClass)
  if (items.length === 0) return []
  const itemIds = items.map((i) => i.id)
  const loc = a.locationId ? { locationId: a.locationId } : {}

  // Opening: the lot ledger replayed to the start of the period (company-wide, or the outlet's tagged rows).
  const opening = new Map<string, QtyCents>()
  for (const ids of chunk(itemIds)) {
    const rows = await db.stockMovement.groupBy({
      by: ['inventoryItemId'], where: { tenantId, inventoryItemId: { in: ids }, occurredAt: { lt: from }, ...loc },
      _sum: { qty: true, valueCents: true },
    })
    for (const r of rows) opening.set(r.inventoryItemId, { qty: r._sum.qty ?? 0, cents: sumCents(r._sum.valueCents) })
  }
  const moves = await db.stockMovement.findMany({
    where: { tenantId, occurredAt: { gte: from, lte: to }, ...loc },
    select: {
      id: true, kind: true, inventoryItemId: true, qty: true, valueCents: true, shortfallQty: true, shortfallValueCents: true,
      conceptId: true, brandShares: true, orderId: true, sourceType: true, sourceId: true,
    },
  })
  // Comp / staff shares of the orders behind the sale rows.
  const orderIds = [...new Set(moves.filter((m) => m.orderId && (ORDER_COGS_KINDS as readonly string[]).includes(m.kind)).map((m) => m.orderId!))]
  const share = new Map<string, { sold: boolean; comp: number; staff: number }>()
  for (const ids of chunk(orderIds)) {
    for (const o of await db.order.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, totalCents: true, payments: { select: { method: true, status: true, amountCents: true, gatewayMeta: true } } },
    })) {
      let comp = 0
      let staff = 0
      for (const p of o.payments) {
        if (p.method !== 'comp' || p.status !== 'paid' || p.amountCents <= 0) continue
        if (compKindOf(p.gatewayMeta) === 'staff_meal') staff += p.amountCents
        else comp += p.amountCents
      }
      const t = Math.max(0, o.totalCents)
      const cs = t > 0 ? Math.min(1, comp / t) : (comp > 0 ? 1 : 0)
      share.set(o.id, { sold: true, comp: cs, staff: t > 0 ? Math.min(1 - cs, staff / t) : 0 })
    }
  }
  const wasteIds = [...new Set(moves.filter((m) => m.kind === 'waste' && m.sourceType === STOCK_SOURCE.wasteLog).map((m) => m.sourceId))]
  const reasonOf = new Map<string, string>()
  for (const ids of chunk(wasteIds)) for (const w of await db.wasteLog.findMany({ where: { id: { in: ids } }, select: { id: true, reason: true } })) reasonOf.set(w.id, w.reason)

  const rows = new Map<string, Omit<IngredientVarianceRow, 'flags' | 'closing' | 'unexplained' | 'name' | 'unit' | 'costClass' | 'classLabel' | 'inventoryItemId'>>()
  const row = (id: string) => {
    let r = rows.get(id)
    if (!r) {
      r = {
        opening: opening.get(id) ?? zq(), received: zq(), theoretical: zq(), comps: zq(), staffMeals: zq(), waste: zq(), wasteByReason: {},
        prep: zq(), issueOnReceipt: zq(), count: zq(), shortfall: zq(), settled: zq(), other: zq(),
      }
      rows.set(id, r)
    }
    return r
  }
  const weightFor = (m: { conceptId: string | null; brandShares: Prisma.JsonValue | null }): number => {
    if (!a.conceptId) return 1
    if (m.conceptId) return m.conceptId === a.conceptId ? 1 : 0
    const s = parseBrandShares(m.brandShares)
    if (!s || s.length === 0) return 0
    const total = s.reduce((t, x) => t + (x.share > 0 ? x.share : 0), 0)
    const mine = s.find((x) => x.conceptId === a.conceptId)
    return mine && total > 0 ? mine.share / total : 0
  }
  const itemSet = new Set(itemIds)
  for (const m of moves) {
    if (!itemSet.has(m.inventoryItemId)) continue
    const wgt = weightFor(m)
    if (wgt === 0 && a.conceptId && !['receipt', 'opening', 'fifo_cutover', 'legacy_return', 'cost_adjust', 'class_reclass', 'supplier_return'].includes(m.kind)) continue
    const r = row(m.inventoryItemId)
    const qty = m.qty
    const v = toCents(m.valueCents)
    const outQ = -qty * wgt
    const outC = Math.round(-v * wgt)
    switch (m.kind) {
      case 'receipt': case 'opening': case 'fifo_cutover': case 'legacy_return':
        addQ(r.received, qty, v); break
      case 'sale': case 'sale_return': case 'sale_void': {
        const memoQ = (m.shortfallQty ?? 0) * wgt
        const memoC = Math.round(toCents(m.shortfallValueCents ?? 0) * wgt)
        if (m.kind === 'sale' && (memoQ > 0 || memoC > 0)) addQ(r.shortfall, memoQ, memoC)
        const sh = (m.orderId && share.get(m.orderId)) || { comp: 0, staff: 0 }
        const q = outQ + (m.kind === 'sale' ? memoQ : 0)
        const cc = outC + (m.kind === 'sale' ? memoC : 0)
        const s = shareSplit(cc, sh.comp, sh.staff)
        addQ(r.comps, q * sh.comp, s.comp)
        addQ(r.staffMeals, q * sh.staff, s.staff)
        addQ(r.theoretical, q * (1 - sh.comp - sh.staff), s.rest)
        break
      }
      case 'waste': {
        addQ(r.waste, outQ, outC)
        const rr = m.sourceType === STOCK_SOURCE.wasteLog ? (reasonOf.get(m.sourceId) ?? 'other') : 'other'
        const reason: WasteReason = isWasteReason(rr) ? rr : 'other'
        const slot = r.wasteByReason[reason] ?? zq()
        addQ(slot, outQ, outC)
        r.wasteByReason[reason] = slot
        break
      }
      case 'prep_draw': addQ(r.prep, outQ, outC); break
      case 'issue_on_receipt': addQ(r.issueOnReceipt, outQ, outC); break
      case 'count_loss': case 'count_gain': addQ(r.count, outQ, outC); break
      case 'shortfall_settle': addQ(r.settled, outQ, outC); break
      default: addQ(r.other, outQ, outC)
    }
  }

  // Flags.
  const onRecipe = new Set((await db.recipeIngredient.findMany({ where: { inventoryItemId: { in: itemIds } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'] })).map((x) => x.inventoryItemId))
  const counted = new Set((await db.physicalCountLine.findMany({
    where: { inventoryItemId: { in: itemIds }, count: { tenantId, countedAt: { gte: from, lte: to } } },
    select: { inventoryItemId: true }, distinct: ['inventoryItemId'],
  })).map((x) => x.inventoryItemId))
  const zeroLots = new Set((await db.stockLot.findMany({
    where: { tenantId, inventoryItemId: { in: itemIds }, unitCostCents: 0, remainingQty: { gt: 0.000001 } }, select: { inventoryItemId: true }, distinct: ['inventoryItemId'],
  })).map((x) => x.inventoryItemId))

  const out: IngredientVarianceRow[] = []
  for (const it of items) {
    const r = rows.get(it.id)
    const op = opening.get(it.id)
    if (!r && !op) continue
    if (!r && op && Math.abs(op.qty) < 1e-9 && op.cents === 0) continue
    const x = r ?? row(it.id)
    const cls = costClassOf(it.category)
    const closingQ = x.opening.qty + x.received.qty
      - x.theoretical.qty - x.comps.qty - x.staffMeals.qty + x.shortfall.qty
      - x.waste.qty - x.prep.qty - x.issueOnReceipt.qty - x.count.qty - x.settled.qty - x.other.qty
    const closingC = x.opening.cents + x.received.cents
      - x.theoretical.cents - x.comps.cents - x.staffMeals.cents + x.shortfall.cents
      - x.waste.cents - x.prep.cents - x.issueOnReceipt.cents - x.count.cents - x.settled.cents - x.other.cents
    const unexplained = { qty: x.count.qty + x.shortfall.qty, cents: x.count.cents + x.shortfall.cents }
    const wasteByReason: Partial<Record<WasteReason, QtyCents>> = {}
    for (const [k, v] of Object.entries(x.wasteByReason)) wasteByReason[k as WasteReason] = roundQ(v!)
    out.push({
      inventoryItemId: it.id, name: it.name, unit: it.unit, costClass: cls, classLabel: CLASS_LABEL[cls],
      opening: roundQ(x.opening), received: roundQ(x.received), theoretical: roundQ(x.theoretical), comps: roundQ(x.comps),
      staffMeals: roundQ(x.staffMeals), waste: roundQ(x.waste), wasteByReason, prep: roundQ(x.prep), issueOnReceipt: roundQ(x.issueOnReceipt),
      count: roundQ(x.count), shortfall: roundQ(x.shortfall), settled: roundQ(x.settled), other: roundQ(x.other),
      closing: roundQ({ qty: closingQ, cents: closingC }), unexplained: roundQ(unexplained),
      flags: {
        noCost: zeroLots.has(it.id) || (it.unitCostCents == null && !(op && op.cents > 0)),
        notOnAnyRecipe: !onRecipe.has(it.id),
        shortfall: x.shortfall.qty > 1e-9,
        notCountedInPeriod: !counted.has(it.id),
      },
    })
  }
  const sort = a.sort ?? 'unexplained'
  out.sort((p, q) => {
    if (sort === 'name') return p.name.localeCompare(q.name)
    if (sort === 'theoretical') return q.theoretical.cents - p.theoretical.cents
    if (sort === 'waste') return q.waste.cents - p.waste.cents
    return Math.abs(q.unexplained.cents) - Math.abs(p.unexplained.cents) || p.name.localeCompare(q.name)
  })
  return out
}

/** One item's lots and its lot-level movements in the period (the drill-down). */
export async function itemMovements(db: Db, a: { tenantId: string; inventoryItemId: string; from: Date; to: Date }) {
  const item = await db.inventoryItem.findFirst({
    where: { id: a.inventoryItemId, tenantId: a.tenantId },
    select: { id: true, name: true, unit: true, category: true, unitCostCents: true, currentStock: true },
  })
  if (!item) throw new AppError('NOT_FOUND', `Inventory item '${a.inventoryItemId}' not found`, 404)
  const [lots, movements] = await Promise.all([
    db.stockLot.findMany({
      where: { tenantId: a.tenantId, inventoryItemId: item.id },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      select: { id: true, sourceType: true, receivedAt: true, qtyIn: true, remainingQty: true, unitCostCents: true, valueInCents: true, remainingValueCents: true, locationId: true },
    }),
    db.stockMovement.findMany({
      where: { tenantId: a.tenantId, inventoryItemId: item.id, occurredAt: { gte: a.from, lte: a.to } },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      select: {
        id: true, kind: true, lotId: true, qty: true, valueCents: true, unitCostCents: true, shortfallQty: true, shortfallValueCents: true,
        conceptId: true, locationId: true, orderId: true, sourceType: true, sourceId: true, occurredAt: true, brandShares: true,
      },
    }),
  ])
  const cls = costClassOf(item.category)
  return {
    item: { ...item, costClass: cls, classLabel: CLASS_LABEL[cls] },
    lots: lots.map((l) => ({ ...l, valueInCents: toCents(l.valueInCents), remainingValueCents: toCents(l.remainingValueCents) })),
    movements: movements.map((m) => ({
      ...m, valueCents: toCents(m.valueCents), shortfallValueCents: m.shortfallValueCents == null ? null : toCents(m.shortfallValueCents),
      allocated: !m.conceptId && !!parseBrandShares(m.brandShares),
    })),
  }
}

// ─── Valuation: lots vs the GL ───────────────────────────────────────────────

export interface ValuationClassRow {
  costClass: CostClass
  label: string
  glCode: string
  lotsCents: number
  glCents: number
  /** Out of the lots, not yet in the ledger (open orders, unposted drawers) — a reconciling item. */
  issuedNotBookedCents: number
  /** The cut-over's pre-FIFO difference while not yet aligned (GL − lots at the cut-over). */
  preFifoDiffCents: number
  /** GL − lots − issued-not-booked − pre-FIFO difference: 0 when the books tie. */
  unreconciledCents: number
}

/** Lots by class against 1210 / 1220 / 1230, the reconciling items, and 2015 against the open receipts. */
export async function inventoryValuation(db: Db, a: { tenantId: string; asOf?: Date }) {
  const { tenantId } = a
  const [lots, gl, unbooked, cut] = await Promise.all([
    lotValuation(db, tenantId, a.asOf),
    ledgerBalancesByCode(tenantId, [...COST_CLASSES.map((c) => CLASS_ACCOUNTS[c].inv), ACCT.GRNI, STOCK_DIFF_SUSPENSE_CODE], { asOf: a.asOf, db }),
    unbookedSalesCostByClass(db, tenantId),
    readCutover(tenantId),
  ])
  const aligned = await db.journalEntry.findFirst({ where: { tenantId, reference: `inventory.fifo_align:${tenantId}` }, select: { entryDate: true } })
  const classes: ValuationClassRow[] = COST_CLASSES.map((c) => {
    const glCents = gl.get(CLASS_ACCOUNTS[c].inv) ?? 0
    const pre = !aligned && cut.preFifoDiff ? cut.preFifoDiff[c] : 0
    return {
      costClass: c, label: CLASS_LABEL[c], glCode: CLASS_ACCOUNTS[c].inv,
      lotsCents: lots[c], glCents, issuedNotBookedCents: unbooked[c], preFifoDiffCents: pre,
      unreconciledCents: glCents - lots[c] - unbooked[c] - pre,
    }
  })
  // Refused stock postings (they explain an unreconciled amount).
  const failed = await db.exceptionFlag.findMany({
    where: {
      tenantId, kind: 'posting_failed', status: { in: ['open', 'acknowledged'] },
      OR: [
        { metadata: { path: ['sourceType'], string_starts_with: 'inventory.' } },
        { metadata: { path: ['sourceType'], string_starts_with: 'procurement.' } },
        { metadata: { path: ['sourceType'], equals: 'pos.void_waste' } },
      ],
    },
    select: { id: true, title: true, amountCents: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  })
  // 2015 Goods received not invoiced: its credit balance against the open
  // receipt lines (their lot value less what live bills cleared — the same
  // rule as procurement/grniRoutes.ts) less quantity billed before it arrived.
  const grni = await grniOpen(db, tenantId)
  const glGrni = -(gl.get(ACCT.GRNI) ?? 0)
  const totals = {
    lotsCents: classes.reduce((s, r) => s + r.lotsCents, 0),
    glCents: classes.reduce((s, r) => s + r.glCents, 0),
    issuedNotBookedCents: classes.reduce((s, r) => s + r.issuedNotBookedCents, 0),
    preFifoDiffCents: classes.reduce((s, r) => s + r.preFifoDiffCents, 0),
    unreconciledCents: classes.reduce((s, r) => s + r.unreconciledCents, 0),
  }
  return {
    tenantId,
    asOf: (a.asOf ?? new Date()).toISOString(),
    /** Issued-not-booked is always read as of now (orders open now). */
    reconcilingAsOfNow: true,
    classes,
    totals,
    ties: totals.unreconciledCents === 0,
    failedPostings: {
      count: failed.length,
      cents: failed.reduce((s, f) => s + Math.abs(sumCents(f.amountCents)), 0),
      rows: failed.map((f) => ({ id: f.id, title: f.title, amountCents: f.amountCents == null ? null : toCents(f.amountCents), createdAt: f.createdAt.toISOString(), sourceType: metaString(f.metadata, 'sourceType') })),
    },
    stockDifferencesSuspenseCents: gl.get(STOCK_DIFF_SUSPENSE_CODE) ?? 0,
    cutover: {
      at: cut.at ? cut.at.toISOString() : null,
      preFifoDiff: cut.preFifoDiff,
      aligned: !!aligned,
      alignedAt: aligned ? aligned.entryDate.toISOString() : null,
      catchupRefused: cut.catchupRefused,
      untied: cut.untied,
    },
    grni: {
      glCode: ACCT.GRNI,
      glCreditCents: glGrni,
      openReceiptCents: grni.openCents,
      openReceiptLines: grni.lines,
      staleLines: grni.staleLines,
      staleCents: grni.staleCents,
      pendingMatchCents: grni.pendingCents,
      expectedCents: grni.openCents - grni.pendingCents,
      differenceCents: glGrni - (grni.openCents - grni.pendingCents),
    },
  }
}

function metaString(meta: Prisma.JsonValue | null, key: string): string | null {
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const v = (meta as Record<string, unknown>)[key]
    return typeof v === 'string' ? v : null
  }
  return null
}

const GRNI_STALE_DAYS = 30
const DAY_MS = 86_400_000

/** The company's open receipt lines (received − billed) and their open value, and pending (billed-ahead) matches. */
async function grniOpen(db: Db, tenantId: string, o: { receivedBefore?: Date; now?: Date } = {}) {
  const lines = await db.goodsReceiptLine.findMany({
    where: {
      writtenOffAt: null,
      receipt: { settledByType: null, ...(o.receivedBefore ? { receivedAt: { lte: o.receivedBefore } } : {}), OR: [{ tenantId }, { tenantId: null, supplierId: { in: (await db.supplier.findMany({ where: { tenantId }, select: { id: true } })).map((s) => s.id) } }] },
    },
    select: { id: true, receivedQty: true, billedQty: true, lotUnitCostCents: true, poUnitCostCents: true, receipt: { select: { receivedAt: true } } },
  })
  const open = lines.filter((l) => l.receivedQty - l.billedQty > 1e-6)
  // The one GRNI open-value rule (procurement/grniRoutes.ts).
  const values = await grniLineOpenValues(db, open)
  const now = (o.now ?? new Date()).getTime()
  let openCents = 0
  let staleLines = 0
  let staleCents = 0
  for (const l of open) {
    const v = values.get(l.id) ?? 0
    openCents += v
    if (now - l.receipt.receivedAt.getTime() > GRNI_STALE_DAYS * DAY_MS) { staleLines += 1; staleCents += v }
  }
  const pending = await db.grniMatch.aggregate({ where: { tenantId, status: 'pending' }, _sum: { grniCents: true } })
  return { lines: open.length, openCents, staleLines, staleCents, pendingCents: sumCents(pending._sum.grniCents) }
}

// ─── Flags ───────────────────────────────────────────────────────────────────

export const FOOD_COST_FLAG_KINDS = ['shrinkage', 'shrinkage_trend', 'yield_low', 'stock_shortfall', 'stock_unrecorded', 'recipe_foreign_stock'] as const

/** The company's open stock flags and refused stock postings (read-only — acknowledging stays in /exceptions). */
export async function foodCostFlags(db: Db, a: { tenantId: string }) {
  const rows = await db.exceptionFlag.findMany({
    where: {
      tenantId: a.tenantId, status: { in: ['open', 'acknowledged'] },
      OR: [
        { kind: { in: [...FOOD_COST_FLAG_KINDS] } },
        { kind: 'posting_failed', metadata: { path: ['sourceType'], string_starts_with: 'inventory.' } },
        { kind: 'posting_failed', metadata: { path: ['sourceType'], equals: 'pos.void_waste' } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: { id: true, kind: true, severity: true, title: true, description: true, entityType: true, entityId: true, conceptId: true, amountCents: true, status: true, createdAt: true },
  })
  return rows.map((r) => ({ ...r, amountCents: r.amountCents == null ? null : toCents(r.amountCents), createdAt: r.createdAt.toISOString(), link: `/exceptions?kind=${r.kind}` }))
}

// ─── Period-close checks (wave Z adds them to CLOSE_CHECKS) ─────────────────

/** A posting_failed flag's document date: metadata.documentDate (ISO) when its writer set one, else when it was raised. */
function flagDocumentDate(f: { metadata: Prisma.JsonValue | null; createdAt: Date }): Date {
  const d = metaString(f.metadata, 'documentDate')
  const at = d ? new Date(d) : null
  return at && !Number.isNaN(at.getTime()) ? at : f.createdAt
}

export const inventoryCloseChecks: CloseCheck[] = [
  {
    key: 'grni_stale',
    severity: 'warn',
    overridable: true,
    async run(ctx) {
      const g = await grniOpen(ctx.db, ctx.tenantId, { receivedBefore: ctx.newLock, now: ctx.newLock })
      if (g.staleLines === 0) return null
      return {
        key: 'grni_stale', severity: 'warn',
        title: 'Goods received but not billed for over 30 days',
        detail: `${g.staleLines} receipt line(s) received more than ${GRNI_STALE_DAYS} days before ${fmtPktDate(ctx.newLock)} still have no bill. `
          + 'Chase the supplier for the bill, or request a write-off on Received, not billed.',
        count: g.staleLines, ...(g.staleCents > 0 ? { cents: g.staleCents } : {}),
        link: '/procurement/grni', overridable: true,
      }
    },
  },
  {
    key: 'inventory_postings_pending',
    severity: 'warn',
    overridable: true,
    async run(ctx) {
      const flags = await ctx.db.exceptionFlag.findMany({
        where: {
          tenantId: ctx.tenantId, kind: 'posting_failed', status: { in: ['open', 'acknowledged'] },
          OR: [
            { metadata: { path: ['sourceType'], string_starts_with: 'inventory.' } },
            { metadata: { path: ['sourceType'], string_starts_with: 'procurement.' } },
          ],
        },
        select: { amountCents: true, metadata: true, createdAt: true },
      })
      const due = flags.filter((f) => flagDocumentDate(f).getTime() <= ctx.newLock.getTime())
      if (due.length === 0) return null
      const cents = due.reduce((s, f) => s + Math.abs(sumCents(f.amountCents)), 0)
      return {
        key: 'inventory_postings_pending', severity: 'warn',
        title: 'Stock postings the ledger refused',
        detail: `${due.length} stock or purchasing posting(s) dated on or before ${fmtPktDate(ctx.newLock)} did not reach the ledger. `
          + 'Re-post them from Reconciliation → Backfill unposted so the food-cost report and the inventory accounts agree.',
        count: due.length, ...(cents > 0 ? { cents } : {}),
        link: '/exceptions?kind=posting_failed', overridable: true,
      }
    },
  },
]

// ─── The scheduled email ─────────────────────────────────────────────────────

const esc = (t: string) => t.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}`
const pctText = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)

/** The period a schedule covers: since it last ran, else the previous 7 PKT days. */
export function foodCostEmailPeriod(lastRunAt: Date | null, now: Date = new Date()): { from: Date; to: Date } {
  if (lastRunAt && lastRunAt.getTime() < now.getTime()) return { from: lastRunAt, to: now }
  const today = fmtPktDate(now)
  const day = (n: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * DAY_MS).toISOString().slice(0, 10)
  return { from: parsePktStartOfDay(day(7)), to: parsePktEndOfDay(day(1)) }
}

/**
 * The 'food_cost' schedule's email: the summary, the top 10 unexplained
 * ingredients and the warnings — for the schedule's OWN company only (and its
 * brand when it names one). Revenue and % only when the schedule's creator's
 * role is in FINANCIALS_VIEWERS. A schedule with no company throws
 * 'no company' (the worker records 'failed: no company') — never unscoped.
 */
export async function buildFoodCostEmail(db: Db, schedule: ScheduledReport, now: Date = new Date()): Promise<{ subject: string; html: string }> {
  if (!schedule.tenantId) throw new AppError('NO_COMPANY', 'no company', 422)
  const tenantId = schedule.tenantId
  if (schedule.conceptId) {
    const c = await db.concept.findUnique({ where: { id: schedule.conceptId }, select: { tenantId: true } })
    if (!c || c.tenantId !== tenantId) throw new AppError('BRAND_NOT_IN_COMPANY', 'brand not in the schedule\'s company', 422)
  }
  const creator = schedule.createdById ? await db.user.findUnique({ where: { id: schedule.createdById }, select: { role: true } }) : null
  const revenueVisible = !!creator && FINANCIALS_VIEWERS.includes(creator.role)
  const { from, to } = foodCostEmailPeriod(schedule.lastRunAt, now)
  const [block] = await foodCostSummary(db, { tenantIds: [tenantId], from, to, revenueVisible, ...(schedule.conceptId ? { conceptId: schedule.conceptId } : {}) })
  if (!block) throw new AppError('NO_COMPANY', 'no company', 422)
  const ingredients = (await ingredientVariance(db, { tenantId, from, to, ...(schedule.conceptId ? { conceptId: schedule.conceptId } : {}), sort: 'unexplained' }))
    .filter((r) => r.unexplained.cents !== 0 || Math.abs(r.unexplained.qty) > 1e-9)
    .slice(0, 10)
  const b = block.buckets
  const period = `${fmtPktDate(from)} to ${fmtPktDate(to)}`
  const row = (label: string, cents: number, note = '') => `<tr><td>${esc(label)}</td><td style="text-align:right">${pkr(cents)}</td><td>${esc(note)}</td></tr>`
  const wasteRows = WASTE_REASONS.filter((r) => b.waste.byReason[r].totalCents !== 0).map((r) => row(`Waste — ${WASTE_REASON_LABEL[r]}`, b.waste.byReason[r].totalCents)).join('')
  const head = revenueVisible
    ? `<ul>
        <li>Brand sales: <strong>${pkr(block.revenueCents ?? 0)}</strong></li>
        <li>Theoretical: <strong>${pctText(block.theoreticalPct)}</strong> · Actual: <strong>${pctText(block.actualPct)}</strong> · Target: ${pctText(block.targetPct)} · Actual vs theoretical: ${block.avtPoints == null ? '—' : `${block.avtPoints > 0 ? '+' : ''}${block.avtPoints.toFixed(1)} points`}</li>
      </ul>`
    : '<p>Quantities and PKR at cost (sales figures are for finance).</p>'
  const ingRows = ingredients.length === 0
    ? '<tr><td colspan="4">Nothing unexplained.</td></tr>'
    : ingredients.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.classLabel)}</td><td style="text-align:right">${r.unexplained.qty} ${esc(r.unit)}</td><td style="text-align:right">${pkr(r.unexplained.cents)}</td></tr>`).join('')
  const warnRows = block.warnings.length === 0 ? '' : `<h3>Warnings</h3><ul>${block.warnings.map((w) => `<li>${esc(w.message)}${w.names?.length ? ` (${esc(w.names.join(', '))})` : ''}</li>`).join('')}</ul>`
  return {
    subject: `[servd] Food cost ${period} — ${block.companyName}: ${block.statusLabel}`,
    html: `
      <h2>Food cost variance — ${esc(block.companyName)}</h2>
      <p>${esc(period)} (PKT). Status: <strong>${esc(block.statusLabel)}</strong>.</p>
      ${head}
      <table cellpadding="6" border="1" style="border-collapse:collapse">
        ${row('Theoretical (recipes at the price paid)', block.theoretical.totalCents)}
        ${row('Comps', b.comps.totalCents)}
        ${row('Staff meals', b.staffMeals.totalCents)}
        ${wasteRows}
        ${row('Prep draws', b.prepDraws.totalCents)}
        ${row('Issued on receipt', b.issueOnReceipt.totalCents)}
        ${row('Late deliveries settling earlier sales', b.shortfallSettles.totalCents)}
        ${row('Price adjustments (bills vs receipts)', b.priceAdjustments)}
        ${row('Count variance', b.countVariance.totalCents, 'unexplained')}
        ${row('Cooked before it was on the books', b.notOnBooks, 'unexplained')}
        ${row('Other entries', b.otherEntries, 'unexplained')}
        ${row('FIFO cut-over (pre-FIFO orders)', block.alignmentCents)}
        ${row('Timing (open orders, drawers, postings)', block.timing?.totalCents ?? 0)}
        ${row('Actual (ledger cost of sales)', block.actual?.totalCents ?? 0)}
      </table>
      <p>Q factor allowance (${Q_ALLOWANCE_LABEL}): ${pkr(block.allowance.qFactorCents)}.</p>
      <h3>Top unexplained ingredients</h3>
      <table cellpadding="6" border="1" style="border-collapse:collapse">
        <tr><th>Ingredient</th><th>Class</th><th>Quantity</th><th>PKR</th></tr>${ingRows}
      </table>
      ${warnRows}
      <p><small>Full report: Reports → Food cost variance.</small></p>`,
  }
}
