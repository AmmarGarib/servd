// Loyalty breakage liability accounting.
//
// Points are a real liability — every point we issue is a deferred discount we
// owe to the customer. The first time we recognise that liability is when the
// points are EARNED; we discharge it when they're REDEEMED or EXPIRE, and a
// refund or cancellation unwinds whichever of those the order caused.
//
// Posting rules (a point is worth the company's loyalty.point_value_cents):
//   EARN:     Dr Marketing & Promo (6060)    / Cr Loyalty Liability (2060)
//   REDEEM:   Dr Loyalty Liability (2060)    / Cr Loyalty Redemptions (7020)
//   EXPIRE:   Dr Loyalty Liability (2060)    / Cr Marketing & Promo (6060) — reverse of accrual
//   REVERSAL: the mirror of the earn or redeem it undoes (postLoyaltyReversal)
//             — an earn clawed back on a refund: Dr 2060 / Cr 6060; points
//             given back on a cancel or refund: Dr 7020 / Cr 2060.
//
// The redemption JE pairs with the order completion JE (which already books
// the redeemed amount as part of `discountCents`); together they net the
// liability discharge against the contra-revenue line so total revenue and
// expense recognition stays correct.
//
// Every posting is in the books of the company the points belong to: a
// loyalty account is ONE company's (LoyaltyAccount.tenantId, ONL-04), so its
// earns, redemptions, expiries and reversals all land in that company's 2060.

import { calculatePointsValue } from '../../lib/loyaltySettings.js'
import { prisma } from '../../lib/prisma.js'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ACCT, postJournalEntry, reverseJournalEntry, withLateNote, type RepostOptions } from './journal.js'
import { primaryTenantId } from '../../lib/setup-config.js'

// The company whose books carry a loyalty transaction: the company of the
// account it moved (accounts are per company). The order's brand and then the
// customer's most recent order remain as fallbacks for an account row that
// somehow has no company — never the "oldest company on the system" by default
// unless there is genuinely nothing else to go on.
async function loyaltyTenantId(
  orderId: string | null,
  customerId?: string | null,
  accountTenantId?: string | null,
): Promise<string | null> {
  if (accountTenantId) return accountTenantId
  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { concept: { select: { tenantId: true } } },
    })
    if (order?.concept.tenantId) return order.concept.tenantId
  }
  if (customerId) {
    const lastOrder = await prisma.order.findFirst({
      where: { customerId, deletedAt: null, concept: { tenantId: { not: null } } },
      orderBy: { placedAt: 'desc' },
      select: { concept: { select: { tenantId: true } } },
    })
    if (lastOrder?.concept.tenantId) return lastOrder.concept.tenantId
  }
  return primaryTenantId()
}

const ACCOUNT_SELECT = { loyaltyAccount: { select: { customerId: true, tenantId: true } } } as const

const LOYALTY_MARKETING_ACCOUNT = '6060'  // Marketing & Promo

export async function postLoyaltyEarn(loyaltyTxId: string, opts: RepostOptions = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    include: ACCOUNT_SELECT,
  })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'earn' || tx.pointsDelta <= 0) return { posted: false, entryId: null, reason: 'not_earn_tx' }
  if (tx.reversedAt) return { posted: false, entryId: null, reason: 'reversed' }

  const tenantId = await loyaltyTenantId(tx.orderId, tx.loyaltyAccount?.customerId ?? null, tx.loyaltyAccount?.tenantId ?? null)
  // A point is worth what the company's loyalty setting says (owner decision 12).
  const valueCents = await calculatePointsValue(tx.pointsDelta, tenantId)
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }

  // `opts`: the backfill moving it out of a sales day the night audit locked (note names the date).
  const late = withLateNote(`Loyalty points earned (customer ${tx.loyaltyAccount.customerId.slice(0,8)})`, [
    { accountCode: LOYALTY_MARKETING_ACCOUNT, type: 'debit',  amountCents: valueCents, memo: `${tx.pointsDelta} pts issued` },
    { accountCode: ACCT.LOYALTY_LIABILITY,    type: 'credit', amountCents: valueCents, memo: 'Liability accrued' },
  ], opts.memoNote)
  return postUnlessReversed(loyaltyTxId, (db) => postJournalEntry({
    tenantId,
    sourceType: 'loyalty.earn',
    sourceId: tx.id,
    description: late.description,
    entryDate: opts.entryDate ?? tx.createdAt,
    postedBy: opts.postedBy ?? 'system',
    lines: late.lines,
  }, { tx: db }))
}

/**
 * Book an earn or a redeem only while it is not reversed (earn vs refund
 * race). A refund / cancel claims the transaction (reversedAt) and then
 * reverses its entry only when that entry is already on the books — otherwise
 * it answers 'original_not_booked' and books nothing. An earn read before the
 * claim and posted after it used to land anyway: 2060 credited for points the
 * customer no longer had, with no reversal ever to follow. So the posting
 * re-reads the transaction under a row lock (FOR UPDATE — the claim's UPDATE
 * takes the same lock) inside the posting's own transaction:
 *   - the claim committed first → reversedAt is set → 'reversed', nothing posted;
 *   - the posting locked first → the claim waits for it to commit, then finds
 *     the entry on the books and reverses it.
 * Either way the ledger nets to what the points did.
 */
async function postUnlessReversed(
  loyaltyTxId: string,
  post: (db: Prisma.TransactionClient) => Promise<{ posted: boolean; entryId: string | null }>,
): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  return prisma.$transaction(async (db) => {
    const locked = await db.$queryRaw<Array<{ reversedAt: Date | null }>>`
      SELECT "reversedAt" FROM loyalty_transactions WHERE id = ${loyaltyTxId} FOR UPDATE`
    if (locked.length === 0) return { posted: false, entryId: null, reason: 'tx_not_found' }
    if (locked[0]!.reversedAt) return { posted: false, entryId: null, reason: 'reversed' }
    const result = await post(db)
    return { posted: result.posted, entryId: result.entryId }
  })
}

export async function postLoyaltyRedeem(loyaltyTxId: string, opts: RepostOptions = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    include: ACCOUNT_SELECT,
  })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'redeem' || tx.pointsDelta >= 0) return { posted: false, entryId: null, reason: 'not_redeem_tx' }
  // Points given back (cancel / refund) before the redemption was booked: the
  // restore found nothing to reverse, so booking it now would be one-sided.
  if (tx.reversedAt) return { posted: false, entryId: null, reason: 'reversed' }

  const tenantId = await loyaltyTenantId(tx.orderId, tx.loyaltyAccount?.customerId ?? null, tx.loyaltyAccount?.tenantId ?? null)
  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }
  // A point is worth what the company's loyalty setting says (owner decision 12).
  const valueCents = await calculatePointsValue(Math.abs(tx.pointsDelta), tenantId)
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  const late = withLateNote(`Loyalty points redeemed (customer ${tx.loyaltyAccount.customerId.slice(0,8)})`, [
    { accountCode: ACCT.LOYALTY_LIABILITY,    type: 'debit',  amountCents: valueCents, memo: `${Math.abs(tx.pointsDelta)} pts burned` },
    { accountCode: ACCT.LOYALTY_REDEMPTIONS,  type: 'credit', amountCents: valueCents, memo: 'Discount applied' },
  ], opts.memoNote)
  return postUnlessReversed(loyaltyTxId, (db) => postJournalEntry({
    tenantId,
    sourceType: 'loyalty.redeem',
    sourceId: tx.id,
    description: late.description,
    entryDate: opts.entryDate ?? tx.createdAt,
    postedBy: opts.postedBy ?? 'system',
    lines: late.lines,
  }, { tx: db }))
}

export async function postLoyaltyExpire(loyaltyTxId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    include: ACCOUNT_SELECT,
  })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'expire' || tx.pointsDelta >= 0) return { posted: false, entryId: null, reason: 'not_expire_tx' }

  const tenantId = await loyaltyTenantId(tx.orderId, tx.loyaltyAccount?.customerId ?? null, tx.loyaltyAccount?.tenantId ?? null)
  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }
  // A point is worth what the company's loyalty setting says (owner decision 12).
  const valueCents = await calculatePointsValue(Math.abs(tx.pointsDelta), tenantId)
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'loyalty.expire',
    sourceId: tx.id,
    description: `Loyalty points expired`,
    entryDate: tx.createdAt,
    postedBy: 'system',
    lines: [
      { accountCode: ACCT.LOYALTY_LIABILITY,    type: 'debit',  amountCents: valueCents, memo: `${Math.abs(tx.pointsDelta)} pts expired` },
      { accountCode: LOYALTY_MARKETING_ACCOUNT, type: 'credit', amountCents: valueCents, memo: 'Breakage recovered' },
    ],
  })
  return { posted: result.posted, entryId: result.entryId }
}

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Undo the ledger side of an earn or a redeem (BOOKS-08 / ONL-06 / FOH-17 /
 * ONL-07). Mirrors the entry the original transaction booked — the same
 * accounts and the same value, whatever the point value is today — in the
 * same company:
 *   earn   'loyalty.earn:<id>'   → 'loyalty.earn.reversal:<id>'   Dr 2060 / Cr 6060
 *   redeem 'loyalty.redeem:<id>' → 'loyalty.redeem.reversal:<id>' Dr 7020 / Cr 2060
 * Idempotent per original transaction (the reversal's key is the original's
 * id). When the original was never booked (no value, or before the posting
 * existed) there is nothing to reverse — the liability never moved — and this
 * is a no-op rather than an entry that would push 2060 the wrong way. Pass
 * `tx` to book it in the same database transaction as the points move.
 */
export async function postLoyaltyReversal(
  originalTxId: string,
  options: { tx?: Tx; reason?: string; postedBy?: string } = {},
): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const db = (options.tx ?? prisma) as typeof prisma
  const orig = await db.loyaltyTransaction.findUnique({
    where: { id: originalTxId },
    include: ACCOUNT_SELECT,
  })
  if (!orig) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (orig.type !== 'earn' && orig.type !== 'redeem') return { posted: false, entryId: null, reason: 'not_reversible' }

  // The reversal goes in the books the ORIGINAL was booked in. That is the
  // account's company — except for a redemption made at another company
  // before accounts were split per company (ONL-04): the migration keeps such
  // a redeem on the issuing company's account (so restored points go back to
  // the company that issued them, LEDGER-R9), while its 'loyalty.redeem'
  // entry sits in the spending company's books, where the reversal must
  // unwind it.
  const accountTenant = await loyaltyTenantId(orig.orderId, orig.loyaltyAccount?.customerId ?? null, orig.loyaltyAccount?.tenantId ?? null)
  const orderTenant = orig.orderId
    ? (await db.order.findUnique({ where: { id: orig.orderId }, select: { concept: { select: { tenantId: true } } } }))?.concept.tenantId ?? null
    : null
  const candidates = [...new Set([accountTenant, orderTenant].filter((t): t is string => !!t))]
  if (candidates.length === 0) return { posted: false, entryId: null, reason: 'no_company' }

  const sourceType = orig.type === 'earn' ? 'loyalty.earn' : 'loyalty.redeem'
  const booked = await db.journalEntry.findFirst({
    where: { tenantId: { in: candidates }, reference: `${sourceType}:${orig.id}` },
    select: { id: true, tenantId: true },
  })
  if (!booked?.tenantId) return { posted: false, entryId: null, reason: 'original_not_booked' }
  const tenantId = booked.tenantId

  const what = orig.type === 'earn'
    ? `${orig.pointsDelta} pts clawed back`
    : `${Math.abs(orig.pointsDelta)} pts given back`
  const result = await reverseJournalEntry(
    tenantId,
    sourceType,
    orig.id,
    `${what}${options.reason ? ` — ${options.reason}` : ''}`,
    { tx: options.tx, postedBy: options.postedBy ?? 'system' },
  )
  return { posted: result.posted, entryId: result.entryId }
}
