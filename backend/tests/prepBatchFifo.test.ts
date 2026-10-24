// Prep batches on FIFO lots (finance wave B) — POST /crosschecks/prep-batches.
//
// What this guards:
//   - An AD-HOC batch (no recipe) draws its inputs FIFO ('prep_draw'),
//     stores PrepBatch.drawValueCents and posts 'inventory.prep_draw:<id>'
//     Dr 50x0 / Cr 12x0 by class, in the batch's company.
//   - A SUB-RECIPE batch (prep as stock, owner 2026-10-24) draws its recipe
//     and adds its prep item at the actual yield — no posting (12x0 → 12x0).
//   - Not enough on the lots → 409 INSUFFICIENT_STOCK and the whole batch rolls back.
//   - Two companies: inputs must be the active company's (404); another
//     company's sub-recipe is 422 RECIPE_NOT_IN_COMPANY; another company's
//     outlet 422; lists never mix.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function lot(co: Company, itemId: string, qty: number, cost: number, daysAgo: number) {
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, unitCostCents: cost, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: `seed-${++seq}`, movementSourceType: 'test.seed', movementSourceId: `seed-${seq}`, receivedAt: new Date(Date.now() - daysAgo * DAY),
  }))
}
async function item(co: Company, category = 'produce') {
  await ensureFifoReady(co.tenantId)
  return prisma.inventoryItem.create({ data: { name: `Prep item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: 1_000, category } })
}
async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return e ? e.lines.map((l) => [l.account.code, l.type as string, Number(l.amountCents)] as const).sort() : null
}
const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock

beforeAll(async () => {
  A = await mkCompany('prep-a')
  B = await mkCompany('prep-b')
  u.chefA = await mkUser('chefA', 'boh_management', A.tenantId)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.chefB = await mkUser('chefB', 'boh_management', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('an ad-hoc batch draws FIFO and posts its draw', () => {
  it('values the draw across lots and classes; Dr 5010 / Cr 1210 and Dr 5020 / Cr 1220', async () => {
    const garlic = await item(A)
    await lot(A, garlic.id, 1, 10_000, 5)     // oldest
    await lot(A, garlic.id, 2, 14_000, 1)
    const cream = await item(A, 'beverage')
    await lot(A, cream.id, 5, 2_000, 2)
    const res = await call(u.chefA!, 'POST', '/crosschecks/prep-batches', {
      itemName: 'Garlic confit', actualYieldQty: 1200, unit: 'g', locationId: A.locationId,
      inputs: [{ inventoryItemId: garlic.id, qtyDrawn: 1500, unit: 'g' }, { inventoryItemId: cream.id, qtyDrawn: 1, unit: 'kg' }, { inventoryItemId: garlic.id, qtyDrawn: 0.25, unit: 'kg' }],
    })
    expect(res.statusCode, res.body).toBe(201)
    // Garlic 1.75 kg: 1 × 100 + 0.75 × 140 = PKR 205; cream 1 × 20 = PKR 20.
    expect(res.json()).toMatchObject({ tenantId: A.tenantId, locationId: A.locationId, drawValueCents: 22_500, ledger: { posted: true } })
    expect(await stockOf(garlic.id)).toBeCloseTo(1.25)
    expect(await stockOf(cream.id)).toBe(4)
    const draws = await prisma.stockMovement.findMany({ where: { sourceType: 'prep_batch', sourceId: res.json().id, kind: 'prep_draw' } })
    expect(draws.reduce((s, m) => s + Number(m.valueCents), 0)).toBe(-22_500)
    expect(draws.every((m) => m.locationId === A.locationId)).toBe(true)
    expect(await entryLines(A.tenantId, `inventory.prep_draw:${res.json().id}`)).toEqual([
      ['1210', 'credit', 20_500], ['1220', 'credit', 2_000], ['5010', 'debit', 20_500], ['5020', 'debit', 2_000],
    ].sort())
  })

  it('not enough on the lots → 409 INSUFFICIENT_STOCK; nothing is kept', async () => {
    const onion = await item(A)
    await lot(A, onion.id, 1, 5_000, 1)
    const leek = await item(A)
    await lot(A, leek.id, 10, 5_000, 1)
    const before = await prisma.prepBatch.count({ where: { tenantId: A.tenantId } })
    const res = await call(u.cookA!, 'POST', '/crosschecks/prep-batches', {
      itemName: 'Soup base', actualYieldQty: 1, unit: 'kg',
      inputs: [{ inventoryItemId: leek.id, qtyDrawn: 2, unit: 'kg' }, { inventoryItemId: onion.id, qtyDrawn: 3, unit: 'kg' }],
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
    expect(await prisma.prepBatch.count({ where: { tenantId: A.tenantId } })).toBe(before)
    expect(await stockOf(leek.id)).toBe(10)
    expect(await stockOf(onion.id)).toBe(1)
  })

  it('a refused posting keeps the batch and its draw, and flags it in the batch\'s company', async () => {
    const it0 = await item(A)
    await lot(A, it0.id, 4, 5_000, 1)
    await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5010' }, data: { isActive: false } })
    let res
    try {
      res = await call(u.chefA!, 'POST', '/crosschecks/prep-batches', { itemName: 'Stock', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: it0.id, qtyDrawn: 2, unit: 'kg' }] })
    } finally {
      await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5010' }, data: { isActive: true } })
    }
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ drawValueCents: 10_000, ledger: { posted: false } })
    expect(await stockOf(it0.id)).toBe(2)
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.prep_draw:${res.json().id}` } })).toBe(0)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'PrepBatch', entityId: res.json().id } })
    expect(flag.tenantId).toBe(A.tenantId)
    expect(flag.metadata).toMatchObject({ sourceType: 'inventory.prep_draw', documentDate: expect.any(String) })
  })

  it('a line cook sees no value; the batch list hides it too', async () => {
    const herb = await item(A)
    await lot(A, herb.id, 2, 3_000, 1)
    const res = await call(u.cookA!, 'POST', '/crosschecks/prep-batches', { itemName: 'Herb oil', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: herb.id, qtyDrawn: 1, unit: 'kg' }] })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ drawValueCents: null, costsHidden: true })
    const list = (await call(u.cookA!, 'GET', '/crosschecks/prep-batches')).json() as Array<{ id: string; drawValueCents: unknown }>
    expect(list.find((b) => b.id === res.json().id)!.drawValueCents).toBeNull()
    const chef = (await call(u.chefA!, 'GET', '/crosschecks/prep-batches')).json() as Array<{ id: string; drawValueCents: unknown }>
    expect(chef.find((b) => b.id === res.json().id)!.drawValueCents).toBe(3_000)
  })
})

describe('a sub-recipe batch and two companies', () => {
  let sauceA: string
  let flourA: string
  let doughB: string

  beforeAll(async () => {
    flourA = (await item(A)).id
    await lot(A, flourA, 5, 2_000, 1)
    sauceA = (await prisma.recipe.create({ data: { kind: 'component', name: 'Prep sauce', ingredients: { create: [{ inventoryItemId: flourA, quantity: 100, unit: 'g' }] } } })).id
    const catA = await prisma.category.create({ data: { conceptId: A.conceptId, name: 'Prep plates' } })
    const plate = await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: catA.id, name: 'Sauced', priceCents: 50_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: plate.id, ingredients: { create: [{ prepRecipeId: sauceA, quantity: 50, unit: 'g' }] } } })
    doughB = (await prisma.recipe.create({ data: { kind: 'component', name: 'Prep dough B' } })).id
    const catB = await prisma.category.create({ data: { conceptId: B.conceptId, name: 'Prep plates B' } })
    const plateB = await prisma.menuItem.create({ data: { conceptId: B.conceptId, categoryId: catB.id, name: 'Bread', priceCents: 10_000 } })
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: plateB.id, ingredients: { create: [{ prepRecipeId: doughB, quantity: 50, unit: 'g' }] } } })
  })

  it('a sub-recipe batch draws its recipe and makes the prep item (owner 2026-10-24, D3) — no posting', async () => {
    const res = await call(u.chefA!, 'POST', '/crosschecks/prep-batches', { recipeId: sauceA, itemName: 'Prep sauce', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: flourA, qtyDrawn: 1, unit: 'kg' }] })
    expect(res.statusCode, res.body).toBe(201)
    // One batch of the recipe (100 g flour = 0.1 kg at PKR 20/kg), whatever was typed; the prep item at the actual yield.
    expect(res.json()).toMatchObject({ recipeId: sauceA, drawValueCents: 200, ledger: null, made: { qty: 1000, unit: 'g', valueCents: 200 } })
    expect(await stockOf(flourA)).toBeCloseTo(4.9)
    expect(await prisma.stockMovement.count({ where: { sourceType: 'prep_batch.input', sourceId: res.json().id, kind: 'prep_draw' } })).toBe(1)
    const sauce = await prisma.inventoryItem.findUniqueOrThrow({ where: { prepRecipeId: sauceA } })
    expect(sauce).toMatchObject({ kind: 'prep', tenantId: A.tenantId, currentStock: 1000 })
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.prep_draw:${res.json().id}` } })).toBe(0)
  })

  it('B: A\'s input 404, A\'s sub-recipe 422, A\'s outlet 422 — nothing drawn; lists never mix', async () => {
    const r1 = await call(u.chefB!, 'POST', '/crosschecks/prep-batches', { itemName: 'x', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: flourA, qtyDrawn: 1, unit: 'kg' }] })
    expect(r1.statusCode).toBe(404)
    const flourB = await item(B)
    await lot(B, flourB.id, 5, 2_000, 1)
    const r2 = await call(u.chefB!, 'POST', '/crosschecks/prep-batches', { recipeId: sauceA, itemName: 'x', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: flourB.id, qtyDrawn: 1, unit: 'kg' }] })
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('RECIPE_NOT_IN_COMPANY')
    const r3 = await call(u.chefB!, 'POST', '/crosschecks/prep-batches', { itemName: 'x', actualYieldQty: 1, unit: 'kg', locationId: A.locationId, inputs: [{ inventoryItemId: flourB.id, qtyDrawn: 1, unit: 'kg' }] })
    expect(r3.statusCode).toBe(422)
    expect(r3.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await stockOf(flourA)).toBeCloseTo(4.9)
    expect(await stockOf(flourB.id)).toBe(5)

    const own = await call(u.chefB!, 'POST', '/crosschecks/prep-batches', { recipeId: doughB, itemName: 'Dough', actualYieldQty: 1, unit: 'kg', inputs: [{ inventoryItemId: flourB.id, qtyDrawn: 1, unit: 'kg' }] })
    expect(own.statusCode).toBe(201)
    expect(own.json().tenantId).toBe(B.tenantId)
    const listA = (await call(u.chefA!, 'GET', '/crosschecks/prep-batches')).json() as Array<{ tenantId: string }>
    expect(listA.every((b) => b.tenantId === A.tenantId)).toBe(true)
  })
})
