// Inter-company transfers (H30) — one movement between TWO companies' books,
// posted in both or neither.
//
//   DEBTOR   (IntercompanyTransfer.tenantId) owes or pays: its 'Due to <creditor>' moves.
//   CREDITOR (counterpartyTenantId): its 'Due from <debtor>' moves.
//
//   charge      debtor:   Dr debtorAccountCode (per brand when conceptSplit) / Cr Due to creditor
//               creditor: Dr Due from debtor / Cr creditorAccountCode
//   settlement  debtor:   Dr Due to creditor / Cr its bank or cash (moneyAccountCode)
//               creditor: Dr its bank or cash / Cr Due from debtor
//               Methods (owner, 2026-10-14): bank transfer, bank deposit, cheque,
//               cash (the old 'bank' = bank transfer; stored rows keep it).
//               'bank_deposit' = the paying company's CASH paid into the
//               receiving company's bank: debtor Cr 1010, creditor Dr its named
//               bank — the paying company names no bank (422). The payment
//               reference # (bankReference) is required for every method when
//               the settlement is created, never re-checked at approval; it is
//               in the entries' description and both money lines' memos.
//   netting     debtor:   Dr Due to creditor / Cr Due from creditor
//               creditor: Dr Due to debtor   / Cr Due from debtor
//
// Both entries carry the SAME key 'ic.transfer:<id>' (sourceType 'ic.transfer'
// — the only prefix journal.ts lets onto a pair account) and are posted in ONE
// serviceClient transaction together with the status claim, so a refusal in
// either book (a closed month, a missing account) rolls back everything. The
// serviceClient is deliberate: in single-company view RLS would hide the other
// company's chart. Reversal: 'ic.transfer.reversal:<id>' in both books.
//
// Sources: 'manual' (finance prepares → the CEO approves, or the CEO posts at
// once), 'fleet' (the shared-fleet monthly charge, fleet.ts), 'cod' (a fleet
// rider's unpaid cash-on-delivery, accounting/codPosting.ts) and 'ho_recharge'
// (one head-office recharge run line, modules/headOffices/runs.ts) — the last
// three are SYSTEM transfers posted by postSystemTransferTx, idempotent on
// sourceRef, and reversed only from where they were booked.
//
// Head-office pairs (D1): a transfer between a head office and a company it
// serves (settlement, or a 'charge' used as a paired adjustment) is an
// ordinary 'manual' transfer. A member of the head office may prepare it
// (lib/companyPairs.ts assertPairPreparer); the CEO or a Finance delegate
// covering the company approves it (lib/approvalRights.ts — the route proves
// the grant and passes it in); a non-admin never approves what they prepared.
// A charge on a head-office pair may not name the head office's recharge
// account or the link's "Head office charges" account (A9).

import { Prisma, type IntercompanyTransfer } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'
import { moneyAccountCode, assertPaymentReference, receiptText } from '../../lib/bankAccounts.js'
import { isMemberOfBoth } from '../../lib/companyPairs.js'
import type { ApprovalGrant } from '../../lib/approvalRights.js'
import { ACCT, postJournalEntry, reverseJournalEntry, withLateNote, type JournalLineInput } from '../accounting/journal.js'
import { fmtPktDate, parsePktStartOfDay, pktToday } from '../accounting/dates.js'
import { ensurePairAccounts, lockPair, sideBalances, type Db, type Tx } from './accounts.js'

export type { Tx } from './accounts.js'

/** The key of both books' entries: 'ic.transfer:<transferId>'. */
export const IC_TRANSFER_SOURCE = 'ic.transfer'
/** The reversal's key (reverseJournalEntry appends '.reversal'). */
export const IC_TRANSFER_REVERSAL_SOURCE = `${IC_TRANSFER_SOURCE}.reversal`

export const TRANSFER_KINDS = ['charge', 'settlement', 'netting'] as const
export type TransferKind = (typeof TRANSFER_KINDS)[number]
export const SYSTEM_SOURCES = ['fleet', 'cod', 'ho_recharge'] as const
export type SystemSource = (typeof SYSTEM_SOURCES)[number]
/** How a settlement was paid (receipt methods without card — lib/bankAccounts.ts RECEIPT_METHODS). */
export const SETTLEMENT_METHODS = ['bank_transfer', 'bank_deposit', 'cheque', 'cash'] as const
export type SettlementMethod = (typeof SETTLEMENT_METHODS)[number]

/** A settlement method as sent: the old 'bank' (before 2026-10-14) is a bank transfer. */
export function normalizeSettlementMethod(m: string | null | undefined): SettlementMethod | null {
  if (m === null || m === undefined || m === '') return null
  const v = m === 'bank' ? 'bank_transfer' : m
  if (!(SETTLEMENT_METHODS as readonly string[]).includes(v)) {
    throw new AppError('BAD_PAYMENT_METHOD', `Unknown settlement method "${m}" — bank transfer, bank deposit, cheque or cash`, 422)
  }
  return v as SettlementMethod
}

/**
 * The method each side's money account is resolved with. A bank deposit is
 * the payer's cash going into the payee's bank: cash for the paying company,
 * the named bank for the receiving one. Every other method is the same on
 * both sides (stored rows may still say 'bank').
 */
export function settlementSideMethods(method: string | null): { debtor: string | null; creditor: string | null } {
  if (method === 'bank_deposit') return { debtor: 'cash', creditor: 'bank_deposit' }
  return { debtor: method, creditor: method }
}

export type TransferRow = IntercompanyTransfer

/** Who is acting (req.staffUser, or a system actor). */
export interface TransferActor {
  id: string
  role: string
  tenantId: string | null
  memberTenantIds: string[]
}

export interface ConceptShare { conceptId: string; cents: number }

const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const

// ─── Dates ───────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** A transfer date (YYYY-MM-DD, Pakistan) as the instant both entries are dated: midday that day. Never in the future. */
export function transferDateOf(iso: string): Date {
  if (!ISO_DATE.test(iso)) throw new AppError('INVALID_DATE', 'Give the date as YYYY-MM-DD', 422)
  const at = new Date(`${iso}T12:00:00+05:00`)
  if (Number.isNaN(at.getTime())) throw new AppError('INVALID_DATE', 'Give the date as YYYY-MM-DD', 422)
  if (at.getTime() > pktToday().to.getTime()) throw new AppError('DATE_IN_FUTURE', 'The transfer date is in the future', 422)
  return at
}

/** A company's latest close (inclusive PKT end of day), or null. */
export async function latestLock(db: Db, tenantId: string): Promise<Date | null> {
  const lock = await db.periodLock.findFirst({
    where: { tenantId },
    orderBy: { lockedThrough: 'desc' },
    select: { lockedThrough: true },
  })
  return lock?.lockedThrough ?? null
}

async function namesOf(db: Db, ids: string[]): Promise<Map<string, string>> {
  const rows = await db.tenant.findMany({ where: { id: { in: Array.from(new Set(ids)) } }, select: { id: true, name: true } })
  return new Map(rows.map((t) => [t.id, t.name]))
}

/** 422 PERIOD_LOCKED naming the company whose books are closed on `at` (user-entered dates are never moved). */
export async function assertOpenInBoth(db: Db, tenantIds: string[], at: Date): Promise<void> {
  const names = await namesOf(db, tenantIds)
  for (const t of tenantIds) {
    const lock = await latestLock(db, t)
    if (lock && at <= lock) {
      throw new AppError(
        'PERIOD_LOCKED',
        `${names.get(t) ?? 'One company'}'s books are closed through ${fmtPktDate(lock)} — the transfer cannot be dated ${fmtPktDate(at)}. Date it after the close.`,
        422,
        { tenantId: t, lockedThrough: fmtPktDate(lock) },
      )
    }
  }
}

/**
 * Where a SYSTEM posting whose natural date is `natural` lands when it must
 * post in several companies' books at once (owner decision 6, for two books):
 *   • its own date while it is open in every company — no note;
 *   • else the FIRST DAY OPEN IN ALL of them (the day after the latest close;
 *     midday, or now when that is earlier) with a note naming the original
 *     date (`label` says what it was, e.g. 'the September 2026 fleet charge');
 *   • `lockedThroughToday` when one company is closed even through now.
 */
export async function commonOpenPlacement(
  db: Db, tenantIds: string[], natural: Date, label: string,
): Promise<{ entryDate: Date; memoNote?: string } | { lockedThroughToday: true; tenantId: string; lockedThrough: Date }> {
  let latest: { tenantId: string; at: Date } | null = null
  for (const t of tenantIds) {
    const lock = await latestLock(db, t)
    if (lock && (!latest || lock > latest.at)) latest = { tenantId: t, at: lock }
  }
  if (!latest || natural > latest.at) return { entryDate: natural }
  const now = new Date()
  if (now <= latest.at) return { lockedThroughToday: true, tenantId: latest.tenantId, lockedThrough: latest.at }
  const firstOpenDay = fmtPktDate(new Date(latest.at.getTime() + 1))
  const midday = new Date(`${firstOpenDay}T12:00:00+05:00`)
  const start = parsePktStartOfDay(firstOpenDay)
  const entryDate = midday <= now ? midday : (now > start ? now : start)
  return {
    entryDate,
    memoNote: `${label} dated ${fmtPktDate(natural)}, posted late on the first day open in both companies (books closed through ${fmtPktDate(latest.at)})`,
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** An account a transfer may name in one company's chart: active, ordinary (never a controlled account). */
async function assertPostableAccount(db: Db, tenantId: string, code: string, companyName: string, side: string): Promise<void> {
  const acc = await db.account.findFirst({
    where: { tenantId, code },
    select: { code: true, name: true, isActive: true, controlledBy: true },
  })
  if (!acc || !acc.isActive) {
    throw new AppError('ACCOUNT_INVALID', `Account ${code} is not an active account in ${companyName}'s chart (${side})`, 422)
  }
  if (acc.controlledBy) {
    throw new AppError(
      'ACCOUNT_CONTROLLED',
      `Account ${code} '${acc.name}' in ${companyName}'s chart is kept by ${acc.controlledBy === 'intercompany' ? 'the inter-company module' : acc.controlledBy === 'fixed_asset' ? 'the fixed-asset register' : 'another module'} — pick an ordinary account (${side})`,
      422,
    )
  }
}

// ─── Head-office pairs (D1) ──────────────────────────────────────────────────

/** Which of a and b are head offices (kind head_office). */
async function headOfficesAmong(db: Db, ids: string[]): Promise<string[]> {
  const rows = await db.tenant.findMany({ where: { id: { in: ids }, kind: 'head_office' }, select: { id: true } })
  return rows.map((r) => r.id)
}

/**
 * A transfer with a head office on one side is only between that head office
 * and a company it serves or served (a link, live or ended — spec §4.6):
 * 422 HEAD_OFFICE_NOT_LINKED otherwise. Two head offices never transfer.
 */
async function assertHeadOfficePairLinked(db: Db, D: string, C: string, names: Map<string, string>): Promise<void> {
  const hos = await headOfficesAmong(db, [D, C])
  if (hos.length === 0) return
  if (hos.length === 2) {
    throw new AppError('HEAD_OFFICE_NOT_LINKED', 'Two head offices do not transfer to each other — a head office transfers only with a company it serves', 422)
  }
  const ho = hos[0]!
  const company = ho === D ? C : D
  const link = await db.headOfficeLink.findFirst({ where: { tenantId: ho, companyTenantId: company }, select: { id: true } })
  if (!link) {
    throw new AppError(
      'HEAD_OFFICE_NOT_LINKED',
      `${names.get(company) ?? 'That company'} has never been linked to ${names.get(ho) ?? 'this head office'} — link it first (CEO → Head offices)`,
      422,
    )
  }
}

/**
 * A9: on a head-office pair, a charge (the paired adjustment) may not name
 * the head office's RECHARGE account (HeadOfficeBooks.rechargeAccountId, else
 * the template 6990) in the head office's chart, nor any link's "Head office
 * charges" account in the company's chart — the recharge run owns them, and a
 * transfer line on them would feed back into the pool. 422 COUNTER_ACCOUNT_INVALID.
 */
async function assertHeadOfficeCounters(
  db: Db, D: string, C: string, codeOf: Record<string, string>, names: Map<string, string>,
): Promise<void> {
  const hos = await headOfficesAmong(db, [D, C])
  if (hos.length !== 1) return
  const ho = hos[0]!
  const company = ho === D ? C : D
  const [books, links] = await Promise.all([
    db.headOfficeBooks.findUnique({ where: { tenantId: ho }, select: { rechargeAccount: { select: { code: true, tenantId: true } } } }),
    db.headOfficeLink.findMany({ where: { tenantId: ho, companyTenantId: company }, select: { charges: { select: { code: true, tenantId: true } } } }),
  ])
  const rechargeCode = books?.rechargeAccount && books.rechargeAccount.tenantId === ho ? books.rechargeAccount.code : ACCT.GROUP_RECHARGES // headOffices/accounts.ts HO_RECHARGE_CODE (not imported: books.ts → fleet.ts → here)
  if (codeOf[ho] === rechargeCode) {
    throw new AppError(
      'COUNTER_ACCOUNT_INVALID',
      `Account ${rechargeCode} is ${names.get(ho) ?? 'the head office'}'s recharge account — only the monthly recharge run posts there. Pick another account.`,
      422,
    )
  }
  const charges = new Set(links.map((l) => l.charges).filter((a): a is { code: string; tenantId: string | null } => !!a && a.tenantId === company).map((a) => a.code))
  if (codeOf[company] && charges.has(codeOf[company]!)) {
    throw new AppError(
      'COUNTER_ACCOUNT_INVALID',
      `Account ${codeOf[company]} is ${names.get(company) ?? 'the company'}'s "Head office charges" account — only the monthly recharge run posts there. Pick another account.`,
      422,
    )
  }
}

/** Brands on the debtor's lines must be the debtor company's, and the shares must add up to the amount. */
async function assertConceptSplit(db: Db, debtorTenantId: string, split: ConceptShare[] | null | undefined, amountCents: number): Promise<ConceptShare[] | null> {
  if (!split || split.length === 0) return null
  let total = 0
  for (const s of split) {
    if (!Number.isInteger(s.cents) || s.cents <= 0) throw new AppError('SPLIT_INVALID', 'Each brand share must be a positive amount in paisa', 422)
    total += s.cents
  }
  if (total !== amountCents) {
    throw new AppError('SPLIT_MISMATCH', `The brand shares add up to ${total} paisa, not the transfer's ${amountCents}`, 422)
  }
  const ids = Array.from(new Set(split.map((s) => s.conceptId)))
  const found = await db.concept.count({ where: { id: { in: ids }, tenantId: debtorTenantId } })
  if (found !== ids.length) {
    throw new AppError('CONCEPT_NOT_IN_DEBTOR', "Every brand on the charge must belong to the company being charged", 422)
  }
  return split.map((s) => ({ conceptId: s.conceptId, cents: s.cents }))
}

/** The split as the JSON column stores it. */
function splitJson(split: ConceptShare[] | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!split) return Prisma.DbNull
  return split.map((s) => ({ conceptId: s.conceptId, cents: s.cents }))
}

function splitOf(v: Prisma.JsonValue | null): ConceptShare[] | null {
  if (!Array.isArray(v)) return null
  const out: ConceptShare[] = []
  for (const x of v) {
    if (x && typeof x === 'object' && !Array.isArray(x) && typeof x['conceptId'] === 'string' && typeof x['cents'] === 'number') {
      out.push({ conceptId: x['conceptId'], cents: x['cents'] })
    }
  }
  return out.length > 0 ? out : null
}

// ─── Balance limits ──────────────────────────────────────────────────────────

/** What `from` owes `to` at `asOf`, the smaller of the two books' figures (they agree unless something went wrong). */
async function owes(db: Db, from: string, to: string, asOf?: Date): Promise<number> {
  const [f, t] = await Promise.all([sideBalances(db, from, to, asOf), sideBalances(db, to, from, asOf)])
  return Math.max(0, Math.min(f.dueTo, t.dueFrom))
}

/** Settlements of from→to and nettings of the pair still waiting for the CEO (they will reduce what from owes to). */
async function pendingOut(db: Db, from: string, to: string, excludeId?: string): Promise<number> {
  const rows = await db.intercompanyTransfer.findMany({
    where: {
      status: 'submitted',
      ...(excludeId && { id: { not: excludeId } }),
      OR: [
        { kind: 'settlement', tenantId: from, counterpartyTenantId: to },
        { kind: 'netting', tenantId: from, counterpartyTenantId: to },
        { kind: 'netting', tenantId: to, counterpartyTenantId: from },
      ],
    },
    select: { amountCents: true },
  })
  return rows.reduce((s, r) => s + toCents(r.amountCents), 0)
}

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * A settlement may not pay more than the debtor owes the creditor, and a
 * netting may not offset more than the smaller direction — on the transfer's
 * date AND today (a later posting can lower it), net of transfers still
 * waiting when `includePending` (at submit; the approval re-checks the books).
 */
async function assertWithinBalance(
  db: Db,
  t: { id?: string; kind: string; tenantId: string; counterpartyTenantId: string; amountCents: number; entryDate: Date },
  includePending: boolean,
): Promise<void> {
  if (t.kind === 'charge') return
  const D = t.tenantId
  const C = t.counterpartyTenantId
  if (t.kind === 'settlement') {
    const owed = Math.min(await owes(db, D, C, t.entryDate), await owes(db, D, C))
    const available = owed - (includePending ? await pendingOut(db, D, C, t.id) : 0)
    if (t.amountCents > available) {
      throw new AppError(
        'SETTLEMENT_OVER_BALANCE',
        `The paying company owes ${pkr(Math.max(0, available))}${includePending ? ' (after settlements still waiting for approval)' : ''} — a settlement cannot pay more than that`,
        422,
        { availableCents: Math.max(0, available) },
      )
    }
    return
  }
  const dc = Math.min(await owes(db, D, C, t.entryDate), await owes(db, D, C)) - (includePending ? await pendingOut(db, D, C, t.id) : 0)
  const cd = Math.min(await owes(db, C, D, t.entryDate), await owes(db, C, D)) - (includePending ? await pendingOut(db, C, D, t.id) : 0)
  const available = Math.min(dc, cd)
  if (t.amountCents > available) {
    throw new AppError(
      'NETTING_OVER_BALANCE',
      `Netting offsets what each company owes the other — at most ${pkr(Math.max(0, available))}, the smaller of the two`,
      422,
      { availableCents: Math.max(0, available) },
    )
  }
}

// ─── Posting both books ──────────────────────────────────────────────────────

/** Both books' lines of a transfer (the codes are each company's own). */
async function linesOf(tx: Tx, t: TransferRow, names: Map<string, string>): Promise<{ debtor: JournalLineInput[]; creditor: JournalLineInput[] }> {
  const D = t.tenantId
  const C = t.counterpartyTenantId
  const amount = toCents(t.amountCents)
  const pair = await ensurePairAccounts(tx, D, C)
  const dName = names.get(D) ?? 'debtor'
  const cName = names.get(C) ?? 'creditor'
  const memo = t.memo.slice(0, 200)

  if (t.kind === 'charge') {
    if (!t.debtorAccountCode || !t.creditorAccountCode) throw new AppError('ACCOUNT_INVALID', 'A charge names an account in each company', 422)
    const split = splitOf(t.conceptSplit)
    const debtorDr: JournalLineInput[] = split
      ? split.map((s) => ({ accountCode: t.debtorAccountCode!, type: 'debit' as const, amountCents: s.cents, memo: `${memo} (charged by ${cName})`, conceptId: s.conceptId }))
      : [{ accountCode: t.debtorAccountCode, type: 'debit', amountCents: amount, memo: `${memo} (charged by ${cName})` }]
    return {
      debtor: [...debtorDr, { accountCode: pair.aDueTo, type: 'credit', amountCents: amount, memo: `Due to ${cName}: ${memo}` }],
      // No brand on the creditor's lines: the brands are the debtor company's.
      creditor: [
        { accountCode: pair.bDueFrom, type: 'debit', amountCents: amount, memo: `Due from ${dName}: ${memo}` },
        { accountCode: t.creditorAccountCode, type: 'credit', amountCents: amount, memo: `${memo} (recharged to ${dName})` },
      ],
    }
  }
  if (t.kind === 'settlement') {
    const side = settlementSideMethods(t.method)
    const dMoney = await moneyAccountCode(tx, D, { method: side.debtor, bankAccountId: t.debtorBankAccountId })
    const cMoney = await moneyAccountCode(tx, C, { method: side.creditor, bankAccountId: t.creditorBankAccountId })
    // "bank deposit, ref 4471" (rows from before the reference was required may have none).
    const how = receiptText(t.method, t.bankReference)
    const deposit = t.method === 'bank_deposit'
    return {
      debtor: [
        { accountCode: pair.aDueTo, type: 'debit', amountCents: amount, memo: `Settled to ${cName} (${how}): ${memo}`.slice(0, 250) },
        { accountCode: dMoney.code, type: 'credit', amountCents: amount, memo: `${deposit ? `Cash deposited into ${cName}'s bank` : `Paid to ${cName}`} (${how})`.slice(0, 250) },
      ],
      creditor: [
        { accountCode: cMoney.code, type: 'debit', amountCents: amount, memo: `${deposit ? `Cash deposited by ${dName}` : `Received from ${dName}`} (${how})`.slice(0, 250) },
        { accountCode: pair.bDueFrom, type: 'credit', amountCents: amount, memo: `Settled by ${dName} (${how}): ${memo}`.slice(0, 250) },
      ],
    }
  }
  // netting
  return {
    debtor: [
      { accountCode: pair.aDueTo, type: 'debit', amountCents: amount, memo: `Netted with ${cName}: ${memo}` },
      { accountCode: pair.aDueFrom, type: 'credit', amountCents: amount, memo: `Netted with ${cName}: ${memo}` },
    ],
    creditor: [
      { accountCode: pair.bDueTo, type: 'debit', amountCents: amount, memo: `Netted with ${dName}: ${memo}` },
      { accountCode: pair.bDueFrom, type: 'credit', amountCents: amount, memo: `Netted with ${dName}: ${memo}` },
    ],
  }
}

/**
 * Post a transfer in BOTH books inside `tx` (a serviceClient transaction that
 * also holds the transfer's status claim), dated `entryDate`, and store the
 * two entry ids. A refusal in either book throws and the caller's transaction
 * rolls back both.
 */
async function postBothBooks(
  tx: Tx, t: TransferRow, opts: { entryDate: Date; memoNote?: string; postedBy: string },
): Promise<{ debtorEntryId: string; creditorEntryId: string }> {
  const names = await namesOf(tx, [t.tenantId, t.counterpartyTenantId])
  await assertOpenInBoth(tx, [t.tenantId, t.counterpartyTenantId], opts.entryDate)
  const lines = await linesOf(tx, t, names)
  const what = t.kind === 'charge' ? 'charge' : t.kind === 'settlement' ? 'settlement' : 'netting'
  const how = t.kind === 'settlement' ? ` (${receiptText(t.method, t.bankReference)})` : ''
  const description = `Inter-company ${what}: ${names.get(t.tenantId) ?? ''} → ${names.get(t.counterpartyTenantId) ?? ''}${how} — ${t.memo}`.slice(0, 480)
  const d = withLateNote(description, lines.debtor, opts.memoNote)
  const c = withLateNote(description, lines.creditor, opts.memoNote)
  const debtor = await postJournalEntry({
    tenantId: t.tenantId, sourceType: IC_TRANSFER_SOURCE, sourceId: t.id,
    description: d.description, entryDate: opts.entryDate, postedBy: opts.postedBy, lines: d.lines,
  }, { tx })
  const creditor = await postJournalEntry({
    tenantId: t.counterpartyTenantId, sourceType: IC_TRANSFER_SOURCE, sourceId: t.id,
    description: c.description, entryDate: opts.entryDate, postedBy: opts.postedBy, lines: c.lines,
  }, { tx })
  await tx.intercompanyTransfer.update({
    where: { id: t.id },
    data: { debtorEntryId: debtor.entryId, creditorEntryId: creditor.entryId, entryDate: opts.entryDate },
  })
  return { debtorEntryId: debtor.entryId, creditorEntryId: creditor.entryId }
}

// ─── Manual transfers (finance prepares, the CEO approves) ───────────────────

export interface CreateTransferInput {
  kind: TransferKind
  debtorTenantId: string
  creditorTenantId: string
  amountCents: number
  /** YYYY-MM-DD (Pakistan). */
  entryDate: string
  memo: string
  debtorAccountCode?: string | null
  creditorAccountCode?: string | null
  conceptSplit?: ConceptShare[] | null
  /** A settlement's method (SETTLEMENT_METHODS; the old 'bank' = bank_transfer). */
  method?: SettlementMethod | 'bank' | null
  debtorBankAccountId?: string | null
  creditorBankAccountId?: string | null
  /** A settlement's payment reference # — required for every method. */
  bankReference?: string | null
}

/**
 * Record a manual transfer. The caller has already checked the pair
 * (lib/companyPairs.ts assertBothSidesOwned). Everything a posting would
 * refuse is checked now, so a transfer waiting for the CEO is postable:
 * accounts, banks, the date open in both companies, the balance limits.
 * `postNow` (the CEO) posts it in the same transaction (selfApproved).
 */
export async function createTransfer(actor: TransferActor, input: CreateTransferInput, opts: { postNow?: boolean } = {}): Promise<TransferRow> {
  const D = input.debtorTenantId
  const C = input.creditorTenantId
  if (D === C) throw new AppError('SAME_COMPANY', 'A transfer must be between two different companies', 422)
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new AppError('AMOUNT_INVALID', 'The amount must be more than zero', 422)
  assertMoneyFits(input.amountCents, 'The transfer')
  const entryDate = transferDateOf(input.entryDate)
  const names = await namesOf(serviceClient, [D, C])

  let debtorAccountCode: string | null = null
  let creditorAccountCode: string | null = null
  let conceptSplit: ConceptShare[] | null = null
  let method: SettlementMethod | null = null
  let debtorBankAccountId: string | null = null
  let creditorBankAccountId: string | null = null
  let bankReference: string | null = null
  if (input.kind === 'charge') {
    if (!input.debtorAccountCode || !input.creditorAccountCode) {
      throw new AppError('ACCOUNT_REQUIRED', "A charge names the paying company's expense account and the charging company's recovery account", 422)
    }
    await assertPostableAccount(serviceClient, D, input.debtorAccountCode, names.get(D) ?? 'the paying company', 'charged to')
    await assertPostableAccount(serviceClient, C, input.creditorAccountCode, names.get(C) ?? 'the charging company', 'recovered in')
    await assertHeadOfficeCounters(serviceClient, D, C, { [D]: input.debtorAccountCode, [C]: input.creditorAccountCode }, names)
    debtorAccountCode = input.debtorAccountCode
    creditorAccountCode = input.creditorAccountCode
    conceptSplit = await assertConceptSplit(serviceClient, D, input.conceptSplit, input.amountCents)
  } else if (input.kind === 'settlement') {
    method = normalizeSettlementMethod(input.method)
    if (!method) throw new AppError('METHOD_REQUIRED', 'Say how the settlement was paid: bank transfer, bank deposit, cheque or cash', 422)
    // The payment reference # — every method, cash included (owner,
    // 2026-10-14). Checked here only: an approval never re-checks it.
    bankReference = assertPaymentReference(method, input.bankReference)
    if (method === 'bank_deposit' && input.debtorBankAccountId) {
      throw new AppError(
        'BANK_ACCOUNT_ON_DEPOSIT',
        `A bank deposit is ${names.get(D) ?? 'the paying company'}'s cash paid into ${names.get(C) ?? 'the receiving company'}'s bank — the paying company does not use a bank account`,
        422,
      )
    }
    // Resolve now so a wrong bank answers before anything is saved.
    const side = settlementSideMethods(method)
    debtorBankAccountId = (await moneyAccountCode(serviceClient, D, { method: side.debtor, bankAccountId: input.debtorBankAccountId ?? null })).bankAccountId
    creditorBankAccountId = (await moneyAccountCode(serviceClient, C, { method: side.creditor, bankAccountId: input.creditorBankAccountId ?? null })).bankAccountId
  }
  await assertHeadOfficePairLinked(serviceClient, D, C, names)
  await assertOpenInBoth(serviceClient, [D, C], entryDate)

  return serviceClient.$transaction(async (tx) => {
    await lockPair(tx, D, C)
    await assertWithinBalance(tx, { kind: input.kind, tenantId: D, counterpartyTenantId: C, amountCents: input.amountCents, entryDate }, true)
    const row = await tx.intercompanyTransfer.create({
      data: {
        tenantId: D, counterpartyTenantId: C, kind: input.kind, source: 'manual', sourceRef: null,
        amountCents: input.amountCents, entryDate, memo: input.memo.trim(),
        debtorAccountCode, creditorAccountCode,
        conceptSplit: splitJson(conceptSplit),
        method, debtorBankAccountId, creditorBankAccountId, bankReference,
        status: 'submitted', preparedById: actor.id,
      },
    })
    if (!opts.postNow) return row
    const claimed = await tx.intercompanyTransfer.update({
      where: { id: row.id },
      data: { status: 'posted', decidedById: actor.id, decidedAt: new Date(), selfApproved: true },
    })
    await postBothBooks(tx, claimed, { entryDate, postedBy: actor.id })
    return tx.intercompanyTransfer.findUniqueOrThrow({ where: { id: row.id } })
  }, TX_OPTS)
}

/** How a decision was authorised: the grant lib/approvalRights.ts assertCanApprove returned (the route proves it). */
export interface DecideOpts {
  grant?: ApprovalGrant | null
}

/**
 * The claim's guard: always 'submitted'; a non-admin (a Finance delegate) never
 * decides what they prepared — enforced in the claim itself, not only by the
 * route's check, so a race cannot slip past it.
 */
function claimWhere(actor: TransferActor, id: string): Prisma.IntercompanyTransferWhereInput {
  return { id, status: 'submitted', ...(actor.role !== 'admin' && { preparedById: { not: actor.id } }) }
}

/** 409 NOT_SUBMITTED, or 403 SELF_APPROVAL_BLOCKED when the claim missed only because a non-admin prepared it. */
async function claimMissed(db: Db, actor: TransferActor, id: string): Promise<never> {
  const now = await db.intercompanyTransfer.findUnique({ where: { id }, select: { status: true, preparedById: true } })
  if (now?.status === 'submitted' && actor.role !== 'admin' && now.preparedById === actor.id) {
    throw new AppError('SELF_APPROVAL_BLOCKED', "You can't approve something you prepared. Have a colleague or the CEO decide it.", 403)
  }
  throw new AppError('NOT_SUBMITTED', 'This transfer is no longer waiting for approval', 409)
}

/**
 * Approve: claim submitted → posted and post both books, in ONE transaction.
 * Authorised by `opts.grant` (the route's assertCanApprove — the CEO, or a
 * Finance delegate on a head-office pair) or, with no grant, the CEO who
 * belongs to both companies (as before). selfApproved stays for the CEO.
 */
export async function approveTransfer(actor: TransferActor, id: string, note?: string | null, opts: DecideOpts = {}): Promise<TransferRow> {
  const t = await serviceClient.intercompanyTransfer.findUnique({ where: { id } })
  if (!t) throw new AppError('NOT_FOUND', 'Transfer not found', 404)
  assertMayDecide(actor, t, opts)
  return serviceClient.$transaction(async (tx) => {
    await lockPair(tx, t.tenantId, t.counterpartyTenantId)
    const claim = await tx.intercompanyTransfer.updateMany({
      where: claimWhere(actor, id),
      data: { status: 'posted', decidedById: actor.id, decidedAt: new Date(), decisionNote: note?.trim() || null, selfApproved: t.preparedById === actor.id },
    })
    if (claim.count === 0) await claimMissed(tx, actor, id)
    const row = await tx.intercompanyTransfer.findUniqueOrThrow({ where: { id } })
    await assertWithinBalance(tx, { id, kind: row.kind, tenantId: row.tenantId, counterpartyTenantId: row.counterpartyTenantId, amountCents: toCents(row.amountCents), entryDate: row.entryDate }, false)
    await postBothBooks(tx, row, { entryDate: row.entryDate, postedBy: actor.id })
    return tx.intercompanyTransfer.findUniqueOrThrow({ where: { id } })
  }, TX_OPTS)
}

/** Reject: the same authority as approve (opts.grant, else the CEO of both). */
export async function rejectTransfer(actor: TransferActor, id: string, note: string, opts: DecideOpts = {}): Promise<TransferRow> {
  const t = await serviceClient.intercompanyTransfer.findUnique({ where: { id } })
  if (!t) throw new AppError('NOT_FOUND', 'Transfer not found', 404)
  assertMayDecide(actor, t, opts)
  const claim = await serviceClient.intercompanyTransfer.updateMany({
    where: claimWhere(actor, id),
    data: { status: 'rejected', decidedById: actor.id, decidedAt: new Date(), decisionNote: note.trim() },
  })
  if (claim.count === 0) await claimMissed(serviceClient, actor, id)
  return serviceClient.intercompanyTransfer.findUniqueOrThrow({ where: { id } })
}

/** A decision needs a proven grant, or the CEO (admin) who belongs to both companies. */
function assertMayDecide(actor: TransferActor, t: { tenantId: string; counterpartyTenantId: string }, opts: DecideOpts): void {
  if (opts.grant) return
  if (actor.role !== 'admin') {
    throw new AppError('APPROVAL_NOT_YOURS', 'This needs the CEO', 403)
  }
  assertActorOfBoth(actor, t)
}

function assertActorOfBoth(actor: TransferActor, t: { tenantId: string; counterpartyTenantId: string }): void {
  if (!isMemberOfBoth(actor, t.tenantId, t.counterpartyTenantId)) {
    throw new AppError('NOT_IN_BOTH_COMPANIES', 'Only someone who belongs to both companies can decide this transfer', 403)
  }
}

// ─── Reversal ────────────────────────────────────────────────────────────────

/**
 * Reverse a posted transfer in both books inside `tx` ('ic.transfer.reversal:<id>'
 * in each), dated `natural` (default now) or the first day open in both. A
 * system transfer's sourceRef is freed (suffixed '#reversed:<id>') so the
 * month / payment can be booked again once corrected. Returns false when it
 * was already reversed.
 */
async function reverseInTx(
  tx: Tx, id: string, reason: string, opts: { actorId: string; natural?: Date; idempotent: boolean },
): Promise<boolean> {
  const t = await tx.intercompanyTransfer.findUnique({ where: { id } })
  if (!t) throw new AppError('NOT_FOUND', 'Transfer not found', 404)
  await lockPair(tx, t.tenantId, t.counterpartyTenantId)
  const fresh = await tx.intercompanyTransfer.findUniqueOrThrow({ where: { id } })
  if (fresh.status === 'reversed' && opts.idempotent) return false
  if (fresh.status !== 'posted') throw new AppError('NOT_POSTED', `This transfer is ${fresh.status}, not posted — nothing to reverse`, 409)
  const place = await commonOpenPlacement(tx, [t.tenantId, t.counterpartyTenantId], opts.natural ?? new Date(), 'the reversal')
  if ('lockedThroughToday' in place) {
    const names = await namesOf(tx, [place.tenantId])
    throw new AppError('PERIOD_LOCKED', `${names.get(place.tenantId) ?? 'One company'}'s books are closed through ${fmtPktDate(place.lockedThrough)}, today included — nothing can be reversed until today is open`, 422)
  }
  const claim = await tx.intercompanyTransfer.updateMany({
    where: { id, status: 'posted' },
    data: {
      status: 'reversed', reversedById: opts.actorId, reversedAt: new Date(), reversalReason: reason,
      ...(fresh.sourceRef && { sourceRef: `${fresh.sourceRef}#reversed:${id}` }),
    },
  })
  if (claim.count === 0) throw new AppError('NOT_POSTED', 'This transfer is no longer posted', 409)
  const why = place.memoNote ? `${reason} (${place.memoNote})` : reason
  for (const tenantId of [t.tenantId, t.counterpartyTenantId]) {
    await reverseJournalEntry(tenantId, IC_TRANSFER_SOURCE, id, why, { tx, entryDate: place.entryDate, postedBy: opts.actorId })
  }
  return true
}

/** The CEO reverses a posted transfer (both books, today). A COD transfer is reversed from where it was booked. */
export async function reverseTransfer(actor: TransferActor, id: string, reason: string): Promise<TransferRow> {
  const t = await serviceClient.intercompanyTransfer.findUnique({ where: { id } })
  if (!t) throw new AppError('NOT_FOUND', 'Transfer not found', 404)
  assertActorOfBoth(actor, t)
  if (t.source === 'cod') {
    throw new AppError('REVERSE_FROM_SOURCE', "A rider's cash-on-delivery debt is cleared when the rider pays it in (Reconciliation → Cash on delivery), not here", 409)
  }
  if (t.source === 'ho_recharge') {
    throw new AppError('REVERSE_FROM_SOURCE', 'A head-office recharge is reversed from its run — reverse the recharge run instead (Inter-company → Head office)', 409)
  }
  await serviceClient.$transaction((tx) => reverseInTx(tx, id, reason.trim(), { actorId: actor.id, idempotent: false }), TX_OPTS)
  return serviceClient.intercompanyTransfer.findUniqueOrThrow({ where: { id } })
}

// ─── System transfers (fleet, COD) ───────────────────────────────────────────

export interface SystemTransferInput {
  kind: 'charge'
  source: SystemSource
  /** Idempotency key per pair: 'fleet:<agreementId>:<YYYY-MM>', 'cod:<paymentId>'. */
  sourceRef: string
  debtorTenantId: string
  creditorTenantId: string
  amountCents: number
  /** Must be open in both companies (place it first: commonOpenPlacement). */
  entryDate: Date
  /** Debited in the debtor's chart (fleet: 6035; cod: 1351). */
  debtorAccountCode: string
  /** Credited in the creditor's chart (fleet: 6990; cod: 1010). */
  creditorAccountCode: string
  /** Brands of the DEBTOR company on its debit lines; shares add up to amountCents. */
  conceptSplit?: Array<{ conceptId: string; cents: number }>
  memo: string
  /** 'system' or the user who triggered it. */
  preparedById: string
  /** The month a charge is for ('YYYY-MM'). */
  period?: string | null
  /** Late-posting note (withLateNote) when entryDate is not the natural date. */
  memoNote?: string
}

/**
 * Post a system transfer in BOTH books inside the caller's serviceClient
 * transaction (status posted at once — no approval). Idempotent on
 * (debtor, creditor, sourceRef): a replay returns the transfer already posted
 * with alreadyPosted: true. Refusals (a closed month in either company — 422
 * PERIOD_LOCKED naming it —, an account missing / controlled / inactive)
 * throw, and the caller's transaction rolls back.
 */
export async function postSystemTransferTx(
  serviceTx: Tx, a: SystemTransferInput,
): Promise<{ transferId: string; debtorEntryId: string; creditorEntryId: string; alreadyPosted: boolean }> {
  if (a.kind !== 'charge') throw new AppError('KIND_INVALID', 'A system transfer is a charge', 500)
  if (!(SYSTEM_SOURCES as readonly string[]).includes(a.source)) throw new AppError('SOURCE_INVALID', `Unknown system transfer source '${a.source}'`, 500)
  if (!a.sourceRef) throw new AppError('SOURCE_REF_REQUIRED', 'A system transfer needs its sourceRef', 500)
  const D = a.debtorTenantId
  const C = a.creditorTenantId
  if (!D || !C || D === C) throw new AppError('SAME_COMPANY', 'A transfer must be between two different companies', 422)
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) throw new AppError('AMOUNT_INVALID', 'A system transfer amount must be a positive whole number of paisa', 422)
  assertMoneyFits(a.amountCents, 'The transfer')

  await lockPair(serviceTx, D, C)
  const existing = await serviceTx.intercompanyTransfer.findUnique({
    where: { tenantId_counterpartyTenantId_sourceRef: { tenantId: D, counterpartyTenantId: C, sourceRef: a.sourceRef } },
  })
  if (existing) {
    if (existing.status === 'posted' && existing.debtorEntryId && existing.creditorEntryId) {
      return { transferId: existing.id, debtorEntryId: existing.debtorEntryId, creditorEntryId: existing.creditorEntryId, alreadyPosted: true }
    }
    throw new AppError('TRANSFER_EXISTS', `A transfer for ${a.sourceRef} already exists (${existing.status})`, 409)
  }
  const names = await namesOf(serviceTx, [D, C])
  await assertPostableAccount(serviceTx, D, a.debtorAccountCode, names.get(D) ?? 'the debtor', 'debited')
  await assertPostableAccount(serviceTx, C, a.creditorAccountCode, names.get(C) ?? 'the creditor', 'credited')
  const split = await assertConceptSplit(serviceTx, D, a.conceptSplit, a.amountCents)
  const now = new Date()
  const row = await serviceTx.intercompanyTransfer.create({
    data: {
      tenantId: D, counterpartyTenantId: C, kind: 'charge', source: a.source, sourceRef: a.sourceRef,
      period: a.period ?? null, amountCents: a.amountCents, entryDate: a.entryDate,
      debtorAccountCode: a.debtorAccountCode, creditorAccountCode: a.creditorAccountCode,
      conceptSplit: splitJson(split),
      memo: a.memo.slice(0, 500), status: 'posted',
      preparedById: a.preparedById, decidedById: a.preparedById, decidedAt: now,
    },
  })
  const posted = await postBothBooks(serviceTx, row, { entryDate: a.entryDate, memoNote: a.memoNote, postedBy: a.preparedById })
  return { transferId: row.id, ...posted, alreadyPosted: false }
}

/**
 * Reverse a system transfer in both books ('ic.transfer.reversal:<id>'),
 * dated `entryDate` (default now) or the first day open in both companies.
 * In the given serviceClient `tx`, else its own transaction. Idempotent: an
 * already-reversed transfer is left alone. Frees its sourceRef.
 */
export async function reverseSystemTransfer(transferId: string, reason: string, o: { entryDate?: Date; tx?: Tx } = {}): Promise<void> {
  const run = (tx: Tx) => reverseInTx(tx, transferId, reason, { actorId: 'system', natural: o.entryDate, idempotent: true })
  if (o.tx) { await run(o.tx); return }
  await serviceClient.$transaction(run, TX_OPTS)
}

// ─── Presenting ──────────────────────────────────────────────────────────────

export interface TransferView {
  id: string
  tenantId: string
  counterpartyTenantId: string
  debtorName: string | null
  creditorName: string | null
  kind: string
  source: string
  sourceRef: string | null
  period: string | null
  amountCents: number
  entryDate: string
  memo: string
  status: string
  debtorAccountCode: string | null
  creditorAccountCode: string | null
  conceptSplit: Array<{ conceptId: string; conceptName: string | null; cents: number }> | null
  method: string | null
  /** A bank's name is shown to members of its company only. */
  debtorBankName: string | null
  creditorBankName: string | null
  bankReference: string | null
  preparedById: string
  preparedByName: string | null
  preparedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
  selfApproved: boolean
  reversedByName: string | null
  reversedAt: string | null
  reversalReason: string | null
  debtorEntryId: string | null
  creditorEntryId: string | null
  createdAt: string
  /** The viewer belongs to both companies. */
  memberOfBoth: boolean
  /** What the viewer may do now (the routes' own guards decide; these only hide buttons that would 403). */
  canApprove: boolean
  canReverse: boolean
}

/** Rows (already in the viewer's scope) with names and the viewer's capability flags. */
export async function presentTransfers(rows: TransferRow[], viewer: TransferActor): Promise<TransferView[]> {
  const userIds = new Set<string>()
  const tenantIds = new Set<string>()
  const bankIds = new Set<string>()
  const conceptIds = new Set<string>()
  for (const t of rows) {
    for (const u of [t.preparedById, t.decidedById, t.reversedById]) if (u && u !== 'system') userIds.add(u)
    tenantIds.add(t.tenantId); tenantIds.add(t.counterpartyTenantId)
    if (t.debtorBankAccountId) bankIds.add(t.debtorBankAccountId)
    if (t.creditorBankAccountId) bankIds.add(t.creditorBankAccountId)
    for (const s of splitOf(t.conceptSplit) ?? []) conceptIds.add(s.conceptId)
  }
  const [users, tenants, banks, concepts] = await Promise.all([
    userIds.size ? serviceClient.user.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, name: true } }) : [],
    tenantIds.size ? serviceClient.tenant.findMany({ where: { id: { in: [...tenantIds] } }, select: { id: true, name: true } }) : [],
    bankIds.size ? serviceClient.bankAccount.findMany({ where: { id: { in: [...bankIds] } }, select: { id: true, name: true } }) : [],
    conceptIds.size ? serviceClient.concept.findMany({ where: { id: { in: [...conceptIds] } }, select: { id: true, name: true } }) : [],
  ])
  const userName = new Map(users.map((u) => [u.id, u.name]))
  const tenantName = new Map(tenants.map((t) => [t.id, t.name]))
  const bankName = new Map(banks.map((b) => [b.id, b.name]))
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))
  const nameOf = (id: string | null) => (!id ? null : id === 'system' ? 'servd (automatic)' : userName.get(id) ?? null)
  const iso = (d: Date | null) => (d ? d.toISOString() : null)
  const isCeo = viewer.role === 'admin'
  return rows.map((t) => {
    const both = isMemberOfBoth(viewer, t.tenantId, t.counterpartyTenantId)
    const seesDebtor = viewer.memberTenantIds.includes(t.tenantId)
    const seesCreditor = viewer.memberTenantIds.includes(t.counterpartyTenantId)
    const split = splitOf(t.conceptSplit)
    return {
      id: t.id,
      tenantId: t.tenantId,
      counterpartyTenantId: t.counterpartyTenantId,
      debtorName: tenantName.get(t.tenantId) ?? null,
      creditorName: tenantName.get(t.counterpartyTenantId) ?? null,
      kind: t.kind,
      source: t.source,
      sourceRef: t.sourceRef,
      period: t.period,
      amountCents: toCents(t.amountCents),
      entryDate: t.entryDate.toISOString(),
      memo: t.memo,
      status: t.status,
      debtorAccountCode: t.debtorAccountCode,
      creditorAccountCode: t.creditorAccountCode,
      conceptSplit: split && seesDebtor ? split.map((s) => ({ ...s, conceptName: conceptName.get(s.conceptId) ?? null })) : null,
      method: t.method,
      debtorBankName: seesDebtor && t.debtorBankAccountId ? bankName.get(t.debtorBankAccountId) ?? null : null,
      creditorBankName: seesCreditor && t.creditorBankAccountId ? bankName.get(t.creditorBankAccountId) ?? null : null,
      bankReference: t.bankReference,
      preparedById: t.preparedById,
      preparedByName: nameOf(t.preparedById),
      preparedAt: t.preparedAt.toISOString(),
      decidedByName: nameOf(t.decidedById),
      decidedAt: iso(t.decidedAt),
      decisionNote: t.decisionNote,
      selfApproved: t.selfApproved,
      reversedByName: nameOf(t.reversedById),
      reversedAt: iso(t.reversedAt),
      reversalReason: t.reversalReason,
      debtorEntryId: seesDebtor ? t.debtorEntryId : null,
      creditorEntryId: seesCreditor ? t.creditorEntryId : null,
      createdAt: t.createdAt.toISOString(),
      memberOfBoth: both,
      canApprove: isCeo && both && t.status === 'submitted',
      canReverse: isCeo && both && t.status === 'posted' && t.source !== 'cod' && t.source !== 'ho_recharge',
    }
  })
}
