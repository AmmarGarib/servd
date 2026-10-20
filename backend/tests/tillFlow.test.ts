// Till flow (owner, 2026-10-20 — src/modules/pos/TILL_FLOW.md), two companies throughout.
//
//   - dine-in ticket with table + waiter (code) + pax + guest; the table board;
//     company B gets 404 / 422 on A's brand, order, waiter, customer, table;
//   - guest search is the company's own customers only;
//   - close in servd → the brand's servd sub-account, the fiscal document held
//     for a manual filing (never sent), close check blocks until filed;
//   - push to Keenu (TEST driver) → the main account, the document sent once;
//   - a refund of each reverses the account the sale credited;
//   - a tip from excess cash is a tip (2095, Order.tipCents — the tip pool's sum), not revenue;
//   - delivery from the till: paid at the counter and COD (fee + GST, completes
//     on delivery, COD custody);
//   - sales report settlement filter + combined = sum; the sales-tax return
//     includes both channels; each brand gets its servd account per company.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { posTillFlowRoutes } from '../src/modules/pos/tillFlowRoutes.js'
import { floorRoutes } from '../src/modules/floors/routes.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import { servdFilingRoutes, servdFilingsCloseCheck } from '../src/modules/accounting/servdFilings.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { testDriverCalls } from '../src/connectors/drivers/test.js'
import { ensureBrandRevenueAccounts } from '../src/modules/accounting/brandRevenueAccount.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { postRefundPayment } from '../src/modules/accounting/orderPosting.js'
import { brandSalesRevenueCents } from '../src/modules/accounting/reports.js'
import { salesTaxReturn } from '../src/modules/accounting/salesTaxReturn.js'
import { salesTotals, salesBySettlement } from '../src/modules/reports/service.js'
import { updateOrderStatus } from '../src/modules/orders/service.js'
import { codDueWhere } from '../src/lib/cod.js'
import { prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, mgrA: Who, cashierB: Who
let drawerA: string
let waiterA: { id: string; code: string }, waiterB: { id: string; code: string }
let tableA1: string, tableA2: string, floorA: string
let codes: { main: string; servd: string }
const kicked: string[] = []

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(posTillFlowRoutes, { prefix: '/pos' })
  await a.register(floorRoutes, { prefix: '/floors' })
  await a.register(reportRoutes, { prefix: '/reports' })
  await a.register(servdFilingRoutes, { prefix: '/accounting/servd-filings' })
  await registerConnectorPlugins(a)
  await a.ready()
  return a
}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const kheer = (co: Company, quantity = 2) => [{ menuItemId: co.items.kheer, name: 'Kheer', quantity, unitPriceCents: 55_000, modifiers: [] }]

async function lines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return e?.lines.map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId, memo: l.memo })) ?? null
}
const sum = (ls: Array<{ code: string; type: string; cents: number }>, code: string, type: 'debit' | 'credit') =>
  ls.filter((l) => l.code === code && l.type === type).reduce((s, l) => s + l.cents, 0)

async function closeAndPost(shiftId: string): Promise<string> {
  const counted = await prisma.payment.aggregate({ where: { shiftId, method: 'cash', status: 'paid' }, _sum: { amountCents: true } })
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: counted._sum.amountCents ?? 0 } })
  const r = await postShiftClose(shiftId)
  expect(r.posted, r.reason).toBe(true)
  return r.entryId!
}

beforeAll(async () => {
  A = await mkCompany('tflow-a', { srbPosId: 8101 })
  B = await mkCompany('tflow-b', { srbPosId: 8102 })
  cashierA = await mkUser('tflow-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('tflow-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('tflow-cashier-b', 'cashier', B.tenantId)
  drawerA = await openDrawer(A, cashierA)
  const wa = await prisma.hrEmployee.create({ data: { tenantId: A.tenantId, employeeCode: 'TFA-001', fullName: 'Bilal Waiter' } })
  const wb = await prisma.hrEmployee.create({ data: { tenantId: B.tenantId, employeeCode: 'TFB-001', fullName: 'B Waiter' } })
  waiterA = { id: wa.id, code: wa.employeeCode }
  waiterB = { id: wb.id, code: wb.employeeCode }
  floorA = (await prisma.floor.create({ data: { conceptId: A.conceptId, name: 'Main' } })).id
  tableA1 = (await prisma.table.create({ data: { conceptId: A.conceptId, floorId: floorA, label: 'T1' } })).id
  tableA2 = (await prisma.table.create({ data: { conceptId: A.conceptId, floorId: floorA, label: 'T2' } })).id
  await ensureBrandRevenueAccounts()
  const cA = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
  codes = { main: cA.revenueAccountCode!, servd: cA.servdRevenueAccountCode! }
  setFiscalKicker(async (id) => { kicked.push(id) })
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
  await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false, settings: { fiscalReportingRequired: true } })
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('two accounts per brand', () => {
  it('each brand gets a main and a servd sub-account in ITS company, distinct codes in 4010–4089', async () => {
    for (const co of [A, B]) {
      const c = await prisma.concept.findUniqueOrThrow({ where: { id: co.conceptId } })
      expect(c.revenueAccountCode).toMatch(/^40[1-8]\d$/)
      expect(c.servdRevenueAccountCode).toMatch(/^40[1-8]\d$/)
      expect(c.servdRevenueAccountCode).not.toBe(c.revenueAccountCode)
      const acc = await prisma.account.findFirstOrThrow({ where: { tenantId: co.tenantId, code: c.servdRevenueAccountCode! } })
      expect(acc.name).toContain('(servd)')
    }
    // Idempotent.
    const again = await ensureBrandRevenueAccounts()
    expect(again.filter((r) => r.conceptId === A.conceptId || r.conceptId === B.conceptId)).toHaveLength(0)
  })
})

describe('dine in: table, waiter, pax, guest', () => {
  it('opens a ticket on a table with the waiter code, pax and a new guest; the board shows it', async () => {
    const r = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, tableId: tableA1, fulfilmentType: 'dine_in', waiterCode: 'tfa-001', partySize: 3,
      guest: { name: 'Ayesha Guest', mobile: '0300 1112223', email: 'ayesha@guest.pk', registrationNo: 'REG-9' },
      items: kheer(A),
    })
    expect(r.statusCode, r.body).toBe(201)
    const o = r.json()
    expect(o).toMatchObject({ waiterEmployeeId: waiterA.id, partySize: 3, guestRegistrationNo: 'REG-9', fulfilmentType: 'dine_in', source: 'pos' })
    expect(o.customerId).toBeTruthy()
    const cust = await prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } })
    expect(cust).toMatchObject({ name: 'Ayesha Guest', phone: '923001112223', email: 'ayesha@guest.pk' })

    const board = await call(cashierA, 'GET', `/floors/board?conceptId=${A.conceptId}`)
    expect(board.statusCode, board.body).toBe(200)
    const b = board.json()
    expect(b.totals).toEqual({ tables: 2, occupied: 1, vacant: 1 })
    expect(b.floors[0]).toMatchObject({ id: floorA, totals: { tables: 2, occupied: 1, vacant: 1 } })
    const t1 = b.tables.find((t: { id: string }) => t.id === tableA1)
    expect(t1).toMatchObject({ occupied: true, openOrders: 1, order: { id: o.id, partySize: 3, waiter: { code: 'TFA-001', name: 'Bilal Waiter' } } })

    const info = await call(cashierA, 'GET', `/pos/orders/${o.id}/info`)
    expect(info.json()).toMatchObject({ partySize: 3, waiter: { id: waiterA.id }, guest: { name: 'Ayesha Guest', registrationNo: 'REG-9' }, table: { id: tableA1 } })

    // Reassign the waiter by id; move to T2.
    const p = await call(cashierA, 'PATCH', `/pos/orders/${o.id}/info`, { waiterEmployeeId: waiterA.id, partySize: 4, tableId: tableA2 })
    expect(p.statusCode, p.body).toBe(200)
    expect(p.json()).toMatchObject({ partySize: 4, table: { id: tableA2 } })
    expect((await prisma.table.findUniqueOrThrow({ where: { id: tableA1 } })).currentOrderId).toBeNull()
    expect((await prisma.table.findUniqueOrThrow({ where: { id: tableA2 } })).currentOrderId).toBe(o.id)
  })

  it('company B: 404 on A\'s brand board, A\'s order info; 422 on another company\'s waiter, customer and table', async () => {
    expect((await call(cashierB, 'GET', `/floors/board?conceptId=${A.conceptId}`)).statusCode).toBe(404)
    expect((await call(cashierB, 'GET', `/pos/waiters?conceptId=${A.conceptId}`)).statusCode).toBe(404)
    const mine = await prisma.order.findFirstOrThrow({ where: { conceptId: A.conceptId } })
    expect((await call(cashierB, 'GET', `/pos/orders/${mine.id}/info`)).statusCode).toBe(404)
    expect((await call(cashierB, 'PATCH', `/pos/orders/${mine.id}/info`, { partySize: 2 })).statusCode).toBe(404)
    // A's waiter at B's brand
    const w = await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, waiterCode: waiterA.code, items: kheer(B) })
    expect(w.statusCode).toBe(422)
    expect(w.json().error.code).toBe('WAITER_CODE_UNKNOWN')
    const wid = await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, waiterEmployeeId: waiterA.id, items: kheer(B) })
    expect(wid.json().error.code).toBe('WAITER_NOT_IN_COMPANY')
    // A's customer (has an order at A only) at B's brand
    const c = await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, customerId: mine.customerId, items: kheer(B) })
    expect(c.statusCode).toBe(422)
    expect(c.json().error.code).toBe('CUSTOMER_NOT_FOUND')
    // A's table at B's brand
    const t = await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, tableId: tableA1, items: kheer(B) })
    expect(t.json().error.code).toBe('TABLE_NOT_IN_BRAND')
    // A create binds to the active company: B's cashier cannot ring at A's brand.
    // (the existing per-user brand check answers first: 403; never a ticket)
    expect([403, 404]).toContain((await call(cashierB, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A) })).statusCode)
  })

  it('guest search is the company\'s own customers only', async () => {
    const a = await call(cashierA, 'GET', `/pos/guests?conceptId=${A.conceptId}&q=ayesha`)
    expect(a.json().guests.map((g: { name: string }) => g.name)).toContain('Ayesha Guest')
    const byPhone = await call(cashierA, 'GET', `/pos/guests?conceptId=${A.conceptId}&q=03001112223`)
    expect(byPhone.json().guests).toHaveLength(1)
    const b = await call(cashierB, 'GET', `/pos/guests?conceptId=${B.conceptId}&q=ayesha`)
    expect(b.statusCode).toBe(200)
    expect(b.json().guests).toHaveLength(0)
    // B typing A's guest's mobile does not link A's customer.
    const r = await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, guest: { name: 'Someone', mobile: '03001112223' }, items: kheer(B) })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().customerId).toBeNull()
    expect(r.json().customerName).toBe('Someone')
  })

  it('item search by code / SKU', async () => {
    await prisma.menuItem.update({ where: { id: A.items.kheer }, data: { itemCode: 'KH-01' } })
    const r = await call(cashierA, 'GET', `/pos/menu/search?conceptId=${A.conceptId}&q=kh-0`)
    expect(r.json().items[0]).toMatchObject({ id: A.items.kheer, itemCode: 'KH-01' })
    expect((await call(cashierB, 'GET', `/pos/menu/search?conceptId=${A.conceptId}&q=kh`)).statusCode).toBe(404)
  })
})

describe('settle: close in servd vs push to Keenu', () => {
  let servdOrder: string, keenuOrder: string
  let shiftEntry: string

  it('close in servd: revenue to the servd sub-account, the fiscal document held for a manual filing', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A) })).json()
    servdOrder = o.id
    const before = testDriverCalls.submitSale
    const r = await call(cashierA, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawerA, settlementChannel: 'servd',
      payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ orderCompleted: true, fiscal: { rawStatus: 'manual_required', statusReason: 'servd_channel' } })
    expect(testDriverCalls.submitSale).toBe(before)
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId: o.id } })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ kind: 'sale', status: 'manual_required', statusReason: 'servd_channel', tenantId: A.tenantId })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).settlementChannel).toBe('servd')
  })

  it('push to Keenu (TEST driver): settled, main account, the sale document sent once', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    keenuOrder = o.id
    const before = testDriverCalls.submitSale
    const r = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push`, { shiftId: drawerA, method: 'card' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ state: 'settled', orderCompleted: true })
    expect(r.json().fiscal).toMatchObject({ rawStatus: 'filed' })
    expect(testDriverCalls.submitSale).toBe(before + 1)
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId: o.id } })
    expect(docs).toHaveLength(1)
    expect((docs[0]!.payload as { settlement?: { channel: string } }).settlement?.channel).toBe('keenu')
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: 'paid' } })
    expect(pay).toMatchObject({ method: 'card', shiftId: drawerA })
    // Card rate (8%): 55,000 + 4,400.
    expect(pay.amountCents).toBe(59_400)
    // A replay answers what it recorded; another tender is refused.
    const again = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push`, { shiftId: drawerA, method: 'card' })
    expect(again.json()).toMatchObject({ state: 'settled', replayed: true })
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
    // B cannot push A's order.
    const drawerB = await openDrawer(B, cashierB)
    expect((await call(cashierB, 'POST', `/pos/orders/${o.id}/keenu-push`, { shiftId: drawerB, method: 'card' })).statusCode).toBe(404)
  })

  it('a pending push blocks other tenders; declined clears the channel', async () => {
    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'ok', push: 'pending' } } })
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    const p = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push`, { shiftId: drawerA, method: 'cash' })
    expect(p.statusCode, p.body).toBe(202)
    const pay = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: o.totalCents }] })
    expect(pay.statusCode).toBe(409)
    // Keenu settles: Check records it.
    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'ok', push: 'settle' } } })
    const chk = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push/check`)
    expect(chk.statusCode, chk.body).toBe(200)
    expect(chk.json()).toMatchObject({ state: 'settled', orderCompleted: true })

    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'ok', push: 'decline' } } })
    const d = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    const dr = await call(cashierA, 'POST', `/pos/orders/${d.id}/keenu-push`, { shiftId: drawerA, method: 'cash' })
    expect(dr.json().error.code).toBe('KEENU_DECLINED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: d.id } })).settlementChannel).toBeNull()
    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'ok', push: 'settle' } } })
    // B (no live POS) cannot push at all.
    const ob = (await call(cashierB, 'POST', '/pos/orders', { conceptId: B.conceptId, items: kheer(B, 1) })).json()
    const drawerB = await openDrawer(B, cashierB)
    expect((await call(cashierB, 'POST', `/pos/orders/${ob.id}/keenu-push`, { shiftId: drawerB, method: 'cash' })).json().error.code).toBe('KEENU_NOT_AVAILABLE')
  })

  it('a tip from excess cash is a tip, not revenue', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    const r = await call(cashierA, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawerA, settlementChannel: 'servd',
      payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents + 5_000, excessAsTip: true }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.tipCents).toBe(5_000)
    expect(after.totalCents).toBe(o.totalCents + 5_000)
    const p = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id } })
    expect(p).toMatchObject({ amountCents: o.totalCents + 5_000, changeCents: 0 })
    // The tip pool sums Order.tipCents of completed orders of the brand.
    const pool = await prisma.order.aggregate({ where: { conceptId: A.conceptId, status: { in: ['completed', 'refunded'] } }, _sum: { tipCents: true } })
    expect(pool._sum.tipCents).toBeGreaterThanOrEqual(5_000)
  })

  it('split tender on one servd bill: several tenders in one payment', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    const half = Math.floor(o.totalCents / 2)
    const r = await call(cashierA, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawerA, settlementChannel: 'servd',
      payments: [{ method: 'cash', amountCents: half, tenderedCents: half }, { method: 'cash', amountCents: o.totalCents - half, tenderedCents: o.totalCents - half }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().orderCompleted).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(2)
    // A part payment alone is refused (the tenders of one call cover the bill).
    const p = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    const part = await call(cashierA, 'POST', '/pos/payments', { orderId: p.id, shiftId: drawerA, settlementChannel: 'servd', payments: [{ method: 'cash', amountCents: 100 }] })
    expect(part.json().error.code).toBe('AMOUNT_MISMATCH')
    await prisma.order.update({ where: { id: p.id }, data: { status: 'cancelled' } })
  })

  it('Order Summary: the caller\'s own open drawer, by tender and by settlement', async () => {
    const r = await call(cashierA, 'GET', '/pos/shifts/current/summary')
    expect(r.statusCode, r.body).toBe(200)
    const s = r.json().shift
    expect(s.shiftId).toBe(drawerA)
    expect(s.bySettlement.servd.orders).toBeGreaterThanOrEqual(3)
    expect(s.bySettlement.keenu.orders).toBe(2)
    expect(s.byTender.cardCents).toBeGreaterThan(0)
    expect(s).not.toHaveProperty('expectedCashCents')
    // Another company's cashier sees only their own drawer.
    const b = (await call(cashierB, 'GET', '/pos/shifts/current/summary')).json().shift
    expect(b?.shiftId).not.toBe(drawerA)
  })

  it('the shift close credits the servd part to the servd sub-account and the rest to the main account; tips to 2095', async () => {
    shiftEntry = await closeAndPost(drawerA)
    const ls = (await prisma.journalLine.findMany({ where: { journalEntryId: shiftEntry }, include: { account: true } }))
      .map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId }))
    // servd: 2 × 55,000 (servdOrder) + 55,000 (tip order) + 55,000 (split) = 220,000 ex tax; keenu: 2 × 55,000 (keenuOrder + the checked push).
    expect(sum(ls, codes.servd, 'credit')).toBe(220_000)
    expect(sum(ls, codes.main, 'credit')).toBe(110_000)
    expect(sum(ls, '2095', 'credit')).toBe(5_000)
    expect(ls.filter((l) => l.code === codes.servd).every((l) => l.conceptId === A.conceptId)).toBe(true)
    // P&L / food cost denominator counts both accounts as the brand's sales.
    const from = new Date('2026-01-01T00:00:00Z'); const to = new Date(Date.now() + 86_400_000)
    expect(await brandSalesRevenueCents(prisma, A.tenantId, { from, to, conceptId: A.conceptId })).toBe(330_000)
  })

  it('a refund of each reverses the account its sale credited', async () => {
    for (const [orderId, code] of [[servdOrder, codes.servd], [keenuOrder, codes.main]] as const) {
      const p = await prisma.payment.create({ data: { orderId, method: 'cash', amountCents: -11_500, status: 'refunded', processedAt: new Date() } })
      const r = await postRefundPayment(p.id)
      expect(r.posted, r.reason).toBe(true)
      const ls = (await lines(A.tenantId, `order.refund:${p.id}`))!
      expect(sum(ls, code, 'debit')).toBeGreaterThan(0)
      expect(sum(ls, code === codes.servd ? codes.main : codes.servd, 'debit')).toBe(0)
    }
    // The servd sale's return is filed by hand too.
    const ret = await prisma.fiscalDocument.findFirst({ where: { orderId: servdOrder, kind: 'refund' } })
    if (ret) expect(ret).toMatchObject({ status: 'manual_required', statusReason: 'servd_channel' })
  })

  it('the month close blocks on unfiled servd sales until finance records the portal filing; B is unaffected', async () => {
    const ctx = (tenantId: string) => ({ db: prisma, tenantId, prevLock: null, newLock: new Date(Date.now() + 86_400_000), months: [], isYearEnd: false })
    const block = await servdFilingsCloseCheck.run(ctx(A.tenantId))
    expect(block).toMatchObject({ key: 'servd_sales_unfiled', severity: 'block', overridable: true })
    expect(await servdFilingsCloseCheck.run(ctx(B.tenantId))).toBeNull()

    const finance = await mkUser('tflow-fin-a', 'finance', A.tenantId)
    const financeB = await mkUser('tflow-fin-b', 'finance', B.tenantId)
    const list = await call(finance, 'GET', '/accounting/servd-filings')
    expect(list.statusCode, list.body).toBe(200)
    const ids = list.json().documents.map((d: { id: string }) => d.id)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    expect((await call(financeB, 'GET', '/accounting/servd-filings')).json().documents).toHaveLength(0)
    // B cannot file A's documents.
    expect((await call(financeB, 'POST', '/accounting/servd-filings/record', { documentIds: ids, portalReference: 'SRB-X', authority: 'srb', filedOn: '2026-10-19' })).statusCode).toBe(404)
    // A cashier cannot file at all.
    expect((await call(cashierA, 'POST', '/accounting/servd-filings/record', { documentIds: ids, portalReference: 'SRB-X', authority: 'srb', filedOn: '2026-10-19' })).statusCode).toBe(403)
    const rec = await call(finance, 'POST', '/accounting/servd-filings/record', { documentIds: ids, portalReference: 'SRB-OCT-W3', authority: 'srb', filedOn: '2026-10-19' })
    expect(rec.statusCode, rec.body).toBe(200)
    expect(rec.json().recorded).toBe(ids.length)
    const filed = await prisma.fiscalDocument.findFirstOrThrow({ where: { id: ids[0] } })
    expect(filed).toMatchObject({ status: 'manual_filed', fiscalNumber: 'SRB-OCT-W3', statusReason: 'servd_portal' })
    expect(await servdFilingsCloseCheck.run(ctx(A.tenantId))).toBeNull()
    // Filing twice is refused.
    expect((await call(finance, 'POST', '/accounting/servd-filings/record', { documentIds: [ids[0]], portalReference: 'X', authority: 'srb', filedOn: '2026-10-19' })).statusCode).toBe(409)
  })

  it('reports: settlement filter, combined = sum; the sales-tax return includes both channels', async () => {
    const from = new Date('2026-01-01T00:00:00Z'); const to = new Date(Date.now() + 86_400_000)
    const q = { company: { tenantId: A.tenantId }, from, to }
    const by = await salesBySettlement(q)
    const keenu = by.rows.find((r) => r.settlement === 'keenu')!
    const servd = by.rows.find((r) => r.settlement === 'servd')!
    expect(keenu.orders).toBe(2)
    expect(servd.orders).toBeGreaterThanOrEqual(2)
    const all = await salesTotals({ ...q, settlement: 'all' })
    expect(by.combined.gross).toBe(all.gross)
    expect(by.combined.net).toBe(all.net)
    expect(keenu.gross + servd.gross + by.rows.find((r) => r.settlement === 'none')!.gross).toBe(all.gross)
    const r = await call(mgrA, 'GET', `/reports/by-settlement?dateFrom=2026-01-01&dateTo=2030-01-01`)
    expect(r.statusCode, r.body).toBe(200)
    const s = await call(mgrA, 'GET', `/reports/sales?settlement=servd&dateFrom=2026-01-01&dateTo=2030-01-01`)
    expect(s.statusCode, s.body).toBe(200)
    expect((await call(mgrA, 'GET', '/reports/sales?settlement=bogus')).statusCode).toBe(400)

    const ret = await salesTaxReturn(A.tenantId, from, to)
    const row = ret.taxableValueByConceptCents.find((x) => x.conceptSlug === 'brand-tflow-a')!
    // Both accounts: 330,000 sold − the two refunds' revenue shares.
    const net = await brandSalesRevenueCents(prisma, A.tenantId, { from, to, conceptId: A.conceptId })
    expect(row.revenueCents).toBe(net)
  })
})

describe('delivery from the till', () => {
  let zoneId: string
  beforeAll(async () => {
    zoneId = (await prisma.deliveryZone.create({ data: { tenantId: A.tenantId, conceptId: A.conceptId, name: 'Inner', feeCents: 20_000 } })).id
  })

  it('paid at the counter: fee + GST at the tender rate, to dispatch, completes ON DELIVERY', async () => {
    const drawer = await openDrawer(A, cashierA)
    const z = await call(cashierA, 'GET', `/pos/delivery-zones?conceptId=${A.conceptId}`)
    expect(z.json().zones.map((x: { id: string }) => x.id)).toContain(zoneId)
    expect((await call(cashierB, 'GET', `/pos/delivery-zones?conceptId=${A.conceptId}`)).statusCode).toBe(404)
    // A zone is required when the brand has zones.
    const nz = await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, fulfilmentType: 'delivery', delivery: { name: 'Zara', phone: '03004445556', address: 'House 1', cod: false }, items: kheer(A, 1) })
    expect(nz.json().error.code).toBe('DELIVERY_ZONE_REQUIRED')
    const r = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, fulfilmentType: 'delivery', items: kheer(A, 1),
      delivery: { name: 'Zara', phone: '03004445556', address: 'House 1, Street 2', zoneId, cod: false },
    })
    expect(r.statusCode, r.body).toBe(201)
    const o = r.json()
    expect(o).toMatchObject({ source: 'manual', fulfilmentType: 'delivery', deliveryFeeCents: 20_000, deliveryFeeTaxCents: 3_000 })
    expect(o.totalCents).toBe(55_000 + 8_250 + 20_000 + 3_000)
    expect(o.deliveryNotes).toContain('House 1')
    const pay = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, settlementChannel: 'servd', payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    expect(pay.statusCode, pay.body).toBe(201)
    expect(pay.json().orderCompleted).toBe(false)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('completed')
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
    // The rider delivers → completed, one sale document (servd: manual), its own order.complete entry.
    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    await updateOrderStatus(o.id, 'completed', { actor: { id: mgrA.id, tenantId: A.tenantId }, via: 'rider_delivered' })
    await new Promise((res) => setTimeout(res, 300))
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id, kind: 'sale', statusReason: 'servd_channel' } })).toBe(1)
    const ls = (await lines(A.tenantId, `order.complete:${o.id}`))!
    expect(ls).not.toBeNull()
    expect(sum(ls, codes.servd, 'credit')).toBe(55_000)
    expect(sum(ls, '4110', 'credit')).toBe(20_000)
  })

  it('cash on delivery ⇄ pay now can change after Save, until money is taken / the rider picks it up', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, fulfilmentType: 'delivery', items: kheer(A, 1),
      delivery: { name: 'Hina', phone: '03001231231', address: 'Plot 4', zoneId, cod: false },
    })).json()
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
    const on = await call(cashierA, 'PATCH', `/pos/orders/${o.id}/info`, { delivery: { cod: true } })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toMatchObject({ settlementChannel: 'servd', delivery: { cod: true, address: 'Plot 4' } })
    expect(await prisma.payment.count({ where: { orderId: o.id, method: 'cash', status: 'pending' } })).toBe(1)
    const off = await call(cashierA, 'PATCH', `/pos/orders/${o.id}/info`, { delivery: { cod: false } })
    expect(off.json().delivery.cod).toBe(false)
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'pending' } })).toBe(0)
    // Pay now, then the switch is refused.
    const drawer = await openDrawer(A, cashierA)
    expect((await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, settlementChannel: 'servd', payments: [{ method: 'cash', amountCents: o.totalCents }] })).statusCode).toBe(201)
    expect((await call(cashierA, 'PATCH', `/pos/orders/${o.id}/info`, { delivery: { cod: true } })).json().error.code).toBe('ALREADY_PAID')
    // A dine-in ticket has no cash on delivery.
    const d = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: kheer(A, 1) })).json()
    expect((await call(cashierA, 'PATCH', `/pos/orders/${d.id}/info`, { delivery: { cod: true } })).json().error.code).toBe('NOT_A_TILL_DELIVERY')
  })

  it('cash on delivery: a pending cash payment, closed in servd, COD custody after delivery', async () => {
    const r = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, fulfilmentType: 'delivery', items: kheer(A, 1),
      delivery: { name: 'Omar', phone: '03007778889', address: 'Flat 9', zoneId, cod: true },
    })
    expect(r.statusCode, r.body).toBe(201)
    const o = r.json()
    expect(o.settlementChannel).toBe('servd')
    expect(o.deliveryOtp ?? (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtp).toMatch(/^\d{4}$/)
    const pending = await prisma.payment.findMany({ where: { orderId: o.id } })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ method: 'cash', status: 'pending', amountCents: o.totalCents })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    await updateOrderStatus(o.id, 'completed', { actor: { id: mgrA.id, tenantId: A.tenantId }, via: 'rider_delivered' })
    const due = await prisma.payment.findMany({ where: codDueWhere({ tenantId: A.tenantId }) })
    expect(due.map((p) => p.orderId)).toContain(o.id)
    expect(await prisma.payment.count({ where: { ...codDueWhere({ tenantId: B.tenantId }), orderId: o.id } })).toBe(0)
  })
})
