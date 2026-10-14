// Customer-withheld sales tax set off in a tax payment (finance wave B, H13 —
// accounting/taxPayments.ts).
//
// A client that is a withholding agent keeps part of our SRB / PRA tax and
// pays it to the authority for us; the receivable books it on 1335 'Sales Tax
// Withheld by Customers' (ReceivablePayment method 'st_withheld',
// 'receivable.st_withheld:<id>'). Paying that authority's return sets it off:
//   Dr 2032 (paid + withheld) / Cr 1335 (withheld) / Cr bank (paid)
//
//   • capped at what clients withheld for THAT authority (received on or
//     before the payment date, reversals left out) less earlier set-offs, and
//     at what 1335 holds — SRB withholding never pays PRA;
//   • 'wht' / 'stwh' / statutory payments take no withheld set-off (422);
//   • B can never use A's 1335 (its own available is 0);
//   • voiding the payment frees what it set off;
//   • a linked manual entry with a Cr 1335 line counts as withheld set off,
//     never as money paid — and is held to the same cap.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import {
  recordTaxPayment, voidTaxPayment, customerWithheldAvailable, monthPeriod, type RecordTaxPaymentInput,
} from '../src/modules/accounting/taxPayments.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string
let bankA: string, sdA: string
let invoiceA: string

const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const TODAY = pktIso(new Date())
const M2 = TODAY.slice(0, 7)
const prevMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
const M1 = prevMonth(M2)
const M0 = prevMonth(M1)
const at = (iso: string) => new Date(`${iso}T10:00:00+05:00`)

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@stwh.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

let seq = 0
/** A client withheld `cents` of `authority` sales tax on A's invoice: the receivable row and its Dr 1335 / Cr 1110. */
async function withheld(tenantId: string, authority: string, cents: number, receivedAt: Date) {
  const p = await prisma.receivablePayment.create({
    data: { tenantId, invoiceId: invoiceA, amountCents: cents, receivedAt, method: 'st_withheld', taxAuthority: authority },
  })
  await postJournalEntry({
    tenantId, sourceType: 'receivable.st_withheld', sourceId: p.id, description: 'withheld by client', postedBy: 'test', entryDate: receivedAt,
    lines: [{ accountCode: '1335', type: 'debit', amountCents: cents }, { accountCode: '1110', type: 'credit', amountCents: cents }],
  })
  return p.id
}
async function entryLines(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) }))
}
const amt = (lines: Array<{ code: string; type: string; amount: number }>, code: string, type: string) =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)

const base = (over: Partial<RecordTaxPaymentInput>): RecordTaxPaymentInput => ({
  tenantId: tenantA, authority: 'srb', periodFrom: monthPeriod(M1).from, periodTo: monthPeriod(M1).to,
  paidCents: 0, inputSetOffCents: 0, customerWithheldSetOffCents: 0, paidAt: `${M2}-01`, method: 'bank_transfer',
  bankAccountId: bankA, cprNumber: null, notes: null, userId: staff['finA']!.id, ...over,
})

beforeAll(async () => {
  tenantA = await company('STWH A')
  tenantB = await company('STWH B')
  sdA = (await prisma.concept.create({ data: { name: 'A Karachi', slug: `stwh-a-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD' } })).id
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'A Operating', accountCode: '1020' } })).id
  await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Operating', accountCode: '1020' } })
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('adminA', 'admin', tenantA)
  await mkStaff('adminB', 'admin', tenantB)
  invoiceA = (await prisma.receivableInvoice.create({
    data: {
      tenantId: tenantA, conceptId: sdA, number: `AR-${RUN}-1`, customerName: 'Corporate client', issueDate: at(`${M1}-05`), dueDate: at(`${M1}-30`),
      description: 'Catering', amountCents: 100_000, taxCents: 16_000,
    },
  })).id
  // A's SRB output for M1, and 3,200 of it withheld by the client on M1-15.
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'test.sale', sourceId: `${RUN}-${++seq}`, description: 'sale', postedBy: 'test', entryDate: at(`${M1}-05`),
    lines: [
      { accountCode: '1110', type: 'debit', amountCents: 116_000 },
      { accountCode: '4090', type: 'credit', amountCents: 100_000, conceptId: sdA },
      { accountCode: '2032', type: 'credit', amountCents: 16_000, conceptId: sdA },
    ],
  })
  await withheld(tenantA, 'srb', 3_200, at(`${M1}-15`))

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('customer-withheld sales tax set off (H13)', () => {
  let srbPaymentId: string

  it('what is available: per company and per authority', async () => {
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(3_200)
    expect(await customerWithheldAvailable(prisma, tenantA, 'pra', new Date())).toBe(0)
    expect(await customerWithheldAvailable(prisma, tenantB, 'srb', new Date())).toBe(0)
    // Not yet received on M1-10.
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', at(`${M1}-10`))).toBe(0)
  })

  it('SRB withholding never pays PRA (422), though 1335 holds it', async () => {
    await expect(recordTaxPayment(base({ authority: 'pra', paidCents: 1_000, customerWithheldSetOffCents: 1_000 })))
      .rejects.toMatchObject({ code: 'WITHHELD_SET_OFF_TOO_LARGE', statusCode: 422 })
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })).toBe(0)
  })

  it('withholding and statutory payments take no withheld set-off', async () => {
    await expect(recordTaxPayment(base({ authority: 'wht', paidCents: 1_000, customerWithheldSetOffCents: 100 })))
      .rejects.toMatchObject({ code: 'NO_WITHHELD_SET_OFF', statusCode: 422 })
    await expect(recordTaxPayment(base({ authority: 'stwh', paidCents: 1_000, customerWithheldSetOffCents: 100 })))
      .rejects.toMatchObject({ code: 'NO_WITHHELD_SET_OFF' })
    await expect(recordTaxPayment(base({ authority: 'eobi', paidCents: 1_000, customerWithheldSetOffCents: 100 })))
      .rejects.toMatchObject({ code: 'NO_WITHHELD_SET_OFF' })
  })

  it('SRB: Dr 2032 (paid + withheld) / Cr 1335 / Cr bank — balanced, in A\'s books', async () => {
    const row = await recordTaxPayment(base({ paidCents: 12_800, customerWithheldSetOffCents: 3_200, cprNumber: 'SRB-1' }))
    srbPaymentId = row.id
    expect(row).toMatchObject({ tenantId: tenantA, authority: 'srb', paidCents: 12_800, customerWithheldSetOffCents: 3_200, outputSetOffCents: 16_000, inputSetOffCents: 0 })
    const lines = await entryLines(tenantA, `salestax.payment:${row.id}`)
    expect(amt(lines, '2032', 'debit')).toBe(16_000)
    expect(amt(lines, '1335', 'credit')).toBe(3_200)
    expect(amt(lines, '1020', 'credit')).toBe(12_800)
    expect(amt(lines, '2032', 'debit')).toBe(amt(lines, '1335', 'credit') + amt(lines, '1020', 'credit'))
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(0)
  })

  it('above what is left: 422 and nothing is saved', async () => {
    await expect(recordTaxPayment(base({ periodFrom: monthPeriod(M2).from, periodTo: monthPeriod(M2).to, paidAt: TODAY, paidCents: 100, customerWithheldSetOffCents: 1 })))
      .rejects.toMatchObject({ code: 'WITHHELD_SET_OFF_TOO_LARGE' })
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })).toBe(1)
  })

  it('B can never set off A\'s 1335', async () => {
    await expect(recordTaxPayment(base({ tenantId: tenantB, bankAccountId: null, paidCents: 100, customerWithheldSetOffCents: 100, userId: staff['adminB']!.id })))
      .rejects.toMatchObject({ code: 'WITHHELD_SET_OFF_TOO_LARGE' })
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantB } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB } })).toBe(0)
  })

  it('voiding the payment frees what it set off', async () => {
    await voidTaxPayment({ scope: { tenantId: tenantA }, id: srbPaymentId, reason: 'wrong amount', userId: staff['finA']!.id })
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(3_200)
    const rev = await entryLines(tenantA, `salestax.payment.reversal:${srbPaymentId}`)
    expect(amt(rev, '1335', 'debit')).toBe(3_200)
  })

  it('withholding received after the payment date cannot be set off by it; a reversed one never counts', async () => {
    // On M1-10 nothing had been withheld yet.
    await expect(recordTaxPayment(base({ periodFrom: monthPeriod(M0).from, periodTo: monthPeriod(M0).to, paidAt: `${M1}-10`, paidCents: 100, customerWithheldSetOffCents: 100 })))
      .rejects.toMatchObject({ code: 'WITHHELD_SET_OFF_TOO_LARGE' })
    const late = await withheld(tenantA, 'srb', 500, new Date())
    // On M1-20 only the 3,200 had been received.
    await expect(recordTaxPayment(base({ periodFrom: monthPeriod(M0).from, periodTo: monthPeriod(M0).to, paidAt: `${M1}-20`, paidCents: 0, customerWithheldSetOffCents: 3_700 })))
      .rejects.toMatchObject({ code: 'WITHHELD_SET_OFF_TOO_LARGE' })
    const ok = await recordTaxPayment(base({ periodFrom: monthPeriod(M0).from, periodTo: monthPeriod(M0).to, paidAt: `${M1}-20`, paidCents: 0, customerWithheldSetOffCents: 3_200 }))
    expect(ok).toMatchObject({ paidCents: 0, customerWithheldSetOffCents: 3_200, outputSetOffCents: 3_200, bankAccountId: null })
    const lines = await entryLines(tenantA, `salestax.payment:${ok.id}`)
    expect(lines).toHaveLength(2)
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(500)
    await prisma.receivablePayment.update({ where: { id: late }, data: { reversedAt: new Date(), reversedReason: 'client reversed it' } })
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(0)
  })

  it('a linked manual entry: its Cr 1335 is withheld set off, never money paid', async () => {
    await withheld(tenantA, 'srb', 2_000, at(`${M1}-25`))
    const accounts = await prisma.account.findMany({ where: { tenantId: tenantA, code: { in: ['2032', '1335', '1020', '2031'] } }, select: { id: true, code: true } })
    const id = (code: string) => accounts.find((a) => a.code === code)!.id
    const manual = await call('adminA', 'POST', '/accounting/journal', {
      description: 'SRB paid for this month, client withholding used', entryDate: at(`${M2}-01`).toISOString(),
      lines: [
        { accountId: id('2032'), type: 'debit', amountCents: 5_000 },
        { accountId: id('1335'), type: 'credit', amountCents: 2_000 },
        { accountId: id('1020'), type: 'credit', amountCents: 3_000 },
      ],
    })
    expect(manual.statusCode).toBe(201)
    const link = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: manual.json().id, authority: 'srb', period: M2 })
    expect(link.statusCode).toBe(201)
    expect(link.json()).toMatchObject({ tenantId: tenantA, linked: true, outputSetOffCents: 5_000, customerWithheldSetOffCents: 2_000, paidCents: 3_000, bankAccountId: bankA })
    expect(await customerWithheldAvailable(prisma, tenantA, 'srb', new Date())).toBe(0)

    // The same shape for PRA: no PRA withholding exists, so it is refused.
    const pra = await call('adminA', 'POST', '/accounting/journal', {
      description: 'PRA paid with withholding that does not exist', entryDate: at(`${M2}-01`).toISOString(),
      lines: [
        { accountId: id('2031'), type: 'debit', amountCents: 9_000 },
        { accountId: id('1335'), type: 'credit', amountCents: 1_000 },
        { accountId: id('1020'), type: 'credit', amountCents: 8_000 },
      ],
    })
    expect(pra.statusCode).toBe(201)
    const refused = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: pra.json().id, authority: 'pra', period: M2 })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('WITHHELD_SET_OFF_TOO_LARGE')
    // B cannot link A's entry at all.
    const foreign = await call('adminB', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: pra.json().id, authority: 'pra', period: M2 })
    expect(foreign.statusCode).toBe(404)
  })
})
