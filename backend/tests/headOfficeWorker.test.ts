// The head-office recharge worker (D1 spec §4.9): runHeadOfficeRechargeTick(now)
// with a fixed clock.
//
//   HA  head office (one employee, payroll required) serving CA 100%
//   HB  head office (no employees) serving CB 50%
//   HC  head office with recharge OFF — never touched
//
// It prepares and submits as 'system' once a month is ready, makes one run per
// (head office, month) over any number of ticks, never posts, leaves a rejected
// month alone, raises recharge_missing once (day ≥ 5), and raises / resolves
// recharge_drift once a day after 06:00 PKT with a true-up prepared.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
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
import { createHeadOffice, linkCompany } from '../src/modules/headOffices/service.js'
import { createSplitVersion } from '../src/modules/headOffices/splits.js'
import { confirmBooks, setRecharge } from '../src/modules/headOffices/books.js'
import { headOfficeHealth } from '../src/modules/headOffices/health.js'
import { rechargeRunRoutes } from '../src/modules/headOffices/runRoutes.js'
import { runHeadOfficeRechargeTick, resetHeadOfficeRechargeDailyMark } from '../src/workers/headOfficeRecharge.js'

const P = `how-${Date.now()}`
const BASE = '/accounting/intercompany/recharge-runs'
let app: FastifyInstance
let HA: string, HB: string, HC: string, CA: string, CB: string
const users: Record<string, { id: string; token: string }> = {}

/** 6 Oct 2026, 08:00 PKT (day 6, after 06:00). */
const DAY6 = new Date('2026-10-06T08:00:00+05:00')
/** 3 Oct 2026, 08:00 PKT (before day 5). */
const DAY3 = new Date('2026-10-03T08:00:00+05:00')

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

async function cost(tenantId: string, date: string, cents: number) {
  await postJournalEntry({
    tenantId, sourceType: 'test.cost', sourceId: randomUUID(), description: 'test cost',
    entryDate: new Date(`${date}T12:00:00+05:00`), postedBy: 'system',
    lines: [{ accountCode: '6010', type: 'debit', amountCents: cents }, { accountCode: '1010', type: 'credit', amountCents: cents }],
  })
}

const runsOf = (hoId: string) => prisma.rechargeRun.findMany({ where: { tenantId: hoId, period: '2026-09' }, orderBy: { createdAt: 'asc' } })
const flags = (kind: string, tenantId: string, status?: 'open' | 'resolved') =>
  prisma.exceptionFlag.findMany({ where: { kind, tenantId, ...(status && { status }) } })

beforeAll(async () => {
  CA = await tenant('Company A')
  CB = await tenant('Company B')
  for (const t of [CA, CB]) await prisma.account.createMany({ data: [{ tenantId: t, code: '1010', name: 'Cash on Hand', type: 'asset' }] })
  await mkUser('ceo', 'admin', CA, [CA, CB])
  const ceo = users.ceo!.id
  HA = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'Head Office A', actorId: ceo }), { timeout: 30_000 })).id
  HB = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'Head Office B', actorId: ceo }), { timeout: 30_000 })).id
  HC = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'Head Office C', actorId: ceo }), { timeout: 30_000 })).id
  await prisma.$transaction(async (t) => {
    await linkCompany(t, { hoId: HA, companyId: CA, actorId: ceo })
    await linkCompany(t, { hoId: HB, companyId: CB, actorId: ceo })
    await linkCompany(t, { hoId: HC, companyId: CA, actorId: ceo })
    await createSplitVersion(t, { hoId: HA, effectiveFrom: '2026-09', lines: [{ companyTenantId: CA, shareBps: 10_000 }], actorId: ceo })
    await createSplitVersion(t, { hoId: HB, effectiveFrom: '2026-09', lines: [{ companyTenantId: CB, shareBps: 5000 }], actorId: ceo })
    await createSplitVersion(t, { hoId: HC, effectiveFrom: '2026-09', lines: [{ companyTenantId: CA, shareBps: 10_000 }], actorId: ceo })
    for (const h of [HA, HB]) {
      await confirmBooks(t, h, { note: 'CA confirmed the accounts', taxAnswer: 'No tax on the recharge — CA confirmed' }, ceo)
      await setRecharge(t, h, { enabled: true, fromPeriod: '2026-09' }, ceo)
    }
  }, { timeout: 30_000 })
  await prisma.hrEmployee.create({ data: { tenantId: HA, employeeCode: 'HO-0001', fullName: 'Head of Finance' } })
  await cost(HA, '2026-09-10', 10_000_000)
  await cost(HB, '2026-09-10', 4_000_000)
  await cost(HC, '2026-09-10', 9_000_000)

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

beforeEach(() => resetHeadOfficeRechargeDailyMark())

describe('preparing and submitting', () => {
  it('health is warn-free before anything runs; recharge OFF head offices are left alone', async () => {
    const h = await headOfficeHealth(DAY3)
    expect(h.status).toBe('ok')
    expect(h.counts.rechargeOn).toBe(2)
    expect(JSON.stringify(h)).not.toContain('Head Office')
  })

  it('a month whose payroll is not locked gets no run; recharge_missing waits for day 5', async () => {
    const r = await runHeadOfficeRechargeTick(DAY3)
    expect(r.headOffices).toBe(2)
    expect(await runsOf(HA)).toHaveLength(0)
    expect(await flags('recharge_missing', HA)).toHaveLength(0)
    // HB has no payroll to wait for: prepared and submitted as the worker.
    const hb = await runsOf(HB)
    expect(hb).toHaveLength(1)
    expect(hb[0]!.status).toBe('submitted')
    expect(hb[0]!.preparedById).toBeNull()
    expect(hb[0]!.submittedById).toBeNull()
    expect(await runsOf(HC)).toHaveLength(0)
  })

  it('from day 5 recharge_missing is raised once', async () => {
    await runHeadOfficeRechargeTick(DAY6)
    await runHeadOfficeRechargeTick(DAY6)
    const f = await flags('recharge_missing', HA, 'open')
    expect(f).toHaveLength(1)
    expect(f[0]!.entityId).toBe(`${HA}:2026-09`)
    expect(await runsOf(HA)).toHaveLength(0)
  })

  it('once payroll is locked the run is made — one per month, however many ticks', async () => {
    await prisma.hrPayrollRun.create({ data: { tenantId: HA, period: '2026-09', status: 'locked', settings: {} } })
    await runHeadOfficeRechargeTick(DAY6)
    await runHeadOfficeRechargeTick(DAY6)
    const ha = await runsOf(HA)
    expect(ha).toHaveLength(1)
    expect(ha[0]!.status).toBe('submitted')
    expect(await runsOf(HB)).toHaveLength(1)
  })

  it('never posts', async () => {
    expect(await prisma.intercompanyTransfer.count()).toBe(0)
    expect(await prisma.rechargeRun.count({ where: { status: 'posted' } })).toBe(0)
  })
})

describe('a person decides', () => {
  it('a rejected month is left alone', async () => {
    const [run] = await runsOf(HA)
    const rej = await call('POST', `/${run!.id}/reject`, { note: 'Wait for the rent invoice' })
    expect(rej.statusCode).toBe(200)
    await cost(HA, '2026-09-20', 500_000)
    await runHeadOfficeRechargeTick(DAY6)
    const ha = await runsOf(HA)
    expect(ha).toHaveLength(1)
    expect(ha[0]!.status).toBe('rejected')
    // Still not recharged: the missing flag stays (one).
    expect(await flags('recharge_missing', HA, 'open')).toHaveLength(1)
  })
})

describe('drift', () => {
  it('after approval the month is ready; a later cost raises recharge_drift once and a true-up is prepared', async () => {
    const [run] = await runsOf(HB)
    const ok = await call('POST', `/${run!.id}/approve`, { acknowledgeWarnings: true })
    expect(ok.statusCode).toBe(200)
    await runHeadOfficeRechargeTick(DAY6)
    expect(await flags('recharge_drift', HB)).toHaveLength(0)

    await cost(HB, '2026-09-25', 200_000)
    // The next day's first tick after 06:00 (the drift check runs once a day).
    resetHeadOfficeRechargeDailyMark()
    await runHeadOfficeRechargeTick(DAY6)
    expect(await flags('recharge_drift', HB, 'open')).toHaveLength(1)
    let hb = await runsOf(HB)
    expect(hb).toHaveLength(2)
    expect(hb[1]!.kind).toBe('true_up')
    expect(hb[1]!.status).toBe('submitted')
    expect(Number(hb[1]!.baseCents)).toBe(200_000)

    // Another tick the same day: no second flag, no second true-up.
    resetHeadOfficeRechargeDailyMark()
    await runHeadOfficeRechargeTick(DAY6)
    expect(await flags('recharge_drift', HB, 'open')).toHaveLength(1)
    expect(await runsOf(HB)).toHaveLength(2)

    // Approve the true-up: the next daily check resolves the flag.
    const t = await call('POST', `/${hb[1]!.id}/approve`, { acknowledgeWarnings: true })
    expect(t.statusCode).toBe(200)
    resetHeadOfficeRechargeDailyMark()
    await runHeadOfficeRechargeTick(DAY6)
    expect(await flags('recharge_drift', HB, 'open')).toHaveLength(0)
    expect(await flags('recharge_drift', HB, 'resolved')).toHaveLength(1)
    hb = await runsOf(HB)
    expect(hb).toHaveLength(2)
  })

  it('the drift check runs once a day, after 06:00 PKT', async () => {
    await cost(HB, '2026-09-26', 100_000)
    // 05:00 PKT: no drift check — but the true-up rule still prepares the run.
    await runHeadOfficeRechargeTick(new Date('2026-10-07T05:00:00+05:00'))
    expect(await flags('recharge_drift', HB, 'open')).toHaveLength(0)
    await runHeadOfficeRechargeTick(new Date('2026-10-07T06:30:00+05:00'))
    expect(await flags('recharge_drift', HB, 'open')).toHaveLength(1)
  })

  it('health warns (counts only) when a recharge-on head office missed its last month after day 10', async () => {
    const h = await headOfficeHealth(new Date('2026-10-12T08:00:00+05:00'))
    expect(h.status).toBe('warn')
    expect(h.counts.lastMonthNotReady).toBe(2)
    expect(h.detail).not.toContain('Head Office')
  })
})
