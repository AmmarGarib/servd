// 1357 retired (owner, 2026-10-16: "Don't post any entry in 1357 … only book
// one entry when confirmed by finance") — and the trial balance shows ONE net
// balance per account, zero balances hidden.
//
//   - A voucher still HELD on 1357 (2026-10-15 flow: paid Dr 1357 / Cr 1011 |
//     1010, documents not verified) is converted ONCE: 'cashvoucher.hold_convert:<id>'
//     Dr its expense account / Cr 1357 for the held amount, under the pay's
//     brand, in its own company; then bookedAtPay = true and
//     postedJournalEntryId = that entry. A re-run posts nothing.
//   - Company B's held voucher is untouched by a run for company A, and is
//     booked in B's books by B's run.
//   - No usable category (none, a stock category), equipment, or a refused
//     posting (locked period): NOT converted — flagged
//     'cash_voucher_hold_unconverted' in the voucher's company (once), left
//     held; once fixed, the next run converts it and resolves the flag.
//   - No path posts to 1357 for new activity: the 'voucher_hold' spend nature
//     is gone; change / overspend entries are refused.
//   - Trial balance: one net figure per account (debit OR credit), zero rows
//     hidden, totals equal.
//
// Needs the disposable test DB.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { postPettyCashMovementTx, postCashVoucherSourceTx } from '../src/modules/accounting/pettyCashPosting.js'
import { recordPettyCashSpendTx } from '../src/modules/trustops/pettyCash.js'
import { convertHeldVoucher, convertHeldVouchers, CASH_VOUCHER_HOLD_CONVERT_SOURCE, HOLD_UNCONVERTED_KIND } from '../src/modules/trustops/voucherHoldConversion.js'
import { trialBalance } from '../src/modules/accounting/reports.js'

const P = `vhc${Date.now()}`
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const C: Record<'A' | 'B', string> = { A: '', B: '' }
const box: Record<'A' | 'B', string> = { A: '', B: '' }
let userId = ''
let seq = 0

async function entry(reference: string, tenantId: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.conceptId]).sort() : null
}
async function balanceOf(code: string, tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { account: { code, tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}

/** A voucher as the 2026-10-15 hold flow left it, paid from a box: Dr 1357 / Cr 1011 (a lineless 1357 movement). */
async function heldFromBox(co: 'A' | 'B', amountCents: number, category: string | null, purpose = 'Taxi to the market') {
  seq++
  return prisma.$transaction(async (tx) => {
    const v = await tx.cashVoucher.create({
      data: {
        tenantId: T[co], seq, number: `CV-${String(seq).padStart(5, '0')}`, voucherDate: new Date(), payeeName: 'Holder',
        purpose, category, conceptId: C[co], amountCents, status: 'disbursed', preparedById: userId,
        disbursedAt: new Date(), disbursedById: userId, boxId: box[co], expenseOnVerify: true, bookedAtPay: false, paySource: 'box',
      },
    })
    await tx.pettyCashBox.update({ where: { id: box[co] }, data: { floatCents: { decrement: amountCents } } })
    const m = await tx.pettyCashMovement.create({
      data: {
        boxId: box[co], tenantId: T[co], type: 'spend', amountCents: -amountCents, reason: `Cash voucher ${v.number}: ${purpose}`,
        createdById: userId, source: 'box', accountCode: '1357', cashVoucherId: v.id, conceptId: C[co],
      },
    })
    // Written directly (as the retired 'voucher_hold' nature booked it): nothing in the code posts to 1357 any more.
    const je = await postJournalEntry({
      tenantId: T[co], sourceType: 'pettycash.spend', sourceId: m.id, description: 'Cash voucher paid from petty cash (held until finance verifies the documents)',
      postedBy: userId, entryDate: new Date(),
      lines: [
        { accountCode: '1357', type: 'debit', amountCents: amountCents, conceptId: C[co] },
        { accountCode: '1011', type: 'credit', amountCents: amountCents, conceptId: C[co] },
      ],
    }, { tx })
    await tx.pettyCashMovement.update({ where: { id: m.id }, data: { journalEntryId: je.entryId } })
    return tx.cashVoucher.update({ where: { id: v.id }, data: { pettyCashMovementId: m.id } })
  })
}

/** A voucher as the hold flow left it, paid from cash on hand: 'cashvoucher.pay:<id>' Dr 1357 / Cr 1010. */
async function heldFromCash(co: 'A' | 'B', amountCents: number, category: string) {
  seq++
  const v = await prisma.cashVoucher.create({
    data: {
      tenantId: T[co], seq, number: `CV-${String(seq).padStart(5, '0')}`, voucherDate: new Date(), payeeName: 'Holder',
      purpose: 'Printer paper', category, conceptId: C[co], amountCents, status: 'disbursed', preparedById: userId,
      disbursedAt: new Date(), disbursedById: userId, expenseOnVerify: true, bookedAtPay: false, paySource: 'cash_on_hand', payAccountCode: '1010',
    },
  })
  const je = await postJournalEntry({
    tenantId: T[co], sourceType: 'cashvoucher.pay', sourceId: v.id, description: `Cash voucher ${v.number} paid — documents awaited`, postedBy: userId,
    lines: [
      { accountCode: '1357', type: 'debit', amountCents, conceptId: C[co] },
      { accountCode: '1010', type: 'credit', amountCents, conceptId: C[co] },
    ],
  })
  return prisma.cashVoucher.update({ where: { id: v.id }, data: { payJournalEntryId: je.entryId } })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Hold Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Hold Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  C.A = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} brand B`, slug: `${P}-brand-b`, type: 'restaurant', tenantId: T.B } })).id
  userId = (await prisma.user.create({ data: { name: `${P} fin`, email: `${P}@vhc.pk`, password: 'x', role: 'finance', tenantId: T.A, isActive: true } })).id
  box.A = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'A box', custodianId: userId, floatCents: 1_000_000, topUpLimitCents: 100_000_000 } })).id
  box.B = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: userId, floatCents: 1_000_000, topUpLimitCents: 100_000_000 } })).id
}, 60_000)

describe('held vouchers become ONE expense entry each', () => {
  it('converts A\'s held vouchers (box and cash on hand): Dr expense / Cr 1357 under the pay\'s brand; B untouched; idempotent', async () => {
    const boxV = await heldFromBox('A', 5_000, 'transport')
    const cashV = await heldFromCash('A', 2_500, 'office')
    const bV = await heldFromBox('B', 4_000, 'transport')
    expect(await balanceOf('1357', T.A)).toBe(7_500)
    expect(await balanceOf('1357', T.B)).toBe(4_000)

    const run = await convertHeldVouchers([T.A])
    expect(run).toEqual([{ tenantId: T.A, converted: 2, refused: 0 }])
    expect(await entry(`${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${boxV.id}`, T.A)).toEqual([['1357', 'credit', 5_000, C.A], ['6140', 'debit', 5_000, C.A]])
    expect(await entry(`${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${cashV.id}`, T.A)).toEqual([['1357', 'credit', 2_500, C.A], ['6170', 'debit', 2_500, C.A]])
    expect(await balanceOf('1357', T.A)).toBe(0)
    for (const id of [boxV.id, cashV.id]) {
      const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id } })
      const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: T.A, reference: `${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${id}` } })
      expect(row).toMatchObject({ status: 'disbursed', bookedAtPay: true, expenseOnVerify: true, postedJournalEntryId: je.id, postedAt: null })
    }
    // Company B: not touched by A's run.
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: bV.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
    expect(await prisma.journalEntry.count({ where: { reference: `${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${bV.id}` } })).toBe(0)

    // Re-run: nothing more.
    const count = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    expect(await convertHeldVouchers([T.A])).toEqual([])
    expect((await convertHeldVoucher(boxV.id)).outcome).toBe('not_held')
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(count)

    // B's own run books it in B's books only.
    expect(await convertHeldVouchers([T.B])).toEqual([{ tenantId: T.B, converted: 1, refused: 0 }])
    expect(await entry(`${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${bV.id}`, T.B)).toEqual([['1357', 'credit', 4_000, C.B], ['6140', 'debit', 4_000, C.B]])
    expect(await entry(`${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${bV.id}`, T.A)).toBeNull()
    expect(await balanceOf('1357', T.B)).toBe(0)
  })

  it('no category, a stock category or equipment: flagged in its company (once) and left held — nothing posts', async () => {
    const none = await heldFromBox('A', 1_000, null)
    const stock = await heldFromBox('A', 1_200, 'kitchen_food')
    const kit = await heldFromBox('A', 1_400, 'transport', 'New blender for the kitchen')
    const before1357 = await balanceOf('1357', T.A)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    expect(await convertHeldVouchers([T.A])).toEqual([{ tenantId: T.A, converted: 0, refused: 3 }])
    await convertHeldVouchers([T.A]) // again: still one flag each
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    expect(await balanceOf('1357', T.A)).toBe(before1357)
    for (const v of [none, stock, kit]) {
      expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
      const flags = await prisma.exceptionFlag.findMany({ where: { kind: HOLD_UNCONVERTED_KIND, entityType: 'CashVoucher', entityId: v.id } })
      expect(flags).toHaveLength(1)
      expect(flags[0]).toMatchObject({ tenantId: T.A, status: 'open' })
    }
    // Finance sets the category: the next run converts it and resolves its flag.
    await prisma.cashVoucher.update({ where: { id: none.id }, data: { category: 'office' } })
    const r = await convertHeldVoucher(none.id)
    expect(r).toMatchObject({ outcome: 'converted', accountCode: '6170', amountCents: 1_000 })
    expect((await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: HOLD_UNCONVERTED_KIND, entityId: none.id } })).status).toBe('resolved')
    // Tidy for the trial-balance test: the other two are corrected by the test's own "journal" (a new category).
    await prisma.cashVoucher.update({ where: { id: stock.id }, data: { category: 'office' } })
    await prisma.cashVoucher.update({ where: { id: kit.id }, data: { purpose: 'Kitchen supplies run' } })
    expect(await convertHeldVouchers([T.A])).toEqual([{ tenantId: T.A, converted: 2, refused: 0 }])
    expect(await balanceOf('1357', T.A)).toBe(0)
  })

  it('a refused posting (locked period) rolls back: still held, no entry, flagged; converts once the period is open', async () => {
    const v = await heldFromBox('A', 3_000, 'transport')
    const lock = await prisma.periodLock.create({ data: { tenantId: T.A, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    try {
      const r = await convertHeldVoucher(v.id)
      expect(r).toMatchObject({ outcome: 'refused', code: 'PERIOD_LOCKED' })
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
    expect(await prisma.journalEntry.count({ where: { reference: `${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${v.id}` } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: HOLD_UNCONVERTED_KIND, entityId: v.id, tenantId: T.A, status: 'open' } })).toBe(1)
    expect((await convertHeldVoucher(v.id)).outcome).toBe('converted')
    expect(await balanceOf('1357', T.A)).toBe(0)
  })
})

describe('nothing new posts to 1357', () => {
  it('the voucher_hold spend nature is gone; change / overspend entries are refused', async () => {
    const v = await heldFromCash('B', 700, 'office')
    const before = await balanceOf('1357', T.B)
    await expect(prisma.$transaction((tx) => recordPettyCashSpendTx(tx, {
      box: { id: box.B }, amountCents: 700, reason: 'hold', createdById: userId,
      nature: 'voucher_hold' as never, cashVoucherId: v.id,
    }))).rejects.toMatchObject({ code: 'BAD_SPEND_NATURE' })
    for (const kind of ['change', 'overspend', 'pay'] as const) {
      await expect(prisma.$transaction((tx) => postCashVoucherSourceTx(tx, v.id, kind, 100, userId))).rejects.toMatchObject({ code: 'EXPENSE_BOOKED_AT_PAY' })
    }
    expect(await balanceOf('1357', T.B)).toBe(before)
    await convertHeldVouchers([T.B])
    expect(await balanceOf('1357', T.B)).toBe(0)
  })
})

describe('trial balance: one net balance per account, zero balances hidden', () => {
  it('debit OR credit per row, 1357 (cleared) not listed, totals equal and match the raw ledger', async () => {
    const tb = await trialBalance([T.A], new Date(Date.now() + 60_000))
    expect(tb.rows.length).toBeGreaterThan(0)
    for (const r of tb.rows) {
      expect(r.debitCents === 0 || r.creditCents === 0, `${r.code} shows both columns`).toBe(true)
      expect(r.debitCents + r.creditCents, `${r.code} is listed at zero`).toBeGreaterThan(0)
    }
    expect(tb.rows.find((r) => r.code === '1357')).toBeUndefined()
    // 1011 had money in and out: one net figure, equal to the raw ledger balance.
    const raw1011 = await balanceOf('1011', T.A)
    const row1011 = tb.rows.find((r) => r.code === '1011')
    if (raw1011 === 0) expect(row1011).toBeUndefined()
    else expect((row1011!.debitCents - row1011!.creditCents)).toBe(raw1011)
    expect(tb.totals.debitCents).toBe(tb.totals.creditCents)
    expect(tb.totals.differenceCents).toBe(0)
    expect(tb.companyTotals.find((c) => c.tenantId === T.A)).toMatchObject({ differenceCents: 0 })
    const listed = tb.rows.reduce((s, r) => s + r.debitCents, 0)
    expect(listed).toBe(tb.totals.debitCents)
  })
})

describe('gate: the hold must be live and equal the voucher; replays never repost 1357; parallel runs book once', () => {
  it('two conversions racing (two API instances booting) book ONE entry', async () => {
    const v = await heldFromBox('B', 2_200, 'transport')
    const rs = await Promise.all([convertHeldVoucher(v.id), convertHeldVoucher(v.id), convertHeldVoucher(v.id)])
    expect(rs.filter((r) => r.outcome === 'converted')).toHaveLength(1)
    expect(rs.filter((r) => r.outcome === 'not_held')).toHaveLength(2)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: `${CASH_VOUCHER_HOLD_CONVERT_SOURCE}:${v.id}` } } })).toBe(1)
    expect(await balanceOf('1357', T.B)).toBe(0)
  })

  it('a reversed hold or a hold of another amount is never converted (flagged; nothing posts)', async () => {
    const reversed = await heldFromBox('B', 1_500, 'transport')
    await reverseJournalEntry(T.B, 'pettycash.spend', reversed.pettyCashMovementId!, 'test: hold corrected by hand', {})
    const mism = await heldFromBox('B', 1_800, 'transport')
    await prisma.cashVoucher.update({ where: { id: mism.id }, data: { amountCents: 1_900 } })
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.B } })
    expect(await convertHeldVoucher(reversed.id)).toMatchObject({ outcome: 'refused', code: 'HOLD_NOT_BOOKED' })
    expect(await convertHeldVoucher(mism.id)).toMatchObject({ outcome: 'refused', code: 'HOLD_AMOUNT_MISMATCH' })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.B } })).toBe(entries)
    for (const v of [reversed, mism]) {
      expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({ bookedAtPay: false, postedJournalEntryId: null })
      expect(await prisma.exceptionFlag.count({ where: { kind: HOLD_UNCONVERTED_KIND, entityId: v.id, tenantId: T.B, status: 'open' } })).toBe(1)
    }
    // Tidy: the amount put back, it converts for exactly its hold.
    await prisma.cashVoucher.update({ where: { id: mism.id }, data: { amountCents: 1_800 } })
    expect(await convertHeldVoucher(mism.id)).toMatchObject({ outcome: 'converted', amountCents: 1_800 })
    expect(await balanceOf('1357', T.B)).toBe(0)
  })

  it('an old hold movement replays as a no-op (even with a backfill date); one with no entry is refused (HOLD_RETIRED)', async () => {
    const v = await heldFromBox('B', 900, 'transport')
    const m = await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: v.pettyCashMovementId! } })
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.B } })
    const r = await prisma.$transaction((tx) => postPettyCashMovementTx(tx, m.id, { entryDate: new Date(Date.now() - 40 * 86_400_000), memoNote: 'backfill' }))
    expect(r).toEqual({ entryId: m.journalEntryId, outcome: 'unchanged' })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.B } })).toBe(entries)
    // A 1357 movement that never got its entry: never booked now.
    const loose = await prisma.pettyCashMovement.create({
      data: { boxId: box.B, tenantId: T.B, type: 'spend', amountCents: -300, reason: 'old hold, never booked', createdById: userId, source: 'box', accountCode: '1357' },
    })
    await expect(prisma.$transaction((tx) => postPettyCashMovementTx(tx, loose.id))).rejects.toMatchObject({ code: 'HOLD_RETIRED' })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.B } })).toBe(entries)
    await prisma.pettyCashMovement.delete({ where: { id: loose.id } })
    expect((await convertHeldVoucher(v.id)).outcome).toBe('converted')
    expect(await balanceOf('1357', T.B)).toBe(0)
  })
})
