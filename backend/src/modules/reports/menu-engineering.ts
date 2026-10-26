import { prisma } from '../../lib/prisma.js'
import { menuItemPlateCosts } from '../../lib/recipeCost.js'

export interface MenuEngineeringItem {
  menuItemId: string
  name: string
  priceCents: number
  qtySold: number
  foodCostCents: number
  grossMarginPct: number
  quadrant: 'star' | 'plowHorse' | 'puzzle' | 'dog'
  popularityIndex: number  // qty vs concept avg (1.0 = avg)
  marginIndex: number      // margin vs concept avg (1.0 = avg)
  hasRecipe: boolean
}

export async function getMenuEngineering(opts: {
  conceptId: string
  dateFrom: Date
  dateTo: Date
}): Promise<MenuEngineeringItem[]> {
  const { conceptId, dateFrom, dateTo } = opts

  // Popularity: order counts per item in period
  const salesRows = await prisma.orderItem.groupBy({
    by: ['menuItemId', 'name'],
    _sum: { quantity: true },
    where: {
      status: { not: 'voided' },
      menuItemId: { not: null },
      order: {
        conceptId,
        status: 'completed',
        placedAt: { gte: dateFrom, lte: dateTo },
      },
    },
  })

  if (salesRows.length === 0) return []

  const menuItemIds = salesRows.map((r) => r.menuItemId!).filter(Boolean)

  // Menu prices, plus THE plate cost (lib/recipeCost.ts) — the number the
  // recipe screens price against and the ledger books as COGS. The inline copy
  // here multiplied the per-kg price by grams (1000x high on weighed items),
  // skipped sub-recipes, had no Q factor, divided by a yield that could be 0,
  // and added labour at 0.83 paisa a minute (100x below the PKR 50/hr it
  // claimed — and decision 26 drops kitchen labour from plate cost anyway).
  const [menuItems, plateCosts] = await Promise.all([
    prisma.menuItem.findMany({
      where: { id: { in: menuItemIds } },
      select: { id: true, name: true, priceCents: true },
    }),
    // Menu pricing reads recipes at the LATEST cost, in the brand's own company (owner, 2026-10-26).
    prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } })
      .then((c) => menuItemPlateCosts(menuItemIds, prisma, { latest: true, tenantId: c?.tenantId ?? null })),
  ])

  const itemMap = new Map(menuItems.map((m) => [m.id, m]))

  const results: MenuEngineeringItem[] = salesRows.map((row) => {
    const qtySold = row._sum.quantity ?? 0
    const item = itemMap.get(row.menuItemId!)
    const priceCents = item?.priceCents ?? 0
    const cost = plateCosts.get(row.menuItemId!)
    const foodCostCents = cost ? Math.round(cost.perPortionCents) : 0

    const grossMarginPct = priceCents > 0 ? ((priceCents - foodCostCents) / priceCents) * 100 : 0

    return {
      menuItemId: row.menuItemId!,
      name: row.name ?? item?.name ?? 'Unknown',
      priceCents,
      qtySold,
      foodCostCents,
      grossMarginPct,
      quadrant: 'dog' as const,  // filled in below
      popularityIndex: 0,
      marginIndex: 0,
      hasRecipe: !!cost,
    }
  })

  // Compute averages for quadrant classification
  const avgQty = results.reduce((s, r) => s + r.qtySold, 0) / results.length
  const avgMargin = results.reduce((s, r) => s + r.grossMarginPct, 0) / results.length

  for (const r of results) {
    r.popularityIndex = avgQty > 0 ? r.qtySold / avgQty : 0
    r.marginIndex = avgMargin > 0 ? r.grossMarginPct / avgMargin : 0

    const highPop = r.qtySold >= avgQty
    const highMargin = r.grossMarginPct >= avgMargin

    if (highPop && highMargin) r.quadrant = 'star'
    else if (highPop && !highMargin) r.quadrant = 'plowHorse'
    else if (!highPop && highMargin) r.quadrant = 'puzzle'
    else r.quadrant = 'dog'
  }

  return results.sort((a, b) => b.qtySold - a.qtySold)
}
