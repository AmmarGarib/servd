// Removals on an order line (owner, 2026-10-27: "removals = any item that is
// being deducted from stock will be adjusted if customer asks to remove").
//
// What this guards:
//   - GET /menu/items/:id/removable lists the top-level ingredient lines of the
//     dish's APPROVED plate recipe (raw by master / item, sub-recipes), never
//     packaging; an unapproved recipe lists nothing; another company's dish 404;
//   - a ring-up with "No onions" draws no onion, everything else as before, and
//     its cost of sales is lower by exactly the onion it did not draw;
//   - removing a sub-recipe line leaves its whole explosion out;
//   - the till's add-items path takes removals through the same check;
//   - an ingredient not on the recipe (or a packaging line) is 422
//     INGREDIENT_NOT_ON_RECIPE, nothing written;
//   - a modifier's 'removes' recipe still works exactly as before;
//   - the kitchen board shows "No <name>" next to the add-ons.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'
import { orderStockCostCents } from '../src/modules/accounting/cogs.js'
import { addItemsToPosOrder, createPosOrder } from '../src/modules/pos/service.js'
import { menuRoutes } from '../src/modules/menu/routes.js'
import { AppError } from '../src/lib/errors.js'
import { cardRows, loadStationQueue } from '../src/modules/expo/kitchenBoard.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import type { OrderLineRemovalDTO } from '@servd/types'

let A: Company
let B: Company
let mgrA: Who
let mgrB: Who
let app: FastifyInstance
let beef: string, onion: string, tomato: string, box: string
let onionMaster: string
let sauce: string           // sub-recipe
let noOnionMod: string      // a modifier whose recipe removes 50 g onion
let seq = 0
const DAY = 86_400_000

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `olr-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
}

type Line = {
  menuItemId: string; name?: string; quantity?: number
  modifiers?: Array<{ name: string; priceDeltaCents: number; modifierId?: string | null }>
  removedIngredients?: OrderLineRemovalDTO[]
}

async function ring(co: Company, lines: Line[], source: 'manual' | 'pos' = 'manual') {
  const { order } = await ingestOrder({
    source, external_id: randomUUID(), concept_id: co.conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: 'dine_in',
    items: lines.map((l) => ({
      externalItemId: '', menuItemId: l.menuItemId, name: l.name ?? 'Beef Nihari', quantity: l.quantity ?? 1, unitPriceCents: 145_000,
      modifiers: l.modifiers ?? [], ...(l.removedIngredients && { removedIngredients: l.removedIngredients }),
    })),
    payment: { provider: null, amountCents: 145_000 * lines.length, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  return order
}

/** Net quantity drawn per item by an order (positive = taken out). */
async function drawn(orderId: string): Promise<Map<string, number>> {
  const rows = await prisma.stockMovement.findMany({ where: { orderId } })
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.inventoryItemId, (out.get(r.inventoryItemId) ?? 0) - Number(r.qty))
  return out
}

const call = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`olr-a-${Date.now()}`)
  B = await mkCompany(`olr-b-${Date.now()}`)
  for (const t of [A.tenantId, B.tenantId]) {
    await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  }
  mgrA = await mkUser('olr-mgr-a', 'foh_management', A.tenantId)
  mgrB = await mkUser('olr-mgr-b', 'foh_management', B.tenantId)

  onionMaster = (await prisma.ingredientMaster.create({ data: { name: 'Onion', normalizedName: `onion-olr-${Date.now()}`, stockUnit: 'g' } })).id
  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  onion = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Onion', unit: 'kg', category: 'produce', masterIngredientId: onionMaster } })).id
  tomato = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Tomato', unit: 'kg', category: 'produce' } })).id
  box = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Nihari box', unit: 'pcs', category: 'packaging' } })).id
  await lot(A.tenantId, beef, 100, 150_000)    // PKR 1,500 / kg
  await lot(A.tenantId, onion, 100, 20_000)    // PKR 200 / kg
  await lot(A.tenantId, tomato, 100, 30_000)   // PKR 300 / kg
  await lot(A.tenantId, box, 100, 3_000)

  // Sub-recipe: a 1 kg batch of tomato sauce (no prep item: explodes raw).
  sauce = (await prisma.recipe.create({
    data: {
      kind: 'component', name: 'Tomato sauce', yieldGrams: 1000, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: tomato, quantity: 1000, unit: 'kg' }] },
    },
  })).id
  // Nihari (approved): 150 g beef, 50 g onion, 100 g sauce, a box in Packaging.
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 10, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [
        { inventoryItemId: beef, quantity: 150, unit: 'kg' },
        { inventoryItemId: onion, quantity: 50, unit: 'kg', masterIngredientId: onionMaster },
        { prepRecipeId: sauce, quantity: 100, unit: 'g' },
        { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' },
      ] },
    },
  })
  // Kheer has a recipe that is NOT approved yet.
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.kheer, servings: 1, status: 'iteration', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: onion, quantity: 10, unit: 'kg' }] },
    },
  })
  // An add-on whose recipe takes the onion out (the modifier way — unchanged).
  const group = await prisma.modifierGroup.create({ data: { menuItemId: A.items.nihari, name: 'Options' } })
  noOnionMod = (await prisma.modifier.create({ data: { groupId: group.id, name: 'No onion (add-on)', priceDeltaCents: 0 } })).id
  await prisma.recipe.create({
    data: {
      kind: 'modifier', modifierId: noOnionMod, servings: 1, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: onion, quantity: -50, unit: 'kg' }] },
    },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the removable list', () => {
  it('lists the approved plate recipe lines (raw by master, sub-recipes), never packaging', async () => {
    const res = await call(mgrA, `/menu/items/${A.items.nihari}/removable`)
    expect(res.statusCode).toBe(200)
    const body = res.json() as { menuItemId: string; removable: Array<Record<string, string>> }
    expect(body.menuItemId).toBe(A.items.nihari)
    expect(body.removable.map((r) => r.name)).toEqual(['Beef', 'Onion', 'Tomato sauce'])
    const byName = new Map(body.removable.map((r) => [r.name, r]))
    expect(byName.get('Onion')).toMatchObject({ kind: 'ingredient', masterIngredientId: onionMaster, key: `m:${onionMaster}` })
    expect(byName.get('Beef')).toMatchObject({ kind: 'ingredient', inventoryItemId: beef, key: `i:${beef}` })
    expect(byName.get('Tomato sauce')).toMatchObject({ kind: 'prep', prepRecipeId: sauce, key: `r:${sauce}` })
    expect(body.removable.some((r) => r.name === 'Nihari box')).toBe(false)
  })

  it('a dish whose recipe is not approved has nothing removable', async () => {
    const res = await call(mgrA, `/menu/items/${A.items.kheer}/removable`)
    expect(res.statusCode).toBe(200)
    expect((res.json() as { removable: unknown[] }).removable).toEqual([])
  })

  it("another company's dish is 404", async () => {
    expect((await call(mgrB, `/menu/items/${A.items.nihari}/removable`)).statusCode).toBe(404)
    expect((await call(mgrA, `/menu/items/${B.items.nihari}/removable`)).statusCode).toBe(404)
    expect((await call(mgrA, `/menu/items/not-a-uuid/removable`)).statusCode).toBe(404)
  })
})

describe('a ring-up with a removal', () => {
  it('"No onions" draws no onion, everything else as before, and costs exactly the onion less', async () => {
    const plain = await ring(A, [{ menuItemId: A.items.nihari, quantity: 2 }])
    const noOnion = await ring(A, [{ menuItemId: A.items.nihari, quantity: 2, removedIngredients: [{ masterIngredientId: onionMaster }] }])

    const p = await drawn(plain.id)
    const n = await drawn(noOnion.id)
    expect(p.get(onion)).toBeCloseTo(0.1, 9)           // 2 × 50 g
    expect(n.get(onion) ?? 0).toBe(0)
    expect(n.get(beef)).toBeCloseTo(p.get(beef)!, 9)   // 0.3 kg
    expect(n.get(tomato)).toBeCloseTo(p.get(tomato)!, 9) // 0.2 kg via the sauce
    expect(n.has(box)).toBe(false)                     // dine-in at a plate brand: no box, either way

    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: noOnion.id } })
    expect(line.removedIngredients).toEqual([{ masterIngredientId: onionMaster, name: 'Onion' }])
    expect(line.unitPriceCents).toBe(145_000)          // price unchanged

    const plainCost = await orderStockCostCents(plain.id)
    const noOnionCost = await orderStockCostCents(noOnion.id)
    expect(plainCost - noOnionCost).toBe(2_000)        // 0.1 kg × PKR 200
  })

  it('removing a sub-recipe line leaves its whole explosion out; the key form works too', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, removedIngredients: [{ key: `r:${sauce}` }, { inventoryItemId: beef }] }])
    const d = await drawn(o.id)
    expect(d.get(tomato) ?? 0).toBe(0)
    expect(d.get(beef) ?? 0).toBe(0)
    expect(d.get(onion)).toBeCloseTo(0.05, 9)
  })

  it('an ingredient not on the recipe, or a packaging line, is 422 and writes nothing', async () => {
    const before = await prisma.order.count({ where: { conceptId: A.conceptId } })
    for (const bad of [{ inventoryItemId: tomato }, { inventoryItemId: box }, { masterIngredientId: randomUUID() }]) {
      await expect(ring(A, [{ menuItemId: A.items.nihari, removedIngredients: [bad] }])).rejects.toMatchObject({ code: 'INGREDIENT_NOT_ON_RECIPE', statusCode: 422 })
    }
    // A dish with an unapproved recipe has nothing removable.
    await expect(ring(A, [{ menuItemId: A.items.kheer, name: 'Kheer', removedIngredients: [{ inventoryItemId: onion }] }]))
      .rejects.toMatchObject({ code: 'INGREDIENT_NOT_ON_RECIPE' })
    expect(await prisma.order.count({ where: { conceptId: A.conceptId } })).toBe(before)
  })

  it("the till's add-items path takes removals through the same check", async () => {
    const t = await ring(A, [{ menuItemId: A.items.water, name: 'Water' }], 'pos')
    await expect(addItemsToPosOrder({
      orderId: t.id, staffId: mgrA.id, staffRole: 'foh_management',
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [], removedIngredients: [{ inventoryItemId: tomato }] }],
    })).rejects.toMatchObject({ code: 'INGREDIENT_NOT_ON_RECIPE' })
    await addItemsToPosOrder({
      orderId: t.id, staffId: mgrA.id, staffRole: 'foh_management', idempotencyKey: randomUUID(),
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [], removedIngredients: [{ masterIngredientId: onionMaster }] }],
    })
    const d = await drawn(t.id)
    expect(d.get(onion) ?? 0).toBe(0)
    expect(d.get(beef)).toBeCloseTo(0.15, 9)
  })
})

describe('add-ons are unchanged', () => {
  it("a modifier's 'removes' recipe still takes the onion out, and never below none with a removal too", async () => {
    const viaMod = await ring(A, [{ menuItemId: A.items.nihari, modifiers: [{ name: 'No onion (add-on)', priceDeltaCents: 0, modifierId: noOnionMod }] }])
    const d = await drawn(viaMod.id)
    expect(d.get(onion) ?? 0).toBe(0)
    expect(d.get(beef)).toBeCloseTo(0.15, 9)
    const both = await ring(A, [{
      menuItemId: A.items.nihari, modifiers: [{ name: 'No onion (add-on)', priceDeltaCents: 0, modifierId: noOnionMod }],
      removedIngredients: [{ masterIngredientId: onionMaster }],
    }])
    const b = await drawn(both.id)
    expect(b.get(onion) ?? 0).toBe(0)
    expect(b.get(beef)).toBeCloseTo(0.15, 9)
  })
})

describe('a till ticket keeps its add-ons (POST /pos/orders dropped modifierId before 2026-10-27)', () => {
  it("an add-on rung at the till keeps its id, so its 'removes' recipe moves stock", async () => {
    const order = await createPosOrder({
      conceptId: A.conceptId, staffId: mgrA.id, staffRole: 'admin',
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [{ name: 'No onion (add-on)', priceDeltaCents: 0, modifierId: noOnionMod }] }],
    })
    const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id }, include: { modifiers: true } })
    expect(line.modifiers.map((m) => m.modifierId)).toEqual([noOnionMod])
    await deductInventoryForOrder(order.id)
    const d = await drawn(order.id)
    expect(d.get(onion) ?? 0).toBe(0)
  })
})

describe('tickets show the removal', () => {
  it('the kitchen board lists "No Onion" next to the add-ons', async () => {
    const station = (await prisma.station.create({ data: { conceptId: A.conceptId, name: `Hot ${Date.now()}` } })).id
    await prisma.menuItem.update({ where: { id: A.items.nihari }, data: { stationId: station } })
    const o = await ring(A, [{ menuItemId: A.items.nihari, removedIngredients: [{ masterIngredientId: onionMaster }] }])
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { stationId: station, status: 'preparing', firedAt: new Date() } })
    const { rows } = cardRows(await loadStationQueue(station, A.tenantId, true))
    const mine = rows.find((r) => r.order.id === o.id)
    expect(mine?.entry.modifiers).toContain('No Onion')
  })
})
