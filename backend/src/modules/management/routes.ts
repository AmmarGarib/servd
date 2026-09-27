// Management dashboards API.
//
// Role-gated bundles (one call per dashboard):
//
//   GET  /management/brand-metrics       — Brand Manager (marketing-finance KPIs)
//   GET  /management/fnb-metrics         — F&B Manager (kitchen + food KPIs)
//   GET  /management/executive-overview  — CEO money section
//
// Each returns everything its dashboard needs in one call, so the managers
// don't need broad API access — they're guarded to exactly the role groups
// that own each surface. The figures themselves come from ONE implementation
// each: sales KPIs from reports/service.ts (the same functions /reports
// uses), P&L from the ledger (accounting/reports.ts).

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS, MARKETING_TEAM } from '../auth/middleware.js'
import { profitAndLoss, cashFlow, pnlByConcept } from '../accounting/reports.js'
import { outputTaxCollectedCents } from '../accounting/salesTaxReturn.js'
import { labourPctReport } from '../../lib/labour.js'
import { isBelowPar } from '../../lib/recipeCost.js'
import { resolveTenantScope, scopeTenantWhere, type TenantIdWhere } from '../../lib/tenantScope.js'
import { salesTotals, dailySeries, topItems, stationTimes } from '../reports/service.js'

// ── Per-brand P&L, from the ledger only ──────────────────────────────────────
// Every figure is the journal's. Brand revenue, COGS, discounts and opex are
// MEASURED from lines tagged with the brand (order and shift postings carry a
// conceptId). What isn't tagged — shared overhead, manual entries, historical
// lines from before brand-tagging — is the "shared remainder", allocated
// across brands by their share of LEDGER revenue (whether untagged cost should
// instead stay an unallocated head-office line is an open owner question; the
// revenue-share split is today's behaviour, kept).
//
// Brand revenue used to come from the sales register (FinancialEntry: GST-
// inclusive and already net of discount) while its costs and discounts came
// from the ledger, so brand margins took the discount off twice and never
// matched the company margin beside them; and company revenue silently fell
// back to register gross whenever the ledger had none.
async function computeBrandPl(
  conceptId: string | undefined,
  from: Date,
  to: Date,
  // Companies in view. The ledger is per company, so the P&L reads only these
  // companies' books — never a blend with someone else's chart of accounts.
  tenantIds: string[],
  company: TenantIdWhere,
) {
  const [pl, labour, conceptPnl, concepts] = await Promise.all([
    profitAndLoss(tenantIds, from, to),
    labourPctReport(tenantIds, from, to),
    pnlByConcept(tenantIds, from, to),
    prisma.concept.findMany({ where: { ...company, deletedAt: null }, select: { id: true, name: true } }),
  ])
  const companyCogs   = pl.totals.cogsCents
  const companyContra = pl.totals.contraRevenueCents
  const companyOpex   = pl.totals.opexCents
  const companyLabour = labour.labourCents
  const names = new Map(concepts.map((c) => [c.id, c.name]))

  const measured = new Map<string, { revenue: number; cogs: number; contra: number; opex: number }>()
  let taggedRevenue = 0, taggedCogs = 0, taggedContra = 0, taggedOpex = 0
  for (const b of conceptPnl) {
    if (!b.conceptId || !names.has(b.conceptId)) continue
    measured.set(b.conceptId, { revenue: b.revenueCents, cogs: b.cogsCents, contra: b.contraRevenueCents, opex: b.opexCents })
    taggedRevenue += b.revenueCents
    taggedCogs += b.cogsCents; taggedContra += b.contraRevenueCents; taggedOpex += b.opexCents
  }
  const sharedCogs   = Math.max(0, companyCogs   - taggedCogs)
  const sharedContra = Math.max(0, companyContra - taggedContra)
  const sharedOpex   = Math.max(0, companyOpex   - taggedOpex)
  const measuredCogsPct = companyCogs > 0 ? Number(((taggedCogs / companyCogs) * 100).toFixed(1)) : 0

  // Allocation base = every brand's measured ledger revenue in the scope, so
  // shares are stable even when a single brand is requested.
  function alloc(brandId: string) {
    const m = measured.get(brandId) ?? { revenue: 0, cogs: 0, contra: 0, opex: 0 }
    const share = taggedRevenue > 0 ? m.revenue / taggedRevenue : 0
    const revenueCents = m.revenue
    const cogsCents   = m.cogs   + Math.round(sharedCogs   * share)
    const contraCents = m.contra + Math.round(sharedContra * share)
    const opexCents   = m.opex   + Math.round(sharedOpex   * share)
    const labourCents = Math.round(companyLabour * share)
    const grossProfitCents = revenueCents - cogsCents - contraCents
    const netProfitCents   = grossProfitCents - opexCents
    const pctOf = (c: number) => (revenueCents > 0 ? Number(((c / revenueCents) * 100).toFixed(2)) : 0)
    return {
      revenueCents, netRevenueCents: revenueCents - contraCents,
      cogsCents, contraCents, opexCents, labourCents,
      grossProfitCents, netProfitCents,
      grossMarginPct: pctOf(grossProfitCents),
      netMarginPct:   pctOf(netProfitCents),
      foodCostPct:    pctOf(cogsCents),
      labourPct:      pctOf(labourCents),
      primeCostPct:   pctOf(cogsCents + labourCents),
    }
  }

  const brands = Array.from(measured.keys()).map((id) => ({ conceptId: id, name: names.get(id) ?? id, ...alloc(id) }))
  const revenue = pl.totals.revenueCents
  const pct = (c: number) => (revenue > 0 ? Number(((c / revenue) * 100).toFixed(2)) : 0)
  const companyBlock = {
    revenueCents: revenue, netRevenueCents: revenue - companyContra,
    cogsCents: companyCogs, contraCents: companyContra, opexCents: companyOpex, labourCents: companyLabour,
    grossProfitCents: pl.totals.grossProfitCents, netProfitCents: pl.totals.netProfitCents,
    grossMarginPct: pl.totals.grossMarginPct,
    netMarginPct: pct(pl.totals.netProfitCents),
    foodCostPct: pct(companyCogs),
    labourPct: labour.labourPct,
    primeCostPct: pct(companyCogs + companyLabour),
  }
  const selected = conceptId
    ? (brands.find((b) => b.conceptId === conceptId) ?? (names.has(conceptId) ? { conceptId, name: names.get(conceptId)!, ...alloc(conceptId) } : null))
    : null
  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    conceptId: conceptId ?? null,
    company: companyBlock, brands, selected,
    allocation: 'measured-cost+shared-allocated' as const,
    // Transparency for the dashboard: how much of company COGS is measured per
    // brand vs still allocated by revenue share (rises toward 100% as tagged
    // postings replace historical untagged data).
    basis: { measuredCogsPct, sharedCogsCents: sharedCogs, sharedOpexCents: sharedOpex, source: 'ledger' as const },
  }
}

// ── date helpers ─────────────────────────────────────────────────────────────
function dateRange(dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  const to = dateTo ? new Date(dateTo) : new Date()
  const from = dateFrom ? new Date(dateFrom) : new Date(to.getTime() - 30 * 86_400_000)
  return { from, to }
}

export async function managementRoutes(fastify: FastifyInstance) {

  // ── Brand Manager metrics ─────────────────────────────────────────────────
  // ARPU, AOV, LTV + the customer counts they're built from.
  // Guarded to the marketing team (incl. brand_manager) + every manager.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/brand-metrics',
    { preHandler: requireAuth(...MARKETING_TEAM) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      const company = await scopeTenantWhere(req, 'read')
      const concept = { ...company, deletedAt: null }

      // Register sales + order count — the same function /reports/sales uses.
      const sales = await salesTotals({ company, conceptId, from, to })
      const gross  = sales.gross
      const net    = sales.net
      const orders = sales.orders

      // Distinct + new customers in the period (completed orders only).
      const grouped = await prisma.order.groupBy({
        by: ['customerId'],
        where: {
          status: 'completed',
          customerId: { not: null },
          ...(conceptId ? { conceptId } : {}),
          concept,
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
          orders: { some: { ...(conceptId ? { conceptId } : {}), concept: company } },
        },
        _avg: { totalSpentCents: true },
        _count: true,
      })
      const ltvCents = Math.round(ltvAgg._avg.totalSpentCents ?? 0)

      // Reputation + complaints (cheap, useful context on the brand dash).
      const [ratingAgg, openComplaints] = await Promise.all([
        prisma.orderReview.aggregate({
          where: { ...(conceptId ? { conceptId } : {}), concept, createdAt: { gte: from, lte: to } },
          _avg: { rating: true }, _count: true,
        }),
        prisma.orderComplaint.count({
          where: { ...(conceptId ? { conceptId } : {}), concept, status: { in: ['open', 'in_progress'] } },
        }),
      ])

      // Derived KPIs. null when the denominator is missing so the dashboard
      // shows "—" rather than a fake number.
      const aov  = orders > 0 ? Math.round(gross / orders) : null
      const arpu = distinctCustomers > 0 ? Math.round(gross / distinctCustomers) : null

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        // Sales register: what customers paid, incl. GST (not ledger revenue).
        revenue: { grossCents: gross, netCents: net, orders, basis: 'sales_register' as const },
        customers: { distinct: distinctCustomers, new: newCustomers, returning: returningCustomers },
        kpis: {
          aovCents:  aov,            // average order value
          arpuCents: arpu,           // average revenue per (active) user, this period
          ltvCents,                  // average lifetime spend per customer (all-time)
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
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      const company = await scopeTenantWhere(req, 'read')
      const concept = { ...company, deletedAt: null }
      const q = { company, conceptId, from, to }

      // Register sales, best sellers and station times — the same functions
      // /reports uses (top-item revenue is Σ price × qty per price point).
      const [sales, top, kitchen] = await Promise.all([salesTotals(q), topItems(q, 8), stationTimes(q)])
      const aov = sales.orders > 0 ? Math.round(sales.gross / sales.orders) : null

      // Food-quality signals: complaints by category + review average.
      const [foodComplaints, allComplaintsByCat, ratingAgg] = await Promise.all([
        prisma.orderComplaint.count({
          where: {
            ...(conceptId ? { conceptId } : {}),
            concept,
            category: { in: ['quality', 'wrong_item', 'missing_item'] },
            createdAt: { gte: from, lte: to },
          },
        }),
        prisma.orderComplaint.groupBy({
          by: ['category'],
          where: { ...(conceptId ? { conceptId } : {}), concept, createdAt: { gte: from, lte: to } },
          _count: true,
        }),
        prisma.orderReview.aggregate({
          where: { ...(conceptId ? { conceptId } : {}), concept, createdAt: { gte: from, lte: to } },
          _avg: { rating: true }, _count: true,
        }),
      ])

      // Stock health (company-scoped — inventory isn't per-brand).
      const inventory = await prisma.inventoryItem.findMany({
        where: { deletedAt: null, ...company },
        select: { name: true, currentStock: true, parLevel: true },
      })
      // THE below-par rule (lib/recipeCost.ts): par must be set — items with
      // parLevel 0 are untracked and used to count whenever their stock was 0.
      const lowStock = inventory.filter((i) => isBelowPar(i))
      const lowStockItems = lowStock
        .map((i) => ({ name: i.name, currentStock: i.currentStock, parLevel: i.parLevel }))
        .slice(0, 12)

      // Waste cost in the period (company-scoped).
      const wasteAgg = await prisma.wasteLog.aggregate({
        where: { recordedAt: { gte: from, lte: to }, inventoryItem: company },
        _sum: { estimatedCostCents: true }, _count: true,
      })

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        // Sales register: what customers paid, incl. GST (not ledger revenue).
        sales: { grossCents: sales.gross, orders: sales.orders, aovCents: aov, basis: 'sales_register' as const },
        topItems: top.map((t) => ({ rank: t.rank, name: t.name, quantity: t.quantity, revenueCents: t.revenueCents })),
        kitchen,
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

  // GET /management/executive-overview?conceptId&dateFrom&dateTo — the CEO
  // "money" payload in one round-trip.
  //
  //   pl, netRevenueCents, taxCollectedCents, cashFlowNetCents — the LEDGER
  //     (the same books as /accounting/pl-ledger and the sales-tax return).
  //   sales, series — the sales REGISTER (orders, what customers paid incl.
  //     GST), for order count, average ticket and the sparkline; labelled as
  //     such on the page.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/executive-overview',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      const company = await scopeTenantWhere(req, 'read')
      const tenantIds = (await resolveTenantScope(req)).tenantIds
      const q = { company, conceptId, from, to }

      const [pl, cf, totals, series, taxCollectedCents] = await Promise.all([
        computeBrandPl(conceptId, from, to, tenantIds, company),
        cashFlow(tenantIds, from, to),
        salesTotals(q),
        dailySeries(q),
        outputTaxCollectedCents(tenantIds, from, to),
      ])
      const block = conceptId ? pl.selected : pl.company

      return {
        period: { from: from.toISOString(), to: to.toISOString() },
        conceptId: conceptId ?? null,
        sales: { totals: { gross: totals.gross, net: totals.net, tax: totals.tax, orders: totals.orders }, basis: 'sales_register' as const },
        pl,
        // Ledger revenue after discounts / refunds, ex-GST — for the brand when
        // one is picked, else the company.
        netRevenueCents: block?.netRevenueCents ?? 0,
        // Output sales tax in the ledger for the whole company scope (the
        // return is filed per company, never per brand).
        taxCollectedCents,
        cashFlowNetCents: cf.totals.netCents,
        series: series.map((d) => ({ date: d.date, gross: d.gross, orders: d.orders })),
      }
    },
  )
}
