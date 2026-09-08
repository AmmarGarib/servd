// Loyalty breakage liability accounting.
//
// Points are a real liability — every point we issue is a deferred discount we
// owe to the customer. The first time we recognise that liability is when the
// points are EARNED; we discharge it when they're REDEEMED (or expired —
// future work).
//
// Posting rules (1 point = 1 paisa per loyalty/routes.ts config):
//   EARN:    Dr Marketing & Promo (6060)         / Cr Loyalty Liability (2060)
//   REDEEM:  Dr Loyalty Liability (2060)          / Cr Loyalty Redemptions (7020)
//   EXPIRE:  Dr Loyalty Liability (2060)          / Cr Marketing & Promo (6060) — reverse of accrual
//
// The redemption JE pairs with the order completion JE (which already books
// the redeemed amount as part of `discountCents`); together they net the
// liability discharge against the contra-revenue line so total revenue and
// expense recognition stays correct.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry } from './journal.js'
import { primaryTenantId } from '../../lib/setup-config.js'

// Loyalty is a customer-facing programme rather than a brand's own ledger
// event, so the company comes from the order the points were earned or spent
// on. Point expiry carries no order — that accrual reversal falls back to the
// primary company, which is where the liability was raised.
async function loyaltyTenantId(orderId: string | null): Promise<string | null> {
  if (orderId) {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { concept: { select: { tenantId: true } } },
    })
    if (order?.concept.tenantId) return order.concept.tenantId
  }
  return primaryTenantId()
}

const POINTS_VALUE_CENTS_PER_POINT = 1  // mirrors loyalty/routes.ts

const LOYALTY_MARKETING_ACCOUNT = '6060'  // Marketing & Promo

export async function postLoyaltyEarn(loyaltyTxId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    include: { loyaltyAccount: { select: { customerId: true } } },
  })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'earn' || tx.pointsDelta <= 0) return { posted: false, entryId: null, reason: 'not_earn_tx' }

  const valueCents = tx.pointsDelta * POINTS_VALUE_CENTS_PER_POINT
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  const tenantId = await loyaltyTenantId(tx.orderId)
  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'loyalty.earn',
    sourceId: tx.id,
    description: `Loyalty points earned (customer ${tx.loyaltyAccount.customerId.slice(0,8)})`,
    entryDate: tx.createdAt,
    postedBy: 'system',
    lines: [
      { accountCode: LOYALTY_MARKETING_ACCOUNT, type: 'debit',  amountCents: valueCents, memo: `${tx.pointsDelta} pts issued` },
      { accountCode: ACCT.LOYALTY_LIABILITY,    type: 'credit', amountCents: valueCents, memo: 'Liability accrued' },
    ],
  })
  return { posted: result.posted, entryId: result.entryId }
}

export async function postLoyaltyRedeem(loyaltyTxId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    include: { loyaltyAccount: { select: { customerId: true } } },
  })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'redeem' || tx.pointsDelta >= 0) return { posted: false, entryId: null, reason: 'not_redeem_tx' }

  const valueCents = Math.abs(tx.pointsDelta) * POINTS_VALUE_CENTS_PER_POINT
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  const tenantId = await loyaltyTenantId(tx.orderId)
  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'loyalty.redeem',
    sourceId: tx.id,
    description: `Loyalty points redeemed (customer ${tx.loyaltyAccount.customerId.slice(0,8)})`,
    entryDate: tx.createdAt,
    postedBy: 'system',
    lines: [
      { accountCode: ACCT.LOYALTY_LIABILITY,    type: 'debit',  amountCents: valueCents, memo: `${Math.abs(tx.pointsDelta)} pts burned` },
      { accountCode: ACCT.LOYALTY_REDEMPTIONS,  type: 'credit', amountCents: valueCents, memo: 'Discount applied' },
    ],
  })
  return { posted: result.posted, entryId: result.entryId }
}

export async function postLoyaltyExpire(loyaltyTxId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const tx = await prisma.loyaltyTransaction.findUnique({ where: { id: loyaltyTxId } })
  if (!tx) return { posted: false, entryId: null, reason: 'tx_not_found' }
  if (tx.type !== 'expire' || tx.pointsDelta >= 0) return { posted: false, entryId: null, reason: 'not_expire_tx' }

  const valueCents = Math.abs(tx.pointsDelta) * POINTS_VALUE_CENTS_PER_POINT
  if (valueCents <= 0) return { posted: false, entryId: null, reason: 'zero_value' }

  const tenantId = await loyaltyTenantId(tx.orderId)
  if (!tenantId) return { posted: false, entryId: null, reason: 'no_company' }

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
