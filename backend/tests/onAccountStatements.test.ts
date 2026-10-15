// On-account statements (receivables/statements.ts) and the receivables routes
// that settle them (receivables/routes.ts). Resumed 2026-10-15.
//
//   - A statement claims exactly the BOOKED, unbilled charges up to periodTo,
//     leaves a charge whose drawer is still open unbilled, and posts nothing.
//   - A second statement for the same client and period is 409
//     STATEMENT_EXISTS; nothing to bill is 409 NOTHING_TO_BILL; bulk issue
//     (ACTIVE company only) skips both.
//   - A payment posts Dr cash / Cr 1110 in the statement's company; a credit
//     note is 409 STATEMENT_CREDIT_AT_TILL; a till refund after billing lowers
//     the balance; void releases the charges and reverses nothing.
//   - The HTML is headed "Statement — not a tax invoice" and lists fiscal
//     numbers; send is 422 NO_EMAIL without an address.
//   - Sales tax withheld on a statement: one authority works, FBR + SRB mixed
//     is 422 STATEMENT_MIXED_AUTHORITY.
//   - Company B gets 404 on A's statement (html, send, void, issue).
//   - An invoice naming a client of another company is 422 CLIENT_NOT_IN_COMPANY.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

const sendMail = vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: 'test' }))
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))
process.env.SMTP_USER = process.env.SMTP_USER || 'test-user'
process.env.SMTP_PASS = process.env.SMTP_PASS || 'test-pass'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { customerAccountRoutes } = await import('../src/modules/receivables/customerAccounts.js')
const { receivableRoutes } = await import('../src/modules/receivables/routes.js')
const { applyChargeRefundTx } = await import('../src/modules/receivables/onAccount.js')
const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
const { orderRefOf } = await import('../src/lib/orderRef.js')

const RUN = Math.random().toString(36).slice(2, 8)
const CA = '/accounting/customer-accounts'
const AR = '/accounting/receivables'
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
const yesterday = () => new Date(Date.now() + 5 * 3_600_000 - 86_400_000).toISOString().slice(0, 10)
const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000)

let app: FastifyInstance
let tA: string, tB: string
let brandSD: string, brandICT: string, brandB: string
const token: Record<string, string> = {}
const uid: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@oastmt.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  token[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  uid[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token[who]}` } })

let clientSeq = 0
async function mkClient(tenantId: string, extra: Record<string, unknown> = {}) {
  const n = ++clientSeq
  return prisma.customerAccount.create({
    data: {
      tenantId, number: `OA-${String(n).padStart(4, '0')}`, legalName: `Client ${n} ${RUN}`, ntn: `NTN-${n}`,
      creditLimitCents: 10_000_000, termsDays: 15, status: 'active', createdById: uid.finA!, ...extra,
    },
  })
}

let orderSeq = 0
/**
 * An on-account bill: an order + its payment + the charge. `booked` posts the
 * sale's entry (Dr 1110 / Cr revenue / Cr the brand's output tax): an online
 * order on 'order.complete:<orderId>', a till order on its drawer's close.
 */
async function charge(
  accountId: string, tenantId: string, conceptId: string, amountCents: number, taxCents: number,
  opts: { booked?: boolean; shiftId?: string; chargedAt?: Date } = {},
) {
  const pos = !!opts.shiftId
  const order = await prisma.order.create({
    data: { conceptId, source: pos ? 'pos' : 'servd', status: 'completed', totalCents: amountCents, placedAt: new Date(), externalId: `st-${RUN}-${++orderSeq}` },
  })
  const payment = await prisma.payment.create({
    data: { orderId: order.id, method: 'on_account', amountCents, status: 'paid', shiftId: opts.shiftId ?? null },
  })
  const c = await prisma.customerAccountCharge.create({
    data: { tenantId, accountId, orderId: order.id, paymentId: payment.id, conceptId, amountCents, taxCents, chargedById: uid.finA!, chargedAt: opts.chargedAt ?? new Date() },
  })
  if (opts.booked !== false && !pos) await book(tenantId, 'order.complete', order.id, conceptId, amountCents, taxCents)
  return c
}
async function book(tenantId: string, sourceType: string, sourceId: string, conceptId: string, amountCents: number, taxCents: number) {
  const brand = await prisma.concept.findUniqueOrThrow({ where: { id: conceptId }, select: { province: true } })
  await postJournalEntry({
    tenantId, sourceType, sourceId, description: `test sale ${sourceId}`, postedBy: 'system',
    lines: [
      { accountCode: '1110', type: 'debit', amountCents, conceptId },
      { accountCode: '4090', type: 'credit', amountCents: amountCents - taxCents, conceptId },
      { accountCode: brand.province === 'SD' ? '2032' : '2030', type: 'credit', amountCents: taxCents, conceptId },
    ],
  })
}
const entriesOf = (tenantId: string) => prisma.journalEntry.count({ where: { tenantId } })
async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) }))
}

type Statement = {
  id: string; tenantId: string; kind: string; number: string; status: string; customerAccountId: string; customerName: string
  customerNtn: string | null; conceptId: string | null; amountCents: number; taxCents: number; totalCents: number; balanceCents: number
  periodFromDay: string; periodToDay: string; dueDate: string; issueDate: string; chargeCount: number; notBookedCount: number
}
async function issue(who: string, accountId: string, body: Record<string, unknown> = {}) {
  return call(who, 'POST', `${CA}/${accountId}/statements`, { periodTo: today(), ...body })
}

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'Statement Co A', slug: `st-a-${RUN}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'Statement Co B', slug: `st-b-${RUN}` } })).id
  for (const t of [tA, tB]) await ensureChartOfAccounts(t)
  brandSD = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: `st-sd-${RUN}`, type: 'restaurant', tenantId: tA, province: 'SD', email: 'accounts@kitchen-a.test' } })).id
  brandICT = (await prisma.concept.create({ data: { name: 'Islamabad kitchen', slug: `st-ict-${RUN}`, type: 'restaurant', tenantId: tA, province: 'ICT' } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Kitchen B', slug: `st-b-${RUN}`, type: 'restaurant', tenantId: tB, province: 'SD' } })).id
  await mkStaff('finA', 'finance', tA)
  await mkStaff('finB', 'finance', tB)
  await mkStaff('fnbA', 'fnb_manager', tA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(customerAccountRoutes, { prefix: CA })
  await app.register(receivableRoutes, { prefix: AR })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('issuing a statement', () => {
  let client: Awaited<ReturnType<typeof mkClient>>
  let st: Statement
  let c1: { id: string; orderId: string }, c2: { id: string; orderId: string }, open: { id: string; orderId: string }
  let shiftId: string

  it('claims exactly the booked charges, leaves an open drawer\'s charge unbilled and posts nothing', async () => {
    client = await mkClient(tA, { contactEmail: 'ap@client.test' })
    c1 = await charge(client.id, tA, brandSD, 11_600, 1_600, { chargedAt: twoDaysAgo })
    c2 = await charge(client.id, tA, brandSD, 5_800, 800, { chargedAt: twoDaysAgo })
    shiftId = (await prisma.shift.create({ data: { userId: uid.finA!, tenantId: tA } })).id
    open = await charge(client.id, tA, brandSD, 2_320, 320, { shiftId, chargedAt: twoDaysAgo })
    // Today's bill is after the period: not on this statement.
    await charge(client.id, tA, brandSD, 1_160, 160)
    // A fiscal number for the first bill (shown on the statement).
    await prisma.fiscalDocument.create({
      data: {
        tenantId: tA, kind: 'sale', orderId: c1.orderId, conceptId: brandSD, idempotencyKey: `sale:${c1.orderId}`,
        payload: {}, payloadHash: 'x', amountCents: 11_600, status: 'filed', fiscalNumber: `SRB-FN-${RUN}`,
      },
    })

    const before = await entriesOf(tA)
    const res = await issue('finA', client.id, { periodTo: yesterday() })
    expect(res.statusCode, res.body).toBe(201)
    st = res.json() as Statement
    expect(st).toMatchObject({
      tenantId: tA, kind: 'statement', status: 'open', customerAccountId: client.id, customerName: client.legalName,
      customerNtn: client.ntn, conceptId: brandSD, totalCents: 17_400, taxCents: 2_400, amountCents: 15_000,
      balanceCents: 17_400, periodToDay: yesterday(), chargeCount: 2, notBookedCount: 1,
    })
    expect(st.number).toMatch(/^AR-ST-\d{4}-0001$/)
    // Due = issue date + the client's 15 terms days.
    expect(Date.parse(st.dueDate) - Date.parse(st.issueDate)).toBe(15 * 86_400_000)
    // Nothing posted.
    expect(await entriesOf(tA)).toBe(before)
    expect(await prisma.journalEntry.count({ where: { reference: { contains: st.id } } })).toBe(0)
    const rows = await prisma.customerAccountCharge.findMany({ where: { id: { in: [c1.id, c2.id, open.id] } } })
    expect(rows.find((r) => r.id === c1.id)!.statementInvoiceId).toBe(st.id)
    expect(rows.find((r) => r.id === c2.id)!.statementInvoiceId).toBe(st.id)
    expect(rows.find((r) => r.id === open.id)!.statementInvoiceId).toBeNull()
  })

  it('a second statement for the same period is 409 STATEMENT_EXISTS; nothing booked is 409 NOTHING_TO_BILL', async () => {
    const again = await issue('finA', client.id, { periodTo: yesterday() })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('STATEMENT_EXISTS')
    const empty = await mkClient(tA)
    const none = await issue('finA', empty.id)
    expect(none.statusCode).toBe(409)
    expect(none.json().error.code).toBe('NOTHING_TO_BILL')
    // A period ending after the issue date is refused.
    expect((await issue('finA', empty.id, { periodTo: '2099-01-01' })).statusCode).toBe(422)
  })

  it('the open drawer\'s charge goes on the next statement once the drawer closes', async () => {
    await book(tA, 'shift.close', shiftId, brandSD, 2_320, 320)
    const res = await issue('finA', client.id)
    expect(res.statusCode, res.body).toBe(201)
    const next = res.json() as Statement
    expect(next.number).toMatch(/^AR-ST-\d{4}-0002$/)
    // The late-booked bill (two days ago) + today's bill.
    expect(next).toMatchObject({ totalCents: 3_480, taxCents: 480, chargeCount: 2, notBookedCount: 0, periodToDay: today() })
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: open.id } })).statementInvoiceId).toBe(next.id)
    // The HTML of the second statement shows the first one's balance as the previous balance.
    const html = (await call('finA', 'GET', `${CA}/statements/${next.id}/html`)).body
    expect(html).toMatch(/Previous balance<\/td><td[^>]*>PKR 174\.00/)
  })

  it('the HTML is headed "Statement — not a tax invoice" and lists fiscal numbers', async () => {
    const res = await call('finA', 'GET', `${CA}/statements/${st.id}/html`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    const html = res.body
    expect(html).toContain('Statement — not a tax invoice')
    expect(html).toContain(`SRB-FN-${RUN}`)
    expect(html).toContain(orderRefOf(c1.orderId))
    expect(html).toContain(orderRefOf(c2.orderId))
    expect(html).not.toContain(orderRefOf(open.orderId))
    expect(html).toContain('Karachi kitchen')
    expect(html).toContain(st.number)
    // fnb_manager is not a client viewer.
    expect((await call('fnbA', 'GET', `${CA}/statements/${st.id}/html`)).statusCode).toBe(403)
  })

  it('sends by email (audited); 422 NO_EMAIL without an address', async () => {
    sendMail.mockClear()
    const res = await call('finA', 'POST', `${CA}/statements/${st.id}/send`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ sent: true, to: 'ap@client.test' })
    expect(sendMail).toHaveBeenCalledTimes(1)
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ to: 'ap@client.test', replyTo: 'accounts@kitchen-a.test' })
    expect(await prisma.auditLog.count({ where: { action: 'on_account.statement.send', entityId: st.id, tenantId: tA } })).toBe(1)

    const noMail = await mkClient(tA)
    await charge(noMail.id, tA, brandSD, 1_160, 160)
    const s2 = (await issue('finA', noMail.id)).json() as Statement
    const r = await call('finA', 'POST', `${CA}/statements/${s2.id}/send`, {})
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NO_EMAIL')
  })

  it('company B gets 404 on A\'s statement: html, send, void, issue', async () => {
    expect((await call('finB', 'GET', `${CA}/statements/${st.id}/html`)).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${CA}/statements/${st.id}/send`, {})).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${AR}/${st.id}/void`, { reason: 'not mine' })).statusCode).toBe(404)
    expect((await call('finB', 'POST', `${AR}/${st.id}/payments`, { amountCents: 100, receivedAt: today(), method: 'cash', reference: 'x' })).statusCode).toBe(404)
    expect((await issue('finB', client.id)).statusCode).toBe(404)
    // B's receivables list never shows it.
    const list = (await call('finB', 'GET', AR)).json() as { invoices: Array<{ id: string }> }
    expect(list.invoices.some((i) => i.id === st.id)).toBe(false)
  })

  it('a till refund after billing lowers the balance', async () => {
    const refund = await prisma.payment.create({ data: { orderId: c2.orderId, method: 'on_account', amountCents: -1_000, status: 'refunded' } })
    const applied = await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c2.orderId, refundPaymentId: refund.id, amountCents: 1_000 }))
    expect(applied).toMatchObject({ appliedCents: 1_000, statementInvoiceId: st.id })
    const list = (await call('finA', 'GET', `${AR}?status=outstanding`)).json() as {
      invoices: Array<{ id: string; balanceCents: number; kind: string; statementPeriod: { from: string; to: string } | null }>
    }
    const row = list.invoices.find((i) => i.id === st.id)!
    expect(row.kind).toBe('statement')
    expect(row.balanceCents).toBe(16_400)
    expect(row.statementPeriod).toEqual({ from: st.periodFromDay, to: yesterday() })
  })

  it('a payment posts Dr cash / Cr 1110 in A; a credit note is 409; void is refused once paid', async () => {
    const res = await call('finA', 'POST', `${AR}/${st.id}/payments`, { amountCents: 6_400, receivedAt: today(), method: 'cash', reference: `CR-${RUN}` })
    expect(res.statusCode, res.body).toBe(201)
    const lines = (await entry(tA, `receivable.payment:${res.json().id}`))!
    expect(lines).toEqual(expect.arrayContaining([
      { code: '1010', type: 'debit', amount: 6_400 },
      { code: '1110', type: 'credit', amount: 6_400 },
    ]))
    const inv = await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.id } })
    expect(inv.status).toBe('partial')

    const cn = await call('finA', 'POST', `${AR}/${st.id}/credit-notes`, { amountCents: 100, reason: 'price dispute', date: today() })
    expect(cn.statusCode).toBe(409)
    expect(cn.json().error.code).toBe('STATEMENT_CREDIT_AT_TILL')

    const v = await call('finA', 'POST', `${AR}/${st.id}/void`, { reason: 'raised in error' })
    expect(v.statusCode).toBe(409)
    expect(v.json().error.code).toBe('CANNOT_VOID')
  })
})

describe('void, bulk issue, withholding and invoices naming a client', () => {
  it('void releases the charges, reverses nothing, and the period can be billed again', async () => {
    const client = await mkClient(tA)
    const c = await charge(client.id, tA, brandSD, 3_480, 480)
    const st = (await issue('finA', client.id)).json() as Statement
    const before = await entriesOf(tA)
    const v = await call('finA', 'POST', `${AR}/${st.id}/void`, { reason: 'wrong period' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json()).toMatchObject({ ok: true, chargesReleased: 1 })
    expect(await entriesOf(tA)).toBe(before)
    expect((await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.id } })).status).toBe('void')
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: c.id } })).statementInvoiceId).toBeNull()
    const again = await issue('finA', client.id)
    expect(again.statusCode, again.body).toBe(201)
    expect((again.json() as Statement).totalCents).toBe(3_480)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: c.id } })).statementInvoiceId).toBe(again.json().id)
  })

  it('bulk issue bills the active company only and skips clients with nothing to bill', async () => {
    const withBills = await mkClient(tA)
    await charge(withBills.id, tA, brandSD, 2_320, 320)
    const nothing = await mkClient(tA)
    const clientB = await mkClient(tB, { createdById: uid.finB! })
    await charge(clientB.id, tB, brandB, 2_320, 320)

    const res = await call('finA', 'POST', `${CA}/statements/issue`, { periodTo: today() })
    expect(res.statusCode, res.body).toBe(200)
    const out = res.json() as { created: Array<{ accountId: string; totalCents: number }>; skipped: Array<{ accountId: string; code: string }> }
    expect(out.created.find((c) => c.accountId === withBills.id)?.totalCents).toBe(2_320)
    expect(out.skipped.find((s) => s.accountId === nothing.id)?.code).toBe('NOTHING_TO_BILL')
    expect([...out.created, ...out.skipped].some((r) => r.accountId === clientB.id)).toBe(false)
    // Every created statement is A's.
    const made = await prisma.receivableInvoice.findMany({ where: { id: { in: out.created.map((c) => (c as unknown as { invoiceId: string }).invoiceId) } } })
    expect(made.every((m) => m.tenantId === tA && m.kind === 'statement')).toBe(true)
    // Naming B's client is 404; a second bulk run skips with STATEMENT_EXISTS.
    expect((await call('finA', 'POST', `${CA}/statements/issue`, { periodTo: today(), accountIds: [clientB.id] })).statusCode).toBe(404)
    const twice = (await call('finA', 'POST', `${CA}/statements/issue`, { periodTo: today(), accountIds: [withBills.id] })).json() as typeof out
    expect(twice.created).toHaveLength(0)
    expect(twice.skipped[0]).toMatchObject({ accountId: withBills.id, code: 'STATEMENT_EXISTS' })
  })

  it('sales tax withheld: one authority works (SRB), FBR + SRB on one statement is 422', async () => {
    const one = await mkClient(tA)
    await charge(one.id, tA, brandSD, 11_600, 1_600)
    const st = (await issue('finA', one.id)).json() as Statement
    const w = await call('finA', 'POST', `${AR}/${st.id}/withholding`, { kind: 'sales_tax', amountCents: 320, date: today(), certificateNo: 'SRB-1' })
    expect(w.statusCode, w.body).toBe(201)
    expect(w.json()).toMatchObject({ method: 'st_withheld', taxAuthority: 'srb' })
    expect(await entry(tA, `receivable.st_withheld:${w.json().id}`)).toEqual(expect.arrayContaining([
      { code: '1335', type: 'debit', amount: 320 },
      { code: '1110', type: 'credit', amount: 320 },
    ]))
    // Income-tax withholding is unchanged on a statement.
    expect((await call('finA', 'POST', `${AR}/${st.id}/withholding`, { amountCents: 100, date: today() })).statusCode).toBe(201)

    const mixed = await mkClient(tA)
    await charge(mixed.id, tA, brandSD, 11_600, 1_600)
    await charge(mixed.id, tA, brandICT, 11_600, 1_600)
    const ms = (await issue('finA', mixed.id)).json() as Statement
    expect(ms.conceptId).toBeNull()
    const bad = await call('finA', 'POST', `${AR}/${ms.id}/withholding`, { kind: 'sales_tax', amountCents: 320, date: today() })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('STATEMENT_MIXED_AUTHORITY')
    expect(await prisma.receivablePayment.count({ where: { invoiceId: ms.id } })).toBe(0)
  })

  it('an invoice may name a client of the ACTIVE company only; its name and NTN are copied', async () => {
    const a = await mkClient(tA)
    const b = await mkClient(tB, { createdById: uid.finB! })
    const body = { issueDate: today(), dueDate: '2099-12-31', description: 'Event catering', amountCents: 50_000 }
    const foreign = await call('finA', 'POST', AR, { ...body, customerAccountId: b.id })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('CLIENT_NOT_IN_COMPANY')
    const ok = await call('finA', 'POST', AR, { ...body, customerName: 'ignored', customerAccountId: a.id })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json()).toMatchObject({ tenantId: tA, kind: 'invoice', customerAccountId: a.id, customerName: a.legalName, customerNtn: a.ntn })
    // No client and no name is refused.
    expect((await call('finA', 'POST', AR, body)).statusCode).toBe(400)
  })
})
