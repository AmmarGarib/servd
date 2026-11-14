// Clean-up A6 (finance decision, 2026-11-14): ONE definition of a company's money accounts — 1010, 1011, 1020 and
// the company's LINKED bank accounts' ledger codes only (lib/moneyAccounts.ts, the payments register's rule). The
// sales-tax payment link and the automatic PV / RV voucher stamp read the same function.
//
// What this guards:
//   - moneyCodesOf: company A's linked bank code is A's money account, never B's; the drawer 1015 never is, even if a
//     bank row names it;
//   - the voucher stamp: a payment out of 1015, out of an unlinked 102x code, or out of a code only ANOTHER company
//     links, gets no PV; out of the company's linked bank, a PV;
//   - the tax-payment link: an entry paying SRB out of the drawer 1015 (counted before) or an unlinked 102x code is
//     422 NOT_A_TAX_PAYMENT; out of the linked bank it links, naming that bank; company B linking A's entry → 404.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { linkTaxPayment } from '../src/modules/accounting/taxPayments.js'
import { moneyCodesOf, moneyCodesOfCompany } from '../src/lib/moneyAccounts.js'
import { moneyCodesOf as registerMoneyCodesOf } from '../src/modules/accounting/paymentsRegister.js'
import { AppError, NotFoundError } from '../src/lib/errors.js'

const RUN = `mao${Date.now()}`
let A = ''
let B = ''
let bankA = ''
let n = 0
const ON = new Date('2026-10-15T07:00:00Z')

async function post(tenantId: string, sourceType: string, debit: string, credit: string, cents = 1_000) {
  const r = await postJournalEntry({
    tenantId, sourceType, sourceId: `${RUN}-${++n}`, description: `${sourceType} ${n}`, postedBy: 'test', entryDate: ON,
    lines: [{ accountCode: debit, type: 'debit', amountCents: cents }, { accountCode: credit, type: 'credit', amountCents: cents }],
  })
  return r.entryId
}
const noOf = async (id: string) => (await prisma.journalEntry.findUniqueOrThrow({ where: { id }, select: { voucherNo: true } })).voucherNo
const link = (tenantId: string, journalEntryId: string) => linkTaxPayment({
  tenantId, journalEntryId, authority: 'srb', periodFrom: '2026-10-01', periodTo: '2026-10-31', cprNumber: null, notes: null, userId: 'test',
})
async function account(tenantId: string, code: string, name: string) {
  if (!(await prisma.account.findFirst({ where: { tenantId, code } }))) {
    await prisma.account.create({ data: { tenantId, code, name, type: 'asset', isActive: true } })
  }
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Money A', slug: `${RUN}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: 'Money B', slug: `${RUN}-b` } })).id
  for (const t of [A, B]) {
    await ensureChartOfAccounts(t)
    await account(t, '1021', 'Bank — HBL')
    await account(t, '1025', 'Bank — not linked')
  }
  bankA = (await prisma.bankAccount.create({ data: { tenantId: A, name: 'HBL', bankName: 'HBL', accountCode: '1021', isActive: true } })).id
  // A bank row wrongly naming the drawer never makes 1015 a money account.
  await prisma.bankAccount.create({ data: { tenantId: A, name: 'Drawer (wrong)', bankName: 'X', accountCode: '1015', isActive: false } })
}, 60_000)

describe('one definition of a money account', () => {
  it('1010, 1011, 1020 + the company\'s linked banks; never 1015, never another company\'s bank', async () => {
    const m = await moneyCodesOf(prisma, [A, B])
    expect([...m.get(A)!].sort()).toEqual(['1010', '1011', '1020', '1021'])
    expect([...m.get(B)!].sort()).toEqual(['1010', '1011', '1020'])
    expect(registerMoneyCodesOf).toBe(moneyCodesOf)          // the register reads the same function
    expect((await moneyCodesOfCompany(prisma, A)).has('1015')).toBe(false)
  })

  it('the voucher stamp follows it', async () => {
    expect(await noOf(await post(A, 'opex.payment', '6040', '1021'))).toMatch(/^PV-/)
    expect(await noOf(await post(A, 'opex.payment', '6040', '1015'))).toBeNull()
    expect(await noOf(await post(A, 'opex.payment', '6040', '1025'))).toBeNull()
    expect(await noOf(await post(B, 'opex.payment', '6040', '1021'))).toBeNull()   // B links no bank to 1021
    expect(await noOf(await post(B, 'opex.payment', '6040', '1010'))).toMatch(/^PV-/)
  })

  it('the sales-tax payment link follows it (two companies)', async () => {
    for (const code of ['1015', '1025']) {
      const id = await post(A, 'manual', '2032', code, 800)
      const err = await link(A, id).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe('NOT_A_TAX_PAYMENT')
      expect(await prisma.salesTaxPayment.count({ where: { journalEntryId: id } })).toBe(0)
    }
    const good = await post(A, 'manual', '2032', '1021', 800)
    await expect(link(B, good)).rejects.toBeInstanceOf(NotFoundError)
    const row = await link(A, good)
    expect(row).toMatchObject({ tenantId: A, linked: true, paidCents: 800, bankAccountId: bankA, journalEntryId: good })
  })
})
