// Automatic voucher numbers (owner, 2026-10-20; accounting/voucherNumbers.ts):
// JV- manual entries and reversals, PV- payments out of cash / bank, RV-
// receipts in; per company, ascending, gap-free; none on sales, till,
// transfers between money accounts or non-cash entries. Company B numbers
// from 1 on its own; parallel postings never share or skip a number.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'

const RUN = `vn${Date.now()}`
let A = ''
let B = ''
let n = 0
const post = async (tenantId: string, sourceType: string, debit: string, credit: string, cents = 1_000) => {
  const r = await postJournalEntry({
    tenantId, sourceType, sourceId: `${RUN}-${++n}`, description: `${sourceType} ${n}`, postedBy: 'test',
    lines: [{ accountCode: debit, type: 'debit', amountCents: cents }, { accountCode: credit, type: 'credit', amountCents: cents }],
  })
  return { ...r, sourceId: `${RUN}-${n}` }
}
const noOf = async (id: string) => (await prisma.journalEntry.findUniqueOrThrow({ where: { id }, select: { voucherNo: true } })).voucherNo

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Voucher A', slug: `${RUN}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'Voucher B', slug: `${RUN}-b` } })).id
  for (const t of [A, B]) await ensureChartOfAccounts(t)
  if (!(await prisma.account.findFirst({ where: { tenantId: A, code: '1021' } }))) {
    await prisma.account.create({ data: { tenantId: A, code: '1021', name: 'Bank — HBL', type: 'asset', isActive: true } })
  }
  await prisma.bankAccount.create({ data: { tenantId: A, name: 'HBL', bankName: 'HBL', accountCode: '1021', isActive: true } })
}, 60_000)

describe('voucher numbers', () => {
  it('JV / PV / RV per kind, ascending; none on sales, transfers and non-cash entries', async () => {
    expect(await noOf((await post(A, 'manual', '6040', '2010')).entryId)).toBe('JV-00001')
    expect(await noOf((await post(A, 'manual', '6040', '1010')).entryId)).toBe('JV-00002')     // a manual payment is still a JV
    expect(await noOf((await post(A, 'opex.payment', '6040', '1010')).entryId)).toBe('PV-00001')
    expect(await noOf((await post(A, 'supplier.payment', '2010', '1021')).entryId)).toBe('PV-00002') // a named bank
    expect(await noOf((await post(A, 'receivable.payment', '1021', '1110')).entryId)).toBe('RV-00001')
    expect(await noOf((await post(A, 'deposit.drop', '1020', '1010')).entryId)).toBeNull()       // cash → bank: a transfer
    expect(await noOf((await post(A, 'order.complete', '1010', '4001')).entryId)).toBeNull()     // sales
    expect(await noOf((await post(A, 'shift.close', '1010', '4001')).entryId)).toBeNull()        // till
    expect(await noOf((await post(A, 'opex.accrual', '6040', '2010')).entryId)).toBeNull()                // non-cash
    const pay = await post(A, 'opex.payment', '6040', '1010')
    expect(await noOf(pay.entryId)).toBe('PV-00003')
    const rev = await reverseJournalEntry(A, 'opex.payment', pay.sourceId, 'entered twice', { postedBy: 'test' })
    expect(await noOf(rev.entryId)).toBe('JV-00003')                                             // a reversal is a JV
  })

  it('company B numbers on its own', async () => {
    expect(await noOf((await post(B, 'manual', '6040', '2010')).entryId)).toBe('JV-00001')
    expect(await noOf((await post(B, 'opex.payment', '6040', '1010')).entryId)).toBe('PV-00001')
  })

  it('parallel postings: unique, gap-free, ascending', async () => {
    const before = await prisma.journalEntry.count({ where: { tenantId: A, voucherKind: 'PV' } })
    await Promise.all(Array.from({ length: 12 }, () => post(A, 'opex.payment', '6040', '1010', 500)))
    const seqs = (await prisma.journalEntry.findMany({ where: { tenantId: A, voucherKind: 'PV' }, select: { voucherSeq: true }, orderBy: { voucherSeq: 'asc' } }))
      .map((e) => e.voucherSeq)
    expect(seqs).toEqual(Array.from({ length: before + 12 }, (_, i) => i + 1))
  })
})
