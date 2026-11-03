// The CEO's clean-up of the old mastersheet (owner, 2026-11-03): removes masters that are in no recipe, were not typed
// in by a person, have no typed price and were never bought / stocked; their unused company items go to the Trash;
// removed ones are restorable. Everyone else 403.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance; let A: Company; let ceo: Who; let chef: Who
const stamp = Date.now()
const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })
const mk = (name: string, extra: Record<string, unknown> = {}) => prisma.ingredientMaster.create({
  data: { name: `${name} ${stamp}`, normalizedName: `${name} ${stamp}`.toLowerCase(), stockUnit: 'g', ...extra },
})

beforeAll(async () => {
  A = await mkCompany(`imc-${stamp}`)
  ceo = await mkUser('imcCeo', 'admin', A.tenantId)
  chef = await mkUser('imcChef', 'boh_management', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode
    return reply.status(status && status < 500 ? status : 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

describe('old mastersheet clean-up', () => {
  it('removes only the unused imported ones; restore brings one back', async () => {
    const old = await mk('Imported apricot')
    const oldItem = await prisma.inventoryItem.create({ data: { name: old.name, unit: 'g', tenantId: A.tenantId, masterIngredientId: old.id } })
    const priced = await mk('Priced anchovy')
    await prisma.ingredientMasterPrice.create({ data: { masterIngredientId: priced.id, perBaseCents: 1.7 } })
    const byHand = await mk('Hand typed beef', { createdByUserId: chef.id })
    const inRecipe = await mk('Recipe onion')
    const r = await prisma.recipe.create({ data: { name: `R ${stamp}`, kind: 'component', tenantId: A.tenantId } })
    const onionItem = await prisma.inventoryItem.create({ data: { name: inRecipe.name, unit: 'g', tenantId: A.tenantId, masterIngredientId: inRecipe.id } })
    await prisma.recipeIngredient.create({ data: { recipeId: r.id, inventoryItemId: onionItem.id, masterIngredientId: inRecipe.id, quantity: 10, unit: 'g' } })

    expect((await call(chef, 'GET', '/ingredient-master/cleanup')).statusCode).toBe(403)
    const pv = await call(ceo, 'GET', '/ingredient-master/cleanup')
    expect(pv.statusCode, pv.body).toBe(200)
    const ids = pv.json().toRemove.map((x: { id: string }) => x.id)
    expect(ids).toContain(old.id)
    for (const keep of [priced.id, byHand.id, inRecipe.id]) expect(ids).not.toContain(keep)

    const run = await call(ceo, 'POST', '/ingredient-master/cleanup', { ids: [old.id, priced.id] })
    expect(run.statusCode, run.body).toBe(200)
    expect(run.json().removed.map((x: { id: string }) => x.id)).toEqual([old.id])
    expect(run.json().skipped[0].reasons).toContain('Has a typed price')
    expect((await prisma.ingredientMaster.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('retired')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: oldItem.id } })).deletedAt).not.toBeNull()
    const list = await call(ceo, 'GET', `/ingredient-master?q=${encodeURIComponent('imported apricot')}`)
    expect(list.json().length).toBe(0)

    const back = await call(ceo, 'POST', `/ingredient-master/${old.id}/restore`, {})
    expect(back.statusCode, back.body).toBe(200)
    expect((await prisma.ingredientMaster.findUniqueOrThrow({ where: { id: old.id } })).status).toBe('approved')
  })
})
