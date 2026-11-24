// One-click merge of two ledger accounts, and the shareholder funding page (owner, 2026-11-24;
// accounting/accountMerge.ts, accounting/shareholders.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole, AccountType } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { trialBalance } from '../src/modules/accounting/reports.js'

const P = `am${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const A: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@am.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code
async function mkAcc(key: string, t: string, accCode: string, name: string, type: AccountType, plSection: string | null = null) {
  A[key] = (await prisma.account.create({ data: { tenantId: t, code: accCode, name, type, plSection } })).id
}
let n = 0
const post = (t: string, debit: string, credit: string, amountCents: number, entryDate: Date, description: string) =>
  postJournalEntry({ tenantId: t, sourceType: 'manual', sourceId: `${P}-${++n}`, description, entryDate, postedBy: U['ceoA']!.id,
    lines: [{ accountCode: debit, type: 'debit', amountCents, memo: `${description} memo` }, { accountCode: credit, type: 'credit', amountCents }] })
const R = '/accounting/account-merges'
const oct = new Date('2026-10-10T07:00:00Z')
const nov = new Date('2026-11-10T07:00:00Z')
const balOf = async (t: string, accCode: string) => {
  const acc = await prisma.account.findFirstOrThrow({ where: { tenantId: t, code: accCode } })
  const g = await prisma.journalLine.groupBy({ by: ['type'], _sum: { amountCents: true }, where: { accountId: acc.id } })
  const of = (k: string) => Number(g.find((x) => x.type === k)?._sum.amountCents ?? 0)
  return of('debit') - of('credit')
}
const tbTotals = async (t: string) => {
  const tb = await trialBalance([t], new Date('2027-01-01T00:00:00Z')) as unknown as Record<string, unknown>
  const { rows: _r, accounts: _a, ...rest } = tb
  return JSON.stringify(rest)
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('mgrA', 'manager', [T.A])
  await mkUser('finB', 'finance', [T.B])
  await mkUser('ceoB', 'admin', [T.B])
  await mkAcc('old', T.A, '6301', 'Internet (old)', 'expense', 'operating_expense')
  await mkAcc('keep', T.A, '6302', 'Internet & IT', 'expense', 'operating_expense')
  await mkAcc('cos', T.A, '5101', 'Kitchen gas', 'expense', 'cost_of_sales')
  await mkAcc('loan', T.A, '2301', 'Loan — partner', 'liability')
  await mkAcc('loan2', T.A, '2302', 'Loan — GS', 'liability')
  await mkAcc('bOld', T.B, '6301', 'B old', 'expense', 'operating_expense')
  await mkAcc('bKeep', T.B, '6302', 'B keep', 'expense', 'operating_expense')
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(accountingRoutes, { prefix: '/accounting' }) }, { prefix: '/api/v1' })
  await app.ready()
  await post(T.A, '6301', '1010', 10_000, oct, 'October internet')
  await post(T.A, '6301', '1010', 25_000, nov, 'November internet')
  await post(T.A, '6302', '1010', 7_000, nov, 'IT support')
  await post(T.B, '6301', '1010', 3_000, nov, 'B internet')
}, 120_000)

afterAll(async () => { await app?.close() })

describe('one-click merge of two ledger accounts', () => {
  it('who may ask and what is refused', async () => {
    const body = { fromAccountId: A.old, intoAccountId: A.keep, reason: 'Duplicate internet account' }
    expect((await call('mgrA', 'POST', R, body)).statusCode).toBe(403)
    // Another company's accounts are not found — either side.
    expect((await call('finB', 'POST', R, body)).statusCode).toBe(404)
    expect((await call('finA', 'POST', R, { ...body, intoAccountId: A.bKeep })).statusCode).toBe(404)
    expect(code(await call('finA', 'POST', R, { ...body, intoAccountId: A.old }))).toBe('SAME_ACCOUNT')
    expect(code(await call('finA', 'POST', R, { ...body, intoAccountId: A.loan }))).toBe('MERGE_TYPE_MISMATCH')
    expect(code(await call('finA', 'POST', R, { ...body, intoAccountId: A.cos }))).toBe('MERGE_SECTION_MISMATCH')
    // An account servd posts to itself is never merged, on either side.
    const cash = (await prisma.account.findFirstOrThrow({ where: { tenantId: T.A, code: '6140' } })).id
    expect(code(await call('finA', 'POST', R, { ...body, intoAccountId: cash }))).toBe('MERGE_NOT_HAND_MADE')
    expect(code(await call('finA', 'POST', R, { ...body, fromAccountId: cash }))).toBe('MERGE_NOT_HAND_MADE')
    const pre = (await call('finA', 'GET', `${R}/preview?fromAccountId=${A.old}&intoAccountId=${A.keep}`)).json()
    expect(pre).toMatchObject({ lineCount: 2, debitCents: 35_000, creditCents: 0, blockers: [] })
  })

  it('closed books block it; finance asks, the CEO approves and the entries themselves move', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date('2026-10-31T18:59:59.999Z'), lockedBy: U['ceoA']!.id } })
    const body = { fromAccountId: A.old, intoAccountId: A.keep, reason: 'Duplicate internet account' }
    expect(code(await call('finA', 'POST', R, body))).toBe('ENTRIES_IN_CLOSED_BOOKS')
    await prisma.periodLock.delete({ where: { id: lock.id } })

    const tbBefore = await tbTotals(T.A)
    const ask = await call('finA', 'POST', R, body)
    expect(ask.statusCode, ask.body).toBe(202)
    const id = ask.json().request.id
    // Nothing moved; one waiting merge per account.
    expect(await prisma.journalLine.count({ where: { accountId: A.old } })).toBe(2)
    expect(code(await call('finA', 'POST', R, body))).toBe('MERGE_PENDING')
    expect((await call('finA', 'POST', `${R}/${id}/approve`, {})).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `${R}/${id}/approve`, {})).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${R}?status=pending`)).json().items).toHaveLength(0)

    const lineBefore = await prisma.journalLine.findFirstOrThrow({ where: { accountId: A.old, amountCents: 10_000 }, include: { journalEntry: true } })
    const ok = await call('ceoA', 'POST', `${R}/${id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().lineCount).toBe(2)
    // The same line, same entry, date, narration and memo — now on the kept account.
    const lineAfter = await prisma.journalLine.findUniqueOrThrow({ where: { id: lineBefore.id }, include: { journalEntry: true } })
    expect(lineAfter.accountId).toBe(A.keep)
    expect(lineAfter.memo).toBe(lineBefore.memo)
    expect(lineAfter.journalEntry.description).toBe('October internet')
    expect(lineAfter.journalEntry.entryDate.getTime()).toBe(lineBefore.journalEntry.entryDate.getTime())
    expect(await prisma.journalLine.count({ where: { accountId: A.old } })).toBe(0)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: A.old } })).isActive).toBe(false)
    expect(await balOf(T.A, '6302')).toBe(42_000)
    expect(await balOf(T.A, '6301')).toBe(0)
    // The books' totals never moved, and company B was never touched.
    expect(await tbTotals(T.A)).toBe(tbBefore)
    expect(await prisma.journalLine.count({ where: { accountId: A.bOld } })).toBe(1)
    expect(await prisma.accountMergeLine.count({ where: { mergeId: id } })).toBe(2)
    expect(code(await call('ceoA', 'POST', `${R}/${id}/approve`, {}))).toBe('REQUEST_NOT_PENDING')

    // Undo: exactly the recorded lines go back.
    expect((await call('finA', 'POST', `${R}/${id}/undo`, { reason: 'Merged the wrong account' })).statusCode).toBe(403)
    const undo = await call('ceoA', 'POST', `${R}/${id}/undo`, { reason: 'Merged the wrong account' })
    expect(undo.statusCode, undo.body).toBe(200)
    expect(await balOf(T.A, '6301')).toBe(35_000)
    expect(await balOf(T.A, '6302')).toBe(7_000)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: A.old } })).isActive).toBe(true)
  })

  it('the CEO merges at once, with sub-accounts; reject and withdraw', async () => {
    const sub = await prisma.subAccount.create({ data: { tenantId: T.A, accountId: A.old, name: 'Office line' } })
    const line = await prisma.journalLine.findFirstOrThrow({ where: { accountId: A.old, amountCents: 25_000 } })
    await prisma.journalLineSubAccount.create({ data: { tenantId: T.A, journalLineId: line.id, subAccountId: sub.id, amountCents: 25_000 } })
    const ask = await call('finA', 'POST', R, { fromAccountId: A.old, intoAccountId: A.keep, reason: 'Duplicate internet account' })
    expect(code(await call('ceoA', 'POST', `${R}/${ask.json().request.id}/reject`, { note: 'short' }))).toBe('VALIDATION_ERROR')
    expect((await call('ceoA', 'POST', `${R}/${ask.json().request.id}/reject`, { note: 'Not now — after the audit' })).statusCode).toBe(200)
    const ask2 = await call('finA', 'POST', R, { fromAccountId: A.old, intoAccountId: A.keep, reason: 'Duplicate internet account' })
    expect((await call('finA', 'POST', `${R}/${ask2.json().request.id}/withdraw`, {})).statusCode).toBe(200)

    const done = await call('ceoA', 'POST', R, { fromAccountId: A.old, intoAccountId: A.keep, reason: 'Duplicate internet account' })
    expect(done.statusCode, done.body).toBe(201)
    expect(done.json().merge).toMatchObject({ status: 'done', lineCount: 2 })
    expect((await prisma.subAccount.findUniqueOrThrow({ where: { id: sub.id } })).accountId).toBe(A.keep)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: A.keep } })).subAccountsEnabled).toBe(true)
    expect(await balOf(T.A, '6302')).toBe(42_000)
  })
})

describe('shareholder funding against the agreed split', () => {
  const S = '/accounting/shareholders'
  it('the CEO sets it per company; figures come from the ledger; other companies see nothing', async () => {
    await post(T.A, '1010', '2301', 578_000_00, nov, 'Partner loan')
    await post(T.A, '1010', '2302', 580_430_00, nov, 'GS loan')
    const set = { shareholders: [{ name: 'Yousuf', sharePercent: 60, accountCodes: ['2301'] }, { name: 'GS Foods', sharePercent: 40, accountCodes: ['2302'] }] }
    expect((await call('finA', 'PUT', S, set)).statusCode).toBe(403)
    expect(code(await call('ceoA', 'PUT', S, { shareholders: [{ ...set.shareholders[0], sharePercent: 50 }, set.shareholders[1]] }))).toBe('SHARES_NOT_100')
    expect(code(await call('ceoA', 'PUT', S, { shareholders: [set.shareholders[0], { ...set.shareholders[1], accountCodes: ['2301'] }] }))).toBe('ACCOUNT_LISTED_TWICE')
    expect(code(await call('ceoA', 'PUT', S, { shareholders: [set.shareholders[0], { ...set.shareholders[1], accountCodes: ['6302'] }] }))).toBe('ACCOUNT_NOT_ALLOWED')
    expect((await call('ceoA', 'PUT', S, set)).statusCode).toBe(200)

    const r = (await call('finA', 'GET', S)).json()
    expect(r.totalCents).toBe(1_158_430_00)
    const [y, g] = r.shareholders
    expect(y).toMatchObject({ name: 'Yousuf', sharePercent: 60, fundedCents: 578_000_00, expectedCents: 695_058_00, varianceCents: -117_058_00 })
    expect(g).toMatchObject({ name: 'GS Foods', fundedCents: 580_430_00, expectedCents: 463_372_00, varianceCents: 117_058_00, topUpCents: 0 })
    // For 60 / 40 with nobody taking money out: GS 580,430 = 40% → Yousuf should stand at 870,645.
    expect(y.topUpCents).toBe(870_645_00 - 578_000_00)
    // As at a day before the loans: nothing funded.
    expect((await call('finA', 'GET', `${S}?asOf=2026-10-31`)).json().totalCents).toBe(0)
    expect((await call('mgrA', 'GET', S)).statusCode).toBe(403)
    // Company B has none set, and its CEO's save lands in B only.
    expect((await call('finB', 'GET', S)).json().shareholders).toHaveLength(0)
    expect(code(await call('ceoB', 'PUT', S, { shareholders: [{ name: 'X', sharePercent: 100, accountCodes: ['2301'] }] }))).toBe('ACCOUNT_NOT_ALLOWED')
    expect(await prisma.shareholder.count({ where: { tenantId: T.A } })).toBe(2)
  })
})
