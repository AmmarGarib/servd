// W1 — POST /webhooks/pos/:token (spec §5 inbound, §8.3): signature, replay,
// fail-closed, and company separation (a token selects ONE company's rows).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { signBody } from '../src/connectors/util.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { testApproval } from '../src/connectors/drivers/test.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, cashierB: Who
let drawerA: string, drawerB: string
let tokenA: string, tokenB: string
const SECRET_A = 'whsec_company_a_0123456789abcdef'
let prevKey: string | undefined

async function ring(who: Who, co: Company): Promise<{ id: string }> {
  const r = await call(who, 'POST', '/pos/orders', { conceptId: co.conceptId, items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }] })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}

async function startCharge(who: Who, co: Company, drawer: string): Promise<{ id: string; amountCents: number; orderId: string }> {
  const o = await ring(who, co)
  const q = await call(who, 'GET', `/pos/orders/${o.id}/quote?method=card`)
  const r = await call(who, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: `key-${o.id}` })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}

function post(token: string, body: unknown, opts: { secret?: string; t?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body)
  const t = opts.t ?? Math.floor(Date.now() / 1000)
  const sig = opts.sig ?? (opts.secret ? signBody(opts.secret, raw, t) : undefined)
  return app.inject({ method: 'POST', url: `/webhooks/pos/${token}`, payload: raw, headers: { 'content-type': 'application/json', ...(sig && { 'x-servd-signature': sig }) } })
}

const event = (id: string, chargeId: string, status: 'approved' | 'declined', amountCents = 0) => ({
  id, type: 'terminal.charge.updated', createdAt: new Date().toISOString(),
  data: status === 'approved'
    ? { chargeId, status, ...(({ state: _s, last4, ...rest }) => ({ ...rest, last4 }))(testApproval(chargeId, amountCents)) }
    : { chargeId, status, message: 'Insufficient funds' },
})

const waitFor = async (fn: () => Promise<boolean>, ms = 4000) => {
  const until = Date.now() + ms
  while (!(await fn()) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  setConnectorClock(null)
  A = await mkCompany('wh-a')
  B = await mkCompany('wh-b')
  cashierA = await mkUser('whCashierA', 'cashier', A.tenantId)
  cashierB = await mkUser('whCashierB', 'cashier', B.tenantId)
  const terminals = (co: Company) => ({ terminals: [{ id: 'trm-1', label: 'Counter', locationId: co.locationId, terminalId: 'DEV-1', active: true }], test: { scenario: 'never' } })
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminals(A), webhookSecret: SECRET_A })
  await setConnector(B.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminals(B), webhookSecret: null })
  tokenA = (await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'terminal' } } })).webhookToken
  tokenB = (await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: B.tenantId, kind: 'terminal' } } })).webhookToken
  app = await buildApp()
  call = caller(app)
  drawerA = await openDrawer(A, cashierA)
  drawerB = await openDrawer(B, cashierB)
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('POST /webhooks/pos/:token', () => {
  it('a valid signature applies the event (declined)', async () => {
    const c = await startCharge(cashierA, A, drawerA)
    const r = await post(tokenA, event('evt_decl_1', c.id, 'declined'), { secret: SECRET_A })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ ok: true })
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('declined')
  })

  it('an approval records ONE payment, even when the same event is replayed', async () => {
    const c = await startCharge(cashierA, A, drawerA)
    const body = event('evt_appr_1', c.id, 'approved', c.amountCents)
    const r1 = await post(tokenA, body, { secret: SECRET_A })
    const r2 = await post(tokenA, body, { secret: SECRET_A })
    expect(r1.statusCode).toBe(200)
    expect(r2.statusCode).toBe(200)
    expect(r2.json()).toMatchObject({ duplicate: true })
    await waitFor(async () => (await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } })).status === 'recorded')
    const charge = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } })
    expect(charge.status).toBe('recorded')
    // A replay under a new event id moves nothing (forward-only).
    await post(tokenA, event('evt_appr_2', c.id, 'approved', c.amountCents), { secret: SECRET_A })
    await post(tokenA, event('evt_decl_late', c.id, 'declined'), { secret: SECRET_A })
    await new Promise((r) => setTimeout(r, 200))
    expect(await prisma.payment.count({ where: { orderId: c.orderId, status: 'paid' } })).toBe(1)
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('recorded')
  })

  it('bad signature → 401; stale timestamp → 401; no signature → 401', async () => {
    const c = await startCharge(cashierA, A, drawerA)
    expect((await post(tokenA, event('evt_bad', c.id, 'declined'), { secret: 'not-the-secret' })).statusCode).toBe(401)
    expect((await post(tokenA, event('evt_old', c.id, 'declined'), { secret: SECRET_A, t: Math.floor(Date.now() / 1000) - 600 })).statusCode).toBe(401)
    expect((await post(tokenA, event('evt_none', c.id, 'declined'))).statusCode).toBe(401)
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('sent')
  })

  it('no secret configured → 503 (fail closed); unknown token → 404', async () => {
    expect((await post(tokenB, event('evt_b', 'whatever', 'declined'), { secret: 'x' })).statusCode).toBe(503)
    expect((await post('f'.repeat(64), event('evt_x', 'whatever', 'declined'), { secret: SECRET_A })).statusCode).toBe(404)
    expect((await post('not-a-token', event('evt_y', 'whatever', 'declined'), { secret: SECRET_A })).statusCode).toBe(404)
  })

  it('B\'s charge id on A\'s token is ignored and B\'s row is untouched', async () => {
    const cb = await startCharge(cashierB, B, drawerB)
    const r = await post(tokenA, event('evt_cross', cb.id, 'declined'), { secret: SECRET_A })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ ignored: true })
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: cb.id } })).status).toBe('sent')
  })

  it('a fiscal event on the terminal connector is not applied', async () => {
    const r = await post(tokenA, { id: 'evt_f', type: 'fiscal.document.updated', data: { documentId: 'x', status: 'filed', fiscalNumber: 'N', authority: 'srb' } }, { secret: SECRET_A })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ignored: true })
  })
})
