// Gift cards.
//
// Issue, void, expiry and the 2080 books check: ./books.ts (header there has
// every entry). Redemption: ./service.ts (the one redeem engine — storefront
// checkout, the till tender and POST /gift-cards/redeem); the sale entry debits
// 2080 for the card-paid share (orderPosting computeSaleAccounting, ONL-05)
// and refunds re-credit it.
//
// Codes are 12 chars in groups of 4 (GS-XXXX-XXXX), generated from a 32-char
// alphabet. Looked up case-insensitively.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, FINANCE_TEAM, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { requireModule } from '../notifications/requireModule.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId, resolveTenantScope } from '../../lib/tenantScope.js'
import { zReceiptMethod, zPaymentRef } from '../../lib/bankAccounts.js'
import { findPaymentReferenceUses } from '../../lib/paymentRefs.js'
import { redeemGiftCard } from './service.js'
import {
  issueGiftCard, voidGiftCard, bookMissingIssue, giftCardBooksCheck,
  GIFT_CARD_PAYMENT_METHODS, GIFT_CARD_REFUND_METHODS, VOID_DISPOSITIONS,
} from './books.js'

// ── Company scope (owner decision 14) ───────────────────────────────────────
// A gift card is sold by ONE company (GiftCard.tenantId, stamped at issue) and
// is spent at any brand of that company — never at another company's. The
// card's conceptId records the brand it was sold under; it does not narrow
// redemption within the company. A null conceptId used to mean "redeemable
// everywhere", and the list/void filters OR'd those cards in for every
// company, so any company could read, void or drain another's open cards.

// Who READS the register (wave 3, UI-07): the manager tiers plus finance, which
// owns the Finance workspace and holds the 'gift_cards' module by default — the
// /gift-cards prefix is module-gated on top (lib/moduleAccess.ts), so a role
// without the module is still refused. The card's liability (2080) and every
// redemption are finance's to reconcile. Voiding a card stays with MANAGERS:
// it writes off a customer's balance.
const GIFT_CARD_READERS = FINANCE_TEAM

// Who SELLS a card (finance gaps, 2026-10-13): the back office — managers and
// finance — never the till. Issuing used to be open to every staff role with
// a self-declared payment method: a cashier "selling" a card for cash put no
// Payment on any shift (lib/drawer.ts counts only those and cash movements),
// so the drawer came up over while 1010 was debited for money that never
// reached the safe. A sold card is a back-office receipt: cash into the safe
// (1010), card on the back-office machine (1030), or a transfer to a named
// bank of the company. A PROMOTIONAL card (given away, Dr 6060) is a manager's
// call only, with a reason.
//
// Payment received (owner, 2026-10-14): a sold card is paid by cash, card,
// bank transfer, bank deposit or cheque (lib/bankAccounts.ts RECEIPT_METHODS)
// and ALWAYS carries its payment reference # (422 PAYMENT_REFERENCE_REQUIRED,
// every method, cash included). A reference this company used before is a
// warning, never a block: the response carries `referenceUsedBefore`
// (lib/paymentRefs.ts — this company's rows only).
const GIFT_CARD_SELLERS = FINANCE_TEAM
// Who reaches POST /:id/void: managers (void any card) and finance (settle
// value on voided / expired cards only — books.ts voidGiftCard settleOnly).
const GIFT_CARD_SETTLERS = FINANCE_TEAM
const LIVE_CARD_VOIDERS = new Set<string>(MANAGERS)
const financeNeedsAccounting = async (req: FastifyRequest) => {
  if (req.staffUser?.role === 'finance') await requireModule('accounting')(req)
}
const PROMO_ISSUERS = new Set<string>(MANAGERS)

// A card's code is a bearer credential: whoever holds it can spend the
// customer's balance through the ALL_STAFF redeem. Finance reconciles the 2080
// liability and needs neither the code nor the buyer's / recipient's contact
// details, so outside the manager tiers (who read the full register as before)
// the code is masked to its last 4 and the emails and gift message are blanked
// (review W3B-RV-2). The redeem engine still takes a code presented at the till.
const FULL_CARD_READERS = new Set<string>(MANAGERS)
const seesFullCard = (req: FastifyRequest) => FULL_CARD_READERS.has(req.staffUser!.role)
export const maskGiftCardCode = (code: string) => `••••${code.slice(-4)}`

const STATUSES = ['active', 'redeemed_full', 'expired', 'voided'] as const
const MAX_PAGE = 500

export async function giftCardRoutes(fastify: FastifyInstance) {
  // List — the companies in view, newest first, a page at a time (it used to
  // stop silently at 100). `nextCursor` is the id to pass as `cursor` for the
  // next page; `total` counts every card the filter matches.
  fastify.get(
    '/',
    { preHandler: requireAuth(...GIFT_CARD_READERS) },
    async (req) => {
      const q = z.object({
        status: z.enum(STATUSES).optional(),
        limit:  z.coerce.number().int().min(1).max(MAX_PAGE).default(100),
        cursor: z.string().min(1).max(64).optional(),
      }).parse(req.query)
      const where = {
        ...(await scopeTenantWhere(req, 'read')),
        ...(q.status && { status: q.status }),
      }
      // A cursor from another company (or a made-up one) is simply not found:
      // the page starts after a row the operator can see, or the request is 404.
      // Checked against the company scope only — the cursor card may have
      // left the status filter (spent, expired, voided) since the last page.
      if (q.cursor && !(await prisma.giftCard.findFirst({ where: { id: q.cursor, ...(await scopeTenantWhere(req, 'read')) }, select: { id: true } }))) {
        throw new NotFoundError('GiftCard', q.cursor)
      }
      const [rows, total] = await Promise.all([
        prisma.giftCard.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.limit + 1,
          ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
        }),
        prisma.giftCard.count({ where }),
      ])
      const page = rows.slice(0, q.limit)
      const nextCursor = rows.length > q.limit ? page[page.length - 1]!.id : null
      const items = seesFullCard(req) ? page : page.map((c) => ({
        ...c,
        code: maskGiftCardCode(c.code),
        buyerEmail: null, recipientEmail: null, buyerCustomerId: null, message: null,
      }))
      return { items, nextCursor, total }
    },
  )

  // The 2080 books check, per company in view: the ledger's Gift Card
  // Liability against what the cards say is owed (live balances + value spent
  // on orders whose sale is not booked yet), the difference, cards whose sale
  // never reached the books, voided and expired cards still holding value
  // (a manager settles them), the breakage booked (H11: count + cents, per
  // company) and breakage held for the sweep.
  fastify.get(
    '/reconcile',
    { preHandler: requireAuth(...GIFT_CARD_READERS) },
    async (req) => {
      const scope = await resolveTenantScope(req)
      if (scope.tenantIds.length === 0) return { companies: [] }
      const companies = await prisma.tenant.findMany({
        where: { id: { in: scope.tenantIds } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      })
      const full = seesFullCard(req)
      const out = []
      for (const c of companies) {
        const check = await giftCardBooksCheck(c.id, c.name)
        if (!full) {
          check.issueNotBooked.items = check.issueNotBooked.items.map((i) => ({ ...i, code: maskGiftCardCode(i.code) }))
          check.voidedHoldingValue.items = check.voidedHoldingValue.items.map((i) => ({ ...i, code: maskGiftCardCode(i.code) }))
          check.expiredHoldingValue.items = check.expiredHoldingValue.items.map((i) => ({ ...i, code: maskGiftCardCode(i.code) }))
          check.breakageHeld.items = check.breakageHeld.items.map((i) => ({ ...i, code: maskGiftCardCode(i.code) }))
        }
        out.push(check)
      }
      return { companies: out }
    },
  )

  // One card's history — what was spent, against which order, and what was
  // put back by a refund (reversedAt). The card must be one of the companies
  // in view; another company's card is 404. This is the card's own ledger:
  // the page used to send people to the accounting audit log for it, which
  // finance cannot open (accounting_audit is CEO + management).
  fastify.get<{ Params: { id: string } }>(
    '/:id/redemptions',
    { preHandler: requireAuth(...GIFT_CARD_READERS) },
    async (req) => {
      const card = await prisma.giftCard.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        select: {
          id: true, tenantId: true, code: true, kind: true, issuedAmountCents: true, balanceCents: true, status: true,
          createdAt: true, expiresAt: true, expiredAt: true, voidedAt: true, voidReason: true, voidDisposition: true,
          paymentMethod: true, bankAccountId: true, paymentRef: true,
        },
      })
      if (!card) throw new NotFoundError('GiftCard', req.params.id)
      const redemptions = await prisma.giftCardRedemption.findMany({
        where: { giftCardId: card.id },
        orderBy: { redeemedAt: 'desc' },
        take: 200,
        select: {
          id: true, amountCents: true, balanceAfter: true, redeemedAt: true, reversedAt: true,
          order: { select: { id: true, placedAt: true, status: true } },
        },
      })
      return { card: seesFullCard(req) ? card : { ...card, code: maskGiftCardCode(card.code) }, redemptions }
    },
  )

  // Issue — a sold card (back office: managers + finance) or a promotional
  // one (managers, with a reason). The card and its entry are one transaction:
  // if the books refuse, no card exists and the error comes back.
  //   body: paymentMethod (RECEIPT_METHODS) + paymentRef (required on a sold
  //         card, refused on a promotional one: 422 PROMO_CARD_NOT_PAID) +
  //         bankAccountId (bank-type methods; the ACTIVE company's bank only).
  //   201:  the card + referenceUsedBefore: PaymentRefUse[] (a warning).
  fastify.post('/', { preHandler: requireAuth(...GIFT_CARD_SELLERS) }, async (req, reply) => {
    const body = z.object({
      kind:              z.enum(['sold', 'promotional']).default('sold'),
      issuedAmountCents: z.number().int().min(10_000).max(10_000_000),  // PKR 100 – PKR 100k
      buyerCustomerId:   z.string().uuid().nullable().optional(),
      buyerEmail:        z.string().email().nullable().optional(),
      recipientName:     z.string().max(120).nullable().optional(),
      recipientEmail:    z.string().email().nullable().optional(),
      message:           z.string().max(500).nullable().optional(),
      conceptId:         z.string().uuid().nullable().optional(),
      expiresAt:         z.string().datetime().nullable().optional(),
      paymentMethod:     zReceiptMethod(GIFT_CARD_PAYMENT_METHODS).nullable().optional(),
      paymentRef:        zPaymentRef.nullable().optional(),
      bankAccountId:     z.string().min(1).max(64).nullable().optional(),
      reason:            z.string().trim().min(3).max(300).nullable().optional(),
    }).parse(req.body)

    if (body.kind === 'promotional' && !PROMO_ISSUERS.has(req.staffUser!.role)) {
      throw new AppError('FORBIDDEN', 'Only a manager can give a promotional gift card', 403)
    }
    if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
      throw new AppError('EXPIRY_IN_PAST', 'The expiry date must be in the future', 422)
    }

    // The card belongs to the ACTIVE company; a brand, if named, must be one
    // of that company's; a bank account must be one of that company's
    // (books.ts → moneyAccountCode, 422 otherwise).
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')

    const card = await issueGiftCard({
      tenantId,
      kind: body.kind,
      issuedAmountCents: body.issuedAmountCents,
      paymentMethod: (body.paymentMethod as typeof GIFT_CARD_PAYMENT_METHODS[number] | null | undefined) ?? null,
      paymentRef: body.paymentRef ?? null,
      bankAccountId: body.bankAccountId ?? null,
      reason: body.reason ?? null,
      conceptId: body.conceptId ?? null,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      buyerCustomerId: body.buyerCustomerId ?? null,
      buyerEmail: body.buyerEmail ?? null,
      recipientName: body.recipientName ?? null,
      recipientEmail: body.recipientEmail ?? null,
      message: body.message ?? null,
      issuedById: req.staffUser?.id ?? null,
    })

    await audit({ category: 'identity',
      action: 'giftcard.issue', entity: 'GiftCard', entityId: card.id,
      userId: req.staffUser?.id ?? null, tenantId, userEmail: req.staffUser?.email ?? null,
      after: { code: card.code, amount: card.issuedAmountCents, kind: card.kind, paymentMethod: card.paymentMethod, paymentRef: card.paymentRef, bankAccountId: card.bankAccountId },
      ...(body.kind === 'promotional' && { metadata: { reason: body.reason } }),
    })

    // Where else THIS company recorded the same reference — saved anyway.
    const referenceUsedBefore = card.paymentRef
      ? await findPaymentReferenceUses(prisma, tenantId, card.paymentRef, { exclude: { kind: 'gift_card', id: card.id } })
      : []
    return reply.status(201).send({ ...card, referenceUsedBefore })
  })

  // Book the sale of a card whose issue entry never posted (cards issued
  // before 2026-10-13, when it was log-only). The books check lists them.
  //   body: paymentMethod (RECEIPT_METHODS) + paymentRef (required, every
  //         method) + bankAccountId (bank-type; the CARD's company's bank).
  //   200:  { card, entryId, debitCode, referenceUsedBefore }.
  fastify.post<{ Params: { id: string } }>(
    '/:id/book-issue',
    { preHandler: requireAuth(...GIFT_CARD_SELLERS) },
    async (req) => {
      const body = z.object({
        paymentMethod: zReceiptMethod(GIFT_CARD_PAYMENT_METHODS),
        paymentRef:    zPaymentRef.nullable().optional(),
        bankAccountId: z.string().min(1).max(64).nullable().optional(),
      }).parse(req.body)
      const r = await bookMissingIssue({
        cardId: req.params.id,
        scope: await scopeTenantWhere(req, 'write'),
        paymentMethod: body.paymentMethod as typeof GIFT_CARD_PAYMENT_METHODS[number],
        paymentRef: body.paymentRef ?? null,
        bankAccountId: body.bankAccountId ?? null,
        postedBy: req.staffUser?.id ?? 'system',
      })
      await audit({ category: 'identity',
        action: 'giftcard.book_issue', entity: 'GiftCard', entityId: r.card.id,
        userId: req.staffUser?.id ?? null, tenantId: r.card.tenantId, userEmail: req.staffUser?.email ?? null,
        after: { paymentMethod: body.paymentMethod, paymentRef: body.paymentRef?.trim() ?? null, debitCode: r.debitCode, amount: r.card.issuedAmountCents, entryId: r.entryId },
      })
      // The CARD's company — never the operator's other companies.
      const referenceUsedBefore = r.card.tenantId
        ? await findPaymentReferenceUses(prisma, r.card.tenantId, body.paymentRef, { exclude: { kind: 'gift_card', id: r.card.id } })
        : []
      // Finance books the sale but never sees the bearer code or contacts.
      const card = seesFullCard(req) ? r.card : {
        ...r.card, code: maskGiftCardCode(r.card.code), buyerEmail: null, recipientEmail: null, buyerCustomerId: null, message: null,
      }
      return { card, entryId: r.entryId, debitCode: r.debitCode, referenceUsedBefore }
    },
  )

  // Lookup balance by code (no auth — guest checks balance). A card past its
  // expiry reads 'expired' at once, before the daily sweep records it.
  fastify.get<{ Params: { code: string } }>(
    '/balance/:code',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const code = req.params.code.trim().toUpperCase()
      const card = await prisma.giftCard.findUnique({
        where: { code },
        select: { code: true, balanceCents: true, status: true, expiresAt: true, conceptId: true },
      })
      if (!card) throw new NotFoundError('GiftCard', code)
      const pastExpiry = card.status === 'active' && !!card.expiresAt && card.expiresAt < new Date()
      return pastExpiry ? { ...card, status: 'expired' as const } : card
    },
  )

  // Redeem — against an order, always. The one redeem engine (./service.ts).
  // A bill settled at the till (a till sale or a dine-in bill) goes through the
  // POS gift-card tender, which also closes the sale when the card covers what
  // is left; any other open order just has its bill lowered.
  // The order must be one the operator can act on; the card must be of that
  // order's company (owner decision 14) or it is "not found".
  fastify.post<{ Body: { code: string; orderId: string; amountCents?: number } }>(
    '/redeem',
    { preHandler: requireAuth(...ALL_STAFF), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const body = z.object({
        code:        z.string().min(8),
        orderId:     z.string().uuid(),
        amountCents: z.number().int().min(1).optional(),
      }).parse(req.body)

      const order = await prisma.order.findFirst({
        where: { id: body.orderId, concept: { ...(await scopeTenantWhere(req, 'write')) } },
        select: { id: true, source: true, fulfilmentType: true },
      })
      if (!order) throw new NotFoundError('Order', body.orderId)

      if (order.source === 'pos' || order.fulfilmentType === 'dine_in') {
        const { applyGiftCardTender } = await import('../pos/service.js')
        return applyGiftCardTender({
          orderId: order.id,
          code: body.code,
          amountCents: body.amountCents,
          staffId: req.staffUser?.id ?? null,
        })
      }
      const r = await redeemGiftCard({
        code: body.code,
        orderId: order.id,
        amountCents: body.amountCents,
        redeemedById: req.staffUser?.id ?? null,
      })
      return { ...r, completed: false }
    },
  )

  // Void (manager-only — fraud, a refund of an unused card, a payment that
  // never arrived, or an unused promotional card). The balance leaves 2080 in
  // the same transaction (books.ts voidGiftCard). A voided or expired card
  // that a refund later put value back on is settled the same way.
  // Forfeiting a SOLD card keeps the customer's money as breakage income
  // (Dr 2080 / Cr 4200, H11): the CEO (role admin) only — any other manager
  // gets 403 FORFEIT_NEEDS_CEO (after the card is found in their companies, so
  // another company's card is still 404).
  //
  // Finance settles (owner, 2026-10-16): finance with its 'accounting' module
  // may run this on a card that is ALREADY voided or expired and still holds
  // value (the books check's "voided or expired cards holding value") —
  // refund it or settle it as payment not received. Voiding a LIVE card stays
  // with managers (403 VOID_NEEDS_MANAGER, under the card lock); forfeiting a
  // sold card stays the CEO's. Every settle is audited (giftcard.void, with
  // the actor's role).
  fastify.post<{ Params: { id: string } }>(
    '/:id/void',
    { preHandler: [requireAuth(...GIFT_CARD_SETTLERS), financeNeedsAccounting] },
    async (req) => {
      const body = z.object({
        reason:        z.string().trim().min(3).max(300),
        disposition:   z.enum(VOID_DISPOSITIONS),
        // Money OUT: its own list (no "bank deposit" as a refund method).
        refundMethod:  z.enum(GIFT_CARD_REFUND_METHODS).nullable().optional(),
        bankAccountId: z.string().min(1).max(64).nullable().optional(),
      }).parse(req.body)
      const r = await voidGiftCard({
        cardId: req.params.id,
        scope: await scopeTenantWhere(req, 'write'),
        reason: body.reason,
        disposition: body.disposition,
        refundMethod: body.refundMethod ?? null,
        bankAccountId: body.bankAccountId ?? null,
        postedBy: req.staffUser?.id ?? 'system',
        canForfeitSold: (ADMIN_ONLY as string[]).includes(req.staffUser!.role),
        settleOnly: !LIVE_CARD_VOIDERS.has(req.staffUser!.role),
      })
      await audit({ category: 'identity',
        action: 'giftcard.void', entity: 'GiftCard', entityId: r.card.id,
        userId: req.staffUser?.id ?? null, tenantId: r.card.tenantId, userEmail: req.staffUser?.email ?? null,
        before: { status: r.before.status, balance: r.before.balanceCents },
        after:  { status: 'voided', disposition: body.disposition, creditCode: r.creditCode, postedCents: r.postedCents },
        metadata: { reason: body.reason, refundMethod: body.refundMethod ?? null, entryId: r.entryId, actorRole: req.staffUser!.role, settle: r.before.status !== 'active' },
      })
      return { ...r.card, postedCents: r.postedCents, creditCode: r.creditCode, entryId: r.entryId, unpaidSpentCents: r.unpaidSpentCents }
    },
  )
}
