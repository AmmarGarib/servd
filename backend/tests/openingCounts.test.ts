// Opening counts (H19, accountant 2026-10-14: to OWNER'S CAPITAL 3010) —
// POST /crosschecks/physical-counts { kind: 'opening' } and the opening count
// made when a company-less item that holds stock is given its company
// (PATCH /inventory/:id { tenantId }).
//
// What this guards:
//   - Finance / CEO / management only (403 OPENING_COUNT_ROLE for a floor
//     manager); finance may not spot-count.
//   - Dr the class inventory / Cr 3010 at the entered cost, default the
//     latest purchase price, else the estimate, else 422
//     OPENING_COST_REQUIRED; never 5050.
//   - Only for stock never on the books: a second opening, or an item already
//     received, is 422 OPENING_NOT_ALLOWED.
//   - Assigning a company to a company-less item with stock records ONE
//     opening lot + entry in that company, in the same transaction.
//   - Two companies: B gets 404 on A's item and A's opening count.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { ACCT } from '../src/modules/accounting/journal.js'
import { ensureFifoReady } from '../src/lib/stockLedger.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

/** H19 as the accountant answered it: opening stock is the owner's capital. */
const OPENING_CREDIT = ACCT.OWNERS_CAPITAL
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

const newItem = (tenantId: string | null, o: { cost?: number | null; category?: string; stock?: number } = {}) =>
  prisma.inventoryItem.create({
    data: {
      name: `Opening item ${++seq}`, unit: 'kg', tenantId, unitCostCents: o.cost === undefined ? 20_000 : o.cost,
      category: o.category ?? 'produce', currentStock: o.stock ?? 0,
    },
  })

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return e ? e.lines.map((l) => [l.account.code, l.type as string, Number(l.amountCents)] as const).sort() : null
}
const opening = (who: Who, lines: unknown[]) => call(who, 'POST', '/crosschecks/physical-counts', { kind: 'opening', lines })

beforeAll(async () => {
  A = await mkCompany('opening-a')
  B = await mkCompany('opening-b')
  await ensureFifoReady(A.tenantId)
  await ensureFifoReady(B.tenantId)
  u.finA = await mkUser('finA', 'finance', A.tenantId)
  u.ceoA = await mkUser('ceoA', 'admin', A.tenantId)
  u.mgmtA = await mkUser('mgmtA', 'management', A.tenantId)
  u.chefA = await mkUser('chefA', 'boh_management', A.tenantId)
  u.mgrA = await mkUser('mgrA', 'manager', A.tenantId)
  u.finB = await mkUser('finB', 'finance', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('an opening count', () => {
  it('finance: an opening lot at the entered cost; Dr 1210 / Cr capital, never 5050', async () => {
    const it0 = await newItem(A.tenantId)
    const res = await opening(u.finA!, [{ inventoryItemId: it0.id, physicalQty: 4, unitCostCents: 25_000 }])
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().count).toMatchObject({ kind: 'opening', tenantId: A.tenantId })
    expect(res.json().ledger).toMatchObject({ posted: true })
    expect(res.json().lines[0]).toMatchObject({ systemQty: 0, physicalQty: 4, valueCents: 100_000, unitCostCents: 25_000, variancePct: null })
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id } })
    expect(lot).toMatchObject({ sourceType: 'opening', qtyIn: 4, unitCostCents: 25_000, tenantId: A.tenantId })
    expect(await entryLines(A.tenantId, `inventory.count:${res.json().id}`)).toEqual([
      ['1210', 'debit', 100_000], [OPENING_CREDIT, 'credit', 100_000],
    ].sort())
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: it0.id } })).currentStock).toBe(4)
  })

  it('packaging goes to 1230; the cost defaults to the latest purchase price, else the estimate; none → 422', async () => {
    const box = await newItem(A.tenantId, { category: 'packaging', cost: 1_000 })
    // A price billed before anything arrived — the latest purchase price.
    await prisma.itemPriceHistory.create({ data: { inventoryItemId: box.id, oldCostCents: null, newCostCents: 1_500, source: 'bill_match' } })
    const est = await newItem(A.tenantId, { cost: 3_000 })
    const none = await newItem(A.tenantId, { cost: null })

    const res = await opening(u.ceoA!, [{ inventoryItemId: box.id, physicalQty: 100 }, { inventoryItemId: est.id, physicalQty: 2 }])
    expect(res.statusCode, res.body).toBe(201)
    expect(await entryLines(A.tenantId, `inventory.count:${res.json().id}`)).toEqual([
      ['1210', 'debit', 6_000], ['1230', 'debit', 150_000], [OPENING_CREDIT, 'credit', 6_000], [OPENING_CREDIT, 'credit', 150_000],
    ].sort())

    const bad = await opening(u.mgmtA!, [{ inventoryItemId: none.id, physicalQty: 1 }])
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('OPENING_COST_REQUIRED')
    expect(await prisma.stockLot.count({ where: { inventoryItemId: none.id } })).toBe(0)
  })

  it('only once, and never for an item already received', async () => {
    const it0 = await newItem(A.tenantId)
    expect((await opening(u.finA!, [{ inventoryItemId: it0.id, physicalQty: 1 }])).statusCode).toBe(201)
    const again = await opening(u.finA!, [{ inventoryItemId: it0.id, physicalQty: 1 }])
    expect(again.statusCode).toBe(422)
    expect(again.json().error.code).toBe('OPENING_NOT_ALLOWED')

    const received = await newItem(A.tenantId)
    const supplier = await prisma.supplier.create({ data: { tenantId: A.tenantId, name: 'Opening Supplier A' } })
    await receiveGoods({ actor: { id: u.ceoA!.id, role: 'admin' }, supplierId: supplier.id, lines: [{ inventoryItemId: received.id, quantityReceived: 2, unitCostCents: 9_000 }] })
    const r = await opening(u.finA!, [{ inventoryItemId: received.id, physicalQty: 5 }])
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('OPENING_NOT_ALLOWED')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: received.id } })).currentStock).toBe(2)
  })

  it('the Count page reads what the operator may do from the server', async () => {
    expect((await call(u.finA!, 'GET', '/crosschecks/physical-counts/capabilities')).json()).toEqual({ canSpotCount: false, canOpeningCount: true, costsHidden: false })
    expect((await call(u.chefA!, 'GET', '/crosschecks/physical-counts/capabilities')).json()).toEqual({ canSpotCount: true, canOpeningCount: false, costsHidden: false })
    expect((await call(u.ceoA!, 'GET', '/crosschecks/physical-counts/capabilities')).json()).toMatchObject({ canSpotCount: true, canOpeningCount: true })
  })

  it('a floor manager cannot (403 OPENING_COUNT_ROLE); finance cannot spot-count', async () => {
    const it0 = await newItem(A.tenantId)
    const chef = await opening(u.chefA!, [{ inventoryItemId: it0.id, physicalQty: 1 }])
    expect(chef.statusCode).toBe(403)
    expect(chef.json().error.code).toBe('OPENING_COUNT_ROLE')
    expect((await opening(u.mgrA!, [{ inventoryItemId: it0.id, physicalQty: 1 }])).json().error.code).toBe('OPENING_COUNT_ROLE')
    const spot = await call(u.finA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 0 }] })
    expect(spot.statusCode).toBe(403)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: it0.id } })).toBe(0)
  })

  it('company B: 404 on A\'s item and on A\'s opening count', async () => {
    const it0 = await newItem(A.tenantId)
    expect((await opening(u.finB!, [{ inventoryItemId: it0.id, physicalQty: 1, unitCostCents: 100 }])).statusCode).toBe(404)
    const mine = await opening(u.finA!, [{ inventoryItemId: it0.id, physicalQty: 1 }])
    expect(mine.statusCode).toBe(201)
    expect((await call(u.finB!, 'GET', `/crosschecks/physical-counts/${mine.json().id}`)).statusCode).toBe(404)
    expect((await call(u.finA!, 'GET', `/crosschecks/physical-counts/${mine.json().id}`)).json().ledger).toMatchObject({ posted: true })
    const listB = (await call(u.finB!, 'GET', '/crosschecks/physical-counts?kind=opening')).json() as Array<{ tenantId: string }>
    expect(listB.every((c) => c.tenantId === B.tenantId)).toBe(true)
  })
})

describe('giving a company to a company-less item that holds stock', () => {
  it('records one opening lot + entry in that company; the second assignment is refused', async () => {
    const orphan = await newItem(null, { stock: 6, cost: 7_000 })
    // A floor manager may assign an item without stock, not one with stock.
    const mgr = await call(u.mgrA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId })
    expect(mgr.statusCode).toBe(403)
    expect(mgr.json().error.code).toBe('OPENING_COUNT_ROLE')
    // Finance: into a company it is not in → 404.
    expect((await call(u.finA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: B.tenantId })).statusCode).toBe(404)
    // Finance may only assign — no other edit.
    expect((await call(u.finA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId, name: 'Renamed' })).statusCode).toBe(403)

    const res = await call(u.finA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId, unitCostCents: 8_000 })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ tenantId: A.tenantId, currentStock: 6, unitCostCents: 8_000 })
    const countId = res.json().openingCount.id as string
    expect(res.json().openingCount.ledger).toMatchObject({ posted: true })
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: orphan.id } })
    expect(lots).toHaveLength(1)
    expect(lots[0]).toMatchObject({ tenantId: A.tenantId, sourceType: 'opening', qtyIn: 6, unitCostCents: 8_000 })
    expect(await entryLines(A.tenantId, `inventory.count:${countId}`)).toEqual([['1210', 'debit', 48_000], [OPENING_CREDIT, 'credit', 48_000]].sort())

    // Now A's: it is never moved again (a merge, not an edit) — and finance edits nothing of a company's item.
    const again = await call(u.ceoA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: B.tenantId })
    expect(again.statusCode).toBe(422)
    expect(again.json().error.code).toBe('ITEM_HAS_COMPANY')
    expect((await call(u.finA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: B.tenantId })).statusCode).toBe(403)
    const ceo = await call(u.ceoA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId })
    expect(ceo.statusCode).toBe(200)     // no change: already A's
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'inventory.count:' }, tenantId: A.tenantId, lines: { some: { account: { code: OPENING_CREDIT } } } } }))
      .toBeGreaterThan(0)
    expect(await prisma.physicalCount.count({ where: { lines: { some: { inventoryItemId: orphan.id } } } })).toBe(1)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'inventory.assign_company', entityId: orphan.id } })
    expect(audit?.tenantId).toBe(A.tenantId)
  })

  it('with no cost anywhere: 422 OPENING_COST_REQUIRED and the item stays company-less', async () => {
    const orphan = await newItem(null, { stock: 3, cost: null })
    const res = await call(u.ceoA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('OPENING_COST_REQUIRED')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: orphan.id } })).tenantId).toBeNull()
    expect(await prisma.stockLot.count({ where: { inventoryItemId: orphan.id } })).toBe(0)
  })

  it('an item without stock is simply assigned (a manager may), with no count', async () => {
    const orphan = await newItem(null)
    const res = await call(u.mgrA!, 'PATCH', `/inventory/${orphan.id}`, { tenantId: A.tenantId })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().openingCount).toBeUndefined()
    expect(await prisma.physicalCount.count({ where: { lines: { some: { inventoryItemId: orphan.id } } } })).toBe(0)
  })
})
