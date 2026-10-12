import { scopeTenantWhere, activeTenantId } from '../../lib/tenantScope.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import {
  LOYALTY_SETTING_KEYS, LOYALTY_DEFAULTS, calculatePointsValue, invalidateLoyaltySettings,
} from '../../lib/loyaltySettings.js'
import { loadCompanyLoyaltySettings, saveCompanyLoyaltySettings } from './settings.js'
import {
  awardOrderPoints, companyOfConceptSlug, loyaltyAccountOf, loyaltyCompanyOf, loyaltyProgram, redeemPointsOnOrder, tierStatus,
} from './service.js'

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

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding crm (CRM → Loyalty) or configuration (the hub's Loyalty tile). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('crm', 'configuration')]

export async function loyaltyRoutes(fastify: FastifyInstance) {
  // GET /loyalty/account?conceptSlug= — authenticated customer's balance at
  // one company: the brand's company, else the company they last ordered
  // from. Points are per company (ONL-04); `companies` lists every company's
  // balance the customer holds, so a page can show them side by side.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/account', { preHandler: requireCustomerAuth }, async (req) => {
    const customerId = req.customer!.id
    const tenantId = (await companyOfConceptSlug(req.query.conceptSlug)) ?? (await loyaltyCompanyOf(customerId))
    const account = tenantId
      ? await prisma.loyaltyAccount.findUnique({
          where: { tenantId_customerId: { tenantId, customerId } },
          include: {
            transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
            customer: { select: { name: true, email: true } },
          },
        })
      : null
    if (!account) throw new NotFoundError('LoyaltyAccount')

    const all = await prisma.loyaltyAccount.findMany({
      where: { customerId },
      select: { tenantId: true, pointsBalance: true, lifetimePoints: true, tier: true },
      orderBy: { createdAt: 'asc' },
    })
    const names = new Map((await prisma.tenant.findMany({
      where: { id: { in: all.map((a) => a.tenantId) } },
      select: { id: true, name: true },
    })).map((t) => [t.id, t.name]))
    return {
      ...account,
      pointsValueCents: await calculatePointsValue(account.pointsBalance, tenantId),
      companies: await Promise.all(all.map(async (a) => ({
        tenantId: a.tenantId,
        companyName: names.get(a.tenantId) ?? null,
        pointsBalance: a.pointsBalance,
        lifetimePoints: a.lifetimePoints,
        tier: a.tier,
        pointsValueCents: await calculatePointsValue(a.pointsBalance, a.tenantId),
      }))),
    }
  })

  // GET /loyalty/program?conceptSlug= — public: what a point is worth and the
  // redeem minimum at this brand's company. Checkout and the account page
  // read these instead of hardcoding a value.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/program', async (req) => {
    return loyaltyProgram(await companyOfConceptSlug(req.query.conceptSlug))
  })

  // GET /loyalty/status?conceptSlug= — the signed-in customer's balance, its
  // value, and where they stand on the tier ladder (TierConfig, unlocked on
  // lifetime spend at the company — owner decision 13). Without a brand, the
  // company they last ordered from.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/status', { preHandler: requireCustomerAuth }, async (req) => {
    const customerId = req.customer!.id
    const tenantId = (await companyOfConceptSlug(req.query.conceptSlug)) ?? (await loyaltyCompanyOf(customerId))
    const [account, program, tiers] = await Promise.all([
      loyaltyAccountOf(customerId, tenantId),
      loyaltyProgram(tenantId),
      tierStatus(customerId, tenantId),
    ])
    const pointsBalance = account?.pointsBalance ?? 0
    return {
      pointsBalance,
      lifetimePoints: account?.lifetimePoints ?? 0,
      pointsValueCents: pointsBalance * program.pointValueCents,
      ...program,
      ...tiers,
    }
  })

  // POST /loyalty/redeem — redeem points against one of the customer's open
  // orders. The one redeem engine (./service.ts): the company's point value,
  // min_redeem_points, and the bill and pending payment come down.
  fastify.post('/redeem', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { orderId, pointsToRedeem } = z
      .object({ orderId: z.string().uuid(), pointsToRedeem: z.number().int().min(1) })
      .parse(req.body)
    const result = await redeemPointsOnOrder({ customerId: req.customer!.id, orderId, points: pointsToRedeem })
    return reply.status(200).send(result)
  })

  // POST /loyalty/earn — manager back-fill: award a completed order's points
  // if they were never awarded (the till completed sales without earning
  // before the loyalty service existed). Idempotent: the one order earn
  // (awardOrderPoints) runs at most once per order.
  fastify.post(
    '/earn',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { orderId } = z.object({ orderId: z.string().uuid() }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: { id: orderId, concept: { ...(await scopeTenantWhere(req, 'write')), deletedAt: null } },
        select: { id: true, status: true, customerId: true },
      })
      if (!order) throw new NotFoundError('Order', orderId)
      if (order.status !== 'completed' || !order.customerId) {
        throw new AppError('ORDER_NOT_ELIGIBLE', 'Only a completed order with a customer earns points', 422)
      }
      const result = await awardOrderPoints(order.id)
      if (!result?.credited) {
        return reply.status(409).send({ error: { code: 'ALREADY_EARNED', message: 'Points have already been awarded for this order.' } })
      }
      return reply.status(200).send({ earned: true, earnedFreeItem: result.earnedFreeItem, stamps: result.stamps })
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

  // Access (wave 3, UI-06): the loyalty programme (earn/redeem rates, tier
  // ladder) is run from CRM → Loyalty, a Marketing-workspace page, so settings
  // and tiers are MARKETING_TEAM. Moving points into one customer's account
  // (POST /earn) stays MANAGERS.
  fastify.get('/settings', { preHandler: marketingGuard }, async (req) => {
    const values = await loadCompanyLoyaltySettings(activeCompany(req))
    return { values, defaults: LOYALTY_DEFAULTS }
  })

  fastify.patch('/settings', { preHandler: marketingGuard }, async (req) => {
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
  // THE tier ladder (owner decision 13): free tiers unlock on lifetime spend
  // (unlockSpendCents) and are assigned by the loyalty service when an order
  // completes; the storefront reads the ladder via GET /loyalty/status.
  // Each company has its own ladder (owner decision 13): the list shows the
  // companies in view, and every write pins to the active company.

  fastify.get('/tiers', { preHandler: marketingGuard }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const tiers = await prisma.tierConfig.findMany({ where: scope, orderBy: [{ rank: 'asc' }, { tier: 'asc' }] })
    // Member counts per tier come off LoyaltyAccount.tier (not Customer —
    // the tier field lives on the account row), counted per company: an
    // account is one company's (ONL-04), and a tier is one company's ladder.
    const counts = await prisma.loyaltyAccount.groupBy({
      by: ['tenantId', 'tier'],
      where: scope,
      _count: { _all: true },
    })
    const countMap = new Map(counts.map((c) => [`${c.tenantId}|${c.tier}`, c._count._all]))
    return tiers.map((t) => ({ ...t, memberCount: countMap.get(`${t.tenantId}|${t.tier}`) ?? 0 }))
  })

  fastify.post('/tiers', { preHandler: marketingGuard }, async (req, reply) => {
    const body = tierBody.parse(req.body)
    if (body.isPaid && (body.monthlyPriceCents == null || body.monthlyPriceCents <= 0)) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Paid tiers must have a monthlyPriceCents > 0' } })
    }
    const tenantId = activeTenantId(req, 'a tier ladder belongs to one company')
    const exists = await prisma.tierConfig.findUnique({ where: { tenantId_tier: { tenantId, tier: body.tier } } })
    if (exists) return reply.status(409).send({ error: { code: 'TIER_EXISTS', message: `Tier "${body.tier}" already exists` } })
    const created = await prisma.tierConfig.create({ data: { ...body, tenantId } })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/tiers/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const body = tierBody.partial().parse(req.body)
      // Don't let an operator rename the slug if it's already in use —
      // tier slugs are referenced by Customer.loyaltyTier and silently
      // changing one would unhook every customer from their tier.
      const existing = await prisma.tierConfig.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
      if (!existing) throw new NotFoundError('TierConfig', req.params.id)
      if (body.tier) {
        if (existing.tier !== body.tier) {
          return reply.status(400).send({ error: { code: 'IMMUTABLE_SLUG', message: 'Tier slug can\'t change after creation. Delete + recreate if you need a different slug.' } })
        }
      }
      const updated = await prisma.tierConfig.update({ where: { id: req.params.id }, data: body })
      return updated
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/tiers/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const tier = await prisma.tierConfig.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) } })
      if (!tier) throw new NotFoundError('TierConfig', req.params.id)
      // Refuse deletion if customers are assigned — operator should toggle
      // isActive instead (already supported via PATCH). Prevents orphan
      // customers stuck on a slug that no longer maps to perks.
      const assigned = await prisma.loyaltyAccount.count({
        where: { tier: tier.tier, ...(tier.tenantId ? { tenantId: tier.tenantId } : { tenantId: { in: [] } }) },
      })
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
