// Head office (D1) items on the period-close checklist (spec §4.7 as amended by
// A1.5: CloseChecks in the ONE checklist, accounting/closeChecks.ts
// CLOSE_CHECKS — the orchestrator spreads `headOfficeCloseChecks` there; no
// separate 409 and no acknowledgeRecharge field: the CEO closes over either
// block with the checklist's own `acknowledge {keys, reason}`, which is
// recorded, audited and flagged 'period_close_override').
//
//   head_office_recharge  block (overridable)  the company being closed IS a head office with recharge
//                                              on: every month the close ends (from rechargeFromPeriod
//                                              on) must be ready(H, M)
//   head_office_charges   block (overridable)  the company being closed is SERVED by a head office with
//                                              recharge on: for each of its links (live, or ended with
//                                              lastChargedPeriod ≥ M) where M ≥ the HO's
//                                              rechargeFromPeriod and the month's split gives it a share
//                                              > 0, ready(H, M) must hold — so a company cannot close
//                                              before the head office has charged it (a company under two
//                                              head offices waits for both)
//
// ready(H, M) is runs.ts monthReadiness: payroll locked when required (and
// someone was payable), no open run, drift = pool − Σ posted base = 0. A month
// whose head-office cost is zero is ready with no run.
//
// Only months whose LAST DAY the new lock reaches count (a close through the
// 10th never asks for that month's recharge). With no head office anywhere
// both checks answer null — today's closes are unchanged.
//
// The company check reads the head office's readiness (its pool and runs) —
// the deliberate, narrow crossing of a served company into its head office's
// facts, like the inter-company checks read a pair's other side.

import type { CloseCheck, CloseCheckContext, CloseCheckDb, CloseProblem } from '../accounting/closeCheckTypes.js'
import { isMonthEnded, monthLabel } from '../intercompany/fleet.js'
import { monthReadiness, READINESS_TEXT, type MonthReadiness } from './runs.js'
import { splitForOrNull } from './splits.js'

const LINK = '/accounting/intercompany?tab=recharges'
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export interface RechargeProblem {
  headOfficeId: string
  headOfficeName: string
  period: string
  reasons: MonthReadiness['reasons']
  driftCents: number
}

/** The close's months whose last day is inside it. */
export function endedMonthsThrough(months: string[], through: Date): string[] {
  return months.filter((m) => isMonthEnded(m, new Date(through.getTime() + 1)))
}

type Memo = Map<string, Promise<MonthReadiness>>
function readiness(db: CloseCheckDb, memo: Memo, hoId: string, period: string): Promise<MonthReadiness> {
  const key = `${hoId}:${period}`
  let p = memo.get(key)
  if (!p) { p = monthReadiness(db, hoId, period); memo.set(key, p) }
  return p
}

/** Problems of a head office closing these months (empty when it is not a head office or recharge is off). */
export async function headOfficeRechargeProblems(db: CloseCheckDb, tenantId: string, months: string[], memo: Memo = new Map()): Promise<RechargeProblem[]> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { kind: true, name: true } })
  if (!t || t.kind !== 'head_office') return []
  const books = await db.headOfficeBooks.findUnique({ where: { tenantId }, select: { rechargeEnabled: true, rechargeFromPeriod: true } })
  if (!books?.rechargeEnabled || !books.rechargeFromPeriod) return []
  const out: RechargeProblem[] = []
  for (const m of [...months].sort()) {
    if (m < books.rechargeFromPeriod) continue
    const r = await readiness(db, memo, tenantId, m)
    if (!r.ready) out.push({ headOfficeId: tenantId, headOfficeName: t.name, period: m, reasons: r.reasons, driftCents: r.driftCents })
  }
  return out
}

/** The share the month's split gives a company (the first posted run's version for a month already recharged). */
async function shareOf(db: CloseCheckDb, hoId: string, companyId: string, period: string): Promise<number> {
  const first = await db.rechargeRun.findFirst({
    where: { tenantId: hoId, period, status: 'posted' },
    orderBy: [{ postedAt: 'asc' }, { createdAt: 'asc' }],
    select: { splitId: true },
  })
  if (first) {
    const line = await db.rechargeSplitLine.findFirst({ where: { splitId: first.splitId, companyTenantId: companyId }, select: { shareBps: true } })
    return line?.shareBps ?? 0
  }
  const v = await splitForOrNull(db, hoId, period)
  return v?.lines.find((l) => l.companyTenantId === companyId)?.shareBps ?? 0
}

/** Problems of a served company closing these months: its head offices that have not charged it yet. */
export async function headOfficeChargeProblems(db: CloseCheckDb, companyId: string, months: string[], memo: Memo = new Map()): Promise<RechargeProblem[]> {
  const links = await db.headOfficeLink.findMany({
    where: { companyTenantId: companyId },
    select: { tenantId: true, endedAt: true, lastChargedPeriod: true, headOffice: { select: { name: true } } },
  })
  if (links.length === 0) return []
  const out: RechargeProblem[] = []
  const hoIds = [...new Set(links.map((l) => l.tenantId))].sort()
  for (const hoId of hoIds) {
    const books = await db.headOfficeBooks.findUnique({ where: { tenantId: hoId }, select: { rechargeEnabled: true, rechargeFromPeriod: true } })
    if (!books?.rechargeEnabled || !books.rechargeFromPeriod) continue
    const mine = links.filter((l) => l.tenantId === hoId)
    for (const m of [...months].sort()) {
      if (m < books.rechargeFromPeriod) continue
      // A month the company is charged for: some link live, or ended on or after it.
      if (!mine.some((l) => l.endedAt === null || (l.lastChargedPeriod !== null && l.lastChargedPeriod >= m))) continue
      if ((await shareOf(db, hoId, companyId, m)) <= 0) continue
      const r = await readiness(db, memo, hoId, m)
      if (!r.ready) out.push({ headOfficeId: hoId, headOfficeName: mine[0]!.headOffice.name, period: m, reasons: r.reasons, driftCents: r.driftCents })
    }
  }
  return out
}

function describe(problems: RechargeProblem[]): string {
  return problems
    .map((p) => `${p.headOfficeName}, ${monthLabel(p.period)}: ${p.reasons.map((r) => READINESS_TEXT[r]).join('; ')}${p.driftCents !== 0 ? ` (${pkr(p.driftCents)} not recharged)` : ''}`)
    .join('. ')
}

function problemOf(key: 'head_office_recharge' | 'head_office_charges', title: string, lead: string, problems: RechargeProblem[]): CloseProblem | null {
  if (problems.length === 0) return null
  const cents = problems.reduce((s, p) => s + Math.abs(p.driftCents), 0)
  return {
    key, severity: 'block', overridable: true, title,
    detail: `${lead} ${describe(problems)}.`,
    count: problems.length,
    ...(cents !== 0 && { cents }),
    months: [...new Set(problems.map((p) => p.period))].sort(),
    link: LINK,
  }
}

const headOfficeRecharge: CloseCheck = {
  key: 'head_office_recharge',
  severity: 'block',
  overridable: true,
  async run(ctx: CloseCheckContext) {
    const problems = await headOfficeRechargeProblems(ctx.db, ctx.tenantId, endedMonthsThrough(ctx.months, ctx.newLock))
    return problemOf(
      'head_office_recharge',
      'Head office cost not recharged',
      'Recharge each month to the companies before closing it (lock the payroll, then prepare, submit and approve the run).',
      problems,
    )
  },
}

const headOfficeCharges: CloseCheck = {
  key: 'head_office_charges',
  severity: 'block',
  overridable: true,
  async run(ctx: CloseCheckContext) {
    const problems = await headOfficeChargeProblems(ctx.db, ctx.tenantId, endedMonthsThrough(ctx.months, ctx.newLock))
    return problemOf(
      'head_office_charges',
      'Head office has not charged this company yet',
      'This company carries a share of a head office\'s cost; close the month after the head office has recharged it.',
      problems,
    )
  },
}

/** The head-office checks, in the order the checklist shows them (the orchestrator spreads them into CLOSE_CHECKS). */
export const headOfficeCloseChecks: CloseCheck[] = [headOfficeRecharge, headOfficeCharges]
