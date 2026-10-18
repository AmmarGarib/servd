// Director → Brand performance (owner, 2026-10-18): what a director sees for
// ONE of their brands over a period. Every figure comes from the EXISTING
// report function that already computes it — called with that brand's filter
// — never a second calculation (standing rule, 2026-09-25):
//
//   sales     reports/service.ts salesTotals / dailySeries / salesByChannel /
//             salesByTender / topItems  (SalesQuery { company: the brand's
//             company, conceptId: the brand } — the /reports/* figures)
//   pnl       accounting/reports.ts brandPnl over the brand's company with
//             ONLY this brand in `brands` → its own row (labour % included:
//             wages booked to the brand). The company and "Company overhead"
//             rows and the allocation basis are never returned.
//   foodCost  reports/foodCost.ts foodCostSummary { conceptId } → this brand's
//             block and its items only (no company name, warnings or
//             company-wide open orders / shifts).
//   menu      reports/menu-engineering.ts getMenuEngineering { conceptId }
//   reviews / complaints — read-only lists of the brand's own rows (the
//             /reviews and /complaints lists are route-inline queries with
//             customer contact; these select no customer, no phone, no email,
//             and mask phone numbers / emails typed into free text). Ban
//             appeals are not complaints about the brand: never listed.
//
// Nothing here names another brand or a company total. Money is in paisa.

import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { fmtPktDate } from '../accounting/dates.js'
import { reportDateRange, salesTotals, dailySeries, salesByChannel, salesByTender, topItems, type SalesQuery } from '../reports/service.js'
import { brandPnl, emptyBrandPnlRow, type BrandPnlRow } from '../accounting/reports.js'
import { foodCostSummary } from '../reports/foodCost.js'
import { getMenuEngineering } from '../reports/menu-engineering.js'
import type { DirectorBrand } from './access.js'

const DAY_MS = 86_400_000
/** Longest period one request may cover. */
export const MAX_PERIOD_DAYS = 366

export interface DirectorPeriod { from: Date; to: Date; dateFrom: string; dateTo: string }

/**
 * Whole PKT days. Default: this month so far (the 1st of the current PKT
 * month → today). 400 on a bad date, a backwards range or more than
 * MAX_PERIOD_DAYS.
 */
export function directorPeriod(q: { dateFrom?: string; dateTo?: string }, now: Date = new Date()): DirectorPeriod {
  const today = fmtPktDate(now)
  const { from, to } = reportDateRange(q.dateFrom || `${today.slice(0, 8)}01`, q.dateTo || today, 0, now)
  if (to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new AppError('INVALID_DATE_RANGE', `Pick a period of at most ${MAX_PERIOD_DAYS} days.`, 400)
  }
  return { from, to, dateFrom: fmtPktDate(from), dateTo: fmtPktDate(to) }
}

function salesQueryOf(brand: DirectorBrand, p: DirectorPeriod): SalesQuery {
  return { company: { tenantId: brand.tenantId }, conceptId: brand.id, locationId: null, channel: null, from: p.from, to: p.to }
}

export async function directorSales(brand: DirectorBrand, p: DirectorPeriod) {
  const q = salesQueryOf(brand, p)
  const [totals, daily, byChannel, byTender, items] = await Promise.all([
    salesTotals(q), dailySeries(q), salesByChannel(q), salesByTender(q), topItems(q, 20),
  ])
  const averageBillCents = totals.orders > 0 ? Math.round(totals.net / totals.orders) : 0
  return {
    totals: { ...totals, averageBillCents },
    daily,
    byChannel,
    byTender: { tenders: byTender.tenders, totalCents: byTender.totalCents, comp: byTender.comp, refunds: byTender.refunds },
    topItems: items,
  }
}

export async function directorPnl(brand: DirectorBrand, p: DirectorPeriod): Promise<BrandPnlRow> {
  const report = await brandPnl([brand.tenantId], p.from, p.to, [{ id: brand.id, name: brand.name }])
  return report.brands.find((r) => r.conceptId === brand.id) ?? emptyBrandPnlRow(brand.id, brand.name)
}

export async function directorFoodCost(brand: DirectorBrand, p: DirectorPeriod) {
  const [block] = await foodCostSummary(prisma, {
    tenantIds: [brand.tenantId], from: p.from, to: p.to, conceptId: brand.id, revenueVisible: true,
  })
  const own = block?.brands.find((b) => b.conceptId === brand.id) ?? null
  return {
    summary: own ? { ...own, name: brand.name } : null,
    items: (block?.items ?? []).filter((i) => i.conceptId === brand.id),
  }
}

export async function directorMenu(brand: DirectorBrand, p: DirectorPeriod) {
  return getMenuEngineering({ conceptId: brand.id, dateFrom: p.from, dateTo: p.to })
}

// ─── Reviews and complaints: the brand's own rows, no customer contact ──────

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
// 7+ digits, allowing spaces, dashes, dots, brackets and a leading + between them.
const PHONE = /\+?\d(?:[\s().-]*\d){6,}/g

/** Hide phone numbers and email addresses a customer typed into free text. */
export function maskContacts(text: string | null | undefined): string | null {
  if (text == null) return null
  return text.replace(EMAIL, '[hidden]').replace(PHONE, '[hidden]')
}

const LIST_CAP = 200

export async function directorReviews(brand: DirectorBrand, p: DirectorPeriod) {
  const where = { conceptId: brand.id, createdAt: { gte: p.from, lte: p.to } }
  const [rows, agg] = await Promise.all([
    prisma.orderReview.findMany({
      where,
      select: { id: true, rating: true, comment: true, categoryRatings: true, tags: true, source: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: LIST_CAP,
    }),
    prisma.orderReview.aggregate({ where, _avg: { rating: true }, _count: true }),
  ])
  const avg = agg._avg.rating
  return {
    reviews: rows.map((r) => ({ ...r, comment: maskContacts(r.comment), tags: r.tags.map((t) => maskContacts(t) ?? '') })),
    total: agg._count,
    average: avg == null ? null : Math.round(avg * 10) / 10,
  }
}

export async function directorComplaints(brand: DirectorBrand, p: DirectorPeriod) {
  const where = { conceptId: brand.id, kind: 'complaint', createdAt: { gte: p.from, lte: p.to } }
  const [rows, byStatus] = await Promise.all([
    prisma.orderComplaint.findMany({
      where,
      select: {
        id: true, title: true, description: true, category: true, status: true, priority: true,
        createdAt: true, resolvedAt: true, resolution: true,
      },
      orderBy: { createdAt: 'desc' },
      take: LIST_CAP,
    }),
    prisma.orderComplaint.groupBy({ by: ['status'], where, _count: true }),
  ])
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0
  const total = byStatus.reduce((n, b) => n + b._count, 0)
  return {
    complaints: rows.map((c) => ({
      ...c, title: maskContacts(c.title) ?? '', description: maskContacts(c.description) ?? '', resolution: maskContacts(c.resolution),
    })),
    stats: { total, open: count('open'), inProgress: count('in_progress'), resolved: count('resolved'), closed: count('closed') },
  }
}
