import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import type { UserRole } from '@prisma/client'
import { requireAuth, MANAGERS, FINANCE_TEAM, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned } from '../../lib/tenantScope.js'
import { getMenuEngineering } from './menu-engineering.js'
import { getDemandForecast } from './demand-forecast.js'
import { salesTotals, salesByHour, salesByChannel, salesBySettlement, salesByTender, topItems, stationTimes, reportDateRange, type SalesQuery } from './service.js'
import { exportFormatOf, sendReportFor, type ExportFormat, type ReportRow } from '../../lib/reportExport.js'
import { fmtPktDate } from '../accounting/dates.js'

// Who reads the OPERATIONAL reports — sales volume (orders, orders by hour,
// orders by channel), item mix, ticket times by station and the demand
// forecast: every role whose default modules hold 'reports'
// (lib/moduleAccess.ts) — the manager tiers, finance and procurement (UI-15:
// foh_management / boh_management held the Reports module and got 403 on its
// first tab). The '/reports' module gate then narrows it to whoever actually
// holds the module, so the CEO's Module Access switch is the control. Every
// figure is scoped to the caller's companies (salesQuery → scopeTenantWhere /
// assertConceptOwned).
//
// Company-level REVENUE stays with FINANCIALS_VIEWERS (owner policy, see
// auth/middleware.ts: "revenue reports … operational managers deliberately
// excluded"): /sales and /by-source answer everyone in REPORT_READERS, but the
// money fields (gross, net, tax, refunds, tips, discount) only to
// FINANCIALS_VIEWERS — the others get the order counts. Item revenue on
// /top-items stays with the manager tiers + finance, as before. The P&L,
// ledger, labour % and exec dashboards live in their own modules
// (accounting, management) and are not touched here.
export const REPORT_READERS = [...MANAGERS, 'finance', 'procurement'] as UserRole[]

/** May this caller see company-level revenue (not just volumes)? */
function seesRevenue(req: FastifyRequest): boolean {
  return FINANCIALS_VIEWERS.includes(req.staffUser!.role)
}
/** Item revenue on the item mix: the manager tiers and finance, as before. */
function seesItemRevenue(req: FastifyRequest): boolean {
  return FINANCE_TEAM.includes(req.staffUser!.role)
}

// ?format=csv|xlsx|pdf on /sales, /top-items, /stations, /by-source and
// /by-tender (owner, 2026-10-20): the SAME answer the screen gets — revenue
// already hidden for the volume-only readers — as a file through
// lib/reportExport.ts.
type ExportQ = { format?: string }
function exportOf(req: FastifyRequest): ExportFormat | null {
  return exportFormatOf((req.query as ExportQ).format)
}
const SETTLEMENTS = ['keenu', 'servd', 'none', 'all'] as const
const SETTLEMENT_LABEL: Record<string, string> = { keenu: 'pushed to Keenu', servd: 'closed in servd', none: 'no settlement channel (legacy / online)' }
function periodLine(q: SalesQuery): string {
  const base = `${fmtPktDate(q.from)} to ${fmtPktDate(q.to)}`
  // The settlement filter rides on every export's period line (till flow, 2026-10-20).
  return q.settlement && q.settlement !== 'all' ? `${base} — ${SETTLEMENT_LABEL[q.settlement]}` : base
}
/** The file-name suffix of an export: the dates, plus the settlement filter. */
function suffixOf(q: SalesQuery): string {
  const base = `${fmtPktDate(q.from)}-to-${fmtPktDate(q.to)}`
  return q.settlement && q.settlement !== 'all' ? `${base}-${q.settlement}` : base
}

export async function reportRoutes(fastify: FastifyInstance) {

  // The figures below come from ONE implementation each (./service.ts), shared
  // with the /management dashboards and the daily sales email: completed
  // orders, net of refunds, with `net` = the P&L's net revenue for them.
  // Dates are PKT business days (dateFrom / dateTo = YYYY-MM-DD).
  //
  // A brand or kitchen id from the client is resolved to its company first:
  // a foreign one is a 404, never silently an empty report.
  async function salesQuery(
    req: FastifyRequest,
    q: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string },
    defaultDays = 90,
  ): Promise<SalesQuery> {
    const { from, to } = reportDateRange(q.dateFrom, q.dateTo, defaultDays)
    // Till flow (2026-10-20): ?settlement=keenu|servd|none|all (default all = combined).
    const rawSettlement = (req.query as { settlement?: string }).settlement
    if (rawSettlement && !SETTLEMENTS.includes(rawSettlement as never)) throw new AppError('INVALID_SETTLEMENT', 'settlement must be keenu, servd, none or all', 400)
    const settlement = (rawSettlement || 'all') as SalesQuery['settlement']
    const company = await scopeTenantWhere(req, 'read')
    if (q.conceptId) await assertConceptOwned(req, q.conceptId, 'read')
    if (q.locationId) {
      const loc = await prisma.location.findFirst({ where: { id: q.locationId, ...company }, select: { id: true } })
      if (!loc) throw new NotFoundError('Location', q.locationId)
    }
    return {
      company,
      conceptId: q.conceptId || null,
      locationId: q.locationId || null,
      channel: q.channel || null,
      settlement,
      from, to,
    }
  }

  // GET /reports/sales — sales totals + by-hour (PKT) breakdown
  fastify.get<{
    Querystring: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string }
  }>('/sales', { preHandler: requireAuth(...REPORT_READERS) }, async (req, reply) => {
    const q = await salesQuery(req, req.query)
    const [totals, byHour] = await Promise.all([salesTotals(q), salesByHour(q)])
    const money = seesRevenue(req)
    const format = exportOf(req)
    if (format) {
      const rows: ReportRow[] = money
        ? [
            { metric: 'Sales incl. GST (completed orders, before refunds)', amountCents: totals.gross, orders: null },
            { metric: 'Discounts', amountCents: totals.discount, orders: null },
            { metric: 'Refunds (incl. GST)', amountCents: totals.refunds, orders: null },
            { metric: 'GST on these orders, less refunds', amountCents: totals.tax, orders: null },
            { metric: 'Tips', amountCents: totals.tips, orders: null },
            { metric: 'NET SALES EX-GST (P&L net revenue)', amountCents: totals.net, orders: null },
            { metric: 'Total orders', amountCents: null, orders: totals.orders },
          ]
        : [{ metric: 'Total orders', orders: totals.orders }]
      return sendReportFor(req, reply, format, { base: 'sales', suffix: suffixOf(q) }, {
        title: 'Sales', period: periodLine(q), rows, labels: { amountCents: 'Amount' }, types: { orders: 'number' },
      })
    }
    if (money) return { totals, byHour }
    // Volume only — the orders, and the orders by hour (see REPORT_READERS).
    return {
      volumeOnly: true,
      totals: { orders: totals.orders },
      byHour: Object.fromEntries(Object.entries(byHour).map(([h, b]) => [h, { orders: b.orders }])),
    }
  })

  // GET /reports/top-items — top-selling items by quantity in period
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/top-items',
    { preHandler: requireAuth(...REPORT_READERS) },
    async (req, reply) => {
      const asked = parseInt(req.query.limit ?? '20', 10)
      const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 20, 50)
      const sq = await salesQuery(req, req.query)
      const items = await topItems(sq, limit)
      const shown = seesItemRevenue(req) ? items : items.map(({ revenueCents: _revenue, ...rest }) => rest)
      const format = exportOf(req)
      if (format) {
        return sendReportFor(req, reply, format, { base: 'top-items', suffix: suffixOf(sq) }, {
          title: 'Top items', period: periodLine(sq),
          rows: shown.map((i): ReportRow => ({ rank: i.rank, item: i.name, quantity: i.quantity, ...('revenueCents' in i ? { revenueCents: (i as { revenueCents: number }).revenueCents } : {}) })),
          types: { rank: 'number', quantity: 'number' }, labels: { revenueCents: 'Revenue' },
        })
      }
      return shown
    },
  )

  // GET /reports/stations — avg ticket time by station
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/stations',
    { preHandler: requireAuth(...REPORT_READERS) },
    async (req, reply) => {
      const sq = await salesQuery(req, req.query)
      const stations = (await stationTimes(sq)).stations
      const format = exportOf(req)
      if (!format) return stations
      return sendReportFor(req, reply, format, { base: 'stations', suffix: suffixOf(sq) }, {
        title: 'Ticket times by station', period: periodLine(sq),
        rows: stations.map((st) => ({ station: st.stationName, itemsFired: st.items, avgMinutes: Number(st.avgMinutes.toFixed(1)) })),
        types: { itemsFired: 'number', avgMinutes: 'number' }, labels: { avgMinutes: 'Average minutes' },
      })
    },
  )

  // GET /reports/by-source — sales by order source
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/by-source',
    { preHandler: requireAuth(...REPORT_READERS) },
    async (req, reply) => {
      const sq = await salesQuery(req, req.query)
      const rows = await salesByChannel(sq)
      const money = seesRevenue(req)
      const format = exportOf(req)
      if (format) {
        return sendReportFor(req, reply, format, { base: 'by-channel', suffix: suffixOf(sq) }, {
          title: 'Sales by channel', period: periodLine(sq),
          rows: (money ? rows : [...rows].sort((a, b) => b.orders - a.orders)).map((r) => ({
            channel: r.source, orders: r.orders, ...(money ? { grossCents: r.gross, netCents: r.net } : {}),
          })),
          types: { orders: 'number', grossCents: 'cents', netCents: 'cents' }, labels: { grossCents: 'Gross (incl. GST)', netCents: 'Net (ex-GST)' },
        })
      }
      if (money) return rows
      return rows.map((r) => ({ source: r.source, orders: r.orders })).sort((a, b) => b.orders - a.orders)
    },
  )

  // GET /reports/by-settlement — sales per settlement channel (till flow, owner
  // 2026-10-20): keenu (pushed to Keenu), servd (closed in servd), none
  // (legacy / online), and combined = their sum. Money only to
  // FINANCIALS_VIEWERS; the other report readers get the order counts.
  fastify.get('/by-settlement', { preHandler: requireAuth(...REPORT_READERS) }, async (req, reply) => {
    const sq = await salesQuery(req, req.query as Record<string, string>)
    const r = await salesBySettlement({ ...sq, settlement: 'all' })
    const money = seesRevenue(req)
    const format = exportOf(req)
    if (format) {
      const all = [...r.rows.map((x) => ({ ...x, label: x.settlement })), { ...r.combined, label: 'combined' }]
      return sendReportFor(req, reply, format, { base: 'by-settlement', suffix: suffixOf({ ...sq, settlement: 'all' }) }, {
        title: 'Sales by settlement', period: periodLine({ ...sq, settlement: 'all' }),
        rows: all.map((x) => ({ settlement: x.label, orders: x.orders, ...(money ? { grossCents: x.gross, taxCents: x.tax, tipsCents: x.tips, netCents: x.net } : {}) })),
        types: { orders: 'number', grossCents: 'cents', taxCents: 'cents', tipsCents: 'cents', netCents: 'cents' },
        labels: { grossCents: 'Gross (incl. GST)', taxCents: 'GST', tipsCents: 'Tips', netCents: 'Net (ex-GST)' },
      })
    }
    if (money) return r
    return { volumeOnly: true, rows: r.rows.map((x) => ({ settlement: x.settlement, orders: x.orders })), combined: { orders: r.combined.orders } }
  })

  // GET /reports/by-tender — how the period's sales were paid (Raast QR, spec
  // §7.6): Cash, Card – Keenu, Raast QR (provisional / matched), the retired
  // Keenu QR's old rows, wallet, gift cards; comps apart; refunds by tender.
  // Same scope and dates as /sales. The money only to FINANCIALS_VIEWERS;
  // the other report readers get the order counts per tender.
  fastify.get<{ Querystring: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string } }>(
    '/by-tender',
    { preHandler: requireAuth(...REPORT_READERS) },
    async (req, reply) => {
      const sq = await salesQuery(req, req.query)
      const r = await salesByTender(sq)
      const format = exportOf(req)
      if (format) {
        const money = seesRevenue(req)
        return sendReportFor(req, reply, format, { base: 'by-tender', suffix: suffixOf(sq) }, {
          title: 'Sales by tender', period: periodLine(sq),
          rows: r.tenders.map((t) => ({ tender: t.label, orders: t.orders, ...(money ? { payments: t.payments, amountCents: t.amountCents, sharePct: t.sharePct } : {}) })),
          types: { orders: 'number', payments: 'number', amountCents: 'cents', sharePct: 'number' }, labels: { amountCents: 'Amount', sharePct: 'Share %' },
        })
      }
      if (seesRevenue(req)) return r
      return {
        volumeOnly: true,
        from: r.from,
        to: r.to,
        tenders: r.tenders.map((t) => ({ tender: t.tender, label: t.label, orders: t.orders })),
        comp: { orders: r.comp.orders },
      }
    },
  )

  // Both quadrant analysis + demand forecast take a REQUIRED conceptId and hand
  // it to a helper that doesn't re-check tenancy — so the id is resolved to
  // the caller's companies here (lib/tenantScope.ts), or any staff member
  // could pull another company's sales analytics by guessing a conceptId. A
  // MISSING id is a 400: `{ id: undefined }` would match any brand, and the
  // helpers would then read every company's orders.
  async function requiredConcept(req: FastifyRequest, conceptId: string | undefined): Promise<string> {
    if (!conceptId) throw new AppError('CONCEPT_REQUIRED', 'Pick a brand (conceptId)', 400)
    await assertConceptOwned(req, conceptId, 'read')
    return conceptId
  }

  // GET /reports/menu-engineering — Stars/Plowhorses/Puzzles/Dogs quadrant analysis.
  // Margin data. Its one page is Accounting → Sales quadrants, so finance (the
  // Finance workspace owner, which holds 'accounting') is let in; the manager
  // tiers keep what they had. Module gate: 'accounting' or 'reports'.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/menu-engineering',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req) => {
      const conceptId = await requiredConcept(req, req.query.conceptId)
      const { from, to } = reportDateRange(req.query.dateFrom, req.query.dateTo, 30)
      return getMenuEngineering({ conceptId, dateFrom: from, dateTo: to })
    },
  )

  // GET /reports/demand-forecast — rolling-average demand forecast for next N days
  fastify.get<{ Querystring: { conceptId?: string; days?: string } }>(
    '/demand-forecast',
    { preHandler: requireAuth(...REPORT_READERS) },
    async (req) => {
      const conceptId = await requiredConcept(req, req.query.conceptId)
      const dStr = req.query.days
      const days = dStr ? Math.min(parseInt(dStr, 10), 30) : 7
      const items = await getDemandForecast({ conceptId, days })
      return { items, conceptId, generatedAt: new Date().toISOString() }
    },
  )

  // GET /reports/delivery — own-fleet delivery speed from order timestamps.
  // avgMinutes = placedAt → (OTP-verified | completed). Segment-level transit
  // (accept→pickup→drop) needs the rider app's GPS stream — flagged below.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; targetMinutes?: string } }>(
    '/delivery',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = reportDateRange(dateFrom, dateTo, 90)
      if (conceptId) await assertConceptOwned(req, conceptId, 'read')
      const target = req.query.targetMinutes ? parseInt(req.query.targetMinutes, 10) : 45
      const orders = await prisma.order.findMany({
        where: {
          ...(conceptId && { conceptId }),
          concept: { ...(await scopeTenantWhere(req, 'read')), deletedAt: null },
          fulfilmentType: 'delivery',
          placedAt: { gte: from, lte: to },
          completedAt: { not: null },
        },
        select: { placedAt: true, completedAt: true, deliveryOtpVerifiedAt: true },
      })
      let total = 0, sumMin = 0, onTime = 0
      for (const o of orders) {
        const done = o.deliveryOtpVerifiedAt ?? o.completedAt
        if (!done) continue
        const min = (done.getTime() - o.placedAt.getTime()) / 60000
        if (min < 0 || min > 600) continue // drop corrupt / stale outliers
        total++; sumMin += min
        if (min <= target) onTime++
      }
      return {
        deliveries: total,
        avgMinutes: total ? Number((sumMin / total).toFixed(1)) : null,
        onTimePct:  total ? Number(((onTime / total) * 100).toFixed(1)) : null,
        targetMinutes: target,
        gpsDepthAvailable: false,
      }
    },
  )
}
