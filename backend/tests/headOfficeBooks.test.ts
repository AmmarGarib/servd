// Head-office recharge runs (D1 spec §4.1, §4.3–§4.5, §12 "Stream A" adapted to
// the inter-company engine; amendments A7–A10, A19) on Fastify inject through
// the real auth middleware.
//
//   HO  a head office serving C1 (60%) and C2 (30%) — 10% stays with the HO
//   X   a company with nothing to do with HO (company separation)
//
//   ceo    admin, member of C1, C2 (and HO, which it creates)
//   fin    finance, member of HO      (preparer)
//   fin2   finance, member of HO      (preparer / editor)
//   fin3   finance, member of HO      (the head-office-wide Finance delegate who approves)
//   c1fin  finance, member of C1 only (a served company's viewer)
//   bfin   finance, member of X only  (foreign: 404 everywhere)
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
import { toCents } from '../src/lib/money.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../src/modules/accounting/dates.js'
import { pairBalances } from '../src/modules/intercompany/accounts.js'
import { createHeadOffice, linkCompany } from '../src/modules/headOffices/service.js'
import { createSplitVersion, splitByBps } from '../src/modules/headOffices/splits.js'
import { confirmBooks, setRecharge } from '../src/modules/headOffices/books.js'
import { computePool } from '../src/modules/headOffices/pool.js'
import { runInvariants } from '../src/modules/headOffices/reconciliation.js'
import { rechargeRunRoutes } from '../src/modules/headOffices/runRoutes.js'

const P = `hob-${Date.now()}`
const BASE = '/accounting/intercompany/recharge-runs'
let app: FastifyInstance
let HO: string, C1: string, C2: string, X: string
const users: Record<string, { id: string; token: string }> = {}

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

type Method = 'GET' | 'POST'
function call(who: string, method: Method, url: string, payload?: unknown) {
  return app.inject({
    method, url: `/api/v1${BASE}${url}`,
    headers: { authorization: `Bearer ${users[who]!.token}` },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

/** A cost in a company's books: Dr `code` / Cr 1010 (or the reverse for a negative amount), dated midday PKT. */
async function cost(tenantId: string, date: string, accountCode: string, cents: number) {
  const dr = cents > 0
  await postJournalEntry({
    tenantId, sourceType: 'test.cost', sourceId: randomUUID(), description: `test cost ${accountCode}`,
    entryDate: new Date(`${date}T12:00:00+05:00`), postedBy: 'system',
    lines: [
      { accountCode, type: dr ? 'debit' : 'credit', amountCents: Math.abs(cents) },
      { accountCode: '1010', type: dr ? 'credit' : 'debit', amountCents: Math.abs(cents) },
    ],
  })
}

/** The head office's net cost for a month: expense − revenue (the recharge is income on 4220, HO-Q3). */
async function hoPnl(period: string) {
  const [y, m] = period.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId: HO, type: { in: ['expense', 'revenue'] } }, journalEntry: { tenantId: HO, entryDate: { gte: parsePktStartOfDay(`${period}-01`), lte: parsePktEndOfDay(`${period}-${last}`) } } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * toCents(l.amountCents), 0)
}

async function transfersOf(runId: string) {
  const lines = await prisma.rechargeRunLine.findMany({ where: { runId }, select: { transferId: true } })
  return prisma.intercompanyTransfer.findMany({ where: { id: { in: lines.map((l) => l.transferId).filter((x): x is string => !!x) } } })
}

async function expectBalanced(entryId: string) {
  const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: true } })
  const dr = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + toCents(l.amountCents), 0)
  const cr = e.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + toCents(l.amountCents), 0)
  expect(dr).toBe(cr)
  return e
}

beforeAll(async () => {
  C1 = await tenant('Company One')
  C2 = await tenant('Company Two')
  X = await tenant('Company X')
  for (const t of [C1, C2, X]) {
    await prisma.account.createMany({
      data: [
        { tenantId: t, code: '1010', name: 'Cash on Hand', type: 'asset' },
        { tenantId: t, code: '6010', name: 'Rent', type: 'expense' },
        { tenantId: t, code: '6990', name: 'Costs Recharged to Group Companies', type: 'expense' },
      ],
    })
  }
  await mkUser('ceo', 'admin', C1, [C1, C2])
  const ceo = users.ceo!.id
  HO = (await prisma.$transaction((t) => createHeadOffice(t, { name: 'GS Head Office', actorId: ceo }), { timeout: 30_000 })).id
  await prisma.$transaction(async (t) => {
    await linkCompany(t, { hoId: HO, companyId: C1, actorId: ceo })
    await linkCompany(t, { hoId: HO, companyId: C2, actorId: ceo })
    await createSplitVersion(t, { hoId: HO, effectiveFrom: '2026-08', lines: [{ companyTenantId: C1, shareBps: 6000 }, { companyTenantId: C2, shareBps: 3000 }], actorId: ceo })
  }, { timeout: 30_000 })
  await mkUser('fin', 'finance', HO, [HO])
  await mkUser('fin2', 'finance', HO, [HO])
  await mkUser('fin3', 'finance', HO, [HO])
  await mkUser('c1fin', 'finance', C1, [C1])
  await mkUser('bfin', 'finance', X, [X])

  // One head-office employee: payroll must be locked before a run is submitted.
  await prisma.hrEmployee.create({ data: { tenantId: HO, employeeCode: 'HO-0001', fullName: 'Head of Finance' } })
  await prisma.hrPayrollRun.create({ data: { tenantId: HO, period: '2026-08', status: 'locked', settings: {} } })

  // September: wages 800,000 + rent 150,000 + software 50,000 = PKR 1,000,000.
  await cost(HO, '2026-09-10', '6032', 80_000_000)
  await cost(HO, '2026-09-10', '6010', 15_000_000)
  await cost(HO, '2026-09-11', '6070', 5_000_000)
  // Never in September's pool: October's cost, and a line on the recharge account itself (A9).
  await cost(HO, '2026-10-02', '6010', 7_000_000)
  await cost(HO, '2026-09-12', '6990', 1_234_500)
  // August: PKR 500,000.
  await cost(HO, '2026-08-15', '6010', 50_000_000)

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(rechargeRunRoutes, { prefix: BASE })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 90_000)

afterAll(async () => {
  await app?.close()
})

let sept: string

describe('pool, preview and prepare', () => {
  it('the pool is the head office expense of the PKT month, never the recharge account or another month', async () => {
    const p = await computePool(prisma, HO, '2026-09')
    expect(p.poolCents).toBe(100_000_000)
    expect(p.basis.map((b) => [b.code, b.netCents])).toEqual([['6010', 15_000_000], ['6032', 80_000_000], ['6070', 5_000_000]])
  })

  it('preview gives the basis, the lines and what the head office keeps', async () => {
    const res = await call('fin', 'GET', `/preview?headOfficeId=${HO}&period=2026-09`)
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.kind).toBe('monthly')
    expect(b.baseCents).toBe(100_000_000)
    expect(b.rechargedCents).toBe(90_000_000)
    expect(b.retainedCents).toBe(10_000_000)
    const byCo = Object.fromEntries(b.lines.map((l: { companyTenantId: string; amountCents: number }) => [l.companyTenantId, l.amountCents]))
    expect(byCo).toEqual({ [C1]: 60_000_000, [C2]: 30_000_000 })
    expect(b.warnings.join(' ')).toContain('10.00% stays with the head office')
    expect(await prisma.rechargeRun.count({ where: { tenantId: HO } })).toBe(0)
  })

  it('rounding is exact: 100,001 paisa over 3 × 33.33% leaves 2 paisa with the head office', () => {
    const lines = splitByBps(100_001, [{ companyTenantId: 'a', shareBps: 3333 }, { companyTenantId: 'b', shareBps: 3333 }, { companyTenantId: 'c', shareBps: 3333 }])
    expect(lines.map((l) => l.amountCents)).toEqual([33_330, 33_330, 33_330])
    expect(100_001 - lines.reduce((s, l) => s + l.amountCents, 0)).toBe(11)
  })

  it('a month not over yet is refused', async () => {
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-10' })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('PERIOD_NOT_OVER')
  })

  it('a preparer prepares; a second open run for the month is refused', async () => {
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(res.statusCode).toBe(201)
    const run = res.json()
    sept = run.id
    expect(run.status).toBe('draft')
    expect(run.kind).toBe('monthly')
    expect(run.preparedByIds).toEqual([users.fin!.id])
    expect(run.lines).toHaveLength(2)
    const again = await call('fin2', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(again.statusCode).toBe(409)
    expect(code(again)).toBe('RUN_OPEN')
  })

  it('a company-only or foreign user cannot prepare for the head office (404)', async () => {
    expect((await call('c1fin', 'POST', '/', { headOfficeId: HO, period: '2026-08' })).statusCode).toBe(404)
    expect((await call('bfin', 'POST', '/', { headOfficeId: HO, period: '2026-08' })).statusCode).toBe(404)
  })
})

describe('submit is refused until everything is in place', () => {
  it('books confirmed → recharge on → cutover → payroll locked', async () => {
    let res = await call('fin', 'POST', `/${sept}/submit`)
    expect(code(res)).toBe('ACCOUNTS_NOT_CONFIRMED')
    const ceo = users.ceo!.id
    await prisma.$transaction((t) => confirmBooks(t, HO, { note: 'CA confirmed the accounts', taxAnswer: 'No tax on the recharge — CA confirmed' }, ceo))
    res = await call('fin', 'POST', `/${sept}/submit`)
    expect(code(res)).toBe('RECHARGE_OFF')
    await prisma.$transaction((t) => setRecharge(t, HO, { enabled: true, fromPeriod: '2026-10' }, ceo))
    res = await call('fin', 'POST', `/${sept}/submit`)
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('BEFORE_CUTOVER')
    await prisma.$transaction((t) => setRecharge(t, HO, { enabled: true, fromPeriod: '2026-08' }, ceo))
    res = await call('fin', 'POST', `/${sept}/submit`)
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('PAYROLL_NOT_LOCKED')
    await prisma.hrPayrollRun.create({ data: { tenantId: HO, period: '2026-09', status: 'locked', settings: {} } })
    res = await call('fin', 'POST', `/${sept}/submit`)
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('submitted')
  })
})

describe('approve', () => {
  it('a company-only user may not approve (403); nothing posts', async () => {
    const res = await call('c1fin', 'POST', `/${sept}/approve`, { acknowledgeWarnings: true })
    expect(res.statusCode).toBe(403)
    expect(await prisma.intercompanyTransfer.count({ where: { source: 'ho_recharge' } })).toBe(0)
  })

  it('warnings must be acknowledged', async () => {
    const res = await call('ceo', 'POST', `/${sept}/approve`, {})
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('WARNINGS_NOT_ACKNOWLEDGED')
  })

  it('posts one transfer per company in both books; the head office keeps only its retained share; drift is reported', async () => {
    // A cost lands after submission: the approval reports the drift (a true-up follows).
    await cost(HO, '2026-09-20', '6070', 100_000)
    const res = await call('ceo', 'POST', `/${sept}/approve`, { acknowledgeWarnings: true })
    expect(res.statusCode).toBe(200)
    const run = res.json()
    expect(run.status).toBe('posted')
    expect(run.driftCents).toBe(100_000)
    expect(run.notice).toContain('true-up')
    expect(run.driftAtApprovalCents).toBe(100_000)

    const transfers = await transfersOf(sept)
    expect(transfers).toHaveLength(2)
    for (const t of transfers) {
      expect(t.source).toBe('ho_recharge')
      expect(t.status).toBe('posted')
      expect(t.counterpartyTenantId).toBe(HO)
      const d = await expectBalanced(t.debtorEntryId!)
      const c = await expectBalanced(t.creditorEntryId!)
      expect(d.reference).toBe(`ic.transfer:${t.id}`)
      expect(c.reference).toBe(`ic.transfer:${t.id}`)
      expect(d.tenantId).toBe(t.tenantId)
      expect(c.tenantId).toBe(HO)
      expect(d.entryDate.toISOString()).toBe(new Date('2026-09-30T23:59:00+05:00').toISOString())
      // HO-Q3 (owner, 2026-10-26): the head office books the recharge as INCOME —
      // Cr 4220 Head Office Recharge Income, and nothing on 6990.
      const hoLines = await prisma.journalLine.findMany({ where: { journalEntryId: c.id }, include: { account: { select: { code: true, type: true } } } })
      const credit = hoLines.filter((l) => l.type === 'credit')
      expect(credit.map((l) => [l.account.code, l.account.type, toCents(l.amountCents)])).toEqual([['4220', 'revenue', t.amountCents]])
      expect(hoLines.some((l) => l.account.code === '6990')).toBe(false)
      expect(t.creditorAccountCode).toBe('4220')
    }
    const c1 = await pairBalances(prisma, HO, C1)
    expect(c1.aDueFromB).toBe(60_000_000)
    expect(c1.bDueToA).toBe(60_000_000)
    expect(c1.mismatchCents).toBe(0)
    expect((await pairBalances(prisma, HO, C2)).aDueFromB).toBe(30_000_000)
    // The head office's September P&L = what it keeps (+ the late cost, not recharged yet,
    // + the stray 6990 line the fixture put outside the pool on purpose).
    expect(await hoPnl('2026-09')).toBe(10_000_000 + 100_000 + 1_234_500)
    const inv = await runInvariants(sept)
    expect(inv.problems).toEqual([])
    // Audited in the head office and both companies — never another company (A19).
    const audits = await prisma.auditLog.findMany({ where: { action: 'ho.recharge.approve', entityId: sept }, select: { tenantId: true } })
    expect(audits.map((a) => a.tenantId).sort()).toEqual([HO, C1, C2].sort())
    const decided = await prisma.auditLog.findMany({ where: { action: 'approval.decide', entityId: sept }, select: { tenantId: true } })
    expect(decided.map((a) => a.tenantId)).toEqual([HO])
  })

  it('a second approval is refused and posts nothing', async () => {
    const res = await call('ceo', 'POST', `/${sept}/approve`, { acknowledgeWarnings: true })
    expect(res.statusCode).toBe(409)
    expect(code(res)).toBe('RUN_NOT_PENDING')
    expect(await prisma.intercompanyTransfer.count({ where: { source: 'ho_recharge' } })).toBe(2)
  })
})

describe('August: stale on submit, and two approvals at once post once', () => {
  it('a run whose month moved is stale until refreshed', async () => {
    const res = await call('ceo', 'POST', '/', { headOfficeId: HO, period: '2026-08' })
    expect(res.statusCode).toBe(201)
    const id = res.json().id
    await cost(HO, '2026-08-20', '6010', 1_000_000)
    const s1 = await call('ceo', 'POST', `/${id}/submit`)
    expect(s1.statusCode).toBe(409)
    expect(code(s1)).toBe('RUN_STALE')
    expect((await prisma.rechargeRun.findUniqueOrThrow({ where: { id } })).stale).toBe(true)
    const r = await call('ceo', 'POST', `/${id}/refresh`)
    expect(r.statusCode).toBe(200)
    expect(r.json().baseCents).toBe(51_000_000)
    expect(r.json().stale).toBe(false)
    expect((await call('ceo', 'POST', `/${id}/submit`)).statusCode).toBe(200)

    const [a, b] = await Promise.all([
      call('ceo', 'POST', `/${id}/approve`, { acknowledgeWarnings: true }),
      call('ceo', 'POST', `/${id}/approve`, { acknowledgeWarnings: true }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(await transfersOf(id)).toHaveLength(2)
    expect(await prisma.intercompanyTransfer.count({ where: { source: 'ho_recharge', period: '2026-08' } })).toBe(2)
  })
})

let posTrueUp: string
let negTrueUp: string

describe('true-ups and closed books', () => {
  it('a positive true-up; a closed company book refuses the whole run, naming it', async () => {
    await prisma.periodLock.create({ data: { tenantId: C2, lockedThrough: parsePktEndOfDay('2026-09-30'), lockedBy: users.ceo!.id } })
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(res.statusCode).toBe(201)
    const run = res.json()
    posTrueUp = run.id
    expect(run.kind).toBe('true_up')
    expect(run.priorCents).toBe(100_000_000)
    expect(run.baseCents).toBe(100_000)
    expect(run.lines.map((l: { amountCents: number }) => l.amountCents).sort()).toEqual([30_000, 60_000])
    expect(run.warnings.join(' ')).toContain("Company Two's books are closed")
    expect((await call('fin', 'POST', `/${posTrueUp}/submit`)).statusCode).toBe(200)

    const before = await prisma.intercompanyTransfer.count()
    const locked = await call('ceo', 'POST', `/${posTrueUp}/approve`, { acknowledgeWarnings: true })
    expect(locked.statusCode).toBe(409)
    expect(code(locked)).toBe('PERIOD_LOCKED_IN')
    const books = (locked.json() as { error: { details: { books: Array<{ tenantId: string; name: string }> } } }).error.details.books
    expect(books.map((b) => b.name)).toEqual(['Company Two'])
    expect(await prisma.intercompanyTransfer.count()).toBe(before)
    expect((await prisma.rechargeRun.findUniqueOrThrow({ where: { id: posTrueUp } })).status).toBe('submitted')
  })

  it('postInOpenPeriod dates each PAIR on its own: C1 on 30 Sep, C2 on the first day open', async () => {
    const res = await call('ceo', 'POST', `/${posTrueUp}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(res.statusCode).toBe(200)
    const lines = await prisma.rechargeRunLine.findMany({ where: { runId: posTrueUp }, include: { transfer: true } })
    const l1 = lines.find((l) => l.companyTenantId === C1)!
    const l2 = lines.find((l) => l.companyTenantId === C2)!
    expect(l1.postedLate).toBe(false)
    expect(l1.entryDate!.toISOString()).toBe(new Date('2026-09-30T23:59:00+05:00').toISOString())
    expect(l2.postedLate).toBe(true)
    expect(l2.memoNote).toContain('posted late')
    expect(l2.entryDate!.getTime()).toBeGreaterThanOrEqual(parsePktStartOfDay('2026-10-01').getTime())
    for (const l of [l1, l2]) {
      const d = await prisma.journalEntry.findUniqueOrThrow({ where: { id: l.transfer!.debtorEntryId! } })
      const c = await prisma.journalEntry.findUniqueOrThrow({ where: { id: l.transfer!.creditorEntryId! } })
      expect(d.entryDate.toISOString()).toBe(c.entryDate.toISOString())
      expect(d.entryDate.toISOString()).toBe(l.entryDate!.toISOString())
    }
    expect((await runInvariants(posTrueUp)).problems).toEqual([])
  })

  it('a negative true-up credits the companies (the head office is the debtor)', async () => {
    await cost(HO, '2026-09-25', '6010', -500_000)
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(res.statusCode).toBe(201)
    negTrueUp = res.json().id
    expect(res.json().baseCents).toBe(-500_000)
    expect(res.json().warnings.join(' ')).toContain('negative')
    expect((await call('fin', 'POST', `/${negTrueUp}/submit`)).statusCode).toBe(200)
    const beforeC1 = await pairBalances(prisma, HO, C1)
    const ok = await call('ceo', 'POST', `/${negTrueUp}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(ok.statusCode).toBe(200)
    const transfers = await transfersOf(negTrueUp)
    expect(transfers).toHaveLength(2)
    for (const t of transfers) expect(t.tenantId).toBe(HO)
    const afterC1 = await pairBalances(prisma, HO, C1)
    expect(afterC1.netOwedByA - beforeC1.netOwedByA).toBe(300_000)
    expect(afterC1.mismatchCents).toBe(0)
    expect((await runInvariants(negTrueUp)).problems).toEqual([])
    // Every posted run's retained share is what the head office keeps.
    const posted = await prisma.rechargeRun.findMany({ where: { tenantId: HO, period: '2026-09', status: 'posted' } })
    const retained = posted.reduce((s, r) => s + toCents(r.retainedCents), 0)
    expect(retained).toBe(10_000_000 + 10_000 - 50_000)
  })
})

describe('reverse (CEO only)', () => {
  it('a non-CEO gets 403; the CEO restores both books', async () => {
    expect((await call('fin', 'POST', `/${negTrueUp}/reverse`, { reason: 'Wrong credit note booked' })).statusCode).toBe(403)
    const short = await call('ceo', 'POST', `/${negTrueUp}/reverse`, { reason: 'short' })
    expect(short.statusCode).toBe(400)
    const before = await pairBalances(prisma, HO, C1)
    const res = await call('ceo', 'POST', `/${negTrueUp}/reverse`, { reason: 'Wrong credit note booked in September' })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('reversed')
    const after = await pairBalances(prisma, HO, C1)
    expect(after.netOwedByA - before.netOwedByA).toBe(-300_000)
    expect(after.mismatchCents).toBe(0)
    for (const t of await transfersOf(negTrueUp)) expect(t.status).toBe('reversed')
    expect((await runInvariants(negTrueUp)).problems).toEqual([])
  })

  it('a reversal withdraws the open runs of the month; a run built on the old prior is stale', async () => {
    // The month drifts again (the negative true-up was reversed).
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(res.statusCode).toBe(201)
    const t = res.json().id
    expect((await call('fin', 'POST', `/${t}/submit`)).statusCode).toBe(200)
    const rev = await call('ceo', 'POST', `/${posTrueUp}/reverse`, { reason: 'True-up booked against the wrong month' })
    expect(rev.statusCode).toBe(200)
    expect(rev.json().withdrawnRunIds).toEqual([t])
    const w = await prisma.rechargeRun.findUniqueOrThrow({ where: { id: t } })
    expect(w.status).toBe('withdrawn')
    expect(w.decisionNote).toBe('superseded by reversal')
    // A race the reversal lost: the run is still submitted, but its prior is gone (A8).
    await prisma.rechargeRun.update({ where: { id: t }, data: { status: 'submitted' } })
    const stale = await call('ceo', 'POST', `/${t}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(stale.statusCode).toBe(409)
    expect(code(stale)).toBe('RUN_STALE')
    await prisma.rechargeRun.update({ where: { id: t }, data: { status: 'withdrawn' } })
  })
})

describe('separation of duties (A7)', () => {
  it('an editor or the preparer cannot approve; another head-office Finance delegate can', async () => {
    for (const who of ['fin', 'fin2', 'fin3']) {
      await prisma.approvalDelegation.create({ data: { tenantId: HO, section: 'finance', delegateUserId: users[who]!.id, grantedById: users.ceo!.id } })
    }
    const res = await call('fin', 'POST', '/', { headOfficeId: HO, period: '2026-09' })
    expect(res.statusCode).toBe(201)
    const id = res.json().id
    // fin2 edits (refresh), fin submits.
    expect((await call('fin2', 'POST', `/${id}/refresh`)).statusCode).toBe(200)
    expect((await call('fin', 'POST', `/${id}/submit`)).statusCode).toBe(200)
    const editor = await call('fin2', 'POST', `/${id}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(editor.statusCode).toBe(403)
    expect(code(editor)).toBe('SELF_APPROVAL_BLOCKED')
    const preparer = await call('fin', 'POST', `/${id}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(preparer.statusCode).toBe(403)
    const ok = await call('fin3', 'POST', `/${id}/approve`, { acknowledgeWarnings: true, postInOpenPeriod: true })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().decidedVia).toBe('delegation')
    // A19: nothing lands in a company the run does not touch.
    const rows = await prisma.auditLog.findMany({ where: { entityId: id }, select: { tenantId: true } })
    for (const r of rows) expect([HO, C1, C2]).toContain(r.tenantId)
  })
})

describe('company separation', () => {
  it('a company outside the head office gets 404 on its runs and pairs', async () => {
    expect((await call('bfin', 'GET', `/${sept}`)).statusCode).toBe(404)
    expect((await call('bfin', 'GET', '/')).json().runs).toEqual([])
    expect((await call('bfin', 'POST', `/${sept}/approve`, { acknowledgeWarnings: true })).statusCode).toBe(404)
    expect((await call('bfin', 'POST', `/${sept}/reject`, { note: 'not mine' })).statusCode).toBe(404)
    expect((await call('bfin', 'GET', `/statement?headOfficeId=${HO}&companyId=${C1}`)).statusCode).toBe(404)
    expect((await call('bfin', 'GET', `/summary?headOfficeId=${HO}`)).statusCode).toBe(404)
  })

  it('a served company sees the run with its own line only, and its own pair statement', async () => {
    const res = await call('c1fin', 'GET', `/${sept}`)
    expect(res.statusCode).toBe(200)
    expect(res.json().lines.map((l: { companyTenantId: string }) => l.companyTenantId)).toEqual([C1])
    expect(res.json().basis).toHaveLength(3)
    expect((await call('c1fin', 'GET', `/statement?headOfficeId=${HO}&companyId=${C2}`)).statusCode).toBe(404)
    const st = await call('c1fin', 'GET', `/statement?headOfficeId=${HO}&companyId=${C1}&from=2026-08-01&to=2026-10-31`)
    expect(st.statusCode).toBe(200)
    const s = st.json()
    expect(s.openingCents).toBe(0)
    expect(s.differenceCents).toBe(0)
    expect(s.closingCents).toBe((await pairBalances(prisma, HO, C1)).aDueFromB - (await pairBalances(prisma, HO, C1)).aDueToB)
    expect(s.chargesCents).toBe(s.closingCents)
 
    // A5: C2's books are closed (the true-ups above), and the run's warning names
    // it — a C1-only viewer never reads C2's name or close date, nor the other
    // companies' share of the charge.
    const full = (await call('ceo', 'GET', `/${posTrueUp}`)).json()
    expect(full.warnings.join(' ')).toContain("Company Two's books are closed")
    expect(full.retainedCents).not.toBeNull()
    const own = await call('c1fin', 'GET', `/${posTrueUp}`)
    expect(own.statusCode).toBe(200)
    const v = own.json()
    expect(JSON.stringify(v.warnings)).not.toContain('Company Two')
    expect(v.warnings.some((w: string) => w.includes('Company Two'))).toBe(false)
    expect(v.lines.map((l: { companyTenantId: string }) => l.companyTenantId)).toEqual([C1])
    expect(v.rechargedCents).toBe(v.lines[0].amountCents)
    expect(v.rechargedCents).not.toBe(full.rechargedCents)
    expect(v.retainedCents).toBeNull()
    const listed = (await call('c1fin', 'GET', '/')).json().runs.find((r: { id: string }) => r.id === posTrueUp)
    expect(JSON.stringify(listed.warnings)).not.toContain('Company Two')
    expect(listed.rechargedCents).toBe(v.lines[0].amountCents)
    expect(listed.retainedCents).toBeNull()
  })

  it('the head office summary lists both companies with balances that agree', async () => {
    const res = await call('ceo', 'GET', `/summary?headOfficeId=${HO}`)
    expect(res.statusCode).toBe(200)
    const s = res.json()
    expect(s.companies.map((c: { companyTenantId: string }) => c.companyTenantId).sort()).toEqual([C1, C2].sort())
    for (const c of s.companies) expect(c.mismatchCents).toBe(0)
  })
})

