// Sales KPIs — the ONE implementation of each figure the dashboards show.
//
// /reports (sales, top items, station times, by channel), the role-gated
// /management bundles (F&B, Brand, CEO executive overview) and the daily sales
// email all call these. They used to carry their own copies, which disagreed:
// the F&B dashboard's top items multiplied SUM(unit price) by SUM(quantity),
// so three PKR 500 sales showed as PKR 4,500 there and PKR 1,500 on the CEO
// page; station ticket time was computed three times with three roundings.
//
// WHAT "SALES" MEANS HERE (BOOKS-01). Sales are read from the ORDERS: every
// order of the companies in scope that completed in the period (status
// completed, or refunded later — the ledger books those as a sale plus a
// refund too), with refunds counted on the day the money went back. These
// used to read the FinancialEntry sales register, which nothing has written
// since owner decision 39, so every sales report, the CEO overview and the
// daily email showed PKR 0.
//
// `net` is the P&L's net revenue for these sales, from the SAME formula the
// ledger posts with (accounting/orderPosting.ts computeSaleAccounting and
// refundShareOf, shiftPosting.ts for the till):
//
//   net = order value (charged + wallet credit)
//         − GST − tips (a liability to staff, never revenue)
//         − till comps (7030)
//         + discount funded by loyalty points (7020, paid from the 2060 liability)
//         − refunds, less the GST and tip share of each refund
//
// i.e. revenue (4xxx incl. 4100 service charge) − contra revenue (7xxx), the
// figure /accounting/pl-ledger shows. What it can't see: postings that are not
// sales (manual journals, allocations), and timing — a till sale reaches the
// ledger when its drawer is closed, here when the order completed.

import { OrderSource, type OrderStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { calculatePointsValue } from '../../lib/loyaltySettings.js'
import { fmtPktDate, parsePktStartOfDay, parsePktEndOfDay } from '../accounting/dates.js'
import { refundShareOf, type SaleOrderFields } from '../accounting/orderPosting.js'

export interface SalesQuery {
  /** Company scope — scopeTenantWhere(req, 'read'), or `{ tenantId }` in a worker. */
  company: TenantIdWhere
  conceptId?: string | null
  locationId?: string | null
  channel?: string | null
  from: Date
  to: Date
}

// ─── Dates: PKT business days (BOOKS-12) ─────────────────────────────────────
//
// Every finance date filter means the PKT business day, as /accounting/* does
// (accounting/dates.ts): dateFrom = 00:00 PKT on that day, dateTo = 23:59:59.999
// PKT. Only the date part of the value is read, so the admin's older
// `2026-10-10T00:00:00Z` / `T23:59:59Z` pairs mean the same PKT day too. They
// used to be parsed as UTC instants: a date-only range collapsed to one
// instant (nothing), and orders rung between 00:00 and 05:00 PKT fell into the
// previous day here while the P&L counted them on the right one.

const DATE_PART = /^\d{4}-\d{2}-\d{2}/

/**
 * A report period as [from, to] UTC instants covering whole PKT days. Missing
 * ends default to today (PKT) and `defaultDays` before it. 400 on a value that
 * is not a date, or a range that runs backwards.
 */
export function reportDateRange(
  dateFrom: string | undefined | null,
  dateTo: string | undefined | null,
  defaultDays: number,
  now: Date = new Date(),
): { from: Date; to: Date } {
  const check = (name: string, v: string) => {
    // Round-trip, so 2026-02-30 is refused rather than rolled into March.
    const start = DATE_PART.test(v) ? parsePktStartOfDay(v) : null
    if (!start || isNaN(start.getTime()) || fmtPktDate(start) !== v.slice(0, 10)) {
      throw new AppError('INVALID_DATE', `${name} must be a date (YYYY-MM-DD)`, 400)
    }
  }
  if (dateFrom) check('dateFrom', dateFrom)
  if (dateTo) check('dateTo', dateTo)
  const to = parsePktEndOfDay(dateTo || fmtPktDate(now))
  const from = dateFrom
    ? parsePktStartOfDay(dateFrom)
    : parsePktStartOfDay(fmtPktDate(new Date(to.getTime() - defaultDays * 86_400_000)))
  if (from.getTime() > to.getTime()) {
    throw new AppError('INVALID_DATE_RANGE', 'dateFrom is after dateTo', 400)
  }
  return { from, to }
}

// ─── Which orders are sales ──────────────────────────────────────────────────

/** Statuses of an order that was sold (refunded = sold, then refunded in full). */
export const SOLD_STATUSES: OrderStatus[] = ['completed', 'refunded']

const ORDER_SOURCES = new Set<string>(Object.values(OrderSource))

function conceptScope(q: SalesQuery): Prisma.ConceptWhereInput {
  return { ...q.company, deletedAt: null }
}

/** The brand / kitchen / channel filters, inside the company scope. */
function orderScope(q: SalesQuery): Prisma.OrderWhereInput {
  return {
    ...(q.conceptId && { conceptId: q.conceptId }),
    ...(q.locationId && { locationId: q.locationId }),
    // An unknown channel matches nothing (it used to be a free-text column).
    ...(q.channel && { source: ORDER_SOURCES.has(q.channel) ? (q.channel as OrderSource) : { in: [] } }),
    concept: conceptScope(q),
  }
}

/** When an order counts as sold: its completion, or (older rows) when it was placed. */
function soldInWindow(from: Date, to: Date): Prisma.OrderWhereInput {
  return {
    OR: [
      { completedAt: { gte: from, lte: to } },
      { completedAt: null, placedAt: { gte: from, lte: to } },
    ],
  }
}

/** The orders sold in the period, in scope — the one definition every sales figure reads. */
export function soldOrderWhere(q: SalesQuery): Prisma.OrderWhereInput {
  return { AND: [orderScope(q), { status: { in: SOLD_STATUSES } }, soldInWindow(q.from, q.to)] }
}

/** One rounding rule for every minutes figure: one decimal place. */
export function roundMinutes(ms: number, count: number): number {
  return count > 0 ? Number((ms / count / 60_000).toFixed(1)) : 0
}

// ─── Sales totals ────────────────────────────────────────────────────────────

export interface SalesTotals {
  /** Orders sold in the period (completed, incl. those refunded since). */
  orders: number
  /** Order value: Σ charged + wallet credit — incl. GST, service charge and tip, after discounts, before refunds. */
  gross: number
  /** Discounts and promos given on these orders. */
  discount: number
  /** GST on these sales, less the GST share of refunds in the period. */
  tax: number
  /** Tips (owed to staff — not revenue), less refunded tip shares. */
  tips: number
  /** Value comped at the till (7030). */
  comps: number
  /** Discount paid for with loyalty points (credited back to 7020 from the points liability). */
  loyaltyRedeemed: number
  /** Money handed back on refunds in the period, incl. GST. */
  refunds: number
  /** Net sales = the P&L's net revenue for these sales: ex-GST, ex-tips, after discounts, comps and refunds. */
  net: number
}

const emptyTotals = (): SalesTotals => ({ orders: 0, gross: 0, discount: 0, tax: 0, tips: 0, comps: 0, loyaltyRedeemed: 0, refunds: 0, net: 0 })

function finish(t: SalesTotals): SalesTotals {
  t.net = t.gross - t.refunds - t.tax - t.tips - t.comps + t.loyaltyRedeemed
  return t
}

type BucketBy = 'all' | 'channel' | 'pktDay' | 'pktHour'

const pktHour = (d: Date) => String((d.getUTCHours() + 5) % 24)

function keyAt(by: BucketBy, at: Date, source: string): string {
  if (by === 'channel') return source
  if (by === 'pktDay') return fmtPktDate(at)
  if (by === 'pktHour') return pktHour(at)
  return 'all'
}

const SALE_FIELDS = {
  totalCents: true, walletAmountCents: true, taxCents: true, tipCents: true,
  discountCents: true, promoDiscountCents: true, serviceChargeCents: true,
} as const

/**
 * Sales totals per bucket — the whole period, per channel, per PKT day or per
 * PKT hour. Sales are bucketed by when the order completed; refunds by when
 * the money went back; comps and loyalty with their order.
 */
async function salesBuckets(q: SalesQuery, by: BucketBy): Promise<Map<string, SalesTotals>> {
  const buckets = new Map<string, SalesTotals>()
  const slot = (k: string) => buckets.get(k) ?? (buckets.set(k, emptyTotals()), buckets.get(k)!)
  const where = soldOrderWhere(q)
  const soldAt = (o: { completedAt: Date | null; placedAt: Date }) => o.completedAt ?? o.placedAt

  const addSale = (t: SalesTotals, count: number, s: Partial<Record<keyof typeof SALE_FIELDS, number | null>>) => {
    t.orders   += count
    t.gross    += (s.totalCents ?? 0) + (s.walletAmountCents ?? 0)
    t.tax      += s.taxCents ?? 0
    t.tips     += s.tipCents ?? 0
    t.discount += (s.discountCents ?? 0) + (s.promoDiscountCents ?? 0)
  }

  // 1. The sales. Whole-period and per-channel totals aggregate in the
  //    database; the time series bucket row by row.
  if (by === 'all') {
    const agg = await prisma.order.aggregate({ where, _sum: SALE_FIELDS, _count: true })
    if (agg._count > 0) addSale(slot('all'), agg._count, agg._sum)
  } else if (by === 'channel') {
    const rows = await prisma.order.groupBy({ by: ['source'], where, _sum: SALE_FIELDS, _count: true })
    for (const r of rows) addSale(slot(r.source), r._count, r._sum)
  } else {
    const rows = await prisma.order.findMany({ where, select: { ...SALE_FIELDS, completedAt: true, placedAt: true, source: true } })
    for (const o of rows) addSale(slot(keyAt(by, soldAt(o), o.source)), 1, o)
  }

  // 2. Till comps on those orders — the shift close books them to 7030.
  //    (Online orders are posted per order and never book a comp.)
  const comps = await prisma.payment.findMany({
    where: { method: 'comp', status: 'paid', amountCents: { gt: 0 }, order: { AND: [where, { source: 'pos' }] } },
    select: { amountCents: true, order: { select: { completedAt: true, placedAt: true, source: true } } },
  })
  for (const c of comps) slot(keyAt(by, soldAt(c.order), c.order.source)).comps += c.amountCents

  // 3. Loyalty points spent on those orders: the order carries the discount
  //    (7010) and the redemption credits 7020 from the points liability, at
  //    the company's point value (lib/loyaltySettings.ts, as loyaltyPosting).
  const redeems = await prisma.loyaltyTransaction.findMany({
    where: { type: 'redeem', pointsDelta: { lt: 0 }, order: where },
    select: { pointsDelta: true, order: { select: { completedAt: true, placedAt: true, source: true, concept: { select: { tenantId: true } } } } },
  })
  const pointValue = new Map<string, number>()
  for (const r of redeems) {
    if (!r.order) continue
    const tenantId = r.order.concept.tenantId
    if (!tenantId) continue
    if (!pointValue.has(tenantId)) pointValue.set(tenantId, await calculatePointsValue(1, tenantId))
    slot(keyAt(by, soldAt(r.order), r.order.source)).loyaltyRedeemed += Math.floor(Math.abs(r.pointsDelta)) * pointValue.get(tenantId)!
  }

  // 4. Refunds handed back in the period — each refund row is its own ledger
  //    entry (orderPosting.ts postRefundPayment), split into revenue, service
  //    charge, tip and GST by the same cumulative pro-rata rule.
  const refundOrder = { select: { ...SALE_FIELDS, source: true, payments: { where: { status: 'refunded' as const }, select: { id: true, amountCents: true, createdAt: true } } } }
  const refunds = await prisma.payment.findMany({
    where: {
      status: 'refunded', amountCents: { lt: 0 },
      order: { AND: [orderScope(q), { status: { in: SOLD_STATUSES } }] },
      OR: [
        { processedAt: { gte: q.from, lte: q.to } },
        { processedAt: null, createdAt: { gte: q.from, lte: q.to } },
      ],
    },
    select: { id: true, amountCents: true, processedAt: true, createdAt: true, order: refundOrder },
  })
  const addRefund = (at: Date, order: SaleOrderFields & { source: string }, prior: number, amount: number) => {
    const share = refundShareOf(order, prior, amount)
    const t = slot(keyAt(by, at, order.source))
    t.refunds += amount
    t.tax     -= share.taxCents
    t.tips    -= share.tipCents
  }
  for (const p of refunds) {
    // "Before this one" exactly as postRefundPayment orders them.
    const before = (r: { id: string; createdAt: Date }) =>
      r.createdAt.getTime() < p.createdAt.getTime() || (r.createdAt.getTime() === p.createdAt.getTime() && r.id < p.id)
    const prior = p.order.payments.filter((r) => r.id !== p.id && before(r)).reduce((s, r) => s + Math.abs(r.amountCents), 0)
    addRefund(p.processedAt ?? p.createdAt, p.order, prior, Math.abs(p.amountCents))
  }

  // 5. Wallet credit given back when an order is refunded in full ('order.
  //    refund_wallet': Dr revenue / GST shares, Cr 2050), on the day it went back.
  const restores = await prisma.walletTransaction.findMany({
    where: { type: 'refund', orderId: { not: null }, createdAt: { gte: q.from, lte: q.to } },
    select: { orderId: true, createdAt: true },
  })
  if (restores.length > 0) {
    const restored = await prisma.order.findMany({
      where: { AND: [orderScope(q), { id: { in: restores.map((w) => w.orderId!) }, status: 'refunded', walletAmountCents: { gt: 0 } }] },
      select: { id: true, ...refundOrder.select },
    })
    const at = new Map(restores.map((w) => [w.orderId!, w.createdAt]))
    for (const o of restored) {
      const prior = o.payments.reduce((s, r) => s + Math.abs(r.amountCents), 0)
      addRefund(at.get(o.id)!, o, prior, o.walletAmountCents)
    }
  }

  for (const t of buckets.values()) finish(t)
  return buckets
}

export async function salesTotals(q: SalesQuery): Promise<SalesTotals> {
  return (await salesBuckets(q, 'all')).get('all') ?? emptyTotals()
}

/** Sales by hour of the day (PKT, by completion), for the same-day chart. */
export async function salesByHour(q: SalesQuery): Promise<Record<string, { orders: number; gross: number; net: number }>> {
  const out: Record<string, { orders: number; gross: number; net: number }> = {}
  for (const [h, t] of await salesBuckets(q, 'pktHour')) out[h] = { orders: t.orders, gross: t.gross, net: t.net }
  return out
}

/** Sales per order channel (pos / servd / cart / manual). */
export async function salesByChannel(q: SalesQuery): Promise<Array<SalesTotals & { source: string }>> {
  return Array.from(await salesBuckets(q, 'channel'))
    .map(([source, t]) => ({ source, ...t }))
    .sort((a, b) => b.gross - a.gross)
}

/** Sales per PKT day, gap-filled so a sparkline is continuous. */
export async function dailySeries(q: SalesQuery): Promise<Array<{ date: string; gross: number; net: number; orders: number }>> {
  const buckets = await salesBuckets(q, 'pktDay')
  const series: Array<{ date: string; gross: number; net: number; orders: number }> = []
  const end = fmtPktDate(q.to)
  let cur = fmtPktDate(q.from)
  for (let guard = 0; cur <= end && guard < 400; guard++) {
    const t = buckets.get(cur)
    series.push({ date: cur, gross: t?.gross ?? 0, net: t?.net ?? 0, orders: t?.orders ?? 0 })
    cur = new Date(new Date(`${cur}T00:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10)
  }
  return series
}

// ─── Items and kitchen ───────────────────────────────────────────────────────

export interface TopItem {
  rank: number
  menuItemId: string | null
  name: string
  quantity: number
  revenueCents: number
}

/**
 * Best sellers by quantity over the orders completed in the period (the same
 * window as the sales totals). Revenue is Σ(price × qty) per price point —
 * never SUM(price) × SUM(qty), which reported three PKR 500 sales as PKR 4,500.
 */
export async function topItems(q: SalesQuery, limit: number): Promise<TopItem[]> {
  const rows = await prisma.orderItem.groupBy({
    by: ['menuItemId', 'name', 'unitPriceCents'],
    _sum: { quantity: true },
    where: {
      status: { not: 'voided' },
      menuItemId: { not: null },
      order: { AND: [orderScope(q), { status: 'completed' }, soldInWindow(q.from, q.to)] },
    },
  })

  const byItem = new Map<string, { menuItemId: string | null; name: string; quantity: number; revenueCents: number }>()
  for (const r of rows) {
    const key = r.menuItemId ?? r.name
    const qty = r._sum.quantity ?? 0
    const slot = byItem.get(key) ?? { menuItemId: r.menuItemId, name: r.name, quantity: 0, revenueCents: 0 }
    slot.quantity     += qty
    slot.revenueCents += r.unitPriceCents * qty
    byItem.set(key, slot)
  }

  return Array.from(byItem.values())
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }))
}

export interface StationTimes {
  stations: Array<{ stationId: string; stationName: string; items: number; avgMinutes: number }>
  /** Fire → bump across every station; null when nothing was bumped. */
  avgTicketMinutes: number | null
}

/** Average fire → bump minutes per station, over the period's orders. */
export async function stationTimes(q: SalesQuery): Promise<StationTimes> {
  const items = await prisma.orderItem.findMany({
    where: {
      firedAt: { not: null }, completedAt: { not: null }, status: 'bumped',
      order: {
        ...(q.conceptId && { conceptId: q.conceptId }),
        concept: conceptScope(q),
        placedAt: { gte: q.from, lte: q.to },
      },
    },
    select: { firedAt: true, completedAt: true, stationId: true, station: { select: { name: true } } },
  })

  const map = new Map<string, { stationId: string; stationName: string; totalMs: number; items: number }>()
  let allMs = 0, allItems = 0
  for (const it of items) {
    if (!it.firedAt || !it.completedAt) continue
    const ms = it.completedAt.getTime() - it.firedAt.getTime()
    const key = it.stationId ?? 'unknown'
    const slot = map.get(key) ?? { stationId: key, stationName: it.station?.name ?? 'Unknown', totalMs: 0, items: 0 }
    slot.items += 1; slot.totalMs += ms
    map.set(key, slot)
    allMs += ms; allItems += 1
  }
  return {
    stations: Array.from(map.values())
      .map((s) => ({ stationId: s.stationId, stationName: s.stationName, items: s.items, avgMinutes: roundMinutes(s.totalMs, s.items) }))
      .sort((a, b) => b.avgMinutes - a.avgMinutes),
    avgTicketMinutes: allItems > 0 ? roundMinutes(allMs, allItems) : null,
  }
}
