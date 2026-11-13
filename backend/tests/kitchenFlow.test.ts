// Kitchen flow, parts C–E (owner, 2026-10-26): par in PORTIONS (K5), ONE prep list, the shopping list → draft POs
// with each ingredient's spec (K6), the spec list. Two companies: B never reads or writes A's outlet.
//
// Numbers: the dish is 150 g beef + 50 g sauce; the sauce batch is 1000 g of mayo making 10 portions (100 g each).
// Three past orders of 4 dishes on today's weekday → forecast 12 ÷ 4 weeks = 3 dishes → the sauce is needed for 150 g
// (1.5 portions) and the beef 0.45 kg directly. The par for today's weekday is 5 portions (500 g), so target = 500 g,
// nothing on hand → prep 5 portions = 0.5 batch → 500 g mayo. Items made from a master are in its base unit (g).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { ensureFifoReady } from '../src/lib/stockLedger.js'
import { ingestOrder } from '../src/modules/orders/service.js'
import { kitchenRoutes } from '../src/modules/kitchen/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
const PKT = 5 * 3_600_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
const I: Record<string, string> = {}
let sauce: string
let dish: string
const today = new Date(Date.now() + PKT).toISOString().slice(0, 10)
const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany('kf-a')
  B = await mkCompany('kf-b')
  await prisma.conceptLocation.create({ data: { conceptId: A.conceptId, locationId: A.locationId, isPrimary: true } })
  await prisma.conceptLocation.create({ data: { conceptId: B.conceptId, locationId: B.locationId, isPrimary: true } })
  u.chefA = await mkUser('kfChefA', 'boh_management', A.tenantId)
  u.buyerA = await mkUser('kfBuyerA', 'procurement', A.tenantId)
  u.cookA = await mkUser('kfCookA', 'boh', A.tenantId)
  u.chefB = await mkUser('kfChefB', 'boh_management', B.tenantId)
  await ensureFifoReady(A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(kitchenRoutes, { prefix: '/kitchen' })
  await app.register(crosschecksRoutes)
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('set-up (masters, recipes, past sales)', () => {
  it('builds the kitchen', async () => {
    const supplier = await prisma.supplier.create({ data: { name: 'KF Foods', tenantId: A.tenantId, phone: '03000000000' } })
    for (const [k, name, spec] of [['beef', 'KF beef mince', '80/20, coarse ground'], ['mayo', 'KF mayonnaise', 'Full fat, 5 kg tubs']] as const) {
      const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name, unit: 'kg', category: 'protein', spec })).json()
      I[k] = (await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })).json().id
      await prisma.inventoryItem.update({ where: { id: I[k] }, data: { supplierId: supplier.id, unitCostCents: 100 } })
    }
    sauce = (await prisma.recipe.create({ data: {
      kind: 'component', name: 'KF sauce', yieldGrams: 1000, portionsPerBatch: 10, portionLabel: 'cup', status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: I.mayo, quantity: 1000, unit: 'g' }] },
    } })).id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'KF burger', priceCents: 100_000 } })).id
    await prisma.recipe.create({ data: {
      kind: 'plate', menuItemId: dish, servings: 1, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: I.beef, quantity: 150, unit: 'g' }, { prepRecipeId: sauce, quantity: 50, unit: 'g' }] },
    } })
    for (const w of [7, 14, 21]) {
      const { order } = await ingestOrder({
        source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date(Date.parse(`${today}T07:00:00Z`) - w * DAY).toISOString(),
        customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null, fulfilment_type: 'dine_in',
        items: [{ externalItemId: '', menuItemId: dish, name: 'KF burger', quantity: 4, unitPriceCents: 100_000, modifiers: [] }],
        payment: { provider: null, amountCents: 400_000, status: 'pending' },
      })
      await prisma.order.update({ where: { id: order.id }, data: { status: 'completed' } })
    }
  })
})

describe('daily par in portions', () => {
  it('kitchen managers set it; a line cook cannot; another company\'s outlet 404; another company\'s prep 422', async () => {
    expect((await call(u.cookA!, 'PUT', '/kitchen/par-targets', { locationId: A.locationId, targets: [{ recipeId: sauce, weekday, portions: 5 }] })).statusCode).toBe(403)
    expect((await call(u.chefB!, 'PUT', '/kitchen/par-targets', { locationId: A.locationId, targets: [{ recipeId: sauce, weekday, portions: 5 }] })).statusCode).toBe(404)
    const foreign = await call(u.chefB!, 'PUT', '/kitchen/par-targets', { locationId: B.locationId, targets: [{ recipeId: sauce, weekday, portions: 5 }] })
    expect(foreign.statusCode).toBe(422)
    const ok = await call(u.chefA!, 'PUT', '/kitchen/par-targets', { locationId: A.locationId, targets: [{ recipeId: sauce, weekday, portions: 5 }] })
    expect(ok.statusCode, ok.body).toBe(200)
    const rows = (await call(u.cookA!, 'GET', `/kitchen/par-targets?locationId=${A.locationId}`)).json().rows
    const row = rows.find((r: { recipeId: string }) => r.recipeId === sauce)
    expect(row.targets[weekday]).toBe(5)
    expect(row.portionSize).toBe(100)
    expect(row.suggested[weekday]).toBe(2)   // 1.5 portions needed by the forecast, rounded up
    expect((await prisma.parTarget.findFirstOrThrow({ where: { recipeId: sauce } })).tenantId).toBe(A.tenantId)
  })
})

describe('one prep list', () => {
  it('forecast → portions needed → max(par, need) − on hand → to prep; raw it draws', async () => {
    const r = await call(u.cookA!, 'GET', `/kitchen/prep-list?locationId=${A.locationId}&date=${today}`)
    expect(r.statusCode, r.body).toBe(200)
    const plan = r.json()
    expect(plan.dishes[0]).toMatchObject({ menuItemId: dish, forecast: 3 })
    const c = plan.components.find((x: { recipeId: string }) => x.recipeId === sauce)
    expect(c).toMatchObject({ needQty: 150, needPortions: 1.5, targetPortions: 5, onHandPortions: 0, toPrepPortions: 5, batches: 0.5 })
    expect(plan.rawForPrep).toEqual([expect.objectContaining({ inventoryItemId: I.mayo, unit: 'g', qty: 500 })])
    expect(plan.directRaw).toEqual([expect.objectContaining({ inventoryItemId: I.beef, unit: 'g', qty: 450 })])
    expect(plan.notStocked).toEqual([])
    expect((await call(u.chefB!, 'GET', `/kitchen/prep-list?locationId=${A.locationId}`)).statusCode).toBe(404)
  })

  it('the par board counts a prep batch logged in portions as made, and the stock it made as on hand', async () => {
    await prisma.$transaction(async (tx) => {
      const { addLotTx } = await import('../src/lib/stockLedger.js')
      await addLotTx(tx, { tenantId: A.tenantId, inventoryItemId: I.mayo, qty: 2000, unitCostCents: 100, kind: 'opening', lotSourceType: 'opening', lotSourceId: 'kf-1', movementSourceType: 'test', movementSourceId: 'kf-1', receivedAt: new Date(Date.now() - DAY), locationId: A.locationId })
    })
    // One whole batch drawn (1000 g of mayo); only 3 portions came out (300 g): variance 0.3.
    const b = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: sauce, itemName: 'KF sauce', batches: 1, actualPortions: 3, locationId: A.locationId })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json()).toMatchObject({ actualYieldQty: 300, expectedYieldQty: 1000, yieldVariancePct: 0.3 })
    const board = (await call(u.cookA!, 'GET', `/kitchen/par-board?locationId=${A.locationId}&date=${today}`)).json()
    const row = board.rows.find((x: { recipeId: string }) => x.recipeId === sauce)
    expect(row).toMatchObject({ targetPortions: 5, onHandPortions: 3, madeTodayPortions: 3, stillToPrepPortions: 2, batchesMadeToday: 1 })
  })

  it('no portions per recipe → logging in portions is 422 NO_PORTION_SIZE', async () => {
    const plain = await prisma.recipe.create({ data: { kind: 'component', name: 'KF plain', yieldGrams: 500, tenantId: A.tenantId, status: 'production', ingredients: { create: [{ inventoryItemId: I.mayo, quantity: 500, unit: 'g' }] } } })
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: plain.id, itemName: 'KF plain', batches: 1, actualPortions: 2, locationId: A.locationId })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NO_PORTION_SIZE')
  })
})

describe('portions are what came out; the draw is whole batches', () => {
  it('1 batch logged at 7 of 8 portions draws one full batch of raw stock; variance 0.875', async () => {
    const r8 = await prisma.recipe.create({ data: { kind: 'component', name: 'KF dough', yieldGrams: 800, portionsPerBatch: 8, tenantId: A.tenantId, status: 'production', ingredients: { create: [{ inventoryItemId: I.mayo, quantity: 400, unit: 'g' }] } } })
    const { siteOnHand } = await import('../src/lib/stockLedger.js')
    const before = await siteOnHand(prisma, I.mayo, A.locationId)
    const b = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: r8.id, itemName: 'KF dough', batches: 1, actualPortions: 7, locationId: A.locationId })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json()).toMatchObject({ actualYieldQty: 700, expectedYieldQty: 800, yieldVariancePct: 0.875 })
    expect(before - await siteOnHand(prisma, I.mayo, A.locationId)).toBeCloseTo(400, 6)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'yield_low', entityId: b.json().id } })).toBe(0)   // 0.875 ≥ 0.85
  })

  it('portions without batches is 400 BATCHES_REQUIRED (never guessed), nothing drawn', async () => {
    const r8 = await prisma.recipe.findFirstOrThrow({ where: { name: 'KF dough' } })
    const before = await prisma.prepBatch.count()
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: r8.id, itemName: 'KF dough', actualPortions: 7, locationId: A.locationId })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('BATCHES_REQUIRED')
    expect(await prisma.prepBatch.count()).toBe(before)
  })

  it('a yield above 115 % is flagged yield_high (10 portions from an 8-portion batch)', async () => {
    const r8 = await prisma.recipe.findFirstOrThrow({ where: { name: 'KF dough' } })
    const b = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: r8.id, itemName: 'KF dough', batches: 1, actualPortions: 10, locationId: A.locationId })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().yieldVariancePct).toBe(1.25)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'yield_high', entityId: b.json().id } })).toBe(1)
  })
})

describe('shopping list → draft POs, with specs', () => {
  it('what to buy, by supplier, minus on hand, with each ingredient\'s spec; B 404', async () => {
    const r = await call(u.buyerA!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}&date=${today}`)
    expect(r.statusCode, r.body).toBe(200)
    const g = r.json().groups
    expect(g).toHaveLength(1)
    const beef = g[0].lines.find((l: { inventoryItemId: string }) => l.inventoryItemId === I.beef)
    expect(beef).toMatchObject({ suggestedQty: 450, spec: '80/20, coarse ground' })
    // Mayo: 2000 g − 1000 g drawn by the batch covers the 200 g the 2 portions still to prep draw → nothing to buy.
    expect(r.json().notStocked).toEqual([])
    expect(g[0].lines.some((l: { inventoryItemId: string }) => l.inventoryItemId === I.mayo)).toBe(false)
    expect((await call(u.chefB!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}`)).statusCode).toBe(404)
  })

  it('draft POs go through procurement\'s own createPo (draft, spec on the line)', async () => {
    const r = await call(u.buyerA!, 'POST', '/kitchen/shopping-list/draft-pos', { locationId: A.locationId, date: today })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().created).toHaveLength(1)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().created[0].purchaseOrderId }, include: { lines: true } })
    expect(po.status).toBe('draft')
    expect(po.lines[0]!.notes).toContain('80/20')
    expect((await call(u.cookA!, 'POST', '/kitchen/shopping-list/draft-pos', { locationId: A.locationId })).statusCode).toBe(403)
  })
})

describe('planned dishes (owner, 2026-11-13: "Can po auto pickup items from recipe?")', () => {
  it('the outlet\'s dishes for the picker; B 404', async () => {
    const r = await call(u.buyerA!, 'GET', `/kitchen/outlet-dishes?locationId=${A.locationId}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual(expect.arrayContaining([expect.objectContaining({ menuItemId: dish, name: 'KF burger', hasRecipe: true })]))
    expect((await call(u.chefB!, 'GET', `/kitchen/outlet-dishes?locationId=${A.locationId}`)).statusCode).toBe(404)
  })

  it('10 planned burgers replace the forecast: 1500 g beef needed, no par; another company\'s dish 422', async () => {
    const r = await call(u.buyerA!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}&plan=${dish}:10`)
    expect(r.statusCode, r.body).toBe(200)
    const beef = r.json().groups.flatMap((g: { lines: unknown[] }) => g.lines).find((l: { inventoryItemId: string }) => l.inventoryItemId === I.beef)
    expect(beef.neededQty).toBe(1500)
    const catB = await prisma.category.findFirstOrThrow({ where: { conceptId: B.conceptId } })
    const dishB = await prisma.menuItem.create({ data: { conceptId: B.conceptId, categoryId: catB.id, name: 'KF B dish', priceCents: 100 } })
    const bad = await call(u.buyerA!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}&plan=${dishB.id}:2`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('DISH_NOT_AT_OUTLET')
  })

  it('an option picked on a planned dish adds its ingredients (Double: +150 g beef each); another dish\'s option 422', async () => {
    const g = await prisma.modifierGroup.create({ data: { menuItemId: dish, name: 'Patty', minSelect: 1, maxSelect: 1, isRequired: true,
      modifiers: { create: [{ name: 'Single', isDefault: true }, { name: 'Double', priceDeltaCents: 40_000 }] } }, include: { modifiers: true } })
    const double = g.modifiers.find((m) => m.name === 'Double')!
    await prisma.recipe.create({ data: { kind: 'modifier', modifierId: double.id, servings: 1, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: I.beef, quantity: 150, unit: 'g' }] } } })
    const opts = (await call(u.buyerA!, 'GET', `/kitchen/outlet-dishes?locationId=${A.locationId}`)).json().find((d: { menuItemId: string }) => d.menuItemId === dish).options
    expect(opts[0]).toMatchObject({ name: 'Patty', isRequired: true })
    expect(opts[0].choices).toEqual(expect.arrayContaining([expect.objectContaining({ modifierId: double.id, hasRecipe: true })]))
    const r = await call(u.buyerA!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}&plan=${dish}:10:${double.id},${dish}:5`)
    expect(r.statusCode, r.body).toBe(200)
    const beef = r.json().groups.flatMap((x: { lines: unknown[] }) => x.lines).find((l: { inventoryItemId: string }) => l.inventoryItemId === I.beef)
    expect(beef.neededQty).toBe(15 * 150 + 10 * 150)
    const other = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: (await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })).id, name: 'KF other', priceCents: 100 } })
    const bad = await call(u.buyerA!, 'GET', `/kitchen/shopping-list?locationId=${A.locationId}&plan=${other.id}:1:${double.id}`)
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('OPTION_NOT_ON_DISH')
  })

  it('draft POs from the plan', async () => {
    const r = await call(u.buyerA!, 'POST', '/kitchen/shopping-list/draft-pos', { locationId: A.locationId, planned: [{ menuItemId: dish, qty: 10 }] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().created).toHaveLength(1)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().created[0].purchaseOrderId } })
    expect(po.notes).toContain('planned dishes')
    expect(po.status).toBe('draft')
  })
})

describe('items with no supplier', () => {
  it('go on ONE draft PO with "no supplier yet" instead of being dropped', async () => {
    const m = (await call(u.chefA!, 'POST', '/ingredient-master', { name: `KF buns ${Date.now()}`, unit: 'pcs', category: 'bakery' })).json()
    const bun = (await call(u.chefA!, 'POST', '/inventory/from-master', { masterIngredientId: m.id })).json().id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const d = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'KF bun plate', priceCents: 100 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: d.id, servings: 1, status: 'production', tenantId: A.tenantId, ingredients: { create: [{ inventoryItemId: bun, quantity: 1, unit: 'pcs' }] } } })
    // No price on the stock item: the line takes the servd price typed on the Ingredients sheet (PKR 50 a bun).
    expect((await call(u.chefA!, 'PUT', `/ingredient-master/${m.id}/price`, { priceCents: 5000 })).statusCode).toBe(200)
    const r = await call(u.buyerA!, 'POST', '/kitchen/shopping-list/draft-pos', { locationId: A.locationId, planned: [{ menuItemId: d.id, qty: 12 }] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().unassigned).toEqual([expect.objectContaining({ inventoryItemId: bun, suggestedQty: 12 })])
    const made = r.json().created.find((c: { supplierName: string }) => c.supplierName === 'No supplier yet')
    expect(made).toBeTruthy()
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: made.purchaseOrderId }, include: { supplier: true, lines: true } })
    expect(po.supplier.systemKind).toBe('cash_purchases')
    expect(po.supplier.tenantId).toBe(A.tenantId)
    expect(po.lines.map((l) => l.inventoryItemId)).toEqual([bun])
    expect(po.lines[0]!.unitCostCents).toBe(5000)
  })
})

describe('the spec list', () => {
  it('every ingredient the company buys with its spec, by supplier; PDF export; B sees none of A\'s', async () => {
    const rows = (await call(u.buyerA!, 'GET', '/kitchen/spec-list')).json().rows
    expect(rows.find((x: { ingredient: string }) => x.ingredient === 'KF beef mince')).toMatchObject({ supplier: 'KF Foods', spec: '80/20, coarse ground' })
    const pdf = await call(u.buyerA!, 'GET', '/kitchen/spec-list?format=pdf')
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toContain('pdf')
    const rowsB = (await call(u.chefB!, 'GET', '/kitchen/spec-list')).json().rows
    expect(rowsB.some((x: { ingredient: string }) => x.ingredient === 'KF beef mince')).toBe(false)
  })
})
