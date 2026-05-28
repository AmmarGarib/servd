// Operational efficiency reports — read-only endpoints that surface things a
// manager would otherwise have to compute by hand:
//   - prep-list:    per-station prep checklist for tomorrow (from forecast)
//   - shift-digest: end-of-shift summary (orders, peaks, voids, complaints)
//   - anomalies:    ticket-time spikes, comp/void patterns, supplier price drift

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

  // ─── /ops/shift-digest/:shiftId ────────────────────────────────────────────
  // Auto-generated end-of-shift summary: orders, hourly peaks, complaints,
  // 86'd items, comps, voids, top sellers.
  fastify.get<{ Params: { shiftId: string } }>(
    '/shift-digest/:shiftId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // Tenant scope via user.tenantId — only show shifts owned by users
      // who belong to the active tenant.
      const shift = await prisma.shift.findFirst({
        where: {
          id: req.params.shiftId,
          user: { tenantId: req.staffUser!.tenantId },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      })
      if (!shift) return { error: 'Shift not found' }

      const from = shift.openedAt
      const to   = shift.closedAt ?? new Date()

      const [orders, payments, complaints, voids] = await Promise.all([
        prisma.order.findMany({
          where: { shiftId: shift.id },
          select: {
            id: true, status: true, totalCents: true, placedAt: true, source: true,
            items: { select: { name: true, quantity: true, status: true, unitPriceCents: true } },
          },
        }),
        prisma.payment.aggregate({
          where: { shiftId: shift.id, status: 'paid' },
          _sum: { amountCents: true }, _count: true,
        }),
        prisma.orderComplaint.count({
          where: { createdAt: { gte: from, lte: to } },
        }).catch(() => 0),
        prisma.orderItem.count({
          where: { status: 'voided', updatedAt: { gte: from, lte: to } },
        }),
      ])

      // Hourly distribution
      const byHour: Record<number, number> = {}
      for (const o of orders) {
        const h = o.placedAt.getHours()
        byHour[h] = (byHour[h] ?? 0) + 1
      }
      const peakHourEntry = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0]
      const peakHour = peakHourEntry ? { hour: parseInt(peakHourEntry[0]), orders: peakHourEntry[1] } : null

      // Top items
      const itemTally: Record<string, { name: string; qty: number; revenue: number }> = {}
      for (const o of orders) {
        for (const it of o.items) {
          if (!itemTally[it.name]) itemTally[it.name] = { name: it.name, qty: 0, revenue: 0 }
          itemTally[it.name]!.qty += it.quantity
          itemTally[it.name]!.revenue += it.quantity * it.unitPriceCents
        }
      }
      const topItems = Object.values(itemTally).sort((a, b) => b.qty - a.qty).slice(0, 5)

      const completed = orders.filter((o) => o.status === 'completed').length
      const cancelled = orders.filter((o) => o.status === 'cancelled' || o.status === 'refunded').length
      const grossCents = orders.filter((o) => o.status === 'completed').reduce((s, o) => s + o.totalCents, 0)

      return {
        shift: {
          id:        shift.id,
          user:      shift.user,
          openedAt:  shift.openedAt.toISOString(),
          closedAt:  shift.closedAt?.toISOString() ?? null,
          durationMin: Math.round((to.getTime() - from.getTime()) / 60_000),
          openingFloatCents: shift.openingFloatCents,
          closingFloatCents: shift.closingFloatCents,
        },
        orders: {
          total:     orders.length,
          completed,
          cancelled,
          grossCents,
        },
        payments: {
          collectedCents: payments._sum.amountCents ?? 0,
          paymentCount:   payments._count,
        },
        peakHour,
        topItems,
        flags: {
          complaints,
          voids,
          voidRate: orders.length > 0 ? Math.round((voids / orders.length) * 100) : 0,
        },
        narrative: buildShiftNarrative({
          orders: orders.length, completed, cancelled, grossCents,
          peakHour, voids, complaints, durationMin: Math.round((to.getTime() - from.getTime()) / 60_000),
        }),
      }
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
          firedAt:    { not: null, gte: since },
          completedAt:{ not: null },
          status:     'bumped',
        },
        select: { firedAt: true, completedAt: true },
        take: 1000,
      })
      const baselineItems = await prisma.orderItem.findMany({
        where: {
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
      const recentVoids = await prisma.orderItem.count({ where: { status: 'voided', updatedAt: { gte: since } } })
      const recentItemsTotal = await prisma.orderItem.count({ where: { createdAt: { gte: since } } })
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
        where: { createdAt: { gte: since } },
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

      // 4. Inventory items at or below par level
      const lowStock = await prisma.inventoryItem.findMany({
        where: { deletedAt: null, currentStock: { lte: prisma.inventoryItem.fields.parLevel } },
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

function buildShiftNarrative(args: {
  orders: number; completed: number; cancelled: number; grossCents: number
  peakHour: { hour: number; orders: number } | null; voids: number; complaints: number; durationMin: number
}): string {
  const lines: string[] = []
  if (args.orders === 0) {
    return 'Quiet shift — no orders recorded. Check that the shift was opened correctly and orders linked.'
  }
  const cancelRate = args.orders > 0 ? Math.round((args.cancelled / args.orders) * 100) : 0
  lines.push(`${args.completed} completed orders out of ${args.orders} placed (${100 - cancelRate}% completion).`)
  lines.push(`Gross PKR ${(args.grossCents / 100).toLocaleString()}, avg ticket PKR ${args.completed > 0 ? Math.round(args.grossCents / args.completed / 100).toLocaleString() : 0}.`)
  if (args.peakHour) {
    const h = args.peakHour.hour
    lines.push(`Peak hour: ${h}:00 (${args.peakHour.orders} orders).`)
  }
  if (args.voids > 0) lines.push(`⚠ ${args.voids} item${args.voids === 1 ? '' : 's'} voided — review with manager.`)
  if (args.complaints > 0) lines.push(`⚠ ${args.complaints} complaint${args.complaints === 1 ? '' : 's'} opened during this shift.`)
  if (args.cancelled > 0) lines.push(`${args.cancelled} cancellation${args.cancelled === 1 ? '' : 's'} — usually customer no-show or kitchen-side issue.`)
  return lines.join(' ')
}
