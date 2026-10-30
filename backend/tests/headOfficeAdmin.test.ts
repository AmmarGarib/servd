// Head office admin (D1, spec §9 as rewritten by the plan; amendments A1, A11,
// A12, A17) — the CEO-only /head-offices routes on Fastify inject, through the
// real auth middleware.
//
//   A, B, C  trading companies (the CEO is a member of each)
//   F        a trading company the CEO is NOT a member of (foreign → 404)
//   T        a test company (the CEO is a member)
//   HO       created through POST /head-offices; HO2 a second head office
//
//   ceo      admin, member of A, B, C, T (and every head office it creates)
//   fin      finance, member of A — every /head-offices route answers 403
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { invalidateTestTenants } from '../src/lib/testCompany.js'
import { headOfficeRoutes } from '../src/modules/headOffices/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'
import { headOfficeSetupApplied } from '../src/modules/headOffices/books.js'
import { getSettings } from '../src/modules/hr/service.js'
import { moveRechargeToIncome } from '../src/modules/headOffices/accounts.js'

const P = `hoa-${Date.now()}`
let app: FastifyInstance
let A: string, B: string, C: string, F: string, T: string
let HO: string, HO2: string
const users: Record<string, { id: string; token: string }> = {}

async function tenant(name: string, isTest = false) {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}`, isTest } })).id
}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
function call(who: string, method: Method, url: string, payload?: unknown) {
  return app.inject({
    method, url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${users[who]!.token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

async function books(hoId: string) {
  return prisma.headOfficeBooks.findUniqueOrThrow({ where: { tenantId: hoId } })
}

/** Confirm the books and switch recharge on — the state every "clears confirmation" test starts from. */
async function confirmAndEnable(hoId: string) {
  const c = await call('ceo', 'POST', `/head-offices/${hoId}/books/confirm`, { note: 'CA confirmed codes and names', taxAnswer: 'No sales tax: cost recovery at cost' })
  expect(c.statusCode).toBe(200)
  const r = await call('ceo', 'PUT', `/head-offices/${hoId}/books/recharge`, { enabled: true, fromPeriod: '2026-09' })
  expect(r.statusCode).toBe(200)
  const b = await books(hoId)
  expect(b.rechargeEnabled).toBe(true)
  expect(b.accountsConfirmedAt).not.toBeNull()
}

async function expectCleared(hoId: string) {
  const b = await books(hoId)
  expect(b.accountsConfirmedAt).toBeNull()
  expect(b.rechargeEnabled).toBe(false)
}

/** A recharge run (another stream owns the run logic) with one line per company. */
async function mkRun(hoId: string, splitId: string, period: string, status: string, lines: Array<{ companyId: string }>) {
  const run = await prisma.rechargeRun.create({
    data: {
      tenantId: hoId, period, status, splitId, costPool: {}, basis: [],
      poolCents: 1000, priorCents: 0, baseCents: 1000, rechargedCents: 1000, retainedCents: 0,
    },
  })
  for (const l of lines) {
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: hoId, companyTenantId: l.companyId }, orderBy: { startedAt: 'desc' } })
    await prisma.rechargeRunLine.create({ data: { runId: run.id, tenantId: hoId, companyTenantId: l.companyId, linkId: link.id, shareBps: 5000, amountCents: 500 } })
  }
  return run.id
}

beforeAll(async () => {
  A = await tenant('Company A')
  B = await tenant('Company B')
  C = await tenant('Company C')
  F = await tenant('Foreign Co')
  T = await tenant('Practice Co', true)
  invalidateTestTenants()
  for (const t of [A, B, C, F, T]) {
    // Each company's own chart: the template accounts the routes resolve against.
    await prisma.account.createMany({
      data: [
        { tenantId: t, code: '6010', name: 'Salaries', type: 'expense' },
        { tenantId: t, code: '6990', name: 'Costs Recharged to Group Companies', type: 'expense' },
        { tenantId: t, code: '6500', name: 'Consultancy', type: 'expense' },
      ],
    })
  }
  await mkUser('ceo', 'admin', A, [A, B, C, T])
  await mkUser('fin', 'finance', A, [A])

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(headOfficeRoutes, { prefix: '/head-offices' })
    await api.register(setupRoutes, { prefix: '/setup' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('create', () => {
  it('creates a head office: kind, CEO owner, chart, books on its own 4220 income (HO-Q3) with recharge OFF, HR codes HO-', async () => {
    const res = await call('ceo', 'POST', '/head-offices', { name: 'GS Head Office' })
    expect(res.statusCode).toBe(201)
    HO = res.json().headOffice.id
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: HO } })
    expect(t.kind).toBe('head_office')
    expect(t.isTest).toBe(false)
    const m = await prisma.tenantMember.findFirstOrThrow({ where: { tenantId: HO, userId: users.ceo!.id } })
    expect(m.role).toBe('owner')
    expect(await prisma.account.count({ where: { tenantId: HO } })).toBeGreaterThan(50)
    const b = await books(HO)
    const recharge = await prisma.account.findUniqueOrThrow({ where: { id: b.rechargeAccountId! } })
    expect(recharge.tenantId).toBe(HO)
    expect(recharge.code).toBe('4220')
    expect(recharge.type).toBe('revenue')
    expect(await prisma.account.count({ where: { tenantId: HO, code: { in: ['6991', '6992'] } } })).toBe(0)
    expect(b.rechargeEnabled).toBe(false)
    expect(b.accountsConfirmedAt).toBeNull()
    expect(b.setupAppliedAt).toBeNull()
    expect((await getSettings(HO)).employeeCodePrefix).toBe('HO-')
    expect(await headOfficeSetupApplied()).toBe(false)
    const audits = await prisma.auditLog.count({ where: { action: 'ho.create', entityId: HO, tenantId: HO } })
    expect(audits).toBe(1)

    HO2 = (await call('ceo', 'POST', '/head-offices', { name: 'Other Head Office' })).json().headOffice.id
  })

  it('HO-Q3: books still on the old 6990 move to 4220 income at boot (recharge OFF), once', async () => {
    const ho6990 = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: HO2, code: '6990' } } })
    await prisma.headOfficeBooks.update({ where: { tenantId: HO2 }, data: { rechargeAccountId: ho6990.id } })
    const r = await moveRechargeToIncome()
    expect(r.moved).toContain(HO2)
    const b = await books(HO2)
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: b.rechargeAccountId! } })
    expect([acc.code, acc.type]).toEqual(['4220', 'revenue'])
    expect(b.rechargeEnabled).toBe(false)
    expect((await moveRechargeToIncome()).moved).not.toContain(HO2)
  })

  it('lists only head offices the CEO belongs to', async () => {
    const res = await call('ceo', 'GET', '/head-offices')
    expect(res.statusCode).toBe(200)
    const ids = res.json().headOffices.map((h: { id: string }) => h.id)
    expect(ids).toEqual(expect.arrayContaining([HO, HO2]))
    expect(ids).not.toContain(A)
  })
})

describe('CEO only', () => {
  it('every route answers 403 to a non-CEO', async () => {
    const routes: Array<[Method, string, unknown?]> = [
      ['GET', '/head-offices'],
      ['POST', '/head-offices', { name: 'Sneaky HO' }],
      ['GET', `/head-offices/${HO}`],
      ['PATCH', `/head-offices/${HO}`, { name: 'x' }],
      ['POST', `/head-offices/${HO}/companies`, { companyTenantId: A }],
      ['POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'test', lastChargedPeriod: '2026-09' }],
      ['GET', `/head-offices/${HO}/splits`],
      ['POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2026-09', lines: [{ companyTenantId: A, shareBps: 5000 }] }],
      ['DELETE', `/head-offices/${HO}/splits/x`],
      ['GET', `/head-offices/${HO}/books`],
      ['PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: 'x' }],
      ['PUT', `/head-offices/${HO}/books/pool`, { include: [{ from: 6030, to: 6036 }] }],
      ['POST', `/head-offices/${HO}/books/confirm`, { note: '0123456789', taxAnswer: '0123456789' }],
      ['PUT', `/head-offices/${HO}/books/recharge`, { enabled: true, fromPeriod: '2026-09' }],
    ]
    for (const [m, u, p] of routes) {
      const res = await call('fin', m, u, p)
      expect(res.statusCode, `${m} ${u}`).toBe(403)
    }
    expect(await prisma.tenant.count({ where: { name: 'Sneaky HO' } })).toBe(0)
  })

  it('a head office the CEO is not a member of is 404', async () => {
    const foreignHo = (await prisma.tenant.create({ data: { name: 'Stranger HO', slug: `${P}-stranger-ho`, kind: 'head_office' } })).id
    expect((await call('ceo', 'GET', `/head-offices/${foreignHo}`)).statusCode).toBe(404)
    expect((await call('ceo', 'POST', `/head-offices/${foreignHo}/companies`, { companyTenantId: A })).statusCode).toBe(404)
    // A company id is not a head office either.
    expect((await call('ceo', 'GET', `/head-offices/${A}`)).statusCode).toBe(404)
  })
})

describe('link', () => {
  it('links a company: pair accounts in both books (1450/2150), the company charges account at 6200, a live link', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: A })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.pairAccounts).toEqual({ hoDueFrom: '1450', hoDueTo: '2150', companyDueFrom: '1450', companyDueTo: '2150' })
    expect(body.chargesAccount.code).toBe('6200')
    const charges = await prisma.account.findUniqueOrThrow({ where: { id: body.chargesAccount.id } })
    expect(charges).toMatchObject({ tenantId: A, type: 'expense', controlledBy: null, name: 'Head office charges — GS Head Office' })
    const pairs = await prisma.account.findMany({ where: { tenantId: { in: [HO, A] }, controlledBy: 'intercompany' } })
    expect(pairs).toHaveLength(4)
    expect(await prisma.account.count({ where: { tenantId: { in: [HO, A] }, controlledBy: 'head_office' } })).toBe(0)
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: HO, companyTenantId: A, endedAt: null } })
    expect(link.chargesAccountId).toBe(charges.id)
    // Audited in the head office's trail AND the company's.
    expect(await prisma.auditLog.count({ where: { action: 'ho.link', entityId: link.id, tenantId: { in: [HO, A] } } })).toBe(2)
  })

  it('a second live link → 409 ALREADY_LINKED', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: A })
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('ALREADY_LINKED')
  })

  it('a foreign company → 404', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: F })
    expect(res.statusCode).toBe(404)
    expect(await prisma.headOfficeLink.count({ where: { companyTenantId: F } })).toBe(0)
  })

  it('a head office under a head office → 422 LINK_TARGET_NOT_A_COMPANY', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: HO2 })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('LINK_TARGET_NOT_A_COMPANY')
    const self = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: HO })
    expect(self.statusCode).toBe(422)
  })

  it('test and real never mix → 422 TEST_COMPANY_MIX (both ways)', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: T })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('TEST_COMPANY_MIX')
    const testHo = (await call('ceo', 'POST', '/head-offices', { name: 'Practice HO', isTest: true })).json().headOffice.id
    const real = await call('ceo', 'POST', `/head-offices/${testHo}/companies`, { companyTenantId: B })
    expect(code(real)).toBe('TEST_COMPANY_MIX')
    const ok = await call('ceo', 'POST', `/head-offices/${testHo}/companies`, { companyTenantId: T })
    expect(ok.statusCode).toBe(201)
  })

  it('A12: a live head-office-wide hand-over must be extended or revoked when a company is linked', async () => {
    const d1 = await prisma.approvalDelegation.create({
      data: { tenantId: HO, section: 'finance', delegateUserId: users.fin!.id, grantedById: users.ceo!.id },
    })
    const d2 = await prisma.approvalDelegation.create({
      data: { tenantId: HO, section: 'hr', delegateUserId: users.fin!.id, grantedById: users.ceo!.id },
    })
    const none = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: B })
    expect(none.statusCode).toBe(422)
    expect(code(none)).toBe('DELEGATIONS_UNANSWERED')
    expect(new Set((none.json().error.details.delegationIds as string[]))).toEqual(new Set([d1.id, d2.id]))
    expect(await prisma.headOfficeLink.count({ where: { tenantId: HO, companyTenantId: B } })).toBe(0)

    const half = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: B, extendDelegationIds: [d1.id] })
    expect(code(half)).toBe('DELEGATIONS_UNANSWERED')

    const ok = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: B, extendDelegationIds: [d1.id], revokeDelegationIds: [d2.id] })
    expect(ok.statusCode).toBe(201)
    expect((await prisma.approvalDelegation.findUniqueOrThrow({ where: { id: d1.id } })).revokedAt).toBeNull()
    const r2 = await prisma.approvalDelegation.findUniqueOrThrow({ where: { id: d2.id } })
    expect(r2.revokedAt).not.toBeNull()
    expect(r2.revokeReason).toMatch(/linked/)
    // Clean up for later links: revoke d1 as well.
    await prisma.approvalDelegation.update({ where: { id: d1.id }, data: { revokedAt: new Date(), revokedById: users.ceo!.id, revokeReason: 'test' } })
  })
})

describe('books: any account, pool or link change clears the confirmation and switches recharge off', () => {
  it('recharge cannot be switched on before the CA confirmation → 409 ACCOUNTS_NOT_CONFIRMED', async () => {
    const res = await call('ceo', 'PUT', `/head-offices/${HO}/books/recharge`, { enabled: true, fromPeriod: '2026-09' })
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('ACCOUNTS_NOT_CONFIRMED')
  })

  it('confirm needs a note and a tax answer of at least 10 characters', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/books/confirm`, { note: 'ok', taxAnswer: 'no tax' })
    expect(res.statusCode).toBe(400)
    expect((await books(HO)).accountsConfirmedAt).toBeNull()
  })

  it('the DB CHECK holds: recharge on without a confirmation is refused by Postgres', async () => {
    await expect(prisma.headOfficeBooks.update({ where: { tenantId: HO }, data: { rechargeEnabled: true, rechargeFromPeriod: '2026-09' } })).rejects.toThrow()
    await expect(prisma.headOfficeBooks.update({ where: { tenantId: HO }, data: { rechargeEnabled: true, accountsConfirmedAt: new Date(), rechargeFromPeriod: null } })).rejects.toThrow()
    expect((await books(HO)).rechargeEnabled).toBe(false)
  })

  it('a pool change (salaries only, owner 2026-10-30)', async () => {
    await confirmAndEnable(HO)
    const res = await call('ceo', 'PUT', `/head-offices/${HO}/books/pool`, { include: [{ from: 6030, to: 6032 }], includeCodes: ['6036'], excludeCodes: [] })
    expect(res.statusCode).toBe(200)
    await expectCleared(HO)
    expect((await books(HO)).costPool).toEqual({ include: [{ from: 6030, to: 6032 }], includeCodes: ['6036'], excludeCodes: [] })
    expect(await prisma.auditLog.count({ where: { action: 'ho.recharge.disable', tenantId: HO } })).toBeGreaterThanOrEqual(1)
    // Anything but salaries is refused: the head office shares salaries only.
    const wide = await call('ceo', 'PUT', `/head-offices/${HO}/books/pool`, { include: [{ from: 5000, to: 6999 }] })
    expect(wide.statusCode).toBe(422)
    expect(wide.json().error.code).toBe('POOL_SALARIES_ONLY')
    const extra = await call('ceo', 'PUT', `/head-offices/${HO}/books/pool`, { include: [{ from: 6030, to: 6036 }], includeCodes: ['6100'] })
    expect(extra.json().error.code).toBe('POOL_SALARIES_ONLY')
    const bad = await call('ceo', 'PUT', `/head-offices/${HO}/books/pool`, { include: [{ from: 6036, to: 6030 }] })
    expect(bad.statusCode).toBe(400)
  })

  it('an account re-mapping (and the mapping rules)', async () => {
    await confirmAndEnable(HO)
    // Unchanged mapping: nothing changes.
    const b0 = await books(HO)
    const same = await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: b0.rechargeAccountId })
    expect(same.statusCode).toBe(200)
    expect((await books(HO)).rechargeEnabled).toBe(true)

    // An engine code other than 4220 → ACCOUNT_RESERVED.
    const salaries = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: HO, code: '6010' } } })
    const reserved = await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: salaries.id })
    expect(code(reserved)).toBe('ACCOUNT_RESERVED')
    // HO-Q3: the fleet's 6990 is never the head office's recharge account.
    const ho6990 = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: HO, code: '6990' } } })
    expect(code(await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: ho6990.id }))).toBe('ACCOUNT_RESERVED')
    // Another company's account as the recharge account → 404 (company separation).
    const aConsult = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: A, code: '6500' } } })
    expect((await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: aConsult.id })).statusCode).toBe(404)
    // A controlled account → refused.
    const due = await prisma.account.findFirstOrThrow({ where: { tenantId: HO, controlledBy: 'intercompany' } })
    expect((await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: due.id })).statusCode).toBe(422)
    // 6990 as a COMPANY charges account → reserved.
    const a6990 = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: A, code: '6990' } } })
    expect(code(await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { charges: [{ companyTenantId: A, accountId: a6990.id }] }))).toBe('ACCOUNT_RESERVED')
    expect((await books(HO)).rechargeEnabled).toBe(true) // refusals change nothing

    // A revenue recharge account is allowed, with the eliminations warning, and clears the confirmation.
    const rev = await prisma.account.create({ data: { tenantId: HO, code: '4300', name: 'Recharge income', type: 'revenue' } })
    const ok = await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { rechargeAccountId: rev.id })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().warnings.join(' ')).toMatch(/eliminations/)
    await expectCleared(HO)
    expect(await prisma.auditLog.count({ where: { action: 'ho.accounts.map', tenantId: HO } })).toBe(1)

    // A company charges account re-map clears it too (and is audited in that company).
    await confirmAndEnable(HO)
    const ok2 = await call('ceo', 'PUT', `/head-offices/${HO}/books/accounts`, { charges: [{ companyTenantId: A, accountId: aConsult.id }] })
    expect(ok2.statusCode).toBe(200)
    await expectCleared(HO)
    expect(await prisma.auditLog.count({ where: { action: 'ho.accounts.map', tenantId: A } })).toBe(1)
  })

  it('a link change', async () => {
    await confirmAndEnable(HO)
    const res = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: C })
    expect(res.statusCode).toBe(201)
    await expectCleared(HO)
  })

  it('A17: a mapped account cannot be switched off in the chart → 422 ACCOUNT_MAPPED_TO_HEAD_OFFICE', async () => {
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: HO, companyTenantId: C, endedAt: null } })
    const res = await call('ceo', 'PATCH', `/setup/chart-of-accounts/${link.chargesAccountId}`, { isActive: false })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('ACCOUNT_MAPPED_TO_HEAD_OFFICE')
    const rev = await prisma.account.findUniqueOrThrow({ where: { tenantId_code: { tenantId: HO, code: '4300' } } })
    const r2 = await call('ceo', 'PATCH', `/setup/chart-of-accounts/${rev.id}`, { isActive: false })
    expect(code(r2)).toBe('ACCOUNT_MAPPED_TO_HEAD_OFFICE')
    // Renaming stays allowed.
    expect((await call('ceo', 'PATCH', `/setup/chart-of-accounts/${rev.id}`, { name: 'Head office recharge income' })).statusCode).toBe(200)
  })
})

describe('splits', () => {
  let v1: string

  it('creates a version (37.5 / 62.5), audited in the head office and both companies', async () => {
    const res = await call('ceo', 'POST', `/head-offices/${HO}/splits`, {
      effectiveFrom: '2026-09', lines: [{ companyTenantId: A, shareBps: 3750 }, { companyTenantId: B, shareBps: 6250 }], note: 'v1',
    })
    expect(res.statusCode).toBe(201)
    v1 = res.json().split.id
    expect(res.json().split.totalBps).toBe(10_000)
    expect(await prisma.auditLog.count({ where: { action: 'ho.split.create', entityId: v1 } })).toBe(3)
    const detail = (await call('ceo', 'GET', `/head-offices/${HO}`)).json()
    expect(detail.currentSplit.id).toBe(v1)
  })

  it('over 100% → 422 SPLIT_OVER_100; an unlinked company → 422 COMPANY_NOT_LINKED; a foreign one → 404', async () => {
    const over = await call('ceo', 'POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2026-10', lines: [{ companyTenantId: A, shareBps: 6000 }, { companyTenantId: B, shareBps: 4001 }] })
    expect(code(over)).toBe('SPLIT_OVER_100')
    const unlinked = await call('ceo', 'POST', `/head-offices/${HO2}/splits`, { effectiveFrom: '2026-10', lines: [{ companyTenantId: A, shareBps: 5000 }] })
    expect(code(unlinked)).toBe('COMPANY_NOT_LINKED')
    const foreign = await call('ceo', 'POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2026-10', lines: [{ companyTenantId: F, shareBps: 5000 }] })
    expect(foreign.statusCode).toBe(404)
  })

  it('a month with a submitted or posted run cannot get a new version → 409 SPLIT_PERIOD_IN_USE; drafts go stale', async () => {
    const posted = await mkRun(HO, v1, '2026-10', 'posted', [{ companyId: A }, { companyId: B }])
    const draft = await mkRun(HO, v1, '2026-12', 'draft', [{ companyId: B }])
    const res = await call('ceo', 'POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2026-10', lines: [{ companyTenantId: A, shareBps: 5000 }] })
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('SPLIT_PERIOD_IN_USE')
    const later = await call('ceo', 'POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2026-11', lines: [{ companyTenantId: A, shareBps: 5000 }, { companyTenantId: B, shareBps: 5000 }] })
    expect(later.statusCode).toBe(201)
    expect((await prisma.rechargeRun.findUniqueOrThrow({ where: { id: draft } })).stale).toBe(true)
    expect((await prisma.rechargeRun.findUniqueOrThrow({ where: { id: posted } })).stale).toBe(false)
    // A version a run uses cannot be deleted; one no run uses can.
    expect(code(await call('ceo', 'DELETE', `/head-offices/${HO}/splits/${v1}`))).toBe('SPLIT_IN_USE')
    const v3 = await call('ceo', 'POST', `/head-offices/${HO}/splits`, { effectiveFrom: '2027-03', lines: [{ companyTenantId: A, shareBps: 10_000 }] })
    expect((await call('ceo', 'DELETE', `/head-offices/${HO}/splits/${v3.json().split.id}`)).statusCode).toBe(200)
    // Clean up the draft so it does not block ending B later.
    await prisma.rechargeRun.update({ where: { id: draft }, data: { status: 'withdrawn' } })
  })
})

describe('end a link', () => {
  // The months below (runs in 2026-10..2027-01, a split from 2026-11) are fixed,
  // so "this month" is pinned to 2026-12 (Karachi) for the end-a-link rules.
  // Only Date is faked; the CEO's token is re-issued at the pinned time.
  let realCeoToken = ''
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-12-15T07:00:00Z') })
    realCeoToken = users.ceo!.token
    const u = await prisma.user.findUniqueOrThrow({ where: { id: users.ceo!.id } })
    users.ceo!.token = (issueStaffSession(u) as { accessToken: string }).accessToken
  })
  afterAll(() => {
    vi.useRealTimers()
    users.ceo!.token = realCeoToken
  })

  it('refuses a last charged month after this month (LAST_CHARGED_IN_FUTURE)', async () => {
    for (const lastChargedPeriod of ['2027-01', '2099-12']) {
      const res = await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'Moved to another head office', lastChargedPeriod })
      expect(res.statusCode).toBe(422)
      expect(code(res)).toBe('LAST_CHARGED_IN_FUTURE')
    }
    expect(await prisma.headOfficeLink.count({ where: { tenantId: HO, companyTenantId: A, endedAt: null } })).toBe(1)
  })

  it('validates lastChargedPeriod against run lines (A11), revokes the company hand-overs (A12), re-spreads the split', async () => {
    const companyGrant = await prisma.approvalDelegation.create({
      data: { tenantId: HO, companyTenantId: A, section: 'procurement', delegateUserId: users.fin!.id, grantedById: users.ceo!.id },
    })
    const split = await prisma.rechargeSplit.findFirstOrThrow({ where: { tenantId: HO, effectiveFrom: '2026-11' } })
    const runAfter = await mkRun(HO, split.id, '2027-01', 'draft', [{ companyId: A }])

    const bad = await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'Moved to another head office', lastChargedPeriod: '2026-12' })
    expect(bad.statusCode).toBe(422)
    expect(code(bad)).toBe('RUN_AFTER_LAST_CHARGED')
    expect(bad.json().error.details.runs.map((r: { id: string }) => r.id)).toContain(runAfter)
    // A posted run line in 2026-10 for A also blocks ending before it.
    expect(code(await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'x-test', lastChargedPeriod: '2026-09' }))).toBe('RUN_AFTER_LAST_CHARGED')
    expect((await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'x-test', lastChargedPeriod: '2026-13' })).statusCode).toBe(400)
    expect(await prisma.headOfficeLink.count({ where: { tenantId: HO, companyTenantId: A, endedAt: null } })).toBe(1)

    await prisma.rechargeRun.update({ where: { id: runAfter }, data: { status: 'withdrawn' } })
    await confirmAndEnable(HO)
    const ok = await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'Moved to another head office', lastChargedPeriod: '2026-12' })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body.revokedDelegationIds).toEqual([companyGrant.id])
    const g = await prisma.approvalDelegation.findUniqueOrThrow({ where: { id: companyGrant.id } })
    expect(g.revokedAt).not.toBeNull()
    expect(g.revokeReason).toBe('company unlinked')
    const link = await prisma.headOfficeLink.findFirstOrThrow({ where: { tenantId: HO, companyTenantId: A }, orderBy: { startedAt: 'desc' } })
    expect(link.endedAt).not.toBeNull()
    expect(link.lastChargedPeriod).toBe('2026-12')
    // The automatic version from 2027-01 keeps B's share and drops A (the rest stays with the head office).
    expect(body.autoSplit.effectiveFrom).toBe('2027-01')
    expect(body.autoSplit.lines).toEqual([{ companyTenantId: B, shareBps: 5000 }])
    await expectCleared(HO)
    expect(await prisma.auditLog.count({ where: { action: 'ho.unlink', entityId: link.id, tenantId: { in: [HO, A] } } })).toBe(2)

    // Ending again → 404 (no live link). Re-linking creates a NEW row and reuses the charges account.
    expect((await call('ceo', 'POST', `/head-offices/${HO}/companies/${A}/end`, { reason: 'again', lastChargedPeriod: '2026-12' })).statusCode).toBe(404)
    const relink = await call('ceo', 'POST', `/head-offices/${HO}/companies`, { companyTenantId: A })
    expect(relink.statusCode).toBe(201)
    expect(relink.json().link.id).not.toBe(link.id)
    expect(relink.json().chargesAccount.reused).toBe(true)
  })
})

describe('switch off', () => {
  it('409 HEAD_OFFICE_IN_USE while it serves a company; a head office with no links switches off', async () => {
    const res = await call('ceo', 'PATCH', `/head-offices/${HO}`, { isActive: false })
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('HEAD_OFFICE_IN_USE')
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: HO } })).isActive).toBe(true)
    const off = await call('ceo', 'PATCH', `/head-offices/${HO2}`, { isActive: false, name: 'Old Head Office' })
    expect(off.statusCode).toBe(200)
    expect(off.json().headOffice).toMatchObject({ isActive: false, name: 'Old Head Office' })
  })
})
