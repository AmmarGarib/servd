// Add-ons on FIFO lots: a modifier's own recipe (RecipeKind 'modifier',
// Recipe.modifierId) is what ONE unit of the add-on uses per unit of the dish
// (lib/recipeCost.ts consumptionPerLine, modules/orders/stock.ts).
//
// What this guards:
//   - an add-on's recipe is consumed with the dish, × the line's quantity;
//   - a 'removes' (negative) line takes the ingredient out of the dish, clamped
//     at zero per ingredient per line — never below none, never a return;
//   - negative lines count only on modifier recipes;
//   - an add-on id that is not this dish's live modifier is stored null and
//     consumes nothing; an add-on whose recipe draws another company's item
//     consumes nothing of it.
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, type Company } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { consumptionPerLine } from '../src/lib/recipeCost.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'

const DAY = 86_400_000
let A: Company
let B: Company
let bun: string
let cheese: string
let patty: string
let cheeseB: string
let extraCheese: string
let noCheese: string
let doublePatty: string
let foreignAddOn: string
let deletedGroupMod: string
let seq = 0

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `mod-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 3 * DAY),
  }))
}

async function ring(quantity: number, modifierIds: string[]) {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: 'dine_in',
    items: [{
      externalItemId: '', menuItemId: A.items.nihari, name: 'Burger', quantity, unitPriceCents: 100_000,
      modifiers: modifierIds.map((id) => ({ name: 'Add-on', priceDeltaCents: 0, modifierId: id })),
    }],
    payment: { provider: null, amountCents: 100_000 * quantity, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  const rows = await prisma.stockMovement.findMany({ where: { orderId: order.id, kind: 'sale' } })
  const taken = (itemId: string) => -rows.filter((r) => r.inventoryItemId === itemId).reduce((s, r) => s + r.qty, 0)
  return { orderId: order.id, rows, taken }
}

beforeAll(async () => {
  A = await mkCompany(`mod-a-${Date.now()}`)
  B = await mkCompany(`mod-b-${Date.now()}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 30 * DAY).toISOString() } })
  bun = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Bun', unit: 'pcs', category: 'dry_goods' } })).id
  cheese = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Cheese slice', unit: 'pcs', category: 'dairy' } })).id
  patty = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Patty', unit: 'pcs', category: 'protein' } })).id
  cheeseB = (await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: 'Cheese slice', unit: 'pcs', category: 'dairy' } })).id
  await lot(A.tenantId, bun, 100, 2_000)
  await lot(A.tenantId, cheese, 100, 3_000)
  await lot(A.tenantId, patty, 100, 20_000)
  await lot(B.tenantId, cheeseB, 100, 3_000)
  // The dish (the fixture's 'nihari' item stands in for a burger): a bun, a patty, one cheese slice.
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1,
      ingredients: { create: [
        { inventoryItemId: bun, quantity: 1, unit: 'pcs' },
        { inventoryItemId: patty, quantity: 1, unit: 'pcs' },
        { inventoryItemId: cheese, quantity: 1, unit: 'pcs' },
      ] },
    },
  })
  const group = await prisma.modifierGroup.create({ data: { menuItemId: A.items.nihari, name: 'Make it yours', maxSelect: 5 } })
  const mod = async (name: string, lines: Array<{ inventoryItemId: string; quantity: number }>, groupId = group.id) => {
    const m = await prisma.modifier.create({ data: { groupId, name } })
    await prisma.recipe.create({ data: { kind: 'modifier', modifierId: m.id, servings: 1, ingredients: { create: lines.map((l) => ({ ...l, unit: 'pcs' })) } } })
    return m.id
  }
  extraCheese = await mod('Extra cheese', [{ inventoryItemId: cheese, quantity: 2 }])
  noCheese = await mod('No cheese', [{ inventoryItemId: cheese, quantity: -1 }])
  doublePatty = await mod('Double patty', [{ inventoryItemId: patty, quantity: 1 }])
  foreignAddOn = await mod('Imported cheese', [{ inventoryItemId: cheeseB, quantity: 1 }])
  const gone = await prisma.modifierGroup.create({ data: { menuItemId: A.items.nihari, name: 'Retired', deletedAt: new Date() } })
  deletedGroupMod = await mod('Old sauce', [{ inventoryItemId: cheese, quantity: 5 }], gone.id)
}, 60_000)

describe('add-on recipes', () => {
  it('an add-on is consumed with the dish, per unit of the line', async () => {
    const r = await ring(3, [extraCheese, doublePatty])
    expect(r.taken(bun)).toBeCloseTo(3, 6)
    expect(r.taken(patty)).toBeCloseTo(6, 6)                      // 3 dishes + 3 double-patty add-ons
    expect(r.taken(cheese)).toBeCloseTo(9, 6)                     // 3 + 3 × 2
    expect(r.rows.every((m) => m.sourceType === 'order_item.sale')).toBe(true)
  })

  it('a "removes" line takes the ingredient out of the dish, clamped at zero per line', async () => {
    const one = await ring(2, [noCheese])
    expect(one.taken(cheese) + 0).toBe(0)
    expect(one.rows.some((m) => m.inventoryItemId === cheese)).toBe(false)
    // "No cheese" twice on the same line can't take the dish below none (and never returns stock).
    const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheese } })).currentStock
    const twice = await consumptionPerLine(
      [{ menuItemId: A.items.nihari, quantity: 1, modifierIds: [noCheese, noCheese, noCheese], serviceVessel: 'plate' }],
      prisma, { tenantId: A.tenantId, fulfilmentType: 'dine_in' },
    )
    expect(twice[0]!.need.has(cheese)).toBe(false)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheese } })).currentStock).toBe(before)
  })

  it('an add-on of another company\'s item consumes nothing of it', async () => {
    const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheeseB } })).currentStock
    const r = await ring(1, [foreignAddOn])
    expect(r.rows.some((m) => m.inventoryItemId === cheeseB)).toBe(false)
    expect(r.taken(cheese)).toBeCloseTo(1, 6)                     // the dish's own slice only
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cheeseB } })).currentStock).toBe(before)
    expect(await prisma.stockMovement.count({ where: { orderId: r.orderId, tenantId: B.tenantId } })).toBe(0)
  })

  it('a retired group\'s add-on is stored null (ingestOrder) and consumes nothing', async () => {
    const r = await ring(1, [deletedGroupMod])
    const mods = await prisma.orderItemModifier.findMany({ where: { orderItem: { orderId: r.orderId } } })
    expect(mods.map((m) => m.modifierId)).toEqual([null])
    expect(r.taken(cheese)).toBeCloseTo(1, 6)
  })
})
