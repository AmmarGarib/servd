// Shrinkage-trend detector — chronic per-item shrinkage over a rolling window.
// Runs nightly. Single-count variances already fire `shrinkage` flags; this
// catches the slow-drip kind: an item that shows -1% every week eventually
// adds up to a real loss, and that pattern is invisible at the single-count
// level. We compute average variance over the configured window (4 weeks
// default) and flag anything trending below -1.5%. A count that found stock
// on a zero book ('stock_unrecorded', variancePct null) has no % and is left
// out of the average.
//
// The same nightly run raises 'stock_shortfall' (finance wave B, FIFO lots):
// per item, the quantity its sales of the last 7 days took beyond what the
// lots held (the sale movements' shortfallQty) that no later delivery has
// settled yet ('shortfall_settle') — stock sold from nothing on the books,
// costed at a memo value. One open flag per item.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { flagException, kindsMatching } from '../lib/exceptions.js'
import { getOperationsConfig } from '../lib/setup-config.js'
import { SHORTFALL_SETTLE_DAYS, STOCK_EPS } from '../lib/stockLedger.js'
import { toCents } from '../lib/money.js'

const TREND_THRESHOLD_PCT = -0.015        // -1.5% rolling average = chronic shrinkage
const DAY_MS = 86_400_000

export function startShrinkageTrendWorker(): void {
  // 02:00 nightly. Off-peak so it doesn't compete with order traffic.
  cron.schedule('0 2 * * *', () => { void runOnce().catch((err) => console.warn('[shrinkage-trend]', (err as Error).message)) })
  console.log('[shrinkageTrend] worker scheduled — nightly at 02:00')
}

export async function runOnce(): Promise<{ checked: number; flagged: number; shortfallFlagged: number }> {
  // One sweep per company: each company's counts, judged over that company's
  // own trend window, flagged into that company's inbox. Counts and items
  // with no company are nobody's and are skipped.
  const tenants = await prisma.tenant.findMany({ where: { deletedAt: null, kind: 'company' }, select: { id: true } })
  let checked = 0
  let flagged = 0
  let shortfallFlagged = 0
  for (const t of tenants) {
    try {
      const r = await runForTenant(t.id)
      checked += r.checked
      flagged += r.flagged
      shortfallFlagged += (await flagStockShortfalls(t.id)).flagged
    } catch (err) {
      console.warn(`[shrinkageTrend] company ${t.id}:`, (err as Error).message)
    }
  }
  console.log(`[shrinkageTrend] ${tenants.length} companies: checked ${checked} items, flagged ${flagged}, stock shortfalls ${shortfallFlagged}`)
  return { checked, flagged, shortfallFlagged }
}

/**
 * One 'stock_shortfall' flag per item of the company whose sales of the last
 * SHORTFALL_SETTLE_DAYS (7) days took more than its lots held and are still
 * unsettled (Σ shortfallQty − what later deliveries settled). An item that
 * already has an open (or acknowledged) one is skipped.
 */
export async function flagStockShortfalls(tenantId: string, now: Date = new Date()): Promise<{ checked: number; flagged: number }> {
  const since = new Date(now.getTime() - SHORTFALL_SETTLE_DAYS * DAY_MS)
  const sales = await prisma.stockMovement.findMany({
    where: { tenantId, kind: 'sale', shortfallQty: { gt: STOCK_EPS }, occurredAt: { gte: since } },
    select: { id: true, inventoryItemId: true, shortfallQty: true, shortfallValueCents: true },
  })
  if (sales.length === 0) return { checked: 0, flagged: 0 }
  const settles = await prisma.stockMovement.groupBy({
    by: ['settlesMovementId'],
    where: { tenantId, kind: 'shortfall_settle', settlesMovementId: { in: sales.map((s) => s.id) } },
    _sum: { qty: true },
  })
  const settledQty = new Map(settles.map((r) => [r.settlesMovementId, -(r._sum.qty ?? 0)]))
  const byItem = new Map<string, { qty: number; valueCents: number; sales: number }>()
  for (const s of sales) {
    const total = s.shortfallQty ?? 0
    const open = total - (settledQty.get(s.id) ?? 0)
    if (open <= STOCK_EPS) continue
    const memo = toCents(s.shortfallValueCents) ?? 0
    const cur = byItem.get(s.inventoryItemId) ?? { qty: 0, valueCents: 0, sales: 0 }
    cur.qty += open
    cur.valueCents += total > 0 ? Math.round((memo * open) / total) : 0
    cur.sales += 1
    byItem.set(s.inventoryItemId, cur)
  }
  if (byItem.size === 0) return { checked: 0, flagged: 0 }

  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: [...byItem.keys()] }, tenantId },
    select: { id: true, name: true, unit: true },
  })
  let flagged = 0
  for (const item of items) {
    const a = byItem.get(item.id)!
    const existing = await prisma.exceptionFlag.findFirst({
      where: {
        tenantId, kind: { in: kindsMatching('stock_shortfall') }, status: { in: ['open', 'acknowledged'] },
        entityType: 'InventoryItem', entityId: item.id,
      },
      select: { id: true },
    })
    if (existing) continue
    const qty = Math.round(a.qty * 1000) / 1000
    await flagException({
      tenantId,
      kind: 'stock_shortfall',
      severity: 'medium',
      title: `Sold more than the books held: ${item.name}`,
      description: `In the last ${SHORTFALL_SETTLE_DAYS} days, sales used ${qty} ${item.unit} of ${item.name} that was not on the books `
        + `(about PKR ${(a.valueCents / 100).toFixed(0)} at the latest purchase price), across ${a.sales} sale line${a.sales === 1 ? '' : 's'}. `
        + 'Record the delivery it came from (it settles the cost automatically), or count the item.',
      entityType: 'InventoryItem',
      entityId: item.id,
      amountCents: a.valueCents,
      metadata: { shortfallQty: a.qty, memoValueCents: a.valueCents, saleLines: a.sales, windowDays: SHORTFALL_SETTLE_DAYS },
    })
    flagged++
  }
  return { checked: byItem.size, flagged }
}

export async function runForTenant(tenantId: string): Promise<{ checked: number; flagged: number }> {
  const ops = await getOperationsConfig(tenantId)
  const weeks = ops?.shrinkage_trend_weeks ?? 4
  const since = new Date(); since.setDate(since.getDate() - weeks * 7)

  // This company's physical-count lines in the window, on this company's items.
  const lines = await prisma.physicalCountLine.findMany({
    where: { count: { tenantId, kind: 'spot', countedAt: { gte: since } } },
    select: { inventoryItemId: true, variancePct: true, systemQty: true, physicalQty: true },
  })

  // Aggregate per item. A zero-book line (stock_unrecorded) has no %.
  const agg = new Map<string, { sum: number; n: number; lossQty: number }>()
  for (const l of lines) {
    if (l.variancePct == null || !(l.systemQty > 0)) continue
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

    const item = await prisma.inventoryItem.findFirst({
      where: { id: itemId, tenantId },
      select: { name: true, unit: true, unitCostCents: true },
    })
    if (!item) continue

    const lossValueCents = item.unitCostCents != null ? Math.round(item.unitCostCents * a.lossQty) : null

    // Don't double-flag — only fire once per item per window if this company
    // has no open flag for it yet.
    const existing = await prisma.exceptionFlag.findFirst({
      where: {
        tenantId,
        kind: 'shrinkage_trend', status: 'open',
        entityType: 'InventoryItem', entityId: itemId,
        createdAt: { gte: since },
      },
      select: { id: true },
    })
    if (existing) continue

    await flagException({
      tenantId,
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

  return { checked: agg.size, flagged }
}
