// Use-by dates on perishable stock (owner B6, 2026-10-26: "Use-by date on deliveries of perishable items, plus an
// expiring-soon list and bell notice").
//
// What this guards:
//   - perishable + shelf life are the servd master's definition, mirrored onto every company's linked item; a linked
//     item refuses them (422 MASTER_FIELD_LOCKED); an unlinked item keeps its own.
//   - The dock: a perishable line with no shelf life needs a use-by (422 USE_BY_REQUIRED, nothing written); typed →
//     on the lot; a shelf life defaults it (received day + days); a non-perishable lot has none.
//   - A transfer carries the use-by to the arrived lot; a prep batch's lot takes the earliest use-by drawn.
//   - GET /inventory/expiring: the companies in view only (B never sees A's lots; A's outlet → 422), expired included,
//     a kitchen floor role sees no value.
//   - The bell: once per lot per stage, to the owning company's kitchen managers only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { addDays, dayToDate, karachiDay } from '../src/lib/useBy.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { ingredientMasterRoutes } from '../src/modules/ingredientMaster/routes.js'
import { runStockExpiryForCompany } from '../src/workers/stockExpiry.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
let A2: string
let supA: string
const u: Record<string, Who> = {}
let seq = 0
const today = karachiDay()

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function mkItem(co: Company, data: { perishable?: boolean; shelfLifeDays?: number | null } = {}) {
  return prisma.inventoryItem.create({ data: { name: `UB item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: 1_000, category: 'produce', ...data } })
}
function lotAt(co: Company, itemId: string, qty: number, useBy: string | null, locationId: string = co.locationId) {
  const src = `ub-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, unitCostCents: 1_000, kind: 'opening', lotSourceType: 'opening',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 86_400_000), locationId,
    useBy: useBy ? dayToDate(useBy) : null,
  }))
}
const lotOf = (id: string) => prisma.stockLot.findUniqueOrThrow({ where: { id } })
const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

beforeAll(async () => {
  A = await mkCompany('ub-a')
  B = await mkCompany('ub-b')
  A2 = (await prisma.location.create({ data: { slug: 'loc-ub-a2', name: 'Outlet UB A2', tenantId: A.tenantId } })).id
  await prisma.conceptLocation.create({ data: { conceptId: A.conceptId, locationId: A.locationId, isPrimary: true } })
  supA = (await prisma.supplier.create({ data: { name: 'UB Greens', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('ubMgrA', 'manager', A.tenantId)
  u.chefA = await mkUser('ubChefA', 'boh_management', A.tenantId)
  u.cookA = await mkUser('ubCookA', 'boh', A.tenantId)
  u.mgrB = await mkUser('ubMgrB', 'manager', B.tenantId)
  u.chefB = await mkUser('ubChefB', 'boh_management', B.tenantId)
  await ensureFifoReady(A.tenantId)
  await ensureFifoReady(B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(crosschecksRoutes)
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.register(ingredientMasterRoutes, { prefix: '/ingredient-master' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('perishable is the master\'s definition', () => {
  it('a master PATCH mirrors onto both companies\' items; a linked item refuses it; an unlinked item keeps its own', async () => {
    const m = await call(u.mgrA!, 'POST', '/ingredient-master', { name: 'UB Coriander', unit: 'g' })
    expect(m.statusCode, m.body).toBe(201)
    const masterId = m.json().id as string
    const itA = (await call(u.mgrA!, 'POST', '/inventory/from-master', { masterIngredientId: masterId })).json().id as string
    const itB = (await call(u.mgrB!, 'POST', '/inventory/from-master', { masterIngredientId: masterId })).json().id as string
    const p = await call(u.mgrA!, 'PATCH', `/ingredient-master/${masterId}`, { perishable: true, shelfLifeDays: 4 })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json()).toMatchObject({ perishable: true, shelfLifeDays: 4 })
    for (const id of [itA, itB]) expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).toMatchObject({ perishable: true, shelfLifeDays: 4 })
    const locked = await call(u.mgrA!, 'PATCH', `/inventory/${itA}`, { perishable: false })
    expect(locked.statusCode).toBe(422)
    expect(locked.json().error.code).toBe('MASTER_FIELD_LOCKED')
    // A new company item made from the master takes the definition.
    const C = await mkCompany('ub-c')
    const mgrC = await mkUser('ubMgrC', 'manager', C.tenantId)
    const itC = (await call(mgrC, 'POST', '/inventory/from-master', { masterIngredientId: masterId })).json()
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itC.id } })).toMatchObject({ perishable: true, shelfLifeDays: 4 })

    const loose = await mkItem(A)
    const ok = await call(u.mgrA!, 'PATCH', `/inventory/${loose.id}`, { perishable: true, shelfLifeDays: 2 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ perishable: true, shelfLifeDays: 2 })
  })
})

describe('the dock records the use-by', () => {
  const receive = (who: Who, lines: Array<Record<string, unknown>>) =>
    call(who, 'POST', '/receiving', { supplierId: supA, locationId: A.locationId, lines })

  it('perishable with no shelf life and no use-by → 422 USE_BY_REQUIRED; nothing written', async () => {
    const it0 = await mkItem(A, { perishable: true })
    const before = await prisma.goodsReceipt.count({ where: { tenantId: A.tenantId } })
    const r = await receive(u.mgrA!, [{ inventoryItemId: it0.id, quantityReceived: 2, unitCostCents: 1_000 }])
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('USE_BY_REQUIRED')
    expect(await prisma.goodsReceipt.count({ where: { tenantId: A.tenantId } })).toBe(before)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: it0.id } })).toBe(0)
  })

  it('a typed use-by lands on the lot; a shelf life defaults it; a non-perishable lot has none; a bad date is refused', async () => {
    const typed = await mkItem(A, { perishable: true })
    const shelf = await mkItem(A, { perishable: true, shelfLifeDays: 3 })
    const plain = await mkItem(A)
    const useBy = addDays(today, 5)
    const r = await receive(u.mgrA!, [
      { inventoryItemId: typed.id, quantityReceived: 2, unitCostCents: 1_000, useBy },
      { inventoryItemId: shelf.id, quantityReceived: 1, unitCostCents: 1_000 },
      { inventoryItemId: plain.id, quantityReceived: 1, unitCostCents: 1_000 },
    ])
    expect(r.statusCode, r.body).toBe(201)
    expect(dayOf((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: typed.id } })).useBy)).toBe(useBy)
    expect(dayOf((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: shelf.id } })).useBy)).toBe(addDays(today, 3))
    expect((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: plain.id } })).useBy).toBeNull()
    const bad = await receive(u.mgrA!, [{ inventoryItemId: typed.id, quantityReceived: 1, unitCostCents: 1_000, useBy: '2026-02-31' }])
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('USE_BY_INVALID')
  })
})

describe('use-by travels with the food', () => {
  it('a transfer carries the shipped lot\'s use-by to the arrived lot', async () => {
    const it0 = await mkItem(A, { perishable: true })
    const ub = addDays(today, 6)
    await lotAt(A, it0.id, 5, ub)
    const created = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: A2, quantity: 2, unit: 'kg' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).statusCode).toBe(200)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
    const rcv = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, {})
    expect(rcv.statusCode, rcv.body).toBe(200)
    const arrived = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id, locationId: A2 } })
    expect(dayOf(arrived.useBy)).toBe(ub)
  })

  it('a prep batch\'s lot takes the earliest use-by of the lots it drew', async () => {
    const leaf = await mkItem(A, { perishable: true })
    const oil = await mkItem(A)
    await lotAt(A, leaf.id, 1, addDays(today, 2))
    await lotAt(A, leaf.id, 5, addDays(today, 8))
    await lotAt(A, oil.id, 5, null)
    const recipe = (await prisma.recipe.create({ data: {
      kind: 'component', name: `UB pesto ${++seq}`, yieldGrams: 1000, status: 'production', tenantId: A.tenantId,
      ingredients: { create: [{ inventoryItemId: leaf.id, quantity: 1500, unit: 'g' }, { inventoryItemId: oil.id, quantity: 500, unit: 'g' }] },
    } })).id
    const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    const dish = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: `UB pasta ${seq}`, priceCents: 90_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: dish.id, servings: 1, status: 'production', tenantId: A.tenantId, ingredients: { create: [{ prepRecipeId: recipe, quantity: 50, unit: 'g' }] } } })
    const r = await call(u.chefA!, 'POST', '/prep-batches', { recipeId: recipe, itemName: 'Pesto', batches: 1, actualYieldQty: 1000, unit: 'g', locationId: A.locationId })
    expect(r.statusCode, r.body).toBe(201)
    const prepItem = await prisma.inventoryItem.findFirstOrThrow({ where: { tenantId: A.tenantId, prepRecipeId: recipe } })
    const made = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: prepItem.id } })
    expect(dayOf(made.useBy)).toBe(addDays(today, 2))
  })
})

describe('the expiring-soon list and the bell', () => {
  let soonLot: string
  let expiredLot: string
  let laterLot: string
  beforeAll(async () => {
    const it0 = await mkItem(A, { perishable: true })
    soonLot = (await lotAt(A, it0.id, 2, addDays(today, 1))).lotId
    expiredLot = (await lotAt(A, it0.id, 1, addDays(today, -1))).lotId
    laterLot = (await lotAt(A, it0.id, 1, addDays(today, 20))).lotId
    const itB = await mkItem(B, { perishable: true })
    await lotAt(B, itB.id, 1, addDays(today, 1))
  })

  it('GET /inventory/expiring lists the company\'s lots due within the window, expired included', async () => {
    const r = await call(u.mgrA!, 'GET', '/inventory/expiring?days=3')
    expect(r.statusCode, r.body).toBe(200)
    const ids = (r.json().items as Array<{ lotId: string }>).map((x) => x.lotId)
    expect(ids).toEqual(expect.arrayContaining([soonLot, expiredLot]))
    expect(ids).not.toContain(laterLot)
    const ex = (r.json().items as Array<{ lotId: string; status: string; daysLeft: number; remainingValueCents?: number }>).find((x) => x.lotId === expiredLot)!
    expect(ex).toMatchObject({ status: 'expired', daysLeft: -1 })
    expect(ex.remainingValueCents).toBe(1_000)
    // Company B never sees A's lots, and A's outlet is not one of B's.
    const rb = await call(u.mgrB!, 'GET', '/inventory/expiring?days=3')
    expect((rb.json().items as Array<{ tenantId: string }>).every((x) => x.tenantId === B.tenantId)).toBe(true)
    expect((rb.json().items as Array<{ lotId: string }>).map((x) => x.lotId)).not.toContain(soonLot)
    const foreign = await call(u.mgrB!, 'GET', `/inventory/expiring?locationId=${A.locationId}`)
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    // A line cook sees the list without value.
    const cook = await call(u.cookA!, 'GET', '/inventory/expiring')
    expect(cook.statusCode).toBe(200)
    expect(cook.json().costsHidden).toBe(true)
    expect((cook.json().items as Array<Record<string, unknown>>).every((x) => !('remainingValueCents' in x))).toBe(true)
  })

  it('the bell tells the company\'s kitchen managers once per lot per stage, never another company', async () => {
    const r = await runStockExpiryForCompany(A.tenantId)
    expect(r.soon).toBeGreaterThanOrEqual(1)
    expect(r.expired).toBeGreaterThanOrEqual(1)
    expect((await lotOf(soonLot)).useByWarnedAt).not.toBeNull()
    expect((await lotOf(expiredLot)).expiredWarnedAt).not.toBeNull()
    expect((await lotOf(laterLot)).useByWarnedAt).toBeNull()
    const notes = await prisma.staffNotification.findMany({ where: { kind: 'stock.expiring', tenantId: A.tenantId } })
    expect(notes.some((n) => n.userId === u.chefA!.id && n.severity === 'critical')).toBe(true)
    expect(notes.some((n) => n.userId === u.chefA!.id && n.severity === 'warning')).toBe(true)
    expect(notes.every((n) => n.link?.startsWith('/inventory?tab=expiring'))).toBe(true)
    expect(notes.some((n) => n.userId === u.chefB!.id || n.userId === u.mgrB!.id)).toBe(false)
    // Again: nothing new to claim.
    const again = await runStockExpiryForCompany(A.tenantId)
    expect(again).toMatchObject({ soon: 0, expired: 0, notices: 0 })
    // B's own run reaches B only.
    await runStockExpiryForCompany(B.tenantId)
    const bNotes = await prisma.staffNotification.findMany({ where: { kind: 'stock.expiring', tenantId: B.tenantId } })
    expect(bNotes.length).toBeGreaterThan(0)
    expect(bNotes.every((n) => n.userId !== u.chefA!.id && n.userId !== u.mgrA!.id)).toBe(true)
  })
})
