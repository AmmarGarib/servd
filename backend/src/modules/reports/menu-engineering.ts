import { prisma } from '../../lib/prisma.js'

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

  // Get menu item prices + recipes in one query
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: menuItemIds } },
    select: {
      id: true,
      name: true,
      priceCents: true,
      recipe: {
        select: {
          servings: true,
          laborMinutes: true,
          ingredients: {
            select: {
              quantity: true,
              yieldPct: true,
              inventoryItem: { select: { unitCostCents: true } },
            },
          },
        },
      },
    },
  })

  const itemMap = new Map(menuItems.map((m) => [m.id, m]))

  // Compute food cost per item (ingredient cost / servings + labour)
  const LABOUR_RATE_PER_MIN = 50 / 60  // PKR 50/hr = ~0.83/min in paisa

  const results: MenuEngineeringItem[] = salesRows.map((row) => {
    const qtySold = row._sum.quantity ?? 0
    const item = itemMap.get(row.menuItemId!)
    const priceCents = item?.priceCents ?? 0
    let foodCostCents = 0

    if (item?.recipe) {
      const { recipe } = item
      const servings = recipe.servings || 1
      const ingredientCost = recipe.ingredients.reduce((sum, ing) => {
        const rawCost = (ing.inventoryItem.unitCostCents ?? 0) * ing.quantity
        return sum + rawCost / ing.yieldPct
      }, 0)
      const labourCost = recipe.laborMinutes * LABOUR_RATE_PER_MIN
      foodCostCents = Math.round((ingredientCost + labourCost) / servings)
    }

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
      hasRecipe: !!item?.recipe,
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
