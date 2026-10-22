// Balance sheet lists no account at zero (owner, 2026-10-22: "Don't show
// accounts in balance sheet with 0 balance"); totals unchanged.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { balanceSheet } from '../src/modules/accounting/reports.js'

let T = ''
beforeAll(async () => {
  T = (await prisma.tenant.create({ data: { name: 'BS Zero', slug: `bsz-${Date.now()}` } })).id
  await ensureChartOfAccounts(T)
  const at = new Date('2026-10-01T10:00:00+05:00')
  // 1020 moves in and out (ends at zero); 1010 keeps 500.
  await postJournalEntry({ tenantId: T, sourceType: 'test.capital', sourceId: 'c1', description: 'Capital', entryDate: at, lines: [
    { accountCode: '1020', type: 'debit', amountCents: 800_00 }, { accountCode: '3010', type: 'credit', amountCents: 800_00 },
  ] })
  await postJournalEntry({ tenantId: T, sourceType: 'test.move', sourceId: 'm1', description: 'To cash', entryDate: at, lines: [
    { accountCode: '1010', type: 'debit', amountCents: 800_00 }, { accountCode: '1020', type: 'credit', amountCents: 800_00 },
  ] })
}, 60_000)

describe('balance sheet', () => {
  it('leaves out accounts at zero and still balances', async () => {
    const bs = await balanceSheet([T], new Date('2026-10-31T23:59:59+05:00'))
    const codes = bs.assets.map((r) => r.code)
    expect(codes).toContain('1010')
    expect(codes).not.toContain('1020')
    expect([...bs.assets, ...bs.liabilities, ...bs.equity].every((r) => r.balanceCents !== 0)).toBe(true)
    expect(bs.assets.reduce((s, r) => s + r.balanceCents, 0)).toBe(800_00)
  })
})
