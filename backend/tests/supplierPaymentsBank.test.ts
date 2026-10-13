// Supplier payments: the bank actually used, unapply and void (finance gaps
// #9 and the "payments can never be unapplied or voided" finding).
//
// What this guards:
//   - POST /procurement/payments takes bankAccountId; the entry credits THAT
//     bank's own chart code (1021 for a second bank), resolved in the
//     SUPPLIER's company (lib/bankAccounts.ts moneyAccountCode). A bank of
//     another company is 422 and nothing is saved; a company with two banks
//     and no pick is 422 BANK_ACCOUNT_REQUIRED; a one-bank company behaves as
//     before (its bank, automatically). A wallet (JazzCash / Easypaisa) needs
//     its own account row; cash never takes one. A payment dated in a closed
//     month is 422 and not saved. Lists show the bank by name. A statement
//     imported for the second bank auto-matches the payment.
//   - POST /procurement/payments/:id/unapply: the bill re-opens, no ledger
//     change; then the bill can be voided (voidBill's own rule).
//   - POST /procurement/payments/:id/void: only while unapplied; reverses the
//     entry; idempotent; a void payment is out of the AP aging and can't be
//     allocated; cash paid out of a petty-cash box can't be voided.
//   - Company B gets 404 on company A's payments and supplier.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { linkBankLedgerAccount } from '../src/lib/bankAccounts.js'
import { createBill, createPayment, agingReport } from '../src/modules/procurement/service.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { importBankStatement } from '../src/modules/reconciliation/service.js'

let tenantA: string
let tenantB: string
let supA: string
let supB: string
let bankA1: string      // A's operating bank (1020)
let bankA2: string      // A's second bank (1021)
let walletA: string     // A's JazzCash wallet (1022)
let bankB: string       // B's only bank (1020)
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.spbank@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const today = () => new Date().toISOString()

async function bank(tenantId: string, name: string) {
  const code = await linkBankLedgerAccount(tenantId, name)
  return (await prisma.bankAccount.create({ data: { tenantId, name, bankName: name, accountCode: code } })).id
}

async function entryLines(reference: string, tenantId: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference, tenantId },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je?.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) })) ?? null
}

async function balance(tenantId: string, code: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code } })
  const sums = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: acct.id }, _sum: { amountCents: true } })
  const dr = Number(sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0)
  const cr = Number(sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0)
  return dr - cr
}

async function bill(supplierId: string, number: string, cents: number) {
  return createBill({
    supplierId, billNumber: number, billDate: today(),
    lines: [{ description: 'Flour', quantity: 1, unitCostCents: cents }],
    createdBy: users['ceoA']!.id,
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SPB A', slug: 'spb-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SPB B', slug: 'spb-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()

  supA = (await prisma.supplier.create({ data: { name: 'A Mills', tenantId: tenantA, paymentTermsDays: 10 } })).id
  supB = (await prisma.supplier.create({ data: { name: 'B Farms', tenantId: tenantB, paymentTermsDays: 10 } })).id

  bankA1 = await bank(tenantA, 'HBL')
  bankA2 = await bank(tenantA, 'Meezan')
  walletA = await bank(tenantA, 'JazzCash')
  bankB = await bank(tenantB, 'UBL')

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('a supplier payment posts to the bank actually used', () => {
  it('the bank codes are what the fixtures expect', async () => {
    const codes = await prisma.bankAccount.findMany({ where: { id: { in: [bankA1, bankA2, walletA, bankB] } }, select: { id: true, accountCode: true } })
    const code = (id: string) => codes.find((c) => c.id === id)!.accountCode
    expect([code(bankA1), code(bankA2), code(walletA), code(bankB)]).toEqual(['1020', '1021', '1022', '1020'])
  })

  it('company B\'s bank on company A\'s supplier is 422 and nothing is saved', async () => {
    const before = await prisma.supplierPayment.count()
    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'bank_transfer', amountCents: 5_000, bankAccountId: bankB,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.supplierPayment.count()).toBe(before)
  })

  it('two banks and no pick is 422 BANK_ACCOUNT_REQUIRED, nothing saved', async () => {
    const before = await prisma.supplierPayment.count()
    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cheque', amountCents: 5_000,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(await prisma.supplierPayment.count()).toBe(before)
  })

  it('picking the second bank credits its own code (1021), and the list names it', async () => {
    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'bank_transfer', amountCents: 12_345, bankAccountId: bankA2, reference: 'IBFT-1',
    })
    expect(res.statusCode).toBe(201)
    const p = res.json()
    expect(p.bankAccountId).toBe(bankA2)
    expect(p.bankAccount.name).toBe('Meezan')
    const lines = await entryLines(`supplier.payment:${p.id}`, tenantA)
    expect(lines).toEqual(expect.arrayContaining([
      { code: '2010', type: 'debit', amount: 12_345 },
      { code: '1021', type: 'credit', amount: 12_345 },
    ]))
    expect(lines!.some((l) => l.code === '1020')).toBe(false)

    const list = (await call('ceoA', 'GET', '/procurement/payments')).json() as Array<{ id: string; bankAccount: { name: string } | null }>
    expect(list.find((x) => x.id === p.id)?.bankAccount?.name).toBe('Meezan')

    // The second bank's statement now sees the payment and matches it.
    const imported = await importBankStatement({
      tenantId: tenantA, accountCode: '1021', source: 'csv', statementDate: new Date(),
      openingBalanceCents: 0, closingBalanceCents: -12_345,
      csv: `date,description,amount\n${new Date().toISOString().slice(0, 10)},IBFT to A Mills,-123.45\n`,
    })
    expect(imported.matchedCount).toBe(1)
  })

  it('a wallet payment needs its own wallet account row, and posts to it', async () => {
    const none = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'wallet', amountCents: 2_000,
    })
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')

    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'wallet', amountCents: 2_000, bankAccountId: walletA,
    })
    expect(res.statusCode).toBe(201)
    expect(await entryLines(`supplier.payment:${res.json().id}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '1022', type: 'credit', amount: 2_000 },
    ]))
  })

  it('cash posts to 1010 and never takes a bank account', async () => {
    const withBank = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cash', amountCents: 1_000, bankAccountId: bankA1,
    })
    expect(withBank.statusCode).toBe(422)
    expect(withBank.json().error.code).toBe('BANK_ACCOUNT_ON_CASH')
    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cash', amountCents: 1_000,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().bankAccountId).toBeNull()
    expect(await entryLines(`supplier.payment:${res.json().id}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '1010', type: 'credit', amount: 1_000 },
    ]))
  })

  it('a one-bank company uses its bank automatically, as before', async () => {
    const res = await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supB, paymentDate: today(), method: 'bank_transfer', amountCents: 7_000,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().bankAccountId).toBe(bankB)
    expect(await entryLines(`supplier.payment:${res.json().id}`, tenantB)).toEqual(expect.arrayContaining([
      { code: '1020', type: 'credit', amount: 7_000 },
    ]))
  })

  it('a payment dated in a closed month is 422 and not saved', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantB, lockedThrough: new Date(Date.now() - 10 * 86_400_000), lockedBy: users['ceoB']!.id } })
    const before = await prisma.supplierPayment.count({ where: { supplierId: supB } })
    const res = await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supB, paymentDate: new Date(Date.now() - 20 * 86_400_000).toISOString(), method: 'bank_transfer', amountCents: 3_000, bankAccountId: bankB,
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.supplierPayment.count({ where: { supplierId: supB } })).toBe(before)
    await prisma.periodLock.delete({ where: { id: lock.id } })
  })

  it('company B can\'t pay company A\'s supplier or touch A\'s payments (404)', async () => {
    const pay = await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'bank_transfer', amountCents: 1_000, bankAccountId: bankB,
    })
    expect(pay.statusCode).toBe(404)
    const aPayment = await prisma.supplierPayment.findFirstOrThrow({ where: { supplierId: supA } })
    expect((await call('ceoB', 'POST', `/procurement/payments/${aPayment.id}/void`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/procurement/payments/${aPayment.id}/unapply`, { billId: aPayment.id })).statusCode).toBe(404)
    expect((await prisma.supplierPayment.findUniqueOrThrow({ where: { id: aPayment.id } })).voidedAt).toBeNull()
    expect((await call('ceoB', 'GET', '/procurement/payments')).json().some((p: { id: string }) => p.id === aPayment.id)).toBe(false)
  })
})

describe('unapply and void a supplier payment', () => {
  it('unapply re-opens the bill with no ledger change; then the bill can be voided', async () => {
    const b = await bill(supA, 'UA-1', 40_000)
    const pay = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'bank_transfer', amountCents: 40_000, bankAccountId: bankA1,
      applications: [{ billId: b.id, amountAppliedCents: 40_000 }],
    })
    expect(pay.statusCode).toBe(201)
    const paymentId = pay.json().id as string
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('paid')

    // The bill can't be voided while the payment sits on it.
    const blocked = await call('ceoA', 'POST', `/procurement/bills/${b.id}/void`, { reason: 'wrong supplier' })
    expect(blocked.statusCode).toBe(400)
    expect(blocked.json().error.code).toBe('HAS_PAYMENTS')

    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const un = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/unapply`, { billId: b.id })
    expect(un.statusCode).toBe(200)
    expect(un.json()).toMatchObject({ amountCents: 40_000, billStatus: 'open' })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(entriesBefore)
    const after = await prisma.supplierBill.findUniqueOrThrow({ where: { id: b.id } })
    expect(after.status).toBe('open')
    expect(Number(after.paidCents)).toBe(0)
    expect(Number((await prisma.supplierPayment.findUniqueOrThrow({ where: { id: paymentId } })).appliedCents)).toBe(0)

    // Unapplying twice is refused, not double-counted.
    const again = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/unapply`, { billId: b.id })
    expect(again.statusCode).toBe(422)
    expect(again.json().error.code).toBe('NOT_APPLIED')

    const voided = await call('ceoA', 'POST', `/procurement/bills/${b.id}/void`, { reason: 'wrong supplier' })
    expect(voided.statusCode).toBe(200)
    expect(voided.json().status).toBe('void')
  })

  it('void only while unapplied; reverses the entry once; out of the aging; can\'t be allocated', async () => {
    const b = await bill(supA, 'UA-2', 9_000)
    const pay = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cheque', amountCents: 9_000, bankAccountId: bankA2, reference: 'CHQ-77',
      applications: [{ billId: b.id, amountAppliedCents: 9_000 }],
    })
    const paymentId = pay.json().id as string

    const applied = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/void`, { reason: 'cheque bounced' })
    expect(applied.statusCode).toBe(422)
    expect(applied.json().error.code).toBe('PAYMENT_APPLIED')

    expect((await call('ceoA', 'POST', `/procurement/payments/${paymentId}/unapply`, { billId: b.id })).statusCode).toBe(200)
    const bank2Before = await balance(tenantA, '1021')
    const agingBefore = (await agingReport([tenantA])).bySupplier.find((r) => r.supplierId === supA)!

    const res = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/void`, { reason: 'cheque bounced' })
    expect(res.statusCode).toBe(200)
    expect(res.json().voidedAt).toBeTruthy()
    expect(res.json().voidReason).toBe('cheque bounced')
    expect(await entryLines(`supplier.payment.void:${paymentId}`, tenantA)).toEqual(expect.arrayContaining([
      { code: '1021', type: 'debit', amount: 9_000 },
      { code: '2010', type: 'credit', amount: 9_000 },
    ]))
    expect(await balance(tenantA, '1021')).toBe(bank2Before + 9_000)

    // Idempotent: a second void changes nothing.
    const twice = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/void`, { reason: 'again' })
    expect(twice.statusCode).toBe(200)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `supplier.payment.void:${paymentId}` } })).toBe(1)

    // The void payment no longer sits in the aging as an unapplied credit:
    // the bill is owed again in full.
    const agingAfter = (await agingReport([tenantA])).bySupplier.find((r) => r.supplierId === supA)!
    expect(agingAfter.creditsCents).toBe(agingBefore.creditsCents - 9_000)
    expect(agingAfter.total).toBe(agingBefore.total + 9_000)

    const alloc = await call('ceoA', 'POST', `/procurement/payments/${paymentId}/allocate`, { applications: [{ billId: b.id, amountAppliedCents: 1_000 }] })
    expect(alloc.statusCode).toBe(422)
    expect(alloc.json().error.code).toBe('PAYMENT_VOID')
  })

  it('cash paid out of a petty-cash box can\'t be voided (the cash has left the box)', async () => {
    const b = await bill(supA, 'UA-3', 2_500)
    const p = await createPayment({
      supplierId: supA, paymentDate: today(), method: 'cash', reference: 'petty cash: Kitchen box', amountCents: 2_500,
      applications: [{ billId: b.id, amountAppliedCents: 2_500 }], createdBy: users['ceoA']!.id,
    })
    const box = await prisma.pettyCashBox.create({ data: { tenantId: tenantA, name: 'Kitchen box', custodianId: users['ceoA']!.id, floatCents: 10_000 } })
    await prisma.pettyCashMovement.create({ data: { boxId: box.id, type: 'spend', amountCents: -2_500, reason: 'flour', supplierPaymentId: p.id, createdById: users['ceoA']!.id } })

    expect((await call('ceoA', 'POST', `/procurement/payments/${p.id}/unapply`, { billId: b.id })).statusCode).toBe(200)
    const res = await call('ceoA', 'POST', `/procurement/payments/${p.id}/void`, { reason: 'mistake' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PAYMENT_FROM_CASH_BOX')
    expect((await prisma.supplierPayment.findUniqueOrThrow({ where: { id: p.id } })).voidedAt).toBeNull()
  })

  it('a payment can\'t be applied to another company\'s bill (404, nothing saved)', async () => {
    const bB = await createBill({ supplierId: supB, billNumber: 'B-1', billDate: today(), lines: [{ description: 'Veg', quantity: 1, unitCostCents: 1_000 }], createdBy: users['ceoB']!.id })
    const res = await call('ceoA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cash', amountCents: 1_000,
      applications: [{ billId: bB.id, amountAppliedCents: 1_000 }],
    })
    expect(res.statusCode).toBe(404)
    expect(Number((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bB.id } })).paidCents)).toBe(0)
  })
})
