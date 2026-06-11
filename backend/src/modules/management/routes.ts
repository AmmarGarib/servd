// Management dashboards API.
//
// Two self-contained metric endpoints (one per manager) plus the
// marketing-spend CRUD that powers the Brand Manager's CAC / CRC / ROAS.
//
//   GET  /management/brand-metrics   — Brand Manager (marketing-finance KPIs)
//   GET  /management/fnb-metrics     — F&B Manager (kitchen + food KPIs)
//   GET  /management/marketing-spend — read a brand's spend for a month
//   PUT  /management/marketing-spend — upsert a brand's spend for a month
//
// Each metric endpoint returns EVERYTHING its dashboard needs in one call, so
// the managers don't need broad API access — they're guarded to exactly the
// role groups that own each surface.

import type { FastifyInstance } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, MARKETING_TEAM } from '../auth/middleware.js'
import { profitAndLoss, cashFlow } from '../accounting/reports.js'
import { labourPctReport } from '../payroll/service.js'

// ── Per-brand P&L (revenue-share allocation) ──────────────────────────────────
// The general ledger books COGS / labour / opex company-wide (journal lines
// carry no conceptId), while real per-brand REVENUE lives on FinancialEntry. We
// attribute the shared cost lines to each brand by its share of gross revenue —
// so the per-brand numbers reconcile to the company books, at the cost of
// cost-*ratios* being company-blended. The genuinely differentiated per-brand
// food-cost % is computed separately (recipe-based) on the client. Shared by
// /brand-pl and /executive-overview.
async function computeBrandPl(conceptId: string | undefined, from: Date, to: Date, tenantFilter: Prisma.ConceptWhereInput['tenantId']) {
  const conceptScope: Prisma.ConceptWhereInput = { tenantId: tenantFilter, deletedAt: null }
  const [pl, labour] = await Promise.all([profitAndLoss(from, to), labourPctReport(from, to)])
  const companyCogs   = pl.totals.cogsCents
  const companyContra = pl.totals.contraRevenueCents
  const companyOpex   = pl.totals.opexCents
  const companyLabour = labour.labourCents

  const entries = await prisma.financialEntry.findMany({
    where: { ...(conceptId ? { conceptId } : {}), concept: conceptScope, entryDate: { gte: from, lte: to } },
    select: { conceptId: true, grossCents: true, netCents: true, taxCents: true, concept: { select: { name: true } } },
  })
  const perBrand = new Map<string, { name: string; grossCents: number; netCents: number; taxCents: number; orders: number }>()
  for (const e of entries) {
    const b = perBrand.get(e.conceptId) ?? { name: e.concept.name, grossCents: 0, netCents: 0, taxCents: 0, orders: 0 }
    b.grossCents += e.grossCents; b.netCents += e.netCents; b.taxCents += e.taxCents; b.orders += 1
    perBrand.set(e.conceptId, b)
  }
  // Allocation base = TOTAL gross across the tenant (all brands) so shares are
  // stable even when a single brand is requested.
  const allEntries = conceptId
    ? await prisma.financialEntry.groupBy({ by: ['conceptId'], where: { concept: conceptScope, entryDate: { gte: from, lte: to } }, _sum: { grossCents: true } })
    : Array.from(perBrand.entries()).map(([id, b]) => ({ conceptId: id, _sum: { grossCents: b.grossCents } }))
  const totalGross = allEntries.reduce((s, r) => s + (r._sum.grossCents ?? 0), 0)

  function alloc(brandGross: number) {
    const share = totalGross > 0 ? brandGross / totalGross : 0
    const cogsCents   = Math.round(companyCogs * share)
    const contraCents = Math.round(companyContra * share)
    const opexCents   = Math.round(companyOpex * share)
    const labourCents = Math.round(companyLabour * share)
    const grossProfitCents = brandGross - cogsCents - contraCents
    const netProfitCents   = grossProfitCents - opexCents
    const pctOf = (c: number) => (brandGross > 0 ? Number(((c / brandGross) * 100).toFixed(2)) : 0)
    return {
      revenueCents: brandGross, cogsCents, contraCents, opexCents, labourCents,
      grossProfitCents, netProfitCents,
      grossMarginPct: pctOf(grossProfitCents),
      netMarginPct:   pctOf(netProfitCents),
      foodCostPct:    pctOf(cogsCents),
      labourPct:      pctOf(labourCents),
      primeCostPct:   pctOf(cogsCents + labourCents),
    }
  }

  const brands = Array.from(perBrand.entries()).map(([id, b]) => ({ conceptId: id, name: b.name, orders: b.orders, taxCents: b.taxCents, ...alloc(b.grossCents) }))
  const companyGross = Array.from(perBrand.values()).reduce((s, b) => s + b.grossCents, 0)
  const company = {
    revenueCents: pl.totals.revenueCents || companyGross,
    cogsCents: companyCogs, contraCents: companyContra, opexCents: companyOpex, labourCents: companyLabour,
    grossProfitCents: pl.totals.grossProfitCents, netProfitCents: pl.totals.netProfitCents,
    grossMarginPct: pl.totals.grossMarginPct,
    netMarginPct: pl.totals.revenueCents > 0 ? Number(((pl.totals.netProfitCents / pl.totals.revenueCents) * 100).toFixed(2)) : 0,
    foodCostPct: pl.totals.revenueCents > 0 ? Number(((companyCogs / pl.totals.revenueCents) * 100).toFixed(2)) : 0,
    labourPct: labour.labourPct,
    primeCostPct: pl.totals.revenueCents > 0 ? Number((((companyCogs + companyLabour) / pl.totals.revenueCents) * 100).toFixed(2)) : 0,
  }
  const selected = conceptId ? (brands.find((b) => b.conceptId === conceptId) ?? null) : null
  return { period: { from: from.toISOString(), to: to.toISOString() }, conceptId: conceptId ?? null, company, brands, selected, allocation: 'revenue-share' as const }
}

// ── date helpers ─────────────────────────────────────────────────────────────
function dateRange(dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  const to = dateTo ? new Date(dateTo) : new Date()
  const from = dateFrom ? new Date(dateFrom) : new Date(to.getTime() - 30 * 86_400_000)
  return { from, to }
}

// Marketing spend is entered per calendar month. To value it against an
// arbitrary period we pro-rate each overlapping month by the share of its days
// that fall inside [from, to]. e.g. a week-long period in June uses 7/30 of
// June's spend.
function monthsInRange(from: Date, to: Date): Array<{ month: string; fraction: number }> {
  const out: Array<{ month: string; fraction: number }> = []
  const cur = new Date(from.getFullYear(), from.getMonth(), 1)
  while (cur <= to) {
    const y = cur.getFullYear(), m = cur.getMonth()
    const monthStart = new Date(y, m, 1)
    const monthEnd   = new Date(y, m + 1, 0, 23, 59, 59, 999)
    const daysInMonth = monthEnd.getDate()
    const overlapStart = from > monthStart ? from : monthStart
    const overlapEnd   = to   < monthEnd   ? to   : monthEnd
    const overlapDays  = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 86_400_000)
    const fraction = Math.min(1, overlapDays / daysInMonth)
    out.push({ month: `${y}-${String(m + 1).padStart(2, '0')}`, fraction })
    cur.setMonth(cur.getMonth() + 1)
  }
  return out
}

async function spendForPeriod(conceptId: string | undefined, from: Date, to: Date) {
  const months = monthsInRange(from, to)
  const rows = await prisma.marketingSpend.findMany({
    where: {
      month: { in: months.map((m) => m.month) },
      ...(conceptId ? { conceptId } : {}),
    },
    select: { month: true, acquisitionCents: true, retentionCents: true },
  })
  const fracByMonth = new Map(months.map((m) => [m.month, m.fraction]))
  let acquisition = 0, retention = 0
  for (const r of rows) {
    const f = fracByMonth.get(r.month) ?? 0
    acquisition += r.acquisitionCents * f
    retention   += r.retentionCents * f
  }
  return { acquisitionCents: Math.round(acquisition), retentionCents: Math.round(retention) }
}

export async function managementRoutes(fastify: FastifyInstance) {

  // ── Brand Manager metrics ─────────────────────────────────────────────────
  // CAC, CRC, ROAS, ARPU, AOV, LTV + the customer counts they're built from.
  // Guarded to the marketing team (incl. brand_manager) + every manager.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/brand-metrics',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      // Revenue + order count from posted financial entries (reconciles with /reports).
      const sales = await prisma.financialEntry.aggregate({
        where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, entryDate: { gte: from, lte: to } },
        _sum: { grossCents: true, netCents: true },
        _count: true,
      })
      const gross  = sales._sum.grossCents ?? 0
      const net    = sales._sum.netCents ?? 0
      const orders = sales._count

      // Distinct + new customers in the period (completed orders only).
      const grouped = await prisma.order.groupBy({
        by: ['customerId'],
        where: {
          status: 'completed',
          customerId: { not: null },
          ...(conceptId ? { conceptId } : {}),
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          placedAt: { gte: from, lte: to },
        },
      })
      const customerIds = grouped.map((g) => g.customerId).filter((x): x is string => !!x)
      const distinctCustomers = customerIds.length

      // "New" = those whose first-ever order falls in this window.
      const newCustomers = customerIds.length === 0 ? 0 : await prisma.customer.count({
        where: { id: { in: customerIds }, firstOrderAt: { gte: from, lte: to } },
      })
      const returningCustomers = Math.max(0, distinctCustomers - newCustomers)

      // Lifetime value — average total spend across this brand's ordering base.
      // Customer has no tenant column, so scope LTV to customers who have at
      // least one order in this tenant (and brand, if filtered).
      const ltvAgg = await prisma.customer.aggregate({
        where: {
          firstOrderAt: { not: null },
          orders: { some: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter } } },
        },
        _avg: { totalSpentCents: true },
        _count: true,
      })
      const ltvCents = Math.round(ltvAgg._avg.totalSpentCents ?? 0)

      // Reputation + complaints (cheap, useful context on the brand dash).
      const [ratingAgg, openComplaints] = await Promise.all([
        prisma.orderReview.aggregate({
          where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, createdAt: { gte: from, lte: to } },
          _avg: { rating: true }, _count: true,
        }),
        prisma.orderComplaint.count({
          where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, status: { in: ['open', 'in_progress'] } },
        }),
      ])

      const spend = await spendForPeriod(conceptId, from, to)
      const totalSpend = spend.acquisitionCents + spend.retentionCents

      // Derived KPIs. null when the denominator is missing (e.g. CAC with no
      // spend entered) so the dashboard shows "—" rather than a fake number.
      const aov  = orders > 0 ? Math.round(gross / orders) : null
      const arpu = distinctCustomers > 0 ? Math.round(gross / distinctCustomers) : null
      const cac  = (spend.acquisitionCents > 0 && newCustomers > 0)
        ? Math.round(spend.acquisitionCents / newCustomers) : null
      const crc  = (spend.retentionCents > 0 && returningCustomers > 0)
        ? Math.round(spend.retentionCents / returningCustomers) : null
      const roas = totalSpend > 0 ? Math.round((gross / totalSpend) * 100) / 100 : null

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        revenue: { grossCents: gross, netCents: net, orders },
        customers: { distinct: distinctCustomers, new: newCustomers, returning: returningCustomers },
        spend,                       // { acquisitionCents, retentionCents }  (period-prorated)
        kpis: {
          aovCents:  aov,            // average order value
          arpuCents: arpu,           // average revenue per (active) user, this period
          ltvCents,                  // average lifetime spend per customer (all-time)
          cacCents:  cac,            // customer acquisition cost
          crcCents:  crc,            // customer retention cost
          roas,                      // return on ad spend (blended), e.g. 4.2 = 4.2x
        },
        reputation: {
          avgRating: ratingAgg._avg.rating ?? null,
          reviewCount: ratingAgg._count,
          openComplaints,
        },
      }
    },
  )

  // ── F&B Manager metrics ───────────────────────────────────────────────────
  // Kitchen throughput + sales + food-quality signals + stock health.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/fnb-metrics',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      // Sales totals.
      const sales = await prisma.financialEntry.aggregate({
        where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, entryDate: { gte: from, lte: to } },
        _sum: { grossCents: true, netCents: true },
        _count: true,
      })
      const gross  = sales._sum.grossCents ?? 0
      const orders = sales._count
      const aov    = orders > 0 ? Math.round(gross / orders) : null

      // Top sellers (by quantity).
      const topRows = await prisma.orderItem.groupBy({
        by: ['menuItemId', 'name'],
        _sum: { quantity: true, unitPriceCents: true },
        where: {
          status: { not: 'voided' },
          menuItemId: { not: null },
          order: { status: 'completed', ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, placedAt: { gte: from, lte: to } },
        },
        orderBy: { _sum: { quantity: 'desc' } },
        take: 8,
      })
      const topItems = topRows.map((r, i) => ({
        rank: i + 1,
        name: r.name,
        quantity: r._sum.quantity ?? 0,
        revenueCents: (r._sum.unitPriceCents ?? 0) * (r._sum.quantity ?? 0),
      }))

      // Kitchen throughput — avg fire→bump minutes per station.
      const fired = await prisma.orderItem.findMany({
        where: {
          firedAt: { not: null }, completedAt: { not: null }, status: 'bumped',
          order: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, placedAt: { gte: from, lte: to } },
        },
        select: { firedAt: true, completedAt: true, stationId: true, station: { select: { name: true } } },
      })
      const stMap: Record<string, { stationName: string; totalMs: number; items: number }> = {}
      let allMs = 0, allItems = 0
      for (const it of fired) {
        if (!it.firedAt || !it.completedAt) continue
        const ms = it.completedAt.getTime() - it.firedAt.getTime()
        const key = it.stationId ?? 'unknown'
        if (!stMap[key]) stMap[key] = { stationName: it.station?.name ?? 'Unknown', totalMs: 0, items: 0 }
        stMap[key]!.items += 1; stMap[key]!.totalMs += ms
        allMs += ms; allItems += 1
      }
      const stations = Object.values(stMap)
        .map((s) => ({ stationName: s.stationName, items: s.items, avgMinutes: s.items > 0 ? Math.round((s.totalMs / s.items / 60_000) * 10) / 10 : 0 }))
        .sort((a, b) => b.avgMinutes - a.avgMinutes)
      const avgTicketMinutes = allItems > 0 ? Math.round((allMs / allItems / 60_000) * 10) / 10 : null

      // Food-quality signals: complaints by category + review average.
      const [foodComplaints, allComplaintsByCat, ratingAgg] = await Promise.all([
        prisma.orderComplaint.count({
          where: {
            ...(conceptId ? { conceptId } : {}),
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
            category: { in: ['quality', 'wrong_item', 'missing_item'] },
            createdAt: { gte: from, lte: to },
          },
        }),
        prisma.orderComplaint.groupBy({
          by: ['category'],
          where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, createdAt: { gte: from, lte: to } },
          _count: true,
        }),
        prisma.orderReview.aggregate({
          where: { ...(conceptId ? { conceptId } : {}), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, createdAt: { gte: from, lte: to } },
          _avg: { rating: true }, _count: true,
        }),
      ])

      // Stock health (tenant-scoped — inventory isn't per-brand).
      const inventory = await prisma.inventoryItem.findMany({
        where: { deletedAt: null, tenantId: req.staffUser!.tenantFilter },
        select: { name: true, currentStock: true, parLevel: true },
      })
      const lowStock = inventory.filter((i) => i.currentStock <= i.parLevel)
      const lowStockItems = lowStock
        .map((i) => ({ name: i.name, currentStock: i.currentStock, parLevel: i.parLevel }))
        .slice(0, 12)

      // Waste cost in the period (tenant-scoped).
      const wasteAgg = await prisma.wasteLog.aggregate({
        where: { recordedAt: { gte: from, lte: to }, inventoryItem: { tenantId: req.staffUser!.tenantFilter } },
        _sum: { estimatedCostCents: true }, _count: true,
      })

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        sales: { grossCents: gross, orders, aovCents: aov },
        topItems,
        kitchen: { avgTicketMinutes, stations },
        quality: {
          foodComplaints,
          complaintsByCategory: allComplaintsByCat.map((c) => ({ category: c.category, count: c._count })),
          avgRating: ratingAgg._avg.rating ?? null,
          reviewCount: ratingAgg._count,
        },
        stock: {
          lowStockCount: lowStock.length,
          lowStockItems,
          wasteCostCents: wasteAgg._sum.estimatedCostCents ?? 0,
          wasteEvents: wasteAgg._count,
        },
      }
    },
  )

  // ── Marketing spend CRUD ──────────────────────────────────────────────────
  const monthRx = /^\d{4}-(0[1-9]|1[0-2])$/

  // List the last N months of spend rows (optionally one brand) — powers the
  // Marketing Spend grid in the Management tab. Returns the month axis so the
  // frontend can render an editable cell even for months with no row yet.
  fastify.get<{ Querystring: { conceptId?: string; months?: string } }>(
    '/marketing-spend/list',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const { conceptId } = req.query
      const n = Math.min(Math.max(parseInt(req.query.months ?? '12', 10) || 12, 1), 24)
      const now = new Date()
      const months: string[] = []
      for (let i = 0; i < n; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
      }
      const rows = await prisma.marketingSpend.findMany({
        where: { month: { in: months }, ...(conceptId ? { conceptId } : {}) },
        select: { conceptId: true, month: true, acquisitionCents: true, retentionCents: true, note: true },
      })
      return { months, rows }
    },
  )

  fastify.get<{ Querystring: { conceptId?: string; month?: string } }>(
    '/marketing-spend',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req, reply) => {
      const { conceptId, month } = req.query
      if (!conceptId || !month || !monthRx.test(month)) {
        return reply.status(400).send({ error: { code: 'BAD_INPUT', message: 'conceptId and month=YYYY-MM are required' } })
      }
      const row = await prisma.marketingSpend.findUnique({ where: { conceptId_month: { conceptId, month } } })
      return row ?? { conceptId, month, acquisitionCents: 0, retentionCents: 0, note: null }
    },
  )

  const upsertSchema = z.object({
    conceptId:        z.string().min(1),
    month:            z.string().regex(monthRx, 'month must be YYYY-MM'),
    acquisitionCents: z.number().int().min(0).max(1_000_000_00),
    retentionCents:   z.number().int().min(0).max(1_000_000_00),
    note:             z.string().max(280).nullable().optional(),
  })

  fastify.put('/marketing-spend', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req, reply) => {
    const body = upsertSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId ?? null
    const row = await prisma.marketingSpend.upsert({
      where:  { conceptId_month: { conceptId: body.conceptId, month: body.month } },
      create: {
        conceptId: body.conceptId, month: body.month,
        acquisitionCents: body.acquisitionCents, retentionCents: body.retentionCents,
        note: body.note ?? null, tenantId, updatedById: req.staffUser!.id,
      },
      update: {
        acquisitionCents: body.acquisitionCents, retentionCents: body.retentionCents,
        note: body.note ?? null, updatedById: req.staffUser!.id,
      },
    })
    return reply.status(200).send(row)
  })

  // GET /management/brand-pl?conceptId&dateFrom&dateTo — per-brand P&L.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/brand-pl',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      return computeBrandPl(conceptId, from, to, req.staffUser!.tenantFilter)
    },
  )

  // GET /management/executive-overview?conceptId&dateFrom&dateTo — consolidated
  // "money" payload in one round-trip: scoped sales totals + daily series (for
  // sparklines) + per-brand P&L + company cash-flow net. Lets the CEO dashboard
  // render its heaviest section from a single call instead of four.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/executive-overview',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      const tenantFilter = req.staffUser!.tenantFilter
      const conceptScope: Prisma.ConceptWhereInput = { tenantId: tenantFilter, deletedAt: null }

      const [pl, cf, salesEntries] = await Promise.all([
        computeBrandPl(conceptId, from, to, tenantFilter),
        cashFlow(from, to),
        prisma.financialEntry.findMany({
          where: { ...(conceptId ? { conceptId } : {}), concept: conceptScope, entryDate: { gte: from, lte: to } },
          select: { entryDate: true, grossCents: true, netCents: true, taxCents: true },
        }),
      ])

      const totals = { gross: 0, net: 0, tax: 0, orders: salesEntries.length }
      const dayMap = new Map<string, { date: string; gross: number; orders: number }>()
      for (const e of salesEntries) {
        totals.gross += e.grossCents; totals.net += e.netCents; totals.tax += e.taxCents
        const d = e.entryDate.toISOString().slice(0, 10)
        const b = dayMap.get(d) ?? { date: d, gross: 0, orders: 0 }
        b.gross += e.grossCents; b.orders += 1; dayMap.set(d, b)
      }
      const series = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date))

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        sales: { totals },
        pl,
        cashFlowNetCents: cf.totals.netCents,
        series,
      }
    },
  )
}
