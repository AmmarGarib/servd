// THE period-close checklist (finance wave B, people plan §3; H29).
//
// One list, CLOSE_CHECKS, of every module's CloseCheck (contract:
// closeCheckTypes.ts). Closing a company's books through a date runs every
// check for THAT company only — another company's open till or unlocked
// payroll never blocks it. POST /accounting/period-close (routes.ts) is the
// only caller that writes: it refuses the close (409 CLOSE_NOT_READY) while a
// block stands, unless the CEO acknowledges every overridable block with a
// reason. No module adds its own 409 to the close: depreciation, card payouts,
// payroll, inter-company, stock and prepaid releases are all CloseChecks.
//
// The core checks (this file):
//   raast            block   Raast payments not matched to a bank statement up to the lock
//   open_tills       block   tills opened on or before the lock and still open
//   unposted_shifts  block   closed tills on or before the lock whose close never reached the books
//   unposted_orders  block   completions, loyalty, restores and refused document postings dated on or
//                            before the lock that are still owed (Backfill unposted's own dry run)
//   posting_failed   block   open posting_failed flags whose DOCUMENT date is on or before the lock
//                            (or unknown) and that the backfill dry run does not already list
//   trial_balance    block   the company's trial balance does not balance — NEVER overridable
//   bank_unmatched   warn    bank statement lines up to the lock still unmatched (+ lines ignored in the period,
//                            counted separately)
//   vouchers_awaiting_docs warn  cash vouchers paid on or before the lock whose supporting documents
//                            finance has not checked yet — only the documents: the expense is booked
//                            at pay (1357 retired, owner 2026-10-16; a voucher still held there is
//                            converted at boot or flagged 'cash_voucher_hold_unconverted')
//   vouchers_held_on_1357 block  cash vouchers paid on or before the lock still HELD on 1357 (not converted,
//                            not "Resolved by journal entry") — overridable by the CEO with a reason
//
// A check that throws becomes a block keyed 'check_failed:<its key>' (the CEO
// may override it, with a reason, like any other block) — a broken check never
// passes silently and never stops the rest of the list. Inside a transaction
// each check runs behind its own savepoint, so one failing statement cannot
// abort the close's transaction.

import type { Prisma, PrismaClient } from '@prisma/client'
import type { CloseCheck, CloseCheckContext, CloseCheckDb, CloseProblem } from './closeCheckTypes.js'
import { fiscalYearEndMonthOf, isFiscalYearEndInRange } from './fiscalYear.js'
import { fmtPktDate } from './dates.js'
import { sumCents } from '../../lib/money.js'
import { shiftOfCompany } from '../../lib/tenantScope.js'
import { shiftBusinessDate } from '../../lib/businessDay.js'
import { withSavepoint } from '../../lib/savepoint.js'
import { raastOpenThrough } from '../reconciliation/raast.js'
import { hrCloseChecks } from '../hr/closeChecks.js'
import { statutoryCloseChecks } from './statutory.js'
import { intercompanyCloseChecks } from '../intercompany/closeChecks.js'
import { fixedAssetCloseChecks } from '../fixedAssets/closeCheck.js'
import { cardPayoutCloseChecks } from '../reconciliation/cardPayouts.js'
import { prepaidCloseChecks } from './prepaidReleases.js'
import { inventoryCloseChecks } from '../reports/foodCost.js'
import { stockDifferenceCloseCheck } from '../stockDifferences/service.js'
import { headOfficeCloseChecks } from '../headOffices/closeChecks.js'
import { codCloseCheck } from '../reconciliation/codCloseCheck.js'
import { onAccountCloseChecks } from './onAccountCloseChecks.js'
import { nightAuditCloseCheck } from '../nightAudit/closeCheck.js'

/** A close never looks further back than this many months (the oldest are dropped). */
export const MAX_CLOSE_MONTHS = 24

const PKT_OFFSET_MS = 5 * 3600_000

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function pktYearMonth(at: Date): { y: number; m: number } {
  const p = new Date(at.getTime() + PKT_OFFSET_MS)
  return { y: p.getUTCFullYear(), m: p.getUTCMonth() + 1 }
}

/** 23:59:59.999 PKT on the last day of a 'YYYY-MM' month. */
function pktMonthEnd(month: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return new Date(Date.UTC(y, mo - 1, lastDay, 23, 59, 59, 999) - PKT_OFFSET_MS)
}

/** Where a close's range starts: just after the previous lock, else the company's first entry (never after the new lock). */
function rangeStart(prevLock: Date | null, newLock: Date, firstEntryDate: Date | null): Date {
  if (prevLock) return new Date(prevLock.getTime() + 1)
  if (firstEntryDate && firstEntryDate.getTime() < newLock.getTime()) return firstEntryDate
  return newLock
}

/**
 * The PKT months ('YYYY-MM') a close from `prevLock` (exclusive) through
 * `newLock` (inclusive) touches — every month with a day in the range,
 * including the month the new lock cuts through. A first close starts at the
 * company's first journal entry (or the new lock's month when it has none).
 * At most MAX_CLOSE_MONTHS, the latest kept.
 */
export function monthsInRange(prevLock: Date | null, newLock: Date, firstEntryDate: Date | null): string[] {
  const start = rangeStart(prevLock, newLock, firstEntryDate)
  if (start.getTime() > newLock.getTime()) return []
  let { y, m } = pktYearMonth(start)
  const end = pktYearMonth(newLock)
  const out: string[] = []
  while (y < end.y || (y === end.y && m <= end.m)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m += 1
    if (m > 12) { m = 1; y += 1 }
  }
  return out.slice(-MAX_CLOSE_MONTHS)
}

// ─── The backfill dry runs, once per checklist run ───────────────────────────
// unposted_orders and posting_failed both read the orders dry run; one run of
// a checklist (the month's, or the night audit's — nightAudit/checks.ts)
// computes it once, through the run's `cache`.

export type CheckCache = Map<string, Promise<unknown>>

type OrderDryRunRow = { kind: string; id: string; tenantId: string; date: string | null; outcome: string; detail: string }
type ShiftDryRunRow = { shiftId: string; closedAt: string | null; businessAt: string | null; tenantId: string | null; outcome: string; detail: string }

function memo<T>(cache: CheckCache | undefined, key: string, fn: () => Promise<T>): Promise<T> {
  if (!cache) return fn()
  let p = cache.get(key) as Promise<T> | undefined
  if (!p) {
    p = fn()
    cache.set(key, p)
  }
  return p
}

function ordersDryRun(tenantId: string, cache: CheckCache | undefined): Promise<OrderDryRunRow[]> {
  return memo(cache, `orders-dry-run:${tenantId}`, async () => {
    const { backfillUnpostedOrders } = await import('../reconciliation/backfillOrders.js')
    const r = await backfillUnpostedOrders({ tenantIds: [tenantId], dryRun: true })
    return r.rows.filter((row) => row.tenantId === tenantId)
  })
}

function shiftsDryRun(tenantId: string, cache: CheckCache | undefined): Promise<ShiftDryRunRow[]> {
  return memo(cache, `shifts-dry-run:${tenantId}`, async () => {
    const { backfillUnpostedShifts } = await import('./shiftPosting.js')
    const r = await backfillUnpostedShifts({ tenantIds: [tenantId], dryRun: true })
    return r.rows.filter((row) => row.tenantId === tenantId)
  })
}

/** Dry-run outcomes that mean "this document still owes the books an entry". */
const ORDER_UNPOSTED = new Set(['would_post', 'would_post_into_current_month', 'unflagged', 'error'])
const SHIFT_UNPOSTED = new Set(['would_post', 'would_post_into_current_month', 'unbalanced', 'error'])

/** In (from, to] by an ISO date; a null date counts only when `from` is null (an open-ended range). */
const inWindow = (iso: string | null, from: Date | null, to: Date): boolean => {
  if (!iso) return from === null
  const t = new Date(iso).getTime()
  return t <= to.getTime() && (from === null || t >= from.getTime())
}

/**
 * Tills of the company opened on or before `through` and still open (oldest
 * first). The month's open_tills and the night audit's share it.
 */
export async function openTillsThrough(db: CloseCheckDb, tenantId: string, through: Date): Promise<Array<{ id: string; openedAt: Date }>> {
  return db.shift.findMany({
    where: { status: 'open', openedAt: { lte: through }, ...shiftOfCompany({ tenantId: { in: [tenantId] } }) },
    select: { id: true, openedAt: true },
    orderBy: { openedAt: 'asc' },
  })
}

/**
 * Closed tills whose BUSINESS date (lib/businessDay.ts — a close before 05:00
 * PKT belongs to the day the till opened) is in [from, to] (from null = no
 * lower bound; an undated row counts only then) that never reached the books.
 */
export async function unpostedShiftRows(_db: CloseCheckDb, tenantId: string, from: Date | null, to: Date, cache?: CheckCache): Promise<ShiftDryRunRow[]> {
  return (await shiftsDryRun(tenantId, cache)).filter((row) => SHIFT_UNPOSTED.has(row.outcome) && inWindow(row.businessAt ?? row.closedAt, from, to))
}

/** Documents (dated in [from, to]; undated only when from is null) that still owe the books an entry — Backfill unposted's own dry run. */
export async function unpostedOrderRows(_db: CloseCheckDb, tenantId: string, from: Date | null, to: Date, cache?: CheckCache): Promise<OrderDryRunRow[]> {
  return (await ordersDryRun(tenantId, cache)).filter((row) => ORDER_UNPOSTED.has(row.outcome) && inWindow(row.date, from, to))
}

function metaOf(v: Prisma.JsonValue | null): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' && !(v instanceof Date)) return null
  const d = new Date(v as string)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The date of the DOCUMENT behind a posting_failed flag — what its re-poster
 * would post it on — never the flag's own createdAt (a failure raised after
 * the close date for a document dated before it still belongs to the closed
 * months). Null when it cannot be told: the flag then counts.
 */
export async function documentDateOf(db: CloseCheckDb, f: { entityType: string | null; entityId: string | null; metadata: Prisma.JsonValue | null }): Promise<Date | null> {
  const m = metaOf(f.metadata)
  for (const k of ['documentDate', 'date', 'entryDate', 'occurredAt']) {
    const d = parseDate(m[k])
    if (d) return d
  }
  for (const k of ['throughPeriod', 'month', 'period']) {
    if (typeof m[k] === 'string') {
      const d = pktMonthEnd(m[k] as string)
      if (d) return d
    }
  }
  if (!f.entityId) return null
  switch (f.entityType) {
    case 'Order': {
      const o = await db.order.findUnique({ where: { id: f.entityId }, select: { completedAt: true, placedAt: true } })
      return o ? (o.completedAt ?? o.placedAt) : null
    }
    case 'Shift': {
      // Its business date (lib/businessDay.ts), as the close posting is dated.
      const s = await db.shift.findUnique({ where: { id: f.entityId }, select: { openedAt: true, closedAt: true } })
      return s ? (shiftBusinessDate(s) ?? s.closedAt) : null
    }
    case 'WasteLog': {
      const w = await db.wasteLog.findUnique({ where: { id: f.entityId }, select: { recordedAt: true } })
      return w?.recordedAt ?? null
    }
    case 'GiftCard': {
      const g = await db.giftCard.findUnique({ where: { id: f.entityId }, select: { expiresAt: true } })
      return g?.expiresAt ?? null
    }
    default:
      return null
  }
}

/**
 * Open / acknowledged posting_failed flags of the company whose DOCUMENT date
 * is in [from, to] (from null = no lower bound; then an undated flag counts
 * too), minus documents the orders dry run already lists (unposted_orders
 * reports those). `salesOnly` (the night audit): only flags whose
 * metadata.sourceType is a sales source (nightAudit/lock.ts isSalesSource) —
 * a supplier bill's or petty cash's refusal never counts on a sales day.
 */
export async function postingFailedBetween(
  db: CloseCheckDb, tenantId: string, from: Date | null, to: Date, cache?: CheckCache, opts: { salesOnly?: boolean } = {},
): Promise<{ count: number; cents: number }> {
  const flags = await db.exceptionFlag.findMany({
    where: { tenantId, kind: 'posting_failed', status: { in: ['open', 'acknowledged'] } },
    select: { id: true, entityType: true, entityId: true, metadata: true, amountCents: true },
  })
  if (flags.length === 0) return { count: 0, cents: 0 }
  const { isSalesSource } = opts.salesOnly ? await import('../nightAudit/lock.js') : { isSalesSource: () => true }
  // A document the backfill dry run lists is unposted_orders' to report (or
  // has nothing owed / sits in an older closed month) — never counted twice.
  const listed = new Set((await ordersDryRun(tenantId, cache)).map((row) => `${row.kind}:${row.id}`))
  let count = 0
  let cents = 0
  for (const f of flags) {
    const m = metaOf(f.metadata)
    const sourceType = typeof m['sourceType'] === 'string' ? m['sourceType'] : null
    if (opts.salesOnly && !isSalesSource(sourceType)) continue
    const sourceId = typeof m['sourceId'] === 'string' ? m['sourceId'] : f.entityId
    if (sourceType && sourceId && listed.has(`${sourceType}:${sourceId}`)) continue
    const at = await documentDateOf(db, f)
    if (at && at.getTime() > to.getTime()) continue
    if (from && (!at || at.getTime() < from.getTime())) continue
    count += 1
    cents += Math.abs(sumCents(f.amountCents))
  }
  return { count, cents }
}

// ─── The core checks ─────────────────────────────────────────────────────────

const raastCheck: CloseCheck = {
  key: 'raast',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    // Raast QR (spec §7.4, S6): a payment still 'provisional' (no bank
    // statement has shown it) or 'needs_attention' dated up to the close —
    // by its confirmation, else its creation — means the period's bank money
    // is not proven.
    const r = await raastOpenThrough(ctx.db as PrismaClient, ctx.tenantId, ctx.newLock)
    if (r.count === 0) return null
    return {
      key: 'raast',
      severity: 'block',
      title: 'Raast payments not matched to a bank statement',
      detail: `${plural(r.count, 'Raast payment')}, ${pkr(r.cents)}, up to ${fmtPktDate(ctx.newLock)} ${r.count === 1 ? 'is' : 'are'} not matched to a bank statement yet. `
        + 'Match them on Finance → Reconciliation → Raast (or mark them not received), or close anyway.',
      count: r.count,
      cents: r.cents,
      link: '/reconciliation?tab=raast',
      overridable: true,
    }
  },
}

const openTillsCheck: CloseCheck = {
  key: 'open_tills',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const open = await openTillsThrough(ctx.db, ctx.tenantId, ctx.newLock)
    if (open.length === 0) return null
    return {
      key: 'open_tills',
      severity: 'block',
      title: 'Tills still open',
      detail: `${plural(open.length, 'till')} opened on or before ${fmtPktDate(ctx.newLock)} (the oldest on ${fmtPktDate(open[0]!.openedAt)}) ${open.length === 1 ? 'is' : 'are'} still open. `
        + 'Their sales reach the books only when the till is closed — close them first.',
      count: open.length,
      link: '/reconciliation',
      overridable: true,
    }
  },
}

const unpostedShiftsCheck: CloseCheck = {
  key: 'unposted_shifts',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const rows = await unpostedShiftRows(ctx.db, ctx.tenantId, null, ctx.newLock, ctx.cache)
    if (rows.length === 0) return null
    const refused = rows.filter((row) => row.outcome === 'unbalanced' || row.outcome === 'error').length
    return {
      key: 'unposted_shifts',
      severity: 'block',
      title: 'Closed tills not on the books',
      detail: `${plural(rows.length, 'till close')} on or before ${fmtPktDate(ctx.newLock)} never reached the ledger`
        + (refused > 0 ? ` (${refused} refused — unbalanced or in error; fix the cause first)` : '')
        + '. Post them from Reconciliation → Backfill unposted.',
      count: rows.length,
      link: '/reconciliation',
      overridable: true,
    }
  },
}

const unpostedOrdersCheck: CloseCheck = {
  key: 'unposted_orders',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const rows = await unpostedOrderRows(ctx.db, ctx.tenantId, null, ctx.newLock, ctx.cache)
    if (rows.length === 0) return null
    const kinds = Array.from(new Set(rows.map((row) => row.kind))).sort()
    return {
      key: 'unposted_orders',
      severity: 'block',
      title: 'Documents not on the books',
      detail: `${plural(rows.length, 'document')} dated on or before ${fmtPktDate(ctx.newLock)} still owe the ledger an entry (${kinds.join(', ')}). `
        + 'Preview and post them from Reconciliation → Backfill unposted.',
      count: rows.length,
      link: '/reconciliation',
      overridable: true,
    }
  },
}

const postingFailedCheck: CloseCheck = {
  key: 'posting_failed',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const { count, cents } = await postingFailedBetween(ctx.db, ctx.tenantId, null, ctx.newLock, ctx.cache)
    if (count === 0) return null
    return {
      key: 'posting_failed',
      severity: 'block',
      title: 'Refused postings still open',
      detail: `${plural(count, 'posting')} the ledger refused for documents dated on or before ${fmtPktDate(ctx.newLock)} (or with no date) ${count === 1 ? 'is' : 'are'} still open. `
        + 'Fix the cause and re-post them (Reconciliation → Backfill unposted), or close the flag in Exceptions if it was booked another way.',
      count,
      ...(cents > 0 ? { cents } : {}),
      link: '/exceptions?kind=posting_failed',
      overridable: true,
    }
  },
}

const trialBalanceCheck: CloseCheck = {
  key: 'trial_balance',
  severity: 'block',
  overridable: false,
  async run(ctx) {
    const { trialBalance } = await import('./reports.js')
    const tb = await trialBalance([ctx.tenantId], ctx.newLock)
    const diff = tb.companyTotals.find((c) => c.tenantId === ctx.tenantId)?.differenceCents ?? tb.totals.differenceCents
    if (diff === 0) return null
    return {
      key: 'trial_balance',
      severity: 'block',
      title: 'Trial balance does not balance',
      detail: `Debits and credits up to ${fmtPktDate(ctx.newLock)} differ by ${pkr(Math.abs(diff))}. The books cannot be closed until they balance — this cannot be overridden.`,
      count: 1,
      cents: Math.abs(diff),
      link: '/accounting/trial-balance',
      overridable: false,
    }
  },
}

const bankUnmatchedCheck: CloseCheck = {
  key: 'bank_unmatched',
  severity: 'warn',
  overridable: false,
  async run(ctx) {
    // Ignored lines (a reason is required and audited) are told apart: those in the months being closed are
    // listed separately so an Ignore clicked by mistake is still seen at the close.
    const since = ctx.prevLock ?? new Date(0)
    const rows = await ctx.db.$queryRaw<Array<{ n: number; cents: bigint | number | null; ign: number; ign_cents: bigint | number | null }>>`
      SELECT count(*) FILTER (WHERE l."matchStatus" = 'unmatched')::int AS n,
             COALESCE(sum(abs(l."amountCents")) FILTER (WHERE l."matchStatus" = 'unmatched'), 0)::bigint AS cents,
             count(*) FILTER (WHERE l."matchStatus" = 'ignored' AND l."postedDate" > ${since})::int AS ign,
             COALESCE(sum(abs(l."amountCents")) FILTER (WHERE l."matchStatus" = 'ignored' AND l."postedDate" > ${since}), 0)::bigint AS ign_cents
        FROM bank_statement_lines l
        JOIN bank_statement_imports i ON i.id = l."importId"
       WHERE i."tenantId" = ${ctx.tenantId}
         AND l."matchStatus" IN ('unmatched', 'ignored')
         AND l."postedDate" <= ${ctx.newLock}`
    const n = rows[0]?.n ?? 0
    const ignored = rows[0]?.ign ?? 0
    if (n === 0 && ignored === 0) return null
    const cents = sumCents(rows[0]?.cents ?? 0)
    const ignoredCents = sumCents(rows[0]?.ign_cents ?? 0)
    const parts = [
      ...(n > 0 ? [`${plural(n, 'bank statement line')} up to ${fmtPktDate(ctx.newLock)} (${pkr(cents)} in and out) ${n === 1 ? 'is' : 'are'} not matched to the books yet.`] : []),
      ...(ignored > 0 ? [`${plural(ignored, 'line')} in this period (${pkr(ignoredCents)}) ${ignored === 1 ? 'was' : 'were'} ignored — check each reason on Reconciliation → Bank.`] : []),
    ]
    return {
      key: 'bank_unmatched',
      severity: 'warn',
      title: n > 0 ? 'Bank lines not matched' : 'Bank lines ignored',
      detail: parts.join(' '),
      count: n + ignored,
      cents: cents + ignoredCents,
      link: '/reconciliation?tab=bank',
      overridable: false,
    }
  },
}

// Owner, 2026-10-16 ("It should pass only one entry when booked by finance, either docs are attached or not";
// "Don't post any entry in 1357"): a paid voucher's expense is on the books from its pay, so documents finance has
// not checked hold no money — only a warning. ONE check for every voucher of the documents flow.
const vouchersAwaitingDocsCheck: CloseCheck = {
  key: 'vouchers_awaiting_docs',
  severity: 'warn',
  overridable: false,
  async run(ctx) {
    const r = await ctx.db.cashVoucher.aggregate({
      where: { tenantId: ctx.tenantId, status: 'disbursed', expenseOnVerify: true, disbursedAt: { lte: ctx.newLock } },
      _count: { _all: true },
      _sum: { amountCents: true },
    })
    const count = r._count._all
    if (count === 0) return null
    const cents = r._sum.amountCents ?? 0
    return {
      key: 'vouchers_awaiting_docs',
      severity: 'warn',
      title: 'Cash voucher documents not checked',
      detail: `${plural(count, 'cash voucher')} paid on or before ${fmtPktDate(ctx.newLock)} (${pkr(cents)}) ${count === 1 ? 'has' : 'have'} supporting documents finance has not checked yet. `
        + 'Check them on Finance → Cash vouchers.',
      count,
      cents,
      link: '/finance/cash-vouchers?view=awaiting_verification',
      overridable: false,
    }
  },
}

// Owner, 2026-10-16 ("add the resolved button, and make it block the close"): a voucher paid under the 2026-10-15
// hold flow and still HELD on 1357 (the boot conversion could not book it, and finance has not marked it "Resolved by
// journal entry") means its expense is not on the books — the close BLOCKS (the CEO may close over it with a reason).
// Same predicate as trustops/voucherHoldConversion.ts heldVoucherWhere, kept inline (no trustops import here).
const vouchersHeldOn1357Check: CloseCheck = {
  key: 'vouchers_held_on_1357',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    // Paid on or before the lock (a held row with no pay date counts too — never a silent pass).
    const paidByLock: Prisma.CashVoucherWhereInput = { OR: [{ disbursedAt: { lte: ctx.newLock } }, { disbursedAt: null }] }
    const held = await ctx.db.cashVoucher.findMany({
      where: {
        tenantId: ctx.tenantId, status: 'disbursed', expenseOnVerify: true, bookedAtPay: false, postedAt: null,
        AND: [paidByLock, { OR: [{ pettyCashMovementId: { not: null } }, { payJournalEntryId: { not: null } }] }],
      },
      select: { id: true, number: true, amountCents: true, seq: true },
      orderBy: { seq: 'asc' },
      take: 500,
    })
    // Cleared only AFTER the lock (converted, or "Resolved by journal entry" with an entry dated after it): at the lock
    // the hold still sat on 1357 and the expense was not in the period — the same block (date the clearing entry
    // inside the period, or the CEO closes over it).
    const cleared = await ctx.db.cashVoucher.findMany({
      where: {
        tenantId: ctx.tenantId, expenseOnVerify: true, bookedAtPay: true, postedJournalEntryId: { not: null },
        disbursedAt: { lte: ctx.newLock },
      },
      select: { id: true, number: true, amountCents: true, seq: true, postedJournalEntryId: true },
      take: 500,
    })
    const lateIds = cleared.length === 0 ? new Set<string>() : new Set((await ctx.db.journalEntry.findMany({
      where: { tenantId: ctx.tenantId, id: { in: cleared.map((c) => c.postedJournalEntryId!) }, entryDate: { gt: ctx.newLock } },
      select: { id: true },
    })).map((e) => e.id))
    const late = cleared.filter((c) => lateIds.has(c.postedJournalEntryId!))
    const rows = [...held, ...late].sort((a, b) => a.seq - b.seq)
    if (rows.length === 0) return null
    const cents = rows.reduce((t, r) => t + r.amountCents, 0)
    const shown = rows.slice(0, 5).map((r) => r.number).join(', ') + (rows.length > 5 ? ` and ${rows.length - 5} more` : '')
    return {
      key: 'vouchers_held_on_1357',
      severity: 'block',
      title: 'Cash vouchers still held on 1357',
      detail: `${plural(rows.length, 'cash voucher')} paid on or before ${fmtPktDate(ctx.newLock)} (${pkr(cents)}: ${shown}) ${rows.length === 1 ? 'is' : 'are'} still held on 1357 at that date — the expense is not booked in the period. `
        + 'Fix the cause and check the documents (which books it), or post a manual journal (Dr the expense / Cr 1357) dated in the period and press "Resolved by journal entry" on the voucher in Finance → Cash vouchers.'
        + (late.length ? ` ${plural(late.length, 'voucher')} ${late.length === 1 ? 'was' : 'were'} cleared only by an entry dated after ${fmtPktDate(ctx.newLock)}.` : ''),
      count: rows.length,
      cents,
      link: rows.length === 1 ? `/finance/cash-vouchers/${rows[0]!.id}` : '/finance/cash-vouchers?view=awaiting_verification',
      overridable: true,
    }
  },
}

export const CORE_CLOSE_CHECKS: CloseCheck[] = [
  raastCheck, openTillsCheck, unpostedShiftsCheck, unpostedOrdersCheck, postingFailedCheck, trialBalanceCheck, bankUnmatchedCheck,
  vouchersAwaitingDocsCheck, vouchersHeldOn1357Check,
]

/** EVERY period-close check, in the order the checklist shows them. */
export const CLOSE_CHECKS: CloseCheck[] = [
  ...CORE_CLOSE_CHECKS,
  ...hrCloseChecks,
  ...statutoryCloseChecks,
  ...intercompanyCloseChecks,
  ...fixedAssetCloseChecks,
  ...cardPayoutCloseChecks,
  ...prepaidCloseChecks,
  // Stock and purchasing — grni_stale, inventory_postings_pending,
  // stock_differences_pending (H20: waste / count differences still in 1290). All warn, overridable.
  ...inventoryCloseChecks,
  stockDifferenceCloseCheck,
  // Resumed 2026-10-15: head-office recharges, COD not handed in (blocks until the CEO approves), on-account tie-out.
  ...headOfficeCloseChecks,
  codCloseCheck,
  ...onAccountCloseChecks,
  // Night audit (owner, 2026-10-16; sales module only): every active SALES day
  // of the range closed (audited + settled), or the CEO closes over it.
  nightAuditCloseCheck,
]

/** The key of the block a throwing check becomes. */
export const CHECK_FAILED_PREFIX = 'check_failed:'

/**
 * Whether the CEO may close over a block with this key: every block check
 * that says so, and every 'check_failed:<key>'. trial_balance never.
 */
export function isOverridableKey(key: string): boolean {
  // A check that could not run inherits its own rule: a never-overridable
  // block (trial_balance) that failed to run cannot be closed over either —
  // nobody has seen the books balance.
  const base = key.startsWith(CHECK_FAILED_PREFIX) ? key.slice(CHECK_FAILED_PREFIX.length) : key
  const c = CLOSE_CHECKS.find((x) => x.key === base)
  return !c || c.severity !== 'block' || c.overridable
}

function isTransaction(db: CloseCheckDb): db is Prisma.TransactionClient {
  return typeof (db as { $transaction?: unknown }).$transaction !== 'function'
}

/**
 * Run `checks` in order against `ctx` and collect their problems — the ONE
 * runner of the month checklist (closeChecklist) and the night audit's
 * (nightAudit/checks.ts nightChecklist). A check that throws becomes a block
 * keyed 'check_failed:<its key>' (overridable). Inside a transaction each check
 * runs behind its own savepoint, so one failing statement cannot abort it.
 */
export async function runChecks<C extends { tenantId: string }>(
  db: CloseCheckDb,
  checks: ReadonlyArray<{ key: string; run(ctx: C): Promise<CloseProblem | null> }>,
  ctx: C,
  opts: { tag: string; savepoint: string; failLink: string },
): Promise<CloseProblem[]> {
  const problems: CloseProblem[] = []
  const inTx = isTransaction(db)
  for (let i = 0; i < checks.length; i++) {
    const check = checks[i]!
    let result: { ok: true; value: CloseProblem | null } | { ok: false; error: Error }
    if (inTx) {
      result = await withSavepoint(db, `${opts.savepoint}_${i}`, () => check.run(ctx))
    } else {
      try {
        result = { ok: true, value: await check.run(ctx) }
      } catch (err) {
        result = { ok: false, error: err as Error }
      }
    }
    if (result.ok) {
      if (result.value) problems.push(result.value)
      continue
    }
    console.error(`[${opts.tag}] check ${check.key} failed for ${ctx.tenantId}:`, result.error.message)
    // Never-overridable block checks (trial_balance) stay never-overridable
    // when they cannot run.
    const declared = check as { severity?: string; overridable?: boolean }
    const failOverridable = !(declared.severity === 'block' && declared.overridable === false)
    problems.push({
      key: `${CHECK_FAILED_PREFIX}${check.key}`,
      severity: 'block',
      title: `Check could not run: ${check.key.replace(/_/g, ' ')}`,
      detail: `The '${check.key}' check failed (${result.error.message.slice(0, 200)}), so servd cannot tell whether it is clear. Try again; ${failOverridable ? "going past it needs the CEO's reason" : 'this check cannot be overridden — the books cannot close until it runs'}.`,
      count: 1,
      link: opts.failLink,
      overridable: failOverridable,
    })
  }
  return problems
}

export interface CloseChecklist {
  problems: CloseProblem[]
  blocks: CloseProblem[]
  warnings: CloseProblem[]
  months: string[]
  isYearEnd: boolean
}

/**
 * Run every check for one company and one proposed lock (inclusive, PKT end
 * of day). Reads the company's current lock and first entry from `db` — pass
 * the close's transaction so the answer is the one the close acts on.
 */
export async function closeChecklist(db: CloseCheckDb, tenantId: string, newLock: Date): Promise<CloseChecklist> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  const first = await db.journalEntry.findFirst({ where: { tenantId }, orderBy: { entryDate: 'asc' }, select: { entryDate: true } })
  const endMonth = await fiscalYearEndMonthOf(db, tenantId)
  const prevLock = lock?.lockedThrough ?? null
  const firstEntryDate = first?.entryDate ?? null
  const months = monthsInRange(prevLock, newLock, firstEntryDate)
  const start = rangeStart(prevLock, newLock, firstEntryDate)
  const isYearEnd = newLock.getTime() > (prevLock?.getTime() ?? -Infinity)
    && isFiscalYearEndInRange(endMonth, prevLock ?? new Date(start.getTime() - 1), newLock)
  const ctx: CloseCheckContext = { db, tenantId, prevLock, newLock, months, isYearEnd, cache: new Map() }
  const problems = await runChecks(db, CLOSE_CHECKS, ctx, { tag: 'period-close', savepoint: 'close_check', failLink: '/accounting/period-close' })
  return {
    problems,
    blocks: problems.filter((p) => p.severity === 'block'),
    warnings: problems.filter((p) => p.severity === 'warn'),
    months,
    isYearEnd,
  }
}
