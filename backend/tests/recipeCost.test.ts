// THE recipe explosion, plate cost and below-par rule (lib/recipeCost.ts).
//
// What this guards:
//   - Depletion is in PURCHASE units: 150 g of an item stocked by the 20 kg
//     sack takes 0.15 kg, not 150 (which clamped the sack to zero and 86'd
//     every dish on it).
//   - Sub-recipes explode into their raw ingredients, scaled by grams used
//     against the batch yield, at any depth; cycles don't hang.
//   - Plate cost = exploded raw cost + each recipe's own Q on its own raw
//     lines (applied once), no labour; costing and explosion agree.
//   - One below-par predicate: par must be set, at-par counts, on-order nets.
//   - MC by class (food / drinks / packaging), the plate MC without the
//     Packaging section, the target MC per order type (wave B packaging rule),
//     Q kept apart; negative lines only on modifier recipes.
//   - Sale-time depletion (DB, FIFO lots): takes the exploded quantities from
//     the lots, is idempotent, gives them back to the same lots on cancel
//     exactly once, clamps a shortfall, and the legacy theoretical COGS
//     helpers keep their rule.
import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildRecipeGraph, explodeRecipe, recipeCost, isBelowPar, toPurchaseUnits,
  costPerMeasureCents, measureToPurchaseUnits, type CostRecipe, type CostItem,
} from '../src/lib/recipeCost.js'

const flour: CostItem  = { id: 'flour',  unit: 'kg',  unitCostCents: 30_000 }   // PKR 300 / kg, 20 kg sack
const butter: CostItem = { id: 'butter', unit: 'kg',  unitCostCents: 100_000 }  // PKR 1,000 / kg
const eggs: CostItem   = { id: 'eggs',   unit: 'pcs', unitCostCents: 2_500 }    // PKR 25 each
const milk: CostItem   = { id: 'milk',   unit: 'L',   unitCostCents: 20_000 }   // PKR 200 / litre

function raw(item: CostItem, quantity: number, yieldPct = 1) {
  return { inventoryItemId: item.id, prepRecipeId: null, quantity, yieldPct, inventoryItem: item }
}
function sub(recipeId: string, grams: number) {
  return { inventoryItemId: null, prepRecipeId: recipeId, quantity: grams, yieldPct: 1, inventoryItem: null }
}

// Sub-recipe: a 1 kg batch of pastry made from 500 g of butter at 50% yield
// (so 1 kg drawn) and 2 eggs, Q 10%.
const pastry: CostRecipe = {
  id: 'pastry', kind: 'component', servings: 1, yieldGrams: 1000, qFactorPct: 10,
  ingredients: [raw(butter, 500, 0.5), raw(eggs, 2)],
}
// Plate: 150 g flour + 200 g of pastry, Q 10%, one portion per batch.
const plate: CostRecipe = {
  id: 'plate', kind: 'plate', servings: 1, yieldGrams: null, qFactorPct: 10,
  ingredients: [raw(flour, 150), sub('pastry', 200)],
}
const graph = buildRecipeGraph([plate, pastry])

describe('explodeRecipe — what a sale takes out of stock', () => {
  it('150 g of a 20 kg item depletes 0.15 kg, not 150', () => {
    const flat = buildRecipeGraph([{ ...plate, ingredients: [raw(flour, 150)] }])
    const q = explodeRecipe(flat, 'plate', 1)
    expect(q.get('flour')).toBeCloseTo(0.15, 10)
    const stockAfter = 20 - q.get('flour')!
    expect(stockAfter).toBeCloseTo(19.85, 10)
  })

  it('recurses through sub-recipes, scaled by grams used against the batch yield', () => {
    const q = explodeRecipe(graph, 'plate', 1)
    expect(q.get('flour')).toBeCloseTo(0.15, 10)
    // 200 g of a 1000 g batch = 0.2 batch; the batch draws 1 kg butter (500 g ÷ 50%) and 2 eggs.
    expect(q.get('butter')).toBeCloseTo(0.2, 10)
    expect(q.get('eggs')).toBeCloseTo(0.4, 10)
    expect([...q.keys()].sort()).toEqual(['butter', 'eggs', 'flour'])
  })

  it('scales by portions sold and by servings per batch', () => {
    const q3 = explodeRecipe(graph, 'plate', 3)
    expect(q3.get('flour')).toBeCloseTo(0.45, 10)
    expect(q3.get('butter')).toBeCloseTo(0.6, 10)
    const twoPortion = buildRecipeGraph([{ ...plate, servings: 2 }, pastry])
    expect(explodeRecipe(twoPortion, 'plate', 1).get('flour')).toBeCloseTo(0.075, 10)
  })

  it('explodes a sub-recipe by grams or by batch', () => {
    expect(explodeRecipe(graph, 'pastry', 500, 'gram').get('butter')).toBeCloseTo(0.5, 10)
    expect(explodeRecipe(graph, 'pastry', 2, 'batch').get('eggs')).toBeCloseTo(4, 10)
  })

  it('goes deeper than one level', () => {
    const glaze: CostRecipe = { id: 'glaze', kind: 'component', servings: 1, yieldGrams: 500, qFactorPct: 10, ingredients: [raw(milk, 250)] }
    const filled: CostRecipe = { ...pastry, id: 'filled', ingredients: [...pastry.ingredients, sub('glaze', 100)] }
    const top: CostRecipe = { ...plate, ingredients: [sub('filled', 500)] }
    const g = buildRecipeGraph([top, filled, glaze])
    // 0.5 batch of filled → 50 g glaze → 0.1 batch of glaze → 25 ml milk = 0.025 L
    expect(explodeRecipe(g, 'plate', 1).get('milk')).toBeCloseTo(0.025, 10)
  })

  it('a cycle does not hang, and an unknown recipe explodes to nothing', () => {
    const a: CostRecipe = { id: 'a', kind: 'component', servings: 1, yieldGrams: 100, qFactorPct: 10, ingredients: [raw(flour, 100), sub('b', 50)] }
    const b: CostRecipe = { id: 'b', kind: 'component', servings: 1, yieldGrams: 100, qFactorPct: 10, ingredients: [sub('a', 50)] }
    const g = buildRecipeGraph([a, b])
    expect(explodeRecipe(g, 'a', 1, 'batch').get('flour')).toBeCloseTo(0.1, 10)
    expect(recipeCost(g, 'a').rawIngredientCents).toBeCloseTo(3_000, 6)
    expect(explodeRecipe(g, 'nope', 1).size).toBe(0)
  })

  it('treats a line yield stored as a percent the same as the fraction', () => {
    const g = buildRecipeGraph([{ ...plate, ingredients: [raw(flour, 150, 75)] }])
    expect(explodeRecipe(g, 'plate', 1).get('flour')).toBeCloseTo(0.2, 10)
  })
})

describe('recipeCost — THE plate cost', () => {
  it('without sub-recipes: raw cost + own Q, no labour', () => {
    const g = buildRecipeGraph([{ ...plate, ingredients: [raw(flour, 150)] }])
    const c = recipeCost(g, 'plate')
    expect(c.rawIngredientCents).toBeCloseTo(4_500, 6)      // 0.15 kg × PKR 300
    expect(c.qCents).toBeCloseTo(450, 6)
    expect(c.totalCents).toBeCloseTo(4_950, 6)
    expect(c.perPortionCents).toBeCloseTo(4_950, 6)
    const two = recipeCost(buildRecipeGraph([{ ...plate, servings: 2, ingredients: [raw(flour, 150)] }]), 'plate')
    expect(two.perPortionCents).toBeCloseTo(2_475, 6)
  })

  it('count items are divided by yield like weighed ones', () => {
    const g = buildRecipeGraph([{ ...plate, qFactorPct: 0, ingredients: [raw(eggs, 3, 0.75)] }])
    expect(recipeCost(g, 'plate').totalCents).toBeCloseTo(10_000, 6)   // 4 eggs drawn × PKR 25
  })

  it('with sub-recipes: each recipe applies its own Q once, on its own raw lines', () => {
    const p = recipeCost(graph, 'pastry')
    expect(p.rawIngredientCents).toBeCloseTo(105_000, 6)    // 1 kg butter + 2 eggs
    expect(p.totalCents).toBeCloseTo(115_500, 6)            // + 10%
    expect(p.perGramCents).toBeCloseTo(115.5, 6)

    const c = recipeCost(graph, 'plate')
    expect(c.rawIngredientCents).toBeCloseTo(4_500, 6)
    expect(c.componentCents).toBeCloseTo(23_100, 6)         // 200 g × 115.5
    expect(c.qCents).toBeCloseTo(450, 6)                    // plate Q on flour only — not again on the pastry
    expect(c.totalCents).toBeCloseTo(28_050, 6)
  })

  it('agrees with the explosion: exploded quantities × unit cost = raw cost before Q', () => {
    const q = explodeRecipe(graph, 'plate', 1)
    const byId = new Map([flour, butter, eggs].map((i) => [i.id, i]))
    const exploded = [...q].reduce((s, [id, qty]) => s + qty * (byId.get(id)!.unitCostCents ?? 0), 0)
    const c = recipeCost(graph, 'plate')
    const rawAllLevels = c.rawIngredientCents + 0.2 * recipeCost(graph, 'pastry').rawIngredientCents
    expect(exploded).toBeCloseTo(rawAllLevels, 6)
  })
})

describe('material cost (MC) by class, packaging and order type — wave B', () => {
  const cola: CostItem = { id: 'cola', unit: 'pcs', unitCostCents: 8_000, category: 'beverage' }
  const box: CostItem  = { id: 'box',  unit: 'pcs', unitCostCents: 3_000, category: 'packaging' }
  const flourF: CostItem = { ...flour, category: 'dry_goods' }
  const pack = (item: CostItem, q: number) => ({ ...raw(item, q), section: 'packaging' })
  const meal = (vessel: 'plate' | 'packaging'): CostRecipe => ({
    id: 'meal', kind: 'plate', servings: 1, yieldGrams: null, qFactorPct: 10, serviceVessel: vessel,
    ingredients: [raw(flourF, 150), raw(cola, 1), pack(box, 1)],
  })

  it('splits food / drinks / packaging; the plate MC leaves the Packaging section out; Q never touches packaging', () => {
    const c = recipeCost(buildRecipeGraph([meal('plate')]), 'meal')
    expect(c.stockByClass.food).toBeCloseTo(4_500, 6)
    expect(c.stockByClass.beverage).toBeCloseTo(8_000, 6)
    expect(c.stockByClass.packaging).toBeCloseTo(3_000, 6)
    expect(c.packagingCents).toBeCloseTo(3_000, 6)
    expect(c.standardCents).toBeCloseTo(12_500, 6)
    expect(c.qCents).toBeCloseTo(1_250, 6)                 // 10% of flour + cola only — never inside the MC
  })

  it('target MC: dine-in excludes packaging at a plate brand, includes it at a packaging brand; takeaway / delivery always include it', () => {
    const plateBrand = recipeCost(buildRecipeGraph([meal('plate')]), 'meal').targetMcCents
    expect(plateBrand.dine_in).toBeCloseTo(12_500, 6)
    expect(plateBrand.takeout).toBeCloseTo(15_500, 6)
    expect(plateBrand.delivery).toBeCloseTo(15_500, 6)
    const packBrand = recipeCost(buildRecipeGraph([meal('packaging')]), 'meal').targetMcCents
    expect(packBrand.dine_in).toBeCloseTo(15_500, 6)
    expect(packBrand.takeout).toBeCloseTo(15_500, 6)
  })

  it('carries a sub-recipe\'s classes up, per portion', () => {
    const c = recipeCost(graph, 'plate')
    // flour 4,500 + 0.2 × pastry (butter 100,000 + eggs 5,000), ex-Q
    expect(c.stockByClass.food).toBeCloseTo(4_500 + 21_000, 6)
    expect(c.standardCents).toBeCloseTo(25_500, 6)
    expect(c.packagingCents).toBe(0)
  })

  it('a negative line counts only on a modifier recipe', () => {
    const noCheese: CostRecipe = { id: 'nc', kind: 'modifier', servings: 1, yieldGrams: null, qFactorPct: 0, ingredients: [raw(butter, -20)] }
    expect(explodeRecipe(buildRecipeGraph([noCheese]), 'nc', 1).get('butter')).toBeCloseTo(-0.02, 10)
    const bad: CostRecipe = { ...plate, ingredients: [raw(flour, 150), raw(butter, -20)] }
    expect(explodeRecipe(buildRecipeGraph([bad]), 'plate', 1).has('butter')).toBe(false)
  })
})

describe('units', () => {
  it('per-measure cost and purchase conversion', () => {
    expect(costPerMeasureCents('kg', 30_000)).toBe(30)
    expect(costPerMeasureCents('L', 20_000)).toBe(20)
    expect(costPerMeasureCents('pcs', 2_500)).toBe(2_500)
    expect(costPerMeasureCents('dozen', 1_200)).toBe(100)
    expect(measureToPurchaseUnits(150, 'kg')).toBeCloseTo(0.15, 10)
    expect(measureToPurchaseUnits(3, 'pcs')).toBe(3)
  })

  it('explicit units convert or refuse', () => {
    expect(toPurchaseUnits(500, 'g', 'kg')).toBeCloseTo(0.5, 10)
    expect(toPurchaseUnits(250, 'ml', 'litres')).toBeCloseTo(0.25, 10)
    expect(toPurchaseUnits(2, 'kg', 'kg')).toBe(2)
    expect(toPurchaseUnits(1, 'dozen', 'pcs')).toBe(12)
    expect(toPurchaseUnits(300, '', 'kg')).toBeCloseTo(0.3, 10)     // no unit = recipe measure
    expect(toPurchaseUnits(2, 'pcs', 'kg')).toBeNull()               // pieces of a weighed item
    expect(toPurchaseUnits(2, 'tbsp', 'kg')).toBeNull()              // unknown unit
  })
})

describe('isBelowPar — THE low-stock rule', () => {
  it('no par set is never below par, even at zero', () => {
    expect(isBelowPar({ currentStock: 0, parLevel: 0 })).toBe(false)
    expect(isBelowPar({ currentStock: -1, parLevel: 0 })).toBe(false)
  })
  it('at par counts; just above does not', () => {
    expect(isBelowPar({ currentStock: 10, parLevel: 10 })).toBe(true)
    expect(isBelowPar({ currentStock: 10.01, parLevel: 10 })).toBe(false)
    expect(isBelowPar({ currentStock: 0, parLevel: 5 })).toBe(true)
  })
  it('nets stock already on order when asked', () => {
    expect(isBelowPar({ currentStock: 4, parLevel: 10 }, 6)).toBe(true)
    expect(isBelowPar({ currentStock: 4, parLevel: 10 }, 7)).toBe(false)
  })
})

// ─── Against the database: sale-time depletion, restore on cancel, COGS ──────

describe('sale-time depletion and restore on FIFO lots (DB)', () => {
  let conceptId: string
  let menuItemId: string
  let flourId: string
  let butterId: string
  let staffId: string
  let tenantId: string
  let seq = 0

  async function lot(itemId: string, qty: number, unitCostCents: number) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    const { addLotTx } = await import('../src/lib/stockLedger.js')
    const src = `rc-lot-${++seq}`
    return prisma.$transaction((tx) => addLotTx(tx, {
      tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
      movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 86_400_000 + seq),
    }))
  }

  beforeAll(async () => {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    const { fifoCutoverKey } = await import('../src/lib/stockLedger.js')
    const run = Math.random().toString(36).slice(2, 8)
    tenantId = (await prisma.tenant.create({ data: { name: 'Recipe Cost Co', slug: `recipe-cost-co-${run}` } })).id
    await prisma.setting.create({ data: { key: fifoCutoverKey(tenantId), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
    conceptId = (await prisma.concept.create({
      data: { name: 'Recipe Cost Cafe', slug: `recipe-cost-cafe-${run}`, type: 'restaurant', tenantId, taxRateCash: 0, taxRateCard: 0 },
    })).id
    const category = await prisma.category.create({ data: { conceptId, name: 'RC Bakes' } })
    menuItemId = (await prisma.menuItem.create({ data: { conceptId, categoryId: category.id, name: 'RC Tart', priceCents: 120_000 } })).id
    flourId = (await prisma.inventoryItem.create({ data: { tenantId, name: 'RC Flour', unit: 'kg', parLevel: 5, unitCostCents: 30_000 } })).id
    butterId = (await prisma.inventoryItem.create({ data: { tenantId, name: 'RC Butter', unit: 'kg', parLevel: 1, unitCostCents: 100_000 } })).id
    await lot(flourId, 20, 30_000)
    await lot(butterId, 3, 100_000)
    const pastryRecipe = await prisma.recipe.create({
      data: {
        kind: 'component', name: 'RC Pastry', yieldGrams: 1000, qFactorPct: 10,
        ingredients: { create: [{ inventoryItemId: butterId, quantity: 500, yieldPct: 0.5, unit: 'kg' }] },
      },
    })
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId, servings: 1, qFactorPct: 10, laborMinutes: 30,
        ingredients: { create: [
          { inventoryItemId: flourId, quantity: 150, yieldPct: 1, unit: 'kg' },
          { prepRecipeId: pastryRecipe.id, quantity: 200, yieldPct: 1, unit: 'g' },
        ] },
      },
    })
    staffId = (await prisma.user.create({
      data: { name: 'RC Manager', email: `rc-manager-${run}@test.local`, password: 'x', role: 'admin', tenantId },
    })).id
  })

  async function order(qty: number, item = menuItemId) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    return prisma.order.create({
      data: {
        conceptId, source: 'servd', status: 'received', totalCents: 120_000 * qty, placedAt: new Date(),
        items: { create: [{ menuItemId: item, name: 'RC Tart', quantity: qty, unitPriceCents: 120_000 }] },
      },
    })
  }
  async function stock(id: string) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    return (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock
  }
  async function moves(orderId: string) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    return prisma.stockMovement.findMany({ where: { orderId }, select: { kind: true, inventoryItemId: true, qty: true, sourceType: true, lotId: true } })
  }

  it('takes purchase units through the sub-recipe from the lots, once; cancel puts them back in the same lots, once', async () => {
    const { deductInventoryForOrder, cancelOrder } = await import('../src/modules/orders/service.js')
    const o = await order(2)

    await deductInventoryForOrder(o.id)
    expect(await stock(flourId)).toBeCloseTo(20 - 0.3, 6)     // 2 × 150 g = 0.3 kg, not 300
    expect(await stock(butterId)).toBeCloseTo(3 - 0.4, 6)     // 2 × 0.2 batch × 1 kg drawn
    const sales = (await moves(o.id)).filter((m) => m.kind === 'sale')
    expect(sales.map((m) => [m.inventoryItemId, m.sourceType]).sort()).toEqual([[butterId, 'order_item.sale'], [flourId, 'order_item.sale']].sort())

    await deductInventoryForOrder(o.id)                       // replay: no second deduction
    expect(await stock(flourId)).toBeCloseTo(19.7, 6)
    expect((await moves(o.id)).length).toBe(2)

    await cancelOrder(o.id, { reason: 'Customer left', actor: { id: staffId, tenantId } })
    expect(await stock(flourId)).toBeCloseTo(20, 6)
    expect(await stock(butterId)).toBeCloseTo(3, 6)
    const back = (await moves(o.id)).filter((m) => m.kind === 'sale_return')
    expect(back).toHaveLength(2)
    for (const b of back) expect(b.lotId).toBe(sales.find((x) => x.inventoryItemId === b.inventoryItemId)!.lotId)

    await cancelOrder(o.id, { reason: 'Again', actor: { id: staffId, tenantId } })
    expect(await stock(flourId)).toBeCloseTo(20, 6)

    // An order already cancelled takes nothing (the depletion lost the race).
    await deductInventoryForOrder(o.id)
    expect(await stock(flourId)).toBeCloseTo(20, 6)
    expect((await moves(o.id)).length).toBe(4)
  })

  it('a shortfall clamps (recorded on the sale), and cancel returns only what the lots gave', async () => {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    const { deductInventoryForOrder, cancelOrder } = await import('../src/modules/orders/service.js')
    const cream = (await prisma.inventoryItem.create({ data: { tenantId, name: 'RC Cream', unit: 'kg', unitCostCents: 50_000 } })).id
    await lot(cream, 0.1, 50_000)
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId } })
    const pud = (await prisma.menuItem.create({ data: { conceptId, categoryId: cat.id, name: 'RC Pudding', priceCents: 90_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: pud, servings: 1, ingredients: { create: [{ inventoryItemId: cream, quantity: 200, unit: 'kg' }] } } })
    const o = await order(1, pud)                            // wants 0.2 kg cream, only 0.1 there
    await deductInventoryForOrder(o.id)
    expect(await stock(cream)).toBe(0)
    const sale = await prisma.stockMovement.findMany({ where: { orderId: o.id, kind: 'sale' } })
    expect(sale.reduce((s, m) => s + (m.shortfallQty ?? 0), 0)).toBeCloseTo(0.1, 6)
    // The sale ran it out: the dish is auto-86'd.
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: pud } })).isAvailable).toBe(false)
    await cancelOrder(o.id, { reason: 'Out of cream', actor: { id: staffId, tenantId } })
    expect(await stock(cream)).toBeCloseTo(0.1, 6)
  })

  it('ledger COGS is THE plate cost × quantity, no labour (the legacy theoretical rule)', async () => {
    const { orderCogsCents, menuItemPlateCosts } = await import('../src/lib/recipeCost.js')
    const o = await order(3)
    // flour 4,500 + pastry 200 g × 110/g (1 kg butter drawn = 100,000 + its 10% Q, per 1000 g) = 22,000
    // + the plate's Q on the flour only (450). The 30 labour minutes add nothing.
    const plateCost = (await menuItemPlateCosts([menuItemId])).get(menuItemId)!
    expect(plateCost.perPortionCents).toBeCloseTo(4_500 + 22_000 + 450, 6)
    expect(await orderCogsCents(o.id)).toBe(Math.round(3 * (4_500 + 22_000 + 450)))
  })
})
