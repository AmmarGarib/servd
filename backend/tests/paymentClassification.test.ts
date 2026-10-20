// Internal payment classification & management reporting (owner, 2026-10-20).
// A REPORTING DIMENSION on payments (Official / Unofficial / Unclassified):
// classified at pay through the payment routes (cash voucher, supplier
// payment, OpEx payment, payroll paid), changed afterwards singly (PUT) or in
// bulk (POST /classify) by the CEO or finance with 'accounting'. The register
// filters by classification, totals tie to the ledger, and NOTHING in the
// books changes: trial balance, P&L and the WHT register are identical before
// and after classifying. Two companies: B never sees or touches A's payments.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { linkBankLedgerAccount } from '../src/lib/bankAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { trialBalance, profitAndLoss } from '../src/modules/accounting/reports.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../src/modules/accounting/dates.js'
import { paymentsRoutes } from '../src/modules/accounting/paymentsRoutes.js'
import { withholdingRoutes } from '../src/modules/accounting/withholdingRoutes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { opexRoutes } from '../src/modules/opex/routes.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let A = '', B = ''
let bankA = ''
const who: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, tenants: string[], extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${key} ${RUN}`, email: `${key}.${RUN}@paycls.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId: tenants[0]!, moduleDeny: extra.moduleDeny ?? [],
    },
  })
  for (const t of tenants) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (w: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${who[w]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })
const code = (r: { json: () => { error?: { code?: string } } }) => r.json().error?.code
const today = () => fmtPktDate(new Date())

/** A manual entry: Dr 6040 / Cr `credit` (1010 = a cash payment). */
async function manual(tenantId: string, tag: string, cents: number, credit = '1010', debit = '6040') {
  return (await postJournalEntry({
    tenantId, sourceType: 'manual', sourceId: `${tag}-${RUN}`, description: `Manual ${tag}`, postedBy: 'test',
    lines: [{ accountCode: debit, type: 'debit', amountCents: cents }, { accountCode: credit, type: 'credit', amountCents: cents }],
  })).entryId
}
const entryOf = async (tenantId: string, reference: string) =>
  (await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, orderBy: { createdAt: 'desc' }, select: { id: true } })).id
const classOf = async (journalEntryId: string) => prisma.paymentClassification.findUnique({ where: { journalEntryId } })

type Reg = {
  rows: Array<{ journalEntryId: string; classification: string; category: string; method: string; payee: string; voucherNumber: string; grossCents: number; whtCents: number; netCents: number; taxStatus: string | null; taxStatusSource: string; nonDeductionReason: string | null }>
  totals: Record<string, { count: number; netCents: number; grossCents: number; whtCents: number }>
  summary: { methods: Array<{ key: string; label: string }>; rows: Array<{ classification: string; cells: Record<string, { count: number; netCents: number }>; total: { count: number; netCents: number } }> }
  tieOut: { ties: boolean; paymentsNetCents: number; registerNetCents: number; differenceCents: number; moneyCreditsCents: number; transfersAndReceiptsCents: number; reversedCents: number }
}
const register = async (w: string, q = '') => {
  const r = await call(w, 'GET', `/accounting/payments?from=${today()}&to=${today()}${q}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Reg
}

/** Everything the books and the statutory reports say about company A, as a string. */
async function booksSnapshot(): Promise<string> {
  const asOf = parsePktEndOfDay(today())
  const tb = await trialBalance([A], asOf)
  const pl = await profitAndLoss([A], parsePktStartOfDay(`${today().slice(0, 7)}-01`), asOf)
  const wht = await call('ceoA', 'GET', `/accounting/withholding/register?from=${today().slice(0, 7)}-01&to=${today()}`)
  expect(wht.statusCode, wht.body).toBe(200)
  const entries = await prisma.journalEntry.count({ where: { tenantId: A } })
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: A } }, select: { id: true, accountId: true, type: true, amountCents: true }, orderBy: { id: 'asc' } })
  return JSON.stringify({ tb, pl, wht: wht.json(), entries, lines: lines.map((l) => [l.id, l.accountId, l.type, Number(l.amountCents)]) })
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  invalidateSetupCache()
  A = (await prisma.tenant.create({ data: { name: `PayCls A ${RUN}`, slug: `paycls-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `PayCls B ${RUN}`, slug: `paycls-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  const codeA = await linkBankLedgerAccount(A, `PayCls Bank ${RUN}`)
  bankA = (await prisma.bankAccount.create({ data: { tenantId: A, name: `PayCls Bank ${RUN}`, bankName: 'HBL', accountCode: codeA } })).id

  await mkUser('ceoA', 'admin', [A])
  await mkUser('finA', 'finance', [A])
  await mkUser('finB', 'finance', [B])
  await mkUser('finNoAcctA', 'finance', [A], { moduleDeny: ['accounting'] })
  await mkUser('mgmtA', 'management', [A])
  await mkUser('mgrA', 'fnb_manager', [A])
  await mkUser('cookA', 'boh', [A])

  app = Fastify({ bodyLimit: 10 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(paymentsRoutes, { prefix: '/accounting/payments' })
    await api.register(withholdingRoutes, { prefix: '/accounting/withholding' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(opexRoutes, { prefix: '/opex' })
    await api.register(hrRoutes, { prefix: '/hr' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { invalidateSetupCache(); await app?.close() })

describe('classified at pay, through the payment routes', () => {
  it('cash voucher: finance pays from cash on hand with Unofficial + not deducted + reason', async () => {
    const raised = await call('finA', 'POST', '/trustops/cash-vouchers', {
      kind: 'expense', payeeName: 'Fast Couriers', purpose: `Courier charges ${RUN}`, categoryKey: 'transport', amountCents: 30_000, payFrom: 'cash',
    })
    expect(raised.statusCode, raised.body).toBe(201)
    const v = raised.json() as { id: string; number: string }
    expect((await call('ceoA', 'POST', `/trustops/cash-vouchers/${v.id}/approve`, {})).statusCode).toBe(200)
    // A reason under 10 characters for "not deducted" is refused before any cash leaves.
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${v.id}/pay`, { classification: 'unofficial', taxStatus: 'not_deducted', nonDeductionReason: 'small' }))).toBe('NON_DEDUCTION_REASON_REQUIRED')
    const paid = await call('finA', 'POST', `/trustops/cash-vouchers/${v.id}/pay`, {
      classification: 'unofficial', taxStatus: 'not_deducted', nonDeductionReason: 'Courier below the withholding threshold',
    })
    expect(paid.statusCode, paid.body).toBe(200)
    ids.voucher = paid.json().journalEntryId
    expect(await classOf(ids.voucher!)).toMatchObject({ tenantId: A, classification: 'unofficial', taxStatus: 'not_deducted', setById: who.finA!.id })
    ids.voucherNumber = v.number
  })

  it('supplier payment (cheque from the bank): Official', async () => {
    const sup = (await prisma.supplier.create({ data: { name: `Mill ${RUN}`, tenantId: A, paymentTermsDays: 10, filerStatus: 'filer' } })).id
    const bill = await call('finA', 'POST', '/procurement/bills', {
      supplierId: sup, billNumber: `PC-${RUN}`, billDate: today(),
      lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: 50_000, expenseAccountCode: '6040' }],
    })
    expect(bill.statusCode, bill.body).toBe(201)
    const pay = await call('finA', 'POST', '/procurement/payments', {
      supplierId: sup, paymentDate: today(), method: 'cheque', bankAccountId: bankA, reference: `CHQ-${RUN}`, amountCents: 50_000,
      applications: [{ billId: bill.json().id, amountAppliedCents: 50_000 }], classification: 'official', taxStatus: 'not_applicable',
    })
    expect(pay.statusCode, pay.body).toBe(201)
    ids.supplier = await entryOf(A, `supplier.payment:${pay.json().id}`)
    expect(pay.json()).toMatchObject({ classification: 'official', paymentEntryId: ids.supplier })
    expect(await classOf(ids.supplier!)).toMatchObject({ tenantId: A, classification: 'official' })
  })

  it('OpEx payment: Official; the OpEx list carries the classification', async () => {
    const cat = await prisma.opexCategory.create({ data: { tenantId: A, name: `Cleaning ${RUN}`, expenseAccountCode: '6040' } })
    const line = await prisma.opexLine.create({ data: { categoryId: cat.id, name: 'Office cleaning', amountCents: 20_000, bankAccountId: bankA } })
    const p = await call('ceoA', 'POST', '/opex/payments', {
      lineId: line.id, periodStart: `${today().slice(0, 7)}-01`, periodEnd: today(), expectedCents: 20_000, paidAt: today(), classification: 'official',
    })
    expect(p.statusCode, p.body).toBe(201)
    ids.opex = await entryOf(A, `opex.payment:${p.json().id}`)
    expect(await classOf(ids.opex!)).toMatchObject({ classification: 'official' })
    const list = await call('ceoA', 'GET', '/opex/categories')
    expect(list.statusCode, list.body).toBe(200)
    {
      const pays = (list.json() as Array<{ lines: Array<{ payments: Array<{ id: string; classification: string | null }> }> }>)
        .flatMap((c) => c.lines.flatMap((l) => l.payments))
      expect(pays.find((x) => x.id === p.json().id)?.classification).toBe('official')
    }
  })

  it('payroll paid: Unofficial; WHT is the salary tax the accrual took (2042)', async () => {
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: A, period: '2026-09', status: 'locked', settings: {} } })
    await postJournalEntry({
      tenantId: A, sourceType: 'hr.payroll.accrual', sourceId: run.id, description: 'Payroll 2026-09 accrued',
      lines: [
        { accountCode: '6030', type: 'debit', amountCents: 120_000 },
        { accountCode: '2020', type: 'credit', amountCents: 100_000 },
        { accountCode: '2042', type: 'credit', amountCents: 20_000 },
      ],
    })
    const r = await call('ceoA', 'POST', `/hr/payroll/runs/${run.id}/paid`, { from: 'cash', classification: 'unofficial' })
    expect(r.statusCode, r.body).toBe(200)
    ids.payroll = await entryOf(A, `hr.payroll.payment:${run.id}`)
    expect(await classOf(ids.payroll!)).toMatchObject({ classification: 'unofficial' })
    const runs = await call('ceoA', 'GET', '/hr/payroll/runs')
    expect(runs.statusCode, runs.body).toBe(200)
    expect((runs.json() as Array<{ id: string; paymentClassification: string | null }>).find((x) => x.id === run.id)?.paymentClassification).toBe('unofficial')
  })
})

describe('the register', () => {
  it('lists payments only (transfers, accruals, reversed entries out); omitted = Unclassified; filters and totals; ties to the ledger', async () => {
    ids.plain = await manual(A, 'plain', 7_000)                       // a cash payment, no classification sent
    await manual(A, 'transfer', 40_000, '1010', (await prisma.bankAccount.findUniqueOrThrow({ where: { id: bankA } })).accountCode!) // cash → bank: not a payment
    ids.accrual = await manual(A, 'accrual', 3_000, '2010')           // nothing left a money account
    const gone = await manual(A, 'gone', 9_000)
    await reverseJournalEntry(A, 'manual', `gone-${RUN}`, 'entered twice', { postedBy: 'test' })

    const all = await register('ceoA')
    const byId = new Map(all.rows.map((r) => [r.journalEntryId, r]))
    for (const k of ['voucher', 'supplier', 'opex', 'payroll', 'plain']) expect(byId.has(ids[k]!), k).toBe(true)
    expect(byId.has(ids.accrual!)).toBe(false)
    expect(byId.has(gone)).toBe(false)
    expect(all.rows.some((r) => r.netCents === 40_000)).toBe(false)

    expect(byId.get(ids.plain!)).toMatchObject({ classification: 'unclassified', category: 'manual', method: 'cash', netCents: 7_000 })
    expect(byId.get(ids.voucher!)).toMatchObject({ category: 'cash_voucher', method: 'cash', voucherNumber: ids.voucherNumber, payee: 'Fast Couriers', taxStatus: 'not_deducted', nonDeductionReason: 'Courier below the withholding threshold' })
    expect(byId.get(ids.supplier!)).toMatchObject({ category: 'vendor', method: 'cheque', voucherNumber: `CHQ-${RUN}`, payee: `Mill ${RUN}` })
    expect(byId.get(ids.opex!)).toMatchObject({ category: 'opex', method: 'bank' })
    expect(byId.get(ids.payroll!)).toMatchObject({ category: 'salaries', netCents: 100_000, whtCents: 20_000, grossCents: 120_000, taxStatus: 'deducted', taxStatusSource: 'derived' })

    const off = await register('ceoA', '&classification=official')
    expect(off.rows.map((r) => r.journalEntryId).sort()).toEqual([ids.supplier!, ids.opex!].sort())
    const unoff = await register('finA', '&classification=unofficial')
    expect(unoff.rows.map((r) => r.journalEntryId).sort()).toEqual([ids.voucher!, ids.payroll!].sort())
    const uncl = await register('mgmtA', '&classification=unclassified')
    expect(uncl.rows.map((r) => r.journalEntryId)).toEqual([ids.plain!])

    expect(all.totals.all!.netCents).toBe(all.totals.official!.netCents + all.totals.unofficial!.netCents + all.totals.unclassified!.netCents)
    expect(all.totals.official!.netCents).toBe(70_000)
    expect(all.totals.unofficial!.netCents).toBe(130_000)
    expect(all.tieOut.ties).toBe(true)
    expect(all.tieOut.paymentsNetCents).toBe(all.totals.all!.netCents)
    expect(all.tieOut.reversedCents).toBe(9_000)    // the reversed entry's credit (its reversal debits cash back)
    expect(all.tieOut.moneyCreditsCents).toBe(all.tieOut.paymentsNetCents + all.tieOut.reversedCents + all.tieOut.transfersAndReceiptsCents)

    // Filters by category / method / text.
    expect((await register('ceoA', '&category=vendor')).rows.map((r) => r.journalEntryId)).toEqual([ids.supplier!])
    expect((await register('ceoA', '&method=cheque')).rows.map((r) => r.journalEntryId)).toEqual([ids.supplier!])
    expect((await register('ceoA', '&q=fast%20couriers')).rows.map((r) => r.journalEntryId)).toEqual([ids.voucher!])

    // The summary grid: classification × method, row and column totals tie to the tiles; unaffected by a method filter.
    const g = all.summary
    expect(g.methods.map((m) => m.key)).toEqual(expect.arrayContaining(['cash', 'petty_cash', 'bank', 'cheque']))
    const line = (c: string) => g.rows.find((r) => r.classification === c)!
    for (const c of ['official', 'unofficial', 'unclassified', 'all']) {
      expect(line(c).total.netCents).toBe(all.totals[c]!.netCents)
      expect(Object.values(line(c).cells).reduce((t, x) => t + x.netCents, 0)).toBe(line(c).total.netCents)
    }
    for (const m of g.methods) {
      expect(line('all').cells[m.key]!.netCents).toBe(['official', 'unofficial', 'unclassified'].reduce((t, c) => t + line(c).cells[m.key]!.netCents, 0))
    }
    expect(line('official').cells['cheque']!.netCents).toBe(byId.get(ids.supplier!)!.netCents)
    expect(line('unclassified').cells['cash']!.netCents).toBe(7_000)
    expect((await register('ceoA', '&method=cheque')).summary).toEqual(g)
    const sx = await call('finA', 'GET', `/accounting/payments?from=${today()}&to=${today()}&view=summary&format=csv`)
    expect(sx.statusCode).toBe(200)
    expect(sx.body).toContain('TOTAL')
    expect(sx.body.split('\n')[0]).toContain('classification,cash,petty_cash,bank')

    // CSV with the report columns.
    const csv = await call('finA', 'GET', `/accounting/payments/payments.csv?from=${today()}&to=${today()}&classification=unofficial`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.split('\n')[0]).toContain('date,voucher_no,narration,payment_method,total_amount,classification')
    expect(csv.body).toContain(',U\r\n')
    expect(csv.body).toContain('Fast Couriers')
    expect(csv.body).not.toContain(`Mill ${RUN}`)
  })

  it('company B never sees A\'s payments; readers only (a cook / a manager is refused)', async () => {
    await manual(B, 'b-pay', 4_000)
    const b = await register('finB')
    expect(b.rows.every((r) => !Object.values(ids).includes(r.journalEntryId))).toBe(true)
    expect(b.rows).toHaveLength(1)
    expect((await call('finB', 'GET', `/accounting/payments/${ids.plain}`)).statusCode).toBe(404)
    expect((await call('ceoA', 'GET', `/accounting/payments/${ids.plain}`)).statusCode).toBe(200)
    expect((await call('cookA', 'GET', '/accounting/payments')).statusCode).toBe(403)
    expect((await call('mgrA', 'GET', '/accounting/payments')).statusCode).toBe(403)
    expect((await call('finNoAcctA', 'GET', '/accounting/payments')).statusCode).toBe(403)
  })
})

describe('changing a classification afterwards', () => {
  it('CEO / finance only; foreign 404; non-payment 422; a reason to change; audited; the books are identical', async () => {
    const before = await booksSnapshot()
    const put = (w: string, id: string, body: Record<string, unknown>) => call(w, 'PUT', `/accounting/payments/${id}/classification`, body)

    expect((await put('mgrA', ids.plain!, { classification: 'official' })).statusCode).toBe(403)
    expect((await put('mgmtA', ids.plain!, { classification: 'official' })).statusCode).toBe(403)
    expect((await put('finNoAcctA', ids.plain!, { classification: 'official' })).statusCode).toBe(403)
    expect((await put('finB', ids.plain!, { classification: 'official' })).statusCode).toBe(404)
    expect(code(await put('finA', ids.accrual!, { classification: 'official' }))).toBe('NOT_A_PAYMENT')
    expect(code(await put('finA', ids.plain!, { classification: 'official', taxStatus: 'not_deducted' }))).toBe('NON_DEDUCTION_REASON_REQUIRED')

    // Unclassified → a value: no reason needed.
    const first = await put('finA', ids.plain!, { classification: 'official', taxStatus: 'not_applicable' })
    expect(first.statusCode, first.body).toBe(200)
    // Changing a set value needs a reason.
    expect(code(await put('finA', ids.plain!, { classification: 'unofficial' }))).toBe('REASON_REQUIRED')
    expect(code(await put('finA', ids.plain!, { classification: 'official', taxStatus: 'not_applicable', reason: 'no change at all here' }))).toBe('CLASSIFICATION_UNCHANGED')
    const second = await put('ceoA', ids.plain!, { classification: 'unofficial', reason: 'Paid outside the official books' })
    expect(second.statusCode, second.body).toBe(200)
    expect(await classOf(ids.plain!)).toMatchObject({ tenantId: A, classification: 'unofficial', setById: who.ceoA!.id })

    const trail = await prisma.auditLog.findMany({ where: { action: 'payment.classification', entityId: ids.plain }, orderBy: { createdAt: 'asc' } })
    expect(trail).toHaveLength(2)
    expect(trail[1]).toMatchObject({ category: 'accounting', tenantId: A })
    expect(trail[1]!.before).toMatchObject({ classification: 'official' })
    expect(trail[1]!.after).toMatchObject({ classification: 'unofficial' })
    expect(trail[1]!.metadata).toMatchObject({ actorRole: 'admin', reason: 'Paid outside the official books' })
    const detail = await call('finA', 'GET', `/accounting/payments/${ids.plain}`)
    expect((detail.json() as { history: unknown[] }).history).toHaveLength(2)

    // Nothing in the books, the trial balance, the P&L or the WHT register moved.
    expect(await booksSnapshot()).toBe(before)
  })
})

describe('bulk allocation of older payments', () => {
  it('finance allocates several Unclassified payments at once; all-or-nothing on a foreign or non-payment id; managers refused', async () => {
    const p1 = await manual(A, 'old-1', 1_100)
    const p2 = await manual(A, 'old-2', 2_200)
    const foreign = await manual(B, 'b-old', 3_300)
    const before = await booksSnapshot()
    const bulk = (w: string, body: Record<string, unknown>) => call(w, 'POST', '/accounting/payments/classify', body)

    expect((await bulk('mgrA', { journalEntryIds: [p1], classification: 'official', reason: 'Year-end allocation' })).statusCode).toBe(403)
    expect((await bulk('finNoAcctA', { journalEntryIds: [p1], classification: 'official', reason: 'Year-end allocation' })).statusCode).toBe(403)
    expect(code(await bulk('finA', { journalEntryIds: [p1, p2], classification: 'official', reason: 'short' }))).toBe('REASON_REQUIRED')
    expect((await bulk('finA', { journalEntryIds: [p1, foreign], classification: 'official', reason: 'Year-end allocation' })).statusCode).toBe(404)
    expect(code(await bulk('finA', { journalEntryIds: [p1, ids.accrual!], classification: 'official', reason: 'Year-end allocation' }))).toBe('NOT_A_PAYMENT')
    expect(await classOf(p1)).toBeNull()
    expect(await classOf(foreign)).toBeNull()

    const ok = await bulk('finA', { journalEntryIds: [p1, p2, ids.opex!], classification: 'official', reason: 'Year-end allocation of old payments' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ changed: 2, unchanged: 1 })
    expect((await classOf(p1))?.classification).toBe('official')
    expect((await classOf(p2))?.tenantId).toBe(A)
    const trail = await prisma.auditLog.findMany({ where: { action: 'payment.classification', entityId: { in: [p1, p2] } } })
    expect(trail).toHaveLength(2)
    for (const t of trail) expect(t.metadata).toMatchObject({ bulk: true, actorRole: 'finance' })
    expect(await booksSnapshot()).toBe(before)
    expect((await register('finA', '&classification=unclassified')).rows.map((r) => r.journalEntryId)).not.toContain(p1)
  })
})

describe('supplier withholding in the register (taken at the bill — H47)', () => {
  it('a payment settling a bill carries that bill\'s WHT: gross = net paid + WHT, by the share applied', async () => {
    const sup = (await prisma.supplier.create({ data: { name: `Wht Mill ${RUN}`, tenantId: A, paymentTermsDays: 10, filerStatus: 'filer' } })).id
    const bill = await call('finA', 'POST', '/procurement/bills', {
      supplierId: sup, billNumber: `WHT-${RUN}`, billDate: today(),
      lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: 100_000, expenseAccountCode: '6040' }],
    })
    expect(bill.statusCode, bill.body).toBe(201)
    // The bill withheld 4,500 (as the WHT engine would when switched on): 95,500 is payable.
    await prisma.supplierBill.update({ where: { id: bill.json().id }, data: { whtCents: 4_500 } })
    const pay = async (cents: number, ref: string) => {
      const r = await call('finA', 'POST', '/procurement/payments', {
        supplierId: sup, paymentDate: today(), method: 'bank_transfer', bankAccountId: bankA, reference: ref, amountCents: cents,
        applications: [{ billId: bill.json().id, amountAppliedCents: cents }], classification: 'official', taxStatus: 'deducted',
      })
      expect(r.statusCode, r.body).toBe(201)
      return entryOf(A, `supplier.payment:${r.json().id}`)
    }
    const half = await pay(47_750, `WHT1-${RUN}`)   // half of what is payable → half the WHT
    const rest = await pay(47_750, `WHT2-${RUN}`)
    const rows = new Map((await register('ceoA')).rows.map((r) => [r.journalEntryId, r]))
    expect(rows.get(half!)).toMatchObject({ netCents: 47_750, whtCents: 2_250, grossCents: 50_000, taxStatus: 'deducted' })
    expect(rows.get(rest!)).toMatchObject({ netCents: 47_750, whtCents: 2_250, grossCents: 50_000 })
  })
})
