// Finance audit 2026-10-16 — books & close (group gl_close), with the owner's
// decision that finance re-posts refused postings in OPEN months:
//   9  allocation runs cover whole Pakistan days (YYYY-MM-DD only)
//   10 allocation splits only the SHARED (untagged) cost of the source account
//      + running a rule stays the CEO's (not among the jobs handed to finance);
//      a CEO login of company B only gets 404
//   11 resolving a flag needs the Exceptions module, an open flag and a 10+
//      character note; flags about the books are the CEO's and finance's; a
//      posting_failed flag closes only once its posting is on the books
//   38 nobody resolves the review flag of their own manual journal (CEO aside)
//   12 a trial_balance check that cannot run is never overridable
//   13 editing a journal reverses it on the ORIGINAL's date (today only when
//      that month is closed); GET /period-close tells the page what is reopened
//   27 finance runs Reconciliation → Backfill unposted; a real run while the
//      CEO has a month reopened stays the CEO's
//   39 the year-basis trial balance has no zero 'Retained earnings b/f' row
import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { fmtPktDate, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { reopenedThroughKey } from '../src/modules/accounting/closedBooks.js'
import { isOverridableKey, runChecks, CHECK_FAILED_PREFIX } from '../src/modules/accounting/closeChecks.js'
import { trialBalance } from '../src/modules/accounting/reports.js'
import { flagException } from '../src/lib/exceptions.js'
import { allocationRoutes } from '../src/modules/allocations/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'

let A: string
let B: string
let brandA1: string
let brandA2: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[], moduleDeny: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.glclose@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary, moduleDeny },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}`, ...headers },
  })

let n = 0
async function post(tenantId: string, at: Date, debit: string, credit: string, cents: number, conceptId: string | null = null, sourceType = 'test.gl') {
  const sourceId = `g${n++}`
  await postJournalEntry({ tenantId, sourceType, sourceId, description: 'Test', entryDate: at, lines: [
    { accountCode: debit, type: 'debit', amountCents: cents, conceptId }, { accountCode: credit, type: 'credit', amountCents: cents },
  ] })
  return `${sourceType}:${sourceId}`
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'GL Foods', slug: 'glc-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'GL Viva', slug: 'glc-b' } })).id
  for (const t of [A, B]) await ensureChartOfAccounts(t)
  brandA1 = (await prisma.concept.create({ data: { name: 'GL Cafe', slug: 'glc-cafe', type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  brandA2 = (await prisma.concept.create({ data: { name: 'GL Diner', slug: 'glc-diner', type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('ceo', 'admin', A, [A, B])
  await mkUser('ceoB', 'admin', B, [B])
  await mkUser('fin', 'finance', A, [A])
  await mkUser('fin2', 'finance', A, [A])
  await mkUser('finB', 'finance', B, [B])
  await mkUser('finNoAcc', 'finance', A, [A], ['accounting'])
  await mkUser('mgmt', 'management', A, [A])
  await mkUser('fnb', 'fnb_manager', A, [A])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(allocationRoutes, { prefix: '/allocations' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.ready()
}, 60_000)

// ─── 9 + 10: allocations ────────────────────────────────────────────────────

describe('allocations — whole Pakistan days, shared cost only, the CEO runs', () => {
  let ruleId: string
  beforeAll(async () => {
    // 31 January, 20:00 and 22:00 PKT (15:00Z / 17:00Z) — after the old
    // 05:00 PKT cut-off. 300k is already Cafe's own rent; 200k is shared.
    await post(A, new Date('2026-01-31T15:00:00Z'), '6010', '1020', 300_000, brandA1)
    await post(A, new Date('2026-01-31T17:00:00Z'), '6010', '1020', 200_000)
    ruleId = (await prisma.costAllocationRule.create({
      data: { tenantId: A, name: 'Rent split', sourceAccountCode: '6010', driver: 'fixed_pct', weights: { create: [{ conceptId: brandA1, weightBps: 5000 }, { conceptId: brandA2, weightBps: 5000 }] } },
    })).id
  })

  it('who may run: the CEO only; finance and ops managers are refused, company B\'s CEO gets 404', async () => {
    const body = { periodStart: '2026-01-01', periodEnd: '2026-01-31' }
    expect((await call('fnb', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('mgmt', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('fin', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(404)
    expect((await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-31' })).statusCode).toBe(400)
    expect(await prisma.costAllocationRun.count({ where: { ruleId } })).toBe(0)
  })

  it('the CEO runs January: the last day\'s evening is in, only the shared 200k is split, tagged cost is reported', async () => {
    const res = await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
    expect(res.statusCode, res.body).toBe(201)
    const out = res.json() as { runId: string; totalAmountCents: number; brandTaggedCents: number; allocations: Array<{ conceptId: string; amountCents: number }> }
    expect(out.totalAmountCents).toBe(200_000)
    expect(out.brandTaggedCents).toBe(300_000)
    expect(out.allocations.map((a) => a.amountCents).sort()).toEqual([100_000, 100_000])
    const run = await prisma.costAllocationRun.findUniqueOrThrow({ where: { id: out.runId } })
    expect(run.tenantId).toBe(A)
    expect(run.periodStart.toISOString()).toBe(new Date('2026-01-01T00:00:00+05:00').toISOString())
    expect(run.periodEnd.toISOString()).toBe(new Date('2026-01-31T23:59:59.999+05:00').toISOString())
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `allocation.run:${out.runId}` } })
    expect(je.tenantId).toBe(A)
    expect(fmtPktDate(je.entryDate)).toBe('2026-01-31')
    // Cafe carries its own 300k + its 100k share — never its 300k twice.
    const cafe = await prisma.journalLine.aggregate({ where: { conceptId: brandA1, account: { code: '6010', tenantId: A } }, _sum: { amountCents: true } })
    expect(Number(cafe._sum.amountCents)).toBe(400_000)
    const audited = await prisma.auditLog.findFirst({ where: { action: 'allocation.run', entityId: out.runId } })
    expect(audited?.userId).toBe(users['ceo']!.id)
  })

  it('February starts at 00:00 PKT 1 Feb — no overlap with January, nothing left to allocate', async () => {
    const res = await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-02-01', periodEnd: '2026-02-28' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('NOTHING_TO_ALLOCATE')
    const again = await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-31', periodEnd: '2026-02-05' })
    expect(again.json().error.code).toBe('RUN_OVERLAPS')
  })

  it('rules stay the CEO\'s', async () => {
    const res = await call('fin', 'POST', '/allocations/rules', { name: 'x', sourceAccountCode: '6020', driver: 'fixed_pct', weights: [{ conceptId: brandA1, weightBps: 10_000 }] })
    expect(res.statusCode).toBe(403)
  })
})

// ─── 11 + 38: exception flags ───────────────────────────────────────────────

describe('exception flags — who may resolve what', () => {
  const note = 'Checked and dealt with properly'
  let failed: string, ownJournal: string, ordinary: string, flagB: string
  let failedRef: string
  beforeAll(async () => {
    failedRef = `test.refused:${crypto.randomUUID()}`
    const [st, sid] = failedRef.split(':') as [string, string]
    failed = (await flagException({ tenantId: A, kind: 'posting_failed', severity: 'high', title: 'Refused', description: 'x', entityType: 'Order', entityId: crypto.randomUUID(), metadata: { sourceType: st, sourceId: sid } }))!.id
    ownJournal = (await flagException({ tenantId: A, kind: 'manual_journal', severity: 'medium', title: 'Manual JE', description: 'x', entityType: 'JournalEntry', entityId: crypto.randomUUID(), actorId: users['fin']!.id }))!.id
    ordinary = (await flagException({ tenantId: A, kind: 'cash_variance', severity: 'medium', title: 'Drawer short', description: 'x' }))!.id
    flagB = (await flagException({ tenantId: B, kind: 'cash_variance', severity: 'medium', title: 'B drawer', description: 'x' }))!.id
  })
  const resolve = (who: string, id: string, resolution = note) => call(who, 'PATCH', `/crosschecks/exceptions/${id}/resolve`, { resolution })

  it('an ops manager without the Exceptions module cannot acknowledge or resolve', async () => {
    expect((await resolve('fnb', ordinary)).statusCode).toBe(403)
    expect((await call('fnb', 'PATCH', `/crosschecks/exceptions/${ordinary}/acknowledge`, {})).statusCode).toBe(403)
  })

  it('a note under 10 characters is refused; another company\'s flag is 404', async () => {
    expect((await resolve('mgmt', ordinary, 'ok')).statusCode).toBe(400)
    expect((await resolve('fin', flagB)).statusCode).toBe(404)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flagB } })).status).toBe('open')
  })

  it('a flag about the books: management is refused, finance only once the posting is on the books', async () => {
    const m = await resolve('mgmt', failed)
    expect(m.statusCode).toBe(403)
    expect(m.json().error.code).toBe('LEDGER_FLAG_FINANCE_ONLY')
    // Finance whose accounting module the CEO unticked is refused too.
    const noAcc = await resolve('finNoAcc', failed)
    expect(noAcc.statusCode).toBe(403)
    expect(noAcc.json().error.code).toBe('LEDGER_FLAG_FINANCE_ONLY')
    const early = await resolve('fin', failed)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('POSTING_NOT_ON_BOOKS')
    // The posting reaches A's books (in company B it would not count).
    const [st, sid] = failedRef.split(':') as [string, string]
    await postJournalEntry({ tenantId: B, sourceType: st, sourceId: sid, description: 'Wrong company', entryDate: new Date(), lines: [
      { accountCode: '6010', type: 'debit', amountCents: 1_000 }, { accountCode: '1020', type: 'credit', amountCents: 1_000 },
    ] })
    expect((await resolve('fin', failed)).statusCode).toBe(409)
    await postJournalEntry({ tenantId: A, sourceType: st, sourceId: sid, description: 'Re-posted', entryDate: new Date(), lines: [
      { accountCode: '6010', type: 'debit', amountCents: 1_000 }, { accountCode: '1020', type: 'credit', amountCents: 1_000 },
    ] })
    expect((await resolve('fin', failed)).statusCode).toBe(204)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: failed } })).status).toBe('resolved')
  })

  it('finance never resolves the review flag of its own journal; another finance login or the CEO may; once only', async () => {
    const own = await resolve('fin', ownJournal)
    expect(own.statusCode).toBe(403)
    expect(own.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    expect((await resolve('fin2', ownJournal)).statusCode).toBe(204)
    const twice = await resolve('ceo', ownJournal)
    expect(twice.statusCode).toBe(409)
    expect(twice.json().error.code).toBe('FLAG_NOT_OPEN')
  })

  it('an ordinary flag: management resolves it; a dismissed one is never flipped to resolved', async () => {
    expect((await resolve('mgmt', ordinary)).statusCode).toBe(204)
    const dismissed = (await flagException({ tenantId: A, kind: 'cash_variance', severity: 'low', title: 'Old', description: 'x' }))!.id
    await prisma.exceptionFlag.update({ where: { id: dismissed }, data: { status: 'dismissed' } })
    expect((await resolve('mgmt', dismissed)).statusCode).toBe(409)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: dismissed } })).status).toBe('dismissed')
  })
})

// ─── 12: a failing trial balance is never overridable ───────────────────────

describe('close checks — a check that could not run keeps its own rule', () => {
  it('check_failed:trial_balance is never overridable; other failures still are', async () => {
    expect(isOverridableKey(`${CHECK_FAILED_PREFIX}trial_balance`)).toBe(false)
    expect(isOverridableKey('trial_balance')).toBe(false)
    expect(isOverridableKey(`${CHECK_FAILED_PREFIX}posting_failed`)).toBe(true)
    const problems = await runChecks(prisma, [
      { key: 'trial_balance', severity: 'block', overridable: false, run: async () => { throw new Error('timeout') } },
      { key: 'posting_failed', severity: 'block', overridable: true, run: async () => { throw new Error('timeout') } },
    ] as never, { tenantId: A }, { tag: 'test', savepoint: 'sp', failLink: '/x' })
    expect(problems.map((p) => [p.key, p.overridable])).toEqual([
      ['check_failed:trial_balance', false],
      ['check_failed:posting_failed', true],
    ])
  })
})

// ─── 13: journal edit dates ─────────────────────────────────────────────────

describe('journal edit — the reversal is dated on the original\'s day', () => {
  const lines = async (tenantId: string, cents: number) => {
    const acc = await prisma.account.findMany({ where: { tenantId, code: { in: ['6010', '1020'] } }, select: { id: true, code: true } })
    const id = (c: string) => acc.find((a) => a.code === c)!.id
    return [{ accountId: id('6010'), type: 'debit', amountCents: cents }, { accountId: id('1020'), type: 'credit', amountCents: cents }]
  }
  // An open day: 10 days ago (no lock in this company yet).
  const tenDaysAgo = fmtPktDate(new Date(Date.now() - 10 * 86400_000))

  it('an open month: original, reversal and corrected entry share the original date; company B gets 404', async () => {
    const orig = await call('fin', 'POST', '/accounting/journal', {
      description: 'Accrual', reference: 'INV-77', entryDate: new Date(`${tenDaysAgo}T12:00:00+05:00`).toISOString(), lines: await lines(A, 50_000),
    })
    expect(orig.statusCode, orig.body).toBe(201)
    const id = orig.json().id as string
    expect((await call('finB', 'POST', `/accounting/journal/${id}/amend`, { reason: 'Wrong amount', description: 'Accrual', lines: await lines(B, 60_000) })).statusCode).toBe(404)
    const res = await call('fin', 'POST', `/accounting/journal/${id}/amend`, {
      reason: 'Wrong amount', description: 'Accrual', reference: 'INV-77', entryDate: new Date(`${tenDaysAgo}T12:00:00+05:00`).toISOString(), lines: await lines(A, 60_000),
    })
    expect(res.statusCode, res.body).toBe(201)
    const reversal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: res.json().replaces.reversalId } })
    expect(reversal.tenantId).toBe(A)
    expect(fmtPktDate(reversal.entryDate)).toBe(tenDaysAgo)
  })

  it('a closed month: the CEO\'s edit reverses today; GET /period-close names a reopened window', async () => {
    const ts = new Date('2026-03-05T07:00:00Z')
    const orig = await call('ceo', 'POST', '/accounting/journal', { description: 'March accrual', entryDate: ts.toISOString(), lines: await lines(A, 10_000) })
    expect(orig.statusCode, orig.body).toBe(201)
    const lock = await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: parsePktEndOfDay('2026-03-31'), lockedBy: users['ceo']!.id } })
    try {
      const res = await call('ceo', 'POST', `/accounting/journal/${orig.json().id}/amend`, { reason: 'Wrong amount', description: 'March accrual', lines: await lines(A, 12_000) })
      expect(res.statusCode, res.body).toBe(201)
      const reversal = await prisma.journalEntry.findUniqueOrThrow({ where: { id: res.json().replaces.reversalId } })
      expect(fmtPktDate(reversal.entryDate)).toBe(fmtPktDate(new Date()))

      await prisma.setting.upsert({ where: { key: reopenedThroughKey(A) }, create: { key: reopenedThroughKey(A), value: parsePktEndOfDay('2026-02-28').toISOString() }, update: {} })
      const pc = await call('fin', 'GET', '/accounting/period-close?lockedThrough=2026-03-31')
      expect(pc.statusCode).toBe(200)
      expect(fmtPktDate(new Date(pc.json().reopenedThrough))).toBe('2026-02-28')
      const pcB = await call('finB', 'GET', '/accounting/period-close?lockedThrough=2026-03-31')
      expect(pcB.json().reopenedThrough).toBeNull()
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
      await prisma.setting.deleteMany({ where: { key: reopenedThroughKey(A) } })
    }
  })
})

// ─── 27: finance re-posts refused postings ──────────────────────────────────

describe('Backfill unposted — finance runs it in open months', () => {
  it('finance previews and posts; ops managers are refused; a reopened month makes the real run the CEO\'s', async () => {
    expect((await call('fnb', 'POST', '/reconciliation/backfill-unposted', {})).statusCode).toBe(403)
    expect((await call('mgmt', 'POST', '/reconciliation/backfill-unposted', {})).statusCode).toBe(403)
    const dry = await call('fin', 'POST', '/reconciliation/backfill-unposted', {})
    expect(dry.statusCode, dry.body).toBe(200)
    expect(dry.json().dryRun).toBe(true)
    const real = await call('fin', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
    expect(real.statusCode, real.body).toBe(200)
    const log = await prisma.auditLog.findFirst({ where: { action: 'shift.backfill_unposted', userId: users['fin']!.id }, orderBy: { createdAt: 'desc' } })
    expect((log!.metadata as { tenantIds: string[]; actorRole: string })).toMatchObject({ tenantIds: [A], actorRole: 'finance' })
    // Company B's finance runs B only.
    expect((await call('finB', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).statusCode).toBe(200)
    const logB = await prisma.auditLog.findFirst({ where: { action: 'shift.backfill_unposted', userId: users['finB']!.id } })
    expect((logB!.metadata as { tenantIds: string[] }).tenantIds).toEqual([B])

    await prisma.setting.create({ data: { key: reopenedThroughKey(A), value: parsePktEndOfDay('2026-02-28').toISOString() } })
    try {
      const refused = await call('fin', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error.code).toBe('REOPENED_BOOKS_CEO_ONLY')
      expect((await call('fin', 'POST', '/reconciliation/backfill-unposted', {})).statusCode).toBe(200)
      expect((await call('finB', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).statusCode).toBe(200)
      expect((await call('ceo', 'POST', '/reconciliation/backfill-unposted', { dryRun: false }, { 'x-servd-active-tenant': A })).statusCode).toBe(200)
    } finally {
      await prisma.setting.deleteMany({ where: { key: reopenedThroughKey(A) } })
    }
  })
})

// ─── 39: no zero b/f row ────────────────────────────────────────────────────

describe('trial balance — year basis', () => {
  it('a company with nothing before its fiscal year has no Retained earnings b/f row', async () => {
    await post(B, new Date('2026-08-10T07:00:00Z'), '1020', '4001', 40_000)
    const tb = await trialBalance([B], parsePktEndOfDay('2026-09-30'), { basis: 'year' })
    expect(tb.rows.some((r) => r.virtual)).toBe(false)
    expect(tb.totals.differenceCents).toBe(0)
  })
})
