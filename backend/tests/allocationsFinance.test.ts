// Cost allocation — finance runs it (owner, 2026-10-16: "Hasnain runs the
// monthly allocation and edits the rules; every run is recorded and can be
// reversed").
//   - finance with `accounting` saves (creates / edits) rules and runs them;
//     the CEO still can; finance without the module and ops roles are refused
//   - company separation: company B's finance never sees, runs or reverses
//     A's rules / runs (404), cannot attach A's brand to a rule (422), and a
//     new rule binds to the ACTIVE company
//   - a run can be reversed once (reason required): the whole entry flips on
//     the run's own day, the run row stays, and the period can be run again
//   - closed books stay the CEO's: a run dated into a reopened month and the
//     reversal of a run dated in closed / reopened books are refused for
//     finance (CEO_ONLY_CLOSED_BOOKS); a closed month refuses everyone's run
//   - every save / run / reversal is audited with actorRole
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { fmtPktDate, pktToday } from '../src/modules/accounting/dates.js'
import { reopenedThroughKey } from '../src/modules/accounting/closedBooks.js'
import { allocationRoutes } from '../src/modules/allocations/routes.js'

const P = `alfin${Date.now()}`
let A: string
let B: string
let brandA1: string
let brandA2: string
let brandB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[], moduleDeny: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary, moduleDeny },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}` },
  })

let n = 0
async function post(tenantId: string, at: Date, debit: string, credit: string, cents: number) {
  await postJournalEntry({ tenantId, sourceType: 'test.alfin', sourceId: `${P}-${n++}`, description: 'Test', entryDate: at, lines: [
    { accountCode: debit, type: 'debit', amountCents: cents }, { accountCode: credit, type: 'credit', amountCents: cents },
  ] })
}

const rule = (sourceAccountCode: string, weights: Array<{ conceptId: string; weightBps: number }>, name = 'Rent split') =>
  ({ name, sourceAccountCode, driver: 'fixed_pct', weights })

async function netOn(tenantId: string, code: string, conceptId: string | null) {
  const rows = await prisma.journalLine.findMany({ where: { conceptId, account: { code, tenantId } }, select: { type: true, amountCents: true } })
  return rows.reduce((s, r) => s + (r.type === 'debit' ? 1 : -1) * Number(r.amountCents), 0)
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'AlFin A', slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'AlFin B', slug: `${P}-b` } })).id
  for (const t of [A, B]) await ensureChartOfAccounts(t)
  brandA1 = (await prisma.concept.create({ data: { name: 'AlFin Cafe', slug: `${P}-c1`, type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  brandA2 = (await prisma.concept.create({ data: { name: 'AlFin Diner', slug: `${P}-c2`, type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  brandB = (await prisma.concept.create({ data: { name: 'AlFin B brand', slug: `${P}-cb`, type: 'restaurant', tenantId: B, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('ceo', 'admin', A, [A])
  await mkUser('fin', 'finance', A, [A])
  await mkUser('finB', 'finance', B, [B])
  await mkUser('finNoAcc', 'finance', A, [A], ['accounting'])
  await mkUser('fnb', 'fnb_manager', A, [A])
  await mkUser('mgmt', 'management', A, [A])

  // Shared (untagged) rent: January 200k, February 100k, March 50k.
  await post(A, new Date('2026-01-20T10:00:00Z'), '6010', '1020', 200_000)
  await post(A, new Date('2026-02-20T10:00:00Z'), '6010', '1020', 100_000)
  await post(A, new Date('2026-03-20T10:00:00Z'), '6010', '1020', 50_000)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(allocationRoutes, { prefix: '/allocations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await prisma.setting.deleteMany({ where: { key: { in: [reopenedThroughKey(A), reopenedThroughKey(B)] } } })
})

describe('rules — finance saves them, company-scoped', () => {
  let ruleId: string

  it('who may save a rule: CEO and finance with accounting; others refused', async () => {
    for (const who of ['finNoAcc', 'fnb', 'mgmt']) {
      expect((await call(who, 'POST', '/allocations/rules', rule('6010', [{ conceptId: brandA1, weightBps: 10_000 }]))).statusCode, who).toBe(403)
    }
  })

  it('finance creates a rule: bound to its active company, audited with actorRole finance', async () => {
    const res = await call('fin', 'POST', '/allocations/rules', rule('6010', [{ conceptId: brandA1, weightBps: 6000 }, { conceptId: brandA2, weightBps: 4000 }]))
    expect(res.statusCode, res.body).toBe(201)
    ruleId = res.json().id
    expect((await prisma.costAllocationRule.findUniqueOrThrow({ where: { id: ruleId } })).tenantId).toBe(A)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'allocation.create', entityId: ruleId } })
    expect(a.userId).toBe(users['fin']!.id)
    expect((a.metadata as { actorRole?: string }).actorRole).toBe('finance')
  })

  it('finance edits it (60/40 → 50/50): audited allocation.update with actorRole', async () => {
    const res = await call('fin', 'POST', '/allocations/rules', rule('6010', [{ conceptId: brandA1, weightBps: 5000 }, { conceptId: brandA2, weightBps: 5000 }]))
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().id).toBe(ruleId)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'allocation.update', entityId: ruleId } })
    expect((a.metadata as { actorRole?: string }).actorRole).toBe('finance')
  })

  it('company B finance: cannot see A\'s rule, cannot attach A\'s brand (422); its own rule binds to B', async () => {
    const list = await call('finB', 'GET', '/allocations/rules')
    expect((list.json() as Array<{ id: string }>).some((r) => r.id === ruleId)).toBe(false)
    const cross = await call('finB', 'POST', '/allocations/rules', rule('6020', [{ conceptId: brandA1, weightBps: 10_000 }]))
    expect(cross.statusCode).toBe(422)
    const own = await call('finB', 'POST', '/allocations/rules', rule('6020', [{ conceptId: brandB, weightBps: 10_000 }]))
    expect(own.statusCode, own.body).toBe(201)
    expect((await prisma.costAllocationRule.findUniqueOrThrow({ where: { id: own.json().id } })).tenantId).toBe(B)
  })

  it('deleting a rule stays the CEO\'s', async () => {
    expect((await call('fin', 'DELETE', `/allocations/rules/${ruleId}`)).statusCode).toBe(403)
  })
})

describe('runs — finance runs and reverses; closed books stay the CEO\'s', () => {
  let ruleId: string
  let janRun: string
  let janRerun: string
  let febRun: string

  beforeAll(async () => {
    ruleId = (await prisma.costAllocationRule.findFirstOrThrow({ where: { tenantId: A, sourceAccountCode: '6010', deletedAt: null } })).id
  })

  it('who may run: finance with accounting yes; without it / ops no; company B 404', async () => {
    const body = { periodStart: '2026-01-01', periodEnd: '2026-01-31' }
    expect((await call('finNoAcc', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('fnb', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/allocations/rules/${ruleId}/run`, body)).statusCode).toBe(404)
    expect(await prisma.costAllocationRun.count({ where: { ruleId } })).toBe(0)
  })

  it('finance runs January: posted in A, audited with actorRole finance', async () => {
    const res = await call('fin', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
    expect(res.statusCode, res.body).toBe(201)
    janRun = res.json().runId
    expect(res.json().totalAmountCents).toBe(200_000)
    const run = await prisma.costAllocationRun.findUniqueOrThrow({ where: { id: janRun } })
    expect(run.tenantId).toBe(A)
    expect(run.postedById).toBe(users['fin']!.id)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'allocation.run', entityId: janRun } })
    expect((a.metadata as { actorRole?: string }).actorRole).toBe('finance')
    expect(await netOn(A, '6010', brandA1)).toBe(100_000)
  })

  it('reversing: company B 404, no accounting 403, a short reason 400', async () => {
    expect((await call('finB', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'Wrong split used here' })).statusCode).toBe(404)
    expect((await call('finNoAcc', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'Wrong split used here' })).statusCode).toBe(403)
    expect((await call('mgmt', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'Wrong split used here' })).statusCode).toBe(403)
    expect((await call('fin', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'short' })).statusCode).toBe(400)
  })

  it('finance reverses January: whole entry flips on 31 Jan, once only, the run stays, January can run again', async () => {
    const res = await call('fin', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'Wrong split used here' })
    expect(res.statusCode, res.body).toBe(201)
    const rev = await prisma.journalEntry.findUniqueOrThrow({ where: { id: res.json().reversalEntryId } })
    expect(rev.tenantId).toBe(A)
    expect(rev.reference).toBe(`allocation.run.reversal:${janRun}`)
    expect(fmtPktDate(rev.entryDate)).toBe('2026-01-31')
    expect(await netOn(A, '6010', brandA1)).toBe(0)
    expect(await netOn(A, '6010', brandA2)).toBe(0)
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'allocation.run_reverse', entityId: janRun } })
    expect(a.userId).toBe(users['fin']!.id)
    expect((a.metadata as { actorRole?: string }).actorRole).toBe('finance')

    const again = await call('fin', 'POST', `/allocations/runs/${janRun}/reverse`, { reason: 'Wrong split used here' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('RUN_ALREADY_REVERSED')

    const runs = await call('fin', 'GET', '/allocations/runs')
    const row = (runs.json() as Array<{ id: string; reversedAt: string | null }>).find((r) => r.id === janRun)
    expect(row?.reversedAt).toBeTruthy()
    expect((await call('finB', 'GET', '/allocations/runs')).json().some((r: { id: string }) => r.id === janRun)).toBe(false)

    const rerun = await call('fin', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-01', periodEnd: '2026-01-31' })
    expect(rerun.statusCode, rerun.body).toBe(201)
    janRerun = rerun.json().runId
    expect(rerun.json().totalAmountCents).toBe(200_000)
    expect(await netOn(A, '6010', brandA1)).toBe(100_000)
    // An un-reversed run still blocks an overlapping one.
    const overlap = await call('fin', 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-01-15', periodEnd: '2026-01-31' })
    expect(overlap.json().error.code).toBe('RUN_OVERLAPS')
  })

  it('a reopened month: finance\'s run is refused (CEO_ONLY_CLOSED_BOOKS), the CEO\'s goes in; reversing it is the CEO\'s', async () => {
    await prisma.setting.upsert({
      where: { key: reopenedThroughKey(A) },
      create: { key: reopenedThroughKey(A), value: new Date('2026-02-28T23:59:59.999+05:00').toISOString() },
      update: { value: new Date('2026-02-28T23:59:59.999+05:00').toISOString() },
    })
    const body = { periodStart: '2026-02-01', periodEnd: '2026-02-28' }
    const fin = await call('fin', 'POST', `/allocations/rules/${ruleId}/run`, body)
    expect(fin.statusCode).toBe(403)
    expect(fin.json().error.code).toBe('CEO_ONLY_CLOSED_BOOKS')
    expect(await prisma.costAllocationRun.count({ where: { ruleId, periodStart: new Date('2026-02-01T00:00:00+05:00') } })).toBe(0)
    const ceo = await call('ceo', 'POST', `/allocations/rules/${ruleId}/run`, body)
    expect(ceo.statusCode, ceo.body).toBe(201)
    febRun = ceo.json().runId
    const a = await prisma.auditLog.findFirstOrThrow({ where: { action: 'allocation.run', entityId: febRun } })
    expect((a.metadata as { actorRole?: string }).actorRole).toBe('admin')

    const finRev = await call('fin', 'POST', `/allocations/runs/${febRun}/reverse`, { reason: 'Reversing the February run' })
    expect(finRev.statusCode).toBe(403)
    expect(finRev.json().error.code).toBe('CEO_ONLY_CLOSED_BOOKS')
    const ceoRev = await call('ceo', 'POST', `/allocations/runs/${febRun}/reverse`, { reason: 'Reversing the February run' })
    expect(ceoRev.statusCode, ceoRev.body).toBe(201)
    await prisma.setting.deleteMany({ where: { key: reopenedThroughKey(A) } })
  })

  it('a closed month: nobody runs into it; reversing a run dated there is the CEO\'s, dated today', async () => {
    await prisma.periodLock.create({ data: { tenantId: A, lockedThrough: new Date('2026-03-31T23:59:59.999+05:00'), lockedBy: users['ceo']!.id } })
    for (const who of ['fin', 'ceo']) {
      const res = await call(who, 'POST', `/allocations/rules/${ruleId}/run`, { periodStart: '2026-03-01', periodEnd: '2026-03-31' })
      expect(res.statusCode, who).toBe(409)
    }
    expect(await prisma.costAllocationRun.count({ where: { ruleId, periodStart: new Date('2026-03-01T00:00:00+05:00') } })).toBe(0)

    const finRev = await call('fin', 'POST', `/allocations/runs/${janRerun}/reverse`, { reason: 'Reversing after the close' })
    expect(finRev.statusCode).toBe(403)
    expect(finRev.json().error.code).toBe('CEO_ONLY_CLOSED_BOOKS')
    const ceoRev = await call('ceo', 'POST', `/allocations/runs/${janRerun}/reverse`, { reason: 'Reversing after the close' })
    expect(ceoRev.statusCode, ceoRev.body).toBe(201)
    const rev = await prisma.journalEntry.findUniqueOrThrow({ where: { id: ceoRev.json().reversalEntryId } })
    expect(fmtPktDate(rev.entryDate)).toBe(fmtPktDate(pktToday().from))
  })
})
