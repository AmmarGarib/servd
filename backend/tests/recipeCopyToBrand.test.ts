// Copy a dish to another brand (owner, 2026-11-12: "make the transfer/copy recipe to another company button").
// POST /recipes/:id/copy-to-brand — contract in the route's comment (recipes/routes.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let GS: Company
let FL: Company
let C3: Company
const u: Record<string, Who> = {}
const call = (who: Who, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${who.token}` } })
const stamp = Date.now()
let dish: string
let sauce: string
let beef: string
let flCat: string

beforeAll(async () => {
  GS = await mkCompany('rcb-gs')
  FL = await mkCompany('rcb-fl')
  C3 = await mkCompany('rcb-c3')
  u.ceo = await mkUser('rcbCeo', 'admin', GS.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: FL.tenantId, userId: u.ceo.id } })
  u.chefC3 = await mkUser('rcbChefC3', 'boh_management', C3.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    return reply.status(status && status < 500 ? status : 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(recipeRoutes, { prefix: '/recipes' })
  await app.ready()

  beef = (await prisma.ingredientMaster.create({ data: { name: `Beef ${stamp}`, normalizedName: `beef ${stamp}`, stockUnit: 'g', category: 'protein' } })).id
  const gsBeef = await prisma.inventoryItem.create({ data: { tenantId: GS.tenantId, name: `Beef ${stamp}`, unit: 'g', category: 'protein', masterIngredientId: beef } as never })
  const legacy = await prisma.inventoryItem.create({ data: { tenantId: GS.tenantId, name: `Old salt ${stamp}`, unit: 'g', category: 'dry_goods' } as never })
  sauce = (await prisma.recipe.create({ data: { tenantId: GS.tenantId, kind: 'component', name: `House sauce ${stamp}`, status: 'production', yieldGrams: 500 } as never })).id
  await prisma.recipeIngredient.create({ data: { recipeId: sauce, inventoryItemId: legacy.id, quantity: 10, unit: 'g' } as never })
  const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: GS.conceptId } })
  const item = await prisma.menuItem.create({ data: { conceptId: GS.conceptId, categoryId: cat.id, name: `Chocolate mousse ${stamp}`, description: 'Dark, airy', priceCents: 90_000 } })
  dish = (await prisma.recipe.create({ data: { tenantId: GS.tenantId, kind: 'plate', menuItemId: item.id, status: 'production', servings: 1, actualSellingPriceCents: 90_000 } as never })).id
  await prisma.recipeIngredient.create({ data: { recipeId: dish, inventoryItemId: gsBeef.id, masterIngredientId: beef, quantity: 120, unit: 'g' } as never })
  await prisma.recipeIngredient.create({ data: { recipeId: dish, prepRecipeId: sauce, quantity: 30, unit: 'g' } as never })
  flCat = (await prisma.category.findFirstOrThrow({ where: { conceptId: FL.conceptId } })).id
}, 60_000)
afterAll(async () => { await app?.close() })

describe('copy a dish to another brand', () => {
  it('the CEO copies a GS Foods dish to Flipd: a new Flipd recipe, sent for approval, its sub-recipe and stock in Flipd', async () => {
    const r = await call(u.ceo!, `/recipes/${dish}/copy-to-brand`, { conceptId: FL.conceptId, categoryId: flCat })
    expect(r.statusCode, r.body).toBe(201)
    const copy = await prisma.recipe.findUniqueOrThrow({ where: { id: r.json().id }, include: { ingredients: { include: { inventoryItem: true } } } })
    expect(copy.tenantId).toBe(FL.tenantId)
    expect(copy.status).toBe('pending_approval')
    expect(copy.menuItemId).toBeNull()
    expect(copy.pendingMenuItem).toMatchObject({ conceptId: FL.conceptId, categoryId: flCat, name: `Chocolate mousse ${stamp}` })
    expect(copy.actualSellingPriceCents).toBe(90_000)
    const raw = copy.ingredients.find((l) => l.masterIngredientId === beef)!
    expect(raw.inventoryItem!.tenantId).toBe(FL.tenantId)
    const subLine = copy.ingredients.find((l) => l.prepRecipeId)!
    expect(subLine.prepRecipeId).not.toBe(sauce)
    const subCopy = await prisma.recipe.findUniqueOrThrow({ where: { id: subLine.prepRecipeId! }, include: { ingredients: { include: { inventoryItem: true } } } })
    expect(subCopy.tenantId).toBe(FL.tenantId)
    expect(subCopy.ingredients[0]!.inventoryItem!.tenantId).toBe(FL.tenantId)
    expect(r.json().copiedSubRecipes).toHaveLength(1)
    // The source never changes.
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id: dish } })).tenantId).toBe(GS.tenantId)

    // A second copy reuses Flipd's sub-recipe (same name) instead of making another.
    const again = await call(u.ceo!, `/recipes/${dish}/copy-to-brand`, { conceptId: FL.conceptId, categoryId: flCat, name: `Mousse two ${stamp}` })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().copiedSubRecipes).toHaveLength(0)
  })

  it('same brand → 422; a stranger → 404', async () => {
    const same = await call(u.ceo!, `/recipes/${dish}/copy-to-brand`, { conceptId: GS.conceptId, categoryId: flCat })
    expect(same.statusCode).toBe(422)
    expect((await call(u.chefC3!, `/recipes/${dish}/copy-to-brand`, { conceptId: C3.conceptId, categoryId: flCat })).statusCode).toBe(404)
  })
})
