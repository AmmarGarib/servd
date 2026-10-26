// Kitchen flow, part B (owner, 2026-10-26, K4): "Recipes belong to a COMPANY, not a brand … Flipd's recipes are OWNED
// BY GS FOODS and USED by Flipd. Stock and sales stay separate PER OUTLET — a Flipd sale deducts Flipd's outlet stock,
// in Flipd's books." Plus the owner's amendment: recipes cost at the LATEST cost (never the books).
//
// What this guards:
//   - The CEO sets Flipd's recipe owner to GS Foods on the brand (CEO field; anyone else 403); Flipd's dish recipes
//     move to GS Foods.
//   - A GS Foods chef writes Flipd's dish (lines from servd's master → GS Foods' own items) and its sub-recipe; the
//     recipe is GS Foods' (tenantId), approved by GS Foods.
//   - Flipd reads it (200) and never edits it (403 RECIPE_OWNED_BY_OTHER_COMPANY); a third company sees nothing (404).
//   - A Flipd sale deducts FLIPD's outlet stock (its own item for each master — made on the spot when Flipd never
//     stocked it, a shortfall, never a block) and never GS Foods' lots.
//   - A Flipd prep batch of GS Foods' sub-recipe draws Flipd's items and makes Flipd's prep item.
//   - Recipe cost follows a NEW receipt price (latest cost) while the FIFO head, the lots and the sale's posted cost of
//     sales stay at the price paid first.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady, siteOnHand } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { kitchenRoutes } from '../src/modules/kitchen/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let GS: Company
let FL: Company
let C3: Company
const u: Record<string, Who> = {}
const M: Record<string, string> = {}
let seq = 0
let flipdDish: string
let plateId: string
let sauceId: string

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}`, ...extra } })
const PORTFOLIO = { 'x-servd-portfolio': '1' }

function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number, locationId: string, daysAgo = 1) {
  const src = `rcs-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'receipt', lotSourceType: 'goods_receipt_line',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - daysAgo * DAY), locationId,
  }))
}

beforeAll(async () => {
  GS = await mkCompany('rcs-gs')
  FL = await mkCompany('rcs-fl')
  C3 = await mkCompany('rcs-c3')
  for (const co of [GS, FL]) await prisma.conceptLocation.create({ data: { conceptId: co.conceptId, locationId: co.locationId, isPrimary: true } })
  u.ceo = await mkUser('rcsCeo', 'admin', GS.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: FL.tenantId, userId: u.ceo.id } })
  u.chefGS = await mkUser('rcsChefGS', 'boh_management', GS.tenantId)
  u.chefFL = await mkUser('rcsChefFL', 'boh_management', FL.tenantId)
  u.chefC3 = await mkUser('rcsChefC3', 'boh_management', C3.tenantId)
  u.mgmtFL = await mkUser('rcsMgmtFL', 'management', FL.tenantId)
  u.cookGS = await mkUser('rcsCookGS', 'boh', GS.tenantId)
  u.cookFL = await mkUser('rcsCookFL', 'boh', FL.tenantId)
  u.ceoFL = await mkUser('rcsCeoFL', 'admin', FL.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: GS.tenantId, userId: u.ceoFL.id } })
  for (const co of [GS, FL]) await ensureFifoReady(co.tenantId)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.register(crosschecksRoutes)
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.register(kitchenRoutes, { prefix: '/kitchen' })
  await app.ready()

  const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: FL.conceptId } })
  flipdDish = (await prisma.menuItem.create({ data: { conceptId: FL.conceptId, categoryId: cat.id, name: 'Flipd smash', priceCents: 120_000 } })).id
}, 90_000)

afterAll(async () => { await app?.close() })

describe('the brand\'s recipe owner (CEO field)', () => {
  // (The masters are made in the first test: vitest runs the setup's raw-SQL step in parallel with beforeAll.)
  it('servd\'s master ingredients exist', async () => {
  for (const [k, name, cat] of [['beef', 'Beef mince', 'protein'], ['mayo', 'Mayonnaise', 'sauce']] as const) {
    const made = await call(u.chefGS!, 'POST', '/ingredient-master', { name, unit: 'kg', category: cat })
    if (!made.json().id) throw new Error(made.body)
    M[k] = made.json().id
  }
    expect(Object.keys(M)).toHaveLength(2)
  })

  it('only the CEO sets it; it must be one of the CEO\'s companies', async () => {
    expect((await call(u.mgmtFL!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeOwnerTenantId: GS.tenantId })).statusCode).toBe(403)
    const bad = await call(u.ceo!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeOwnerTenantId: C3.tenantId })
    expect(bad.statusCode).toBe(422)
    const ok = await call(u.ceo!, 'PATCH', `/concepts/${FL.conceptId}`, { recipeOwnerTenantId: GS.tenantId })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().recipeOwnerTenantId).toBe(GS.tenantId)
  })
})

describe('GS Foods writes Flipd\'s recipes', () => {
  it('a GS chef creates the sub-recipe and Flipd\'s dish from servd\'s master; both are GS Foods\'', async () => {
    const sauce = await call(u.chefGS!, 'POST', '/recipes', {
      kind: 'component', name: 'Smash sauce', yieldGrams: 1000, portionsPerBatch: 20, portionLabel: 'cup',
      ingredients: [{ masterIngredientId: M.mayo, quantity: 1000, unit: 'g' }],
    })
    expect(sauce.statusCode, sauce.body).toBe(201)
    sauceId = sauce.json().id
    const plate = await call(u.chefGS!, 'POST', '/recipes', {
      kind: 'plate', menuItemId: flipdDish, servings: 1,
      ingredients: [{ masterIngredientId: M.beef, quantity: 150, unit: 'g' }, { prepRecipeId: sauceId, quantity: 50, unit: 'g' }],
    })
    expect(plate.statusCode, plate.body).toBe(201)
    plateId = plate.json().id
    const rows = await prisma.recipe.findMany({ where: { id: { in: [sauceId, plateId] } }, select: { tenantId: true, portionsPerBatch: true } })
    expect(rows.map((r) => r.tenantId)).toEqual([GS.tenantId, GS.tenantId])
    // The lines are GS Foods' own items, each naming its master.
    const lines = await prisma.recipeIngredient.findMany({ where: { recipeId: plateId, inventoryItemId: { not: null } }, include: { inventoryItem: true } })
    expect(lines[0]!.inventoryItem!.tenantId).toBe(GS.tenantId)
    expect(lines[0]!.masterIngredientId).toBe(M.beef)
  })

  it('Flipd reads it (200) but never edits it (403); a third company sees nothing (404)', async () => {
    expect((await call(u.chefFL!, 'GET', `/recipes/${plateId}`)).statusCode).toBe(200)
    const list = (await call(u.chefFL!, 'GET', '/recipes')).json() as Array<{ id: string }>
    expect(list.map((r) => r.id)).toContain(plateId)
    const edit = await call(u.chefFL!, 'PUT', `/recipes/${plateId}`, { servings: 2 })
    expect(edit.statusCode).toBe(403)
    expect(edit.json().error.code).toBe('RECIPE_OWNED_BY_OTHER_COMPANY')
    expect((await call(u.chefFL!, 'PUT', `/recipes/${sauceId}`, { yieldGrams: 900 })).statusCode).toBe(403)
    expect((await call(u.chefC3!, 'GET', `/recipes/${plateId}`)).statusCode).toBe(404)
    expect((await call(u.chefC3!, 'PUT', `/recipes/${plateId}`, { servings: 2 })).statusCode).toBe(404)
    expect((await call(u.chefGS!, 'PUT', `/recipes/${plateId}`, { servings: 1 })).statusCode).toBe(200)
  })
})

describe('Flipd\'s stock and books stay Flipd\'s', () => {
  it('a Flipd prep batch of the GS sub-recipe draws Flipd\'s mayo and makes Flipd\'s prep item', async () => {
    const flMayo = (await call(u.chefFL!, 'POST', '/inventory/from-master', { masterIngredientId: M.mayo })).json().id
    await lot(FL.tenantId, flMayo, 5000, 50, FL.locationId)   // items made from a master are in its base unit (g)
    await prisma.recipe.update({ where: { id: sauceId }, data: { status: 'production' } })
    // 20 cups = one 1000 g batch.
    const r = await call(u.chefFL!, 'POST', '/prep-batches', { recipeId: sauceId, itemName: 'Smash sauce', batches: 1, actualPortions: 20, locationId: FL.locationId })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().actualYieldQty).toBe(1000)
    expect(await siteOnHand(prisma, flMayo, FL.locationId)).toBeCloseTo(4000, 6)
    const prep = await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: sauceId, tenantId: FL.tenantId } })
    expect(await siteOnHand(prisma, prep.id, FL.locationId)).toBeCloseTo(1000, 6)
    expect(await prisma.inventoryItem.count({ where: { prepRecipeId: sauceId, tenantId: GS.tenantId } })).toBe(0)
  })

  it('a Flipd sale deducts Flipd\'s outlet stock (beef made on the spot, a shortfall) and never GS Foods\' lots', async () => {
    const gsBeef = (await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: GS.tenantId, masterIngredientId: M.beef } })).id
    await lot(GS.tenantId, gsBeef, 10_000, 100, GS.locationId)
    const { order } = await ingestOrder({
      source: 'manual', external_id: randomUUID(), concept_id: FL.conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      fulfilment_type: 'dine_in',
      items: [{ externalItemId: '', menuItemId: flipdDish, name: 'Flipd smash', quantity: 2, unitPriceCents: 120_000, modifiers: [] }],
      payment: { provider: null, amountCents: 240_000, status: 'pending' },
    })
    await deductInventoryForOrder(order.id)
    expect(await siteOnHand(prisma, gsBeef, GS.locationId)).toBeCloseTo(10_000, 6)
    const flBeef = await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: FL.tenantId, masterIngredientId: M.beef } })
    const lineIds = (await prisma.orderItem.findMany({ where: { orderId: order.id }, select: { id: true } })).map((l) => l.id)
    const moves = await prisma.stockMovement.findMany({ where: { sourceId: { in: lineIds } } })
    expect(moves.every((m) => m.tenantId === FL.tenantId)).toBe(true)
    expect(moves.some((m) => m.inventoryItemId === gsBeef)).toBe(false)
    // Beef: 2 × 150 g = 300 g — Flipd held none, so it is a shortfall on Flipd's own item; the sauce is Flipd's prep.
    const beefMove = moves.find((m) => m.inventoryItemId === flBeef.id)
    expect(beefMove?.shortfallQty).toBeCloseTo(300, 6)
    const prep = await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: sauceId, tenantId: FL.tenantId } })
    expect(await siteOnHand(prisma, prep.id, FL.locationId)).toBeCloseTo(900, 6)
  })
})

describe('recipes cost at the LATEST cost; the books stay FIFO', () => {
  it('a new receipt price moves the recipe cost, not the FIFO head, the lots or a sale\'s cost of sales', async () => {
    const gsMayo = (await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: GS.tenantId, masterIngredientId: M.mayo } })).id
    await lot(GS.tenantId, gsMayo, 2000, 40, GS.locationId, 3)   // PKR 0.40 / g, older
    await lot(GS.tenantId, gsMayo, 2000, 60, GS.locationId, 1)   // PKR 0.60 / g, latest
    const before = await prisma.stockLot.findMany({ where: { inventoryItemId: gsMayo }, orderBy: { receivedAt: 'asc' } })
    const head = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: gsMayo } })).unitCostCents
    expect(head).toBe(40)                                         // FIFO head: the oldest open lot
    const costing = (await call(u.chefGS!, 'GET', `/recipes/${sauceId}/costing`)).json()
    const line = costing.ingredients[0]
    expect(line.latestCostCents).toBe(60)
    // 1000 g at PKR 0.60 / g = PKR 600 (60,000 paisa) — the latest price, not the FIFO PKR 400.
    expect(line.ingredientCostCents).toBe(60_000)
    const listed = (await call(u.chefGS!, 'GET', '/inventory')).json() as Array<{ id: string; latestCostCents: number; unitCostCents: number }>
    expect(listed.find((i) => i.id === gsMayo)).toMatchObject({ latestCostCents: 60, unitCostCents: 40 })
    // Nothing on the books moved: same lots, same values.
    const after = await prisma.stockLot.findMany({ where: { inventoryItemId: gsMayo }, orderBy: { receivedAt: 'asc' } })
    expect(after.map((l) => [l.remainingQty, l.unitCostCents])).toEqual(before.map((l) => [l.remainingQty, l.unitCostCents]))
    // A sale draws FIFO: the oldest PKR 400 lot first.
    const r = await call(u.chefGS!, 'POST', '/prep-batches', { recipeId: sauceId, itemName: 'Smash sauce', batches: 1, actualYieldQty: 1000, unit: 'g', locationId: GS.locationId })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().drawValueCents).toBe(40_000)
  })

  it('price history on the inventory route: newest first, the cost recipes use', async () => {
    const gsMayo = (await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: GS.tenantId, masterIngredientId: M.mayo } })).id
    await prisma.itemPriceHistory.create({ data: { inventoryItemId: gsMayo, oldCostCents: 40, newCostCents: 60, source: 'po_receive' } })
    const h = await call(u.chefGS!, 'GET', `/inventory/${gsMayo}/price-history`)
    expect(h.statusCode).toBe(200)
    expect(h.json().latest.costCents).toBe(60)
    expect(h.json().rows[0]).toMatchObject({ newCostCents: 60, changePct: 50, sourceLabel: 'Receipt' })
    expect((await call(u.chefFL!, 'GET', `/inventory/${gsMayo}/price-history`)).statusCode).toBe(404)
  })
})

describe('owner review fixes: viewer prices, owner active, twins, not stocked', () => {
  const X: Record<string, string> = {}
  it('GS writes a second Flipd dish: chicken (GS keeps it in kg) and a honey glaze', async () => {
    const chicken = await call(u.chefGS!, 'POST', '/inventory', { name: 'Chicken thigh', unit: 'kg', category: 'protein', unitCostCents: 90_000 })
    expect(chicken.statusCode, chicken.body).toBe(201)
    X.chickenMaster = chicken.json().masterIngredientId
    const honey = await call(u.chefGS!, 'POST', '/inventory', { name: 'Honey', unit: 'kg', category: 'sauce', unitCostCents: 80_000 })
    X.honeyMaster = honey.json().masterIngredientId
    const glaze = await call(u.chefGS!, 'POST', '/recipes', {
      kind: 'component', name: 'Honey glaze', yieldGrams: 500, portionsPerBatch: 5,
      ingredients: [{ masterIngredientId: X.honeyMaster, quantity: 500, unit: 'g' }],
    })
    expect(glaze.statusCode, glaze.body).toBe(201)
    X.glaze = glaze.json().id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: FL.conceptId } })
    X.dish = (await prisma.menuItem.create({ data: { conceptId: FL.conceptId, categoryId: cat.id, name: 'Flipd wings', priceCents: 90_000 } })).id
    X.dish3 = (await prisma.menuItem.create({ data: { conceptId: FL.conceptId, categoryId: cat.id, name: 'Flipd fries', priceCents: 40_000 } })).id
    const plate = await call(u.chefGS!, 'POST', '/recipes', {
      kind: 'plate', menuItemId: X.dish, servings: 1,
      ingredients: [{ masterIngredientId: X.chickenMaster, quantity: 200, unit: 'g' }, { prepRecipeId: X.glaze, quantity: 100, unit: 'g' }],
    })
    expect(plate.statusCode, plate.body).toBe(201)
  })

  it('costing shows ONLY the viewing company\'s prices: GS sees honey; Flipd sees "Not stocked by …", no price', async () => {
    const gs = (await call(u.chefGS!, 'GET', `/recipes/${X.glaze}/costing`)).json()
    expect(gs.ingredients[0]).toMatchObject({ ingredientCostCents: 40_000, notStockedBy: null })
    const fl = (await call(u.chefFL!, 'GET', `/recipes/${X.glaze}/costing`)).json()
    expect(fl.ingredients[0]).toMatchObject({ ingredientCostCents: 0, latestCostCents: null, notStockedBy: 'Co rcs-fl' })
    const list = (await call(u.chefFL!, 'GET', '/recipes')).json() as Array<{ id: string; ingredients: Array<{ inventoryItem: { unitCostCents: number | null } | null; notStockedBy: string | null }> }>
    const row = list.find((r) => r.id === X.glaze)!
    expect(row.ingredients[0]!.inventoryItem!.unitCostCents).toBeNull()
    expect(row.ingredients[0]!.notStockedBy).toBe('Co rcs-fl')
    // The detail never shows GS Foods' item (id, stock, category) to Flipd: Flipd does not stock honey → none.
    const detail = (await call(u.chefFL!, 'GET', `/recipes/${X.glaze}`)).json()
    expect(detail.ingredients[0]).toMatchObject({ inventoryItem: null, inventoryItemId: null, notStockedBy: 'Co rcs-fl' })
    const hidden = (await call(u.cookFL!, 'GET', `/recipes/${X.glaze}`)).json()
    expect(hidden.ingredients[0]).toMatchObject({ inventoryItem: null, inventoryItemId: null })
    expect(JSON.stringify(hidden)).not.toContain(X.honeyMaster ? (await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: GS.tenantId, masterIngredientId: X.honeyMaster } })).id : 'x')
  })

  it('a cost-hidden login (boh) gets no latest cost either', async () => {
    const rows = (await call(u.cookGS!, 'GET', '/recipes')).json() as Array<{ ingredients: Array<Record<string, unknown>> }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) for (const i of r.ingredients) {
      expect(i.latestCostCents ?? null).toBeNull()
      expect(i.latestCostAt ?? null).toBeNull()
    }
  })

  it('a Flipd-only login cannot write a Flipd dish whose recipes GS Foods owns: 422 RECIPE_OWNER_NOT_ACTIVE, nothing made in GS', async () => {
    const before = await prisma.inventoryItem.count({ where: { tenantId: GS.tenantId } })
    const r = await call(u.chefFL!, 'POST', '/recipes', { kind: 'plate', menuItemId: X.dish3, servings: 1, ingredients: [{ masterIngredientId: X.honeyMaster, quantity: 10, unit: 'g' }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('RECIPE_OWNER_NOT_ACTIVE')
    expect(await prisma.inventoryItem.count({ where: { tenantId: GS.tenantId } })).toBe(before)
  })

  it('the shopping list lists an ingredient Flipd never stocked as "not stocked yet", never drops it', async () => {
    const weekday = new Date(Date.now() + 5 * 3_600_000).getUTCDay()
    const par = await call(u.chefFL!, 'PUT', '/kitchen/par-targets', { locationId: FL.locationId, targets: [{ recipeId: X.glaze, weekday, portions: 5 }] })
    expect(par.statusCode, par.body).toBe(200)
    const r = await call(u.chefFL!, 'GET', `/kitchen/shopping-list?locationId=${FL.locationId}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().notStocked).toEqual([expect.objectContaining({ masterIngredientId: X.honeyMaster, name: 'Honey', unit: 'g', qty: 500 })])
    expect(JSON.stringify(r.json().groups)).not.toContain('Honey')
  })

  it('a Flipd sale of the GS dish draws Flipd\'s EXISTING chicken in g (GS keeps kg) — nothing new made', async () => {
    const flChicken = await prisma.inventoryItem.create({ data: { name: 'chicken  thigh', unit: 'g', tenantId: FL.tenantId, category: 'protein' } })
    await lot(FL.tenantId, flChicken.id, 5000, 100, FL.locationId)
    const { order } = await ingestOrder({
      source: 'manual', external_id: randomUUID(), concept_id: FL.conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      fulfilment_type: 'dine_in',
      items: [{ externalItemId: '', menuItemId: X.dish, name: 'Flipd wings', quantity: 1, unitPriceCents: 90_000, modifiers: [] }],
      payment: { provider: null, amountCents: 90_000, status: 'pending' },
    })
    await deductInventoryForOrder(order.id)
    expect(await siteOnHand(prisma, flChicken.id, FL.locationId)).toBeCloseTo(4800, 6)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flChicken.id } })).masterIngredientId).toBe(X.chickenMaster)
    expect(await prisma.inventoryItem.count({ where: { tenantId: FL.tenantId, masterIngredientId: X.chickenMaster } })).toBe(1)
  })
})

describe('portfolio pricing and legacy duplicates (owner review N1, N5)', () => {
  const Y: Record<string, string> = {}
  it('the CEO sees a GS Foods dish at GS prices and a Flipd dish at Flipd prices, whichever company is active', async () => {
    // GS Foods' own dish (its brand) with the same chicken line.
    const gsChicken = (await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: GS.tenantId, name: 'Chicken thigh' } })).id
    const gsPlate = await prisma.recipe.create({ data: {
      kind: 'plate', menuItemId: GS.items.nihari, servings: 1, tenantId: GS.tenantId,
      ingredients: { create: [{ inventoryItemId: gsChicken, masterIngredientId: (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: gsChicken } })).masterIngredientId, quantity: 200, unit: 'g' }] },
    } })
    Y.gsPlate = gsPlate.id
    Y.flPlate = (await prisma.recipe.findFirstOrThrow({ where: { menuItem: { name: 'Flipd wings' } } })).id
    const chickenCost = (c: { ingredients: Array<{ name: string; ingredientCostCents: number }> }) => c.ingredients.find((i) => /chicken/i.test(i.name))!.ingredientCostCents
    for (const who of [u.ceo!, u.ceoFL!]) {
      // GS: 200 g at PKR 900 / kg (typed) = 18,000; Flipd: 200 g at its lot's PKR 1 / g = 20,000.
      // The CEO's portfolio view, whichever company is active.
      expect(chickenCost((await call(who, 'GET', `/recipes/${Y.gsPlate}/costing`, undefined, PORTFOLIO)).json())).toBe(18_000)
      expect(chickenCost((await call(who, 'GET', `/recipes/${Y.flPlate}/costing`, undefined, PORTFOLIO)).json())).toBe(20_000)
    }
    // A Flipd-only viewer: Flipd's own price, and GS Foods' own dish is not even visible.
    expect(chickenCost((await call(u.chefFL!, 'GET', `/recipes/${Y.flPlate}/costing`)).json())).toBe(20_000)
    expect((await call(u.chefFL!, 'GET', `/recipes/${Y.gsPlate}/costing`)).statusCode).toBe(404)
    const listFL = (await call(u.chefFL!, 'GET', '/recipes')).json() as Array<{ id: string; ingredients: Array<{ inventoryItem: { unitCostCents: number | null } | null }> }>
    expect(JSON.stringify(listFL)).not.toContain('"unitCostCents":90000')
  })

  it('a company-less legacy line keeps its typed cost', async () => {
    const legacy = await prisma.inventoryItem.create({ data: { name: 'Legacy salt', unit: 'kg', tenantId: null, unitCostCents: 5_000 } })
    const comp = await prisma.recipe.create({ data: { kind: 'component', name: 'Legacy brine', yieldGrams: 1000, tenantId: GS.tenantId, ingredients: { create: [{ inventoryItemId: legacy.id, quantity: 1000, unit: 'g' }] } } })
    const c = (await call(u.chefGS!, 'GET', `/recipes/${comp.id}/costing`)).json()
    expect(c.ingredients[0]).toMatchObject({ ingredientCostCents: 5_000, notStockedBy: null })
  })

  it('a sale on a legacy "(duplicate 2)" ingredient draws the using company\'s existing Flour — no "(duplicate" item made', async () => {
    const dup = await prisma.ingredientMaster.create({ data: { name: 'Flour (duplicate 2)', normalizedName: 'flour (duplicate 2)', stockUnit: 'g', status: 'needs_review' } })
    const gsFlour = await prisma.inventoryItem.create({ data: { name: 'flour', unit: 'g', tenantId: GS.tenantId, masterIngredientId: dup.id } })
    const flFlour = await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', tenantId: FL.tenantId } })
    await lot(FL.tenantId, flFlour.id, 5, 10_000, FL.locationId)
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: FL.conceptId } })
    const dish = await prisma.menuItem.create({ data: { conceptId: FL.conceptId, categoryId: cat.id, name: 'Flipd roti', priceCents: 10_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish.id, servings: 1, tenantId: GS.tenantId, ingredients: { create: [{ inventoryItemId: gsFlour.id, masterIngredientId: dup.id, quantity: 250, unit: 'g' }] } } })
    const { order } = await ingestOrder({
      source: 'manual', external_id: randomUUID(), concept_id: FL.conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      fulfilment_type: 'dine_in',
      items: [{ externalItemId: '', menuItemId: dish.id, name: 'Flipd roti', quantity: 2, unitPriceCents: 10_000, modifiers: [] }],
      payment: { provider: null, amountCents: 20_000, status: 'pending' },
    })
    await deductInventoryForOrder(order.id)
    expect(await siteOnHand(prisma, flFlour.id, FL.locationId)).toBeCloseTo(4.5, 6)
    expect(await prisma.inventoryItem.count({ where: { tenantId: FL.tenantId, name: { contains: 'duplicate' } } })).toBe(0)
  })

  it('a company with no flour gets one under the BASE name, flagged for review', async () => {
    const { ensureCompanyItemForMasterTx } = await import('../src/lib/ingredientMaster.js')
    const dup = await prisma.ingredientMaster.findFirstOrThrow({ where: { normalizedName: 'flour (duplicate 2)' } })
    const C3item = await prisma.$transaction((tx) => ensureCompanyItemForMasterTx(tx, C3.tenantId, dup.id))
    expect(C3item).toMatchObject({ created: true, name: 'Flour' })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'ingredient_master_unlinked', entityId: C3item.id } })).toBe(1)
  })

  it('a BASE master takes the company\'s item already on a "(duplicate N)" master — never a second Rice', async () => {
    const { ensureCompanyItemForMasterTx } = await import('../src/lib/ingredientMaster.js')
    const base = await prisma.ingredientMaster.create({ data: { name: 'Rice', normalizedName: 'rice', stockUnit: 'g', status: 'approved' } })
    const dup = await prisma.ingredientMaster.create({ data: { name: 'Rice (duplicate 3)', normalizedName: 'rice (duplicate 3)', stockUnit: 'g', status: 'needs_review' } })
    const flRice = await prisma.inventoryItem.create({ data: { name: 'Rice', unit: 'kg', tenantId: FL.tenantId, masterIngredientId: dup.id } })
    const got = await prisma.$transaction((tx) => ensureCompanyItemForMasterTx(tx, FL.tenantId, base.id))
    expect(got).toMatchObject({ id: flRice.id, created: false })
    expect(await prisma.inventoryItem.count({ where: { tenantId: FL.tenantId, deletedAt: null, name: { equals: 'rice', mode: 'insensitive' } } })).toBe(1)
    // A duplicate master of another unit family is not the same ingredient.
    const dupMl = await prisma.ingredientMaster.create({ data: { name: 'Vinegar (duplicate 2)', normalizedName: 'vinegar (duplicate 2)', stockUnit: 'ml', status: 'needs_review' } })
    await prisma.inventoryItem.create({ data: { name: 'Vinegar', unit: 'ml', tenantId: FL.tenantId, masterIngredientId: dupMl.id } })
    const baseG = await prisma.ingredientMaster.create({ data: { name: 'Vinegar', normalizedName: 'vinegar', stockUnit: 'g', status: 'approved' } })
    const made = await prisma.$transaction((tx) => ensureCompanyItemForMasterTx(tx, FL.tenantId, baseG.id))
    expect(made.created).toBe(true)
  })

  it('pricing follows the company being VIEWED: single-company Flipd prices GS Foods\' sub-recipe at Flipd', async () => {
    const { ensureCompanyItemForMasterTx } = await import('../src/lib/ingredientMaster.js')
    const flMayo = await prisma.$transaction((tx) => ensureCompanyItemForMasterTx(tx, FL.tenantId, M.mayo!))
    await lot(FL.tenantId, flMayo.id, 1000, 90, FL.locationId, 0)   // Flipd's latest: PKR 0.90 / g
    const mayo = (c: { ingredients: Array<{ latestCostCents: number | null }> }) => c.ingredients[0]!.latestCostCents
    const single = await call(u.ceoFL!, 'GET', `/recipes/${sauceId}/costing`)
    expect(single.statusCode, single.body).toBe(200)
    expect(mayo(single.json())).toBe(90)
    const portfolio = await call(u.ceoFL!, 'GET', `/recipes/${sauceId}/costing`, undefined, PORTFOLIO)
    expect(mayo(portfolio.json())).toBe(60)                          // its own company, GS Foods, in portfolio view
  })
})
