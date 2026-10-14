// H10 (Hasnain, 2026-10-14): a kept no-show deposit is untaxed compensation —
// other income.
//
//   • 'reservation.deposit_capture:<reservationId>' (markNoShow → captureReservationDeposit)
//     posts, in the brand's company, both lines tagged with the brand:
//       Dr 1030 D / Cr 4210 No-show Deposits Kept D — no output tax, no brand revenue.
//   • Its reversal mirrors it. No fiscal document is created.
//   • The P&L shows it as other income (42xx), not operating revenue.
//   • The sales tax return lists nothing for it; a capture booked under the
//     earlier treatment (revenue + tax inside) stays declared, flagged 'pre-H10'.
//   • Company B's no-show posts in B's books only.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { captureReservationDeposit } from '../src/modules/reservations/depositCapture.js'
import { markNoShow } from '../src/modules/reservations/noShow.js'
import { salesTaxReturn } from '../src/modules/accounting/salesTaxReturn.js'
import { profitAndLoss } from '../src/modules/accounting/reports.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'

const RUN = Math.random().toString(36).slice(2, 8)
const TODAY = new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
const M = TODAY.slice(0, 7)
const FROM = parsePktStartOfDay(`${M}-01`)
const TO = parsePktEndOfDay(TODAY)

let tenantA: string, tenantB: string, brandA: string, brandB: string

const booking = (conceptId: string, depositCents: number) => prisma.reservation.create({
  data: {
    conceptId, partySize: 2, guestName: 'No-show Guest', source: 'staff', status: 'confirmed', depositCents, depositRef: 'KEENU-7',
    startTime: new Date(Date.now() - 3 * 3_600_000), endTime: new Date(Date.now() - 90 * 60_000),
  },
})

type Line = [code: string, type: string, amount: number, conceptId: string | null]
async function linesOf(tenantId: string, reference: string): Promise<Line[]> {
  const je = await prisma.journalEntry.findFirstOrThrow({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je.lines.map((l): Line => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort()
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'No-show A', slug: `ns-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'No-show B', slug: `ns-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  brandA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-ns-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  brandB = (await prisma.concept.create({ data: { name: 'Viva', slug: `viva-ns-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
}, 60_000)

describe('a kept no-show deposit is other income (4210), untaxed', () => {
  let capturedA: string

  it('markNoShow: Dr 1030 / Cr 4210 for the whole deposit, tagged with the brand; no tax line, no fiscal document', async () => {
    const r = await booking(brandA, 5_000)
    const out = await markNoShow(r.id, { reason: 'No-show', actorId: null, auto: true })
    expect(out.marked).toBe(true)
    if (out.marked) expect(out.depositCapturedCents).toBe(5_000)
    capturedA = r.id
    expect(await linesOf(tenantA, `reservation.deposit_capture:${r.id}`)).toEqual([
      ['1030', 'debit', 5_000, brandA],
      ['4210', 'credit', 5_000, brandA],
    ])
    expect(await prisma.fiscalDocument.count({ where: { tenantId: tenantA } })).toBe(0)
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'no_show', depositCents: 0 })
    // Idempotent on the hold.
    expect(await captureReservationDeposit({ reservationId: r.id, postedBy: 'system' })).toEqual({ captured: false, reason: 'no-deposit' })
    expect(await prisma.journalEntry.count({ where: { reference: `reservation.deposit_capture:${r.id}` } })).toBe(1)
  })

  it('company B\'s no-show posts in B\'s books only', async () => {
    const r = await booking(brandB, 12_000)
    const out = await captureReservationDeposit({ reservationId: r.id, postedBy: 'system' })
    expect(out).toEqual({ captured: true, amountCents: 12_000, reservationId: r.id })
    expect(await linesOf(tenantB, `reservation.deposit_capture:${r.id}`)).toEqual([
      ['1030', 'debit', 12_000, brandB],
      ['4210', 'credit', 12_000, brandB],
    ])
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `reservation.deposit_capture:${r.id}` } })).toBe(0)
  })

  it('P&L: other income, not operating revenue', async () => {
    const pl = await profitAndLoss([tenantA], FROM, TO)
    expect(pl.otherIncome).toEqual([expect.objectContaining({ code: '4210', amountCents: 5_000 })])
    expect(pl.totals.otherIncomeCents).toBe(5_000)
    expect(pl.revenue.some((r) => r.code === '4210')).toBe(false)
  })

  it('the sales tax return lists nothing for it; a pre-H10 capture stays declared, flagged', async () => {
    let r = await salesTaxReturn(tenantA, FROM, TO)
    expect(r.byRate.some((x) => x.supply === 'deposit_forfeit')).toBe(false)
    expect(r.byAuthority.find((a) => a.key === 'srb')?.output.totalCents ?? 0).toBe(0)
    expect(r.taxableSalesCents).toBe(0)
    expect(r.notes.some((n) => n.includes('pre-H10'))).toBe(false)

    // A capture booked under the earlier treatment: revenue + SRB tax inside at 8 %.
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'reservation.deposit_capture', sourceId: randomUUID(), description: 'pre-H10 capture', postedBy: 'test', entryDate: new Date(),
      lines: [
        { accountCode: '1030', type: 'debit', amountCents: 10_800, conceptId: brandA },
        { accountCode: '4090', type: 'credit', amountCents: 10_000, conceptId: brandA },
        { accountCode: '2032', type: 'credit', amountCents: 800, conceptId: brandA },
      ],
    })
    r = await salesTaxReturn(tenantA, FROM, TO)
    const rows = r.byRate.filter((x) => x.supply === 'deposit_forfeit')
    expect(rows).toEqual([expect.objectContaining({ authority: 'SRB', ratePct: 8, tender: 'card', orders: 1, salesValueCents: 10_000, salesTaxCents: 800, taxCents: 800 })])
    expect(r.byAuthority.find((a) => a.key === 'srb')).toMatchObject({ output: expect.objectContaining({ totalCents: 800 }), otherOutputCents: 0 })
    expect(r.notes.some((n) => n.includes('pre-H10') && n.includes('4210'))).toBe(true)
  })

  it('its reversal mirrors it (Dr 4210 / Cr 1030), still untaxed', async () => {
    await reverseJournalEntry(tenantA, 'reservation.deposit_capture', capturedA, 'test reversal', { postedBy: 'test' })
    expect(await linesOf(tenantA, `reservation.deposit_capture.reversal:${capturedA}`)).toEqual([
      ['1030', 'credit', 5_000, brandA],
      ['4210', 'debit', 5_000, brandA],
    ])
    const r = await salesTaxReturn(tenantA, FROM, TO)
    // Only the pre-H10 row; the new capture and its reversal declare nothing.
    expect(r.byRate.filter((x) => x.supply === 'deposit_forfeit')).toEqual([expect.objectContaining({ orders: 1, refundTaxCents: 0, taxCents: 800 })])
    expect((await profitAndLoss([tenantA], FROM, TO)).totals.otherIncomeCents).toBe(0)
  })
})
