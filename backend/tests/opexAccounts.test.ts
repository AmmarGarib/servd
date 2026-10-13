// OpEx expense accounts + payments, CapEx instalment bank (finance gaps 17d / 9).
//
//   - The name map: licences before software, ONE code for 'utilities' (the
//     OpEx map and the till pay-out agree), generator fuel is power.
//   - OpexCategory.expenseAccountCode: named or pre-filled on create, edited on
//     PATCH, checked against the CATEGORY's company's chart (6xxx, active,
//     expense), never on payroll; backfilled idempotently from the name map.
//   - Posting order: payment code → live posted code → category column → name
//     map. A code named on an unmapped category's payment is remembered.
//   - Payments: paid date / reference / receipt; PATCH corrects before and
//     reposts after; a closed month refuses with nothing saved.
//   - Where the money came from: lib/bankAccounts.ts moneyAccountCode, with
//     the live-credit rule on edit — OpEx and CapEx alike.
//   - "Post old payments": dry run says exactly what would happen
//     (needs_account / needs_bank / period_locked), then posts.
//   - Two companies: B's PATCH of A's category is 404; a code only A's chart
//     has is 422 for B; another company's bank is 422 with nothing saved.
// Every journal entry written here is checked to balance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { opexRoutes } from '../src/modules/opex/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { expenseCodeForCategoryName, PAYOUT_CATEGORIES } from '../src/modules/accounting/expenseCategories.js'
import { backfillOpexCategoryAccounts } from '../src/modules/opex/categoryAccounts.js'
import { opexMoneyInput } from '../src/modules/opex/posting.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
const users: Record<string, { id: string; token: string }> = {}
const bank: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@opexacct.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined && { payload: payload as never }) })

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? { ...je, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId })) } : null
}
const amt = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)
const entriesFor = (id: string) => prisma.journalEntry.count({ where: { reference: { contains: id } } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'OpEx A', slug: `opex-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'OpEx B', slug: `opex-b-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'OpEx Cafe', slug: `opex-cafe-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  await mkUser('finA', 'finance', tenantA)

  // A has two banks (1020 + a 1021 child), B exactly one (1020).
  await prisma.account.create({ data: { tenantId: tenantA, code: '1021', name: 'Bank — MCB', type: 'asset', isActive: true } })
  bank.hblA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bank.mcbA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'MCB Ops', accountCode: '1021' } })).id
  bank.onlyB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'Meezan', accountCode: '1020' } })).id
  // A code only A's chart has.
  await prisma.account.create({ data: { tenantId: tenantA, code: '6200', name: 'Security services', type: 'expense', isActive: true } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(opexRoutes, { prefix: '/opex' })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [tenantA, tenantB] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  await app.close()
})

// ─── The name map ──────────────────────────────────────────────────────────────

describe('expense name map', () => {
  it('licences before software; generator fuel is power; one code for utilities', () => {
    expect(expenseCodeForCategoryName('Trade licence fee')).toBe('6120')
    expect(expenseCodeForCategoryName('Food authority license')).toBe('6120')
    expect(expenseCodeForCategoryName('Licenses')).toBe('6120')
    expect(expenseCodeForCategoryName('Software licence')).toBe('6070')
    expect(expenseCodeForCategoryName('POS software subscription')).toBe('6070')
    expect(expenseCodeForCategoryName('Generator fuel')).toBe('6020')
    expect(expenseCodeForCategoryName('Fuel & transport')).toBe('6140')
    expect(expenseCodeForCategoryName('Water tanker')).toBe('6023')
    expect(expenseCodeForCategoryName('Sui gas')).toBe('6021')
    expect(expenseCodeForCategoryName('Payroll')).toBeNull()
    expect(expenseCodeForCategoryName('Security')).toBeNull()
    // The till's 'utilities' pay-out and the OpEx name map give ONE code.
    const tillUtilities = PAYOUT_CATEGORIES.find((c) => c.key === 'utilities')!
    expect(tillUtilities.code).toBe(expenseCodeForCategoryName('Utilities'))
    expect(PAYOUT_CATEGORIES.find((c) => c.key === 'water')!.code).toBe(expenseCodeForCategoryName('Water'))
    expect(PAYOUT_CATEGORIES.find((c) => c.key === 'gas')!.code).toBe(expenseCodeForCategoryName('Gas'))
  })

  it('an OpEx payment pays from a bank unless it is cash; a line\'s bank wins', () => {
    expect(opexMoneyInput({ paymentMethod: 'card', bankAccountId: null })).toEqual({ method: 'bank_transfer', bankAccountId: null })
    expect(opexMoneyInput({ paymentMethod: 'auto_debit', bankAccountId: 'b1' })).toEqual({ method: 'bank_transfer', bankAccountId: 'b1' })
    expect(opexMoneyInput({ paymentMethod: 'cash', bankAccountId: null })).toEqual({ method: 'cash', bankAccountId: null })
    expect(opexMoneyInput({ paymentMethod: 'bank_transfer', bankAccountId: 'b1' }, { payFrom: 'cash' })).toEqual({ method: 'cash', bankAccountId: null })
    expect(opexMoneyInput({ paymentMethod: 'cash', bankAccountId: null }, { bankAccountId: 'b2' })).toEqual({ method: 'bank_transfer', bankAccountId: 'b2' })
  })
})

// ─── Category accounts ─────────────────────────────────────────────────────────

describe('OpEx category expense account', () => {
  it('pre-fills from the name map, takes a named code, refuses wrong ones', async () => {
    const rent = await call('adminA', 'POST', '/opex/categories', { name: 'Rent' })
    expect(rent.statusCode).toBe(201)
    expect(rent.json().tenantId).toBe(tenantA)
    expect(rent.json().expenseAccountCode).toBe('6010')

    const sec = await call('adminA', 'POST', '/opex/categories', { name: 'Security' })
    expect(sec.json().expenseAccountCode).toBeNull()
    const named = await call('adminA', 'POST', '/opex/categories', { name: 'Guards', expenseAccountCode: '6200' })
    expect(named.statusCode).toBe(201)
    expect(named.json().expenseAccountCode).toBe('6200')
    // An explicit null leaves it undecided even when the name maps.
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Insurance', expenseAccountCode: null })).json().expenseAccountCode).toBeNull()

    // Not an operating expense (COGS, stock) → refused by shape; a 6xxx the chart
    // lacks or has switched off → 422.
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Food', expenseAccountCode: '5010' })).statusCode).toBe(400)
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Stock', expenseAccountCode: '1210' })).statusCode).toBe(400)
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Odd', expenseAccountCode: '6999' })).json().error.code).toBe('ACCOUNT_NOT_FOUND')
    await prisma.account.updateMany({ where: { tenantId: tenantA, code: '6130' }, data: { isActive: false } })
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Property tax', expenseAccountCode: '6130' })).json().error.code).toBe('ACCOUNT_NOT_FOUND')
    // …and the name map never pre-fills a switched-off code.
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Property tax' })).json().expenseAccountCode).toBeNull()
    await prisma.account.updateMany({ where: { tenantId: tenantA, code: '6130' }, data: { isActive: true } })

    // Payroll never carries one.
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Payroll', expenseAccountCode: '6030' })).json().error.code).toBe('PAYROLL_CATEGORY')
    expect((await call('adminA', 'POST', '/opex/categories', { name: 'Payroll' })).json().expenseAccountCode).toBeNull()

    // PATCH sets it; renaming into payroll clears it.
    const p = await call('adminA', 'PATCH', `/opex/categories/${sec.json().id}`, { expenseAccountCode: '6200' })
    expect(p.statusCode).toBe(200)
    expect(p.json().expenseAccountCode).toBe('6200')
    const wages = await call('adminA', 'POST', '/opex/categories', { name: 'Staff costs', expenseAccountCode: '6110' })
    const renamed = await call('adminA', 'PATCH', `/opex/categories/${wages.json().id}`, { name: 'Salaries' })
    expect(renamed.json().expenseAccountCode).toBeNull()

    // The list carries the column, and the name map's suggestion for an unmapped one.
    const list = (await call('adminA', 'GET', '/opex/categories')).json() as Array<{ id: string; expenseAccountCode: string | null; suggestedExpenseAccountCode: string | null }>
    expect(list.find((c) => c.id === rent.json().id)!.expenseAccountCode).toBe('6010')
  })

  it('two companies: B cannot edit A\'s category (404); a code only A\'s chart has is 422 for B', async () => {
    const a = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'A only' } })
    const r = await call('adminB', 'PATCH', `/opex/categories/${a.id}`, { expenseAccountCode: '6040' })
    expect(r.statusCode).toBe(404)
    expect((await prisma.opexCategory.findUniqueOrThrow({ where: { id: a.id } })).expenseAccountCode).toBeNull()

    const createB = await call('adminB', 'POST', '/opex/categories', { name: 'Guards', expenseAccountCode: '6200' })
    expect(createB.statusCode).toBe(422)
    expect(createB.json().error.code).toBe('ACCOUNT_NOT_FOUND')
    const b = await call('adminB', 'POST', '/opex/categories', { name: 'Security' })
    expect(b.json().tenantId).toBe(tenantB)
    const patchB = await call('adminB', 'PATCH', `/opex/categories/${b.json().id}`, { expenseAccountCode: '6200' })
    expect(patchB.json().error.code).toBe('ACCOUNT_NOT_FOUND')
  })

  it('backfill: name map → column where the chart has the code; idempotent; never overwrites', async () => {
    const rent = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Shop rent' } })
    const odd = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Miscellany' } })
    const pay = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Payroll' } })
    const mine = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Cleaning', expenseAccountCode: '6050' } })
    await prisma.account.updateMany({ where: { tenantId: tenantB, code: '6100' }, data: { isActive: false } })
    const ins = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Insurance' } })

    const first = await backfillOpexCategoryAccounts()
    expect(first.mapped).toBeGreaterThanOrEqual(1)
    const code = async (id: string) => (await prisma.opexCategory.findUniqueOrThrow({ where: { id } })).expenseAccountCode
    expect(await code(rent.id)).toBe('6010')
    expect(await code(odd.id)).toBeNull()
    expect(await code(pay.id)).toBeNull()
    expect(await code(mine.id)).toBe('6050')
    expect(await code(ins.id)).toBeNull()
    expect((await backfillOpexCategoryAccounts()).mapped).toBe(0)
    await prisma.account.updateMany({ where: { tenantId: tenantB, code: '6100' }, data: { isActive: true } })
  })
})

// ─── Payments: accounts, dates, corrections ───────────────────────────────────

describe('OpEx payments post to the category account, from the right bank', () => {
  it('a category with an account posts there; an unmapped one asks once and remembers', async () => {
    const guards = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Night watch', expenseAccountCode: '6200' } })
    const gl = await prisma.opexLine.create({ data: { categoryId: guards.id, name: 'Guard company', amountCents: 80_000, bankAccountId: bank.mcbA, conceptId: conceptA } })
    const p1 = await call('adminA', 'POST', '/opex/payments', { lineId: gl.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 80_000, paidAt: '2026-09-28', paymentRef: 'CHQ-1101', receiptUrl: 'https://files.example.com/r/1101.jpg' })
    expect(p1.statusCode).toBe(201)
    expect(p1.json().paymentRef).toBe('CHQ-1101')
    expect(p1.json().receiptUrl).toBe('https://files.example.com/r/1101.jpg')
    const je = await entry(`opex.payment:${p1.json().id}`)
    expect(amt(je!.rows, '6200', 'debit')).toBe(80_000)
    expect(amt(je!.rows, '1021', 'credit')).toBe(80_000)
    expect(je!.rows.find((r) => r.code === '6200')!.conceptId).toBe(conceptA)
    // Booked on the day it was paid, not the day it was keyed.
    expect(je!.entryDate.toISOString().slice(0, 10)).toBe('2026-09-28')

    const pest = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Pest control' } })
    const pl = await prisma.opexLine.create({ data: { categoryId: pest.id, name: 'Fumigation', amountCents: 15_000, bankAccountId: bank.hblA } })
    const bad = await call('adminA', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 15_000, paidAt: '2026-09-10' })
    expect(bad.json().error.code).toBe('CATEGORY_NOT_MAPPED')
    expect(await prisma.opexPayment.count({ where: { lineId: pl.id } })).toBe(0)
    // A code that is not an active 6xxx expense of A's chart is refused, nothing saved.
    expect((await call('adminA', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 15_000, paidAt: '2026-09-10', expenseAccountCode: '6999' })).json().error.code).toBe('ACCOUNT_NOT_FOUND')
    expect(await prisma.opexPayment.count({ where: { lineId: pl.id } })).toBe(0)
    expect((await prisma.opexCategory.findUniqueOrThrow({ where: { id: pest.id } })).expenseAccountCode).toBeNull()

    const named = await call('adminA', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 15_000, paidAt: '2026-09-10', expenseAccountCode: '6040' })
    expect(named.statusCode).toBe(201)
    expect(amt((await entry(`opex.payment:${named.json().id}`))!.rows, '6040', 'debit')).toBe(15_000)
    // Remembered on the category, in the same transaction…
    expect((await prisma.opexCategory.findUniqueOrThrow({ where: { id: pest.id } })).expenseAccountCode).toBe('6040')
    // …so next period posts without asking.
    const next = await call('adminA', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 15_000, paidAt: '2026-10-10' })
    expect(next.statusCode).toBe(201)
    expect(amt((await entry(`opex.payment:${next.json().id}`))!.rows, '6040', 'debit')).toBe(15_000)

    // Changing the category's account moves NEW payments only.
    await call('adminA', 'PATCH', `/opex/categories/${pest.id}`, { expenseAccountCode: '6050' })
    await call('adminA', 'PATCH', `/opex/payments/${next.json().id}`, { actualCents: 16_000 })
    const re = await entry(`opex.payment:${next.json().id}@2`)
    expect(amt(re!.rows, '6040', 'debit')).toBe(16_000)
    const nov = await call('adminA', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 15_000, paidAt: '2026-10-11' })
    expect(amt((await entry(`opex.payment:${nov.json().id}`))!.rows, '6050', 'debit')).toBe(15_000)
    // A code named on the payment is an explicit correction: reposts there.
    await call('adminA', 'PATCH', `/opex/payments/${nov.json().id}`, { expenseAccountCode: '6040' })
    expect(amt((await entry(`opex.payment:${nov.json().id}@2`))!.rows, '6040', 'debit')).toBe(15_000)
  })

  it('PATCH corrects the paid date / reference / receipt; reposts only when the books change', async () => {
    const rent = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Kiosk rent', expenseAccountCode: '6010' } })
    const line = await prisma.opexLine.create({ data: { categoryId: rent.id, name: 'Kiosk', amountCents: 200_000, bankAccountId: bank.hblA } })
    // Before it is paid: saves, nothing on the books.
    const due = await call('adminA', 'POST', '/opex/payments', { lineId: line.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 200_000 })
    const id = due.json().id as string
    expect(due.json().ledger.status).toBe('not_paid')
    expect(await entriesFor(id)).toBe(0)
    const fixed = await call('adminA', 'PATCH', `/opex/payments/${id}`, { periodStart: '2026-09-02', notes: 'landlord changed' })
    expect(fixed.statusCode).toBe(200)
    expect(await entriesFor(id)).toBe(0)
    // Marked paid (backdated): posts on that day.
    const paid = await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: '2026-09-29', paymentRef: 'TRF-77' })
    expect(paid.json().ledger.status).toBe('posted')
    expect((await entry(`opex.payment:${id}`))!.entryDate.toISOString().slice(0, 10)).toBe('2026-09-29')
    // Reference / receipt only: saved, the books untouched.
    const ref = await call('adminA', 'PATCH', `/opex/payments/${id}`, { paymentRef: 'TRF-78', receiptUrl: 'https://files.example.com/r/78.pdf' })
    expect(ref.json().paymentRef).toBe('TRF-78')
    expect(ref.json().ledger.outcome).toBe('unchanged')
    expect(await entriesFor(id)).toBe(1)
    // Wrong day: reversed and reposted on the corrected day.
    await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: '2026-09-28' })
    expect(await entry(`opex.payment.reversal:${id}`)).toBeTruthy()
    expect((await entry(`opex.payment:${id}@2`))!.entryDate.toISOString().slice(0, 10)).toBe('2026-09-28')
    // A day still to come is refused.
    expect((await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: '2099-01-01' })).json().error.code).toBe('PAID_IN_FUTURE')
    expect((await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: 'not a date' })).statusCode).toBe(400)

    // A closed month: refused, nothing saved — neither a new payment nor a move into it.
    await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-08-31T18:59:59Z'), lockedBy: users.adminA!.id } })
    const locked = await call('adminA', 'POST', '/opex/payments', { lineId: line.id, periodStart: '2026-08-01', periodEnd: '2026-08-31', expectedCents: 200_000, paidAt: '2026-08-15' })
    expect(locked.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.opexPayment.count({ where: { lineId: line.id } })).toBe(1)
    const move = await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: '2026-08-20' })
    expect(move.json().error.code).toBe('PERIOD_LOCKED')
    expect((await prisma.opexPayment.findUniqueOrThrow({ where: { id } })).paidAt!.toISOString().slice(0, 10)).toBe('2026-09-28')
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantA } })

    // Un-marked paid: reversed.
    await call('adminA', 'PATCH', `/opex/payments/${id}`, { paidAt: null })
    expect(await entry(`opex.payment.reversal:${id}@2`)).toBeTruthy()
  })

  it('money: the one resolver — two banks need a pick; the live credit stays on edit; another company\'s bank is 422', async () => {
    const util = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Utilities' } })
    const noBank = await prisma.opexLine.create({ data: { categoryId: util.id, name: 'KE bill', amountCents: 50_000, paymentMethod: 'bank_transfer' } })
    // A has two banks and the line names none: refused, nothing saved.
    const req = await call('adminA', 'POST', '/opex/payments', { lineId: noBank.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 50_000, paidAt: '2026-09-12' })
    expect(req.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(await prisma.opexPayment.count({ where: { lineId: noBank.id } })).toBe(0)
    // Another company's bank on the payment: refused, nothing saved.
    const foreign = await call('adminA', 'POST', '/opex/payments', { lineId: noBank.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 50_000, paidAt: '2026-09-12', bankAccountId: bank.onlyB })
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.opexPayment.count({ where: { lineId: noBank.id } })).toBe(0)
    // Picked on the payment: credits that bank (Utilities → the name map's 6020).
    const ok = await call('adminA', 'POST', '/opex/payments', { lineId: noBank.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 50_000, paidAt: '2026-09-12', bankAccountId: bank.mcbA })
    expect(ok.statusCode).toBe(201)
    const id = ok.json().id as string
    let je = await entry(`opex.payment:${id}`)
    expect(amt(je!.rows, '6020', 'debit')).toBe(50_000)
    expect(amt(je!.rows, '1021', 'credit')).toBe(50_000)
    // An amount fix keeps the bank it was paid from (live credit) — no pick needed.
    const fix = await call('adminA', 'PATCH', `/opex/payments/${id}`, { actualCents: 52_000 })
    expect(fix.statusCode).toBe(200)
    je = await entry(`opex.payment:${id}@2`)
    expect(amt(je!.rows, '1021', 'credit')).toBe(52_000)
    // Naming the bank is a correction: reposted to HBL (1020).
    await call('adminA', 'PATCH', `/opex/payments/${id}`, { bankAccountId: bank.hblA })
    expect(amt((await entry(`opex.payment:${id}@3`))!.rows, '1020', 'credit')).toBe(52_000)
    // Paid in cash after all: 1010.
    await call('adminA', 'PATCH', `/opex/payments/${id}`, { payFrom: 'cash' })
    expect(amt((await entry(`opex.payment:${id}@4`))!.rows, '1010', 'credit')).toBe(52_000)
    expect((await call('adminA', 'PATCH', `/opex/payments/${id}`, { payFrom: 'cash', bankAccountId: bank.hblA })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')

    // The line's own bank (any non-cash method — a company card draws on it).
    const card = await call('adminA', 'POST', '/opex/lines', { categoryId: util.id, name: 'Gas bill', amountCents: 9_000, paymentMethod: 'card', bankAccountId: bank.mcbA })
    expect(card.statusCode).toBe(201)
    const cp = await call('adminA', 'POST', '/opex/payments', { lineId: card.json().id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 9_000, paidAt: '2026-09-14' })
    expect(amt((await entry(`opex.payment:${cp.json().id}`))!.rows, '1021', 'credit')).toBe(9_000)
    // A cash line names no bank; switching to cash drops it.
    expect((await call('adminA', 'POST', '/opex/lines', { categoryId: util.id, name: 'x', amountCents: 1, paymentMethod: 'cash', bankAccountId: bank.mcbA })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')
    expect((await call('adminA', 'PATCH', `/opex/lines/${card.json().id}`, { paymentMethod: 'cash', bankAccountId: bank.hblA })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')
    const toCash = await call('adminA', 'PATCH', `/opex/lines/${card.json().id}`, { paymentMethod: 'cash' })
    expect(toCash.json().bankAccountId).toBeNull()
    const cashPay = await call('adminA', 'POST', '/opex/payments', { lineId: card.json().id, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 9_000, paidAt: '2026-10-05' })
    expect(amt((await entry(`opex.payment:${cashPay.json().id}`))!.rows, '1010', 'credit')).toBe(9_000)

    // A one-bank company: no pick needed, its only bank is used.
    const utilB = await prisma.opexCategory.create({ data: { tenantId: tenantB, name: 'Utilities', expenseAccountCode: '6020' } })
    const lineB = await prisma.opexLine.create({ data: { categoryId: utilB.id, name: 'KE bill', amountCents: 30_000, paymentMethod: 'bank_transfer' } })
    const pb = await call('adminB', 'POST', '/opex/payments', { lineId: lineB.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 30_000, paidAt: '2026-09-12' })
    expect(pb.statusCode).toBe(201)
    const jb = await entry(`opex.payment:${pb.json().id}`)
    expect(jb!.tenantId).toBe(tenantB)
    expect(amt(jb!.rows, '1020', 'credit')).toBe(30_000)
    // …and B cannot touch A's payment.
    expect((await call('adminB', 'PATCH', `/opex/payments/${id}`, { actualCents: 1 })).statusCode).toBe(404)

    // The list shows where each paid row was booked and paid from.
    const list = (await call('adminA', 'GET', '/opex/categories')).json() as Array<{ lines: Array<{ payments: Array<{ id: string; ledger: { status: string; accountCode: string | null; creditCode: string | null } }> }> }>
    const row = list.flatMap((c) => c.lines.flatMap((l) => l.payments)).find((p) => p.id === cp.json().id)!
    expect(row.ledger).toMatchObject({ status: 'posted', accountCode: '6020', creditCode: '1021' })
  })
})

// ─── Post old payments ─────────────────────────────────────────────────────────

describe('post old OpEx payments (admin): preview, then post', () => {
  it('says exactly what would happen, posts what it can, never forces', async () => {
    // Paid before payments posted: rows with no journal entry.
    const ins = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Fire cover', expenseAccountCode: '6100' } })
    const insLine = await prisma.opexLine.create({ data: { categoryId: ins.id, name: 'Fire policy', amountCents: 40_000, bankAccountId: bank.hblA } })
    const good = await prisma.opexPayment.create({ data: { lineId: insLine.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), expectedCents: 40_000, actualCents: 40_000, paidAt: new Date('2026-09-03T07:00:00Z') } })
    const odd = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Sundries' } })
    const oddLine = await prisma.opexLine.create({ data: { categoryId: odd.id, name: 'Bits', amountCents: 1_000, bankAccountId: bank.hblA } })
    const unmapped = await prisma.opexPayment.create({ data: { lineId: oddLine.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), expectedCents: 1_000, actualCents: 1_000, paidAt: new Date('2026-09-04T07:00:00Z') } })
    const noBankLine = await prisma.opexLine.create({ data: { categoryId: ins.id, name: 'Theft policy', amountCents: 2_000, paymentMethod: 'cheque' } })
    const noBank = await prisma.opexPayment.create({ data: { lineId: noBankLine.id, periodStart: new Date('2026-09-01'), periodEnd: new Date('2026-09-30'), expectedCents: 2_000, actualCents: 2_000, paidAt: new Date('2026-09-05T07:00:00Z') } })
    const lockedP = await prisma.opexPayment.create({ data: { lineId: insLine.id, periodStart: new Date('2026-07-01'), periodEnd: new Date('2026-07-31'), expectedCents: 40_000, actualCents: 40_000, paidAt: new Date('2026-07-03T07:00:00Z') } })
    await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-07-31T18:59:59Z'), lockedBy: users.adminA!.id } })

    // Finance works OpEx but the backfill is the CEO's.
    expect((await call('finA', 'POST', '/opex/payments/post-unposted', { dryRun: true })).statusCode).toBe(403)

    const before = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const preview = await call('adminA', 'POST', '/opex/payments/post-unposted', { dryRun: true })
    expect(preview.statusCode).toBe(200)
    type Row = { paymentId: string; outcome: string; code?: string; category: string }
    const outcomeOf = (rows: Row[], id: string) => rows.find((r) => r.paymentId === id)?.outcome
    const pr = preview.json().rows as Row[]
    expect(outcomeOf(pr, good.id)).toBe('would_post')
    expect(outcomeOf(pr, unmapped.id)).toBe('needs_account')
    expect(pr.find((r) => r.paymentId === unmapped.id)!.category).toBe('Sundries')
    expect(outcomeOf(pr, noBank.id)).toBe('needs_bank')
    expect(outcomeOf(pr, lockedP.id)).toBe('period_locked')
    // The preview wrote nothing.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(before)
    expect(await prisma.opexCategory.findUniqueOrThrow({ where: { id: odd.id } }).then((c) => c.expenseAccountCode)).toBeNull()

    // B's admin sees none of A's.
    const other = (await call('adminB', 'POST', '/opex/payments/post-unposted', { dryRun: true })).json().rows as Row[]
    expect(other.some((r) => [good.id, unmapped.id, noBank.id, lockedP.id].includes(r.paymentId))).toBe(false)

    const run = await call('adminA', 'POST', '/opex/payments/post-unposted', { dryRun: false })
    const rr = run.json().rows as Row[]
    expect(outcomeOf(rr, good.id)).toBe('posted')
    expect(outcomeOf(rr, unmapped.id)).toBe('needs_account')
    expect(outcomeOf(rr, noBank.id)).toBe('needs_bank')
    expect(rr.find((r) => r.paymentId === noBank.id)!.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(outcomeOf(rr, lockedP.id)).toBe('period_locked')
    const je = await entry(`opex.payment:${good.id}`)
    expect(amt(je!.rows, '6100', 'debit')).toBe(40_000)
    expect(amt(je!.rows, '1020', 'credit')).toBe(40_000)

    // Fix the category, run again: it posts; the posted one is left alone.
    await call('adminA', 'PATCH', `/opex/categories/${odd.id}`, { expenseAccountCode: '6040' })
    const again = (await call('adminA', 'POST', '/opex/payments/post-unposted', { dryRun: false })).json().rows as Row[]
    expect(outcomeOf(again, unmapped.id)).toBe('posted')
    expect(outcomeOf(again, good.id)).toBe('already_posted')
    expect(await entriesFor(good.id)).toBe(1)
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantA } })
  })
})

// ─── CapEx instalment bank ─────────────────────────────────────────────────────

describe('CapEx instalments: the bank they are paid from', () => {
  it('stores the bank, credits it, keeps the live credit on edit, refuses another company\'s', async () => {
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, conceptId: conceptA, name: 'Kiosk build' } })
    const oven = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'Equipment', item: 'Deck oven', unitCostCents: 900_000, negotiatedCents: 900_000, status: 'ordered' } })
    const url = `/finance/capex/lines/${oven.id}/payments`

    // Two banks, none named: refused, no row.
    const none = await call('adminA', 'POST', url, { label: 'deposit', amountCents: 300_000, paidAt: '2026-09-02' })
    expect(none.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(await prisma.capexPayment.count({ where: { lineId: oven.id } })).toBe(0)
    // Another company's bank: refused, no row — even when only scheduled.
    expect((await call('adminA', 'POST', url, { label: 'deposit', amountCents: 300_000, paidAt: '2026-09-02', bankAccountId: bank.onlyB })).json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await call('adminA', 'POST', url, { label: 'balance', amountCents: 300_000, bankAccountId: bank.onlyB })).json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.capexPayment.count({ where: { lineId: oven.id } })).toBe(0)

    const dep = await call('adminA', 'POST', url, { label: 'deposit', amountCents: 300_000, paidAt: '2026-09-02', bankAccountId: bank.mcbA })
    expect(dep.statusCode).toBe(201)
    expect(dep.json().bankAccountId).toBe(bank.mcbA)
    const id = dep.json().id as string
    let je = await entry(`capex.payment:${id}`)
    expect(amt(je!.rows, '1340', 'debit')).toBe(300_000)
    expect(amt(je!.rows, '1021', 'credit')).toBe(300_000)

    // An amount fix keeps the live credit.
    await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { paidAmountCents: 310_000 })
    je = await entry(`capex.payment:${id}@2`)
    expect(amt(je!.rows, '1021', 'credit')).toBe(310_000)
    // Naming another of A's banks reposts there.
    const moved = await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { bankAccountId: bank.hblA })
    expect(moved.json().bankAccountId).toBe(bank.hblA)
    expect(amt((await entry(`capex.payment:${id}@3`))!.rows, '1020', 'credit')).toBe(310_000)
    // B's bank on edit: refused, nothing changed.
    expect((await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { bankAccountId: bank.onlyB })).json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await prisma.capexPayment.findUniqueOrThrow({ where: { id } })).bankAccountId).toBe(bank.hblA)
    // Cash: 1010, no bank on the row; a bank with cash is refused.
    expect((await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { payFrom: 'cash', bankAccountId: bank.hblA })).json().error.code).toBe('BANK_ACCOUNT_ON_CASH')
    const cash = await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { payFrom: 'cash' })
    expect(cash.json().bankAccountId).toBeNull()
    expect(amt((await entry(`capex.payment:${id}@4`))!.rows, '1010', 'credit')).toBe(310_000)
    // …and a later amount fix keeps it in cash.
    await call('adminA', 'PATCH', `/finance/capex/payments/${id}`, { paidAmountCents: 300_000 })
    expect(amt((await entry(`capex.payment:${id}@5`))!.rows, '1010', 'credit')).toBe(300_000)

    // Scheduled with a bank, marked paid later without naming it: that bank.
    const bal = await call('adminA', 'POST', url, { label: 'balance', amountCents: 600_000, dueDate: '2026-10-01', bankAccountId: bank.mcbA })
    expect(bal.json().ledger.status).toBe('not_paid')
    const paid = await call('adminA', 'PATCH', `/finance/capex/payments/${bal.json().id}`, { paidAt: '2026-10-02', paidAmountCents: 600_000 })
    expect(paid.statusCode).toBe(200)
    expect(amt((await entry(`capex.payment:${bal.json().id}`))!.rows, '1021', 'credit')).toBe(600_000)

    // B cannot touch A's instalment.
    expect((await call('adminB', 'PATCH', `/finance/capex/payments/${id}`, { bankAccountId: bank.onlyB })).statusCode).toBe(404)

    // A one-bank company needs no pick.
    const projectB = await prisma.capexProject.create({ data: { tenantId: tenantB, name: 'B build' } })
    const lineB = await prisma.capexLine.create({ data: { projectId: projectB.id, scope: 'Equipment', item: 'Fryer', unitCostCents: 100_000 } })
    const pb = await call('adminB', 'POST', `/finance/capex/lines/${lineB.id}/payments`, { label: 'deposit', amountCents: 100_000, paidAt: '2026-09-02' })
    expect(pb.statusCode).toBe(201)
    expect(amt((await entry(`capex.payment:${pb.json().id}`))!.rows, '1020', 'credit')).toBe(100_000)
  })
})
