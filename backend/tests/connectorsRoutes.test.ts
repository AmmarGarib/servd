// W1 — /connectors routes (spec §8.1, §17.0, §17.7): two companies, roles,
// secrets never leave the server, SSRF guard, go-live / release / switch.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, mkOrder, buildApp, caller, setConnector, resetConnectorCache, containsDeep, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { enqueueFiscalSaleTx, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { LEGACY_DRAIN_KEY } from '../src/connectors/legacyDrain.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
const u: Record<string, Who> = {}
const SECRET = 'sk_live_9f8e7d6c5b4a39281706'
let docA: string
let prevKey: string | undefined

const KHEER = (c: Company) => [{ menuItemId: c.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
async function saleDoc(co: Company): Promise<string> {
  const orderId = await mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
  return (await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId })))!.id
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  A = await mkCompany('routes-a', { srbPosId: 101 })
  B = await mkCompany('routes-b', { srbPosId: 202 })
  u['adminA'] = await mkUser('adminA', 'admin', A.tenantId)
  u['itA'] = await mkUser('itA', 'it', A.tenantId)
  u['mgmtA'] = await mkUser('mgmtA', 'management', A.tenantId)
  u['cashierA'] = await mkUser('cashierA', 'cashier', A.tenantId)
  u['adminB'] = await mkUser('adminB', 'admin', B.tenantId)
  u['itB'] = await mkUser('itB', 'it', B.tenantId)
  u['nobody'] = await mkUser('nobody', 'it', null)
  app = await buildApp()
  call = caller(app)
  docA = await saleDoc(A) // held / no_connector
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('roles', () => {
  it('cashier gets 403 everywhere under /connectors', async () => {
    for (const [m, url] of [['GET', '/connectors'], ['GET', '/connectors/drivers'], ['GET', '/connectors/fiscal/documents'], ['PUT', '/connectors/fiscal']] as const) {
      expect((await call(u['cashierA']!, m, url, m === 'PUT' ? {} : undefined)).statusCode, url).toBe(403)
    }
  })

  it('it and admin get 200; management reads but cannot configure', async () => {
    expect((await call(u['itA']!, 'GET', '/connectors')).statusCode).toBe(200)
    expect((await call(u['adminA']!, 'GET', '/connectors')).statusCode).toBe(200)
    expect((await call(u['mgmtA']!, 'GET', '/connectors')).statusCode).toBe(200)
    expect((await call(u['mgmtA']!, 'GET', '/connectors/fiscal/documents')).statusCode).toBe(200)
    expect((await call(u['mgmtA']!, 'PUT', '/connectors/fiscal', { driver: 'test' })).statusCode).toBe(403)
    expect((await call(u['mgmtA']!, 'GET', '/connectors/drivers')).statusCode).toBe(403)
  })

  it('go-live, switch-off, release and the reporting switch are the CEO\'s only', async () => {
    expect((await call(u['itA']!, 'POST', '/connectors/fiscal/go-live', { confirm: 'GO LIVE' })).statusCode).toBe(403)
    expect((await call(u['itA']!, 'POST', '/connectors/fiscal/switch-off', { confirm: 'SWITCH OFF' })).statusCode).toBe(403)
    expect((await call(u['itA']!, 'POST', '/connectors/fiscal/documents/release', {})).statusCode).toBe(403)
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'test kitchen' })).statusCode).toBe(403)
  })
})

describe('company separation', () => {
  it('PUT binds the ACTIVE company; GET shows only it', async () => {
    const r = await call(u['itA']!, 'PUT', '/connectors/fiscal', { driver: 'test' })
    expect(r.statusCode, r.body).toBe(200)
    const row = await prisma.posConnector.findFirstOrThrow({ where: { id: r.json().id } })
    expect(row.tenantId).toBe(A.tenantId)
    const b = await call(u['itB']!, 'GET', '/connectors')
    expect(b.json().fiscal.driver).toBe('none')
    expect(b.json().fiscal.id).not.toBe(row.id)
    expect(b.json().brandPosIds.map((x: { conceptId: string }) => x.conceptId)).toEqual([B.conceptId])
  })

  it('B gets 404 on A\'s documents (read, retry, manual) and on A\'s brand POS ids; there is no skip route', async () => {
    expect((await call(u['adminB']!, 'GET', `/connectors/fiscal/documents/${docA}`)).statusCode).toBe(404)
    expect((await call(u['adminB']!, 'POST', `/connectors/fiscal/documents/${docA}/retry`)).statusCode).toBe(404)
    expect((await call(u['adminB']!, 'POST', `/connectors/fiscal/documents/${docA}/manual`, { fiscalNumber: 'X1', authority: 'srb' })).statusCode).toBe(404)
    expect((await call(u['adminA']!, 'POST', `/connectors/fiscal/documents/${docA}/skip`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call(u['adminB']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: 5, srbPosId: 6 }] })).statusCode).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).srbPosId).toBe(101)
    const list = await call(u['adminB']!, 'GET', '/connectors/fiscal/documents')
    expect(list.json().items.map((d: { id: string }) => d.id)).not.toContain(docA)
    expect((await call(u['adminB']!, 'GET', '/connectors/terminal/charges')).json().items).toEqual([])
  })

  it('a settings entry naming another company\'s outlet or brand → 422 NOT_IN_COMPANY', async () => {
    const loc = await call(u['itA']!, 'PUT', '/connectors/fiscal', { settings: { outlets: [{ locationId: B.locationId, conceptId: null, authority: 'srb', posId: 'X' }] } })
    expect(loc.statusCode).toBe(422)
    expect(loc.json().error.code).toBe('NOT_IN_COMPANY')
    const brand = await call(u['itA']!, 'PUT', '/connectors/fiscal', { settings: { outlets: [{ locationId: A.locationId, conceptId: B.conceptId, authority: 'srb', posId: 'X' }] } })
    expect(brand.statusCode).toBe(422)
    const term = await call(u['itA']!, 'PUT', '/connectors/terminal', { settings: { terminals: [{ label: 'Till 1', locationId: B.locationId, terminalId: 'DEV1', active: true }] } })
    expect(term.statusCode).toBe(422)
    const ok = await call(u['itA']!, 'PUT', '/connectors/terminal', { settings: { terminals: [{ label: 'Till 1', locationId: A.locationId, terminalId: 'DEV1', active: true }] } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().settings.terminals[0].id).toMatch(/^trm_/)
  })

  it('brand POS ids are written to the existing Concept columns, audited', async () => {
    const r = await call(u['itA']!, 'PUT', '/connectors/fiscal/brand-pos-ids', { items: [{ conceptId: A.conceptId, fbrPosId: 555, srbPosId: 101 }] })
    expect(r.statusCode, r.body).toBe(200)
    expect(await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { fbrPosId: true, srbPosId: true } })).toEqual({ fbrPosId: 555, srbPosId: 101 })
    expect(await prisma.auditLog.count({ where: { action: 'concept.pos_ids.update', entityId: A.conceptId } })).toBe(1)
  })

  it('an operator with no company sees nothing (empty scope denies)', async () => {
    // The lists are the ACTIVE company's (one connector, one company): no company → 422.
    const r = await call(u['nobody']!, 'GET', '/connectors/fiscal/documents')
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NO_ACTIVE_COMPANY')
    expect((await call(u['nobody']!, 'GET', '/connectors')).statusCode).toBe(422)
  })
})

describe('secrets', () => {
  it('are stored encrypted, shown only as a hint, never in any response or audit row', async () => {
    const put = await call(u['itA']!, 'PUT', '/connectors/fiscal', { apiKey: SECRET, regenerateWebhookSecret: true })
    expect(put.statusCode, put.body).toBe(200)
    const generated = put.json().newWebhookSecret as string
    expect(generated).toMatch(/^[0-9a-f]{64}$/)
    expect(put.json().apiKeyHint).toBe('sk_l…1706')
    expect(containsDeep(put.json(), SECRET)).toBe(false)
    const row = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })
    expect(row.apiKeyEnc).toMatch(/^enc:v1:/)
    expect(row.webhookSecretEnc).toMatch(/^enc:v1:/)
    for (const [m, url] of [['GET', '/connectors'], ['GET', '/connectors/fiscal/documents'], ['GET', `/connectors/fiscal/documents/${docA}`]] as const) {
      const r = await call(u['adminA']!, m, url)
      expect(containsDeep(r.json(), SECRET), url).toBe(false)
      expect(containsDeep(r.json(), generated), url).toBe(false)
      expect(containsDeep(r.json(), 'enc:v1:'), url).toBe(false)
    }
    const again = await call(u['itA']!, 'PUT', '/connectors/fiscal', { settings: { syncTimeoutMs: 2500 } })
    expect(again.json().newWebhookSecret).toBeUndefined()
    const audits = await prisma.auditLog.findMany({ where: { action: 'connectors.update', tenantId: A.tenantId } })
    expect(audits.length).toBeGreaterThan(0)
    for (const a of audits) {
      expect(containsDeep(a, SECRET)).toBe(false)
      expect(containsDeep(a, generated)).toBe(false)
    }
    expect(audits.some((a) => containsDeep(a.metadata, '"apiKey"'))).toBe(true)
  })

  it('503 SECRET_KEY_MISSING when a secret is supplied but SERVD_SECRET_KEY is unset', async () => {
    delete process.env['SERVD_SECRET_KEY']
    try {
      const r = await call(u['itA']!, 'PUT', '/connectors/terminal', { apiKey: 'another-secret-value' })
      expect(r.statusCode).toBe(503)
      expect(r.json().error.code).toBe('SECRET_KEY_MISSING')
    } finally {
      process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    }
  })
})

describe('SSRF guard', () => {
  it('rejects http, localhost and private addresses with 422 URL_NOT_ALLOWED', async () => {
    for (const baseUrl of [
      'http://pos.example.com', 'https://localhost/api', 'https://10.0.0.5', 'https://127.0.0.1:8443', 'https://169.254.169.254', 'https://user:pw@pos.example.com',
      // W1-R3: IPv6 spellings of loopback / private IPv4 (and IPv6 literals at all).
      'https://[::ffff:127.0.0.1]/', 'https://[::ffff:a00:1]/', 'https://[::127.0.0.1]/', 'https://[64:ff9b::7f00:1]/', 'https://[::1]/', 'https://[2606:4700::1111]/',
    ]) {
      const r = await call(u['itA']!, 'PUT', '/connectors/fiscal', { baseUrl })
      expect(r.statusCode, baseUrl).toBe(422)
      expect(r.json().error.code).toBe('URL_NOT_ALLOWED')
    }
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal', { baseUrl: '' })).statusCode).toBe(200)
  })
})

describe('go-live, release, switch-off (no skip, no date range)', () => {
  it('NOT_READY lists what is missing', async () => {
    const r = await call(u['adminB']!, 'POST', '/connectors/fiscal/go-live', { confirm: 'GO LIVE' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_READY')
    const missing = r.json().error.details.missing as string[]
    expect(missing.join(' | ')).toMatch(/driver/)
    expect(missing.join(' | ')).toMatch(/Test connection/)
    expect(missing.join(' | ')).toMatch(/drained/)
    expect((await call(u['adminA']!, 'POST', '/connectors/fiscal/go-live', { confirm: 'yes' })).statusCode).toBe(400)
  })

  it('release before go-live → 409 NOT_LIVE', async () => {
    const r = await call(u['adminA']!, 'POST', '/connectors/fiscal/documents/release', {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_LIVE')
    // A date range is not accepted.
    expect((await call(u['adminA']!, 'POST', '/connectors/fiscal/documents/release', { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' })).statusCode).toBe(400)
  })

  it('test → go live → release ALL held → switch off', async () => {
    await prisma.setting.upsert({ where: { key: LEGACY_DRAIN_KEY }, create: { key: LEGACY_DRAIN_KEY, value: new Date().toISOString() }, update: {} })
    const t = await call(u['itA']!, 'POST', '/connectors/fiscal/test', { dryRun: true })
    expect(t.statusCode, t.body).toBe(200)
    expect(t.json()).toMatchObject({ ok: true, dryRun: { outcome: 'filed' } })
    expect(t.json().dryRun.fiscalNumber).toMatch(/^TEST-SRB-/)
    expect(await prisma.fiscalDocument.count({ where: { id: { startsWith: 'test_' } } })).toBe(0)
    const live = await call(u['adminA']!, 'POST', '/connectors/fiscal/go-live', { confirm: 'GO LIVE' })
    expect(live.statusCode, live.body).toBe(200)
    expect(live.json()).toMatchObject({ enabled: true, isTest: true })
    expect(live.json().liveSince).not.toBeNull()
    expect(await prisma.auditLog.count({ where: { action: 'fiscal.go_live', tenantId: A.tenantId } })).toBe(1)

    const held = await saleDoc(A) // created while live → pending; make one more held to release
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: held } })).status).toBe('pending')
    const rel = await call(u['adminA']!, 'POST', '/connectors/fiscal/documents/release', {})
    expect(rel.statusCode, rel.body).toBe(200)
    expect(rel.json()).toEqual({ released: 1, stillHeld: 0 })
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docA } })).status).toBe('pending')

    const off = await call(u['adminA']!, 'POST', '/connectors/fiscal/switch-off', { confirm: 'SWITCH OFF' })
    expect(off.json().enabled).toBe(false)
    expect((await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })).liveSince).not.toBeNull()
  })

  it('retry + manual filing through the routes, audited', async () => {
    const d = await saleDoc(B) // B is off → held
    await prisma.fiscalDocument.update({ where: { id: d }, data: { status: 'failed' } })
    const r = await call(u['adminB']!, 'POST', `/connectors/fiscal/documents/${d}/retry`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('pending')
    const m = await call(u['itB']!, 'POST', `/connectors/fiscal/documents/${d}/manual`, { fiscalNumber: 'SRB-PORTAL-9', authority: 'srb', note: 'filed on the portal' })
    expect(m.statusCode, m.body).toBe(200)
    expect(m.json()).toMatchObject({ status: 'manual_filed', fiscalNumber: 'SRB-PORTAL-9' })
    expect(await prisma.auditLog.count({ where: { action: { in: ['fiscal.retry', 'fiscal.manual_filed'] }, entityId: d } })).toBe(2)
  })
})

describe('§17.7 fiscal reporting required', () => {
  it('the CEO switches it off for the whole company (reason + audit); its sales then create no document', async () => {
    const r = await call(u['adminB']!, 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'home kitchen — not a commercial company' })
    expect(r.statusCode, r.body).toBe(200)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'fiscal.reporting_required', tenantId: B.tenantId } })
    expect(a.before).toEqual({ fiscalReportingRequired: true })
    expect(a.after).toEqual({ fiscalReportingRequired: false })
    expect(a.metadata).toMatchObject({ reason: 'home kitchen — not a commercial company' })
    expect((await call(u['adminB']!, 'GET', '/connectors')).json().fiscalReportingRequired).toBe(false)
    const orderB = await mkOrder(B, { items: KHEER(B), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    expect(await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId: orderB, tenantId: B.tenantId }))).toBeNull()
    // Company A still reports.
    const orderA = await mkOrder(A, { items: KHEER(A), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    expect(await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId: orderA, tenantId: A.tenantId }))).not.toBeNull()
    // IT cannot change it through the settings PUT either.
    await call(u['itB']!, 'PUT', '/connectors/fiscal', { settings: { syncTimeoutMs: 2000 } })
    expect((await call(u['adminB']!, 'GET', '/connectors')).json().fiscalReportingRequired).toBe(false)
    expect((await call(u['itB']!, 'PUT', '/connectors/fiscal', { settings: { fiscalReportingRequired: true } })).statusCode).toBe(400)
  })
})

describe('drivers', () => {
  it('lists none / test / http for both kinds', async () => {
    const r = await call(u['itA']!, 'GET', '/connectors/drivers')
    const ids = r.json().map((d: { kind: string; id: string }) => `${d.kind}:${d.id}`)
    expect(ids).toEqual(expect.arrayContaining(['fiscal:none', 'fiscal:test', 'fiscal:http', 'terminal:none', 'terminal:test', 'terminal:http']))
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal', { driver: 'acme' })).statusCode).toBe(422)
  })

  it('terminal: the manual reference cannot be switched off without a driver', async () => {
    await setConnector(B.tenantId, 'terminal', { driver: 'none' })
    const r = await call(u['itB']!, 'PUT', '/connectors/terminal', { settings: { allowManualRef: false } })
    expect(r.statusCode).toBe(422)
  })
})

describe('W1-R6: a LIVE fiscal POS is never re-pointed from the settings PUT', () => {
  it('IT changing the driver / address of a live fiscal connector → 409 SWITCH_OFF_FIRST; key rotation is fine; after the CEO switches off it works', async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
    for (const body of [{ driver: 'http' }, { driver: 'none' }, { baseUrl: 'https://pos.example.com' }]) {
      const r = await call(u['itA']!, 'PUT', '/connectors/fiscal', body)
      expect(r.statusCode, JSON.stringify(body)).toBe(409)
      expect(r.json().error.code).toBe('SWITCH_OFF_FIRST')
    }
    const row = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })
    expect(row).toMatchObject({ driver: 'test', enabled: true, baseUrl: null })
    // The CEO cannot do it from here either — switch off, change, go live (with its readiness check).
    expect((await call(u['adminA']!, 'PUT', '/connectors/fiscal', { driver: 'http' })).statusCode).toBe(409)
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal', { apiKey: 'sk_rotated_123456789' })).statusCode).toBe(200)
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal', { settings: { syncTimeoutMs: 2500 } })).statusCode).toBe(200)

    expect((await call(u['adminA']!, 'POST', '/connectors/fiscal/switch-off', { confirm: 'SWITCH OFF' })).statusCode).toBe(200)
    const r = await call(u['itA']!, 'PUT', '/connectors/fiscal', { driver: 'none' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ driver: 'none', enabled: false })
    expect((await call(u['itA']!, 'PUT', '/connectors/fiscal', { driver: 'test' })).statusCode).toBe(200)
  })
})

describe('W1-R10: the reporting switch survives concurrent settings saves', () => {
  it('the CEO\'s switch-off racing ten IT saves is never dropped', async () => {
    const saves = Array.from({ length: 10 }, (_, i) => call(u['itA']!, 'PUT', '/connectors/fiscal', { settings: { syncTimeoutMs: 1000 + i * 100 } }))
    const toggle = call(u['adminA']!, 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'race test — rehearsal company' })
    const all = await Promise.all([...saves.slice(0, 5), toggle, ...saves.slice(5)])
    for (const r of all) expect(r.statusCode, r.body).toBe(200)
    expect((await call(u['adminA']!, 'GET', '/connectors')).json().fiscalReportingRequired).toBe(false)
    const row = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })
    expect((row.settings as Record<string, unknown>)['fiscalReportingRequired']).toBe(false)
    expect((await call(u['adminA']!, 'PUT', '/connectors/fiscal/reporting-required', { required: true, reason: 'restore' })).statusCode).toBe(200)
  })
})
