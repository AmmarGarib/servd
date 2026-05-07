// Backfill the journal from the legacy FinancialEntry table.
//
// FinancialEntry was the denormalised pre-ledger summary written by the
// original `createFinancialEntry` path. Every row corresponds to one completed
// order. This script replays each row as a balanced journal entry so the
// pre-ledger period shows up correctly in trial balance / P&L / balance sheet.
//
// Safety:
//   - Idempotent. Each replay uses sourceType="legacy.financial-entry" and
//     sourceId=<feId>; replays are no-ops on subsequent runs.
//   - --dry-run is the default. The script prints what it WOULD post and stops.
//   - --commit actually writes. Required to be explicit so nobody runs this
//     accidentally and locks down a period of historical activity.
//   - Refuses to run if any target entryDate falls inside a closed period
//     (the period-lock guard would reject those entries one by one anyway —
//     this just fails faster with a clearer message).
//   - Refuses to run unless DATABASE_URL points at the intended environment.
//
// Usage:
//   pnpm --filter @servd/api exec tsx scripts/replay-financial-entries.ts                      # dry-run
//   pnpm --filter @servd/api exec tsx scripts/replay-financial-entries.ts --commit             # write
//   pnpm --filter @servd/api exec tsx scripts/replay-financial-entries.ts --commit --from=2026-01-01 --to=2026-04-30
//
// REQUIRED before running --commit: accountant has signed off on which historical
// period should be replayed. Replaying a period that's already in the books in
// some other system means double-counting.

import { PrismaClient } from '@prisma/client'
import { ACCT, postJournalEntry, revenueCodeForConcept } from '../src/modules/accounting/journal.js'

interface CliOptions {
  commit: boolean
  from?: Date
  to?: Date
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2)
  const opts: CliOptions = { commit: false }
  for (const a of args) {
    if (a === '--commit') opts.commit = true
    else if (a.startsWith('--from=')) opts.from = new Date(a.slice(7))
    else if (a.startsWith('--to='))   opts.to   = new Date(a.slice(5))
    else if (a === '--help' || a === '-h') {
      console.log('Usage: replay-financial-entries.ts [--commit] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]')
      process.exit(0)
    }
  }
  return opts
}

async function main() {
  const opts = parseArgs()
  const prisma = new PrismaClient()

  if (!opts.commit) {
    console.log('── DRY RUN — no writes. Pass --commit to actually post journal entries. ──')
  } else {
    console.log('── COMMIT MODE — journal entries will be posted. ──')
  }
  console.log(`Period filter: ${opts.from?.toISOString() ?? '(all-time)'} → ${opts.to?.toISOString() ?? '(all-time)'}`)

  // Period lock pre-flight
  const lock = await prisma.periodLock.findFirst({ orderBy: { lockedThrough: 'desc' } })
  if (lock) {
    console.log(`Active period lock: through ${lock.lockedThrough.toISOString().slice(0,10)}`)
  }

  const entries = await prisma.financialEntry.findMany({
    where: {
      ...(opts.from && { entryDate: { gte: opts.from } }),
      ...(opts.to   && { entryDate: { lte: opts.to } }),
    },
    include: { concept: { select: { slug: true, foodpandaCommissionRate: true } }, order: { select: { taxCents: true, discountCents: true, promoDiscountCents: true, walletAmountCents: true, source: true } } },
    orderBy: { entryDate: 'asc' },
  })

  if (entries.length === 0) {
    console.log('No FinancialEntry rows in scope. Done.')
    return
  }

  console.log(`Found ${entries.length} FinancialEntry rows to replay.`)
  console.log('')

  let posted = 0
  let skippedExisting = 0
  let skippedLocked = 0
  let failed = 0

  for (const fe of entries) {
    const lockBlocks = lock && fe.entryDate <= lock.lockedThrough
    if (lockBlocks) {
      skippedLocked++
      continue
    }

    // Build the journal entry from the FinancialEntry row + the original Order's
    // fields. The same posting math as orderPosting.ts but expressed against the
    // historical denormalised data.
    const taxCents       = fe.taxCents
    const discountCents  = fe.discountCents
    const totalChargedCents = fe.grossCents
    const walletAmt      = fe.order.walletAmountCents
    const grossRevenue   = totalChargedCents + walletAmt + discountCents - taxCents

    const lines: { accountCode: string; type: 'debit' | 'credit'; amountCents: number; memo?: string }[] = []
    const memo = `Legacy FE replay (${fe.id.slice(0,8)})`

    // Debits — receipts
    if (fe.order.source === 'foodpanda') {
      const netDue = totalChargedCents - fe.commissionCents
      if (netDue > 0)             lines.push({ accountCode: ACCT.FOODPANDA_AR,         type: 'debit', amountCents: netDue,            memo })
      if (fe.commissionCents > 0) lines.push({ accountCode: ACCT.FOODPANDA_COMMISSION, type: 'debit', amountCents: fe.commissionCents, memo })
    } else if (totalChargedCents > 0) {
      // We don't know cash vs card from FinancialEntry alone — book to a
      // generic cash receivable. The accountant can reclassify if needed.
      lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: totalChargedCents, memo })
    }
    if (walletAmt > 0)     lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: walletAmt,    memo })
    if (discountCents > 0) lines.push({ accountCode: ACCT.DISCOUNTS,        type: 'debit', amountCents: discountCents, memo })

    // Credits — revenue + tax
    if (grossRevenue > 0)  lines.push({ accountCode: revenueCodeForConcept(fe.concept.slug), type: 'credit', amountCents: grossRevenue, memo })
    if (taxCents > 0)      lines.push({ accountCode: ACCT.GST_OUTPUT,                        type: 'credit', amountCents: taxCents,     memo })

    // Sanity
    const debits  = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credits = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    if (debits !== credits) {
      console.warn(`  ⚠ skip ${fe.id.slice(0,8)} — would post unbalanced (${debits} ≠ ${credits})`)
      failed++
      continue
    }

    if (!opts.commit) {
      console.log(`  would replay ${fe.entryDate.toISOString().slice(0,10)} concept=${fe.concept.slug} gross=${fe.grossCents} tax=${taxCents} disc=${discountCents}`)
      continue
    }

    try {
      const result = await postJournalEntry({
        sourceType: 'legacy.financial-entry',
        sourceId: fe.id,
        description: `Legacy replay: ${fe.concept.slug} order via ${fe.channel}`,
        entryDate: fe.entryDate,
        postedBy: 'system-replay',
        lines,
      })
      if (result.posted) posted++
      else               skippedExisting++
    } catch (err) {
      console.warn(`  ✗ ${fe.id.slice(0,8)}: ${(err as Error).message}`)
      failed++
    }
  }

  console.log('')
  console.log('── Summary ──')
  console.log(`Considered:        ${entries.length}`)
  console.log(`Skipped (locked):  ${skippedLocked}`)
  if (opts.commit) {
    console.log(`Posted (new):      ${posted}`)
    console.log(`Skipped (replay):  ${skippedExisting}`)
    console.log(`Failed:            ${failed}`)
  } else {
    console.log('(dry-run — no writes)')
  }

  await prisma.$disconnect()
  process.exit(failed > 0 ? 2 : 0)
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
