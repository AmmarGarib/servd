// Head office (D1) — recharge runs: prepare → (refresh) → submit → approve
// (posts) / reject / withdraw → CEO reverse (spec §4.3–§4.5 on the EXISTING
// inter-company engine — owner, 2026-10-15; amendments A7–A10, A19).
//
// A run is the head office's own pending record for one PKT month:
//   pool      computePool (pool.ts) — the head office's net cost in the month
//   prior     Σ baseCents of the month's POSTED runs (a reversed run is not
//             'posted' any more, so it drops out and the month can run again)
//   base      pool − prior — what THIS run splits
//   kind      'monthly' while the month has no posted run, else 'true_up'
//             (a true-up uses the split of the month's FIRST posted run — A8)
//   lines     splitByBps(base, split) over the companies with a chargeable link
//             (live, or ended with lastChargedPeriod ≥ the month; else 422
//             COMPANY_UNLINKED) — retained = base − Σ lines stays with the HO
//
// Posting (approve) — one serviceClient transaction, all or nothing: per line
// ONE IntercompanyTransfer through intercompany/service.ts postSystemTransferTx
// (source 'ho_recharge', sourceRef 'ho_recharge:<lineId>'), which posts BOTH
// books under 'ic.transfer:<transferId>':
//   A > 0  debtor = the company  Dr its "Head office charges — <HO>" / Cr Due to HO
//          creditor = the HO     Dr Due from company / Cr its recharge account
//                                (4220 Head Office Recharge Income — HO-Q3, owner
//                                2026-10-26: INCOME, never the fleet's 6990)
//   A < 0  the sides swap (the HO is the debtor on its recharge account, the
//          company the creditor on its charges account).
// Dated the month's last day 23:59 PKT. A closed book refuses (409
// PERIOD_LOCKED_IN naming it) unless `postInOpenPeriod`, when EACH PAIR moves to
// the first day open in both its books (commonOpenPlacement, A10).
//
// Concurrency: every prepare / refresh / submit / approve / reverse of a
// (head office, month) takes pg_advisory_xact_lock(hashtext('ho.recharge'),
// hashtext('<hoId>:<period>')); the partial unique index recharge_runs_one_open
// is the backstop for "one open run". Claims are conditional updateMany on the
// status (two approvals post once).
//
// Separation of duties (A7): every create, refresh and submit appends the actor
// to preparedByIds inside the claim; approve / reject go through
// lib/approvalRights.ts (approvalSubject → assertCanApprove), and the approve
// claim also refuses a non-admin found in preparedByIds.
//
// A19: every write takes its companies from the RUN (its head office and its
// lines), never from the caller's active company.
//
// The worker (workers/headOfficeRecharge.ts) prepares and submits as 'system';
// it NEVER approves, so nothing posts without the CEO (or a head-office-wide
// Finance delegate).

import type { Prisma, PrismaClient } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { approvalInputOf, approvalSubject, assertCanApprove, type ApprovalGrant } from '../../lib/approvalRights.js'
import { fmtPktDate, parsePktStartOfDay } from '../accounting/dates.js'
import { payableEmployees } from '../hr/service.js'
import { assertMonth, isMonthEnded, monthBounds, monthLabel } from '../intercompany/fleet.js'
import { commonOpenPlacement, latestLock, postSystemTransferTx, reverseSystemTransfer } from '../intercompany/service.js'
import { chargesAccountCodeFor } from './accounts.js'
import { computePool, type PoolBasisLine, type PoolResult } from './pool.js'
import { FULL_BPS, splitByBps, splitFor, type SplitLineInput } from './splits.js'

export type Tx = Prisma.TransactionClient
export type Db = Tx | PrismaClient

/** Who prepares, refreshes, submits and withdraws a run — when a member of the head office. */
export const IC_PREPARERS = ['admin', 'owner', 'management', 'finance'] as const
/** The worker's actor id. */
export const SYSTEM = 'system'
export const RUN_STATUSES = ['draft', 'submitted', 'posted', 'rejected', 'withdrawn', 'reversed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]
export const OPEN_STATUSES = ['draft', 'submitted'] as const
/** The source / sourceRef of a run line's transfer. */
export const HO_RECHARGE_SOURCE = 'ho_recharge'
export const lineSourceRef = (lineId: string) => `ho_recharge:${lineId}`

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const

/** A person acting on a run (req.staffUser), or the worker. */
export interface RunActor { id: string; role: string; memberTenantIds: string[] }
export type Preparer = RunActor | typeof SYSTEM

const actorIdOf = (a: Preparer): string => (a === SYSTEM ? SYSTEM : a.id)
const personOf = (a: Preparer): string | null => (a === SYSTEM ? null : a.id)

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`
const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

// ─── Months and locks ────────────────────────────────────────────────────────

/** The natural date of a month's recharge: its last day, 23:59:00 PKT (after the month's other entries). */
export function naturalDateOf(period: string): Date {
  return new Date(`${monthBounds(period).lastDay}T23:59:00+05:00`)
}

/** Serialise every run change of one (head office, month) for the rest of the transaction. */
export async function lockMonth(tx: Tx, hoId: string, period: string): Promise<void> {
  const key = `${hoId}:${period}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ho.recharge'), hashtext(${key}::text))`
}

/** The head office (kind head_office, not deleted) or 404. */
export async function headOfficeOr404(db: Db, hoId: string): Promise<{ id: string; name: string; isActive: boolean }> {
  const t = await db.tenant.findUnique({ where: { id: hoId }, select: { id: true, name: true, kind: true, isActive: true, deletedAt: true } })
  if (!t || t.kind !== 'head_office' || t.deletedAt) throw new NotFoundError('Head office', hoId)
  return { id: t.id, name: t.name, isActive: t.isActive }
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)]
  if (uniq.length === 0) return new Map()
  const rows = await db.tenant.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } })
  return new Map(rows.map((t) => [t.id, t.name]))
}

// ─── The month's posted runs ─────────────────────────────────────────────────

/** Posted (non-reversed) runs of a month, first posted first. */
async function postedRuns(db: Db, hoId: string, period: string) {
  return db.rechargeRun.findMany({
    where: { tenantId: hoId, period, status: 'posted' },
    orderBy: [{ postedAt: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, splitId: true, baseCents: true },
  })
}

/** Σ baseCents of the month's posted runs. */
export async function postedPriorCents(db: Db, hoId: string, period: string): Promise<number> {
  return (await postedRuns(db, hoId, period)).reduce((s, r) => s + toCents(r.baseCents), 0)
}

// ─── Payroll ─────────────────────────────────────────────────────────────────

/** True when the head office's payroll for the month is locked, or it had nobody to pay. */
export async function payrollReady(db: Db, hoId: string, period: string): Promise<boolean> {
  const payable = await payableEmployees(hoId, period, db)
  if (payable.length === 0) return true
  const run = await db.hrPayrollRun.findFirst({ where: { tenantId: hoId, period, status: 'locked' }, select: { id: true } })
  return run !== null
}

// ─── Computing a run ─────────────────────────────────────────────────────────

export interface ComputedLine {
  companyTenantId: string
  linkId: string
  shareBps: number
  /** Signed paisa (negative = a credit to the company). */
  amountCents: number
}

export interface ComputedRun {
  hoId: string
  period: string
  kind: 'monthly' | 'true_up'
  splitId: string
  splitTotalBps: number
  pool: PoolResult
  priorCents: number
  baseCents: number
  lines: ComputedLine[]
  rechargedCents: number
  retainedCents: number
  warnings: string[]
}

/**
 * The link a company is charged through for `period`: live, or ended with
 * lastChargedPeriod ≥ period. 422 COMPANY_UNLINKED otherwise (never charge a
 * company after its link's last month).
 */
async function chargeableLink(db: Db, hoId: string, companyId: string, period: string, companyName: string): Promise<string> {
  const links = await db.headOfficeLink.findMany({
    where: { tenantId: hoId, companyTenantId: companyId },
    orderBy: { startedAt: 'desc' },
    select: { id: true, endedAt: true, lastChargedPeriod: true },
  })
  const hit = links.find((l) => l.endedAt === null || (l.lastChargedPeriod !== null && l.lastChargedPeriod >= period))
  if (!hit) {
    throw new AppError(
      'COMPANY_UNLINKED',
      `${companyName} is not linked to the head office for ${period} (its link ended before it) — replace the % table without it`,
      422,
      { companyTenantId: companyId },
    )
  }
  return hit.id
}

async function rechargeAccountOf(db: Db, hoId: string, accountId: string | null): Promise<{ id: string; code: string; type: string }> {
  const acc = accountId
    ? await db.account.findUnique({ where: { id: accountId }, select: { id: true, code: true, type: true, isActive: true, tenantId: true, controlledBy: true } })
    : null
  if (!acc || acc.tenantId !== hoId || !acc.isActive || acc.controlledBy || (acc.type !== 'expense' && acc.type !== 'revenue')) {
    throw new AppError('RECHARGE_ACCOUNT_UNUSABLE', "The head office's recharge account is missing or switched off — map it on the head office Books tab", 422)
  }
  return { id: acc.id, code: acc.code, type: acc.type }
}

/** The run's warnings (spec §4.3), stored on the run; the approver acknowledges them. */
async function warningsFor(
  db: Db,
  c: { hoId: string; period: string; baseCents: number; splitTotalBps: number; lines: ComputedLine[] },
  books: { requireLockedPayroll: boolean; rechargeAccountId: string | null },
): Promise<string[]> {
  const out: string[] = []
  const label = monthLabel(c.period)
  const { from, to } = monthBounds(c.period)
  const natural = naturalDateOf(c.period)
  if (!books.requireLockedPayroll && !(await payrollReady(db, c.hoId, c.period))) {
    out.push(`The head office's payroll for ${label} is not locked — its pay may still change`)
  }
  const jr = await db.journalRequest.count({
    where: { tenantId: c.hoId, status: { in: ['draft', 'submitted', 'returned'] }, entryDate: { gte: from, lte: to } },
  })
  if (jr > 0) out.push(`${jr} journal request${jr === 1 ? '' : 's'} dated in ${label} still wait${jr === 1 ? 's' : ''} in the head office's books`)
  const names = await namesOf(db, [c.hoId, ...c.lines.map((l) => l.companyTenantId)])
  for (const t of [c.hoId, ...c.lines.map((l) => l.companyTenantId)]) {
    const lock = await latestLock(db, t)
    if (lock && lock >= natural) {
      out.push(`${names.get(t) ?? 'A company'}'s books are closed through ${fmtPktDate(lock)} — approving needs "post into the first open month"`)
    }
  }
  // The revenue-account (eliminations) note is not a per-run warning since
  // HO-Q3: income is the agreed default, shown once on the Books tab.
  if (c.baseCents < 0) out.push(`The head office's cost to recharge is negative (${pkr(c.baseCents)}) — the companies are credited`)
  if (c.splitTotalBps < FULL_BPS) {
    out.push(`The % table adds up to ${pct(c.splitTotalBps)} — ${pct(FULL_BPS - c.splitTotalBps)} stays with the head office as its own cost`)
  }
  return out
}

/**
 * What a run for (head office, month) would be NOW. Pure read (no row is
 * written) — the preview, prepare, refresh and submit's staleness check.
 * 404 no head-office books; 422 NO_SPLIT / COMPANY_UNLINKED.
 */
export async function computeRun(db: Db, hoId: string, period: string): Promise<ComputedRun> {
  assertMonth(period, 'period')
  const books = await db.headOfficeBooks.findUnique({
    where: { tenantId: hoId },
    select: { requireLockedPayroll: true, rechargeAccountId: true },
  })
  if (!books) throw new NotFoundError('Head office books', hoId)
  const pool = await computePool(db, hoId, period)
  const posted = await postedRuns(db, hoId, period)
  const priorCents = posted.reduce((s, r) => s + toCents(r.baseCents), 0)
  const baseCents = pool.poolCents - priorCents
  const kind: ComputedRun['kind'] = posted.length > 0 ? 'true_up' : 'monthly'

  let split: { id: string; lines: SplitLineInput[] }
  if (posted.length > 0) {
    // A8: a true-up splits by the version the month was first recharged with.
    const row = await db.rechargeSplit.findUniqueOrThrow({
      where: { id: posted[0]!.splitId },
      select: { id: true, lines: { select: { companyTenantId: true, shareBps: true } } },
    })
    split = { id: row.id, lines: row.lines }
  } else {
    const v = await splitFor(db, hoId, period)
    split = { id: v.id, lines: v.lines }
  }
  const splitTotalBps = split.lines.reduce((s, l) => s + l.shareBps, 0)
  const amounts = splitByBps(baseCents, split.lines)
  const names = await namesOf(db, amounts.map((a) => a.companyTenantId))
  const lines: ComputedLine[] = []
  for (const a of amounts) {
    const linkId = await chargeableLink(db, hoId, a.companyTenantId, period, names.get(a.companyTenantId) ?? 'A company')
    lines.push({ companyTenantId: a.companyTenantId, linkId, shareBps: a.shareBps, amountCents: a.amountCents })
  }
  const rechargedCents = lines.reduce((s, l) => s + l.amountCents, 0)
  const retainedCents = baseCents - rechargedCents
  const warnings = await warningsFor(db, { hoId, period, baseCents, splitTotalBps, lines }, books)
  return { hoId, period, kind, splitId: split.id, splitTotalBps, pool, priorCents, baseCents, lines, rechargedCents, retainedCents, warnings }
}

// ─── Readiness (close checks, worker, health) ────────────────────────────────

export type ReadinessReason = 'payroll_not_locked' | 'open_run' | 'drift'

export interface MonthReadiness {
  hoId: string
  period: string
  ready: boolean
  reasons: ReadinessReason[]
  poolCents: number
  postedBaseCents: number
  /** pool − Σ base of posted runs (0 = fully recharged). */
  driftCents: number
  openRunId: string | null
}

/**
 * ready(H, M) (spec §4.7): payroll locked when required (and anybody was
 * payable), no open run, and drift = pool − Σ posted base = 0. A month whose
 * pool is zero and that has no run is ready.
 */
export async function monthReadiness(db: Db, hoId: string, period: string): Promise<MonthReadiness> {
  const books = await db.headOfficeBooks.findUnique({ where: { tenantId: hoId }, select: { requireLockedPayroll: true } })
  const reasons: ReadinessReason[] = []
  if (books?.requireLockedPayroll !== false && !(await payrollReady(db, hoId, period))) reasons.push('payroll_not_locked')
  const open = await db.rechargeRun.findFirst({
    where: { tenantId: hoId, period, status: { in: [...OPEN_STATUSES] } },
    select: { id: true },
  })
  if (open) reasons.push('open_run')
  const pool = await computePool(db, hoId, period)
  const postedBaseCents = await postedPriorCents(db, hoId, period)
  const driftCents = pool.poolCents - postedBaseCents
  if (driftCents !== 0) reasons.push('drift')
  return { hoId, period, ready: reasons.length === 0, reasons, poolCents: pool.poolCents, postedBaseCents, driftCents, openRunId: open?.id ?? null }
}

export const READINESS_TEXT: Readonly<Record<ReadinessReason, string>> = {
  payroll_not_locked: "the head office's payroll for the month is not locked",
  open_run: 'a recharge run for the month is still open (draft or waiting for approval)',
  drift: 'the head office cost for the month is not fully recharged',
}

// ─── Conditions to submit / post ─────────────────────────────────────────────

/**
 * Submit (and approve, again inside its transaction) needs, in order:
 *   409 ACCOUNTS_NOT_CONFIRMED  the CEO has not confirmed the accounts with the CA
 *   409 RECHARGE_OFF            recharge is switched off for this head office
 *   422 BEFORE_CUTOVER          the month is before the cutover month
 *   422 RECHARGE_ACCOUNT_UNUSABLE / CHARGES_ACCOUNT_UNUSABLE  an account is missing or off
 *   409 PAYROLL_NOT_LOCKED      payroll must be locked first (requireLockedPayroll, someone payable)
 * Returns the recharge account and each link's charges code.
 */
async function assertPostable(db: Db, hoId: string, period: string, linkIds: string[]): Promise<{ recharge: { id: string; code: string; type: string }; chargesCode: Map<string, string> }> {
  const books = await db.headOfficeBooks.findUnique({ where: { tenantId: hoId } })
  if (!books) throw new NotFoundError('Head office books', hoId)
  if (!books.accountsConfirmedAt) {
    throw new AppError('ACCOUNTS_NOT_CONFIRMED', 'The head office accounts are not confirmed with the CA yet (CEO → Head offices → Books)', 409)
  }
  if (!books.rechargeEnabled) throw new AppError('RECHARGE_OFF', 'Recharge is switched off for this head office (CEO → Head offices → Books)', 409)
  if (!books.rechargeFromPeriod || period < books.rechargeFromPeriod) {
    throw new AppError('BEFORE_CUTOVER', `${period} is before the head office's first recharge month (${books.rechargeFromPeriod ?? 'not set'})`, 422)
  }
  const recharge = await rechargeAccountOf(db, hoId, books.rechargeAccountId)
  const chargesCode = new Map<string, string>()
  for (const id of new Set(linkIds)) chargesCode.set(id, await chargesAccountCodeFor(db, id))
  if (books.requireLockedPayroll && !(await payrollReady(db, hoId, period))) {
    throw new AppError('PAYROLL_NOT_LOCKED', `Lock the head office's payroll for ${monthLabel(period)} first — the recharge carries its cost`, 409)
  }
  return { recharge, chargesCode }
}

// ─── Who prepares ────────────────────────────────────────────────────────────

/** A preparer must hold an IC_PREPARERS role and belong to the head office (404 otherwise: the id is not confirmed). */
export function assertHoPreparer(actor: Preparer, hoId: string): void {
  if (actor === SYSTEM) return
  if (!actor.memberTenantIds.includes(hoId)) throw new NotFoundError('Head office', hoId)
  if (!(IC_PREPARERS as readonly string[]).includes(actor.role)) {
    throw new AppError('FORBIDDEN', 'Only finance, management, owners and the CEO of the head office prepare recharges', 403)
  }
}

// ─── Rows ────────────────────────────────────────────────────────────────────

export const RUN_INCLUDE = { lines: { orderBy: { companyTenantId: 'asc' as const } } } as const
export type RunRow = Prisma.RechargeRunGetPayload<{ include: typeof RUN_INCLUDE }>

export async function loadRun(db: Db, id: string): Promise<RunRow | null> {
  return db.rechargeRun.findUnique({ where: { id }, include: RUN_INCLUDE })
}

function basisJson(basis: PoolBasisLine[]): Prisma.InputJsonValue {
  return basis.map((b) => ({ accountId: b.accountId, code: b.code, name: b.name, netCents: b.netCents }))
}

function poolJson(c: ComputedRun): Prisma.InputJsonValue {
  const p = c.pool.costPool
  return { include: p.include.map((r) => ({ from: r.from, to: r.to })), includeCodes: [...p.includeCodes], excludeCodes: [...p.excludeCodes] }
}

/** Does a stored run still match what it would be now? */
function matches(run: RunRow, c: ComputedRun): boolean {
  if (run.kind !== c.kind || run.splitId !== c.splitId) return false
  if (toCents(run.poolCents) !== c.pool.poolCents || toCents(run.priorCents) !== c.priorCents || toCents(run.baseCents) !== c.baseCents) return false
  if (run.lines.length !== c.lines.length) return false
  const want = new Map(c.lines.map((l) => [l.companyTenantId, l]))
  return run.lines.every((l) => {
    const w = want.get(l.companyTenantId)
    return !!w && w.linkId === l.linkId && w.shareBps === l.shareBps && w.amountCents === toCents(l.amountCents)
  })
}

// ─── Prepare / refresh / submit / withdraw ───────────────────────────────────

/**
 * Prepare a run (POST /, or the worker as 'system').
 *   422 PERIOD_NOT_OVER     the month has not ended in Pakistan
 *   422 NO_SPLIT / COMPANY_UNLINKED
 *   409 RUN_OPEN            a draft or submitted run exists for the month
 *   409 NOTHING_TO_RECHARGE pool − prior = 0
 */
export async function prepareRun(actor: Preparer, hoId: string, period: string, now: Date = new Date()): Promise<RunRow> {
  assertMonth(period, 'period')
  await headOfficeOr404(serviceClient, hoId)
  assertHoPreparer(actor, hoId)
  if (!isMonthEnded(period, now)) {
    throw new AppError('PERIOD_NOT_OVER', `${monthLabel(period)} has not ended yet in Pakistan — it is recharged after its last day`, 422)
  }
  const id = await serviceClient.$transaction(async (tx) => {
    await lockMonth(tx, hoId, period)
    const open = await tx.rechargeRun.findFirst({ where: { tenantId: hoId, period, status: { in: [...OPEN_STATUSES] } }, select: { id: true, status: true } })
    if (open) {
      throw new AppError('RUN_OPEN', `A recharge run for ${period} is already ${open.status === 'draft' ? 'a draft' : 'waiting for approval'} — refresh or withdraw it`, 409, { runId: open.id })
    }
    const c = await computeRun(tx, hoId, period)
    if (c.baseCents === 0) {
      throw new AppError('NOTHING_TO_RECHARGE', `Nothing to recharge for ${period}: the head office's cost is ${c.priorCents === 0 ? 'zero' : 'already recharged'}`, 409)
    }
    const person = personOf(actor)
    const run = await tx.rechargeRun.create({
      data: {
        tenantId: hoId, period, kind: c.kind, status: 'draft', splitId: c.splitId,
        costPool: poolJson(c), basis: basisJson(c.pool.basis),
        poolCents: c.pool.poolCents, priorCents: c.priorCents, baseCents: c.baseCents,
        rechargedCents: c.rechargedCents, retainedCents: c.retainedCents,
        warnings: c.warnings,
        preparedById: person, preparedByIds: person ? [person] : [],
        lines: { create: c.lines.map((l) => ({ tenantId: hoId, companyTenantId: l.companyTenantId, linkId: l.linkId, shareBps: l.shareBps, amountCents: l.amountCents })) },
      },
      select: { id: true },
    })
    return run.id
  }, TX_OPTS)
  return (await loadRun(serviceClient, id))!
}

async function runOr404(id: string): Promise<RunRow> {
  const run = await loadRun(serviceClient, id)
  if (!run) throw new NotFoundError('Recharge run', id)
  return run
}

/** Refresh a DRAFT (recompute everything). 409 RUN_NOT_DRAFT / NOTHING_TO_RECHARGE. */
export async function refreshRun(actor: Preparer, id: string): Promise<RunRow> {
  const run = await runOr404(id)
  assertHoPreparer(actor, run.tenantId)
  await serviceClient.$transaction(async (tx) => {
    await lockMonth(tx, run.tenantId, run.period)
    const person = personOf(actor)
    const claim = await tx.rechargeRun.updateMany({
      where: { id, status: 'draft' },
      data: person ? { preparedByIds: { push: person } } : { updatedAt: new Date() },
    })
    if (claim.count === 0) throw new AppError('RUN_NOT_DRAFT', 'Only a draft run can be refreshed', 409)
    const c = await computeRun(tx, run.tenantId, run.period)
    if (c.baseCents === 0) {
      throw new AppError('NOTHING_TO_RECHARGE', `Nothing to recharge for ${run.period} any more — withdraw this run`, 409)
    }
    await tx.rechargeRunLine.deleteMany({ where: { runId: id } })
    await tx.rechargeRun.update({
      where: { id },
      data: {
        kind: c.kind, splitId: c.splitId, stale: false,
        costPool: poolJson(c), basis: basisJson(c.pool.basis),
        poolCents: c.pool.poolCents, priorCents: c.priorCents, baseCents: c.baseCents,
        rechargedCents: c.rechargedCents, retainedCents: c.retainedCents, warnings: c.warnings,
        preparedAt: new Date(),
        lines: { create: c.lines.map((l) => ({ tenantId: run.tenantId, companyTenantId: l.companyTenantId, linkId: l.linkId, shareBps: l.shareBps, amountCents: l.amountCents })) },
      },
    })
  }, TX_OPTS)
  return (await loadRun(serviceClient, id))!
}

/**
 * Submit a draft for approval (assertPostable's refusals first). It recomputes:
 * a run whose figures moved is marked stale and refused (409 RUN_STALE —
 * refresh it). The run then waits in the Finance section of the inbox.
 */
export async function submitRun(actor: Preparer, id: string): Promise<RunRow> {
  const run = await runOr404(id)
  assertHoPreparer(actor, run.tenantId)
  if (run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', `This run is ${run.status} — only a draft can be submitted`, 409)
  const stale = await serviceClient.$transaction(async (tx) => {
    await lockMonth(tx, run.tenantId, run.period)
    const fresh = await loadRun(tx, id)
    if (!fresh || fresh.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Only a draft run can be submitted', 409)
    await assertPostable(tx, fresh.tenantId, fresh.period, fresh.lines.map((l) => l.linkId))
    const c = await computeRun(tx, fresh.tenantId, fresh.period)
    if (fresh.stale || !matches(fresh, c)) {
      await tx.rechargeRun.update({ where: { id }, data: { stale: true } })
      return true
    }
    const person = personOf(actor)
    const claim = await tx.rechargeRun.updateMany({
      where: { id, status: 'draft' },
      data: {
        status: 'submitted', submittedById: person, submittedAt: new Date(), warnings: c.warnings,
        ...(person && { preparedByIds: { push: person } }),
      },
    })
    if (claim.count === 0) throw new AppError('RUN_NOT_DRAFT', 'Only a draft run can be submitted', 409)
    return false
  }, TX_OPTS)
  if (stale) {
    throw new AppError('RUN_STALE', "The head office's figures for the month moved since this run was prepared — refresh it, then submit", 409)
  }
  return (await loadRun(serviceClient, id))!
}

/** Withdraw a draft or submitted run (any head-office preparer). 409 RUN_NOT_OPEN. */
export async function withdrawRun(actor: RunActor, id: string, note?: string | null): Promise<RunRow> {
  const run = await runOr404(id)
  assertHoPreparer(actor, run.tenantId)
  const claim = await serviceClient.rechargeRun.updateMany({
    where: { id, status: { in: [...OPEN_STATUSES] } },
    data: { status: 'withdrawn', decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || 'withdrawn by the preparer' },
  })
  if (claim.count === 0) throw new AppError('RUN_NOT_OPEN', `This run is ${run.status} — only a draft or submitted run can be withdrawn`, 409)
  return (await loadRun(serviceClient, id))!
}

// ─── Approve / reject ────────────────────────────────────────────────────────

export interface ApproveInput { postInOpenPeriod?: boolean; acknowledgeWarnings?: boolean; note?: string | null }

export interface ApproveResult {
  run: RunRow
  grant: ApprovalGrant
  /** (pool − prior, recomputed now) − baseCents: a true-up of this follows when ≠ 0. */
  driftCents: number
  lockedBooks: Array<{ tenantId: string; name: string; lockedThrough: string }>
}

/** The approval facts of a run (A5: on serviceClient, before the right is proven). 404 when there is none. */
async function approvalOf(req: FastifyRequest, id: string, action: string): Promise<ApprovalGrant> {
  const s = await approvalSubject('ho_recharge', id)
  if (!s) throw new NotFoundError('Recharge run', id)
  return assertCanApprove(req, approvalInputOf('ho_recharge', id, s, { entity: 'RechargeRun', action }))
}

/**
 * Approve and post (spec §4.3 / §4.4; A8, A10). The CEO, or a head-office-wide
 * Finance delegate of this head office — never a preparer or the submitter.
 *   422 WARNINGS_NOT_ACKNOWLEDGED  the run has warnings and acknowledgeWarnings is not set
 *   409 RUN_NOT_PENDING            not submitted (any more)
 *   409 RUN_STALE                  the month's posted prior changed (a reversal) — refresh
 *   409 PERIOD_LOCKED_IN {books}   a book is closed on the month's date (without postInOpenPeriod)
 *   409 ALREADY_POSTED             a line's transfer was already posted (defence)
 * plus assertPostable's refusals. All or nothing.
 */
export async function approveRun(req: FastifyRequest, id: string, input: ApproveInput): Promise<ApproveResult> {
  const grant = await approvalOf(req, id, 'approve a head-office recharge')
  const run = await runOr404(id)
  if (run.status !== 'submitted') throw new AppError('RUN_NOT_PENDING', `This run is ${run.status}, not waiting for approval`, 409)
  if (run.warnings.length > 0 && !input.acknowledgeWarnings) {
    throw new AppError('WARNINGS_NOT_ACKNOWLEDGED', 'Read the warnings on this run and tick that you have, then approve', 422, { warnings: run.warnings })
  }
  const me = req.staffUser!
  const isAdmin = me.role === 'admin'
  const hoId = run.tenantId
  const period = run.period

  const out = await serviceClient.$transaction(async (tx) => {
    await lockMonth(tx, hoId, period)
    const fresh = await loadRun(tx, id)
    if (!fresh || fresh.status !== 'submitted') throw new AppError('RUN_NOT_PENDING', 'This run is no longer waiting for approval', 409)
    const { recharge, chargesCode } = await assertPostable(tx, hoId, period, fresh.lines.map((l) => l.linkId))
    // A8: the prior this run was built on must still be the month's posted prior.
    const prior = await postedPriorCents(tx, hoId, period)
    if (prior !== toCents(fresh.priorCents)) {
      throw new AppError('RUN_STALE', `The month's posted recharges changed since this run was prepared (a reversal?) — refresh it`, 409)
    }
    const claim = await tx.rechargeRun.updateMany({
      where: { id, status: 'submitted', ...(isAdmin ? {} : { NOT: { preparedByIds: { has: me.id } } }) },
      data: {
        status: 'posted', decidedById: me.id, decidedAt: new Date(), decisionNote: input.note?.trim() || null,
        decidedVia: grant.via, delegationId: grant.via === 'delegation' ? grant.delegationId : null, postedAt: new Date(),
      },
    })
    if (claim.count === 0) throw new AppError('RUN_NOT_PENDING', 'This run is no longer waiting for approval', 409)

    // Dates, per pair (A10).
    const natural = naturalDateOf(period)
    const names = await namesOf(tx, [hoId, ...fresh.lines.map((l) => l.companyTenantId)])
    const lockOf = new Map<string, Date | null>()
    const lockFor = async (t: string) => {
      if (!lockOf.has(t)) lockOf.set(t, await latestLock(tx, t))
      return lockOf.get(t) ?? null
    }
    const locked: Array<{ tenantId: string; name: string; lockedThrough: string }> = []
    for (const t of [hoId, ...fresh.lines.map((l) => l.companyTenantId)]) {
      const lock = await lockFor(t)
      if (lock && lock >= natural && !locked.some((b) => b.tenantId === t)) {
        locked.push({ tenantId: t, name: names.get(t) ?? 'A company', lockedThrough: fmtPktDate(lock) })
      }
    }
    if (locked.length > 0 && !input.postInOpenPeriod) {
      throw new AppError(
        'PERIOD_LOCKED_IN',
        `${locked.map((b) => `${b.name} is closed through ${b.lockedThrough}`).join('; ')} — nothing was posted. Approve with "post into the first open month" to date those pairs after the close.`,
        409,
        { books: locked },
      )
    }

    const label = monthLabel(period)
    const trueUp = fresh.kind === 'true_up'
    for (const line of fresh.lines) {
      const a = toCents(line.amountCents)
      if (a === 0) continue
      const company = line.companyTenantId
      let entryDate = natural
      let memoNote: string | undefined
      const pairLocked = [hoId, company].some((t) => { const l = lockOf.get(t); return !!l && l >= natural })
      if (pairLocked) {
        const place = await commonOpenPlacement(tx, [hoId, company], natural, `the ${label} head office charge`)
        if ('lockedThroughToday' in place) {
          throw new AppError(
            'PERIOD_LOCKED_IN',
            `${names.get(place.tenantId) ?? 'A company'} is closed through ${fmtPktDate(place.lockedThrough)}, today included — nothing was posted`,
            409,
            { books: [{ tenantId: place.tenantId, name: names.get(place.tenantId) ?? 'A company', lockedThrough: fmtPktDate(place.lockedThrough) }] },
          )
        }
        entryDate = place.entryDate
        memoNote = place.memoNote
      }
      const postedLate = memoNote !== undefined
      const memo = `Head office charge ${period} — ${names.get(hoId) ?? 'Head office'} (${pct(line.shareBps)})${trueUp ? ' true-up' : ''}${postedLate ? ' (posted late)' : ''}`
      const charges = chargesCode.get(line.linkId)!
      const res = await postSystemTransferTx(tx, {
        kind: 'charge',
        source: HO_RECHARGE_SOURCE,
        sourceRef: lineSourceRef(line.id),
        debtorTenantId: a > 0 ? company : hoId,
        creditorTenantId: a > 0 ? hoId : company,
        debtorAccountCode: a > 0 ? charges : recharge.code,
        creditorAccountCode: a > 0 ? recharge.code : charges,
        amountCents: Math.abs(a),
        entryDate,
        memo,
        memoNote,
        period,
        preparedById: me.id,
      })
      if (res.alreadyPosted) {
        throw new AppError('ALREADY_POSTED', `The charge for ${names.get(company) ?? 'a company'} was already posted — nothing was posted again`, 409)
      }
      await tx.rechargeRunLine.update({
        where: { id: line.id },
        data: { transferId: res.transferId, entryDate, postedLate, memoNote: memoNote ?? null },
      })
    }

    const pool = await computePool(tx, hoId, period)
    const driftCents = pool.poolCents - prior - toCents(fresh.baseCents)
    await tx.rechargeRun.update({ where: { id }, data: { driftAtApprovalCents: driftCents } })
    return { driftCents, lockedBooks: locked }
  }, TX_OPTS)

  return { run: (await loadRun(serviceClient, id))!, grant, ...out }
}

/** Reject a submitted run {note} — the same rights as approve. 409 RUN_NOT_PENDING. */
export async function rejectRun(req: FastifyRequest, id: string, note: string): Promise<{ run: RunRow; grant: ApprovalGrant }> {
  const grant = await approvalOf(req, id, 'reject a head-office recharge')
  const me = req.staffUser!
  const claim = await serviceClient.rechargeRun.updateMany({
    where: { id, status: 'submitted', ...(me.role === 'admin' ? {} : { NOT: { preparedByIds: { has: me.id } } }) },
    data: {
      status: 'rejected', decidedById: me.id, decidedAt: new Date(), decisionNote: note.trim(),
      decidedVia: grant.via, delegationId: grant.via === 'delegation' ? grant.delegationId : null,
    },
  })
  if (claim.count === 0) throw new AppError('RUN_NOT_PENDING', 'This run is no longer waiting for approval', 409)
  return { run: (await loadRun(serviceClient, id))!, grant }
}

// ─── Reverse (CEO) ───────────────────────────────────────────────────────────

/**
 * The CEO reverses a POSTED run (both books of every line, through
 * reverseSystemTransfer: 'ic.transfer.reversal:<id>', on the line's own date
 * while open, else the first day open in both). In the same transaction every
 * OPEN run of the same (head office, month) is withdrawn — it was built on the
 * prior this reversal removes (A8). The caller checks CEO + membership.
 *   409 RUN_NOT_POSTED
 */
export async function reverseRun(actor: RunActor, id: string, reason: string): Promise<{ run: RunRow; withdrawnRunIds: string[] }> {
  const run = await runOr404(id)
  const why = reason.trim()
  if (why.length < 10) throw new AppError('REASON_REQUIRED', 'Say why the recharge is reversed (at least 10 characters)', 422)
  const withdrawn = await serviceClient.$transaction(async (tx) => {
    await lockMonth(tx, run.tenantId, run.period)
    const claim = await tx.rechargeRun.updateMany({
      where: { id, status: 'posted' },
      data: { status: 'reversed', reversedById: actor.id, reversedAt: new Date(), reversalReason: why },
    })
    if (claim.count === 0) throw new AppError('RUN_NOT_POSTED', 'Only a posted run can be reversed', 409)
    const lines = await tx.rechargeRunLine.findMany({ where: { runId: id }, select: { transferId: true, entryDate: true } })
    for (const l of lines) {
      if (!l.transferId) continue
      await reverseSystemTransfer(l.transferId, `Head office recharge ${run.period} reversed: ${why}`, { tx, entryDate: l.entryDate ?? naturalDateOf(run.period) })
    }
    const open = await tx.rechargeRun.findMany({
      where: { tenantId: run.tenantId, period: run.period, status: { in: [...OPEN_STATUSES] } },
      select: { id: true },
    })
    if (open.length > 0) {
      await tx.rechargeRun.updateMany({
        where: { id: { in: open.map((r) => r.id) }, status: { in: [...OPEN_STATUSES] } },
        data: { status: 'withdrawn', decidedById: actor.id, decidedAt: new Date(), decisionNote: 'superseded by reversal' },
      })
    }
    return open.map((r) => r.id)
  }, TX_OPTS)
  return { run: (await loadRun(serviceClient, id))!, withdrawnRunIds: withdrawn }
}

// ─── Presenting ──────────────────────────────────────────────────────────────

export interface RunLineView {
  id: string
  companyTenantId: string
  companyName: string | null
  linkId: string
  shareBps: number
  amountCents: number
  transferId: string | null
  entryDate: string | null
  postedLate: boolean
  memoNote: string | null
}

export interface RunView {
  id: string
  tenantId: string
  headOfficeName: string | null
  period: string
  kind: string
  status: string
  stale: boolean
  splitId: string
  costPool: Prisma.JsonValue
  basis: Prisma.JsonValue
  poolCents: number
  priorCents: number
  baseCents: number
  /** Full viewers: the whole run's charge. A company-only viewer: its own lines' sum (A5). */
  rechargedCents: number
  /** null for a company-only viewer (it would expose the other companies' share). */
  retainedCents: number | null
  driftAtApprovalCents: number | null
  /** A company-only viewer gets only the warnings that name no other company. */
  warnings: string[]
  preparedById: string | null
  preparedByIds: string[]
  preparedAt: string
  submittedById: string | null
  submittedAt: string | null
  decidedById: string | null
  decidedAt: string | null
  decisionNote: string | null
  decidedVia: string | null
  postedAt: string | null
  reversedAt: string | null
  reversalReason: string | null
  lines: RunLineView[]
  /** The viewer belongs to the head office (sees every line). */
  memberOfHeadOffice: boolean
}

const BOOKS_CLOSED_WARNING = /^(.*)'s books are closed through /
const SPLIT_TOTAL_WARNING = /^The % table adds up to /

/**
 * The run's warnings a company-only viewer may read (A5, fail closed): a
 * "books are closed" warning only when it names the head office or one of the
 * viewer's own companies on the run (a renamed company's old warning is dropped, never
 * shown), and never the % table total (it tells the other companies' share).
 */
export function companyViewWarnings(warnings: readonly string[], ownNames: readonly string[]): string[] {
  const own = new Set(ownNames)
  return warnings.filter((w) => {
    if (SPLIT_TOTAL_WARNING.test(w)) return false
    const m = BOOKS_CLOSED_WARNING.exec(w)
    if (m) return own.has(m[1]!)
    return true
  })
}

/**
 * Rows the viewer may see (the caller filtered them). A viewer who belongs to
 * the head office (or holds its hand-over) sees every line; a company member
 * sees only its own company's lines (A5).
 */
export async function presentRuns(rows: RunRow[], viewer: { memberTenantIds: string[]; fullHeadOffices: ReadonlySet<string> }): Promise<RunView[]> {
  const names = await namesOf(serviceClient, rows.flatMap((r) => [r.tenantId, ...r.lines.map((l) => l.companyTenantId)]))
  const iso = (d: Date | null) => (d ? d.toISOString() : null)
  const members = new Set(viewer.memberTenantIds)
  return rows.map((r) => {
    const full = viewer.fullHeadOffices.has(r.tenantId)
    const ownLines = r.lines.filter((l) => full || members.has(l.companyTenantId))
    return {
      id: r.id,
      tenantId: r.tenantId,
      headOfficeName: names.get(r.tenantId) ?? null,
      period: r.period,
      kind: r.kind,
      status: r.status,
      stale: r.stale,
      splitId: r.splitId,
      costPool: r.costPool,
      basis: r.basis,
      poolCents: toCents(r.poolCents),
      priorCents: toCents(r.priorCents),
      baseCents: toCents(r.baseCents),
      rechargedCents: full ? toCents(r.rechargedCents) : ownLines.reduce((a, l) => a + toCents(l.amountCents), 0),
      retainedCents: full ? toCents(r.retainedCents) : null,
      driftAtApprovalCents: r.driftAtApprovalCents === null ? null : toCents(r.driftAtApprovalCents),
      warnings: full ? r.warnings : companyViewWarnings(r.warnings, [r.tenantId, ...ownLines.map((l) => l.companyTenantId)].map((t) => names.get(t)).filter((n): n is string => !!n)),
      preparedById: r.preparedById,
      preparedByIds: r.preparedByIds,
      preparedAt: r.preparedAt.toISOString(),
      submittedById: r.submittedById,
      submittedAt: iso(r.submittedAt),
      decidedById: r.decidedById,
      decidedAt: iso(r.decidedAt),
      decisionNote: r.decisionNote,
      decidedVia: r.decidedVia,
      postedAt: iso(r.postedAt),
      reversedAt: iso(r.reversedAt),
      reversalReason: r.reversalReason,
      lines: ownLines
        .map((l) => ({
          id: l.id,
          companyTenantId: l.companyTenantId,
          companyName: names.get(l.companyTenantId) ?? null,
          linkId: l.linkId,
          shareBps: l.shareBps,
          amountCents: toCents(l.amountCents),
          transferId: l.transferId,
          entryDate: iso(l.entryDate),
          postedLate: l.postedLate,
          memoNote: l.memoNote,
        })),
      memberOfHeadOffice: members.has(r.tenantId),
    }
  })
}

/** The PKT first day of a month (for statements and range defaults). */
export function monthStart(period: string): Date {
  return parsePktStartOfDay(`${period}-01`)
}
