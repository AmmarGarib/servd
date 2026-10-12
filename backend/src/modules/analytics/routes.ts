import type { FastifyInstance } from 'fastify'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { conceptWhere } from '../../lib/tenantScope.js'

interface IncomingEvent {
  event: string
  properties?: Record<string, unknown>
  url?: string
  referrer?: string
}

const VALID_EVENTS = new Set([
  'page_view', 'concept_view', 'item_view', 'item_added', 'item_removed',
  'cart_viewed', 'checkout_started', 'checkout_step', 'checkout_abandoned',
  'order_placed', 'search', 'filter_applied', 'concept_switched',
  'promo_applied', 'promo_failed',
])

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding analytics (Analytics page). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('analytics')]

// Access (wave 3, UI-06): the Analytics page is the Marketing workspace's
// (module analytics), so the reads are MARKETING_TEAM — MANAGERS plus
// marketing and brand_manager — scoped to brands in view (conceptWhere).
export async function analyticsRoutes(fastify: FastifyInstance) {
  // POST /analytics/events — ingest batched storefront events
  // Public (no auth) but rate-limited. Fire-and-forget: always returns 204.
  fastify.post(
    '/events',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = req.body as {
        sessionId?: string
        customerId?: string
        conceptId?: string
        events?: IncomingEvent[]
      }

      const sessionId = (body.sessionId ?? '').slice(0, 128)
      const customerId = body.customerId ?? null
      const baseConceptId = body.conceptId ?? null
      const events = (body.events ?? []).slice(0, 50)

      if (!sessionId || events.length === 0) {
        return reply.status(204).send()
      }

      // Fire-and-forget — never let analytics block the response
      setImmediate(async () => {
        try {
          const rows = events
            .filter((e) => VALID_EVENTS.has(e.event))
            .map((e): Prisma.AnalyticsEventCreateManyInput => ({
              sessionId,
              customerId: customerId ?? undefined,
              conceptId: ((e.properties?.conceptId as string | undefined) ?? baseConceptId) ?? undefined,
              event: e.event as Prisma.AnalyticsEventCreateManyInput['event'],
              properties: e.properties ? (e.properties as Prisma.InputJsonValue) : undefined,
              url: e.url?.slice(0, 2048),
              referrer: e.referrer?.slice(0, 2048),
            }))
          if (rows.length) await prisma.analyticsEvent.createMany({ data: rows })
        } catch { /* never block on analytics failures */ }
      })

      return reply.status(204).send()
    },
  )

  // GET /analytics/funnel?conceptId&dateFrom&dateTo
  fastify.get<{
    Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string }
  }>('/funnel', { preHandler: marketingGuard }, async (req) => {
    const { conceptId, dateFrom, dateTo } = req.query
    const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 864e5)
    const to = dateTo ? new Date(dateTo) : new Date()

    const FUNNEL_STEPS = [
      'concept_view', 'item_view', 'item_added',
      'checkout_started', 'checkout_abandoned', 'order_placed',
    ] as const

    type FunnelEvent = (typeof FUNNEL_STEPS)[number]

    const counts = await prisma.analyticsEvent.groupBy({
      by: ['event'],
      where: {
        event: { in: [...FUNNEL_STEPS] as FunnelEvent[] },
        createdAt: { gte: from, lte: to },
        // Company scope: only events at brands in view; a foreign conceptId 404s.
        ...(await conceptWhere(req, conceptId, 'read')),
      },
      _count: { event: true },
    })

    const countMap = Object.fromEntries(counts.map((r) => [r.event, r._count.event]))
    const steps = FUNNEL_STEPS.map((step, i) => {
      const count = countMap[step] ?? 0
      const prevStep = i > 0 ? FUNNEL_STEPS[i - 1] : null
      const prev = prevStep ? (countMap[prevStep] ?? 0) : count
      return {
        event: step,
        count,
        conversionRate: prev > 0 ? Math.round((count / prev) * 100) : null,
      }
    })

    return { from: from.toISOString(), to: to.toISOString(), steps }
  })

  // GET /analytics/items?conceptId&dateFrom&dateTo&limit
  // Items ranked by views with add-to-cart conversion rate.
  fastify.get<{
    Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; limit?: string }
  }>('/items', { preHandler: marketingGuard }, async (req) => {
    const { conceptId, dateFrom, dateTo, limit } = req.query
    const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 864e5)
    const to = dateTo ? new Date(dateTo) : new Date()
    const n = Math.min(parseInt(limit ?? '20', 10), 100)

    // Company scope: brands in view only (empty scope = no rows); a foreign
    // conceptId 404s rather than silently widening to every brand.
    const scope = await conceptWhere(req, conceptId, 'read')
    const effectiveConceptIds = typeof scope.conceptId === 'string' ? [scope.conceptId] : scope.conceptId.in
    if (effectiveConceptIds.length === 0) return []

    type Row = { itemId: string; name: string; views: bigint; adds: bigint }
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        properties->>'itemId'   AS "itemId",
        properties->>'name'     AS "name",
        COUNT(*) FILTER (WHERE event = 'item_view')  AS views,
        COUNT(*) FILTER (WHERE event = 'item_added') AS adds
      FROM analytics_events
      WHERE event IN ('item_view', 'item_added')
        AND "createdAt" BETWEEN ${from} AND ${to}
        AND "conceptId" IN (${Prisma.join(effectiveConceptIds)})
      GROUP BY properties->>'itemId', properties->>'name'
      ORDER BY views DESC
      LIMIT ${n}
    `

    return rows.map((r) => ({
      itemId: r.itemId,
      name: r.name,
      views: Number(r.views),
      adds: Number(r.adds),
      addRate: Number(r.views) > 0 ? Math.round((Number(r.adds) / Number(r.views)) * 100) : 0,
    }))
  })

  // GET /analytics/search?conceptId&dateFrom&dateTo&limit
  // Top search queries with no-result rate.
  fastify.get<{
    Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; limit?: string }
  }>('/search', { preHandler: marketingGuard }, async (req) => {
    const { conceptId, dateFrom, dateTo, limit } = req.query
    const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 864e5)
    const to = dateTo ? new Date(dateTo) : new Date()
    const n = Math.min(parseInt(limit ?? '20', 10), 100)

    // Company scope: brands in view only (empty scope = no rows); a foreign
    // conceptId 404s rather than silently widening to every brand.
    const scope = await conceptWhere(req, conceptId, 'read')
    const effectiveConceptIds = typeof scope.conceptId === 'string' ? [scope.conceptId] : scope.conceptId.in
    if (effectiveConceptIds.length === 0) return []

    type Row = { query: string; count: bigint; noResults: bigint }
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT
        properties->>'query'                                               AS query,
        COUNT(*)                                                           AS count,
        COUNT(*) FILTER (WHERE (properties->>'resultCount')::int = 0)     AS "noResults"
      FROM analytics_events
      WHERE event = 'search'
        AND "createdAt" BETWEEN ${from} AND ${to}
        AND "conceptId" IN (${Prisma.join(effectiveConceptIds)})
        AND properties->>'query' IS NOT NULL
        AND length(properties->>'query') > 0
      GROUP BY properties->>'query'
      ORDER BY count DESC
      LIMIT ${n}
    `

    return rows.map((r) => ({
      query: r.query,
      count: Number(r.count),
      noResults: Number(r.noResults),
      noResultRate: Number(r.count) > 0 ? Math.round((Number(r.noResults) / Number(r.count)) * 100) : 0,
    }))
  })

  // GET /analytics/overview?conceptId&dateFrom&dateTo — summary numbers
  fastify.get<{
    Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string }
  }>('/overview', { preHandler: marketingGuard }, async (req) => {
    const { conceptId, dateFrom, dateTo } = req.query
    const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 864e5)
    const to = dateTo ? new Date(dateTo) : new Date()

    // Company scope: brands in view only; a foreign conceptId 404s.
    const scope = await conceptWhere(req, conceptId, 'read')
    const [sessions, events] = await Promise.all([
      prisma.analyticsEvent.groupBy({
        by: ['sessionId'],
        where: {
          createdAt: { gte: from, lte: to },
          ...scope,
        },
        _count: { sessionId: true },
      }),
      prisma.analyticsEvent.groupBy({
        by: ['event'],
        where: {
          createdAt: { gte: from, lte: to },
          ...scope,
        },
        _count: { event: true },
      }),
    ])

    const eventMap = Object.fromEntries(events.map((e) => [e.event, e._count.event]))
    const orders = eventMap['order_placed'] ?? 0
    const checkouts = eventMap['checkout_started'] ?? 0

    return {
      totalSessions: sessions.length,
      totalEvents: events.reduce((s, e) => s + e._count.event, 0),
      checkoutStarted: checkouts,
      ordersPlaced: orders,
      checkoutConversion: checkouts > 0 ? Math.round((orders / checkouts) * 100) : 0,
      topEvents: events
        .sort((a, b) => b._count.event - a._count.event)
        .slice(0, 8)
        .map((e) => ({ event: e.event, count: e._count.event })),
    }
  })
}
