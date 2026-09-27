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
//   - Sale-time depletion (DB): takes the exploded quantities, is idempotent,
//     gives them back on cancel exactly once, and ledger COGS is costed on the
//     same function.
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

describe('sale-time depletion and restore (DB)', () => {
  let conceptId: string
  let menuItemId: string
  let flourId: string
  let butterId: string
  let staffId: string
  let tenantId: string

  beforeAll(async () => {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    const run = Math.random().toString(36).slice(2, 8)
    tenantId = (await prisma.tenant.create({ data: { name: 'Recipe Cost Co', slug: `recipe-cost-co-${run}` } })).id
    conceptId = (await prisma.concept.create({
      data: { name: 'Recipe Cost Cafe', slug: `recipe-cost-cafe-${run}`, type: 'restaurant', tenantId, taxRateCash: 0, taxRateCard: 0 },
    })).id
    const category = await prisma.category.create({ data: { conceptId, name: 'RC Bakes' } })
    menuItemId = (await prisma.menuItem.create({ data: { conceptId, categoryId: category.id, name: 'RC Tart', priceCents: 120_000 } })).id
    flourId = (await prisma.inventoryItem.create({ data: { tenantId, name: 'RC Flour', unit: 'kg', currentStock: 20, parLevel: 5, unitCostCents: 30_000 } })).id
    butterId = (await prisma.inventoryItem.create({ data: { tenantId, name: 'RC Butter', unit: 'kg', currentStock: 3, parLevel: 1, unitCostCents: 100_000 } })).id
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

  async function order(qty: number) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    return prisma.order.create({
      data: {
        conceptId, source: 'servd', status: 'received', totalCents: 120_000 * qty, placedAt: new Date(),
        items: { create: [{ menuItemId, name: 'RC Tart', quantity: qty, unitPriceCents: 120_000 }] },
      },
    })
  }
  async function stock(id: string) {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    return (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock
  }

  it('takes purchase units through the sub-recipe, once; cancel gives it back once', async () => {
    const { deductInventoryForOrder, cancelOrder } = await import('../src/modules/orders/service.js')
    const o = await order(2)

    await deductInventoryForOrder(o.id)
    expect(await stock(flourId)).toBeCloseTo(20 - 0.3, 6)     // 2 × 150 g = 0.3 kg, not 300
    expect(await stock(butterId)).toBeCloseTo(3 - 0.4, 6)     // 2 × 0.2 batch × 1 kg drawn

    await deductInventoryForOrder(o.id)                       // replay: no second deduction
    expect(await stock(flourId)).toBeCloseTo(19.7, 6)

    await cancelOrder(o.id, { reason: 'Customer left', actor: { id: staffId, tenantId } })
    expect(await stock(flourId)).toBeCloseTo(20, 6)
    expect(await stock(butterId)).toBeCloseTo(3, 6)

    await cancelOrder(o.id, { reason: 'Again', actor: { id: staffId, tenantId } })
    expect(await stock(flourId)).toBeCloseTo(20, 6)

    // An order already cancelled takes nothing (the depletion lost the race).
    await deductInventoryForOrder(o.id)
    expect(await stock(flourId)).toBeCloseTo(20, 6)
  })

  it('restores only what clamping actually took', async () => {
    const { serviceClient: prisma } = await import('../src/lib/prisma.js')
    const { deductInventoryForOrder, cancelOrder } = await import('../src/modules/orders/service.js')
    await prisma.inventoryItem.update({ where: { id: butterId }, data: { currentStock: 0.1 } })
    const o = await order(1)                                 // wants 0.2 kg butter, only 0.1 there
    await deductInventoryForOrder(o.id)
    expect(await stock(butterId)).toBe(0)
    await cancelOrder(o.id, { reason: 'Out of butter', actor: { id: staffId, tenantId } })
    expect(await stock(butterId)).toBeCloseTo(0.1, 6)
    await prisma.inventoryItem.update({ where: { id: butterId }, data: { currentStock: 3 } })
    await prisma.menuItem.update({ where: { id: menuItemId }, data: { isAvailable: true } })
  })

  it('ledger COGS is THE plate cost × quantity, no labour', async () => {
    const { orderCogsCents, menuItemPlateCosts } = await import('../src/lib/recipeCost.js')
    const o = await order(3)
    // flour 4,500 + pastry 200 g × 110/g (1 kg butter drawn = 100,000 + its 10% Q, per 1000 g) = 22,000
    // + the plate's Q on the flour only (450). The 30 labour minutes add nothing.
    const plateCost = (await menuItemPlateCosts([menuItemId])).get(menuItemId)!
    expect(plateCost.perPortionCents).toBeCloseTo(4_500 + 22_000 + 450, 6)
    expect(await orderCogsCents(o.id)).toBe(Math.round(3 * (4_500 + 22_000 + 450)))
  })
})
