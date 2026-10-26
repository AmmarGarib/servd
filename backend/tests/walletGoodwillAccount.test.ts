// Owner C6 (2026-10-26): "Give wallet goodwill credit its own account so I can
// see what we give away."
//
//   • 6065 Goodwill Credit to Customers is in the canonical chart, so every
//     company gets it (ensureChartOfAccounts).
//   • A NEW goodwill wallet credit is Dr 6065 / Cr 2050 in the top-up's own
//     company (A and B each in their own books).
//   • A paid top-up is unchanged (Dr the money account / Cr 2050).
//   • An OLD goodwill credit booked on 6060 is undone on 6060: a reversal
//     mirrors the entry's own lines, never today's mapping.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { CHART_OF_ACCOUNTS, ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { topUpWallet, WALLET_GOODWILL_EXPENSE } from '../src/modules/wallet/service.js'

const RUN = Date.now().toString(36)
let tenantA = ''
let tenantB = ''
let customer = ''

async function lines(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirstOrThrow({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  return je.lines.map((l) => [l.type, l.account.code, l.amountCents, l.account.tenantId] as const).sort()
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Goodwill A', slug: `gw-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Goodwill B', slug: `gw-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  customer = (await prisma.customer.create({ data: { name: 'Goodwill guest', email: `gw-${RUN}@example.com` } })).id
}, 60_000)

describe('C6 — goodwill wallet credit has its own account', () => {
  it('6065 is in the canonical chart and every company gets it', async () => {
    expect(WALLET_GOODWILL_EXPENSE).toBe('6065')
    expect(CHART_OF_ACCOUNTS.find((a) => a.code === '6065')).toMatchObject({ name: 'Goodwill Credit to Customers', type: 'expense' })
    for (const t of [tenantA, tenantB]) {
      expect(await prisma.account.findFirst({ where: { tenantId: t, code: '6065', isActive: true } })).not.toBeNull()
    }
  })

  it('a new goodwill credit posts Dr 6065 / Cr 2050 in its own company — A and B each', async () => {
    const a = await topUpWallet({ tenantId: tenantA, customerId: customer, amountCents: 12_000, kind: 'goodwill', description: 'late delivery', postedBy: 'test' })
    const b = await topUpWallet({ tenantId: tenantB, customerId: customer, amountCents: 3_000, kind: 'goodwill', description: 'cold fries', postedBy: 'test' })
    expect(await lines(tenantA, `wallet.topup:${a.transactionId}`)).toEqual([
      ['credit', '2050', 12_000, tenantA], ['debit', '6065', 12_000, tenantA],
    ])
    expect(await lines(tenantB, `wallet.topup:${b.transactionId}`)).toEqual([
      ['credit', '2050', 3_000, tenantB], ['debit', '6065', 3_000, tenantB],
    ])
    // Nothing new on 6060 in either company.
    expect(await prisma.journalLine.count({ where: { account: { tenantId: { in: [tenantA, tenantB] }, code: '6060' } } })).toBe(0)
  })

  it('a paid top-up is unchanged: Dr the money account (cash → 1010) / Cr 2050', async () => {
    const p = await topUpWallet({ tenantId: tenantA, customerId: customer, amountCents: 5_000, kind: 'paid', tender: 'cash', paymentRef: `GW-${RUN}`, description: 'paid', postedBy: 'test' })
    expect(await lines(tenantA, `wallet.topup:${p.transactionId}`)).toEqual([
      ['credit', '2050', 5_000, tenantA], ['debit', '1010', 5_000, tenantA],
    ])
  })

  it('an old goodwill credit booked on 6060 is reversed on 6060 (its own lines, not today’s mapping)', async () => {
    const sourceId = `old-${RUN}`
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'wallet.topup', sourceId, description: 'Wallet top-up (goodwill) — before C6', postedBy: 'test',
      lines: [
        { accountCode: '6060', type: 'debit', amountCents: 7_000 },
        { accountCode: '2050', type: 'credit', amountCents: 7_000 },
      ],
    })
    const rev = await reverseJournalEntry(tenantA, 'wallet.topup', sourceId, 'test reversal of an old goodwill credit')
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: rev.entryId! },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(je.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([
      ['credit', '6060', 7_000], ['debit', '2050', 7_000],
    ])
  })
})
