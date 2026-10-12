// Raast QR — /connectors/raast (spec §6.7, §9 A; S2): roles (api_pos people
// only: finance 403, it configures, management reads, the CEO switches SMS
// matching on and reveals tokens), device tokens shown once and rotated,
// readiness, settings validation, the tester writes nothing, and company B
// never sees or touches company A's devices or SMS.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, resetConnectorCache, mkRaastAccount, containsDeep, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { resetSmsAuthThrottle } from '../src/modules/connectors/webhookRoutes.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
const u: Record<string, Who> = {}
let accA: { bankAccountId: string; ledgerCode: string }
let accB: { bankAccountId: string; ledgerCode: string }
let prevKey: string | undefined

const TPL = { id: 'tpl-c', label: 'Credit', kind: 'credit', template: 'PKR {amount} received from {payer} via Raast. Ref {ref}.', active: true }
const SMS = 'PKR 1,188.00 received from ALI KHAN via Raast. Ref FT99887766.'

async function sendSms(token: string, text: string, from = 'MEEZANBNK') {
  return app.inject({ method: 'POST', url: '/webhooks/pos/sms', headers: { authorization: `Bearer ${token}` }, payload: { from, text, receivedAt: Date.now() } })
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  A = await mkCompany('rcr-a')
  B = await mkCompany('rcr-b')
  accA = await mkRaastAccount(A)
  accB = await mkRaastAccount(B)
  u['adminA'] = await mkUser('adminA', 'admin', A.tenantId)
  u['itA'] = await mkUser('itA', 'it', A.tenantId)
  u['mgmtA'] = await mkUser('mgmtA', 'management', A.tenantId)
  u['financeA'] = await mkUser('financeA', 'finance', A.tenantId)
  u['cashierA'] = await mkUser('cashierA', 'cashier', A.tenantId)
  u['itB'] = await mkUser('itB', 'it', B.tenantId)
  u['adminB'] = await mkUser('adminB', 'admin', B.tenantId)
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  resetConnectorCache()
  resetSmsAuthThrottle()
  await app.close()
})

describe('roles', () => {
  it('finance and cashiers get 403; it and admin read and configure; management reads only', async () => {
    for (const who of ['financeA', 'cashierA'] as const) {
      expect((await call(u[who]!, 'GET', '/connectors/raast/settings')).statusCode, who).toBe(403)
      expect((await call(u[who]!, 'GET', '/connectors/raast/sms')).statusCode, who).toBe(403)
    }
    expect((await call(u['itA']!, 'GET', '/connectors/raast/settings')).statusCode).toBe(200)
    expect((await call(u['mgmtA']!, 'GET', '/connectors/raast/settings')).statusCode).toBe(200)
    expect((await call(u['mgmtA']!, 'PUT', '/connectors/raast/settings', { matchWindowMin: 12 })).statusCode).toBe(403)
    expect((await call(u['mgmtA']!, 'POST', '/connectors/raast/devices', { label: 'x' })).statusCode).toBe(403)
    expect((await call(u['itA']!, 'PUT', '/connectors/raast/settings', { matchWindowMin: 12 })).statusCode).toBe(200)
  })

  it('the /connectors overview carries the raast block', async () => {
    const r = await call(u['itA']!, 'GET', '/connectors')
    expect(r.statusCode).toBe(200)
    expect(r.json().raast).toMatchObject({ enabled: false, devices: 0, counts: { awaiting: 0 } })
  })
})

describe('settings validation', () => {
  it('a sender on another company\'s bank account → 422 BANK_ACCOUNT_NOT_IN_COMPANY', async () => {
    const r = await call(u['itA']!, 'PUT', '/connectors/raast/settings', {
      templates: [TPL], senders: [{ senderId: 'MEEZANBNK', bankAccountId: accB.bankAccountId, templateIds: ['tpl-c'], active: true }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
  })

  it('a credit template without {ref} → 422 INVALID_TEMPLATE; a sender naming a missing template → 422', async () => {
    const t = await call(u['itA']!, 'PUT', '/connectors/raast/settings', { templates: [{ ...TPL, template: 'PKR {amount} received' }] })
    expect(t.statusCode).toBe(422)
    expect(t.json().error).toMatchObject({ code: 'INVALID_TEMPLATE', details: { templateId: 'tpl-c' } })
    const s = await call(u['itA']!, 'PUT', '/connectors/raast/settings', {
      templates: [TPL], senders: [{ senderId: 'MEEZANBNK', bankAccountId: accA.bankAccountId, templateIds: ['nope'], active: true }],
    })
    expect(s.statusCode).toBe(422)
  })

  it('a valid save normalises the sender and keeps it for the company only', async () => {
    const r = await call(u['itA']!, 'PUT', '/connectors/raast/settings', {
      templates: [TPL], senders: [{ senderId: 'Meezan-Bnk', bankAccountId: accA.bankAccountId, templateIds: ['tpl-c'], active: true }],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().settings.senders[0]).toMatchObject({ senderId: 'MEEZANBNK', bankAccountId: accA.bankAccountId })
    expect((await call(u['itB']!, 'GET', '/connectors/raast/settings')).json().connector.settings.senders).toEqual([])
    expect(await prisma.auditLog.count({ where: { action: 'raast.settings.update', tenantId: A.tenantId } })).toBeGreaterThan(0)
  })
})

describe('devices', () => {
  let deviceId = ''
  let token = ''

  it('creating a device returns the token ONCE; lists never carry it', async () => {
    const r = await call(u['itA']!, 'POST', '/connectors/raast/devices', { label: 'Counter phone' })
    expect(r.statusCode, r.body).toBe(201)
    token = r.json().token
    deviceId = r.json().device.id
    expect(token).toMatch(/^sms_[0-9a-f]{64}$/)
    expect(r.json().postUrl).toMatch(/\/api\/v1\/webhooks\/pos\/sms$/)
    expect(r.json().header).toBe(`Authorization: Bearer ${token}`)
    expect(r.json().pathUrl).toBeNull()
    const row = await prisma.bankSmsDevice.findUniqueOrThrow({ where: { id: deviceId } })
    expect(row.tenantId).toBe(A.tenantId)
    expect(row.tokenEnc.startsWith('enc:v1:')).toBe(true)
    expect(row.tokenHash).not.toContain(token.slice(4, 20))
    for (const url of ['/connectors/raast/devices', '/connectors/raast/settings']) {
      expect(containsDeep((await call(u['itA']!, 'GET', url)).json(), token), url).toBe(false)
    }
  })

  it('a device on another company\'s outlet → 422; without SERVD_SECRET_KEY → 503', async () => {
    expect((await call(u['itA']!, 'POST', '/connectors/raast/devices', { label: 'x', locationId: B.locationId })).statusCode).toBe(422)
    delete process.env['SERVD_SECRET_KEY']
    const r = await call(u['itA']!, 'POST', '/connectors/raast/devices', { label: 'x' })
    process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    expect(r.statusCode).toBe(503)
    expect(r.json().error.code).toBe('SECRET_KEY_MISSING')
  })

  it('B never sees, edits, rotates or reveals A\'s device', async () => {
    expect((await call(u['itB']!, 'GET', '/connectors/raast/devices')).json()).toEqual([])
    expect((await call(u['itB']!, 'PATCH', `/connectors/raast/devices/${deviceId}`, { label: 'mine' })).statusCode).toBe(404)
    expect((await call(u['itB']!, 'POST', `/connectors/raast/devices/${deviceId}/rotate`, {})).statusCode).toBe(404)
    expect((await call(u['adminB']!, 'POST', `/connectors/raast/devices/${deviceId}/reveal`, {})).statusCode).toBe(404)
  })

  it('rotating kills the old token at once', async () => {
    expect((await sendSms(token, SMS)).statusCode).toBe(200)
    const r = await call(u['itA']!, 'POST', `/connectors/raast/devices/${deviceId}/rotate`, {})
    expect(r.statusCode).toBe(200)
    const fresh = r.json().token as string
    expect(fresh).not.toBe(token)
    expect((await sendSms(token, SMS)).statusCode).toBe(401)
    expect((await sendSms(fresh, SMS)).statusCode).toBe(200)
    token = fresh
  })

  it('reveal is the CEO\'s only, and audited', async () => {
    expect((await call(u['itA']!, 'POST', `/connectors/raast/devices/${deviceId}/reveal`, {})).statusCode).toBe(403)
    const r = await call(u['adminA']!, 'POST', `/connectors/raast/devices/${deviceId}/reveal`, {})
    expect(r.statusCode).toBe(200)
    expect(r.json().token).toBe(token)
    expect(await prisma.auditLog.count({ where: { action: 'raast.device.reveal', entityId: deviceId } })).toBe(1)
  })

  it('allowPathToken (PATCH) offers the path URL; deactivating a device locks it out', async () => {
    const p = await call(u['itA']!, 'PATCH', `/connectors/raast/devices/${deviceId}`, { allowPathToken: true })
    expect(p.json().allowPathToken).toBe(true)
    expect((await app.inject({ method: 'POST', url: `/webhooks/pos/sms/${token}`, payload: { from: 'X', text: 'y' } })).statusCode).toBe(200)
    await call(u['itA']!, 'PATCH', `/connectors/raast/devices/${deviceId}`, { allowPathToken: false, active: false })
    expect((await sendSms(token, SMS)).statusCode).toBe(401)
    await call(u['itA']!, 'PATCH', `/connectors/raast/devices/${deviceId}`, { active: true })
    resetSmsAuthThrottle()
  })
})

describe('test-parse and the SMS log', () => {
  it('the tester reports fields and problems and writes nothing', async () => {
    const before = await prisma.bankSmsAlert.count()
    const r = await call(u['mgmtA']!, 'POST', '/connectors/raast/test-parse', { sender: 'Meezan Bnk', body: SMS })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ sender: 'MEEZANBNK', senderAllowed: true, ignoredByKeyword: false })
    expect(r.json().results[0]).toMatchObject({ templateId: 'tpl-c', matched: true, fields: { amountCents: 118_800, bankRef: 'FT99887766', refValid: true, payer: 'ALI KHAN' } })
    const draft = await call(u['itA']!, 'POST', '/connectors/raast/test-parse', {
      sender: 'X', body: SMS, templates: [{ label: 'draft', kind: 'credit', template: 'PKR {amount} received {*}', active: true }],
    })
    expect(draft.json().results[0].matched).toBe(false)
    expect(draft.json().results[0].problems.join()).toMatch(/\{ref\}/)
    expect(await prisma.bankSmsAlert.count()).toBe(before)
  })

  it('GET /sms is the company\'s own log only', async () => {
    const a = await call(u['itA']!, 'GET', '/connectors/raast/sms')
    expect(a.statusCode).toBe(200)
    expect(a.json().items.length).toBeGreaterThan(0)
    for (const it of a.json().items) expect(it.device).toBeTruthy()
    expect((await call(u['itB']!, 'GET', '/connectors/raast/sms')).json().items).toEqual([])
  })
})

describe('SMS matching switch', () => {
  it('sms-on: CEO only, refused with the missing list until ready, then on; sms-off by IT', async () => {
    expect((await call(u['itA']!, 'POST', '/connectors/raast/sms-on', { confirm: 'SMS ON' })).statusCode).toBe(403)
    await prisma.bankSmsAlert.updateMany({ where: { tenantId: A.tenantId }, data: { status: 'unparsed' } })
    const no = await call(u['adminA']!, 'POST', '/connectors/raast/sms-on', { confirm: 'SMS ON' })
    expect(no.statusCode).toBe(409)
    expect(no.json().error.code).toBe('NOT_READY')
    expect(no.json().error.details.missing.join(' ')).toMatch(/7 days/)
    // A money-in SMS read correctly while matching is off makes it ready.
    const tok = (await call(u['adminA']!, 'POST', `/connectors/raast/devices/${(await prisma.bankSmsDevice.findFirstOrThrow({ where: { tenantId: A.tenantId } })).id}/reveal`, {})).json().token
    const sent = await sendSms(tok, 'PKR 2,000.00 received from SARA via Raast. Ref FT11223344.')
    const id = sent.json().id as string
    for (let i = 0; i < 100; i++) {
      const s = (await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id } })).status
      if (s !== 'received' && s !== 'processing') break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id } })).status).toBe('off')
    const ok = await call(u['adminA']!, 'POST', '/connectors/raast/sms-on', { confirm: 'SMS ON' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ enabled: true, smsMatching: true })
    expect(ok.json().smsOnSince).toBeTruthy()
    // B is untouched.
    expect((await call(u['itB']!, 'GET', '/connectors/raast/settings')).json().connector.enabled).toBe(false)
    const off = await call(u['itA']!, 'POST', '/connectors/raast/sms-off', { confirm: 'SMS OFF' })
    expect(off.statusCode).toBe(200)
    expect(off.json().enabled).toBe(false)
    expect(await prisma.auditLog.count({ where: { action: { in: ['raast.sms_on', 'raast.sms_off'] }, tenantId: A.tenantId } })).toBe(2)
  })
})
