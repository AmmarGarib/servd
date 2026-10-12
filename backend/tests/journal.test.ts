import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.ts'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.ts'

// The app's client: BIGINT money columns come back as JS numbers (lib/money.ts).
import { serviceClient as prisma } from '../src/lib/prisma.ts'

// The ledger is per company: every posting names its company, and codes
// resolve inside that company's chart.
let tenantId: string

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Journal Co', slug: `journal-co-${Date.now()}` } })).id
  await ensureChartOfAccounts(tenantId)
})

beforeEach(async () => {
  // Clean ledger between tests
  await prisma.journalLine.deleteMany({})
  await prisma.journalEntry.deleteMany({})
  await prisma.periodLock.deleteMany({})
})

describe('postJournalEntry', () => {
  it('rejects unbalanced entries', async () => {
    await expect(
      postJournalEntry({
        tenantId,
        sourceType: 'test.unbalanced',
        sourceId: 'a',
        description: 'Bad',
        lines: [
          { accountCode: '1010', type: 'debit',  amountCents: 100 },
          { accountCode: '4001', type: 'credit', amountCents:  90 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_UNBALANCED' })
  })

  it('rejects negative amounts', async () => {
    await expect(
      postJournalEntry({
        tenantId,
        sourceType: 'test.neg',
        sourceId: 'a',
        description: 'Bad',
        lines: [
          { accountCode: '1010', type: 'debit',  amountCents: -100 },
          { accountCode: '4001', type: 'credit', amountCents: -100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_NEGATIVE_AMOUNT' })
  })

  it('posts a balanced entry and is idempotent on (sourceType, sourceId)', async () => {
    const input = {
      tenantId,
      sourceType: 'test.idem',
      sourceId: 'order-1',
      description: 'Test sale',
      lines: [
        { accountCode: '1010', type: 'debit'  as const, amountCents: 1170 },
        { accountCode: '4001', type: 'credit' as const, amountCents: 1000 },
        { accountCode: '2030', type: 'credit' as const, amountCents:  170 },
      ],
    }
    const first = await postJournalEntry(input)
    expect(first.posted).toBe(true)

    const replay = await postJournalEntry(input)
    expect(replay.posted).toBe(false)
    expect(replay.entryId).toBe(first.entryId)

    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: first.entryId } })
    expect(lines).toHaveLength(3)
  })

  it('reverseJournalEntry posts the inverse', async () => {
    const input = {
      tenantId,
      sourceType: 'test.reverse',
      sourceId: 'order-2',
      description: 'Test',
      lines: [
        { accountCode: '1010', type: 'debit'  as const, amountCents: 500 },
        { accountCode: '4001', type: 'credit' as const, amountCents: 500 },
      ],
    }
    await postJournalEntry(input)

    await reverseJournalEntry(tenantId, 'test.reverse', 'order-2', 'Customer cancelled')

    // Sum debits and credits across both entries should equal — net zero
    const lines = await prisma.journalLine.findMany({})
    const debits  = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    expect(debits).toBe(credits)
    expect(lines).toHaveLength(4)
  })

  it('refuses to post into a locked period', async () => {
    await prisma.periodLock.create({
      data: { tenantId, lockedThrough: new Date('2026-04-30T23:59:59Z'), lockedBy: 'test' },
    })

    await expect(
      postJournalEntry({
        tenantId,
        sourceType: 'test.locked',
        sourceId: 'order-3',
        description: 'Backdated',
        entryDate: new Date('2026-04-15'),
        lines: [
          { accountCode: '1010', type: 'debit',  amountCents: 100 },
          { accountCode: '4001', type: 'credit', amountCents: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
  })

  it('allows posting in the open period after a lock', async () => {
    await prisma.periodLock.create({
      data: { tenantId, lockedThrough: new Date('2026-04-30T23:59:59Z'), lockedBy: 'test' },
    })

    const result = await postJournalEntry({
      tenantId,
      sourceType: 'test.open',
      sourceId: 'order-4',
      description: 'Current period',
      entryDate: new Date('2026-05-01'),
      lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 100 },
        { accountCode: '4001', type: 'credit', amountCents: 100 },
      ],
    })
    expect(result.posted).toBe(true)
  })

  it('throws if any account code is missing', async () => {
    await expect(
      postJournalEntry({
        tenantId,
        sourceType: 'test.bad-account',
        sourceId: 'order-5',
        description: 'Bad',
        lines: [
          { accountCode: '9999', type: 'debit',  amountCents: 100 },
          { accountCode: '4001', type: 'credit', amountCents: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' })
  })
})
