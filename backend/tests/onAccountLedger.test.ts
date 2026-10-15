// On-account clients — the ledger formulas (2026-10-15, parked B resumed).
//
//   • A till bill charged to a named client (Payment.method 'on_account',
//     gatewayMeta.onAccount {accountId, number, name}) is debited at the shift
//     close to 1110 Customer receivable, ONE line per client, memo'd
//     ON_ACCOUNT_MEMO with the client and the order refs. Revenue and tax are
//     exactly what the same bill paid in cash books. Never 1030, never drawer
//     cash.
//   • A non-till bill's order.complete debits 1110 the same way.
//   • A refund of an on-account bill goes back to the account: Cr 1110,
//     memo'd ON_ACCOUNT_MEMO.
//   • An on-account bill earns no loyalty points (decision OA-LOYALTY).
//   • Till clearing (unsettled bills, refund due, card failed after close) is
//     tillClearingCodeTx: 1110 with no cut-over marker, 1115 once the
//     company's Setting `ledger.tillClearingCutoverAt:<tenantId>` exists —
//     per company; the on-account debit stays on 1110 either way.
//   • Company B's books are never touched by company A's clients.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ON_ACCOUNT_MEMO } from '../src/modules/accounting/journal.js'
import { tillClearingCodeTx, tillClearingCutoverKey } from '../src/modules/accounting/tillClearingCode.js'
import { postOrderCompletion, postRefundPayment, refundDueCents, refundCreditAccount } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose, summariseShiftSales, SHIFT_SALE_PAYMENT_INCLUDE } from '../src/modules/accounting/shiftPosting.js'
import { awardOrderPoints } from '../src/modules/loyalty/service.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string, slugA: string
let clientA1: { id: string; number: string; legalName: string }
let clientA2: { id: string; number: string; legalName: string }
let clientB1: { id: string; number: string; legalName: string }
let cashierSeq = 0

type Line = { code: string; type: string; amount: number; memo: string; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '', conceptId: l.conceptId }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)
const codes = (lines: Line[]) => [...new Set(lines.map((l) => l.code))].sort()
const ref8 = (id: string) => id.slice(-8).toUpperCase()

async function mkClient(tenantId: string, number: string, legalName: string) {
  const u = await prisma.user.findFirstOrThrow({ where: { tenantId } })
  return prisma.customerAccount.create({
    data: { tenantId, number, legalName, creditLimitCents: 10_000_000, status: 'active', createdById: u.id, approvedById: u.id, approvedAt: new Date() },
    select: { id: true, number: true, legalName: true },
  })
}
async function freshShift(tenantId: string) {
  const u = await prisma.user.create({
    data: { name: `till${++cashierSeq}`, email: `till${cashierSeq}.${RUN}@onaccount.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents: 0, status: 'open', tenantId } })
}
async function mkOrder(conceptId: string, o: { source?: 'pos' | 'servd'; items: number; tax: number; customerId?: string }) {
  return prisma.order.create({
    data: {
      conceptId, source: o.source ?? 'pos', status: 'completed', completedAt: new Date(), fulfilmentType: 'dine_in',
      totalCents: o.items + o.tax, taxCents: o.tax, taxRatePct: 15, customerId: o.customerId ?? null,
      items: { create: [{ name: 'Lunch', quantity: 1, unitPriceCents: o.items }] },
    },
  })
}
/** What the till's on-account route writes: one paid on_account Payment + its CustomerAccountCharge. */
async function chargeToClient(
  tenantId: string,
  order: { id: string; conceptId: string; totalCents: number; taxCents: number },
  client: { id: string; number: string; legalName: string },
  shiftId: string | null,
) {
  const u = await prisma.user.findFirstOrThrow({ where: { tenantId } })
  const payment = await prisma.payment.create({
    data: {
      orderId: order.id, shiftId, method: 'on_account', status: 'paid', amountCents: order.totalCents, processedAt: new Date(),
      gatewayRef: client.number,
      gatewayMeta: { idempotencyKey: `k-${order.id}`, onAccount: { accountId: client.id, cardId: null, number: client.number, name: client.legalName, reference: null } },
    },
  })
  await prisma.customerAccountCharge.create({
    data: {
      tenantId, accountId: client.id, orderId: order.id, paymentId: payment.id, conceptId: order.conceptId, shiftId,
      amountCents: order.totalCents, taxCents: order.taxCents, chargedById: u.id,
    },
  })
  return payment
}
async function closeAndPost(shiftId: string, countedCents: number) {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
  return (await entry(shift.tenantId!, `shift.close:${shiftId}`))!
}
async function companyLineCount(tenantId: string) {
  return prisma.journalLine.count({ where: { journalEntry: { tenantId } } })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'OA A', slug: `oa-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'OA B', slug: `oa-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) {
    await ensureChartOfAccounts(t)
    await prisma.user.create({
      data: { name: `fin-${t.slice(0, 4)}`, email: `fin.${t}.${RUN}@onaccount.test`, password: 'x', role: 'finance', isActive: true, accountStatus: 'active', tenantId: t },
    })
  }
  slugA = `oa-sd-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'OA Karachi', slug: slugA, type: 'restaurant', tenantId: tenantA, province: 'SD' } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'OA Other', slug: `oa-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  clientA1 = await mkClient(tenantA, 'OA-0001', `Acme Ltd ${RUN}`)
  clientA2 = await mkClient(tenantA, 'OA-0002', `Bolt Pvt ${RUN}`)
  clientB1 = await mkClient(tenantB, 'OA-0001', `Crest Co ${RUN}`)
}, 60_000)

describe('a till on-account bill at the shift close', () => {
  let shiftId: string
  let orders: Array<{ id: string }>
  let close: Line[]
  let bLinesBefore: number

  it('posts Dr 1110 per client with the ON ACCOUNT memo and balances; nothing on 1030 or the drawer', async () => {
    bLinesBefore = await companyLineCount(tenantB)
    const shift = await freshShift(tenantA)
    shiftId = shift.id
    const o1 = await mkOrder(conceptA, { items: 100_000, tax: 15_000 })
    const o2 = await mkOrder(conceptA, { items: 40_000, tax: 6_000 })
    const o3 = await mkOrder(conceptA, { items: 20_000, tax: 3_000 })
    orders = [o1, o2, o3]
    await chargeToClient(tenantA, o1, clientA1, shift.id)
    await chargeToClient(tenantA, o2, clientA1, shift.id)
    await chargeToClient(tenantA, o3, clientA2, shift.id)

    // The pure summary: on-account, never cash or card.
    const payments = await prisma.payment.findMany({ where: { shiftId: shift.id }, include: SHIFT_SALE_PAYMENT_INCLUDE })
    const s = summariseShiftSales(shift.id, payments)
    expect(s.onAccount.cents).toBe(184_000)
    expect(s.onAccount.byAccount.get(clientA1.id)).toMatchObject({ number: 'OA-0001', cents: 161_000 })
    expect(s.onAccount.byAccount.get(clientA1.id)!.orderIds.sort()).toEqual([o1.id, o2.id].sort())
    expect(s.onAccount.byAccount.get(clientA2.id)).toMatchObject({ number: 'OA-0002', cents: 23_000, orderIds: [o3.id] })
    expect(s.cashCents + s.cardPaidCents + s.cardAwaitingCents + s.unsettledCents + s.nonTillCashCents).toBe(0)

    close = await closeAndPost(shift.id, 0)
    expect(side(close, 'debit')).toBe(side(close, 'credit'))
    const oa = close.filter((l) => l.code === '1110' && l.type === 'debit')
    expect(oa).toHaveLength(2)
    const one = oa.find((l) => l.memo.includes('OA-0001'))!
    expect(one.amount).toBe(161_000)
    expect(one.memo.startsWith(`${ON_ACCOUNT_MEMO} — OA-0001 Acme Ltd ${RUN} — `)).toBe(true)
    expect(one.memo).toContain(`#${ref8(o1.id)}`)
    expect(one.memo).toContain(`#${ref8(o2.id)}`)
    const two = oa.find((l) => l.memo.includes('OA-0002'))!
    expect(two.amount).toBe(23_000)
    expect(two.memo).toContain(`#${ref8(o3.id)}`)
    expect(amt(close, '1110', 'credit')).toBe(0)
    expect(codes(close)).not.toContain('1030')
    expect(codes(close)).not.toContain('1015')
    expect(codes(close)).not.toContain('1115')
    expect(codes(close)).not.toContain('8010')
  })

  it('revenue and tax are exactly what the same bills paid in cash book', async () => {
    const shift = await freshShift(tenantA)
    let total = 0
    for (const [items, tax] of [[100_000, 15_000], [40_000, 6_000], [20_000, 3_000]] as const) {
      const o = await mkOrder(conceptA, { items, tax })
      await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', status: 'paid', amountCents: items + tax, processedAt: new Date() } })
      total += items + tax
    }
    const cash = await closeAndPost(shift.id, total)
    for (const code of ['4010', '4020', '4030', '4040', '4050', '2030', '2032', '4100', '2095', '7010']) {
      expect(amt(close, code, 'credit')).toBe(amt(cash, code, 'credit'))
      expect(amt(close, code, 'debit')).toBe(amt(cash, code, 'debit'))
    }
    expect(amt(close, '2032', 'credit')).toBe(24_000)
    expect(amt(cash, '1015', 'debit')).toBe(amt(close, '1110', 'debit'))
  })

  it('a refund of an on-account bill goes back to the account: Cr 1110, memo\'d ON ACCOUNT', async () => {
    const o1 = orders[0]!
    const next = await freshShift(tenantA)
    const refund = await prisma.payment.create({
      data: { orderId: o1.id, shiftId: next.id, method: 'on_account', status: 'refunded', amountCents: -23_000, processedAt: new Date(), gatewayRef: clientA1.number },
    })
    expect(refundCreditAccount(refund)).toBe('1110')
    const r = await postRefundPayment(refund.id)
    expect(r.posted).toBe(true)
    const lines = (await entry(tenantA, `order.refund:${refund.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '1110', 'credit')).toBe(23_000)
    expect(lines.find((l) => l.code === '1110')!.memo.startsWith(`${ON_ACCOUNT_MEMO} — `)).toBe(true)
    // Revenue and SRB output tax come off, as for any refund.
    expect(amt(lines, '2032', 'debit')).toBe(3_000)
    expect(codes(lines)).not.toContain('1030')
    expect(codes(lines)).not.toContain('1015')

    // The next drawer's close never books it again (no 7040 / 1030 line).
    await prisma.shift.update({ where: { id: next.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await postShiftClose(next.id)
    const nextClose = await entry(tenantA, `shift.close:${next.id}`)
    if (nextClose) {
      expect(amt(nextClose, '7040', 'debit')).toBe(0)
      expect(codes(nextClose)).not.toContain('1030')
    }
  })

  it('company B\'s books are untouched', async () => {
    expect(await companyLineCount(tenantB)).toBe(bLinesBefore)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `shift.close:${shiftId}` } })).toBe(0)
  })
})

describe('a non-till on-account bill', () => {
  it('order.complete debits 1110 with the ON ACCOUNT memo, never 1030', async () => {
    const o = await mkOrder(conceptA, { source: 'servd', items: 50_000, tax: 7_500 })
    await chargeToClient(tenantA, o, clientA2, null)
    const r = await postOrderCompletion(o.id)
    expect(r.posted).toBe(true)
    const lines = (await entry(tenantA, `order.complete:${o.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '1110', 'debit')).toBe(57_500)
    const l = lines.find((x) => x.code === '1110')!
    expect(l.memo.startsWith(`${ON_ACCOUNT_MEMO} — OA-0002 Bolt Pvt ${RUN} — ${slugA} #${ref8(o.id)}`)).toBe(true)
    expect(l.conceptId).toBe(conceptA)
    expect(amt(lines, '2032', 'credit')).toBe(7_500)
    expect(codes(lines)).not.toContain('1030')
    expect(codes(lines)).not.toContain('1010')
  })

  it('company B\'s client bills land only in B', async () => {
    const o = await mkOrder(conceptB, { source: 'servd', items: 10_000, tax: 1_500 })
    await chargeToClient(tenantB, o, clientB1, null)
    expect((await postOrderCompletion(o.id)).posted).toBe(true)
    expect(await entry(tenantA, `order.complete:${o.id}`)).toBeNull()
    const lines = (await entry(tenantB, `order.complete:${o.id}`))!
    expect(amt(lines, '1110', 'debit')).toBe(11_500)
  })
})

describe('no refund due and no loyalty for on-account', () => {
  it('a cancelled on-account ticket is no refund due, and the close books nothing for it', async () => {
    const shift = await freshShift(tenantA)
    const o = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'received', totalCents: 11_500, taxCents: 1_500, taxRatePct: 15,
        items: { create: [{ name: 'Lunch', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await chargeToClient(tenantA, o, clientA1, shift.id)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled', cancelledAt: new Date() } })
    const withPayments = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } })
    expect(refundDueCents(withPayments)).toBe(0)
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    const r = await postShiftClose(shift.id)
    expect(r.posted).toBe(false)
  })

  it('an on-account bill earns no points; the same bill paid in cash does', async () => {
    const cust = await prisma.customer.create({ data: { name: 'Diner', phone: `+92300${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}` } })
    const oa = await mkOrder(conceptA, { source: 'servd', items: 10_000, tax: 1_500, customerId: cust.id })
    await chargeToClient(tenantA, oa, clientA1, null)
    expect(await awardOrderPoints(oa.id)).toBeNull()
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: oa.id } })).toBe(0)

    const cash = await mkOrder(conceptA, { source: 'servd', items: 10_000, tax: 1_500, customerId: cust.id })
    await prisma.payment.create({ data: { orderId: cash.id, method: 'cash', status: 'paid', amountCents: 11_500, processedAt: new Date() } })
    const earned = await awardOrderPoints(cash.id)
    expect(earned).not.toBeNull()
  })
})

// Last: the marker for A changes every later till-clearing posting in A.
describe('till clearing follows the company\'s cut-over marker', () => {
  it('1110 with no marker; 1115 once A is cut over — B stays on 1110', async () => {
    expect(await tillClearingCodeTx(prisma, tenantA)).toBe('1110')
    expect(await tillClearingCodeTx(prisma, tenantB)).toBe('1110')
    await prisma.setting.create({ data: { key: tillClearingCutoverKey(tenantA), value: new Date().toISOString() } })
    expect(await tillClearingCodeTx(prisma, tenantA)).toBe('1115')
    expect(await tillClearingCodeTx(prisma, tenantB)).toBe('1110')
  })

  it('after the cut-over an unsettled bill goes to 1115; the on-account debit stays on 1110', async () => {
    const shift = await freshShift(tenantA)
    const charged = await mkOrder(conceptA, { items: 20_000, tax: 3_000 })
    await chargeToClient(tenantA, charged, clientA1, shift.id)
    // Half a split paid in cash here; the rest is still open.
    const split = await mkOrder(conceptA, { items: 20_000, tax: 3_000 })
    await prisma.payment.create({ data: { orderId: split.id, shiftId: shift.id, method: 'cash', status: 'paid', amountCents: 11_500, processedAt: new Date() } })
    const lines = await closeAndPost(shift.id, 11_500)
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '1115', 'debit')).toBe(11_500)
    expect(amt(lines, '1110', 'debit')).toBe(23_000)
    expect(lines.find((l) => l.code === '1110')!.memo.startsWith(ON_ACCOUNT_MEMO)).toBe(true)
  })

  it('after the cut-over a cancelled ticket\'s refund due sits on 1115 and its hand-back clears 1115', async () => {
    const shift = await freshShift(tenantA)
    const o = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'received', totalCents: 23_000, taxCents: 3_000, taxRatePct: 15,
        items: { create: [{ name: 'Lunch', quantity: 1, unitPriceCents: 20_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', status: 'paid', amountCents: 23_000, processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled', cancelledAt: new Date() } })
    const close = await closeAndPost(shift.id, 23_000)
    expect(amt(close, '1115', 'credit')).toBe(23_000)
    expect(amt(close, '1110', 'credit')).toBe(0)

    const next = await freshShift(tenantA)
    const back = await prisma.payment.create({
      data: { orderId: o.id, shiftId: next.id, method: 'cash', status: 'refunded', amountCents: -23_000, processedAt: new Date() },
    })
    expect((await postRefundPayment(back.id)).posted).toBe(true)
    const lines = (await entry(tenantA, `order.refund:${back.id}`))!
    expect(amt(lines, '1115', 'debit')).toBe(23_000)
    expect(amt(lines, '1015', 'credit')).toBe(23_000)
    expect(codes(lines)).not.toContain('2032')
  })

  it('company B, not cut over, still holds a refund due on 1110', async () => {
    const shift = await freshShift(tenantB)
    const o = await prisma.order.create({
      data: {
        conceptId: conceptB, source: 'pos', status: 'received', totalCents: 11_500, taxCents: 1_500, taxRatePct: 15,
        items: { create: [{ name: 'Lunch', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', status: 'paid', amountCents: 11_500, processedAt: new Date() } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled', cancelledAt: new Date() } })
    const close = await closeAndPost(shift.id, 11_500)
    expect(amt(close, '1110', 'credit')).toBe(11_500)
    expect(codes(close)).not.toContain('1115')
  })
})
