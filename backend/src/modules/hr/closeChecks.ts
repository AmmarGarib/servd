// HR's part of the period-close checklist (accounting/closeCheckTypes.ts;
// accounting/closeChecks.ts lists every module's checks in CLOSE_CHECKS).
//
//   payroll       (block, overridable) a month the close covers, from the
//                 company's FIRST payroll in servd on, with someone to pay but
//                 no locked payroll — or a locked one with money that never
//                 reached the books ('hr.payroll.accrual:<runId>').
//   fnf_unposted  (block, overridable) a full & final approved on or before
//                 the new lock whose accrual ('hr.final_settlement.accrual:<id>')
//                 is not on the books. Fix: POST /hr/final-settlement/post-unposted.
//
// The payroll baseline is the company's first HrPayrollRun period: months
// before servd ran payroll were paid outside it (and staff with no joining
// date would otherwise count in every one of them), so they never block.
// Every query reads ctx.tenantId only — another company's unlocked payroll
// never blocks this one's close.

import type { CloseCheck, CloseCheckContext, CloseProblem } from '../accounting/closeCheckTypes.js'
import { payableEmployees } from './service.js'
import { settlementParts, settlementNet } from './logic.js'
import { FNF_ACCRUAL } from './ledger.js'
import type { ApprovalEntry } from './logic.js'

export const PAYROLL_ACCRUAL = 'hr.payroll.accrual'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The date a month's payroll accrual is posted on: its last day (UTC midnight, as HR keeps dates). */
function accrualDateOf(period: string): Date {
  const [y, m] = period.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0))
}

const payrollCheck: CloseCheck = {
  key: 'payroll',
  severity: 'block',
  overridable: true,
  async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
    const { db, tenantId } = ctx
    const first = await db.hrPayrollRun.findFirst({ where: { tenantId }, orderBy: { period: 'asc' }, select: { period: true } })
    if (!first) return null
    // A month's payroll is booked on its last day (ledger.ts postPayrollAccrual),
    // so only a month whose last day the lock reaches is due: closing through
    // the 10th never asks for that month's payroll.
    const months = ctx.months.filter((m) => m >= first.period && accrualDateOf(m) <= ctx.newLock).sort()
    if (months.length === 0) return null

    const runs = await db.hrPayrollRun.findMany({
      where: { tenantId, period: { in: months } },
      select: { id: true, period: true, status: true },
    })
    const runOf = new Map(runs.map((r) => [r.period, r]))
    const locked = runs.filter((r) => r.status === 'locked')
    // A locked run with money must have its accrual on the books.
    const [withMoney, posted] = locked.length
      ? await Promise.all([
        db.hrPayslip.groupBy({
          by: ['runId'],
          where: { tenantId, runId: { in: locked.map((r) => r.id) }, OR: [{ earningsCents: { not: 0 } }, { netCents: { not: 0 } }, { deductionsCents: { not: 0 } }] },
          _sum: { netCents: true },
        }),
        db.journalEntry.findMany({
          where: { tenantId, reference: { in: locked.map((r) => `${PAYROLL_ACCRUAL}:${r.id}`) } },
          select: { reference: true },
        }),
      ])
      : [[], []]
    const moneyOf = new Map(withMoney.map((g) => [g.runId, g._sum.netCents ?? 0]))
    const postedRefs = new Set(posted.map((p) => p.reference))

    const notRun: string[] = []
    const notLocked: string[] = []
    const notPosted: string[] = []
    let unpostedCents = 0
    for (const m of months) {
      const run = runOf.get(m)
      if (run?.status === 'locked') {
        if (moneyOf.has(run.id) && !postedRefs.has(`${PAYROLL_ACCRUAL}:${run.id}`)) {
          notPosted.push(m)
          unpostedCents += moneyOf.get(run.id) ?? 0
        }
        continue
      }
      // No run, or one still draft / approved: only a month with someone to pay.
      if ((await payableEmployees(tenantId, m, db)).length === 0) continue
      ;(run ? notLocked : notRun).push(m)
    }
    const all = [...notRun, ...notLocked, ...notPosted].sort()
    if (all.length === 0) return null
    const bits = [
      notRun.length ? `no payroll for ${notRun.join(', ')}` : null,
      notLocked.length ? `payroll not locked for ${notLocked.join(', ')}` : null,
      notPosted.length ? `payroll locked but not on the books for ${notPosted.join(', ')} (marking it paid books it)` : null,
    ].filter(Boolean)
    return {
      key: 'payroll',
      severity: 'block',
      title: 'Payroll not locked and booked',
      detail: `${bits.join('; ')}. Lock each month's payroll in HR → Payroll so its wages are on the books before closing.`,
      count: all.length,
      ...(unpostedCents ? { cents: unpostedCents } : {}),
      months: all,
      link: '/hr/payroll',
      overridable: true,
    }
  },
}

/** When a record reached 'approved': its last approval, else (no approval
 *  steps, or approved before they were recorded) when it was last changed. */
function approvedAt(rec: { approvals: unknown; updatedAt: Date }): Date {
  const list = Array.isArray(rec.approvals) ? rec.approvals as ApprovalEntry[] : []
  const times = list.filter((a) => a && a.decision === 'approved' && typeof a.at === 'string').map((a) => new Date(a.at).getTime()).filter(Number.isFinite)
  return times.length ? new Date(Math.max(...times)) : rec.updatedAt
}

const fnfUnpostedCheck: CloseCheck = {
  key: 'fnf_unposted',
  severity: 'block',
  overridable: true,
  async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
    const { db, tenantId } = ctx
    const recs = await db.hrRecord.findMany({
      where: { tenantId, section: 'final_settlement', status: 'approved' },
      select: { id: true, data: true, approvals: true, updatedAt: true },
    })
    // Approved on or before the lock, with money to book (an all-zero
    // settlement books nothing, so it is never "unposted").
    const due = recs.filter((r) => approvedAt(r) <= ctx.newLock && Object.values(settlementParts(r.data)).some((v) => v !== 0))
    if (due.length === 0) return null
    const posted = await db.journalEntry.findMany({
      where: { tenantId, reference: { in: due.map((r) => `${FNF_ACCRUAL}:${r.id}`) } },
      select: { reference: true },
    })
    const have = new Set(posted.map((p) => p.reference))
    const missing = due.filter((r) => !have.has(`${FNF_ACCRUAL}:${r.id}`))
    if (missing.length === 0) return null
    const cents = missing.reduce((a, r) => a + Math.max(0, settlementNet(settlementParts(r.data))), 0)
    return {
      key: 'fnf_unposted',
      severity: 'block',
      title: 'Approved full & final settlements not booked',
      detail: `${plural(missing.length, 'approved settlement')} ${missing.length === 1 ? 'is' : 'are'} not on the books. Book them (they post into the open month) or cancel any that are wrong.`,
      count: missing.length,
      ...(cents ? { cents } : {}),
      link: '/hr/s/final_settlement',
      fix: { method: 'POST', path: '/hr/final-settlement/post-unposted', label: 'Book approved settlements' },
      overridable: true,
    }
  },
}

/** HR's close checks, in the order the checklist shows them. */
export const hrCloseChecks: CloseCheck[] = [payrollCheck, fnfUnpostedCheck]
