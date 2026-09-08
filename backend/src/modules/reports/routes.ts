import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { getMenuEngineering } from './menu-engineering.js'
import { getDemandForecast } from './demand-forecast.js'

function dateRange(dateFrom?: string, dateTo?: string, defaultDays = 90) {
  const defaultFrom = new Date(Date.now() - defaultDays * 86_400_000)
  return {
    from: dateFrom ? new Date(dateFrom) : defaultFrom,
    to: dateTo ? new Date(dateTo) : new Date(),
  }
}

export async function reportRoutes(fastify: FastifyInstance) {

  // GET /reports/sales — totals + by-hour breakdown
  fastify.get<{
    Querystring: { conceptId?: string; locationId?: string; channel?: string; dateFrom?: string; dateTo?: string }
  }>('/sales', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const { conceptId, locationId, channel, dateFrom, dateTo } = req.query
    const { from, to } = dateRange(dateFrom, dateTo)

    const entries = await prisma.financialEntry.findMany({
      where: {
        ...(conceptId && { conceptId }),
        ...(locationId && { locationId }),
        ...(channel && { channel }),
        concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        entryDate: { gte: from, lte: to },
      },
      select: { grossCents: true, netCents: true, commissionCents: true, taxCents: true, entryDate: true, channel: true },
    })

    // Hourly breakdown (for chart) — only meaningful for same-day view
    const byHour: Record<string, { orders: number; gross: number }> = {}
    for (const e of entries) {
      const h = String(e.entryDate.getHours())
      if (!byHour[h]) byHour[h] = { orders: 0, gross: 0 }
      byHour[h]!.orders += 1
      byHour[h]!.gross += e.grossCents
    }

    return {
      totals: {
        gross: entries.reduce((s, e) => s + e.grossCents, 0),
        commission: entries.reduce((s, e) => s + e.commissionCents, 0),
        tax: entries.reduce((s, e) => s + e.taxCents, 0),
        net: entries.reduce((s, e) => s + e.netCents, 0),
        orders: entries.length,
      },
      byHour,
    }
  })

  // GET /reports/top-items — top-selling items by quantity in period
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/top-items',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo, limit: lStr } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)
      const limit = Math.min(parseInt(lStr ?? '20', 10), 50)

      // Group by price point as well as item. Revenue is Σ(price × qty) per
      // price point; the old query multiplied the SUM of unit prices by the SUM
      // of quantities, so three PKR 500 sales reported PKR 4,500 instead of
      // PKR 1,500 (and worse the more rows an item had).
      const rows = await prisma.orderItem.groupBy({
        by: ['menuItemId', 'name', 'unitPriceCents'],
        _sum: { quantity: true },
        where: {
          status: { not: 'voided' },
          menuItemId: { not: null },
          order: {
            status: 'completed',
            ...(conceptId && { conceptId }),
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
            placedAt: { gte: from, lte: to },
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
    },
  )

  // GET /reports/stations — avg ticket time by station
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/stations',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      const items = await prisma.orderItem.findMany({
        where: {
          firedAt: { not: null },
          completedAt: { not: null },
          status: 'bumped',
          order: {
            ...(conceptId && { conceptId }),
            concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
            placedAt: { gte: from, lte: to },
          },
        },
        select: { firedAt: true, completedAt: true, stationId: true, station: { select: { name: true } } },
      })

      const map: Record<string, { stationId: string; stationName: string; totalMs: number; items: number }> = {}
      for (const item of items) {
        if (!item.firedAt || !item.completedAt) continue
        const ms = item.completedAt.getTime() - item.firedAt.getTime()
        const key = item.stationId ?? 'unknown'
        if (!map[key]) map[key] = { stationId: key, stationName: item.station?.name ?? 'Unknown', totalMs: 0, items: 0 }
        map[key]!.items += 1
        map[key]!.totalMs += ms
      }

      return Object.values(map).map((s) => ({
        stationId: s.stationId,
        stationName: s.stationName,
        items: s.items,
        avgMinutes: s.items > 0 ? parseFloat((s.totalMs / s.items / 60_000).toFixed(1)) : 0,
      }))
    },
  )

  // GET /reports/by-source — sales breakdown by order source
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/by-source',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      const entries = await prisma.financialEntry.findMany({
        where: {
          ...(conceptId && { conceptId }),
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          entryDate: { gte: from, lte: to },
        },
        select: { channel: true, grossCents: true, netCents: true },
      })

      const map: Record<string, { source: string; orders: number; gross: number; net: number }> = {}
      for (const e of entries) {
        if (!map[e.channel]) map[e.channel] = { source: e.channel, orders: 0, gross: 0, net: 0 }
        map[e.channel]!.orders += 1
        map[e.channel]!.gross += e.grossCents
        map[e.channel]!.net += e.netCents
      }

      return Object.values(map).sort((a, b) => b.gross - a.gross)
    },
  )

  // GET /reports/ticket-times — kept for backwards compatibility (alias of /stations)
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/ticket-times',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      const items = await prisma.orderItem.findMany({
        where: {
          firedAt: { not: null }, completedAt: { not: null }, status: 'bumped',
          order: { ...(conceptId && { conceptId }), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, placedAt: { gte: from, lte: to } },
        },
        select: { firedAt: true, completedAt: true, stationId: true, station: { select: { name: true } } },
      })

      const map: Record<string, { stationId: string; station: { name: string }; totalMs: number; count: number }> = {}
      for (const item of items) {
        if (!item.firedAt || !item.completedAt) continue
        const ms = item.completedAt.getTime() - item.firedAt.getTime()
        const key = item.stationId ?? 'unknown'
        if (!map[key]) map[key] = { stationId: key, station: { name: item.station?.name ?? 'Unknown' }, totalMs: 0, count: 0 }
        map[key]!.count += 1
        map[key]!.totalMs += ms
      }

      return { byStation: Object.values(map).map((s) => ({ ...s, avgMinutes: s.count > 0 ? s.totalMs / s.count / 60_000 : 0 })) }
    },
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

  // GET /reports/series — daily revenue/orders buckets (powers sparklines).
  // Gap-fills missing days with zeros so the trend line is continuous.
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/series',
    { preHandler: requireAuth(...FINANCIALS_VIEWERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo, 30)
      const entries = await prisma.financialEntry.findMany({
        where: { ...(conceptId && { conceptId }), concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null }, entryDate: { gte: from, lte: to } },
        select: { entryDate: true, grossCents: true, netCents: true },
      })
      const buckets = new Map<string, { date: string; gross: number; net: number; orders: number }>()
      for (const e of entries) {
        const d = e.entryDate.toISOString().slice(0, 10)
        const b = buckets.get(d) ?? { date: d, gross: 0, net: 0, orders: 0 }
        b.gross += e.grossCents; b.net += e.netCents; b.orders += 1
        buckets.set(d, b)
      }
      const series: Array<{ date: string; gross: number; net: number; orders: number }> = []
      const cur = new Date(from); cur.setUTCHours(0, 0, 0, 0)
      const end = new Date(to); end.setUTCHours(0, 0, 0, 0)
      let guard = 0
      while (cur <= end && guard++ < 400) {
        const key = cur.toISOString().slice(0, 10)
        series.push(buckets.get(key) ?? { date: key, gross: 0, net: 0, orders: 0 })
        cur.setUTCDate(cur.getUTCDate() + 1)
      }
      return { series }
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
