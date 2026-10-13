// The fixed-asset items of the period-close checklist (accounting/closeChecks.ts
// lists them in CLOSE_CHECKS; contract in accounting/closeCheckTypes.ts).
//
//   depreciation             block, CEO-overridable — an active asset still has
//                            a month to charge that ends on or before the new
//                            lock. Closing over it would leave the closed
//                            months' P&L short (the charge would later post
//                            late into the open month). Fix: charge now.
//   capitalisation_pending   warn — a capitalisation dated in the closed range
//                            is still waiting for the CEO (it will post late).
//
// chargeForClose is what the close runs (or offers) first: chargeThrough the
// last completed month the lock covers — the same one depreciation path.

import type { CloseCheck, CloseProblem } from '../accounting/closeCheckTypes.js'
import { toCents } from '../../lib/money.js'
import { lastCompletedPeriodPkt, lastPeriodEndingBy, periodIndex } from './schedule.js'
import { chargeThrough, unchargedThrough } from './service.js'

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** The last month a lock through `lockedThrough` covers that has also ended (never the running month). */
function closeThroughPeriod(lockedThrough: Date): string {
  const covered = lastPeriodEndingBy(lockedThrough)
  const last = lastCompletedPeriodPkt()
  return periodIndex(covered) <= periodIndex(last) ? covered : last
}

export const fixedAssetCloseChecks: CloseCheck[] = [
  {
    key: 'depreciation',
    severity: 'block',
    overridable: true,
    async run(ctx): Promise<CloseProblem | null> {
      const through = closeThroughPeriod(ctx.newLock)
      const rows = await unchargedThrough(ctx.db, ctx.tenantId, through)
      if (rows.length === 0) return null
      const months = Array.from(new Set(rows.flatMap((r) => r.months.map((m) => m.period)))).sort()
      const cents = rows.reduce((t, r) => t + r.months.reduce((s, m) => s + m.amountCents, 0), 0)
      return {
        key: 'depreciation',
        severity: 'block',
        title: 'Depreciation not charged',
        detail: `${rows.length} asset${rows.length === 1 ? '' : 's'} still ${rows.length === 1 ? 'has' : 'have'} depreciation to charge for `
          + `${months.length === 1 ? months[0] : `${months[0]} to ${months[months.length - 1]}`} (${pkr(cents)}). `
          + 'Charge it before closing — otherwise those months\' profit is overstated and the charge posts late into the open month.',
        count: rows.length,
        cents,
        months,
        link: '/accounting/fixed-assets?uncharged=1',
        fix: { method: 'POST', path: '/accounting/fixed-assets/depreciate', label: `Charge depreciation through ${through}` },
        overridable: true,
      }
    },
  },
  {
    key: 'capitalisation_pending',
    severity: 'warn',
    overridable: false,
    async run(ctx): Promise<CloseProblem | null> {
      const pending = await ctx.db.fixedAssetEvent.findMany({
        where: { tenantId: ctx.tenantId, kind: 'capitalise', status: 'pending', effectiveDate: { lte: ctx.newLock } },
        select: { amountCents: true },
      })
      if (pending.length === 0) return null
      const cents = pending.reduce((t, e) => t + (toCents(e.amountCents) ?? 0), 0)
      return {
        key: 'capitalisation_pending',
        severity: 'warn',
        title: 'Capitalisations waiting for the CEO',
        detail: `${pending.length} CapEx item${pending.length === 1 ? ' is' : 's are'} delivered but not yet on the register. `
          + 'Once approved they post into the open month with a note, and their depreciation catches up from the in-service month.',
        count: pending.length,
        ...(cents > 0 ? { cents } : {}),
        link: '/accounting/fixed-assets/requests?kind=capitalise&status=pending',
        overridable: false,
      }
    },
  },
]

/**
 * Charge every completed month the lock covers (through `lockedThrough`),
 * for one company, before it is closed. Idempotent; failures are flagged by
 * chargeThrough and left for the 'depreciation' check to report.
 */
export async function chargeForClose(tenantId: string, lockedThrough: Date, postedBy: string): Promise<void> {
  await chargeThrough(tenantId, closeThroughPeriod(lockedThrough), { postedBy })
}
