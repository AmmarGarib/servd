// Stock deducted by sales — prep as stock, units, counts, the weekly variance, the recipe gate (owner card 2026-10-24).
//
// What this guards (the card's "done when"):
//   - Selling one smash burger at a site lowers raw beef by 167 g (150 g at 90 % yield), buns by 1, cheese by 20 g and
//     the sauce by 30 g AT THAT SITE — the bun and the sauce are PREP ITEMS (D3), never their raw ingredients again.
//   - A bun batch lowers flour, butter and eggs and RAISES bun stock: one lot at the ACTUAL yield valued at exactly
//     the raw value drawn; short → 409 INSUFFICIENT_STOCK listing every short item, nothing kept.
//   - The weekly variance lists each tracked item's recipe usage, actual usage and rupee gap (worst first), per site;
//     CSV export; another company's outlet is 404.
//   - Units: a dock line in the purchase unit ("case" of 12) lands as 12 × stock units at cost ÷ 12.
//   - Counts: GET /physical-counts/due (daily every day, weekly until counted this week); whoever raised a PO of the
//     item in the last 14 days cannot count it (403 COUNTER_ORDERS_ITEM; the CEO can).
//   - GET /inventory/negative lists a site's unsettled sale shortfall; company B sees none of A's.
//   - Recipe gate: a dish is switched on only with a production recipe (422 RECIPE_NOT_APPROVED); live ones without
//     are listed, never switched off.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady, siteOnHand } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'
import { ensurePrepItemTx } from '../src/modules/inventory/prepItems.js'
import { consumptionPerLine } from '../src/lib/recipeCost.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { menuRoutes } from '../src/modules/menu/routes.js'
import foodCostRoutes from '../src/modules/reports/foodCostRoutes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0
const I: Record<string, string> = {}
let bunRecipe: string
let sauceRecipe: string
let burger: string

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function mk(name: string, unit: string, category = 'protein') {
  return (await prisma.inventoryItem.create({ data: { name, unit, tenantId: A.tenantId, category, unitCostCents: 1_000 } })).id
}
function lot(itemId: string, qty: number, unitCostCents: number, locationId = A.locationId) {
  const src = `pas-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'opening', lotSourceType: 'opening',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - DAY), locationId,
  }))
}
const onHand = (itemId: string, locationId = A.locationId) => siteOnHand(prisma, itemId, locationId)

async function sell(menuItemId: string, quantity = 1) {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: 'dine_in',
    items: [{ externalItemId: '', menuItemId, name: 'Smash burger', quantity, unitPriceCents: 100_000, modifiers: [] }],
    payment: { provider: null, amountCents: 100_000 * quantity, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  return order.id
}

beforeAll(async () => {
  A = await mkCompany('pas-a')
  B = await mkCompany('pas-b')
  // The brand cooks at A's outlet (its primary site).
  await prisma.conceptLocation.create({ data: { conceptId: A.conceptId, locationId: A.locationId, isPrimary: true } })
  u.chefA = await mkUser('pasChefA', 'boh_management', A.tenantId)
  u.mgrA = await mkUser('pasMgrA', 'manager', A.tenantId)
  u.cookA = await mkUser('pasCookA', 'boh', A.tenantId)
  u.ceoA = await mkUser('pasCeoA', 'admin', A.tenantId)
  u.finA = await mkUser('pasFinA', 'finance', A.tenantId)
  u.mgrB = await mkUser('pasMgrB', 'manager', B.tenantId)
  u.finB = await mkUser('pasFinB', 'finance', B.tenantId)
  await ensureFifoReady(A.tenantId)
  await ensureFifoReady(B.tenantId)

  I.beef = await mk('Beef mince', 'kg')
  I.cheese = await mk('Cheddar', 'kg', 'dairy')
  I.flour = await mk('Flour', 'kg', 'dry_goods')
  I.butter = await mk('Butter', 'kg', 'dairy')
  I.eggs = await mk('Eggs', 'pcs', 'dairy')
  I.mayo = await mk('Mayonnaise', 'kg', 'sauce')

  // Bun: a batch of 10 pcs = 1 kg flour, 100 g butter, 2 eggs. Sauce: a batch of 1000 g = 1000 g mayo.
  bunRecipe = (await prisma.recipe.create({ data: {
    kind: 'component', name: 'Brioche bun', yieldGrams: 10, yieldUnit: 'pcs', status: 'production',
    ingredients: { create: [{ inventoryItemId: I.flour, quantity: 1000, unit: 'g' }, { inventoryItemId: I.butter, quantity: 100, unit: 'g' }, { inventoryItemId: I.eggs, quantity: 2, unit: 'pcs' }] },
  } })).id
  sauceRecipe = (await prisma.recipe.create({ data: {
    kind: 'component', name: 'Smash sauce', yieldGrams: 1000, status: 'production',
    ingredients: { create: [{ inventoryItemId: I.mayo, quantity: 1000, unit: 'g' }] },
  } })).id
  const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
  burger = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Smash burger', priceCents: 100_000 } })).id
  await prisma.recipe.create({ data: {
    kind: 'plate', menuItemId: burger, servings: 1, status: 'production',
    ingredients: { create: [
      { inventoryItemId: I.beef, quantity: 150, yieldPct: 0.9, unit: 'g' },
      { prepRecipeId: bunRecipe, quantity: 1, unit: 'pcs' },
      { inventoryItemId: I.cheese, quantity: 20, unit: 'g' },
      { prepRecipeId: sauceRecipe, quantity: 30, unit: 'g' },
    ] },
  } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crosschecksRoutes)
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.register(foodCostRoutes, { prefix: '/reports/food-cost' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('prep batches make prep stock', () => {
  it('short → 409 INSUFFICIENT_STOCK listing every short item; nothing kept', async () => {
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: bunRecipe, itemName: 'Brioche bun', batches: 1, actualYieldQty: 10, unit: 'pcs', locationId: A.locationId })
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('INSUFFICIENT_STOCK')
    expect((r.json().error.details.short as Array<{ inventoryItemId: string }>).map((x) => x.inventoryItemId).sort()).toEqual([I.butter, I.eggs, I.flour].sort())
    expect(await prisma.prepBatch.count({ where: { recipeId: bunRecipe } })).toBe(0)
  })

  it('a bun batch lowers flour, butter and eggs and RAISES bun stock at the drawn value', async () => {
    await lot(I.flour, 5, 10_000)      // PKR 100 / kg
    await lot(I.butter, 1, 200_000)    // PKR 2,000 / kg
    await lot(I.eggs, 30, 3_000)       // PKR 30 each
    await lot(I.mayo, 2, 50_000)
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: bunRecipe, itemName: 'Brioche bun', batches: 2, actualYieldQty: 19, unit: 'pcs', locationId: A.locationId })
    expect(r.statusCode, r.body).toBe(201)
    // 2 batches: flour 2 kg (20,000), butter 0.2 kg (40,000), eggs 4 (12,000) = 72,000.
    expect(r.json()).toMatchObject({ drawValueCents: 72_000, expectedYieldQty: 20, made: { qty: 19, unit: 'pcs', valueCents: 72_000 } })
    expect(r.json().yieldVariancePct).toBeCloseTo(0.95)
    expect(await onHand(I.flour)).toBeCloseTo(3)
    expect(await onHand(I.butter)).toBeCloseTo(0.8)
    expect(await onHand(I.eggs)).toBe(26)
    const bun = await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: bunRecipe, tenantId: A.tenantId } })
    expect(bun).toMatchObject({ kind: 'prep', unit: 'pcs', tenantId: A.tenantId })
    expect(await onHand(bun.id)).toBe(19)
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: bun.id } })
    expect(lots).toHaveLength(1)
    expect(Number(lots[0]!.valueInCents)).toBe(72_000)
    // Raw → prep is 12x0 → 12x0: no prep-draw entry.
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.prep_draw:${r.json().id}` } })).toBe(0)
    const s = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: sauceRecipe, itemName: 'Smash sauce', actualYieldQty: 1000, unit: 'g', locationId: A.locationId })
    expect(s.statusCode, s.body).toBe(201)
  })

  it('selling one smash burger lowers beef 167 g, a bun, cheese 20 g and sauce 30 g at that site — raw bun/sauce inputs untouched', async () => {
    await lot(I.beef, 10, 120_000)
    await lot(I.cheese, 2, 150_000)
    const bun = (await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: bunRecipe, tenantId: A.tenantId } })).id
    const sauce = (await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: sauceRecipe, tenantId: A.tenantId } })).id
    const before = { beef: await onHand(I.beef), cheese: await onHand(I.cheese), bun: await onHand(bun), sauce: await onHand(sauce), flour: await onHand(I.flour), mayo: await onHand(I.mayo) }
    await sell(burger)
    expect(before.beef - await onHand(I.beef)).toBeCloseTo(0.16667, 4)
    expect(before.bun - await onHand(bun)).toBeCloseTo(1, 6)
    expect(before.cheese - await onHand(I.cheese)).toBeCloseTo(0.02, 6)
    expect(before.sauce - await onHand(sauce)).toBeCloseTo(30, 6)
    expect(await onHand(I.flour)).toBeCloseTo(before.flour, 9)
    expect(await onHand(I.mayo)).toBeCloseTo(before.mayo, 9)
  })

  it('B cannot batch A\'s prep recipe; a prep item belongs to one company', async () => {
    const r = await call(u.mgrB!, 'POST', '/prep-batches', { recipeId: bunRecipe, itemName: 'x', actualYieldQty: 1, unit: 'pcs' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('RECIPE_NOT_IN_COMPANY')
    await expect(ensurePrepItemTx(prisma, bunRecipe, B.tenantId)).rejects.toMatchObject({ code: 'RECIPE_NOT_IN_COMPANY' })
  })
})

describe('the weekly variance', () => {
  it('lists recipe usage, actual usage and the rupee gap per site, worst first; CSV; another company\'s outlet 404', async () => {
    // A count finds 1 kg of beef missing: actual usage beyond the recipe = the gap.
    const book = await onHand(I.beef)
    const c = await call(u.chefA!, 'POST', '/physical-counts', { locationId: A.locationId, lines: [{ inventoryItemId: I.beef, physicalQty: book - 1, reason: 'missing from walk-in' }] })
    expect(c.statusCode, c.body).toBe(201)
    const weekOf = new Date().toISOString().slice(0, 10)
    const r = await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&locationId=${A.locationId}`)
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Array<{ inventoryItemId: string; actual: { qty: number; cents: number }; recipe: { qty: number }; gap: { qty: number; cents: number } }>
    expect(rows[0]!.inventoryItemId).toBe(I.beef)
    const beef = rows[0]!
    expect(beef.recipe.qty).toBeCloseTo(0.167, 3)
    expect(beef.gap.qty).toBeCloseTo(1, 3)
    expect(beef.gap.cents).toBe(120_000)
    expect(beef.actual.qty).toBeCloseTo(1.167, 3)
    const flour = rows.find((x) => x.inventoryItemId === I.flour)!
    expect(flour.gap.qty).toBeCloseTo(0, 6)                                  // drawn into buns: explained (prep)
    const company = await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&tenantId=${A.tenantId}`)
    expect(company.statusCode).toBe(200)
    expect((company.json().sites as Array<{ locationId: string }>).some((s) => s.locationId === A.locationId)).toBe(true)
    const csv = await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&locationId=${A.locationId}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Gap PKR')
    expect((await call(u.finB!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&locationId=${A.locationId}`)).statusCode).toBe(404)
  })
})

describe('units, counts, negative stock', () => {
  it('a dock line in the purchase unit converts: 2 cases of 12 → 24 pcs at cost ÷ 12', async () => {
    const cans = await mk('Cola can', 'pcs', 'beverage')
    await prisma.inventoryItem.update({ where: { id: cans }, data: { purchaseUnit: 'case', purchaseUnitFactor: 12 } })
    const sup = await prisma.supplier.create({ data: { name: 'Drinks Co', tenantId: A.tenantId } })
    const r = await call(u.mgrA!, 'POST', '/receiving', {
      supplierId: sup.id, locationId: A.locationId, photoUrl: 'https://x.test/dock.jpg',
      lines: [{ inventoryItemId: cans, quantityReceived: 2, unitCostCents: 120_000, unit: 'case' }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(await onHand(cans)).toBe(24)
    const lot0 = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: cans } })
    expect(lot0.unitCostCents).toBe(10_000)
    expect(Number(lot0.valueInCents)).toBe(240_000)
  })

  it('counts due: daily items every day, weekly until counted this week; a PO raiser cannot count its item (CEO can)', async () => {
    await prisma.inventoryItem.update({ where: { id: I.cheese }, data: { countFrequency: 'daily' } })
    const due = await call(u.cookA!, 'GET', `/physical-counts/due?locationId=${A.locationId}`)
    expect(due.statusCode, due.body).toBe(200)
    const ids = (due.json().items as Array<{ id: string }>).map((x) => x.id)
    expect(ids).toContain(I.cheese)
    expect(ids).not.toContain(I.beef)                        // counted this week (above)
    expect(ids).toContain(I.flour)

    const sup = await prisma.supplier.create({ data: { name: 'Dairy Co', tenantId: A.tenantId } })
    await prisma.purchaseOrder.create({ data: { supplierId: sup.id, status: 'sent', createdBy: u.mgrA!.id, lines: { create: [{ inventoryItemId: I.cheese, quantityOrdered: 5, unitCostCents: 150_000 }] } } })
    const book = await onHand(I.cheese)
    const refused = await call(u.mgrA!, 'POST', '/physical-counts', { locationId: A.locationId, lines: [{ inventoryItemId: I.cheese, physicalQty: book }] })
    expect(refused.statusCode).toBe(403)
    expect(refused.json().error.code).toBe('COUNTER_ORDERS_ITEM')
    expect((await call(u.ceoA!, 'POST', '/physical-counts', { locationId: A.locationId, lines: [{ inventoryItemId: I.cheese, physicalQty: book }] })).statusCode).toBe(201)
    const after = (await call(u.cookA!, 'GET', `/physical-counts/due?locationId=${A.locationId}`)).json().items as Array<{ id: string }>
    expect(after.map((x) => x.id)).not.toContain(I.cheese)
  })

  it('GET /inventory/negative lists a site\'s unsettled sale shortfall; B sees none of A\'s', async () => {
    const pickle = await mk('Pickles', 'kg', 'produce')
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Pickle plate', priceCents: 10_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish, servings: 1, status: 'production', ingredients: { create: [{ inventoryItemId: pickle, quantity: 200, unit: 'g' }] } } })
    await sell(dish, 2)
    const neg = await call(u.mgrA!, 'GET', `/inventory/negative?locationId=${A.locationId}`)
    expect(neg.statusCode, neg.body).toBe(200)
    const row = (neg.json().items as Array<{ inventoryItemId: string; shortQty: number; locationId: string }>).find((x) => x.inventoryItemId === pickle)
    expect(row).toMatchObject({ locationId: A.locationId })
    expect(row!.shortQty).toBeCloseTo(0.4)
    const b = await call(u.mgrB!, 'GET', '/inventory/negative')
    expect((b.json().items as Array<{ inventoryItemId: string }>).some((x) => x.inventoryItemId === pickle)).toBe(false)
    expect((await call(u.mgrB!, 'GET', `/inventory/negative?locationId=${A.locationId}`)).statusCode).toBe(422)
  })
})

describe('the recipe gate', () => {
  it('a dish goes live only with an approved recipe; live ones without are listed, not switched off', async () => {
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const live = await call(u.mgrA!, 'POST', '/menu/items', { conceptId: A.conceptId, categoryId: cat.id, name: 'New wrap', priceCents: 50_000, isAvailable: true })
    expect(live.statusCode).toBe(422)
    expect(live.json().error.code).toBe('RECIPE_NOT_APPROVED')
    const off = await call(u.mgrA!, 'POST', '/menu/items', { conceptId: A.conceptId, categoryId: cat.id, name: 'New wrap', priceCents: 50_000 })
    expect(off.statusCode, off.body).toBe(201)
    expect(off.json().isAvailable).toBe(false)
    const id = off.json().id as string
    const on = await call(u.mgrA!, 'PATCH', `/menu/items/${id}/availability`, { isAvailable: true })
    expect(on.statusCode).toBe(422)
    expect(on.json().error.code).toBe('RECIPE_NOT_APPROVED')
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, servings: 1, status: 'pending_approval' } })
    expect((await call(u.mgrA!, 'PATCH', `/menu/items/${id}`, { isAvailable: true })).statusCode).toBe(422)
    await prisma.recipe.update({ where: { menuItemId: id }, data: { status: 'production' } })
    expect((await call(u.mgrA!, 'PATCH', `/menu/items/${id}/availability`, { isAvailable: true })).statusCode).toBe(200)

    // A legacy dish, live with no recipe: listed, and still live.
    const legacy = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Legacy fries', priceCents: 20_000, isAvailable: true } })
    const list = await call(u.mgrA!, 'GET', '/menu/items/live-without-recipe')
    expect(list.statusCode).toBe(200)
    expect((list.json() as Array<{ id: string }>).map((x) => x.id)).toContain(legacy.id)
    expect((list.json() as Array<{ id: string }>).map((x) => x.id)).not.toContain(id)
    expect(((await call(u.mgrB!, 'GET', '/menu/items/live-without-recipe')).json() as Array<{ id: string }>).some((x) => x.id === legacy.id)).toBe(false)
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: legacy.id } })).isAvailable).toBe(true)
  })
})

describe('review fixes (2026-10-24)', () => {
  it('prep is stock per SITE: a site that never held the prep item still draws its raw ingredients', async () => {
    const A2 = (await prisma.location.create({ data: { slug: 'loc-pas-a2', name: 'A2', tenantId: A.tenantId } })).id
    const line = { menuItemId: burger, quantity: 1, status: 'pending', serviceVessel: 'plate', boxGiven: false }
    const opts = { tenantId: A.tenantId, fulfilmentType: 'dine_in', serviceVessel: 'plate' }
    const bun = (await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: bunRecipe, tenantId: A.tenantId } })).id
    const [atA] = await prisma.$transaction((tx) => consumptionPerLine([line], tx, { ...opts, prepStockAt: { siteId: A.locationId } }))
    expect(atA!.need.has(bun)).toBe(true)
    expect(atA!.need.has(I.flour)).toBe(false)
    const [atA2] = await prisma.$transaction((tx) => consumptionPerLine([line], tx, { ...opts, prepStockAt: { siteId: A2 } }))
    expect(atA2!.need.has(bun)).toBe(false)
    expect(atA2!.need.get(I.flour)!.qty).toBeCloseTo(0.1, 6)          // one bun = a tenth of a batch: 100 g flour
    expect(atA2!.need.get(I.mayo)!.qty).toBeCloseTo(0.03, 6)
  })

  it('a recipe batch never draws an issued-on-receipt ingredient', async () => {
    const salt = await mk('Salt', 'kg', 'dry_goods')
    await prisma.inventoryItem.update({ where: { id: salt }, data: { issueOnReceipt: true } })
    const rec = (await prisma.recipe.create({ data: {
      kind: 'component', name: 'Seasoned mayo', yieldGrams: 500, status: 'production',
      ingredients: { create: [{ inventoryItemId: I.mayo, quantity: 490, unit: 'g' }, { inventoryItemId: salt, quantity: 10, unit: 'g' }] },
    } })).id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Dip', priceCents: 10_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish, servings: 1, status: 'production', ingredients: { create: [{ prepRecipeId: rec, quantity: 20, unit: 'g' }] } } })
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: rec, itemName: 'Seasoned mayo', actualYieldQty: 500, unit: 'g', locationId: A.locationId })
    expect(r.statusCode, r.body).toBe(201)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: salt } })).toBe(0)
  })

  it('the unused-ingredient clean-up never lists a prep item', async () => {
    const res = await call(u.ceoA!, 'GET', '/inventory/unused-cleanup')
    expect(res.statusCode, res.body).toBe(200)
    const prepIds = (await prisma.inventoryItem.findMany({ where: { tenantId: A.tenantId, kind: 'prep' }, select: { id: true } })).map((x) => x.id)
    expect(prepIds.length).toBeGreaterThan(0)
    const listed = [...res.json().toMove, ...res.json().skipped].map((x: { id: string }) => x.id)
    expect(listed.some((id: string) => prepIds.includes(id))).toBe(false)
  })

  it('a purchase-unit dock line is worth exactly what was typed', async () => {
    const jars = await mk('Pickle jar', 'pcs', 'produce')
    await prisma.inventoryItem.update({ where: { id: jars }, data: { purchaseUnit: 'box', purchaseUnitFactor: 7 } })
    const sup = await prisma.supplier.create({ data: { name: 'Jar Co', tenantId: A.tenantId } })
    const r = await call(u.mgrA!, 'POST', '/receiving', {
      supplierId: sup.id, locationId: A.locationId, photoUrl: 'https://x.test/dock.jpg',
      lines: [{ inventoryItemId: jars, quantityReceived: 3, unitCostCents: 1_000, unit: 'box' }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: jars } })
    expect(lot.qtyIn).toBe(21)
    expect(Number(lot.valueInCents)).toBe(3_000)            // not 21 × round(1000 / 7) = 3,003
  })

  it('the recipe gate exempts only dishes live at go-live (liveAtRecipeGate)', async () => {
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const old = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Old fries', priceCents: 20_000, isAvailable: false, liveAtRecipeGate: true } })
    const other = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Old wings', priceCents: 20_000, isAvailable: false } })
    expect((await call(u.mgrA!, 'PATCH', `/menu/items/${old.id}/availability`, { isAvailable: true })).statusCode).toBe(200)
    const no = await call(u.mgrA!, 'PATCH', `/menu/items/${other.id}/availability`, { isAvailable: true })
    expect(no.statusCode).toBe(422)
    expect(no.json().error.code).toBe('RECIPE_NOT_APPROVED')
  })

  it('weekly variance: prep value counted once in the company totals; "counted" is per site', async () => {
    const weekOf = new Date().toISOString().slice(0, 10)
    const r = await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&tenantId=${A.tenantId}`)
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Array<{ actual: { cents: number }; prepToStock: { cents: number } }>
    const sumActual = rows.reduce((t, x) => t + x.actual.cents, 0)
    const toStock = rows.reduce((t, x) => t + x.prepToStock.cents, 0)
    expect(toStock).toBeGreaterThan(0)
    expect(r.json().totals.actualCents).toBe(sumActual - toStock)
    // Beef was counted at A's outlet only: not "counted" at another outlet.
    const A3 = (await prisma.location.create({ data: { slug: 'loc-pas-a3', name: 'A3', tenantId: A.tenantId } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: A.tenantId, inventoryItemId: I.beef, qty: 1, unitCostCents: 120_000, kind: 'count_gain', lotSourceType: 'count_gain',
      lotSourceId: `pas-a3-${randomUUID()}`, movementSourceType: 'test', movementSourceId: randomUUID(), receivedAt: new Date(), locationId: A3,
    }))
    const atA = (await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&locationId=${A.locationId}`)).json().rows as Array<{ inventoryItemId: string; counted: boolean }>
    const atA3 = (await call(u.finA!, 'GET', `/reports/food-cost/variance?weekOf=${weekOf}&locationId=${A3}`)).json().rows as Array<{ inventoryItemId: string; counted: boolean }>
    expect(atA.find((x) => x.inventoryItemId === I.beef)!.counted).toBe(true)
    expect(atA3.find((x) => x.inventoryItemId === I.beef)!.counted).toBe(false)
  })
})
