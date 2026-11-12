// A weighed ingredient may carry the weight of one piece (owner, 2026-11-12: "its 1 slice of nurpur cheese not 1g"):
// recipe lines are then typed in pieces. Display only — the stock item keeps its unit; the inventory list carries it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
const u: Record<string, Who> = {}
const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany('ipwA')
  u.ceo = await mkUser('ipwCeo', 'admin', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

const stamp = Date.now()

describe('piece weight', () => {
  it('a g ingredient takes a slice weight; the stock item list carries it; unit unchanged', async () => {
    const m = (await call(u.ceo!, 'POST', '/ingredient-master', { name: `Cheese slice ${stamp}`, unit: 'kg', category: 'dairy' })).json()
    const item = await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: `Cheese slice ${stamp}`, unit: 'kg', category: 'dairy', masterIngredientId: m.id } as never })
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { pieceGrams: 20, pieceLabel: 'slice' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ pieceGrams: 20, pieceLabel: 'slice', stockUnit: 'g' })
    const list = (await call(u.ceo!, 'GET', '/inventory')).json() as Array<{ id: string; unit: string; pieceGrams: number | null; pieceLabel: string | null }>
    expect(list.find((i) => i.id === item.id)).toMatchObject({ unit: 'kg', pieceGrams: 20, pieceLabel: 'slice' })
    // Cleared with null.
    const c = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { pieceGrams: null, pieceLabel: null })
    expect(c.json()).toMatchObject({ pieceGrams: null, pieceLabel: null })
  })

  it('a counted ingredient refuses a piece weight; zero or negative is refused', async () => {
    const m = (await call(u.ceo!, 'POST', '/ingredient-master', { name: `Bun ${stamp}`, unit: 'pcs', category: 'bakery' })).json()
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { pieceGrams: 60 })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('PIECE_ON_COUNT_UNIT')
    const g = (await call(u.ceo!, 'POST', '/ingredient-master', { name: `Ham ${stamp}`, unit: 'g', category: 'meat' })).json()
    expect((await call(u.ceo!, 'PATCH', `/ingredient-master/${g.id}`, { pieceGrams: 0 })).statusCode).toBe(400)
  })
})
