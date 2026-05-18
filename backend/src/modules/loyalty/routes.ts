import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'

// ─── Points configuration ────────────────────────────────────────────────
// Live values are read from the Settings table (key-value store) so the
// CEO can tune earn/redeem rates / expiry / minimum redeem from the
// admin Loyalty page without a deploy. Hardcoded constants below are
// the BOOTSTRAP DEFAULTS used when no Setting row exists yet, and also
// as a fallback in case Settings lookup fails (so loyalty never crashes
// a checkout).

const LOYALTY_SETTING_KEYS = [
  'loyalty.earn_cents_per_point',   // cents of spend that earns one point — default 100 (= 1 pt per PKR 1)
  'loyalty.point_value_cents',      // value of one point at redeem — default 100 (= PKR 1)
  'loyalty.min_redeem_points',      // minimum points needed to redeem in one go
  'loyalty.expiry_months',          // months before unused points expire
  'loyalty.birthday_bonus_points',  // points auto-credited on birthday
  'loyalty.stamp_threshold',        // visits to earn one free item via stamps (per concept)
] as const

const LOYALTY_DEFAULTS: Record<typeof LOYALTY_SETTING_KEYS[number], number> = {
  'loyalty.earn_cents_per_point':  100,
  'loyalty.point_value_cents':     100,
  'loyalty.min_redeem_points':     50,
  'loyalty.expiry_months':         12,
  'loyalty.birthday_bonus_points': 500,
  'loyalty.stamp_threshold':       9,
}

// Small cache so we don't hit Settings on every order — invalidated when
// the operator saves new values via PATCH /loyalty/settings below.
let _loyaltyCache: { values: typeof LOYALTY_DEFAULTS; expiresAt: number } | null = null
const LOYALTY_CACHE_TTL_MS = 60_000

async function loadLoyaltySettings(): Promise<typeof LOYALTY_DEFAULTS> {
  if (_loyaltyCache && _loyaltyCache.expiresAt > Date.now()) return _loyaltyCache.values
  try {
    const rows = await prisma.setting.findMany({ where: { key: { in: [...LOYALTY_SETTING_KEYS] } } })
    const out = { ...LOYALTY_DEFAULTS }
    for (const r of rows) {
      const n = Number(r.value)
      if (Number.isFinite(n) && n >= 0) (out as Record<string, number>)[r.key] = n
    }
    _loyaltyCache = { values: out, expiresAt: Date.now() + LOYALTY_CACHE_TTL_MS }
    return out
  } catch {
    return { ...LOYALTY_DEFAULTS }
  }
}

async function calculatePointsEarned(totalCents: number): Promise<number> {
  const s = await loadLoyaltySettings()
  const denom = s['loyalty.earn_cents_per_point'] || 100
  return Math.floor(totalCents / denom)
}

async function calculatePointsValue(points: number): Promise<number> {
  const s = await loadLoyaltySettings()
  return Math.floor(points) * (s['loyalty.point_value_cents'] || 100)
}

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
      pointsValueCents: await calculatePointsValue(account.pointsBalance),
    }
  })

  // POST /loyalty/redeem — redeem points against an order
  fastify.post('/redeem', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { orderId, pointsToRedeem } = z
      .object({ orderId: z.string().uuid(), pointsToRedeem: z.number().int().min(1) })
      .parse(req.body)

    // Verify order belongs to this customer
    const order = await prisma.order.findFirst({ where: { id: orderId, customerId: req.customer!.id } })
    if (!order) throw new NotFoundError('Order', orderId)

    const discountCents = await calculatePointsValue(pointsToRedeem)

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
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })

      let account = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
      if (!account) {
        account = await prisma.loyaltyAccount.create({
          data: { customerId, stampCounts: {} },
        })
      }

      const settings = await loadLoyaltySettings()
      const points = await calculatePointsEarned(totalCents)
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

  // ─── Admin: loyalty global settings ────────────────────────────────────
  // GET reads the current values (with defaults filled in for any unset
  // keys); PATCH accepts a partial object and writes only the keys
  // present in the body. Cache is busted on PATCH so subsequent earns
  // pick up the new values immediately.

  fastify.get('/settings', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const values = await loadLoyaltySettings()
    return { values, defaults: LOYALTY_DEFAULTS }
  })

  fastify.patch('/settings', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object(
      Object.fromEntries(
        LOYALTY_SETTING_KEYS.map((k) => [k, z.number().int().min(0).max(1_000_000).optional()]),
      ) as Record<typeof LOYALTY_SETTING_KEYS[number], z.ZodOptional<z.ZodNumber>>,
    ).parse(req.body)

    await prisma.$transaction(
      Object.entries(body)
        .filter(([, v]) => typeof v === 'number')
        .map(([key, value]) =>
          prisma.setting.upsert({
            where:  { key },
            create: { key, value: String(value) },
            update: { value: String(value) },
          }),
        ),
    )
    _loyaltyCache = null    // bust so next earn re-reads
    return loadLoyaltySettings().then((values) => ({ values }))
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
