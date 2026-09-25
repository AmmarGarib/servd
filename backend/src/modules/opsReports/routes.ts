// Operational efficiency reports — read-only endpoints that surface things a
// manager would otherwise have to compute by hand:
//   - prep-list:    per-station prep checklist for tomorrow (from forecast)
//   - anomalies:    ticket-time spikes, comp/void patterns, supplier price drift
//
// The end-of-shift summary is the Z-report (GET /pos/shifts/:id/zreport) —
// the old /ops/shift-digest had no caller, took gross from Order.shiftId
// rather than the tenders the drawer reconciles against, and counted the
// whole company's voids and complaints as the shift's. The scheduled
// 'shift_summary' email sends the Z-report.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { getDemandForecast } from '../reports/demand-forecast.js'

export async function opsReportRoutes(fastify: FastifyInstance) {

  // ─── /ops/prep-list ────────────────────────────────────────────────────────
  // Tomorrow's prep checklist per station, derived from demand forecast +
  // recipe ingredients. Output groups required ingredient quantities by station
  // so each cook gets a focused list at end-of-shift.
  fastify.get<{ Querystring: { conceptId: string; days?: string } }>(
    '/prep-list',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { conceptId } = req.query
      const days = Math.min(parseInt(req.query.days ?? '1', 10), 7)

      // Tenant scope: requested concept must belong to the active tenant.
      const concept = await prisma.concept.findFirst({
        where: { id: conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })

      const forecast = await getDemandForecast({ conceptId, days })

      // Map menuItemId → forecast quantity for the requested window
      const forecastQty = new Map<string, { name: string; qty: number; confidence: string }>()
      for (const item of forecast) {
        const total = item.forecasts.reduce((s, f) => s + f.predictedQty, 0)
        if (total > 0) {
          forecastQty.set(item.menuItemId, { name: item.name, qty: total, confidence: item.confidence })
        }
      }
      if (forecastQty.size === 0) {
        return { byStation: [], unmappedItems: [], generatedAt: new Date().toISOString() }
      }

      // Fetch recipes + station + current stock for each item we'll need
      const menuItemIds = Array.from(forecastQty.keys())
      // MenuItem has `stationId` but no `station` relation back, so we
      // separately fetch the stations referenced.
      const items = await prisma.menuItem.findMany({
        where: { id: { in: menuItemIds } },
        include: {
          recipe: {
            include: {
              ingredients: {
                include: {
                  inventoryItem: { select: { id: true, name: true, currentStock: true, unit: true, parLevel: true } },
                },
              },
            },
          },
        },
      })
      const stationIds = Array.from(new Set(items.map((i) => i.stationId).filter((x): x is string => !!x)))
      const stations = stationIds.length > 0
        ? await prisma.station.findMany({ where: { id: { in: stationIds } }, select: { id: true, name: true } })
        : []
      const stationMap = new Map(stations.map((s) => [s.id, s]))

      // Aggregate by station → ingredient id → required qty
      type StationLine = {
        ingredientId: string
        ingredientName: string
        unit: string
        requiredQty: number
        currentStock: number
        shortfall: number     // positive = need to prep / order more
      }
      const byStation = new Map<string, { stationId: string; stationName: string; lines: Map<string, StationLine>; itemNames: string[] }>()
      const unmapped: Array<{ menuItemId: string; name: string; qty: number; reason: string }> = []

      for (const item of items) {
        const fc = forecastQty.get(item.id)
        if (!fc) continue
        const station = item.stationId ? stationMap.get(item.stationId) : null
        const recipe  = item.recipe
        if (!station || !recipe) {
          unmapped.push({
            menuItemId: item.id, name: item.name, qty: fc.qty,
            reason: !station ? 'No station assigned' : 'No recipe configured',
          })
          continue
        }

        if (!byStation.has(station.id)) {
          byStation.set(station.id, { stationId: station.id, stationName: station.name, lines: new Map(), itemNames: [] })
        }
        const bucket = byStation.get(station.id)!
        bucket.itemNames.push(`${fc.qty}× ${item.name}`)

        // For each ingredient, compute total raw qty needed for the forecast volume
        const portionsNeeded = fc.qty
        const recipeServings = recipe.servings || 1
        for (const ing of recipe.ingredients) {
          const yp = ing.yieldPct > 0 ? ing.yieldPct : 1
          // ing.quantity is per-batch; per-portion = quantity / servings; raw purchase = / yieldPct
          const perPortion = ing.quantity / recipeServings
          const rawNeeded = (perPortion / yp) * portionsNeeded
          const inv = ing.inventoryItem
          if (!inv) continue
          const id = inv.id

          const existing = bucket.lines.get(id)
          if (existing) {
            existing.requiredQty += rawNeeded
            existing.shortfall = Math.max(0, existing.requiredQty - existing.currentStock)
          } else {
            bucket.lines.set(id, {
              ingredientId: id,
              ingredientName: inv.name,
              unit: inv.unit,
              requiredQty: rawNeeded,
              currentStock: inv.currentStock,
              shortfall: Math.max(0, rawNeeded - inv.currentStock),
            })
          }
        }
      }

      // Materialise the maps
      const out = Array.from(byStation.values()).map((s) => ({
        stationId:   s.stationId,
        stationName: s.stationName,
        forecastedItems: s.itemNames.sort(),
        lines: Array.from(s.lines.values())
          .map((l) => ({ ...l, requiredQty: round2(l.requiredQty), shortfall: round2(l.shortfall) }))
          .sort((a, b) => b.shortfall - a.shortfall || a.ingredientName.localeCompare(b.ingredientName)),
      })).sort((a, b) => a.stationName.localeCompare(b.stationName))

      return { byStation: out, unmappedItems: unmapped, generatedAt: new Date().toISOString() }
    },
  )

  // ─── /ops/anomalies ────────────────────────────────────────────────────────
  // Looks at the last 24 hours and flags things worth a manager's attention.
  fastify.get<{ Querystring: { conceptId?: string; hours?: string } }>(
    '/anomalies',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const hours = Math.min(parseInt(req.query.hours ?? '24', 10), 168)
      const since = new Date(Date.now() - hours * 3600_000)
      const baselineSince = new Date(Date.now() - (hours + 24 * 7) * 3600_000)
      const baselineUntil = since

      // Company scoping — every probe below is restricted to the concepts
      // visible to this request (and honours ?conceptId, which was previously
      // accepted but silently ignored).
      const tenantFilter = req.staffUser!.tenantFilter
      const scopedConcepts = await prisma.concept.findMany({
        where: { tenantId: tenantFilter, deletedAt: null },
        select: { id: true },
      })
      let conceptIds = scopedConcepts.map((c) => c.id)
      if (req.query.conceptId) {
        conceptIds = conceptIds.filter((id) => id === req.query.conceptId)
      }
      const orderScope = { order: { conceptId: { in: conceptIds } } }

      const flags: Array<{
        severity: 'low' | 'medium' | 'high'
        category: 'kitchen' | 'cash' | 'customer' | 'inventory'
        title: string
        detail: string
        actionUrl?: string
      }> = []

      // 1. Ticket-time spikes — average bumped→completed time vs baseline
      const recentItems = await prisma.orderItem.findMany({
        where: {
          ...orderScope,
          firedAt:    { not: null, gte: since },
          completedAt:{ not: null },
          status:     'bumped',
        },
        select: { firedAt: true, completedAt: true },
        take: 1000,
      })
      const baselineItems = await prisma.orderItem.findMany({
        where: {
          ...orderScope,
          firedAt:    { not: null, gte: baselineSince, lt: baselineUntil },
          completedAt:{ not: null },
          status:     'bumped',
        },
        select: { firedAt: true, completedAt: true },
        take: 1000,
      })
      const avg = (items: typeof recentItems) =>
        items.length === 0 ? 0
          : items.reduce((s, i) => s + (i.completedAt!.getTime() - i.firedAt!.getTime()), 0) / items.length / 60_000

      const recentAvg = avg(recentItems)
      const baseAvg = avg(baselineItems)
      if (recentAvg > 0 && baseAvg > 0 && recentAvg > baseAvg * 1.3) {
        flags.push({
          severity: recentAvg > baseAvg * 1.6 ? 'high' : 'medium',
          category: 'kitchen',
          title: 'Ticket times running long',
          detail: `Avg ${recentAvg.toFixed(1)} min vs ${baseAvg.toFixed(1)} min baseline (${Math.round((recentAvg / baseAvg - 1) * 100)}% slower).`,
          actionUrl: '/reports',
        })
      }

      // 2. Void / comp rate spike
      const recentVoids = await prisma.orderItem.count({ where: { ...orderScope, status: 'voided', updatedAt: { gte: since } } })
      const recentItemsTotal = await prisma.orderItem.count({ where: { ...orderScope, createdAt: { gte: since } } })
      const voidRate = recentItemsTotal > 0 ? recentVoids / recentItemsTotal : 0
      if (voidRate > 0.05) {
        flags.push({
          severity: voidRate > 0.1 ? 'high' : 'medium',
          category: 'cash',
          title: 'Void rate elevated',
          detail: `${recentVoids} voided items out of ${recentItemsTotal} (${Math.round(voidRate * 100)}%). Investigate who's voiding and why.`,
          actionUrl: '/configuration/audit-log',
        })
      }

      // 3. Complaint cluster — same category 3+ times in window
      const complaints = await prisma.orderComplaint.findMany({
        where: { conceptId: { in: conceptIds }, createdAt: { gte: since } },
        select: { category: true },
      })
      const byCategory: Record<string, number> = {}
      for (const c of complaints) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1
      for (const [cat, count] of Object.entries(byCategory)) {
        if (count >= 3) {
          flags.push({
            severity: count >= 5 ? 'high' : 'medium',
            category: 'customer',
            title: `${count} '${cat}' complaints`,
            detail: `Customers are flagging the same problem repeatedly. Worth a kitchen huddle.`,
            actionUrl: '/complaints',
          })
        }
      }

      // 4. Inventory items at or below par level (company's own + shared items)
      const lowStock = await prisma.inventoryItem.findMany({
        where: {
          deletedAt: null,
          currentStock: { lte: prisma.inventoryItem.fields.parLevel },
          OR: [{ tenantId: tenantFilter }, { tenantId: null }],
        },
        select: { id: true, name: true, currentStock: true, parLevel: true, unit: true },
        take: 20,
      })
      if (lowStock.length > 0) {
        flags.push({
          severity: lowStock.some((i) => i.currentStock <= 0) ? 'high' : 'medium',
          category: 'inventory',
          title: `${lowStock.length} ingredient${lowStock.length === 1 ? '' : 's'} below par`,
          detail: lowStock.slice(0, 3).map((i) => `${i.name} (${i.currentStock}${i.unit})`).join(', ') + (lowStock.length > 3 ? '…' : ''),
          actionUrl: '/inventory/alerts',
        })
      }

      return {
        windowHours: hours,
        generatedAt: new Date().toISOString(),
        flags: flags.sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
      }
    },
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function severityRank(s: 'low' | 'medium' | 'high'): number {
  return s === 'high' ? 3 : s === 'medium' ? 2 : 1
}
