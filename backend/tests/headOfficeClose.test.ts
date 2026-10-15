// Head-office close checks (D1 spec §4.7 as amended by A1.5): the two
// CloseChecks of modules/headOffices/closeChecks.ts, called directly.
//
//   HO   a head office (one employee) serving C1 (60%) and C3 (no share)
//   X    a company with no head office — never blocked
//
// head_office_recharge  (the head office closing)  needs ready(HO, M)
// head_office_charges   (a served company closing) needs ready(HO, M) when its share > 0
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'
import { createHeadOffice, linkCompany } from '../src/modules/headOffices/service.js'
import { createSplitVersion } from '../src/modules/headOffices/splits.js'
import { confirmBooks, setRecharge } from '../src/modules/headOffices/books.js'
import { headOfficeCloseChecks } from '../src/modules/headOffices/closeChecks.js'
import { rechargeRunRoutes } from '../src/modules/headOffices/runRoutes.js'

const P = `hoc-${Date.now()}`
const BASE = '/accounting/intercompany/recharge-runs'
let app: FastifyInstance
let HO: string, C1: string, C3: string, X: string
const users: Record<string, { id: string; token: string }> = {}

const [recharge, charges] = headOfficeCloseChecks as [typeof headOfficeCloseChecks[0], typeof headOfficeCloseChecks[0]]

async function tenant(name: string) {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}` } })).id
}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  return app.inject({
    method, url: `/api/v1${BASE}${url}`,
    headers: { authorization: `Bearer ${users.ceo!.token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}

async function cost(tenantId: string, date: string, accountCode: string, cents: number) {
  await postJournalEntry({
    tenantId, sourceType: 'test.cost', sourceId: randomUUID(), description: 'test cost',
    entryDate: new Date(`${date}T12:00:00+05:00`), postedBy: 'system',
    lines: [{ accountCode, type: 'debit', amountCents: cents }, { accountCode: '1010', type: 'credit', amountCents: cents }],
  })
}

function ctx(tenantId: string, through: string, months: string[]): CloseCheckContext {
  return { db: prisma, tenantId, prevLock: null, newLock: parsePktEndOfDay(through), months, isYearEnd: false }
}

async function runMonth(period: string) {
  const p = await call('POST', '/', { headOfficeId: HO, period })
  expect(p.statusCode).toBe(201)
  const id = p.json().id as string
  expect((await call('POST', `/${id}/submit`)).statusCode).toBe(200)
  return id
}

beforeAll(async () => {
  C1 = await tenant('Company One')
  C3 = await tenant('Company Three')
  X = await tenant('Company X')
  for (const t of [C1, C3, X]) {
    await prisma.account.createMany({ data: [{ tenantId: t, code: '1010', name: 'Cash on Hand', type: 'asset' }] })
  }
  await mkUser('ceo', 'admin', C1, [C1, C3, X])
  const ceo = users.ceo!.id
  HO = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'GS Head Office', actorId: ceo }), { timeout: 30_000 })).id
  await prisma.$transaction(async (t) => {
    await linkCompany(t, { hoId: HO, companyId: C1, actorId: ceo })
    await linkCompany(t, { hoId: HO, companyId: C3, actorId: ceo })
    await createSplitVersion(t, { hoId: HO, effectiveFrom: '2026-07', lines: [{ companyTenantId: C1, shareBps: 6000 }], actorId: ceo })
    await confirmBooks(t, HO, { note: 'CA confirmed the accounts', taxAnswer: 'No tax on the recharge — CA confirmed' }, ceo)
    await setRecharge(t, HO, { enabled: true, fromPeriod: '2026-08' }, ceo)
  }, { timeout: 30_000 })
  await prisma.hrEmployee.create({ data: { tenantId: HO, employeeCode: 'HO-0001', fullName: 'Head of Finance' } })
  await cost(HO, '2026-07-10', '6010', 2_000_000)
  await cost(HO, '2026-09-10', '6010', 10_000_000)
  await cost(HO, '2026-10-05', '6010', 3_000_000)

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => { await api.register(rechargeRunRoutes, { prefix: BASE }) }, { prefix: '/api/v1' })
  await app.ready()
}, 90_000)

afterAll(async () => {
  await app?.close()
})

describe('the contract', () => {
  it('two blocking, overridable checks', () => {
    expect(headOfficeCloseChecks.map((c) => [c.key, c.severity, c.overridable])).toEqual([
      ['head_office_recharge', 'block', true],
      ['head_office_charges', 'block', true],
    ])
  })

  it('a company with no head office is never blocked', async () => {
    expect(await recharge.run(ctx(X, '2026-09-30', ['2026-09']))).toBeNull()
    expect(await charges.run(ctx(X, '2026-09-30', ['2026-09']))).toBeNull()
  })
})

describe('the head office and its companies wait for the recharge', () => {
  it('payroll not locked + cost not recharged blocks the head office and the company with a share', async () => {
    const ho = await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))
    expect(ho?.key).toBe('head_office_recharge')
    expect(ho?.months).toEqual(['2026-09'])
    expect(ho?.cents).toBe(10_000_000)
    expect(ho?.detail).toContain('payroll for the month is not locked')
    expect(ho?.detail).toContain('not fully recharged')
    const co = await charges.run(ctx(C1, '2026-09-30', ['2026-09']))
    expect(co?.key).toBe('head_office_charges')
    expect(co?.detail).toContain('GS Head Office')
    // C3 is linked but has no share: never blocked.
    expect(await charges.run(ctx(C3, '2026-09-30', ['2026-09']))).toBeNull()
  })

  it('an open run still blocks', async () => {
    await prisma.hrPayrollRun.create({ data: { tenantId: HO, period: '2026-09', status: 'locked', settings: {} } })
    const id = await runMonth('2026-09')
    const ho = await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))
    expect(ho?.detail).toContain('still open')
    expect(ho?.detail).not.toContain('payroll for the month is not locked')
    expect(await charges.run(ctx(C1, '2026-09-30', ['2026-09']))).not.toBeNull()
    const ok = await call('POST', `/${id}/approve`, { acknowledgeWarnings: true })
    expect(ok.statusCode).toBe(200)
  })

  it('once recharged, both close', async () => {
    expect(await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))).toBeNull()
    expect(await charges.run(ctx(C1, '2026-09-30', ['2026-09']))).toBeNull()
  })

  it('drift after posting blocks again until a true-up', async () => {
    await cost(HO, '2026-09-28', '6070', 250_000)
    const ho = await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))
    expect(ho?.cents).toBe(250_000)
    expect(await charges.run(ctx(C1, '2026-09-30', ['2026-09']))).not.toBeNull()
    const id = await runMonth('2026-09')
    expect((await call('POST', `/${id}/approve`, { acknowledgeWarnings: true })).statusCode).toBe(200)
    expect(await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))).toBeNull()
  })

  it('a zero-cost month closes with no run (payroll locked)', async () => {
    await prisma.hrPayrollRun.create({ data: { tenantId: HO, period: '2026-08', status: 'locked', settings: {} } })
    expect(await recharge.run(ctx(HO, '2026-08-31', ['2026-08']))).toBeNull()
    expect(await charges.run(ctx(C1, '2026-08-31', ['2026-08']))).toBeNull()
    expect(await prisma.rechargeRun.count({ where: { tenantId: HO, period: '2026-08' } })).toBe(0)
  })

  it('a lock in the middle of a month does not ask for that month', async () => {
    expect(await recharge.run(ctx(HO, '2026-10-10', ['2026-10']))).toBeNull()
    expect(await charges.run(ctx(C1, '2026-10-10', ['2026-10']))).toBeNull()
  })

  it('months before the cutover never block (July has cost and no run)', async () => {
    expect(await recharge.run(ctx(HO, '2026-07-31', ['2026-07']))).toBeNull()
    expect(await charges.run(ctx(C1, '2026-07-31', ['2026-07']))).toBeNull()
  })

  it('the close status route answers the same for the company', async () => {
    await cost(HO, '2026-09-29', '6070', 1_000)
    const res = await call('GET', `/close-status?tenantId=${C1}&through=2026-09-30`)
    expect(res.statusCode).toBe(200)
    expect(res.json().ready).toBe(false)
    expect(res.json().charges[0].period).toBe('2026-09')
  })

  it('recharge switched off: nothing blocks', async () => {
    await prisma.$transaction((t) => setRecharge(t, HO, { enabled: false }, users.ceo!.id))
    expect(await recharge.run(ctx(HO, '2026-09-30', ['2026-09']))).toBeNull()
    expect(await charges.run(ctx(C1, '2026-09-30', ['2026-09']))).toBeNull()
  })
})
