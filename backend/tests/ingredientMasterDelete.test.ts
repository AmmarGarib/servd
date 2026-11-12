// Delete an ingredient from servd's sheet (owner, 2026-11-12: "Give me access to delete ingredients from here. Or the
// needs review page"). DELETE /ingredient-master/:id — contract in the route's comment (ingredientMaster/routes.ts).
//
// What this guards:
//   - The CEO / F&B manager delete an UNUSED ingredient; every company's empty stock item for it goes to the Trash with
//     it, and the ingredient (with its typed prices) is parked as a snapshot.
//   - Anyone else 403; an ingredient in a recipe, or one a company holds stock / history for → 409 MASTER_IN_USE,
//     nothing changes.
//   - Restore from the Trash brings the ingredient back with the same id and its prices, re-linked to its stock items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { trashRoutes } from '../src/modules/trash/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'DELETE' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function ingredient(name: string): Promise<string> {
  const r = await call(u.ceo!, 'POST', '/ingredient-master', { name: `${name} ${Date.now()}-${++seq}`, unit: 'kg', category: 'dry_goods' })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id
}
async function stockItemFor(masterId: string, tenantId: string): Promise<string> {
  const m = await prisma.ingredientMaster.findUniqueOrThrow({ where: { id: masterId } })
  return (await prisma.inventoryItem.create({ data: { tenantId, name: m.name, unit: 'g', category: 'dry_goods', masterIngredientId: masterId } as never })).id
}

beforeAll(async () => {
  A = await mkCompany('imdA')
  B = await mkCompany('imdB')
  u.ceo = await mkUser('imdCeo', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceo.id } })
  u.fnb = await mkUser('imdFnb', 'fnb_manager', A.tenantId)
  u.chef = await mkUser('imdChef', 'boh_management', A.tenantId)
  await ensureFifoReady(A.tenantId)
  await ensureFifoReady(B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.register(trashRoutes, { prefix: '/trash' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('delete from the Ingredients sheet', () => {
  it('the CEO deletes an unused ingredient: gone from the sheet, empty stock items in the Trash, then restored', async () => {
    const id = await ingredient('Baking soda')
    await call(u.ceo!, 'PUT', `/ingredient-master/${id}/price`, { priceCents: 400_000 })
    const itemA = await stockItemFor(id, A.tenantId)
    const itemB = await stockItemFor(id, B.tenantId)
    const r = await call(u.ceo!, 'DELETE', `/ingredient-master/${id}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().stockItemsParked).toBe(2)
    expect(await prisma.ingredientMaster.findUnique({ where: { id } })).toBeNull()
    for (const it of [itemA, itemB]) {
      const row = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: it } })
      expect(row.deletedAt).not.toBeNull()
      expect(row.masterIngredientId).toBeNull()
    }
    const sheet = (await call(u.ceo!, 'GET', '/ingredient-master?limit=500')).json() as Array<{ id: string }>
    expect(sheet.map((x) => x.id)).not.toContain(id)

    const back = await call(u.ceo!, 'POST', `/trash/ingredient_master/${id}/restore`, {})
    expect(back.statusCode, back.body).toBe(200)
    expect(await prisma.ingredientMaster.findUnique({ where: { id } })).not.toBeNull()
    expect(await prisma.ingredientMasterPrice.count({ where: { masterIngredientId: id } })).toBeGreaterThan(0)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemA } })).masterIngredientId).toBe(id)
  })

  it('the F&B manager may delete; a chef gets 403', async () => {
    const id = await ingredient('Old flour')
    expect((await call(u.chef!, 'DELETE', `/ingredient-master/${id}`)).statusCode).toBe(403)
    expect((await call(u.fnb!, 'DELETE', `/ingredient-master/${id}`)).statusCode).toBe(200)
  })

  it('in a recipe, or a company holds stock for it → 409 MASTER_IN_USE, nothing changes', async () => {
    const inRecipe = await ingredient('Cocoa')
    const rec = await prisma.recipe.create({ data: { tenantId: A.tenantId, kind: 'component', name: 'Cocoa mix', status: 'iteration' } as never })
    await prisma.recipeIngredient.create({ data: { recipeId: rec.id, masterIngredientId: inRecipe, inventoryItemId: await stockItemFor(inRecipe, A.tenantId), quantity: 10, unit: 'g' } as never })
    const r1 = await call(u.ceo!, 'DELETE', `/ingredient-master/${inRecipe}`)
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('MASTER_IN_USE')

    const stocked = await ingredient('Salt')
    const item = await stockItemFor(stocked, B.tenantId)
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: B.tenantId, inventoryItemId: item, qty: 500, unitCostCents: 10, kind: 'receipt', lotSourceType: 'goods_receipt_line',
      lotSourceId: `imd-${Date.now()}`, movementSourceType: 'test', movementSourceId: `imd-${Date.now()}`, receivedAt: new Date(), locationId: B.locationId,
    }))
    const r2 = await call(u.ceo!, 'DELETE', `/ingredient-master/${stocked}`)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.details.reasons.join(' ')).toMatch(/stock/i)
    expect(await prisma.ingredientMaster.findUnique({ where: { id: stocked } })).not.toBeNull()
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item } })).deletedAt).toBeNull()
  })
})
