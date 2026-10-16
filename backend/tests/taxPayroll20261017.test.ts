// Finance audit 2026-10-17 — group tax_payroll (items 7, 21, 22, 23).
//
//   7  A tip-pool payout is paid from cash (1010) or the named / only bank of
//      the POOL's company (lib/bankAccounts.ts moneyAccountCode) — never a
//      silent 1020; two banks and none named is 422 BANK_ACCOUNT_REQUIRED;
//      another company's bank is 422; another company's pool is 404.
//  21  Finance (with 'accounting') marks a locked payroll run and an approved
//      full & final paid, and books unposted settlements; nobody pays a run or
//      a settlement carrying their own pay (403 OWN_PAY_IN_RUN, the CEO
//      included); company B gets 404; finance without 'accounting' is 403.
//  22  A month takes a top-up statutory / sales-tax challan with its own CPR;
//      without one 422 CPR_REQUIRED_FOR_TOP_UP; the same CPR twice 409; the
//      owed figure drops to zero.
//  23  Finance (with 'accounting') lists the tax-invoice register and its CSV,
//      its own companies only; another company's brand filter is 404.
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
import { invalidateModuleAccessCache } from '../src/lib/moduleAccess.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { statutoryRoutes } from '../src/modules/accounting/statutoryRoutes.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { invoiceRoutes } from '../src/modules/invoices/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string, tenantT: string
let bankA: string, bankB: string, bankT1: string
let brandA: string, brandB: string

const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const TODAY = pktIso(new Date())
const M2 = TODAY.slice(0, 7)
const M1 = (() => {
  const [y, m] = M2.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
})()
const at = (iso: string) => new Date(`${iso}T10:00:00+05:00`)

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string, extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@taxpayroll.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...extra },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

async function entryLines(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => [l.type, l.account.code, Number(l.amountCents)] as const).sort()
}

let empSeq = 0
async function mkEmp(tenantId: string, userId: string | null = null) {
  return (await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `TP-${RUN}-${++empSeq}`, fullName: `Person ${empSeq}`, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), userId, paymentMethod: 'bank' },
  })).id
}
/** A locked run with its accrual on the books (Dr 6031 / Cr 2020). */
async function lockedRun(tenantId: string, period: string, employeeIds: string[]) {
  const run = await prisma.hrPayrollRun.create({ data: { tenantId, period, status: 'locked', settings: {}, lockedAt: new Date() } })
  for (const employeeId of employeeIds) {
    await prisma.hrPayslip.create({ data: { runId: run.id, tenantId, employeeId, inputs: { paymentMethod: 'bank' }, lines: [], grossCents: 10_000, earningsCents: 10_000, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 10_000 } })
  }
  await postJournalEntry({
    tenantId, sourceType: 'hr.payroll.accrual', sourceId: run.id, description: 'accrual', postedBy: 'test', entryDate: at(`${M1}-28`),
    lines: [
      { accountCode: '6031', type: 'debit', amountCents: 10_000 * employeeIds.length },
      { accountCode: '2020', type: 'credit', amountCents: 10_000 * employeeIds.length },
    ],
  })
  return run.id
}
/** An approved full & final with its accrual on the books. */
async function approvedFnf(tenantId: string, employeeId: string, cents = 25_000) {
  const rec = await prisma.hrRecord.create({ data: { tenantId, section: 'final_settlement', formVersion: 1, employeeId, status: 'approved', amountCents: cents, data: {} } })
  await postJournalEntry({
    tenantId, sourceType: 'hr.final_settlement.accrual', sourceId: rec.id, description: 'fnf accrual', postedBy: 'test', entryDate: at(`${M2}-01`),
    lines: [
      { accountCode: '6031', type: 'debit', amountCents: cents },
      { accountCode: '2020', type: 'credit', amountCents: cents },
    ],
  })
  return rec.id
}

beforeAll(async () => {
  tenantA = await company('TaxPay A')
  tenantB = await company('TaxPay B')
  tenantT = await company('TaxPay T two banks')
  invalidateModuleAccessCache()
  // A's only bank hangs off 1021 (1020 unused) — the case the old payout got wrong.
  for (const [t, code] of [[tenantA, '1021'], [tenantT, '1022']] as const) {
    await prisma.account.create({ data: { tenantId: t, code, name: `Bank ${code}`, type: 'asset' } })
  }
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'A HBL', accountCode: '1021' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B UBL', accountCode: '1020' } })).id
  bankT1 = (await prisma.bankAccount.create({ data: { tenantId: tenantT, name: 'T one', accountCode: '1020' } })).id
  await prisma.bankAccount.create({ data: { tenantId: tenantT, name: 'T two', accountCode: '1022' } })
  brandA = (await prisma.concept.create({ data: { name: 'TP Brand A', slug: `tp-a-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  brandB = (await prisma.concept.create({ data: { name: 'TP Brand B', slug: `tp-b-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id

  await mkStaff('ceoA', 'admin', tenantA)
  await mkStaff('ceoB', 'admin', tenantB)
  await mkStaff('ceoT', 'admin', tenantT)
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('finB', 'finance', tenantB)
  await mkStaff('finNoAcct', 'finance', tenantA, { moduleDeny: ['accounting'] })
  await mkStaff('fohA', 'foh', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: status === 403 ? 'FORBIDDEN' : 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(statutoryRoutes, { prefix: '/accounting/statutory' })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(tipPoolRoutes, { prefix: '/tip-pools' })
  await app.register(invoiceRoutes, { prefix: '/invoices' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Item 7: tip payouts ─────────────────────────────────────────────────────

describe('item 7 — a tip payout is paid from the pool company\'s cash or bank', () => {
  const pool = async (tenantId: string, cents = 30_000) => (await prisma.tipPool.create({
    data: { tenantId, name: `pool ${RUN}`, periodStart: new Date(Date.now() - 48 * 3_600_000), periodEnd: new Date(Date.now() - 24 * 3_600_000), totalTipsCents: cents, status: 'posted', postedAt: new Date() },
  })).id

  it('with nothing named: the company\'s only bank (1021), never a silent 1020', async () => {
    const id = await pool(tenantA)
    const res = await call('ceoA', 'POST', `/tip-pools/${id}/pay`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(await entryLines(tenantA, `tippool.payout:${id}`)).toEqual([['credit', '1021', 30_000], ['debit', '2095', 30_000]])
  })

  it('cash → 1010; a named bank → its code', async () => {
    const cash = await pool(tenantA, 12_000)
    expect((await call('ceoA', 'POST', `/tip-pools/${cash}/pay`, { method: 'cash' })).statusCode).toBe(200)
    expect(await entryLines(tenantA, `tippool.payout:${cash}`)).toEqual([['credit', '1010', 12_000], ['debit', '2095', 12_000]])
    const named = await pool(tenantA, 5_000)
    expect((await call('ceoA', 'POST', `/tip-pools/${named}/pay`, { method: 'bank_transfer', bankAccountId: bankA })).statusCode).toBe(200)
    expect(await entryLines(tenantA, `tippool.payout:${named}`)).toEqual([['credit', '1021', 5_000], ['debit', '2095', 5_000]])
  })

  it('two banks and none named → 422 BANK_ACCOUNT_REQUIRED (nothing paid); naming one pays from it', async () => {
    const id = await pool(tenantT)
    const res = await call('ceoT', 'POST', `/tip-pools/${id}/pay`, {})
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id } })).status).toBe('posted')
    expect((await call('ceoT', 'POST', `/tip-pools/${id}/pay`, { method: 'bank', bankAccountId: bankT1 })).statusCode).toBe(200)
    expect(await entryLines(tenantT, `tippool.payout:${id}`)).toEqual([['credit', '1020', 30_000], ['debit', '2095', 30_000]])
  })

  it('another company\'s bank is 422; another company\'s pool is 404; cash with a bank is 422', async () => {
    const id = await pool(tenantA, 1_000)
    const foreign = await call('ceoA', 'POST', `/tip-pools/${id}/pay`, { method: 'bank_transfer', bankAccountId: bankB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    const both = await call('ceoA', 'POST', `/tip-pools/${id}/pay`, { method: 'cash', bankAccountId: bankA })
    expect(both.statusCode).toBe(422)
    expect((await call('ceoB', 'POST', `/tip-pools/${id}/pay`, { method: 'cash' })).statusCode).toBe(404)
    expect(await entryLines(tenantA, `tippool.payout:${id}`)).toBeNull()
  })
})

// ─── Item 21: finance pays payroll and full & final ─────────────────────────

describe('item 21 — finance marks payroll and full & final paid', () => {
  let finAEmp: string, otherEmp: string, empB: string

  beforeAll(async () => {
    finAEmp = await mkEmp(tenantA, staff['finA']!.id)
    otherEmp = await mkEmp(tenantA)
    empB = await mkEmp(tenantB)
  })

  it('finance pays its own company\'s locked run (Dr 2020 / Cr A\'s bank); B gets 404', async () => {
    const run = await lockedRun(tenantA, '2001-01', [otherEmp])
    expect((await call('finB', 'POST', `/hr/payroll/runs/${run}/paid`, {})).statusCode).toBe(404)
    const res = await call('finA', 'POST', `/hr/payroll/runs/${run}/paid`, { paidOn: TODAY })
    expect(res.statusCode, res.body).toBe(200)
    expect(await entryLines(tenantA, `hr.payroll.payment:${run}`)).toEqual([['credit', '1021', 10_000], ['debit', '2020', 10_000]])
    const audit = await prisma.auditLog.findFirst({ where: { action: 'hr.payroll.paid', entityId: run } })
    expect(audit?.userId).toBe(staff['finA']!.id)
  })

  it('nobody pays a run carrying their own pay — 403 OWN_PAY_IN_RUN; someone else can', async () => {
    const run = await lockedRun(tenantA, '2001-02', [finAEmp, otherEmp])
    const own = await call('finA', 'POST', `/hr/payroll/runs/${run}/paid`, {})
    expect(own.statusCode).toBe(403)
    expect(own.json().error.code).toBe('OWN_PAY_IN_RUN')
    expect((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: run } })).paidAt).toBeNull()
    expect((await call('ceoA', 'POST', `/hr/payroll/runs/${run}/paid`, {})).statusCode).toBe(200)
  })

  it('finance without the accounting module, and a floor role, are refused', async () => {
    const run = await lockedRun(tenantA, '2001-03', [otherEmp])
    expect((await call('finNoAcct', 'POST', `/hr/payroll/runs/${run}/paid`, {})).statusCode).toBe(403)
    expect((await call('fohA', 'POST', `/hr/payroll/runs/${run}/paid`, {})).statusCode).toBe(403)
  })

  it('finance lists and pays its company\'s approved settlements; B neither sees nor pays them', async () => {
    const fnf = await approvedFnf(tenantA, otherEmp)
    const fnfB = await approvedFnf(tenantB, empB)
    const list = await call('finA', 'GET', '/hr/final-settlement/to-pay')
    expect(list.statusCode, list.body).toBe(200)
    const ids = (list.json() as Array<{ id: string; tenantId: string }>).map((r) => r.id)
    expect(ids).toContain(fnf)
    expect(ids).not.toContain(fnfB)
    expect((await call('finB', 'POST', `/hr/final-settlement/${fnf}/paid`, {})).statusCode).toBe(404)
    const paid = await call('finA', 'POST', `/hr/final-settlement/${fnf}/paid`, { cash: true, paidOn: TODAY })
    expect(paid.statusCode, paid.body).toBe(200)
    expect(await entryLines(tenantA, `hr.final_settlement.payment:${fnf}`)).toEqual([['credit', '1010', 25_000], ['debit', '2020', 25_000]])
    expect(((await call('finA', 'GET', '/hr/final-settlement/to-pay')).json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(fnf)
    expect((await call('finA', 'POST', `/hr/final-settlement/${fnf}/paid`, {})).statusCode).toBe(409)
  })

  it('nobody marks their own settlement paid; finance without accounting is 403; finance books unposted settlements', async () => {
    const own = await approvedFnf(tenantA, finAEmp)
    const r = await call('finA', 'POST', `/hr/final-settlement/${own}/paid`, {})
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OWN_PAY_IN_RUN')
    const row = ((await call('finA', 'GET', '/hr/final-settlement/to-pay')).json() as Array<{ id: string; ownPay: boolean }>).find((x) => x.id === own)
    expect(row?.ownPay).toBe(true)
    expect((await call('finNoAcct', 'GET', '/hr/final-settlement/to-pay')).statusCode).toBe(403)
    expect((await call('finNoAcct', 'POST', `/hr/final-settlement/${own}/paid`, {})).statusCode).toBe(403)
    const backfill = await call('finA', 'POST', '/hr/final-settlement/post-unposted', {})
    expect(backfill.statusCode, backfill.body).toBe(200)
  })
})

// ─── Item 22: top-up challans ────────────────────────────────────────────────

describe('item 22 — a month takes a top-up challan with its own CPR', () => {
  beforeAll(async () => {
    // M1 accrued 6,000 EOBI; a late F&F adds 1,500 after the first challan.
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'hr.payroll.accrual', sourceId: randomUUID(), description: 'eobi', postedBy: 'test', entryDate: at(`${M1}-28`),
      lines: [{ accountCode: '6031', type: 'debit', amountCents: 6_000 }, { accountCode: '2043', type: 'credit', amountCents: 6_000 }],
    })
  })

  it('first challan, then a top-up: none without a CPR (422), never the same CPR twice (409); owed ends at zero', async () => {
    const first = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 6_000, paidAt: `${M2}-01`, bankAccountId: bankA, cprNumber: 'CPR-1' })
    expect(first.statusCode, first.body).toBe(201)
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'hr.final_settlement.accrual', sourceId: randomUUID(), description: 'late fnf', postedBy: 'test', entryDate: at(`${M1}-28`),
      lines: [{ accountCode: '6031', type: 'debit', amountCents: 1_500 }, { accountCode: '2043', type: 'credit', amountCents: 1_500 }],
    })
    const bare = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 1_500, paidAt: TODAY, bankAccountId: bankA })
    expect(bare.statusCode).toBe(422)
    expect(bare.json().error.code).toBe('CPR_REQUIRED_FOR_TOP_UP')
    const same = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 1_500, paidAt: TODAY, bankAccountId: bankA, cprNumber: ' CPR-1 ' })
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('TAX_PAYMENT_EXISTS')
    const topUp = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 1_500, paidAt: TODAY, bankAccountId: bankA, cprNumber: 'CPR-2' })
    expect(topUp.statusCode, topUp.body).toBe(201)
    expect(await entryLines(tenantA, `salestax.payment:${topUp.json().id}`)).toEqual([['credit', '1021', 1_500], ['debit', '2043', 1_500]])
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA, authority: 'eobi' } })).toBe(2)

    const sum = await call('finA', 'GET', `/accounting/statutory?from=${M1}&to=${M1}`)
    expect(sum.statusCode, sum.body).toBe(200)
    const cell = (sum.json().months as Array<{ month: string; eobi: { paidCents: number; owedCents: number; payments: unknown[] } }>).find((m) => m.month === M1)!.eobi
    expect(cell.paidCents).toBe(7_500)
    expect(cell.owedCents).toBe(0)
    expect(cell.payments).toHaveLength(2)
  })

  it('company B records its own CPR-1 for the same month — CPRs are per company', async () => {
    const b = await call('finB', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 100, paidAt: `${M2}-01`, bankAccountId: bankB, cprNumber: 'CPR-1' })
    expect(b.statusCode, b.body).toBe(201)
    expect(b.json().tenantId).toBe(tenantB)
  })
})

// ─── Item 23: the tax invoice register ───────────────────────────────────────

describe('item 23 — finance reads the tax-invoice register', () => {
  beforeAll(async () => {
    const inv = async (tenantId: string, conceptId: string, invoiceNumber: string, type: 'invoice' | 'credit_note' = 'invoice') => {
      const order = await prisma.order.create({ data: { conceptId, source: 'pos', status: 'completed', completedAt: new Date(), totalCents: 11_500 } })
      return prisma.taxInvoice.create({
        data: { tenantId, invoiceNumber, type, orderId: order.id, conceptId, sellerLegalName: 'Seller', subtotalCents: 10_000, taxableValueCents: 10_000, provincialTaxCents: 1_500, totalCents: 11_500 },
      })
    }
    await inv(tenantA, brandA, `TPA-${RUN}-00001`)
    await inv(tenantA, brandA, `TPA-${RUN}-CN-00001`, 'credit_note')
    await inv(tenantB, brandB, `TPB-${RUN}-00001`)
  })

  it('lists its own company\'s invoices only, filters by type, and B\'s brand is 404', async () => {
    const res = await call('finA', 'GET', '/invoices')
    expect(res.statusCode, res.body).toBe(200)
    const nums = (res.json() as Array<{ invoiceNumber: string; tenantId: string }>).map((r) => r.invoiceNumber)
    expect(nums).toEqual(expect.arrayContaining([`TPA-${RUN}-00001`, `TPA-${RUN}-CN-00001`]))
    expect(nums).not.toContain(`TPB-${RUN}-00001`)
    const cn = await call('finA', 'GET', '/invoices?type=credit_note')
    expect((cn.json() as Array<{ invoiceNumber: string }>).map((r) => r.invoiceNumber)).toEqual([`TPA-${RUN}-CN-00001`])
    expect((await call('finA', 'GET', `/invoices?conceptId=${brandB}`)).statusCode).toBe(404)
    const b = await call('finB', 'GET', '/invoices')
    expect((b.json() as Array<{ invoiceNumber: string }>).map((r) => r.invoiceNumber)).toEqual([`TPB-${RUN}-00001`])
  })

  it('the CSV holds the same rows; finance without accounting and a floor role are 403', async () => {
    const csv = await call('finA', 'GET', `/invoices/register.csv?q=${encodeURIComponent(`TPA-${RUN}`)}`)
    expect(csv.statusCode, csv.body).toBe(200)
    expect(csv.headers['content-type']).toMatch(/text\/csv/)
    const lines = csv.body.split('\n')
    expect(lines[0]).toMatch(/^Number,Type,Issued/)
    expect(lines).toHaveLength(3)
    expect(csv.body).toContain(`TPA-${RUN}-CN-00001,Credit note`)
    expect(csv.body).not.toContain('TPB-')
    expect((await call('finNoAcct', 'GET', '/invoices')).statusCode).toBe(403)
    expect((await call('finNoAcct', 'GET', '/invoices/register.csv')).statusCode).toBe(403)
    expect((await call('fohA', 'GET', '/invoices')).statusCode).toBe(403)
  })
})
