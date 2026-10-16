// Finance final (owner, 2026-10-16) — cash group, the bank side:
//
//   #5  A bank account links only to a BANK code: never cash / petty cash /
//       the drawer / card or customer receivable / till clearing / rider COD /
//       advances / 1357 (422 NOT_A_BANK_CODE), never outside 1000–1099, never
//       a register-controlled account (422 ACCOUNT_CONTROLLED), never another
//       live bank's code (409 BANK_CODE_IN_USE). Re-pointing a bank whose old
//       code still holds money is the CEO's, with a reason (409
//       BANK_CODE_HAS_BALANCE), audited 'bank_account.relink'.
//   #18 Ignore needs a reason (≥10) and is audited; /unignore brings a line
//       back (audited); bank_unmatched reports ignored lines separately.
//   #19 Finance (with accounting) matches by hand (/match, /candidates),
//       books adjustments and unmatches — all audited; a manager without the
//       booker role, or finance without accounting, is refused; company B 404.
//   #32 A reversed entry and its reversal never match a statement line (the
//       import matcher, the manual match) and never count in the night audit's
//       sales_bank_unmatched.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { salesBankUnmatchedBetween } from '../src/modules/reconciliation/service.js'
import { setupRoutes } from '../src/modules/setup/routes.js'
import { CLOSE_CHECKS } from '../src/modules/accounting/closeChecks.js'

const P = `cbr${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const bank: Record<string, { id: string; accountCode: string }> = {}

async function mkUser(key: string, role: UserRole, tenants: string[], extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@cbr.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', moduleDeny: extra.moduleDeny ?? [],
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

async function ensureAccount(tenantId: string, c: string, extra: { controlledBy?: string } = {}) {
  if (!(await prisma.account.findFirst({ where: { tenantId, code: c } }))) {
    await prisma.account.create({ data: { tenantId, code: c, name: `Test ${c}`, type: 'asset', isActive: true, ...extra } })
  }
}
/** A posted entry Dr <bank> / Cr 3010 (or the reverse for a negative amount) on `day`. */
async function bankEntry(tenantId: string, bankCode: string, amountCents: number, day: Date, sourceType = 'test.bank') {
  const sourceId = randomUUID()
  const abs = Math.abs(amountCents)
  await postJournalEntry({
    tenantId, sourceType, sourceId, description: `Test ${sourceType}`, entryDate: day, postedBy: 'system',
    lines: [
      { accountCode: bankCode, type: amountCents > 0 ? 'debit' : 'credit', amountCents: abs },
      { accountCode: '3010', type: amountCents > 0 ? 'credit' : 'debit', amountCents: abs },
    ],
  })
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference: `${sourceType}:${sourceId}` }, include: { lines: { include: { account: true } } } })
  return { sourceType, sourceId, entryId: je.id, bankLineId: je.lines.find((l) => l.account.code === bankCode)!.id }
}
async function statementLine(tenantId: string, bankAccountId: string | null, accountCode: string, amountCents: number, postedDate: Date) {
  const imp = await prisma.bankStatementImport.create({ data: { tenantId, bankAccountId, source: 'bank:test', accountCode, statementDate: postedDate } })
  return prisma.bankStatementLine.create({ data: { importId: imp.id, postedDate, description: `Line ${amountCents}`, amountCents } })
}
const auditCount = (action: string, entityId: string) => prisma.auditLog.count({ where: { action, entityId } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Bank Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Bank Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finNoAcc', 'finance', [T.A], { moduleDeny: ['accounting'] })
  await mkUser('mgrA', 'management', [T.A])
  await mkUser('finB', 'finance', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(reconciliationRoutes, { prefix: '/reconciliation' })
    await api.register(setupRoutes, { prefix: '/setup' })
  }, { prefix: '/api/v1' })
  await app.ready()

  const a1 = await call('finA', 'POST', '/setup/bank-accounts', { name: 'HBL Ops', bankName: 'HBL' })
  expect(a1.statusCode, a1.body).toBe(201)
  bank['A1'] = a1.json()
  expect(bank['A1']!.accountCode).toBe('1020')
  const b1 = await call('finB', 'POST', '/setup/bank-accounts', { name: 'B Ops', bankName: 'MCB' })
  expect(b1.statusCode, b1.body).toBe(201)
  bank['B1'] = b1.json()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('#5 a bank links only to a bank code', () => {
  it('refuses cash, petty cash, receivables, 1357, out-of-band, controlled and another bank\'s code', async () => {
    for (const c of ['1010', '1011', '1015', '1030', '1110', '1115', '1351', '1355', '1357']) {
      const r = await call('finA', 'POST', '/setup/bank-accounts', { name: `Wrong ${c}`, accountCode: c })
      expect(r.statusCode, c).toBe(422)
      expect(code(r), c).toBe('NOT_A_BANK_CODE')
    }
    expect(code(await call('finA', 'POST', '/setup/bank-accounts', { name: 'Stock', accountCode: '1210' }))).toBe('NOT_A_BANK_CODE')
    await ensureAccount(T.A, '1048', { controlledBy: 'fixed_asset' })
    expect(code(await call('finA', 'POST', '/setup/bank-accounts', { name: 'Ctl', accountCode: '1048' }))).toBe('ACCOUNT_CONTROLLED')
    const dup = await call('finA', 'POST', '/setup/bank-accounts', { name: 'Twin', accountCode: '1020' })
    expect(dup.statusCode).toBe(409)
    expect(code(dup)).toBe('BANK_CODE_IN_USE')
    // B's 1020 is B's own: B's bank does not block A, and A's does not block B.
    await ensureAccount(T.A, '1040')
    const ok = await call('finA', 'POST', '/setup/bank-accounts', { name: 'Meezan', bankName: 'Meezan', accountCode: '1040' })
    expect(ok.statusCode, ok.body).toBe(201)
    bank['A2'] = ok.json()
    expect(bank['A2']!.accountCode).toBe('1040')
    expect(await auditCount('bank_account.create', bank['A2']!.id)).toBe(1)
  })

  it('re-pointing a bank that still holds money is the CEO\'s, with a reason; audited; company B 404', async () => {
    await ensureAccount(T.A, '1041')
    await ensureAccount(T.A, '1042')
    await bankEntry(T.A, '1040', 100_000, new Date())
    const fin = await call('finA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1041' })
    expect(fin.statusCode, fin.body).toBe(409)
    expect(code(fin)).toBe('BANK_CODE_HAS_BALANCE')
    expect(code(await call('finA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1041', repointReason: 'Moving to the right code' }))).toBe('BANK_CODE_HAS_BALANCE')
    expect(code(await call('ceoA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1041' }))).toBe('BANK_CODE_HAS_BALANCE')
    expect(code(await call('ceoA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1020', repointReason: 'Moving to the right code' }))).toBe('BANK_CODE_IN_USE')
    expect((await call('finB', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1041' })).statusCode).toBe(404)
    const ceo = await call('ceoA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1041', repointReason: 'Opened on the wrong code by mistake' })
    expect(ceo.statusCode, ceo.body).toBe(200)
    expect(ceo.json().accountCode).toBe('1041')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'bank_account.relink', entityId: bank['A2']!.id } })
    expect(log.tenantId).toBe(T.A)
    expect(log.before).toMatchObject({ accountCode: '1040' })
    expect(log.after).toMatchObject({ accountCode: '1041' })
    // Nothing on the new code yet: finance re-points it alone (audited too).
    const back = await call('finA', 'PATCH', `/setup/bank-accounts/${bank['A2']!.id}`, { accountCode: '1042' })
    expect(back.statusCode, back.body).toBe(200)
    expect(await auditCount('bank_account.relink', bank['A2']!.id)).toBe(2)
  })
})

describe('#18 ignore needs a reason; unignore; the close counts ignored lines', () => {
  it('ignore → reason + audit; unignore brings it back; company B 404', async () => {
    const line = await statementLine(T.A, bank['A1']!.id, '1020', 12_345, new Date())
    const url = `/reconciliation/bank/lines/${line.id}`
    expect((await call('finB', 'POST', `${url}/ignore`, { reason: 'Not ours at all, really' })).statusCode).toBe(404)
    expect((await call('finA', 'POST', `${url}/ignore`, {})).statusCode).toBe(400)
    expect((await call('finA', 'POST', `${url}/ignore`, { reason: 'dup' })).statusCode).toBe(400)
    const ok = await call('finA', 'POST', `${url}/ignore`, { reason: 'Duplicate row from the bank export' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ matchStatus: 'ignored' })
    expect(ok.json().notes).toContain('Duplicate row from the bank export')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'reconciliation.line.ignore', entityId: line.id } })
    expect(log.userId).toBe(U['finA']!.id)
    expect(log.tenantId).toBe(T.A)

    expect((await call('finB', 'POST', `${url}/unignore`, {})).statusCode).toBe(404)
    const back = await call('finA', 'POST', `${url}/unignore`, {})
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json()).toMatchObject({ matchStatus: 'unmatched', notes: null })
    const again = await call('finA', 'POST', `${url}/unignore`, {})
    expect(again.statusCode).toBe(409)
    expect(code(again)).toBe('LINE_NOT_IGNORED')
    expect(await auditCount('reconciliation.line.unignore', line.id)).toBe(1)
  })

  it('bank_unmatched lists lines ignored in the period separately', async () => {
    const C = (await prisma.tenant.create({ data: { name: 'Bank Co C', slug: `${P}-c` } })).id
    const day = new Date('2026-03-15T07:00:00Z')
    const l1 = await statementLine(C, null, '1020', 50_000, day)
    await prisma.bankStatementLine.update({ where: { id: l1.id }, data: { matchStatus: 'ignored', notes: 'Ignored: test' } })
    const check = CLOSE_CHECKS.find((c) => c.key === 'bank_unmatched')!
    const ctx = { db: prisma, tenantId: C, prevLock: null, newLock: new Date('2026-03-31T18:59:59Z'), months: ['2026-03'], isYearEnd: false }
    const p = await check.run(ctx)
    expect(p?.severity).toBe('warn')
    expect(p?.count).toBe(1)
    expect(p?.detail).toMatch(/ignored/)
    // Ignored before the last close: not told again.
    expect(await check.run({ ...ctx, prevLock: new Date('2026-03-20T18:59:59Z') })).toBeNull()
    // Company A's check never counts C's line.
    const pa = await check.run({ ...ctx, tenantId: T.A })
    expect(pa === null || !(pa.detail ?? '').includes('PKR 500')).toBe(true)
  })
})

describe('#19 finance matches by hand, books and unmatches', () => {
  it('manual match: candidates, guards, two companies, audit; unmatch by finance', async () => {
    const booked = new Date('2026-01-10T07:00:00Z')
    const cleared = new Date('2026-04-25T07:00:00Z') // far outside the import's matching window
    const jl = await bankEntry(T.A, '1020', 450_000, booked)
    const other = await bankEntry(T.A, '1020', 450_001, booked)
    const jlB = await bankEntry(T.B, '1020', 450_000, booked)
    const line = await statementLine(T.A, bank['A1']!.id, '1020', 450_000, cleared)
    const url = `/reconciliation/bank/lines/${line.id}`

    // Who: a manager (reconciler, not a booker) and finance without accounting are refused; B is 404.
    expect((await call('mgrA', 'POST', `${url}/match`, { journalLineId: jl.bankLineId })).statusCode).toBe(403)
    expect((await call('finNoAcc', 'POST', `${url}/match`, { journalLineId: jl.bankLineId })).statusCode).toBe(403)
    expect((await call('finB', 'POST', `${url}/match`, { journalLineId: jlB.bankLineId })).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${url}/candidates?days=200`)).statusCode).toBe(404)

    const cands = await call('finA', 'GET', `${url}/candidates?days=200`)
    expect(cands.statusCode, cands.body).toBe(200)
    const ids = (cands.json() as Array<{ journalLineId: string }>).map((c) => c.journalLineId)
    expect(ids).toContain(jl.bankLineId)
    expect(ids).not.toContain(other.bankLineId)
    expect(ids).not.toContain(jlB.bankLineId)

    // B's journal line is not there at all; another amount is refused.
    expect((await call('finA', 'POST', `${url}/match`, { journalLineId: jlB.bankLineId })).statusCode).toBe(404)
    expect(code(await call('finA', 'POST', `${url}/match`, { journalLineId: other.bankLineId }))).toBe('AMOUNT_MISMATCH')
    // The 3010 side of the entry is not on the statement's account.
    const capitalLine = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: jl.entryId, id: { not: jl.bankLineId } } })
    expect(code(await call('finA', 'POST', `${url}/match`, { journalLineId: capitalLine.id }))).toBe('JOURNAL_LINE_NOT_ON_ACCOUNT')

    const ok = await call('finA', 'POST', `${url}/match`, { journalLineId: jl.bankLineId })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ matchStatus: 'matched', matchedJournalLineId: jl.bankLineId })
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'reconciliation.line.match', entityId: line.id } })
    expect(log.tenantId).toBe(T.A)
    expect(log.userId).toBe(U['finA']!.id)

    // A second statement line never takes the same journal line.
    const twin = await statementLine(T.A, bank['A1']!.id, '1020', 450_000, cleared)
    const taken = await call('finA', 'POST', `/reconciliation/bank/lines/${twin.id}/match`, { journalLineId: jl.bankLineId })
    expect(taken.statusCode).toBe(409)
    expect(code(taken)).toBe('JOURNAL_LINE_ALREADY_MATCHED')

    // Unmatch: finance with accounting now; a manager and B are refused.
    expect((await call('mgrA', 'POST', `${url}/unmatch`, {})).statusCode).toBe(403)
    expect((await call('finB', 'POST', `${url}/unmatch`, {})).statusCode).toBe(404)
    const un = await call('finA', 'POST', `${url}/unmatch`, { reason: 'wrong pair' })
    expect(un.statusCode, un.body).toBe(200)
    expect(await auditCount('reconciliation.line.unmatch', line.id)).toBe(1)
  })

  it('finance books a bank fee (audited); a register override stays the CEO\'s', async () => {
    const fee = await statementLine(T.A, bank['A1']!.id, '1020', -2_500, new Date())
    const url = `/reconciliation/bank/lines/${fee.id}/adjust`
    expect((await call('finNoAcc', 'POST', url, { contraAccountCode: '6081', memo: 'SMS charges' })).statusCode).toBe(403)
    expect((await call('mgrA', 'POST', url, { contraAccountCode: '6081', memo: 'SMS charges' })).statusCode).toBe(403)
    expect((await call('finB', 'POST', url, { contraAccountCode: '6081', memo: 'SMS charges' })).statusCode).toBe(404)
    const reg = await call('finA', 'POST', url, { contraAccountCode: '1510', memo: 'oven', registerOverride: { reason: 'Oven deposit paid by bank' } })
    expect(reg.statusCode).toBe(403)
    expect(code(reg)).toBe('REGISTER_OVERRIDE_CEO_ONLY')
    const ok = await call('finA', 'POST', url, { contraAccountCode: '6081', memo: 'SMS charges' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: fee.id } })).matchStatus).toBe('adjusted')
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: T.A, reference: `reconciliation.adjustment:${fee.id}` } })
    expect(je.tenantId).toBe(T.A)
    expect(await auditCount('reconciliation.line.adjust', fee.id)).toBe(1)
  })
})

describe('#32 reversed entries never match', () => {
  it('the import matcher pairs the live re-post, not the reversed original; manual match refuses the dead one', async () => {
    const day = new Date('2026-02-10T07:00:00Z')
    // The original and its reversal first, the re-post last (as syncSourcePosting does).
    const original = await bankEntry(T.A, '1042', 70_000, day, 'test.sync')
    await reverseJournalEntry(T.A, original.sourceType, original.sourceId, 'resynced', { entryDate: day })
    const repost = await bankEntry(T.A, '1042', 70_000, day, 'test.sync2')
    const imp = await call('finA', 'POST', '/reconciliation/bank/imports', {
      bankAccountId: bank['A2']!.id, statementDate: '2026-02-10', openingBalanceCents: 0, closingBalanceCents: 70_000,
      filename: 'meezan.csv', fileUrl: 'https://example.com/meezan.csv',
      csv: 'date,description,amount\n2026-02-10,Transfer in,700',
    })
    expect(imp.statusCode, imp.body).toBe(201)
    expect(imp.json().matchedCount).toBe(1)
    const line = await prisma.bankStatementLine.findFirstOrThrow({ where: { importId: imp.json().importId } })
    expect(line.matchedJournalLineId).toBe(repost.bankLineId)

    const second = await statementLine(T.A, bank['A2']!.id, '1042', 70_000, day)
    const cands = (await call('finA', 'GET', `/reconciliation/bank/lines/${second.id}/candidates`)).json() as Array<{ journalLineId: string }>
    expect(cands.map((c) => c.journalLineId)).not.toContain(original.bankLineId)
    const dead = await call('finA', 'POST', `/reconciliation/bank/lines/${second.id}/match`, { journalLineId: original.bankLineId })
    expect(dead.statusCode).toBe(422)
    expect(code(dead)).toBe('ENTRY_REVERSED')
  })

  it('sales_bank_unmatched does not count a reversed sales line or its reversal', async () => {
    const day = new Date('2026-02-20T07:00:00Z')
    const sale = await bankEntry(T.A, '1020', 33_000, day, 'order.complete')
    const from = new Date('2026-02-19T19:00:00Z')
    const to = new Date('2026-02-20T18:59:59Z')
    expect((await salesBankUnmatchedBetween(prisma, T.A, from, to)).count).toBe(1)
    await reverseJournalEntry(T.A, sale.sourceType, sale.sourceId, 'wrong order', { entryDate: day })
    expect(await salesBankUnmatchedBetween(prisma, T.A, from, to)).toEqual({ count: 0, cents: 0 })
  })
})
