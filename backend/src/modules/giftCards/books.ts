// Gift cards in the books (finance gaps #7, 2026-10-13).
//
// 2080 Gift Card Liability is what a company owes the holders of the cards it
// issued. Every movement of a card's value has its entry, in the CARD's
// company (GiftCard.tenantId), never the operator's:
//
//   issue  'giftcard.issue:<card>' — in the SAME transaction as the card, so a
//          refused entry means no card (it used to be .catch(log): the card was
//          live, its spend later debited 2080, and 2080 went debit-negative).
//            sold        Dr 1010 cash | 1030 card | the bank's own code / Cr 2080
//            promotional Dr 6060 Marketing & Promo                     / Cr 2080
//   spend  the sale the order becomes debits 2080 for the card-paid share
//          (accounting/orderPosting computeSaleAccounting, ONL-05).
//   refund a refund that puts value back on the card: Dr revenue / tax shares,
//          Cr 2080 ('order.refund_giftcard'). It never reopens a voided or
//          expired card — the value waits on that card for a manager to settle.
//   void   'giftcard.void:<card>' (then '@2', '@3' … when a refund later put
//          value back on the voided card and it is settled again), row-locked,
//          the balance claimed in the same transaction:
//            refund               Dr 2080 / Cr 1010 | 1030 | the bank's code
//            payment_not_received Dr 2080 / Cr the account the issue debited
//            forfeit  promotional: Dr 2080 / Cr 6060 (any manager)
//                     sold:        Dr 2080 / Cr 4200 Gift Card Breakage — the
//                                  CEO (role admin) only (403 FORFEIT_NEEDS_CEO
//                                  for anyone else; H11), breakageCents += B.
//   expiry 'giftcard.expire:<card>' — breakage (owner + accountant, H11), in
//          the nightly sweep (workers/giftCardExpiry.ts → expireDueGiftCards →
//          expireOneGiftCard), ONE row-locked transaction per card:
//            status expired / expiredAt, the balance B claimed to 0,
//            GiftCard.breakageCents += B / breakageAt, and
//            sold        Dr 2080 / Cr 4200 Gift Card Breakage (other income,
//                        no sales tax)
//            promotional Dr 2080 / Cr 6060 Marketing & Promo (its cost back)
//          tagged with the card's brand, dated the sweep (today, open month).
//          Breakage is taken ONCE, at the card's FIRST expiry. Value a refund
//          later puts back on an expired card is never swept: it waits on the
//          card (books check → expiredHoldingValue) for a manager to settle
//          through Void (refund, or forfeit by the CEO).
//          HELD breakage — the card still expires, its balance stays in 2080,
//          GiftCard.breakagePendingAt / breakagePendingReason are set and the
//          next sweep (and the 'giftcard.expire' re-poster) retries it:
//            • ISSUE_NOT_BOOKED — the card's own 'giftcard.issue' entry never
//              posted (taking 2080 down for value that never went in would
//              leave 2080 short for good): flag 'gift_card_breakage_held';
//              book the sale first (Books check → Book the sale).
//            • the posting was refused (e.g. 4200 missing / inactive): the
//              balance claim rolls back, flag 'posting_failed' (sourceType
//              'giftcard.expire', entity GiftCard, sourceId = the card id).
//          A card that expired before breakage existed (status expired,
//          breakageAt null) is treated as held and booked on the next sweep.
//
// Money moved outside a till: a sold card is a back-office receipt. Cash is
// cash on hand / the safe (1010), never a till drawer (1015): lib/drawer.ts
// counts only a shift's own payments and cash movements, so a card sold for
// cash at a counter would leave that drawer "over" with 1010 debited for money
// nobody put in the safe. Hence only the back office (managers + finance)
// sells cards, and only managers give promotional ones (routes.ts).

import type { Prisma, PrismaClient, GiftCard, GiftCardKind, GiftCardStatus } from '@prisma/client'
import { randomBytes } from 'crypto'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { moneyAccountCode, ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { toCents } from '../../lib/money.js'
import { withSavepoint } from '../../lib/savepoint.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { postJournalEntry, flagPostingFailed, resolvePostingFailed, ACCT } from '../accounting/journal.js'

type Tx = Prisma.TransactionClient
/** The client a sweep runs on (the worker passes serviceClient — no RLS context). */
export type GiftCardDb = PrismaClient

export const GIFT_CARD_LIABILITY_CODE = '2080'
/** Marketing & Promo — a promotional card's cost, and its unspent value back. */
export const PROMO_EXPENSE_CODE = '6060'
/** Gift Card Breakage (other income, no sales tax — H11): a SOLD card's value kept at expiry or a CEO forfeit. */
export const BREAKAGE_INCOME_CODE: string = ACCT.GIFT_CARD_BREAKAGE
/** The breakage posting's sourceType ('giftcard.expire:<cardId>', once per card). */
export const EXPIRE_SOURCE = 'giftcard.expire'
/** The exception kind of breakage held back because the card's sale is not in the books. */
const BREAKAGE_HELD_KIND = 'gift_card_breakage_held' as const
/** Why breakage is held (GiftCard.breakagePendingReason). */
export const BREAKAGE_HELD = { ISSUE_NOT_BOOKED: 'ISSUE_NOT_BOOKED', POSTING_REFUSED: 'POSTING_REFUSED' } as const

export const GIFT_CARD_PAYMENT_METHODS = ['cash', 'card', 'bank_transfer'] as const
export type GiftCardPaymentMethod = typeof GIFT_CARD_PAYMENT_METHODS[number]
export const VOID_DISPOSITIONS = ['refund', 'payment_not_received', 'forfeit'] as const
export type VoidDisposition = typeof VOID_DISPOSITIONS[number]

const ISSUE_SOURCE = 'giftcard.issue'
const VOID_SOURCE = 'giftcard.void'
const issueRef = (cardId: string) => `${ISSUE_SOURCE}:${cardId}`

// ── Codes ────────────────────────────────────────────────────────────────────
// 12 chars in groups of 4 (GS-XXXX-XXXX) from a 32-char alphabet with no
// 0/O/1/I. CSPRNG bytes — Math.random's state is recoverable from a handful of
// outputs, so a leaked code could expose the PRNG and future cards.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
function generateCode(): string {
  let block = ''
  const bytes = randomBytes(8)
  for (let i = 0; i < 8; i++) block += ALPHABET[bytes[i]! % ALPHABET.length]
  return `GS-${block.slice(0, 4)}-${block.slice(4)}`
}

/** Lock one card row for the rest of `tx` (the void, the refund re-credit and the expiry sweep take it). */
export async function lockGiftCardTx(tx: Tx, cardId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM gift_cards WHERE id = ${cardId} FOR UPDATE`
}

// ── Issue ────────────────────────────────────────────────────────────────────

export interface IssueGiftCardInput {
  /** The ACTIVE company — the card and its entry belong to it. */
  tenantId: string
  kind: 'sold' | 'promotional'
  issuedAmountCents: number
  paymentMethod?: GiftCardPaymentMethod | null
  bankAccountId?: string | null
  /** Why a promotional card was given (required for one). Kept on the entry and the audit row. */
  reason?: string | null
  conceptId?: string | null
  expiresAt?: Date | null
  buyerCustomerId?: string | null
  buyerEmail?: string | null
  recipientName?: string | null
  recipientEmail?: string | null
  message?: string | null
  issuedById: string | null
}

/**
 * Create a card and its 'giftcard.issue' entry in ONE transaction. A chart
 * problem (2080 missing or inactive) or a foreign bank account refuses the
 * whole thing: no card without its liability.
 */
export async function issueGiftCard(input: IssueGiftCardInput): Promise<GiftCard> {
  if (input.kind === 'promotional') {
    if (input.paymentMethod || input.bankAccountId) {
      throw new AppError('PROMO_CARD_NOT_PAID', 'A promotional card is given away — it takes no payment method or bank account', 422)
    }
    if (!input.reason?.trim()) {
      throw new AppError('REASON_REQUIRED', 'Say why this promotional card is being given', 422)
    }
  } else if (!input.paymentMethod) {
    throw new AppError('PAYMENT_METHOD_REQUIRED', 'Say how the customer paid for the card', 422)
  }

  return prisma.$transaction(async (tx) => {
    // Which account the money went into: cash on hand, card receivable, or a
    // live linked bank of THIS company (422 for another company's or a
    // deleted / unlinked one — lib/bankAccounts.ts).
    const debit = input.kind === 'promotional'
      ? { code: PROMO_EXPENSE_CODE, bankAccountId: null }
      : await moneyAccountCode(tx, input.tenantId, { method: input.paymentMethod!, bankAccountId: input.bankAccountId ?? null })

    let code = generateCode()
    for (let i = 0; i < 5; i++) {
      if (!(await tx.giftCard.findUnique({ where: { code }, select: { id: true } }))) break
      code = generateCode()
    }

    const card = await tx.giftCard.create({
      data: {
        tenantId: input.tenantId,
        code,
        kind: input.kind,
        issuedAmountCents: input.issuedAmountCents,
        balanceCents: input.issuedAmountCents,
        paymentMethod: input.kind === 'promotional' ? null : input.paymentMethod!,
        bankAccountId: debit.bankAccountId,
        buyerCustomerId: input.buyerCustomerId ?? null,
        buyerEmail: input.buyerEmail ?? null,
        recipientName: input.recipientName ?? null,
        recipientEmail: input.recipientEmail ?? null,
        message: input.message ?? null,
        conceptId: input.conceptId ?? null,
        expiresAt: input.expiresAt ?? null,
        issuedById: input.issuedById,
      },
    })

    const promo = input.kind === 'promotional'
    await postJournalEntry({
      tenantId: input.tenantId,
      sourceType: ISSUE_SOURCE,
      sourceId: card.id,
      entryDate: card.createdAt,
      description: promo
        ? `Promotional gift card ${card.code} — ${input.reason!.trim().slice(0, 200)}`
        : `Gift card sold · ${card.code} (${input.paymentMethod})`,
      postedBy: input.issuedById ?? 'system',
      lines: [
        { accountCode: debit.code, type: 'debit', amountCents: card.issuedAmountCents,
          memo: promo ? `Promotional gift card ${card.code}` : `Gift card ${card.code} paid by ${input.paymentMethod}`, conceptId: card.conceptId },
        { accountCode: GIFT_CARD_LIABILITY_CODE, type: 'credit', amountCents: card.issuedAmountCents,
          memo: `Gift card liability ${card.code}`, conceptId: card.conceptId },
      ],
    }, { tx })

    return card
  })
}

/**
 * Book the sale of a card whose 'giftcard.issue' entry never posted (before
 * 2026-10-13 the entry was .catch(log)'d after the card was created). Dated on
 * the card's own day; if that period is closed, today. 409 when it is already
 * booked; promotional cards are always booked at issue.
 */
export async function bookMissingIssue(input: {
  cardId: string
  scope: TenantIdWhere
  paymentMethod: GiftCardPaymentMethod
  bankAccountId?: string | null
  postedBy: string
}): Promise<{ card: GiftCard; entryId: string; debitCode: string }> {
  return prisma.$transaction(async (tx) => {
    await lockGiftCardTx(tx, input.cardId)
    const card = await tx.giftCard.findFirst({ where: { id: input.cardId, ...input.scope } })
    if (!card || !card.tenantId) throw new NotFoundError('GiftCard', input.cardId)
    if (card.kind === 'promotional') throw new AppError('PROMO_CARD_NOT_PAID', 'A promotional card takes no payment', 422)
    const tenantId = card.tenantId
    const existing = await tx.journalEntry.findFirst({ where: { tenantId, reference: issueRef(card.id) }, select: { id: true } })
    if (existing) throw new AppError('ISSUE_ALREADY_BOOKED', `The sale of ${card.code} is already in the books`, 409)

    const debit = await moneyAccountCode(tx, tenantId, { method: input.paymentMethod, bankAccountId: input.bankAccountId ?? null })
    const lines = [
      { accountCode: debit.code, type: 'debit' as const, amountCents: card.issuedAmountCents, memo: `Gift card ${card.code} paid by ${input.paymentMethod}`, conceptId: card.conceptId },
      { accountCode: GIFT_CARD_LIABILITY_CODE, type: 'credit' as const, amountCents: card.issuedAmountCents, memo: `Gift card liability ${card.code}`, conceptId: card.conceptId },
    ]
    const entry = (entryDate: Date) => ({
      tenantId, sourceType: ISSUE_SOURCE, sourceId: card.id, entryDate, postedBy: input.postedBy, lines,
      description: `Gift card sold · ${card.code} (${input.paymentMethod}) — booked late`,
    })
    // The period lock is read before anything is written, so a refusal leaves
    // the transaction clean for the second try.
    const posted = await postJournalEntry(entry(card.createdAt), { tx }).catch(async (err: unknown) => {
      if (err instanceof AppError && err.code === 'PERIOD_LOCKED') return postJournalEntry(entry(new Date()), { tx })
      throw err
    })
    const updated = await tx.giftCard.update({
      where: { id: card.id },
      data: { paymentMethod: card.paymentMethod ?? input.paymentMethod, bankAccountId: card.bankAccountId ?? debit.bankAccountId },
    })
    return { card: updated, entryId: posted.entryId, debitCode: debit.code }
  })
}

// ── Void ─────────────────────────────────────────────────────────────────────

export interface VoidGiftCardInput {
  cardId: string
  /** The operator's companies in 'write' mode — another company's card is 404. */
  scope: TenantIdWhere
  reason: string
  disposition: VoidDisposition
  refundMethod?: GiftCardPaymentMethod | null
  bankAccountId?: string | null
  postedBy: string
  /**
   * The caller is the CEO (role admin): only they may FORFEIT a SOLD card —
   * keeping a customer's money as income (H11; the owner's pattern for every
   * customer-money-to-income decision). Anyone else gets 403 FORFEIT_NEEDS_CEO.
   */
  canForfeitSold?: boolean
}

export interface VoidGiftCardResult {
  card: GiftCard
  before: { status: GiftCardStatus; balanceCents: number }
  /** What left 2080 (0 when the card held nothing). */
  postedCents: number
  entryId: string | null
  creditCode: string | null
  /**
   * payment_not_received on a card already partly spent: the spent part was
   * never paid either, and stays in the issue's debit account until someone
   * writes it off. Shown, never guessed into an expense.
   */
  unpaidSpentCents: number
}

/**
 * Void a card: row-locked, its balance claimed atomically, and its value
 * taken out of 2080 the way the disposition says — in one transaction.
 *
 * A card can be voided when it is active, fully spent, or expired (its
 * breakage was booked at expiry, so what an expired card still holds is value
 * a refund put back afterwards — or breakage still held); a voided card only
 * when value came back onto it (a refund of an order it paid, or a void from
 * before 2026-10-13 that left the balance in 2080) — settling it again.
 */
export async function voidGiftCard(input: VoidGiftCardInput): Promise<VoidGiftCardResult> {
  return prisma.$transaction(async (tx) => {
    await lockGiftCardTx(tx, input.cardId)
    const card = await tx.giftCard.findFirst({ where: { id: input.cardId, ...input.scope } })
    if (!card || !card.tenantId) throw new NotFoundError('GiftCard', input.cardId)
    const tenantId = card.tenantId
    const B = card.balanceCents
    if (card.status === 'voided' && B <= 0) {
      throw new AppError('GIFTCARD_ALREADY_VOIDED', `${card.code} is already voided and holds nothing`, 409)
    }

    // What the disposition may do with this kind of card.
    if (card.kind === 'promotional' && input.disposition !== 'forfeit') {
      throw new AppError('PROMO_CARD_FORFEIT_ONLY', 'A promotional card was never paid for — void it as "forfeit" (its value goes back to Marketing & Promo)', 422)
    }
    const soldForfeit = card.kind === 'sold' && input.disposition === 'forfeit'
    if (soldForfeit && !input.canForfeitSold) {
      // H11: keeping a customer's money as income (breakage, 4200) is the
      // CEO's call — like a bad-debt write-off. Managers refund it, or void it
      // as "payment not received".
      throw new AppError('FORFEIT_NEEDS_CEO', 'Only the CEO can keep the money on a sold gift card. Refund it, or void it as "payment not received".', 403)
    }
    if (input.disposition === 'refund' && !input.refundMethod) {
      throw new AppError('REFUND_METHOD_REQUIRED', 'Say how the money goes back: cash, card or bank transfer', 422)
    }
    if (input.disposition !== 'refund' && (input.refundMethod || input.bankAccountId)) {
      throw new AppError('NO_REFUND_ON_THIS_VOID', 'Only a refund pays money out — leave the refund method and bank empty', 422)
    }

    // Where the value goes. Nothing moves when the card holds nothing.
    let creditCode: string | null = null
    let unpaidSpentCents = 0
    if (B > 0) {
      const issue = await tx.journalEntry.findFirst({
        where: { tenantId, reference: issueRef(card.id) },
        select: { lines: { where: { type: 'debit' }, select: { amountCents: true, account: { select: { code: true } } } } },
      })
      if (!issue) {
        // Taking value out of 2080 that never went in would leave 2080 short
        // by the card for good. Book the sale first (books check).
        throw new AppError('ISSUE_NOT_BOOKED', `The sale of ${card.code} is not in the books yet — book it first (Gift cards → Books check), then void the card`, 422)
      }
      if (input.disposition === 'refund') {
        creditCode = (await moneyAccountCode(tx, tenantId, { method: input.refundMethod!, bankAccountId: input.bankAccountId ?? null })).code
      } else if (input.disposition === 'payment_not_received') {
        const line = issue.lines[0]
        if (!line) throw new AppError('ISSUE_ENTRY_UNREADABLE', `The issue entry of ${card.code} has no debit line`, 500)
        creditCode = line.account.code
        // Only meaningful on a first void: a settle of refunded value is not "spent".
        if (card.status !== 'voided') unpaidSpentCents = Math.max(0, toCents(line.amountCents) - B)
      } else {
        // Forfeit: a promotional card's value goes back to Marketing & Promo;
        // a sold card's (the CEO's call, above) is breakage income (H11).
        creditCode = soldForfeit ? BREAKAGE_INCOME_CODE : PROMO_EXPENSE_CODE
      }
    }

    // Claim the balance: only the B we read leaves the card. A forfeit is
    // breakage (breakageCents += B); any void settles held breakage too.
    const now = new Date()
    const forfeited = input.disposition === 'forfeit' && B > 0
    const claimed = await tx.giftCard.updateMany({
      where: { id: card.id, status: card.status, balanceCents: B },
      data: {
        status: 'voided', balanceCents: 0, voidedAt: now, voidReason: input.reason, voidDisposition: input.disposition,
        breakagePendingAt: null, breakagePendingReason: null,
        ...(forfeited && { breakageCents: { increment: B }, breakageAt: now }),
      },
    })
    if (claimed.count === 0) throw new AppError('GIFTCARD_CHANGED', 'The card changed while it was being voided — try again', 409)

    let entryId: string | null = null
    if (B > 0 && creditCode) {
      // One entry per settlement: the first void is '<card>', a settle of
      // value a refund later put back is '<card>@2', '@3' … (under the lock).
      const prior = await tx.journalEntry.count({
        where: { tenantId, OR: [{ reference: `${VOID_SOURCE}:${card.id}` }, { reference: { startsWith: `${VOID_SOURCE}:${card.id}@` } }] },
      })
      const what = input.disposition === 'refund' ? `refunded by ${input.refundMethod}`
        : input.disposition === 'payment_not_received' ? 'payment never received'
        : soldForfeit ? 'unused value kept as breakage'
        : 'promotional value unused'
      const r = await postJournalEntry({
        tenantId,
        sourceType: VOID_SOURCE,
        sourceId: prior === 0 ? card.id : `${card.id}@${prior + 1}`,
        entryDate: now,
        description: `Gift card ${card.code} voided — ${what}: ${input.reason.slice(0, 200)}`,
        postedBy: input.postedBy,
        lines: [
          { accountCode: GIFT_CARD_LIABILITY_CODE, type: 'debit', amountCents: B, memo: `Gift card ${card.code} voided`, conceptId: card.conceptId },
          { accountCode: creditCode, type: 'credit', amountCents: B, memo: `Gift card ${card.code} — ${what}`, conceptId: card.conceptId },
        ],
      }, { tx })
      entryId = r.entryId
    }

    const updated = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
    return {
      card: updated,
      before: { status: card.status, balanceCents: B },
      postedCents: B > 0 ? B : 0,
      entryId,
      creditCode,
      unpaidSpentCents,
    }
  })
}

// ── Expiry (breakage, H11) ───────────────────────────────────────────────────

export interface ExpireGiftCardResult {
  /** This call moved the card from active to expired (its first expiry). */
  expired: boolean
  /** Value taken to breakage by this call (0 when held or nothing was owed). */
  breakageCents: number
  /** Breakage is held (ISSUE_NOT_BOOKED or a refused posting) — retried by the next sweep / the re-poster. */
  held: boolean
}

const NOTHING: ExpireGiftCardResult = { expired: false, breakageCents: 0, held: false }

/**
 * Value a refund put back on the card AFTER it expired (re-credited
 * redemptions claimed after `expiredAt`): never breakage — it waits for a
 * manager (books check → expiredHoldingValue).
 */
async function creditedAfter(tx: Tx, cardId: string, expiredAt: Date): Promise<number> {
  const r = await tx.giftCardRedemption.aggregate({
    where: { giftCardId: cardId, reversedAt: { gt: expiredAt } },
    _sum: { amountCents: true },
  })
  return Math.max(0, r._sum.amountCents ?? 0)
}

const maskCode = (code: string) => `••••${code.slice(-4)}`

/**
 * Expire ONE card and book its breakage, in one row-locked transaction (see
 * the header): the card's first expiry (status active, expiresAt passed), or
 * a retry of breakage held at its expiry (status expired, breakageAt null —
 * which also covers a card expired before breakage existed). Anything else is
 * a no-op. Breakage is dated `now` (the sweep's day, an open month).
 *
 * Held breakage leaves the card expired with its balance (still owed in
 * 2080) and breakagePendingAt set: ISSUE_NOT_BOOKED raises
 * 'gift_card_breakage_held'; a refused posting raises 'posting_failed'
 * (sourceType 'giftcard.expire', entity GiftCard, sourceId = cardId). When it
 * books, both flags of the card are resolved. Idempotent: a second call finds
 * breakageAt set and does nothing. The REPOSTER calls this.
 */
export async function expireOneGiftCard(cardId: string, now: Date = new Date(), db: GiftCardDb = serviceClient): Promise<ExpireGiftCardResult> {
  type Outcome = ExpireGiftCardResult & {
    card?: { id: string; tenantId: string; code: string; conceptId: string | null; kind: GiftCardKind }
    heldReason?: string
    refusal?: string
    amountCents?: number
  }
  const out: Outcome = await db.$transaction(async (tx): Promise<Outcome> => {
    await lockGiftCardTx(tx, cardId)
    const card = await tx.giftCard.findUnique({ where: { id: cardId } })
    if (!card || !card.tenantId) return NOTHING
    const firstExpiry = card.status === 'active' && card.expiresAt != null && card.expiresAt < now
    const owed = card.status === 'expired' && card.breakageAt == null
    if (!firstExpiry && !owed) return NOTHING
    const tenantId = card.tenantId
    const ref = { id: card.id, tenantId, code: card.code, conceptId: card.conceptId, kind: card.kind }

    let expiredAt = card.expiredAt ?? now
    if (firstExpiry) {
      const r = await tx.giftCard.updateMany({
        where: { id: card.id, status: 'active', expiresAt: { lt: now } },
        data: { status: 'expired', expiredAt: now },
      })
      if (r.count === 0) return NOTHING
      expiredAt = now
    }

    // Breakage is the value the card held at its FIRST expiry: what a refund
    // put back afterwards stays on the card for a manager.
    const B = Math.max(0, card.balanceCents - (firstExpiry ? 0 : await creditedAfter(tx, card.id, expiredAt)))
    if (B <= 0) {
      await tx.giftCard.update({
        where: { id: card.id },
        data: { breakageAt: now, breakagePendingAt: null, breakagePendingReason: null },
      })
      return { expired: firstExpiry, breakageCents: 0, held: false, card: ref }
    }

    // The card's sale must be in the books before 2080 comes down for it
    // (the same check as voidGiftCard): else the card expires, breakage held.
    const issue = await tx.journalEntry.findFirst({ where: { tenantId, reference: issueRef(card.id) }, select: { id: true } })
    if (!issue) {
      await tx.giftCard.update({
        where: { id: card.id },
        data: { breakagePendingAt: card.breakagePendingAt ?? now, breakagePendingReason: BREAKAGE_HELD.ISSUE_NOT_BOOKED },
      })
      return { expired: firstExpiry, breakageCents: 0, held: true, card: ref, heldReason: BREAKAGE_HELD.ISSUE_NOT_BOOKED, amountCents: B }
    }

    const sold = card.kind === 'sold'
    const booked = await withSavepoint(tx, 'giftcard_breakage', async () => {
      const claimed = await tx.giftCard.updateMany({
        where: { id: card.id, status: 'expired', balanceCents: card.balanceCents, breakageAt: null },
        data: {
          balanceCents: card.balanceCents - B,
          breakageCents: { increment: B },
          breakageAt: now,
          breakagePendingAt: null,
          breakagePendingReason: null,
        },
      })
      if (claimed.count === 0) throw new AppError('GIFTCARD_CHANGED', 'The card changed while its breakage was being booked', 409)
      const what = sold ? 'breakage (unused value of a sold card)' : 'unused promotional value back to Marketing & Promo'
      const r = await postJournalEntry({
        tenantId,
        sourceType: EXPIRE_SOURCE,
        sourceId: card.id,
        entryDate: now,
        description: `Gift card ${maskCode(card.code)} expired — ${what}`,
        postedBy: 'system',
        lines: [
          { accountCode: GIFT_CARD_LIABILITY_CODE, type: 'debit', amountCents: B, memo: `Gift card ${maskCode(card.code)} expired`, conceptId: card.conceptId },
          { accountCode: sold ? BREAKAGE_INCOME_CODE : PROMO_EXPENSE_CODE, type: 'credit', amountCents: B, memo: `Gift card ${maskCode(card.code)} — ${what}`, conceptId: card.conceptId },
        ],
      }, { tx })
      // Under the card lock with breakageAt still null, an entry already
      // there means the books and the card disagree — a person decides.
      if (!r.posted) throw new AppError('BREAKAGE_ALREADY_BOOKED', `'${EXPIRE_SOURCE}:${card.id}' is already in the books but the card shows no breakage`, 409)
    })
    if (!booked.ok) {
      await tx.giftCard.update({
        where: { id: card.id },
        data: { breakagePendingAt: card.breakagePendingAt ?? now, breakagePendingReason: `${BREAKAGE_HELD.POSTING_REFUSED}: ${booked.error.message}`.slice(0, 300) },
      })
      return { expired: firstExpiry, breakageCents: 0, held: true, card: ref, refusal: booked.error.message || 'posting failed', amountCents: B }
    }
    return { expired: firstExpiry, breakageCents: B, held: false, card: ref }
  })

  // Flags after the commit (they never undo the card's state).
  const c = out.card
  if (c && out.refusal) {
    await flagPostingFailed({
      tenantId: c.tenantId,
      sourceType: EXPIRE_SOURCE,
      sourceId: c.id,
      entityType: 'GiftCard',
      entityId: c.id,
      reason: out.refusal,
      title: `Gift card ${maskCode(c.code)} expired but its breakage did not reach the ledger`,
      conceptId: c.conceptId,
      amountCents: out.amountCents ?? null,
    })
  } else if (c && out.heldReason) {
    await flagBreakageHeld(c, out.amountCents ?? 0)
  } else if (c && out.breakageCents > 0) {
    await resolvePostingFailed('GiftCard', c.id, EXPIRE_SOURCE, 'Breakage booked by the expiry sweep', { tenantIds: [c.tenantId] })
    await resolveBreakageHeld(c.id, c.tenantId, 'Breakage booked by the expiry sweep')
  }
  return { expired: out.expired, breakageCents: out.breakageCents, held: out.held }
}

/** Raise (once per card) the 'gift_card_breakage_held' flag. Never throws. */
async function flagBreakageHeld(c: { id: string; tenantId: string; code: string; conceptId: string | null }, amountCents: number): Promise<void> {
  try {
    const open = await serviceClient.exceptionFlag.findFirst({
      where: { kind: BREAKAGE_HELD_KIND, entityType: 'GiftCard', entityId: c.id, status: { in: ['open', 'acknowledged'] } },
      select: { id: true },
    })
    if (open) return
    const { flagException } = await import('../../lib/exceptions.js')
    await flagException({
      tenantId: c.tenantId,
      kind: BREAKAGE_HELD_KIND,
      severity: 'medium',
      title: `Gift card ${maskCode(c.code)} expired — breakage held, its sale is not in the books`,
      description: `The card expired holding PKR ${(amountCents / 100).toFixed(2)}, but its sale ('giftcard.issue') never reached the books, `
        + 'so its unused value cannot come out of Gift Card Liability (2080) yet. Book the sale in Gift cards → Books check → Book the sale; '
        + 'the next nightly sweep then books the breakage.',
      entityType: 'GiftCard',
      entityId: c.id,
      conceptId: c.conceptId,
      amountCents,
      metadata: { reason: BREAKAGE_HELD.ISSUE_NOT_BOOKED, sourceType: EXPIRE_SOURCE, sourceId: c.id },
    })
  } catch (err) {
    console.error(`[giftCardExpiry] could not flag held breakage on ${c.id}:`, (err as Error).message)
  }
}

/** Close the card's open 'gift_card_breakage_held' flags. Never throws. */
async function resolveBreakageHeld(cardId: string, tenantId: string, resolution: string): Promise<void> {
  await serviceClient.exceptionFlag.updateMany({
    where: { kind: BREAKAGE_HELD_KIND, entityType: 'GiftCard', entityId: cardId, tenantId, status: { in: ['open', 'acknowledged'] } },
    data: { status: 'resolved', resolvedAt: new Date(), resolution },
  }).catch((err) => console.error(`[giftCardExpiry] could not resolve held breakage on ${cardId}:`, (err as Error).message))
}

export interface ExpirySweepResult {
  /** Cards moved from active to expired. */
  expired: number
  /** Cards whose breakage was booked, and how much. */
  breakageCount: number
  breakageCents: number
  /** Cards whose breakage is held (flagged; retried next run). */
  held: number
  /** Cards the sweep could not process (logged). */
  failed: number
}

const SWEEP_PAGE = 200

/**
 * The nightly sweep for one company: every active card whose expiry has
 * passed is expired with its breakage booked, and every expired card whose
 * breakage is still owed (held, or expired before breakage existed) is
 * retried — each through expireOneGiftCard, each card ONCE per run: the
 * candidates are walked with an (expiresAt, id) cursor, so a card that keeps
 * failing never starves the rest. (Every expired card got there from a passed
 * expiresAt, so the cursor's expiresAt is never null.)
 */
export async function expireDueGiftCards(tenantId: string, now: Date = new Date(), db: GiftCardDb = serviceClient): Promise<ExpirySweepResult> {
  const res: ExpirySweepResult = { expired: 0, breakageCount: 0, breakageCents: 0, held: 0, failed: 0 }
  let cursor: { expiresAt: Date; id: string } | null = null
  for (;;) {
    const page: Array<{ id: string; expiresAt: Date | null }> = await db.giftCard.findMany({
      where: {
        tenantId,
        expiresAt: { not: null },
        AND: [
          {
            OR: [
              { status: 'active', expiresAt: { lt: now } },
              { status: 'expired', breakageAt: null, balanceCents: { gt: 0 } },
            ],
          },
          ...(cursor
            ? [{ OR: [{ expiresAt: { gt: cursor.expiresAt } }, { expiresAt: cursor.expiresAt, id: { gt: cursor.id } }] }]
            : []),
        ],
      },
      select: { id: true, expiresAt: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: SWEEP_PAGE,
    })
    if (page.length === 0) break
    for (const { id } of page) {
      try {
        const r = await expireOneGiftCard(id, now, db)
        if (r.expired) res.expired += 1
        if (r.breakageCents > 0) { res.breakageCount += 1; res.breakageCents += r.breakageCents }
        if (r.held) res.held += 1
      } catch (err) {
        res.failed += 1
        console.error(`[giftCardExpiry] card ${id} failed:`, (err as Error).message)
      }
    }
    const last = page[page.length - 1]!
    cursor = { expiresAt: last.expiresAt!, id: last.id }
    if (page.length < SWEEP_PAGE) break
  }
  return res
}

// ── The 2080 check ───────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const LIST_CAP = 50

export interface GiftCardBooksCheck {
  tenantId: string
  companyName: string
  /** 2080's balance in this company's books, as owed (credits − debits). */
  ledgerCents: number
  /** Σ balanceCents of every card of the company (a voided card holds 0 unless a refund put value back). */
  cardBalancesCents: number
  byStatus: Record<GiftCardStatus, { count: number; cents: number }>
  /** Spent on orders whose sale (and its 2080 debit) is not in the books yet. Still owed in 2080. */
  awaitingSale: { count: number; cents: number; items: Array<{ redemptionId: string; orderId: string; orderStatus: string | null; amountCents: number }> }
  /** Spent with no order (the old admin redeem) — never booked, so 2080 still holds it. */
  spentWithoutOrder: { count: number; cents: number }
  /** = cardBalancesCents + awaitingSale + spentWithoutOrder: what 2080 should hold. */
  expectedCents: number
  /** ledgerCents − expectedCents. 0 = the cards and the books agree. */
  differenceCents: number
  /** Cards whose sale never reached the books ('giftcard.issue' missing): 2080 is short by their issued value. */
  issueNotBooked: { count: number; cents: number; items: Array<{ id: string; code: string; issuedAmountCents: number; createdAt: Date; status: GiftCardStatus }> }
  /** differenceCents once the unbooked issues are counted in. Anything here needs a person. */
  unexplainedCents: number
  /** Voided cards holding value (a refund of an order the card paid, or a void before 2026-10-13): owed, unspendable — settle them. */
  voidedHoldingValue: { count: number; cents: number; items: Array<{ id: string; code: string; kind: GiftCardKind; balanceCents: number; voidedAt: Date | null }> }
  /**
   * Expired cards holding value a refund put back AFTER their breakage was
   * booked (breakage is taken once, at the first expiry): owed, unspendable —
   * a manager settles it with Void (refund, or forfeit by the CEO).
   */
  expiredHoldingValue: { count: number; cents: number; items: Array<{ id: string; code: string; kind: GiftCardKind; balanceCents: number; expiredAt: Date | null }> }
  /** Breakage booked (H11): cards with value taken at expiry or a CEO forfeit, and how much (4200 sold / 6060 promotional). */
  breakage: { count: number; cents: number }
  /** Expired cards whose breakage is held (sale not in the books, or a refused posting): still owed in 2080 until the sweep books it. */
  breakageHeld: { count: number; cents: number; items: Array<{ id: string; code: string; kind: GiftCardKind; balanceCents: number; reason: string | null; since: Date | null }> }
}

/** The 2080 check for one company. Codes are returned in full — the route masks them. */
export async function giftCardBooksCheck(tenantId: string, companyName: string): Promise<GiftCardBooksCheck> {
  const [ledger, cards, issueEntries, open, cardDebits] = await Promise.all([
    ledgerBalancesByCode(tenantId, [GIFT_CARD_LIABILITY_CODE]),
    prisma.giftCard.findMany({
      where: { tenantId },
      select: {
        id: true, code: true, kind: true, status: true, balanceCents: true, issuedAmountCents: true, createdAt: true, voidedAt: true,
        expiredAt: true, breakageCents: true, breakageAt: true, breakagePendingAt: true, breakagePendingReason: true,
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.journalEntry.findMany({
      where: { tenantId, reference: { startsWith: `${ISSUE_SOURCE}:` } },
      select: { reference: true },
    }),
    prisma.giftCardRedemption.findMany({
      where: { reversedAt: null, amountCents: { gt: 0 }, giftCard: { tenantId } },
      select: { id: true, amountCents: true, orderId: true, order: { select: { status: true } } },
    }),
    // Every 2080 debit that names an order (giftCardSaleMemo: the sale's own
    // line, the shift close's line, or a backfill of a pre-ONL-05 sale).
    prisma.journalLine.findMany({
      where: { type: 'debit', account: { tenantId, code: GIFT_CARD_LIABILITY_CODE }, journalEntry: { tenantId } },
      select: { memo: true },
    }),
  ])

  // ledgerBalancesByCode is debits − credits; a liability is owed the other way.
  const ledgerCents = -(ledger.get(GIFT_CARD_LIABILITY_CODE) ?? 0)

  const byStatus: GiftCardBooksCheck['byStatus'] = {
    active: { count: 0, cents: 0 }, redeemed_full: { count: 0, cents: 0 }, expired: { count: 0, cents: 0 }, voided: { count: 0, cents: 0 },
  }
  let cardBalancesCents = 0
  for (const c of cards) {
    byStatus[c.status].count += 1
    byStatus[c.status].cents += c.balanceCents
    cardBalancesCents += c.balanceCents
  }

  const bookedOrders = new Set<string>()
  for (const l of cardDebits) for (const m of (l.memo ?? '').match(UUID_RE) ?? []) bookedOrders.add(m.toLowerCase())
  const awaitingSale: GiftCardBooksCheck['awaitingSale'] = { count: 0, cents: 0, items: [] }
  const spentWithoutOrder = { count: 0, cents: 0 }
  for (const r of open) {
    if (!r.orderId) { spentWithoutOrder.count += 1; spentWithoutOrder.cents += r.amountCents; continue }
    if (bookedOrders.has(r.orderId.toLowerCase())) continue
    awaitingSale.count += 1
    awaitingSale.cents += r.amountCents
    if (awaitingSale.items.length < LIST_CAP) {
      awaitingSale.items.push({ redemptionId: r.id, orderId: r.orderId, orderStatus: r.order?.status ?? null, amountCents: r.amountCents })
    }
  }

  const booked = new Set(issueEntries.map((e) => e.reference))
  const issueNotBooked: GiftCardBooksCheck['issueNotBooked'] = { count: 0, cents: 0, items: [] }
  const voidedHoldingValue: GiftCardBooksCheck['voidedHoldingValue'] = { count: 0, cents: 0, items: [] }
  const expiredHoldingValue: GiftCardBooksCheck['expiredHoldingValue'] = { count: 0, cents: 0, items: [] }
  const breakage: GiftCardBooksCheck['breakage'] = { count: 0, cents: 0 }
  const breakageHeld: GiftCardBooksCheck['breakageHeld'] = { count: 0, cents: 0, items: [] }
  for (const c of cards) {
    if (c.breakageCents > 0) {
      breakage.count += 1
      breakage.cents += c.breakageCents
    }
    if (c.status === 'expired' && c.balanceCents > 0) {
      if (c.breakageAt) {
        expiredHoldingValue.count += 1
        expiredHoldingValue.cents += c.balanceCents
        if (expiredHoldingValue.items.length < LIST_CAP) {
          expiredHoldingValue.items.push({ id: c.id, code: c.code, kind: c.kind, balanceCents: c.balanceCents, expiredAt: c.expiredAt })
        }
      } else {
        // Held at expiry, or expired before breakage existed: the sweep books it.
        breakageHeld.count += 1
        breakageHeld.cents += c.balanceCents
        if (breakageHeld.items.length < LIST_CAP) {
          breakageHeld.items.push({ id: c.id, code: c.code, kind: c.kind, balanceCents: c.balanceCents, reason: c.breakagePendingReason, since: c.breakagePendingAt ?? c.expiredAt })
        }
      }
    }
    if (!booked.has(issueRef(c.id))) {
      issueNotBooked.count += 1
      issueNotBooked.cents += c.issuedAmountCents
      if (issueNotBooked.items.length < LIST_CAP) {
        issueNotBooked.items.push({ id: c.id, code: c.code, issuedAmountCents: c.issuedAmountCents, createdAt: c.createdAt, status: c.status })
      }
    }
    if (c.status === 'voided' && c.balanceCents > 0) {
      voidedHoldingValue.count += 1
      voidedHoldingValue.cents += c.balanceCents
      if (voidedHoldingValue.items.length < LIST_CAP) {
        voidedHoldingValue.items.push({ id: c.id, code: c.code, kind: c.kind, balanceCents: c.balanceCents, voidedAt: c.voidedAt })
      }
    }
  }

  const expectedCents = cardBalancesCents + awaitingSale.cents + spentWithoutOrder.cents
  const differenceCents = ledgerCents - expectedCents
  return {
    tenantId, companyName, ledgerCents, cardBalancesCents, byStatus,
    awaitingSale, spentWithoutOrder, expectedCents, differenceCents,
    issueNotBooked, unexplainedCents: differenceCents + issueNotBooked.cents,
    voidedHoldingValue, expiredHoldingValue, breakage, breakageHeld,
  }
}
