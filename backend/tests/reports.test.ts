import { describe, it, expect, beforeEach } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { postJournalEntry } from '../src/modules/accounting/journal.ts'
import { trialBalance, balanceSheet, profitAndLoss } from '../src/modules/accounting/reports.ts'

const prisma = new PrismaClient()

beforeEach(async () => {
  await prisma.journalLine.deleteMany({})
  await prisma.journalEntry.deleteMany({})
})

describe('reports', () => {
  it('trial balance ties to zero after a balanced entry', async () => {
    await postJournalEntry({
      sourceType: 'test.tb',
      sourceId: 'e1',
      description: 'Sale',
      lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 1170 },
        { accountCode: '4001', type: 'credit', amountCents: 1000 },
        { accountCode: '2030', type: 'credit', amountCents:  170 },
      ],
    })

    const tb = await trialBalance(new Date())
    expect(tb.totals.debitCents).toBe(1170)
    expect(tb.totals.creditCents).toBe(1170)
    expect(tb.totals.differenceCents).toBe(0)
  })

  it('balance sheet balances (A = L + E + earnings)', async () => {
    // Sale: debit cash, credit revenue + GST
    await postJournalEntry({
      sourceType: 'test.bs.sale',
      sourceId: 'e2',
      description: 'Sale',
      lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 1170 },
        { accountCode: '4001', type: 'credit', amountCents: 1000 },
        { accountCode: '2030', type: 'credit', amountCents:  170 },
      ],
    })
    // Cost: derecognise inventory to COGS
    await postJournalEntry({
      sourceType: 'test.bs.cogs',
      sourceId: 'e2',
      description: 'COGS',
      lines: [
        { accountCode: '5010', type: 'debit',  amountCents: 400 },
        { accountCode: '1210', type: 'credit', amountCents: 400 },
      ],
    })

    const bs = await balanceSheet(new Date())
    // assets = liabilities + equity + currentEarnings
    expect(bs.totals.differenceCents).toBe(0)
    expect(bs.totals.currentEarningsCents).toBe(600) // 1000 revenue − 400 COGS
  })

  it('P&L surfaces COGS and discounts separately from OpEx', async () => {
    // Revenue 1000, COGS 400, marketing 50 (OpEx), discount 100 (contra-rev)
    await postJournalEntry({
      sourceType: 'test.pl',
      sourceId: 'e3',
      description: 'Combined',
      lines: [
        { accountCode: '1010', type: 'debit',  amountCents: 1450 },
        { accountCode: '5010', type: 'debit',  amountCents:  400 },
        { accountCode: '6060', type: 'debit',  amountCents:   50 },
        { accountCode: '7010', type: 'debit',  amountCents:  100 },
        { accountCode: '4001', type: 'credit', amountCents: 1000 },
        { accountCode: '1210', type: 'credit', amountCents:  400 },
        { accountCode: '1020', type: 'credit', amountCents:  600 },   // arbitrary balancing
      ],
    })

    const pl = await profitAndLoss(new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000))
    expect(pl.totals.revenueCents).toBe(1000)
    expect(pl.totals.cogsCents).toBe(400)
    expect(pl.totals.contraRevenueCents).toBe(100)
    expect(pl.totals.opexCents).toBe(50)
    expect(pl.totals.grossProfitCents).toBe(500)   // 1000 − 400 − 100
    expect(pl.totals.netProfitCents).toBe(450)     // 500 − 50
  })
})
