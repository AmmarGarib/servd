// On account at the till — a named corporate client's bill (owner 2026-10-13;
// parked area B resumed 2026-10-15).
//
// The cashier scans (or types) the client's QR card. The card resolves to its
// client ONLY inside the order's own company: a card of another company is
// "unknown" (404 ON_ACCOUNT_CARD_UNKNOWN) — the till never learns it exists
// elsewhere. The whole bill is then charged to the client's account in ONE
// transaction and the sale completes through the one coverage rule
// (applyCoverageTx) and the one completion routine (afterTillSale →
// completeOrder): exactly one fiscal sale document at supply, at the CASH
// rate, with the client as the buyer (connectors/fiscal/payload.ts reads the
// CustomerAccountCharge), and the tax invoice naming the client.
//
//   findTillOrderInScope   the order, in the caller's companies ('write'
//                          scope through its brand) — else 404
//   lookupCardForOrder     card → client, exposure, the quote and what would
//                          block the charge (writes nothing but the revoked-
//                          card flag)
//   chargeOrderToAccount   the charge (below)
//   onAccountEnabledFor    the till shows "On account" only when the company
//                          has an active client AND is cut over to 1115
//
// chargeOrderToAccount, one transaction, in this order (LOCK ORDER: order →
// client account, receivables/onAccount.ts):
//    1. lockOrderTx
//    2. idempotent replay (the payment row's gatewayMeta.idempotencyKey)
//    3. no card-machine charge in flight, no awaiting Raast request
//    4. the ticket takes money and is not completed
//    5. a bill completed at the till (source 'pos', or dine-in) — else 409
//       ON_ACCOUNT_NOT_HERE (delivery / pickup complete on fulfilment)
//    6. the WHOLE bill: nothing paid or pending, no tip / promo / wallet /
//       gift card / loyalty / split portion — else 409 ON_ACCOUNT_WHOLE_BILL
//    7. re-priced for the tender (cash class) and the stored rate asserted to
//       be the brand's cash rate — else 409 ON_ACCOUNT_RATE
//    8. the card (unknown 404 / revoked 409) → lockAccountTx
//    9. assertChargeableTx (TILL_CLEARING_NOT_SPLIT, not active, brand,
//       overdue, over limit, reference)
//   10. Payment on_account / paid / the drawer, gatewayRef = the client number,
//       gatewayMeta {idempotencyKey, onAccount {accountId, cardId, number,
//       name, reference}}
//   11. recordChargeTx (the CustomerAccountCharge, in the client's company)
//   12. applyCoverageTx — it MUST complete the sale now, else 409
//       ON_ACCOUNT_NOT_HERE and everything rolls back
// then, after commit, afterTillSale (completeOrder) and the audit row.
//
// The card code is a bearer secret: it is hashed at once and never reaches a
// log, an audit row, an error message or a response. Only its hint (last
// four characters) is ever shown.

import type { FastifyRequest } from 'fastify'
import type { CustomerAccount, CustomerAccountCard, CustomerAccountCharge, Payment, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { toCents } from '../../lib/money.js'
import { normalizeCardCode, hashCardCode } from '../../lib/onAccountCard.js'
import { karachiDay } from '../../connectors/util.js'
import { assertNoActiveTerminalChargeTx } from '../../connectors/terminal/guard.js'
import { fiscalViewForOrder } from '../../connectors/fiscal/view.js'
import { tillClearingCutoverAt } from '../accounting/tillClearingCode.js'
import { assertChargeableTx, exposureOfTx, lockAccountTx, recordChargeTx } from '../receivables/onAccount.js'
import {
  afterTillSale, applyCoverageTx, assertAmountsFit, assertTakesMoney, coveredCents, idempotencyKeyReused, lockOrderTx,
  paymentKeyOf, quoteOrderForTender, repriceForTenderTx, tillFiscal,
} from './service.js'

type Tx = Prisma.TransactionClient

// ─── Refusals ────────────────────────────────────────────────────────────────

export const ON_ACCOUNT_TILL_ERRORS = {
  ON_ACCOUNT_CARD_UNKNOWN: 'That card is not a client card of this company — check the card, or take payment another way',
  ON_ACCOUNT_CARD_REVOKED: 'That client card has been cancelled — ask the client for their current card, or take payment another way',
  ON_ACCOUNT_NOT_HERE: 'On account is for bills settled at the till (counter sales and dine-in) — delivery and pickup orders are paid another way',
  ON_ACCOUNT_WHOLE_BILL: 'On account takes the whole bill in one go — not a part-paid, split or tipped bill, or one with a promo, wallet, gift card or loyalty credit on it',
  ON_ACCOUNT_RATE: 'This bill could not be priced at the cash rate for an on-account charge — take payment another way',
} as const
export type OnAccountTillErrorCode = keyof typeof ON_ACCOUNT_TILL_ERRORS

const refuse = (code: OnAccountTillErrorCode, status: number, details?: unknown): AppError =>
  new AppError(code, ON_ACCOUNT_TILL_ERRORS[code], status, details)

// ─── The order and the card ──────────────────────────────────────────────────

export interface TillOrderRef {
  id: string
  conceptId: string
  tenantId: string
}

/**
 * The order, when it is one of the caller's companies' ('write' scope —
 * every company the login belongs to; orders carry their company through the
 * brand). Foreign, deleted, or a brand with no company → 404.
 */
export async function findTillOrderInScope(req: FastifyRequest, orderId: string): Promise<TillOrderRef> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    select: { id: true, conceptId: true, concept: { select: { tenantId: true } } },
  })
  if (!order?.concept.tenantId) throw new NotFoundError('Order', orderId)
  return { id: order.id, conceptId: order.conceptId, tenantId: order.concept.tenantId }
}

/** The card a scanned / typed code names, in THIS company only (null when none). Never logs the code. */
async function cardByCode(db: Tx | typeof prisma, tenantId: string, code: string): Promise<CustomerAccountCard | null> {
  const normalized = normalizeCardCode(code)
  if (!normalized) return null
  return db.customerAccountCard.findUnique({ where: { tenantId_tokenHash: { tenantId, tokenHash: hashCardCode(normalized) } } })
}

/**
 * A revoked card was presented at the till: ONE flag per card per Karachi day
 * in the order's company (a second scan the same day adds nothing). Never
 * fails the caller.
 */
export async function flagRevokedCardUse(input: {
  tenantId: string
  card: Pick<CustomerAccountCard, 'id' | 'accountId' | 'tokenHint' | 'label' | 'revokedAt' | 'revokedReason'>
  orderId: string
  conceptId: string
  actorId: string | null
}): Promise<void> {
  const day = karachiDay(new Date())
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`oa_card_revoked:${input.card.id}:${day}`}))`
      const existing = await tx.exceptionFlag.findFirst({
        where: {
          tenantId: input.tenantId, kind: 'on_account_card_revoked_used', entityType: 'CustomerAccountCard', entityId: input.card.id,
          metadata: { path: ['day'], equals: day },
        },
        select: { id: true },
      })
      if (existing) return
      const account = await tx.customerAccount.findUnique({ where: { id: input.card.accountId }, select: { number: true, legalName: true } })
      await tx.exceptionFlag.create({
        data: {
          tenantId: input.tenantId,
          kind: 'on_account_card_revoked_used',
          severity: 'medium',
          title: `A cancelled client card was presented at the till (${account?.number ?? 'client'} · card …${input.card.tokenHint})`,
          description: `${account?.legalName ?? 'A client'}'s card "${input.card.label}" (…${input.card.tokenHint}) was cancelled`
            + `${input.card.revokedReason ? ` (${input.card.revokedReason})` : ''} but was presented at the till today. The charge was refused.`,
          entityType: 'CustomerAccountCard',
          entityId: input.card.id,
          conceptId: input.conceptId,
          actorId: input.actorId,
          metadata: { day, orderId: input.orderId, accountId: input.card.accountId, cardHint: input.card.tokenHint } as Prisma.InputJsonObject,
        },
      })
    })
  } catch (err) {
    console.warn('[on-account] revoked-card flag failed:', (err as Error).message)
  }
}

/** 404 unknown / 409 revoked (the caller flags a revoked card after its transaction). */
function assertCardUsable(card: CustomerAccountCard | null): asserts card is CustomerAccountCard {
  if (!card) throw refuse('ON_ACCOUNT_CARD_UNKNOWN', 404)
  if (card.revokedAt) throw refuse('ON_ACCOUNT_CARD_REVOKED', 409, { cardId: card.id, hint: card.tokenHint })
}

// ─── Eligibility (steps 4–6) ─────────────────────────────────────────────────

type EligibilityOrder = {
  id: string
  status: string
  source: string
  fulfilmentType: string
  totalCents: number
  tipCents: number
  promoDiscountCents: number
  walletAmountCents: number
  payments: Array<{ status: string; amountCents: number; method: string }>
}

/** Steps 4–6: a ticket that takes money, completed at the till, the whole bill with nothing else on it. */
async function assertEligibleTx(db: Tx | typeof prisma, order: EligibilityOrder): Promise<void> {
  assertTakesMoney(order.status)
  if (order.status === 'completed') throw new AppError('ORDER_NOT_OPEN', 'This order is already completed — it cannot be charged on account', 409)
  // The applyCoverageTx completion rule: a till sale, or a dine-in bill settled at the till.
  if (!(order.source === 'pos' || order.fulfilmentType === 'dine_in')) throw refuse('ON_ACCOUNT_NOT_HERE', 409)
  if (order.totalCents <= 0) throw new AppError('NOTHING_DUE', 'Nothing is due on this order — cancel the ticket instead', 409)
  const taken = order.payments.some((p) => (p.status === 'paid' || p.status === 'pending') && p.amountCents > 0)
  const credits = order.tipCents > 0 || order.promoDiscountCents > 0 || order.walletAmountCents > 0
  if (taken || credits || coveredCents(order.payments) > 0) throw refuse('ON_ACCOUNT_WHOLE_BILL', 409)
  const [giftCards, loyalty] = await Promise.all([
    db.giftCardRedemption.count({ where: { orderId: order.id } }),
    db.loyaltyTransaction.count({ where: { orderId: order.id, type: 'redeem' } }),
  ])
  if (giftCards > 0 || loyalty > 0) throw refuse('ON_ACCOUNT_WHOLE_BILL', 409)
}

const ELIGIBILITY_SELECT = {
  id: true, status: true, source: true, fulfilmentType: true, totalCents: true, tipCents: true, promoDiscountCents: true,
  walletAmountCents: true, payments: { select: { status: true, amountCents: true, method: true } },
} satisfies Prisma.OrderSelect

// ─── Lookup ──────────────────────────────────────────────────────────────────

export interface OnAccountBlock { code: string; message: string; details?: unknown }

export interface CardLookup {
  account: {
    id: string
    number: string
    legalName: string
    limitCents: number
    exposureCents: number
    availableCents: number
    requiresReference: boolean
  }
  card: { id: string; label: string; hint: string }
  quote: Awaited<ReturnType<typeof quoteOrderForTender>>
  /** What would refuse the charge right now (null: it would go through, given a reference when one is required). */
  blocked: OnAccountBlock | null
}

/**
 * The till's card scan: the client the card names IN THE ORDER'S COMPANY,
 * its credit, the bill at the cash rate and anything that would refuse the
 * charge. 404 when the order is not the caller's or the card is not this
 * company's; 409 ON_ACCOUNT_CARD_REVOKED for a cancelled card (flagged once
 * per card per Karachi day). Writes nothing else.
 */
export async function lookupCardForOrder(req: FastifyRequest, orderId: string, code: string): Promise<CardLookup> {
  const order = await findTillOrderInScope(req, orderId)
  const card = await cardByCode(prisma, order.tenantId, code)
  try {
    assertCardUsable(card)
  } catch (err) {
    if (card && err instanceof AppError && err.code === 'ON_ACCOUNT_CARD_REVOKED') {
      await flagRevokedCardUse({ tenantId: order.tenantId, card, orderId: order.id, conceptId: order.conceptId, actorId: req.staffUser?.id ?? null })
    }
    throw err
  }
  const account = await prisma.customerAccount.findFirst({ where: { id: card.accountId, tenantId: order.tenantId } })
  if (!account) throw refuse('ON_ACCOUNT_CARD_UNKNOWN', 404)

  const quote = await quoteOrderForTender(order.id, 'on_account')
  const exposure = await exposureOfTx(prisma, account.id)
  const limitCents = toCents(account.creditLimitCents)

  let blocked: OnAccountBlock | null = null
  try {
    await prisma.$transaction(async (tx) => {
      const o = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: ELIGIBILITY_SELECT })
      await assertEligibleTx(tx, o)
      // The reference is asked for on the charge screen (requiresReference), so it never blocks the preview.
      await assertChargeableTx(tx, account, { conceptId: order.conceptId, billCents: quote.dueCents, reference: 'preview' })
    })
  } catch (err) {
    if (!(err instanceof AppError)) throw err
    blocked = { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) }
  }

  return {
    account: {
      id: account.id,
      number: account.number,
      legalName: account.legalName,
      limitCents,
      exposureCents: exposure.exposureCents,
      availableCents: Math.max(0, limitCents - exposure.exposureCents),
      requiresReference: account.requiresReference,
    },
    card: { id: card.id, label: card.label, hint: card.tokenHint },
    quote,
    blocked,
  }
}

/** The till shows "On account" for this order only when its company has an active client and is cut over to 1115. */
export async function onAccountEnabledFor(tenantId: string): Promise<boolean> {
  if (!(await tillClearingCutoverAt(prisma, tenantId))) return false
  return (await prisma.customerAccount.count({ where: { tenantId, status: 'active' } })) > 0
}

// ─── The charge ──────────────────────────────────────────────────────────────

export interface ChargeInput {
  orderId: string
  shiftId: string
  /** The client's card code — or, with no card, `accountId` picked from the City Ledger list plus the manager who approved it. */
  code?: string | null
  accountId?: string | null
  /** The manager (requireManagerApproval) who let the cashier charge a picked account without its card. */
  approverId?: string | null
  reference?: string | null
  idempotencyKey: string
  actor: { id: string; email?: string | null }
}

export interface ChargeResult {
  payment: Payment
  charge: CustomerAccountCharge | null
  orderCompleted: boolean
  fiscal: Awaited<ReturnType<typeof afterTillSale>>
  srb: ReturnType<typeof tillFiscal>['srb']
  replayed: boolean
}

/**
 * Charge the whole bill to the client the card names (see the header for the
 * twelve steps). The caller has checked the order is in scope and the drawer
 * is an open one of the order's company that the caller may use.
 */
export async function chargeOrderToAccount(input: ChargeInput): Promise<ChargeResult> {
  const reference = input.reference?.trim() ? input.reference.trim().slice(0, 80) : null
  // A revoked card refused inside the transaction is flagged after it rolls back.
  let revoked: { tenantId: string; card: CustomerAccountCard; conceptId: string } | null = null

  type TxResult =
    | { replay: true; payment: Payment; charge: CustomerAccountCharge | null; completed: boolean }
    | { replay: false; payment: Payment; charge: CustomerAccountCharge; account: CustomerAccount; card: CustomerAccountCard | null; tenantId: string; conceptId: string; customerId: string | null; source: string }

  let result: TxResult
  try {
    result = await prisma.$transaction(async (tx): Promise<TxResult> => {
      // 1. The order lock every money path takes first.
      await lockOrderTx(tx, input.orderId)
      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        include: { payments: true, concept: { select: { tenantId: true, taxRateCash: true } } },
      })
      if (!order || !order.concept.tenantId) throw new NotFoundError('Order', input.orderId)
      const tenantId = order.concept.tenantId
      // City Ledger (2026-10-24): a card, or an account picked from the list with a manager's approval — never neither.
      const byCard = !!input.code?.trim()
      if (!byCard && !(input.accountId && input.approverId)) throw new AppError('ON_ACCOUNT_CARD_OR_MANAGER', 'Scan the client card, or pick the account and have a manager approve', 422)
      const card = byCard ? await cardByCode(tx, tenantId, input.code!) : null

      // 2. A retry of a charge that went through returns it.
      const prior = order.payments.filter((p) => paymentKeyOf(p) === input.idempotencyKey)
      if (prior.length > 0) {
        const p = prior[0]!
        const meta = p.gatewayMeta && typeof p.gatewayMeta === 'object' && !Array.isArray(p.gatewayMeta)
          ? ((p.gatewayMeta as Record<string, unknown>)['onAccount'] as Record<string, unknown> | undefined)
          : undefined
        const same = byCard ? !!card && meta?.['cardId'] === card.id : meta?.['accountId'] === input.accountId
        if (prior.length !== 1 || p.method !== 'on_account' || !same) throw idempotencyKeyReused()
        const charge = await tx.customerAccountCharge.findFirst({ where: { tenantId, paymentId: p.id } })
        return { replay: true, payment: p, charge, completed: order.status === 'completed' }
      }

      // 3. Nothing else is taking money on this bill.
      await assertNoActiveTerminalChargeTx(tx, order.id)
      // 4–6. A ticket that takes money, settled at the till, the whole bill.
      await assertEligibleTx(tx, order)

      // 7. The cash class (lib/pricing tenderOf('on_account') === 'cash').
      await repriceForTenderTx(tx, order, ['on_account'])
      const priced = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { totalCents: true, taxCents: true, taxRatePct: true, conceptId: true, customerId: true, source: true },
      })
      if (priced.taxRatePct == null || priced.taxRatePct !== order.concept.taxRateCash) {
        throw refuse('ON_ACCOUNT_RATE', 409, { taxRatePct: priced.taxRatePct, cashRatePct: order.concept.taxRateCash })
      }
      assertAmountsFit(priced.totalCents)

      // 8. The card (or the picked account), in this company only, then the client's lock.
      let account: CustomerAccount
      if (byCard) {
        try {
          assertCardUsable(card)
        } catch (err) {
          if (card && err instanceof AppError && err.code === 'ON_ACCOUNT_CARD_REVOKED') revoked = { tenantId, card, conceptId: order.conceptId }
          throw err
        }
        account = await lockAccountTx(tx, card.accountId)
        if (account.tenantId !== tenantId) throw refuse('ON_ACCOUNT_CARD_UNKNOWN', 404)
        // The card may have been cancelled while we waited for the client's lock.
        const fresh = await tx.customerAccountCard.findUniqueOrThrow({ where: { id: card.id } })
        if (fresh.revokedAt || fresh.accountId !== account.id) {
          revoked = { tenantId, card: fresh, conceptId: order.conceptId }
          throw refuse('ON_ACCOUNT_CARD_REVOKED', 409, { cardId: fresh.id, hint: fresh.tokenHint })
        }
      } else {
        // Another company's account is the same 404 as an unknown one.
        const found = await tx.customerAccount.findFirst({ where: { id: input.accountId!, tenantId }, select: { id: true } })
        if (!found) throw new NotFoundError('CustomerAccount', input.accountId!)
        account = await lockAccountTx(tx, found.id)
      }

      // 9. Active, this brand, nothing overdue, within the limit, reference.
      await assertChargeableTx(tx, account, { conceptId: priced.conceptId, billCents: priced.totalCents, reference })

      // 10. The tender row.
      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          shiftId: input.shiftId,
          method: 'on_account',
          amountCents: priced.totalCents,
          status: 'paid',
          gateway: 'none',
          gatewayRef: account.number,
          gatewayMeta: {
            idempotencyKey: input.idempotencyKey,
            onAccount: { accountId: account.id, cardId: card?.id ?? null, approverId: byCard ? null : input.approverId ?? null, number: account.number, name: account.legalName, reference },
          },
          processedAt: new Date(),
        },
      })

      // 11. The client's charge, in the client's company.
      const charge = await recordChargeTx(tx, {
        account,
        cardId: card?.id ?? null,
        orderId: order.id,
        paymentId: payment.id,
        conceptId: priced.conceptId,
        shiftId: input.shiftId,
        amountCents: priced.totalCents,
        taxCents: priced.taxCents,
        reference,
        chargedById: input.actor.id,
      })

      // 12. The one coverage rule must complete the sale here and now.
      const coverage = await applyCoverageTx(tx, order.id, 'till')
      if (!coverage.completedNow) throw refuse('ON_ACCOUNT_NOT_HERE', 409)

      return { replay: false, payment, charge, account, card, tenantId, conceptId: priced.conceptId, customerId: coverage.customerId, source: coverage.source }
    }, { maxWait: 10_000, timeout: 15_000 })
  } catch (err) {
    if (revoked) {
      const r: { tenantId: string; card: CustomerAccountCard; conceptId: string } = revoked
      await flagRevokedCardUse({ tenantId: r.tenantId, card: r.card, orderId: input.orderId, conceptId: r.conceptId, actorId: input.actor.id })
    }
    throw err
  }

  if (result.replay) {
    const fiscal = result.completed ? await fiscalViewForOrder(input.orderId, 'sale', { staff: true }).catch(() => null) : null
    return { payment: result.payment, charge: result.charge, orderCompleted: result.completed, ...tillFiscal(fiscal), replayed: true }
  }

  // THE completion routine: one fiscal sale document (the client as buyer),
  // the tax invoice, the ledger for a non-till bill, rollups, webhook.
  const fiscal = await afterTillSale(input.orderId, result.customerId, result.source)

  // Audited in the order's company — the card's hint only, never its code.
  await audit({
    category: 'accounting',
    action: 'order.on_account_charge',
    entity: 'Order',
    entityId: input.orderId,
    userId: input.actor.id,
    userEmail: input.actor.email ?? null,
    tenantId: result.tenantId,
    metadata: {
      paymentId: result.payment.id,
      chargeId: result.charge.id,
      accountId: result.account.id,
      accountNumber: result.account.number,
      cardId: result.card?.id ?? null,
      cardHint: result.card?.tokenHint ?? null,
      approverId: result.card ? null : input.approverId ?? null,
      amountCents: result.payment.amountCents,
      reference,
      shiftId: input.shiftId,
    },
  })

  return { payment: result.payment, charge: result.charge, orderCompleted: true, ...tillFiscal(fiscal), replayed: false }
}
