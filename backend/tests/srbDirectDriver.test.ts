// SRB direct (owner, 2026-10-30): servd files sales tax invoices with SRB itself
// through the connector framework (drivers/srb.ts, registry FISCAL_DRIVERS
// 'srb', the ONE outbox). Bills closed in servd are filed automatically under
// this driver; under a fiscal POS driver (test / http) they stay hand-filed.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma, mkCompany, mkOrder, setConnector, resetConnectorCache, type Company } from './connectorsFixtures.js'
import { enqueueFiscalSaleTx, enqueueFiscalRefundTx, sendOnce, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { clearConnectorCache, fiscalDriverOf, isDirectFiscalDriver } from '../src/connectors/registry.js'
import { setSrbTransport, srbFiscalDriver, SRB_BASE_URL, SRB_INVOICE_PATH, type SrbTransport } from '../src/connectors/drivers/srb.js'
import { encryptSecret, secretHint } from '../src/lib/secretBox.js'
import { servdUnfiledCount } from '../src/modules/accounting/servdFilings.js'
import { resetAlertMemory } from '../src/connectors/alerts.js'
import type { ConnectorCtx, FiscalPayload } from '../src/connectors/types.js'
import { parseFiscalSettings } from '../src/connectors/config.js'
import { keenuPushAvailable } from '../src/modules/pos/keenuPush.js'
import { goLiveMissing } from '../src/modules/connectors/routes.js'
import { applyConnectorConfig, prepareConnectorConfig } from '../src/modules/connectors/applyConfig.js'

const PASS_A = 'Sup3r-Secret-PassA'
const PASS_B = 'Other-Secret-PassB'

let A: Company // SRB direct
let B: Company // SRB direct, other credentials
let T: Company // test driver (a fiscal POS)
let H: Company // http driver (a fiscal POS)

type Call = { tenantId: string; body: Record<string, unknown>; key: string }
let calls: Call[] = []
let answer: Awaited<ReturnType<SrbTransport>> = { kind: 'answer', answer: { status: 200, body: { resCode: '00', srbInvoiceId: 'SRB-INV-1', QRCodeLink: 'https://pos.srb.gos.pk/verify/SRB-INV-1' } } }
const transport: SrbTransport = async (ctx, body, key) => {
  calls.push({ tenantId: ctx.tenantId, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, key })
  return answer
}

async function setSrbCreds(co: Company, posUser: string, pass: string, live = false): Promise<void> {
  await setConnector(co.tenantId, 'fiscal', { driver: 'srb', enabled: true, liveSince: new Date('2026-01-01'), settings: { srb: { posUser, live } } })
  await prisma.posConnector.update({
    where: { tenantId_kind: { tenantId: co.tenantId, kind: 'fiscal' } },
    data: { apiKeyEnc: encryptSecret(pass), apiKeyHint: secretHint(pass) },
  })
  clearConnectorCache()
}

const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
async function servdSale(co: Company, channel: 'servd' | null = 'servd'): Promise<{ orderId: string; docId: string; status: string; reason: string | null }> {
  const orderId = await mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
  if (channel) await prisma.order.update({ where: { id: orderId }, data: { settlementChannel: channel } })
  const r = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))
  return { orderId, docId: r!.id, status: r!.status, reason: r!.statusReason }
}

function ctxOf(settings: Record<string, unknown>, apiKey: string | null): ConnectorCtx {
  return {
    tenantId: 't1', connectorId: 'c1', driver: 'srb', isTest: false, baseUrl: null, apiKey, webhookSecret: null,
    settings: parseFiscalSettings(settings), signal: AbortSignal.timeout(5000), now: () => new Date('2026-10-30T10:00:00Z'), log: () => {},
  }
}

function payload(kind: 'sale' | 'refund' = 'sale', extra: Partial<FiscalPayload> = {}): FiscalPayload {
  return {
    version: 1, documentId: 'doc-0000000000abcdef', kind, orderId: '11111111-2222-3333-4444-555566667777', orderRef: '66667777', source: 'pos',
    issuedAt: '2026-10-30T15:00:00+05:00', currency: 'PKR',
    registrations: [{ authority: 'srb', posId: '777' }],
    seller: { legalName: 'Stackd Foods (Pvt) Ltd', ntn: '1234567-8' },
    buyer: { legalName: 'Ali', phone: '03001234567' },
    lines: [{ lineId: 'l1', itemCode: 'K', description: 'Kheer', quantity: 2, unitPriceCents: 55_000, grossCents: 110_000, discountCents: 0, taxableCents: 110_000, taxRatePct: 15, taxCents: 16_500 }],
    totals: { saleValueCents: 110_000, discountCents: 0, taxableCents: 110_000, taxCents: 16_500, taxRatePct: 15, serviceChargeCents: 0, tipCents: 0, totalCents: 126_500 },
    payment: { mode: 'cash', tenders: [{ method: 'cash', amountCents: 126_500 }] },
    ...(kind === 'refund' && { original: { fiscalNumber: 'SRB-INV-1', authority: 'srb' }, refundAmountCents: 126_500 }),
    ...extra,
  }
}

beforeAll(async () => {
  A = await mkCompany('srb-a', { srbPosId: 777 })
  B = await mkCompany('srb-b', { srbPosId: 888 })
  T = await mkCompany('srb-t', { srbPosId: 999 })
  H = await mkCompany('srb-h', { srbPosId: 555 })
  await setSrbCreds(A, 'user-a', PASS_A)
  await setSrbCreds(B, 'user-b', PASS_B, true)
  await setConnector(T.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date('2026-01-01') })
  await setConnector(H.tenantId, 'fiscal', { driver: 'http', enabled: false })
  setSrbTransport(transport)
  setFiscalKicker(async () => {})
}, 60_000)

beforeEach(() => {
  calls = []
  answer = { kind: 'answer', answer: { status: 200, body: { resCode: '00', srbInvoiceId: 'SRB-INV-1', QRCodeLink: 'https://pos.srb.gos.pk/verify/SRB-INV-1' } } }
  resetAlertMemory()
  clearConnectorCache()
})

afterAll(() => {
  setSrbTransport(null)
  setFiscalKicker(null)
  resetConnectorCache()
})

describe('SRB direct driver', () => {
  it('is registered as a direct filer with the agreed needs and capabilities', () => {
    expect(fiscalDriverOf('srb')).toBe(srbFiscalDriver)
    expect(isDirectFiscalDriver('srb')).toBe(true)
    expect(isDirectFiscalDriver('http')).toBe(false)
    expect(srbFiscalDriver.needs).toEqual({ baseUrl: false, apiKey: true, webhookSecret: false })
    expect(srbFiscalDriver.capabilities(ctxOf({}, null))).toMatchObject({ refunds: true, zeroValue: false, lookup: false, billPush: false })
    expect(srbFiscalDriver.pushBill).toBeUndefined()
    expect(SRB_BASE_URL + SRB_INVOICE_PATH).toBe('https://pos.srb.gos.pk/ePOSGateway/v1/SalesInvoiceService.api')
  })

  it('success → filed with the SRB invoice id and the QR link; flat body with credentials and Test mode', async () => {
    const out = await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())
    expect(out).toEqual({ kind: 'ok', value: { state: 'filed', result: { fiscalNumber: 'SRB-INV-1', authority: 'srb', fiscalAt: '2026-10-30T10:00:00.000Z', qrPayload: 'https://pos.srb.gos.pk/verify/SRB-INV-1', verifyUrl: 'https://pos.srb.gos.pk/verify/SRB-INV-1' } } })
    expect(calls).toHaveLength(1)
    const b = calls[0]!.body
    expect(b).toMatchObject({
      posId: 777, invoiceType: 1, invoiceId: 'SRB-555566667777', rateValue: 15, saleValue: 1100, taxAmount: 165, discountAmount: 0, netAmount: 1265,
      modeOfPay: 'Cash', consumerName: 'Ali', consumerMobile: '03001234567', consumerEmail: 'N/A', address: 'N/A', extraInf: 'N/A', cpcCode: 'N/A',
      transType: 'Test', pos_user: 'u1', pos_pass: PASS_A, invoiceDateTime: '2026-10-30 15:00:00',
    })
    expect(calls[0]!.key).toBe('SRB-555566667777')
  })

  it('Live only when switched on — a dry run is always Test', async () => {
    await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1', live: true } }, PASS_A), payload())
    await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1', live: true } }, PASS_A), payload('sale', { test: true }))
    expect(calls.map((c) => c.body['transType'])).toEqual(['Live', 'Test'])
  })

  it('refund → the same call as a sales return (invoiceType 2, its own invoice id)', async () => {
    const out = await srbFiscalDriver.submitRefund(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload('refund'))
    expect(out.kind).toBe('ok')
    expect(calls[0]!.body).toMatchObject({ invoiceType: 2, invoiceId: 'SRBRET-5566667777-ABCDEF' })
  })

  it('resCode other than 00 → rejected SRB_<code>; the password never appears in the message', async () => {
    answer = { kind: 'answer', answer: { status: 200, body: { resCode: '05', message: `Invalid pos_user or pos_pass ${PASS_A}` } } }
    const out = await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())
    expect(out).toMatchObject({ kind: 'rejected', code: 'SRB_05' })
    expect(JSON.stringify(out)).not.toContain(PASS_A)
  })

  it('503 → transient; 401 → AUTH; 2xx without a result → unknown', async () => {
    answer = { kind: 'answer', answer: { status: 503, body: { message: 'busy' } } }
    expect(await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())).toMatchObject({ kind: 'transient', httpStatus: 503 })
    answer = { kind: 'answer', answer: { status: 401, body: { message: `bad ${PASS_A}` } } }
    const auth = await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())
    expect(auth).toMatchObject({ kind: 'rejected', code: 'AUTH' })
    expect(JSON.stringify(auth)).not.toContain(PASS_A)
    answer = { kind: 'answer', answer: { status: 200, body: { resCode: '00' } } }
    expect(await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())).toMatchObject({ kind: 'unknown', code: 'BAD_RESPONSE' })
  })

  it('timeout after the request was written → unknown, password scrubbed; error before the write → transient', async () => {
    answer = { kind: 'unknown', code: 'TIMEOUT', message: `socket hang up pos_pass=${PASS_A}` }
    const out = await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())
    expect(out).toMatchObject({ kind: 'unknown', code: 'TIMEOUT' })
    expect(JSON.stringify(out)).not.toContain(PASS_A)
    answer = { kind: 'transient', code: 'ECONNREFUSED', message: 'refused' }
    expect(await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload())).toMatchObject({ kind: 'transient', code: 'ECONNREFUSED' })
  })

  it('not configured → transient NOT_CONFIGURED (no call); no SRB registration → rejected NOT_REGISTERED', async () => {
    expect(await srbFiscalDriver.submitSale(ctxOf({}, PASS_A), payload())).toMatchObject({ kind: 'transient', code: 'NOT_CONFIGURED' })
    expect(await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, null), payload())).toMatchObject({ kind: 'transient', code: 'NOT_CONFIGURED' })
    expect(await srbFiscalDriver.health(ctxOf({}, null))).toMatchObject({ kind: 'transient', code: 'NOT_CONFIGURED' })
    expect(await srbFiscalDriver.health(ctxOf({ srb: { posUser: 'u1' } }, PASS_A))).toMatchObject({ kind: 'ok' })
    expect(await srbFiscalDriver.submitSale(ctxOf({ srb: { posUser: 'u1' } }, PASS_A), payload('sale', { registrations: [{ authority: 'fbr', posId: '1' }] })))
      .toMatchObject({ kind: 'rejected', code: 'NOT_REGISTERED' })
    expect(calls).toHaveLength(0)
  })
})

describe('outbox with SRB direct', () => {
  it('a bill closed in servd is filed automatically under SRB; under a fiscal POS driver it stays hand-filed', async () => {
    const a = await servdSale(A)
    expect(a).toMatchObject({ status: 'pending', reason: null })
    expect(await sendOnce(a.docId, 'worker', 3000)).toBe('filed')
    const d = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: a.docId } })
    expect(d).toMatchObject({ status: 'filed', fiscalNumber: 'SRB-INV-1', authority: 'srb', qrPayload: 'https://pos.srb.gos.pk/verify/SRB-INV-1', verifyUrl: 'https://pos.srb.gos.pk/verify/SRB-INV-1', driver: 'srb', isTest: false })
    // Not a hand filing: the servd filings close check does not count it.
    const t = await servdSale(T)
    expect(t).toMatchObject({ status: 'manual_required', reason: 'servd_channel' })
    const h = await servdSale(H)
    expect(h).toMatchObject({ status: 'manual_required', reason: 'servd_channel' })
    const far = new Date('2099-01-01')
    expect(await servdUnfiledCount(T.tenantId, far)).toBeGreaterThanOrEqual(1)
    // Pending ones of an SRB company are automatic, not hand filings.
    const p = await servdSale(A)
    expect(p.status).toBe('pending')
    expect(await servdUnfiledCount(A.tenantId, far)).toBe(0)
  })

  it('a hand-filed row from before the switch stays hand-filed, and so does its return', async () => {
    const orderId = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    await prisma.order.update({ where: { id: orderId }, data: { settlementChannel: 'servd' } })
    // Before the switch (a test-driver company's rule): enqueue as a fiscal POS company would.
    await setConnector(A.tenantId, 'fiscal', { driver: 'test' })
    const sale = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: A.tenantId }))
    expect(sale).toMatchObject({ status: 'manual_required', statusReason: 'servd_channel' })
    await setSrbCreds(A, 'user-a', PASS_A)
    expect(await servdUnfiledCount(A.tenantId, new Date('2099-01-01'))).toBe(1)
    const ret = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId, tenantId: A.tenantId, amountCents: 126_500, refundPaymentId: null, reason: 'test return' }))
    expect(ret).toMatchObject({ status: 'manual_required', statusReason: 'servd_channel' })
    await prisma.fiscalDocument.updateMany({ where: { orderId }, data: { status: 'skipped', statusReason: 'zero_value' } }) // tidy for the count
  })

  it('unknown after the write → pending; the retry resends the SAME invoice id (no lookup, never a second invoice)', async () => {
    const s = await servdSale(A, null)
    answer = { kind: 'unknown', code: 'TIMEOUT', message: 'timed out' }
    expect(await sendOnce(s.docId, 'worker', 3000)).toBe('pending')
    let d = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s.docId } })
    expect(d.lastErrorCode).toBe('UNKNOWN_TIMEOUT')
    await prisma.fiscalDocument.update({ where: { id: s.docId }, data: { nextAttemptAt: new Date(0) } })
    answer = { kind: 'answer', answer: { status: 200, body: { resCode: '00', srbInvoiceId: 'SRB-INV-2' } } }
    expect(await sendOnce(s.docId, 'worker', 3000)).toBe('filed')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.body['invoiceId']).toBe(calls[1]!.body['invoiceId'])
    d = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s.docId } })
    expect(d).toMatchObject({ status: 'filed', fiscalNumber: 'SRB-INV-2' })
    expect(await prisma.fiscalAttempt.count({ where: { documentId: s.docId, op: 'lookup' } })).toBe(0)
  })

  it('two companies: each document is filed with its OWN company credentials and POS id', async () => {
    const a = await servdSale(A)
    const b = await servdSale(B)
    await sendOnce(a.docId, 'worker', 3000)
    await sendOnce(b.docId, 'worker', 3000)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ tenantId: A.tenantId, body: { pos_user: 'user-a', pos_pass: PASS_A, posId: 777, transType: 'Test' } })
    expect(calls[1]).toMatchObject({ tenantId: B.tenantId, body: { pos_user: 'user-b', pos_pass: PASS_B, posId: 888, transType: 'Live' } })
    // Nothing of B's crossed into A's call.
    expect(JSON.stringify(calls[0])).not.toContain(PASS_B)
    expect(JSON.stringify(calls[0])).not.toContain('user-b')
  })

  it('a rejection is stored with the SRB code and the password is never stored', async () => {
    const s = await servdSale(A)
    answer = { kind: 'answer', answer: { status: 200, body: { resCode: '12', message: `duplicate invoice for ${PASS_A}` } } }
    expect(await sendOnce(s.docId, 'worker', 3000)).toBe('rejected')
    const d = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s.docId } })
    expect(d).toMatchObject({ status: 'rejected', lastErrorCode: 'SRB_12' })
    expect(JSON.stringify(d)).not.toContain(PASS_A)
    const attempts = await prisma.fiscalAttempt.findMany({ where: { documentId: s.docId } })
    expect(JSON.stringify(attempts)).not.toContain(PASS_A)
  })
})

describe('till and set-up with SRB direct', () => {
  it('no Push to Keenu under SRB direct; the test fiscal POS still takes one', async () => {
    expect(await keenuPushAvailable(A.tenantId)).toBe(false)
    expect(await keenuPushAvailable(T.tenantId)).toBe(true)
  })

  it('go-live needs the SRB credentials and Live; the POS user / Live switch is locked while live', async () => {
    const rowA = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })
    expect(await goLiveMissing(A.tenantId, rowA)).toContain('Switch SRB to Live (after a passing Test)')
    const rowB = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: B.tenantId, kind: 'fiscal' } } })
    const missingB = await goLiveMissing(B.tenantId, rowB)
    expect(missingB).not.toContain('Switch SRB to Live (after a passing Test)')
    expect(missingB).not.toContain('Enter the SRB POS user and password')
    const body = { settings: { srb: { posUser: 'user-a', live: true } } }
    const prepared = await prepareConnectorConfig(A.tenantId, 'fiscal', body)
    await expect(prisma.$transaction((tx) => applyConnectorConfig(tx, A.tenantId, 'fiscal', body, { userId: 'x' }, prepared)))
      .rejects.toMatchObject({ code: 'SWITCH_OFF_FIRST' })
  })
})

