// On-account core rules (receivables/onAccount.ts) and the receivables ledger
// helpers moved into receivables/ledger.ts.
//
//   exposure     unbilled charges net of refunds + Σ max(0, balance) of the
//                client's open / part-paid invoices and statements — in the
//                CLIENT's company only (company B's rows never count);
//   overdue      Karachi due day + grace days before today's Karachi day;
//   refusals     in order: TILL_CLEARING_NOT_SPLIT, NOT_ACTIVE,
//                BRAND_NOT_ALLOWED, OVERDUE, OVER_LIMIT, REFERENCE_REQUIRED;
//   refunds      applyChargeRefundTx caps at the charge's net, credits a
//                statement and re-statuses it, is idempotent per refund row,
//                and is a no-op on an order with no charge;
//   booked       a till sale needs its drawer's shift.close, any other order
//                its order.complete — in the charge's company.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import type { CustomerAccount, Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import {
  assertChargeableTx, applyChargeRefundTx, exposureOfTx, isChargeBookedTx, recordChargeTx, chargeNetCents,
  lockAccountTx, ON_ACCOUNT_ERRORS, CLIENT_EDITORS, CLIENT_VIEWERS,
} from '../src/modules/receivables/onAccount.js'
import { nextNumber, balanceOf, statusFor, STATEMENT, LIVE_KINDS } from '../src/modules/receivables/ledger.js'
import * as routesMod from '../src/modules/receivables/routes.js'
import * as ledgerMod from '../src/modules/receivables/ledger.js'
import { tillClearingCutoverKey } from '../src/modules/accounting/tillClearingCode.js'

const RUN = Math.random().toString(36).slice(2, 8)
const DAY = 86_400_000

let tenantA: string, tenantB: string, conceptA: string, conceptA2: string, conceptB: string, userA: string
let seq = 0

async function mkAccount(tenantId: string, extra: Partial<Prisma.CustomerAccountUncheckedCreateInput> = {}): Promise<CustomerAccount> {
  seq++
  return prisma.customerAccount.create({
    data: {
      tenantId, number: `OA-${RUN}-${seq}`, legalName: `Client ${RUN} ${seq}`, creditLimitCents: 100_000,
      status: 'active', createdById: userA, overdueGraceDays: 7, ...extra,
    },
  })
}

async function mkOrder(conceptId: string, source: 'pos' | 'servd', shiftId: string | null = null) {
  const o = await prisma.order.create({
    data: { conceptId, source, fulfilmentType: 'dine_in', status: 'completed', totalCents: 10_000, taxCents: 1_300, taxRatePct: 15, shiftId },
  })
  const p = await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'on_account', amountCents: 10_000, status: 'paid' } })
  return { orderId: o.id, paymentId: p.id }
}

async function charge(acct: CustomerAccount, amountCents: number, opts: { source?: 'pos' | 'servd'; shiftId?: string | null; conceptId?: string } = {}) {
  const { orderId, paymentId } = await mkOrder(opts.conceptId ?? conceptA, opts.source ?? 'servd', opts.shiftId ?? null)
  return prisma.$transaction((tx) => recordChargeTx(tx, {
    account: acct, orderId, paymentId, conceptId: opts.conceptId ?? conceptA, shiftId: opts.shiftId ?? null,
    amountCents, chargedById: userA,
  }))
}

async function mkBill(tenantId: string, accountId: string, opts: { total: number; due: string; kind?: string; status?: string; paid?: number }) {
  seq++
  return prisma.receivableInvoice.create({
    data: {
      tenantId, customerAccountId: accountId, kind: opts.kind ?? STATEMENT, number: `T-${RUN}-${seq}`,
      customerName: 'Client', issueDate: new Date(`${opts.due}T00:00:00Z`), dueDate: new Date(`${opts.due}T00:00:00Z`),
      description: 'Statement', amountCents: opts.total, taxCents: 0, paidCents: opts.paid ?? 0, status: opts.status ?? 'open',
    },
  })
}

const cutOver = (tenantId: string) =>
  prisma.setting.upsert({ where: { key: tillClearingCutoverKey(tenantId) }, create: { key: tillClearingCutoverKey(tenantId), value: new Date().toISOString() }, update: {} })

async function refusal(acct: CustomerAccount, input: { conceptId?: string; billCents: number; reference?: string | null }, now?: Date) {
  try {
    await prisma.$transaction(async (tx) => {
      const locked = await lockAccountTx(tx, acct.id)
      await assertChargeableTx(tx, locked, { conceptId: input.conceptId ?? conceptA, billCents: input.billCents, reference: input.reference }, now)
    })
    return null
  } catch (err) {
    if (err instanceof AppError) return { code: err.code, status: err.statusCode, details: err.details as Record<string, unknown> | undefined }
    throw err
  }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'OA A', slug: `oa-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'OA B', slug: `oa-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Kitchen A', slug: `oa-a-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Kitchen A2', slug: `oa-a2-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Kitchen B', slug: `oa-b-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id
  userA = (await prisma.user.create({ data: { name: 'fin', email: `fin.${RUN}@oa.test`, password: 'x', role: 'finance', isActive: true, tenantId: tenantA } })).id
})

describe('receivables ledger helpers (moved, re-exported)', () => {
  it('routes.ts re-exports every moved name from ledger.ts', () => {
    for (const k of ['INVOICE', 'CREDIT_NOTE', 'STATEMENT', 'LIVE_KINDS', 'WHT_METHOD', 'ST_WITHHELD_METHOD', 'totalOf', 'balanceOf',
      'statusFor', 'paymentKind', 'sourceOfPayment', 'lockInvoice', 'restatus', 'nextNumber', 'withNumberRetry'] as const) {
      expect((routesMod as Record<string, unknown>)[k], k).toBe((ledgerMod as Record<string, unknown>)[k])
    }
    expect(LIVE_KINDS).toEqual(['invoice', 'statement'])
  })

  it('a statement balances and statuses like an invoice', () => {
    const f = { kind: STATEMENT, status: 'open', amountCents: 10_000, taxCents: 0, paidCents: 4_000, creditedCents: 0, whtCents: 0, writtenOffCents: 0 }
    expect(balanceOf(f)).toBe(6_000)
    expect(statusFor(f)).toBe('partial')
    expect(statusFor({ ...f, paidCents: 10_000 })).toBe('paid')
  })

  it('numbers statements AR-ST-<Karachi year>-NNNN, separately from invoices', async () => {
    const acct = await mkAccount(tenantA)
    // 31 Dec 2025 21:00 UTC is already 1 Jan 2026 in Karachi.
    const n1 = await prisma.$transaction((tx) => nextNumber(tx, tenantA, new Date('2025-12-31T21:00:00Z'), STATEMENT))
    expect(n1).toBe('AR-ST-2026-0001')
    await prisma.receivableInvoice.create({
      data: { tenantId: tenantA, customerAccountId: acct.id, kind: STATEMENT, number: n1, customerName: 'c', issueDate: new Date(), dueDate: new Date(), description: 's', amountCents: 1, status: 'open' },
    })
    expect(await prisma.$transaction((tx) => nextNumber(tx, tenantA, new Date('2026-03-01T00:00:00Z'), STATEMENT))).toBe('AR-ST-2026-0002')
    expect(await prisma.$transaction((tx) => nextNumber(tx, tenantA, new Date('2026-03-01T00:00:00Z'), 'invoice'))).toBe('AR-2026-0001')
    expect(await prisma.$transaction((tx) => nextNumber(tx, tenantB, new Date('2026-03-01T00:00:00Z'), STATEMENT))).toBe('AR-ST-2026-0001')
  })
})

describe('exposure', () => {
  it('counts unbilled charges net of refunds plus what open statements still owe', async () => {
    const acct = await mkAccount(tenantA)
    const c1 = await charge(acct, 3_000)
    await charge(acct, 2_000)
    await prisma.customerAccountCharge.update({ where: { id: c1.id }, data: { refundedCents: 500 } })
    expect(chargeNetCents({ amountCents: 3_000, refundedCents: 500 })).toBe(2_500)
    // A billed charge is not counted as unbilled (its statement carries it).
    const st = await mkBill(tenantA, acct.id, { total: 7_000, due: '2099-01-01', paid: 1_000, status: 'partial' })
    const billed = await charge(acct, 7_000)
    await prisma.customerAccountCharge.update({ where: { id: billed.id }, data: { statementInvoiceId: st.id } })
    // Paid, void and in-credit rows never add.
    await mkBill(tenantA, acct.id, { total: 9_000, due: '2099-01-01', status: 'paid', paid: 9_000 })
    await mkBill(tenantA, acct.id, { total: 9_000, due: '2099-01-01', status: 'void' })
    await mkBill(tenantA, acct.id, { total: 1_000, due: '2099-01-01', status: 'partial', paid: 1_500 })
    // An ordinary invoice linked to the client counts too.
    await mkBill(tenantA, acct.id, { total: 4_000, due: '2099-01-01', kind: 'invoice' })
    const e = await exposureOfTx(prisma, acct.id)
    // …but the in-credit row is money owed BACK to the client (500): creditCents,
    // never netted against exposure (closing refuses it — CLIENT_IN_CREDIT).
    expect(e).toEqual({ unbilledCents: 4_500, invoicesDueCents: 6_000 + 4_000, exposureCents: 14_500, creditCents: 500, overdue: null })
  })

  it('two companies: B rows carrying A client id never count', async () => {
    const acct = await mkAccount(tenantA)
    await mkBill(tenantB, acct.id, { total: 50_000, due: '2000-01-01' })
    await prisma.customerAccountCharge.create({
      data: { tenantId: tenantB, accountId: acct.id, orderId: `x-${RUN}-1`, paymentId: `x-${RUN}-1`, conceptId: conceptB, amountCents: 9_999, chargedById: userA },
    })
    const e = await exposureOfTx(prisma, acct.id)
    expect(e).toEqual({ unbilledCents: 0, invoicesDueCents: 0, exposureCents: 0, creditCents: 0, overdue: null })
  })

  it('overdue by Karachi day with grace', async () => {
    const acct = await mkAccount(tenantA, { overdueGraceDays: 7 })
    const st = await mkBill(tenantA, acct.id, { total: 5_000, due: '2026-01-10' })
    // Due 10 Jan + 7 grace = 17 Jan. On 17 Jan (Karachi) not yet overdue.
    expect((await exposureOfTx(prisma, acct.id, new Date('2026-01-17T18:59:00Z'))).overdue).toBeNull() // 23:59 PKT on the 17th
    // 19:00 UTC on the 17th is 00:00 PKT on the 18th — overdue.
    const e = await exposureOfTx(prisma, acct.id, new Date('2026-01-17T19:00:00Z'))
    expect(e.overdue).toEqual({ invoiceId: st.id, number: st.number, kind: STATEMENT, dueDate: '2026-01-10', balanceCents: 5_000 })
    // Zero grace: overdue from the 11th (Karachi).
    await prisma.customerAccount.update({ where: { id: acct.id }, data: { overdueGraceDays: 0 } })
    expect((await exposureOfTx(prisma, acct.id, new Date('2026-01-10T18:59:00Z'))).overdue).toBeNull()
    expect((await exposureOfTx(prisma, acct.id, new Date('2026-01-10T19:00:00Z'))).overdue?.invoiceId).toBe(st.id)
    // A settled statement is never overdue.
    await prisma.receivableInvoice.update({ where: { id: st.id }, data: { paidCents: 5_000, status: 'paid' } })
    expect((await exposureOfTx(prisma, acct.id, new Date('2026-03-01T00:00:00Z'))).overdue).toBeNull()
  })
})

describe('assertChargeableTx refusals, in order', () => {
  it('TILL_CLEARING_NOT_SPLIT first — even for an inactive, over-limit client', async () => {
    const acct = await mkAccount(tenantB, { status: 'suspended' })
    const r = await refusal(acct, { conceptId: conceptB, billCents: 10_000_000 })
    expect(r).toMatchObject({ code: 'TILL_CLEARING_NOT_SPLIT', status: 409 })
    expect(ON_ACCOUNT_ERRORS.TILL_CLEARING_NOT_SPLIT).toBeTruthy()
  })

  it('then NOT_ACTIVE, BRAND_NOT_ALLOWED, OVERDUE, OVER_LIMIT, REFERENCE_REQUIRED', async () => {
    await cutOver(tenantA)
    const pending = await mkAccount(tenantA, { status: 'pending' })
    expect(await refusal(pending, { billCents: 1 })).toMatchObject({ code: 'ON_ACCOUNT_NOT_ACTIVE', status: 409 })

    const acct = await mkAccount(tenantA, { conceptIds: [conceptA], requiresReference: true, creditLimitCents: 10_000 })
    expect(await refusal(acct, { conceptId: conceptA2, billCents: 1 })).toMatchObject({ code: 'ON_ACCOUNT_BRAND_NOT_ALLOWED', status: 409 })

    const st = await mkBill(tenantA, acct.id, { total: 2_000, due: '2000-01-01' })
    const od = await refusal(acct, { billCents: 1 })
    expect(od).toMatchObject({ code: 'ON_ACCOUNT_OVERDUE', status: 409, details: { statementNumber: st.number, dueDate: '2000-01-01', balanceCents: 2_000 } })
    await prisma.receivableInvoice.update({ where: { id: st.id }, data: { dueDate: new Date(Date.now() + 30 * DAY) } })

    await charge(acct, 3_000)
    // exposure 2,000 + 3,000 = 5,000; limit 10,000.
    const ol = await refusal(acct, { billCents: 5_001, reference: 'PO-1' })
    expect(ol).toMatchObject({ code: 'ON_ACCOUNT_OVER_LIMIT', status: 409, details: { limitCents: 10_000, exposureCents: 5_000, availableCents: 5_000, billCents: 5_001 } })

    expect(await refusal(acct, { billCents: 5_000, reference: '  ' })).toMatchObject({ code: 'ON_ACCOUNT_REFERENCE_REQUIRED', status: 422 })
    expect(await refusal(acct, { billCents: 5_000, reference: 'PO-1' })).toBeNull()
  })

  it('an empty conceptIds list allows every brand of the company', async () => {
    const acct = await mkAccount(tenantA)
    expect(await refusal(acct, { conceptId: conceptA2, billCents: 1_000 })).toBeNull()
  })

  it('exports the role lists', () => {
    expect(CLIENT_EDITORS).toEqual(['admin', 'owner', 'management', 'finance'])
    expect(CLIENT_VIEWERS).toEqual(['admin', 'owner', 'management', 'finance'])
  })
})

describe('recordChargeTx', () => {
  it('binds to the client company and marks the card used', async () => {
    const acct = await mkAccount(tenantA)
    const card = await prisma.customerAccountCard.create({ data: { tenantId: tenantA, accountId: acct.id, label: 'Reception', tokenHash: `h-${RUN}`, tokenHint: 'ABCD', issuedById: userA } })
    const { orderId, paymentId } = await mkOrder(conceptA, 'servd')
    const c = await prisma.$transaction((tx) => recordChargeTx(tx, { account: acct, cardId: card.id, orderId, paymentId, conceptId: conceptA, amountCents: 4_200, taxCents: 548, reference: ' PO-9 ', chargedById: userA }))
    expect(c).toMatchObject({ tenantId: tenantA, accountId: acct.id, amountCents: 4_200, taxCents: 548, reference: 'PO-9', refundedCents: 0, statementInvoiceId: null })
    expect((await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: card.id } })).lastUsedAt).not.toBeNull()
  })
})

describe('applyChargeRefundTx', () => {
  const refundRow = (orderId: string, amountCents: number) =>
    prisma.payment.create({ data: { orderId, method: 'on_account', amountCents: -amountCents, status: 'refunded' } })

  it('is a no-op on an order with no charge', async () => {
    const { orderId } = await mkOrder(conceptA, 'servd')
    const r = await refundRow(orderId, 100)
    expect(await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId, refundPaymentId: r.id, amountCents: 100 })))
      .toEqual({ appliedCents: 0, chargeId: null, statementInvoiceId: null, alreadyApplied: false })
  })

  it('caps at the net, credits the statement, re-statuses it and is idempotent per refund row', async () => {
    const acct = await mkAccount(tenantA)
    const c = await charge(acct, 6_000)
    const st = await mkBill(tenantA, acct.id, { total: 6_000, due: '2099-01-01' })
    await prisma.customerAccountCharge.update({ where: { id: c.id }, data: { statementInvoiceId: st.id } })

    const r1 = await refundRow(c.orderId, 2_000)
    const a1 = await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c.orderId, refundPaymentId: r1.id, amountCents: 2_000 }))
    expect(a1).toEqual({ appliedCents: 2_000, chargeId: c.id, statementInvoiceId: st.id, alreadyApplied: false })
    let inv = await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.id } })
    expect(Number(inv.creditedCents)).toBe(2_000)
    expect(inv.status).toBe('partial')

    // Same refund row again: nothing moves.
    const again = await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c.orderId, refundPaymentId: r1.id, amountCents: 2_000 }))
    expect(again).toMatchObject({ appliedCents: 0, alreadyApplied: true })
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: c.id } })).refundedCents).toBe(2_000)

    // More than the net: capped at the 4,000 left.
    const r2 = await refundRow(c.orderId, 9_000)
    const a2 = await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c.orderId, refundPaymentId: r2.id, amountCents: 9_000 }))
    expect(a2.appliedCents).toBe(4_000)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: c.id } })).refundedCents).toBe(6_000)
    inv = await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.id } })
    expect(Number(inv.creditedCents)).toBe(6_000)
    expect(balanceOf(inv)).toBe(0)
    expect(inv.status).toBe('credited')
    const meta = (await prisma.payment.findUniqueOrThrow({ where: { id: r2.id } })).gatewayMeta as Record<string, { cents: number }>
    expect(meta.onAccountApplied.cents).toBe(4_000)

    // Fully refunded: a further refund applies nothing.
    const r3 = await refundRow(c.orderId, 100)
    expect((await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c.orderId, refundPaymentId: r3.id, amountCents: 100 }))).appliedCents).toBe(0)
    expect(await exposureOfTx(prisma, acct.id)).toMatchObject({ exposureCents: 0 })
  })

  it('an unbilled charge only lowers refundedCents-net exposure', async () => {
    const acct = await mkAccount(tenantA)
    const c = await charge(acct, 5_000)
    const r = await refundRow(c.orderId, 1_500)
    const a = await prisma.$transaction((tx) => applyChargeRefundTx(tx, { orderId: c.orderId, refundPaymentId: r.id, amountCents: 1_500 }))
    expect(a).toMatchObject({ appliedCents: 1_500, statementInvoiceId: null })
    expect((await exposureOfTx(prisma, acct.id)).unbilledCents).toBe(3_500)
  })
})

describe('isChargeBookedTx', () => {
  it('a till sale is booked by its drawer close, in the charge company only', async () => {
    const acct = await mkAccount(tenantA)
    const shift = await prisma.shift.create({ data: { userId: userA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })
    const c = await charge(acct, 1_000, { source: 'pos', shiftId: shift.id })
    expect(await isChargeBookedTx(prisma, c)).toBe(false)
    // order.complete does not book a till sale; another company's close does not either.
    await prisma.journalEntry.create({ data: { tenantId: tenantA, reference: `order.complete:${c.orderId}`, description: 't' } })
    await prisma.journalEntry.create({ data: { tenantId: tenantB, reference: `shift.close:${shift.id}`, description: 't' } })
    expect(await isChargeBookedTx(prisma, c)).toBe(false)
    await prisma.journalEntry.create({ data: { tenantId: tenantA, reference: `shift.close:${shift.id}`, description: 't' } })
    expect(await isChargeBookedTx(prisma, c)).toBe(true)
  })

  it('any other order is booked by its order.complete', async () => {
    const acct = await mkAccount(tenantA)
    const c = await charge(acct, 1_000, { source: 'servd' })
    expect(await isChargeBookedTx(prisma, c)).toBe(false)
    await prisma.journalEntry.create({ data: { tenantId: tenantB, reference: `order.complete:${c.orderId}`, description: 't' } })
    expect(await isChargeBookedTx(prisma, c)).toBe(false)
    await prisma.journalEntry.create({ data: { tenantId: tenantA, reference: `order.complete:${c.orderId}`, description: 't' } })
    expect(await isChargeBookedTx(prisma, c)).toBe(true)
  })
})
