// Raast QR — the ledger (spec §5, tests C; owner decisions 2026-10-12).
//
// A Raast payment is a transfer straight into the company's receiving BANK
// account, so the books debit that bank's own chart code — the RaastReceipt's
// ledgerCode snapshot — never 1030 card receivable:
//   - the shift close: one debit per receiving-bank code, memo'd
//     RAAST RECEIPTS (bank reconciliation never pairs a statement line with
//     that aggregate), balanced; each company's close stays in its own chart;
//   - two brands on two receiving accounts → two bank lines; the snapshot
//     decides, not today's brand mapping;
//   - a cancelled ticket's Raast money: Dr bank / Cr 1110 refund due (never
//     revenue or tax); its hand-back Dr 1110 / Cr bank nets both to zero;
//   - a non-till order's completion debits the bank, and the drawer that
//     took the transfer books no second Raast line;
//   - a Raast refund credits the bank it was sent back from
//     (gatewayMeta.raast.ledgerCode); without a code it is refused;
//   - a Raast row with no code on record: the close is REFUSED
//     (RAAST_ACCOUNT_UNKNOWN) and flagged posting_failed, the Z-report summary
//     still reads, the backfill lists it and carries on — never 1030;
//   - end to end through the till (stream B's routes): ring → Raast with the
//     bank reference + the counter-device tick → close → Dr bank; a manager's
//     Raast refund → Cr bank; the fiscal documents carry the raast tender.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, mkRaastAccount, openDrawer, buildApp, caller, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import {
  postOrderCompletion, postRefundPayment, refundCreditAccount, raastLedgerCodeOf, refundDueCents, refundDueMemo,
  RAAST_RECEIPTS_MEMO,
} from '../src/modules/accounting/orderPosting.js'
import {
  postShiftClose, buildShiftCloseEntry, backfillUnpostedShifts, summariseShiftSales, SHIFT_SALE_PAYMENT_INCLUDE,
} from '../src/modules/accounting/shiftPosting.js'
import { revenueCodeForConcept } from '../src/modules/accounting/journal.js'
import { resolveRaastAccount } from '../src/connectors/raast/accounts.js'
import { orderRefOf } from '../src/lib/orderRef.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { toCents } from '../src/lib/money.js'

const RUN = Math.random().toString(36).slice(2, 7).toUpperCase()

let A: Company, B: Company
let conceptA2: string
let cashierA: Who, cashierB: Who

type Line = { code: string; type: string; amount: number; memo: string; tenantId: string | null; conceptId: string | null }

async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  return je
    ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: toCents(l.amountCents), memo: l.memo ?? '', tenantId: l.account.tenantId, conceptId: l.conceptId }))
    : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)
const balanced = (lines: Line[]) => side(lines, 'debit') === side(lines, 'credit')

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 6000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100))
    v = await read()
  }
  return v
}

/** Net debit (debits − credits) of a company's account code over the given entries (or all of the company's). */
async function netDebit(tenantId: string, code: string, references?: string[]): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId, ...(references && { reference: { in: references } }) } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}

async function order(co: Company, conceptId: string, o: {
  items: number; tax: number; ratePct: number; tip?: number; status?: 'completed' | 'cancelled' | 'received'; source?: 'pos' | 'servd'
}): Promise<string> {
  const status = o.status ?? 'completed'
  const row = await prisma.order.create({
    data: {
      conceptId, locationId: co.locationId, source: o.source ?? 'pos', fulfilmentType: 'takeout', status,
      totalCents: o.items + o.tax + (o.tip ?? 0), taxCents: o.tax, taxRatePct: o.ratePct, tipCents: o.tip ?? 0,
      completedAt: status === 'completed' ? new Date() : null,
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: o.items }] },
    },
  })
  return row.id
}

let refSeq = 0
const nextRef = () => `MZ${RUN}${String(++refSeq).padStart(4, '0')}77`

/**
 * A Raast tender as stream B records it: a paid Payment (gateway 'raast',
 * gatewayRef = the normalised bank reference) and its RaastReceipt with the
 * brand's receiving account and its ledgerCode snapshot (resolveRaastAccount).
 * `receipt: false` leaves the row with no code on record.
 */
async function payRaast(co: Company, conceptId: string, orderId: string, shiftId: string | null, cents: number, opts: { receipt?: boolean; who?: Who } = {}) {
  const ref = nextRef()
  const payment = await prisma.payment.create({
    data: { orderId, shiftId, method: 'raast', amountCents: cents, status: 'paid', gateway: 'raast', gatewayRef: ref, processedAt: new Date() },
  })
  if (opts.receipt === false) return { paymentId: payment.id, receiptId: null, ledgerCode: null, bankAccountId: null, ref }
  const account = await resolveRaastAccount(prisma, co.tenantId, conceptId)
  if (!account) throw new Error('no Raast account for the brand')
  const actor = (opts.who ?? cashierA).id
  const receipt = await prisma.raastReceipt.create({
    data: {
      tenantId: co.tenantId, orderId, conceptId, shiftId, paymentId: payment.id,
      bankAccountId: account.bankAccountId, ledgerCode: account.ledgerCode,
      amountCents: cents, tipCents: 0, dueCents: cents, bankRef: ref, bankRefRaw: ref,
      status: 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(), confirmedById: actor, cashierVerified: true,
      idempotencyKey: `pay:${payment.id}`, createdById: actor,
    },
  })
  return { paymentId: payment.id, receiptId: receipt.id, ledgerCode: account.ledgerCode, bankAccountId: account.bankAccountId, ref }
}

async function payCash(orderId: string, shiftId: string, cents: number) {
  return prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
}
async function payCard(orderId: string, shiftId: string, cents: number) {
  return prisma.payment.create({ data: { orderId, shiftId, method: 'card', amountCents: cents, status: 'paid', gatewayRef: `T-${nextRef()}`, processedAt: new Date() } })
}

/** A Raast refund row as the refund engine writes it (gatewayMeta.raast from chooseRaastRefundSourceTx). */
async function raastRefundRow(orderId: string, shiftId: string | null, cents: number, source: { receiptId: string; bankAccountId: string; ledgerCode: string } | null) {
  return prisma.payment.create({
    data: {
      orderId, shiftId, method: 'raast', amountCents: -cents, status: 'refunded', gateway: 'raast', gatewayRef: nextRef(), processedAt: new Date(),
      gatewayMeta: {
        refund: { reason: 'test', approverId: null, actorId: cashierA.id },
        ...(source && { raast: { receiptId: source.receiptId, bankAccountId: source.bankAccountId, ledgerCode: source.ledgerCode } }),
      },
    },
  })
}

async function closeAndPost(shiftId: string, countedCents: number): Promise<Line[]> {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
  return (await entry(shift.tenantId!, `shift.close:${shiftId}`))!
}

beforeAll(async () => {
  A = await mkCompany(`rl-a-${RUN.toLowerCase()}`)
  B = await mkCompany(`rl-b-${RUN.toLowerCase()}`)
  conceptA2 = (await prisma.concept.create({
    data: { name: `Brand two ${RUN}`, slug: `rl-a2-${RUN.toLowerCase()}`, type: 'restaurant', tenantId: A.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8, province: 'SD' },
  })).id
  cashierA = await mkUser(`rl-cashier-a-${RUN}`, 'cashier', A.tenantId)
  cashierB = await mkUser(`rl-cashier-b-${RUN}`, 'cashier', B.tenantId)
  // A: the company default on 1020; brand two has its own account on 1022.
  // B: its own default, ALSO on code 1020 — in B's chart.
  await mkRaastAccount(A, { code: '1020' })
  await mkRaastAccount(A, { code: '1022', forConceptId: conceptA2, isDefault: false })
  await mkRaastAccount(B, { code: '1020' })
}, 60_000)

describe('pure rules', () => {
  it('raastLedgerCodeOf: the receipt snapshot, else the refund row\'s gatewayMeta.raast — else 422 RAAST_ACCOUNT_UNKNOWN (never 1030)', () => {
    expect(raastLedgerCodeOf({ method: 'raast', raastReceipt: { ledgerCode: '1022' } })).toBe('1022')
    expect(raastLedgerCodeOf({ method: 'raast', gatewayMeta: { raast: { receiptId: 'r', bankAccountId: 'b', ledgerCode: '1021' } } })).toBe('1021')
    expect(raastLedgerCodeOf({ method: 'raast', raastReceipt: { ledgerCode: '1022' }, gatewayMeta: { raast: { ledgerCode: '1021' } } })).toBe('1022')
    expect(() => raastLedgerCodeOf({ id: 'pay_x', method: 'raast', gatewayMeta: { tipCents: 5 } })).toThrow(expect.objectContaining({ code: 'RAAST_ACCOUNT_UNKNOWN', statusCode: 422 }))
    expect(() => raastLedgerCodeOf({ method: 'raast', raastReceipt: { ledgerCode: '  ' } })).toThrow(expect.objectContaining({ code: 'RAAST_ACCOUNT_UNKNOWN' }))
  })

  it('refundCreditAccount: cash → drawer / cash on hand, card and the retired Keenu QR → 1030, Raast → the bank', () => {
    expect(refundCreditAccount({ method: 'cash', shiftId: 's1' })).toBe('1015')
    expect(refundCreditAccount({ method: 'cash', shiftId: null })).toBe('1010')
    expect(refundCreditAccount({ method: 'card', shiftId: 's1' })).toBe('1030')
    expect(refundCreditAccount({ method: 'keenu_qr', shiftId: null })).toBe('1030')
    expect(refundCreditAccount({ method: 'raast', shiftId: 's1', gatewayMeta: { raast: { ledgerCode: '1022' } } })).toBe('1022')
    expect(() => refundCreditAccount({ method: 'raast', shiftId: 's1', gatewayMeta: {} })).toThrow(expect.objectContaining({ code: 'RAAST_ACCOUNT_UNKNOWN' }))
  })
})

describe('the shift close', () => {
  it('debits the receiving bank per code (RAAST RECEIPTS), balanced, never 1030 — cash still 1015, tax at the stored figures', async () => {
    const s = await openDrawer(A, cashierA)
    const viaRaast = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8 })
    await payRaast(A, A.conceptId, viaRaast, s, 118_800)
    const viaCash = await order(A, A.conceptId, { items: 110_000, tax: 16_500, ratePct: 15 })
    await payCash(viaCash, s, 126_500)

    const lines = await closeAndPost(s, 126_500)
    expect(balanced(lines)).toBe(true)
    const bank = lines.filter((l) => l.code === '1020')
    expect(bank).toHaveLength(1)
    expect(bank[0]).toMatchObject({ type: 'debit', amount: 118_800 })
    expect(bank[0]!.memo.startsWith(`${RAAST_RECEIPTS_MEMO} — POS Raast sales (1)`)).toBe(true)
    expect(lines.some((l) => l.code === '1030')).toBe(false)
    expect(amt(lines, '1015', 'debit')).toBe(126_500)
    expect(amt(lines, revenueCodeForConcept(`brand-rl-a-${RUN.toLowerCase()}`), 'credit')).toBe(220_000)
    expect(amt(lines, '2032', 'credit')).toBe(25_300) // SD brand: 8,800 (Raast, card rate) + 16,500 (cash)
    // Every line in A's own chart.
    expect(lines.every((l) => l.tenantId === A.tenantId)).toBe(true)
  })

  it('two brands on two receiving accounts → two bank lines; the receipt snapshot decides, not today\'s mapping', async () => {
    const s = await openDrawer(A, cashierA)
    const o1 = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8 })
    await payRaast(A, A.conceptId, o1, s, 118_800)
    const o2 = await order(A, conceptA2, { items: 55_000, tax: 4_400, ratePct: 8 })
    const two = await payRaast(A, conceptA2, o2, s, 59_400)
    expect(two.ledgerCode).toBe('1022')
    const o3 = await order(A, A.conceptId, { items: 55_000, tax: 4_400, ratePct: 8 })
    await payRaast(A, A.conceptId, o3, s, 59_400)
    // Finance re-points brand two to another account AFTER the sale: the
    // money already went to 1022, and the books follow the receipt.
    const moved = await mkRaastAccount(A, { code: '1023', forConceptId: conceptA2, isDefault: false })
    expect((await resolveRaastAccount(prisma, A.tenantId, conceptA2))?.ledgerCode).toBe(moved.ledgerCode)

    const lines = await closeAndPost(s, 0)
    expect(balanced(lines)).toBe(true)
    const on1020 = lines.filter((l) => l.code === '1020' && l.type === 'debit')
    const on1022 = lines.filter((l) => l.code === '1022' && l.type === 'debit')
    expect(on1020).toHaveLength(1)
    expect(on1020[0]).toMatchObject({ amount: 178_200 })
    expect(on1020[0]!.memo).toContain('POS Raast sales (2)')
    expect(on1022).toHaveLength(1)
    expect(on1022[0]).toMatchObject({ amount: 59_400 })
    expect(lines.some((l) => l.code === '1023' || l.code === '1030')).toBe(false)
    // Put brand two back on 1022 for the rest of the suite.
    const back = await prisma.bankAccount.findFirstOrThrow({ where: { tenantId: A.tenantId, accountCode: '1022' } })
    await prisma.concept.update({ where: { id: conceptA2 }, data: { raastBankAccountId: back.id } })
  })

  it('A\'s close never touches B\'s chart: the same code in each company is its own account', async () => {
    const aBefore = await netDebit(A.tenantId, '1020')
    const s = await openDrawer(B, cashierB)
    const o = await order(B, B.conceptId, { items: 110_000, tax: 8_800, ratePct: 8 })
    const paid = await payRaast(B, B.conceptId, o, s, 118_800, { who: cashierB })
    const receipt = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: paid.receiptId! } })
    expect(receipt).toMatchObject({ tenantId: B.tenantId, ledgerCode: '1020' })
    const lines = await closeAndPost(s, 0)
    expect(balanced(lines)).toBe(true)
    expect(lines.every((l) => l.tenantId === B.tenantId)).toBe(true)
    expect(amt(lines, '1020', 'debit')).toBe(118_800)
    // A's bank is exactly where it was.
    expect(await netDebit(A.tenantId, '1020')).toBe(aBefore)
    // And every entry of A's books sits on A's accounts only.
    const foreign = await prisma.journalLine.count({ where: { journalEntry: { tenantId: A.tenantId }, account: { tenantId: { not: A.tenantId } } } })
    expect(foreign).toBe(0)
  })

  it('a cancelled ticket\'s Raast money: Dr bank / Cr 1110 refund due (no revenue, no tax); the hand-back Dr 1110 / Cr bank nets to zero', async () => {
    const s = await openDrawer(A, cashierA)
    const o = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8, status: 'cancelled' })
    const paid = await payRaast(A, A.conceptId, o, s, 118_800)
    const lines = await closeAndPost(s, 0)
    const tag = `(shift ${s.slice(0, 8)})`
    expect(balanced(lines)).toBe(true)
    const bank = lines.filter((l) => l.code === '1020')
    expect(bank).toHaveLength(1)
    expect(bank[0]).toMatchObject({ type: 'debit', amount: 118_800 })
    expect(bank[0]!.memo.startsWith(`${RAAST_RECEIPTS_MEMO} — REFUND DUE`)).toBe(true)
    expect(bank[0]!.memo).toContain(`#${orderRefOf(o)}`)
    expect(lines.filter((l) => l.code === '1110')).toEqual([expect.objectContaining({ type: 'credit', amount: 118_800, memo: refundDueMemo(o, tag) })])
    expect(lines.some((l) => l.code.startsWith('4') || l.code.startsWith('20') || l.code === '1030')).toBe(false)

    const before = await prisma.order.findUniqueOrThrow({ where: { id: o }, include: { payments: true } })
    expect(refundDueCents(before)).toBe(118_800)
    // The manager sends it back from the bank; the refund row names the receipt's account.
    const back = await raastRefundRow(o, null, 118_800, { receiptId: paid.receiptId!, bankAccountId: paid.bankAccountId!, ledgerCode: paid.ledgerCode! })
    const r = await postRefundPayment(back.id)
    expect(r.posted).toBe(true)
    const hb = (await entry(A.tenantId, `order.refund:${back.id}`))!
    expect(balanced(hb)).toBe(true)
    expect(hb.map((l) => [l.code, l.type, l.amount]).sort()).toEqual([['1020', 'credit', 118_800], ['1110', 'debit', 118_800]])
    // Net zero for the ticket on both accounts.
    const refs = [`shift.close:${s}`, `order.refund:${back.id}`]
    expect(await netDebit(A.tenantId, '1020', refs)).toBe(0)
    const ar = await prisma.journalLine.findMany({ where: { account: { tenantId: A.tenantId, code: '1110' }, memo: { contains: o } }, select: { type: true, amountCents: true } })
    expect(ar.reduce((t, l) => t + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)).toBe(0)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o }, include: { payments: true } })
    expect(refundDueCents(after)).toBe(0)
  })
})

describe('order completion and refunds', () => {
  it('a non-till order\'s completion debits the bank (RAAST RECEIPTS), the rest 1030 — and the drawer that took it books no second Raast line', async () => {
    const s = await openDrawer(A, cashierA)
    const o = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8, source: 'servd' })
    await payRaast(A, A.conceptId, o, s, 100_000)
    await payCard(o, s, 18_800)
    const r = await postOrderCompletion(o)
    expect(r.posted).toBe(true)
    const lines = (await entry(A.tenantId, `order.complete:${o}`))!
    expect(balanced(lines)).toBe(true)
    const bank = lines.filter((l) => l.code === '1020')
    expect(bank).toEqual([expect.objectContaining({ type: 'debit', amount: 100_000 })])
    expect(bank[0]!.memo).toBe(`${RAAST_RECEIPTS_MEMO} — brand-rl-a-${RUN.toLowerCase()} #${orderRefOf(o)}`)
    expect(amt(lines, '1030', 'debit')).toBe(18_800)
    expect(lines.every((l) => l.tenantId === A.tenantId)).toBe(true)

    // A till sale on the same drawer so the close posts; it books no Raast for the online order.
    const till = await order(A, A.conceptId, { items: 110_000, tax: 16_500, ratePct: 15 })
    await payCash(till, s, 126_500)
    const close = await closeAndPost(s, 126_500)
    expect(close.some((l) => l.code === '1020')).toBe(false)
    expect(balanced(close)).toBe(true)
  })

  it('a non-till order overpaid by Raast is capped at the charged total (the entry still balances)', async () => {
    const o = await order(A, A.conceptId, { items: 55_000, tax: 4_400, ratePct: 8, source: 'servd' })
    await payRaast(A, A.conceptId, o, null, 60_000)
    expect((await postOrderCompletion(o)).posted).toBe(true)
    const lines = (await entry(A.tenantId, `order.complete:${o}`))!
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '1020', 'debit')).toBe(59_400)
    expect(lines.some((l) => l.code === '1030')).toBe(false)
  })

  it('a Raast refund credits the bank it went back from (never 1030); without a code on the row it is refused and nothing posts', async () => {
    const s = await openDrawer(A, cashierA)
    const o = await order(A, conceptA2, { items: 110_000, tax: 8_800, ratePct: 8 })
    const paid = await payRaast(A, conceptA2, o, s, 118_800)
    expect(paid.ledgerCode).toBe('1022')
    await closeAndPost(s, 0)
    const part = await raastRefundRow(o, null, 59_400, { receiptId: paid.receiptId!, bankAccountId: paid.bankAccountId!, ledgerCode: paid.ledgerCode! })
    expect((await postRefundPayment(part.id)).posted).toBe(true)
    const lines = (await entry(A.tenantId, `order.refund:${part.id}`))!
    expect(balanced(lines)).toBe(true)
    expect(lines.filter((l) => l.type === 'credit')).toEqual([expect.objectContaining({ code: '1022', amount: 59_400 })])
    expect(lines.some((l) => l.code === '1030')).toBe(false)
    // Half the sale back: half of its revenue and tax.
    expect(amt(lines, '2032', 'debit')).toBe(4_400)
    expect(amt(lines, revenueCodeForConcept(`rl-a2-${RUN.toLowerCase()}`), 'debit')).toBe(55_000)

    const bad = await raastRefundRow(o, null, 1_000, null)
    await expect(postRefundPayment(bad.id)).rejects.toMatchObject({ code: 'RAAST_ACCOUNT_UNKNOWN' })
    expect(await entry(A.tenantId, `order.refund:${bad.id}`)).toBeNull()
  })
})

describe('a Raast row with no receiving-bank code on record', () => {
  it('the summary still reads (Z-report), the close is refused (RAAST_ACCOUNT_UNKNOWN), the backfill lists it and carries on', async () => {
    const s = await openDrawer(A, cashierA)
    const o = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8 })
    const paid = await payRaast(A, A.conceptId, o, s, 118_800, { receipt: false })
    const rows = await prisma.payment.findMany({ where: { shiftId: s }, include: SHIFT_SALE_PAYMENT_INCLUDE })
    const sum = summariseShiftSales(s, rows)
    expect(sum.raastUnknown).toEqual([{ paymentId: paid.paymentId, orderId: o, cents: 118_800 }])
    expect(sum.cardPaidCents).toBe(0)
    expect(sum.raastByCode.size).toBe(0)

    await prisma.shift.update({ where: { id: s }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await expect(buildShiftCloseEntry(s)).rejects.toMatchObject({ code: 'RAAST_ACCOUNT_UNKNOWN' })
    await expect(postShiftClose(s)).rejects.toMatchObject({ code: 'RAAST_ACCOUNT_UNKNOWN' })
    expect(await entry(A.tenantId, `shift.close:${s}`)).toBeNull()

    // Another closed drawer of A with nothing wrong still posts in the same backfill run.
    const ok = await openDrawer(A, cashierA)
    const okOrder = await order(A, A.conceptId, { items: 110_000, tax: 16_500, ratePct: 15 })
    await payCash(okOrder, ok, 126_500)
    await prisma.shift.update({ where: { id: ok }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 126_500 } })
    const bf = await backfillUnpostedShifts({ tenantIds: [A.tenantId], dryRun: false, postedBy: 'test' })
    expect(bf.rows.find((r) => r.shiftId === s)).toMatchObject({ outcome: 'error', tenantId: A.tenantId })
    expect(bf.rows.find((r) => r.shiftId === s)!.detail).toContain(paid.paymentId)
    expect(bf.rows.find((r) => r.shiftId === ok)?.outcome).toBe('posted')
    // B's backfill never sees A's drawer.
    const bfB = await backfillUnpostedShifts({ tenantIds: [B.tenantId], dryRun: true })
    expect(bfB.rows.some((r) => r.shiftId === s)).toBe(false)
  })

  it('a cancelled ticket\'s Raast row with no code refuses the close too', async () => {
    const s = await openDrawer(A, cashierA)
    const o = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8, status: 'cancelled' })
    await payRaast(A, A.conceptId, o, s, 118_800, { receipt: false })
    await prisma.shift.update({ where: { id: s }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await expect(postShiftClose(s)).rejects.toMatchObject({ code: 'RAAST_ACCOUNT_UNKNOWN' })
  })

  it('the till close flags posting_failed for the drawer\'s company (never silently 1030)', async () => {
    const { closeShift } = await import('../src/modules/pos/service.js')
    const s = await openDrawer(A, cashierA)
    const o = await order(A, A.conceptId, { items: 110_000, tax: 8_800, ratePct: 8 })
    await payRaast(A, A.conceptId, o, s, 118_800, { receipt: false })
    await closeShift(s, 0)
    const flag = await waitFor(
      () => prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityType: 'Shift', entityId: s } }),
      (f) => f !== null,
    )
    expect(flag).toMatchObject({ tenantId: A.tenantId, severity: 'high' })
    expect(flag!.description).toContain('no receiving bank account on record')
    expect(await entry(A.tenantId, `shift.close:${s}`)).toBeNull()
    expect(await prisma.journalLine.count({ where: { account: { tenantId: A.tenantId, code: '1030' }, journalEntry: { tenantId: A.tenantId, reference: `shift.close:${s}` } } })).toBe(0)
  })

  it('a non-till completion with no code is refused and flagged (postCompletionOrFlag), never 1030', async () => {
    const { postCompletionOrFlag } = await import('../src/modules/orders/service.js')
    const o = await order(A, A.conceptId, { items: 55_000, tax: 4_400, ratePct: 8, source: 'servd' })
    await payRaast(A, A.conceptId, o, null, 59_400, { receipt: false })
    const r = await postCompletionOrFlag(o)
    expect(r.posted).toBe(false)
    expect(r.reason).toContain('no receiving bank account on record')
    expect(await entry(A.tenantId, `order.complete:${o}`)).toBeNull()
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityType: 'Order', entityId: o } })
    expect(flag?.tenantId).toBe(A.tenantId)
  })
})

// ─── End to end through the till (stream B's routes and refund engine) ────────

describe('end to end: ring → Raast at the till → close → refund', () => {
  let app: FastifyInstance
  let mgrA: Who
  beforeAll(async () => {
    app = await buildApp()
    mgrA = await mkUser(`rl-mgr-a-${RUN}`, 'foh_management', A.tenantId)
    await setManagerPin(mgrA.id, '7319')
  }, 60_000)
  afterAll(async () => { await app?.close() })

  it('a Raast payment completes the sale, the close debits the receiving bank, a manager\'s Raast refund credits it; fiscal tenders say raast', async () => {
    const call = caller(app)
    const drawer = await openDrawer(A, cashierA)
    const ring = await ringKheer(app, cashierA, A)
    const quote = await call(cashierA, 'GET', `/pos/orders/${ring.id}/quote?method=raast`)
    expect(quote.statusCode).toBe(200)
    const due = quote.json().dueCents as number
    expect(due).toBe(118_800) // 2 × Kheer at the card (digital) rate

    const pay = await call(cashierA, 'POST', '/pos/payments', {
      orderId: ring.id, shiftId: drawer, idempotencyKey: `raast-e2e-${RUN}`,
      payments: [{ method: 'raast', amountCents: due, gatewayRef: `mz-${RUN}-4471-0093`, raastVerified: true }],
    })
    expect([200, 201]).toContain(pay.statusCode)
    const p = await prisma.payment.findFirstOrThrow({ where: { orderId: ring.id, method: 'raast', status: 'paid' }, include: { raastReceipt: true } })
    expect(p.gateway).toBe('raast')
    expect(p.raastReceipt).toMatchObject({ tenantId: A.tenantId, ledgerCode: '1020', status: 'provisional' })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ring.id } })).status).toBe('completed')

    const close = await call(cashierA, 'POST', `/pos/shifts/${drawer}/close`, { closingFloatCents: 0 })
    expect(close.statusCode).toBe(200)
    const lines = await waitFor(() => entry(A.tenantId, `shift.close:${drawer}`), (l) => l !== null)
    expect(lines).not.toBeNull()
    expect(balanced(lines!)).toBe(true)
    expect(amt(lines!, '1020', 'debit')).toBe(due)
    expect(lines!.some((l) => l.code === '1030')).toBe(false)

    // A manager sends 500.00 back from the bank and types the outgoing transfer's reference.
    await openDrawer(A, mgrA)
    const refund = await call(mgrA, 'POST', `/pos/orders/${ring.id}/refund`, {
      amountCents: 50_000, reason: 'Kheer was cold', method: 'raast', gatewayRef: `OUT${RUN}88812`,
    })
    expect(refund.statusCode).toBe(200)
    const row = await prisma.payment.findFirstOrThrow({ where: { orderId: ring.id, status: 'refunded' } })
    expect(row.method).toBe('raast')
    const back = (await entry(A.tenantId, `order.refund:${row.id}`))!
    expect(balanced(back)).toBe(true)
    expect(back.filter((l) => l.type === 'credit')).toEqual([expect.objectContaining({ code: '1020', amount: 50_000 })])

    // Fiscal: the sale's tender is raast (mode card); the return goes back by raast.
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId: ring.id }, orderBy: { createdAt: 'asc' } })
    const sale = docs.find((d) => d.kind === 'sale')
    expect(sale).toBeDefined()
    const salePayment = (sale!.payload as { payment: { mode: string; tenders: Array<{ method: string; amountCents: number }> } }).payment
    expect(salePayment).toEqual({ mode: 'card', tenders: [{ method: 'raast', amountCents: due }] })
    const ret = docs.find((d) => d.kind === 'refund')
    expect((ret!.payload as { payment: { tenders: Array<{ method: string }> } }).payment.tenders[0]!.method).toBe('raast')
  })
})

describe('after the CEO\'s till-clearing cut-over (1110 → 1115)', () => {
  it('a cancelled ticket\'s Raast money is held on 1115 and the hand-back clears 1115; 1110 untouched; another company still on 1110', async () => {
    const { cutoverTillClearing } = await import('../src/modules/accounting/tillClearing.js')
    const K = await mkCompany(`rl-k-${RUN.toLowerCase()}`)
    const cashierK = await mkUser(`rl-cashier-k-${RUN}`, 'cashier', K.tenantId)
    await mkRaastAccount(K, { code: '1020' })
    const cut = await cutoverTillClearing(K.tenantId, cashierK.id, { reason: 'test cut-over of K' })
    expect(cut.status).toBe('cut_over')

    const s = await openDrawer(K, cashierK)
    const o = await order(K, K.conceptId, { items: 110_000, tax: 8_800, ratePct: 8, status: 'cancelled' })
    const paid = await payRaast(K, K.conceptId, o, s, 118_800, { who: cashierK })
    const lines = await closeAndPost(s, 0)
    const tag = `(shift ${s.slice(0, 8)})`
    expect(balanced(lines)).toBe(true)
    expect(lines.filter((l) => l.code === '1115')).toEqual([expect.objectContaining({ type: 'credit', amount: 118_800, memo: refundDueMemo(o, tag) })])
    expect(lines.some((l) => l.code === '1110')).toBe(false)

    const back = await raastRefundRow(o, null, 118_800, { receiptId: paid.receiptId!, bankAccountId: paid.bankAccountId!, ledgerCode: paid.ledgerCode! })
    expect((await postRefundPayment(back.id)).posted).toBe(true)
    const hb = (await entry(K.tenantId, `order.refund:${back.id}`))!
    expect(hb.map((l) => [l.code, l.type, l.amount]).sort()).toEqual([['1020', 'credit', 118_800], ['1115', 'debit', 118_800]])
    expect(await netDebit(K.tenantId, '1115')).toBe(0)
    expect(await netDebit(K.tenantId, '1110')).toBe(0)
    // A has no marker: its new till clearing stays on 1110.
    const { tillClearingCodeTx } = await import('../src/modules/accounting/tillClearingCode.js')
    expect(await tillClearingCodeTx(prisma, A.tenantId)).toBe('1110')
  })
})
