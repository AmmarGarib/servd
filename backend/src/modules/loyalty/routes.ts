import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { primaryTenantId } from '../../lib/setup-config.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import {
  LOYALTY_SETTING_KEYS, LOYALTY_DEFAULTS, loadLoyaltySettings,
  calculatePointsEarned, calculatePointsValue, invalidateLoyaltySettings,
} from '../../lib/loyaltySettings.js'
import { loadCompanyLoyaltySettings, saveCompanyLoyaltySettings } from './settings.js'

// ─── Points configuration ────────────────────────────────────────────────
// Live values are read from the Settings table (key-value store) so the
// CEO can tune earn/redeem rates / expiry / minimum redeem from the
// admin Loyalty page without a deploy. Hardcoded constants below are
// the BOOTSTRAP DEFAULTS used when no Setting row exists yet, and also
// as a fallback in case Settings lookup fails (so loyalty never crashes
// a checkout).


// Tier schema — used by POST/PATCH /loyalty/tiers below. Mirrors the
// Prisma model. customPerks is a string array of free-form bullets.
const tierBody = z.object({
  tier:                  z.string().min(2).max(40).regex(/^[a-z0-9-]+$/i, 'lowercase slug, letters/numbers/-'),
  displayName:           z.string().min(1).max(80).optional().nullable(),
  rank:                  z.number().int().min(0).max(99).default(0),
  isPaid:                z.boolean().default(false),
  monthlyPriceCents:     z.number().int().min(0).max(10_000_00).optional().nullable(),
  unlockSpendCents:      z.number().int().min(0).max(100_000_000).optional().nullable(),
  isActive:              z.boolean().default(true),
  alwaysFreeDelivery:    z.boolean().default(false),
  freeDeliveryAboveCents: z.number().int().min(0).optional().nullable(),
  birthdayDiscountPct:   z.number().int().min(0).max(100).optional().nullable(),
  priorityReservationDays: z.number().int().min(0).max(180).optional().nullable(),
  waitlistPriority:      z.boolean().default(false),
  monthlyCompCents:      z.number().int().min(0).optional().nullable(),
  earlyMenuAccess:       z.boolean().default(false),
  freeBirthdayItem:      z.boolean().default(false),
  customPerks:           z.array(z.string().min(1).max(200)).max(20).default([]),
  description:           z.string().max(500).optional().nullable(),
})

export async function loyaltyRoutes(fastify: FastifyInstance) {
  // GET /loyalty/account — authenticated customer's balance
  fastify.get('/account', { preHandler: requireCustomerAuth }, async (req) => {
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.customer!.id },
      include: {
        transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
        customer: { select: { name: true, email: true } },
      },
    })
    if (!account) throw new NotFoundError('LoyaltyAccount')

    return {
      ...account,
      // One loyalty account spans companies; the balance is shown at the
      // primary company's point value (a per-company account is an owner call).
      pointsValueCents: await calculatePointsValue(account.pointsBalance, await primaryTenantId()),
    }
  })

  // POST /loyalty/redeem — redeem points against an order
  fastify.post('/redeem', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { orderId, pointsToRedeem } = z
      .object({ orderId: z.string().uuid(), pointsToRedeem: z.number().int().min(1) })
      .parse(req.body)

    // Verify order belongs to this customer
    const order = await prisma.order.findFirst({ where: { id: orderId, customerId: req.customer!.id }, include: { concept: { select: { tenantId: true } } } })
    if (!order) throw new NotFoundError('Order', orderId)

    // The order has to still be open. Ownership was the only check, so a
    // customer could redeem against an order that was already completed,
    // cancelled or refunded — incrementing discountCents on a settled bill,
    // which inflates the discount line in the P&L and makes postLoyaltyRedeem
    // discharge liability against a transaction that is closed.
    const SETTLED: string[] = ['completed', 'cancelled', 'rejected', 'refunded']
    if (SETTLED.includes(order.status)) {
      throw new AppError('ORDER_NOT_OPEN', 'That order is already closed — points cannot be redeemed against it.', 422)
    }

    // And it has to be redeemable once. There was no idempotency at all, so the
    // same order could be redeemed against repeatedly, each call adding to
    // discountCents.
    const already = await prisma.loyaltyTransaction.findFirst({
      where: { orderId, type: 'redeem' },
      select: { id: true },
    })
    if (already) {
      throw new AppError('ALREADY_REDEEMED', 'Points have already been redeemed on this order.', 409)
    }

    // Points are worth what the brand's company says (settings are per company).
    const discountCents = await calculatePointsValue(pointsToRedeem, order.concept.tenantId)

    // Atomic: conditional update prevents race condition where two concurrent requests
    // both pass a balance check and both decrement, driving balance negative
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.loyaltyAccount.updateMany({
        where: { customerId: req.customer!.id, pointsBalance: { gte: pointsToRedeem } },
        data: { pointsBalance: { decrement: pointsToRedeem } },
      })
      if (updated.count === 0) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)

      const account = await tx.loyaltyAccount.findUnique({
        where: { customerId: req.customer!.id },
        select: { id: true, pointsBalance: true },
      })

      const ltx = await tx.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: account!.id,
          orderId,
          type: 'redeem',
          pointsDelta: -pointsToRedeem,
          description: `Redeemed ${pointsToRedeem} pts for PKR ${discountCents / 100} discount`,
        },
      })
      await tx.order.update({
        where: { id: orderId },
        data: { discountCents: { increment: discountCents } },
      })
      return { newBalance: account!.pointsBalance, loyaltyTxId: ltx.id }
    })

    // Fire-and-forget liability discharge — posting failures are non-blocking
    const { postLoyaltyRedeem } = await import('../accounting/loyaltyPosting.js')
    postLoyaltyRedeem(result.loyaltyTxId).catch((err) =>
      req.log.error({ err: (err as Error).message, ltxId: result.loyaltyTxId }, 'postLoyaltyRedeem failed'),
    )

    return reply.status(200).send({
      pointsRedeemed: pointsToRedeem,
      discountCents,
      newBalance: result.newBalance,
    })
  })

  // POST /loyalty/earn (internal — called after order completion)
  fastify.post(
    '/earn',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { customerId, orderId, totalCents, conceptSlug } = z.object({
        customerId: z.string().uuid(),
        orderId: z.string().uuid(),
        totalCents: z.number().int().positive(),
        conceptSlug: z.string().min(1).max(80),
      }).parse(req.body)

      // Verify the order belongs to one of our tenant's concepts.
      const order = await prisma.order.findFirst({
        where: {
          id: orderId,
          customerId,
          concept: { ...(await scopeTenantWhere(req, 'write')), deletedAt: null },
        },
        include: { concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })

      // Points come from what the order is actually worth, not from a number in
      // the request body. `totalCents` was taken on trust and fed straight into
      // calculatePointsEarned, so whoever called this decided how many points
      // to mint — and the liability posted to the ledger followed the same
      // number. The body value is now only accepted if it matches the order.
      if (totalCents !== order.totalCents) {
        return reply.status(422).send({
          error: {
            code: 'TOTAL_MISMATCH',
            message: `Order total is ${order.totalCents}, not ${totalCents}. Points are earned on the order's real total.`,
          },
        })
      }

      // Earning is once per order. There was no idempotency, so re-calling this
      // minted a fresh batch of points and a fresh liability accrual every time.
      const earned = await prisma.loyaltyTransaction.findFirst({
        where: { orderId, type: 'earn' },
        select: { id: true },
      })
      if (earned) {
        return reply.status(409).send({
          error: { code: 'ALREADY_EARNED', message: 'Points have already been awarded for this order.' },
        })
      }

      let account = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
      if (!account) {
        account = await prisma.loyaltyAccount.create({
          data: { customerId, stampCounts: {} },
        })
      }

      const settings = await loadLoyaltySettings(order.concept.tenantId)
      const points = await calculatePointsEarned(order.totalCents, order.concept.tenantId)
      const stampThreshold = settings['loyalty.stamp_threshold'] || 9

      // Stamp card logic
      const stampCounts: Record<string, number> =
        account.stampCounts && typeof account.stampCounts === 'object' && !Array.isArray(account.stampCounts)
          ? (account.stampCounts as Record<string, number>)
          : {}
      const currentStamps = stampCounts[conceptSlug] ?? 0
      const newStamps = (currentStamps + 1) % (stampThreshold + 1)
      const earnedFreeItem = newStamps === 0 && currentStamps === stampThreshold
      stampCounts[conceptSlug] = newStamps

      const [, earnTx] = await prisma.$transaction([
        prisma.loyaltyAccount.update({
          where: { id: account.id },
          data: {
            pointsBalance: { increment: points },
            lifetimePoints: { increment: points },
            stampCounts,
          },
        }),
        prisma.loyaltyTransaction.create({
          data: {
            loyaltyAccountId: account.id,
            orderId,
            type: 'earn',
            pointsDelta: points,
            description: `Earned ${points} pts from order`,
          },
        }),
      ])

      // Accrue the liability for the points just issued
      const { postLoyaltyEarn } = await import('../accounting/loyaltyPosting.js')
      postLoyaltyEarn(earnTx.id).catch((err) =>
        req.log.error({ err: (err as Error).message, ltxId: earnTx.id }, 'postLoyaltyEarn failed'),
      )

      return reply.status(200).send({ pointsEarned: points, earnedFreeItem, stamps: stampCounts })
    },
  )

  // ─── Admin: loyalty settings (per company) ──────────────────────────────
  // GET reads the ACTIVE company's values (defaults filled in for unset keys;
  // the old platform-wide values are copied in the first time); PATCH writes
  // only the keys present in the body, for the active company only. See
  // ./settings.ts. The shared cache is busted on PATCH as before.

  const activeCompany = (req: { staffUser?: { tenantId: string | null } }): string => {
    const t = req.staffUser?.tenantId
    if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company to see its loyalty settings', 422)
    return t
  }

  fastify.get('/settings', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const values = await loadCompanyLoyaltySettings(activeCompany(req))
    return { values, defaults: LOYALTY_DEFAULTS }
  })

  fastify.patch('/settings', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenantId = activeCompany(req)
    const body = z.object(
      Object.fromEntries(
        LOYALTY_SETTING_KEYS.map((k) => [k, z.number().int().min(0).max(1_000_000).optional()]),
      ) as Record<typeof LOYALTY_SETTING_KEYS[number], z.ZodOptional<z.ZodNumber>>,
    ).parse(req.body)

    const values = await saveCompanyLoyaltySettings(tenantId, body)
    invalidateLoyaltySettings()    // bust so next earn re-reads
    return { values }
  })

  // ─── Admin: tier CRUD ──────────────────────────────────────────────────
  // Tiers are global (not per-tenant) since loyalty membership applies
  // platform-wide across every kitchen. Operator manages them from
  // /configuration/loyalty.

  fastify.get('/tiers', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const tiers = await prisma.tierConfig.findMany({ orderBy: [{ rank: 'asc' }, { tier: 'asc' }] })
    // Member counts per tier come off LoyaltyAccount.tier (not Customer —
    // the tier field lives on the account row). Informative for the admin
    // list: shows operator how many are on each tier before they touch
    // the toggles.
    const counts = await prisma.loyaltyAccount.groupBy({
      by: ['tier'],
      _count: { _all: true },
    })
    const countMap = new Map(counts.map((c) => [c.tier, c._count._all]))
    return tiers.map((t) => ({ ...t, memberCount: countMap.get(t.tier) ?? 0 }))
  })

  fastify.post('/tiers', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = tierBody.parse(req.body)
    if (body.isPaid && (body.monthlyPriceCents == null || body.monthlyPriceCents <= 0)) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Paid tiers must have a monthlyPriceCents > 0' } })
    }
    const exists = await prisma.tierConfig.findUnique({ where: { tier: body.tier } })
    if (exists) return reply.status(409).send({ error: { code: 'TIER_EXISTS', message: `Tier "${body.tier}" already exists` } })
    const created = await prisma.tierConfig.create({ data: body })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/tiers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = tierBody.partial().parse(req.body)
      // Don't let an operator rename the slug if it's already in use —
      // tier slugs are referenced by Customer.loyaltyTier and silently
      // changing one would unhook every customer from their tier.
      if (body.tier) {
        const existing = await prisma.tierConfig.findUnique({ where: { id: req.params.id } })
        if (existing && existing.tier !== body.tier) {
          return reply.status(400).send({ error: { code: 'IMMUTABLE_SLUG', message: 'Tier slug can\'t change after creation. Delete + recreate if you need a different slug.' } })
        }
      }
      const updated = await prisma.tierConfig.update({ where: { id: req.params.id }, data: body })
      return updated
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/tiers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tier = await prisma.tierConfig.findUnique({ where: { id: req.params.id } })
      if (!tier) throw new NotFoundError('TierConfig', req.params.id)
      // Refuse deletion if customers are assigned — operator should toggle
      // isActive instead (already supported via PATCH). Prevents orphan
      // customers stuck on a slug that no longer maps to perks.
      const assigned = await prisma.loyaltyAccount.count({ where: { tier: tier.tier } })
      if (assigned > 0) {
        return reply.status(400).send({
          error: { code: 'TIER_IN_USE', message: `${assigned} customers are on this tier — toggle Active off instead of deleting.` },
        })
      }
      await prisma.tierConfig.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )
}
