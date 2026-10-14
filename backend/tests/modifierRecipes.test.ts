// Modifier (add-on) recipes — RecipeKind 'modifier' (finance wave B, food
// cost): what ONE unit of a menu add-on uses, or removes.
//
// What this guards (two companies, plus an operator in both):
//   - a manager creates the recipe of their own company's add-on: kind
//     'modifier', no menu item, named after the add-on;
//   - another company's add-on → 404; an add-on of another of the
//     operator's companies (not the active one) → 422 MODIFIER_NOT_IN_COMPANY;
//   - a second recipe for the same add-on → 409 MODIFIER_HAS_RECIPE;
//   - negative quantities ('removes', e.g. "no onion") ONLY on modifier
//     recipes (422 NEGATIVE_QTY_NOT_ALLOWED on a sub-recipe);
//   - no Packaging section on an add-on (422 PACKAGING_ON_PLATES_ONLY), no
//     menu item on an add-on (400);
//   - company B → 404 on A's modifier recipe (read, costing, edit);
//   - costing-preview and by-item carry sections; by-item lists the dish's
//     add-on recipes; the list's brand filter includes add-on recipes.
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
let mgrAB: Who
let cheese: string
let onion: string
let box: string
let cheeseB: string
let extraCheese: string
let noOnion: string
let modB: string
let cheeseRecipe: string
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

async function modifierOf(menuItemId: string, group: string, name: string): Promise<string> {
  const g = await prisma.modifierGroup.create({ data: { menuItemId, name: group } })
  return (await prisma.modifier.create({ data: { groupId: g.id, name, priceDeltaCents: 10_000 } })).id
}

beforeAll(async () => {
  A = await mkCompany(`mr-a-${stamp}`)
  B = await mkCompany(`mr-b-${stamp}`)
  mgrA = await mkUser('mr-mgr-a', 'manager', A.tenantId)
  mgrB = await mkUser('mr-mgr-b', 'manager', B.tenantId)
  // An operator of both companies, active in A.
  mgrAB = await mkUser('mr-mgr-ab', 'manager', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: mgrAB.id } })
  const item = (tenantId: string, name: string, unit: string, category: string, unitCostCents: number) =>
    prisma.inventoryItem.create({ data: { tenantId, name: `${name} ${stamp}`, unit, category, unitCostCents } }).then((i) => i.id)
  cheese = await item(A.tenantId, 'Cheese', 'kg', 'dairy', 200_000)   // 20 g → 4,000
  onion = await item(A.tenantId, 'Onion', 'kg', 'produce', 20_000)    // 10 g → 200
  box = await item(A.tenantId, 'Box', 'pcs', 'packaging', 3_000)
  cheeseB = await item(B.tenantId, 'B cheese', 'kg', 'dairy', 100_000)
  extraCheese = await modifierOf(A.items.nihari, 'Extras', 'Extra cheese')
  noOnion = await modifierOf(A.items.nihari, 'Remove', 'No onion')
  modB = await modifierOf(B.items.nihari, 'Extras', 'Extra cheese')
  // The dish itself has a recipe (by-item reads the dish's).
  await prisma.recipe.create({ data: { kind: 'plate', menuItemId: A.items.nihari, ingredients: { create: [{ inventoryItemId: onion, quantity: 50, unit: 'g' }] } } })
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

describe('creating a modifier recipe', () => {
  it("creates one for the company's own add-on: kind 'modifier', no menu item, named after the add-on", async () => {
    const r = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: extraCheese, ingredients: [{ inventoryItemId: cheese, quantity: 20, unit: 'g' }] })
    expect(r.statusCode).toBe(201)
    const row = r.json()
    expect(row).toMatchObject({ kind: 'modifier', modifierId: extraCheese, menuItemId: null, name: 'Beef Nihari — Extra cheese', warnings: [] })
    cheeseRecipe = row.id
  })

  it("another company's add-on → 404; another of the operator's companies → 422 MODIFIER_NOT_IN_COMPANY", async () => {
    const foreign = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: modB, ingredients: [{ inventoryItemId: cheese, quantity: 20, unit: 'g' }] })
    expect(foreign.statusCode).toBe(404)
    const cross = await call(mgrAB, 'POST', '/recipes', { kind: 'modifier', modifierId: modB, ingredients: [{ inventoryItemId: cheese, quantity: 20, unit: 'g' }] })
    expect(cross.statusCode).toBe(422)
    expect(cross.json().error.code).toBe('MODIFIER_NOT_IN_COMPANY')
    expect(await prisma.recipe.count({ where: { modifierId: modB } })).toBe(0)
  })

  it('a second recipe for the same add-on → 409 MODIFIER_HAS_RECIPE', async () => {
    const r = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: extraCheese, ingredients: [{ inventoryItemId: cheese, quantity: 30, unit: 'g' }] })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('MODIFIER_HAS_RECIPE')
  })

  it('stock must be the add-on\'s company: B\'s cheese → 422 ITEM_NOT_IN_COMPANY', async () => {
    const r = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: noOnion, ingredients: [{ inventoryItemId: cheeseB, quantity: 20, unit: 'g' }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
  })

  it('no packaging on an add-on; no menu item on an add-on; a modifier is required', async () => {
    const pack = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: noOnion, ingredients: [{ inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' }] })
    expect(pack.statusCode).toBe(422)
    expect(pack.json().error.code).toBe('PACKAGING_ON_PLATES_ONLY')
    expect((await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: noOnion, menuItemId: A.items.kheer, ingredients: [{ inventoryItemId: onion, quantity: 1, unit: 'g' }] })).statusCode).toBe(400)
    expect((await call(mgrA, 'POST', '/recipes', { kind: 'modifier', ingredients: [{ inventoryItemId: onion, quantity: 1, unit: 'g' }] })).statusCode).toBe(400)
  })

  it("negative quantities ('removes') only on modifier recipes", async () => {
    const ok = await call(mgrA, 'POST', '/recipes', { kind: 'modifier', modifierId: noOnion, ingredients: [{ inventoryItemId: onion, quantity: -10, unit: 'g' }] })
    expect(ok.statusCode).toBe(201)
    const sub = await call(mgrA, 'POST', '/recipes', { kind: 'component', name: 'Sauce', yieldGrams: 100, ingredients: [{ inventoryItemId: onion, quantity: -10, unit: 'g' }] })
    expect(sub.statusCode).toBe(422)
    expect(sub.json().error.code).toBe('NEGATIVE_QTY_NOT_ALLOWED')
    const plate = await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ inventoryItemId: onion, quantity: -10, unit: 'g' }] })
    expect(plate.json().error.code).toBe('NEGATIVE_QTY_NOT_ALLOWED')
    // A zero quantity is never a line.
    expect((await call(mgrA, 'POST', '/recipes', { menuItemId: A.items.kheer, ingredients: [{ inventoryItemId: onion, quantity: 0, unit: 'g' }] })).statusCode).toBe(400)
  })
})

describe('reading and costing', () => {
  it("company B → 404 on A's modifier recipe; A reads it with its add-on chain", async () => {
    expect((await call(mgrB, 'GET', `/recipes/${cheeseRecipe}`)).statusCode).toBe(404)
    expect((await call(mgrB, 'GET', `/recipes/${cheeseRecipe}/costing`)).statusCode).toBe(404)
    expect((await call(mgrB, 'PUT', `/recipes/${cheeseRecipe}`, { notes: 'hijack' })).statusCode).toBe(404)
    expect((await call(mgrB, 'POST', '/recipes/costing-preview', { kind: 'modifier', modifierId: extraCheese, ingredients: [] })).statusCode).toBe(404)
    const own = (await call(mgrA, 'GET', `/recipes/${cheeseRecipe}`)).json()
    expect(own.modifier).toMatchObject({ id: extraCheese, name: 'Extra cheese', group: { name: 'Extras', menuItemId: A.items.nihari, menuItem: { conceptId: A.conceptId } } })
    const costing = (await call(mgrA, 'GET', `/recipes/${cheeseRecipe}/costing`)).json()
    expect(costing.standardCents).toBe(4_000)
    expect(costing.packagingCents).toBe(0)
    expect(costing.targetMcCents).toEqual({ dine_in: 4_000, takeout: 4_000, delivery: 4_000 })
    expect(costing.recipe.modifierName).toBe('Beef Nihari — Extra cheese')
    // A modifier recipe edit keeps to the same rules: a negative line is fine, packaging is not.
    expect((await call(mgrA, 'PUT', `/recipes/${cheeseRecipe}`, { ingredients: [{ inventoryItemId: cheese, quantity: 25, unit: 'g' }, { inventoryItemId: onion, quantity: -5, unit: 'g' }] })).statusCode).toBe(200)
    expect((await call(mgrA, 'PUT', `/recipes/${cheeseRecipe}`, { ingredients: [{ inventoryItemId: box, quantity: 1, unit: 'pcs' }] })).json().error.code).toBe('PACKAGING_ON_PLATES_ONLY')
  })

  it('costing-preview of an add-on: sections on the lines, a negative line takes cost off', async () => {
    const r = await call(mgrA, 'POST', '/recipes/costing-preview', {
      kind: 'modifier', modifierId: noOnion,
      ingredients: [{ inventoryItemId: onion, quantity: -10 }, { inventoryItemId: cheese, quantity: 20 }],
    })
    expect(r.statusCode).toBe(200)
    const p = r.json()
    expect(p.lines.map((l: { section: string }) => l.section)).toEqual(['ingredients', 'ingredients'])
    expect(p.lines[0].costCents).toBe(-200)
    expect(p.standardCents).toBe(3_800)
    expect(p.warnings).toEqual({ outsideCompany: [], costedWhileUnapproved: false, noPackaging: false })
    // Negative lines are refused in a sub-recipe preview, packaging in an add-on preview.
    expect((await call(mgrA, 'POST', '/recipes/costing-preview', { kind: 'component', ingredients: [{ inventoryItemId: onion, quantity: -10 }] })).json().error.code).toBe('NEGATIVE_QTY_NOT_ALLOWED')
    expect((await call(mgrA, 'POST', '/recipes/costing-preview', { kind: 'modifier', modifierId: noOnion, ingredients: [{ inventoryItemId: box, quantity: 1, section: 'packaging' }] })).json().error.code).toBe('PACKAGING_ON_PLATES_ONLY')
  })

  it("by-item lists the dish's add-on recipes with their lines and sections; B sees nothing", async () => {
    const r = (await call(mgrA, 'GET', `/recipes/by-item/${A.items.nihari}`)).json()
    expect(r.sections.packaging).toEqual([])
    expect(r.sections.ingredients).toHaveLength(1)
    const names = r.addOns.map((a: { name: string }) => a.name).sort()
    expect(names).toEqual(['Extra cheese', 'No onion'])
    const noOnionRow = r.addOns.find((a: { name: string }) => a.name === 'No onion')
    expect(noOnionRow.ingredients).toEqual([expect.objectContaining({ name: `Onion ${stamp}`, quantity: -10, section: 'ingredients' })])
    expect((await call(mgrB, 'GET', `/recipes/by-item/${A.items.nihari}`)).json()).toBeNull()
  })

  it("the list's brand filter includes the brand's add-on recipes; B never sees them", async () => {
    const rows = (await call(mgrA, 'GET', `/recipes?conceptId=${A.conceptId}`)).json() as Array<{ id: string; kind: string; costPerPortionCents: number | null }>
    const mine = rows.find((r) => r.id === cheeseRecipe)!
    expect(mine.kind).toBe('modifier')
    expect(mine.costPerPortionCents).toBe(Math.round(25 / 1000 * 200_000 * 1.1 - 5 / 1000 * 20_000 * 1.1))
    expect(((await call(mgrB, 'GET', '/recipes')).json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(cheeseRecipe)
    expect(((await call(mgrB, 'GET', `/recipes?conceptId=${A.conceptId}`)).json())).toEqual([])
  })
})
