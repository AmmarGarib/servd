// Stock differences waiting for the CEO (H20 — owner decision 2026-10-14).
//
//   • Waste (postWasteLog), sold-line waste (postVoidWaste) and spot-count
//     differences (postStockCount) book the cost side to 1290 — the one
//     switch point stockDifferenceAccount — with the brand and the reason.
//   • GET /accounting/stock-differences lists each 1290 line (read scope):
//     item, outlet, brand, kind, reason, value, who; totals; canApprove.
//   • POST /approve (CEO only): per line 'stock_difference.clear:<lineId>',
//     dated today, in the line's company, the line's brand — loss Dr 5040 /
//     5050 / Cr 1290, gain Dr 1290 / Cr 5050. Repeat → 409 ALREADY_CLEARED;
//     a mix clears only what waits. One company per call (422 ONE_COMPANY).
//   • A closed month is never touched: a difference from a closed month is
//     cleared today; the books closed through today → 422 PERIOD_LOCKED.
//   • POST /:lineId/query (CEO): audit row + 'stock_difference_queried' flag,
//     stays pending; an approved one is 409.
//   • Two companies: B never sees, approves or queries A's lines (404).
//   • stockDifferenceCloseCheck warns per month; nothing waiting → null.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { postWasteLog, postStockCount, stockDifferenceAccount } from '../src/modules/accounting/inventoryPosting.js'
import { postVoidWaste } from '../src/modules/inventory/voidWaste.js'
import { stockDifferenceRoutes } from '../src/modules/stockDifferences/routes.js'
import { stockDifferenceCloseCheck, listStockDifferences } from '../src/modules/stockDifferences/service.js'
import { fmtPktDate, parsePktEndOfDay } from '../src/modules/accounting/dates.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company, B: Company, C: Company
let ceoA: Who, ceoB: Who, ceoAB: Who, finA: Who, ceoC: Who
let beef: string, cola: string, beefB: string

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/accounting/stock-differences${url}`, headers: { authorization: `Bearer ${who.token}` }, ...(payload !== undefined && { payload: payload as object }) })

async function waste(co: Company, itemId: string, cents: number, o: { conceptId?: string | null; reason?: string; at?: Date; by?: string } = {}) {
  const log = await prisma.wasteLog.create({
    data: {
      tenantId: co.tenantId, inventoryItemId: itemId, quantity: 1, unit: 'kg', reason: o.reason ?? 'spoilage', estimatedCostCents: cents,
      conceptId: o.conceptId === undefined ? co.conceptId : o.conceptId, locationId: co.locationId, recordedById: o.by ?? null,
      recordedAt: o.at ?? new Date(), notes: 'dropped the tray',
    },
  })
  const r = await postWasteLog(log.id)
  expect(r.posted).toBe(true)
  return log.id
}

async function lineOf(tenantId: string, reference: string, type?: 'debit' | 'credit') {
  return prisma.journalLine.findFirstOrThrow({
    where: { account: { tenantId, code: '1290' }, journalEntry: { tenantId, reference }, ...(type ? { type } : {}) },
    select: { id: true, type: true, amountCents: true, conceptId: true },
  })
}
async function clearing(tenantId: string, lineId: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference: `stock_difference.clear:${lineId}` },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
}
const shape = (je: Awaited<ReturnType<typeof clearing>>) =>
  je!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort()

beforeAll(async () => {
  const run = Date.now().toString(36)
  A = await mkCompany(`sd-a-${run}`)
  B = await mkCompany(`sd-b-${run}`)
  C = await mkCompany(`sd-c-${run}`)
  ceoA = await mkUser('sd-ceo-a', 'admin', A.tenantId)
  ceoB = await mkUser('sd-ceo-b', 'admin', B.tenantId)
  ceoC = await mkUser('sd-ceo-c', 'admin', C.tenantId)
  finA = await mkUser('sd-fin-a', 'finance', A.tenantId)
  ceoAB = await mkUser('sd-ceo-ab', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: ceoAB.id } })
  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef mince', unit: 'kg', category: 'protein' } })).id
  cola = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Cola', unit: 'pcs', category: 'beverage' } })).id
  beefB = (await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: 'B beef', unit: 'kg', category: 'protein' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(stockDifferenceRoutes, { prefix: '/accounting/stock-differences' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('postings wait in 1290 (the switch point)', () => {
  it('stockDifferenceAccount: suspense for every company', () => {
    expect(stockDifferenceAccount(A.tenantId, 'waste')).toBe('1290')
    expect(stockDifferenceAccount(B.tenantId, 'count')).toBe('1290')
  })
})

describe('listing, approving and sending back', () => {
  let wasteId: string, countId: string, voidItemId: string

  beforeAll(async () => {
    wasteId = await waste(A, beef, 9_000, { by: finA.id })
    // A spot count: beef short 3,000 (loss), cola over 1,200 (gain); brand-less (no recipe use: head office).
    const count = await prisma.physicalCount.create({
      data: { tenantId: A.tenantId, countedById: finA.id, kind: 'spot', locationId: A.locationId, notes: 'month-end count', lines: { create: [
        { inventoryItemId: beef, systemQty: 10, physicalQty: 7, valueCents: -3_000 },
        { inventoryItemId: cola, systemQty: 0, physicalQty: 2, valueCents: 1_200 },
      ] } },
    })
    expect((await postStockCount(count.id)).posted).toBe(true)
    countId = count.id
    // A fired line voided: its waste log, booked by postVoidWaste to 1290.
    const order = await prisma.order.create({
      data: { conceptId: A.conceptId, source: 'pos', status: 'preparing', totalCents: 145_000, locationId: A.locationId,
        items: { create: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, status: 'voided' }] } },
      include: { items: true },
    })
    voidItemId = order.items[0]!.id
    await prisma.wasteLog.create({
      data: { tenantId: A.tenantId, conceptId: A.conceptId, locationId: A.locationId, orderItemId: voidItemId, inventoryItemId: beef,
        quantity: 0.15, unit: 'kg', reason: 'void_after_fire', estimatedCostCents: 1_500, recordedById: finA.id, notes: 'Reason: wrong table' },
    })
    expect((await postVoidWaste(A.tenantId, voidItemId, [], A.conceptId)).posted).toBe(true)
    // B's own waste.
    await waste(B, beefB, 4_000)
  })

  it('every entry booked its cost side to 1290, the other side unchanged', async () => {
    const w = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `inventory.waste:${wasteId}` }, include: { lines: { include: { account: true } } } })
    expect(w.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort()).toEqual([
      ['1210', 'credit', 9_000, A.conceptId], ['1290', 'debit', 9_000, A.conceptId],
    ])
    const c = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `inventory.count:${countId}` }, include: { lines: { include: { account: true } } } })
    expect(c.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([
      ['1210', 'credit', 3_000], ['1220', 'debit', 1_200], ['1290', 'credit', 1_200], ['1290', 'debit', 3_000],
    ])
    const v = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `pos.void_waste:${voidItemId}` }, include: { lines: { include: { account: true } } } })
    expect(v.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'credit', 1_500], ['1290', 'debit', 1_500]])
  })

  it('GET lists A\'s pending differences with item, outlet, brand, kind, reason and who; totals; canApprove only for the CEO', async () => {
    const res = await call(finA, 'GET', '/')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { rows: Array<Record<string, unknown>>; totals: Record<string, number>; canApprove: boolean }
    expect(body.canApprove).toBe(false)
    expect(body.totals).toEqual({ count: 4, lossCents: 9_000 + 3_000 + 1_500, gainCents: 1_200, netCents: 9_000 + 3_000 + 1_500 - 1_200 })
    const byKind = (k: string) => body.rows.filter((r) => r.kind === k)
    expect(byKind('waste')).toEqual([expect.objectContaining({
      itemName: 'Beef mince', reason: 'spoilage', valueCents: 9_000, direction: 'loss', conceptId: A.conceptId, locationName: expect.stringContaining('Outlet'),
      recordedByName: 'sd-fin-a', notes: 'dropped the tray', status: 'pending', clearingAccount: '5040', tenantId: A.tenantId,
    })])
    expect(byKind('count').map((r) => [r.itemName, r.reason, r.valueCents, r.clearingAccount, r.conceptId]).sort()).toEqual([
      ['Beef mince', 'count short', 3_000, '5050', null], ['Cola', 'count over', -1_200, '5050', null],
    ])
    expect(byKind('void_waste')).toEqual([expect.objectContaining({ itemName: 'Beef mince', reason: 'voided after firing', valueCents: 1_500, notes: 'Reason: wrong table' })])
    // Never B's.
    expect(body.rows.every((r) => r.tenantId === A.tenantId)).toBe(true)
    expect((await call(ceoA, 'GET', '/')).json().canApprove).toBe(true)
    // A company filter outside the scope reads nothing.
    expect((await call(ceoA, 'GET', `/?tenantId=${B.tenantId}`)).json().rows).toEqual([])
  })

  it('finance cannot approve or send back (403)', async () => {
    const line = await lineOf(A.tenantId, `inventory.waste:${wasteId}`)
    expect((await call(finA, 'POST', '/approve', { lineIds: [line.id] })).statusCode).toBe(403)
    expect((await call(finA, 'POST', `/${line.id}/query`, { note: 'please check' })).statusCode).toBe(403)
  })

  it('company B: A\'s lines are 404 — to approve and to send back', async () => {
    const line = await lineOf(A.tenantId, `inventory.waste:${wasteId}`)
    const r = await call(ceoB, 'POST', '/approve', { lineIds: [line.id] })
    expect(r.statusCode).toBe(404)
    expect((await call(ceoB, 'POST', `/${line.id}/query`, { note: 'not mine' })).statusCode).toBe(404)
    expect(await clearing(A.tenantId, line.id)).toBeNull()
    expect((await call(ceoB, 'GET', '/')).json().rows.every((x: { tenantId: string }) => x.tenantId === B.tenantId)).toBe(true)
  })

  it('send back: a note, an audit row and a flag in A; it stays pending', async () => {
    const line = await lineOf(A.tenantId, `inventory.count:${countId}`, 'debit')
    expect((await call(ceoA, 'POST', `/${line.id}/query`, { note: 'x' })).statusCode).toBe(400)
    const res = await call(ceoA, 'POST', `/${line.id}/query`, { note: 'Three kilos short — recount the walk-in' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().row).toMatchObject({ status: 'pending', queries: [expect.objectContaining({ note: 'Three kilos short — recount the walk-in', byName: 'sd-ceo-a' })] })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'stock_difference_queried', entityId: line.id } })
    expect(flag).toMatchObject({ tenantId: A.tenantId, severity: 'medium', entityType: 'JournalLine', amountCents: 3_000 })
    expect(await prisma.auditLog.count({ where: { action: 'stock_difference.query', entityId: line.id, tenantId: A.tenantId } })).toBe(1)
    expect(await clearing(A.tenantId, line.id)).toBeNull()
  })

  it('approve: per line, dated today, the line\'s brand — loss Dr 5040 / 5050 / Cr 1290, gain Dr 1290 / Cr 5050', async () => {
    const w = await lineOf(A.tenantId, `inventory.waste:${wasteId}`)
    const short = await lineOf(A.tenantId, `inventory.count:${countId}`, 'debit')
    const over = await lineOf(A.tenantId, `inventory.count:${countId}`, 'credit')
    const t0 = Date.now()
    const res = await call(ceoA, 'POST', '/approve', { lineIds: [w.id, short.id, over.id] })
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({ tenantId: A.tenantId, alreadyCleared: [], clearedCents: 9_000 + 3_000 - 1_200, canApprove: true })
    expect(body.cleared).toHaveLength(3)
    expect(body.rows.every((r: { status: string }) => r.status === 'cleared')).toBe(true)

    expect(shape(await clearing(A.tenantId, w.id))).toEqual([['1290', 'credit', 9_000, A.conceptId], ['5040', 'debit', 9_000, A.conceptId]])
    expect(shape(await clearing(A.tenantId, short.id))).toEqual([['1290', 'credit', 3_000, null], ['5050', 'debit', 3_000, null]])
    expect(shape(await clearing(A.tenantId, over.id))).toEqual([['1290', 'debit', 1_200, null], ['5050', 'credit', 1_200, null]])
    const je = await clearing(A.tenantId, w.id)
    expect(je!.entryDate.getTime()).toBeGreaterThanOrEqual(t0 - 1_000)
    expect(je!.postedBy).toBe(ceoA.id)
    expect(await prisma.journalEntry.count({ where: { tenantId: B.tenantId, reference: `stock_difference.clear:${w.id}` } })).toBe(0)

    // Pending: only the sold-line waste left; Cleared lists the three.
    const pending = (await call(finA, 'GET', '/')).json()
    expect(pending.rows.map((r: { kind: string }) => r.kind)).toEqual(['void_waste'])
    const cleared = (await call(finA, 'GET', '/?status=cleared')).json()
    expect(cleared.totals).toMatchObject({ count: 3, netCents: 10_800 })
    expect(cleared.rows.find((r: { lineId: string }) => r.lineId === w.id).cleared).toMatchObject({ byName: 'sd-ceo-a', account: '5040' })

    // A repeat is 409; a mix clears only what waits.
    const again = await call(ceoA, 'POST', '/approve', { lineIds: [w.id] })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_CLEARED')
    const v = await lineOf(A.tenantId, `pos.void_waste:${voidItemId}`)
    const mix = await call(ceoA, 'POST', '/approve', { lineIds: [w.id, v.id] })
    expect(mix.statusCode, mix.body).toBe(200)
    expect(mix.json()).toMatchObject({ alreadyCleared: [w.id], clearedCents: 1_500 })
    expect(shape(await clearing(A.tenantId, v.id))).toEqual([['1290', 'credit', 1_500, A.conceptId], ['5040', 'debit', 1_500, A.conceptId]])
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `stock_difference.clear:${w.id}` } })).toBe(1)

    // An approved difference cannot be sent back.
    expect((await call(ceoA, 'POST', `/${w.id}/query`, { note: 'too late now' })).statusCode).toBe(409)
    // 1290 is empty for A again; 5040 / 5050 hold the cost.
    const left = await listStockDifferences({ tenantIds: [A.tenantId], status: 'pending' })
    expect(left.totals.count).toBe(0)
  })

  it('one company per call: a CEO of both companies gets 422 ONE_COMPANY for A + B lines', async () => {
    const bLine = (await listStockDifferences({ tenantIds: [B.tenantId], status: 'pending' })).rows[0]!
    const aWaste = await waste(A, beef, 2_000)
    const aLine = await lineOf(A.tenantId, `inventory.waste:${aWaste}`)
    const res = await call(ceoAB, 'POST', '/approve', { lineIds: [aLine.id, bLine.lineId] })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('ONE_COMPANY')
    expect(await clearing(A.tenantId, aLine.id)).toBeNull()
    expect(await clearing(B.tenantId, bLine.lineId)).toBeNull()
    // B's own line, in B's books.
    const ok = await call(ceoAB, 'POST', '/approve', { lineIds: [bLine.lineId] })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().tenantId).toBe(B.tenantId)
    expect(shape(await clearing(B.tenantId, bLine.lineId))).toEqual([['1290', 'credit', 4_000, B.conceptId], ['5040', 'debit', 4_000, B.conceptId]])
  })
})

describe('a closed month is never touched', () => {
  it('a difference from a closed month clears today; the books closed through today refuse it (422) and nothing clears', async () => {
    const itemC = (await prisma.inventoryItem.create({ data: { tenantId: C.tenantId, name: 'C beef', unit: 'kg', category: 'protein' } })).id
    const old = new Date(Date.now() - 45 * DAY)
    const id = await waste(C, itemC, 5_000, { at: old })
    const line = await lineOf(C.tenantId, `inventory.waste:${id}`)
    const lock = await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: parsePktEndOfDay(fmtPktDate(new Date(Date.now() - 20 * DAY))), lockedBy: ceoC.id } })

    // The close check warns (never blocks) for the month the difference is in.
    const ctx = { db: prisma, tenantId: C.tenantId, prevLock: null, newLock: lock.lockedThrough, months: [], isYearEnd: false }
    const problem = await stockDifferenceCloseCheck.run(ctx)
    expect(problem).toMatchObject({ key: 'stock_differences_pending', severity: 'warn', overridable: true, count: 1, cents: 5_000, months: [fmtPktDate(old).slice(0, 7)], link: '/finance/stock-differences' })
    expect(await stockDifferenceCloseCheck.run({ ...ctx, tenantId: B.tenantId })).toBeNull()

    // Books closed through tomorrow: refused, nothing cleared.
    const tomorrow = await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: new Date(Date.now() + DAY), lockedBy: ceoC.id } })
    const refused = await call(ceoC, 'POST', '/approve', { lineIds: [line.id] })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('PERIOD_LOCKED')
    expect(await clearing(C.tenantId, line.id)).toBeNull()
    await prisma.periodLock.delete({ where: { id: tomorrow.id } })

    const res = await call(ceoC, 'POST', '/approve', { lineIds: [line.id] })
    expect(res.statusCode, res.body).toBe(200)
    const je = await clearing(C.tenantId, line.id)
    expect(fmtPktDate(je!.entryDate)).toBe(fmtPktDate(new Date()))
    expect(je!.entryDate > lock.lockedThrough).toBe(true)
    expect(await stockDifferenceCloseCheck.run(ctx)).toBeNull()
  })
})

// Final gate (answers-1 / answers-2, 2026-10-14): the CEO approves LINE BY
// LINE, so an approved difference is classed by its OWN 1290 line's stock —
// never spread over every class of the count or sold-line waste it came from;
// and a sold-line waste whose cost was already booked (Cr 50x0) clears into
// that class, not into food.
describe('the cost-of-sales class of an approved difference is its own line\'s', () => {
  it('a count with beef (food) and cups (packaging) short: approving only the cups line puts it all on packaging', async () => {
    const { approveStockDifferences } = await import('../src/modules/stockDifferences/service.js')
    const { costOfSalesByConcept } = await import('../src/modules/accounting/reports.js')
    const D = await mkCompany(`sd-cls-${Date.now().toString(36)}`)
    const ceo = await mkUser('sd-cls-ceo', 'admin', D.tenantId)
    const meat = (await prisma.inventoryItem.create({ data: { tenantId: D.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
    const cups = (await prisma.inventoryItem.create({ data: { tenantId: D.tenantId, name: 'Cups', unit: 'pcs', category: 'packaging' } })).id
    const count = await prisma.physicalCount.create({
      data: { tenantId: D.tenantId, countedById: ceo.id, kind: 'spot', locationId: D.locationId, lines: { create: [
        { inventoryItemId: meat, systemQty: 10, physicalQty: 0, valueCents: -1_000 },
        { inventoryItemId: cups, systemQty: 10, physicalQty: 0, valueCents: -200 },
      ] } },
    })
    expect((await postStockCount(count.id)).posted).toBe(true)
    const lines = await prisma.journalLine.findMany({
      where: { account: { tenantId: D.tenantId, code: '1290' }, journalEntry: { reference: `inventory.count:${count.id}` } },
      select: { id: true, memo: true },
    })
    const cupsLine = lines.find((l) => (l.memo ?? '').includes('Cups'))!
    const meatLine = lines.find((l) => (l.memo ?? '').includes('Beef'))!
    const win = { from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) }
    const split = async () => {
      const m = await costOfSalesByConcept(prisma, [D.tenantId], win)
      const t = { foodCents: 0, drinksCents: 0, packagingCents: 0 }
      for (const v of m.values()) { t.foodCents += v.foodCents; t.drinksCents += v.drinksCents; t.packagingCents += v.packagingCents }
      return t
    }
    await approveStockDifferences({ tenantIds: [D.tenantId], lineIds: [cupsLine.id], actorId: ceo.id })
    expect(await split()).toEqual({ foodCents: 0, drinksCents: 0, packagingCents: 200 })
    await approveStockDifferences({ tenantIds: [D.tenantId], lineIds: [meatLine.id], actorId: ceo.id })
    expect(await split()).toEqual({ foodCents: 1_000, drinksCents: 0, packagingCents: 200 })
  })

  it('a sold-line waste of food + packaging: each line clears into its own class; cost already booked (Cr 5030) nets to zero', async () => {
    const { approveStockDifferences } = await import('../src/modules/stockDifferences/service.js')
    const { costOfSalesByConcept } = await import('../src/modules/accounting/reports.js')
    const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
    const D = await mkCompany(`sd-cls2-${Date.now().toString(36)}`)
    const ceo = await mkUser('sd-cls2-ceo', 'admin', D.tenantId)
    const patty = (await prisma.inventoryItem.create({ data: { tenantId: D.tenantId, name: 'Patty', unit: 'pcs', category: 'protein' } })).id
    const box = (await prisma.inventoryItem.create({ data: { tenantId: D.tenantId, name: 'Box', unit: 'pcs', category: 'packaging' } })).id
    const win = { from: new Date(Date.now() - DAY), to: new Date(Date.now() + DAY) }
    const split = async () => {
      const m = await costOfSalesByConcept(prisma, [D.tenantId], win)
      const t = { foodCents: 0, drinksCents: 0, packagingCents: 0 }
      for (const v of m.values()) { t.foodCents += v.foodCents; t.drinksCents += v.drinksCents; t.packagingCents += v.packagingCents }
      return t
    }
    const mkOrder = () => prisma.order.create({
      data: { conceptId: D.conceptId, source: 'servd', status: 'completed', totalCents: 1_000, locationId: D.locationId,
        items: { create: [{ menuItemId: D.items.nihari, name: 'Burger', quantity: 1, unitPriceCents: 1_000, status: 'voided' }] } },
      include: { items: true },
    })
    const log = (orderItemId: string, itemId: string, cents: number) => prisma.wasteLog.create({
      data: { tenantId: D.tenantId, conceptId: D.conceptId, locationId: D.locationId, orderItemId, inventoryItemId: itemId, quantity: 1, unit: 'pcs', reason: 'void_after_fire', estimatedCostCents: cents, recordedAt: new Date() },
    })
    // 1. Not yet costed: Dr 1290 per log / Cr 1210, 1230 per class. Approve only the box.
    const o1 = await mkOrder()
    await log(o1.items[0]!.id, patty, 2_000)
    await log(o1.items[0]!.id, box, 500)
    const v1 = await postVoidWaste(D.tenantId, o1.items[0]!.id, [], D.conceptId)
    expect(v1.posted).toBe(true)
    const v1Lines = await prisma.journalLine.findMany({ where: { journalEntryId: v1.entryId!, account: { code: '1290' } }, select: { id: true, memo: true } })
    const boxLine = v1Lines.find((l) => (l.memo ?? '').endsWith('Box'))!
    await approveStockDifferences({ tenantIds: [D.tenantId], lineIds: [boxLine.id], actorId: ceo.id })
    expect(await split()).toEqual({ foodCents: 0, drinksCents: 0, packagingCents: 500 })

    // 2. Cost already booked: Dr 1290 / Cr 5030 — packaging −500, then the approval +500.
    const o2 = await mkOrder()
    await postJournalEntry({ tenantId: D.tenantId, sourceType: 'order.complete', sourceId: o2.id, description: 'sale', entryDate: new Date(Date.now() - 60_000), lines: [
      { accountCode: '1010', type: 'debit', amountCents: 1 }, { accountCode: '4090', type: 'credit', amountCents: 1 },
    ] })
    await new Promise((r) => setTimeout(r, 20))
    await log(o2.items[0]!.id, box, 300)
    const v2 = await postVoidWaste(D.tenantId, o2.items[0]!.id, [], D.conceptId)
    const v2Codes = await prisma.journalLine.findMany({ where: { journalEntryId: v2.entryId! }, select: { id: true, type: true, account: { select: { code: true } } } })
    expect(v2Codes.map((l) => `${l.account.code}:${l.type}`).sort()).toEqual(['1290:debit', '5030:credit'])
    expect(await split()).toEqual({ foodCents: 0, drinksCents: 0, packagingCents: 200 })
    await approveStockDifferences({ tenantIds: [D.tenantId], lineIds: [v2Codes.find((l) => l.account.code === '1290')!.id], actorId: ceo.id })
    expect(await split()).toEqual({ foodCents: 0, drinksCents: 0, packagingCents: 500 })
  })
})
