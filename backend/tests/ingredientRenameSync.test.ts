// Renaming an ingredient on the sheet renames every company's linked stock item (owner, 2026-11-12: "I pick birds eye
// chili from the list and it inputs red Onion"), and the catch-up migration fixes items left behind by earlier renames.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
const call = (who: Who, method: 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany('irsA')
  B = await mkCompany('irsB')
  u.ceo = await mkUser('irsCeo', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceo.id } })
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
async function linked(masterId: string, tenantId: string, name: string): Promise<string> {
  return (await prisma.inventoryItem.create({ data: { tenantId, name, unit: 'g', category: 'produce', masterIngredientId: masterId } as never })).id
}

describe('rename carries over', () => {
  it('every company\'s linked item takes the new name; a company with another item of that name keeps its own', async () => {
    const m = (await call(u.ceo!, 'POST', '/ingredient-master', { name: `Red Onion ${stamp}`, unit: 'kg', category: 'produce' })).json()
    const a = await linked(m.id, A.tenantId, `Red Onion ${stamp}`)
    const b = await linked(m.id, B.tenantId, `Red Onion ${stamp}`)
    await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: `Bird's Eye Chili ${stamp}`, unit: 'g', category: 'produce' } as never })
    const r = await call(u.ceo!, 'PATCH', `/ingredient-master/${m.id}`, { name: `Bird's Eye Chili ${stamp}` })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: a } })).name).toBe(`Bird's Eye Chili ${stamp}`)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: b } })).name).toBe(`Red Onion ${stamp}`)
  })

  it('the catch-up migration renames items left behind by an earlier rename, and nothing else', async () => {
    const m = await prisma.ingredientMaster.create({ data: { name: `Green Chili ${stamp}`, normalizedName: `green chili ${stamp}`, stockUnit: 'g', category: 'produce' } })
    const left = await linked(m.id, A.tenantId, `Shallot ${stamp}`)
    const other = await linked(m.id, B.tenantId, `Chilli (local) ${stamp}`)
    await prisma.auditLog.create({ data: { category: 'identity', action: 'ingredient_master.update', entity: 'IngredientMaster', entityId: m.id, before: { name: `Shallot ${stamp}` }, after: { name: `Green Chili ${stamp}` } } as never })
    const sql = readFileSync(join(__dirname, '../prisma/migrations/20261112130000_ingredient_rename_sync/migration.sql'), 'utf8')
    await prisma.$executeRawUnsafe(sql.split('\n').filter((l) => !l.startsWith('--')).join('\n'))
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: left } })).name).toBe(`Green Chili ${stamp}`)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: other } })).name).toBe(`Chilli (local) ${stamp}`)
  })
})
