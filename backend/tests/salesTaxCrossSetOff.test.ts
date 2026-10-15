// H8 cross set-off (Hasnain, 2026-10-14): federal input (1320) on supplier
// bills for raw materials — stock of CROSS_SETOFF_ELIGIBLE_CLASSES (food,
// drinks and packaging; packaging added by H34, 2026-10-14) — may be set off
// against a provincial authority's output.
//
//   • Eligible = each 1320 line of a bill / credit note × the share of the
//     document's line value that is eligible stock of the company's own items
//     (non-stock lines and another company's item are not); a
//     credit note with no lines takes its bill's share.
//   • The pool: eligible to date − cross set-offs recorded, within what 1320
//     holds after what FBR is owed (federal output first). The return shows
//     "claimable against SRB" and the net after it; never twice.
//   • recordTaxPayment crossSetOffCents: Dr output / Cr 1320 / Cr cash;
//     422 CROSS_SETOFF_TOO_LARGE above the pool; 422 NO_CROSS_SET_OFF for FBR
//     and withholding; a void frees it; a linked manual entry's Cr 1320 is the
//     cross set-off, held to the pool without the ledger cap.
//   • Two companies: B's input never offsets A's output, and the other way.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import {
  salesTaxReturn, taxPaymentsFor, federalCrossSetOffAvailable, eligibleFederalInputCents, CROSS_SETOFF_ELIGIBLE_CLASSES, CROSS_SETOFF_AUTHORITIES,
} from '../src/modules/accounting/salesTaxReturn.js'
import { recordTaxPayment, linkTaxPayment, voidTaxPayment } from '../src/modules/accounting/taxPayments.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'

const RUN = Math.random().toString(36).slice(2, 8)
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
const FROM = parsePktStartOfDay(`${M1}-01`)
const TO = parsePktEndOfDay(lastDay(M1))
const P1 = { periodFrom: `${M1}-01`, periodTo: lastDay(M1) }
const P2 = { periodFrom: `${M2}-01`, periodTo: lastDay(M2) }

let tenantA: string, tenantB: string, sdA: string, sdB: string, userA: string, userB: string
let supplierA: string, supplierB: string

type L = { accountCode: string; type: 'debit' | 'credit'; amountCents: number; conceptId?: string }
async function post(tenantId: string, sourceType: string, sourceId: string, when: Date, lines: L[]) {
  return postJournalEntry({ tenantId, sourceType, sourceId, description: sourceType, postedBy: 'test', entryDate: when, lines })
}

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
const item = async (tenantId: string, name: string, category: string) =>
  (await prisma.inventoryItem.create({ data: { tenantId, name: `${name} ${RUN}`, unit: 'kg', category } })).id

let billSeq = 0
/** A supplier bill (or credit note) row with its lines, and its posted entry: Dr stock / Dr 1320 tax / Cr 2010 (Cr 1320 for a credit note). */
async function bill(tenantId: string, supplierId: string, when: Date, taxCents: number, lines: Array<{ cents: number; itemId?: string; expense?: string }>, cn?: { originalBillId: string }) {
  const subtotal = lines.reduce((t, l) => t + l.cents, 0)
  const b = await prisma.supplierBill.create({
    data: {
      supplierId, billNumber: `B-${RUN}-${++billSeq}`, billDate: when, dueDate: when, status: 'open',
      subtotalCents: subtotal, taxCents, totalCents: subtotal + taxCents, taxAuthority: 'fbr',
      kind: cn ? 'credit_note' : 'bill', originalBillId: cn?.originalBillId ?? null,
      lines: { create: lines.map((l, i) => ({ description: `line ${i}`, quantity: 1, unitCostCents: l.cents, lineTotalCents: l.cents, inventoryItemId: l.itemId ?? null, expenseAccountCode: l.expense ?? null })) },
    },
  })
  if (cn) {
    await post(tenantId, 'supplier.credit_note', b.id, when, [
      { accountCode: '2010', type: 'debit', amountCents: subtotal + taxCents },
      ...(subtotal > 0 ? [{ accountCode: '1210', type: 'credit' as const, amountCents: subtotal }] : []),
      { accountCode: '1320', type: 'credit', amountCents: taxCents },
    ])
  } else {
    await post(tenantId, 'supplier.bill', b.id, when, [
      { accountCode: '1210', type: 'debit', amountCents: subtotal },
      { accountCode: '1320', type: 'debit', amountCents: taxCents },
      { accountCode: '2010', type: 'credit', amountCents: subtotal + taxCents },
    ])
  }
  return b.id
}

const pay = (tenantId: string, userId: string, authority: string, period: { periodFrom: string; periodTo: string }, o: { paid: number; cross?: number; input?: number }) =>
  recordTaxPayment({
    tenantId, authority: authority as never, ...period, paidCents: o.paid, inputSetOffCents: o.input ?? 0, crossSetOffCents: o.cross ?? 0,
    paidAt: TODAY, method: 'cash', bankAccountId: null, cprNumber: null, notes: null, userId,
  })

async function expectCode(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code })
}

beforeAll(async () => {
  tenantA = await company('Cross A')
  tenantB = await company('Cross B')
  sdA = (await prisma.concept.create({ data: { name: 'A Karachi', slug: `x-a-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  sdB = (await prisma.concept.create({ data: { name: 'B Karachi', slug: `x-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id
  userA = (await prisma.user.create({ data: { name: 'Fin A', email: `fa.${RUN}@x.test`, password: 'x', role: 'finance', tenantId: tenantA } })).id
  userB = (await prisma.user.create({ data: { name: 'Fin B', email: `fb.${RUN}@x.test`, password: 'x', role: 'finance', tenantId: tenantB } })).id
  supplierA = (await prisma.supplier.create({ data: { name: `Meat Co ${RUN}`, tenantId: tenantA } })).id
  supplierB = (await prisma.supplier.create({ data: { name: `B Meat ${RUN}`, tenantId: tenantB } })).id

  const chicken = await item(tenantA, 'Chicken', 'protein')
  const cola = await item(tenantA, 'Cola', 'beverage')
  const boxes = await item(tenantA, 'Boxes', 'packaging')
  const bChicken = await item(tenantB, 'B Chicken', 'protein')

  // A, month M1: bill 1 — 80 % eligible (chicken + cola + boxes, packaging is eligible since H34;
  // the 20,000 non-stock line is not): 18,000 × 0.8 = 14,400.
  const b1 = await bill(tenantA, supplierA, at(`${M1}-05`), 18_000, [{ cents: 40_000, itemId: chicken }, { cents: 20_000, itemId: cola }, { cents: 20_000, itemId: boxes }, { cents: 20_000, expense: '6020' }])
  // Bill 2 — a non-stock line: not eligible (1,000 of 1320).
  await bill(tenantA, supplierA, at(`${M1}-06`), 1_000, [{ cents: 10_000, expense: '6020' }])
  // Bill 3 — a line naming ANOTHER company's item: not eligible (2,000 of 1320).
  await bill(tenantA, supplierA, at(`${M1}-07`), 2_000, [{ cents: 10_000, itemId: bChicken }])
  // A credit note on bill 1 with no lines: its bill's 80 % — 1,800 × 0.8 = 1,440 back.
  await bill(tenantA, supplierA, at(`${M1}-08`), 1_800, [], { originalBillId: b1 })
  // 1320 holds 18,000 + 1,000 + 2,000 − 1,800 = 19,200; eligible 12,960.

  // SRB output 30,000 (a Sindh sale); FBR output 7,000 still owed — federal output takes 1320 first.
  await post(tenantA, 'order.complete', randomUUID(), at(`${M1}-10`), [
    { accountCode: '1010', type: 'debit', amountCents: 230_000 },
    { accountCode: '4090', type: 'credit', amountCents: 200_000, conceptId: sdA },
    { accountCode: '2032', type: 'credit', amountCents: 30_000, conceptId: sdA },
  ])
  await post(tenantA, 'test.fbr_output', randomUUID(), at(`${M1}-15`), [
    { accountCode: '1110', type: 'debit', amountCents: 7_000 },
    { accountCode: '2030', type: 'credit', amountCents: 7_000 },
  ])

  // B: its own eligible bill (50,000 of 1320, all chicken) and its own SRB output.
  await bill(tenantB, supplierB, at(`${M1}-05`), 50_000, [{ cents: 300_000, itemId: bChicken }])
  await post(tenantB, 'order.complete', randomUUID(), at(`${M1}-10`), [
    { accountCode: '1010', type: 'debit', amountCents: 230_000 },
    { accountCode: '4090', type: 'credit', amountCents: 200_000, conceptId: sdB },
    { accountCode: '2032', type: 'credit', amountCents: 30_000, conceptId: sdB },
  ])
}, 60_000)

describe('eligibility (one switch point)', () => {
  it('food, drinks and packaging are eligible (H34); non-stock lines and another company\'s item are not', async () => {
    expect([...CROSS_SETOFF_ELIGIBLE_CLASSES]).toEqual(['food', 'beverage', 'packaging'])
    expect([...CROSS_SETOFF_AUTHORITIES]).toEqual(['srb'])
    expect(await eligibleFederalInputCents(prisma, tenantA, FROM, TO)).toBe(12_960)
    expect(await eligibleFederalInputCents(prisma, tenantB, FROM, TO)).toBe(50_000)
  })
})

describe('the return (H8)', () => {
  it('claimable against SRB = the pool, after what FBR is owed; net after it', async () => {
    const r = await salesTaxReturn(tenantA, FROM, TO)
    expect(r.federalCrossSetOff).toMatchObject({
      eligibleClasses: ['food', 'beverage', 'packaging'],
      eligibleInPeriodCents: 12_960, eligibleToDateCents: 12_960, usedCents: 0,
      ledgerHeldCents: 19_200, federalOutputOwedCents: 7_000,
      availableCents: 12_200, setOffForPeriodCents: 0, claimableCents: 12_200,
    })
    const srb = r.byAuthority.find((a) => a.key === 'srb')!
    expect(srb).toMatchObject({ netAfterWithheldCents: 30_000, crossSetOffForPeriodCents: 0, federalInputClaimableCents: 12_200, netAfterCrossSetOffCents: 17_800 })
    const fbr = r.byAuthority.find((a) => a.key === 'fbr')!
    expect(fbr).toMatchObject({ netAfterWithheldCents: 7_000 - 19_200, federalInputClaimableCents: 0, netAfterCrossSetOffCents: 7_000 - 19_200 })
    expect(r.netPayableAfterCrossSetOffCents).toBe(17_800)
    // Unchanged figures: each authority's own net.
    expect(r.netPayableCents).toBe(30_000)
    expect(r.notes.some((n) => n.includes('H8'))).toBe(true)
  })

  it('company B: its own input only — never A\'s, and A never B\'s', async () => {
    const b = await salesTaxReturn(tenantB, FROM, TO)
    expect(b.federalCrossSetOff).toMatchObject({ eligibleToDateCents: 50_000, ledgerHeldCents: 50_000, federalOutputOwedCents: 0, availableCents: 50_000, claimableCents: 30_000 })
    expect(b.byAuthority.find((a) => a.key === 'srb')).toMatchObject({ federalInputClaimableCents: 30_000, netAfterCrossSetOffCents: 0 })
    expect((await federalCrossSetOffAvailable(prisma, tenantA, TO)).eligibleToDateCents).toBe(12_960)
  })
})

describe('the payment (taxPayments.ts)', () => {
  let srbPayment: string

  it('refuses FBR and withholding (422 NO_CROSS_SET_OFF) and anything above the pool (422 CROSS_SETOFF_TOO_LARGE)', async () => {
    await expectCode(pay(tenantA, userA, 'fbr', P1, { paid: 1_000, cross: 100 }), 'NO_CROSS_SET_OFF')
    await expectCode(pay(tenantA, userA, 'wht', P1, { paid: 1_000, cross: 100 }), 'NO_CROSS_SET_OFF')
    await expectCode(pay(tenantA, userA, 'srb', P1, { paid: 17_799, cross: 12_201 }), 'CROSS_SETOFF_TOO_LARGE')
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })).toBe(0)
  })

  it('Dr 2032 30,000 / Cr 1320 10,000 / Cr 1010 20,000 — and it is never claimed twice', async () => {
    const row = await pay(tenantA, userA, 'srb', P1, { paid: 20_000, cross: 10_000 })
    srbPayment = row.id
    expect(Number(row.outputSetOffCents)).toBe(30_000)
    expect(Number(row.inputSetOffCents)).toBe(0)
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: tenantA, reference: `salestax.payment:${row.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([
      ['1010', 'credit', 20_000], ['1320', 'credit', 10_000], ['2032', 'debit', 30_000],
    ])
    const listed = (await taxPaymentsFor(tenantA, FROM, TO)).find((p) => p.id === row.id)!
    expect(listed).toMatchObject({ crossSetOffCents: 10_000, paidCents: 20_000, inputSetOffCents: 0 })

    // Pool now: eligible 12,960 − 10,000 = 2,960; 1320 9,200 − FBR 7,000 = 2,200.
    const pool = await federalCrossSetOffAvailable(prisma, tenantA, new Date())
    expect(pool).toMatchObject({ usedCents: 10_000, ledgerHeldCents: 9_200, availableCents: 2_200 })
    // Another period: the same pool.
    await expectCode(pay(tenantA, userA, 'srb', P2, { paid: 0, cross: 2_201 }), 'CROSS_SETOFF_TOO_LARGE')

    const r = await salesTaxReturn(tenantA, FROM, TO)
    expect(r.byAuthority.find((a) => a.key === 'srb')).toMatchObject({
      paidForPeriodCents: 20_000, crossSetOffForPeriodCents: 10_000, federalInputClaimableCents: 2_200, netAfterCrossSetOffCents: 17_800,
    })
    expect(r.federalCrossSetOff).toMatchObject({ usedCents: 10_000, availableCents: 2_200, setOffForPeriodCents: 10_000, claimableCents: 2_200 })
  })

  it('a void frees what it set off', async () => {
    await voidTaxPayment({ scope: { tenantId: tenantA }, id: srbPayment, reason: 'test void', userId: userA })
    expect((await federalCrossSetOffAvailable(prisma, tenantA, new Date())).availableCents).toBe(12_200)
  })

  it('a linked manual entry\'s Cr 1320 is the cross set-off — held to the pool', async () => {
    const ok = await post(tenantA, 'manual', randomUUID(), new Date(), [
      { accountCode: '2032', type: 'debit', amountCents: 8_000 },
      { accountCode: '1320', type: 'credit', amountCents: 3_000 },
      { accountCode: '1010', type: 'credit', amountCents: 5_000 },
    ])
    const linked = await linkTaxPayment({ tenantId: tenantA, journalEntryId: ok.entryId, authority: 'srb', ...P1, cprNumber: null, notes: null, userId: userA })
    expect(Number(linked.paidCents)).toBe(5_000)
    expect((await taxPaymentsFor(tenantA, FROM, TO)).find((p) => p.id === linked.id)).toMatchObject({ crossSetOffCents: 3_000, paidCents: 5_000, linked: true })
    // eligible 12,960 − 3,000 = 9,960; 1320 16,200 − 7,000 = 9,200.
    expect((await federalCrossSetOffAvailable(prisma, tenantA, new Date())).availableCents).toBe(9_200)

    // 10,000 of 1320 against SRB (next period): more than the eligible input left (9,960).
    const big = await post(tenantA, 'manual', randomUUID(), new Date(), [
      { accountCode: '2032', type: 'debit', amountCents: 20_000 },
      { accountCode: '1320', type: 'credit', amountCents: 10_000 },
      { accountCode: '1010', type: 'credit', amountCents: 10_000 },
    ])
    await expectCode(linkTaxPayment({ tenantId: tenantA, journalEntryId: big.entryId, authority: 'srb', ...P2, cprNumber: null, notes: null, userId: userA }), 'CROSS_SETOFF_TOO_LARGE')
  })

  it('two companies: B sets off its own input; A\'s pool does not move, and B cannot use A\'s', async () => {
    const before = await federalCrossSetOffAvailable(prisma, tenantA, new Date())
    await expectCode(pay(tenantB, userB, 'srb', P1, { paid: 0, cross: 50_001 }), 'CROSS_SETOFF_TOO_LARGE')
    const row = await pay(tenantB, userB, 'srb', P1, { paid: 0, cross: 30_000 })
    expect((await taxPaymentsFor(tenantB, FROM, TO)).find((p) => p.id === row.id)).toMatchObject({ crossSetOffCents: 30_000 })
    expect(await federalCrossSetOffAvailable(prisma, tenantA, new Date())).toEqual(before)
    // A's payments never list B's, and B's pool is its own.
    expect((await taxPaymentsFor(tenantA, FROM, TO)).some((p) => p.id === row.id)).toBe(false)
    expect((await federalCrossSetOffAvailable(prisma, tenantB, new Date())).availableCents).toBe(20_000)
  })
})

// The HTTP route passes crossSetOffCents through (final gate, 2026-10-14), and
// the CSV carries the H8 rows. Read-only / refused writes only, so the pool
// figures asserted above are untouched.
describe('the route (POST /accounting/sales-tax-return/payments, CSV)', () => {
  it('passes crossSetOffCents to recordTaxPayment (FBR refused 422 NO_CROSS_SET_OFF, nothing saved) and the CSV lists the H8 rows', async () => {
    const Fastify = (await import('fastify')).default
    const { ZodError } = await import('zod')
    const { AppError } = await import('../src/lib/errors.js')
    const { issueStaffSession } = await import('../src/modules/auth/service.js')
    const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
    const u = await prisma.user.findUniqueOrThrow({ where: { id: userA } })
    await prisma.user.update({ where: { id: userA }, data: { isActive: true, accountStatus: 'active' } })
    await prisma.tenantMember.upsert({ where: { userId_tenantId: { userId: userA, tenantId: tenantA } }, create: { tenantId: tenantA, userId: userA }, update: {} })
    const token = (issueStaffSession({ ...u, isActive: true, accountStatus: 'active' }) as { accessToken: string }).accessToken
    const app = Fastify()
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
      if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
      return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
    })
    await app.register(accountingRoutes, { prefix: '/accounting' })
    await app.ready()
    try {
      const auth = { authorization: `Bearer ${token}` }
      const before = await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })
      const fbr = await app.inject({
        method: 'POST', url: '/accounting/sales-tax-return/payments', headers: auth,
        payload: { authority: 'fbr', ...P1, paidCents: 100, crossSetOffCents: 100, paidAt: TODAY, method: 'cash' },
      })
      expect(fbr.statusCode).toBe(422)
      expect(fbr.json().error.code).toBe('NO_CROSS_SET_OFF')
      expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantA } })).toBe(before)

      const csv = await app.inject({ method: 'GET', url: `/accounting/sales-tax-return?dateFrom=${P1.periodFrom}&dateTo=${P1.periodTo}&format=csv`, headers: auth })
      expect(csv.statusCode).toBe(200)
      expect(csv.body).toContain('NET PAYABLE AFTER FEDERAL INPUT ON RAW MATERIALS (H8)')
      expect(csv.body).toContain('Federal input on raw materials still claimable (H8)')
      expect(csv.body).toContain('Federal input set off in those payments (H8)')
    } finally {
      await app.close()
    }
  })
})

// Final gate (answers-3, 2026-10-14): the pool counts cross set-offs from the
// LEDGER. A hand-posted Dr 203x / Cr 1320 that was never linked, or was
// unlinked (voidTaxPayment keeps a linked entry), still uses the pool — so
// ineligible 1320 input (a non-stock line) can never be set off against SRB.
describe('the pool reads the ledger: unlinked hand-posted set-offs still count', () => {
  it('eligible 10,000 + non-stock 8,000; a manual Cr 1320 10,000 against SRB — linked, unlinked or never linked, nothing is left', async () => {
    const t = await company('Cross Unlink')
    const u = (await prisma.user.create({ data: { name: 'Fin U', email: `fu.${RUN}@x.test`, password: 'x', role: 'finance', tenantId: t } })).id
    const sup = (await prisma.supplier.create({ data: { name: `U Meat ${RUN}`, tenantId: t } })).id
    await bill(t, sup, at(`${M1}-05`), 10_000, [{ cents: 50_000, itemId: await item(t, 'U Chicken', 'protein') }])
    await bill(t, sup, at(`${M1}-05`), 8_000, [{ cents: 40_000, expense: '6020' }])
    await post(t, 'order.complete', randomUUID(), at(`${M1}-10`), [
      { accountCode: '1010', type: 'debit', amountCents: 100_000 },
      { accountCode: '2032', type: 'credit', amountCents: 100_000 },
    ])
    expect((await federalCrossSetOffAvailable(prisma, t, new Date())).availableCents).toBe(10_000)
    const manual = await post(t, 'manual', randomUUID(), at(`${M1}-20`), [
      { accountCode: '2032', type: 'debit', amountCents: 30_000 },
      { accountCode: '1320', type: 'credit', amountCents: 10_000 },
      { accountCode: '1010', type: 'credit', amountCents: 20_000 },
    ])
    // Never linked: already used.
    expect(await federalCrossSetOffAvailable(prisma, t, new Date())).toMatchObject({ usedCents: 10_000, availableCents: 0 })
    // Linking it is allowed (its own set-off is left out of the check) …
    const linked = await linkTaxPayment({ tenantId: t, journalEntryId: manual.entryId, authority: 'srb', ...P1, cprNumber: null, notes: null, userId: u })
    expect(await federalCrossSetOffAvailable(prisma, t, new Date())).toMatchObject({ usedCents: 10_000, availableCents: 0 })
    // … and unlinking it does not free the input: the entry still credits 1320.
    await voidTaxPayment({ scope: { tenantId: t }, id: linked.id, reason: 'linked to the wrong period', userId: u })
    expect(await federalCrossSetOffAvailable(prisma, t, new Date())).toMatchObject({ usedCents: 10_000, availableCents: 0 })
    await expectCode(pay(t, u, 'srb', P2, { paid: 0, cross: 8_000 }), 'CROSS_SETOFF_TOO_LARGE')
    // Re-linking it still works.
    const again = await linkTaxPayment({ tenantId: t, journalEntryId: manual.entryId, authority: 'srb', ...P1, cprNumber: null, notes: null, userId: u })
    expect(again.linked).toBe(true)
  })

  it('a hand journal settling FBR and SRB together: the 1320 that paid FBR\'s output is not a cross set-off', async () => {
    const t = await company('Cross Combined')
    const sup = (await prisma.supplier.create({ data: { name: `C Meat ${RUN}`, tenantId: t } })).id
    await bill(t, sup, at(`${M1}-05`), 10_000, [{ cents: 50_000, itemId: await item(t, 'C Chicken', 'protein') }])
    await post(t, 'test.sales', randomUUID(), at(`${M1}-10`), [
      { accountCode: '1010', type: 'debit', amountCents: 110_000 },
      { accountCode: '2030', type: 'credit', amountCents: 4_000 },
      { accountCode: '2032', type: 'credit', amountCents: 6_000 },
      { accountCode: '4090', type: 'credit', amountCents: 100_000 },
    ])
    // Dr 2030 4,000 + Dr 2032 6,000 / Cr 1320 5,000 + Cr 1010 5,000: 4,000 of the 1320 paid FBR, 1,000 went against SRB.
    await post(t, 'manual', randomUUID(), at(`${M1}-20`), [
      { accountCode: '2030', type: 'debit', amountCents: 4_000 },
      { accountCode: '2032', type: 'debit', amountCents: 6_000 },
      { accountCode: '1320', type: 'credit', amountCents: 5_000 },
      { accountCode: '1010', type: 'credit', amountCents: 5_000 },
    ])
    expect((await federalCrossSetOffAvailable(prisma, t, new Date())).usedCents).toBe(1_000)
  })
})
