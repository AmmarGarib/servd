// Card payouts at payout (H12, finance wave B) — Keenu pays a day's card money
// into the payout bank NET of the merchant discount (MDR) and the tax on it.
//
// This EXTENDS BOOKS-11 (owner's standing rule — one way to book a net card
// payout): the manual split on a bank line (service.ts adjustStatementLine)
// and this module post through the SAME helper, service.ts
// postCardPayoutSplitTx — Dr the payout bank net / Dr 6080 the fee (MDR + the
// tax on it, all a cost — H12) / Cr 1030 the day's card gross. What this adds
// is the matching: which statement credit pays which days of card sales.
//
//   Day gross     card Payment rows of the company — method card (and the
//                 retired keenu_qr's old rows), Keenu-settled (gateway
//                 card_terminal, keenu or none; JazzCash / Easypaisa / Raast
//                 never), status paid (+) or refunded (−) — by the PKT day of
//                 their payment time (processedAt, else createdAt). NOT the
//                 1030 entry dates: a shift close books card money on
//                 closedAt and without its brand (critic).
//   Unit          per Keenu MID: 'company' (one MID), 'brand:<conceptId>' or
//                 'terminal:<terminalId>' (TerminalCharge; a card payment with
//                 no machine is 'terminal:none'). CardSettlementDay is unique
//                 per (company, unit, day); a day settled under another unit
//                 family (the mode was changed) is taken too.
//   Fit           a credit on the payout bank, dated D, fits a run of 1..
//                 maxBatchDays unsettled days of ONE unit ending 1..lagDays+1
//                 days before D (first and last day with card money), when
//                 |net − gross × (1 − mdr × (1 + feeTax))| ≤ max(PKR 1,
//                 gross × tolerance) and the fee is within 0..maxFeeBps.
//                 EXACTLY one fit for the line and no day of it fitted by any
//                 other line of the pass — else nothing (never a guess): the
//                 line stays unmatched, finance confirms a suggestion.
//   Post          postCardSettlementTx — advisory lock (company,
//                 'card-settlement'), re-validate, period lock + accounts
//                 pre-checked (a refusal leaves the line unmatched with its
//                 reason, never a 500), CardSettlement + its days, the split
//                 'card.settlement:<lineId>[@n]', the line matched to the bank
//                 leg. Company = the statement import's.
//   Refusals      an automatic post that is refused writes the reason on the
//                 line and raises ONE open 'card_payout_unmatched' flag per
//                 line. The unmatched line, POST /card-payouts/rematch and the
//                 period-close check 'card_unsettled' are the queue — there is
//                 no REPOSTER (nothing was posted, so nothing is half-booked).
//   Undo          APPROVERS: the entry is reversed (dated today), the
//                 settlement deleted (its days freed), the line unmatched.
//
// Money: day gross and payouts are company-level sums in JS numbers (BIGINT
// columns on CardSettlement come back as numbers through lib/money.ts).

import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { flagException } from '../../lib/exceptions.js'
import { ACCT, reverseJournalEntry } from '../accounting/journal.js'
import { fmtPktDate } from '../accounting/dates.js'
import type { CloseCheck, CloseCheckContext, CloseProblem } from '../accounting/closeCheckTypes.js'
import { NON_BANK_MONEY_CODES } from '../../connectors/raast/accounts.js'
import { postCardPayoutSplitTx } from './service.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof defaultPrisma

const DAY_MS = 86_400_000
const PKT_MS = 5 * 3_600_000
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const

export const CARD_SETTLEMENT_SOURCE = 'card.settlement'
/** The flag a refused automatic card payout raises (one open per statement line). */
export const CARD_PAYOUT_FLAG = 'card_payout_unmatched' as const
/** Days a confirm / manual claim may name at most (the settings cap automatic runs at maxBatchDays). */
export const MAX_CONFIRM_DAYS = 5

// ─── Days ────────────────────────────────────────────────────────────────────

/** PKT business-day number of an instant (a statement's date-only value lands on its own day). */
export const dayNumOf = (d: Date): number => Math.floor((d.getTime() + PKT_MS) / DAY_MS)
/** 'YYYY-MM-DD' of a day number. */
export const dayStr = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10)
/** Day number of a 'YYYY-MM-DD' (NaN when it is not a real date). */
export const dayNum = (s: string): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return Number.NaN
  const t = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(t)) return Number.NaN
  const n = Math.floor(t / DAY_MS)
  return dayStr(n) === s ? n : Number.NaN
}
/** The UTC instant a PKT day starts. */
const dayStart = (n: number): Date => new Date(n * DAY_MS - PKT_MS)

// ─── Settings (OperationsConfig.cardSettlement) ─────────────────────────────

export const UNIT_MODES = ['company', 'brand', 'terminal'] as const
export type UnitMode = (typeof UNIT_MODES)[number]

export interface CardSettlementSettings {
  enabled: boolean
  /** The company's bank account Keenu pays into (a live, linked bank of the company). */
  payoutBankAccountId: string | null
  /** How Keenu pays: one MID for the company, one per brand, or one per card machine. */
  unitMode: UnitMode
  /** Merchant discount rate, basis points of the gross (250 = 2.5%). */
  mdrBps: number
  /** Tax on the fee, basis points of the fee (1600 = 16%). Only predicts the payout; all of the fee is 6080 (H12). */
  feeTaxBps: number
  /** Keenu pays 1..lagDays (+1) days after the card day. */
  lagDays: number
  /** How far the payout may be from the prediction, basis points of the gross (min PKR 1). */
  toleranceBps: number
  /** Days one payout may cover at most (a weekend batch is 3). */
  maxBatchDays: number
  /** The largest fee a payout may imply, basis points of the gross (a confirm above it is 422). */
  maxFeeBps: number
  /** The first card day matched (YYYY-MM-DD PKT). Set on the first enable; earlier days were cleared by hand. */
  startDay: string | null
}

export const CARD_SETTLEMENT_DEFAULTS: CardSettlementSettings = {
  enabled: false,
  payoutBankAccountId: null,
  unitMode: 'company',
  mdrBps: 0,
  feeTaxBps: 0,
  lagDays: 2,
  toleranceBps: 30,
  maxBatchDays: 3,
  maxFeeBps: 500,
  startDay: null,
}

const dayField = z.string().refine((s) => !Number.isNaN(dayNum(s)), 'A day as YYYY-MM-DD')

/** The ranges of every setting (the PUT route validates against the same schema). */
export const cardSettlementFields = {
  enabled: z.boolean(),
  payoutBankAccountId: z.string().min(1).nullable(),
  unitMode: z.enum(UNIT_MODES),
  mdrBps: z.number().int().min(0).max(1000),
  feeTaxBps: z.number().int().min(0).max(3000),
  lagDays: z.number().int().min(1).max(5),
  toleranceBps: z.number().int().min(0).max(200),
  maxBatchDays: z.number().int().min(1).max(5),
  maxFeeBps: z.number().int().min(0).max(1000),
  startDay: dayField.nullable(),
}
const storedSchema = z.object(cardSettlementFields).partial()

async function opsConfigRow(db: Db, tenantId: string) {
  return db.operationsConfig.findFirst({
    where: { scope: 'global', scopeId: null, tenantId },
    select: { id: true, cardSettlement: true },
  })
}

/**
 * The company's card-payout settings (defaults when none). A stored value that
 * no longer parses reads as OFF (and is logged) — never a guess at a payout
 * bank. Read fresh (no cache) so a pass inside a transaction sees the latest.
 */
export async function cardSettlementSettings(db: Db, tenantId: string): Promise<CardSettlementSettings> {
  const row = await opsConfigRow(db, tenantId)
  const raw = row?.cardSettlement
  if (raw === null || raw === undefined) return { ...CARD_SETTLEMENT_DEFAULTS }
  const parsed = storedSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn(`[card-payouts] company ${tenantId}: stored card payout settings do not parse — treated as off`)
    return { ...CARD_SETTLEMENT_DEFAULTS }
  }
  return { ...CARD_SETTLEMENT_DEFAULTS, ...parsed.data }
}

/** True when this import's credits go through the card-payout pass. */
export const isPayoutBank = (s: CardSettlementSettings, bankAccountId: string | null | undefined): boolean =>
  s.enabled && !!s.startDay && !!s.payoutBankAccountId && s.payoutBankAccountId === bankAccountId

/**
 * Save the company's settings (PUT /card-payouts/settings). `patch` is merged
 * over the stored settings. The payout bank must be a live, active, linked
 * BANK of the company (422 BANK_ACCOUNT_NOT_IN_COMPANY / BANK_ACCOUNT_NOT_LINKED /
 * BANK_ACCOUNT_NOT_A_BANK); enabling needs one (422 PAYOUT_BANK_REQUIRED).
 * startDay: today (PKT) on the first enable; it may be set to an earlier day
 * only after the last manual split that cleared 1030 (422
 * START_DAY_BEFORE_MANUAL_SPLIT) — days before it were cleared by hand.
 */
export async function saveCardSettlementSettings(db: typeof defaultPrisma, tenantId: string, patch: Partial<CardSettlementSettings>, actorId: string): Promise<{ before: CardSettlementSettings; after: CardSettlementSettings }> {
  const before = await cardSettlementSettings(db, tenantId)
  const after: CardSettlementSettings = { ...before, ...patch }
  if (after.payoutBankAccountId && after.payoutBankAccountId !== before.payoutBankAccountId) {
    await assertPayoutBank(db, tenantId, after.payoutBankAccountId)
  }
  if (after.enabled && !after.payoutBankAccountId) {
    throw new AppError('PAYOUT_BANK_REQUIRED', 'Pick the bank account Keenu pays into before switching card payout matching on', 422)
  }
  if (after.enabled && after.payoutBankAccountId) await assertPayoutBank(db, tenantId, after.payoutBankAccountId)
  if (after.maxFeeBps < after.mdrBps) {
    throw new AppError('MAX_FEE_BELOW_MDR', 'The largest fee allowed is below the MDR itself — raise it or lower the MDR', 422)
  }
  const today = dayNumOf(new Date())
  if (patch.startDay !== undefined && patch.startDay !== null) {
    const n = dayNum(patch.startDay)
    if (n > today) throw new AppError('START_DAY_IN_FUTURE', 'The first card day to match cannot be after today', 422)
    const lastManual = await lastManualCardSplitDay(db, tenantId)
    if (lastManual !== null && n <= lastManual) {
      throw new AppError(
        'START_DAY_BEFORE_MANUAL_SPLIT',
        `Card days up to ${dayStr(lastManual)} were cleared by a manual split of a bank line — start matching after it (${dayStr(lastManual + 1)} or later)`,
        422, { earliestStartDay: dayStr(lastManual + 1) },
      )
    }
  }
  if (after.enabled && !after.startDay) after.startDay = dayStr(today)

  const json = JSON.parse(JSON.stringify(after)) as Prisma.InputJsonValue
  const row = await opsConfigRow(db, tenantId)
  if (row) await db.operationsConfig.update({ where: { id: row.id }, data: { cardSettlement: json, updatedById: actorId } })
  else await db.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId, cardSettlement: json, updatedById: actorId } })
  return { before, after }
}

/** The PKT day of the latest manual bank-line split that credited 1030 (BOOKS-11 before matching was on), or null. */
async function lastManualCardSplitDay(db: Db, tenantId: string): Promise<number | null> {
  const line = await db.journalLine.findFirst({
    where: {
      type: 'credit', account: { tenantId, code: ACCT.CARD_RECEIVABLE },
      journalEntry: { tenantId, reference: { startsWith: 'reconciliation.adjustment:' } },
    },
    orderBy: { journalEntry: { entryDate: 'desc' } },
    select: { journalEntry: { select: { entryDate: true } } },
  })
  return line ? dayNumOf(line.journalEntry.entryDate) : null
}

/** A live, active, linked bank of the company whose chart code is a bank's (never cash, the drawer, 1030 or till clearing). */
async function assertPayoutBank(db: Db, tenantId: string, bankAccountId: string): Promise<{ id: string; accountCode: string; name: string }> {
  const bank = await db.bankAccount.findFirst({
    where: { id: bankAccountId, tenantId, deletedAt: null },
    select: { id: true, name: true, accountCode: true, isActive: true },
  })
  if (!bank || !bank.isActive) throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account is not an active account of this company', 422)
  if (!bank.accountCode) throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Link "${bank.name}" to a chart code first (Configuration → Bank accounts)`, 422)
  if (NON_BANK_MONEY_CODES.includes(bank.accountCode)) {
    throw new AppError('BANK_ACCOUNT_NOT_A_BANK', `"${bank.name}" posts to ${bank.accountCode}, which is not a bank balance — Keenu pays into a bank`, 422)
  }
  const acc = await db.account.findFirst({ where: { tenantId, code: bank.accountCode, isActive: true }, select: { id: true } })
  if (!acc) throw new AppError('BANK_ACCOUNT_NOT_LINKED', `"${bank.name}"'s chart code ${bank.accountCode} is not an active account of this company`, 422)
  return { id: bank.id, accountCode: bank.accountCode, name: bank.name }
}

// ─── Day gross from card Payment rows ────────────────────────────────────────

const CARD_METHODS = ['card', 'keenu_qr'] as const
/** Money a card processor other than Keenu (or a bank transfer) settles — never part of a Keenu payout. */
const NOT_KEENU_GATEWAYS = ['jazzcash', 'easypaisa', 'raast'] as const

export type UnitFamily = 'company' | 'brand' | 'terminal'
export const unitFamily = (unit: string): UnitFamily =>
  unit.startsWith('brand:') ? 'brand' : unit.startsWith('terminal:') ? 'terminal' : 'company'

/** Card money per unit per PKT day: Map<unit, Map<dayNum, cents>>. Days before startDay are left out. */
export type DayGross = Map<string, Map<number, number>>

/**
 * The company's card money by unit and PKT day, fromN..toN inclusive (never
 * before startDay). Paid card rows add, refunded card rows (negative) take
 * away. Scoped through the order's brand's company.
 */
export async function cardDayGrossTx(db: Db, tenantId: string, s: CardSettlementSettings, fromN: number, toN: number): Promise<DayGross> {
  const out: DayGross = new Map()
  if (!s.startDay) return out
  const from = Math.max(fromN, dayNum(s.startDay))
  if (from > toN) return out
  const window = { gte: dayStart(from), lt: dayStart(toN + 1) }
  const rows = await db.payment.findMany({
    where: {
      method: { in: [...CARD_METHODS] },
      gateway: { notIn: [...NOT_KEENU_GATEWAYS] },
      order: { concept: { tenantId } },
      AND: [
        { OR: [{ status: 'paid', amountCents: { gt: 0 } }, { status: 'refunded', amountCents: { lt: 0 } }] },
        { OR: [{ processedAt: window }, { processedAt: null, createdAt: window }] },
      ],
    },
    select: { id: true, amountCents: true, status: true, processedAt: true, createdAt: true, gatewayMeta: true, order: { select: { conceptId: true } } },
  })
  if (rows.length === 0) return out

  // Terminal mode: the card machine of each charge (a refund names its refund charge).
  let terminalOf = new Map<string, string>()
  if (s.unitMode === 'terminal') {
    const refundChargeIds = rows
      .map((p) => (p.status === 'refunded' ? metaString(p.gatewayMeta, 'terminalChargeId') : null))
      .filter((x): x is string => !!x)
    const charges = await db.terminalCharge.findMany({
      where: { tenantId, OR: [{ paymentId: { in: rows.map((p) => p.id) } }, ...(refundChargeIds.length ? [{ id: { in: refundChargeIds } }] : [])] },
      select: { id: true, paymentId: true, terminalId: true },
    })
    terminalOf = new Map<string, string>()
    const byChargeId = new Map(charges.map((c) => [c.id, c.terminalId]))
    for (const c of charges) if (c.paymentId) terminalOf.set(c.paymentId, c.terminalId)
    for (const p of rows) {
      const chargeId = p.status === 'refunded' ? metaString(p.gatewayMeta, 'terminalChargeId') : null
      if (chargeId && byChargeId.has(chargeId)) terminalOf.set(p.id, byChargeId.get(chargeId)!)
    }
  }

  for (const p of rows) {
    const unit = s.unitMode === 'brand' ? `brand:${p.order.conceptId}`
      : s.unitMode === 'terminal' ? `terminal:${terminalOf.get(p.id) ?? 'none'}`
        : 'company'
    const day = dayNumOf(p.processedAt ?? p.createdAt)
    if (day < from || day > toN) continue
    const byDay = out.get(unit) ?? new Map<number, number>()
    byDay.set(day, (byDay.get(day) ?? 0) + p.amountCents)
    out.set(unit, byDay)
  }
  return out
}

function metaString(meta: Prisma.JsonValue | null, key: string): string | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const v = (meta as Record<string, unknown>)[key]
  return typeof v === 'string' && v ? v : null
}

/** Settled (unit, day) pairs of the company in a window, indexed by day. */
async function claimedTx(db: Db, tenantId: string, fromN: number, toN: number): Promise<Map<number, string[]>> {
  const rows = await db.cardSettlementDay.findMany({
    where: { tenantId, day: { gte: dayStr(fromN), lte: dayStr(toN) } },
    select: { unit: true, day: true },
  })
  const out = new Map<number, string[]>()
  for (const r of rows) {
    const n = dayNum(r.day)
    out.set(n, [...(out.get(n) ?? []), r.unit])
  }
  return out
}

/** A day of `unit` is taken when it was settled under that unit, or under another unit family (the mode changed since). */
const isTaken = (claimed: Map<number, string[]>, unit: string, n: number): boolean =>
  (claimed.get(n) ?? []).some((u) => u === unit || unitFamily(u) !== unitFamily(unit))

// ─── Fitting ─────────────────────────────────────────────────────────────────

export interface CardRun {
  unit: string
  startN: number
  endN: number
  /** Days of the run with card money (the ones a settlement claims). */
  days: string[]
  grossCents: number
}

export interface CardFit {
  lineId: string
  unit: string
  days: string[]
  dayFrom: string
  dayTo: string
  grossCents: number
  netCents: number
  feeCents: number
}

/** The payout Keenu should send for `gross`: gross − MDR − tax on the MDR. */
export function expectedNetCents(gross: number, s: Pick<CardSettlementSettings, 'mdrBps' | 'feeTaxBps'>): number {
  return gross - Math.round((gross * s.mdrBps * (10_000 + s.feeTaxBps)) / 100_000_000)
}

/** The fee `net` implies on `gross` is within 0..maxFeeBps. */
export function feeInRange(gross: number, net: number, s: Pick<CardSettlementSettings, 'maxFeeBps'>): boolean {
  const fee = gross - net
  return fee >= 0 && fee <= Math.floor((gross * s.maxFeeBps) / 10_000)
}

/** H12's fit rule: |net − expected| ≤ max(PKR 1, gross × tolerance) and the fee in range. */
export function payoutFits(gross: number, net: number, s: CardSettlementSettings): boolean {
  if (gross <= 0 || net <= 0) return false
  if (!feeInRange(gross, net, s)) return false
  const tol = Math.max(100, Math.round((gross * s.toleranceBps) / 10_000))
  return Math.abs(net - expectedNetCents(gross, s)) <= tol
}

/**
 * Every run of unsettled days a payout dated `lineDay` could cover: per unit,
 * ending 1..maxLag days before it, 1..maxLen days long, first and last day
 * with card money, a positive total, no day settled already.
 */
export function candidateRuns(gross: DayGross, claimed: Map<number, string[]>, lineDay: number, startN: number, maxLag: number, maxLen: number): CardRun[] {
  const out: CardRun[] = []
  for (const [unit, byDay] of gross) {
    for (let end = lineDay - 1; end >= lineDay - maxLag; end--) {
      if (!byDay.get(end)) continue
      for (let len = 1; len <= maxLen; len++) {
        const start = end - len + 1
        if (start < startN) break
        if (!byDay.get(start)) continue
        let total = 0
        let taken = false
        const days: string[] = []
        for (let n = start; n <= end; n++) {
          if (isTaken(claimed, unit, n)) { taken = true; break }
          const c = byDay.get(n) ?? 0
          if (c !== 0) days.push(dayStr(n))
          total += c
        }
        if (taken) break // a longer run would include the taken day too
        if (total > 0) out.push({ unit, startN: start, endN: end, days, grossCents: total })
      }
    }
  }
  return out
}

/**
 * The automatic fits of `lines` (credits on the payout bank). A line gets a
 * fit only when exactly ONE run fits it and no day of that run is in any
 * other line's fits; `candidateLineIds` are the lines with at least one fit
 * (the generic matcher leaves them for finance).
 */
export async function findCardPayoutFits(tx: Db, input: {
  tenantId: string
  settings: CardSettlementSettings
  lines: Array<{ id: string; postedDate: Date; amountCents: number }>
}): Promise<{ fits: CardFit[]; candidateLineIds: string[] }> {
  const s = input.settings
  const lines = input.lines.filter((l) => l.amountCents > 0)
  if (!s.enabled || !s.startDay || lines.length === 0) return { fits: [], candidateLineIds: [] }
  const startN = dayNum(s.startDay)
  const maxLag = s.lagDays + 1
  const days = lines.map((l) => dayNumOf(l.postedDate))
  const fromN = Math.min(...days) - maxLag - (s.maxBatchDays - 1)
  const toN = Math.max(...days) - 1
  if (toN < startN) return { fits: [], candidateLineIds: [] }
  const gross = await cardDayGrossTx(tx, input.tenantId, s, fromN, toN)
  if (gross.size === 0) return { fits: [], candidateLineIds: [] }
  const claimed = await claimedTx(tx, input.tenantId, fromN, toN)

  const fitsOf = new Map<string, CardRun[]>()
  const usage = new Map<string, Set<string>>() // `${unit}|${day}` → line ids
  for (const l of lines) {
    const fits = candidateRuns(gross, claimed, dayNumOf(l.postedDate), startN, maxLag, s.maxBatchDays)
      .filter((r) => payoutFits(r.grossCents, l.amountCents, s))
    if (fits.length === 0) continue
    fitsOf.set(l.id, fits)
    for (const r of fits) {
      for (let n = r.startN; n <= r.endN; n++) {
        const k = `${r.unit}|${n}`
        usage.set(k, (usage.get(k) ?? new Set()).add(l.id))
      }
    }
  }

  const out: CardFit[] = []
  for (const l of lines) {
    const fits = fitsOf.get(l.id)
    if (!fits || fits.length !== 1) continue
    const r = fits[0]!
    let alone = true
    for (let n = r.startN; n <= r.endN && alone; n++) if ((usage.get(`${r.unit}|${n}`)?.size ?? 0) !== 1) alone = false
    if (!alone) continue
    out.push({
      lineId: l.id, unit: r.unit, days: r.days, dayFrom: dayStr(r.startN), dayTo: dayStr(r.endN),
      grossCents: r.grossCents, netCents: l.amountCents, feeCents: r.grossCents - l.amountCents,
    })
  }
  return { fits: out, candidateLineIds: [...fitsOf.keys()] }
}

// ─── Posting one settlement ──────────────────────────────────────────────────

export interface SettleInput {
  tenantId: string
  lineId: string
  /** 'company', 'brand:<conceptId>' or 'terminal:<terminalId>' — must be the company's current unit mode. */
  unit: string
  /** The card days (YYYY-MM-DD PKT) this payout covers, consecutive. */
  days: string[]
  status: 'auto' | 'confirmed'
  actorId: string | null
}

/** Lock the company's card-payout claims for the rest of the transaction. */
export async function lockCardSettlementTx(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('card-settlement'))`
}

/**
 * The days a payout claims, validated: consecutive, 1..max, on or after
 * startDay, before the payout's own day, of the company's unit mode, none
 * settled already, a positive total. Returns the days with card money.
 */
export async function claimableDaysTx(tx: Db, input: {
  tenantId: string; settings: CardSettlementSettings; unit: string; days: string[]; lineDay: number; maxDays: number
}): Promise<{ startN: number; endN: number; days: Array<{ day: string; cents: number }>; grossCents: number }> {
  const s = input.settings
  if (unitFamily(input.unit) !== s.unitMode || (s.unitMode === 'company' && input.unit !== 'company') || /^(brand|terminal):$/.test(input.unit)) {
    throw new AppError('CARD_UNIT_INVALID', s.unitMode === 'company'
      ? 'Card payouts are matched for the whole company — leave the unit out'
      : `Card payouts are matched per ${s.unitMode} — name the ${s.unitMode} ('${s.unitMode}:<id>')`, 422)
  }
  const ns = [...new Set(input.days)].map(dayNum)
  if (ns.length === 0 || ns.some((n) => Number.isNaN(n))) throw new AppError('CARD_DAYS_INVALID', 'Give the card days as YYYY-MM-DD', 422)
  ns.sort((a, b) => a - b)
  if (ns.length > input.maxDays) throw new AppError('CARD_DAYS_INVALID', `One payout covers at most ${input.maxDays} days`, 422)
  for (let i = 1; i < ns.length; i++) {
    if (ns[i] !== ns[i - 1]! + 1) throw new AppError('CARD_DAYS_INVALID', 'The card days of one payout must follow each other', 422)
  }
  const startN = ns[0]!
  const endN = ns[ns.length - 1]!
  if (!s.startDay || startN < dayNum(s.startDay)) {
    throw new AppError('DAY_BEFORE_START', `Card payout matching starts on ${s.startDay ?? '—'}; earlier days were cleared by hand`, 422)
  }
  if (endN >= input.lineDay) throw new AppError('DAYS_NOT_BEFORE_PAYOUT', 'A payout settles card days BEFORE its own date', 422)

  const claimed = await claimedTx(tx, input.tenantId, startN, endN)
  const taken = ns.filter((n) => isTaken(claimed, input.unit, n))
  if (taken.length > 0) {
    throw new AppError('DAY_ALREADY_SETTLED', `Card day(s) ${taken.map(dayStr).join(', ')} are already settled by another payout`, 409, { days: taken.map(dayStr) })
  }
  const gross = await cardDayGrossTx(tx, input.tenantId, s, startN, endN)
  const byDay = gross.get(input.unit) ?? new Map<number, number>()
  const days = ns.map((n) => ({ day: dayStr(n), cents: byDay.get(n) ?? 0 })).filter((d) => d.cents !== 0)
  const grossCents = days.reduce((t, d) => t + d.cents, 0)
  if (grossCents <= 0) throw new AppError('NO_CARD_MONEY_ON_DAYS', 'There are no card sales on those days to settle', 422)
  assertMoneyFits(grossCents, 'A card payout\'s gross')
  return { startN, endN, days, grossCents }
}

const unitTag = (unit: string): string => (unit === 'company' ? '' : ` (${unit})`)
const rangeOf = (from: string, to: string): string => (from === to ? from : `${from}–${to}`)

/**
 * Settle one payout line against card days, inside `tx` (see the header).
 * Every refusal is an AppError thrown before anything is written for it —
 * the caller's transaction rolls back.
 */
export async function postCardSettlementTx(tx: Tx, input: SettleInput): Promise<{ settlementId: string; entryId: string }> {
  await lockCardSettlementTx(tx, input.tenantId)
  const s = await cardSettlementSettings(tx, input.tenantId)
  if (!s.enabled || !s.startDay || !s.payoutBankAccountId) {
    throw new AppError('CARD_PAYOUTS_OFF', 'Card payout matching is off for this company (Reconciliation → Card payouts → settings)', 422)
  }
  const line = await tx.bankStatementLine.findFirst({
    where: { id: input.lineId, import: { tenantId: input.tenantId } },
    select: { id: true, postedDate: true, description: true, amountCents: true, matchStatus: true, import: { select: { bankAccountId: true, accountCode: true } } },
  })
  if (!line) throw new NotFoundError('BankStatementLine', input.lineId)
  if (line.matchStatus !== 'unmatched') throw new AppError('LINE_NOT_UNMATCHED', `This statement line is already ${line.matchStatus}`, 409)
  const net = toCents(line.amountCents)
  if (net <= 0) throw new AppError('LINE_NOT_A_CREDIT', 'A card payout is money IN — this line is not a credit', 422)
  if (line.import.bankAccountId !== s.payoutBankAccountId) {
    throw new AppError('NOT_THE_PAYOUT_BANK', 'This line is not on the bank account Keenu pays into (card payout settings)', 422)
  }
  const lineDay = dayNumOf(line.postedDate)
  const claim = await claimableDaysTx(tx, {
    tenantId: input.tenantId, settings: s, unit: input.unit, days: input.days, lineDay,
    maxDays: input.status === 'auto' ? s.maxBatchDays : MAX_CONFIRM_DAYS,
  })
  const gross = claim.grossCents
  const fee = gross - net
  if (!feeInRange(gross, net, s)) {
    throw new AppError(
      'FEE_OUT_OF_RANGE',
      `The payout implies a fee of PKR ${(fee / 100).toFixed(2)} on PKR ${(gross / 100).toFixed(2)} of card sales — outside 0 to ${(s.maxFeeBps / 100).toFixed(2)}%. Check the days.`,
      422, { grossCents: gross, netCents: net, feeCents: fee, maxFeeBps: s.maxFeeBps },
    )
  }
  // An automatic post re-checks its fit: card money may have moved since the import.
  if (input.status === 'auto' && !payoutFits(gross, net, s)) {
    throw new AppError('CARD_PAYOUT_CHANGED', 'The card sales on those days changed since the statement was imported — confirm the payout by hand', 409)
  }
  // The period lock and the accounts, before anything is written (a refusal
  // leaves the line unmatched with its reason — never a 500).
  const lock = await tx.periodLock.findFirst({ where: { tenantId: input.tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  if (lock && line.postedDate <= lock.lockedThrough) {
    throw new AppError('PERIOD_LOCKED', `The payout is dated ${fmtPktDate(line.postedDate)} but the books are closed through ${fmtPktDate(lock.lockedThrough)}`, 422)
  }
  await assertTemplateAccounts(tx, input.tenantId, [ACCT.CARD_RECEIVABLE, ACCT.CARD_FEES])
  const bank = await tx.account.findFirst({ where: { tenantId: input.tenantId, code: line.import.accountCode, isActive: true }, select: { id: true } })
  if (!bank) throw new AppError('ACCOUNT_NOT_FOUND', `The payout bank's chart code ${line.import.accountCode} is not an active account of this company`, 422)

  const dayFrom = dayStr(claim.startN)
  const dayTo = dayStr(claim.endN)
  let settlementId: string
  try {
    const created = await tx.cardSettlement.create({
      data: {
        tenantId: input.tenantId, unit: input.unit, bankAccountId: s.payoutBankAccountId, statementLineId: line.id,
        grossCents: gross, feeCents: fee, feeTaxCents: Math.round((fee * s.feeTaxBps) / (10_000 + s.feeTaxBps)), netCents: net,
        dayFrom, dayTo, status: input.status, createdById: input.actorId,
        days: { create: claim.days.map((d) => ({ tenantId: input.tenantId, unit: input.unit, day: d.day, grossCents: d.cents })) },
      },
      select: { id: true },
    })
    settlementId = created.id
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new AppError('DAY_ALREADY_SETTLED', 'Those card days (or this line) were settled meanwhile — refresh', 409)
    throw err
  }

  const prior = await tx.journalEntry.count({ where: { tenantId: input.tenantId, reference: { startsWith: `${CARD_SETTLEMENT_SOURCE}:${line.id}` } } })
  const sourceId = prior === 0 ? line.id : `${line.id}@${prior + 1}`
  const conceptId = input.unit.startsWith('brand:') ? input.unit.slice('brand:'.length) : null
  const memo = `CARD PAYOUT ${rangeOf(dayFrom, dayTo)}${unitTag(input.unit)}`
  const posted = await postCardPayoutSplitTx(tx, {
    tenantId: input.tenantId, lineId: line.id, grossCents: gross, feeCents: fee, netCents: net,
    bankCode: line.import.accountCode, sourceType: CARD_SETTLEMENT_SOURCE, sourceId, memo,
    description: `Card payout ${rangeOf(dayFrom, dayTo)}${unitTag(input.unit)}: card sales PKR ${(gross / 100).toFixed(2)}, fee PKR ${(fee / 100).toFixed(2)}, received PKR ${(net / 100).toFixed(2)}`,
    postedBy: input.actorId ?? 'system', conceptId,
  })
  const claimed = await tx.bankStatementLine.updateMany({
    where: { id: line.id, matchStatus: 'unmatched' },
    data: { matchStatus: 'matched', matchedJournalLineId: posted.bankLineId, notes: memo.slice(0, 500) },
  })
  if (claimed.count === 0) throw new AppError('LINE_NOT_UNMATCHED', 'The line was cleared meanwhile — refresh', 409)
  await tx.cardSettlement.update({ where: { id: settlementId }, data: { journalEntryId: posted.entryId } })
  await tx.exceptionFlag.updateMany({
    where: { tenantId: input.tenantId, kind: CARD_PAYOUT_FLAG, entityType: 'BankStatementLine', entityId: line.id, status: { in: ['open', 'acknowledged'] } },
    data: { status: 'resolved', resolvedAt: new Date(), resolution: `Settled card days ${rangeOf(dayFrom, dayTo)}` },
  })
  return { settlementId, entryId: posted.entryId }
}

/** postCardSettlementTx in its own transaction. */
export async function settleCardPayout(input: SettleInput, db: typeof defaultPrisma = defaultPrisma): Promise<{ settlementId: string; entryId: string }> {
  return db.$transaction((tx) => postCardSettlementTx(tx, input), TX_OPTS)
}

/**
 * Post the automatic fits of a pass, each in its own transaction. A refusal
 * writes the reason on the (still unmatched) line and raises one open
 * card_payout_unmatched flag for it. Returns how many posted.
 */
export async function postCardFits(tenantId: string, fits: CardFit[], db: typeof defaultPrisma = defaultPrisma): Promise<{ posted: number; refused: Array<{ lineId: string; code: string; reason: string }> }> {
  let posted = 0
  const refused: Array<{ lineId: string; code: string; reason: string }> = []
  for (const f of fits) {
    try {
      await settleCardPayout({ tenantId, lineId: f.lineId, unit: f.unit, days: f.days, status: 'auto', actorId: null }, db)
      posted++
    } catch (err) {
      const code = err instanceof AppError ? err.code : 'INTERNAL'
      const reason = (err as Error).message
      refused.push({ lineId: f.lineId, code, reason })
      await markRefused(db, tenantId, f, code, reason)
    }
  }
  return { posted, refused }
}

async function markRefused(db: typeof defaultPrisma, tenantId: string, f: CardFit, code: string, reason: string): Promise<void> {
  try {
    await db.bankStatementLine.updateMany({
      where: { id: f.lineId, matchStatus: 'unmatched' },
      data: { notes: `Card payout not booked (${code}): ${reason}`.slice(0, 500) },
    })
    const open = await db.exceptionFlag.findFirst({
      where: { tenantId, kind: CARD_PAYOUT_FLAG, entityType: 'BankStatementLine', entityId: f.lineId, status: { in: ['open', 'acknowledged'] } },
      select: { id: true },
    })
    if (open) return
    await flagException({
      tenantId, kind: CARD_PAYOUT_FLAG, severity: 'medium',
      title: `Card payout of PKR ${(f.netCents / 100).toFixed(2)} not booked`,
      description: `A bank credit fits the card sales of ${rangeOf(f.dayFrom, f.dayTo)}${unitTag(f.unit)} (PKR ${(f.grossCents / 100).toFixed(2)}) but could not be booked: ${reason.slice(0, 300)}. `
        + 'Fix the cause, then Reconciliation → Card payouts → Re-run matching (or confirm the line by hand).',
      entityType: 'BankStatementLine', entityId: f.lineId, amountCents: f.netCents,
      metadata: { code, reason, unit: f.unit, days: f.days, grossCents: f.grossCents, netCents: f.netCents },
    })
  } catch (err) {
    console.warn(`[card-payouts] could not record the refusal of line ${f.lineId}:`, (err as Error).message)
  }
}

/**
 * Re-run the card pass over the company's unmatched credits on the payout
 * bank of the last 60 days (POST /card-payouts/rematch). Raast lines (naming
 * a receipt's reference, or equal to a provisional receipt — S3) are left out.
 */
export async function rematchCardPayouts(input: { tenantId: string; db?: typeof defaultPrisma }): Promise<{ matched: number; candidates: number; refused: Array<{ lineId: string; code: string; reason: string }> }> {
  const db = input.db ?? defaultPrisma
  const s = await cardSettlementSettings(db, input.tenantId)
  if (!s.enabled || !s.startDay || !s.payoutBankAccountId) {
    throw new AppError('CARD_PAYOUTS_OFF', 'Card payout matching is off for this company (Reconciliation → Card payouts → settings)', 422)
  }
  const since = new Date(Date.now() - 60 * DAY_MS)
  const rows = await db.bankStatementLine.findMany({
    where: { matchStatus: 'unmatched', amountCents: { gt: 0 }, postedDate: { gte: since }, import: { tenantId: input.tenantId, bankAccountId: s.payoutBankAccountId } },
    select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
    orderBy: { postedDate: 'asc' },
  })
  const lines = rows.map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))
  if (lines.length === 0) return { matched: 0, candidates: 0, refused: [] }
  const { raastLinesToLeaveTx } = await import('./raast.js')
  const skip = await raastLinesToLeaveTx(db, { tenantId: input.tenantId, bankAccountId: s.payoutBankAccountId, lines })
  const { fits, candidateLineIds } = await findCardPayoutFits(db, { tenantId: input.tenantId, settings: s, lines: lines.filter((l) => !skip.has(l.id)) })
  const res = await postCardFits(input.tenantId, fits, db)
  return { matched: res.posted, candidates: candidateLineIds.length, refused: res.refused }
}

// ─── Suggestions for one line ────────────────────────────────────────────────

export interface CardSuggestion {
  unit: string
  dayFrom: string
  dayTo: string
  days: string[]
  grossCents: number
  expectedNetCents: number
  impliedFeeCents: number
  impliedFeeBps: number
  fits: boolean
}

/**
 * Runs of unsettled card days a payout line could be (GET
 * /lines/:lineId/suggestions): a little wider than the automatic window
 * (2 more days of lag, up to MAX_CONFIRM_DAYS long), only runs whose implied
 * fee is in range, best first. Finance confirms one with POST /confirm.
 */
export async function cardSuggestionsForLine(db: Db, tenantId: string, line: { postedDate: Date; amountCents: number }): Promise<{ settings: CardSettlementSettings; suggestions: CardSuggestion[] }> {
  const s = await cardSettlementSettings(db, tenantId)
  if (!s.enabled || !s.startDay || line.amountCents <= 0) return { settings: s, suggestions: [] }
  const lineDay = dayNumOf(line.postedDate)
  const maxLag = s.lagDays + 3
  const maxLen = Math.max(s.maxBatchDays, 3)
  const fromN = lineDay - maxLag - (maxLen - 1)
  const toN = lineDay - 1
  const gross = await cardDayGrossTx(db, tenantId, s, fromN, toN)
  const claimed = await claimedTx(db, tenantId, fromN, toN)
  const runs = candidateRuns(gross, claimed, lineDay, dayNum(s.startDay), maxLag, maxLen)
    .filter((r) => feeInRange(r.grossCents, line.amountCents, s))
  const out = runs.map((r): CardSuggestion => {
    const fee = r.grossCents - line.amountCents
    return {
      unit: r.unit, dayFrom: dayStr(r.startN), dayTo: dayStr(r.endN), days: r.days, grossCents: r.grossCents,
      expectedNetCents: expectedNetCents(r.grossCents, s), impliedFeeCents: fee,
      impliedFeeBps: r.grossCents > 0 ? Math.round((fee * 10_000) / r.grossCents) : 0,
      fits: payoutFits(r.grossCents, line.amountCents, s),
    }
  })
  out.sort((a, b) => Number(b.fits) - Number(a.fits)
    || Math.abs(line.amountCents - a.expectedNetCents) - Math.abs(line.amountCents - b.expectedNetCents))
  return { settings: s, suggestions: out.slice(0, 30) }
}

// ─── Undo ────────────────────────────────────────────────────────────────────

/**
 * APPROVERS: reverse a settlement's entry (dated today), delete it (its days
 * are free again) and put its statement line back to unmatched. A manual
 * BOOKS-11 claim ('manual_adjust') is undone the same way.
 */
export async function undoCardSettlement(input: { settlementId: string; tenantId: string; actorId: string; reason: string; db?: typeof defaultPrisma }): Promise<{ lineId: string; reversalEntryId: string | null; days: string[] }> {
  const db = input.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    await lockCardSettlementTx(tx, input.tenantId)
    const st = await tx.cardSettlement.findFirst({
      where: { id: input.settlementId, tenantId: input.tenantId },
      include: { days: { select: { day: true } } },
    })
    if (!st) throw new NotFoundError('CardSettlement', input.settlementId)
    let reversalEntryId: string | null = null
    if (st.journalEntryId) {
      const je = await tx.journalEntry.findFirst({ where: { id: st.journalEntryId, tenantId: st.tenantId }, select: { reference: true } })
      const ref = je?.reference ?? ''
      const cut = ref.indexOf(':')
      if (cut <= 0) throw new AppError('CARD_SETTLEMENT_ENTRY_MISSING', 'This payout\'s journal entry was not found in its company\'s ledger — ask the CEO to check it', 409)
      const rev = await reverseJournalEntry(st.tenantId, ref.slice(0, cut), ref.slice(cut + 1), `Card payout undone: ${input.reason}`.slice(0, 300), { tx, postedBy: input.actorId })
      reversalEntryId = rev.entryId
    }
    await tx.cardSettlement.delete({ where: { id: st.id } })
    await tx.bankStatementLine.updateMany({
      where: { id: st.statementLineId, matchStatus: { in: ['matched', 'adjusted'] } },
      data: { matchStatus: 'unmatched', matchedJournalLineId: null, notes: null },
    })
    return { lineId: st.statementLineId, reversalEntryId, days: st.days.map((d) => d.day).sort() }
  }, TX_OPTS)
}

// ─── Manual BOOKS-11 claims ──────────────────────────────────────────────────

/**
 * A manual split (service.ts adjustStatementLine) that credits 1030 on the
 * payout bank while matching is on claims its card days here, in the split's
 * own transaction: CardSettlement status 'manual_adjust'. gross = the 1030
 * credit, fee = the 6080 debit, net = the line. No fee range: the CEO / a
 * co-owner decided the split.
 */
export async function claimManualCardDaysTx(tx: Tx, input: {
  tenantId: string; settings: CardSettlementSettings; lineId: string; lineDate: Date; bankAccountId: string
  unit: string; days: string[]; grossCents: number; feeCents: number; netCents: number; actorId: string
}): Promise<{ settlementId: string }> {
  await lockCardSettlementTx(tx, input.tenantId)
  const claim = await claimableDaysTx(tx, {
    tenantId: input.tenantId, settings: input.settings, unit: input.unit, days: input.days, lineDay: dayNumOf(input.lineDate), maxDays: MAX_CONFIRM_DAYS,
  })
  try {
    const st = await tx.cardSettlement.create({
      data: {
        tenantId: input.tenantId, unit: input.unit, bankAccountId: input.bankAccountId, statementLineId: input.lineId,
        grossCents: input.grossCents, feeCents: input.feeCents,
        feeTaxCents: Math.round((input.feeCents * input.settings.feeTaxBps) / (10_000 + input.settings.feeTaxBps)),
        netCents: input.netCents, dayFrom: dayStr(claim.startN), dayTo: dayStr(claim.endN), status: 'manual_adjust', createdById: input.actorId,
        days: { create: claim.days.map((d) => ({ tenantId: input.tenantId, unit: input.unit, day: d.day, grossCents: d.cents })) },
      },
      select: { id: true },
    })
    return { settlementId: st.id }
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') throw new AppError('DAY_ALREADY_SETTLED', 'Those card days (or this line) were settled meanwhile — refresh', 409)
    throw err
  }
}

// ─── Unsettled days (the list, the period close) ─────────────────────────────

export interface UnsettledDay { unit: string; day: string; cents: number }

/** Card days of the company with money and no payout yet, startDay..throughN (newest first). */
export async function unsettledCardDays(db: Db, tenantId: string, s: CardSettlementSettings, throughN: number, fromN?: number): Promise<UnsettledDay[]> {
  if (!s.enabled || !s.startDay) return []
  const startN = Math.max(dayNum(s.startDay), fromN ?? -Infinity)
  if (throughN < startN) return []
  const gross = await cardDayGrossTx(db, tenantId, s, startN, throughN)
  if (gross.size === 0) return []
  const claimed = await claimedTx(db, tenantId, startN, throughN)
  const out: UnsettledDay[] = []
  for (const [unit, byDay] of gross) {
    for (const [n, cents] of byDay) {
      if (cents === 0 || isTaken(claimed, unit, n)) continue
      out.push({ unit, day: dayStr(n), cents })
    }
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.unit.localeCompare(b.unit)))
}

/**
 * Period close (H12): card days on or before lockedThrough − (lagDays + 3)
 * with money and no payout, when matching is on. `days` are the distinct PKT
 * days; `count` is (unit, day) pairs.
 */
export async function unsettledCardDaysThrough(db: Db, tenantId: string, lockedThrough: Date): Promise<{ count: number; cents: number; days: string[] }> {
  const s = await cardSettlementSettings(db, tenantId)
  if (!s.enabled || !s.startDay) return { count: 0, cents: 0, days: [] }
  const cutoff = dayNumOf(lockedThrough) - (s.lagDays + 3)
  const rows = await unsettledCardDays(db, tenantId, s, cutoff)
  return {
    count: rows.length,
    cents: rows.reduce((t, r) => t + r.cents, 0),
    days: [...new Set(rows.map((r) => r.day))].sort(),
  }
}

const cardUnsettledCheck: CloseCheck = {
  key: 'card_unsettled',
  severity: 'block',
  overridable: true,
  async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
    const r = await unsettledCardDaysThrough(ctx.db, ctx.tenantId, ctx.newLock)
    if (r.count === 0) return null
    const first = r.days[0]!
    const last = r.days[r.days.length - 1]!
    return {
      key: 'card_unsettled',
      severity: 'block',
      title: 'Card sales with no bank payout',
      detail: `${r.count} day${r.count === 1 ? '' : 's'} of card sales (PKR ${(r.cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 2 })}, ${rangeOf(first, last)}) `
        + 'still sit in 1030 with no Keenu payout matched. Import the payout bank\'s statement and confirm the payouts on Reconciliation → Card payouts.',
      count: r.count,
      cents: r.cents,
      link: '/reconciliation?tab=card-payouts',
      fix: { method: 'POST', path: '/reconciliation/card-payouts/rematch', label: 'Re-run card payout matching' },
      overridable: true,
    }
  },
}

/** The card-payout items of the period-close checklist (accounting/closeChecks.ts lists them). */
export const cardPayoutCloseChecks: CloseCheck[] = [cardUnsettledCheck]

// ─── The statement-line chip ─────────────────────────────────────────────────

export interface CardSettlementChip { id: string; dayFrom: string; dayTo: string; feeCents: number; grossCents: number; status: string; unit: string }

/** The card settlement of each statement line that has one (the bank-lines GET's chip). */
export async function cardSettlementChips(db: Db, lineIds: string[]): Promise<Map<string, CardSettlementChip>> {
  if (lineIds.length === 0) return new Map()
  const rows = await db.cardSettlement.findMany({
    where: { statementLineId: { in: lineIds } },
    select: { id: true, statementLineId: true, dayFrom: true, dayTo: true, feeCents: true, grossCents: true, status: true, unit: true },
  })
  return new Map(rows.map((r) => [r.statementLineId, {
    id: r.id, dayFrom: r.dayFrom, dayTo: r.dayTo, feeCents: toCents(r.feeCents), grossCents: toCents(r.grossCents), status: r.status, unit: r.unit,
  }]))
}
