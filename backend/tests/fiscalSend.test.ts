// W1 — sending fiscal documents (spec §6.3–§6.6, D3, D5, D10): one lease,
// classified outcomes, lookup-before-resubmit, backoff, alerts, sweeper.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma, mkCompany, mkOrder, setConnector, resetConnectorCache, type Company } from './connectorsFixtures.js'
import {
  enqueueFiscalSaleTx, enqueueFiscalRefundTx, sendOnce, sendFiscalDocument, submitFiscalNow, setFiscalKicker,
  sweepFiscal, retryDocument, recordManualFiling, kickFiscal,
} from '../src/connectors/fiscal/outbox.js'
import { setConnectorClock, clearConnectorCache } from '../src/connectors/registry.js'
import { testDriverCalls, resetTestDriverCalls } from '../src/connectors/drivers/test.js'
import { resetAlertMemory } from '../src/connectors/alerts.js'
import { backoffBaseMs } from '../src/connectors/util.js'

let co: Company
let clock = Date.now()
const now = () => new Date(clock)
const advance = (ms: number) => { clock += ms }
let kicked: string[] = []

const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
async function newSale(): Promise<{ orderId: string; docId: string }> {
  const orderId = await mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
  const r = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))
  return { orderId, docId: r!.id }
}
const scenario = (s: string) => setConnector(co.tenantId, 'fiscal', { settings: { test: { scenario: s } } })
const doc = (id: string) => prisma.fiscalDocument.findUniqueOrThrow({ where: { id } })
const flags = (entityId: string, kind: string) => prisma.exceptionFlag.count({ where: { entityId, kind } })

beforeAll(async () => {
  co = await mkCompany('send-a', { srbPosId: 777 })
  await setConnector(co.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
  setConnectorClock(now)
}, 60_000)

beforeEach(async () => {
  clock = Date.now() + 1000
  kicked = []
  setFiscalKicker(async (id) => { kicked.push(id) })
  resetTestDriverCalls()
  resetAlertMemory()
  clearConnectorCache()
  await scenario('ok')
})

afterAll(() => {
  setFiscalKicker(null)
  setConnectorClock(null)
  resetConnectorCache()
})

describe('send', () => {
  it('ok → filed with the number, QR, verify URL; TEST flagged; attempt logged; socket-free', async () => {
    const { docId } = await newSale()
    const v = await sendFiscalDocument(docId, 'worker', 3000)
    expect(v).toMatchObject({ status: 'test', rawStatus: 'filed', authority: 'srb', isTest: true })
    const d = await doc(docId)
    expect(d.fiscalNumber).toMatch(/^TEST-SRB-[0-9A-F]{10}$/)
    expect(d.qrPayload).toBe(`https://fiscal.test.servd.pk/verify/${d.fiscalNumber}`)
    expect(d).toMatchObject({ status: 'filed', isTest: true, attempts: 1, leaseOwner: null, driver: 'test' })
    expect(await prisma.fiscalAttempt.count({ where: { documentId: docId, op: 'submit', outcome: 'filed' } })).toBe(1)
    expect((await prisma.posConnector.findFirstOrThrow({ where: { tenantId: co.tenantId, kind: 'fiscal' } })).lastOkAt).not.toBeNull()
  })

  it('transient → pending on the backoff schedule (5 s, then 15 s, ±20 %)', async () => {
    await scenario('down')
    const { docId } = await newSale()
    expect(await sendOnce(docId, 'worker', 3000)).toBe('pending')
    let d = await doc(docId)
    let delay = d.nextAttemptAt.getTime() - clock
    expect(delay).toBeGreaterThanOrEqual(backoffBaseMs(1) * 0.8 - 5)
    expect(delay).toBeLessThanOrEqual(backoffBaseMs(1) * 1.2 + 5)
    expect(d.lastErrorCode).toBe('TEST_DOWN')
    // Not due yet → nothing happens.
    expect(await sendOnce(docId, 'worker', 3000)).toBe('busy')
    advance(7000)
    expect(await sendOnce(docId, 'worker', 3000)).toBe('pending')
    d = await doc(docId)
    delay = d.nextAttemptAt.getTime() - clock
    expect(delay).toBeGreaterThanOrEqual(15_000 * 0.8 - 5)
    expect(delay).toBeLessThanOrEqual(15_000 * 1.2 + 5)
    expect(d.attempts).toBe(2)
  })

  it('slow vendor at the till: the sync budget gives unknown; the worker looks up and gets the SAME number with ONE submit', async () => {
    await scenario('slow')
    const { docId } = await newSale()
    const t0 = Date.now()
    const v = await submitFiscalNow(docId, { budgetMs: 600, via: 'sync_till' })
    expect(Date.now() - t0).toBeLessThan(600 + 1500)
    expect(v).toMatchObject({ status: 'test', rawStatus: 'pending' })
    expect((await doc(docId)).lastErrorCode).toMatch(/^UNKNOWN_/)
    advance(60_000)
    expect(await sendOnce(docId, 'worker', 15_000)).toBe('filed')
    expect(testDriverCalls.submitSale).toBe(1)
    expect(testDriverCalls.getDocumentStatus).toBe(1)
    expect((await doc(docId)).fiscalNumber).toMatch(/^TEST-SRB-/)
  })

  it('unknown_then_filed: submit once, then the lookup files it', async () => {
    await scenario('unknown_then_filed')
    const { docId } = await newSale()
    expect(await sendOnce(docId, 'worker', 3000)).toBe('pending')
    advance(60_000)
    expect(await sendOnce(docId, 'worker', 3000)).toBe('filed')
    expect(testDriverCalls.submitSale).toBe(1)
  })

  it('processing_then_ok: providerRef kept, the next attempt looks it up', async () => {
    await scenario('processing_then_ok')
    const { docId } = await newSale()
    expect(await sendOnce(docId, 'worker', 3000)).toBe('pending')
    const d = await doc(docId)
    expect(d).toMatchObject({ lastErrorCode: 'PROCESSING', providerRef: `P-${docId}` })
    expect(d.nextAttemptAt.getTime() - clock).toBeGreaterThanOrEqual(29_000)
    advance(31_000)
    expect(await sendOnce(docId, 'worker', 3000)).toBe('filed')
    expect(testDriverCalls.submitSale).toBe(1)
  })

  it('reject → rejected + ONE fiscal_rejected flag, even when sent again', async () => {
    await scenario('reject')
    const { docId } = await newSale()
    expect(await sendOnce(docId, 'worker', 3000)).toBe('rejected')
    expect(await sendOnce(docId, 'worker', 3000)).toBe('busy')
    expect((await doc(docId)).lastErrorCode).toBe('TEST_REJECT')
    expect(await flags(docId, 'fiscal_rejected')).toBe(1)
  })

  it('auth → stays pending (≥ 5 min backoff), connector lastError set, fiscal_auth flagged once per hour', async () => {
    await scenario('auth')
    const a = await newSale()
    const b = await newSale()
    expect(await sendOnce(a.docId, 'worker', 3000)).toBe('pending')
    expect(await sendOnce(b.docId, 'worker', 3000)).toBe('pending')
    const d = await doc(a.docId)
    expect(d.status).toBe('pending')
    expect(d.nextAttemptAt.getTime() - clock).toBeGreaterThanOrEqual(5 * 60_000)
    expect((await prisma.posConnector.findFirstOrThrow({ where: { tenantId: co.tenantId, kind: 'fiscal' } })).lastError).toMatch(/^AUTH/)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: co.tenantId, kind: 'fiscal_auth' } })).toBe(1)
  })

  it('past maxAgeHours → failed + fiscal_failed', async () => {
    await scenario('down')
    const { docId } = await newSale()
    expect(await sendOnce(docId, 'worker', 3000)).toBe('pending')
    advance(73 * 3_600_000)
    expect(await sendOnce(docId, 'worker', 3000)).toBe('failed')
    expect((await doc(docId)).status).toBe('failed')
    expect(await flags(docId, 'fiscal_failed')).toBe(1)
  })

  it('switched off: the sender puts the document back to held and sends nothing', async () => {
    const { docId } = await newSale()
    await setConnector(co.tenantId, 'fiscal', { enabled: false })
    expect(await sendOnce(docId, 'worker', 3000)).toBe('held')
    expect(await doc(docId)).toMatchObject({ status: 'held', statusReason: 'no_connector', attempts: 0 })
    expect(testDriverCalls.submitSale).toBe(0)
    await setConnector(co.tenantId, 'fiscal', { enabled: true })
  })

  it('two racing senders → one driver call', async () => {
    const { docId } = await newSale()
    const r = await Promise.all([sendOnce(docId, 'worker', 3000), sendOnce(docId, 'sweeper', 3000), sendOnce(docId, 'sync_till', 3000)])
    expect(r.filter((x) => x === 'filed')).toHaveLength(1)
    expect(testDriverCalls.submitSale).toBe(1)
  })
})

describe('sweeper', () => {
  it('an expired lease → pending UNKNOWN_LEASE_EXPIRED → the next attempt looks up first (no second submit)', async () => {
    const { docId } = await newSale()
    await prisma.fiscalDocument.update({ where: { id: docId }, data: { status: 'submitting', leaseUntil: new Date(clock - 1000), leaseOwner: 'dead-host:1:x', attempts: 1 } })
    const s = await sweepFiscal()
    expect(s.leasesFreed).toBeGreaterThanOrEqual(1)
    expect(kicked).toContain(docId)
    expect((await doc(docId)).lastErrorCode).toBe('UNKNOWN_LEASE_EXPIRED')
    expect(await sendOnce(docId, 'worker', 3000)).toBe('filed')
    expect(testDriverCalls.getDocumentStatus).toBe(1)
    expect(testDriverCalls.submitSale).toBe(0)
  })

  it('queue add throws (Redis down) → the sweeper sends inline', async () => {
    setFiscalKicker(async () => { throw new Error('ECONNREFUSED') })
    const { docId } = await newSale()
    expect(await kickFiscal(docId)).toBe(false)
    const s = await sweepFiscal()
    expect(s.sentInline).toBeGreaterThanOrEqual(1)
    expect((await doc(docId)).status).toBe('filed')
  })
})

describe('operator actions (no skip — §17.0)', () => {
  it('retry: a rejected document goes back to pending and is kicked', async () => {
    await scenario('reject')
    const { docId } = await newSale()
    await sendOnce(docId, 'worker', 3000)
    await scenario('ok')
    clearConnectorCache()
    const d = await retryDocument(docId, { tenantId: co.tenantId })
    expect(d.status).toBe('pending')
    expect(kicked).toContain(docId)
    expect(await sendOnce(docId, 'manual_retry', 3000)).toBe('filed')
    await expect(retryDocument(docId, { tenantId: co.tenantId })).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
  })

  it('W1-R8: retry after the 60-attempt cap gives a full new run — counted from the retry, in the sender and the sweeper', async () => {
    await scenario('down')
    const { docId } = await newSale()
    await prisma.fiscalDocument.update({ where: { id: docId }, data: { status: 'failed', attempts: 60, lastErrorCode: 'TEST_DOWN' } })
    const d = await retryDocument(docId, { tenantId: co.tenantId })
    expect(d).toMatchObject({ status: 'pending', attempts: 60 })
    // A transient failure on the first attempt after the retry keeps it pending…
    expect(await sendOnce(docId, 'manual_retry', 3000)).toBe('pending')
    expect(await doc(docId)).toMatchObject({ status: 'pending', attempts: 61 })
    // …and the sweeper's age/attempt step does not fail it either.
    await prisma.fiscalDocument.update({ where: { id: docId }, data: { createdAt: new Date(clock - 2 * 3_600_000) } })
    await sweepFiscal()
    expect((await doc(docId)).status).toBe('pending')
    // 60 attempts after the retry, it fails again.
    await prisma.fiscalDocument.update({ where: { id: docId }, data: { attempts: 119, nextAttemptAt: new Date(clock) } })
    expect(await sendOnce(docId, 'worker', 3000)).toBe('failed')
    expect(await doc(docId)).toMatchObject({ status: 'failed', attempts: 120 })
  })

  it('a foreign company cannot retry or record a filing (404)', async () => {
    const { docId } = await newSale()
    await expect(retryDocument(docId, { tenantId: 'someone-else' })).rejects.toMatchObject({ statusCode: 404 })
    await expect(recordManualFiling(docId, { tenantId: { in: [] } }, { fiscalNumber: 'X', authority: 'srb', actorId: 'u' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('manual filing of the sale promotes its waiting refund with the manual number', async () => {
    await scenario('reject')
    const { orderId, docId } = await newSale()
    await sendOnce(docId, 'worker', 3000)
    const pay = await prisma.payment.create({ data: { orderId, method: 'cash', amountCents: -26_500, status: 'refunded', processedAt: new Date() } })
    const r = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId, tenantId: co.tenantId, refundPaymentId: pay.id, amountCents: 26_500 }))
    expect(r!.status).toBe('waiting')
    const filed = await recordManualFiling(docId, { tenantId: co.tenantId }, { fiscalNumber: 'SRB-PORTAL-1', authority: 'srb', actorId: 'mgr' })
    expect(filed).toMatchObject({ status: 'manual_filed', driver: 'manual', fiscalNumber: 'SRB-PORTAL-1' })
    const refund = await doc(r!.id)
    expect(refund.status).toBe('pending')
    expect(refund.payload).toMatchObject({ original: { fiscalNumber: 'SRB-PORTAL-1' } })
  })
})
