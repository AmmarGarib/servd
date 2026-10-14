// Test company — fiscal + customer follow-ups (review findings fr-2, fr-3, fr-4):
//   • fr-2: a test company's past sales are NEVER filed. Turning test mode off
//     stamps `reportingRequiredSince`; the completion recovery sweep, the
//     sale / refund enqueue and release-held skip every order completed
//     before it. A sale completed after turning test off files normally. A
//     company that never was a test company behaves exactly as before.
//   • fr-3: the isTest flag and the fiscal switch move together (PATCH
//     test-mode) and PUT reporting-required re-reads isTest under the lock.
//   • fr-4: test-company orders never move a customer's shared rollups or the
//     first-order lookups (referral payout).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalReportingRequired } from '../src/modules/connectors/routes.js'
import { completeOrder, recoverIncompleteCompletions } from '../src/modules/orders/service.js'
import { enqueueFiscalRefundTx, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { fiscalReportingRequired, reportingRequiredSinceOf, saleFileable } from '../src/connectors/config.js'
import { invalidateTestTenants, isTestTenant } from '../src/lib/testCompany.js'
import { recomputeCustomerRollups } from '../src/lib/customerRollups.js'
import { runReferralRewardTrigger } from '../src/workers/loyaltyTriggers.js'
import {
  prisma, mkCompany, mkUser, mkOrder, setConnector, resetConnectorCache,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let T: Company   // becomes a test company
let R: Company   // never a test company
let ceo: Who

const KHEER = (co: Company) => ({
  items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }],
  taxCents: 8_250, taxRatePct: 15, totalCents: 63_250,
})

/** A completed order (completed NOW) that has run its completion. */
async function sold(co: Company, completedAt = new Date()): Promise<string> {
  const id = await mkOrder(co, KHEER(co))
  await prisma.order.update({ where: { id }, data: { completedAt, placedAt: new Date(completedAt.getTime() - 60_000) } })
  await completeOrder(id, null, { via: 'status_update' })
  return id
}
const docs = (orderId: string) => prisma.fiscalDocument.findMany({ where: { orderId } })
const settingsOf = async (tenantId: string) =>
  (await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId, kind: 'fiscal' } } })).settings
const patch = (id: string, isTest: boolean, reason: string) =>
  app.inject({ method: 'PATCH', url: `/tenants/${id}/test-mode`, payload: { isTest, reason }, headers: { authorization: `Bearer ${ceo.token}` } })

beforeAll(async () => {
  T = await mkCompany('tcf-test', { srbPosId: 7301 })
  R = await mkCompany('tcf-real', { srbPosId: 7302 })
  ceo = await mkUser('tcf-ceo', 'admin', T.tenantId)
  await prisma.tenantMember.createMany({ data: [{ tenantId: T.tenantId, userId: ceo.id }, { tenantId: R.tenantId, userId: ceo.id }], skipDuplicates: true })
  // Both report sales; no fiscal POS yet (sales are held, never sent).
  await setConnector(T.tenantId, 'fiscal', { driver: 'none', enabled: false, settings: { fiscalReportingRequired: true } })
  await setConnector(R.tenantId, 'fiscal', { driver: 'none', enabled: false, settings: { fiscalReportingRequired: true } })
  // The recovery marker (written at boot in production): count this file's orders.
  const since = new Date(Date.now() - 3_600_000).toISOString()
  await prisma.setting.upsert({ where: { key: 'orders.completionRecoverySince' }, create: { key: 'orders.completionRecoverySince', value: since }, update: { value: since } })
  setFiscalKicker(async () => {})
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await registerConnectorPlugins(app)
  await app.ready()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('fr-2: a test company\'s past sales are never filed', () => {
  let testSale: string
  let testSaleUnclaimed: string

  it('test mode ON: a completed sale gets no fiscal document', async () => {
    const on = await patch(T.tenantId, true, 'Practice kitchen for training')
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json()).toMatchObject({ isTest: true, fiscalReportingRequired: false })
    expect(reportingRequiredSinceOf(await settingsOf(T.tenantId))).toBeNull()
    testSale = await sold(T)
    expect(await docs(testSale)).toHaveLength(0)
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: testSale, action: 'order.complete' } })).toBe(1)
    // A sale completed during test mode whose completion never ran (no claim).
    testSaleUnclaimed = await mkOrder(T, KHEER(T))
    await prisma.order.update({ where: { id: testSaleUnclaimed }, data: { completedAt: new Date(Date.now() - 1_000), placedAt: new Date(Date.now() - 60_000) } })
  })

  it('test mode OFF stamps reportingRequiredSince; the recovery sweep files NONE of the test sales', async () => {
    await new Promise((r) => setTimeout(r, 20))
    const off = await patch(T.tenantId, false, 'Trial finished, going live')
    expect(off.statusCode, off.body).toBe(200)
    expect(off.json()).toMatchObject({ isTest: false, fiscalReportingRequired: true })
    const since = reportingRequiredSinceOf(await settingsOf(T.tenantId))
    expect(since).not.toBeNull()
    expect(await isTestTenant(T.tenantId)).toBe(false)

    const s = await recoverIncompleteCompletions({ tenantIds: [T.tenantId], graceMs: 0 })
    expect(s.saleEnqueued).toBe(0)
    expect(await docs(testSale)).toHaveLength(0)
    // The unclaimed one is completed by the sweep (its books), but files nothing.
    expect(await docs(testSaleUnclaimed)).toHaveLength(0)
    await recoverIncompleteCompletions({ tenantIds: [T.tenantId], graceMs: 0 })
    expect(await prisma.fiscalDocument.count({ where: { orderId: { in: [testSale, testSaleUnclaimed] } } })).toBe(0)
  })

  it('a refund of a test sale after test mode is off files nothing either', async () => {
    const r = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, {
      orderId: testSale, tenantId: T.tenantId, refundPaymentId: null, amountCents: 63_250, reason: 'void',
    }))
    expect(r).toBeNull()
    expect(await docs(testSale)).toHaveLength(0)
  })

  it('a sale completed AFTER turning test off files normally (held: no fiscal POS yet)', async () => {
    const real = await sold(T)
    const d = await docs(real)
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'sale', status: 'held' })
  })

  it('release-held never releases a sale document created after the stamp for an order completed before it', async () => {
    // A stray document (as an older build's sweep would have made) for the test sale.
    const since = reportingRequiredSinceOf(await settingsOf(T.tenantId))!
    await prisma.fiscalDocument.create({
      data: {
        id: `fdstray${Date.now()}`, tenantId: T.tenantId, kind: 'sale', orderId: testSale, conceptId: T.conceptId,
        idempotencyKey: `sale:${testSale}`, status: 'held', statusReason: 'no_connector', payload: {}, payloadHash: 'x', amountCents: 63_250,
        createdAt: new Date(since.getTime() + 1_000),
      },
    })
    await setConnector(T.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' } } })
    resetConnectorCache()
    const { releaseHeld } = await import('../src/connectors/fiscal/outbox.js')
    await releaseHeld(T.tenantId)
    const stray = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: testSale } })
    expect(stray.status).toBe('held')
    await prisma.fiscalDocument.delete({ where: { id: stray.id } })
    await setConnector(T.tenantId, 'fiscal', { driver: 'none', enabled: false })
    resetConnectorCache()
  })

  it('a company that never was a test company: no stamp, files and recovers exactly as before', async () => {
    expect(reportingRequiredSinceOf(await settingsOf(R.tenantId))).toBeNull()
    const old = await sold(R, new Date(Date.now() - 30 * 60_000))
    expect(await docs(old)).toHaveLength(1)
    // Its sale document lost (as if the enqueue had failed): the sweep queues it again.
    await prisma.fiscalDocument.deleteMany({ where: { orderId: old } })
    const s = await recoverIncompleteCompletions({ tenantIds: [R.tenantId], graceMs: 0 })
    expect(s.saleEnqueued).toBeGreaterThanOrEqual(1)
    expect(await docs(old)).toHaveLength(1)
  })

  it('saleFileable: the one rule', () => {
    const since = '2026-10-14T10:00:00.000Z'
    const before = new Date('2026-10-14T09:59:59Z')
    const after = new Date('2026-10-14T10:00:01Z')
    expect(saleFileable({}, { hasRow: false, isTest: false, completedAt: before })).toBe(true)
    expect(saleFileable({}, { hasRow: false, isTest: true, completedAt: after })).toBe(false)
    expect(saleFileable({ fiscalReportingRequired: true }, { hasRow: true, isTest: false, completedAt: before })).toBe(true)
    expect(saleFileable({ fiscalReportingRequired: false }, { hasRow: true, isTest: false, completedAt: after })).toBe(false)
    expect(saleFileable({ fiscalReportingRequired: true, reportingRequiredSince: since }, { hasRow: true, isTest: false, completedAt: before })).toBe(false)
    expect(saleFileable({ fiscalReportingRequired: true, reportingRequiredSince: since }, { hasRow: true, isTest: false, completedAt: after })).toBe(true)
    expect(saleFileable({ fiscalReportingRequired: true, reportingRequiredSince: since }, { hasRow: true, isTest: false, completedAt: null })).toBe(true)
  })
})

describe('fr-3: the flag and the switch move together', () => {
  it('test mode ON writes isTest and reporting OFF; the stamp is dropped', async () => {
    const on = await patch(T.tenantId, true, 'Back to practice for a week')
    expect(on.statusCode, on.body).toBe(200)
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: T.tenantId } })).isTest).toBe(true)
    expect(await fiscalReportingRequired(T.tenantId, prisma)).toBe(false)
    expect(reportingRequiredSinceOf(await settingsOf(T.tenantId))).toBeNull()
  })

  it('PUT reporting-required re-reads isTest under the lock (a stale early read cannot switch it on)', async () => {
    // The flag flips under the route's feet: simulate by making the switch's
    // underLock see the company as test while nothing else does.
    await expect(setFiscalReportingRequired(T.tenantId, true, { userId: ceo.id, reason: 'race' }, {
      underLock: async (tx) => {
        const t = await tx.tenant.findUniqueOrThrow({ where: { id: T.tenantId }, select: { isTest: true } })
        if (t.isTest) throw new Error('TEST_COMPANY_NO_FISCAL')
      },
    })).rejects.toThrow('TEST_COMPANY_NO_FISCAL')
    expect(await fiscalReportingRequired(T.tenantId, prisma)).toBe(false)
    const put = await app.inject({
      method: 'PUT', url: '/connectors/fiscal/reporting-required', payload: { required: true, reason: 'Try to file' },
      headers: { authorization: `Bearer ${ceo.token}`, 'x-servd-active-tenant': T.tenantId },
    })
    expect(put.statusCode).toBe(409)
    expect(put.json().error.code).toBe('TEST_COMPANY_NO_FISCAL')
    expect(await fiscalReportingRequired(T.tenantId, prisma)).toBe(false)
  })

  it('a test company made real with its switch already on still gets a fresh stamp', async () => {
    // Out of step on purpose: test company, switch on.
    await setConnector(T.tenantId, 'fiscal', { settings: { fiscalReportingRequired: true } })
    const before = reportingRequiredSinceOf(await settingsOf(T.tenantId))
    const off = await patch(T.tenantId, false, 'Real again, for good this time')
    expect(off.statusCode, off.body).toBe(200)
    const after = reportingRequiredSinceOf(await settingsOf(T.tenantId))
    expect(after).not.toBeNull()
    if (before) expect(after!.getTime()).toBeGreaterThanOrEqual(before.getTime())
    invalidateTestTenants()
  })
})

describe('fr-4: test-company orders never touch shared customer records', () => {
  let testCo: Company
  beforeAll(async () => {
    testCo = await mkCompany('tcf-practice', { srbPosId: 7303 })
    await prisma.tenant.update({ where: { id: testCo.tenantId }, data: { isTest: true } })
    invalidateTestTenants()
  })

  it('rollups (firstOrderAt, lastOrderAt, totalSpentCents) count only real companies\' orders', async () => {
    const c = await prisma.customer.create({ data: { name: 'Shared Customer', phone: '+923001112233' } })
    const tOrder = await mkOrder(testCo, KHEER(testCo))
    await prisma.order.update({ where: { id: tOrder }, data: { customerId: c.id, completedAt: new Date('2026-10-01T10:00:00Z'), totalCents: 99_000 } })
    await recomputeCustomerRollups(c.id)
    let row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
    expect(row.firstOrderAt).toBeNull()
    expect(Number(row.totalSpentCents)).toBe(0)

    const rOrder = await mkOrder(R, KHEER(R))
    await prisma.order.update({ where: { id: rOrder }, data: { customerId: c.id, completedAt: new Date('2026-10-05T10:00:00Z') } })
    await recomputeCustomerRollups(c.id)
    row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })
    expect(row.firstOrderAt?.toISOString()).toBe('2026-10-05T10:00:00.000Z')
    expect(row.lastOrderAt?.toISOString()).toBe('2026-10-05T10:00:00.000Z')
    expect(Number(row.totalSpentCents)).toBe(63_250)
  })

  it('a referral is never paid off (nor stamped) by a test company\'s order', async () => {
    const referrer = await prisma.customer.create({ data: { name: 'Referrer', phone: '+923002223344' } })
    const referee = await prisma.customer.create({
      data: { name: 'Referee', phone: '+923003334455', phoneVerifiedAt: new Date(), referredById: referrer.id, firstOrderAt: new Date() },
    })
    const tOrder = await mkOrder(testCo, KHEER(testCo))
    await prisma.order.update({ where: { id: tOrder }, data: { customerId: referee.id, completedAt: new Date() } })
    await runReferralRewardTrigger()
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: referee.id } })
    expect(after.referralRewardCreditedAt).toBeNull()
    expect(await prisma.loyaltyTransaction.count({ where: { loyaltyAccount: { customerId: { in: [referee.id, referrer.id] } } } })).toBe(0)
  })
})
