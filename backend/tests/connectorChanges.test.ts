// D1/D3 B4 — POS connector change requests (the Dev hand-over) and A24
// (head offices have no fiscal POS). Real routes through Fastify inject with
// the real auth middleware (head-office reach, the lens header, RLS).
//
//   - a request through the head-office lens: secrets sealed, never returned;
//   - approve runs the PUT's own validation (live fiscal refusals, company
//     checks) in the claim's transaction — a refusal leaves it submitted;
//   - regenerating / rotating a secret is refused;
//   - company B gets 404;
//   - a Dev delegate approves; the preparer cannot;
//   - a head office: fiscal reporting OFF, no backlog, no /health count.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, containsDeep, TEST_SECRET_KEY,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { ensureConnectorRow } from '../src/connectors/registry.js'
import { connectorHealthChecks, reportingOffTenantIds } from '../src/connectors/health.js'
import { fiscalReportingRequired } from '../src/connectors/config.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let HO: string
const u: Record<string, Who> = {}
const API_KEY = 'sk_live_HOchange_55aa77bb99'
const HOOK = 'whsec_HOchange_1234567890abcdef'
let prevKey: string | undefined

const lens = (tenantId: string) => ({ 'x-servd-active-tenant': tenantId })

async function addMember(who: Who, tenantId: string) {
  await prisma.tenantMember.create({ data: { tenantId, userId: who.id } }).catch(() => {})
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  A = await mkCompany('cc-a', { srbPosId: 111 })
  B = await mkCompany('cc-b', { srbPosId: 222 })
  HO = (await prisma.tenant.create({ data: { name: 'Co cc-ho', slug: 'cc-ho', kind: 'head_office' } })).id

  u['ceo'] = await mkUser('ceo', 'admin', A.tenantId)
  await addMember(u['ceo']!, B.tenantId)
  await addMember(u['ceo']!, HO)
  u['itA'] = await mkUser('itA', 'it', A.tenantId)
  u['itHo'] = await mkUser('itHo', 'it', HO)          // reach-only IT (no delegation)
  u['devDel'] = await mkUser('devDel', 'it', HO)      // reach-only IT holding the Dev hand-over for A
  u['adminB'] = await mkUser('adminB', 'admin', B.tenantId)
  u['itB'] = await mkUser('itB', 'it', B.tenantId)
  u['mgmtA'] = await mkUser('mgmtA', 'management', A.tenantId)
  u['cashierA'] = await mkUser('cashierA', 'cashier', A.tenantId)

  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A.tenantId, createdById: u['ceo']!.id } })
  await prisma.approvalDelegation.create({
    data: {
      tenantId: HO, companyTenantId: A.tenantId, section: 'dev', approvalTypes: ['connector_change'],
      delegateUserId: u['devDel']!.id, grantedById: u['ceo']!.id, note: 'Dev hand-over',
    },
  })
  app = await buildApp()
  call = caller(app)
}, 120_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

const submit = (who: Who, kind: 'fiscal' | 'terminal', body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  call(who, 'POST', `/connectors/${kind}/change-requests`, body, headers)

describe('submit through the head-office lens', () => {
  let changeId = ''

  it('seals the secrets, stamps the head office and the preparer, never returns a secret', async () => {
    const r = await submit(u['itHo']!, 'terminal', {
      driver: 'test', apiKey: API_KEY, webhookSecret: HOOK,
      settings: { terminals: [{ label: 'Counter 1', locationId: A.locationId, terminalId: 'DEV-1', active: true }] },
    }, lens(A.tenantId))
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json()
    changeId = body.id
    expect(body.tenantId).toBe(A.tenantId)
    expect(body.status).toBe('submitted')
    expect(body.secretsIncluded).toBe(true)
    expect(body.patch).toMatchObject({ driver: 'test', apiKey: 'set', webhookSecret: 'set' })
    for (const needle of [API_KEY, HOOK, 'enc:v1:']) expect(containsDeep(body, needle), needle).toBe(false)

    const row = await prisma.posConnectorChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(row.apiKeyEnc).toMatch(/^enc:v1:/)
    expect(row.webhookSecretEnc).toMatch(/^enc:v1:/)
    expect(containsDeep(row.patch, API_KEY)).toBe(false)
    expect(row.viaHeadOfficeId).toBe(HO)
    expect(row.preparedById).toBe(u['itHo']!.id)
    expect(row.preparedByIds).toEqual([u['itHo']!.id])

    // Lists (the preparer through the lens, the CEO, the delegate) carry no secret either.
    for (const [who, headers] of [['itHo', lens(A.tenantId)], ['ceo', {}], ['devDel', {}]] as const) {
      const l = await call(u[who]!, 'GET', '/connectors/change-requests?status=submitted', undefined, headers)
      expect(l.statusCode, `${who} ${l.body}`).toBe(200)
      expect(l.json().changes.map((c: { id: string }) => c.id), who).toContain(changeId)
      for (const needle of [API_KEY, HOOK, 'enc:v1:']) expect(containsDeep(l.json(), needle), `${who} ${needle}`).toBe(false)
    }
    const audits = await prisma.auditLog.findMany({ where: { entityId: changeId } })
    expect(audits.length).toBeGreaterThan(0)
    for (const a of audits) expect(containsDeep(a, API_KEY) || containsDeep(a, HOOK)).toBe(false)
  })

  it('a reach-only IT member cannot PUT the reached company directly (submit only)', async () => {
    const r = await call(u['itHo']!, 'PUT', '/connectors/terminal', { driver: 'test' }, lens(A.tenantId))
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
  })

  it('the preparer (no hand-over) cannot approve; a cashier cannot list', async () => {
    const r = await call(u['itHo']!, 'POST', `/connectors/change-requests/${changeId}/approve`, {})
    expect(r.statusCode).toBe(403)
    expect((await call(u['cashierA']!, 'GET', '/connectors/change-requests')).statusCode).toBe(403)
  })

  it('company B gets 404 (approve, reject, withdraw) and never sees it in a list', async () => {
    expect((await call(u['adminB']!, 'POST', `/connectors/change-requests/${changeId}/approve`, {})).statusCode).toBe(404)
    expect((await call(u['adminB']!, 'POST', `/connectors/change-requests/${changeId}/reject`, { note: 'no' })).statusCode).toBe(404)
    expect((await call(u['itB']!, 'POST', `/connectors/change-requests/${changeId}/withdraw`, {})).statusCode).toBe(404)
    const l = await call(u['adminB']!, 'GET', '/connectors/change-requests')
    expect(l.statusCode).toBe(200)
    expect(l.json().changes.map((c: { id: string }) => c.id)).not.toContain(changeId)
    expect((await prisma.posConnectorChange.findUniqueOrThrow({ where: { id: changeId } })).status).toBe('submitted')
  })

  it('the Dev delegate approves: the PUT writer applies it, secrets land sealed on the connector', async () => {
    const r = await call(u['devDel']!, 'POST', `/connectors/change-requests/${changeId}/approve`, {})
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().change.status).toBe('applied')
    expect(r.json().change.decidedVia).toBe('delegation')
    expect(r.json().connector.driver).toBe('test')
    expect(r.json().connector.apiKeyHint).toBe('sk_l…bb99')
    for (const needle of [API_KEY, HOOK, 'enc:v1:']) expect(containsDeep(r.json(), needle), needle).toBe(false)
    const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'terminal' } } })
    expect(conn.apiKeyEnc).toMatch(/^enc:v1:/)
    expect(conn.webhookSecretEnc).toMatch(/^enc:v1:/)
    expect(conn.updatedById).toBe(u['devDel']!.id)
    const row = await prisma.posConnectorChange.findUniqueOrThrow({ where: { id: changeId } })
    expect(row.apiKeyEnc).toBeNull()
    expect(row.webhookSecretEnc).toBeNull()
    expect(row.decidedById).toBe(u['devDel']!.id)
    expect(row.delegationId).not.toBeNull()
    expect(await prisma.auditLog.count({ where: { action: 'approval.decide', entityId: changeId } })).toBe(1)
    // Decided once.
    expect((await call(u['ceo']!, 'POST', `/connectors/change-requests/${changeId}/approve`, {})).statusCode).toBe(409)
  })

  it('the delegate cannot approve a request they prepared (separation of duties)', async () => {
    const s = await submit(u['devDel']!, 'terminal', { settings: { allowManualRef: true } }, lens(A.tenantId))
    expect(s.statusCode, s.body).toBe(201)
    const r = await call(u['devDel']!, 'POST', `/connectors/change-requests/${s.json().id}/approve`, {})
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    // The preparer withdraws it; nobody else may.
    expect((await call(u['itA']!, 'POST', `/connectors/change-requests/${s.json().id}/withdraw`, {})).statusCode).toBe(403)
    const w = await call(u['devDel']!, 'POST', `/connectors/change-requests/${s.json().id}/withdraw`, {}, lens(A.tenantId))
    expect(w.statusCode, w.body).toBe(200)
    expect(w.json().status).toBe('withdrawn')
  })
})

describe('refusals at submit', () => {
  it('regenerating a webhook secret or rotating the webhook token is refused', async () => {
    for (const body of [{ regenerateWebhookSecret: true }, { rotateWebhookToken: true }]) {
      const r = await submit(u['itA']!, 'fiscal', body)
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('REGENERATE_NOT_ALLOWED')
    }
  })

  it('go-live / switch-off and the reporting switch cannot be requested', async () => {
    const r = await submit(u['itA']!, 'fiscal', { enabled: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('CEO_ONLY_SWITCH')
    expect((await submit(u['itA']!, 'fiscal', { settings: { fiscalReportingRequired: false } })).statusCode).toBe(400)
    expect((await submit(u['itA']!, 'fiscal', {})).json().error.code).toBe('NOTHING_TO_CHANGE')
    expect((await submit(u['mgmtA']!, 'fiscal', { driver: 'test' })).statusCode).toBe(403)
  })

  it('503 SECRET_KEY_MISSING when a secret is sent without SERVD_SECRET_KEY; nothing is stored', async () => {
    const before = await prisma.posConnectorChange.count()
    delete process.env['SERVD_SECRET_KEY']
    try {
      const r = await submit(u['itA']!, 'terminal', { apiKey: 'another-secret-value' })
      expect(r.statusCode).toBe(503)
      expect(r.json().error.code).toBe('SECRET_KEY_MISSING')
    } finally {
      process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
    }
    expect(await prisma.posConnectorChange.count()).toBe(before)
  })

  it('the SSRF guard runs at submit', async () => {
    const r = await submit(u['itA']!, 'fiscal', { baseUrl: 'https://127.0.0.1:8443' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('URL_NOT_ALLOWED')
  })
})

describe('approve runs the same validation as PUT', () => {
  it('a live fiscal POS refuses a driver change (409 SWITCH_OFF_FIRST); the request stays submitted', async () => {
    const s = await submit(u['itA']!, 'fiscal', { driver: 'http' })
    expect(s.statusCode, s.body).toBe(201)
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
    const r = await call(u['ceo']!, 'POST', `/connectors/change-requests/${s.json().id}/approve`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('SWITCH_OFF_FIRST')
    expect((await prisma.posConnectorChange.findUniqueOrThrow({ where: { id: s.json().id } })).status).toBe('submitted')
    expect((await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'fiscal' } } })).driver).toBe('test')
    // Switched off by the CEO → the same request applies.
    await setConnector(A.tenantId, 'fiscal', { enabled: false, liveSince: null })
    const ok = await call(u['ceo']!, 'POST', `/connectors/change-requests/${s.json().id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().connector.driver).toBe('http')
    expect(ok.json().change.decidedVia).toBe('role')
  })

  it('another company\'s outlet in the settings → 422 NOT_IN_COMPANY at approve; rejected with a note', async () => {
    const s = await submit(u['itA']!, 'fiscal', { settings: { outlets: [{ locationId: B.locationId, conceptId: null, authority: 'srb', posId: 'X' }] } })
    expect(s.statusCode, s.body).toBe(201)
    const r = await call(u['ceo']!, 'POST', `/connectors/change-requests/${s.json().id}/approve`, {})
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOT_IN_COMPANY')
    expect((await call(u['ceo']!, 'POST', `/connectors/change-requests/${s.json().id}/reject`, {})).statusCode).toBe(400)
    const rej = await call(u['ceo']!, 'POST', `/connectors/change-requests/${s.json().id}/reject`, { note: 'Wrong outlet' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('rejected')
    expect(rej.json().decisionNote).toBe('Wrong outlet')
  })

  it('IT of the company itself (not the CEO) cannot approve', async () => {
    const s = await submit(u['itA']!, 'terminal', { settings: { allowManualRef: true } })
    expect((await call(u['itA']!, 'POST', `/connectors/change-requests/${s.json().id}/approve`, {})).statusCode).toBe(403)
  })
})

describe('A24: a head office has no fiscal POS', () => {
  it('its fiscal row is created with reporting OFF; it is never a backlog; no request can name it', async () => {
    const row = await ensureConnectorRow(HO, 'fiscal')
    expect((row.settings as Record<string, unknown>)['fiscalReportingRequired']).toBe(false)
    expect(await fiscalReportingRequired(HO)).toBe(false)
    expect(await reportingOffTenantIds()).toContain(HO)
    // A trading company's new row is unchanged (default ON).
    const c = await mkCompany('cc-c')
    expect((await ensureConnectorRow(c.tenantId, 'fiscal')).settings).toEqual({})
    const r = await submit(u['ceo']!, 'fiscal', { driver: 'test' }, lens(HO))
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('HEAD_OFFICE_HAS_NO_POS')
  })

  it('/health skips head offices', async () => {
    await setConnector(A.tenantId, 'fiscal', { enabled: false })
    const before = await connectorHealthChecks()
    await setConnector(HO, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
    await setConnector(HO, 'terminal', { driver: 'test', enabled: true })
    await prisma.posConnector.update({ where: { tenantId_kind: { tenantId: HO, kind: 'fiscal' } }, data: { lastError: 'AUTH refused', lastErrorAt: new Date() } })
    const after = await connectorHealthChecks()
    expect(after.checks.fiscalConnector).toBe(before.checks.fiscalConnector)
    expect(after.details['fiscalConnector']).toBe(before.details['fiscalConnector'])
    expect(after.checks.cardTerminal).toBe(before.checks.cardTerminal)
    expect(after.details['cardTerminal']).toBe(before.details['cardTerminal'])
  })
})
