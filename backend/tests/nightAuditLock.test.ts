// Night audit day lock — SALES postings only (owner, 2026-10-16: "Night
// run/Audit/Day close is only for sales module"). A sales posting dated into
// an audited / closed day is refused (422 DAY_AUDITED) in that company only;
// every other module's posting (supplier bill, petty cash, manual journal,
// payroll, depreciation, card payout, bank adjustment) posts as before. The
// late-dating helpers move a sales posting out of a locked day to today with
// a note; a reopened day takes dated postings again.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { AppError } from '../src/lib/errors.js'
import { postJournalEntry, lateDatingFor } from '../src/modules/accounting/journal.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { backfillUnpostedShifts } from '../src/modules/accounting/shiftPosting.js'
import { SALES_SOURCES, SALES_SOURCE_PREFIXES, isSalesSource, salesReferenceSqlPatterns } from '../src/modules/nightAudit/lock.js'
import { reopenDay } from '../src/modules/nightAudit/service.js'

let A: string
let B: string
let conceptA: string
let ceoId: string
const DAY_MS = 86_400_000
const yesterday = fmtPktDate(new Date(Date.now() - DAY_MS))
const today = fmtPktDate(new Date())
// 13:00 PKT on yesterday's date.
const atYesterday = new Date(`${yesterday}T13:00:00+05:00`)

const lines = (debit = '1015', credit = '4001', cents = 10_000) => [
  { accountCode: debit, type: 'debit' as const, amountCents: cents },
  { accountCode: credit, type: 'credit' as const, amountCents: cents },
]

async function lockDay(tenantId: string, day: string, status: 'audited' | 'closed' = 'audited') {
  await prisma.nightAuditDay.upsert({
    where: { tenantId_businessDate: { tenantId, businessDate: day } },
    create: { tenantId, businessDate: day, status, auditedAt: new Date(), auditedById: ceoId, ...(status === 'closed' ? { closedAt: new Date(), closedVia: 'manual' } : {}) },
    update: { status, auditedAt: new Date(), auditedById: ceoId, ...(status === 'closed' ? { closedAt: new Date(), closedVia: 'manual' } : {}) },
  })
}

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  try { await p; return null } catch (err) { return err as AppError }
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Lock Foods', slug: 'nal-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Lock Viva', slug: 'nal-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer L', slug: 'simmer', type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  ceoId = (await prisma.user.create({ data: { name: 'CEO', email: 'ceo.nal@gsfoods.pk', password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId: A } })).id
  await prisma.tenantMember.create({ data: { tenantId: A, userId: ceoId } })
  await lockDay(A, yesterday)
})

describe('the sales-source list', () => {
  it('is exactly the owner\'s sales module', () => {
    expect([...SALES_SOURCES].sort()).toEqual([
      'cod.rider_debt', 'cod.rider_debt.reversal', 'deposit.drop', 'loyalty.earn', 'loyalty.redeem', 'order', 'raast.unreceived', 'shift.close',
    ])
    expect([...SALES_SOURCE_PREFIXES]).toEqual(['order.', 'order_item.', 'pos.'])
    for (const s of ['order.complete', 'order.refund', 'order.cancel_unwind', 'order_item.box_given', 'pos.card_failed', 'pos.void_waste', 'shift.close', 'deposit.drop']) {
      expect(isSalesSource(s), s).toBe(true)
    }
    for (const s of ['card.settlement', 'reconciliation.adjustment', 'pettycash.till_topup', 'ledger.till_clearing_split', 'ic.transfer',
      'giftcard.issue', 'supplier.bill', 'manual', 'hr.payroll.accrual', 'fixed_asset.depreciation', 'pettycash.spend', 'reservation', 'reservation.deposit_capture', 'loyalty.expire']) {
      expect(isSalesSource(s), s).toBe(false)
    }
    expect(salesReferenceSqlPatterns()).toContain('order\\_item.%')
  })
})

describe('postJournalEntry refuses a SALES posting into a locked day', () => {
  it('order.complete, shift.close and deposit.drop dated into an audited day → 422 DAY_AUDITED', async () => {
    for (const [sourceType, debit] of [['order.complete', '1015'], ['shift.close', '1015'], ['deposit.drop', '1020']] as const) {
      const err = await refusal(postJournalEntry({ tenantId: A, sourceType, sourceId: `x-${sourceType}`, description: 't', entryDate: atYesterday, lines: lines(debit, sourceType === 'deposit.drop' ? '1015' : '4001') }))
      expect(err?.code, sourceType).toBe('DAY_AUDITED')
      expect(err?.statusCode).toBe(422)
      expect(err?.details).toEqual({ day: yesterday, status: 'audited' })
    }
    // A closed day is locked too.
    const twoAgo = fmtPktDate(new Date(Date.now() - 2 * DAY_MS))
    await lockDay(A, twoAgo, 'closed')
    const err = await refusal(postJournalEntry({ tenantId: A, sourceType: 'order.refund', sourceId: 'r-closed', description: 't', entryDate: new Date(`${twoAgo}T12:00:00+05:00`), lines: lines('4001', '1015') }))
    expect(err?.details).toEqual({ day: twoAgo, status: 'closed' })
  })

  it('company B on the same date posts (its day is not locked)', async () => {
    const r = await postJournalEntry({ tenantId: B, sourceType: 'order.complete', sourceId: 'b-order', description: 't', entryDate: atYesterday, lines: lines() })
    expect(r.posted).toBe(true)
  })

  it('every other module posts into the audited day as before', async () => {
    const others: Array<[string, string, string]> = [
      ['supplier.bill', '5010', '2010'], ['pettycash.spend', '6170', '1011'], ['manual', '6170', '1010'],
      ['hr.payroll.accrual', '6030', '2020'], ['fixed_asset.depreciation', '6150', '2010'],
      ['card.settlement', '1020', '1030'], ['reconciliation.adjustment', '1020', '6080'],
    ]
    for (const [sourceType, d, c] of others) {
      const r = await postJournalEntry({ tenantId: A, sourceType, sourceId: `o-${sourceType}`, description: 't', entryDate: atYesterday, lines: lines(d, c) })
      expect(r.posted, sourceType).toBe(true)
    }
  })

  it('today is never locked: a refund today of an order completed on the audited day posts today', async () => {
    const r = await postJournalEntry({ tenantId: A, sourceType: 'order.refund', sourceId: 'refund-today', description: 't', lines: lines('4001', '1015') })
    expect(r.posted).toBe(true)
    const je = await prisma.journalEntry.findUniqueOrThrow({ where: { id: r.entryId } })
    expect(fmtPktDate(je.entryDate)).toBe(today)
  })
})

describe('late dating', () => {
  it('lateDatingFor(…, sales source) moves a locked day to today with the note; without a sourceType nothing changes', async () => {
    const sales = await lateDatingFor(prisma, A, atYesterday, 'order.complete')
    expect('entryDate' in sales && fmtPktDate(sales.entryDate)).toBe(today)
    expect('memoNote' in sales && sales.memoNote).toBe(`dated ${yesterday}, posted late (the night audit locked that sales day)`)
    const plain = await lateDatingFor(prisma, A, atYesterday)
    expect(plain).toEqual({ entryDate: atYesterday })
    const other = await lateDatingFor(prisma, A, atYesterday, 'supplier.bill')
    expect(other).toEqual({ entryDate: atYesterday })
  })

  it('the backfill of an unposted till closed on the audited day posts today, with the note', async () => {
    const shift = await prisma.shift.create({ data: { userId: ceoId, tenantId: A, status: 'closed', openedAt: new Date(`${yesterday}T10:00:00+05:00`), closedAt: new Date(`${yesterday}T22:00:00+05:00`), openingFloatCents: 0, closingFloatCents: 11_500 } })
    const o = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'completed', placedAt: new Date(`${yesterday}T12:00:00+05:00`), completedAt: new Date(`${yesterday}T12:30:00+05:00`),
        totalCents: 11_500, taxCents: 1_500, items: { create: [{ name: 'Nihari', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', amountCents: 11_500, status: 'paid', processedAt: new Date(`${yesterday}T12:30:00+05:00`) } })
    const dry = await backfillUnpostedShifts({ tenantIds: [A], dryRun: true })
    const row = dry.rows.find((r) => r.shiftId === shift.id)
    expect(row?.outcome).toBe('would_post_into_current_month')
    expect(row?.detail).toContain('the night audit locked that sales day')
    const run = await backfillUnpostedShifts({ tenantIds: [A], dryRun: false, postedBy: ceoId })
    expect(run.rows.find((r) => r.shiftId === shift.id)?.outcome).toBe('posted_into_current_month')
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: `shift.close:${shift.id}` } })
    expect(fmtPktDate(je.entryDate)).toBe(today)
    expect(je.description).toContain(`closed ${yesterday}, posted late (the night audit locked that sales day)`)
  })
})

describe('reopen', () => {
  it('after the CEO reopens the day, a dated sales posting works', async () => {
    await reopenDay({ tenantId: A, day: yesterday, actor: { id: ceoId, role: 'admin' }, reason: 'Late Raast bill found' })
    const r = await postJournalEntry({ tenantId: A, sourceType: 'order.complete', sourceId: 'after-reopen', description: 't', entryDate: atYesterday, lines: lines() })
    expect(r.posted).toBe(true)
    const row = await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: A, businessDate: yesterday } } })
    expect(row.status).toBe('open')
    expect(row.reopenCount).toBe(1)
  })
})
