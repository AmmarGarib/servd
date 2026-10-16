// The ONE period-close checklist (finance wave B, H29): every block refuses
// the close with 409 CLOSE_NOT_READY naming it; the CEO closes over the
// overridable ones with a reason (stored on the lock, audited, flagged); the
// trial balance can never be closed over; a warning never stops a close; Raast
// alone keeps its old 409 RAAST_UNMATCHED and its no-reason switch, which
// never bypasses another block; one company's problems never block another;
// a close across the fiscal year end is a year-end close.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { CLOSE_CHECKS, closeChecklist, monthsInRange } from '../src/modules/accounting/closeChecks.js'
import type { CloseCheck } from '../src/modules/accounting/closeCheckTypes.js'

let A: string
let B: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

const BASE_LOCK = '2026-07-31'
const CLOSE = '2026-08-31'
const NIGHT_AUDIT_LATER = '2026-09-15'

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.pcc@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, tenant?: string) =>
  app.inject({
    method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}`, ...(tenant && { 'x-servd-active-tenant': tenant }) },
  })

const close = (who: string, tenant: string, body: Record<string, unknown> = {}) =>
  call(who, 'POST', '/accounting/period-close', { lockedThrough: CLOSE, ...body }, tenant)

type Problem = { key: string; severity: string; overridable: boolean; count: number }
const keysOf = (res: { json(): unknown }) => ((res.json() as { error: { details: { problems: Problem[] } } }).error.details.problems).map((p) => p.key)

async function resetLocks() {
  await prisma.periodLock.deleteMany({ where: { tenantId: { in: [A, B] } } })
  for (const t of [A, B]) {
    await prisma.periodLock.create({ data: { tenantId: t, lockedThrough: parsePktEndOfDay(BASE_LOCK), lockedBy: users.ceo!.id } })
  }
}

/** Swap a check in CLOSE_CHECKS for the length of `fn`. */
async function withCheck<T>(check: CloseCheck, fn: () => Promise<T>, replaceKey?: string): Promise<T> {
  const i = replaceKey ? CLOSE_CHECKS.findIndex((c) => c.key === replaceKey) : -1
  const old = i >= 0 ? CLOSE_CHECKS[i]! : null
  if (i >= 0) CLOSE_CHECKS[i] = check
  else CLOSE_CHECKS.push(check)
  try {
    return await fn()
  } finally {
    if (old) CLOSE_CHECKS[i] = old
    else CLOSE_CHECKS.splice(CLOSE_CHECKS.indexOf(check), 1)
  }
}

const stubBlock = (key: string, extra: Partial<{ cents: number }> = {}): CloseCheck => ({
  key, severity: 'block', overridable: true,
  async run(ctx) {
    return { key, severity: 'block', title: `Stub ${key}`, detail: `stub for ${ctx.tenantId}`, count: 1, link: '/', overridable: true, ...extra }
  },
})

async function openTill(tenantId: string) {
  return prisma.shift.create({ data: { userId: users.ceo!.id, tenantId, status: 'open', openedAt: new Date('2026-08-20T05:00:00Z') } })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Close Foods', slug: 'pcc-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Close Viva', slug: 'pcc-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  await mkUser('ceo', 'admin', A, [A, B])
  await mkUser('adminB', 'admin', B, [B])
  await mkUser('fin', 'finance', A, [A])
  // The night audit (2026-10-16) starts after these closes, so its month
  // check stays quiet here; its own cases below set an earlier start day.
  await prisma.tenant.updateMany({ where: { id: { in: [A, B] } }, data: { nightAuditStartDay: NIGHT_AUDIT_LATER } })
  // First entries: mid-May, so a first close through July crosses 30 June.
  for (const t of [A, B]) {
    await postJournalEntry({ tenantId: t, sourceType: 'test.opening', sourceId: t, description: 'Opening capital', entryDate: new Date('2026-05-15T07:00:00Z'), lines: [
      { accountCode: '1020', type: 'debit', amountCents: 1_000_000 }, { accountCode: '3010', type: 'credit', amountCents: 1_000_000 },
    ] })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

beforeEach(async () => {
  await resetLocks()
})

describe('monthsInRange', () => {
  it('covers every PKT month with a day in (prevLock, newLock], capped at 24', () => {
    expect(monthsInRange(parsePktEndOfDay('2026-07-31'), parsePktEndOfDay('2026-09-15'), null)).toEqual(['2026-08', '2026-09'])
    expect(monthsInRange(null, parsePktEndOfDay('2026-07-31'), new Date('2026-05-15T07:00:00Z'))).toEqual(['2026-05', '2026-06', '2026-07'])
    expect(monthsInRange(null, parsePktEndOfDay('2026-07-31'), null)).toEqual(['2026-07'])
    expect(monthsInRange(null, parsePktEndOfDay('2026-07-31'), new Date('2020-01-01T00:00:00Z'))).toHaveLength(24)
  })
})

describe('blocks refuse the close with their key; the CEO closes over them with a reason', () => {
  it('an open till blocks A only; acknowledged with a reason it closes, stored, audited and flagged', async () => {
    const till = await openTill(A)
    try {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error.code).toBe('CLOSE_NOT_READY')
      expect(keysOf(refused)).toContain('open_tills')

      // B's view and B's close never see A's till.
      const viewB = await call('adminB', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, B)
      expect((viewB.json().checks as Problem[]).map((p) => p.key)).not.toContain('open_tills')
      const viewA = await call('ceo', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, A)
      expect((viewA.json().checks as Problem[]).find((p) => p.key === 'open_tills')?.count).toBe(1)
      expect(viewA.json().ready).toBe(false)
      expect((await close('adminB', B)).statusCode).toBe(201)

      // A short reason is refused before anything runs.
      const short = await close('ceo', A, { acknowledge: { keys: ['open_tills'], reason: 'too short' } })
      expect(short.statusCode).toBe(422)
      expect(short.json().error.code).toBe('OVERRIDE_REASON_REQUIRED')
      expect((await close('ceo', A, { acknowledge: { keys: ['open_tills'] } })).json().error.code).toBe('OVERRIDE_REASON_REQUIRED')

      const ok = await close('ceo', A, { acknowledge: { keys: ['open_tills'], reason: 'Till 2 was left open by mistake, cash counted by hand' } })
      expect(ok.statusCode).toBe(201)
      const lock = await prisma.periodLock.findUniqueOrThrow({ where: { id: ok.json().id } })
      expect(lock.tenantId).toBe(A)
      expect((lock.overrides as Array<{ key: string; count: number }>).map((o) => o.key)).toEqual(['open_tills'])
      expect(lock.overrideReason).toBe('Till 2 was left open by mistake, cash counted by hand')
      const audits = await prisma.auditLog.findMany({ where: { entityId: lock.id }, select: { action: true, tenantId: true } })
      expect(audits.map((a) => a.action).sort()).toEqual(['period.close', 'period.close_override'])
      expect(audits.every((a) => a.tenantId === A)).toBe(true)
      const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'period_close_override', entityId: lock.id } })
      expect(flag?.severity).toBe('high')
      expect(flag?.tenantId).toBe(A)

      const hist = await call('fin', 'GET', '/accounting/period-close/history', undefined, A)
      expect(hist.json().locks[0].overrideReason).toBe('Till 2 was left open by mistake, cash counted by hand')
      expect(hist.json().locks[0].overrides[0].key).toBe('open_tills')
    } finally {
      await prisma.shift.delete({ where: { id: till.id } })
    }
  })

  it('only the CEO closes', async () => {
    expect((await close('fin', A)).statusCode).toBe(403)
  })

  it('a closed till whose close never reached the books blocks (unposted_shifts)', async () => {
    // A drawer counted 50 over with no sales: the close entry would book the variance.
    const s = await prisma.shift.create({ data: {
      userId: users.ceo!.id, tenantId: A, status: 'closed', openingFloatCents: 0, closingFloatCents: 5_000,
      openedAt: new Date('2026-08-10T04:00:00Z'), closedAt: new Date('2026-08-10T16:00:00Z'),
    } })
    try {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      expect(keysOf(refused)).toContain('unposted_shifts')
      expect(keysOf(refused)).not.toContain('open_tills')
    } finally {
      await prisma.shift.delete({ where: { id: s.id } })
    }
  })

  it('an open posting_failed flag blocks by its DOCUMENT date, not the day it was raised', async () => {
    const before = await prisma.exceptionFlag.create({ data: {
      tenantId: A, kind: 'posting_failed', severity: 'high', title: 'refused', description: 'refused',
      entityType: 'TestDoc', entityId: 'doc-aug', metadata: { sourceType: 'test.doc', sourceId: 'doc-aug', documentDate: '2026-08-10T07:00:00.000Z' },
    } })
    const after = await prisma.exceptionFlag.create({ data: {
      tenantId: A, kind: 'posting_failed', severity: 'high', title: 'refused', description: 'refused',
      entityType: 'TestDoc', entityId: 'doc-sep', metadata: { sourceType: 'test.doc', sourceId: 'doc-sep', documentDate: '2026-09-10T07:00:00.000Z' },
    } })
    const otherCo = await prisma.exceptionFlag.create({ data: {
      tenantId: B, kind: 'posting_failed', severity: 'high', title: 'refused', description: 'refused',
      entityType: 'TestDoc', entityId: 'doc-b', metadata: { sourceType: 'test.doc', sourceId: 'doc-b', documentDate: '2026-08-10T07:00:00.000Z' },
    } })
    try {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      const p = (refused.json().error.details.problems as Problem[]).find((x) => x.key === 'posting_failed')
      expect(p?.count).toBe(1)
      // Raised long after its document's day, dated in the close: still counts.
      await prisma.exceptionFlag.update({ where: { id: before.id }, data: { status: 'resolved' } })
      expect((await close('ceo', A)).statusCode).toBe(201)
    } finally {
      await prisma.exceptionFlag.deleteMany({ where: { id: { in: [before.id, after.id, otherCo.id] } } })
    }
  })

  it('a month with payable staff and no locked payroll blocks (hrCloseChecks); B\'s payroll never blocks A', async () => {
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: B, period: '2026-07', status: 'locked', settings: {} } })
    const emp = await prisma.hrEmployee.create({ data: { tenantId: B, employeeCode: 'PCC-1', fullName: 'Cook B', joiningDate: new Date('2026-01-01T00:00:00Z'), grossSalaryCents: 5_000_000, basicSalaryCents: 3_000_000 } })
    try {
      const refusedB = await close('adminB', B)
      expect(refusedB.statusCode).toBe(409)
      expect(keysOf(refusedB)).toContain('payroll')
      // A has no HR at all: its close is not blocked by B's payroll.
      expect((await close('ceo', A)).statusCode).toBe(201)
    } finally {
      await prisma.hrEmployee.delete({ where: { id: emp.id } })
      await prisma.hrPayrollRun.delete({ where: { id: run.id } })
    }
  })

  it('an inter-company transfer waiting for the CEO blocks both parties (intercompanyCloseChecks)', async () => {
    const t = await prisma.intercompanyTransfer.create({ data: {
      tenantId: A, counterpartyTenantId: B, kind: 'charge', amountCents: 50_000, entryDate: new Date('2026-08-20T07:00:00Z'),
      memo: 'Shared rider costs', status: 'submitted', preparedById: users.ceo!.id,
    } })
    try {
      expect(keysOf(await close('ceo', A))).toContain('intercompany_pending')
    } finally {
      await prisma.intercompanyTransfer.delete({ where: { id: t.id } })
    }
  })

  it('a module\'s block (stubbed depreciation) is just another key — and a throwing check is a check_failed block', async () => {
    await withCheck(stubBlock('depreciation_stub', { cents: 12_345 }), async () => {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      expect(keysOf(refused)).toEqual(['depreciation_stub'])
      const ok = await close('ceo', A, { acknowledge: { keys: ['depreciation_stub'], reason: 'Assets charged next month by finance' } })
      expect(ok.statusCode).toBe(201)
    })
    await resetLocks()
    const boom: CloseCheck = { key: 'boom', severity: 'block', overridable: false, async run() { throw new Error('kaput') } }
    await withCheck(boom, async () => {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      expect(keysOf(refused)).toEqual(['check_failed:boom'])
      expect((await close('ceo', A, { acknowledge: { keys: ['check_failed:boom'], reason: 'Known bug, books checked by hand' } })).statusCode).toBe(201)
    })
  })
})

describe('the trial balance is never closed over; warnings never stop a close', () => {
  it('acknowledging trial_balance is 422 NOT_OVERRIDABLE; an unbalanced ledger is 409 whatever else is acknowledged', async () => {
    const bad = await close('ceo', A, { acknowledge: { keys: ['trial_balance'], reason: 'We will fix it later on' } })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('NOT_OVERRIDABLE')

    // A one-sided entry written past the engine (a corrupt ledger).
    const acct = await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: '1020' } })
    const je = await prisma.journalEntry.create({ data: {
      tenantId: A, reference: 'test.corrupt:1', description: 'one-sided', entryDate: new Date('2026-08-05T07:00:00Z'), postedBy: users.ceo!.id,
      lines: { create: [{ accountId: acct.id, type: 'debit', amountCents: 100 }] },
    } })
    const till = await openTill(A)
    try {
      const refused = await close('ceo', A, { acknowledge: { keys: ['open_tills'], reason: 'Till left open by mistake overnight' } })
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error.code).toBe('CLOSE_NOT_READY')
      expect(keysOf(refused)).toContain('trial_balance')
      expect(refused.json().error.details.open).toEqual(['trial_balance'])
    } finally {
      await prisma.shift.delete({ where: { id: till.id } })
      await prisma.journalLine.deleteMany({ where: { journalEntryId: je.id } })
      await prisma.journalEntry.delete({ where: { id: je.id } })
    }
  })

  it('an unmatched bank line alone is a warning: shown, and the close goes through', async () => {
    const imp = await prisma.bankStatementImport.create({ data: { tenantId: A, source: 'bank:hbl', accountCode: '1020', statementDate: new Date('2026-08-31T07:00:00Z') } })
    await prisma.bankStatementLine.create({ data: { importId: imp.id, postedDate: new Date('2026-08-15T07:00:00Z'), description: 'IBFT', amountCents: 250_000 } })
    try {
      const view = await call('ceo', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, A)
      const warn = (view.json().checks as Problem[]).find((p) => p.key === 'bank_unmatched')
      expect(warn?.severity).toBe('warn')
      expect(view.json().ready).toBe(true)
      const ok = await close('ceo', A)
      expect(ok.statusCode).toBe(201)
      expect(ok.json().overrides).toBeNull()
      // The other company's view never counts it.
      const viewB = await call('adminB', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, B)
      expect((viewB.json().checks as Problem[]).map((p) => p.key)).not.toContain('bank_unmatched')
    } finally {
      await prisma.bankStatementLine.deleteMany({ where: { importId: imp.id } })
      await prisma.bankStatementImport.delete({ where: { id: imp.id } })
    }
  })
})

describe('Raast keeps its own answer and switch, only when it is the one block', () => {
  const raastStub: CloseCheck = {
    key: 'raast', severity: 'block', overridable: true,
    async run() {
      return { key: 'raast', severity: 'block', title: 'Raast payments not matched', detail: 'stub', count: 2, cents: 300_000, link: '/reconciliation?tab=raast', overridable: true }
    },
  }

  it('raast only → 409 RAAST_UNMATCHED; closeWithUnmatchedRaast closes with its own audit action, no reason needed', async () => {
    await withCheck(raastStub, async () => {
      const refused = await close('ceo', A)
      expect(refused.statusCode).toBe(409)
      expect(refused.json().error.code).toBe('RAAST_UNMATCHED')
      expect(refused.json().error.details).toMatchObject({ count: 2, cents: 300_000 })
      const ok = await close('ceo', A, { closeWithUnmatchedRaast: true })
      expect(ok.statusCode).toBe(201)
      const actions = (await prisma.auditLog.findMany({ where: { entityId: ok.json().id }, select: { action: true } })).map((a) => a.action).sort()
      expect(actions).toEqual(['period.close', 'period.close_with_unmatched_raast'])
      expect(await prisma.exceptionFlag.count({ where: { kind: 'period_close_override', entityId: ok.json().id } })).toBe(0)
    }, 'raast')
  })

  it('raast plus another block → CLOSE_NOT_READY; the switch never bypasses the other block, nor raast itself then', async () => {
    const till = await openTill(A)
    try {
      await withCheck(raastStub, async () => {
        const refused = await close('ceo', A, { closeWithUnmatchedRaast: true })
        expect(refused.statusCode).toBe(409)
        expect(refused.json().error.code).toBe('CLOSE_NOT_READY')
        expect(keysOf(refused).sort()).toEqual(['open_tills', 'raast'])
        const still = await close('ceo', A, { closeWithUnmatchedRaast: true, acknowledge: { keys: ['open_tills'], reason: 'Till left open by mistake overnight' } })
        expect(still.statusCode).toBe(409)
        expect(still.json().error.code).toBe('CLOSE_NOT_READY')
        expect(still.json().error.details.open).toEqual(['raast'])
        // Both acknowledged with the reason: closes, and the Raast trail is kept.
        const ok = await close('ceo', A, { acknowledge: { keys: ['open_tills', 'raast'], reason: 'Till left open; Raast statement arrives Monday' } })
        expect(ok.statusCode).toBe(201)
        const actions = (await prisma.auditLog.findMany({ where: { entityId: ok.json().id }, select: { action: true } })).map((a) => a.action).sort()
        expect(actions).toEqual(['period.close', 'period.close_override', 'period.close_with_unmatched_raast'])
      }, 'raast')
    } finally {
      await prisma.shift.delete({ where: { id: till.id } })
    }
  })
})

describe('year end', () => {
  it('a close across the company\'s fiscal year end is a year-end close', async () => {
    await prisma.periodLock.deleteMany({ where: { tenantId: A } })
    const view = await call('ceo', 'GET', '/accounting/period-close?lockedThrough=2026-07-31', undefined, A)
    expect(view.json().isYearEnd).toBe(true)
    expect(view.json().fiscalYear).toMatchObject({ endMonth: 6, label: 'FY2026-27' })
    expect(view.json().months).toEqual(['2026-05', '2026-06', '2026-07'])
    expect(view.json().closesFiscalYear).toBe('FY2025-26')
    const ok = await call('ceo', 'POST', '/accounting/period-close', { lockedThrough: '2026-07-31' }, A)
    expect(ok.statusCode).toBe(201)
    expect(ok.json().isYearEnd).toBe(true)
    const actions = (await prisma.auditLog.findMany({ where: { entityId: ok.json().id }, select: { action: true } })).map((a) => a.action).sort()
    expect(actions).toEqual(['period.close', 'period.year_end_close'])

    // August alone (after the July lock) is not.
    const aug = await close('ceo', A)
    expect(aug.statusCode).toBe(201)
    expect(aug.json().isYearEnd).toBe(false)
  })

  it('closeChecklist runs for one company and reads its own lock', async () => {
    const list = await closeChecklist(prisma, B, parsePktEndOfDay(CLOSE))
    expect(list.months).toEqual(['2026-08'])
    expect(list.isYearEnd).toBe(false)
    expect(list.blocks).toEqual([])
  })
})

describe('night_audit_days (the night audit, sales days only)', () => {
  it('blocks while an active sales day is open or awaiting settlement; passes when every one is closed; the CEO can close over it', async () => {
    const concept = await prisma.concept.create({ data: { name: 'Night brand', slug: 'pcc-night', type: 'restaurant', tenantId: A } })
    await prisma.tenant.update({ where: { id: A }, data: { nightAuditStartDay: '2026-08-10' } })
    const day = '2026-08-12'
    const o = await prisma.order.create({ data: {
      conceptId: concept.id, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 0, taxCents: 0,
      placedAt: new Date(`${day}T12:00:00+05:00`), completedAt: new Date(`${day}T12:10:00+05:00`),
    } })
    // A supplier bill alone on another day never makes that day a sales day.
    await postJournalEntry({ tenantId: A, sourceType: 'supplier.bill', sourceId: 'pcc-night-bill', description: 'not sales', entryDate: new Date('2026-08-14T07:00:00Z'), lines: [
      { accountCode: '5010', type: 'debit', amountCents: 1_000 }, { accountCode: '2010', type: 'credit', amountCents: 1_000 },
    ] })
    try {
      const open = await close('ceo', A)
      expect(open.statusCode).toBe(409)
      const p = (open.json().error.details.problems as Array<Problem & { detail: string }>).find((x) => x.key === 'night_audit_days')!
      expect(p).toMatchObject({ severity: 'block', count: 1, overridable: true })
      expect(p.detail).toContain(`not night-audited (${day})`)
      expect(p.detail).not.toContain('2026-08-14')

      await prisma.nightAuditDay.create({ data: { tenantId: A, businessDate: day, status: 'audited', auditedAt: new Date(), auditedById: users.ceo!.id } })
      const awaiting = await close('ceo', A)
      expect(((awaiting.json().error.details.problems as Array<Problem & { detail: string }>).find((x) => x.key === 'night_audit_days'))?.detail).toContain('awaiting settlement')
      // B's close never sees A's days.
      const viewB = await call('adminB', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, B)
      expect((viewB.json().checks as Problem[]).map((x) => x.key)).not.toContain('night_audit_days')
      // The CEO closes over it with a reason.
      const over = await close('ceo', A, { acknowledge: { keys: ['night_audit_days'], reason: 'Card payouts for that day arrive late' } })
      expect(over.statusCode, over.body).toBe(201)
      await resetLocks()

      await prisma.nightAuditDay.update({ where: { tenantId_businessDate: { tenantId: A, businessDate: day } }, data: { status: 'closed', closedAt: new Date(), closedVia: 'manual' } })
      const ok = await close('ceo', A)
      expect(ok.statusCode, ok.body).toBe(201)
    } finally {
      await prisma.nightAuditDay.deleteMany({ where: { tenantId: A } })
      await prisma.order.delete({ where: { id: o.id } })
      await prisma.tenant.update({ where: { id: A }, data: { nightAuditStartDay: NIGHT_AUDIT_LATER } })
    }
  })

  it('a warning (never a block) while the company\'s night audit has not started', async () => {
    await prisma.tenant.update({ where: { id: B }, data: { nightAuditStartDay: null } })
    try {
      const view = await call('adminB', 'GET', `/accounting/period-close?lockedThrough=${CLOSE}`, undefined, B)
      const p = (view.json().checks as Problem[]).find((x) => x.key === 'night_audit_days')
      expect(p).toMatchObject({ severity: 'warn', overridable: false })
      expect((await close('adminB', B)).statusCode).toBe(201)
    } finally {
      await prisma.tenant.update({ where: { id: B }, data: { nightAuditStartDay: NIGHT_AUDIT_LATER } })
    }
  })
})
