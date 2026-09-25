import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { getMenuEngineering } from './menu-engineering.js'
import { getDemandForecast } from './demand-forecast.js'
import { salesTotals, salesByHour, salesByChannel, topItems, stationTimes, type SalesQuery } from './service.js'

function dateRange(dateFrom?: string, dateTo?: string, defaultDays = 90) {
  const defaultFrom = new Date(Date.now() - defaultDays * 86_400_000)
  return {
    from: dateFrom ? new Date(dateFrom) : defaultFrom,
    to: dateTo ? new Date(dateTo) : new Date(),
  }
}

export async function reportRoutes(fastify: FastifyInstance) {

  // The figures below come from ONE implementation each (./service.ts), shared
  // with the /management dashboards and the daily sales email. They are
  // sales-register figures (what customers paid, incl. GST) — the books'
  // revenue is the ledger P&L (/accounting/pl-ledger).
  async function salesQuery(
    req: FastifyRequest,
    q: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string },
  ): Promise<SalesQuery> {
    const { from, to } = dateRange(q.dateFrom, q.dateTo)
    return {
      company: await scopeTenantWhere(req, 'read'),
      conceptId: q.conceptId ?? null,
      locationId: q.locationId ?? null,
      channel: q.channel ?? null,
      from, to,
    }
  }

  // GET /reports/sales — register totals + by-hour (PKT) breakdown
  fastify.get<{
    Querystring: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string }
  }>('/sales', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = await salesQuery(req, req.query)
    const [totals, byHour] = await Promise.all([salesTotals(q), salesByHour(q)])
    return { totals, byHour }
  })

  // GET /reports/top-items — top-selling items by quantity in period
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/top-items',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 50)
      return topItems(await salesQuery(req, req.query), limit)
    },
  )

  // GET /reports/stations — avg ticket time by station
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/stations',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => (await stationTimes(await salesQuery(req, req.query))).stations,
  )

  // GET /reports/by-source — register sales by order source
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/by-source',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => salesByChannel(await salesQuery(req, req.query)),
  )

  // Both quadrant analysis + demand forecast take a REQUIRED conceptId and hand
  // it to a helper that doesn't re-check tenancy — so the id must be validated
  // against the caller's tenant scope here, or any staff member could pull
  // another company's sales analytics by guessing a conceptId.
  async function assertConceptInScope(
    req: { staffUser?: { tenantFilter: string | { in: string[] } | null } | null },
    conceptId: string,
  ) {
    const concept = await prisma.concept.findFirst({
      where: { id: conceptId, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
      select: { id: true },
    })
    if (!concept) throw new NotFoundError('Concept', conceptId)
  }

  // GET /reports/menu-engineering — Stars/Plowhorses/Puzzles/Dogs quadrant analysis
  fastify.get<{ Querystring: { conceptId: string; dateFrom?: string; dateTo?: string } }>(
    '/menu-engineering',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      await assertConceptInScope(req, conceptId)
      const { from, to } = dateRange(dateFrom, dateTo, 30)
      return getMenuEngineering({ conceptId, dateFrom: from, dateTo: to })
    },
  )

  // GET /reports/demand-forecast — rolling-average demand forecast for next N days
  fastify.get<{ Querystring: { conceptId: string; days?: string } }>(
    '/demand-forecast',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, days: dStr } = req.query
      await assertConceptInScope(req, conceptId)
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
      const { from, to } = dateRange(dateFrom, dateTo)
      const target = req.query.targetMinutes ? parseInt(req.query.targetMinutes, 10) : 45
      const orders = await prisma.order.findMany({
        where: {
          ...(conceptId && { conceptId }),
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
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
