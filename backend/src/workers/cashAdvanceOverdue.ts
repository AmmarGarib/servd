// Cash requests whose receipts are overdue — the daily flag (H3, Hasnain
// 2026-10-14: "expense at payment; receipts kept for the file").
//
// A cash request is expensed to its category the moment it is paid
// (accounting/pettyCashPosting.ts cashRequestPayLine), so nothing is left to
// convert when the receipts are late: no money moves here. At 09:10 PKT, for
// every company that HAS such a request (not only active companies), each
// paid request past its dueBy (paid + OperationsConfig.cashAdvanceSettleDays)
// with NO receipt uploaded is flagged ONCE for a person —
// 'cash_request_receipts_overdue' in the request's own company, amount = what
// is still open — and stamped overdueFlaggedAt (claimed conditionally, so two
// runs never flag it twice). Legacy requests with no holder (payeeUserId
// null, 'needs review') are never touched. serviceClient, node-cron only.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'

let running = false

/**
 * One pass. Returns how many requests were flagged. `now` is injectable for
 * tests.
 */
export async function runCashAdvanceOverdueOnce(now: Date = new Date()): Promise<{ flagged: number }> {
  if (running) return { flagged: 0 }
  running = true
  let flagged = 0
  try {
    const due = {
      status: 'disbursed' as const,
      dueBy: { lt: now },
      overdueFlaggedAt: null,
      payeeUserId: { not: null },
      attachments: { none: { kind: 'receipt' } },
    }
    const companies = await prisma.cashVoucher.findMany({ where: due, distinct: ['tenantId'], select: { tenantId: true } })
    for (const { tenantId } of companies) {
      try {
        const rows = await prisma.cashVoucher.findMany({
          where: { ...due, tenantId },
          select: {
            id: true, tenantId: true, number: true, payeeName: true, purpose: true, conceptId: true, dueBy: true,
            amountCents: true, settledCents: true, returnedCents: true, convertedCents: true,
          },
          orderBy: { dueBy: 'asc' },
        })
        for (const v of rows) {
          const open = v.amountCents - v.settledCents - v.returnedCents - v.convertedCents
          if (open <= 0) continue
          // Claim it first: a second run (or a second worker) finds it stamped.
          const claimed = await prisma.cashVoucher.updateMany({
            where: { id: v.id, tenantId, status: 'disbursed', overdueFlaggedAt: null },
            data: { overdueFlaggedAt: now },
          })
          if (claimed.count === 0) continue
          await flagException({
            tenantId: v.tenantId,
            conceptId: v.conceptId,
            kind: 'cash_request_receipts_overdue',
            severity: 'medium',
            title: `Receipts overdue on cash request ${v.number} (${v.payeeName})`.slice(0, 200),
            description: `${v.payeeName} took PKR ${(open / 100).toFixed(0)} for "${v.purpose}" and no receipt was uploaded by ${v.dueBy!.toISOString().slice(0, 10)}. `
              + 'The cash was booked to its category when paid; the receipts are needed for the file.',
            entityType: 'CashVoucher',
            entityId: v.id,
            amountCents: open,
            metadata: { dueBy: v.dueBy!.toISOString() },
          })
          flagged++
        }
      } catch (err) {
        console.error(`[cashAdvanceOverdue] company ${tenantId} failed:`, (err as Error).message)
      }
    }
    if (flagged > 0) console.info(`[cashAdvanceOverdue] ${flagged} cash request(s) flagged: receipts overdue`)
    return { flagged }
  } finally {
    running = false
  }
}

export function startCashAdvanceOverdueWorker(): { stop: () => void } {
  const job = cron.schedule('10 9 * * *', () => {
    runCashAdvanceOverdueOnce().catch((err) => console.error('[cashAdvanceOverdue] failed:', (err as Error).message))
  }, { timezone: 'Asia/Karachi' })
  console.info('[cashAdvanceOverdue] worker started — daily 09:10 PKT')
  return { stop: () => job.stop() }
}
