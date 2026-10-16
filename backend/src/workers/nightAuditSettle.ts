// Night audit settle worker (owner, 2026-10-16; SALES module only —
// modules/nightAudit). Every 60 minutes (first tick after 2 minutes), for each
// live company (each settle under the company's advisory lock):
//   (a) refreshAuditedDays — an audited sales day whose card payout and bank
//       side are now matched moves to 'closed' (closedVia 'auto');
//   (b) after 06:00 PKT, ONE 'night_audit_pending' flag per (company,
//       yesterday) when yesterday had sales and is still open;
//   (c) H45 (the CA, 2026-10-16: "after 2 working days"): ONE bell notice
//       ('night_audit.awaiting', CEO + finance with accounting) per (company,
//       audited day) still not closed once its 2nd working day after the sales
//       day is over — naming what is unmatched (card payout / bank deposit).
// It never audits a day and never posts.

import { serviceClient as prisma } from '../lib/prisma.js'
import { flagPendingYesterday, notifyAwaitingSettlement, refreshAuditedDays } from '../modules/nightAudit/service.js'

export const NIGHT_AUDIT_INTERVAL_MS = 60 * 60_000
const FIRST_TICK_MS = 2 * 60_000

let running = false
let timer: NodeJS.Timeout | null = null
let first: NodeJS.Timeout | null = null

export async function runNightAuditSettleOnce(now: Date = new Date()): Promise<{ companies: number; closed: number; flagged: number; awaiting: number }> {
  const companies = await prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true } })
  let closed = 0
  let flagged = 0
  let awaiting = 0
  for (const { id } of companies) {
    // Each day's settle holds the company's transaction-scoped advisory lock
    // (service.ts lockTenant), so two API processes never close a day twice;
    // the pending flag is de-duplicated on its entity.
    try {
      // At most 62 days a tick, least recently checked first — a company with a
      // longer backlog is worked through over the following ticks.
      closed += (await refreshAuditedDays(id, { limit: 62 })).closed
      if (await flagPendingYesterday(id, now)) flagged++
      awaiting += await notifyAwaitingSettlement(id, now)
    } catch (err) {
      console.error(`[night-audit-worker] company ${id}:`, (err as Error).message)
    }
  }
  return { companies: companies.length, closed, flagged, awaiting }
}

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await runNightAuditSettleOnce()
  } catch (err) {
    console.error('[night-audit-worker] tick failed:', (err as Error).message)
  } finally {
    running = false
  }
}

export function startNightAuditSettleWorker(): void {
  if (timer || first) return
  first = setTimeout(() => { void tick() }, FIRST_TICK_MS)
  timer = setInterval(() => { void tick() }, NIGHT_AUDIT_INTERVAL_MS)
}

export function stopNightAuditSettleWorker(): void {
  if (first) clearTimeout(first)
  if (timer) clearInterval(timer)
  first = null
  timer = null
}
