// The night audit's checks — SALES money only (owner, 2026-10-16). Contract:
// ./README.md §3. Two phases:
//   night       the same night: tills closed and counted, the day's tickets
//               ended, every sale on the books, Raast and COD in, every
//               tender resolved → the day becomes 'audited' (locked for sales).
//   settlement  audited → closed: the card payout and the bank side of the
//               day's sales money are matched.
// Every check is a block the CEO may push past with a reason (overridable),
// unless marked otherwise; a check that throws becomes 'check_failed:<key>'
// (accounting/closeChecks.ts runChecks — the one runner). Every query is
// filtered on ctx.tenantId. Purchases, petty cash, payroll and every other
// module are never read.

import type { CloseCheckDb } from '../accounting/closeCheckTypes.js'
import {
  CHECK_FAILED_PREFIX, openTillsThrough, postingFailedBetween, runChecks, unpostedOrderRows, unpostedShiftRows,
} from '../accounting/closeChecks.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { closedShiftsOfBusinessDays } from '../../lib/businessDay.js'
import { toCents } from '../../lib/money.js'
import { codBookedDebtIds, codPendingLink, codPendingRows } from '../reconciliation/codCloseCheck.js'
import { raastNightOpenBetween, raastOpenBetween } from '../reconciliation/raast.js'
import { raastConnectorTx } from '../../connectors/raast/match.js'
import { cardDayGrossTx, cardSettlementSettings, dayNum, unsettledCardDays } from '../reconciliation/cardPayouts.js'
import { salesBankUnmatchedBetween } from '../reconciliation/service.js'
import type { CloseProblem, NightCheck, NightCheckContext, NightPhase } from './types.js'

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const isAre = (n: number) => (n === 1 ? 'is' : 'are')

function block(key: string, title: string, detail: string, count: number, link: string, cents?: number): CloseProblem {
  return { key, severity: 'block', title, detail, count, ...(cents && cents > 0 ? { cents } : {}), link, overridable: true }
}

/** Order statuses that end a ticket. */
const ENDED_ORDER = ['completed', 'cancelled', 'rejected', 'refunded'] as const

/**
 * Shifts of the company closed on the business days [from, to]: a till that
 * closes before 05:00 PKT belongs to the day it opened (lib/businessDay.ts —
 * owner, 2026-10-16).
 */
async function shiftsClosedBetween(db: CloseCheckDb, tenantId: string, from: Date, to: Date): Promise<Array<{ id: string }>> {
  return closedShiftsOfBusinessDays(db, tenantId, from, to)
}

/** Open cash_variance flags on the company's shifts closed in [from, to] (owner question Q4). */
export async function cashVarianceOpenBetween(db: CloseCheckDb, tenantId: string, from: Date, to: Date): Promise<{ count: number; cents: number }> {
  const shifts = await shiftsClosedBetween(db, tenantId, from, to)
  if (shifts.length === 0) return { count: 0, cents: 0 }
  const flags = await db.exceptionFlag.findMany({
    where: { tenantId, kind: 'cash_variance', status: 'open', entityType: 'Shift', entityId: { in: shifts.map((s) => s.id) } },
    select: { amountCents: true },
  })
  return { count: flags.length, cents: flags.reduce((t, f) => t + Math.abs(toCents(f.amountCents ?? 0)), 0) }
}

/** Tickets of the company whose sales day (scheduledFor ?? placedAt) is in [from, to] and that have not ended. */
export async function openOrdersBetween(db: CloseCheckDb, tenantId: string, from: Date, to: Date): Promise<{ count: number; cents: number }> {
  const at = { gte: from, lte: to }
  const r = await db.order.aggregate({
    where: {
      concept: { tenantId },
      deletedAt: null,
      status: { notIn: [...ENDED_ORDER] },
      OR: [{ scheduledFor: at }, { scheduledFor: null, placedAt: at }],
    },
    _count: { _all: true },
    _sum: { totalCents: true },
  })
  return { count: r._count._all, cents: r._sum.totalCents ?? 0 }
}

/**
 * Tenders of the day not resolved: (a) pending payments (any method but COD,
 * which is cod_pending's) created in [from, to] on the company's orders that
 * are not cancelled / rejected; (b) card-machine charges created in [from, to]
 * whose outcome is not final, or that need a person (needs_attention).
 * `unverified` / `manual_resolved` charges are counted apart (a warn).
 */
export async function unresolvedTendersBetween(db: CloseCheckDb, tenantId: string, from: Date, to: Date): Promise<{ payments: number; charges: number; unverified: number; cents: number }> {
  const at = { gte: from, lte: to }
  const pending = await db.payment.findMany({
    where: {
      status: 'pending', createdAt: at, amountCents: { gt: 0 },
      order: { concept: { tenantId }, status: { notIn: ['cancelled', 'rejected'] } },
      // COD (cash pending on a completed non-till order) is cod_pending's.
      NOT: { method: 'cash', order: { source: { not: 'pos' }, status: 'completed' } },
    },
    select: { amountCents: true },
  })
  const charges = await db.terminalCharge.findMany({
    // needs_attention: a reversal that failed (or an unknown past 24 h) — money may sit on the
    // customer's card with no outcome in servd; a person must resolve it before the day locks.
    where: { tenantId, createdAt: at, status: { in: ['pending', 'sent', 'approved', 'cancel_requested', 'unknown', 'void_pending', 'needs_attention'] } },
    select: { amountCents: true },
  })
  // Still being verified against the machine (a warn): marked "not charged", or recorded from the slip.
  const unverified = await db.terminalCharge.count({ where: { tenantId, createdAt: at, status: { in: ['unverified', 'manual_resolved'] } } })
  const cents = pending.reduce((t, p) => t + p.amountCents, 0) + charges.reduce((t, c) => t + c.amountCents, 0)
  return { payments: pending.length, charges: charges.length, unverified, cents }
}

/**
 * Tills closed on the business days [from, to] whose cash is not banked in
 * full: the amounts banked for the shift (every deposit drop's share for it —
 * one bag may be split across several tills, owner 2026-10-16) fall short of
 * its cash to bank (expectedShiftDeposit: its drops + counted close − float
 * kept) — wholly, or by more than the company's cash tolerance when part is
 * banked. "A deposit exists" is not enough — the night audit compares amounts. `cents` = what is still unbanked.
 */
export async function cashNotBankedBetween(db: CloseCheckDb, tenantId: string, from: Date, to: Date): Promise<{ count: number; cents: number }> {
  const shifts = await shiftsClosedBetween(db, tenantId, from, to)
  if (shifts.length === 0) return { count: 0, cents: 0 }
  const { bankedByShift, expectedShiftDeposit } = await import('../accounting/depositPosting.js')
  const { cashVarianceLimitCents } = await import('../../lib/drawer.js')
  const banked = await bankedByShift(db, tenantId, shifts.map((s) => s.id))
  const tolerance = await cashVarianceLimitCents(tenantId)
  let count = 0
  let cents = 0
  for (const s of shifts) {
    const e = await expectedShiftDeposit(s.id)
    if (e.expectedCents <= 0) continue
    const bankedCents = banked.get(s.id) ?? 0
    const short = e.expectedCents - bankedCents
    // Nothing banked at all blocks whatever the amount; a part banked blocks
    // when the rest is beyond the tolerance (a counting difference at the bank).
    if (short <= 0 || (bankedCents > 0 && short <= tolerance)) continue
    count += 1
    cents += short
  }
  return { count, cents }
}

// ─── Night step ──────────────────────────────────────────────────────────────

const night = (key: string, run: (ctx: NightCheckContext) => Promise<CloseProblem | null>): NightCheck =>
  ({ key, phase: 'night', severity: 'block', overridable: true, run })
const settlement = (key: string, run: (ctx: NightCheckContext) => Promise<CloseProblem | null>): NightCheck =>
  ({ key, phase: 'settlement', severity: 'block', overridable: true, run })

export const NIGHT_CHECKS: NightCheck[] = [
  night('open_tills', async (ctx) => {
    const open = await openTillsThrough(ctx.db, ctx.tenantId, ctx.to)
    if (open.length === 0) return null
    return block('open_tills', 'Tills still open',
      `${plural(open.length, 'till')} opened on or before ${ctx.day} ${isAre(open.length)} still open. Close and count ${open.length === 1 ? 'it' : 'them'} on the till first.`,
      open.length, '/reconciliation')
  }),
  night('cash_variance_open', async (ctx) => {
    const r = await cashVarianceOpenBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (r.count === 0) return null
    return block('cash_variance_open', 'Cash differences not reviewed',
      `${plural(r.count, 'till')} closed on ${ctx.day} counted a cash difference (${pkr(r.cents)}) nobody has reviewed. Acknowledge or resolve ${r.count === 1 ? 'it' : 'them'} in Exceptions.`,
      r.count, '/exceptions?kind=cash_variance', r.cents)
  }),
  night('open_orders', async (ctx) => {
    const r = await openOrdersBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (r.count === 0) return null
    return block('open_orders', 'Tickets still open',
      `${plural(r.count, 'ticket')} of ${ctx.day} (${pkr(r.cents)}) ${r.count === 1 ? 'has' : 'have'} not been completed, cancelled or refunded. Finish or cancel ${r.count === 1 ? 'it' : 'them'} first.`,
      r.count, `/orders?status=open&date=${ctx.day}`, r.cents)
  }),
  night('unposted_shifts', async (ctx) => {
    const rows = await unpostedShiftRows(ctx.db, ctx.tenantId, ctx.from, ctx.to, ctx.cache)
    if (rows.length === 0) return null
    return block('unposted_shifts', 'Closed tills not on the books',
      `${plural(rows.length, 'till close')} of ${ctx.day} never reached the ledger. Post ${rows.length === 1 ? 'it' : 'them'} from Reconciliation → Backfill unposted.`,
      rows.length, '/reconciliation')
  }),
  night('unposted_orders', async (ctx) => {
    const rows = await unpostedOrderRows(ctx.db, ctx.tenantId, ctx.from, ctx.to, ctx.cache)
    if (rows.length === 0) return null
    const kinds = Array.from(new Set(rows.map((r) => r.kind))).sort()
    return block('unposted_orders', 'Sales not on the books',
      `${plural(rows.length, 'document')} of ${ctx.day} still owe the ledger an entry (${kinds.join(', ')}). Post them from Reconciliation → Backfill unposted.`,
      rows.length, '/reconciliation')
  }),
  night('posting_failed', async (ctx) => {
    const r = await postingFailedBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to, ctx.cache, { salesOnly: true })
    if (r.count === 0) return null
    return block('posting_failed', 'Refused sales postings still open',
      `${plural(r.count, 'sales posting')} of ${ctx.day} the ledger refused ${isAre(r.count)} still open. Fix the cause and re-post from Reconciliation → Backfill unposted.`,
      r.count, '/exceptions?kind=posting_failed', r.cents)
  }),
  night('raast_open_night', async (ctx) => {
    const { enabled } = await raastConnectorTx(ctx.db, ctx.tenantId)
    const r = await raastNightOpenBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to, enabled)
    if (r.count === 0) return null
    return block('raast_open_night', 'Raast payments not settled',
      `${plural(r.count, 'Raast payment')} of ${ctx.day} (${pkr(r.cents)}) ${isAre(r.count)} still awaiting the customer, need attention${enabled ? ', or have no bank SMS' : ''}. Settle them at the till or on Reconciliation → Raast.`,
      r.count, '/reconciliation?tab=raast', r.cents)
  }),
  // A COD whose rider debt finance has booked (live 1351 entry, or the fleet
  // 'cod' transfer) no longer blocks the night run — it shows as "rider owes —
  // booked" (owner, 2026-10-17). Unbooked COD still blocks; a reversed booking
  // blocks again. The month close (cod_with_rider) is unchanged.
  night('cod_pending', async (ctx) => {
    const rows = await codPendingRows(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (rows.length === 0) return null
    const bookedIds = await codBookedDebtIds(ctx.db, ctx.tenantId, rows)
    const open = rows.filter((p) => !bookedIds.has(p.id))
    const booked = rows.filter((p) => bookedIds.has(p.id))
    const bookedCents = booked.reduce((t, p) => t + toCents(p.amountCents), 0)
    const bookedNote = booked.length > 0
      ? `${plural(booked.length, 'cash-on-delivery payment')} (${pkr(bookedCents)}): rider owes — booked.`
      : ''
    const go = await codPendingLink(ctx.db, ctx.tenantId)
    if (open.length === 0) {
      return {
        key: 'cod_pending', severity: 'warn', title: 'Cash on delivery: rider owes — booked',
        detail: `${bookedNote} Finance booked ${booked.length === 1 ? 'it' : 'them'} as owed by the rider; the cash is still to be handed in. ${go.where}`,
        count: booked.length, ...(bookedCents > 0 ? { cents: bookedCents } : {}), link: go.link, overridable: false,
      }
    }
    const cents = open.reduce((t, p) => t + toCents(p.amountCents), 0)
    return block('cod_pending', 'Cash on delivery not handed in',
      `${plural(open.length, 'cash-on-delivery payment')} of ${ctx.day} (${pkr(cents)}) ${open.length === 1 ? 'has' : 'have'} not been paid into a drawer. ${go.where}${bookedNote ? ` Also ${bookedNote}` : ''}`,
      open.length, go.link, cents)
  }),
  {
    key: 'tenders_unresolved', phase: 'night', severity: 'block', overridable: true,
    async run(ctx) {
      const r = await unresolvedTendersBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
      const n = r.payments + r.charges
      if (n === 0) {
        if (r.unverified === 0) return null
        return {
          key: 'tenders_unresolved', severity: 'warn', title: 'Card charges still being verified',
          detail: `${plural(r.unverified, 'card-machine charge')} of ${ctx.day} the cashier marked "not charged" or recorded from the slip ${isAre(r.unverified)} still being verified against the machine.`,
          count: r.unverified, link: '/orders', overridable: false,
        }
      }
      return block('tenders_unresolved', 'Payments not resolved',
        `${ctx.day} has ${[r.payments ? plural(r.payments, 'pending payment') : null, r.charges ? plural(r.charges, 'card-machine charge') + ' with no final outcome' : null].filter(Boolean).join(' and ')} (${pkr(r.cents)}). Settle, cancel or resolve ${n === 1 ? 'it' : 'them'} first.`,
        n, '/orders', r.cents)
    },
  },
]

// ─── Settlement step ─────────────────────────────────────────────────────────

export const SETTLEMENT_CHECKS: NightCheck[] = [
  {
    key: 'card_unsettled_day', phase: 'settlement', severity: 'block', overridable: true,
    async run(ctx) {
      const s = await cardSettlementSettings(ctx.db, ctx.tenantId)
      const n = dayNum(ctx.day)
      if (!s.enabled || !s.startDay) {
        // Matching off: the day's card money cannot be proven against a payout.
        const gross = await cardDayGrossTx(ctx.db, ctx.tenantId, { ...s, startDay: ctx.day, unitMode: 'company' }, n, n)
        const cents = [...gross.values()].reduce((t, byDay) => t + (byDay.get(n) ?? 0), 0)
        if (cents === 0) return null
        return block('card_matching_off', 'Card payout matching is off',
          `${ctx.day} took ${pkr(cents)} by card, but card payout matching is switched off, so its Keenu payout cannot be matched. Switch it on in Reconciliation → Card payouts, or the CEO closes the day over it.`,
          1, '/reconciliation?tab=card-payouts', cents)
      }
      const rows = await unsettledCardDays(ctx.db, ctx.tenantId, s, n, n)
      if (rows.length === 0) return null
      const cents = rows.reduce((t, r) => t + r.cents, 0)
      return block('card_unsettled_day', 'Card sales with no bank payout',
        `${ctx.day}'s card sales (${pkr(cents)}) have no Keenu payout matched yet. Import the payout bank's statement and confirm the payout on Reconciliation → Card payouts.`,
        rows.length, '/reconciliation?tab=card-payouts', cents)
    },
  },
  settlement('raast_unmatched_day', async (ctx) => {
    const r = await raastOpenBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (r.count === 0) return null
    return block('raast_unmatched_day', 'Raast payments not on a bank statement',
      `${plural(r.count, 'Raast payment')} of ${ctx.day} (${pkr(r.cents)}) ${isAre(r.count)} not matched to a bank statement yet. Match them on Reconciliation → Raast.`,
      r.count, '/reconciliation?tab=raast', r.cents)
  }),
  settlement('cash_not_banked', async (ctx) => {
    const r = await cashNotBankedBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (r.count === 0) return null
    return block('cash_not_banked', 'Till cash not deposited',
      `${plural(r.count, 'till')} closed on ${ctx.day} still ${r.count === 1 ? 'has' : 'have'} ${pkr(r.cents)} of cash not deposited in the bank. Record the deposit (one bag may be split across several tills) on Finance → Deposit drops.`,
      r.count, '/finance/deposit-drops', r.cents)
  }),
  settlement('sales_bank_unmatched', async (ctx) => {
    const r = await salesBankUnmatchedBetween(ctx.db, ctx.tenantId, ctx.from, ctx.to)
    if (r.count === 0) return null
    return block('sales_bank_unmatched', 'Sales money not on a bank statement',
      `${plural(r.count, 'bank line')} of ${ctx.day}'s sales money (${pkr(Math.abs(r.cents))} — deposits of its till cash, bank transfers, refunds from the bank) ${isAre(r.count)} not matched to a bank statement line yet. Import the statement and match them on Reconciliation → Bank.`,
      r.count, '/reconciliation?tab=bank', Math.abs(r.cents))
  }),
]

export const ALL_NIGHT_CHECKS: NightCheck[] = [...NIGHT_CHECKS, ...SETTLEMENT_CHECKS]

/** Whether the CEO may push past a night-audit block with this key. */
export function isNightOverridableKey(key: string): boolean {
  if (key.startsWith(CHECK_FAILED_PREFIX)) return true
  if (key === 'card_matching_off') return true
  const c = ALL_NIGHT_CHECKS.find((x) => x.key === key)
  return !c || c.severity !== 'block' || c.overridable
}

export interface NightChecklist {
  phase: NightPhase
  problems: CloseProblem[]
  blocks: CloseProblem[]
  warnings: CloseProblem[]
  ready: boolean
}

/** Run one phase's checks for one company and one PKT day. */
export async function nightChecklist(db: CloseCheckDb, tenantId: string, day: string, phase: NightPhase): Promise<NightChecklist> {
  const ctx: NightCheckContext = { db, tenantId, day, from: parsePktStartOfDay(day), to: parsePktEndOfDay(day), cache: new Map() }
  const checks = phase === 'night' ? NIGHT_CHECKS : SETTLEMENT_CHECKS
  const problems = await runChecks(db, checks, ctx, { tag: 'night-audit', savepoint: `night_check_${phase}`, failLink: '/finance/night-audit' })
  const blocks = problems.filter((p) => p.severity === 'block')
  return { phase, problems, blocks, warnings: problems.filter((p) => p.severity === 'warn'), ready: blocks.length === 0 }
}
