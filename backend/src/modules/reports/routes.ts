import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
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
  }>('/sales', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { conceptId, locationId, channel, dateFrom, dateTo } = req.query
    const { from, to } = dateRange(dateFrom, dateTo)

    const entries = await prisma.financialEntry.findMany({
      where: {
        ...(conceptId && { conceptId }),
        ...(locationId && { locationId }),
        ...(channel && { channel }),
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

      const rows = await prisma.orderItem.groupBy({
        by: ['menuItemId', 'name'],
        _sum: { quantity: true, unitPriceCents: true },
        where: {
          status: { not: 'voided' },
          menuItemId: { not: null },
          order: {
            status: 'completed',
            ...(conceptId && { conceptId }),
            placedAt: { gte: from, lte: to },
          },
        },
        orderBy: { _sum: { quantity: 'desc' } },
        take: limit,
      })

      return rows.map((r, i) => ({
        rank: i + 1,
        menuItemId: r.menuItemId,
        name: r.name,
        quantity: r._sum.quantity ?? 0,
        revenueCents: (r._sum.unitPriceCents ?? 0) * (r._sum.quantity ?? 0),
      }))
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
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const { from, to } = dateRange(dateFrom, dateTo)

      const entries = await prisma.financialEntry.findMany({
        where: {
          ...(conceptId && { conceptId }),
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
          order: { ...(conceptId && { conceptId }), placedAt: { gte: from, lte: to } },
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

  // GET /reports/menu-engineering — Stars/Plowhorses/Puzzles/Dogs quadrant analysis
  fastify.get<{ Querystring: { conceptId: string; dateFrom?: string; dateTo?: string } }>(
    '/menu-engineering',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
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
      const days = dStr ? Math.min(parseInt(dStr, 10), 30) : 7
      const items = await getDemandForecast({ conceptId, days })
      return { items, conceptId, generatedAt: new Date().toISOString() }
    },
  )
}
