// Accounts receivable — finance gaps wave A (2026-10-13).
//
//   #9   a receipt posts to the bank it actually went into (moneyAccountCode,
//        the INVOICE's company): two banks and no pick → 422, a foreign bank
//        → 422, nothing saved; the payment row carries the bank, the list
//        shows it.
//   14b  credit notes (AR-CN-YYYY-NNNN): Dr revenue + Dr the output tax the
//        invoice credited / Cr 1110, in the same transaction; never more than
//        invoiced (before tax and tax each, 409); a credit on money already
//        received leaves the customer in credit, which a refund pays out
//        (Dr 1110 / Cr bank); voiding a credit note puts it back.
//   14d  income tax the client withheld: Dr 1330 / Cr 1110, settles the
//        invoice, capped at what is due.
//   bounced cheque: a receipt is reversed (idempotent), the invoice owes it
//        again.
//   balance = total − paid − credited − withheld everywhere (status, aging).
//   Two companies throughout: B gets 404 on every A row; a closed period is
//   422 with nothing saved.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const YEAR = new Date().getUTCFullYear()
const today = () => new Date().toISOString().slice(0, 10)

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptSD: string, conceptPlain: string, conceptB: string
let bankA1: string, bankA2: string, bankB: string
const staff: Record<string, string> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@arcredit.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]}` } })
const AR = '/accounting/receivables'

type Line = { code: string; type: string; amount: number; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  const lines = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId }))
  expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
  return lines
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)
/** Net debit of a code in one company's books (every entry). */
async function netDebit(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}

async function raise(who: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', AR, {
    customerName: `Corporate ${RUN}`, issueDate: today(), dueDate: '2099-12-31', description: 'Catering',
    amountCents: 100_000, taxCents: 15_000, ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { id: string; number: string }
}
const inv = (id: string) => prisma.receivableInvoice.findUniqueOrThrow({ where: { id } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'AR A', slug: `arc-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'AR B', slug: `arc-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptSD = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: `arc-sd-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  conceptPlain = (await prisma.concept.create({ data: { name: 'No province', slug: `arc-np-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 16, taxRateCard: 5 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other co', slug: `arc-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  // A has two banks (1020 and a second on 1021); B has one.
  await prisma.account.create({ data: { tenantId: tenantA, code: '1021', name: 'Bank — Meezan', type: 'asset', isActive: true } })
  bankA1 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bankA2 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan', accountCode: '1021' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Bank', accountCode: '1020' } })).id
  await mkStaff('admA', tenantA)
  await mkStaff('admB', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(receivableRoutes, { prefix: AR })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── #9 receipts go to the bank used ─────────────────────────────────────────

describe('a receipt posts to the bank it went into', () => {
  it('two banks and no pick is 422 with nothing saved; the picked bank is debited and shown', async () => {
    const i = await raise('admA')
    const noPick = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-1', amountCents: 50_000, receivedAt: today(), method: 'bank' })
    expect(noPick.statusCode).toBe(422)
    expect(noPick.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect(Number((await inv(i.id)).paidCents)).toBe(0)
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)

    const foreign = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-2', amountCents: 50_000, receivedAt: today(), method: 'bank', bankAccountId: bankB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)

    const cashWithBank = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-3', amountCents: 50_000, receivedAt: today(), method: 'cash', bankAccountId: bankA1 })
    expect(cashWithBank.statusCode).toBe(422)

    const ok = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 50_000, receivedAt: today(), method: 'cheque', bankAccountId: bankA2, reference: 'CHQ-1' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().bankAccountId).toBe(bankA2)
    const lines = (await entry(tenantA, `receivable.payment:${ok.json().id}`))!
    expect(amt(lines, '1021', 'debit')).toBe(50_000)
    expect(amt(lines, '1020', 'debit')).toBe(0)
    expect(amt(lines, '1110', 'credit')).toBe(50_000)

    const cash = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-4', amountCents: 5_000, receivedAt: today(), method: 'cash' })
    expect(cash.statusCode).toBe(201)
    expect(amt((await entry(tenantA, `receivable.payment:${cash.json().id}`))!, '1010', 'debit')).toBe(5_000)

    const list = (await call('admA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string; status: string; balanceCents: number; payments: Array<{ id: string; bankName: string | null; kind: string }> }> }
    const row = list.invoices.find((r) => r.id === i.id)!
    expect(row.status).toBe('partial')
    expect(row.balanceCents).toBe(60_000)
    expect(row.payments.find((p) => p.id === ok.json().id)).toMatchObject({ bankName: 'Meezan', kind: 'payment' })
  })

  it('a one-bank company uses its only bank without a pick', async () => {
    const i = await raise('admB', { conceptId: conceptB })
    const r = await call('admB', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-5', amountCents: 115_000, receivedAt: today(), method: 'bank' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().bankAccountId).toBe(bankB)
    expect(amt((await entry(tenantB, `receivable.payment:${r.json().id}`))!, '1020', 'debit')).toBe(115_000)
    expect((await inv(i.id)).status).toBe('paid')
  })
})

// ─── Two companies ──────────────────────────────────────────────────────────

describe('company B never touches company A\'s receivables', () => {
  it('every write on an A invoice or payment is 404 for B, and B\'s list does not show it', async () => {
    const i = await raise('admA')
    const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-6', amountCents: 1_000, receivedAt: today(), method: 'cash' })
    expect(p.statusCode).toBe(201)
    const before = await inv(i.id)
    for (const [url, body] of [
      [`${AR}/${i.id}/payments`, { reference: 'ARC-7', amountCents: 1_000, receivedAt: today(), method: 'cash' }],
      [`${AR}/${i.id}/credit-notes`, { amountCents: 1_000, reason: 'dispute', date: today() }],
      [`${AR}/${i.id}/withholding`, { amountCents: 1_000, date: today() }],
      [`${AR}/${i.id}/refunds`, { amountCents: 1_000, date: today(), method: 'cash' }],
      [`${AR}/${i.id}/payments/${p.json().id}/reverse`, { reason: 'bounced' }],
      [`${AR}/${i.id}/void`, { reason: 'not mine' }],
    ] as const) {
      const r = await call('admB', 'POST', url, body)
      expect(r.statusCode, url).toBe(404)
    }
    const after = await inv(i.id)
    expect(after.paidCents).toEqual(before.paidCents)
    expect(after.creditedCents).toEqual(before.creditedCents)
    expect(after.whtCents).toEqual(before.whtCents)
    expect((await prisma.receivablePayment.findUniqueOrThrow({ where: { id: p.json().id } })).reversedAt).toBeNull()
    const listB = (await call('admB', 'GET', AR)).json() as { invoices: Array<{ id: string }> }
    expect(listB.invoices.some((r) => r.id === i.id)).toBe(false)
    // A payment id of A under a B-owned invoice path is also 404.
    const bInv = await raise('admB', { conceptId: conceptB })
    expect((await call('admB', 'POST', `${AR}/${bInv.id}/payments/${p.json().id}/reverse`, { reason: 'x-bounce' })).statusCode).toBe(404)
  })
})

// ─── 14b credit notes ───────────────────────────────────────────────────────

describe('credit notes', () => {
  it('credits revenue and the SRB output tax the invoice used, in the same transaction; numbered AR-CN-', async () => {
    const i = await raise('admA', { conceptId: conceptSD })
    expect(amt((await entry(tenantA, `receivable.issue:${i.id}`))!, '2032', 'credit')).toBe(15_000)

    const cn = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 20_000, taxCents: 3_000, reason: 'Short delivery', date: today() })
    expect(cn.statusCode, cn.body).toBe(201)
    const note = cn.json()
    expect(note.number).toMatch(new RegExp(`^AR-CN-${YEAR}-\\d{4}$`))
    expect(note).toMatchObject({ kind: 'credit_note', originalInvoiceId: i.id, status: 'issued', warning: null })
    expect(note.invoice).toMatchObject({ status: 'partial', balanceCents: 92_000 })
    const lines = (await entry(tenantA, `receivable.credit_note:${note.id}`))!
    expect(amt(lines, '4090', 'debit')).toBe(20_000)
    expect(amt(lines, '2032', 'debit')).toBe(3_000)
    expect(amt(lines, '2030', 'debit')).toBe(0)
    expect(amt(lines, '1110', 'credit')).toBe(23_000)
    expect(lines.every((l) => l.conceptId === conceptSD)).toBe(true)
    expect(Number((await inv(i.id)).creditedCents)).toBe(23_000)

    // Aging counts what is still owed, not the credited part.
    const list = (await call('admA', 'GET', `${AR}`)).json() as { invoices: Array<{ id: string; balanceCents: number; bucket: string | null; creditNotes: Array<{ id: string }>; originalNumber: string | null }> }
    const row = list.invoices.find((r) => r.id === i.id)!
    expect(row.balanceCents).toBe(92_000)
    expect(row.bucket).toBe('current')
    expect(row.creditNotes.map((c) => c.id)).toEqual([note.id])
    expect(list.invoices.find((r) => r.id === note.id)).toMatchObject({ balanceCents: 0, bucket: null, originalNumber: i.number })
    // A credit note is not outstanding.
    const out = (await call('admA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string }> }
    expect(out.invoices.some((r) => r.id === note.id)).toBe(false)

    // A second one gets the next number.
    const cn2 = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 1_000, reason: 'Rounding', date: today() })
    expect(cn2.statusCode).toBe(201)
    expect(parseInt(cn2.json().number.slice(-4), 10)).toBe(parseInt(note.number.slice(-4), 10) + 1)
  })

  it('never credits more than invoiced — before tax and tax each (409); a tax-only credit works', async () => {
    const i = await raise('admA', { conceptId: conceptSD })
    await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 30_000, taxCents: 0, reason: 'Part', date: today() })
    const over = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 70_001, reason: 'Too much', date: today() })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVER_CREDIT')
    expect(over.json().error.details).toMatchObject({ leftAmountCents: 70_000, leftTaxCents: 15_000 })

    const taxOnly = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { taxCents: 15_000, reason: 'Tax charged in error', date: today() })
    expect(taxOnly.statusCode, taxOnly.body).toBe(201)
    const tl = (await entry(tenantA, `receivable.credit_note:${taxOnly.json().id}`))!
    expect(tl.map((l) => [l.type, l.code, l.amount]).sort()).toEqual([['credit', '1110', 15_000], ['debit', '2032', 15_000]])
    const moreTax = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { taxCents: 1, reason: 'again', date: today() })
    expect(moreTax.statusCode).toBe(409)

    const empty = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { reason: 'nothing', date: today() })
    expect(empty.statusCode).toBe(400)
    const early = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 1, reason: 'before', date: '2000-01-01' })
    expect(early.statusCode).toBe(400)
    // Credit the rest → settled by credit alone.
    const rest = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 70_000, reason: 'Event cancelled', date: today() })
    expect(rest.statusCode).toBe(201)
    expect(rest.json().invoice).toMatchObject({ status: 'credited', balanceCents: 0 })
    // Nothing left: no payment, no credit note on a credit note.
    expect((await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-8', amountCents: 1, receivedAt: today(), method: 'cash' })).statusCode).toBe(409)
    const onNote = await call('admA', 'POST', `${AR}/${rest.json().id}/credit-notes`, { amountCents: 1, reason: 'nested', date: today() })
    expect(onNote.statusCode).toBe(409)
    expect(onNote.json().error.code).toBe('NOT_AN_INVOICE')
  })

  it('a credit on a paid invoice leaves the customer in credit; a refund pays it out from the bank picked', async () => {
    const i = await raise('admA', { taxCents: 0, amountCents: 50_000 })
    const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-9', amountCents: 50_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1 })
    expect(p.statusCode).toBe(201)
    expect((await inv(i.id)).status).toBe('paid')

    const cn = await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 10_000, reason: 'Price adjustment', date: today() })
    expect(cn.statusCode).toBe(201)
    expect(cn.json().invoice).toMatchObject({ status: 'paid', balanceCents: -10_000 })
    const list = (await call('admA', 'GET', `${AR}?status=in_credit`)).json() as { invoices: Array<{ id: string; balanceCents: number }>; creditBalanceCents: number }
    expect(list.invoices.find((r) => r.id === i.id)?.balanceCents).toBe(-10_000)
    expect(list.creditBalanceCents).toBeGreaterThanOrEqual(10_000)

    const tooMuch = await call('admA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 12_000, date: today(), method: 'bank', bankAccountId: bankA2 })
    expect(tooMuch.statusCode).toBe(409)
    expect(tooMuch.json().error.code).toBe('OVER_REFUND')
    const noPick = await call('admA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 10_000, date: today(), method: 'bank' })
    expect(noPick.statusCode).toBe(422)
    expect(noPick.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')

    const r = await call('admA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 10_000, date: today(), method: 'bank', bankAccountId: bankA2, reference: 'IBFT-77' })
    expect(r.statusCode, r.body).toBe(201)
    expect(Number(r.json().amountCents)).toBe(-10_000)
    const rl = (await entry(tenantA, `receivable.refund:${r.json().id}`))!
    expect(rl.map((l) => [l.type, l.code, l.amount]).sort()).toEqual([['credit', '1021', 10_000], ['debit', '1110', 10_000]])
    const after = await inv(i.id)
    expect(Number(after.paidCents)).toBe(40_000)
    expect(after.status).toBe('paid')
    const row = ((await call('admA', 'GET', AR)).json() as { invoices: Array<{ id: string; balanceCents: number; payments: Array<{ id: string; kind: string }> }> }).invoices.find((x) => x.id === i.id)!
    expect(row.balanceCents).toBe(0)
    expect(row.payments.find((x) => x.id === r.json().id)?.kind).toBe('refund')
    // Nothing more to refund.
    expect((await call('admA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 1, date: today(), method: 'cash' })).json().error.code).toBe('NO_CREDIT_BALANCE')
  })

  it('a credit note dated in a closed period is 422 and saves nothing', async () => {
    const i = await raise('admA')
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date(Date.now() - 86_400_000), lockedBy: 'test' } })
    try {
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
      // A credit note cannot be dated before its invoice: move the invoice's
      // issue date back to the closed day first.
      const old = await prisma.receivableInvoice.update({ where: { id: i.id }, data: { issueDate: new Date(`${yesterday}T00:00:00Z`) } })
      const before = await prisma.receivableInvoice.count({ where: { tenantId: tenantA, kind: 'credit_note' } })
      const r = await call('admA', 'POST', `${AR}/${old.id}/credit-notes`, { amountCents: 5_000, reason: 'Closed month', date: yesterday })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
      expect(await prisma.receivableInvoice.count({ where: { tenantId: tenantA, kind: 'credit_note' } })).toBe(before)
      expect(Number((await inv(i.id)).creditedCents)).toBe(0)
      // A payment dated there too.
      const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-10', amountCents: 5_000, receivedAt: yesterday, method: 'cash' })
      expect(p.statusCode).toBe(422)
      expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)
      expect(Number((await inv(i.id)).paidCents)).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })

  it('voiding a credit note puts the amount back on the invoice and reverses its entry; an invoice with a credit cannot be voided', async () => {
    const i = await raise('admA', { conceptId: conceptSD })
    const cn = (await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 10_000, taxCents: 1_500, reason: 'dispute', date: today() })).json()
    const v = await call('admA', 'POST', `${AR}/${i.id}/void`, { reason: 'mistake' })
    expect(v.statusCode).toBe(409)
    expect(v.json().error.code).toBe('CANNOT_VOID')

    const vc = await call('admA', 'POST', `${AR}/${cn.id}/void`, { reason: 'credited the wrong invoice' })
    expect(vc.statusCode, vc.body).toBe(200)
    const back = await inv(i.id)
    expect(Number(back.creditedCents)).toBe(0)
    expect(back.status).toBe('open')
    const rev = (await entry(tenantA, `receivable.credit_note.reversal:${cn.id}`))!
    expect(amt(rev, '1110', 'debit')).toBe(11_500)
    expect(amt(rev, '2032', 'credit')).toBe(1_500)
    expect((await call('admA', 'POST', `${AR}/${cn.id}/void`, { reason: 'again!' })).statusCode).toBe(409)
    // Now the invoice can be voided.
    expect((await call('admA', 'POST', `${AR}/${i.id}/void`, { reason: 'raised in error' })).statusCode).toBe(200)
  })

  it('a receipt and a refund that net to zero still block the void; a void invoice refuses reversals', async () => {
    const i = await raise('admA', { taxCents: 0, amountCents: 50_000 })
    const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-11', amountCents: 50_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1 })
    expect(p.statusCode, p.body).toBe(201)
    const cn = (await call('admA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 50_000, reason: 'Event cancelled', date: today() })).json()
    const r = await call('admA', 'POST', `${AR}/${i.id}/refunds`, { amountCents: 50_000, date: today(), method: 'bank', bankAccountId: bankA2 })
    expect(r.statusCode, r.body).toBe(201)
    expect((await call('admA', 'POST', `${AR}/${cn.id}/void`, { reason: 'credit raised by mistake' })).statusCode).toBe(200)
    // paid 50,000 − refunded 50,000 = 0 and nothing credited, but both rows
    // still sit in 1110 — the invoice cannot be voided until they are reversed.
    const v = await call('admA', 'POST', `${AR}/${i.id}/void`, { reason: 'raised in error' })
    expect(v.statusCode).toBe(409)
    expect(v.json().error.code).toBe('CANNOT_VOID')

    // A void invoice (another path) refuses a reversal of anything on it.
    const j = await raise('admA', { taxCents: 0, amountCents: 20_000 })
    const pj = await call('admA', 'POST', `${AR}/${j.id}/payments`, { reference: 'ARC-12', amountCents: 20_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1 })
    await prisma.receivableInvoice.update({ where: { id: j.id }, data: { status: 'void' } })
    const rv = await call('admA', 'POST', `${AR}/${j.id}/payments/${pj.json().id}/reverse`, { reason: 'bounced' })
    expect(rv.statusCode).toBe(409)
    expect(rv.json().error.code).toBe('INVOICE_VOID')
  })
})

// ─── 14d income tax withheld by the client ──────────────────────────────────

describe('income tax the client withheld', () => {
  it('100,000 paid 96,000 + 4,000 withheld → paid; Dr bank 96,000, Dr 1330 4,000, Cr 1110 100,000', async () => {
    const i = await raise('admA', { taxCents: 0 })
    const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-13', amountCents: 96_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1 })
    expect(p.statusCode).toBe(201)
    const over = await call('admA', 'POST', `${AR}/${i.id}/withholding`, { amountCents: 4_001, date: today() })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVER_WITHHOLDING')
    const w = await call('admA', 'POST', `${AR}/${i.id}/withholding`, { amountCents: 4_000, certificateNo: 'WHT-153-001', date: today() })
    expect(w.statusCode, w.body).toBe(201)
    expect(w.json()).toMatchObject({ method: 'wht', reference: 'WHT-153-001' })
    const after = await inv(i.id)
    expect(after.status).toBe('paid')
    expect(Number(after.whtCents)).toBe(4_000)
    const wl = (await entry(tenantA, `receivable.wht:${w.json().id}`))!
    expect(wl.map((l) => [l.type, l.code, l.amount]).sort()).toEqual([['credit', '1110', 4_000], ['debit', '1330', 4_000]])
    const pl = (await entry(tenantA, `receivable.payment:${p.json().id}`))!
    expect(amt(pl, '1020', 'debit')).toBe(96_000)
    expect(amt((await entry(tenantA, `receivable.issue:${i.id}`))!, '1110', 'debit') - 96_000 - 4_000).toBe(0)

    // A withdrawn certificate is reversed like a receipt.
    const rv = await call('admA', 'POST', `${AR}/${i.id}/payments/${w.json().id}/reverse`, { reason: 'certificate withdrawn' })
    expect(rv.statusCode).toBe(200)
    expect(rv.json()).toMatchObject({ kind: 'withholding', alreadyReversed: false })
    const re = await inv(i.id)
    expect(Number(re.whtCents)).toBe(0)
    expect(re.status).toBe('partial')
    expect(amt((await entry(tenantA, `receivable.wht.reversal:${w.json().id}`))!, '1330', 'credit')).toBe(4_000)
  })
})

// ─── Bounced cheque ─────────────────────────────────────────────────────────

describe('a receipt can be reversed (bounced cheque)', () => {
  it('reverses the receipt\'s entry, the invoice owes it again, idempotent', async () => {
    const i = await raise('admA', { taxCents: 0, amountCents: 30_000 })
    const p = await call('admA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 30_000, receivedAt: today(), method: 'cheque', bankAccountId: bankA2, reference: 'CHQ-9' })
    expect((await inv(i.id)).status).toBe('paid')

    const r1 = await call('admA', 'POST', `${AR}/${i.id}/payments/${p.json().id}/reverse`, { reason: 'Cheque bounced' })
    expect(r1.statusCode, r1.body).toBe(200)
    expect(r1.json()).toMatchObject({ alreadyReversed: false, reversedReason: 'Cheque bounced' })
    expect(r1.json().reversedAt).toBeTruthy()
    const after = await inv(i.id)
    expect(Number(after.paidCents)).toBe(0)
    expect(after.status).toBe('open')
    const rl = (await entry(tenantA, `receivable.payment.reversal:${p.json().id}`))!
    expect(rl.map((l) => [l.type, l.code, l.amount]).sort()).toEqual([['credit', '1021', 30_000], ['debit', '1110', 30_000]])

    const r2 = await call('admA', 'POST', `${AR}/${i.id}/payments/${p.json().id}/reverse`, { reason: 'Cheque bounced' })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().alreadyReversed).toBe(true)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `receivable.payment.reversal:${p.json().id}` } })).toBe(1)
    expect(Number((await inv(i.id)).paidCents)).toBe(0)

    // Owes it again: a new receipt is accepted, and the old one is listed as reversed.
    const again = await call('admA', 'POST', `${AR}/${i.id}/payments`, { reference: 'ARC-14', amountCents: 30_000, receivedAt: today(), method: 'bank', bankAccountId: bankA1 })
    expect(again.statusCode).toBe(201)
    expect((await inv(i.id)).status).toBe('paid')
    const unknownPay = await call('admA', 'POST', `${AR}/${i.id}/payments/00000000-0000-0000-0000-000000000000/reverse`, { reason: 'nope' })
    expect(unknownPay.statusCode).toBe(404)
  })
})

// ─── Tax rates on the new-invoice form ──────────────────────────────────────

describe('the invoice form reads the brand\'s own rates', () => {
  it('cash and card rates of the brand, and the authority account the tax goes to', async () => {
    const sd = await call('admA', 'GET', `${AR}/tax-preview?conceptId=${conceptSD}`)
    expect(sd.statusCode).toBe(200)
    expect(sd.json()).toMatchObject({ rates: { cashPct: 15, cardPct: 8 }, accountCode: '2032', accountName: 'SRB Sales Tax Output' })
    const plain = await call('admA', 'GET', `${AR}/tax-preview?conceptId=${conceptPlain}`)
    expect(plain.json()).toMatchObject({ rates: { cashPct: 16, cardPct: 5 }, accountCode: '2030' })
    const none = await call('admA', 'GET', `${AR}/tax-preview`)
    expect(none.json()).toMatchObject({ rates: null, accountCode: '2030' })
    expect((await call('admA', 'GET', `${AR}/tax-preview?conceptId=${conceptB}`)).statusCode).toBe(404)
  })
})

// ─── The subledger ties to 1110 ─────────────────────────────────────────────

describe('the AR subledger ties to the 1110 balance', () => {
  it('Σ balances of A\'s invoices = A\'s 1110 net debit (no till in this company)', async () => {
    const list = (await call('admA', 'GET', AR)).json() as { invoices: Array<{ kind: string; balanceCents: number }>; outstandingCents: number; creditBalanceCents: number }
    const sum = list.invoices.filter((r) => r.kind === 'invoice').reduce((t, r) => t + r.balanceCents, 0)
    expect(await netDebit(tenantA, '1110')).toBe(sum)
    expect(list.outstandingCents - list.creditBalanceCents).toBe(sum)
  })
})
