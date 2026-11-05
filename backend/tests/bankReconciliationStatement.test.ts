// Bank Reconciliation Statements (owner, 2026-11-05) — modules/reconciliation/brs.ts.
//   - the statement is computed from the ledger + the statement lines; both methods agree; the difference is 0 only
//     when every item is classified (no balancing figure)
//   - uncredited deposits / unpresented cheques carry forward and clear when a later statement line matches them
//   - a reversed entry and its reversal (net zero) are left out
//   - a missing bank charge is booked through the existing adjustment route (posts at once) and leaves the statement
//   - finance submits; only the CEO approves / returns; approval locks the period (match, ignore, import); finance or
//     the CEO reopens (not while a later period is approved); periods never overlap
//   - imports skip lines already imported for the bank; Excel (debit / credit columns, day-first dates) imports
//   - section F needs narration + reference; reports export; company B gets 404
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
import { setupRoutes } from '../src/modules/setup/routes.js'
import { buildXlsx } from '../src/lib/xlsxWriter.js'
import { parseStatementDate } from '../src/modules/reconciliation/service.js'

const P = `brs${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const bank: Record<string, { id: string; accountCode: string }> = {}

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@brs.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const pkt = (day: string) => new Date(`${day}T12:00:00+05:00`)

async function bankEntry(tenantId: string, bankCode: string, amountCents: number, day: string, description = 'Test entry', sourceType = 'test.bank') {
  const sourceId = randomUUID()
  const abs = Math.abs(amountCents)
  await postJournalEntry({
    tenantId, sourceType, sourceId, description, entryDate: pkt(day), postedBy: 'system',
    lines: [
      { accountCode: bankCode, type: amountCents > 0 ? 'debit' : 'credit', amountCents: abs },
      { accountCode: '3010', type: amountCents > 0 ? 'credit' : 'debit', amountCents: abs },
    ],
  })
  return { sourceType, sourceId }
}
const importCsv = (who: string, bankAccountId: string, statementDate: string, rows: string[], closing = 0) => call(who, 'POST', '/reconciliation/bank/imports', {
  bankAccountId, statementDate, openingBalanceCents: 0, closingBalanceCents: closing, filename: 'stmt.csv', fileUrl: 'https://files.example/stmt.csv',
  csv: ['date,description,reference,amount', ...rows].join('\n'),
})
type St = {
  book: { openingCents: number; closingCents: number }; bankClosingCents: number | null
  deposits: Array<{ amountCents: number; journalLineId: string; clearedOn: string | null }>
  cheques: Array<{ amountCents: number; journalLineId: string; clearedOn: string | null }>
  bankCredits: Array<{ amountCents: number; statementLineId: string }>; bankDebits: Array<{ amountCents: number; statementLineId: string }>
  totals: { depositsCents: number; chequesCents: number; bankCreditsCents: number; bankDebitsCents: number; adjustedBankCents: number | null; adjustedBookCents: number; differenceCents: number | null; expectedBankCents: number; bankAdjustmentsCents: number; bookAdjustmentsCents: number }
}
const getRec = async (who: string, id: string) => {
  const r = await call(who, 'GET', `/reconciliation/brs/${id}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as { reconciliation: { status: string; returnNote: string | null }; statement: St; changedSinceApproval: boolean }
}
/** Both methods always agree: books → bank gives what the bank should show. */
const bothMethodsAgree = (s: St) => {
  if (s.bankClosingCents == null) return
  expect(s.totals.expectedBankCents - s.bankClosingCents + (s.totals.differenceCents ?? 0)).toBe(0)
}

const R = (pkr: number) => pkr * 100
let aug = ''
let sep = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'BRS Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'BRS Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
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

  const a1 = await call('finA', 'POST', '/setup/bank-accounts', { name: 'HBL Ops', bankName: 'HBL', accountNumber: '0123-4567' })
  expect(a1.statusCode, a1.body).toBe(201)
  bank.A = a1.json()
  const b1 = await call('finB', 'POST', '/setup/bank-accounts', { name: 'B Ops', bankName: 'MCB' })
  bank.B = b1.json()

  // The books (August): opening, a deposit, a cheque, a late deposit, and an entry reversed the next day.
  await bankEntry(T.A, '1020', R(1_000_000), '2026-08-01', 'Opening funds')
  await bankEntry(T.A, '1020', R(50_000), '2026-08-10', 'Customer deposit')
  await bankEntry(T.A, '1020', -R(30_000), '2026-08-20', 'Cheque 123456 to Alpha Traders')
  await bankEntry(T.A, '1020', R(20_000), '2026-08-30', 'Cash deposited late')
  const wrong = await bankEntry(T.A, '1020', R(5_000), '2026-08-15', 'Posted by mistake')
  await reverseJournalEntry(T.A, wrong.sourceType, wrong.sourceId, 'wrong', { entryDate: pkt('2026-08-16'), postedBy: 'system' })
}, 120_000)

afterAll(async () => { await app?.close() })

describe('the August statement', () => {
  it('creates once per period, in the bank\'s company only', async () => {
    const r = await call('finA', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-08-01', periodTo: '2026-08-31', periodKind: 'month' })
    expect(r.statusCode, r.body).toBe(201)
    aug = r.json().id
    const dup = await call('finA', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-08-15', periodTo: '2026-09-10' })
    expect(code(dup)).toBe('PERIOD_OVERLAPS')
    expect((await call('finB', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-07-01', periodTo: '2026-07-31' })).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/reconciliation/brs/${aug}`)).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-06-01', periodTo: '2026-06-30' })).statusCode).toBe(403)
  })

  it('reads the books and the statement: outstanding items on each side, reversal pair left out, both methods agree', async () => {
    const imp = await importCsv('finA', bank.A!.id, '2026-08-31', [
      '2026-08-01,Opening funds,,1000000', '2026-08-11,Deposit,DEP1,50000', '31/08/2026,Bank charges,,-1500', '31-Aug-2026,Profit credited,,700',
    ], R(1_049_200))
    expect(imp.statusCode, imp.body).toBe(201)
    expect(imp.json()).toMatchObject({ totalRows: 4, matchedCount: 2, skippedDuplicates: 0 })
    await call('finA', 'PATCH', `/reconciliation/brs/${aug}`, { bankClosingCents: R(1_049_200) })
    const { statement: s } = await getRec('finA', aug)
    expect(s.book.closingCents).toBe(R(1_040_000))
    expect(s.deposits.map((d) => d.amountCents)).toEqual([R(20_000)])
    expect(s.cheques.map((d) => d.amountCents)).toEqual([R(30_000)])
    expect(s.bankCredits.map((d) => d.amountCents)).toEqual([R(700)])
    expect(s.bankDebits.map((d) => d.amountCents)).toEqual([R(1_500)])
    expect(s.totals).toMatchObject({ adjustedBankCents: R(1_039_200), adjustedBookCents: R(1_039_200), differenceCents: 0 })
    bothMethodsAgree(s)
  })

  it('a wrong bank balance leaves a difference, and submit refuses it', async () => {
    await call('finA', 'PATCH', `/reconciliation/brs/${aug}`, { bankClosingCents: R(1_049_000) })
    const { statement: s } = await getRec('finA', aug)
    expect(s.totals.differenceCents).toBe(-R(200))
    bothMethodsAgree(s)
    const sub = await call('finA', 'POST', `/reconciliation/brs/${aug}/submit`)
    expect(code(sub)).toBe('UNRECONCILED_DIFFERENCE')
    await call('finA', 'PATCH', `/reconciliation/brs/${aug}`, { bankClosingCents: R(1_049_200) })
  })

  it('booking the bank charge (the existing adjustment route) posts once and moves it into the books', async () => {
    const { statement: s0 } = await getRec('finA', aug)
    const lineId = s0.bankDebits[0]!.statementLineId
    const adj = await call('finA', 'POST', `/reconciliation/bank/lines/${lineId}/adjust`, { memo: 'Bank charges August', contraAccountCode: '6080' })
    expect(adj.statusCode, adj.body).toBe(200)
    const line = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: lineId } })
    expect(line.matchStatus).toBe('adjusted')
    expect(line.matchedJournalLineId).not.toBeNull()
    const { statement: s } = await getRec('finA', aug)
    expect(s.book.closingCents).toBe(R(1_038_500))
    expect(s.bankDebits).toEqual([])
    expect(s.totals.differenceCents).toBe(0)
    bothMethodsAgree(s)
  })

  it('section F needs narration and a reference, counts on its side, and is removed with a reason', async () => {
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/adjustments`, { side: 'bank', kind: 'bank_error', amountCents: 100, narration: 'short', reference: 'x' })).statusCode).toBe(400)
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/adjustments`, { side: 'bank', kind: 'bank_error', amountCents: 100, narration: 'Bank posted twice', reference: '' })).statusCode).toBe(400)
    const add = await call('finA', 'POST', `/reconciliation/brs/${aug}/adjustments`, { side: 'bank', kind: 'bank_error', amountCents: 100, narration: 'Bank keyed the profit twice', reference: 'Bank letter 77' })
    expect(add.statusCode, add.body).toBe(201)
    const { statement: s } = await getRec('finA', aug)
    expect(s.totals.bankAdjustmentsCents).toBe(100)
    expect(s.totals.differenceCents).toBe(100)
    bothMethodsAgree(s)
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/adjustments/${add.json().id}/remove`, { reason: 'Bank corrected it themselves' })).statusCode).toBe(200)
    expect((await getRec('finA', aug)).statement.totals.differenceCents).toBe(0)
  })

  it('under review is a flag only: the item stays where it was', async () => {
    const { statement: s0 } = await getRec('finA', aug)
    const dep = s0.deposits[0]!.journalLineId
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/review`, { journalLineId: dep, underReview: true, note: 'Teller slip missing' })).statusCode).toBe(200)
    const { statement: s } = await getRec('finA', aug)
    expect(s.totals.depositsCents).toBe(s0.totals.depositsCents)
    expect(s.deposits[0]).toMatchObject({ underReview: true })
    await call('finA', 'POST', `/reconciliation/brs/${aug}/review`, { journalLineId: dep, underReview: false })
  })

  it('finance submits; finance cannot approve; the CEO returns, then approves — and the period locks', async () => {
    const sub = await call('finA', 'POST', `/reconciliation/brs/${aug}/submit`)
    expect(sub.statusCode, sub.body).toBe(200)
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/approve`)).statusCode).toBe(403)
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/adjustments`, { side: 'bank', kind: 'other', amountCents: 1, narration: 'not while submitted', reference: 'x' })).statusCode).toBe(409)
    const ret = await call('ceoA', 'POST', `/reconciliation/brs/${aug}/return`, { note: 'Attach the bank letter please' })
    expect(ret.statusCode, ret.body).toBe(200)
    expect((await getRec('finA', aug)).reconciliation).toMatchObject({ status: 'draft', returnNote: 'Attach the bank letter please' })
    expect((await call('finA', 'POST', `/reconciliation/brs/${aug}/submit`)).statusCode).toBe(200)
    const ok = await call('ceoA', 'POST', `/reconciliation/brs/${aug}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await getRec('finA', aug)).reconciliation.status).toBe('approved')

    // Locked: the August lines cannot be ignored / adjusted, and a late August import is refused.
    const { statement: s } = await getRec('finA', aug)
    const profit = s.bankCredits[0]!.statementLineId
    expect(code(await call('finA', 'POST', `/reconciliation/bank/lines/${profit}/ignore`, { reason: 'trying to hide it' }))).toBe('RECONCILIATION_LOCKED')
    expect(code(await call('finA', 'POST', `/reconciliation/bank/lines/${profit}/adjust`, { memo: 'Profit', contraAccountCode: '4200' }))).toBe('RECONCILIATION_LOCKED')
    expect(code(await importCsv('finA', bank.A!.id, '2026-08-31', ['2026-08-25,Late line,,10']))).toBe('RECONCILIATION_LOCKED')
    // The same statement again: every line is a duplicate — skipped, nothing locked is touched.
    const again = await importCsv('finA', bank.A!.id, '2026-08-31', [
      '2026-08-01,Opening funds,,1000000', '2026-08-11,Deposit,DEP1,50000', '31/08/2026,Bank charges,,-1500', '31-Aug-2026,Profit credited,,700',
    ])
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ skippedDuplicates: 4, totalRows: 0 })
  })
})

describe('September: carry forward and clearing', () => {
  it('outstanding items clear against September statement lines; matched by cheque number', async () => {
    const c = await call('finA', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-09-01', periodTo: '2026-09-30', periodKind: 'month', bankClosingCents: R(1_039_200) })
    expect(c.statusCode, c.body).toBe(201)
    sep = c.json().id
    // Before the September statement: August's items carry forward.
    const s0 = (await getRec('finA', sep)).statement
    expect(s0.deposits.map((d) => d.amountCents)).toEqual([R(20_000)])
    expect(s0.cheques.map((d) => d.amountCents)).toEqual([R(30_000)])
    expect(s0.bankCredits.map((d) => d.amountCents)).toEqual([R(700)])

    const imp = await importCsv('finA', bank.A!.id, '2026-09-30', ['2026-09-02,Cash deposit,,20000', '2026-09-14,Clearing CHQ 123456,123456,-30000'])
    expect(imp.json()).toMatchObject({ matchedCount: 1 }) // the deposit (within 3 days); the cheque is 25 days later
    const sug = await call('finA', 'GET', `/reconciliation/brs/${sep}/suggestions?days=30`)
    expect(sug.statusCode, sug.body).toBe(200)
    expect(sug.json()).toHaveLength(1)
    expect(sug.json()[0].reason).toMatch(/cheque/i)
    const apply = await call('finA', 'POST', `/reconciliation/brs/${sep}/auto-match`, { days: 30 })
    expect(apply.json()).toMatchObject({ matched: 1, refused: [] })

    const { statement: s } = await getRec('finA', sep)
    expect(s.deposits).toEqual([])
    expect(s.cheques).toEqual([])
    expect(s.bankCredits.map((d) => d.amountCents)).toEqual([R(700)]) // still not in the books: carried forward
    expect(s.totals.differenceCents).toBe(0)
    bothMethodsAgree(s)

    // August, approved, still shows what was outstanding at 31 August — now with "cleared on".
    const a = await getRec('finA', aug)
    expect(a.statement.cheques.map((d) => d.amountCents)).toEqual([R(30_000)])
    expect(a.changedSinceApproval).toBe(false)
  })

  it('approval order, reopen rules, and the CEO is told when finance reopens', async () => {
    expect((await call('finA', 'POST', `/reconciliation/brs/${sep}/submit`)).statusCode).toBe(200)
    expect((await call('ceoA', 'POST', `/reconciliation/brs/${sep}/approve`)).statusCode).toBe(200)
    expect(code(await call('finA', 'POST', `/reconciliation/brs/${aug}/reopen`, { reason: 'Need to recheck the profit line' }))).toBe('LATER_APPROVED')
    expect((await call('mgrA', 'POST', `/reconciliation/brs/${sep}/reopen`, { reason: 'Need to recheck the profit line' })).statusCode).toBe(403)
    const re = await call('finA', 'POST', `/reconciliation/brs/${sep}/reopen`, { reason: 'Need to recheck the profit line' })
    expect(re.statusCode, re.body).toBe(200)
    expect((await getRec('finA', sep)).reconciliation.status).toBe('draft')
    await new Promise((r) => setTimeout(r, 300))
    expect(await prisma.staffNotification.count({ where: { userId: U.ceoA!.id, kind: 'bank_reconciliation.reopened' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { entity: 'BankReconciliation', entityId: sep, action: 'bank_reconciliation.reopen' } })).toBe(1)
  })

  it('reports export; the dashboard counts; company B sees nothing', async () => {
    for (const f of ['pdf', 'xlsx', 'csv']) {
      const r = await call('finA', 'GET', `/reconciliation/brs/${aug}/report?format=${f}`)
      expect(r.statusCode, `${f} ${r.body.slice(0, 200)}`).toBe(200)
    }
    for (const k of ['cheques', 'deposits', 'unmatched']) expect((await call('finA', 'GET', `/reconciliation/brs/${aug}/report?kind=${k}&format=pdf`)).statusCode).toBe(200)
    const charges = await call('finA', 'GET', '/reconciliation/brs/reports/charges?from=2026-08-01&to=2026-09-30')
    expect(charges.json().map((r: { account: string; debit: number }) => [r.account.slice(0, 4), r.debit])).toEqual([['6080', R(1_500)]])
    const monthly = await call('finA', 'GET', '/reconciliation/brs/reports/monthly?from=2026-08-01&to=2026-09-30')
    expect(monthly.json()).toHaveLength(2)
    expect((await call('finA', 'GET', '/reconciliation/brs/reports/monthly?from=2026-08-01&to=2026-09-30&format=pdf')).statusCode).toBe(200)
    const dash = (await call('finA', 'GET', '/reconciliation/brs/dashboard')).json()
    expect(dash).toMatchObject({ completed: 1, drafts: 1, outstandingChequesCents: R(30_000), uncreditedDepositsCents: R(20_000) })
    expect((await call('finB', 'GET', '/reconciliation/brs')).json()).toEqual([])
    expect((await call('finB', 'GET', '/reconciliation/brs/banks')).json().map((b: { bankAccountId: string }) => b.bankAccountId)).toEqual([bank.B!.id])
  })
})

describe('imports', () => {
  it('reads Pakistani dates and Excel files with debit / credit columns', async () => {
    expect(parseStatementDate('31/10/2026').toISOString().slice(0, 10)).toBe('2026-10-31')
    expect(parseStatementDate('05-Nov-2026').toISOString().slice(0, 10)).toBe('2026-11-05')
    expect(parseStatementDate('46331').toISOString().slice(0, 10)).toBe('2026-11-05')
    expect(Number.isNaN(parseStatementDate('31/02/2026').getTime())).toBe(true)
    const xlsx = buildXlsx({ name: 'Statement', rows: [['Account statement'], ['Date', 'Narration', 'Cheque No', 'Debit', 'Credit'], ['01/10/2026', 'Opening deposit', '', '', '5,000.00'], ['02/10/2026', 'SMS charges', '', '25.50', '']] })
    const r = await call('finA', 'POST', '/reconciliation/bank/imports', {
      bankAccountId: bank.A!.id, statementDate: '2026-10-02', openingBalanceCents: 0, closingBalanceCents: 0, filename: 'stmt.xlsx', fileUrl: 'https://files.example/stmt.xlsx',
      xlsxBase64: xlsx.toString('base64'),
    })
    expect(r.statusCode, r.body).toBe(201)
    const lines = await prisma.bankStatementLine.findMany({ where: { importId: r.json().importId }, orderBy: { postedDate: 'asc' } })
    expect(lines.map((l) => [l.postedDate.toISOString().slice(0, 10), Number(l.amountCents), l.description])).toEqual([
      ['2026-10-01', 500_000, 'Opening deposit'], ['2026-10-02', -2_550, 'SMS charges'],
    ])
  })
})

// Owner, 2026-11-05: "This transaction is cleared and received in bank, why it's showing in uncredited amounts? …
// Give finance option to settle these type of issues" — the book side's own "Match to bank line".
describe('match a deposit to its bank line from the book side', () => {
  let id = ''
  it('lists the same-amount unmatched lines of this bank and matches through the existing engine', async () => {
    await bankEntry(T.A, '1020', R(460_000), '2026-11-03', 'Cash deposited in UBL')
    const c = await call('finA', 'POST', '/reconciliation/brs', { bankAccountId: bank.A!.id, periodFrom: '2026-11-01', periodTo: '2026-11-30', periodKind: 'month' })
    expect(c.statusCode, c.body).toBe(201)
    id = c.json().id as string
    const dep = (await getRec('finA', id)).statement.deposits.find((d) => d.amountCents === R(460_000))!
    expect(dep).toBeTruthy()
    // Nothing on the statement yet.
    expect((await call('finA', 'GET', `/reconciliation/brs/${id}/bank-lines?journalLineId=${dep.journalLineId}`)).json()).toEqual([])
    // The bank credited it 9 days later (too far for the importer's own pairing).
    const imp = await importCsv('finA', bank.A!.id, '2026-11-15', ['12/11/2026,CASH DEP UBL,TRX991,460000', '12/11/2026,Other credit,,1234'])
    expect(imp.statusCode, imp.body).toBe(201)
    const cands = await call('finA', 'GET', `/reconciliation/brs/${id}/bank-lines?journalLineId=${dep.journalLineId}`)
    expect(cands.statusCode, cands.body).toBe(200)
    expect(cands.json().map((x: { amountCents: number; inPeriod: boolean; reference: string }) => [x.amountCents, x.inPeriod, x.reference])).toEqual([[R(460_000), true, 'TRX991']])
    // Company B cannot read A's.
    expect((await call('finB', 'GET', `/reconciliation/brs/${id}/bank-lines?journalLineId=${dep.journalLineId}`)).statusCode).toBe(404)
    const m = await call('finA', 'POST', `/reconciliation/brs/${id}/auto-match`, { pairs: [{ statementLineId: cands.json()[0].statementLineId, journalLineId: dep.journalLineId }] })
    expect(m.json()).toMatchObject({ matched: 1, refused: [] })
    const s = (await getRec('finA', id)).statement
    expect(s.deposits.some((d) => d.journalLineId === dep.journalLineId)).toBe(false)
    expect(s.bankCredits.some((d) => d.amountCents === R(460_000))).toBe(false)
  })

  // Owner, 2026-11-05: "Make it settle by manual entry instead of matching with bank statement".
  it('a cheque is cleared by a manual entry — no posting, out of the outstanding list, undoable', async () => {
    await bankEntry(T.A, '1020', -R(19_481), '2026-11-04', 'Paid to FBR CHQ 87756444')
    const before = (await getRec('finA', id)).statement
    const chq = before.cheques.find((d) => d.amountCents === R(19_481))!
    expect(chq).toBeTruthy()
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const url = `/reconciliation/brs/${id}/cleared-manual`
    // Checks: a note, not before the entry, not in the future; company B 404.
    expect(code(await call('finA', 'POST', url, { journalLineId: chq.journalLineId, cleared: true, clearedOn: '2026-11-05', note: 'short' }))).toBe('VALIDATION_ERROR')
    expect(code(await call('finA', 'POST', url, { journalLineId: chq.journalLineId, cleared: true, clearedOn: '2026-11-03', note: 'Seen on the online statement' }))).toBe('CLEARED_BEFORE_ENTRY')
    expect(code(await call('finA', 'POST', url, { journalLineId: chq.journalLineId, cleared: true, clearedOn: '2099-01-01', note: 'Seen on the online statement' }))).toBe('CLEARED_IN_FUTURE')
    expect((await call('finB', 'POST', url, { journalLineId: chq.journalLineId, cleared: true, clearedOn: '2026-11-05', note: 'Seen on the online statement' })).statusCode).toBe(404)
    const ok = await call('finA', 'POST', url, { journalLineId: chq.journalLineId, cleared: true, clearedOn: '2026-11-05', reference: 'TRX5521', note: 'Seen on the online statement' })
    expect(ok.statusCode, ok.body).toBe(200)
    const s1 = (await getRec('finA', id)).statement as St & { manuallyCleared: Array<{ journalLineId: string; manualClear: { clearedOn: string; reference: string } }> }
    expect(s1.cheques.some((d) => d.journalLineId === chq.journalLineId)).toBe(false)
    expect(s1.totals.chequesCents).toBe(before.totals.chequesCents - R(19_481))
    expect(s1.manuallyCleared.map((m) => [m.journalLineId, m.manualClear.clearedOn, m.manualClear.reference])).toEqual([[chq.journalLineId, '2026-11-05', 'TRX5521']])
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entriesBefore) // nothing posted
    // "Under review" cannot overwrite it; undo brings it back.
    expect(code(await call('finA', 'POST', `/reconciliation/brs/${id}/review`, { journalLineId: chq.journalLineId, underReview: true, note: 'check it' }))).toBe('LINE_CLEARED_MANUAL')
    expect((await call('finA', 'POST', url, { journalLineId: chq.journalLineId, cleared: false })).statusCode).toBe(200)
    const s2 = (await getRec('finA', id)).statement
    expect(s2.cheques.some((d) => d.journalLineId === chq.journalLineId)).toBe(true)
  })
})
