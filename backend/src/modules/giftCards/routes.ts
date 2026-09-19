// Gift cards.
//
// Issuance: Dr Cash/Card / Cr Gift Card Liability (2080).
// Redemption: Dr Gift Card Liability / Cr Revenue (or Cr cash receivable when used at POS).
//
// Codes are 12 chars in groups of 4 (GS-XXXX-XXXX), generated from a 32-char
// alphabet. Looked up case-insensitively.

import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { postJournalEntry, ACCT } from '../accounting/journal.js'

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

export async function giftCardRoutes(fastify: FastifyInstance) {
  // List — scoped to active tenant (cards bound to one of its concepts, or
  // unscoped null-concept cards which are tenant-portable by design).
  fastify.get<{ Querystring: { status?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      return prisma.giftCard.findMany({
        where: {
          ...(req.query.status && { status: req.query.status as never }),
          OR: [
            { conceptId: null },
            { conceptId: { in: tenantConceptIds } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
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

    // If issuing under a concept, verify it's in the active tenant.
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }

    // Generate a unique code (loop in the unlikely case of collision)
    let code = generateCode()
    for (let i = 0; i < 5; i++) {
      const exists = await prisma.giftCard.findUnique({ where: { code } })
      if (!exists) break
      code = generateCode()
    }

    const card = await prisma.giftCard.create({
      data: {
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

    // Journal: Dr cash/card, Cr Gift Card Liability (2080). Books belong to
    // the card's brand, or to the company the operator is selling it in.
    const jeTenantId = card.conceptId
      ? (await prisma.concept.findUnique({ where: { id: card.conceptId }, select: { tenantId: true } }))?.tenantId ?? req.staffUser!.tenantId
      : req.staffUser!.tenantId
    await postJournalEntry({
      tenantId: jeTenantId!,
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
      userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
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

  // Redeem
  fastify.post<{ Body: { code: string; amountCents: number; orderId?: string } }>(
    '/redeem',
    { preHandler: requireAuth(...ALL_STAFF), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z.object({
        code:        z.string().min(8),
        amountCents: z.number().int().min(1),
        orderId:     z.string().uuid().optional(),
      }).parse(req.body)
      const code = body.code.trim().toUpperCase()

      return prisma.$transaction(async (tx) => {
        // Read first only to surface friendly errors (expired, inactive, not-found).
        const card = await tx.giftCard.findUnique({ where: { code } })
        if (!card) throw new NotFoundError('GiftCard', code)
        if (card.status !== 'active') throw new AppError('GIFTCARD_INACTIVE', `Card is ${card.status}`, 422)
        if (card.expiresAt && card.expiresAt < new Date()) {
          await tx.giftCard.update({ where: { id: card.id }, data: { status: 'expired' } })
          throw new AppError('GIFTCARD_EXPIRED', 'Gift card has expired', 422)
        }

        // Atomic conditional decrement: only succeeds if balance still covers the
        // requested amount. Two concurrent /redeem calls cannot both pass — the
        // second updateMany returns count=0 because the WHERE clause no longer matches.
        const dec = await tx.giftCard.updateMany({
          where: { id: card.id, status: 'active', balanceCents: { gte: body.amountCents } },
          data: { balanceCents: { decrement: body.amountCents } },
        })
        if (dec.count === 0) {
          throw new AppError('INSUFFICIENT_BALANCE', `Card has only PKR ${(card.balanceCents / 100).toFixed(2)} remaining (race or already redeemed)`, 422)
        }

        // Re-read to get the post-decrement balance and finalise status if 0.
        const post = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id } })
        const updated = post.balanceCents === 0 && post.status === 'active'
          ? await tx.giftCard.update({ where: { id: card.id }, data: { status: 'redeemed_full' } })
          : post

        const redemption = await tx.giftCardRedemption.create({
          data: {
            giftCardId: card.id,
            orderId: body.orderId ?? null,
            amountCents: body.amountCents,
            balanceAfter: updated.balanceCents,
            redeemedById: req.staffUser?.id ?? null,
          },
        })

        return { card: updated, redemption }
      })
    },
  )

  // Void (manager-only — for fraud / refund of unused cards)
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/:id/void',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({ reason: z.string().min(3).max(300) }).parse(req.body)
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      const card = await prisma.giftCard.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { conceptId: { in: tenantConceptIds } },
          ],
        },
      })
      if (!card) throw new NotFoundError('GiftCard', req.params.id)
      const updated = await prisma.giftCard.update({
        where: { id: card.id },
        data: { status: 'voided', voidedAt: new Date(), voidReason: body.reason },
      })
      await audit({ category: 'identity',
        action: 'giftcard.void', entity: 'GiftCard', entityId: card.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        before: { status: card.status, balance: card.balanceCents },
        after:  { status: 'voided' },
        metadata: { reason: body.reason },
      })
      return updated
    },
  )
}
