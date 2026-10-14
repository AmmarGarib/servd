// Sales tax a client withholds when paying our invoice (wave B, H13 → 1335).
//
//   POST /accounting/receivables/:id/withholding { kind: 'sales_tax', … }
//     → ReceivablePayment method 'st_withheld' (never 'stwh' — that is OUR
//       withholding as an agent, 2041) with taxAuthority = the authority whose
//       output account the invoice's own entry credited;
//     → 'receivable.st_withheld:<paymentId>' Dr 1335 / Cr 1110 (the 1110 line
//       carries the invoice's brand), in the invoice-locked transaction.
//   Caps: 409 OVER_SALES_TAX_WITHHOLDING above tax − credited tax − live
//   st_withheld rows; 409 OVER_WITHHOLDING above the balance; 422 NO_OUTPUT_TAX
//   on an invoice with no tax; 1335 inactive → 422 with nothing saved.
//   Reversal through the existing reverse route. kind 'income_tax' (the
//   default) is unchanged. Company B gets 404.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
// The PKT calendar day — the date a person in Karachi types (5 h ahead of UTC).
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptSD: string, conceptPB: string, conceptB: string
const staff: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@stwh.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
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
async function netDebit(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}

async function raise(who: string, extra: Record<string, unknown> = {}) {
  const res = await call(who, 'POST', AR, {
    customerName: `Bank client ${RUN}`, issueDate: today(), dueDate: '2099-12-31', description: 'Staff lunches',
    amountCents: 100_000, taxCents: 16_000, conceptId: conceptSD, ...extra,
  })
  expect(res.statusCode, res.body).toBe(201)
  return res.json() as { id: string; number: string }
}
const inv = (id: string) => prisma.receivableInvoice.findUniqueOrThrow({ where: { id } })
const withhold = (who: string, id: string, body: Record<string, unknown>) =>
  call(who, 'POST', `${AR}/${id}/withholding`, { date: today(), ...body })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'STWH A', slug: `stwh-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'STWH B', slug: `stwh-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptSD = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: `stwh-sd-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 16, taxRateCard: 8 } })).id
  conceptPB = (await prisma.concept.create({ data: { name: 'Lahore kitchen', slug: `stwh-pb-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'PB', taxRateCash: 16, taxRateCard: 5 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other co', slug: `stwh-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('admB', 'admin', tenantB)

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

describe('sales tax the client withheld (H13)', () => {
  it('100,000 + 16,000 SRB invoice, the client withholds 3,200: Dr 1335 / Cr 1110, the balance goes down', async () => {
    const i = await raise('finA')
    expect(amt((await entry(tenantA, `receivable.issue:${i.id}`))!, '2032', 'credit')).toBe(16_000)
    const res = await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 3_200, certificateNo: 'SRB-WH-1' })
    expect(res.statusCode, res.body).toBe(201)
    const row = res.json() as { id: string; method: string; taxAuthority: string; reference: string }
    expect(row).toMatchObject({ method: 'st_withheld', taxAuthority: 'srb', reference: 'SRB-WH-1' })
    const lines = (await entry(tenantA, `receivable.st_withheld:${row.id}`))!
    expect(lines).toHaveLength(2)
    expect(amt(lines, '1335', 'debit')).toBe(3_200)
    expect(lines.find((l) => l.code === '1110')).toMatchObject({ type: 'credit', amount: 3_200, conceptId: conceptSD })
    expect(await entry(tenantA, `receivable.wht:${row.id}`)).toBeNull()
    const after = await inv(i.id)
    expect(Number(after.whtCents)).toBe(3_200)
    expect(after.status).toBe('partial')
    const list = (await call('finA', 'GET', `${AR}?status=outstanding`)).json() as { invoices: Array<{ id: string; balanceCents: number; payments: Array<{ id: string; kind: string; method: string }> }> }
    const listed = list.invoices.find((x) => x.id === i.id)!
    expect(listed.balanceCents).toBe(112_800)
    expect(listed.payments.find((p) => p.id === row.id)).toMatchObject({ kind: 'withholding', method: 'st_withheld' })

    // The client pays the rest; the invoice is settled.
    const pay = await call('finA', 'POST', `${AR}/${i.id}/payments`, { amountCents: 112_800, receivedAt: today(), method: 'cash' })
    expect(pay.statusCode, pay.body).toBe(201)
    expect((await inv(i.id)).status).toBe('paid')
  })

  it('never more than the tax left (credit notes and earlier withholding count), nor more than is due', async () => {
    const i = await raise('finA')
    expect((await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 3_200 })).statusCode).toBe(201)
    const over = await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 12_801 })
    expect(over.statusCode).toBe(409)
    expect(over.json().error).toMatchObject({ code: 'OVER_SALES_TAX_WITHHOLDING' })
    // A credit note takes 2,000 of the tax: 10,800 left.
    expect((await call('finA', 'POST', `${AR}/${i.id}/credit-notes`, { amountCents: 0, taxCents: 2_000, reason: 'tax rate corrected', date: today() })).statusCode).toBe(201)
    expect((await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 10_801 })).json().error.code).toBe('OVER_SALES_TAX_WITHHOLDING')
    expect((await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 10_800 })).statusCode).toBe(201)
    expect(Number((await inv(i.id)).whtCents)).toBe(14_000)

    // Within the tax, but more than is still due.
    const j = await raise('finA')
    expect((await call('finA', 'POST', `${AR}/${j.id}/payments`, { amountCents: 115_000, receivedAt: today(), method: 'cash' })).statusCode).toBe(201)
    const due = await withhold('finA', j.id, { kind: 'sales_tax', amountCents: 2_000 })
    expect(due.statusCode).toBe(409)
    expect(due.json().error.code).toBe('OVER_WITHHOLDING')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: j.id, method: 'st_withheld' } })).toBe(0)
  })

  it('an invoice with no output tax cannot have sales tax withheld (422); income tax still works as before', async () => {
    const i = await raise('finA', { taxCents: 0 })
    const res = await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 1_000 })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('NO_OUTPUT_TAX')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)

    // kind omitted = income tax (s.153), Dr 1330 — today's behaviour.
    const it2 = await withhold('finA', i.id, { amountCents: 4_000, certificateNo: 'FBR-153' })
    expect(it2.statusCode, it2.body).toBe(201)
    expect(it2.json()).toMatchObject({ method: 'wht', taxAuthority: null })
    expect(amt((await entry(tenantA, `receivable.wht:${it2.json().id}`))!, '1330', 'debit')).toBe(4_000)
    expect((await withhold('finA', i.id, { kind: 'vat', amountCents: 1_000 })).statusCode).toBe(400)
  })

  it('the authority is the one the invoice\'s tax was credited to (PRA for a Punjab brand)', async () => {
    const i = await raise('finA', { conceptId: conceptPB })
    expect(amt((await entry(tenantA, `receivable.issue:${i.id}`))!, '2031', 'credit')).toBe(16_000)
    const res = await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 1_600 })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().taxAuthority).toBe('pra')
  })

  it('1335 switched off in the chart: 422 and nothing saved', async () => {
    const i = await raise('finA')
    await prisma.account.updateMany({ where: { tenantId: tenantA, code: '1335' }, data: { isActive: false } })
    try {
      const res = await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 1_000 })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('ACCOUNT_INACTIVE')
      expect(await prisma.receivablePayment.count({ where: { invoiceId: i.id } })).toBe(0)
      expect(Number((await inv(i.id)).whtCents)).toBe(0)
    } finally {
      await prisma.account.updateMany({ where: { tenantId: tenantA, code: '1335' }, data: { isActive: true } })
    }
  })

  it('a withdrawn certificate is reversed: Dr 1110 / Cr 1335, the invoice owes it again, and the tax can be withheld again', async () => {
    const i = await raise('finA')
    const w = (await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 16_000 })).json() as { id: string }
    expect((await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 1 })).statusCode).toBe(409)
    const rev = await call('finA', 'POST', `${AR}/${i.id}/payments/${w.id}/reverse`, { reason: 'certificate withdrawn' })
    expect(rev.statusCode, rev.body).toBe(200)
    expect(rev.json()).toMatchObject({ kind: 'withholding', alreadyReversed: false })
    const lines = (await entry(tenantA, `receivable.st_withheld.reversal:${w.id}`))!
    expect(amt(lines, '1110', 'debit')).toBe(16_000)
    expect(amt(lines, '1335', 'credit')).toBe(16_000)
    expect(Number((await inv(i.id)).whtCents)).toBe(0)
    expect((await inv(i.id)).status).toBe('open')
    // Reversed rows no longer count against the cap.
    expect((await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 16_000 })).statusCode).toBe(201)
    expect((await call('finA', 'POST', `${AR}/${i.id}/payments/${w.id}/reverse`, { reason: 'certificate withdrawn' })).json().alreadyReversed).toBe(true)
  })

  it('company B gets 404 on A\'s invoice', async () => {
    const i = await raise('finA')
    const res = await withhold('admB', i.id, { kind: 'sales_tax', amountCents: 1_000 })
    expect(res.statusCode).toBe(404)
    expect(Number((await inv(i.id)).whtCents)).toBe(0)
    const w = (await withhold('finA', i.id, { kind: 'sales_tax', amountCents: 1_000 })).json() as { id: string }
    expect((await call('admB', 'POST', `${AR}/${i.id}/payments/${w.id}/reverse`, { reason: 'not mine' })).statusCode).toBe(404)
    // B's own SRB invoice books into B's 1335.
    const b = await raise('admB', { conceptId: conceptB })
    const bw = await withhold('admB', b.id, { kind: 'sales_tax', amountCents: 500 })
    expect(bw.statusCode, bw.body).toBe(201)
    expect(amt((await entry(tenantB, `receivable.st_withheld:${bw.json().id}`))!, '1335', 'debit')).toBe(500)
  })

  it('the AR subledger ties to 1110, and 1335 holds exactly the live sales-tax withholding', async () => {
    const list = (await call('finA', 'GET', AR)).json() as { invoices: Array<{ kind: string; balanceCents: number }> }
    const sum = list.invoices.filter((r) => r.kind === 'invoice').reduce((t, r) => t + r.balanceCents, 0)
    expect(await netDebit(tenantA, '1110')).toBe(sum)
    const live = await prisma.receivablePayment.aggregate({ where: { tenantId: tenantA, method: 'st_withheld', reversedAt: null }, _sum: { amountCents: true } })
    expect(await netDebit(tenantA, '1335')).toBe(Number(live._sum.amountCents ?? 0))
  })
})
