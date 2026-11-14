// THE unit rule (owner, 2026-11-14 — clean-up step 1, A1): one table (lib/units.ts) for the ingredient master, recipe
// costing, PO order units, receipts and transfers.
//   - grams and millilitres are SEPARATE: mass never converts to volume; a NEW recipe line / PO line / transfer in
//     the other family is refused (422 UNIT_MISMATCH).
//   - items = pcs = pc = piece(s) everywhere (the master keeps "items" in the count family, base pcs); dozen = 12.
//   - legacy rows (an ml line on a gram item stored before the rule) are read exactly as before (1:1): a recipe save
//     that keeps such a line passes with a warning and costs the same; stored transfers / prep batches read 1:1.
//   - two companies: company B never uses company A's item, whatever its unit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { convertUnits, convertUnitsLegacy, measuresPerStockUnit, sameUnitFamily, unitFamily } from '../src/lib/units.js'
import { unitFamily as masterUnitFamily } from '../src/lib/ingredientMaster.js'
import { measureToPurchaseUnits, toPurchaseUnits, toPurchaseUnitsLegacy } from '../src/lib/recipeCost.js'
import { orderUnitFactor, orderUnitsFor, storedLine } from '../src/modules/procurement/poUnits.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

describe('the one unit table', () => {
  it('grams and millilitres are separate families; items are pieces', () => {
    expect(sameUnitFamily('g', 'ml')).toBe(false)
    expect(sameUnitFamily('kg', 'l')).toBe(false)
    expect(sameUnitFamily('kg', 'g')).toBe(true)
    for (const u of ['items', 'item', 'pcs', 'pc', 'piece', 'pieces', 'dozen']) expect(unitFamily(u).family, u).toBe('count')
    expect(unitFamily('items')).toEqual({ family: 'count', base: 'pcs', perUnit: 1 })
    // The ingredient master reads the SAME table (re-export): an "items" master is a pcs master.
    expect(masterUnitFamily('Items ')).toEqual({ family: 'count', base: 'pcs', perUnit: 1 })
    expect(unitFamily('dozen').perUnit).toBe(12)
  })

  it('new quantities convert within a family only', () => {
    expect(convertUnits(500, 'g', 'kg')).toBe(0.5)
    expect(convertUnits(1, 'l', 'ml')).toBe(1000)
    expect(convertUnits(3, 'items', 'pcs')).toBe(3)
    expect(convertUnits(2, 'dozen', 'items')).toBe(24)
    expect(convertUnits(1, 'ml', 'g')).toBeNull()
    expect(convertUnits(1, 'kg', 'pcs')).toBeNull()
    expect(toPurchaseUnits(200, 'ml', 'kg')).toBeNull()
    expect(toPurchaseUnits(200, 'g', 'kg')).toBe(0.2)
    expect(toPurchaseUnits(4, 'items', 'dozen')).toBeCloseTo(1 / 3)
    // An empty unit is still the recipe-measure convention.
    expect(toPurchaseUnits(250, '', 'kg')).toBe(0.25)
  })

  it('legacy rows read 1:1 as before (never for new input)', () => {
    expect(convertUnitsLegacy(200, 'ml', 'kg')).toBe(0.2)
    expect(toPurchaseUnitsLegacy(1, 'l', 'g')).toBe(1000)
    expect(toPurchaseUnitsLegacy(1, 'kg', 'pcs')).toBeNull()
    // Recipe costing reads the item's own measure, whatever the line's label — unchanged.
    expect(measureToPurchaseUnits(200, 'kg')).toBe(0.2)
    expect(measureToPurchaseUnits(200, 'l')).toBe(0.2)
    expect(measureToPurchaseUnits(24, 'dozen')).toBe(2)
    expect(measureToPurchaseUnits(5, 'items')).toBe(5)
    expect(measuresPerStockUnit('mg')).toBe(1) // as before: an mg item's recipe quantity is in mg
  })

  it('PO order units: same family only; items = pcs', () => {
    const flour = { name: 'Flour', unit: 'g', purchaseUnit: 'bag', purchaseUnitFactor: 25_000 }
    expect(orderUnitFactor(flour, 'kg')).toBe(1000)
    expect(orderUnitFactor(flour, 'ml')).toBeNull()
    expect(orderUnitFactor(flour, 'l')).toBeNull()
    expect(orderUnitFactor(flour, 'bag')).toBe(25_000)
    expect(orderUnitsFor(flour).map((o) => o.unit)).toEqual(['g', 'kg', 'bag'])
    const eggs = { name: 'Eggs', unit: 'items', purchaseUnit: null, purchaseUnitFactor: 1 }
    expect(orderUnitFactor(eggs, 'pcs')).toBe(1)
    expect(orderUnitFactor(eggs, 'dozen')).toBe(12)
    expect(orderUnitsFor(eggs).map((o) => o.unit)).toEqual(['items', 'pcs', 'dozen'])
    expect(() => storedLine(flour, { inventoryItemId: 'x', orderUnit: 'ml', orderQuantity: 5, orderUnitCostCents: 100 }, 0)).toThrow(/cannot be converted/)
    const milk = { name: 'Milk', unit: 'ml', purchaseUnit: null, purchaseUnitFactor: 1 }
    expect(orderUnitsFor(milk).map((o) => o.unit)).toEqual(['ml', 'l'])
    expect(orderUnitFactor(milk, 'kg')).toBeNull()
  })
})

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let flourG = ''
let milkL = ''
let locA2 = ''
const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`unit-a-${Date.now()}`)
  B = await mkCompany(`unit-b-${Date.now()}`)
  u.chefA = await mkUser('unitChefA', 'boh_management', A.tenantId)
  u.chefB = await mkUser('unitChefB', 'boh_management', B.tenantId)
  u.mgrA = await mkUser('unitMgrA', 'manager', A.tenantId)
  flourG = (await prisma.inventoryItem.create({ data: { name: 'Unit flour', unit: 'g', category: 'flour_grain', tenantId: A.tenantId, unitCostCents: 1 } })).id
  milkL = (await prisma.inventoryItem.create({ data: { name: 'Unit milk', unit: 'l', category: 'dairy', tenantId: A.tenantId, unitCostCents: 30_000 } })).id
  locA2 = (await prisma.location.create({ data: { slug: `unit-a2-${Date.now()}`, name: 'Second outlet', tenantId: A.tenantId } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    return reply.status(status && status < 500 ? status : 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.ready()
}, 90_000)

afterAll(async () => { await app?.close() })

describe('recipe lines follow the unit rule', () => {
  it('a NEW line in the other family is refused (422 UNIT_MISMATCH); the item\'s own family saves', async () => {
    const bad = await call(u.chefA!, 'POST', '/recipes', {
      kind: 'component', name: 'Unit batter', yieldGrams: 1000,
      ingredients: [{ inventoryItemId: flourG, quantity: 500, unit: 'ml' }],
    })
    expect(bad.statusCode, bad.body).toBe(422)
    expect(bad.json().error.code).toBe('UNIT_MISMATCH')
    const badMilk = await call(u.chefA!, 'POST', '/recipes', {
      kind: 'component', name: 'Unit custard', yieldGrams: 1000,
      ingredients: [{ inventoryItemId: milkL, quantity: 500, unit: 'kg' }],
    })
    expect(badMilk.statusCode).toBe(422)
    const ok = await call(u.chefA!, 'POST', '/recipes', {
      kind: 'component', name: 'Unit batter ok', yieldGrams: 1000,
      ingredients: [{ inventoryItemId: flourG, quantity: 500, unit: 'kg' }, { inventoryItemId: milkL, quantity: 300, unit: 'ml' }],
    })
    expect(ok.statusCode, ok.body).toBe(201)
  })

  it('a LEGACY ml line on a gram item still saves (warning) and costs exactly as before', async () => {
    const r = await prisma.recipe.create({ data: { tenantId: A.tenantId, kind: 'component', name: 'Unit legacy dough', yieldGrams: 1000, status: 'iteration' } as never })
    await prisma.recipeIngredient.create({ data: { recipeId: r.id, inventoryItemId: flourG, quantity: 400, unit: 'ml' } as never })
    const before = await call(u.chefA!, 'GET', `/recipes/${r.id}/costing`)
    expect(before.statusCode, before.body).toBe(200)
    const put = await call(u.chefA!, 'PUT', `/recipes/${r.id}`, { ingredients: [{ inventoryItemId: flourG, quantity: 400, unit: 'ml' }] })
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json().warnings).toContain('UNIT_MISMATCH')
    const after = await call(u.chefA!, 'GET', `/recipes/${r.id}/costing`)
    expect(after.json().cost).toEqual(before.json().cost)
    // 400 "ml" of an item kept in g is read as 400 g (1:1), as before the rule.
    expect(before.json().cost.totalIngredientCents).toBe(400)
  })

  it('two companies: company B never uses company A\'s item (422 ITEM_NOT_IN_COMPANY), whatever the unit', async () => {
    const r = await call(u.chefB!, 'POST', '/recipes', {
      kind: 'component', name: 'Unit foreign', yieldGrams: 1000,
      ingredients: [{ inventoryItemId: flourG, quantity: 100, unit: 'g' }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
  })
})

describe('stock transfers follow the unit rule', () => {
  it('a new transfer in the other family is refused; the item\'s family is accepted', async () => {
    const bad = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: flourG, fromLocationId: A.locationId, toLocationId: locA2, quantity: 5, unit: 'ml' })
    expect(bad.statusCode, bad.body).toBe(422)
    expect(bad.json().error.code).toBe('UNIT_MISMATCH')
    const ok = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: flourG, fromLocationId: A.locationId, toLocationId: locA2, quantity: 5, unit: 'kg' })
    expect(ok.statusCode, ok.body).toBe(201)
  })
})
