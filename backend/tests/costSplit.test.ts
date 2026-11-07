// Cost splits (owner, 2026-11-07) — modules/intercompany/costSplit.ts. Companies A (books the cost), B and C (take
// shares), D (unrelated). Every share is an inter-company 'charge' (source 'cost_split') through the existing engine.
//
//   - percent split of a manual expense entry: A credits each expense line (brand kept) and debits Due from B/C;
//     B and C debit the same expense codes and credit Due to A; every book balances, due-to == due-from; the source
//     keeps the remainder; a code missing in C's chart is created there from A's;
//   - amount split; a payroll run (its live accrual): only the wages lines move, 2020 / 2042 untouched;
//   - Σ > 100 → 422, Σ > base → 422, foreign entry 404, non-member of a target 403, second split 409 ALREADY_SPLIT,
//     reverse (both books, the split's date) then split again, closed month 422, a manager 403, finance without the
//     accounting module 403, the share's transfer is not reversed from the transfers list (409), the bell tells the
//     CEO(s) but never the actor.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { parsePktEndOfDay, fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { intercompanyRoutes } = await import('../src/modules/intercompany/routes.js')
const { spread, allocateShares } = await import('../src/modules/intercompany/costSplit.js')
const { flushNotifications } = await import('../src/lib/staffNotify.js')

const PREFIX = `cs-${Date.now()}`
let app: FastifyInstance
let A: string, B: string, C: string, D: string
let brandA: string

interface Who { id: string; token: string }
let ceo: Who, fin: Who, finAB: Who, finNoAcc: Who, mgr: Who, ceoD: Who

async function mkTenant(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name, slug: `${PREFIX}-${name.toLowerCase().replace(/\s+/g, '-')}` } })).id
  await ensureChartOfAccounts(id)
  return id
}

async function mkUser(key: string, role: 'admin' | 'finance' | 'manager', tenants: string[], extra: { moduleDeny?: string[] } = {}): Promise<Who> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${key}`, email: `${PREFIX}.${key}@cs.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0]!, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((t) => ({ tenant: { connect: { id: t } }, role })) },
    },
  })
  return { id: u.id, token: `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}` }
}

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/accounting/intercompany${url}`, headers: { authorization: who.token }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const daysAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * 86_400_000))
const at = (iso: string) => new Date(`${iso}T12:00:00+05:00`)

/** Signed balance (debit +) per account code in one company's books. */
async function balances(tenantId: string): Promise<Map<string, number>> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true, account: { select: { code: true } } } })
  const m = new Map<string, number>()
  for (const l of lines) m.set(l.account.code, (m.get(l.account.code) ?? 0) + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents))
  return m
}
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0)

let seq = 0
/** A manual expense entry in A: Dr 6110 (brand) 100 000 + Dr 6170 50 000 / Cr 1010 150 000. */
async function expenseEntry(date = daysAgo(3)): Promise<string> {
  const r = await postJournalEntry({
    tenantId: A, sourceType: 'manual', sourceId: `${PREFIX}-e${++seq}`, description: 'Audit fee and stationery', entryDate: at(date), postedBy: ceo.id,
    lines: [
      { accountCode: '6110', type: 'debit', amountCents: 100_000, conceptId: brandA },
      { accountCode: '6170', type: 'debit', amountCents: 50_000 },
      { accountCode: '1010', type: 'credit', amountCents: 150_000 },
    ],
  })
  return r.entryId
}

beforeAll(async () => {
  A = await mkTenant('CS Alpha')
  B = await mkTenant('CS Bravo')
  C = await mkTenant('CS Charlie')
  D = await mkTenant('CS Delta')
  // C has no 6170 — the split creates it from A's.
  await prisma.account.deleteMany({ where: { tenantId: C, code: '6170' } })
  brandA = (await prisma.concept.create({ data: { name: 'Alpha brand', slug: `${PREFIX}-ba`, type: 'restaurant', tenantId: A } })).id
  ceo = await mkUser('ceo', 'admin', [A, B, C])
  fin = await mkUser('fin', 'finance', [A, B, C])
  finAB = await mkUser('fin-ab', 'finance', [A, B])
  finNoAcc = await mkUser('fin-noacc', 'finance', [A, B, C], { moduleDeny: ['accounting'] })
  mgr = await mkUser('mgr', 'manager', [A, B, C])
  ceoD = await mkUser('ceo-d', 'admin', [D])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(intercompanyRoutes, { prefix: '/accounting/intercompany' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the arithmetic', () => {
  it('spreads exactly, never above a line', () => {
    expect(spread(10, [3, 3, 4])).toEqual([3, 3, 4])
    const s = spread(100, [333, 333, 334])
    expect(s.reduce((a, b) => a + b, 0)).toBe(100)
    const many = allocateShares(
      [{ lineId: 'a', accountCode: 'x', accountName: 'x', conceptId: null, amountCents: 7 }, { lineId: 'b', accountCode: 'y', accountName: 'y', conceptId: null, amountCents: 4 }],
      [{ tenantId: 'p', amountCents: 4 }, { tenantId: 'q', amountCents: 4 }, { tenantId: 'r', amountCents: 3 }],
    )
    const perLine = [0, 1].map((i) => [...many.values()].reduce((a, v) => a + v[i]!, 0))
    expect(perLine).toEqual([7, 4])
    for (const [, v] of many) expect(v.every((x) => x >= 0)).toBe(true)
  })
})

describe('percent split of a booked expense', () => {
  let entryId: string
  let splitId: string
  it('preview lists the expense lines only, the companies and no live split', async () => {
    entryId = await expenseEntry()
    const r = await call(fin, 'GET', `/splits/preview?sourceEntryId=${entryId}`)
    expect(r.statusCode).toBe(200)
    const p = r.json()
    expect(p.lines.map((l: { accountCode: string }) => l.accountCode).sort()).toEqual(['6110', '6170'])
    expect(p.baseCents).toBe(150_000)
    expect(p.companies.map((c: { id: string }) => c.id).sort()).toEqual([B, C].sort())
    expect(p.canSplit).toBe(true)
    expect(p.liveSplit).toBeNull()
  })

  it('posts both books per company; the source keeps the rest; a missing code is created in the receiver', async () => {
    const before = await balances(A)
    const r = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 40 }, { tenantId: C, percent: 33.33 }], memo: 'Shared audit' })
    expect(r.statusCode, r.body).toBe(201)
    const v = r.json()
    splitId = v.id
    expect(v.status).toBe('posted')
    expect(v.baseCents).toBe(150_000)
    const b = v.shares.find((s: { tenantId: string }) => s.tenantId === B)
    const c = v.shares.find((s: { tenantId: string }) => s.tenantId === C)
    expect(b.amountCents).toBe(60_000)
    expect(c.amountCents).toBe(49_995)
    expect(v.keptCents).toBe(150_000 - 60_000 - 49_995)
    expect(v.canReverse).toBe(true)

    const a1 = await balances(A)
    const moved = (code: string) => (a1.get(code) ?? 0) - (before.get(code) ?? 0)
    expect(moved('6110') + moved('6170')).toBe(-(60_000 + 49_995))
    expect(moved('1010')).toBe(0)
    for (const t of [A, B, C]) expect(sum(await balances(t))).toBe(0)

    const bBal = await balances(B)
    expect((bBal.get('6110') ?? 0) + (bBal.get('6170') ?? 0)).toBe(60_000)
    expect(await prisma.account.findFirst({ where: { tenantId: C, code: '6170', type: 'expense' } })).not.toBeNull()
    // Due from B in A == Due to A in B.
    const tB = await prisma.intercompanyTransfer.findUniqueOrThrow({ where: { id: b.transferId } })
    expect(tB.source).toBe('cost_split')
    expect(tB.tenantId).toBe(B)
    expect(tB.counterpartyTenantId).toBe(A)
    const aEntry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: tB.creditorEntryId! }, include: { lines: { include: { account: true } } } })
    const bEntry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: tB.debtorEntryId! }, include: { lines: { include: { account: true } } } })
    const dueFrom = aEntry.lines.find((l) => l.account.controlledBy === 'intercompany')!
    const dueTo = bEntry.lines.find((l) => l.account.controlledBy === 'intercompany')!
    expect(dueFrom.type).toBe('debit')
    expect(dueTo.type).toBe('credit')
    expect(Number(dueFrom.amountCents)).toBe(Number(dueTo.amountCents))
    // The source's credit on 6110 keeps the brand; the receiver's lines carry none.
    expect(aEntry.lines.find((l) => l.account.code === '6110')!.conceptId).toBe(brandA)
    expect(bEntry.lines.every((l) => l.conceptId === null)).toBe(true)

    await flushNotifications()
    const bell = await prisma.staffNotification.findMany({ where: { entityId: splitId, kind: 'cost_split.posted' } })
    expect(bell.some((n) => n.userId === ceo.id)).toBe(true)
    expect(bell.some((n) => n.userId === fin.id)).toBe(false)
    expect(await prisma.auditLog.count({ where: { entityId: splitId, action: 'cost_split.post' } })).toBe(3)
  })

  it('a second split is 409 ALREADY_SPLIT; the share is not reversed from the transfers list', async () => {
    const r = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 10 }], memo: 'again' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('ALREADY_SPLIT')
    const v = (await call(ceo, 'GET', `/splits/${splitId}`)).json()
    const t = await call(ceo, 'POST', `/transfers/${v.shares[0].transferId}/reverse`, { reason: 'trying the wrong door' })
    expect(t.statusCode).toBe(409)
    expect(t.json().error.code).toBe('REVERSE_FROM_SOURCE')
  })

  it('reverse undoes both books, then the entry splits again', async () => {
    const before = { a: await balances(A), b: await balances(B) }
    const short = await call(fin, 'POST', `/splits/${splitId}/reverse`, { reason: 'short' })
    expect(short.statusCode).toBe(400)
    const r = await call(fin, 'POST', `/splits/${splitId}/reverse`, { reason: 'Wrong percentages used' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('reversed')
    const a = await balances(A)
    expect((a.get('6110') ?? 0) + (a.get('6170') ?? 0) - (before.a.get('6110') ?? 0) - (before.a.get('6170') ?? 0)).toBe(109_995)
    const b = await balances(B)
    expect((b.get('6110') ?? 0) + (b.get('6170') ?? 0)).toBe(0)
    for (const t of [A, B, C]) expect(sum(await balances(t))).toBe(0)
    const again = await call(fin, 'POST', `/splits/${splitId}/reverse`, { reason: 'Wrong percentages used' })
    expect(again.statusCode).toBe(409)
    const re = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'amount', shares: [{ tenantId: B, amountCents: 75_000 }], memo: 'Half to Bravo' })
    expect(re.statusCode, re.body).toBe(201)
    expect(re.json().shares[0].amountCents).toBe(75_000)
    expect((await call(fin, 'GET', `/splits?sourceEntryId=${entryId}`)).json().items).toHaveLength(2)
  })
})

describe('amount split and limits', () => {
  it('splits by amount over the chosen lines only', async () => {
    const entryId = await expenseEntry()
    const pv = (await call(fin, 'GET', `/splits/preview?sourceEntryId=${entryId}`)).json()
    const line6170 = pv.lines.find((l: { accountCode: string }) => l.accountCode === '6170').lineId
    const r = await call(ceo, 'POST', '/splits', { sourceEntryId: entryId, mode: 'amount', lines: [line6170], shares: [{ tenantId: B, amountCents: 20_000 }, { tenantId: C, amountCents: 30_000 }], memo: 'Stationery shared' })
    expect(r.statusCode, r.body).toBe(201)
    const v = r.json()
    expect(v.baseCents).toBe(50_000)
    expect(v.keptCents).toBe(0)
    expect(v.shares.every((s: { lines: Array<{ accountCode: string }> }) => s.lines.every((l) => l.accountCode === '6170'))).toBe(true)
  })

  it('refuses Σ > 100%, Σ > base, a non-expense line, the source itself', async () => {
    const entryId = await expenseEntry()
    const over = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 60 }, { tenantId: C, percent: 41 }], memo: 'too much' })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('SPLIT_OVER_100')
    const overAmt = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'amount', shares: [{ tenantId: B, amountCents: 150_001 }], memo: 'too much' })
    expect(overAmt.json().error.code).toBe('SPLIT_OVER_BASE')
    const cashLine = (await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: entryId, type: 'credit' } })).id
    const bad = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'amount', lines: [cashLine], shares: [{ tenantId: B, amountCents: 1 }], memo: 'cash line' })
    expect(bad.json().error.code).toBe('LINE_NOT_SPLITTABLE')
    const self = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: A, percent: 10 }], memo: 'self' })
    expect(self.json().error.code).toBe('SAME_COMPANY')
    const mixed = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, amountCents: 100 }], memo: 'mixed' })
    expect(mixed.json().error.code).toBe('SHARE_INVALID')
  })
})

describe('payroll already processed', () => {
  it('splits only the wages lines of the live accrual', async () => {
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: A, period: '2026-10', status: 'approved', settings: {} } })
    await postJournalEntry({
      tenantId: A, sourceType: 'hr.payroll.accrual', sourceId: run.id, description: 'Payroll accrual 2026-10', entryDate: at(daysAgo(5)), postedBy: ceo.id,
      lines: [
        { accountCode: '6030', type: 'debit', amountCents: 300_000 },
        { accountCode: '6032', type: 'debit', amountCents: 100_000 },
        { accountCode: '2020', type: 'credit', amountCents: 360_000 },
        { accountCode: '2042', type: 'credit', amountCents: 40_000 },
      ],
    })
    const pv = (await call(fin, 'GET', `/splits/preview?payrollRunId=${run.id}`)).json()
    expect(pv.source.kind).toBe('payroll_run')
    expect(pv.baseCents).toBe(400_000)
    const before = await balances(A)
    const r = await call(fin, 'POST', '/splits', { payrollRunId: run.id, mode: 'percent', shares: [{ tenantId: B, percent: 62.5 }], memo: 'Flipd share of October payroll' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().payrollRunId).toBe(run.id)
    expect(r.json().payrollPeriod).toBe('2026-10')
    expect(r.json().shares[0].amountCents).toBe(250_000)
    const after = await balances(A)
    for (const code of ['2020', '2042']) expect(after.get(code)).toBe(before.get(code))
    expect((after.get('6030') ?? 0) - (before.get('6030') ?? 0)).toBe(-187_500)
    expect((after.get('6032') ?? 0) - (before.get('6032') ?? 0)).toBe(-62_500)
    const bBal = await balances(B)
    expect(bBal.get('2020') ?? 0).toBe(0)
    // The accrual entry named directly is the same split (409).
    const dup = await call(fin, 'POST', '/splits', { sourceEntryId: r.json().sourceEntryId, mode: 'percent', shares: [{ tenantId: C, percent: 1 }], memo: 'again' })
    expect(dup.json().error.code).toBe('ALREADY_SPLIT')
    expect((await call(fin, 'GET', `/splits?payrollRunId=${run.id}`)).json().items).toHaveLength(1)
  })

  it('a draft payroll is not split', async () => {
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: A, period: '2026-09', status: 'draft', settings: {} } })
    const r = await call(fin, 'POST', '/splits', { payrollRunId: run.id, mode: 'percent', shares: [{ tenantId: B, percent: 50 }], memo: 'draft' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('PAYROLL_NOT_APPROVED')
  })
})

describe('who and where', () => {
  it('a foreign entry is 404; a non-member of a target is 403; a manager 403; finance without accounting 403', async () => {
    const entryId = await expenseEntry()
    const foreign = await call(ceoD, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: D, percent: 10 }], memo: 'foreign' })
    expect(foreign.statusCode).toBe(404)
    expect((await call(ceoD, 'GET', `/splits/preview?sourceEntryId=${entryId}`)).statusCode).toBe(404)
    const notMember = await call(finAB, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: C, percent: 10 }], memo: 'not mine' })
    expect(notMember.statusCode).toBe(403)
    expect(notMember.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    expect((await call(mgr, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 10 }], memo: 'mgr' })).statusCode).toBe(403)
    expect((await call(finNoAcc, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 10 }], memo: 'no module' })).statusCode).toBe(403)
    // D's CEO sees none of A's splits.
    expect((await call(ceoD, 'GET', '/splits')).json().items).toHaveLength(0)
  })

  it('a closed month in a receiving company is 422 PERIOD_LOCKED and nothing posts', async () => {
    const entryId = await expenseEntry(daysAgo(10))
    const lock = await prisma.periodLock.create({ data: { tenantId: C, lockedThrough: parsePktEndOfDay(daysAgo(8)), lockedBy: ceo.id } })
    try {
      const r = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 10 }, { tenantId: C, percent: 10 }], memo: 'locked' })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
      expect(await prisma.costSplit.count({ where: { sourceEntryId: entryId } })).toBe(0)
      // Dated after the close it goes through.
      const ok = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: C, percent: 10 }], entryDate: daysAgo(1), memo: 'dated later' })
      expect(ok.statusCode, ok.body).toBe(201)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })

  it('a reversed entry is not split', async () => {
    const entryId = await expenseEntry()
    const ref = (await prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId } })).reference!
    const { reverseJournalEntry } = await import('../src/modules/accounting/journal.js')
    await reverseJournalEntry(A, 'manual', ref.slice('manual:'.length), 'mistake', { postedBy: ceo.id })
    const r = await call(fin, 'POST', '/splits', { sourceEntryId: entryId, mode: 'percent', shares: [{ tenantId: B, percent: 10 }], memo: 'dead' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('SOURCE_REVERSED')
  })
})
