// Spot counts on FIFO lots (finance wave B, H16 / H20) — POST/GET
// /crosschecks/physical-counts and /physical-counts/suggested.
//
// What this guards:
//   - Short: the difference leaves the lots FIFO ('count_loss') at the lots'
//     value; Dr 5050 / Cr the class inventory at exactly that value.
//   - Over: a 'count_gain' lot at the LATEST PURCHASE price (not the FIFO
//     head), Dr class inventory / Cr 5050.
//   - A zero-book over raises 'stock_unrecorded' (variancePct null) instead
//     of a 0 % line and never a shrinkage flag.
//   - Every difference carries a reason (≥ 3 characters, H20).
//   - A refused posting keeps the count, flags it with the document date.
//   - Two companies: B gets 404 on A's items and counts, a count binds to the
//     active company, B's outlet on A's count is 422.
//   - Suggested: high-value items of the active company, none counted in the
//     last 7 days; costs hidden for the line cook.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

/** An item with `qty` on one lot at `cost` (a cut-over style lot — not a purchase). */
async function item(co: Company, o: { qty?: number; cost?: number | null; category?: string } = {}) {
  await ensureFifoReady(co.tenantId)
  const it = await prisma.inventoryItem.create({
    data: { name: `Count item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: o.cost === undefined ? 10_000 : o.cost, category: o.category ?? 'protein' },
  })
  if (o.qty && o.qty > 0) {
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: it.id, qty: o.qty!, unitCostCents: o.cost ?? 0, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
      lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - 3 * DAY),
    }))
  }
  return it
}

/** A delivery at the dock (the one receiving path): a receipt lot at the price paid. */
async function receive(co: Company, itemId: string, qty: number, unitCostCents: number) {
  const supplier = await prisma.supplier.findFirst({ where: { tenantId: co.tenantId, systemKind: null } })
    ?? await prisma.supplier.create({ data: { tenantId: co.tenantId, name: `Supplier ${co.tenantId.slice(-4)}` } })
  await receiveGoods({ actor: { id: u.ceoA!.id, role: 'admin' }, supplierId: supplier.id, lines: [{ inventoryItemId: itemId, quantityReceived: qty, unitCostCents }] })
}

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
  return e ? e.lines.map((l) => ({ code: l.account.code, type: l.type as string, cents: Number(l.amountCents), accountTenant: l.account.tenantId })) : null
}
const sum = (ls: Array<{ code: string; type: string; cents: number }>, code: string, type: string) =>
  ls.filter((l) => l.code === code && l.type === type).reduce((s, l) => s + l.cents, 0)
const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock

beforeAll(async () => {
  A = await mkCompany('spot-a')
  B = await mkCompany('spot-b')
  u.ceoA = await mkUser('ceoA', 'admin', A.tenantId)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.chefA = await mkUser('chefA', 'boh_management', A.tenantId)
  u.cookB = await mkUser('cookB', 'boh', B.tenantId)
  u.ceoB = await mkUser('ceoB', 'admin', B.tenantId)
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
  // Every entry balanced, every line in its own company's chart.
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } }, include: { lines: { include: { account: { select: { tenantId: true } } } } } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
    for (const l of e.lines) expect(l.account.tenantId).toBe(e.tenantId)
  }
  await app?.close()
})

describe('a spot count on the lots', () => {
  it('short: count_loss FIFO across two lots at their value; Dr 5050 / Cr 1210', async () => {
    const it0 = await item(A, { qty: 2, cost: 10_000 })
    await receive(A, it0.id, 3, 15_000)
    expect(await stockOf(it0.id)).toBe(5)
    const res = await call(u.cookA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 1.5, reason: 'end of week count' }] })
    expect(res.statusCode, res.body).toBe(201)
    const body = res.json()
    expect(body.count.tenantId).toBe(A.tenantId)
    expect(body.ledger).toMatchObject({ posted: true })
    // A line cook sees no value.
    expect(body.lines[0]).toMatchObject({ systemQty: 5, physicalQty: 1.5, valueCents: null })
    const line = await prisma.physicalCountLine.findFirstOrThrow({ where: { countId: body.id } })
    // 2 kg × 100 + 1.5 kg × 150 = PKR 425.
    expect(Number(line.valueCents)).toBe(-42_500)
    expect(await stockOf(it0.id)).toBe(1.5)
    const moves = await prisma.stockMovement.findMany({ where: { sourceType: 'physical_count_line', sourceId: line.id, kind: 'count_loss' } })
    expect(moves.reduce((s, m) => s + Number(m.valueCents), 0)).toBe(-42_500)
    const ls = (await entryLines(A.tenantId, `inventory.count:${body.id}`))!
    expect(sum(ls, '5050', 'debit')).toBe(42_500)
    expect(sum(ls, '1210', 'credit')).toBe(42_500)
  })

  it('over: a count_gain lot at the LATEST purchase price, not the FIFO head; Dr 1210 / Cr 5050', async () => {
    const it0 = await item(A)
    await receive(A, it0.id, 2, 10_000)
    await receive(A, it0.id, 2, 12_000)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: it0.id } })).unitCostCents).toBe(10_000)   // the head
    const res = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 5, reason: 'delivery not entered' }] })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().lines[0]).toMatchObject({ valueCents: 12_000, unitCostCents: 12_000 })
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id, sourceType: 'count_gain' } })
    expect(lot).toMatchObject({ qtyIn: 1, unitCostCents: 12_000 })
    const ls = (await entryLines(A.tenantId, `inventory.count:${res.json().id}`))!
    expect(sum(ls, '1210', 'debit')).toBe(12_000)
    expect(sum(ls, '5050', 'credit')).toBe(12_000)
    expect(await stockOf(it0.id)).toBe(5)
  })

  it('a drinks item moves 1220, not 1210', async () => {
    const cola = await item(A, { qty: 10, cost: 5_000, category: 'beverage' })
    const res = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: cola.id, physicalQty: 8, reason: 'two cans missing' }] })
    expect(res.statusCode, res.body).toBe(201)
    const ls = (await entryLines(A.tenantId, `inventory.count:${res.json().id}`))!
    expect(sum(ls, '5050', 'debit')).toBe(10_000)
    expect(sum(ls, '1220', 'credit')).toBe(10_000)
    expect(sum(ls, '1210', 'credit')).toBe(0)
  })

  it('zero-book over: stock_unrecorded (no % line, no shrinkage flag); lot at the estimate; no cost at all → high, at no value', async () => {
    const it0 = await item(A, { cost: 5_000 })
    const res = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 2, reason: 'found in the walk-in' }] })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().lines[0]).toMatchObject({ systemQty: 0, variancePct: null, valueCents: 10_000 })
    const flags = await prisma.exceptionFlag.findMany({ where: { entityId: res.json().id } })
    expect(flags.map((f) => f.kind)).toEqual(['stock_unrecorded'])
    expect(flags[0]).toMatchObject({ tenantId: A.tenantId, severity: 'medium', amountCents: 10_000 })
    expect(await stockOf(it0.id)).toBe(2)

    const bare = await item(A, { cost: null })
    const r2 = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: bare.id, physicalQty: 1, reason: 'found on a shelf' }] })
    expect(r2.statusCode, r2.body).toBe(201)
    expect(r2.json().ledger).toMatchObject({ posted: false, reason: 'no_variance' })
    const f2 = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: r2.json().id, kind: 'stock_unrecorded' } })
    expect(f2.severity).toBe('high')
    expect(f2.metadata).toMatchObject({ itemId: bare.id, noCost: true })
  })

  it('a difference needs a reason of 3+ characters; nothing is written without one', async () => {
    const it0 = await item(A, { qty: 4, cost: 10_000 })
    const before = await prisma.physicalCount.count({ where: { tenantId: A.tenantId } })
    for (const reason of [undefined, 'ab', '   ']) {
      const res = await call(u.cookA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 3, ...(reason !== undefined ? { reason } : {}) }] })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('COUNT_REASON_REQUIRED')
    }
    expect(await prisma.physicalCount.count({ where: { tenantId: A.tenantId } })).toBe(before)
    expect(await stockOf(it0.id)).toBe(4)
    // A count that matches the books needs none.
    const ok = await call(u.cookA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 4 }] })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().ledger).toMatchObject({ posted: false, reason: 'no_variance' })
  })

  it('a refused posting keeps the count and the stock, and flags it with the document date', async () => {
    const it0 = await item(A, { qty: 10, cost: 10_000 })
    await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5050' }, data: { isActive: false } })
    let res
    try {
      res = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 7, reason: 'three missing' }] })
    } finally {
      await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5050' }, data: { isActive: true } })
    }
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().ledger.posted).toBe(false)
    expect(res.json().ledger.error).toBeTruthy()
    expect(await stockOf(it0.id)).toBe(7)
    expect(await entryLines(A.tenantId, `inventory.count:${res.json().id}`)).toBeNull()
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'PhysicalCount', entityId: res.json().id } })
    expect(flag.tenantId).toBe(A.tenantId)
    expect(flag.metadata).toMatchObject({ sourceType: 'inventory.count', sourceId: res.json().id, documentDate: expect.any(String) })
    // The list shows it as not posted, failed.
    const list = await call(u.chefA!, 'GET', '/crosschecks/physical-counts')
    const row = (list.json() as Array<{ id: string; ledger: { posted: boolean; failed: boolean } }>).find((c) => c.id === res.json().id)!
    expect(row.ledger).toMatchObject({ posted: false, failed: true })
  })
})

describe('two companies', () => {
  it('B gets 404 on A\'s item and A\'s count; lists never mix; B\'s outlet on A\'s count is 422', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })
    const foreign = await call(u.cookB!, 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: it0.id, physicalQty: 1, reason: 'not mine' }] })
    expect(foreign.statusCode).toBe(404)
    expect(await stockOf(it0.id)).toBe(5)

    const loc = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { locationId: B.locationId, lines: [{ inventoryItemId: it0.id, physicalQty: 5 }] })
    expect(loc.statusCode).toBe(422)
    expect(loc.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')

    const ok = await call(u.chefA!, 'POST', '/crosschecks/physical-counts', { locationId: A.locationId, lines: [{ inventoryItemId: it0.id, physicalQty: 4, reason: 'one short' }] })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().count).toMatchObject({ tenantId: A.tenantId, locationId: A.locationId, kind: 'spot' })
    expect((await prisma.stockMovement.findFirstOrThrow({ where: { kind: 'count_loss', inventoryItemId: it0.id } })).locationId).toBe(A.locationId)

    expect((await call(u.ceoB!, 'GET', `/crosschecks/physical-counts/${ok.json().id}`)).statusCode).toBe(404)
    const mine = await call(u.chefA!, 'GET', `/crosschecks/physical-counts/${ok.json().id}`)
    expect(mine.statusCode).toBe(200)
    expect(mine.json().lines[0]).toMatchObject({ itemName: it0.name, valueCents: -10_000 })
    expect(mine.json().ledger).toMatchObject({ posted: true, failed: false })
    const listB = (await call(u.ceoB!, 'GET', '/crosschecks/physical-counts')).json() as Array<{ tenantId: string }>
    expect(listB.every((c) => c.tenantId === B.tenantId)).toBe(true)
    const spotA = (await call(u.chefA!, 'GET', '/crosschecks/physical-counts?kind=spot')).json() as Array<{ tenantId: string; kind: string }>
    expect(spotA.length).toBeGreaterThan(0)
    expect(spotA.every((c) => c.tenantId === A.tenantId && c.kind === 'spot')).toBe(true)
    expect((await call(u.chefA!, 'GET', '/crosschecks/physical-counts?from=yesterday')).statusCode).toBe(400)
  })
})

describe('suggested counts', () => {
  it('the active company\'s valuable items, none counted in 7 days; the line cook sees no value', async () => {
    const big = await item(A, { qty: 50, cost: 100_000 })
    const counted = await item(A, { qty: 50, cost: 100_000 })
    await prisma.physicalCount.create({
      data: { tenantId: A.tenantId, countedById: u.chefA!.id, status: 'completed', lines: { create: [{ inventoryItemId: counted.id, systemQty: 50, physicalQty: 50, variancePct: 0 }] } },
    })
    const bItem = await item(B, { qty: 50, cost: 100_000 })

    const chef = await call(u.chefA!, 'GET', '/crosschecks/physical-counts/suggested?n=50')
    expect(chef.statusCode).toBe(200)
    const ids = (chef.json().items as Array<{ id: string }>).map((i) => i.id)
    expect(ids).toContain(big.id)
    expect(ids).not.toContain(counted.id)
    expect(ids).not.toContain(bItem.id)
    expect(chef.json().items.find((i: { id: string }) => i.id === big.id)).toMatchObject({ onHandQty: 50, onHandValueCents: 5_000_000 })

    const cook = await call(u.cookA!, 'GET', '/crosschecks/physical-counts/suggested?n=50')
    expect(cook.json().costsHidden).toBe(true)
    expect(cook.json().items.every((i: Record<string, unknown>) => !('onHandValueCents' in i))).toBe(true)

    const n2 = await call(u.chefA!, 'GET', '/crosschecks/physical-counts/suggested?n=2')
    expect(n2.json().items.length).toBeLessThanOrEqual(2)
    expect((await call(u.chefA!, 'GET', `/crosschecks/physical-counts/suggested?locationId=${B.locationId}`)).statusCode).toBe(422)
  })
})
