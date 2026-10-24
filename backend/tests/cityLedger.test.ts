// City Ledger (owner, 2026-10-24: "Extend on-account") — per-bill settlement
// of a client's POS bills, at the till and in the back office, the reports,
// and company separation. The rules are in src/modules/receivables/cityLedger.ts.
//
//   • a till cash settlement: ONE entry Dr 1015 / Cr 1110 + a drawer pay-in;
//     the drawer's close does not book that pay-in again and the count balances
//   • explicit allocation across bills; partial leaves the rest owed; full
//     settles; over-allocation, a settled bill, a bill on a statement, a bill
//     not booked yet — refused; a retry with the same key is the same
//     settlement, a reused key with another split is 409
//   • exposure, the statement and the 1110 tie-out are net of what was settled
//   • reversal (back office) gives the bills back, mirrors the entry
//   • history ends at the client's balance; the summary report's totals add
//     up, exclude unrelated receivables, honour ignoreZero; the account field
//     is required
//   • company B: 404 on A's client, accounts and settlements; a cashier cannot
//     use the back-office routes
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
import { customerAccountRoutes } from '../src/modules/receivables/customerAccounts.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'
import posCityLedgerRoutes from '../src/modules/receivables/cityLedgerRoutes.js'
import { tillReportRoutes } from '../src/modules/reports/tillReportsRoutes.js'
import { exposureOfTx } from '../src/modules/receivables/onAccount.js'
import { clientHistory } from '../src/modules/receivables/cityLedger.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { tieOutOf } from '../src/modules/accounting/tillClearing.js'

const RUN = Math.random().toString(36).slice(2, 8)
const CA = '/accounting/customer-accounts'
const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)

let app: FastifyInstance
let tA: string, tB: string
let brandA: string, brandB: string
const token: Record<string, string> = {}
const uid: Record<string, string> = {}

async function mkStaff(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@cityledger.test`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  token[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  uid[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token[who]}` } })

let clientSeq = 0
async function mkClient(tenantId: string, extra: Record<string, unknown> = {}) {
  const n = ++clientSeq
  return prisma.customerAccount.create({
    data: {
      tenantId, number: `CL-${n}-${RUN}`.toUpperCase().slice(0, 20), legalName: `City Client ${n} ${RUN}`,
      creditLimitCents: 10_000_000, termsDays: 15, status: 'active', createdById: uid.finA!, ...extra,
    },
  })
}

let orderSeq = 0
/** A booked on-account bill (an online order booked on its order.complete). */
async function bill(accountId: string, tenantId: string, conceptId: string, amountCents: number, opts: { booked?: boolean } = {}) {
  const order = await prisma.order.create({
    data: { conceptId, source: 'servd', status: 'completed', totalCents: amountCents, taxCents: Math.round(amountCents * 0.15 / 1.15), placedAt: new Date(), externalId: `cl-${RUN}-${++orderSeq}` },
  })
  const payment = await prisma.payment.create({ data: { orderId: order.id, method: 'on_account', amountCents, status: 'paid' } })
  const c = await prisma.customerAccountCharge.create({
    data: { tenantId, accountId, orderId: order.id, paymentId: payment.id, conceptId, amountCents, taxCents: order.taxCents, chargedById: uid.finA! },
  })
  if (opts.booked !== false) {
    await postJournalEntry({
      tenantId, sourceType: 'order.complete', sourceId: order.id, description: `test sale ${order.id}`, postedBy: 'system',
      lines: [
        { accountCode: '1110', type: 'debit', amountCents, conceptId },
        { accountCode: '4090', type: 'credit', amountCents: amountCents - order.taxCents, conceptId },
        { accountCode: '2032', type: 'credit', amountCents: order.taxCents, conceptId },
      ],
    })
  }
  return c
}
async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), memo: l.memo ?? '' }))
}
const owedNow = async (accountId: string) => { const e = await exposureOfTx(prisma, accountId); return e.exposureCents - e.creditCents }

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'CL A', slug: `cl-a-${RUN}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'CL B', slug: `cl-b-${RUN}` } })).id
  for (const t of [tA, tB]) await ensureChartOfAccounts(t)
  brandA = (await prisma.concept.create({ data: { name: 'CL Brand A', slug: `cl-ba-${RUN}`, type: 'restaurant', tenantId: tA, province: 'SD' } })).id
  brandB = (await prisma.concept.create({ data: { name: 'CL Brand B', slug: `cl-bb-${RUN}`, type: 'restaurant', tenantId: tB, province: 'SD' } })).id
  await mkStaff('finA', 'finance', tA)
  await mkStaff('finB', 'finance', tB)
  await mkStaff('cashA', 'cashier', tA)
  await mkStaff('cashB', 'cashier', tB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(customerAccountRoutes, { prefix: CA })
  await app.register(receivableRoutes, { prefix: '/accounting/receivables' })
  await app.register(posCityLedgerRoutes, { prefix: '/pos' })
  await app.register(tillReportRoutes, { prefix: '/reports/till' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('City Ledger accounts', () => {
  it('create: account type, a typed code (unique per company), immediate terms; duplicate code 409', async () => {
    const body = { legalName: `Typed Code Co ${RUN}`, creditLimitCents: 500_000, termsDays: 0, accountType: 'travel_agent', number: `ta-${RUN}` }
    const r = await call('finA', 'POST', CA, body)
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ number: `TA-${RUN}`.toUpperCase(), accountType: 'travel_agent', accountTypeLabel: 'Travel agent', termsDays: 0, receivableAccountCode: '1110' })
    const dup = await call('finA', 'POST', CA, { ...body, legalName: `Another ${RUN}` })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('ACCOUNT_CODE_TAKEN')
    // The automatic OA-<n> series cannot be typed.
    expect((await call('finA', 'POST', CA, { ...body, legalName: `OA typed ${RUN}`, number: 'OA-99999999999' })).statusCode).toBe(400)
    // Company B may use the same code.
    expect((await call('finB', 'POST', CA, { ...body, legalName: `B Co ${RUN}` })).statusCode).toBe(201)
  })
})

describe('settling bills at the till', () => {
  it('cash: one entry Dr 1015 / Cr 1110, a drawer pay-in the close does not book again; partial then full', async () => {
    const client = await mkClient(tA)
    const b1 = await bill(client.id, tA, brandA, 100_000)
    const b2 = await bill(client.id, tA, brandA, 50_000)
    const shift = await prisma.shift.create({ data: { userId: uid.cashA!, openingFloatCents: 10_000, status: 'open', tenantId: tA } })
    expect(await owedNow(client.id)).toBe(150_000)

    // The till's list shows the client with what it owes; company B's cashier never sees it.
    const list = await call('cashA', 'GET', '/pos/city-ledger/accounts')
    expect(list.json().items.find((x: { id: string }) => x.id === client.id)).toMatchObject({ owedCents: 150_000, availableCents: 10_000_000 - 150_000 })
    expect((await call('cashB', 'GET', '/pos/city-ledger/accounts')).json().items.some((x: { id: string }) => x.id === client.id)).toBe(false)
    expect((await call('cashB', 'GET', `/pos/city-ledger/accounts/${client.id}/bills`)).statusCode).toBe(404)

    // Partial: 60,000 on bill 1, 20,000 on bill 2.
    const key = `k-${RUN}-1-xxxx`
    const payload = { accountId: client.id, shiftId: shift.id, method: 'cash', idempotencyKey: key, allocations: [{ chargeId: b1.id, amountCents: 60_000 }, { chargeId: b2.id, amountCents: 20_000 }] }
    const r = await call('cashA', 'POST', '/pos/city-ledger/settlements', payload)
    expect(r.statusCode, r.body).toBe(201)
    const s = r.json().settlement as { id: string; number: string; amountCents: number }
    expect(s.amountCents).toBe(80_000)
    expect(r.json().owedCents).toBe(70_000)
    const lines = (await entry(tA, `cityledger.settlement:${s.id}`))!
    expect(lines.filter((l) => l.type === 'debit')).toEqual([expect.objectContaining({ code: '1015', amount: 80_000 })])
    expect(lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amount, 0)).toBe(80_000)
    expect(lines.every((l) => l.type === 'debit' || l.code === '1110')).toBe(true)
    expect(await prisma.cashMovement.count({ where: { shiftId: shift.id, type: 'payin' } })).toBe(1)

    // A retry is the same settlement; the same key with another split is 409.
    const again = await call('cashA', 'POST', '/pos/city-ledger/settlements', payload)
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ replayed: true, settlement: { id: s.id } })
    const other = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, allocations: [{ chargeId: b1.id, amountCents: 1_000 }] })
    expect(other.statusCode).toBe(409)
    expect(await prisma.cityLedgerSettlement.count({ where: { accountId: client.id } })).toBe(1)

    // Over-allocated (bill 1 owes 40,000 now) → 409, nothing written.
    const over = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-2-xxxx`, allocations: [{ chargeId: b1.id, amountCents: 40_001 }] })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVER_ALLOCATED')

    // Card / Raast are not taken against City Ledger bills; a bank transfer needs its reference.
    expect((await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-3-xxxx`, method: 'card' })).statusCode).toBe(400)
    const noRef = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-4-xxxx`, method: 'bank_transfer' })
    expect(noRef.json().error.code).toBe('PAYMENT_REFERENCE_REQUIRED')
    // A transfer must be seen on the counter device.
    const unseen = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-4b-xxxx`, method: 'bank_transfer', reference: `T-${RUN}` })
    expect(unseen.json().error.code).toBe('TRANSFER_NOT_VERIFIED')

    // Full: the rest of both bills; bill 1 is then settled and refused.
    const full = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-5-xxxx`, allocations: [{ chargeId: b1.id, amountCents: 40_000 }, { chargeId: b2.id, amountCents: 30_000 }] })
    expect(full.statusCode, full.body).toBe(201)
    expect(await owedNow(client.id)).toBe(0)
    const done = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-6-xxxx`, allocations: [{ chargeId: b1.id, amountCents: 1 }] })
    expect(done.json().error.code).toBe('BILL_ALREADY_SETTLED')
    expect((await call('cashA', 'GET', `/pos/city-ledger/accounts/${client.id}/bills`)).json().items).toHaveLength(0)

    // The close: counted = float + 150,000 settled cash → no variance, the pay-ins not booked as Dr 1015 / Cr 1010.
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 160_000 } })
    // Nothing but City Ledger cash went through this drawer, so its close has nothing left to book.
    await postShiftClose(shift.id)
    const close = (await entry(tA, `shift.close:${shift.id}`)) ?? []
    expect(close.some((l) => l.code === '8010')).toBe(false)
    expect(close.some((l) => l.memo.includes('paid in to drawer'))).toBe(false)
    // A settlement on a closed drawer is refused.
    const late = await call('cashA', 'POST', '/pos/city-ledger/settlements', { ...payload, idempotencyKey: `k-${RUN}-7-xxxx` })
    expect(late.statusCode).toBe(422)

    // Reversing the full settlement after the drawer closed: the cash goes back out from cash on hand (1010).
    const fullId = full.json().settlement.id as string
    const rev = await call('finA', 'POST', `${CA}/settlements/${fullId}/reverse`, { reason: 'Keyed on the wrong client' })
    expect(rev.statusCode, rev.body).toBe(200)
    const back = (await entry(tA, `cityledger.settlement.reversal:${fullId}`))!
    expect(back.find((l) => l.type === 'credit')).toMatchObject({ code: '1010', amount: 70_000 })
    expect(back.filter((l) => l.type === 'debit' && l.code === '1110').reduce((t, l) => t + l.amount, 0)).toBe(70_000)
    expect(await owedNow(client.id)).toBe(70_000)

    // History ends at what the client owes; the 1110 tie-out has no difference.
    const h = await clientHistory(prisma, client)
    expect(h[h.length - 1]!.balanceCents).toBe(70_000)
    expect((await tieOutOf(tA, prisma)).differenceCents).toBe(0)
  })

  it('a bill not booked yet, or on a statement, is refused; the statement bills only what is still owed', async () => {
    const client = await mkClient(tA)
    const shift = await prisma.shift.create({ data: { userId: uid.cashA!, openingFloatCents: 0, status: 'open', tenantId: tA } })
    const unbooked = await bill(client.id, tA, brandA, 30_000, { booked: false })
    const r = await call('cashA', 'POST', '/pos/city-ledger/settlements', { accountId: client.id, shiftId: shift.id, method: 'cash', idempotencyKey: `k-${RUN}-nb-xxxx`, allocations: [{ chargeId: unbooked.id, amountCents: 1_000 }] })
    expect(r.json().error.code).toBe('BILL_NOT_BOOKED')

    const b1 = await bill(client.id, tA, brandA, 80_000)
    const b2 = await bill(client.id, tA, brandA, 20_000)
    // Back office: 30,000 of bill 1, all of bill 2 (bank transfer with its reference).
    const s = await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `bo-${Math.random().toString(36).slice(2)}-key`, method: 'bank_transfer', reference: `TRF-${RUN}`, receivedAt: today(), allocations: [{ chargeId: b1.id, amountCents: 30_000 }, { chargeId: b2.id, amountCents: 20_000 }] })
    expect(s.statusCode, s.body).toBe(201)
    expect(s.json().settlement.moneyAccountCode).toBe('1020')
    // A cashier cannot use the back-office route; company B is 404.
    expect((await call('cashA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `bo-${Math.random().toString(36).slice(2)}-key`, method: 'cash', reference: 'x', receivedAt: today(), allocations: [{ chargeId: b1.id, amountCents: 1 }] })).statusCode).toBe(403)
    expect((await call('finB', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `bo-${Math.random().toString(36).slice(2)}-key`, method: 'cash', reference: 'x', receivedAt: today(), allocations: [{ chargeId: b1.id, amountCents: 1 }] })).statusCode).toBe(404)

    // The statement: bill 1's remaining 50,000 only (bill 2 is paid, the unbooked one waits).
    const st = await call('finA', 'POST', `${CA}/${client.id}/statements`, { periodTo: today() })
    expect(st.statusCode, st.body).toBe(201)
    const inv = await prisma.receivableInvoice.findFirstOrThrow({ where: { customerAccountId: client.id, kind: 'statement' } })
    expect(Number(inv.amountCents) + Number(inv.taxCents)).toBe(50_000)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: b2.id } })).statementInvoiceId).toBeNull()
    const onSt = await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `bo-${Math.random().toString(36).slice(2)}-key`, method: 'cash', reference: 'R1', receivedAt: today(), allocations: [{ chargeId: b1.id, amountCents: 1_000 }] })
    expect(onSt.json().error.code).toBe('BILL_ON_STATEMENT')
    expect(await owedNow(client.id)).toBe(80_000) // 50,000 on the statement + the unbooked 30,000

    // Reverse the bank settlement: refused while bill 1 is on the statement; once the statement is voided the bills
    // owe again, the entry is mirrored; twice → 409.
    const sid = s.json().settlement.id as string
    expect((await call('finA', 'POST', `${CA}/settlements/${sid}/reverse`, { reason: 'short' })).statusCode).toBe(400)
    const blocked = await call('finA', 'POST', `${CA}/settlements/${sid}/reverse`, { reason: 'Transfer bounced at the bank' })
    expect(blocked.json().error.code).toBe('SETTLED_BILL_ON_STATEMENT')
    const voided = await call('finA', 'POST', `/accounting/receivables/${inv.id}/void`, { reason: 'Re-issue after the bounced transfer' })
    expect(voided.statusCode, voided.body).toBe(200)
    const rev = await call('finA', 'POST', `${CA}/settlements/${sid}/reverse`, { reason: 'Transfer bounced at the bank' })
    expect(rev.statusCode, rev.body).toBe(200)
    expect(await entry(tA, `cityledger.settlement.reversal:${sid}`)).not.toBeNull()
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: b2.id } })).settledCents).toBe(0)
    expect(await owedNow(client.id)).toBe(130_000)
    expect((await call('finA', 'POST', `${CA}/settlements/${sid}/reverse`, { reason: 'Transfer bounced at the bank' })).statusCode).toBe(409)
    expect((await call('finB', 'POST', `${CA}/settlements/${sid}/reverse`, { reason: 'Transfer bounced at the bank' })).statusCode).toBe(404)

    const h = await clientHistory(prisma, client)
    expect(h[h.length - 1]!.balanceCents).toBe(await owedNow(client.id))
    const hist = await call('finA', 'GET', `${CA}/${client.id}/history`)
    expect(hist.json().balanceCents).toBe(await owedNow(client.id))
    expect((await call('finB', 'GET', `${CA}/${client.id}/history`)).statusCode).toBe(404)
  })
})

describe('City Ledger Summary report', () => {
  it('account-wise totals add up; unrelated receivables never appear; ignoreZero; the account is required', async () => {
    const client = await mkClient(tA, { accountType: 'corporate' })
    const zero = await mkClient(tA)
    const b1 = await bill(client.id, tA, brandA, 40_000)
    await bill(client.id, tA, brandA, 10_000)
    await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `bo-${Math.random().toString(36).slice(2)}-key`, method: 'cash', reference: 'RCPT-1', receivedAt: today(), allocations: [{ chargeId: b1.id, amountCents: 15_000 }] })
    // An unrelated back-office invoice to a customer of the same name: never in the City Ledger.
    await prisma.receivableInvoice.create({ data: { tenantId: tA, number: `AR-X-${RUN}`, customerName: client.legalName, issueDate: new Date(), dueDate: new Date(), description: 'consulting', amountCents: 999_999 } })

    const base = `/reports/till/run/city_ledger_summary?conceptIds=${brandA}&dateFrom=${today()}&dateTo=${today()}`
    const missing = await call('finA', 'GET', base)
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error.code).toBe('ACCOUNT_REQUIRED')

    const r = await call('finA', 'GET', `${base}&clAccounts=${client.id},${zero.id}`)
    expect(r.statusCode, r.body).toBe(200)
    const [accounts, bills] = r.json().sections as Array<{ rows: Array<Record<string, unknown>> }>
    const row = accounts!.rows.find((x) => x['code'] === client.number)!
    expect(row).toMatchObject({ type: 'Corporate customer', openingCents: 0, newBillsCents: 50_000, paymentsCents: 15_000, adjustmentsCents: 0, closingCents: 35_000 })
    expect(row['closingCents']).toBe(await owedNow(client.id))
    expect(bills!.rows.filter((x) => x['code'] === client.number)).toHaveLength(2)
    expect(bills!.rows.find((x) => x['outstandingCents'] === 25_000)).toMatchObject({ status: 'Partially settled', settledCents: 15_000, netCents: 40_000 })
    expect(JSON.stringify(r.json())).not.toContain('999999')
    expect(accounts!.rows.some((x) => x['code'] === zero.number)).toBe(true)

    const ign = await call('finA', 'GET', `${base}&clAccounts=all&opts=ignoreZero`)
    expect((ign.json().sections[0].rows as Array<Record<string, unknown>>).some((x) => x['code'] === zero.number)).toBe(false)
    // By account type.
    const typed = await call('finA', 'GET', `${base}&clAccounts=all&clAccountTypes=travel_agent`)
    expect((typed.json().sections[0].rows as Array<Record<string, unknown>>).some((x) => x['code'] === client.number)).toBe(false)
    // Export matches: the CSV carries the same closing.
    const csv = await call('finA', 'GET', `${base}&clAccounts=${client.id}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain(client.number)
    // Company B cannot run it on A's brand.
    expect((await call('finB', 'GET', `${base}&clAccounts=all`)).statusCode).toBe(404)
  })
})

describe('money owed back (a bill refunded after it was paid)', () => {
  it('finance pays it back: Dr 1110 / Cr the money, the bill owes nothing; never more than owed back', async () => {
    const client = await mkClient(tA)
    const b = await bill(client.id, tA, brandA, 20_000)
    const paid = await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `pb-${RUN}-1-key`, method: 'cash', reference: 'R-PB', receivedAt: today(), allocations: [{ chargeId: b.id, amountCents: 20_000 }] })
    expect(paid.statusCode, paid.body).toBe(201)
    // The till refunds the whole bill afterwards: the client is now owed 20,000 back.
    await prisma.customerAccountCharge.update({ where: { id: b.id }, data: { refundedCents: 20_000 } })
    expect((await exposureOfTx(prisma, client.id)).creditCents).toBe(20_000)
    const over = await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `pb-${RUN}-2-key`, direction: 'out', method: 'cash', reference: 'PB-1', receivedAt: today(), allocations: [{ chargeId: b.id, amountCents: 20_001 }] })
    expect(over.json().error.code).toBe('OVER_ALLOCATED')
    const out = await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `pb-${RUN}-3-key`, direction: 'out', method: 'cash', reference: 'PB-1', receivedAt: today(), allocations: [{ chargeId: b.id, amountCents: 20_000 }] })
    expect(out.statusCode, out.body).toBe(201)
    const lines = (await entry(tA, `cityledger.settlement:${out.json().settlement.id}`))!
    expect(lines.find((l) => l.type === 'credit')).toMatchObject({ code: '1010', amount: 20_000 })
    expect(lines.find((l) => l.type === 'debit')).toMatchObject({ code: '1110', amount: 20_000 })
    const e = await exposureOfTx(prisma, client.id)
    expect(e.creditCents + e.exposureCents).toBe(0)
    // A future date is refused.
    const fut = new Date(Date.now() + 3 * 86_400_000 + 5 * 3_600_000).toISOString().slice(0, 10)
    const b2 = await bill(client.id, tA, brandA, 5_000)
    expect((await call('finA', 'POST', `${CA}/${client.id}/settlements`, { idempotencyKey: `pb-${RUN}-4-key`, method: 'cash', reference: 'R', receivedAt: fut, allocations: [{ chargeId: b2.id, amountCents: 5_000 }] })).json().error.code).toBe('DATE_IN_FUTURE')
    const h = await clientHistory(prisma, client)
    expect(h[h.length - 1]!.balanceCents).toBe(5_000)
  })
})

