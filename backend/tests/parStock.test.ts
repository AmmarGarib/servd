// Par stock today (owner, 2026-11-13) — expo sets how many portions of a dish
// are left; every sale counts it down (the lib/reservation.ts counter); at 0
// the dish is sold out; cancel / void gives back; expo raises, lowers or clears
// it. Never stock or the ledger. Two companies: B gets 404 on A's dish.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { menuRoutes } from '../src/modules/menu/routes.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { prisma, mkCompany, mkUser, caller, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let expoA: Who, expoB: Who, cashierA: Who, mgrA: Who

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await a.register(expoRoutes, { prefix: '/expo' })
  await a.register(menuRoutes, { prefix: '/menu' })
  await registerPreBillPlugins(a)
  await a.ready()
  return a
}

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

function ring(who: Who, co: Company, item: 'kheer' | 'nihari', quantity = 1) {
  return call(who, 'POST', '/pos/orders', {
    conceptId: co.conceptId,
    items: [{ menuItemId: co.items[item], name: item, quantity, unitPriceCents: item === 'kheer' ? 55_000 : 145_000, modifiers: [] }],
  })
}
const left = async (co: Company, id: string) => {
  const r = await call(expoA, 'GET', `/expo/par-stock?conceptId=${co.conceptId}`)
  return (r.json().items as Array<{ menuItemId: string; left: number | null; isAvailable: boolean; portionsSet: number | null }>).find((i) => i.menuItemId === id)!
}
const dish = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id }, select: { isAvailable: true, portionsAvailable: true } })

beforeAll(async () => {
  A = await mkCompany('par-a')
  B = await mkCompany('par-b')
  expoA = await mkUser('par-expo-a', 'expediter', A.tenantId)
  expoB = await mkUser('par-expo-b', 'expediter', B.tenantId)
  cashierA = await mkUser('par-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('par-mgr-a', 'foh_management', A.tenantId)
  await prisma.menuItem.updateMany({ where: { conceptId: { in: [A.conceptId, B.conceptId] } }, data: { isAvailable: true } })
  setFiscalKicker(async () => {})
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('par stock today', () => {
  it('company B gets 404 on A\'s dish (set and list)', async () => {
    const r = await call(expoB, 'PUT', '/expo/par-stock', { menuItemId: A.items.kheer, portions: 5 })
    expect(r.statusCode).toBe(404)
    expect((await dish(A.items.kheer)).portionsAvailable).toBeNull()
    const l = await call(expoB, 'GET', `/expo/par-stock?conceptId=${A.conceptId}`)
    expect(l.statusCode).toBe(404)
  })

  it('a cashier cannot set par stock (403)', async () => {
    const r = await call(cashierA, 'PUT', '/expo/par-stock', { menuItemId: A.items.kheer, portions: 5 })
    expect(r.statusCode).toBe(403)
  })

  it('set 2 → two sales ok → third refused PAR_STOCK_SHORT, dish sold out at 0; cancel gives back and switches on; set 5', async () => {
    const set = await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.kheer, portions: 2 })
    expect(set.statusCode, set.body).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'menu.par_stock_set', entityId: A.items.kheer, tenantId: A.tenantId } })).toBe(1)

    const r1 = await ring(cashierA, A, 'kheer')
    expect(r1.statusCode, r1.body).toBe(201)
    expect((await left(A, A.items.kheer)).left).toBe(1)
    const r2 = await ring(cashierA, A, 'kheer')
    expect(r2.statusCode, r2.body).toBe(201)
    expect((await left(A, A.items.kheer)).left).toBe(0)
    expect((await dish(A.items.kheer)).isAvailable).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: 'menu.par_stock_out', entityId: A.items.kheer, tenantId: A.tenantId } })).toBe(1)

    const r3 = await ring(cashierA, A, 'kheer')
    expect(r3.statusCode).toBe(409)
    expect(r3.json().error.code).toBe('PAR_STOCK_SHORT')
    expect((await left(A, A.items.kheer)).left).toBe(0)

    // Cancel the second ticket: one portion back, the dish this counter sold out comes back on.
    const cancel = await call(mgrA, 'POST', `/orders/${r2.json().id}/cancel`, { reason: 'guest walked out' })
    expect(cancel.statusCode, cancel.body).toBe(200)
    expect((await left(A, A.items.kheer)).left).toBe(1)
    expect((await dish(A.items.kheer)).isAvailable).toBe(true)
    // A repeat cancel gives nothing back twice.
    await call(mgrA, 'POST', `/orders/${r2.json().id}/cancel`, { reason: 'guest walked out' })
    expect((await left(A, A.items.kheer)).left).toBe(1)

    // Sell out again, then expo sets 5 → back on, 5 left.
    expect((await ring(cashierA, A, 'kheer')).statusCode).toBe(201)
    expect((await dish(A.items.kheer)).isAvailable).toBe(false)
    const set5 = await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.kheer, portions: 5 })
    expect(set5.statusCode, set5.body).toBe(200)
    expect(set5.json()).toMatchObject({ left: 5, isAvailable: true })
    expect((await left(A, A.items.kheer)).left).toBe(5)
  })

  it('a two-portion line on a dish with one left is refused whole; a line void gives back', async () => {
    await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.nihari, portions: 1 })
    const big = await ring(cashierA, A, 'nihari', 2)
    expect(big.statusCode).toBe(409)
    expect(big.json().error.details.short[0]).toMatchObject({ menuItemId: A.items.nihari, available: 1 })
    expect((await left(A, A.items.nihari)).left).toBe(1)
    const ok = await ring(cashierA, A, 'nihari', 1)
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await left(A, A.items.nihari)).left).toBe(0)
    const v = await call(mgrA, 'POST', `/pos/orders/${ok.json().id}/void`, { orderItemId: ok.json().items[0].id, reason: 'wrong item' })
    expect(v.statusCode, v.body).toBe(200)
    expect((await left(A, A.items.nihari)).left).toBe(1)
    expect((await dish(A.items.nihari)).isAvailable).toBe(true)
  })

  it('a dish 86\'d by hand is not switched on by a par set', async () => {
    await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.water, portions: 1 })
    expect((await ring(cashierA, A, 'kheer')).statusCode).toBe(201) // unrelated
    const w = await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: [{ menuItemId: A.items.water, name: 'Water', quantity: 1, unitPriceCents: 10_000, modifiers: [] }] })
    expect(w.statusCode, w.body).toBe(201)
    expect((await dish(A.items.water)).isAvailable).toBe(false)
    // The chef switches it off by hand after the sell-out (a person touched it).
    await new Promise((r) => setTimeout(r, 20))
    await prisma.menuItem.update({ where: { id: A.items.water }, data: { isAvailable: false, lastSyncedAt: null } })
    const set = await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.water, portions: 10 })
    expect(set.statusCode).toBe(200)
    expect(set.json().isAvailable).toBe(false)
    expect((await dish(A.items.water)).isAvailable).toBe(false)
  })

  it('null = unlimited: clear takes no portions and never sells out', async () => {
    const clr = await call(expoA, 'PUT', '/expo/par-stock', { menuItemId: A.items.kheer, portions: null })
    expect(clr.statusCode).toBe(200)
    for (let i = 0; i < 3; i++) expect((await ring(cashierA, A, 'kheer')).statusCode).toBe(201)
    const row = await left(A, A.items.kheer)
    expect(row).toMatchObject({ portionsSet: null, left: null, isAvailable: true })
    // The till's light read lists only dishes with a count.
    const till = await call(cashierA, 'GET', `/menu/${A.conceptId}/par-left`)
    expect(till.statusCode).toBe(200)
    expect((till.json().items as Array<{ menuItemId: string }>).some((i) => i.menuItemId === A.items.kheer)).toBe(false)
    expect((await call(expoB, 'GET', `/menu/${A.conceptId}/par-left`)).statusCode).toBe(404)
  })
})
