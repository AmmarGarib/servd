// One-off: find closed POS shifts that never reached the ledger and (only
// with --apply) post them — the command-line face of the same backfill the
// CEO runs from the API (POST /reconciliation/backfill-unposted, admin only,
// dry run by default). ONE implementation: backfillUnpostedShifts in
// src/modules/accounting/shiftPosting.ts.
//
// Why they are missing: POST /reconciliation/shift/:id/complete used to close
// a drawer WITHOUT posting it, and a close whose entry would not balance was
// refused. Owner decision 6: such a shift posts into its own month while that
// month is open, otherwise into the CURRENT open month with a memo naming the
// shift's original close date — a locked month is never reopened for it.
// Unbalanced and company-less shifts are listed, never forced. Idempotent.
//
//   npx tsx scripts/backfill-shift-close-postings.ts            # report only
//   npx tsx scripts/backfill-shift-close-postings.ts --apply    # post them

import { PrismaClient } from '@prisma/client'
import { backfillUnpostedShifts } from '../src/modules/accounting/shiftPosting.js'

const prisma = new PrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  const tenantIds = (await prisma.tenant.findMany({ select: { id: true } })).map((t) => t.id)
  const { rows, summary } = await backfillUnpostedShifts({ tenantIds, dryRun: !APPLY, postedBy: 'backfill-script' })
  console.log(`Mode: ${APPLY ? 'APPLY' : 'report only'} — ${rows.length} closed shift(s) with no 'shift.close' entry`)
  console.log('shiftId,closedAt,tenantId,outcome,detail')
  for (const r of rows) console.log([r.shiftId, r.closedAt ?? '', r.tenantId ?? '', r.outcome, JSON.stringify(r.detail)].join(','))
  console.log('\nSummary:', JSON.stringify(summary))
}

main().catch((err) => { console.error(err); process.exit(1) }).finally(() => prisma.$disconnect())
