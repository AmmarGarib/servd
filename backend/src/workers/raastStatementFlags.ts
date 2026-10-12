// Raast QR — the daily "not on a bank statement" flag (spec §7.3). The
// orchestrator starts it in index.ts under ENABLE_WORKERS. node-cron only, no
// Redis. At 09:05 PKT, for every active company: ONE open raast_unmatched
// flag per bank account whose provisional Raast receipts are older than the
// company's provisionalFlagDays (count, total, oldest, the last statement
// imported — "no statement imported since X" when that is why), resolved
// once none are left (reconciliation/raast.ts flagUnmatchedReceipts). A
// statement import refreshes its own company's flag at once.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { flagUnmatchedReceipts } from '../modules/reconciliation/raast.js'

let running = false

/** One pass over every active company. Returns the bank accounts flagged. */
export async function runRaastStatementFlagsOnce(): Promise<number> {
  if (running) return 0
  running = true
  let flagged = 0
  try {
    const companies = await prisma.tenant.findMany({ where: { isActive: true, deletedAt: null }, select: { id: true } })
    for (const c of companies) {
      try {
        flagged += await flagUnmatchedReceipts(c.id, { db: prisma })
      } catch (err) {
        console.error(`[raastStatementFlags] company ${c.id} failed:`, (err as Error).message)
      }
    }
    if (flagged > 0) console.info(`[raastStatementFlags] ${flagged} bank account(s) with Raast payments not on a statement`)
    return flagged
  } finally {
    running = false
  }
}

export function startRaastStatementFlagsWorker(): { stop: () => void } {
  const job = cron.schedule('5 9 * * *', () => {
    runRaastStatementFlagsOnce().catch((err) => console.error('[raastStatementFlags] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[raastStatementFlags] worker started — daily 09:05 PKT')
  return { stop: () => job.stop() }
}
