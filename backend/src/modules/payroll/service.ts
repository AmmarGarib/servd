// Payroll service.
//
// Workflow:
//   1. compute() — pair ClockLog in/out events into hours per user, multiply
//      by their hourlyRate. Returns a draft run; the operator reviews and
//      can adjust per-line (advances, deductions) before posting.
//   2. post() — emits the accrual JE: Dr Wages (per account) / Cr Wages
//      Payable. Locks the run.
//   3. pay() — operator records cash going out: Dr Wages Payable / Cr Bank.
//      Optionally tied to a bank statement line on the recon side.

import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'

// Maps every UserRole to the GL wage account its payroll posts to. New roles
// added after 2026-05-13 default-route by team:
//   management tiers   → WAGES_MANAGEMENT
//   FOH-adjacent       → WAGES_FOH
//   BOH-adjacent       → WAGES_KITCHEN
//   procurement/finance/hr/marketing → WAGES_MANAGEMENT (office salaries)
const ROLE_TO_WAGE_ACCOUNT: Record<UserRole, string> = {
  admin:          ACCT.WAGES_MANAGEMENT,
  manager:        ACCT.WAGES_MANAGEMENT,
  management:     ACCT.WAGES_MANAGEMENT,
  foh_management: ACCT.WAGES_MANAGEMENT,
  boh_management: ACCT.WAGES_MANAGEMENT,
  foh:            ACCT.WAGES_FOH,
  cashier:        ACCT.WAGES_FOH,
  expediter:      ACCT.WAGES_FOH,
  boh:            ACCT.WAGES_KITCHEN,
  kitchen:        ACCT.WAGES_KITCHEN,
  procurement:    ACCT.WAGES_MANAGEMENT,
  marketing:      ACCT.WAGES_MANAGEMENT,
  finance:        ACCT.WAGES_MANAGEMENT,
  hr:             ACCT.WAGES_MANAGEMENT,
}

function wageAccountFor(user: { role: UserRole; wageAccountCode: string | null }): string {
  return user.wageAccountCode ?? ROLE_TO_WAGE_ACCOUNT[user.role]
}

// ─── Hours from ClockLog ─────────────────────────────────────────────────────
//
// Pair every "in" with the next "out" for the same user. Unclosed "in" events
// at period end are clamped to MAX_SESSION_HOURS — NOT to periodEnd. A missed
// clock-out that's been open for two weeks is operator error, not 168 hours of
// labour. The unclosed count is surfaced so payroll can chase corrections.

const MAX_SESSION_HOURS = 12   // any single shift > 12h is treated as missed clock-out
const MAX_SESSION_MS = MAX_SESSION_HOURS * 3_600_000

interface HoursResult {
  userId: string
  userName: string
  role: UserRole
  hourlyRateCents: number | null
  wageAccountCode: string
  hours: number
  unclosedSessions: number   // diagnostic — surface to operator
}

export async function computeHoursForPeriod(periodStart: Date, periodEnd: Date): Promise<HoursResult[]> {
  // Pull ClockLog events that overlap the period, plus any leading "in" before
  // the period for users still on shift at periodStart.
  const events = await prisma.clockLog.findMany({
    where: { recordedAt: { lte: periodEnd } },
    orderBy: [{ userId: 'asc' }, { recordedAt: 'asc' }],
    select: { userId: true, type: true, recordedAt: true },
  })

  const userIds = Array.from(new Set(events.map((e) => e.userId)))
  if (userIds.length === 0) return []

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, name: true, role: true, hourlyRateCents: true, wageAccountCode: true },
  })
  const userMap = new Map(users.map((u) => [u.id, u]))

  const byUser = new Map<string, { msWorked: number; openIn: Date | null; unclosedSessions: number }>()
  for (const e of events) {
    const slot = byUser.get(e.userId) ?? { msWorked: 0, openIn: null, unclosedSessions: 0 }
    if (e.type === 'in') {
      // If a previous "in" was open, that session was never closed; ignore it.
      if (slot.openIn) slot.unclosedSessions += 1
      slot.openIn = e.recordedAt
    } else if (e.type === 'out' && slot.openIn) {
      // Clamp to (a) the period bounds AND (b) MAX_SESSION_MS from the start.
      // (b) prevents a missed clock-out from billing 24+ hours.
      const sessionStart = slot.openIn < periodStart ? periodStart : slot.openIn
      const naturalEnd   = e.recordedAt > periodEnd  ? periodEnd  : e.recordedAt
      const cappedEnd    = new Date(Math.min(naturalEnd.getTime(), sessionStart.getTime() + MAX_SESSION_MS))
      if (cappedEnd > sessionStart) {
        slot.msWorked += cappedEnd.getTime() - sessionStart.getTime()
      }
      if (cappedEnd < naturalEnd) {
        slot.unclosedSessions += 1   // clamped — flag for operator to verify
      }
      slot.openIn = null
    }
    byUser.set(e.userId, slot)
  }

  // Close any still-open sessions, but only credit up to MAX_SESSION_MS of
  // labour. Anything beyond that is treated as a missed clock-out and flagged.
  for (const [userId, slot] of byUser.entries()) {
    if (slot.openIn && slot.openIn < periodEnd) {
      const sessionStart = slot.openIn < periodStart ? periodStart : slot.openIn
      const cappedEnd    = new Date(Math.min(periodEnd.getTime(), sessionStart.getTime() + MAX_SESSION_MS))
      if (cappedEnd > sessionStart) {
        slot.msWorked += cappedEnd.getTime() - sessionStart.getTime()
      }
      slot.unclosedSessions += 1
      slot.openIn = null
      byUser.set(userId, slot)
    }
  }

  const out: HoursResult[] = []
  for (const [userId, slot] of byUser.entries()) {
    const user = userMap.get(userId)
    if (!user) continue
    out.push({
      userId,
      userName: user.name,
      role: user.role,
      hourlyRateCents: user.hourlyRateCents,
      wageAccountCode: wageAccountFor(user),
      hours: slot.msWorked / 3_600_000,
      unclosedSessions: slot.unclosedSessions,
    })
  }
  out.sort((a, b) => a.userName.localeCompare(b.userName))
  return out
}

// ─── Compute and store a draft payroll run ──────────────────────────────────

export async function computePayrollRun(input: {
  periodStart: Date
  periodEnd: Date
  createdById: string
  notes?: string
}) {
  const hours = await computeHoursForPeriod(input.periodStart, input.periodEnd)
  const billable = hours.filter((h) => h.hourlyRateCents != null && h.hours > 0)

  return prisma.$transaction(async (tx) => {
    const run = await tx.payrollRun.create({
      data: {
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        status: 'draft',
        createdById: input.createdById,
        notes: input.notes ?? null,
      },
    })

    let totalGross = 0
    for (const h of billable) {
      const grossCents = Math.round(h.hourlyRateCents! * h.hours)
      totalGross += grossCents
      await tx.payrollRunLine.create({
        data: {
          payrollRunId: run.id,
          userId: h.userId,
          userName: h.userName,
          hoursWorked: Number(h.hours.toFixed(3)),
          hourlyRateCents: h.hourlyRateCents!,
          grossCents,
          wageAccountCode: h.wageAccountCode,
          adjustmentCents: 0,
          netCents: grossCents,
          notes: h.unclosedSessions > 0 ? `${h.unclosedSessions} unclosed session(s) — verify` : null,
        },
      })
    }
    await tx.payrollRun.update({ where: { id: run.id }, data: { totalGrossCents: totalGross } })

    // Ghost-employee detection — every active user with a wage rate but ZERO
    // clock logs in this period is suspicious. Could be a forgotten contractor
    // OR a fake employee created by a manager. Flag for owner review.
    const activeWaged = await tx.user.findMany({
      where: { isActive: true, deletedAt: null, hourlyRateCents: { gt: 0 } },
      select: { id: true, name: true, role: true, hourlyRateCents: true, createdAt: true },
    })
    const userIdsWithLogs = new Set(hours.map((h) => h.userId))
    const ghosts = activeWaged.filter((u) => !userIdsWithLogs.has(u.id))
    if (ghosts.length > 0) {
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        kind: 'ghost_employee',
        severity: ghosts.length >= 3 ? 'high' : 'medium',
        title: `${ghosts.length} possible ghost employee(s) on payroll`,
        description: `Active users on the payroll register with wages but ZERO clock logs in this period: ${ghosts.map((g) => `${g.name} (${g.role})`).join(', ')}. Confirm each is a real working employee before posting payroll.`,
        entityType: 'PayrollRun',
        entityId: run.id,
        actorId: input.createdById,
        metadata: { ghostUsers: ghosts, periodStart: input.periodStart, periodEnd: input.periodEnd },
      })
    }

    return tx.payrollRun.findUnique({
      where: { id: run.id },
      include: { lines: { orderBy: { userName: 'asc' } } },
    })
  })
}

export async function adjustPayrollLine(lineId: string, adjustmentCents: number, notes?: string) {
  const line = await prisma.payrollRunLine.findUnique({
    where: { id: lineId },
    include: { payrollRun: { select: { status: true } } },
  })
  if (!line) throw new NotFoundError('PayrollRunLine', lineId)
  if (line.payrollRun.status !== 'draft') {
    throw new AppError('RUN_LOCKED', 'Cannot adjust a posted/paid payroll run', 422)
  }
  return prisma.payrollRunLine.update({
    where: { id: lineId },
    data: {
      adjustmentCents,
      netCents: line.grossCents + adjustmentCents,
      notes: notes ?? line.notes,
    },
  })
}

// ─── Post accrual: Dr Wages (per account) / Cr Wages Payable ────────────────

export async function postPayrollRun(runId: string, postedBy: string) {
  const run = await prisma.payrollRun.findUnique({
    where: { id: runId },
    include: { lines: true },
  })
  if (!run) throw new NotFoundError('PayrollRun', runId)
  if (run.status !== 'draft') {
    throw new AppError('ALREADY_POSTED', `Payroll run is ${run.status}`, 422)
  }

  // Aggregate per wage account so the JE has one debit per account
  const byAccount = new Map<string, number>()
  let totalNet = 0
  for (const line of run.lines) {
    if (line.netCents <= 0) continue
    byAccount.set(line.wageAccountCode, (byAccount.get(line.wageAccountCode) ?? 0) + line.netCents)
    totalNet += line.netCents
  }

  if (totalNet === 0) {
    throw new AppError('EMPTY_RUN', 'Payroll run has no billable lines', 422)
  }

  const lines: JournalLineInput[] = []
  for (const [code, cents] of byAccount.entries()) {
    lines.push({ accountCode: code, type: 'debit', amountCents: cents, memo: `Payroll ${run.periodStart.toISOString().slice(0,10)}–${run.periodEnd.toISOString().slice(0,10)}` })
  }
  lines.push({ accountCode: ACCT.WAGES_PAYABLE, type: 'credit', amountCents: totalNet, memo: `Wages payable accrued` })

  await postJournalEntry({
    sourceType: 'payroll.accrual',
    sourceId: run.id,
    description: `Payroll accrual ${run.periodStart.toISOString().slice(0,10)} → ${run.periodEnd.toISOString().slice(0,10)}`,
    entryDate: run.periodEnd,
    postedBy,
    lines,
  })

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: { status: 'posted', postedAt: new Date() },
  })

  return prisma.payrollRun.findUnique({
    where: { id: run.id },
    include: { lines: true },
  })
}

// ─── Pay: Dr Wages Payable / Cr Bank ─────────────────────────────────────────

export async function payPayrollRun(runId: string, paidBy: string, paidFromAccountCode?: string) {
  const run = await prisma.payrollRun.findUnique({ where: { id: runId } })
  if (!run) throw new NotFoundError('PayrollRun', runId)
  if (run.status !== 'posted') {
    throw new AppError('NOT_POSTABLE', `Run is ${run.status}; only "posted" runs can be paid`, 422)
  }

  const cashAccount = paidFromAccountCode ?? ACCT.BANK

  await postJournalEntry({
    sourceType: 'payroll.payment',
    sourceId: run.id,
    description: `Payroll payment for ${run.periodStart.toISOString().slice(0,10)} → ${run.periodEnd.toISOString().slice(0,10)}`,
    entryDate: new Date(),
    postedBy: paidBy,
    lines: [
      { accountCode: ACCT.WAGES_PAYABLE, type: 'debit',  amountCents: run.totalGrossCents, memo: 'Wages paid' },
      { accountCode: cashAccount,        type: 'credit', amountCents: run.totalGrossCents, memo: 'Bank transfer to staff' },
    ],
  })

  await prisma.payrollRun.update({
    where: { id: run.id },
    data: { status: 'paid', paidAt: new Date() },
  })

  return prisma.payrollRun.findUnique({
    where: { id: run.id },
    include: { lines: true },
  })
}

// ─── Labour cost as % of revenue ─────────────────────────────────────────────

export async function labourPctReport(periodStart: Date, periodEnd: Date) {
  // Sum payroll runs whose period falls inside the window (status: posted/paid)
  const runs = await prisma.payrollRun.findMany({
    where: {
      periodStart: { gte: periodStart },
      periodEnd:   { lte: periodEnd },
      status:      { in: ['posted', 'paid'] },
    },
    select: { totalGrossCents: true, lines: { select: { wageAccountCode: true, grossCents: true } } },
  })

  const labourCents = runs.reduce((s, r) => s + r.totalGrossCents, 0)

  // Revenue from ledger
  const revenueRows = await prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { amountCents: true },
    where: {
      type: 'credit',
      account: { type: 'revenue' },
      journalEntry: { entryDate: { gte: periodStart, lte: periodEnd } },
    },
  })
  const debitOffsets = await prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { amountCents: true },
    where: {
      type: 'debit',
      account: { type: 'revenue' },
      journalEntry: { entryDate: { gte: periodStart, lte: periodEnd } },
    },
  })
  const debitMap = new Map(debitOffsets.map((d) => [d.accountId, d._sum.amountCents ?? 0]))
  const revenueCents = revenueRows.reduce(
    (s, r) => s + (r._sum.amountCents ?? 0) - (debitMap.get(r.accountId) ?? 0),
    0,
  )

  // Per wage-account breakdown
  const byWageAccount = new Map<string, number>()
  for (const r of runs) {
    for (const line of r.lines) {
      byWageAccount.set(line.wageAccountCode, (byWageAccount.get(line.wageAccountCode) ?? 0) + line.grossCents)
    }
  }

  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    revenueCents,
    labourCents,
    labourPct: revenueCents > 0 ? Number(((labourCents / revenueCents) * 100).toFixed(2)) : 0,
    byWageAccount: Array.from(byWageAccount.entries()).map(([code, cents]) => ({ code, cents })),
  }
}
