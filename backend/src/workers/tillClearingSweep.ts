// Till clearing — the daily mover (accounting/tillClearing.ts). The
// orchestrator starts it in index.ts under ENABLE_WORKERS. node-cron only, no
// Redis. At 03:10 PKT, for every active company that HAS the cut-over marker
// (the CEO's one-time 1110 → 1115 cut-over — this worker never cuts a company
// over): moveLateTillLines — an allow-listed till line that reached 1110
// after the marker (a reversal of a pre-cut-over entry, a close that raced the
// cut-over) is moved to 1115 under its own key; any other unexplained 1110
// line raises one till_clearing_unexpected flag per entry. Companies without
// the marker are skipped, so nothing changes until the CEO cuts one over.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { TILL_CLEARING_CUTOVER_SETTING } from '../modules/accounting/tillClearingCode.js'
import { moveLateTillLines } from '../modules/accounting/tillClearing.js'

let running = false

/** One pass over every active, cut-over company. Returns { moved, flagged, refused } counts. */
export async function runTillClearingSweepOnce(): Promise<{ moved: number; flagged: number; refused: number }> {
  const total = { moved: 0, flagged: 0, refused: 0 }
  if (running) return total
  running = true
  try {
    const markers = await prisma.setting.findMany({
      where: { key: { startsWith: `${TILL_CLEARING_CUTOVER_SETTING}:` } },
      select: { key: true },
    })
    const cutOver = markers.map((m) => m.key.slice(TILL_CLEARING_CUTOVER_SETTING.length + 1)).filter(Boolean)
    if (cutOver.length === 0) return total
    const companies = await prisma.tenant.findMany({
      where: { id: { in: cutOver }, isActive: true, deletedAt: null }, select: { id: true },
    })
    for (const c of companies) {
      try {
        const r = await moveLateTillLines(c.id)
        total.moved += r.moved.length
        total.flagged += r.flagged.length
        total.refused += r.refused.length
      } catch (err) {
        console.error(`[tillClearingSweep] company ${c.id} failed:`, (err as Error).message)
      }
    }
    if (total.moved + total.flagged + total.refused > 0) {
      console.info(`[tillClearingSweep] moved ${total.moved}, flagged ${total.flagged}, refused ${total.refused}`)
    }
    return total
  } finally {
    running = false
  }
}

export function startTillClearingSweepWorker(): { stop: () => void } {
  const job = cron.schedule('10 3 * * *', () => {
    runTillClearingSweepOnce().catch((err) => console.error('[tillClearingSweep] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[tillClearingSweep] worker started — daily 03:10 PKT')
  return { stop: () => job.stop() }
}
