// Recipes: the Packaging section on every dish (owner's FINAL packaging rule,
// 2026-10-13) — backend/src/modules/recipes/routes.ts.
//
// What this guards (two companies; A has a plate brand "Simmer" and a
// packaging-vessel brand "Stackd"):
//   - the line rules: a packaging-class item under Ingredients → 422
//     PACKAGING_SECTION_ONLY; food under Packaging → 422 NOT_PACKAGING; a
//     Packaging section (or a packaging item) on a sub-recipe → 422
//     PACKAGING_ON_PLATES_ONLY; B's stock on A's recipe → 422
//     ITEM_NOT_IN_COMPANY; company-less stock → 422 ITEM_HAS_NO_COMPANY; a
//     negative quantity on a dish → 422 NEGATIVE_QTY_NOT_ALLOWED;
//   - a legacy line (a packaging item the backfill left in a sub-recipe) the
//     user did not touch passes with a warning; a new one is refused;
//   - a Stackd recipe with no packaging is saved, submitted and approved with
//     warning PACKAGING_MISSING; a Simmer one gets no warning;
//   - costing: plate MC = food + drinks; target MC dine-in = plate MC at
//     Simmer, = plate MC + packaging at Stackd; takeaway / delivery = plate
//     MC + packaging at both; the Q allowance is reported apart and never
//     inside an MC; prices use the target MC + Q, never a packaging %;
//   - packagingPct sent → ignored, never written;
//   - GET /recipes/food-cost → 404 (the report lives at /reports/food-cost);
//   - company B → 404 on A's recipe (read, costing, edit, preview);
//   - warnings: noPackaging / outsideCompany / costedWhileUnapproved on the
//     costing, the preview and the list; by-item groups lines by section.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'

let app: FastifyInstance
let A: Company
let B: Company
let mgrA: Who
let mgrB: Who
let ceoA: Who
let stackd: string
let stackdCat: string
let stackdDish: string
let beef: string
let cola: string
let box: string
let boxB: string
let sharedOil: string
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const beefLine = { inventoryItemId: '', quantity: 100, unit: 'g' }
const lines = () => ({
  beef: { ...beefLine, inventoryItemId: beef },
  cola: { inventoryItemId: cola, quantity: 1, unit: 'pcs' },
  box:  { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' as const },
})

beforeAll(async () => {
  A = await mkCompany(`rp-a-${stamp}`)
  B = await mkCompany(`rp-b-${stamp}`)
  mgrA = await mkUser('rp-mgr-a', 'manager', A.tenantId)
  mgrB = await mkUser('rp-mgr-b', 'manager', B.tenantId)
  ceoA = await mkUser('rp-ceo-a', 'admin', A.tenantId)
  stackd = (await prisma.concept.create({
    data: { name: `Stackd ${stamp}`, slug: `rp-stackd-${stamp}`, type: 'restaurant', tenantId: A.tenantId, serviceVessel: 'packaging', taxRateCash: 15, taxRateCard: 8 },
  })).id
  stackdCat = (await prisma.category.create({ data: { conceptId: stackd, name: 'Sandwiches' } })).id
  stackdDish = (await prisma.menuItem.create({ data: { conceptId: stackd, categoryId: stackdCat, name: 'Club', priceCents: 100_000 } })).id
  const item = (tenantId: string | null, name: string, unit: string, category: string, unitCostCents: number) =>
    prisma.inventoryItem.create({ data: { tenantId, name: `${name} ${stamp}`, unit, category, unitCostCents } }).then((i) => i.id)
  beef = await item(A.tenantId, 'Beef', 'kg', 'protein', 150_000)      // 100 g → 15,000
  cola = await item(A.tenantId, 'Cola', 'pcs', 'beverage', 5_000)      // 1 → 5,000
  box = await item(A.tenantId, 'Kraft box', 'pcs', 'packaging', 3_000) // 1 → 3,000
  boxB = await item(B.tenantId, 'B box', 'pcs', 'packaging', 2_000)
  sharedOil = await item(null, 'Shared oil', 'kg', 'other', 50_000)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the line rules', () => {
  it('a packaging item under Ingredients → 422 PACKAGING_SECTION_ONLY', async () => {
    const r = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [lines().beef, { inventoryItemId: box, quantity: 1, unit: 'pcs' }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('PACKAGING_SECTION_ONLY')
    expect(await prisma.recipe.count({ where: { menuItemId: A.items.kheer } })).toBe(0)
  })

  it('food under Packaging → 422 NOT_PACKAGING', async () => {
    const r = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ ...lines().beef, section: 'packaging' }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOT_PACKAGING')
  })

  it('a Packaging section or a packaging item on a sub-recipe → 422 PACKAGING_ON_PLATES_ONLY', async () => {
    for (const ing of [lines().box, { inventoryItemId: box, quantity: 1, unit: 'pcs' }]) {
      const r = await call(mgrA, 'POST', '/recipes', { kind: 'component', name: 'Sauce', yieldGrams: 500, ingredients: [lines().beef, ing] })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PACKAGING_ON_PLATES_ONLY')
    }
  })

  it("B's packaging on A's recipe → 422 ITEM_NOT_IN_COMPANY; company-less stock → 422 ITEM_HAS_NO_COMPANY", async () => {
    const foreign = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [lines().beef, { inventoryItemId: boxB, quantity: 1, unit: 'pcs', section: 'packaging' }] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
    const shared = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ inventoryItemId: sharedOil, quantity: 10, unit: 'g' }] })
    expect(shared.statusCode).toBe(422)
    expect(shared.json().error.code).toBe('ITEM_HAS_NO_COMPANY')
  })

  it('a negative quantity on a dish → 422 NEGATIVE_QTY_NOT_ALLOWED', async () => {
    const r = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ ...lines().beef, quantity: -10 }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NEGATIVE_QTY_NOT_ALLOWED')
  })

  it('a legacy packaging line in a sub-recipe passes untouched (warning); a new one is refused', async () => {
    const legacy = await prisma.recipe.create({
      data: { kind: 'component', name: `Legacy sauce ${stamp}`, yieldGrams: 1000,
        ingredients: { create: [{ inventoryItemId: beef, quantity: 1000, unit: 'g' }, { inventoryItemId: box, quantity: 1, unit: 'pcs' }] } },
    })
    const same = await call(mgrA, 'PUT', `/recipes/${legacy.id}`, { notes: 'renamed', ingredients: [{ inventoryItemId: beef, quantity: 900, unit: 'g' }, { inventoryItemId: box, quantity: 1, unit: 'pcs' }] })
    expect(same.statusCode).toBe(200)
    expect(same.json().warnings).toEqual(['PACKAGING_ON_PLATES_ONLY'])
    const added = await call(mgrA, 'PUT', `/recipes/${legacy.id}`, { ingredients: [{ inventoryItemId: beef, quantity: 900, unit: 'g' }, { inventoryItemId: box, quantity: 1, unit: 'pcs' }, lines().box] })
    expect(added.statusCode).toBe(422)
    expect(added.json().error.code).toBe('PACKAGING_ON_PLATES_ONLY')
  })
})

describe('packaging warning, approval, costing', () => {
  let simmerRecipe: string
  let stackdRecipe: string

  it('a Stackd dish with no packaging is saved, submitted and approved with PACKAGING_MISSING; a Simmer one has no warning', async () => {
    const st = await call(mgrA, 'POST', '/recipes', { menuItemId: stackdDish, ingredients: [lines().beef, lines().cola] })
    expect(st.statusCode).toBe(201)
    expect(st.json().warnings).toEqual(['PACKAGING_MISSING'])
    stackdRecipe = st.json().id
    const si = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.nihari, packagingPct: 40, ingredients: [lines().beef, lines().cola, lines().box] })
    expect(si.statusCode).toBe(201)
    expect(si.json().warnings).toEqual([])
    simmerRecipe = si.json().id
    // A Simmer dish with no packaging at all (dine-in only) is valid and quiet.
    const plain = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.water, ingredients: [lines().cola] })
    expect(plain.statusCode).toBe(201)
    expect(plain.json().warnings).toEqual([])

    expect((await call(mgrA, 'POST', `/recipes/${stackdRecipe}/submit`, {})).json().warnings).toEqual(['PACKAGING_MISSING'])
    const ap = await call(ceoA, 'POST', `/recipes/${stackdRecipe}/approve`, {})
    expect(ap.statusCode).toBe(200)
    expect(ap.json().status).toBe('production')
    expect(ap.json().warnings).toEqual(['PACKAGING_MISSING'])
  })

  it('packagingPct sent → ignored and never written', async () => {
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: simmerRecipe } })).packagingPct).toBe(8)
    const r = await call(mgrA, 'PUT', `/recipes/${simmerRecipe}`, { packagingPct: 55, servings: 1 })
    expect(r.statusCode).toBe(200)
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: simmerRecipe } })).packagingPct).toBe(8)
  })

  it('costing: plate MC, target MC per order type by brand vessel, Q apart', async () => {
    const si = (await call(mgrA, 'GET', `/recipes/${simmerRecipe}/costing`)).json()
    expect(si.stockByClass).toEqual({ food: 15_000, beverage: 5_000, packaging: 3_000 })
    expect(si.standardCents).toBe(20_000)
    expect(si.packagingCents).toBe(3_000)
    expect(si.qCents).toBe(2_000)   // 10% of the ingredient lines only — never inside an MC
    expect(si.targetMcCents).toEqual({ dine_in: 20_000, takeout: 23_000, delivery: 23_000 })
    expect(si.cost.plateCostCents).toBe(20_000)
    expect(si.recipe.serviceVessel).toBe('plate')
    expect(si.recipe).not.toHaveProperty('packagingPct')
    // Prices cover the main order type's MC + Q (no packaging %): 22,000 ÷ 30%.
    expect(si.pricing.foodCostPriceCents).toBe(Math.round(22_000 / 0.3))
    expect(si.pricing.breakEvenPriceCents).toBe(22_000 + si.cost.opexPerPortionCents)
    expect(si.profitability.packagingCostCents).toBe(0)
    expect(si.profitability.byOrderType.delivery.packagingCents).toBe(3_000)
    expect(si.profitability.byOrderType.dine_in.mcCents).toBe(20_000)
    expect(si.ingredients.find((l: { section: string }) => l.section === 'packaging')).toMatchObject({ costClass: 'packaging', ingredientCostCents: 3_000 })

    // Stackd with its box added: dine-in carries the packaging too.
    const put = await call(mgrA, 'PUT', `/recipes/${stackdRecipe}`, { ingredients: [lines().beef, lines().cola, lines().box] })
    expect(put.statusCode).toBe(200)
    expect(put.json().warnings).toEqual([])
    const st = (await call(mgrA, 'GET', `/recipes/${stackdRecipe}/costing`)).json()
    expect(st.standardCents).toBe(20_000)
    expect(st.targetMcCents).toEqual({ dine_in: 23_000, takeout: 23_000, delivery: 23_000 })
    expect(st.qCents).toBe(2_000)
    expect(st.pricing.foodCostPriceCents).toBe(Math.round(25_000 / 0.3))
    expect(st.profitability.packagingCostCents).toBe(3_000)
    expect(st.warnings.noPackaging).toBe(false)
  })

  it('GET /recipes/food-cost → 404 (the report is /reports/food-cost)', async () => {
    expect((await call(mgrA, 'GET', '/recipes/food-cost')).statusCode).toBe(404)
  })

  it("company B → 404 on A's recipe: read, costing, edit, submit, preview", async () => {
    expect((await call(mgrB, 'GET', `/recipes/${simmerRecipe}`)).statusCode).toBe(404)
    expect((await call(mgrB, 'GET', `/recipes/${simmerRecipe}/costing`)).statusCode).toBe(404)
    expect((await call(mgrB, 'PUT', `/recipes/${simmerRecipe}`, { notes: 'hijack' })).statusCode).toBe(404)
    expect((await call(mgrB, 'POST', `/recipes/${simmerRecipe}/submit`, {})).statusCode).toBe(404)
    expect((await call(mgrB, 'POST', '/recipes/costing-preview', { recipeId: simmerRecipe, ingredients: [] })).statusCode).toBe(404)
    expect((await call(mgrB, 'POST', '/recipes/costing-preview', { conceptId: stackd, ingredients: [] })).statusCode).toBe(404)
    expect(((await call(mgrB, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(simmerRecipe)
    // And B's own create binds to B: A's dish is 404.
    expect((await call(mgrB, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ inventoryItemId: boxB, quantity: 1, unit: 'pcs', section: 'packaging' }] })).statusCode).toBe(404)
  })
})

describe('warnings', () => {
  it('noPackaging: a Stackd dish with no packaging line (costing, preview, list); never for Simmer', async () => {
    const dish = (await prisma.menuItem.create({ data: { conceptId: stackd, categoryId: stackdCat, name: 'Croissant', priceCents: 60_000 } })).id
    const r = await call(mgrA, 'POST', '/recipes', { menuItemId: dish, ingredients: [lines().beef] })
    const id = r.json().id
    const costing = (await call(mgrA, 'GET', `/recipes/${id}/costing`)).json()
    expect(costing.warnings.noPackaging).toBe(true)
    expect(costing.targetMcCents).toEqual({ dine_in: 15_000, takeout: 15_000, delivery: 15_000 })

    const preview = (await call(mgrA, 'POST', '/recipes/costing-preview', { conceptId: stackd, ingredients: [lines().beef] })).json()
    expect(preview.warnings.noPackaging).toBe(true)
    expect(preview.lineWarnings).toEqual(['PACKAGING_MISSING'])
    const withBox = (await call(mgrA, 'POST', '/recipes/costing-preview', { conceptId: stackd, ingredients: [lines().beef, lines().box] })).json()
    expect(withBox.warnings.noPackaging).toBe(false)
    expect(withBox.targetMcCents).toEqual({ dine_in: 18_000, takeout: 18_000, delivery: 18_000 })
    expect(withBox.lines.map((l: { section: string }) => l.section)).toEqual(['ingredients', 'packaging'])
    const simmerPreview = (await call(mgrA, 'POST', '/recipes/costing-preview', { conceptId: A.conceptId, ingredients: [lines().beef, lines().box] })).json()
    expect(simmerPreview.targetMcCents).toEqual({ dine_in: 15_000, takeout: 18_000, delivery: 18_000 })
    expect(simmerPreview.warnings.noPackaging).toBe(false)
    // The preview applies the same line rules.
    const bad = await call(mgrA, 'POST', '/recipes/costing-preview', { conceptId: A.conceptId, ingredients: [{ inventoryItemId: box, quantity: 1 }] })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('PACKAGING_SECTION_ONLY')

    const rows = (await call(mgrA, 'GET', '/recipes')).json() as Array<{ id: string; serviceVessel: string | null; warnings: { noPackaging: boolean } }>
    const row = rows.find((x) => x.id === id)!
    expect(row.serviceVessel).toBe('packaging')
    expect(row.warnings.noPackaging).toBe(true)
    expect(rows.filter((x) => x.serviceVessel === 'plate').every((x) => x.warnings.noPackaging === false)).toBe(true)
  })

  it('outsideCompany: a legacy line on another company\'s stock is listed by name (and counted nowhere at the sale)', async () => {
    const dish = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: (await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })).id, name: 'Legacy dish', priceCents: 50_000 } })).id
    const legacy = await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: dish, ingredients: { create: [{ inventoryItemId: beef, quantity: 100, unit: 'g' }, { inventoryItemId: boxB, quantity: 1, unit: 'pcs', section: 'packaging' }] } },
      include: { ingredients: true },
    })
    const foreignLine = legacy.ingredients.find((l) => l.inventoryItemId === boxB)!
    const costing = (await call(mgrA, 'GET', `/recipes/${legacy.id}/costing`)).json()
    expect(costing.warnings.outsideCompany).toEqual([expect.objectContaining({ lineId: foreignLine.id, itemName: `B box ${stamp}`, reason: 'foreign' })])
    // Editing it without touching that line still saves.
    const put = await call(mgrA, 'PUT', `/recipes/${legacy.id}`, { ingredients: [{ inventoryItemId: beef, quantity: 120, unit: 'g' }, { inventoryItemId: boxB, quantity: 1, unit: 'pcs', section: 'packaging' }] })
    expect(put.statusCode).toBe(200)
    expect(put.json().warnings).toEqual(['ITEM_NOT_IN_COMPANY'])
  })

  it('costedWhileUnapproved: a testing recipe on a live dish; cleared once approved', async () => {
    const dish = (await prisma.menuItem.create({ data: { conceptId: stackd, categoryId: stackdCat, name: 'Muffin', priceCents: 40_000 } })).id
    const id = (await call(mgrA, 'POST', '/recipes', { menuItemId: dish, ingredients: [lines().beef, lines().box] })).json().id
    expect((await call(mgrA, 'GET', `/recipes/${id}/costing`)).json().warnings.costedWhileUnapproved).toBe(true)
    expect((await call(mgrA, 'POST', '/recipes/costing-preview', { recipeId: id, ingredients: [lines().beef, lines().box] })).json().warnings.costedWhileUnapproved).toBe(true)
    await call(mgrA, 'POST', `/recipes/${id}/submit`, {})
    expect((await call(ceoA, 'POST', `/recipes/${id}/approve`, {})).statusCode).toBe(200)
    expect((await call(mgrA, 'GET', `/recipes/${id}/costing`)).json().warnings.costedWhileUnapproved).toBe(false)
    // A testing plate whose dish is not open yet (pendingMenuItem) is not live.
    const pending = await call(mgrA, 'POST', '/recipes', { newMenuItem: { conceptId: stackd, categoryId: stackdCat, name: 'Scone' }, ingredients: [lines().beef, lines().box] })
    expect(pending.statusCode).toBe(201)
    expect((await call(mgrA, 'GET', `/recipes/${pending.json().id}/costing`)).json().warnings.costedWhileUnapproved).toBe(false)
  })

  it('by-item groups the dish\'s lines by section (what to pack in)', async () => {
    const r = (await call(mgrA, 'GET', `/recipes/by-item/${A.items.nihari}`)).json()
    expect(r.sections.ingredients.map((l: { name: string }) => l.name).sort()).toEqual([`Beef ${stamp}`, `Cola ${stamp}`])
    expect(r.sections.packaging.map((l: { name: string }) => l.name)).toEqual([`Kraft box ${stamp}`])
    expect(r.ingredients).toHaveLength(3)
    expect((await call(mgrB, 'GET', `/recipes/by-item/${A.items.nihari}`)).json()).toBeNull()
  })
})
