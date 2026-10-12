// W1 — /health checks for the POS connector (spec §8.4) and Raast QR bank SMS
// (raast spec §6.11): ok / warn / off, never fail.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma, mkCompany, mkOrder, setConnector, resetConnectorCache, mkRaastAccount, TEST_SECRET_KEY, type Company } from './connectorsFixtures.js'
import { connectorHealthChecks } from '../src/connectors/health.js'
import { enqueueFiscalSaleTx } from '../src/connectors/fiscal/outbox.js'
import { encryptSecret } from '../src/lib/secretBox.js'

let A: Company
let prevKey: string | undefined
const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
const never = (c: Record<string, string>) => Object.values(c).every((v) => v === 'ok' || v === 'warn' || v === 'off')

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  delete process.env['SERVD_SECRET_KEY']
  A = await mkCompany('health-a', { srbPosId: 51 })
}, 60_000)

afterAll(() => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  resetConnectorCache()
})

describe('connectorHealthChecks', () => {
  it('nothing configured → off everywhere (never fail)', async () => {
    const h = await connectorHealthChecks()
    expect(h.checks).toEqual({ fiscalConnector: 'off', cardTerminal: 'off', connectorSecretKey: 'off', raastSms: 'off' })
  })

  it('a live company on the TEST driver warns; held / stale / failed / manual-refund backlogs warn', async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true })
    let h = await connectorHealthChecks()
    expect(h.checks.fiscalConnector).toBe('warn')
    expect(h.details['fiscalConnector']).toMatch(/TEST driver/)

    await setConnector(A.tenantId, 'fiscal', { driver: 'http', enabled: true })
    h = await connectorHealthChecks()
    expect(h.checks.fiscalConnector).toBe('ok')

    const orderId = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    const d = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: A.tenantId }))
    for (const [status, re] of [['held', /held/], ['failed', /failed/], ['manual_required', /by hand/]] as const) {
      await prisma.fiscalDocument.update({ where: { id: d!.id }, data: { status } })
      h = await connectorHealthChecks()
      expect(h.checks.fiscalConnector, status).toBe('warn')
      expect(h.details['fiscalConnector']).toMatch(re)
    }
    await prisma.fiscalDocument.update({ where: { id: d!.id }, data: { status: 'pending', createdAt: new Date(Date.now() - 20 * 60_000) } })
    h = await connectorHealthChecks()
    expect(h.checks.fiscalConnector).toBe('warn')
    expect(h.details['fiscalConnector']).toMatch(/15\+ min/)
    await prisma.fiscalDocument.update({ where: { id: d!.id }, data: { status: 'filed' } })
    await prisma.posConnector.updateMany({ where: { tenantId: A.tenantId, kind: 'fiscal' }, data: { lastError: 'AUTH: bad key', lastErrorAt: new Date() } })
    h = await connectorHealthChecks()
    expect(h.checks.fiscalConnector).toBe('warn')
    expect(h.details['fiscalConnector']).toMatch(/API key/)
    expect(never(h.checks)).toBe(true)
  })

  it('card machine: needs_attention or an old unknown warns', async () => {
    await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true })
    expect((await connectorHealthChecks()).checks.cardTerminal).toBe('ok')
    const orderId = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, status: 'received' })
    const conn = await prisma.posConnector.findFirstOrThrow({ where: { tenantId: A.tenantId, kind: 'terminal' } })
    const user = await prisma.user.create({ data: { name: 'h', email: 'h.health@conn.test', password: 'x', role: 'cashier', tenantId: A.tenantId } })
    await prisma.terminalCharge.create({
      data: {
        tenantId: A.tenantId, connectorId: conn.id, terminalId: 'trm-1', orderId, amountCents: 118_800, quoteDueCents: 118_800,
        idempotencyKey: 'health-1', status: 'unknown', expiresAt: new Date(), createdById: user.id, createdAt: new Date(Date.now() - 11 * 60_000),
      },
    })
    const h = await connectorHealthChecks()
    expect(h.checks.cardTerminal).toBe('warn')
    expect(h.details['cardTerminal']).toMatch(/unknown/)
  })

  it('raast SMS: on → ok; an SMS not understood, a bill needing a person or an over-age intent → warn', async () => {
    await setConnector(A.tenantId, 'raast', { enabled: true })
    let h = await connectorHealthChecks()
    expect(h.checks.raastSms).toBe('ok')
    const conn = await prisma.posConnector.findFirstOrThrow({ where: { tenantId: A.tenantId, kind: 'raast' } })
    const user = await prisma.user.create({ data: { name: 'r', email: 'r.health@conn.test', password: 'x', role: 'it', tenantId: A.tenantId } })
    const device = await prisma.bankSmsDevice.create({ data: { tenantId: A.tenantId, connectorId: conn.id, label: 'p', tokenHash: 'h-health', tokenEnc: 'plain', tokenHint: 'x', createdById: user.id } })
    const alert = await prisma.bankSmsAlert.create({ data: { tenantId: A.tenantId, deviceId: device.id, sender: 'BANK', bodyHash: 'hh', body: '?', receivedAt: new Date(), status: 'unparsed' } })
    h = await connectorHealthChecks()
    expect(h.checks.raastSms).toBe('warn')
    expect(h.details['raastSms']).toMatch(/not understood/)
    await prisma.bankSmsAlert.update({ where: { id: alert.id }, data: { status: 'dismissed' } })

    const { bankAccountId } = await mkRaastAccount(A)
    const orderId = await mkOrder(A, { items: KHEER(A), taxCents: 8_800, taxRatePct: 8, totalCents: 118_800, status: 'received' })
    const base = { tenantId: A.tenantId, orderId, conceptId: A.conceptId, bankAccountId, ledgerCode: '1021', amountCents: 118_800, dueCents: 118_800, createdById: user.id }
    await prisma.raastReceipt.create({ data: { ...base, status: 'awaiting', idempotencyKey: 'h-1', expiresAt: new Date(), createdAt: new Date(Date.now() - 2 * 60 * 60_000) } })
    h = await connectorHealthChecks()
    expect(h.checks.raastSms).toBe('warn')
    expect(h.details['raastSms']).toMatch(/twice their time limit/)
    await prisma.raastReceipt.updateMany({ where: { tenantId: A.tenantId }, data: { status: 'needs_attention' } })
    h = await connectorHealthChecks()
    expect(h.details['raastSms']).toMatch(/need a person/)
    expect(never(h.checks)).toBe(true)
    await prisma.raastReceipt.updateMany({ where: { tenantId: A.tenantId }, data: { status: 'cancelled' } })
  })

  it('secret key: encrypted values stored but the key missing → warn; key set → ok', async () => {
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    const enc = encryptSecret('some-api-key')
    delete process.env['SERVD_SECRET_KEY']
    await prisma.posConnector.updateMany({ where: { tenantId: A.tenantId, kind: 'fiscal' }, data: { apiKeyEnc: enc } })
    let h = await connectorHealthChecks()
    expect(h.checks.connectorSecretKey).toBe('warn')
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    h = await connectorHealthChecks()
    expect(h.checks.connectorSecretKey).toBe('ok')
    expect(never(h.checks)).toBe(true)
  })
})
