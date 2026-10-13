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
//            forfeit              promotional only: Dr 2080 / Cr 6060
//          Forfeiting a SOLD card is breakage income (and maybe sales tax) —
//          pending owner decision G10, refused until then.
//   expiry status only (workers/giftCardExpiry.ts). The value stays owed in
//          2080 — pending owner decision G10 (breakage).
//
// Money moved outside a till: a sold card is a back-office receipt. Cash is
// cash on hand / the safe (1010), never a till drawer (1015): lib/drawer.ts
// counts only a shift's own payments and cash movements, so a card sold for
// cash at a counter would leave that drawer "over" with 1010 debited for money
// nobody put in the safe. Hence only the back office (managers + finance)
// sells cards, and only managers give promotional ones (routes.ts).

import type { Prisma, GiftCard, GiftCardKind, GiftCardStatus } from '@prisma/client'
import { randomBytes } from 'crypto'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { moneyAccountCode, ledgerBalancesByCode } from '../../lib/bankAccounts.js'
import { toCents } from '../../lib/money.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { postJournalEntry } from '../accounting/journal.js'

type Tx = Prisma.TransactionClient

export const GIFT_CARD_LIABILITY_CODE = '2080'
/** Marketing & Promo — a promotional card's cost, and its unspent value back. */
export const PROMO_EXPENSE_CODE = '6060'

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
 * A card can be voided when it is active, expired (no breakage is ever
 * booked yet — G10) or fully spent; a voided card only when value came back
 * onto it (a refund of an order it paid, or a void from before 2026-10-13
 * that left the balance in 2080) — settling it again.
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
    if (card.kind === 'sold' && input.disposition === 'forfeit') {
      // Pending owner decision G10: breakage income on a sold card, and
      // whether SRB / PRA is due on it. Until the owner and the accountant
      // decide, a sold card's value is either refunded or reversed.
      throw new AppError('FORFEIT_PENDING_DECISION', 'Keeping the money on a sold card is not set up yet (pending owner decision G10). Refund it, or void it as "payment not received".', 422)
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
        creditCode = PROMO_EXPENSE_CODE
      }
    }

    // Claim the balance: only the B we read leaves the card.
    const now = new Date()
    const claimed = await tx.giftCard.updateMany({
      where: { id: card.id, status: card.status, balanceCents: B },
      data: { status: 'voided', balanceCents: 0, voidedAt: now, voidReason: input.reason, voidDisposition: input.disposition },
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

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Mark a company's active cards whose expiry has passed as expired (with
 * expiredAt), each under its row lock. The redeem engine already refuses them
 * from the instant expiresAt passes; this records it. Returns how many.
 *
 * Pending owner decision G10: when breakage is decided, its posting goes in
 * the marked spot below ('giftcard.expire:<card>' — Dr 2080 / Cr breakage
 * income for a sold card, Cr 6060 for a promotional one), inside the same
 * transaction as the status change.
 */
export async function expireDueGiftCards(tenantId: string, now: Date = new Date(), db = serviceClient): Promise<number> {
  let expired = 0
  for (;;) {
    const due = await db.giftCard.findMany({
      where: { tenantId, status: 'active', expiresAt: { lt: now } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    })
    if (due.length === 0) break
    let progressed = false
    for (const { id } of due) {
      try {
        const done = await db.$transaction(async (tx) => {
          await lockGiftCardTx(tx, id)
          const r = await tx.giftCard.updateMany({
            where: { id, tenantId, status: 'active', expiresAt: { lt: now } },
            data: { status: 'expired', expiredAt: now },
          })
          // Pending owner decision G10 — breakage posting goes here.
          return r.count > 0
        })
        if (done) { expired += 1; progressed = true }
      } catch (err) {
        console.error(`[giftCardExpiry] card ${id} failed:`, (err as Error).message)
      }
    }
    if (!progressed) break   // every card in the batch failed — don't spin
  }
  return expired
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
}

/** The 2080 check for one company. Codes are returned in full — the route masks them. */
export async function giftCardBooksCheck(tenantId: string, companyName: string): Promise<GiftCardBooksCheck> {
  const [ledger, cards, issueEntries, open, cardDebits] = await Promise.all([
    ledgerBalancesByCode(tenantId, [GIFT_CARD_LIABILITY_CODE]),
    prisma.giftCard.findMany({
      where: { tenantId },
      select: { id: true, code: true, kind: true, status: true, balanceCents: true, issuedAmountCents: true, createdAt: true, voidedAt: true },
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
  for (const c of cards) {
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
    voidedHoldingValue,
  }
}
