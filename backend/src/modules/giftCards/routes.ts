// Gift cards.
//
// Issuance: Dr Cash/Card / Cr Gift Card Liability (2080).
// Redemption: ./service.ts (the one redeem engine — storefront checkout, the
// till tender and POST /gift-cards/redeem). The liability is not yet debited
// on redemption; see service.ts.
//
// Codes are 12 chars in groups of 4 (GS-XXXX-XXXX), generated from a 32-char
// alphabet. Looked up case-insensitively.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, FINANCE_TEAM } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'
import { scopeTenantWhere, assertConceptOwned, activeTenantId } from '../../lib/tenantScope.js'
import { redeemGiftCard } from './service.js'

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'  // no 0/O/1/I confusion
function generateCode(): string {
  // Use CSPRNG bytes mapped onto the unambiguous alphabet — Math.random's
  // state is recoverable from a handful of outputs, so a leaked card code
  // could expose the PRNG and let an attacker enumerate future cards.
  let block = ''
  const bytes = randomBytes(8)
  for (let i = 0; i < 8; i++) block += ALPHABET[bytes[i]! % ALPHABET.length]
  return `GS-${block.slice(0, 4)}-${block.slice(4)}`
}

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

// A card's code is a bearer credential: whoever holds it can spend the
// customer's balance through the ALL_STAFF redeem. Finance reconciles the 2080
// liability and needs neither the code nor the buyer's / recipient's contact
// details, so outside the manager tiers (who read the full register as before)
// the code is masked to its last 4 and the emails and gift message are blanked
// (review W3B-RV-2). The redeem engine still takes a code presented at the till.
const FULL_CARD_READERS = new Set<string>(MANAGERS)
const seesFullCard = (req: FastifyRequest) => FULL_CARD_READERS.has(req.staffUser!.role)
export const maskGiftCardCode = (code: string) => `••••${code.slice(-4)}`

export async function giftCardRoutes(fastify: FastifyInstance) {
  // List — the companies in view.
  fastify.get<{ Querystring: { status?: string } }>(
    '/',
    { preHandler: requireAuth(...GIFT_CARD_READERS) },
    async (req) => {
      const cards = await prisma.giftCard.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
          ...(req.query.status && { status: req.query.status as never }),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
      if (seesFullCard(req)) return cards
      return cards.map((c) => ({
        ...c,
        code: maskGiftCardCode(c.code),
        buyerEmail: null, recipientEmail: null, buyerCustomerId: null, message: null,
      }))
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
        select: { id: true, code: true, issuedAmountCents: true, balanceCents: true, status: true, createdAt: true, voidedAt: true, voidReason: true },
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

  // Issue
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      issuedAmountCents: z.number().int().min(10_000).max(10_000_000),  // PKR 100 – PKR 100k
      buyerCustomerId:   z.string().uuid().nullable().optional(),
      buyerEmail:        z.string().email().nullable().optional(),
      recipientName:     z.string().max(120).nullable().optional(),
      recipientEmail:    z.string().email().nullable().optional(),
      message:           z.string().max(500).nullable().optional(),
      conceptId:         z.string().uuid().nullable().optional(),
      expiresAt:         z.string().datetime().nullable().optional(),
      paymentMethod:     z.enum(['cash', 'card', 'bank_transfer']).default('card'),
    }).parse(req.body)

    // The card belongs to the ACTIVE company; a brand, if named, must be one
    // of that company's.
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')

    // Generate a unique code (loop in the unlikely case of collision)
    let code = generateCode()
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.giftCard.findUnique({ where: { code } })
      if (!exists) break
      code = generateCode()
    }

    const card = await prisma.giftCard.create({
      data: {
        tenantId,
        code,
        issuedAmountCents: body.issuedAmountCents,
        balanceCents: body.issuedAmountCents,
        buyerCustomerId: body.buyerCustomerId ?? null,
        buyerEmail: body.buyerEmail ?? null,
        recipientName: body.recipientName ?? null,
        recipientEmail: body.recipientEmail ?? null,
        message: body.message ?? null,
        conceptId: body.conceptId ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        issuedById: req.staffUser?.id ?? null,
      },
    })

    // Journal: Dr cash/card, Cr Gift Card Liability (2080) in the books of
    // the company that sold the card (the brand, if any, is of that company).
    await postJournalEntry({
      tenantId,
      sourceType: 'giftcard.issue',
      sourceId: card.id,
      description: `Gift card issued · ${card.code}`,
      lines: [
        { accountCode: body.paymentMethod === 'cash' ? ACCT.CASH_ON_HAND : ACCT.CARD_RECEIVABLE,
          type: 'debit',  amountCents: body.issuedAmountCents, memo: `Issue ${card.code}` },
        { accountCode: '2080',
          type: 'credit', amountCents: body.issuedAmountCents, memo: `Gift card liability ${card.code}` },
      ],
      postedBy: req.staffUser?.id ?? 'system',
    }).catch((err) => req.log.error({ err: (err as Error).message }, 'gift card JE failed'))

    await audit({ category: 'identity',
      action: 'giftcard.issue', entity: 'GiftCard', entityId: card.id,
      userId: req.staffUser?.id ?? null, tenantId, userEmail: req.staffUser?.email ?? null,
      after: { code: card.code, amount: card.issuedAmountCents },
    })

    return reply.status(201).send(card)
  })

  // Lookup balance by code (no auth — guest checks balance)
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
      return card
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

  // Void (manager-only — for fraud / refund of unused cards)
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/void',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
      const card = await prisma.giftCard.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      })
      if (!card) throw new NotFoundError('GiftCard', req.params.id)
      const updated = await prisma.giftCard.update({
        where: { id: card.id },
        data: { status: 'voided', voidedAt: new Date(), voidReason: body.reason },
      })
      await audit({ category: 'identity',
        action: 'giftcard.void', entity: 'GiftCard', entityId: card.id,
        userId: req.staffUser?.id ?? null, tenantId: card.tenantId, userEmail: req.staffUser?.email ?? null,
        before: { status: card.status, balance: card.balanceCents },
        after:  { status: 'voided' },
        metadata: { reason: body.reason },
      })
      return updated
    },
  )
}
