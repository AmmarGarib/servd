// Operational efficiency reports — read-only endpoints that surface things a
// manager would otherwise have to compute by hand:
//   - (the prep list moved to GET /kitchen/prep-list — modules/kitchen)
//   - anomalies:    ticket-time spikes, comp/void patterns, supplier price drift
//
// The end-of-shift summary is the Z-report (GET /pos/shifts/:id/zreport) —
// the old /ops/shift-digest had no caller, took gross from Order.shiftId
// rather than the tenders the drawer reconciles against, and counted the
// whole company's voids and complaints as the shift's. The scheduled
// 'shift_summary' email sends the Z-report.

import type { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { getDemandForecast } from '../reports/demand-forecast.js'
import { belowParWhere, explodeRecipe, loadRecipeGraph } from '../../lib/recipeCost.js'
import { assertConceptOwned, conceptIdsInScope, scopeTenantWhere } from '../../lib/tenantScope.js'

export async function opsReportRoutes(fastify: FastifyInstance) {

  // /ops/prep-list was REPLACED by the ONE prep list, GET /kitchen/prep-list (modules/kitchen/prepPlan.ts — kitchen
  // flow, owner 2026-10-26: one engine, per outlet, preps in portions). The admin's /ops/prep-list redirects there.

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
      let conceptIds = await conceptIdsInScope(req, 'read')
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
        where: { conceptId: { in: conceptIds }, kind: 'complaint', createdAt: { gte: since } },
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

      // 4. Inventory items below par — THE rule (lib/recipeCost.ts): a par
      // must be set (parLevel 0 = untracked catalogue item, which used to
      // flag whenever its stock was 0), scoped by the item's own company.
      const lowStock = await prisma.inventoryItem.findMany({
        where: {
          deletedAt: null,
          ...(await scopeTenantWhere(req, 'read')),
          ...belowParWhere(),
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
