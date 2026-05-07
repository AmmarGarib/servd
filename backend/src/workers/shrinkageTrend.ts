// Shrinkage-trend detector — chronic per-item shrinkage over a rolling window.
// Runs nightly. Single-count variances already fire `shrinkage` flags; this
// catches the slow-drip kind: an item that shows -1% every week eventually
// adds up to a real loss, and that pattern is invisible at the single-count
// level. We compute average variance over the configured window (4 weeks
// default) and flag anything trending below -1.5%.

import cron from 'node-cron'
import { prisma } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'
import { getOperationsConfig } from '../lib/setup-config.js'

const TREND_THRESHOLD_PCT = -0.015        // -1.5% rolling average = chronic shrinkage

export function startShrinkageTrendWorker(): void {
  // 02:00 nightly. Off-peak so it doesn't compete with order traffic.
  cron.schedule('0 2 * * *', () => { void runOnce().catch((err) => console.warn('[shrinkage-trend]', (err as Error).message)) })
  console.log('[shrinkageTrend] worker scheduled — nightly at 02:00')
}

export async function runOnce(): Promise<{ checked: number; flagged: number }> {
  const ops = await getOperationsConfig()
  const weeks = ops?.shrinkage_trend_weeks ?? 4
  const since = new Date(); since.setDate(since.getDate() - weeks * 7)

  // Pull all physical-count lines in the window
  const lines = await prisma.physicalCountLine.findMany({
    where: { count: { countedAt: { gte: since } } },
    select: { inventoryItemId: true, variancePct: true, systemQty: true, physicalQty: true },
  })

  // Aggregate per item
  const agg = new Map<string, { sum: number; n: number; lossQty: number }>()
  for (const l of lines) {
    if (l.variancePct == null) continue
    const cur = agg.get(l.inventoryItemId) ?? { sum: 0, n: 0, lossQty: 0 }
    cur.sum += l.variancePct
    cur.n += 1
    if (l.physicalQty < l.systemQty) cur.lossQty += (l.systemQty - l.physicalQty)
    agg.set(l.inventoryItemId, cur)
  }

  let flagged = 0
  for (const [itemId, a] of agg.entries()) {
    if (a.n < 2) continue              // need at least two counts to call it a trend
    const avg = a.sum / a.n
    if (avg >= TREND_THRESHOLD_PCT) continue

    const item = await prisma.inventoryItem.findUnique({
      where: { id: itemId },
      select: { name: true, unit: true, unitCostCents: true },
    })
    if (!item) continue

    const lossValueCents = item.unitCostCents != null ? Math.round(item.unitCostCents * a.lossQty) : null

    // Don't double-flag — only fire once per item per window if no open flag exists
    const existing = await prisma.exceptionFlag.findFirst({
      where: {
        kind: 'shrinkage_trend', status: 'open',
        entityType: 'InventoryItem', entityId: itemId,
        createdAt: { gte: since },
      },
      select: { id: true },
    })
    if (existing) continue

    await flagException({
      kind: 'shrinkage_trend',
      severity: avg < -0.05 ? 'high' : 'medium',
      title: `Chronic shrinkage: ${item.name}`,
      description: `${item.name} has averaged ${(avg * 100).toFixed(1)}% variance across ${a.n} counts in the last ${weeks} weeks. Cumulative loss: ${a.lossQty.toFixed(2)} ${item.unit}${lossValueCents != null ? ` (PKR ${(lossValueCents / 100).toFixed(0)})` : ''}.`,
      entityType: 'InventoryItem',
      entityId: itemId,
      amountCents: lossValueCents,
      metadata: { avgVariancePct: avg, countN: a.n, lossQty: a.lossQty, windowWeeks: weeks },
    })
    flagged++
  }

  console.log(`[shrinkageTrend] checked ${agg.size} items, flagged ${flagged}`)
  return { checked: agg.size, flagged }
}
