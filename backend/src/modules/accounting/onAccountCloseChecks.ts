// On-account clients — the period-close check (corporate clients on account).
// The orchestrator lists onAccountCloseChecks in accounting/closeChecks.ts
// CLOSE_CHECKS.
//
//   on_account_tieout   warn, overridable. Only for a company that has done
//                       the till-clearing cut-over (1110 → 1115,
//                       accounting/tillClearingCode.ts); before it 1110 still
//                       mixes till clearing and the check stays silent. It
//                       warns when any of these holds:
//                         • the 1110 tie-out (tillClearing.ts tieOutOf) does
//                           not tie: differenceCents ≠ 0;
//                         • 1110 lines nothing explains (manual journals,
//                           opening balances, …) are dated in the period;
//                         • on-account charges made in the period whose sale
//                           is booked are still on no statement more than 35
//                           days later.
//
// Every query reads ctx.tenantId only. Read-only.

import type { CloseCheck, CloseCheckContext, CloseProblem } from './closeCheckTypes.js'
import { tillClearingCutoverAt } from './tillClearingCode.js'
import { tieOutOf } from './tillClearing.js'
import { chargeNetCents, isChargeBookedTx } from '../receivables/onAccount.js'

const DAY = 86_400_000
/** Booked charges unbilled longer than this many days are warned about. */
export const UNBILLED_WARN_DAYS = 35
const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK')}`

export const onAccountTieoutCheck: CloseCheck = {
  key: 'on_account_tieout',
  severity: 'warn',
  overridable: true,
  async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
    const { db, tenantId, prevLock, newLock } = ctx
    if (!(await tillClearingCutoverAt(db, tenantId))) return null

    const tie = await tieOutOf(tenantId, db)
    const inPeriod = (d: Date) => (!prevLock || d > prevLock) && d <= newLock
    // tieOutOf returns the newest UNEXPLAINED_LIMIT lines; the count below is
    // of those — the full total is tie.unexplainedCount (shown in the detail).
    const unexplained = tie.unexplainedLines.filter((l) => inPeriod(new Date(l.entryDate)))

    const stale = new Date(Date.now() - UNBILLED_WARN_DAYS * DAY)
    const upTo = newLock < stale ? newLock : stale
    const charges = await db.customerAccountCharge.findMany({
      where: {
        tenantId,
        statementInvoiceId: null,
        chargedAt: { ...(prevLock ? { gt: prevLock } : {}), lte: upTo },
      },
      select: { tenantId: true, orderId: true, paymentId: true, amountCents: true, refundedCents: true },
    })
    let unbilledCount = 0
    let unbilledCents = 0
    for (const c of charges) {
      const net = chargeNetCents(c)
      if (net <= 0 || !(await isChargeBookedTx(db, c))) continue
      unbilledCount++
      unbilledCents += net
    }

    const parts: string[] = []
    if (tie.differenceCents !== 0) {
      parts.push(`1110 Customer receivable is ${pkr(Math.abs(tie.differenceCents))} ${tie.differenceCents > 0 ? 'above' : 'below'} what open invoices, statements and booked unbilled charges explain`)
    }
    if (unexplained.length > 0) {
      parts.push(`${unexplained.length} 1110 line${unexplained.length === 1 ? '' : 's'} in the period that no invoice, statement or till sale explains (${tie.unexplainedCount} in all)`)
    }
    if (unbilledCount > 0) {
      parts.push(`${unbilledCount} booked on-account charge${unbilledCount === 1 ? '' : 's'} (${pkr(unbilledCents)}) from the period not on a statement after ${UNBILLED_WARN_DAYS} days`)
    }
    if (parts.length === 0) return null

    return {
      key: 'on_account_tieout',
      severity: 'warn',
      title: 'On-account receivables do not tie out',
      detail: `${parts.join('; ')}. Check the tie-out on the clients page before closing.`,
      count: (tie.differenceCents !== 0 ? 1 : 0) + unexplained.length + unbilledCount,
      cents: tie.differenceCents !== 0 ? Math.abs(tie.differenceCents) : unbilledCents || undefined,
      link: '/accounting/receivables/clients',
      overridable: true,
    }
  },
}

/** Every on-account close check (one today). */
export const onAccountCloseChecks: CloseCheck[] = [onAccountTieoutCheck]
