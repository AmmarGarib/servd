// Cost splits (owner, 2026-11-07: "Build a split option to split cost/payroll/expenses into FLIPD and GS Foods or any
// other company added in future. It should be to split in % and in amount, an expense already booked, Payroll already
// processed should also have option to split.") Owner decisions: EXTEND the existing inter-company engine (no second
// ledger, no new transfer table); FINANCE POSTS DIRECTLY (no CEO approval — the CEO is told on the bell).
//
// CONTRACT
//
//   Source   a LIVE journal entry (not reversed, not itself a reversal, not an inter-company entry 'ic.*') of a
//            company the caller belongs to; or a payroll run (status approved | locked) through its live accrual
//            (hr/ledger.ts liveRunAccrual — the ONE reader). An entry that IS a payroll accrual is recorded as the
//            run's split. Unseen / foreign → 404.
//   Base     the entry's DEBIT lines on ordinary EXPENSE accounts (Account.type 'expense' — the same test the P&L
//            uses; 5xxx cost of sales and 6xxx overheads), never a controlled account and never the recharge ranges
//            6200–6249 / 6990–6999. Liabilities, tax, money, payables (2020 / 2042–2044 on payroll) are NEVER split:
//            they stay with the company that owes / paid them. `lines: [lineId]` narrows the base to some of those
//            lines (422 LINE_NOT_SPLITTABLE for any other); default every one.
//   Shares   [{tenantId, percent (0.01–100, 2 dp)} | {tenantId, amountCents}] — one mode for all (`mode`), ≥1,
//            ≤20, each a live TRADING company (kind 'company') the caller is a member of, never the source, no
//            duplicates. Percent: Σ ≤ 100 (422 SPLIT_OVER_100); amount: Σ ≤ base (422 SPLIT_OVER_BASE). The source
//            keeps the remainder. Head offices are refused (422 HEAD_OFFICE_NOT_SPLIT): their cost moves only through
//            the recharge run, and their pool is the wages accounts — a split there would be recharged back.
//   Rounding percent → headOffices/splits.ts splitByBps (the ONE rounding rule: floor per share, the residue to the
//            largest share only at exactly 100%, else it stays with the source); a share rounding to 0 → 422
//            SHARE_TOO_SMALL. Each share is then spread over the base lines in proportion to what each line still
//            has left (shares in order, largest remainder) — paisa exact, never more than a line holds, totals tie.
//   Posting  ONE serviceClient transaction, all-or-nothing: per receiving company X one IntercompanyTransfer kind
//            'charge', source 'cost_split', sourceRef 'cost_split:<splitId>:<X>' through postSystemTransferTx
//            (chargeLines): X (debtor) Dr the SAME expense codes (no brand — brands are the source's) / Cr Due to
//            source; the source (creditor) Dr Due from X / Cr each split expense account under the line's own brand.
//            Both under 'ic.transfer:<transferId>'. A code missing in X's chart is created there from the SOURCE's
//            account (same code, name, type 'expense', description) — the receiving company records the same cost
//            under the same head; X holding that code as a non-expense account → 422 ACCOUNT_TYPE_MISMATCH; inactive or
//            controlled there → the engine's 422 ACCOUNT_INVALID / ACCOUNT_CONTROLLED.
//   Date     entryDate 'YYYY-MM-DD' (midday PKT, never in the future), default the source entry's own date. A closed
//            month in ANY company involved → 422 PERIOD_LOCKED (never moved); a CEO-reopened window → 403
//            CEO_ONLY_CLOSED_BOOKS for anyone but the CEO (closedBooks.ts, through postJournalEntry's postedBy).
//   One live One POSTED split per source entry (partial unique index cost_splits_one_posted_per_entry + an advisory
//            lock): a second → 409 ALREADY_SPLIT. Reverse it first, then split again.
//   Who      the CEO (admin) or role finance (the '/accounting' module gate holds finance to `accounting`), a member
//            of the source AND every receiving company (403 NOT_IN_BOTH_COMPANIES); the active company must be one of
//            them (422 ACTIVE_COMPANY_NOT_A_PARTY). Posts at once. Audit `cost_split.post` in every company; bell
//            `cost_split.posted` to each company's CEO(s) (never the actor), queued after the commit.
//   Reverse  POST /splits/:id/reverse {reason ≥10}: same people (member of every company). ONE transaction: the split
//            claimed posted → reversed (409 NOT_POSTED), then each share's transfer reversed in both books through the
//            engine ('ic.transfer.reversal:<id>'), dated the split's own date — a closed month → 422 PERIOD_LOCKED,
//            reopened books CEO only. The source may then be split again. A share's transfer is never reversed from
//            the transfers list (409 REVERSE_FROM_SOURCE). Audit `cost_split.reverse`; bell `cost_split.reversed`.
//
// Not done: sub-account tags (a payroll wages line split is credited untagged — the source's per-employee sub-ledger
// shows the split under Unassigned); a source entry reversed AFTER its split leaves the split standing (reverse the
// split too — the preview's `sourceLive` says so).

import { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { fmtPktDate } from '../accounting/dates.js'
import { deadEntryIds } from '../reconciliation/service.js'
import { liveRunAccrual, RUN_ACCRUAL, runIdOfAccrualSource } from '../hr/ledger.js'
import { splitByBps } from '../headOffices/splits.js'
import {
  assertOpenInBoth, postSystemTransferTx, reverseSystemTransfer, transferDateOf,
  type ChargeLine, type TransferActor, type Tx,
} from './service.js'

export const COST_SPLIT_SOURCE = 'cost_split'
/** Who splits and reverses: the CEO and finance (with the accounting module — the route's gate). */
export const COST_SPLITTERS = ['admin', 'finance'] as const
export const PAYROLL_SPLITTABLE_STATUSES = ['approved', 'locked'] as const
export const MAX_SHARES = 20
const FULL_BPS = 10000
const TX_OPTS = { timeout: 60_000, maxWait: 10_000 } as const
/** Codes a split never moves: the head-office charge accounts and the group-recharge accounts (module-owned). */
const NOT_SPLIT_RANGES: ReadonlyArray<readonly [number, number]> = [[6200, 6249], [6990, 6999]]

export interface SplitLine {
  lineId: string
  accountCode: string
  accountName: string
  conceptId: string | null
  amountCents: number
}

export interface ShareInput { tenantId: string; percent?: number | null; amountCents?: number | null }

export interface CreateSplitInput {
  sourceEntryId?: string | null
  payrollRunId?: string | null
  mode: 'percent' | 'amount'
  shares: ShareInput[]
  lines?: string[] | null
  entryDate?: string | null
  memo: string
}

interface ResolvedSource {
  kind: 'journal_entry' | 'payroll_run'
  entryId: string
  payrollRunId: string | null
  payrollPeriod: string | null
  tenantId: string
  reference: string | null
  voucherNo: string | null
  description: string
  entryDate: Date
  live: boolean
  splittable: boolean
  notSplittableReason: string | null
  lines: SplitLine[]
}

function inRange(code: string): boolean {
  const m = /^\s*(\d{4})(?!\d)/.exec(code)
  if (!m) return false
  const n = Number(m[1])
  return NOT_SPLIT_RANGES.some(([lo, hi]) => n >= lo && n <= hi)
}

// ─── The source ──────────────────────────────────────────────────────────────

/**
 * The entry (or payroll run's live accrual) a split is about, as the caller may see it: its company must be one the
 * caller belongs to, else 404. `live` = not reversed and not a reversal.
 */
export async function resolveSource(
  db: Tx | typeof serviceClient, actor: Pick<TransferActor, 'memberTenantIds'>,
  q: { sourceEntryId?: string | null; payrollRunId?: string | null },
): Promise<ResolvedSource> {
  let entryId = q.sourceEntryId ?? null
  let payrollRunId: string | null = null
  let payrollPeriod: string | null = null
  if (!!entryId === !!q.payrollRunId) throw new AppError('SOURCE_REQUIRED', 'Name the entry to split (sourceEntryId) or the payroll run (payrollRunId) — one of them', 422)
  if (q.payrollRunId) {
    const run = await db.hrPayrollRun.findUnique({ where: { id: q.payrollRunId }, select: { id: true, tenantId: true, status: true, period: true } })
    if (!run || !actor.memberTenantIds.includes(run.tenantId)) throw new NotFoundError('Payroll run', q.payrollRunId)
    if (!(PAYROLL_SPLITTABLE_STATUSES as readonly string[]).includes(run.status)) {
      throw new AppError('PAYROLL_NOT_APPROVED', `This payroll is ${run.status} — a payroll is split once the CEO has approved it (it is booked then)`, 422)
    }
    const live = await liveRunAccrual(db, run.tenantId, run.id)
    if (!live) throw new AppError('PAYROLL_NOT_BOOKED', 'This payroll has no booked accrual in the books — nothing to split', 422)
    entryId = live.entryId
    payrollRunId = run.id
    payrollPeriod = run.period
  }
  const entry = await db.journalEntry.findUnique({
    where: { id: entryId! },
    select: {
      id: true, tenantId: true, reference: true, description: true, entryDate: true, voucherNo: true,
      lines: { select: { id: true, type: true, amountCents: true, conceptId: true, account: { select: { code: true, name: true, type: true, controlledBy: true } } } },
    },
  })
  if (!entry || !entry.tenantId || !actor.memberTenantIds.includes(entry.tenantId)) throw new NotFoundError('Journal entry', entryId!)
  // An entry that IS a payroll accrual is that run's split.
  if (!payrollRunId && entry.reference?.startsWith(`${RUN_ACCRUAL}:`)) {
    const runId = runIdOfAccrualSource(entry.reference.slice(RUN_ACCRUAL.length + 1))
    const run = await db.hrPayrollRun.findUnique({ where: { id: runId }, select: { id: true, period: true, tenantId: true } })
    if (run && run.tenantId === entry.tenantId) { payrollRunId = run.id; payrollPeriod = run.period }
  }
  const dead = await deadEntryIds(db as Tx, entry.tenantId, [{ id: entry.id, reference: entry.reference, description: entry.description }])
  const live = !dead.has(entry.id)
  let notSplittableReason: string | null = null
  if (!live) notSplittableReason = 'This entry was reversed (or is itself a reversal) — nothing live to split'
  else if (entry.reference?.startsWith('ic.')) notSplittableReason = 'An inter-company entry is not split again — split the original expense'
  const lines: SplitLine[] = entry.lines
    .filter((l) => l.type === 'debit' && l.account.type === 'expense' && !l.account.controlledBy && !inRange(l.account.code))
    .map((l) => ({ lineId: l.id, accountCode: l.account.code, accountName: l.account.name, conceptId: l.conceptId, amountCents: toCents(l.amountCents) }))
    .filter((l) => l.amountCents > 0)
  if (!notSplittableReason && lines.length === 0) notSplittableReason = 'This entry has no expense debit lines to split'
  return {
    kind: payrollRunId ? 'payroll_run' : 'journal_entry',
    entryId: entry.id, payrollRunId, payrollPeriod, tenantId: entry.tenantId, reference: entry.reference, voucherNo: entry.voucherNo,
    description: entry.description, entryDate: entry.entryDate, live, splittable: !notSplittableReason, notSplittableReason, lines,
  }
}

// ─── Arithmetic (pure) ───────────────────────────────────────────────────────

/**
 * Spread `total` over `weights` (each ≥0, Σ ≥ total) in proportion, largest remainder, never above a weight.
 * Pure. Float only for the proportion; the integers are then fixed so Σ === total exactly.
 */
export function spread(total: number, weights: readonly number[]): number[] {
  const R = weights.reduce((s, w) => s + w, 0)
  if (total > R) throw new AppError('SPLIT_OVER_BASE', 'A share is larger than what is left to split', 422)
  if (total === R) return weights.slice()
  if (total === 0 || R === 0) return weights.map(() => 0)
  const raw = weights.map((w) => total * (w / R))
  const out = raw.map((x, i) => Math.min(weights[i]!, Math.max(0, Math.floor(x))))
  let diff = total - out.reduce((s, v) => s + v, 0)
  const order = raw.map((x, i) => ({ i, frac: x - out[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i).map((o) => o.i)
  while (diff > 0) {
    let moved = false
    for (const i of order) { if (diff === 0) break; if (out[i]! < weights[i]!) { out[i]!++; diff--; moved = true } }
    if (!moved) break
  }
  while (diff < 0) {
    let moved = false
    for (const i of [...order].reverse()) { if (diff === 0) break; if (out[i]! > 0) { out[i]!--; diff++; moved = true } }
    if (!moved) break
  }
  return out
}

/** Each share's amount over the base lines: shares in order, each spread over what every line still has left. Pure. */
export function allocateShares(lines: readonly SplitLine[], amounts: ReadonlyArray<{ tenantId: string; amountCents: number }>): Map<string, number[]> {
  const left = lines.map((l) => l.amountCents)
  const out = new Map<string, number[]>()
  for (const s of amounts) {
    const part = spread(s.amountCents, left)
    part.forEach((v, i) => { left[i] = left[i]! - v })
    out.set(s.tenantId, part)
  }
  return out
}

/** The percent (2 dp) as basis points, or 422. */
function bpsOf(percent: number): number {
  const bps = Math.round(percent * 100)
  if (!Number.isFinite(percent) || Math.abs(percent * 100 - bps) > 1e-6 || bps < 1 || bps > FULL_BPS) {
    throw new AppError('PERCENT_INVALID', 'Each percentage is between 0.01 and 100, with at most two decimals', 422)
  }
  return bps
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface PostedSplit {
  splitId: string
  sourceTenantId: string
  tenantIds: string[]
  createdAccounts: Array<{ tenantId: string; code: string; name: string }>
}

/** The company's CEO login ids (admins who belong to it) — the bell's recipients. */
export async function ceoIdsOf(tenantId: string): Promise<string[]> {
  const rows = await serviceClient.user.findMany({
    where: {
      role: 'admin', isActive: true, accountStatus: 'active', deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Post a split (see the contract). The route checks the role; this checks everything else. */
export async function createCostSplit(actor: TransferActor, input: CreateSplitInput): Promise<PostedSplit> {
  if (!(COST_SPLITTERS as readonly string[]).includes(actor.role)) throw new AppError('FORBIDDEN', 'Only the CEO or finance splits a cost', 403)
  const src = await resolveSource(serviceClient, actor, input)
  if (!src.splittable) throw new AppError(src.live ? 'SOURCE_NOT_SPLITTABLE' : 'SOURCE_REVERSED', src.notSplittableReason!, 422)
  const S = src.tenantId

  // Lines
  let lines = src.lines
  if (input.lines && input.lines.length > 0) {
    const want = new Set(input.lines)
    const known = new Set(src.lines.map((l) => l.lineId))
    for (const id of want) if (!known.has(id)) throw new AppError('LINE_NOT_SPLITTABLE', 'Only the entry\'s expense debit lines can be split', 422, { lineId: id })
    lines = src.lines.filter((l) => want.has(l.lineId))
  }
  const base = lines.reduce((s, l) => s + l.amountCents, 0)
  if (base <= 0) throw new AppError('NOTHING_TO_SPLIT', 'Nothing to split on this entry', 422)
  assertMoneyFits(base, 'The split base')

  // Shares — companies
  if (input.shares.length === 0) throw new AppError('SHARES_REQUIRED', 'Name at least one company to split to', 422)
  if (input.shares.length > MAX_SHARES) throw new AppError('TOO_MANY_SHARES', `At most ${MAX_SHARES} companies in one split`, 422)
  const ids = input.shares.map((s) => s.tenantId)
  if (new Set(ids).size !== ids.length) throw new AppError('COMPANY_LISTED_TWICE', 'A company is listed twice — one share each', 422)
  if (ids.includes(S)) throw new AppError('SAME_COMPANY', 'The company that booked the cost keeps the remainder — split to other companies only', 422)
  for (const t of ids) {
    if (!actor.memberTenantIds.includes(t)) {
      throw new AppError('NOT_IN_BOTH_COMPANIES', 'Only someone who belongs to the company that booked the cost AND every company it is split to can split it', 403)
    }
  }
  if (!actor.tenantId || (actor.tenantId !== S && !ids.includes(actor.tenantId))) {
    throw new AppError('ACTIVE_COMPANY_NOT_A_PARTY', 'Switch to one of the companies in the split first', 422)
  }
  const companies = await serviceClient.tenant.findMany({ where: { id: { in: [S, ...ids] } }, select: { id: true, name: true, kind: true, deletedAt: true } })
  const byId = new Map(companies.map((c) => [c.id, c]))
  for (const t of [S, ...ids]) {
    const c = byId.get(t)
    if (!c || c.deletedAt) throw new AppError('COMPANY_NOT_FOUND', 'One of the companies no longer exists', 422)
    if (c.kind !== 'company') {
      throw new AppError('HEAD_OFFICE_NOT_SPLIT', `${c.name} is a head office — its costs move only through the monthly recharge run`, 422)
    }
  }

  // Shares — amounts
  let amounts: Array<{ tenantId: string; amountCents: number; percentBp: number | null }>
  if (input.mode === 'percent') {
    const bps = input.shares.map((s) => {
      if (s.percent === undefined || s.percent === null || (s.amountCents !== undefined && s.amountCents !== null)) {
        throw new AppError('SHARE_INVALID', 'A percentage split gives each company a percent (and no amount)', 422)
      }
      return { tenantId: s.tenantId, bps: bpsOf(s.percent) }
    })
    const total = bps.reduce((s, b) => s + b.bps, 0)
    if (total > FULL_BPS) throw new AppError('SPLIT_OVER_100', `The percentages add up to ${(total / 100).toFixed(2)}% — at most 100%`, 422)
    const split = splitByBps(base, bps.map((b) => ({ companyTenantId: b.tenantId, shareBps: b.bps })))
    const got = new Map(split.map((x) => [x.companyTenantId, x.amountCents]))
    amounts = bps.map((b) => {
      const a = got.get(b.tenantId) ?? 0
      if (a <= 0) throw new AppError('SHARE_TOO_SMALL', `${byId.get(b.tenantId)?.name ?? 'A company'}'s share rounds to nothing`, 422)
      return { tenantId: b.tenantId, amountCents: a, percentBp: b.bps }
    })
  } else {
    amounts = input.shares.map((s) => {
      if (s.amountCents === undefined || s.amountCents === null || (s.percent !== undefined && s.percent !== null)) {
        throw new AppError('SHARE_INVALID', 'An amount split gives each company an amount in paisa (and no percent)', 422)
      }
      if (!Number.isInteger(s.amountCents) || s.amountCents <= 0) throw new AppError('SHARE_INVALID', 'Each share is a positive whole number of paisa', 422)
      return { tenantId: s.tenantId, amountCents: s.amountCents, percentBp: null }
    })
    const total = amounts.reduce((s, a) => s + a.amountCents, 0)
    if (total > base) throw new AppError('SPLIT_OVER_BASE', `The shares add up to more than the cost being split (${total} > ${base} paisa)`, 422, { baseCents: base })
  }
  const splitCents = amounts.reduce((s, a) => s + a.amountCents, 0)
  const perLine = allocateShares(lines, amounts)

  // Date
  const entryDate = input.entryDate ? transferDateOf(input.entryDate) : src.entryDate
  await assertOpenInBoth(serviceClient, [S, ...ids], entryDate)
  const period = fmtPktDate(entryDate).slice(0, 7)
  const memo = input.memo.trim()
  const sourceLabel = src.payrollPeriod ? `payroll ${src.payrollPeriod}` : (src.voucherNo ?? src.reference ?? 'entry')

  const createdAccounts: PostedSplit['createdAccounts'] = []
  let splitId = ''
  try {
    await serviceClient.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cost_split'), hashtext(${src.entryId}::text))`
      const existing = await tx.costSplit.findFirst({ where: { sourceEntryId: src.entryId, status: 'posted' }, select: { id: true } })
      if (existing) throw new AppError('ALREADY_SPLIT', 'This entry is already split — reverse that split first to split it again', 409, { splitId: existing.id })
      // Re-read inside the lock: still live, lines unchanged.
      const fresh = await resolveSource(tx, actor, { sourceEntryId: src.entryId })
      if (!fresh.splittable) throw new AppError(fresh.live ? 'SOURCE_NOT_SPLITTABLE' : 'SOURCE_REVERSED', fresh.notSplittableReason!, 409)

      const accounts = await tx.account.findMany({ where: { tenantId: S, code: { in: Array.from(new Set(lines.map((l) => l.accountCode))) } }, select: { code: true, name: true, type: true, description: true } })
      const srcAccount = new Map(accounts.map((a) => [a.code, a]))
      const row = await tx.costSplit.create({
        data: {
          tenantId: S, sourceKind: src.kind, sourceEntryId: src.entryId, payrollRunId: src.payrollRunId, mode: input.mode,
          baseCents: base, splitCents, entryDate, memo, status: 'posted', createdById: actor.id,
          lines: lines.map((l) => ({ lineId: l.lineId, accountCode: l.accountCode, accountName: l.accountName, conceptId: l.conceptId, amountCents: l.amountCents })),
        },
      })
      splitId = row.id
      for (const share of amounts) {
        const X = share.tenantId
        const part = perLine.get(X)!
        // The receiving company records the same cost under the same head: a missing code is created from the source's.
        for (const code of Array.from(new Set(lines.filter((_, i) => part[i]! > 0).map((l) => l.accountCode)))) {
          const have = await tx.account.findFirst({ where: { tenantId: X, code }, select: { type: true, name: true } })
          if (have) {
            if (have.type !== 'expense') {
              throw new AppError('ACCOUNT_TYPE_MISMATCH', `${byId.get(X)?.name ?? 'The receiving company'} uses code ${code} for '${have.name}', which is not an expense account — rename one of them first`, 422, { tenantId: X, code })
            }
            continue
          }
          const a = srcAccount.get(code)!
          const made = await tx.account.createMany({ data: [{ tenantId: X, code, name: a.name, type: 'expense', description: a.description }], skipDuplicates: true })
          if (made.count > 0) createdAccounts.push({ tenantId: X, code, name: a.name })
        }
        const chargeLines: ChargeLine[] = []
        const shareLines: Array<{ accountCode: string; conceptId: string | null; amountCents: number }> = []
        lines.forEach((l, i) => {
          const cents = part[i]!
          if (cents <= 0) return
          chargeLines.push({ debtorAccountCode: l.accountCode, creditorAccountCode: l.accountCode, amountCents: cents, creditorConceptId: l.conceptId })
          shareLines.push({ accountCode: l.accountCode, conceptId: l.conceptId, amountCents: cents })
        })
        const pct = share.percentBp !== null ? ` (${(share.percentBp / 100).toFixed(2)}%)` : ''
        const t = await postSystemTransferTx(tx, {
          kind: 'charge', source: COST_SPLIT_SOURCE, sourceRef: `cost_split:${row.id}:${X}`,
          debtorTenantId: X, creditorTenantId: S, amountCents: share.amountCents, entryDate,
          debtorAccountCode: chargeLines[0]!.debtorAccountCode, creditorAccountCode: chargeLines[0]!.creditorAccountCode,
          chargeLines, memo: `Cost split of ${sourceLabel}${pct}: ${memo}`, preparedById: actor.id, period,
        })
        await tx.costSplitShare.create({
          data: { splitId: row.id, tenantId: X, percentBp: share.percentBp, amountCents: share.amountCents, lines: shareLines, intercompanyTransferId: t.transferId },
        })
      }
    }, TX_OPTS)
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('ALREADY_SPLIT', 'This entry is already split — reverse that split first to split it again', 409)
    }
    throw err
  }
  return { splitId, sourceTenantId: S, tenantIds: ids, createdAccounts }
}

// ─── Reverse ─────────────────────────────────────────────────────────────────

/** Reverse a posted split: every share's transfer in both books, dated the split's own date, in ONE transaction. */
export async function reverseCostSplit(actor: TransferActor, id: string, reason: string): Promise<{ sourceTenantId: string; tenantIds: string[] }> {
  if (!(COST_SPLITTERS as readonly string[]).includes(actor.role)) throw new AppError('FORBIDDEN', 'Only the CEO or finance reverses a cost split', 403)
  const split = await serviceClient.costSplit.findUnique({ where: { id }, include: { shares: true } })
  if (!split || !(actor.memberTenantIds.includes(split.tenantId) || split.shares.some((s) => actor.memberTenantIds.includes(s.tenantId)))) {
    throw new NotFoundError('Cost split', id)
  }
  const all = [split.tenantId, ...split.shares.map((s) => s.tenantId)]
  if (!all.every((t) => actor.memberTenantIds.includes(t))) {
    throw new AppError('NOT_IN_BOTH_COMPANIES', 'Only someone who belongs to every company in the split can reverse it', 403)
  }
  const why = reason.trim()
  await serviceClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('cost_split'), hashtext(${split.sourceEntryId}::text))`
    const claim = await tx.costSplit.updateMany({
      where: { id, status: 'posted' },
      data: { status: 'reversed', reversedById: actor.id, reversedAt: new Date(), reversalReason: why },
    })
    if (claim.count === 0) throw new AppError('NOT_POSTED', 'This split is already reversed', 409)
    for (const s of split.shares) {
      await reverseSystemTransfer(s.intercompanyTransferId, `Cost split reversed: ${why}`, { tx, actorId: actor.id, entryDate: split.entryDate, strictDate: true })
    }
  }, TX_OPTS)
  return { sourceTenantId: split.tenantId, tenantIds: split.shares.map((s) => s.tenantId) }
}

// ─── Presenting ──────────────────────────────────────────────────────────────

export type SplitRow = Prisma.CostSplitGetPayload<{ include: { shares: true } }>

export interface SplitView {
  id: string
  tenantId: string
  companyName: string | null
  sourceKind: string
  sourceEntryId: string
  sourceReference: string | null
  sourceVoucherNo: string | null
  payrollRunId: string | null
  payrollPeriod: string | null
  mode: string
  baseCents: number
  splitCents: number
  keptCents: number
  /** The split base (shown to members of the source company only, else null). */
  lines: SplitLine[] | null
  entryDate: string
  memo: string
  status: string
  createdById: string
  createdByName: string | null
  createdAt: string
  reversedByName: string | null
  reversedAt: string | null
  reversalReason: string | null
  /** Every share for a member of the source company; otherwise only the shares of the viewer's companies. */
  shares: Array<{
    id: string; tenantId: string; companyName: string | null; percent: number | null; amountCents: number
    lines: Array<{ accountCode: string; amountCents: number }>
    transferId: string; transferStatus: string | null
    /** The entry in the receiving company's books (members of it only). */
    receiverEntryId: string | null
    /** The entry in the source company's books (members of it only). */
    sourceEntryIdOfShare: string | null
  }>
  /** The viewer may reverse it now (role, membership of every company, posted). */
  canReverse: boolean
}

export async function presentSplits(rows: SplitRow[], viewer: TransferActor): Promise<SplitView[]> {
  const tenantIds = new Set<string>()
  const userIds = new Set<string>()
  const entryIds = new Set<string>()
  const runIds = new Set<string>()
  const transferIds = new Set<string>()
  for (const r of rows) {
    tenantIds.add(r.tenantId)
    for (const s of r.shares) { tenantIds.add(s.tenantId); transferIds.add(s.intercompanyTransferId) }
    for (const u of [r.createdById, r.reversedById]) if (u) userIds.add(u)
    entryIds.add(r.sourceEntryId)
    if (r.payrollRunId) runIds.add(r.payrollRunId)
  }
  const [tenants, users, entries, runs, transfers] = await Promise.all([
    serviceClient.tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true } }),
    userIds.size ? serviceClient.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    serviceClient.journalEntry.findMany({ where: { id: { in: [...entryIds] } }, select: { id: true, reference: true, voucherNo: true } }),
    runIds.size ? serviceClient.hrPayrollRun.findMany({ where: { id: { in: [...runIds] } }, select: { id: true, period: true } }) : [],
    transferIds.size ? serviceClient.intercompanyTransfer.findMany({ where: { id: { in: [...transferIds] } }, select: { id: true, status: true, debtorEntryId: true, creditorEntryId: true } }) : [],
  ])
  const tName = new Map(tenants.map((t) => [t.id, t.name]))
  const uName = new Map(users.map((u) => [u.id, u.name]))
  const entry = new Map(entries.map((e) => [e.id, e]))
  const runPeriod = new Map(runs.map((r) => [r.id, r.period]))
  const transfer = new Map(transfers.map((t) => [t.id, t]))
  const member = (t: string) => viewer.memberTenantIds.includes(t)
  const mayAct = (COST_SPLITTERS as readonly string[]).includes(viewer.role)
  return rows.map((r) => {
    const seesSource = member(r.tenantId)
    const base = toCents(r.baseCents)
    const split = toCents(r.splitCents)
    const all = [r.tenantId, ...r.shares.map((s) => s.tenantId)]
    const shares = r.shares.filter((s) => seesSource || member(s.tenantId)).map((s) => {
      const t = transfer.get(s.intercompanyTransferId)
      const shareLines = Array.isArray(s.lines) ? (s.lines as Array<{ accountCode: string; amountCents: number }>) : []
      return {
        id: s.id, tenantId: s.tenantId, companyName: tName.get(s.tenantId) ?? null,
        percent: s.percentBp === null ? null : s.percentBp / 100, amountCents: toCents(s.amountCents),
        lines: shareLines.map((l) => ({ accountCode: l.accountCode, amountCents: l.amountCents })),
        transferId: s.intercompanyTransferId, transferStatus: t?.status ?? null,
        receiverEntryId: member(s.tenantId) ? t?.debtorEntryId ?? null : null,
        sourceEntryIdOfShare: seesSource ? t?.creditorEntryId ?? null : null,
      }
    })
    const e = entry.get(r.sourceEntryId)
    return {
      id: r.id, tenantId: r.tenantId, companyName: tName.get(r.tenantId) ?? null, sourceKind: r.sourceKind,
      sourceEntryId: r.sourceEntryId, sourceReference: seesSource ? e?.reference ?? null : null, sourceVoucherNo: seesSource ? e?.voucherNo ?? null : null,
      payrollRunId: r.payrollRunId, payrollPeriod: r.payrollRunId ? runPeriod.get(r.payrollRunId) ?? null : null,
      mode: r.mode, baseCents: base, splitCents: split, keptCents: base - split,
      lines: seesSource && Array.isArray(r.lines) ? (r.lines as unknown as SplitLine[]) : null,
      entryDate: r.entryDate.toISOString(), memo: r.memo, status: r.status,
      createdById: r.createdById, createdByName: uName.get(r.createdById) ?? null, createdAt: r.createdAt.toISOString(),
      reversedByName: r.reversedById ? uName.get(r.reversedById) ?? null : null, reversedAt: r.reversedAt?.toISOString() ?? null,
      reversalReason: r.reversalReason,
      shares,
      canReverse: mayAct && r.status === 'posted' && all.every(member),
    }
  })
}
