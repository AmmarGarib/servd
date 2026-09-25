// One-off: find closed POS shifts that never reached the ledger, and (only
// with --apply) post the ones that can be posted safely.
//
// Why they are missing: until the one-close fix, POST /reconciliation/shift/
// :id/complete closed a drawer WITHOUT calling postShiftClose, so every shift
// closed from /reconciliation has no 'shift.close' journal entry — its sales,
// GST output and discounts are absent from the trial balance, P&L, cash flow
// and the sales-tax return. Shifts closed from the till can be missing too,
// when their post failed (e.g. a split tender whose card leg was still
// pending at close makes the entry unbalanced).
//
// Run it AFTER the expected-cash ledger fix is deployed (it is in the same
// change as this script): an entry built with the old formula would book
// every drop and pay-out as cash-variance loss.
//
//   npx tsx scripts/backfill-shift-close-postings.ts            # report only
//   npx tsx scripts/backfill-shift-close-postings.ts --apply    # post the postable ones
//
// It NEVER forces anything:
//   • period_locked         — the shift closed inside a locked month. Posting
//                             it means reopening that month or posting into the
//                             current one instead; that is the owner's call,
//                             so these are listed and left alone.
//   • unbalanced            — the entry would not balance (see above); listed
//                             for the accountant with the shift's totals.
//   • shift_has_no_company  — no company can be resolved; listed.
// Idempotent: a shift that already has its entry is skipped, and
// postJournalEntry is keyed on 'shift.close:<shiftId>'.

import { PrismaClient } from '@prisma/client'
import { buildShiftCloseEntry, postShiftClose } from '../src/modules/accounting/shiftPosting.js'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

interface Row { shiftId: string; closedAt: string; tenantId: string; outcome: string; detail: string }

async function main() {
  const closed = await prisma.shift.findMany({
    where: { status: 'closed' },
    select: { id: true, closedAt: true },
    orderBy: { closedAt: 'asc' },
  })
  const posted = new Set(
    (await prisma.journalEntry.findMany({
      where: { reference: { startsWith: 'shift.close:' } },
      select: { reference: true },
    })).map((e) => e.reference!.slice('shift.close:'.length)),
  )
  const missing = closed.filter((s) => !posted.has(s.id))
  console.log(`${closed.length} closed shifts, ${missing.length} with no 'shift.close' journal entry. Mode: ${APPLY ? 'APPLY' : 'report only'}`)

  const locks = new Map<string, Date | null>()
  const lockedThrough = async (tenantId: string) => {
    if (!locks.has(tenantId)) {
      const lock = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      locks.set(tenantId, lock?.lockedThrough ?? null)
    }
    return locks.get(tenantId) ?? null
  }

  const rows: Row[] = []
  for (const s of missing) {
    const entry = await buildShiftCloseEntry(s.id)
    const closedAt = s.closedAt?.toISOString() ?? ''
    if (!entry.ok) {
      rows.push({ shiftId: s.id, closedAt, tenantId: '', outcome: entry.reason, detail: '' })
      continue
    }
    if (entry.debits !== entry.credits) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'unbalanced', detail: `debits ${entry.debits} credits ${entry.credits}; ${entry.diagnostics}` })
      continue
    }
    const lock = await lockedThrough(entry.tenantId)
    if (lock && entry.entryDate <= lock) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'period_locked', detail: `books closed through ${lock.toISOString().slice(0, 10)}; ${entry.diagnostics}` })
      continue
    }
    if (!APPLY) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'would_post', detail: entry.diagnostics })
      continue
    }
    try {
      const r = await postShiftClose(s.id)
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: r.posted ? 'posted' : (r.reason ?? 'already_posted'), detail: r.entryId ?? '' })
    } catch (err) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'error', detail: (err as Error).message })
    }
  }

  console.log('shiftId,closedAt,tenantId,outcome,detail')
  for (const r of rows) console.log([r.shiftId, r.closedAt, r.tenantId, r.outcome, JSON.stringify(r.detail)].join(','))
  const count = (o: string) => rows.filter((r) => r.outcome === o).length
  console.log(
    `\nSummary: posted ${count('posted')}, would post ${count('would_post')}, period_locked ${count('period_locked')} (owner decision), ` +
    `unbalanced ${count('unbalanced')}, no company ${count('shift_has_no_company')}, nothing to post ${count('no_postable_activity')}, errors ${count('error')}.`,
  )
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => prisma.$disconnect())
