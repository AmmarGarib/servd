// A sub-recipe's stock is the stock of the companies whose dishes use it (W3
// gate finding stock-01) — backend/src/modules/recipes/routes.ts.
//
// A component (sub-recipe) has no brand of its own. Its stock lines used to be
// checked against EVERY company the operator belongs to, so a manager of
// companies A and B could put B's cheese into a sub-recipe only A's Nihari
// uses: every Nihari sale then skipped the cheese (a sale never consumes
// another company's stock), A's food cost left it out and B's lots never
// moved. Now:
//   - a component's lines (and step stations) must belong to the companies of
//     the dishes and add-ons that use it → else 422 ITEM_NOT_IN_COMPANY /
//     STATION_NOT_IN_COMPANY; one nothing uses yet binds to the ACTIVE company;
//   - a dish may not take a sub-recipe used by, or made from the stock of,
//     another company → 422 INGREDIENT_NOT_IN_COMPANY;
//   - the costing preview applies the same rule;
//   - company B → 404 on A's sub-recipe; A's own lines still save.
// Requires a disposable database (DATABASE_URL must contain "test").
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
let mgrAB: Who      // belongs to A and B, active in A
let cheeseA: string
let cheeseB: string
let stationB: string
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}`, ...headers } })
/** The portfolio view: the operator SEES both companies' recipes (read scope), so only the company rule refuses. */
const portfolio = { 'x-servd-portfolio': '1' }

/** A fresh dish of the company's brand. */
async function dishOf(co: Company): Promise<string> {
  const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: co.conceptId } })
  return (await prisma.menuItem.create({ data: { conceptId: co.conceptId, categoryId: cat.id, name: `Dish ${Math.random().toString(36).slice(2, 8)}`, priceCents: 50_000 } })).id
}

/** A sub-recipe with `itemId` as its one line, used by the dish `menuItemId` (none when null). */
async function sauceUsedBy(menuItemId: string | null, itemId: string) {
  const comp = await prisma.recipe.create({
    data: { kind: 'component', name: `Sauce ${stamp}-${Math.random().toString(36).slice(2, 6)}`, yieldGrams: 1000, ingredients: { create: [{ inventoryItemId: itemId, quantity: 100, unit: 'g' }] } },
  })
  if (menuItemId) {
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId, ingredients: { create: [{ prepRecipeId: comp.id, quantity: 50, unit: 'g' }] } } })
  }
  return comp.id
}

beforeAll(async () => {
  A = await mkCompany(`rcc-a-${stamp}`)
  B = await mkCompany(`rcc-b-${stamp}`)
  mgrA = await mkUser('rcc-mgr-a', 'manager', A.tenantId)
  mgrB = await mkUser('rcc-mgr-b', 'manager', B.tenantId)
  mgrAB = await mkUser('rcc-mgr-ab', 'manager', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: mgrAB.id } })
  cheeseA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: `Cheese A ${stamp}`, unit: 'kg', category: 'dairy', unitCostCents: 200_000 } })).id
  cheeseB = (await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: `Cheese B ${stamp}`, unit: 'kg', category: 'dairy', unitCostCents: 200_000 } })).id
  stationB = (await prisma.station.create({ data: { conceptId: B.conceptId, name: `Grill B ${stamp}`, isActive: true } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('a sub-recipe only A uses', () => {
  it('a manager of A and B cannot put B\'s stock in it → 422 ITEM_NOT_IN_COMPANY; A\'s own stock saves', async () => {
    const comp = await sauceUsedBy(A.items.nihari, cheeseA)
    const bad = await call(mgrAB, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseB, quantity: 100, unit: 'g' }] })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
    const lines = await prisma.recipeIngredient.findMany({ where: { recipeId: comp }, select: { inventoryItemId: true } })
    expect(lines.map((l) => l.inventoryItemId)).toEqual([cheeseA])
    const ok = await call(mgrAB, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseA, quantity: 120, unit: 'g' }] })
    expect(ok.statusCode).toBe(200)
    // A's own manager still edits it (its companies stayed {A}).
    expect((await call(mgrA, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseA, quantity: 110, unit: 'g' }] })).statusCode).toBe(200)
    // Company B: 404 on A's sub-recipe.
    expect((await call(mgrB, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseB, quantity: 100, unit: 'g' }] })).statusCode).toBe(404)
  })

  it('the costing preview refuses B\'s stock the same way', async () => {
    const comp = await sauceUsedBy(await dishOf(A), cheeseA)
    const r = await call(mgrAB, 'POST', '/recipes/costing-preview', {
      recipeId: comp, kind: 'component', yieldGrams: 1000, ingredients: [{ inventoryItemId: cheeseB, quantity: 100, unit: 'g' }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
  })

  it('a step station of company B → 422 STATION_NOT_IN_COMPANY', async () => {
    const comp = await sauceUsedBy(await dishOf(A), cheeseA)
    const r = await call(mgrAB, 'POST', `/recipes/${comp}/steps`, { phase: 'prep_mep', instruction: 'Melt', stationId: stationB })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('STATION_NOT_IN_COMPANY')
  })
})

describe('a sub-recipe nothing uses yet', () => {
  it('binds to the active company: A\'s stock saves, B\'s → 422', async () => {
    const comp = await sauceUsedBy(null, cheeseA)
    expect((await call(mgrAB, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseB, quantity: 100, unit: 'g' }] })).json().error.code).toBe('ITEM_NOT_IN_COMPANY')
    expect((await call(mgrAB, 'PUT', `/recipes/${comp}`, { ingredients: [{ inventoryItemId: cheeseA, quantity: 90, unit: 'g' }] })).statusCode).toBe(200)
  })
})

describe('a dish taking a sub-recipe', () => {
  it('of another company (used by B, or made from B\'s stock) → 422 INGREDIENT_NOT_IN_COMPANY; its own company\'s → 201', async () => {
    const usedByB = await sauceUsedBy(B.items.nihari, cheeseB)
    const madeFromB = await sauceUsedBy(null, cheeseB)
    for (const sub of [usedByB, madeFromB]) {
      const r = await call(mgrAB, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ prepRecipeId: sub, quantity: 50, unit: 'g' }] }, portfolio)
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('INGREDIENT_NOT_IN_COMPANY')
    }
    expect(await prisma.recipe.count({ where: { menuItemId: A.items.kheer } })).toBe(0)
    const own = await sauceUsedBy(null, cheeseA)
    const ok = await call(mgrAB, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ prepRecipeId: own, quantity: 50, unit: 'g' }] }, portfolio)
    expect(ok.statusCode).toBe(201)
  })
})
