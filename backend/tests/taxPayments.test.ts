// Tax paid to the authorities, and the sales tax return around it — finance
// gap 6 and the tax group's extra findings.
//
//   • The return's output / input are what was CHARGED in the period: a
//     payment ('salestax.payment:<id>') or an entry linked as one is left out,
//     so paying September's SRB in October lowers neither month's output.
//     Each authority shows what was paid for the period and the ledger
//     balance at the period's end.
//   • POST /accounting/sales-tax-return/payments posts Dr 203x (paid + input
//     set off) / Cr 132x (input set off) / Cr the company's bank (paid);
//     'wht' Dr 2040 and 'stwh' Dr 2041 / Cr bank. A closed date is 422 and
//     nothing is saved; one payment per authority and period.
//   • …/payments/link records an existing manual entry as the payment without
//     posting again; …/payments/:id/void reverses (or unlinks) it.
//   • …/reclass moves a provincial brand's 2030 tax for a month to its
//     authority (Dr 2030 / Cr 2032, tagged), dated in that month; a repeat is
//     a no-op; a closed month is 422; a later refund debits 2032; the
//     per-rate breakdown then files the sale with SRB.
//   • A brand deactivated mid-period stays in the return; zero-rated and
//     exempt lines are not declared as standard-rated taxable value.
//   • Two companies: B cannot pay, link, void or reclass against A's books
//     (404 / 422), and A's payment is absent from B's return.
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
import { postOrderCompletion, postRefundPayment } from '../src/modules/accounting/orderPosting.js'
import { salesTaxReturn, outputTaxCollectedCents } from '../src/modules/accounting/salesTaxReturn.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string, tenantC: string, tenantD: string, tenantE: string
let sdA: string, fbrA: string, sdB: string, sdC: string, sdD: string
let bankA: string, bankB: string

// ─── Dates: last month (M1) and this month (M2), Pakistan time ───────────────
const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const TODAY = pktIso(new Date())
const M2 = TODAY.slice(0, 7)
const M1 = (() => {
  const [y, m] = M2.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
})()
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const at = (iso: string) => new Date(`${iso}T10:00:00+05:00`)
const M1_FROM = parsePktStartOfDay(`${M1}-01`), M1_TO = parsePktEndOfDay(lastDay(M1))
const M2_FROM = parsePktStartOfDay(`${M2}-01`), M2_TO = parsePktEndOfDay(TODAY)

async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@taxpay.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}` } })

type Line = { code: string; type: string; amount: number; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<(Line[] & { entryDate?: Date }) | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  const lines = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, conceptId: l.conceptId })) as Line[] & { entryDate?: Date }
  lines.entryDate = je.entryDate
  return lines
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)

let seq = 0
/** A synthetic sale: Dr cash / Cr revenue / Cr the tax account, tagged with the brand. */
async function sale(tenantId: string, conceptId: string, taxCode: string, taxCents: number, when: Date) {
  await postJournalEntry({
    tenantId, sourceType: 'test.sale', sourceId: `${RUN}-${++seq}`, description: 'sale', postedBy: 'test', entryDate: when,
    lines: [
      { accountCode: '1010', type: 'debit', amountCents: taxCents * 10 },
      { accountCode: '4090', type: 'credit', amountCents: taxCents * 9, conceptId },
      { accountCode: taxCode, type: 'credit', amountCents: taxCents, conceptId },
    ],
  })
}
async function post(tenantId: string, when: Date, lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; conceptId?: string }>) {
  await postJournalEntry({ tenantId, sourceType: 'test.entry', sourceId: `${RUN}-${++seq}`, description: 'entry', postedBy: 'test', entryDate: when, lines })
}
const authorityOf = (r: Awaited<ReturnType<typeof salesTaxReturn>>, a: string) => r.byAuthority.find((x) => x.authority === a)

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
const brand = async (tenantId: string, name: string, province: string | null) =>
  (await prisma.concept.create({ data: { name, slug: `tp-${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}`, type: 'restaurant', tenantId, province } })).id

beforeAll(async () => {
  tenantA = await company('Tax A')
  tenantB = await company('Tax B')
  tenantC = await company('Tax C locked')
  tenantD = await company('Tax D classes')
  tenantE = await company('Tax E closed brand')
  sdA = await brand(tenantA, 'A Karachi', 'SD')
  fbrA = await brand(tenantA, 'A Islamabad', 'ICT')
  sdB = await brand(tenantB, 'B Karachi', 'SD')
  sdC = await brand(tenantC, 'C Karachi', 'SD')
  sdD = await brand(tenantD, 'D Karachi', 'SD')
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'A Operating', accountCode: '1020' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Operating', accountCode: '1020' } })).id
  await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'C Operating', accountCode: '1020' } })
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('adminA', 'admin', tenantA)
  await mkStaff('fnbA', 'fnb_manager', tenantA)
  await mkStaff('adminB', 'admin', tenantB)
  await mkStaff('finC', 'finance', tenantC)
  await mkStaff('finD', 'finance', tenantD)

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

// ─── Payments ─────────────────────────────────────────────────────────────────

describe('a tax payment is first-class and never lowers the output of a return', () => {
  let srbPaymentId: string

  it('paying last month\'s SRB this month: balanced, from the company\'s bank, both months\' output unchanged', async () => {
    await sale(tenantA, sdA, '2032', 1_500, at(`${M1}-10`))
    await sale(tenantA, sdA, '2032', 900, at(`${M2}-01`))
    const before1 = authorityOf(await salesTaxReturn(tenantA, M1_FROM, M1_TO), 'SRB')!
    const before2 = authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')!
    expect(before1.output.totalCents).toBe(1_500)
    expect(before2.output.totalCents).toBe(900)

    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'srb', period: M1, paidCents: 1_500, paidAt: `${M2}-01`, method: 'bank_transfer', bankAccountId: bankA, cprNumber: 'SRB-CPR-1',
    })
    expect(res.statusCode).toBe(201)
    const row = res.json() as { id: string; tenantId: string; journalEntryId: string; paidCents: number; outputSetOffCents: number; bankAccountId: string }
    srbPaymentId = row.id
    expect(row).toMatchObject({ tenantId: tenantA, paidCents: 1_500, outputSetOffCents: 1_500, bankAccountId: bankA })
    expect(row.journalEntryId).toBeTruthy()

    const je = (await entry(tenantA, `salestax.payment:${row.id}`))!
    expect(amt(je, '2032', 'debit')).toBe(1_500)
    expect(amt(je, '1020', 'credit')).toBe(1_500)
    expect(side(je, 'debit')).toBe(side(je, 'credit'))
    expect(pktIso(je.entryDate!)).toBe(`${M2}-01`)

    const after1 = authorityOf(await salesTaxReturn(tenantA, M1_FROM, M1_TO), 'SRB')!
    const after2 = authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')!
    expect(after1.output.totalCents).toBe(1_500)          // unchanged
    expect(after2.output.totalCents).toBe(900)            // was 900 − 1,500 before the fix
    expect(after1.paidForPeriodCents).toBe(1_500)
    expect(after1.ledgerBalanceAtEndCents).toBe(1_500)   // paid after M1 closed
    expect(after2.paidForPeriodCents).toBe(0)
    expect(after2.ledgerBalanceAtEndCents).toBe(900)     // 1,500 + 900 − 1,500
    // The CEO "Tax collected" card: what was charged, not charged − paid.
    expect(await outputTaxCollectedCents([tenantA], M2_FROM, M2_TO)).toBe(900)
  })

  it('a second payment for the same authority and period is refused', async () => {
    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'srb', periodFrom: `${M1}-01`, periodTo: lastDay(M1), paidCents: 100, paidAt: `${M2}-01`, bankAccountId: bankA,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('TAX_PAYMENT_EXISTS')
  })

  it('FBR with input set off: Dr 2030 (paid + input) / Cr 1320 / Cr bank; the month paid in shows no negative input', async () => {
    await sale(tenantA, fbrA, '2030', 3_000, at(`${M1}-12`))
    await post(tenantA, at(`${M1}-12`), [
      { accountCode: '1320', type: 'debit', amountCents: 1_000 }, { accountCode: '5010', type: 'debit', amountCents: 9_000 },
      { accountCode: '2010', type: 'credit', amountCents: 10_000 },
    ])
    // More input than the books hold is refused.
    const tooMuch = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'fbr', period: M1, paidCents: 1_000, inputSetOffCents: 2_000, paidAt: `${M2}-01`, bankAccountId: bankA,
    })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().error.code).toBe('INPUT_SET_OFF_TOO_LARGE')

    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'fbr', period: M1, paidCents: 2_000, inputSetOffCents: 1_000, paidAt: `${M2}-01`, bankAccountId: bankA,
    })
    expect(res.statusCode).toBe(201)
    const je = (await entry(tenantA, `salestax.payment:${res.json().id}`))!
    expect(amt(je, '2030', 'debit')).toBe(3_000)
    expect(amt(je, '1320', 'credit')).toBe(1_000)
    expect(amt(je, '1020', 'credit')).toBe(2_000)

    const m1 = authorityOf(await salesTaxReturn(tenantA, M1_FROM, M1_TO), 'FBR')!
    expect(m1).toMatchObject({ netPayableCents: 2_000, paidForPeriodCents: 2_000, inputSetOffForPeriodCents: 1_000, ledgerBalanceAtEndCents: 3_000, inputLedgerBalanceAtEndCents: 1_000 })
    const m2 = authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'FBR')!
    expect(m2.output.totalCents).toBe(0)
    expect(m2.input.totalCents).toBe(0)                   // not −1,000
    expect(m2.ledgerBalanceAtEndCents).toBe(0)
    expect(m2.inputLedgerBalanceAtEndCents).toBe(0)
  })

  it('withholding: WHT Dr 2040 / Cr bank, STWH Dr 2041 / Cr bank, no input set off', async () => {
    await post(tenantA, at(`${M1}-15`), [
      { accountCode: '2010', type: 'debit', amountCents: 4_000 },
      { accountCode: '2040', type: 'credit', amountCents: 2_500 },
      { accountCode: '2041', type: 'credit', amountCents: 1_500 },
    ])
    const bad = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'wht', period: M1, paidCents: 2_000, inputSetOffCents: 500, paidAt: `${M2}-01`, bankAccountId: bankA,
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('NO_INPUT_SET_OFF')

    const wht = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'wht', period: M1, paidCents: 2_500, paidAt: `${M2}-01`, bankAccountId: bankA })
    expect(wht.statusCode).toBe(201)
    const w = (await entry(tenantA, `salestax.payment:${wht.json().id}`))!
    expect(amt(w, '2040', 'debit')).toBe(2_500)
    expect(amt(w, '1020', 'credit')).toBe(2_500)
    const stwh = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'stwh', period: M1, paidCents: 1_500, paidAt: `${M2}-01`, method: 'cash' })
    expect(stwh.statusCode).toBe(201)
    const s = (await entry(tenantA, `salestax.payment:${stwh.json().id}`))!
    expect(amt(s, '2041', 'debit')).toBe(1_500)
    expect(amt(s, '1010', 'credit')).toBe(1_500)

    const r1 = await salesTaxReturn(tenantA, M1_FROM, M1_TO)
    expect(r1.withholding.find((x) => x.key === 'wht')).toMatchObject({ account: { code: '2040', totalCents: 2_500 }, paidForPeriodCents: 2_500, ledgerBalanceAtEndCents: 2_500 })
    const r2 = await salesTaxReturn(tenantA, M2_FROM, M2_TO)
    expect(r2.withholding.find((x) => x.key === 'wht')).toMatchObject({ account: { totalCents: 0 }, ledgerBalanceAtEndCents: 0 })
    expect(r2.withholding.find((x) => x.key === 'stwh')).toMatchObject({ account: { totalCents: 0 }, ledgerBalanceAtEndCents: 0 })
  })

  it('who may pay: a role outside finance / the CEO is refused; another company\'s bank is 422; PRA / KPRA / BRA are not authorities', async () => {
    const before = await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })
    const fnb = await call('fnbA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M2, paidCents: 100, paidAt: `${M2}-01` })
    expect(fnb.statusCode).toBe(403)
    const foreignBank = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M2, paidCents: 100, paidAt: `${M2}-01`, bankAccountId: bankB })
    expect(foreignBank.statusCode).toBe(422)
    expect(foreignBank.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    const future = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M2, paidCents: 100, paidAt: '2999-01-01' })
    expect(future.statusCode).toBe(422)
    // GS Foods is registered only with FBR and SRB (owner, 2026-10-15).
    for (const gone of ['pra', 'kpra', 'bra']) {
      expect((await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: gone, period: M1, paidCents: 100, paidAt: `${M2}-01`, bankAccountId: bankA })).statusCode).toBe(400)
    }
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('a closed date is refused and nothing is saved', async () => {
    await sale(tenantC, sdC, '2032', 700, at(`${M1}-05`))
    await prisma.periodLock.create({ data: { tenantId: tenantC, lockedThrough: M1_TO, lockedBy: staff['finC']!.id } })
    const res = await call('finC', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M1, paidCents: 700, paidAt: `${M1}-20` })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantC } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC, reference: { startsWith: 'salestax.payment:' } } })).toBe(0)
  })

  it('two companies: A\'s payment is absent from B\'s return and B cannot void it', async () => {
    await sale(tenantB, sdB, '2032', 2_000, at(`${M1}-10`))
    const rb = await salesTaxReturn(tenantB, M1_FROM, M1_TO)
    expect(rb.payments).toEqual([])
    expect(authorityOf(rb, 'SRB')).toMatchObject({ output: { totalCents: 2_000 }, paidForPeriodCents: 0, ledgerBalanceAtEndCents: 2_000 })
    const list = await call('adminB', 'GET', `/accounting/sales-tax-return/payments?dateFrom=${M1}-01&dateTo=${lastDay(M1)}`)
    expect(list.statusCode).toBe(200)
    expect(list.json().payments).toEqual([])
    const voidIt = await call('adminB', 'POST', `/accounting/sales-tax-return/payments/${srbPaymentId}/void`, { reason: 'not ours at all' })
    expect(voidIt.statusCode).toBe(404)
    // B's own payment binds to B, from B's bank.
    const own = await call('adminB', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M1, paidCents: 2_000, paidAt: `${M2}-01` })
    expect(own.statusCode).toBe(201)
    expect(own.json()).toMatchObject({ tenantId: tenantB, bankAccountId: bankB })
    expect((await salesTaxReturn(tenantA, M1_FROM, M1_TO)).payments.map((p) => p.id)).not.toContain(own.json().id)
  })

  it('void: a posted payment is reversed and can be recorded again; the output still does not move', async () => {
    const res = await call('finA', 'POST', `/accounting/sales-tax-return/payments/${srbPaymentId}/void`, { reason: 'wrong amount typed' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ reversed: true })
    const rev = (await entry(tenantA, `salestax.payment.reversal:${srbPaymentId}`))!
    expect(amt(rev, '2032', 'credit')).toBe(1_500)
    expect(amt(rev, '1020', 'debit')).toBe(1_500)
    const m2 = authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')!
    expect(m2.output.totalCents).toBe(900)
    expect(m2.ledgerBalanceAtEndCents).toBe(2_400)
    const again = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'srb', period: M1, paidCents: 1_500, paidAt: `${M2}-01`, bankAccountId: bankA })
    expect(again.statusCode).toBe(201)
    srbPaymentId = again.json().id
  })
})

// ─── Linking a payment posted by hand ────────────────────────────────────────

describe('a payment already posted by hand is linked, never posted twice', () => {
  let manualId: string

  it('links a manual entry: no second posting, left out of the month\'s output', async () => {
    // A Sindh brand's tax for this month, paid by a manual journal.
    await sale(tenantA, sdA, '2032', 800, at(`${M2}-01`))
    const charged = authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')!.output.totalCents
    const accounts = await prisma.account.findMany({ where: { tenantId: tenantA, code: { in: ['2032', '1020'] } }, select: { id: true, code: true } })
    const id = (code: string) => accounts.find((a) => a.code === code)!.id
    const manual = await call('adminA', 'POST', '/accounting/journal', {
      description: 'SRB paid', entryDate: at(`${M2}-01`).toISOString(),
      lines: [{ accountId: id('2032'), type: 'debit', amountCents: 800 }, { accountId: id('1020'), type: 'credit', amountCents: 800 }],
    })
    expect(manual.statusCode).toBe(201)
    manualId = manual.json().id
    expect(authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')!.output.totalCents).toBe(charged - 800) // before linking

    const cands = await call('finA', 'GET', '/accounting/sales-tax-return/payments/candidates?authority=srb')
    expect(cands.json().entries.map((e: { id: string }) => e.id)).toContain(manualId)

    const before = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: manualId, authority: 'srb', period: M2, cprNumber: 'SRB-2' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ tenantId: tenantA, linked: true, journalEntryId: manualId, paidCents: 800, outputSetOffCents: 800, bankAccountId: bankA })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(before)

    expect(authorityOf(await salesTaxReturn(tenantA, M2_FROM, M2_TO), 'SRB')).toMatchObject({ output: { totalCents: charged }, paidForPeriodCents: 800 })
  })

  it('the same entry twice, an entry that is not a manual / reconciliation one, or one that pays nothing, is refused', async () => {
    const twice = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: manualId, authority: 'srb', period: M2 })
    expect(twice.statusCode).toBe(409)
    const saleEntry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: { startsWith: 'test.sale:' } } })
    const notLinkable = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: saleEntry.id, authority: 'fbr', period: M2 })
    expect(notLinkable.statusCode).toBe(422)
    expect(notLinkable.json().error.code).toBe('NOT_LINKABLE')
    // An SRB payment linked as FBR: it never touches 2030.
    const wrongTax = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: manualId, authority: 'fbr', period: M2 })
    expect(wrongTax.statusCode).toBe(422)
    expect(wrongTax.json().error.code).toBe('NOT_A_TAX_PAYMENT')
  })

  it('another company cannot link A\'s entry (404)', async () => {
    const res = await call('adminB', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: manualId, authority: 'srb', period: M2 })
    expect(res.statusCode).toBe(404)
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantB, journalEntryId: manualId } })).toBe(0)
  })

  it('unlinking leaves the entry as it was posted', async () => {
    const row = await prisma.salesTaxPayment.findFirstOrThrow({ where: { tenantId: tenantA, journalEntryId: manualId } })
    const res = await call('finA', 'POST', `/accounting/sales-tax-return/payments/${row.id}/void`, { reason: 'linked to the wrong month' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ reversed: false })
    expect(await prisma.journalEntry.count({ where: { id: manualId } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: 'manual.reversal:' } } })).toBe(0)
  })
})

// ─── Reclass ──────────────────────────────────────────────────────────────────

describe('the 2030 reclass is first-class', () => {
  let orderId: string

  it('moves a Sindh brand\'s 2030 tax for the month to 2032, tagged, dated in the month; the return files the sale with SRB', async () => {
    // A pre-routing sale: its own entry credited 2030 for the Sindh brand.
    const order = await prisma.order.create({
      data: {
        conceptId: sdA, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 11_500, taxCents: 1_500, taxRatePct: 15,
        items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    orderId = order.id
    await prisma.payment.create({ data: { orderId, method: 'cash', amountCents: 11_500, status: 'paid', processedAt: new Date() } })
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'order.complete', sourceId: orderId, description: 'pre-routing sale', postedBy: 'test',
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 11_500 },
        { accountCode: '4090', type: 'credit', amountCents: 10_000, conceptId: sdA },
        { accountCode: '2030', type: 'credit', amountCents: 1_500, conceptId: sdA },
      ],
    })
    const before = await salesTaxReturn(tenantA, M2_FROM, M2_TO)
    expect(before.reclassification).toEqual([expect.objectContaining({ conceptId: sdA, fromAccount: '2030', toAccount: '2032', amountCents: 1_500 })])
    expect(before.byRate.find((r) => r.authority === 'FBR' && r.ratePct === 15)).toMatchObject({ orders: 1, salesTaxCents: 1_500 })

    // Not a provincial brand, two months at once, another company's brand.
    expect((await call('finA', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: fbrA, from: `${M2}-01`, to: TODAY })).json().error.code).toBe('NOT_PROVINCIAL')
    expect((await call('finA', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: sdA, from: `${M1}-01`, to: TODAY })).json().error.code).toBe('RECLASS_ONE_MONTH')
    expect((await call('adminB', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: sdA, from: `${M2}-01`, to: TODAY })).statusCode).toBe(404)

    const res = await call('finA', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: sdA, from: `${M2}-01`, to: TODAY })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ posted: true, amountCents: 1_500, month: M2, reference: `salestax.reclass:${sdA}:${M2}` })
    const je = (await entry(tenantA, `salestax.reclass:${sdA}:${M2}`))!
    expect(je).toEqual(expect.arrayContaining([
      { code: '2030', type: 'debit', amount: 1_500, conceptId: sdA },
      { code: '2032', type: 'credit', amount: 1_500, conceptId: sdA },
    ]))
    expect(pktIso(je.entryDate!).slice(0, 7)).toBe(M2)

    const after = await salesTaxReturn(tenantA, M2_FROM, M2_TO)
    expect(after.reclassification).toEqual([])
    expect(after.reclassesPosted).toEqual([expect.objectContaining({ conceptId: sdA, month: M2, toAccount: '2032', amountCents: 1_500 })])
    expect(after.byRate.find((r) => r.authority === 'FBR' && r.ratePct === 15)).toBeUndefined()
    expect(after.byRate.find((r) => r.authority === 'SRB' && r.ratePct === 15)).toMatchObject({ orders: 1, salesTaxCents: 1_500 })
    expect(authorityOf(after, 'SRB')!.otherOutputCents).toBe(before.byAuthority.find((a) => a.authority === 'SRB')!.otherOutputCents)
    expect(authorityOf(after, 'FBR')?.otherOutputCents ?? 0).toBe(0)
  })

  it('a second reclass is a no-op', async () => {
    const res = await call('finA', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: sdA, from: `${M2}-01`, to: TODAY })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ posted: false, amountCents: 0 })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { startsWith: `salestax.reclass:${sdA}:` } } })).toBe(1)
  })

  it('a refund after the reclass debits 2032', async () => {
    const p = await prisma.payment.create({
      data: { orderId, method: 'cash', amountCents: -5_750, status: 'refunded', processedAt: new Date() },
    })
    expect((await postRefundPayment(p.id)).posted).toBe(true)
    const refund = (await entry(tenantA, `order.refund:${p.id}`))!
    expect(amt(refund, '2032', 'debit')).toBe(750)
    expect(amt(refund, '2030', 'debit')).toBe(0)
  })

  it('a closed month is refused (422) and nothing is posted', async () => {
    // C: Sindh tax in 2030 in M1, books closed through M1 (previous describe).
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantC } })
    await post(tenantC, at(`${M1}-06`), [{ accountCode: '1010', type: 'debit', amountCents: 600 }, { accountCode: '2030', type: 'credit', amountCents: 600, conceptId: sdC }])
    await prisma.periodLock.create({ data: { tenantId: tenantC, lockedThrough: M1_TO, lockedBy: staff['finC']!.id } })
    const res = await call('finC', 'POST', '/accounting/sales-tax-return/reclass', { conceptId: sdC, from: `${M1}-01`, to: lastDay(M1) })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC, reference: { startsWith: 'salestax.reclass:' } } })).toBe(0)
  })
})

// ─── Extra findings ──────────────────────────────────────────────────────────

describe('what the return declares', () => {
  it('a brand deactivated mid-period stays in "Taxable sales by brand"', async () => {
    const closed = await brand(tenantE, 'E Closed', 'SD')
    await sale(tenantE, closed, '2032', 1_000, at(`${M1}-03`))
    await prisma.concept.update({ where: { id: closed }, data: { isActive: false } })
    const r = await salesTaxReturn(tenantE, M1_FROM, M1_TO)
    expect(r.taxableValueByConceptCents).toEqual([expect.objectContaining({ conceptName: 'E Closed', revenueCents: 9_000 })])
    expect(r.taxableSalesCents).toBe(9_000)
  })

  it('zero-rated and exempt lines are declared at 0% on their own rows, not as standard-rated value', async () => {
    const cat = await prisma.category.create({ data: { conceptId: sdD, name: 'Menu' } })
    const item = (name: string, taxClassification: 'standard' | 'zero_rated' | 'exempt') =>
      prisma.menuItem.create({ data: { conceptId: sdD, categoryId: cat.id, name, priceCents: 1, taxClassification } })
    const [std, zero, exempt] = [await item('Burger', 'standard'), await item('Milk', 'zero_rated'), await item('Bread', 'exempt')]
    const order = await prisma.order.create({
      data: {
        conceptId: sdD, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 165_000, taxCents: 15_000, taxRatePct: 15,
        items: {
          create: [
            { name: 'Burger', quantity: 1, unitPriceCents: 100_000, menuItemId: std.id },
            { name: 'Milk', quantity: 2, unitPriceCents: 10_000, menuItemId: zero.id },
            { name: 'Bread', quantity: 1, unitPriceCents: 30_000, menuItemId: exempt.id },
          ],
        },
      },
    })
    await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: 165_000, status: 'pending' } })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const refund = await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: -82_500, status: 'refunded', processedAt: new Date() } })
    expect((await postRefundPayment(refund.id)).posted).toBe(true)

    const r = await salesTaxReturn(tenantD, M2_FROM, M2_TO)
    const srb = r.byRate.filter((x) => x.authority === 'SRB')
    expect(srb.find((x) => x.supply === 'standard')).toMatchObject({ ratePct: 15, salesValueCents: 100_000, salesTaxCents: 15_000, refundTaxCents: 7_500, refundValueCents: 50_000, taxCents: 7_500, taxableValueCents: 50_000 })
    expect(srb.find((x) => x.supply === 'zero_rated')).toMatchObject({ ratePct: 0, salesValueCents: 20_000, salesTaxCents: 0, refundValueCents: 10_000, taxCents: 0, taxableValueCents: 10_000 })
    expect(srb.find((x) => x.supply === 'exempt')).toMatchObject({ ratePct: 0, salesValueCents: 30_000, salesTaxCents: 0, refundValueCents: 15_000, taxCents: 0 })
    expect(srb.reduce((t, x) => t + x.taxCents, 0)).toBe(authorityOf(r, 'SRB')!.output.totalCents)
    expect(authorityOf(r, 'SRB')!.otherOutputCents).toBe(0)
  })

  it('the CSV carries what was paid and what is still owed', async () => {
    const res = await call('finA', 'GET', `/accounting/sales-tax-return?dateFrom=${M1}-01&dateTo=${lastDay(M1)}&format=csv`)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('Paid — SRB')
    expect(res.body).toContain('Ledger balance at period end')
    expect(res.body).toContain('Withholding — WHT')
    expect(res.body).toMatch(/Payments,SRB,/)
  })
})
