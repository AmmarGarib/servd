// Wave 3 — role <-> route alignment, stream D (kitchen), 2026-10-11.
//
// What this guards:
//   UI-10  The line cook (boh) holds `inventory` and `recipes` by default, so
//          the Inventory / Low stock / Count / Prep pages (GET /inventory,
//          /inventory/alerts, /inventory/waste-logs) and the recipe book
//          (GET /recipes, GET /recipes/:id) answer 200 — with every cost,
//          supplier and margin taken out (costsHidden). boh logs waste in its
//          own company. It does NOT add or edit items, cost or price recipes,
//          edit, submit or approve them, or read the waste-cost dashboard.
//          kitchen / expediter (no inventory module) stay out of stock, and
//          their own defaults (par_sheet, food_safety) answer 200.
//          procurement (holds `inventory`) reads stock with costs and keeps
//          the item master (the Sourcing sheet), in its own company.
//   UI-07  finance reads the food-cost variance report (GET
//          /reports/food-cost/summary — Reports -> Food cost variance; the old
//          GET /recipes/food-cost is gone, wave B) and the recipe list,
//          scoped to its own company.
// Every widened route is two-company: company B's role gets 404 / nothing on
// company A's rows, and creates bind to the active company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { parSheetRoutes } from '../src/modules/par-sheet/routes.js'
import { foodSafetyRoutes } from '../src/modules/foodSafety/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import foodCostRoutes from '../src/modules/reports/foodCostRoutes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let beefA: string
let beefB: string
let recipeA: string
let recipeB: string
let burgerA: string
let burgerB: string
const users: Record<string, { id: string; token: string }> = {}
const PHOTO = 'https://example.com/waste.jpg'

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.w3kitchen@test.local`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

let n = 0
async function sell(conceptId: string, menuItemId: string, qty: number) {
  n += 1
  await prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'completed', fulfilmentType: 'dine_in', totalCents: 150_000 * qty,
      placedAt: new Date(), completedAt: new Date(), externalId: `w3k-${n}-${Date.now()}`,
      items: { create: [{ menuItemId, name: 'Burger', quantity: qty, unitPriceCents: 150_000, status: 'bumped' }] },
    },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'W3 Kitchen A', slug: 'w3-kitchen-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'W3 Kitchen B', slug: 'w3-kitchen-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()

  conceptA = (await prisma.concept.create({ data: { name: 'W3 Diner A', slug: 'w3k-diner-a', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'W3 Diner B', slug: 'w3k-diner-b', type: 'restaurant', tenantId: tenantB } })).id
  const catA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  const catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })).id
  burgerA = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA, name: 'Burger A', priceCents: 150_000 } })).id
  burgerB = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB, name: 'Burger B', priceCents: 150_000 } })).id

  const supA = (await prisma.supplier.create({ data: { name: 'Meat Co A', phone: '03000000001', tenantId: tenantA } })).id
  const supB = (await prisma.supplier.create({ data: { name: 'Meat Co B', phone: '03000000002', tenantId: tenantB } })).id
  // Beef is below par in both companies, so both show on the alerts list.
  beefA = (await prisma.inventoryItem.create({ data: { name: 'Beef A', unit: 'kg', currentStock: 5, parLevel: 10, unitCostCents: 200_000, listPriceCents: 190_000, supplierId: supA, tenantId: tenantA } })).id
  beefB = (await prisma.inventoryItem.create({ data: { name: 'Beef B', unit: 'kg', currentStock: 5, parLevel: 10, unitCostCents: 300_000, supplierId: supB, tenantId: tenantB } })).id

  recipeA = (await prisma.recipe.create({ data: { kind: 'plate', menuItemId: burgerA, servings: 1, steps: 'Smash, sear, stack.', ingredients: { create: [{ inventoryItemId: beefA, quantity: 0.15, unit: 'kg', yieldPct: 1 }] } } })).id
  recipeB = (await prisma.recipe.create({ data: { kind: 'plate', menuItemId: burgerB, servings: 1, ingredients: { create: [{ inventoryItemId: beefB, quantity: 0.15, unit: 'kg', yieldPct: 1 }] } } })).id

  await sell(conceptA, burgerA, 2)
  await sell(conceptB, burgerB, 3)

  // A waste log in each company, so the waste-log list has something to scope.
  await prisma.wasteLog.create({ data: { inventoryItemId: beefA, quantity: 0.5, unit: 'kg', reason: 'spoilage', estimatedCostCents: 100_000 } })
  await prisma.wasteLog.create({ data: { inventoryItemId: beefB, quantity: 0.5, unit: 'kg', reason: 'spoilage', estimatedCostCents: 150_000 } })

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('cookA', 'boh', tenantA)
  await mkUser('cookB', 'boh', tenantB)
  await mkUser('lineA', 'kitchen', tenantA)
  await mkUser('expoA', 'expediter', tenantA)
  await mkUser('buyerA', 'procurement', tenantA)
  await mkUser('buyerB', 'procurement', tenantB)
  await mkUser('financeA', 'finance', tenantA)
  await mkUser('financeB', 'finance', tenantB)
  await mkUser('cashierA', 'cashier', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.register(parSheetRoutes, { prefix: '/par-sheet' })
  await app.register(foodSafetyRoutes, { prefix: '/food-safety' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.register(foodCostRoutes, { prefix: '/reports/food-cost' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  invalidateSetupCache()
})

type Row = Record<string, unknown> & { id: string; name?: string }

// ─── UI-10: the line cook reads stock, without money ─────────────────────────

describe('boh reads inventory in its own company, with costs and suppliers taken out (UI-10)', () => {
  it('GET /inventory: 200, own company only, no cost / list price / supplier', async () => {
    const a = await call('cookA', 'GET', '/inventory')
    expect(a.statusCode).toBe(200)
    const rows = a.json() as Row[]
    const beef = rows.find((r) => r.id === beefA)!
    expect(beef).toBeTruthy()
    expect(beef.currentStock).toBe(5)
    expect(beef.isLowStock).toBe(true)
    expect(beef.unitCostCents).toBeNull()
    expect(beef.listPriceCents).toBeNull()
    expect(beef.supplierId).toBeNull()
    expect(beef.supplier).toBeNull()
    expect(beef.costsHidden).toBe(true)
    expect(rows.some((r) => r.id === beefB)).toBe(false)

    const b = (await call('cookB', 'GET', '/inventory')).json() as Row[]
    expect(b.some((r) => r.id === beefB)).toBe(true)
    expect(b.some((r) => r.id === beefA)).toBe(false)
  })

  it('GET /inventory/alerts: own company only, no supplier phone', async () => {
    const a = await call('cookA', 'GET', '/inventory/alerts')
    expect(a.statusCode).toBe(200)
    const rows = a.json() as Row[]
    expect(rows.map((r) => r.id)).toContain(beefA)
    expect(rows.map((r) => r.id)).not.toContain(beefB)
    expect(rows.find((r) => r.id === beefA)!.supplier).toBeNull()
    expect(rows.find((r) => r.id === beefA)!.unitCostCents).toBeNull()
    const b = (await call('cookB', 'GET', '/inventory/alerts')).json() as Row[]
    expect(b.map((r) => r.id)).not.toContain(beefA)
  })

  it('GET /inventory/waste-logs: own company only, no cost', async () => {
    const a = await call('cookA', 'GET', '/inventory/waste-logs')
    expect(a.statusCode).toBe(200)
    const logs = a.json() as Array<{ inventoryItemId: string; estimatedCostCents: number | null; inventoryItem: { unitCostCents: number | null } }>
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.every((l) => l.inventoryItemId !== beefB)).toBe(true)
    expect(logs.every((l) => l.estimatedCostCents === null && l.inventoryItem.unitCostCents === null)).toBe(true)
    // Asking for company A's item by id from company B returns nothing.
    const b = (await call('cookB', 'GET', `/inventory/waste-logs?inventoryItemId=${beefA}`)).json() as unknown[]
    expect(b).toEqual([])
  })

  it('logs waste in its own company (no value in the answer); 404 on the other company\'s item', async () => {
    const ok = await call('cookA', 'POST', `/inventory/${beefA}/waste`, { quantity: 0.2, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().estimatedCostCents).toBeNull()
    // The record itself still carries the server's value for the books.
    const saved = await prisma.wasteLog.findUniqueOrThrow({ where: { id: ok.json().id } })
    expect(saved.estimatedCostCents).toBe(40_000)
    expect(saved.recordedById).toBe(users['cookA']!.id)

    const foreign = await call('cookB', 'POST', `/inventory/${beefA}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })
    expect(foreign.statusCode).toBe(404)
  })

  it('the photo refusal does not tell a line cook what the item costs', async () => {
    const res = await call('cookA', 'POST', `/inventory/${beefA}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PHOTO_REQUIRED')
    expect(res.json().error.message).not.toMatch(/PKR/)
  })

  it('does not add or edit the item master, and does not read the waste-cost dashboard', async () => {
    expect((await call('cookA', 'POST', '/inventory', { name: 'Buns', unit: 'pcs' })).statusCode).toBe(403)
    expect((await call('cookA', 'PATCH', `/inventory/${beefA}`, { parLevel: 1 })).statusCode).toBe(403)
    expect((await call('cookA', 'GET', '/inventory/waste-analytics')).statusCode).toBe(403)
    expect((await call('cookA', 'GET', '/inventory/unassigned')).statusCode).toBe(403)
  })

  it('managers still see costs and suppliers', async () => {
    const rows = (await call('ceoA', 'GET', '/inventory')).json() as Row[]
    const beef = rows.find((r) => r.id === beefA)!
    expect(beef.unitCostCents).toBe(200_000)
    expect(beef.costsHidden).toBeUndefined()
  })
})

describe('kitchen / expediter / cashier: no inventory module, no stock; their own defaults work', () => {
  it('GET /inventory and /recipes stay 403', async () => {
    for (const who of ['lineA', 'expoA', 'cashierA']) {
      expect((await call(who, 'GET', '/inventory')).statusCode, who).toBe(403)
      expect((await call(who, 'GET', '/recipes')).statusCode, who).toBe(403)
      expect((await call(who, 'POST', `/inventory/${beefA}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })).statusCode, who).toBe(403)
    }
  })

  it('par sheet and food safety (their default modules) answer 200', async () => {
    for (const who of ['lineA', 'expoA', 'cookA']) {
      expect((await call(who, 'GET', '/par-sheet')).statusCode, who).toBe(200)
      expect((await call(who, 'GET', '/food-safety/summary')).statusCode, who).toBe(200)
    }
  })
})

describe('procurement keeps the item master in its own company', () => {
  it('reads stock with costs, own company only', async () => {
    const res = await call('buyerA', 'GET', '/inventory')
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Row[]
    expect(rows.find((r) => r.id === beefA)!.unitCostCents).toBe(200_000)
    expect(rows.some((r) => r.id === beefB)).toBe(false)
  })

  it('adds an item bound to its active company; edits its own, 404 on the other company\'s', async () => {
    const created = await call('buyerA', 'POST', '/inventory', { name: 'Brioche bun', unit: 'pcs', parLevel: 50 })
    expect(created.statusCode).toBe(201)
    expect(created.json().tenantId).toBe(tenantA)
    // Not into a company it does not belong to.
    expect((await call('buyerA', 'POST', '/inventory', { name: 'Sneaky', unit: 'pcs', tenantId: tenantB })).statusCode).toBe(403)

    expect((await call('buyerA', 'PATCH', `/inventory/${created.json().id}`, { parLevel: 60 })).statusCode).toBe(200)
    expect((await call('buyerB', 'PATCH', `/inventory/${beefA}`, { parLevel: 1 })).statusCode).toBe(404)
  })

  it('does not log waste', async () => {
    expect((await call('buyerA', 'POST', `/inventory/${beefA}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })).statusCode).toBe(403)
  })
})

// ─── UI-10: the line cook reads the recipe book, without money ───────────────

describe('boh reads recipes in its own company, without costs (UI-10)', () => {
  it('GET /recipes: own company only; method and quantities, no cost or margin', async () => {
    const res = await call('cookA', 'GET', '/recipes')
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<Row & { ingredients: Array<Row & { inventoryItem: Row | null }> }>
    expect(rows.map((r) => r.id)).toEqual([recipeA])
    const r = rows[0]!
    expect(r.steps).toBe('Smash, sear, stack.')
    expect(r.ingredients[0]!.quantity).toBe(0.15)
    expect(r.ingredients[0]!.inventoryItem!.name).toBe('Beef A')
    for (const k of ['totalCostCents', 'costPerPortionCents', 'grossMarginPct', 'foodCostPct', 'ingredientCostCents', 'qFactorCents']) {
      expect(r[k], k).toBeNull()
    }
    expect(r.ingredients[0]!.ingredientCostCents).toBeNull()
    expect(r.ingredients[0]!.costPerUnit).toBeNull()
    expect(r.ingredients[0]!.inventoryItem!.unitCostCents).toBeNull()
    expect(r.costsHidden).toBe(true)

    // Company B's cook, and a brand filter pointing at company A, see nothing of A.
    expect(((await call('cookB', 'GET', '/recipes')).json() as Row[]).map((x) => x.id)).toEqual([recipeB])
    expect((await call('cookB', 'GET', `/recipes?conceptId=${conceptA}`)).json()).toEqual([])
  })

  it('GET /recipes/:id: own company 200 without cost, other company 404', async () => {
    const res = await call('cookA', 'GET', `/recipes/${recipeA}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().ingredients[0].inventoryItem.unitCostCents).toBeNull()
    expect(res.json().costsHidden).toBe(true)
    expect((await call('cookA', 'GET', `/recipes/${recipeB}`)).statusCode).toBe(404)
    expect((await call('cookB', 'GET', `/recipes/${recipeA}`)).statusCode).toBe(404)
  })

  it('does not cost, price, edit, submit, delete or approve recipes', async () => {
    expect((await call('cookA', 'GET', `/recipes/${recipeA}/costing`)).statusCode).toBe(403)
    expect((await call('cookA', 'POST', '/recipes/costing-preview', { ingredients: [] })).statusCode).toBe(403)
    expect((await call('cookA', 'PUT', `/recipes/${recipeA}`, { servings: 2 })).statusCode).toBe(403)
    expect((await call('cookA', 'POST', '/recipes', { kind: 'component', name: 'Sauce', yieldGrams: 100, ingredients: [{ inventoryItemId: beefA, quantity: 1, unit: 'kg' }] })).statusCode).toBe(403)
    expect((await call('cookA', 'POST', `/recipes/${recipeA}/submit`, {})).statusCode).toBe(403)
    expect((await call('cookA', 'DELETE', `/recipes/${recipeA}`)).statusCode).toBe(403)
    expect((await call('cookA', 'POST', `/recipes/${recipeA}/approve`, {})).statusCode).toBe(403)
    expect((await call('cookA', 'GET', '/recipes/pending-approval')).statusCode).toBe(403)
    // The food-cost report moved to /reports/food-cost (wave B); the line cook reads neither.
    expect((await call('cookA', 'GET', '/recipes/food-cost')).statusCode).not.toBe(200)
    expect((await call('cookA', 'GET', '/reports/food-cost/summary')).statusCode).toBe(403)
    expect((await call('cookA', 'GET', `/recipes/${recipeA}/test-attempts`)).statusCode).toBe(403)
  })
})

// ─── UI-07: finance reads food cost, per company ─────────────────────────────

describe('finance reads food cost and the recipe list, scoped per company (UI-07)', () => {
  it('GET /reports/food-cost/summary: 200, only its own company\'s sales', async () => {
    const a = await call('financeA', 'GET', '/reports/food-cost/summary')
    expect(a.statusCode).toBe(200)
    const blocks = a.json().companies as Array<{ tenantId: string; items: Array<{ menuItemId: string; qtySold: number; hasRecipe: boolean }> }>
    expect(blocks.map((b) => b.tenantId)).toEqual([tenantA])
    expect(blocks[0]!.items.map((i) => i.menuItemId)).toEqual([burgerA])
    expect(blocks[0]!.items[0]!.qtySold).toBe(2)
    expect(blocks[0]!.items[0]!.hasRecipe).toBe(true)

    const b = (await call('financeB', 'GET', '/reports/food-cost/summary')).json()
    expect((b.companies[0].items as Array<{ menuItemId: string }>).map((i) => i.menuItemId)).toEqual([burgerB])

    // Naming company A's brand from company B is a 404 — never A's numbers.
    expect((await call('financeB', 'GET', `/reports/food-cost/summary?conceptId=${conceptA}`)).statusCode).toBe(404)
    // The old route is gone.
    expect((await call('financeA', 'GET', '/recipes/food-cost')).statusCode).not.toBe(200)
  })

  it('GET /recipes: own company, with costs; edits stay closed', async () => {
    const rows = (await call('financeA', 'GET', '/recipes')).json() as Row[]
    expect(rows.map((r) => r.id)).toEqual([recipeA])
    expect(typeof rows[0]!.totalCostCents).toBe('number')
    expect(((await call('financeB', 'GET', '/recipes')).json() as Row[]).map((r) => r.id)).toEqual([recipeB])
    expect((await call('financeA', 'PUT', `/recipes/${recipeA}`, { servings: 2 })).statusCode).toBe(403)
    expect((await call('financeA', 'GET', `/recipes/${recipeA}/costing`)).statusCode).toBe(403)
    // Finance reads the item list since wave B (opening counts and the item's
    // company are finance's — w3-stockdocs ITEM_READERS); it still never edits recipes.
    expect((await call('financeA', 'GET', '/inventory')).statusCode).toBe(200)
  })
})

// ─── Review fixes (W3D-RV-1, -2, -4, -5) ─────────────────────────────────────
//
// A company-less legacy item ("Legacy Oil") that company A's recipes use is a
// manager's clean-up job. The roles wave 3 let in — boh and procurement — do
// not see it, re-price it, claim it or waste it. Nobody wastes it until it has
// a company (its waste could reach no ledger). An operator with no company
// sees nothing. And a kitchen role gets no pricing inputs on a sub-recipe.

describe('company-less legacy items stay with managers (W3D-RV-1, -2, -5)', () => {
  let legacyOil: string
  let legacyFlour: string
  let plateWithSauce: string

  beforeAll(async () => {
    legacyOil = (await prisma.inventoryItem.create({ data: { name: 'Legacy Oil', unit: 'L', currentStock: 20, parLevel: 5, unitCostCents: 80_000, tenantId: null } })).id
    legacyFlour = (await prisma.inventoryItem.create({ data: { name: 'Legacy Flour', unit: 'kg', currentStock: 10, parLevel: 0, unitCostCents: 20_000, tenantId: null } })).id
    await prisma.wasteLog.create({ data: { inventoryItemId: legacyOil, quantity: 0.1, unit: 'L', reason: 'spoilage', estimatedCostCents: 8_000 } })

    // Company A's sauce (a sub-recipe with its own pricing inputs) fries in
    // the legacy oil; A's second plate uses the sauce.
    const sauce = (await prisma.recipe.create({
      data: {
        kind: 'component', name: 'Burger sauce', yieldGrams: 500, qFactorPct: 13, targetProfitPct: 41,
        targetFoodCostPct: 27, packagingPct: 6, actualSellingPriceCents: 99_000,
        ingredients: { create: [{ inventoryItemId: legacyOil, quantity: 0.2, unit: 'L', yieldPct: 1 }] },
      },
    })).id
    const cat = (await prisma.category.findFirstOrThrow({ where: { conceptId: conceptA } })).id
    const fries = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Fries A', priceCents: 50_000 } })).id
    plateWithSauce = (await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId: fries, servings: 1, actualSellingPriceCents: 55_000, qFactorPct: 12,
        ingredients: { create: [{ prepRecipeId: sauce, quantity: 30, unit: 'g' }] },
      },
    })).id

    const nobody = await prisma.user.create({
      data: { name: 'cookNone', email: 'cooknone.w3kitchen@test.local', password: await bcrypt.hash('x-Password-1', 4), role: 'boh', isActive: true, accountStatus: 'active', tenantId: null },
    })
    users['cookNone'] = { id: nobody.id, token: (issueStaffSession(nobody) as { accessToken: string }).accessToken }
  })

  it('procurement of company B cannot re-price or claim a company-less item', async () => {
    const reprice = await call('buyerB', 'PATCH', `/inventory/${legacyOil}`, { unitCostCents: 999_999 })
    expect(reprice.statusCode).toBe(422)
    expect(reprice.json().error.code).toBe('ITEM_HAS_NO_COMPANY')
    const claim = await call('buyerB', 'PATCH', `/inventory/${legacyOil}`, { tenantId: tenantB })
    expect(claim.statusCode).toBe(422)
    // Same for company A's own buyer: assigning a company is the managers' job.
    expect((await call('buyerA', 'PATCH', `/inventory/${legacyOil}`, { tenantId: tenantA })).statusCode).toBe(422)
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: legacyOil } })
    expect(after.unitCostCents).toBe(80_000)
    expect(after.tenantId).toBeNull()
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: legacyOil } })).toBe(0)
  })

  it('boh and procurement do not see company-less rows; managers still do', async () => {
    for (const who of ['cookA', 'cookB', 'buyerA', 'buyerB']) {
      const rows = (await call(who, 'GET', '/inventory')).json() as Row[]
      expect(rows.some((r) => r.id === legacyOil), who).toBe(false)
      const logs = (await call(who, 'GET', '/inventory/waste-logs')).json() as Array<{ inventoryItemId: string }>
      expect(logs.some((l) => l.inventoryItemId === legacyOil), who).toBe(false)
    }
    const ceo = (await call('ceoA', 'GET', '/inventory')).json() as Row[]
    expect(ceo.some((r) => r.id === legacyOil)).toBe(true)
    const ceoLogs = (await call('ceoA', 'GET', '/inventory/waste-logs')).json() as Array<{ inventoryItemId: string }>
    expect(ceoLogs.some((l) => l.inventoryItemId === legacyOil)).toBe(true)
  })

  it('nobody wastes a company-less item — stock does not move off the books', async () => {
    for (const who of ['cookB', 'cookA', 'ceoA']) {
      const res = await call(who, 'POST', `/inventory/${legacyOil}/waste`, { quantity: 0.5, unit: 'L', reason: 'spoilage', photoUrl: PHOTO })
      expect(res.statusCode, who).toBe(422)
      expect(res.json().error.code, who).toBe('ITEM_HAS_NO_COMPANY')
    }
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: legacyOil } })).currentStock).toBe(20)
    expect(await prisma.wasteLog.count({ where: { inventoryItemId: legacyOil } })).toBe(1)
  })

  it('a manager still assigns a company to a legacy item, and it can then be wasted in that company', async () => {
    const res = await call('ceoA', 'PATCH', `/inventory/${legacyFlour}`, { tenantId: tenantA })
    expect(res.statusCode).toBe(200)
    expect(res.json().tenantId).toBe(tenantA)
    const waste = await call('cookA', 'POST', `/inventory/${legacyFlour}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })
    expect(waste.statusCode).toBe(201)
    expect((await call('cookB', 'POST', `/inventory/${legacyFlour}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })).statusCode).toBe(404)
  })

  it('a boh login with no company gets nothing: an empty scope denies', async () => {
    const inv = await call('cookNone', 'GET', '/inventory')
    expect(inv.statusCode).toBe(200)
    expect(inv.json()).toEqual([])
    const logs = await call('cookNone', 'GET', '/inventory/waste-logs')
    expect(logs.statusCode).toBe(200)
    expect(logs.json()).toEqual([])
    expect((await call('cookNone', 'GET', '/inventory/alerts')).json()).toEqual([])
  })

  it('boh gets no pricing inputs on the recipe or on a sub-recipe it uses (W3D-RV-4)', async () => {
    const rows = (await call('cookA', 'GET', '/recipes')).json() as Array<Row & { ingredients: Array<Row & { prepRecipe: Row | null }> }>
    const plate = rows.find((r) => r.id === plateWithSauce)!
    expect(plate).toBeTruthy()
    for (const k of ['qFactorPct', 'targetProfitPct', 'targetFoodCostPct', 'packagingPct', 'actualSellingPriceCents']) {
      expect(plate[k], `plate.${k}`).toBeNull()
    }
    const prep = plate.ingredients.find((i) => i.prepRecipe)!.prepRecipe!
    expect(prep.name).toBe('Burger sauce')
    for (const k of ['qFactorPct', 'targetProfitPct', 'targetFoodCostPct', 'packagingPct', 'actualSellingPriceCents']) {
      expect(prep[k], `prepRecipe.${k}`).toBeNull()
    }
    const detail = (await call('cookA', 'GET', `/recipes/${plateWithSauce}`)).json()
    expect(detail.actualSellingPriceCents).toBeNull()
    expect(detail.qFactorPct).toBeNull()

    // A manager still reads them.
    const ceoRows = (await call('ceoA', 'GET', '/recipes')).json() as Array<Row & { ingredients: Array<Row & { prepRecipe: Row | null }> }>
    const ceoPrep = ceoRows.find((r) => r.id === plateWithSauce)!.ingredients.find((i) => i.prepRecipe)!.prepRecipe!
    expect(ceoPrep.qFactorPct).toBe(13)
    expect(ceoPrep.targetProfitPct).toBe(41)
  })
})

// ─── The Count page: the line cook submits a count in its own company ────────
describe('boh takes stock counts in its own company (UI-10, physical counts)', () => {
  it('boh A counts A\'s item; stock becomes the count; the list shows only A\'s counts', async () => {
    // A count that differs from the books names a reason (wave B, w3-stockdocs: COUNT_REASON_REQUIRED).
    const res = await call('cookA', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: beefA, physicalQty: 4.5, reason: 'trim loss' }] })
    expect(res.statusCode).toBe(201)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefA } })).currentStock).toBe(4.5)
    const listA = await call('cookA', 'GET', '/crosschecks/physical-counts')
    expect(listA.statusCode).toBe(200)
    expect((listA.json() as Array<{ tenantId: string }>).every((c) => c.tenantId === tenantA)).toBe(true)
    const listB = await call('cookB', 'GET', '/crosschecks/physical-counts')
    expect(listB.statusCode).toBe(200)
    expect((listB.json() as Array<{ id: string }>).map((c) => c.id)).not.toContain((res.json() as { id: string }).id)
  })

  it('boh B gets 404 counting company A\'s item, and A\'s stock is untouched', async () => {
    const before = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefA } })).currentStock
    const res = await call('cookB', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: beefA, physicalQty: 99 }] })
    expect(res.statusCode).toBe(404)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefA } })).currentStock).toBe(before)
  })

  it('procurement, kitchen, expediter and cashier still cannot count', async () => {
    for (const who of ['buyerA', 'lineA', 'expoA', 'cashierA']) {
      expect((await call(who, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: beefA, physicalQty: 1 }] })).statusCode, who).toBe(403)
      expect((await call(who, 'GET', '/crosschecks/physical-counts')).statusCode, who).toBe(403)
    }
  })
})
