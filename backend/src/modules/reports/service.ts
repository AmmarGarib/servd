// Sales KPIs — the ONE implementation of each figure the dashboards show.
//
// /reports (sales, top items, station times, by channel), the role-gated
// /management bundles (F&B, Brand, CEO executive overview) and the daily sales
// email all call these. They used to carry their own copies, which disagreed:
// the F&B dashboard's top items multiplied SUM(unit price) by SUM(quantity),
// so three PKR 500 sales showed as PKR 4,500 there and PKR 1,500 on the CEO
// page; station ticket time was computed three times with three roundings.
//
// WHAT "SALES" MEANS HERE. These read the sales register (FinancialEntry: one
// row per completed order, gross = what the customer paid, INCLUDING GST and
// service charge, after discounts) and completed orders. That is not the
// ledger's revenue (ex-GST, before discounts, with refunds reversed) — the
// P&L, trial balance and tax return read the journal (accounting/reports.ts).
// Whether operational dashboards should show register sales or ledger net
// revenue is waiting on the owner, so these keep today's numbers and every
// screen labels them as register figures.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { fmtPktDate } from '../accounting/dates.js'

export interface SalesQuery {
  /** Company scope — scopeTenantWhere(req, 'read'), or `{ tenantId }` in a worker. */
  company: TenantIdWhere
  conceptId?: string | null
  locationId?: string | null
  channel?: string | null
  from: Date
  to: Date
}

function conceptScope(q: SalesQuery): Prisma.ConceptWhereInput {
  return { ...q.company, deletedAt: null }
}

function registerWhere(q: SalesQuery): Prisma.FinancialEntryWhereInput {
  return {
    ...(q.conceptId && { conceptId: q.conceptId }),
    ...(q.locationId && { locationId: q.locationId }),
    ...(q.channel && { channel: q.channel }),
    concept: conceptScope(q),
    entryDate: { gte: q.from, lte: q.to },
  }
}

/** One rounding rule for every minutes figure: one decimal place. */
export function roundMinutes(ms: number, count: number): number {
  return count > 0 ? Number((ms / count / 60_000).toFixed(1)) : 0
}

// ─── Sales register totals ───────────────────────────────────────────────────

export interface SalesTotals {
  /** What customers paid: Σ Order.totalCents (incl. GST + service charge, after discounts). */
  gross: number
  /** The register's stored net (gross − commission − discount). Kept as today; see header. */
  net: number
  commission: number
  tax: number
  discount: number
  orders: number
}

export async function salesTotals(q: SalesQuery): Promise<SalesTotals> {
  const agg = await prisma.financialEntry.aggregate({
    where: registerWhere(q),
    _sum: { grossCents: true, netCents: true, commissionCents: true, taxCents: true, discountCents: true },
    _count: true,
  })
  return {
    gross:      agg._sum.grossCents ?? 0,
    net:        agg._sum.netCents ?? 0,
    commission: agg._sum.commissionCents ?? 0,
    tax:        agg._sum.taxCents ?? 0,
    discount:   agg._sum.discountCents ?? 0,
    orders:     agg._count,
  }
}

/** Register sales by hour of the day (PKT), for the same-day chart. */
export async function salesByHour(q: SalesQuery): Promise<Record<string, { orders: number; gross: number }>> {
  const rows = await prisma.financialEntry.findMany({ where: registerWhere(q), select: { entryDate: true, grossCents: true } })
  const byHour: Record<string, { orders: number; gross: number }> = {}
  for (const e of rows) {
    const h = String((e.entryDate.getUTCHours() + 5) % 24)
    const slot = byHour[h] ?? (byHour[h] = { orders: 0, gross: 0 })
    slot.orders += 1
    slot.gross  += e.grossCents
  }
  return byHour
}

/** Register sales per order channel (pos / servd / cart / manual). */
export async function salesByChannel(q: SalesQuery): Promise<Array<{ source: string; orders: number; gross: number; net: number }>> {
  const rows = await prisma.financialEntry.groupBy({
    by: ['channel'],
    where: registerWhere(q),
    _sum: { grossCents: true, netCents: true },
    _count: true,
  })
  return rows
    .map((r) => ({ source: r.channel, orders: r._count, gross: r._sum.grossCents ?? 0, net: r._sum.netCents ?? 0 }))
    .sort((a, b) => b.gross - a.gross)
}

/** Register sales per PKT day, gap-filled so a sparkline is continuous. */
export async function dailySeries(q: SalesQuery): Promise<Array<{ date: string; gross: number; net: number; orders: number }>> {
  const rows = await prisma.financialEntry.findMany({ where: registerWhere(q), select: { entryDate: true, grossCents: true, netCents: true } })
  const buckets = new Map<string, { date: string; gross: number; net: number; orders: number }>()
  for (const e of rows) {
    const d = fmtPktDate(e.entryDate)
    const b = buckets.get(d) ?? { date: d, gross: 0, net: 0, orders: 0 }
    b.gross += e.grossCents; b.net += e.netCents; b.orders += 1
    buckets.set(d, b)
  }
  const series: Array<{ date: string; gross: number; net: number; orders: number }> = []
  const end = fmtPktDate(q.to)
  let cur = fmtPktDate(q.from)
  for (let guard = 0; cur <= end && guard < 400; guard++) {
    series.push(buckets.get(cur) ?? { date: cur, gross: 0, net: 0, orders: 0 })
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
 * Best sellers by quantity over completed orders. Revenue is Σ(price × qty)
 * per price point — never SUM(price) × SUM(qty), which reported three PKR 500
 * sales as PKR 4,500.
 */
export async function topItems(q: SalesQuery, limit: number): Promise<TopItem[]> {
  const rows = await prisma.orderItem.groupBy({
    by: ['menuItemId', 'name', 'unitPriceCents'],
    _sum: { quantity: true },
    where: {
      status: { not: 'voided' },
      menuItemId: { not: null },
      order: {
        status: 'completed',
        ...(q.conceptId && { conceptId: q.conceptId }),
        concept: conceptScope(q),
        placedAt: { gte: q.from, lte: q.to },
      },
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
