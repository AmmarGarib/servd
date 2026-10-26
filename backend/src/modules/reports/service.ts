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
//   net = order value (charged + wallet credit + gift card)
//         − GST (food GST and the delivery fee's GST) − tips (a liability to
//           staff, never revenue)
//         − till comps (7030)
//         + discount funded by loyalty points (7020, paid from the 2060 liability)
//         − refunds, less the GST and tip share of each refund — tender
//           refunds, and the wallet credit and gift-card balance given back
//           when an order is refunded in full
//
// A gift card lowers Order.totalCents by what it paid (giftCards/service.ts),
// but the ledger credits revenue and GST on the PRE-card value and debits
// 2080 for the card's share (ONL-05) — so the register adds each redemption
// back to the order value, and values every refund against the full order
// (LEDGER-R6), or its GST would disagree with the P&L. A sale the ledger booked
// BEFORE ONL-05 (no 2080 debit naming the order — orderPosting.saleBookingOf
// .legacyGiftCard) took revenue on the post-card total instead, and its refunds
// and card restore are valued that way too, so for those orders the register
// does the same: no add-back, refunds valued without the card, and the card
// restore (which books nothing) is not a refund (R6-A).
//
// The delivery fee ex-tax (Order.deliveryFeeCents, H9) is revenue too — 4110
// Delivery Fee Income — so it stays in `net`; `deliveryFees` reports it apart
// (net of each refund's fee share, the same refundShareOf split the ledger's
// Dr 4110 uses).
//
// i.e. revenue (4xxx incl. 4100 service charge, 4110 delivery fees) − contra revenue (7xxx), the
// figure /accounting/pl-ledger shows. What it can't see: postings that are not
// sales (manual journals, allocations), and timing — a till sale reaches the
// ledger when its drawer is closed, here when the order completed.

import { OrderSource, type OrderStatus, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { calculatePointsValue } from '../../lib/loyaltySettings.js'
import { fmtPktDate, parsePktStartOfDay, parsePktEndOfDay } from '../accounting/dates.js'
import { refundShareOf, giftCardAppliedOf, saleBookingOf, voidSplitOf, netOfVoidRefunds, isSplitVoidRefund, type RefundShare, type SaleOrderFields } from '../accounting/orderPosting.js'
import { tenderLabel } from '../../lib/tenders.js'
import { codStatusOf } from '../../lib/cod.js'
import { orderChannelOf, whatsappOrderWhere, WHATSAPP_CHANNEL } from '../../lib/orderChannel.js'

export interface SalesQuery {
  /** Company scope — scopeTenantWhere(req, 'read'), or `{ tenantId }` in a worker. */
  company: TenantIdWhere
  conceptId?: string | null
  /** Several brands (the till's Reports, reports/tillReports.ts) — each already checked with assertConceptOwned. */
  conceptIds?: string[] | null
  locationId?: string | null
  channel?: string | null
  /**
   * Extra order filters ANDed into the scope (the till's Reports: who rang it,
   * waiter, order type, source, drawer, payment method, search). They only
   * narrow — the company scope above still applies.
   */
  extra?: Prisma.OrderWhereInput | null
  /**
   * Till flow (owner, 2026-10-20): how the bill was closed — 'keenu' (pushed to
   * Keenu), 'servd' (closed in servd), 'none' (legacy / non-till: no channel),
   * 'all' / omitted = combined.
   */
  settlement?: 'keenu' | 'servd' | 'none' | 'all' | null
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
export function orderScope(q: SalesQuery): Prisma.OrderWhereInput {
  const base: Prisma.OrderWhereInput = {
    ...(q.conceptId && { conceptId: q.conceptId }),
    ...(!q.conceptId && q.conceptIds && { conceptId: { in: q.conceptIds } }),
    ...(q.locationId && { locationId: q.locationId }),
    // An unknown channel matches nothing (it used to be a free-text column).
    ...(q.channel === WHATSAPP_CHANNEL ? whatsappOrderWhere
      : q.channel && { source: ORDER_SOURCES.has(q.channel) ? (q.channel as OrderSource) : { in: [] } }),
    ...(q.settlement && q.settlement !== 'all' && { settlementChannel: q.settlement === 'none' ? null : q.settlement }),
    concept: conceptScope(q),
  }
  return q.extra ? { AND: [base, q.extra] } : base
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
  /** Order value: Σ charged + wallet credit + gift card — incl. GST, service charge and tip, after discounts, before refunds. */
  gross: number
  /** Discounts and promos given on these orders. */
  discount: number
  /** GST on these sales, less the GST share of refunds in the period. */
  tax: number
  /** Tips (owed to staff — not revenue), less refunded tip shares. */
  tips: number
  /**
   * Delivery fees ex-tax (4110 Delivery Fee Income, H9), less the fee share of
   * refunds in the period. Informational: already inside gross and net (it is
   * revenue); its GST is inside `tax`. 0 for till sales and legacy deliveries.
   */
  deliveryFees: number
  /** Value comped at the till (7030). */
  comps: number
  /** Discount paid for with loyalty points (credited back to 7020 from the points liability). */
  loyaltyRedeemed: number
  /** Money handed back on refunds in the period, incl. GST. */
  refunds: number
  /** Net sales = the P&L's net revenue for these sales: ex-GST, ex-tips, after discounts, comps and refunds. */
  net: number
}

const emptyTotals = (): SalesTotals => ({ orders: 0, gross: 0, discount: 0, tax: 0, tips: 0, deliveryFees: 0, comps: 0, loyaltyRedeemed: 0, refunds: 0, net: 0 })

function finish(t: SalesTotals): SalesTotals {
  t.net = t.gross - t.refunds - t.tax - t.tips - t.comps + t.loyaltyRedeemed
  return t
}

type BucketBy = 'all' | 'channel' | 'pktDay' | 'pktHour'

/**
 * R6-A: is this order's sale on the books WITHOUT its gift cards (booked before
 * ONL-05: revenue on the post-card total, no 2080 debit naming the order)? The
 * ledger's own test (saleBookingOf), so the register values the order exactly
 * as the ledger's refunds do. Memoised per call of salesBuckets; only orders a
 * gift card paid part of are ever asked.
 */
function legacyCardSaleCheck(): (orderId: string) => Promise<boolean> {
  const memo = new Map<string, Promise<boolean>>()
  return (orderId) => {
    let p = memo.get(orderId)
    if (!p) {
      p = (async () => {
        const o = await prisma.order.findUnique({
          where: { id: orderId },
          select: {
            id: true, conceptId: true, source: true,
            concept: { select: { tenantId: true } },
            payments: { select: { id: true, shiftId: true, method: true, status: true, gatewayRef: true, createdAt: true } },
            giftCardRedemptions: { select: { amountCents: true } },
          },
        })
        if (!o?.concept.tenantId || giftCardAppliedOf(o.giftCardRedemptions) <= 0) return false
        return (await saleBookingOf(prisma, o.concept.tenantId, o)).legacyGiftCard
      })()
      memo.set(orderId, p)
    }
    return p
  }
}

const pktHour = (d: Date) => String((d.getUTCHours() + 5) % 24)

function keyAt(by: BucketBy, at: Date, source: string): string {
  if (by === 'channel') return source // already the channel (orderChannelOf)
  if (by === 'pktDay') return fmtPktDate(at)
  if (by === 'pktHour') return pktHour(at)
  return 'all'
}

const SALE_FIELDS = {
  totalCents: true, walletAmountCents: true, taxCents: true, tipCents: true,
  discountCents: true, promoDiscountCents: true, serviceChargeCents: true, deliveryFeeCents: true,
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
  // R6-A: a sale booked before ONL-05 is valued without its gift cards, as the ledger does.
  const isLegacyCardSale = legacyCardSaleCheck()
  const valued = async <T extends SaleOrderFields & { id: string; giftCardRedemptions: Array<{ amountCents: number }> }>(o: T) => {
    const applied = giftCardAppliedOf(o.giftCardRedemptions)
    return { ...o, giftCardAppliedCents: applied > 0 && await isLegacyCardSale(o.id) ? 0 : applied }
  }

  const addSale = (t: SalesTotals, count: number, s: Partial<Record<keyof typeof SALE_FIELDS, number | null>>) => {
    t.orders   += count
    t.gross    += (s.totalCents ?? 0) + (s.walletAmountCents ?? 0)
    t.tax      += s.taxCents ?? 0
    t.tips     += s.tipCents ?? 0
    t.deliveryFees += s.deliveryFeeCents ?? 0
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
    // WhatsApp orders are source 'servd' too: move them to their own bucket (B10).
    const wa = await prisma.order.aggregate({ where: { AND: [where, whatsappOrderWhere] }, _sum: SALE_FIELDS, _count: true })
    if (wa._count > 0) {
      const web = slot('servd')
      web.orders -= wa._count
      web.gross -= (wa._sum.totalCents ?? 0) + (wa._sum.walletAmountCents ?? 0)
      web.tax -= wa._sum.taxCents ?? 0
      web.tips -= wa._sum.tipCents ?? 0
      web.deliveryFees -= wa._sum.deliveryFeeCents ?? 0
      web.discount -= (wa._sum.discountCents ?? 0) + (wa._sum.promoDiscountCents ?? 0)
      addSale(slot(WHATSAPP_CHANNEL), wa._count, wa._sum)
      if (web.orders === 0) buckets.delete('servd')
    }
  } else {
    const rows = await prisma.order.findMany({ where, select: { ...SALE_FIELDS, completedAt: true, placedAt: true, source: true } })
    for (const o of rows) addSale(slot(keyAt(by, soldAt(o), o.source)), 1, o)
  }
  //    What gift cards paid of those orders: the bill came down by it, but the
  //    ledger credits revenue on the pre-card value (ONL-05). Every redemption
  //    counts — a card given back on a refund is a refund (step 6) — except on
  //    a sale booked before ONL-05, whose revenue was the post-card total (R6-A).
  const cardsPaid = await prisma.giftCardRedemption.findMany({
    where: { amountCents: { gt: 0 }, order: where },
    select: { amountCents: true, order: { select: { id: true, completedAt: true, placedAt: true, source: true, rawPayload: true } } },
  })
  for (const r of cardsPaid) {
    if (!r.order || await isLegacyCardSale(r.order.id)) continue
    slot(keyAt(by, soldAt(r.order), orderChannelOf(r.order))).gross += r.amountCents
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
    select: { pointsDelta: true, order: { select: { completedAt: true, placedAt: true, source: true, rawPayload: true, concept: { select: { tenantId: true } } } } },
  })
  const pointValue = new Map<string, number>()
  for (const r of redeems) {
    if (!r.order) continue
    const tenantId = r.order.concept.tenantId
    if (!tenantId) continue
    if (!pointValue.has(tenantId)) pointValue.set(tenantId, await calculatePointsValue(1, tenantId))
    slot(keyAt(by, soldAt(r.order), orderChannelOf(r.order))).loyaltyRedeemed += Math.floor(Math.abs(r.pointsDelta)) * pointValue.get(tenantId)!
  }

  // 4. Refunds handed back in the period — each refund row is its own ledger
  //    entry (orderPosting.ts postRefundPayment), split into revenue, service
  //    charge, tip and GST by the same cumulative pro-rata rule.
  //    The order is valued with its gift cards, as postRefundPayment values it
  //    (without them for a sale booked before ONL-05 — asBooked, R6-A).
  //    A line voided on a paid, still-open order (TILL-R3) books its exact
  //    split (orderPosting voidSplitOf — no fee, no tip, its own GST), and
  //    every other refund values the order net of those voids, exactly as
  //    postRefundPayment does.
  const refundOrder = {
    select: {
      ...SALE_FIELDS, id: true, source: true, rawPayload: true,
      payments: { where: { status: 'refunded' as const }, select: { id: true, amountCents: true, createdAt: true, gatewayMeta: true } },
      giftCardRedemptions: { select: { amountCents: true } },
    },
  }
  const refunds = await prisma.payment.findMany({
    where: {
      status: 'refunded', amountCents: { lt: 0 },
      order: { AND: [orderScope(q), { status: { in: SOLD_STATUSES } }] },
      OR: [
        { processedAt: { gte: q.from, lte: q.to } },
        { processedAt: null, createdAt: { gte: q.from, lte: q.to } },
      ],
    },
    select: { id: true, amountCents: true, processedAt: true, createdAt: true, gatewayMeta: true, order: refundOrder },
  })
  const addShare = (at: Date, source: string, amount: number, share: RefundShare) => {
    const t = slot(keyAt(by, at, source))
    t.refunds += amount
    t.tax     -= share.taxCents
    t.tips    -= share.tipCents
    t.deliveryFees -= share.deliveryFeeCents
  }
  const addRefund = (at: Date, order: SaleOrderFields & { source: string; rawPayload?: unknown }, prior: number, amount: number) =>
    addShare(at, orderChannelOf(order), amount, refundShareOf(order, prior, amount))
  /** The order net of its exact void refunds, and the refunded amount that is not one of them. */
  const netOfVoids = <T extends SaleOrderFields & { payments: Array<{ amountCents: number; gatewayMeta: unknown }> }>(o: T) => ({
    order: netOfVoidRefunds(o, o.payments),
    tenderRefunded: o.payments.filter((r) => !isSplitVoidRefund(r)).reduce((s, r) => s + Math.abs(r.amountCents), 0),
  })
  for (const p of refunds) {
    const at = p.processedAt ?? p.createdAt
    const split = voidSplitOf(p)
    if (split) { addShare(at, orderChannelOf(p.order), Math.abs(p.amountCents), split); continue }
    // "Before this one" exactly as postRefundPayment orders them.
    const before = (r: { id: string; createdAt: Date }) =>
      r.createdAt.getTime() < p.createdAt.getTime() || (r.createdAt.getTime() === p.createdAt.getTime() && r.id < p.id)
    const prior = p.order.payments.filter((r) => r.id !== p.id && before(r) && !isSplitVoidRefund(r)).reduce((s, r) => s + Math.abs(r.amountCents), 0)
    addRefund(at, await valued(netOfVoidRefunds(p.order, p.order.payments.filter((r) => r.id !== p.id))), prior, Math.abs(p.amountCents))
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
      select: refundOrder.select,
    })
    const at = new Map(restores.map((w) => [w.orderId!, w.createdAt]))
    for (const o of restored) {
      const n = netOfVoids(o)
      addRefund(at.get(o.id)!, await valued(n.order), n.tenderRefunded, o.walletAmountCents)
    }
  }

  // 6. Gift-card balance given back when an order is refunded in full ('order.
  //    refund_giftcard': Dr revenue / GST shares, Cr 2080), on the day it went
  //    back — mirrors orderPosting.postOrderRefund step 4: each card's slice
  //    comes after the tender refunds, the wallet restore and the order's
  //    earlier redemptions. A sale booked before ONL-05 never discharged 2080,
  //    so its card restore books nothing (postOrderRefund) and is no refund here.
  const cardRestores = await prisma.giftCardRedemption.findMany({
    where: {
      reversedAt: { gte: q.from, lte: q.to },
      amountCents: { gt: 0 },
      order: { AND: [orderScope(q), { status: 'refunded' }] },
    },
    select: {
      id: true, amountCents: true, reversedAt: true, redeemedAt: true,
      order: {
        select: {
          ...refundOrder.select,
          walletAmountCents: true,
          giftCardRedemptions: { orderBy: [{ redeemedAt: 'asc' }, { id: 'asc' }], select: { id: true, amountCents: true } },
        },
      },
    },
  })
  for (const r of cardRestores) {
    const o = r.order
    if (!o || !r.reversedAt) continue
    if (await isLegacyCardSale(o.id)) continue
    const n = netOfVoids(o)
    let prior = n.tenderRefunded + (o.walletAmountCents > 0 ? o.walletAmountCents : 0)
    for (const e of o.giftCardRedemptions) {
      if (e.id === r.id) break
      prior += Math.max(0, e.amountCents)
    }
    addRefund(r.reversedAt, await valued(n.order), prior, r.amountCents)
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

/**
 * Sales per settlement channel (till flow, 2026-10-20): keenu, servd and none
 * (legacy / non-till), each through THE sales figures with the filter, and
 * `combined` = their sum (= the unfiltered totals).
 */
export async function salesBySettlement(q: SalesQuery): Promise<{ rows: Array<SalesTotals & { settlement: 'keenu' | 'servd' | 'none' }>; combined: SalesTotals }> {
  const kinds = ['keenu', 'servd', 'none'] as const
  const rows = await Promise.all(kinds.map(async (settlement) => ({ settlement, ...(await salesTotals({ ...q, settlement })) })))
  const combined = emptyTotals()
  for (const r of rows) {
    for (const k of Object.keys(combined) as Array<keyof SalesTotals>) combined[k] += r[k]
  }
  return { rows, combined }
}

/** Sales per order channel (pos / servd / cart / manual / whatsapp — lib/orderChannel.ts). */
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

// ─── Sales by tender (Raast QR, spec §7.6) ───────────────────────────────────
//
// How the period's sold orders (the same soldOrderWhere as every sales
// figure) were paid: the paid receipts by method — Cash (paid into a drawer),
// Card – Keenu, Raast QR and the retired Keenu QR's old rows — plus wallet
// credit (Order.walletAmountCents) and gift cards (redemptions). Cash on
// delivery whose cash has NOT reached a drawer (still 'pending' on a sold
// non-till order) is its own row, never "Cash": 'cod_rider_owes' once
// finance booked it as owed by the rider (H5: Payment.codRiderDebtAt, 1351 /
// the inter-company 'cod' transfer — status from lib/cod.ts codStatusOf),
// 'cod_with_rider' otherwise (still out with the rider, overdue, or a pickup's
// cash not yet at the counter). The rows still add up to the sales. On-account
// bills (the client's account, invoiced on a statement) are their own row. Comps are not money: reported apart, never in a share. sharePct is each
// tender's share of the money tenders (everything but comp). Raast is split
// by its reconciliation state: provisional (no bank statement has shown it
// yet), matched, written off as not received. Refunds by tender are the money
// handed back in the period (refund rows, processedAt), on sold orders — as
// salesTotals counts refunds.

export interface TenderRow {
  tender: string
  label: string
  amountCents: number
  /** Receipts (payment rows / redemptions). */
  payments: number
  /** Orders that used the tender. */
  orders: number
  /** Share of the money tenders' total, one decimal. */
  sharePct: number
}

export interface SalesByTender {
  from: Date
  to: Date
  tenders: TenderRow[]
  totalCents: number
  comp: { amountCents: number; orders: number }
  raast: { provisionalCents: number; provisionalCount: number; matchedCents: number; matchedCount: number; unreceivedCents: number; unreceivedCount: number }
  /**
   * Cash on delivery by where the cash is: paid into a drawer, still with the
   * rider, booked as owed by the rider (H5). `notCollected*` are DEPRECATED
   * aliases of `riderOwes*` (same values) kept for older admin builds.
   */
  cod: {
    paidInCents: number; paidInCount: number; withRiderCents: number; withRiderCount: number
    riderOwesCents: number; riderOwesCount: number
    /** @deprecated use riderOwesCents */
    notCollectedCents: number
    /** @deprecated use riderOwesCount */
    notCollectedCount: number
  }
  refunds: Array<{ tender: string; label: string; amountCents: number; count: number }>
}

const TENDER_ORDER = ['cash', 'cod_with_rider', 'cod_rider_owes', 'card', 'raast', 'on_account', 'keenu_qr', 'wallet', 'gift_card'] as const
/** The two COD rows are not payment methods — their labels live here. */
const COD_LABELS: Record<string, string> = {
  cod_with_rider: 'Cash on delivery – with rider',
  cod_rider_owes: 'Cash on delivery – owed by rider',
}

export async function salesByTender(q: SalesQuery): Promise<SalesByTender> {
  const where = soldOrderWhere(q)
  const rows = await prisma.payment.findMany({
    where: {
      order: where,
      amountCents: { gt: 0 },
      method: { not: 'split' },
      OR: [
        { status: 'paid' },
        // Cash on delivery not yet paid into a drawer: still 'pending' on a
        // sold non-till order — its own rows below, never Cash.
        { status: 'pending', method: 'cash', order: { source: { not: 'pos' } } },
      ],
    },
    select: {
      method: true, status: true, amountCents: true, orderId: true, createdAt: true, codRiderDebtAt: true,
      raastReceipt: { select: { status: true } },
      order: { select: { source: true, fulfilmentType: true, riderId: true, deliveredAt: true, completedAt: true } },
    },
  })
  const cod = { paidInCents: 0, paidInCount: 0, withRiderCents: 0, withRiderCount: 0, riderOwesCents: 0, riderOwesCount: 0 }
  const now = new Date()
  const by = new Map<string, { amountCents: number; payments: number; orders: Set<string> }>()
  const add = (tender: string, cents: number, orderId: string, receipts = 1) => {
    const s = by.get(tender) ?? { amountCents: 0, payments: 0, orders: new Set<string>() }
    s.amountCents += cents
    s.payments += receipts
    s.orders.add(orderId)
    by.set(tender, s)
  }
  const raast = { provisionalCents: 0, provisionalCount: 0, matchedCents: 0, matchedCount: 0, unreceivedCents: 0, unreceivedCount: 0 }
  for (const p of rows) {
    if (p.method === 'cash' && p.status === 'pending') {
      // Cash on delivery not in a drawer — never counted as Cash received.
      // The ONE status rule (lib/cod.ts): booked to the rider (H5) is its own
      // row; with the rider, overdue or at the counter stay 'with rider'.
      if (codStatusOf(p, p.order, now) === 'rider_owes') {
        add('cod_rider_owes', p.amountCents, p.orderId)
        cod.riderOwesCents += p.amountCents; cod.riderOwesCount++
      } else {
        add('cod_with_rider', p.amountCents, p.orderId)
        cod.withRiderCents += p.amountCents; cod.withRiderCount++
      }
      continue
    }
    if (p.method === 'cash' && p.order.source !== 'pos') { cod.paidInCents += p.amountCents; cod.paidInCount++ }
    add(p.method, p.amountCents, p.orderId)
    if (p.method === 'raast') {
      const st = p.raastReceipt?.status
      if (st === 'matched') { raast.matchedCents += p.amountCents; raast.matchedCount++ }
      else if (st === 'unreceived') { raast.unreceivedCents += p.amountCents; raast.unreceivedCount++ }
      else { raast.provisionalCents += p.amountCents; raast.provisionalCount++ }
    }
  }
  const wallets = await prisma.order.findMany({ where: { AND: [where, { walletAmountCents: { gt: 0 } }] }, select: { id: true, walletAmountCents: true } })
  for (const o of wallets) add('wallet', o.walletAmountCents, o.id)
  const cards = await prisma.giftCardRedemption.findMany({ where: { amountCents: { gt: 0 }, order: where }, select: { amountCents: true, orderId: true } })
  for (const c of cards) if (c.orderId) add('gift_card', c.amountCents, c.orderId)

  const comp = by.get('comp')
  by.delete('comp')
  const totalCents = [...by.values()].reduce((s, t) => s + t.amountCents, 0)
  const known = new Set<string>(TENDER_ORDER)
  const keys = [...TENDER_ORDER.filter((k) => by.has(k)), ...[...by.keys()].filter((k) => !known.has(k)).sort()]
  const tenders: TenderRow[] = keys.map((k) => {
    const t = by.get(k)!
    return {
      tender: k, label: COD_LABELS[k] ?? tenderLabel(k), amountCents: t.amountCents, payments: t.payments, orders: t.orders.size,
      sharePct: totalCents > 0 ? Math.round((t.amountCents / totalCents) * 1000) / 10 : 0,
    }
  })

  const refundRows = await prisma.payment.findMany({
    where: {
      status: 'refunded', amountCents: { lt: 0 },
      order: { AND: [orderScope(q), { status: { in: SOLD_STATUSES } }] },
      OR: [
        { processedAt: { gte: q.from, lte: q.to } },
        { processedAt: null, createdAt: { gte: q.from, lte: q.to } },
      ],
    },
    select: { method: true, amountCents: true },
  })
  const refundBy = new Map<string, { amountCents: number; count: number }>()
  for (const r of refundRows) {
    const s = refundBy.get(r.method) ?? { amountCents: 0, count: 0 }
    s.amountCents += Math.abs(r.amountCents)
    s.count++
    refundBy.set(r.method, s)
  }

  return {
    from: q.from, to: q.to, tenders, totalCents,
    comp: { amountCents: comp?.amountCents ?? 0, orders: comp?.orders.size ?? 0 },
    raast,
    // notCollected* — deprecated aliases of riderOwes* (same values) until the admin reads the new keys.
    cod: { ...cod, notCollectedCents: cod.riderOwesCents, notCollectedCount: cod.riderOwesCount },
    refunds: [...refundBy].map(([tender, s]) => ({ tender, label: tenderLabel(tender), ...s })).sort((a, b) => b.amountCents - a.amountCents),
  }
}
