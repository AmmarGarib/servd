// "Paid already — booked as an expense" (owner, 2026-11-20). Two companies (A, B).
//   • finance marks an open bill paid: the bill turns Paid, 2010 comes down, the picked expense account is credited,
//     cash on hand (1010) nets to zero, audited; a part amount leaves it Partially paid;
//   • company B's finance gets 404 on A's bill; a manager gets 403; more than is due 422; a non-expense account 422;
//     another company's brand 422;
//   • unapply + void of the payment reverses the correction too.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'

const RUN = Math.random().toString(36).slice(2, 8)
let A: string
let B: string
let supA: string
let brandB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@paidexp.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function balance(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { account: { tenantId, code }, journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
async function mkBill(number: string, cents: number): Promise<string> {
  const r = await call('finA', 'POST', '/api/v1/procurement/bills', {
    supplierId: supA, billNumber: number, billDate: fmtPktDate(new Date()),
    lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: cents, expenseAccountCode: '6040' }],
  })
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as { id: string }).id
}

beforeAll(async () => {
  invalidateSetupCache()
  A = (await prisma.tenant.create({ data: { name: `PE A ${RUN}`, slug: `pe-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `PE B ${RUN}`, slug: `pe-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  supA = (await prisma.supplier.create({ data: { name: `Mill ${RUN}`, tenantId: A, paymentTermsDays: 10, filerStatus: 'filer' } })).id
  brandB = (await prisma.concept.create({ data: { name: `PE Brand B ${RUN}`, slug: `pe-b-brand-${RUN}`, type: 'restaurant', tenantId: B, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('ceo', 'admin', A)
  await mkUser('finA', 'finance', A)
  await mkUser('finB', 'finance', B)
  await mkUser('mgr', 'fnb_manager', A)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/api/v1/procurement' })
  await app.ready()
})
afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('a bill paid already, booked as an expense', () => {
  it('one click: bill Paid, 2010 down, the expense credited, cash unchanged — and the undo puts it all back', async () => {
    const billId = await mkBill(`PE-1-${RUN}`, 40_000)
    const before = { ap: await balance(A, '2010'), exp: await balance(A, '5010'), cash: await balance(A, '1010') }

    const opts = await call('finA', 'GET', `/api/v1/procurement/bills/${billId}/paid-as-expense/options`)
    expect(opts.statusCode, opts.body).toBe(200)
    const accounts = (opts.json() as { accounts: Array<{ code: string; section: string }> }).accounts
    expect(accounts.find((a) => a.code === '5010')?.section).toBe('cost_of_sales')
    expect(accounts.some((a) => a.code === '2010')).toBe(false)

    const r = await call('finA', 'POST', `/api/v1/procurement/bills/${billId}/paid-as-expense`, { accountCode: '5010', reason: 'Paid through the buyer cash voucher' })
    expect(r.statusCode, r.body).toBe(200)
    const out = r.json() as { supplierPaymentId: string; amountCents: number; status: string }
    expect(out.amountCents).toBe(40_000)
    expect(out.status).toBe('paid')
    expect(await balance(A, '2010') - before.ap).toBe(40_000)      // payable down (a debit)
    expect(await balance(A, '5010') - before.exp).toBe(-40_000)    // duplicate expense out (a credit)
    expect(await balance(A, '1010') - before.cash).toBe(0)         // no cash moved
    expect(await prisma.auditLog.count({ where: { action: 'supplier.bill.paid_as_expense', entityId: billId, tenantId: A } })).toBe(1)
    const corr = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `supplier.bill_expense_correction:${out.supplierPaymentId}` } })
    expect(corr.tenantId).toBe(A)

    // already paid → refused
    expect((await call('finA', 'POST', `/api/v1/procurement/bills/${billId}/paid-as-expense`, { accountCode: '5010', reason: 'A second time by mistake' })).statusCode).toBe(422)

    // undo: unapply, then void — the correction is reversed with the payment
    expect((await call('finA', 'POST', `/api/v1/procurement/payments/${out.supplierPaymentId}/unapply`, { billId })).statusCode).toBe(200)
    const v = await call('finA', 'POST', `/api/v1/procurement/payments/${out.supplierPaymentId}/void`, { reason: 'marked by mistake' })
    expect(v.statusCode, v.body).toBe(200)
    expect(await balance(A, '2010')).toBe(before.ap)
    expect(await balance(A, '5010')).toBe(before.exp)
    expect(await balance(A, '1010')).toBe(before.cash)
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe('open')
  })

  it('a part amount leaves the bill partially paid; the CEO may do it too', async () => {
    const billId = await mkBill(`PE-2-${RUN}`, 30_000)
    const r = await call('ceo', 'POST', `/api/v1/procurement/bills/${billId}/paid-as-expense`, { accountCode: '6040', amountCents: 10_000, reason: 'Part paid from the petty cash box' })
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as { status: string }).status).toBe('partially_paid')
  })

  it('refusals: other company 404, manager 403, over the due 422, not an expense account 422, foreign brand 422, short reason 400', async () => {
    const billId = await mkBill(`PE-3-${RUN}`, 20_000)
    const url = `/api/v1/procurement/bills/${billId}/paid-as-expense`
    const ok = { accountCode: '6040', reason: 'Paid through the buyer cash voucher' }
    expect((await call('finB', 'POST', url, ok)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `${url}/options`)).statusCode).toBe(404)
    expect((await call('mgr', 'POST', url, ok)).statusCode).toBe(403)
    const over = await call('finA', 'POST', url, { ...ok, amountCents: 20_001 })
    expect(over.statusCode).toBe(422)
    expect((over.json() as { error: { code: string } }).error.code).toBe('OVER_APPLIED')
    const acct = await call('finA', 'POST', url, { ...ok, accountCode: '2010' })
    expect((acct.json() as { error: { code: string } }).error.code).toBe('ACCOUNT_NOT_ALLOWED')
    const brand = await call('finA', 'POST', url, { ...ok, conceptId: brandB })
    expect((brand.json() as { error: { code: string } }).error.code).toBe('BRAND_NOT_IN_COMPANY')
    expect((await call('finA', 'POST', url, { accountCode: '6040', reason: 'short' })).statusCode).toBe(400)
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe('open')
  })
})
