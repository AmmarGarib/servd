// Raast QR — finance's side (spec §7, amendments M4, S3, S6).
//
// A Raast payment completes the sale at the till and writes a RaastReceipt
// 'provisional'. The BANK STATEMENT is the truth: a receipt becomes 'matched'
// only when a statement line of the SAME company and the SAME receiving bank
// account names its reference with the same amount — or when finance matches
// it by hand. Nothing here guesses:
//
//   matchRaastLinesTx   the statement pre-pass. Runs inside importBankStatement
//                       (before the generic matcher) and from POST /rematch and
//                       a reference fix. A line pairs with a receipt only when
//                       the line names exactly ONE candidate receipt, that
//                       receipt is named by exactly ONE line, and the amounts
//                       are equal. One hit with a different amount raises
//                       raast_statement_mismatch and matches nothing.
//                       References a manager dismissed as "not a sale", or a
//                       debit's reference, are never used (M4).
//   raastSkipLinesTx    S3: the generic matcher leaves alone every positive line
//                       that equals a provisional receipt's amount on that
//                       account within ±statementMatchDays (it would pair it
//                       with any equal debit — a cash deposit — and the
//                       receipt could never be matched).
//   matchReceiptToLineTx / unmatchReceiptTx / writeOffUnreceivedTx /
//   fixReceiptReferenceTx / resolveAttentionReceipt
//                       finance's manual actions (raastRoutes.ts).
//
// Time rule (M4, RV-FRAUD-1): a statement line dated before the bill existed
// (its creation minus matchWindowMin, by PKT day) never matches it — the
// reference was borrowed from an older credit.
//   flagUnmatchedReceipts   the daily raast_unmatched flag (one per bank account).
//   requestRaastVoid / rejectRaastVoidRequest / voidNeverBooked
//                       the CEO's "void, never booked" (RV-MONEY-1, owner
//                       2026-10-13: finance may ask, ONLY the CEO voids) —
//                       see raastVoidEligibilityTx.
//
// Every write path takes lockRaastTx (connectors/raast/lock.ts) FIRST, in its
// own short transaction — the till's Raast payments and the SMS matcher take
// the same lock, so a receipt's state is never overwritten by a race.
//
// Ledger. A write-off ('not received') posts 'raast.unreceived:<receiptId>'
// in the receipt's company: Dr contra (the customer owes it — the company's
// till-clearing code, tillClearingCodeTx: 1110 until the CEO's 1110 → 1115
// cut-over, 1115 after it / 8010 loss / 1350 staff owes) / Cr the receiving
// bank's code — both memos start with RAAST_RECEIPTS_MEMO, so the generic
// matcher never pairs them. Entries already posted are never touched here:
// a reversal mirrors its own entry's lines (a pre-cut-over 1110 write-off
// reverses on 1110, and the daily till-clearing mover — accounting/
// tillClearing.ts moveLateTillLines — carries that onto 1115). A receipt
// written off and later found on a statement
// reverses that entry first
// ('raast.unreceived.reversal:<…>'). A second write-off after a reversal gets
// its own sourceId (`<receiptId>:2`, …) — a posting is idempotent per
// reference. A void posts NOTHING: nothing ever debited the bank for it.

import type { Prisma, RaastReceipt, RaastReceiptStatus } from '@prisma/client'
import { prisma as defaultPrisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { fmtPktDate } from '../accounting/dates.js'
import { ACCT, postJournalEntry, reverseJournalEntry, TILL_CLEARING_CODES } from '../accounting/journal.js'
import { tillClearingCodeTx } from '../accounting/tillClearingCode.js'
import { RAAST_RECEIPTS_MEMO, REFUND_DUE_PREFIX } from '../accounting/orderPosting.js'
import { lockRaastTx } from '../../connectors/raast/lock.js'
import { cleanBankRef, normalizeBankRef, refInText } from '../../connectors/raast/reference.js'
import {
  raastConnectorTx, raiseRaastFlagTx, resolveRaastFlagsTx, assertRefNotClaimedTx, findSmsForRefTx, linkAlertTx,
  RAAST_TOLERANCE_CENTS, OPEN_ALERT_STATUSES,
} from '../../connectors/raast/match.js'
import { notifyConnectorPeople } from '../../connectors/alerts.js'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof defaultPrisma

const DAY_MS = 86_400_000
const PKT_MS = 5 * 3_600_000
const TX_OPTS = { maxWait: 10_000, timeout: 30_000 } as const

/** Receipts a statement line may match: booked as a sale, not yet on a statement. */
export const MATCHABLE_STATUSES: RaastReceiptStatus[] = ['provisional', 'unreceived']
/** Receipts finance still has to clear before a period closes (S6). */
export const OPEN_FINANCE_STATUSES: RaastReceiptStatus[] = ['provisional', 'needs_attention']
/**
 * The contra accounts a write-off may use: 1115 (the customer still owes it —
 * till clearing), 8010 a loss, 1350 recovered from staff, and the legacy
 * '1110' an older screen may still send. '1115' and '1110' both mean "the
 * customer owes it" and post to the company's CURRENT till-clearing code
 * (tillClearingCodeTx — 1110 before the CEO's cut-over, 1115 after it), so a
 * write-off never lands on the wrong side of the split. Omitted, that is the
 * default (resolved server-side, never a static code).
 */
export const WRITE_OFF_CONTRAS = ['1115', '8010', '1350', '1110'] as const
export type WriteOffContra = (typeof WRITE_OFF_CONTRAS)[number]
/** The contras that mean "the customer still owes it" (till clearing). */
const TILL_CLEARING_CONTRAS: ReadonlySet<string> = new Set([ACCT.TILL_CLEARING, ACCT.CUSTOMER_AR])
/** Who may ask the CEO to void a receipt (the void itself is the CEO's — role admin). */
export const RAAST_VOID_REQUESTERS: readonly string[] = ['admin', 'owner', 'management', 'finance']

const WRITE_OFF_SOURCE = 'raast.unreceived'

/** PKT business-day number of an instant (a statement's date-only value lands on its own day). */
export const pktDay = (d: Date): number => Math.floor((d.getTime() + PKT_MS) / DAY_MS)

/** When a receipt's money should be in the bank: its confirmation, else its creation. */
export const receiptAt = (r: Pick<RaastReceipt, 'confirmedAt' | 'createdAt'>): Date => r.confirmedAt ?? r.createdAt

/**
 * M4 on the statement (RV-FRAUD-1): the earliest PKT day a statement line may
 * carry and still be this receipt's money — the bill's own creation minus the
 * match window. A credit posted before the bill existed (an owner transfer, a
 * supplier refund) is never its payment, whatever reference the cashier typed.
 * A statement is date-only, so a line of the bill's own day still counts.
 */
export const earliestLineDay = (r: Pick<RaastReceipt, 'createdAt'>, matchWindowMin: number): number =>
  pktDay(new Date(r.createdAt.getTime() - matchWindowMin * 60_000))

/** A statement line's PKT day `day` may be receipt `r`'s money: not before the bill, at most n days after it. */
export const lineDayFits = (r: Pick<RaastReceipt, 'createdAt' | 'confirmedAt'>, day: number, n: number, matchWindowMin: number): boolean =>
  day >= earliestLineDay(r, matchWindowMin) && day - pktDay(receiptAt(r)) <= n

const pkr = (cents: number) => `PKR ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`

/** The statement-matching settings of a company's raast connector (defaults when none). */
export async function raastFinanceSettings(db: Db, tenantId: string): Promise<{ statementMatchDays: number; matchWindowMin: number; provisionalFlagDays: number; refMin: number; refMax: number; smsOn: boolean }> {
  const c = await raastConnectorTx(db, tenantId)
  return {
    statementMatchDays: c.settings.statementMatchDays,
    matchWindowMin: c.settings.matchWindowMin,
    provisionalFlagDays: c.settings.provisionalFlagDays,
    refMin: c.settings.refMinLength,
    refMax: c.settings.refMaxLength,
    smsOn: c.enabled,
  }
}

/**
 * References of the company that can never pay a bill (M4): claimed as "not a
 * sale" by a manager, a dismissed alert's reference, or money going OUT (a
 * debit SMS). The statement pre-pass never matches a receipt carrying one.
 */
async function claimedRefsTx(db: Db, tenantId: string, refs: string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set()
  const rows = await db.bankSmsAlert.findMany({
    where: {
      tenantId,
      OR: [
        { claimedRef: { in: refs } },
        { bankRef: { in: refs }, kind: 'debit' },
        { bankRef: { in: refs }, status: 'dismissed' },
      ],
    },
    select: { claimedRef: true, bankRef: true, kind: true, status: true },
  })
  const out = new Set<string>()
  for (const r of rows) {
    if (r.claimedRef) out.add(r.claimedRef)
    if (r.bankRef && (r.kind === 'debit' || r.status === 'dismissed')) out.add(r.bankRef)
  }
  return out
}

// ─── The statement pre-pass ──────────────────────────────────────────────────

export interface PassLine {
  id: string
  postedDate: Date
  description: string
  reference: string | null
  amountCents: number
}

export interface RaastPassResult {
  /** Lines matched to a receipt in this pass. */
  matched: number
  /** Lines that named one receipt with a different amount (flagged, not matched). */
  mismatched: number
  matchedLineIds: string[]
  matchedReceiptIds: string[]
  /**
   * RV-FIN-2: every line that names a receipt's reference, matched or not
   * (another amount, several receipts, a receipt named twice) — the generic
   * matcher never touches them; they are the Raast tab's.
   */
  hitLineIds: string[]
}

const emptyPass = (): RaastPassResult => ({ matched: 0, mismatched: 0, matchedLineIds: [], matchedReceiptIds: [], hitLineIds: [] })

/**
 * Pair `lines` (unmatched credits of `bankAccountId`'s statements) with the
 * company's provisional / unreceived receipts on that account. Caller holds
 * lockRaastTx(tenantId) in `tx`.
 */
async function raastPassTx(
  tx: Tx,
  opts: { tenantId: string; bankAccountId: string; lines: PassLine[]; actorId: string | null; onlyReceiptId?: string },
): Promise<RaastPassResult> {
  const out = emptyPass()
  const lines = opts.lines.filter((l) => l.amountCents > 0)
  if (lines.length === 0) return out
  const { statementMatchDays: n, matchWindowMin } = await raastFinanceSettings(tx, opts.tenantId)

  const minT = Math.min(...lines.map((l) => l.postedDate.getTime())) - (n + 1) * DAY_MS
  const maxT = Math.max(...lines.map((l) => l.postedDate.getTime())) + (n + 1) * DAY_MS
  const window = { gte: new Date(minT), lte: new Date(maxT) }
  const found = await tx.raastReceipt.findMany({
    where: {
      tenantId: opts.tenantId, bankAccountId: opts.bankAccountId, status: { in: MATCHABLE_STATUSES },
      statementLineId: null, bankRef: { not: null },
      OR: [{ confirmedAt: window }, { confirmedAt: null, createdAt: window }],
    },
  })
  const claimed = await claimedRefsTx(tx, opts.tenantId, found.map((r) => r.bankRef!).filter(Boolean))
  const receipts = found.filter((r) => r.bankRef && !claimed.has(r.bankRef))
  if (receipts.length === 0) return out

  const hitsOfLine = new Map<string, RaastReceipt[]>()
  const linesOfReceipt = new Map<string, number>()
  for (const line of lines) {
    const text = `${line.description} ${line.reference ?? ''}`
    const day = pktDay(line.postedDate)
    // One-sided (M4, RV-FRAUD-1): a credit dated before the bill existed is
    // never its payment — the reference was borrowed from an older transfer.
    const hits = receipts.filter((r) => lineDayFits(r, day, n, matchWindowMin) && refInText(r.bankRef!, text))
    hitsOfLine.set(line.id, hits)
    if (hits.length > 0) out.hitLineIds.push(line.id)
    for (const r of hits) linesOfReceipt.set(r.id, (linesOfReceipt.get(r.id) ?? 0) + 1)
  }

  for (const line of lines) {
    const hits = hitsOfLine.get(line.id) ?? []
    // Never guess: exactly one receipt named by the line, and that receipt
    // named by no other line of this pass.
    if (hits.length !== 1) continue
    const r = hits[0]!
    if ((linesOfReceipt.get(r.id) ?? 0) !== 1) continue
    if (opts.onlyReceiptId && r.id !== opts.onlyReceiptId) continue
    if (r.amountCents !== line.amountCents) {
      out.mismatched++
      await raiseRaastFlagTx(tx, {
        tenantId: r.tenantId, kind: 'raast_statement_mismatch', severity: 'high',
        title: `Bank statement amount differs for Raast bill #${orderRefOf(r.orderId)}`,
        description: `The statement line of ${fmtPktDate(line.postedDate)} names reference ${r.bankRef} but shows ${pkr(line.amountCents)}; the till recorded ${pkr(r.amountCents)}. Nothing was matched — check the transfer and match it by hand, or mark it not received.`,
        entityType: 'RaastReceipt', entityId: r.id, conceptId: r.conceptId, amountCents: r.amountCents,
        metadata: { orderId: r.orderId, bankRef: r.bankRef, lineId: line.id, lineAmountCents: line.amountCents, receiptAmountCents: r.amountCents },
      })
      continue
    }
    const ok = await matchPairTx(tx, r, line, opts.actorId, 'Matched on the bank statement')
    if (ok) {
      out.matched++
      out.matchedLineIds.push(line.id)
      out.matchedReceiptIds.push(r.id)
    }
  }
  return out
}

/**
 * The import's Raast pass (spec §7.1). Inside importBankStatement's
 * transaction, after its lines are inserted and before the generic matcher.
 * Takes the per-company Raast lock.
 */
export async function matchRaastLinesTx(tx: Tx, input: { tenantId: string; importId: string; bankAccountId: string; actorId?: string | null }): Promise<RaastPassResult> {
  await lockRaastTx(tx, input.tenantId)
  const rows = await tx.bankStatementLine.findMany({
    where: { importId: input.importId, matchStatus: 'unmatched' },
    select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
    orderBy: { postedDate: 'asc' },
  })
  const lines = rows.map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))
  return raastPassTx(tx, { tenantId: input.tenantId, bankAccountId: input.bankAccountId, lines, actorId: input.actorId ?? null })
}

/**
 * S3 — positive lines of this import the generic matcher must leave for the
 * Raast tab: equal to a provisional (or written-off, RV-FIN-2) receipt's
 * amount on `bankAccountId` within ±statementMatchDays.
 */
export async function raastSkipLinesTx(tx: Db, input: { tenantId: string; bankAccountId: string; lines: PassLine[] }): Promise<Set<string>> {
  const skip = new Set<string>()
  const lines = input.lines.filter((l) => l.amountCents > 0)
  if (lines.length === 0) return skip
  const { statementMatchDays: n } = await raastFinanceSettings(tx, input.tenantId)
  const minT = Math.min(...lines.map((l) => l.postedDate.getTime())) - (n + 1) * DAY_MS
  const maxT = Math.max(...lines.map((l) => l.postedDate.getTime())) + (n + 1) * DAY_MS
  const window = { gte: new Date(minT), lte: new Date(maxT) }
  const receipts = await tx.raastReceipt.findMany({
    where: {
      // RV-FIN-2: a written-off receipt's late credit is the Raast tab's too.
      tenantId: input.tenantId, bankAccountId: input.bankAccountId, status: { in: MATCHABLE_STATUSES }, statementLineId: null,
      OR: [{ confirmedAt: window }, { confirmedAt: null, createdAt: window }],
    },
    select: { amountCents: true, confirmedAt: true, createdAt: true },
  })
  if (receipts.length === 0) return skip
  for (const l of lines) {
    const day = pktDay(l.postedDate)
    if (receipts.some((r) => r.amountCents === l.amountCents && Math.abs(pktDay(receiptAt(r)) - day) <= n)) skip.add(l.id)
  }
  return skip
}

/**
 * Every positive line another matcher (the card-payout pass's re-run) must
 * leave for the Raast tab, read only: lines naming a matchable receipt's
 * reference on `bankAccountId` (RV-FIN-2) and S3's equal-amount lines.
 */
export async function raastLinesToLeaveTx(db: Db, input: { tenantId: string; bankAccountId: string; lines: PassLine[] }): Promise<Set<string>> {
  const lines = input.lines.filter((l) => l.amountCents > 0)
  const out = new Set<string>()
  if (lines.length === 0) return out
  const { statementMatchDays: n } = await raastFinanceSettings(db, input.tenantId)
  const minT = Math.min(...lines.map((l) => l.postedDate.getTime())) - (n + 1) * DAY_MS
  const maxT = Math.max(...lines.map((l) => l.postedDate.getTime())) + (n + 1) * DAY_MS
  const window = { gte: new Date(minT), lte: new Date(maxT) }
  const receipts = await db.raastReceipt.findMany({
    where: {
      tenantId: input.tenantId, bankAccountId: input.bankAccountId, status: { in: MATCHABLE_STATUSES }, statementLineId: null, bankRef: { not: null },
      OR: [{ confirmedAt: window }, { confirmedAt: null, createdAt: window }],
    },
    select: { bankRef: true },
  })
  for (const l of lines) {
    const text = `${l.description} ${l.reference ?? ''}`
    if (receipts.some((r) => refInText(r.bankRef!, text))) out.add(l.id)
  }
  for (const id of await raastSkipLinesTx(db, input)) out.add(id)
  return out
}

/**
 * Re-run the Raast pass over the company's unmatched credit lines of the last
 * 60 days (or one import), per bank account. Short transaction per account.
 */
export async function rematchRaast(input: { tenantId: string; importId?: string | null; actorId: string; db?: typeof defaultPrisma }): Promise<RaastPassResult & { accounts: number }> {
  const db = input.db ?? defaultPrisma
  const since = new Date(Date.now() - 60 * DAY_MS)
  const imports = await db.bankStatementImport.findMany({
    where: { tenantId: input.tenantId, bankAccountId: { not: null }, ...(input.importId && { id: input.importId }) },
    select: { id: true, bankAccountId: true },
  })
  const byAccount = new Map<string, string[]>()
  for (const i of imports) byAccount.set(i.bankAccountId!, [...(byAccount.get(i.bankAccountId!) ?? []), i.id])
  const total = { ...emptyPass(), accounts: 0 }
  for (const [bankAccountId, importIds] of byAccount) {
    const r = await db.$transaction(async (tx) => {
      await lockRaastTx(tx, input.tenantId)
      const rows = await tx.bankStatementLine.findMany({
        where: {
          importId: { in: importIds }, matchStatus: 'unmatched', amountCents: { gt: 0 },
          ...(!input.importId && { postedDate: { gte: since } }),
        },
        select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
        orderBy: { postedDate: 'asc' },
      })
      const lines = rows.map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))
      return raastPassTx(tx, { tenantId: input.tenantId, bankAccountId, lines, actorId: null })
    }, TX_OPTS)
    total.accounts++
    total.matched += r.matched
    total.mismatched += r.mismatched
    total.matchedLineIds.push(...r.matchedLineIds)
    total.matchedReceiptIds.push(...r.matchedReceiptIds)
    total.hitLineIds.push(...r.hitLineIds)
  }
  return total
}

// ─── Matching one pair / undoing it ──────────────────────────────────────────

/** Reverse a receipt's write-off ('unreceived' → the money did arrive). Caller holds the lock. */
async function reverseWriteOffTx(tx: Tx, r: RaastReceipt, actorId: string | null, reason: string): Promise<void> {
  if (!r.writeOffEntryId) {
    throw new AppError('RAAST_WRITE_OFF_MISSING', 'This Raast receipt is marked not received but its write-off entry is missing — ask the CEO to check the ledger', 409)
  }
  const je = await tx.journalEntry.findFirst({ where: { id: r.writeOffEntryId, tenantId: r.tenantId }, select: { reference: true } })
  const prefix = `${WRITE_OFF_SOURCE}:`
  if (!je?.reference?.startsWith(prefix)) {
    throw new AppError('RAAST_WRITE_OFF_MISSING', 'This Raast receipt\'s write-off entry was not found in its company\'s ledger', 409)
  }
  await reverseJournalEntry(r.tenantId, WRITE_OFF_SOURCE, je.reference.slice(prefix.length), reason, { tx, postedBy: actorId ?? 'system' })
}

/**
 * Pair one receipt with one statement line. The line is claimed first
 * (unmatched → matched); a receipt that is no longer matchable puts it back.
 * An 'unreceived' receipt's write-off is reversed first — when that is
 * refused (a closed period, a missing entry) the pass skips the pair.
 * Returns false when nothing was matched.
 */
async function matchPairTx(tx: Tx, r: RaastReceipt, line: PassLine, actorId: string | null, why: string): Promise<boolean> {
  const note = `Raast ${r.bankRef ?? ''} — order #${orderRefOf(r.orderId)}`.slice(0, 500)
  const claimedLine = await tx.bankStatementLine.updateMany({
    where: { id: line.id, matchStatus: 'unmatched' },
    data: { matchStatus: 'matched', matchedJournalLineId: null, notes: note },
  })
  if (claimedLine.count === 0) return false
  const unclaimLine = () => tx.bankStatementLine.updateMany({ where: { id: line.id }, data: { matchStatus: 'unmatched', notes: null } })

  if (r.status === 'unreceived') {
    try {
      await reverseWriteOffTx(tx, r, actorId, `Raast ${r.bankRef} found on the bank statement of ${fmtPktDate(line.postedDate)}`)
    } catch (err) {
      // An automatic pass skips the pair (finance sees it on the Raast tab);
      // finance's own match gets the refusal. A refusal is raised in code
      // before any write, so the transaction is still usable.
      if (err instanceof AppError && !actorId) { await unclaimLine(); return false }
      throw err
    }
  }
  const now = new Date()
  const done = await tx.raastReceipt.updateMany({
    where: { id: r.id, tenantId: r.tenantId, status: { in: MATCHABLE_STATUSES }, statementLineId: null },
    data: {
      status: 'matched', statementLineId: line.id, matchedAt: now, matchedById: actorId,
      ...(r.status === 'unreceived' && { writeOffEntryId: null }),
    },
  })
  if (done.count === 0) {
    if (r.status === 'unreceived') throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed while it was being matched — try again', 409)
    await unclaimLine()
    return false
  }
  await resolveRaastFlagsTx(tx, r.tenantId, ['raast_statement_mismatch', 'raast_unmatched'], 'RaastReceipt', r.id, why)
  return true
}

/**
 * Finance matches a receipt to a statement line by hand (S3's suggestion is
 * confirmed here — never automatic). Same company and receiving account, an
 * unmatched credit line of exactly the receipt's amount.
 */
export async function matchReceiptToLine(input: { receiptId: string; statementLineId: string; actorId: string; db?: typeof defaultPrisma }): Promise<RaastReceipt> {
  const db = input.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    const head = await tx.raastReceipt.findUnique({ where: { id: input.receiptId }, select: { tenantId: true } })
    if (!head) throw new NotFoundError('RaastReceipt', input.receiptId)
    await lockRaastTx(tx, head.tenantId)
    const r = await tx.raastReceipt.findUniqueOrThrow({ where: { id: input.receiptId } })
    if (!MATCHABLE_STATUSES.includes(r.status) || r.statementLineId) {
      throw new AppError('RAAST_NOT_MATCHABLE', `This Raast receipt is ${r.status} — only a provisional or not-received receipt can be matched`, 409)
    }
    const line = await tx.bankStatementLine.findUnique({
      where: { id: input.statementLineId },
      select: { id: true, postedDate: true, description: true, reference: true, amountCents: true, matchStatus: true, import: { select: { tenantId: true, bankAccountId: true } } },
    })
    if (!line || line.import.tenantId !== r.tenantId || line.import.bankAccountId !== r.bankAccountId) {
      throw new AppError('RAAST_LINE_NOT_ON_ACCOUNT', 'That statement line is not on this receipt\'s receiving bank account', 422)
    }
    if (line.matchStatus !== 'unmatched') throw new AppError('LINE_NOT_UNMATCHED', `That statement line is already ${line.matchStatus}`, 409)
    const amount = toCents(line.amountCents)
    if (amount !== r.amountCents) {
      throw new AppError('RAAST_AMOUNT_MISMATCH', `The statement line is ${pkr(amount)}; the receipt is ${pkr(r.amountCents)}. Only an equal amount can be matched.`, 422, { lineAmountCents: amount, receiptAmountCents: r.amountCents })
    }
    const ok = await matchPairTx(tx, r, { id: line.id, postedDate: line.postedDate, description: line.description, reference: line.reference, amountCents: amount }, input.actorId, 'Matched by finance')
    if (!ok) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt or the line changed meanwhile — refresh and try again', 409)
    return tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
  }, TX_OPTS)
}

/** Undo a match: the receipt goes back to provisional, the line to unmatched. */
export async function unmatchReceipt(input: { receiptId: string; actorId: string; db?: typeof defaultPrisma }): Promise<{ receipt: RaastReceipt; lineId: string }> {
  const db = input.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    const head = await tx.raastReceipt.findUnique({ where: { id: input.receiptId }, select: { tenantId: true } })
    if (!head) throw new NotFoundError('RaastReceipt', input.receiptId)
    await lockRaastTx(tx, head.tenantId)
    const r = await tx.raastReceipt.findUniqueOrThrow({ where: { id: input.receiptId } })
    if (r.status !== 'matched' || !r.statementLineId) throw new AppError('RAAST_NOT_MATCHED', 'This Raast receipt is not matched to a statement line', 409)
    const lineId = r.statementLineId
    await tx.raastReceipt.update({ where: { id: r.id }, data: { status: 'provisional', statementLineId: null, matchedAt: null, matchedById: null } })
    // 'ignored' too (RV-FIN-3 safety net): a line ignored by hand while it was
    // this receipt's match is freed with it, never stranded.
    await tx.bankStatementLine.updateMany({ where: { id: lineId, matchStatus: { in: ['matched', 'ignored'] } }, data: { matchStatus: 'unmatched', notes: null, matchedJournalLineId: null } })
    return { receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }), lineId }
  }, TX_OPTS)
}

// ─── Not received (write-off) ────────────────────────────────────────────────

/**
 * The entry that actually debited the bank for THIS receipt is posted — a
 * write-off before that would credit a bank code nothing debited
 * (RV-MONEY-1). Which entry depends on the order:
 *   - a till sale (source 'pos'): its drawer's LIVE close
 *     (shiftPosting.ts liveShiftCloses — a shift correction reverses a close
 *     and re-posts it as 'shift.close:<shiftId>@n'; a reversed revision books
 *     nothing). A live bill: the live close books it. A cancelled / rejected
 *     bill: the live close books it when it was posted while the sale still
 *     stood (before the cancel, or the cancel time is unknown), or when it
 *     holds the money as a refund due naming the order; a close re-posted
 *     after the cancel with no refund due for it (a shift correction voided
 *     the tender) does not;
 *   - any other order, live: only its completion debits the bank
 *     ('order.complete:<orderId>') — a drawer close books non-till CASH only;
 *   - any other order, cancelled / rejected: only a live drawer close that
 *     held its money as a refund due (Cr till clearing — 1110 before the
 *     company's cut-over, 1115 after; TILL_CLEARING_CODES holds both —
 *     'REFUND DUE …' naming the order).
 */
export async function saleBookedTx(db: Db, r: RaastReceipt): Promise<boolean> {
  const o = await db.order.findUnique({ where: { id: r.orderId }, select: { source: true, status: true, cancelledAt: true } })
  if (!o) return false
  const completion = () => db.journalEntry.findFirst({ where: { tenantId: r.tenantId, reference: `order.complete:${r.orderId}` }, select: { id: true } })
  const liveClose = async () => {
    if (!r.shiftId) return null
    const { liveShiftCloses } = await import('../accounting/shiftPosting.js')
    return (await liveShiftCloses(db, r.tenantId, [r.shiftId])).get(r.shiftId) ?? null
  }
  const heldAsRefundDue = async (entryId: string) => !!(await db.journalLine.findFirst({
    where: {
      journalEntryId: entryId, type: 'credit', account: { tenantId: r.tenantId, code: { in: TILL_CLEARING_CODES } },
      AND: [{ memo: { startsWith: REFUND_DUE_PREFIX } }, { memo: { contains: r.orderId } }],
    },
    select: { id: true },
  }))
  const cancelled = o.status === 'cancelled' || o.status === 'rejected'
  // (A till order with a receipt on a drawer never posts order.complete —
  // postOrderCompletion skips it — so accepting it here opens nothing.)
  if (o.source === 'pos') {
    if (await completion()) return true
    const close = await liveClose()
    if (!close) return false
    if (!cancelled) return true
    if (!o.cancelledAt || close.createdAt < o.cancelledAt) return true
    return heldAsRefundDue(close.id)
  }
  if (!cancelled) return !!(await completion())
  const close = await liveClose()
  if (!close) return false
  return heldAsRefundDue(close.id)
}

export async function writeOffUnreceived(input: {
  receiptId: string; actorId: string; reason: string
  /** Omitted → the company's till-clearing code (the customer owes it). */
  contraAccountCode?: WriteOffContra | null
  db?: typeof defaultPrisma
}): Promise<{ receipt: RaastReceipt; entryId: string; contraAccountCode: string }> {
  const db = input.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    const head = await tx.raastReceipt.findUnique({ where: { id: input.receiptId }, select: { tenantId: true } })
    if (!head) throw new NotFoundError('RaastReceipt', input.receiptId)
    await lockRaastTx(tx, head.tenantId)
    const r = await tx.raastReceipt.findUniqueOrThrow({ where: { id: input.receiptId } })
    if (r.status !== 'provisional') {
      throw new AppError('RAAST_NOT_PROVISIONAL', `This Raast receipt is ${r.status} — only a provisional receipt can be marked not received`, 409)
    }
    if (!(await saleBookedTx(tx, r))) {
      throw new AppError('RAAST_SALE_NOT_BOOKED', 'The sale is not on the books yet (its till shift is still open, or its posting failed) — close the shift first, then mark it not received', 409)
    }
    // "The customer owes it" goes to the company's till-clearing code as it
    // stands now (read inside the transaction): 1110 before the cut-over, 1115 after.
    const contra = !input.contraAccountCode || TILL_CLEARING_CONTRAS.has(input.contraAccountCode)
      ? await tillClearingCodeTx(tx, r.tenantId)
      : input.contraAccountCode
    const prior = await tx.journalEntry.count({ where: { tenantId: r.tenantId, reference: { startsWith: `${WRITE_OFF_SOURCE}:${r.id}` } } })
    const sourceId = prior === 0 ? r.id : `${r.id}:${prior + 1}`
    const memo = `${RAAST_RECEIPTS_MEMO} — not received, Ref ${r.bankRef ?? '-'} order #${orderRefOf(r.orderId)}`
    const posted = await postJournalEntry({
      tenantId: r.tenantId,
      sourceType: WRITE_OFF_SOURCE,
      sourceId,
      description: `Raast payment not received — order #${orderRefOf(r.orderId)}: ${input.reason}`.slice(0, 500),
      postedBy: input.actorId,
      reference: r.bankRef ?? undefined,
      lines: [
        { accountCode: contra, type: 'debit', amountCents: r.amountCents, memo, conceptId: r.conceptId },
        { accountCode: r.ledgerCode, type: 'credit', amountCents: r.amountCents, memo, conceptId: r.conceptId },
      ],
    }, { tx })
    const claimed = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'provisional' },
      data: { status: 'unreceived', writeOffEntryId: posted.entryId },
    })
    if (claimed.count === 0) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed meanwhile — refresh and try again', 409)
    await resolveRaastFlagsTx(tx, r.tenantId, ['raast_statement_mismatch', 'raast_unconfirmed', 'raast_needs_attention'], 'RaastReceipt', r.id, `Written off as not received: ${input.reason}`)
    return { receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }), entryId: posted.entryId, contraAccountCode: contra }
  }, TX_OPTS)
}

// ─── Void, never booked (RV-MONEY-1 — the CEO only) ─────────────────────────
//
// A PROVISIONAL receipt on a CANCELLED / REJECTED bill whose money no entry
// ever debited to the bank (not the drawer close, not order.complete, not a
// refund-due hold) — so "not received" (which credits the bank) would book a
// bank credit nothing debited. Finance may ASK (requestRaastVoid); only the
// CEO voids (voidNeverBooked) or rejects the ask. The receipt becomes
// 'voided' with the reason, who and when; NO ledger posting (finance books
// the statement credit, if the money did arrive, with the bank line's own
// adjustment, as for a resolved needs-attention receipt). The bank reference
// stays on the receipt, so the same transfer can never pay another bill
// (RAAST_REF_USED). A voided receipt stops counting for the period close
// (raastOpenThrough) and the daily flag. Refused (409) unless:
//   RAAST_NOT_PROVISIONAL      the receipt is provisional;
//   RAAST_SALE_BOOKED          no entry debited the bank for it (saleBookedTx —
//                              when one did, use "not received");
//   RAAST_ORDER_NOT_CANCELLED  the bill is cancelled or rejected;
//   RAAST_CLOSE_PENDING        every till drawer holding the bill's payments
//                              or the receipt is closed, with no open
//                              posting_failed flag on it or on the bill (the
//                              close might still book it);
//   RAAST_REFUND_EXISTS        no refund row on the bill was paid back against
//                              this receipt (gatewayMeta.raast.receiptId) —
//                              that money already left the bank on the books.

export interface RaastVoidRefusal { code: string; message: string }

/** Why `r` cannot be voided, or null when it can (read only; see above). */
export async function raastVoidEligibilityTx(db: Db, r: RaastReceipt): Promise<RaastVoidRefusal | null> {
  const ref = orderRefOf(r.orderId)
  if (r.status !== 'provisional') {
    return { code: 'RAAST_NOT_PROVISIONAL', message: `This Raast receipt is ${r.status} — only a provisional receipt can be voided` }
  }
  if (await saleBookedTx(db, r)) {
    return { code: 'RAAST_SALE_BOOKED', message: `Bill #${ref}'s Raast money is on the books (an entry debited the bank for it) — mark it not received instead` }
  }
  const o = await db.order.findUnique({ where: { id: r.orderId }, select: { status: true, payments: { select: { shiftId: true } } } })
  if (!o || (o.status !== 'cancelled' && o.status !== 'rejected')) {
    return { code: 'RAAST_ORDER_NOT_CANCELLED', message: `Bill #${ref} is ${o?.status ?? 'missing'} — only a receipt on a cancelled or rejected bill can be voided` }
  }
  const shiftIds = [...new Set([r.shiftId, ...o.payments.map((p) => p.shiftId)].filter((x): x is string => !!x))]
  if (shiftIds.length > 0) {
    const open = await db.shift.count({ where: { id: { in: shiftIds }, status: { not: 'closed' } } })
    if (open > 0) {
      return { code: 'RAAST_CLOSE_PENDING', message: `A till drawer that took bill #${ref}'s money is still open — its close may book it; close the drawer first` }
    }
  }
  const failed = await db.exceptionFlag.count({
    where: {
      kind: 'posting_failed', status: { in: ['open', 'acknowledged'] },
      OR: [{ entityType: 'Order', entityId: r.orderId }, ...(shiftIds.length > 0 ? [{ entityType: 'Shift', entityId: { in: shiftIds } }] : [])],
    },
  })
  if (failed > 0) {
    return { code: 'RAAST_CLOSE_PENDING', message: `A drawer close or posting for bill #${ref} was refused and is waiting to be re-posted (Reconciliation → Backfill unposted) — it may book this money` }
  }
  const refund = await db.payment.findFirst({
    where: { orderId: r.orderId, status: 'refunded', gatewayMeta: { path: ['raast', 'receiptId'], equals: r.id } },
    select: { id: true },
  })
  if (refund) {
    return { code: 'RAAST_REFUND_EXISTS', message: `Money was already paid back against this Raast receipt (refund on bill #${ref}) — it cannot be voided` }
  }
  return null
}

async function lockedReceiptTx(tx: Tx, receiptId: string): Promise<RaastReceipt> {
  const head = await tx.raastReceipt.findUnique({ where: { id: receiptId }, select: { tenantId: true } })
  if (!head) throw new NotFoundError('RaastReceipt', receiptId)
  await lockRaastTx(tx, head.tenantId)
  return tx.raastReceipt.findUniqueOrThrow({ where: { id: receiptId } })
}

async function assertVoidableTx(tx: Tx, r: RaastReceipt): Promise<void> {
  const no = await raastVoidEligibilityTx(tx, r)
  if (no) throw new AppError(no.code, no.message, 409)
}

/** Finance asks the CEO to void a receipt (the same checks as the void). */
export async function requestRaastVoid(receiptId: string, a: { actorId: string; reason: string; db?: typeof defaultPrisma }): Promise<{ before: RaastReceipt; receipt: RaastReceipt }> {
  const db = a.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    const r = await lockedReceiptTx(tx, receiptId)
    await assertVoidableTx(tx, r)
    if (r.voidRequestedAt) throw new AppError('RAAST_VOID_ALREADY_REQUESTED', 'A void of this receipt is already waiting for the CEO', 409)
    const done = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'provisional', voidRequestedAt: null },
      data: { voidRequestedAt: new Date(), voidRequestedById: a.actorId, voidRequestReason: a.reason.trim().slice(0, 500) },
    })
    if (done.count === 0) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed meanwhile — refresh and try again', 409)
    return { before: r, receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }) }
  }, TX_OPTS)
}

/** The CEO turns down a void request: it is cleared (the receipt stays provisional). */
export async function rejectRaastVoidRequest(receiptId: string, a: { actorId: string; note: string; db?: typeof defaultPrisma }): Promise<{ before: RaastReceipt; receipt: RaastReceipt }> {
  const db = a.db ?? defaultPrisma
  return db.$transaction(async (tx) => {
    const r = await lockedReceiptTx(tx, receiptId)
    if (!r.voidRequestedAt || r.status !== 'provisional') {
      throw new AppError('RAAST_NO_VOID_REQUEST', 'No void of this receipt is waiting for the CEO', 409)
    }
    const done = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'provisional', voidRequestedAt: { not: null } },
      data: { voidRequestedAt: null, voidRequestedById: null, voidRequestReason: null },
    })
    if (done.count === 0) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed meanwhile — refresh and try again', 409)
    return { before: r, receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }) }
  }, TX_OPTS)
}

/**
 * The CEO voids a provisional receipt whose sale was never booked (see
 * above): provisional → voided, conditionally, under the Raast lock. NO
 * ledger posting; the bank reference stays claimed; the receipt's raast_*
 * flags are resolved and the company's daily raast_unmatched flag refreshed.
 */
export async function voidNeverBooked(receiptId: string, a: { actorId: string; reason: string; db?: typeof defaultPrisma }): Promise<RaastReceipt> {
  const db = a.db ?? defaultPrisma
  const reason = a.reason.trim().slice(0, 500)
  const receipt = await db.$transaction(async (tx) => {
    const r = await lockedReceiptTx(tx, receiptId)
    await assertVoidableTx(tx, r)
    const done = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'provisional', statementLineId: null },
      data: { status: 'voided', voidedAt: new Date(), voidedById: a.actorId, voidReason: reason },
    })
    if (done.count === 0) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed meanwhile — refresh and try again', 409)
    await resolveRaastFlagsTx(tx, r.tenantId, ['raast_statement_mismatch', 'raast_unconfirmed', 'raast_needs_attention'], 'RaastReceipt', r.id, `Voided by the CEO (never booked): ${reason}`)
    return tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
  }, TX_OPTS)
  await flagUnmatchedReceipts(receipt.tenantId, { db }).catch((err) => console.warn('[raast] flag refresh after a void failed:', (err as Error).message))
  return receipt
}

// ─── Resolve a needs-attention receipt (RV-FIN-1) ───────────────────────────

export const ATTENTION_OUTCOMES = ['refunded_to_customer', 'not_a_sale', 'booked_elsewhere'] as const
export type AttentionOutcome = (typeof ATTENTION_OUTCOMES)[number]

const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'refunded', 'rejected'] as const

/**
 * Finance clears a 'needs_attention' receipt that never took a payment (an
 * SMS reached the bill but the settle was refused, then the bill was paid
 * another way or closed). The till can no longer clear it, and without this it
 * would hold every later period close (raastOpenThrough). No ledger posting:
 * the transfer was never booked — finance books the statement credit (and the
 * refund going out) with the statement line's own adjustment.
 *
 * The receipt → 'cancelled' with the outcome as its reason; its bank SMS, if
 * still open, is closed as finance's and its reference CLAIMED (M4) so it can
 * never pay a bill afterwards. While the order is still open the till must
 * attach or cancel it instead (409 RAAST_ATTACH_AT_TILL).
 */
export async function resolveAttentionReceipt(input: {
  receiptId: string; actorId: string; outcome: AttentionOutcome; reason: string; refundReference?: string | null; db?: typeof defaultPrisma
}): Promise<{ before: RaastReceipt; receipt: RaastReceipt; alertId: string | null; refundReference: string | null }> {
  const db = input.db ?? defaultPrisma
  const reason = input.reason.trim()
  const refundReference = input.refundReference ? (normalizeBankRef(input.refundReference) || null) : null
  return db.$transaction(async (tx) => {
    const head = await tx.raastReceipt.findUnique({ where: { id: input.receiptId }, select: { tenantId: true } })
    if (!head) throw new NotFoundError('RaastReceipt', input.receiptId)
    await lockRaastTx(tx, head.tenantId)
    const r = await tx.raastReceipt.findUniqueOrThrow({ where: { id: input.receiptId } })
    if (r.status !== 'needs_attention' || r.paymentId) {
      throw new AppError('RAAST_NOT_ATTENTION', `This Raast receipt is ${r.status} — only a needs-attention receipt with no payment can be resolved here`, 409, { status: r.status })
    }
    const o = await tx.order.findUnique({ where: { id: r.orderId }, select: { status: true } })
    if (o && !(CLOSED_ORDER_STATUSES as readonly string[]).includes(o.status)) {
      throw new AppError('RAAST_ATTACH_AT_TILL', `Bill #${orderRefOf(r.orderId)} is still open — attach the bank alert or cancel the request at the till`, 409, { orderStatus: o.status })
    }
    const alertId = r.smsAlertId
    const why = `finance:${input.outcome}: ${reason}${refundReference ? ` (refund ref ${refundReference})` : ''}`.slice(0, 500)
    const moved = await tx.raastReceipt.updateMany({
      where: { id: r.id, status: 'needs_attention', paymentId: null },
      data: { status: 'cancelled', cancelReason: why, smsAlertId: null, settlingUntil: null, expiresAt: null },
    })
    if (moved.count === 0) throw new AppError('RAAST_RECEIPT_CHANGED', 'The receipt changed meanwhile — refresh and try again', 409)

    if (alertId) {
      const a = await tx.bankSmsAlert.findUnique({ where: { id: alertId }, select: { id: true, tenantId: true, status: true, bankRef: true } })
      // Close the SMS as finance's and claim its reference: this transfer was
      // handled outside a bill and can never pay one later (M4).
      if (a && a.tenantId === r.tenantId && (OPEN_ALERT_STATUSES as readonly string[]).includes(a.status) && a.status !== 'processing') {
        const taken = a.bankRef ? await tx.bankSmsAlert.findFirst({ where: { tenantId: r.tenantId, claimedRef: a.bankRef }, select: { id: true } }) : null
        const used = a.bankRef ? await tx.raastReceipt.findFirst({ where: { tenantId: r.tenantId, bankRef: a.bankRef }, select: { id: true } }) : null
        await tx.bankSmsAlert.update({
          where: { id: a.id },
          data: {
            status: 'dismissed', claimedRef: a.bankRef && !taken && !used ? a.bankRef : null, candidateIds: [],
            resolvedById: input.actorId, resolvedAt: new Date(), resolution: `Finance: ${input.outcome.replace(/_/g, ' ')} — ${reason}`.slice(0, 300),
          },
        })
      }
      await resolveRaastFlagsTx(tx, r.tenantId, ['raast_needs_attention', 'raast_sms_unmatched'], 'BankSmsAlert', alertId, `Resolved by finance: ${input.outcome}`)
    }
    await resolveRaastFlagsTx(tx, r.tenantId, ['raast_needs_attention', 'raast_unconfirmed'], 'RaastReceipt', r.id, `Resolved by finance: ${input.outcome}: ${reason}`)
    return { before: r, receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }), alertId, refundReference }
  }, TX_OPTS)
}

// ─── Fix a typed reference (M4: approvers, the same checks as the till) ─────

export async function fixReceiptReference(input: {
  receiptId: string; actorId: string; bankRefRaw: string; db?: typeof defaultPrisma
}): Promise<{ before: string | null; receipt: RaastReceipt; smsConfirmed: boolean; statementMatched: boolean }> {
  const db = input.db ?? defaultPrisma
  let otherOrder: string | null = null
  try {
    return await db.$transaction(async (tx) => {
      const head = await tx.raastReceipt.findUnique({ where: { id: input.receiptId }, select: { tenantId: true } })
      if (!head) throw new NotFoundError('RaastReceipt', input.receiptId)
      await lockRaastTx(tx, head.tenantId)
      const r = await tx.raastReceipt.findUniqueOrThrow({ where: { id: input.receiptId } })
      if (r.status !== 'provisional') {
        throw new AppError('RAAST_NOT_PROVISIONAL', `This Raast receipt is ${r.status} — only a provisional receipt's reference can be fixed (unmatch it first)`, 409)
      }
      if (r.smsAlertId) {
        throw new AppError('RAAST_SMS_CONFIRMED', 'The bank SMS already confirmed this reference — it cannot be changed', 409)
      }
      const settings = await raastFinanceSettings(tx, r.tenantId)
      const ref = cleanBankRef(input.bankRefRaw, { orderId: r.orderId, min: settings.refMin, max: settings.refMax })
      if (ref === r.bankRef) throw new AppError('RAAST_REF_UNCHANGED', 'That is already the receipt\'s reference', 422)
      // M4: a transfer a manager dismissed as "not a sale" (or money going out)
      // can never pay a bill.
      await assertRefNotClaimedTx(tx, r.tenantId, ref)
      const other = await tx.raastReceipt.findFirst({ where: { tenantId: r.tenantId, bankRef: ref, id: { not: r.id } }, select: { orderId: true } })
      if (other) {
        otherOrder = other.orderId
        throw new AppError('RAAST_REF_USED', `That bank reference already paid bill #${orderRefOf(other.orderId)}`, 409, { orderRef: orderRefOf(other.orderId) })
      }
      // The same SMS cross-check as the till (SMS matching on): an eligible
      // credit SMS of that reference must carry the same amount.
      let smsAlertId: string | null = null
      if (settings.smsOn) {
        const sms = await findSmsForRefTx(tx, r.tenantId, ref, { bankAccountId: r.bankAccountId, createdAt: r.createdAt, id: r.id })
        if (sms) {
          if (Math.abs(sms.amountCents - r.amountCents) > RAAST_TOLERANCE_CENTS) {
            throw new AppError('RAAST_AMOUNT_MISMATCH', `The bank SMS for that reference is ${pkr(sms.amountCents)}; the receipt is ${pkr(r.amountCents)}`, 422, { smsAmountCents: sms.amountCents })
          }
          smsAlertId = sms.id
        }
      }
      await tx.raastReceipt.update({ where: { id: r.id }, data: { bankRef: ref, bankRefRaw: input.bankRefRaw.slice(0, 80) } })
      if (r.paymentId) await tx.payment.update({ where: { id: r.paymentId }, data: { gatewayRef: ref } })
      if (smsAlertId) await linkAlertTx(tx, smsAlertId, r.id, 'confirmed', input.actorId)

      // Re-run the statement match for this receipt on its account's lines
      // around its date (still exactly-one-or-nothing).
      const n = settings.statementMatchDays
      const at = receiptAt(r).getTime()
      const rows = await tx.bankStatementLine.findMany({
        where: {
          matchStatus: 'unmatched', amountCents: { gt: 0 },
          postedDate: { gte: new Date(at - (n + 1) * DAY_MS), lte: new Date(at + (n + 1) * DAY_MS) },
          import: { tenantId: r.tenantId, bankAccountId: r.bankAccountId },
        },
        select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
      })
      const pass = await raastPassTx(tx, {
        tenantId: r.tenantId, bankAccountId: r.bankAccountId, actorId: null, onlyReceiptId: r.id,
        lines: rows.map((l) => ({ ...l, amountCents: toCents(l.amountCents) })),
      })
      return {
        before: r.bankRef,
        receipt: await tx.raastReceipt.findUniqueOrThrow({ where: { id: r.id } }),
        smsConfirmed: !!smsAlertId,
        statementMatched: pass.matched > 0,
      }
    }, TX_OPTS)
  } catch (err) {
    // A racing write of the same reference: the unique key decides.
    if ((err as { code?: string }).code === 'P2002') {
      throw new AppError('RAAST_REF_USED', otherOrder ? `That bank reference already paid bill #${orderRefOf(otherOrder)}` : 'That bank reference already paid another bill', 409)
    }
    throw err
  }
}

// ─── The daily flag (spec §7.3) ──────────────────────────────────────────────

/**
 * ONE open raast_unmatched flag per bank account of the company: provisional
 * receipts older than provisionalFlagDays that no statement has matched,
 * with the count, the total, the oldest and the last statement imported for
 * that account ("no statement imported since …" when that is the cause).
 * Resolved when the count is 0. Returns the accounts flagged.
 */
export async function flagUnmatchedReceipts(tenantId: string, opts: { db?: typeof defaultPrisma; now?: Date } = {}): Promise<number> {
  const db = opts.db ?? defaultPrisma
  const now = opts.now ?? new Date()
  const { provisionalFlagDays } = await raastFinanceSettings(db, tenantId)
  const cutoff = new Date(now.getTime() - provisionalFlagDays * DAY_MS)
  const old = await db.raastReceipt.findMany({
    where: {
      tenantId, status: 'provisional',
      OR: [{ confirmedAt: { lt: cutoff } }, { confirmedAt: null, createdAt: { lt: cutoff } }],
    },
    select: { bankAccountId: true, amountCents: true, confirmedAt: true, createdAt: true },
  })
  const byAccount = new Map<string, { count: number; totalCents: number; oldestAt: Date }>()
  for (const r of old) {
    const at = receiptAt(r)
    const s = byAccount.get(r.bankAccountId) ?? { count: 0, totalCents: 0, oldestAt: at }
    s.count++
    s.totalCents += r.amountCents
    if (at < s.oldestAt) s.oldestAt = at
    byAccount.set(r.bankAccountId, s)
  }

  // Clear the accounts that no longer have any.
  const open = await db.exceptionFlag.findMany({
    where: { tenantId, kind: 'raast_unmatched', entityType: 'BankAccount', status: { in: ['open', 'acknowledged'] } },
    select: { entityId: true },
  })
  for (const f of open) {
    if (f.entityId && !byAccount.has(f.entityId)) {
      await resolveRaastFlagsTx(db, tenantId, ['raast_unmatched'], 'BankAccount', f.entityId, 'Every Raast receipt on this account is matched or cleared')
    }
  }
  if (byAccount.size === 0) return 0

  const accounts = await db.bankAccount.findMany({
    where: { tenantId, id: { in: [...byAccount.keys()] } },
    select: { id: true, name: true, bankName: true },
  })
  const nameOf = new Map(accounts.map((a) => [a.id, a.bankName ? `${a.name} (${a.bankName})` : a.name]))
  let flagged = 0
  for (const [bankAccountId, s] of byAccount) {
    const last = await db.bankStatementImport.findFirst({
      where: { tenantId, bankAccountId }, orderBy: { statementDate: 'desc' }, select: { statementDate: true },
    })
    const lastStatementDate = last?.statementDate ?? null
    const noStatement = !lastStatementDate || lastStatementDate < s.oldestAt
    const name = nameOf.get(bankAccountId) ?? 'a bank account'
    const cause = !lastStatementDate
      ? `No statement has been imported for ${name} yet — import it in Finance → Reconciliation.`
      : noStatement
        ? `No statement imported since ${fmtPktDate(lastStatementDate)} — import the latest one in Finance → Reconciliation.`
        : `The statement up to ${fmtPktDate(lastStatementDate)} does not show them — check each on the Raast tab (match, fix the reference, or mark not received).`
    const res = await raiseRaastFlagTx(db, {
      tenantId, kind: 'raast_unmatched', severity: s.count >= 10 || now.getTime() - s.oldestAt.getTime() > 7 * DAY_MS ? 'high' : 'medium',
      title: `${s.count} Raast payment(s) not on a bank statement — ${name}`,
      description: `${s.count} Raast payment(s), ${pkr(s.totalCents)} in all, older than ${provisionalFlagDays} day(s) (oldest ${fmtPktDate(s.oldestAt)}). ${cause}`,
      entityType: 'BankAccount', entityId: bankAccountId, amountCents: s.totalCents,
      metadata: {
        count: s.count, totalCents: s.totalCents, oldestAt: s.oldestAt.toISOString(),
        lastStatementDate: lastStatementDate ? fmtPktDate(lastStatementDate) : null, noStatement,
      },
    })
    flagged++
    if (res.created) void notifyConnectorPeople(tenantId, 'raast_finance', `servd: ${s.count} Raast payment(s) (${pkr(s.totalCents)}) on ${name} are not on a bank statement yet. ${cause}`)
  }
  return flagged
}

/** The open-to-finance Raast figure for a period close (S6): provisional / needs attention through `through`. */
export async function raastOpenThrough(db: Db, tenantId: string, through: Date): Promise<{ count: number; cents: number }> {
  return raastOpenBetween(db, tenantId, null, through)
}

/** COALESCE(confirmedAt, createdAt) in [from, to] (from null = no lower bound). */
function raastDayWhere(from: Date | null, to: Date): Prisma.RaastReceiptWhereInput {
  const at = { ...(from ? { gte: from } : {}), lte: to }
  return { OR: [{ confirmedAt: at }, { confirmedAt: null, createdAt: at }] }
}

/**
 * Raast receipts still open to finance (provisional / needs attention — not on
 * a bank statement yet), dated by their confirmation, else their creation, in
 * [from, to]. The month close (raastOpenThrough) and the night audit's
 * settlement step (raast_unmatched_day) share it.
 */
export async function raastOpenBetween(db: Db, tenantId: string, from: Date | null, to: Date): Promise<{ count: number; cents: number }> {
  const agg = await db.raastReceipt.aggregate({
    where: { tenantId, status: { in: OPEN_FINANCE_STATUSES }, ...raastDayWhere(from, to) },
    _count: true,
    _sum: { amountCents: true },
  })
  return { count: agg._count, cents: agg._sum.amountCents ?? 0 }
}

/**
 * The night audit's same-night Raast check (raast_open_night; owner question
 * Q1): receipts of the day still 'awaiting' (an intent the customer never
 * finished) or 'needs_attention'. With bank-SMS matching ON (`smsOn`), a
 * 'provisional' receipt no SMS confirmed and no statement matched counts too.
 * The statement match itself is the settlement step's (raastOpenBetween).
 */
export async function raastNightOpenBetween(db: Db, tenantId: string, from: Date, to: Date, smsOn: boolean): Promise<{ count: number; cents: number }> {
  const agg = await db.raastReceipt.aggregate({
    where: {
      tenantId,
      AND: [
        raastDayWhere(from, to),
        {
          OR: [
            { status: { in: ['awaiting', 'needs_attention'] } },
            ...(smsOn ? [{ status: 'provisional' as const, smsConfirmedAt: null, smsAlertId: null, statementLineId: null }] : []),
          ],
        },
      ],
    },
    _count: true,
    _sum: { amountCents: true },
  })
  return { count: agg._count, cents: agg._sum.amountCents ?? 0 }
}
