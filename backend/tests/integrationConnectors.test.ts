// I2 — connector route scoping and the small cross-file follow-ups (W4):
//   - GET /connectors/fiscal/documents and GET /connectors/terminal/charges
//     list the ACTIVE company only, even for an operator in two companies
//     with the portfolio view on; counts are that company's; every item
//     carries its tenantId; a brand filter of another company is 404.
//   - PUT /connectors/fiscal/brand-pos-ids caps ids at INT4 max (400, not a
//     500 from Postgres).
//   - chargeView carries targetPaymentId (refund charges).
//   - GET /pos/orders/:orderId/fiscal reads for finance and management too,
//     still company-scoped (another company's order → 404) and lastError
//     still managers-only.
//   - GET /media/upload-url → 503 STORAGE_NOT_CONFIGURED when R2 is unset.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import {
  prisma, mkCompany, mkUser, mkOrder, buildApp, caller, setConnector, resetConnectorCache, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { enqueueFiscalSaleTx, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { mediaRoutes, missingStorageEnv, R2_REQUIRED_ENV } from '../src/modules/media/routes.js'
import { AppError, errorResponse } from '../src/lib/errors.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
const u: Record<string, Who> = {}
let prevKey: string | undefined
let orderA: string, orderB: string
let docA: string, docB: string
let chargeA: string, refundA: string, chargeB: string
let paymentA: string

const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
async function sale(co: Company): Promise<{ orderId: string; docId: string }> {
  const orderId = await mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'card', amountCents: 126_500 }] })
  const doc = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))
  return { orderId, docId: doc!.id }
}

async function charge(co: Company, orderId: string, who: Who, extra: { kind?: 'charge' | 'refund'; targetPaymentId?: string | null } = {}): Promise<string> {
  const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: co.tenantId, kind: 'terminal' } } })
  const row = await prisma.terminalCharge.create({
    data: {
      tenantId: co.tenantId, kind: extra.kind ?? 'charge', connectorId: conn.id, terminalId: 'trm-1', orderId,
      targetPaymentId: extra.targetPaymentId ?? null, amountCents: 118_800, quoteDueCents: 118_800,
      idempotencyKey: `i2-${Math.random().toString(36).slice(2)}`, status: 'declined',
      expiresAt: new Date(Date.now() + 60_000), createdById: who.id,
    },
  })
  return row.id
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  A = await mkCompany('i2-a', { srbPosId: 111 })
  B = await mkCompany('i2-b', { srbPosId: 222 })
  u['adminA'] = await mkUser('i2adminA', 'admin', A.tenantId)
  u['adminB'] = await mkUser('i2adminB', 'admin', B.tenantId)
  u['mgmtA'] = await mkUser('i2mgmtA', 'management', A.tenantId)
  u['financeA'] = await mkUser('i2financeA', 'finance', A.tenantId)
  u['financeB'] = await mkUser('i2financeB', 'finance', B.tenantId)
  u['cashierA'] = await mkUser('i2cashierA', 'cashier', A.tenantId)
  u['kitchenA'] = await mkUser('i2kitchenA', 'kitchen', A.tenantId)
  // The CEO of both companies, active in A.
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u['adminA']!.id } })

  for (const co of [A, B]) {
    await setConnector(co.tenantId, 'terminal', {
      driver: 'test', enabled: true,
      settings: { terminals: [{ id: 'trm-1', label: 'Counter 1', locationId: co.locationId, terminalId: 'DEV-1', active: true }] },
    })
  }
  ;({ orderId: orderA, docId: docA } = await sale(A))
  ;({ orderId: orderB, docId: docB } = await sale(B))
  await prisma.fiscalDocument.update({ where: { id: docA }, data: { lastError: 'vendor said no (internal detail)' } })
  paymentA = (await prisma.payment.findFirstOrThrow({ where: { orderId: orderA } })).id
  chargeA = await charge(A, orderA, u['cashierA']!)
  refundA = await charge(A, orderA, u['cashierA']!, { kind: 'refund', targetPaymentId: paymentA })
  chargeB = await charge(B, orderB, u['adminB']!)

  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('GET /connectors/fiscal/documents — the ACTIVE company only', () => {
  it('a two-company CEO with the portfolio view on sees only the active company, with tenantId on each item and its own counts', async () => {
    for (const headers of [{}, { 'x-servd-portfolio': '1' }]) {
      const r = await call(u['adminA']!, 'GET', '/connectors/fiscal/documents', undefined, headers)
      expect(r.statusCode, r.body).toBe(200)
      const body = r.json() as { items: Array<{ id: string; tenantId: string }>; counts: Record<string, number> }
      const ids = body.items.map((i) => i.id)
      expect(ids).toContain(docA)
      expect(ids).not.toContain(docB)
      expect(body.items.every((i) => i.tenantId === A.tenantId)).toBe(true)
      const total = Object.values(body.counts).reduce((s, n) => s + (typeof n === 'number' ? n : 0), 0)
      expect(total).toBeGreaterThan(0)
      const own = await prisma.fiscalDocument.count({ where: { tenantId: A.tenantId } })
      expect(own).toBe(body.items.length)
    }
  })

  it('company B sees only its own; A\'s brand as a filter is 404 for B and for A in portfolio mode when A is not active', async () => {
    const r = await call(u['adminB']!, 'GET', '/connectors/fiscal/documents')
    expect(r.json().items.map((i: { id: string }) => i.id)).toEqual([docB])
    expect((await call(u['adminB']!, 'GET', `/connectors/fiscal/documents?conceptId=${A.conceptId}`)).statusCode).toBe(404)
    // The two-company CEO is active in A: B's brand is not the connector's company.
    expect((await call(u['adminA']!, 'GET', `/connectors/fiscal/documents?conceptId=${B.conceptId}`, undefined, { 'x-servd-portfolio': '1' })).statusCode).toBe(404)
    const own = await call(u['adminA']!, 'GET', `/connectors/fiscal/documents?conceptId=${A.conceptId}`)
    expect(own.statusCode).toBe(200)
    expect(own.json().items.map((i: { id: string }) => i.id)).toEqual([docA])
  })

  it('no active company → 422 NO_ACTIVE_COMPANY (empty scope denies)', async () => {
    const nobody = await mkUser('i2nobody', 'it', null)
    const r = await call(nobody, 'GET', '/connectors/fiscal/documents')
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NO_ACTIVE_COMPANY')
    expect((await call(nobody, 'GET', '/connectors/terminal/charges')).statusCode).toBe(422)
  })
})

describe('GET /connectors/terminal/charges — the ACTIVE company only', () => {
  it('lists only the active company\'s charges, each with tenantId; refunds carry targetPaymentId', async () => {
    for (const headers of [{}, { 'x-servd-portfolio': '1' }]) {
      const r = await call(u['adminA']!, 'GET', '/connectors/terminal/charges', undefined, headers)
      expect(r.statusCode, r.body).toBe(200)
      const items = r.json().items as Array<{ id: string; tenantId: string; kind: string; targetPaymentId: string | null }>
      expect(items.map((i) => i.id).sort()).toEqual([chargeA, refundA].sort())
      expect(items.every((i) => i.tenantId === A.tenantId)).toBe(true)
      expect(items.find((i) => i.id === refundA)!.targetPaymentId).toBe(paymentA)
      expect(items.find((i) => i.id === chargeA)!.targetPaymentId).toBeNull()
    }
    const b = await call(u['adminB']!, 'GET', '/connectors/terminal/charges')
    expect(b.json().items.map((i: { id: string }) => i.id)).toEqual([chargeB])
  })
})

describe('PUT /connectors/fiscal/brand-pos-ids — INT4 ceiling', () => {
  it('rejects ids above 2147483647 with 400 and leaves the brand unchanged; the ceiling itself is accepted', async () => {
    const big = await call(u['adminA']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: 2147483648, srbPosId: 111 }] })
    expect(big.statusCode).toBe(400)
    const big2 = await call(u['adminA']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: null, srbPosId: 9_999_999_999 }] })
    expect(big2.statusCode).toBe(400)
    expect(await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { fbrPosId: true, srbPosId: true } })).toEqual({ fbrPosId: null, srbPosId: 111 })
    const ok = await call(u['adminA']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: 2147483647, srbPosId: 111 }] })
    expect(ok.statusCode, ok.body).toBe(200)
    // Another company's brand stays 404.
    expect((await call(u['adminB']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: 1, srbPosId: 1 }] })).statusCode).toBe(404)
  })
})

describe('GET /pos/orders/:orderId/fiscal — finance and management read too', () => {
  it('finance and management of the owning company get 200; finance sees no lastError, management does', async () => {
    const fin = await call(u['financeA']!, 'GET', `/pos/orders/${orderA}/fiscal`)
    expect(fin.statusCode, fin.body).toBe(200)
    const finDocs = fin.json() as Array<{ documentId: string; lastError: string | null }>
    expect(finDocs.map((d) => d.documentId)).toEqual([docA])
    expect(finDocs[0]!.lastError).toBeNull()
    const mg = await call(u['mgmtA']!, 'GET', `/pos/orders/${orderA}/fiscal`)
    expect(mg.statusCode).toBe(200)
    expect((mg.json() as Array<{ lastError: string | null }>)[0]!.lastError).toBe('vendor said no (internal detail)')
    const cash = await call(u['cashierA']!, 'GET', `/pos/orders/${orderA}/fiscal`)
    expect(cash.statusCode).toBe(200)
  })

  it('another company\'s finance gets 404; roles outside the list get 403', async () => {
    expect((await call(u['financeB']!, 'GET', `/pos/orders/${orderA}/fiscal`)).statusCode).toBe(404)
    expect((await call(u['kitchenA']!, 'GET', `/pos/orders/${orderA}/fiscal`)).statusCode).toBe(403)
    // Retry stays managers-only.
    expect((await call(u['financeA']!, 'POST', `/pos/orders/${orderA}/fiscal/retry`)).statusCode).toBe(403)
  })
})

describe('GET /media/upload-url — 503 STORAGE_NOT_CONFIGURED without R2', () => {
  let media: FastifyInstance
  const saved: Record<string, string | undefined> = {}
  beforeAll(async () => {
    for (const k of [...R2_REQUIRED_ENV, 'R2_BUCKET_NAME']) saved[k] = process.env[k]
    media = Fastify()
    media.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
      if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
      return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
    })
    await media.register(mediaRoutes, { prefix: '/media' })
    await media.ready()
  })
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await media.close()
  })

  it('names the missing settings, creates no asset; type errors still come first', async () => {
    for (const k of R2_REQUIRED_ENV) delete process.env[k]
    process.env['R2_ACCOUNT_ID'] = '   '
    expect(missingStorageEnv()).toEqual([...R2_REQUIRED_ENV])
    const before = await prisma.mediaAsset.count({ where: { tenantId: A.tenantId } })
    const r = await media.inject({ method: 'GET', url: '/media/upload-url?filename=a.png&contentType=image%2Fpng', headers: { authorization: `Bearer ${u['adminA']!.token}` } })
    expect(r.statusCode).toBe(503)
    expect(r.json().error.code).toBe('STORAGE_NOT_CONFIGURED')
    expect(r.json().error.details.missing).toEqual([...R2_REQUIRED_ENV])
    expect(await prisma.mediaAsset.count({ where: { tenantId: A.tenantId } })).toBe(before)
    const bad = await media.inject({ method: 'GET', url: '/media/upload-url?filename=a.exe&contentType=application%2Fx-msdownload', headers: { authorization: `Bearer ${u['adminA']!.token}` } })
    expect(bad.statusCode).toBe(422)
  })

  it('with R2 set, signs as before and binds the asset to the active company', async () => {
    process.env['R2_ACCOUNT_ID'] = 'acct-test'
    process.env['R2_ACCESS_KEY_ID'] = 'test-access-key'
    process.env['R2_SECRET_ACCESS_KEY'] = 'test-secret-not-real'
    process.env['R2_PUBLIC_URL'] = 'https://media.example.test'
    expect(missingStorageEnv()).toEqual([])
    const r = await media.inject({ method: 'GET', url: '/media/upload-url?filename=a.png&contentType=image%2Fpng', headers: { authorization: `Bearer ${u['adminB']!.token}` } })
    expect(r.statusCode, r.body).toBe(200)
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: r.json().assetId } })
    expect(asset.tenantId).toBe(B.tenantId)
  })
})
