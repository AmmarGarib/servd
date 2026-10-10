import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned } from '../../lib/tenantScope.js'
import { getMenuEngineering } from './menu-engineering.js'
import { getDemandForecast } from './demand-forecast.js'
import { salesTotals, salesByHour, salesByChannel, topItems, stationTimes, reportDateRange, type SalesQuery } from './service.js'

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
      from, to,
    }
  }

  // GET /reports/sales — sales totals + by-hour (PKT) breakdown
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
      const asked = parseInt(req.query.limit ?? '20', 10)
      const limit = Math.min(Number.isFinite(asked) && asked > 0 ? asked : 20, 50)
      return topItems(await salesQuery(req, req.query), limit)
    },
  )

  // GET /reports/stations — avg ticket time by station
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/stations',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => (await stationTimes(await salesQuery(req, req.query))).stations,
  )

  // GET /reports/by-source — sales by order source
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/by-source',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => salesByChannel(await salesQuery(req, req.query)),
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

  // GET /reports/menu-engineering — Stars/Plowhorses/Puzzles/Dogs quadrant analysis
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/menu-engineering',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const conceptId = await requiredConcept(req, req.query.conceptId)
      const { from, to } = reportDateRange(req.query.dateFrom, req.query.dateTo, 30)
      return getMenuEngineering({ conceptId, dateFrom: from, dateTo: to })
    },
  )

  // GET /reports/demand-forecast — rolling-average demand forecast for next N days
  fastify.get<{ Querystring: { conceptId?: string; days?: string } }>(
    '/demand-forecast',
    { preHandler: requireAuth(...MANAGERS) },
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
