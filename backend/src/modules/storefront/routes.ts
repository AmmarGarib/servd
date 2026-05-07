// Public storefront API — no auth for menu/concept reads; customer auth for orders
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS } from '../auth/middleware.js'
import { ingestOrder } from '../orders/service.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { reserveItem, settleCart, getAvailability, getBatchAvailability } from '../../lib/reservation.js'
import { computeServiceCharge, computeDeliveryFee, haversineKm as zoneHaversineKm } from '../../lib/setup-config.js'
import type { OrderDTO } from '@servd/types'

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

const createDirectOrderSchema = z.object({
  conceptSlug: z.string(),
  type: z.enum(['delivery', 'pickup', 'dine-in']),
  deliveryAddress: z.string().optional(),
  deliveryLat: z.number().optional(),     // delivery zone lookup
  deliveryLng: z.number().optional(),
  tableId: z.string().uuid().optional(),
  scheduledFor: z.string().datetime().optional(),
  promoCode: z.string().optional(),
  useWallet: z.boolean().default(false),
  qrCodeId: z.string().uuid().optional(),
  items: z.array(
    z.object({
      menuItemId: z.string().uuid(),
      quantity: z.number().int().min(1),
      notes: z.string().optional(),
      modifiers: z
        .array(z.object({ modifierId: z.string().uuid(), name: z.string(), priceDeltaCents: z.number().int() }))
        .default([]),
    }),
  ),
  loyaltyPointsToRedeem: z.number().int().min(0).default(0),
  paymentGateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'cash', 'wallet']).default('cash'),
  tipCents: z.number().int().min(0).max(1_000_000).default(0),     // optional tip on top of bill
  giftCardCode: z.string().optional(),                              // redeem against this order
})

const createGuestOrderSchema = z.object({
  conceptSlug: z.string(),
  cartId: z.string().optional(),
  customerName: z.string().min(1),
  customerPhone: z.string().optional(),
  customerEmail: z.string().email().optional(),
  type: z.enum(['delivery', 'pickup', 'dine-in']).default('pickup'),
  deliveryAddress: z.string().optional(),
  notes: z.string().optional(),
  scheduledFor: z.string().datetime().optional(),
  promoCode: z.string().optional(),
  qrCodeId: z.string().uuid().optional(),
  items: z.array(
    z.object({
      menuItemId: z.string().uuid(),
      name: z.string(),
      priceCents: z.number().int(),
      quantity: z.number().int().min(1),
      notes: z.string().optional(),
    }),
  ),
})

const reserveSchema = z.object({
  cartId: z.string().min(1),
  menuItemId: z.string().uuid(),
  qty: z.number().int().min(0),
  prevQty: z.number().int().min(0).default(0),
})

const releaseSchema = z.object({
  cartId: z.string().min(1),
  menuItemId: z.string().uuid(),
})

export async function storefrontRoutes(fastify: FastifyInstance) {
  // GET /storefront/search?q=... — cross-brand search across concepts AND
  // menu items. Powers the Browse page's search box.
  fastify.get<{ Querystring: { q?: string } }>(
    '/search',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const q = (req.query.q ?? '').trim()
      if (q.length < 2) return { brands: [], items: [] }

      const [brands, items] = await Promise.all([
        prisma.concept.findMany({
          where: {
            isActive: true,
            deletedAt: null,
            storefrontVisible: true,
            OR: [
              { name:        { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { slug:        { contains: q, mode: 'insensitive' } },
            ],
          },
          select: { id: true, name: true, slug: true, description: true, primaryColor: true, type: true },
          take: 10,
        }),
        prisma.menuItem.findMany({
          where: {
            deletedAt: null,
            isAvailable: true,
            concept: { isActive: true, deletedAt: null, storefrontVisible: true },
            OR: [
              { name:        { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true, name: true, description: true, priceCents: true, imageUrl: true,
            concept: { select: { name: true, slug: true, primaryColor: true } },
          },
          take: 30,
          orderBy: { displayOrder: 'asc' },
        }),
      ])

      return { brands, items }
    },
  )

  // GET /storefront/:concept/reviews — public reviews summary for a brand
  // microsite. Returns the latest 12 + the running average.
  fastify.get<{ Params: { concept: string } }>(
    '/:concept/reviews',
    async (req) => {
      const concept = await prisma.concept.findFirst({
        where: { slug: req.params.concept, isActive: true, deletedAt: null },
        select: { id: true },
      })
      if (!concept) throw new NotFoundError('Concept', req.params.concept)

      const [reviews, agg] = await Promise.all([
        prisma.orderReview.findMany({
          where: { conceptId: concept.id, comment: { not: null } },
          select: {
            id: true, rating: true, comment: true, createdAt: true,
            order: { select: { customerName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 12,
        }),
        prisma.orderReview.aggregate({
          where: { conceptId: concept.id },
          _avg: { rating: true },
          _count: { rating: true },
        }),
      ])

      return {
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          comment: r.comment,
          createdAt: r.createdAt,
          customerName: r.order.customerName ?? 'Anonymous',
        })),
        average: agg._avg.rating ? Math.round(agg._avg.rating * 10) / 10 : null,
        total: agg._count.rating,
      }
    },
  )

  // POST /storefront/orders/:id/reorder — clone a past order's items as a
  // fresh draft for the same customer. Returns the items shaped so the
  // storefront cart store can hydrate from them; the customer reviews
  // before submitting via POST /storefront/orders.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/reorder',
    { preHandler: requireCustomerAuth },
    async (req, reply) => {
      const original = await prisma.order.findFirst({
        where: { id: req.params.id, customerId: req.customer!.id, deletedAt: null },
        include: {
          concept: { select: { id: true, slug: true, taxRate: true } },
          items:   { include: { modifiers: true, menuItem: { select: { id: true, isAvailable: true, priceCents: true, name: true } } } },
        },
      })
      if (!original) throw new NotFoundError('Order', req.params.id)

      // Filter to currently-available items only — reordering a sold-out item
      // would just frustrate the customer.
      const items = original.items
        .filter((i) => i.menuItem?.isAvailable && i.status !== 'voided')
        .map((i) => ({
          menuItemId:    i.menuItemId,
          name:          i.menuItem?.name ?? i.name,
          quantity:      i.quantity,
          // Use TODAY's price, not the snapshotted historical price
          unitPriceCents: i.menuItem?.priceCents ?? i.unitPriceCents,
          modifiers: i.modifiers.map((m) => ({ name: m.name, priceDeltaCents: m.priceDeltaCents })),
        }))

      const removed = original.items.length - items.length

      return reply.send({
        conceptSlug: original.concept.slug,
        items,
        removed,
        notice: removed > 0
          ? `${removed} item${removed === 1 ? ' is' : 's are'} no longer available and were removed`
          : null,
      })
    },
  )

  // GET /storefront/:concept/menu — public menu (no auth)
  fastify.get<{ Params: { concept: string } }>(
    '/:concept/menu',
    async (req) => {
      const concept = await prisma.concept.findFirst({
        where: { slug: req.params.concept, isActive: true, deletedAt: null },
      })
      if (!concept) throw new NotFoundError('Concept', req.params.concept)

      const now = new Date()
      const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`

      const categories = await prisma.category.findMany({
        where: {
          conceptId: concept.id,
          deletedAt: null,
          isActive: true,
          OR: [
            { timeRestrictionStart: null },
            {
              AND: [
                { timeRestrictionStart: { lte: currentTime } },
                { timeRestrictionEnd: { gte: currentTime } },
              ],
            },
          ],
        },
        orderBy: { sortOrder: 'asc' },
        include: {
          items: {
            where: { deletedAt: null, isAvailable: true },
            orderBy: { displayOrder: 'asc' },
            include: {
              modifierGroups: {
                where: { deletedAt: null },
                orderBy: { sortOrder: 'asc' },
                include: { modifiers: { where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } } },
              },
            },
          },
        },
      })

      // Enrich items with live availability counts — single Redis MGET instead of N round-trips
      const allItems = categories.flatMap((cat) => cat.items)
      const availMap = await getBatchAvailability(
        allItems.map((i) => ({ id: i.id, portionsAvailable: i.portionsAvailable ?? null })),
      )
      const enrichedCategories = categories.map((cat) => ({
        ...cat,
        items: cat.items.map((item) => ({ ...item, available: availMap.get(item.id) ?? null })),
      }))

      return {
        concept: {
          name: concept.name,
          slug: concept.slug,
          description: concept.description,
          heroTagline: concept.heroTagline,
          announcementBanner: concept.announcementBanner,
          logoUrl: concept.logoUrl,
          primaryColor: concept.primaryColor,
          storefrontLayout: concept.storefrontLayout,
        },
        categories: enrichedCategories,
      }
    },
  )

  // GET /storefront/:concept/availability — live availability snapshot for polling
  fastify.get<{ Params: { concept: string } }>('/:concept/availability', async (req) => {
    const concept = await prisma.concept.findFirst({
      where: { slug: req.params.concept, isActive: true, deletedAt: null },
    })
    if (!concept) throw new NotFoundError('Concept', req.params.concept)

    const items = await prisma.menuItem.findMany({
      where: { conceptId: concept.id, deletedAt: null, isAvailable: true },
      select: { id: true, portionsAvailable: true },
    })

    const availMap = await getBatchAvailability(
      items.map((i) => ({ id: i.id, portionsAvailable: i.portionsAvailable ?? null })),
    )
    const availability = items.map((item) => ({
      menuItemId: item.id,
      available: availMap.get(item.id) ?? null,
    }))

    return { items: availability }
  })

  // POST /storefront/cart/reserve — atomic hold for a cart item
  fastify.post('/cart/reserve', async (req, reply) => {
    const { cartId, menuItemId, qty, prevQty } = reserveSchema.parse(req.body)

    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, isAvailable: true, deletedAt: null },
      select: { portionsAvailable: true },
    })
    if (!menuItem) throw new NotFoundError('MenuItem', menuItemId)

    const result = await reserveItem(cartId, menuItemId, qty, prevQty, menuItem.portionsAvailable ?? null)
    if (!result.ok) {
      return reply.status(409).send({
        error: { code: 'INSUFFICIENT_STOCK', message: 'Not enough portions available', available: result.available },
      })
    }
    return reply.status(200).send({ ok: true })
  })

  // POST /storefront/cart/release — release a single item hold
  fastify.post('/cart/release', async (req, reply) => {
    const { cartId, menuItemId } = releaseSchema.parse(req.body)

    const menuItem = await prisma.menuItem.findFirst({
      where: { id: menuItemId, deletedAt: null },
      select: { portionsAvailable: true, id: true },
    })
    if (!menuItem) return reply.send({ ok: true })

    // release=true restores availability
    await settleCart(cartId, [{ menuItemId, quantity: 1, portionsAvailable: menuItem.portionsAvailable ?? null }], true)
    return reply.send({ ok: true })
  })

  // GET /storefront/concepts?lat=X&lng=Y — list active concepts within delivery radius
  fastify.get('/concepts', async (req) => {
    const { lat, lng } = req.query as { lat?: string; lng?: string }

    const all = await prisma.concept.findMany({
      where: { isActive: true, storefrontVisible: true, deletedAt: null },
      select: {
        id: true, name: true, slug: true, type: true, description: true,
        logoUrl: true, primaryColor: true, heroTagline: true, announcementBanner: true,
        latitude: true, longitude: true, deliveryRadiusKm: true,
      },
    })

    const userLat = lat ? parseFloat(lat) : null
    const userLng = lng ? parseFloat(lng) : null

    const filtered = (userLat !== null && userLng !== null && !isNaN(userLat) && !isNaN(userLng))
      ? all.filter(c => {
          if (c.latitude === null || c.longitude === null) return true // no pin = global
          const dist = haversineKm(userLat, userLng, c.latitude, c.longitude)
          return dist <= c.deliveryRadiusKm
        })
      : all

    return filtered.map(({ latitude: _lat, longitude: _lng, deliveryRadiusKm: _r, ...rest }) => rest)
  })

  // POST /storefront/orders — direct order (customer auth required)
  fastify.post('/orders', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const body = createDirectOrderSchema.parse(req.body)
    const customerId = req.customer!.id

    // Blacklist check
    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (customer?.isBlacklisted) throw new AppError('BLACKLISTED', 'Your account is not permitted to place orders', 403)

    const concept = await prisma.concept.findFirst({ where: { slug: body.conceptSlug, isActive: true } })
    if (!concept) throw new NotFoundError('Concept', body.conceptSlug)

    const resolvedItems = []
    let itemTotal = 0

    for (const item of body.items) {
      const menuItem = await prisma.menuItem.findFirst({
        where: { id: item.menuItemId, conceptId: concept.id, isAvailable: true, deletedAt: null },
      })
      if (!menuItem) throw new AppError('ITEM_UNAVAILABLE', `Item ${item.menuItemId} is not available`, 400)

      const modTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
      const lineTotal = (menuItem.priceCents + modTotal) * item.quantity
      itemTotal += lineTotal

      resolvedItems.push({
        externalItemId: item.menuItemId,
        menuItemId: item.menuItemId,
        name: menuItem.name,
        quantity: item.quantity,
        unitPriceCents: menuItem.priceCents,
        modifiers: item.modifiers,
        notes: item.notes,
      })
    }

    const taxCents = Math.round(itemTotal * (concept.taxRate / 100))

    // Delivery fee — lookup zone by haversine distance from concept to drop point.
    // Only applies to delivery orders that supply lat/lng. Throws if order
    // is below the zone's minimum.
    let deliveryFeeCents = 0
    if (body.type === 'delivery' && body.deliveryLat != null && body.deliveryLng != null && concept.latitude != null && concept.longitude != null) {
      const distKm = zoneHaversineKm(concept.latitude, concept.longitude, body.deliveryLat, body.deliveryLng)
      const zone = await computeDeliveryFee(itemTotal, distKm, concept.id)
      if (zone.zoneId && !zone.meetsMinimum) {
        throw new AppError('BELOW_ZONE_MINIMUM', `Order does not meet the delivery minimum for ${zone.zoneName}`, 400)
      }
      deliveryFeeCents = zone.feeCents
    }

    // Service charge — applied to (food + tax + delivery) for storefront orders.
    const serviceChargeCents = await computeServiceCharge(itemTotal + taxCents + deliveryFeeCents, 'storefront')

    let subtotal = itemTotal + taxCents + deliveryFeeCents + serviceChargeCents

    // Promo code — validated atomically to prevent race conditions on usage limits
    let promoCodeId: string | null = null
    let promoDiscountCents = 0
    if (body.promoCode) {
      const promo = await prisma.promoCode.findUnique({ where: { code: body.promoCode.toUpperCase() } })
      const now = new Date()
      if (!promo || !promo.isActive || promo.startAt > now || promo.endAt < now) {
        throw new AppError('INVALID_PROMO', 'Promo code is invalid or expired', 400)
      }
      if (promo.conceptId && promo.conceptId !== concept.id) {
        throw new AppError('PROMO_WRONG_CONCEPT', 'Promo code not valid for this brand', 400)
      }
      if (promo.minOrderCents != null && subtotal < promo.minOrderCents) {
        throw new AppError('PROMO_MIN_ORDER', `Minimum order of PKR ${(promo.minOrderCents / 100).toFixed(0)} required`, 400)
      }

      // Atomic increment: only succeeds if limit not yet reached
      if (promo.maxUsageCount != null) {
        const updated = await prisma.promoCode.updateMany({
          where: { id: promo.id, usedCount: { lt: promo.maxUsageCount } },
          data: { usedCount: { increment: 1 } },
        })
        if (updated.count === 0) throw new AppError('PROMO_EXHAUSTED', 'Promo code usage limit reached', 400)
      }

      const usageCount = await prisma.promoCodeUsage.count({ where: { promoCodeId: promo.id, customerId } })
      if (usageCount >= promo.perCustomerLimit) {
        // Undo the increment if we already bumped it
        if (promo.maxUsageCount != null) {
          await prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { decrement: 1 } } }).catch(() => {})
        }
        throw new AppError('PROMO_LIMIT_REACHED', 'You have already used this promo code', 400)
      }

      if (promo.discountType === 'percentage') {
        promoDiscountCents = Math.round(subtotal * (promo.discountValue / 100))
        if (promo.maxDiscountCents != null) promoDiscountCents = Math.min(promoDiscountCents, promo.maxDiscountCents)
      } else {
        promoDiscountCents = Math.min(Math.round(promo.discountValue * 100), subtotal)
      }
      promoCodeId = promo.id
      subtotal -= promoDiscountCents
    }

    // Loyalty points redemption — 1 point = 10 cents (PKR 0.10)
    let loyaltyPointsRedeemed = 0
    let loyaltyDiscountCents = 0
    if (body.loyaltyPointsToRedeem > 0) {
      const loyaltyAccount = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
      const available = loyaltyAccount?.pointsBalance ?? 0
      loyaltyPointsRedeemed = Math.min(body.loyaltyPointsToRedeem, available)
      loyaltyDiscountCents = Math.min(loyaltyPointsRedeemed * 10, subtotal)
      loyaltyPointsRedeemed = Math.ceil(loyaltyDiscountCents / 10) // recalc in case capped by subtotal
      subtotal -= loyaltyDiscountCents
    }

    // Wallet payment — atomic deduction to prevent double-spend
    let walletAmountCents = 0
    if (body.useWallet && customer && customer.walletBalance > 0) {
      walletAmountCents = Math.min(customer.walletBalance, subtotal)
      subtotal -= walletAmountCents
    }

    const totalCents = Math.max(0, subtotal)

    const dto: OrderDTO = {
      source: 'servd',
      external_id: `direct-${Date.now()}`,
      concept_id: concept.id,
      placed_at: new Date().toISOString(),
      scheduled_for: body.scheduledFor ?? null,
      is_pre_order: !!body.scheduledFor,
      customer_id: customerId,
      customer_name: customer?.name ?? null,
      table_id: body.tableId ?? null,
      items: resolvedItems,
      payment: { provider: body.paymentGateway as never, amountCents: totalCents, status: 'pending' },
      loyalty_points_earned: null,
      delivery_notes: body.deliveryAddress ?? null,
      estimated_pickup: null,
      promo_code_id: promoCodeId,
      promo_discount_cents: promoDiscountCents,
      wallet_amount_cents: walletAmountCents,
    }

    const { order } = await ingestOrder(dto)

    // Persist computed surcharges. ingestOrder() doesn't know about zones /
    // service charge so we patch after creation. (deliveryZoneId is derivable
    // from delivery address + concept later if needed.)
    if (serviceChargeCents > 0 || deliveryFeeCents > 0) {
      await prisma.order.update({
        where: { id: order.id },
        data: { serviceChargeCents },
      })
    }

    // Tip + gift card — patched after creation so we don't have to plumb them
    // through OrderDTO. Order total adjusts to reflect tip.
    if (body.tipCents > 0) {
      await prisma.order.update({
        where: { id: order.id },
        data: { tipCents: body.tipCents, totalCents: { increment: body.tipCents } },
      })
    }
    if (body.giftCardCode) {
      // Apply up to the (post-tip) total, decrement balance, derecognise liability.
      const total = order.totalCents + (body.tipCents > 0 ? body.tipCents : 0)
      try {
        const card = await prisma.giftCard.findUnique({ where: { code: body.giftCardCode.toUpperCase() } })
        if (card && card.status === 'active' && card.balanceCents > 0) {
          const apply = Math.min(card.balanceCents, total)
          await prisma.$transaction([
            prisma.giftCard.update({
              where: { id: card.id },
              data: {
                balanceCents: card.balanceCents - apply,
                ...(card.balanceCents - apply === 0 && { status: 'redeemed_full' as never }),
              },
            }),
            prisma.giftCardRedemption.create({
              data: { giftCardId: card.id, orderId: order.id, amountCents: apply, balanceAfter: card.balanceCents - apply },
            }),
          ])
        }
      } catch (err) {
        req.log.error({ err: (err as Error).message }, 'gift card redemption failed')
      }
    }

    // Post-order: record promo usage (count already atomically incremented above) + deduct wallet
    if (promoCodeId && promoDiscountCents > 0) {
      await prisma.promoCodeUsage.create({ data: { promoCodeId, customerId, orderId: order.id, discountCents: promoDiscountCents } })
    }
    if (walletAmountCents > 0 && customer) {
      // Atomic deduction: only succeeds if balance is still sufficient (prevents double-spend)
      const walletUpdate = await prisma.customer.updateMany({
        where: { id: customerId, walletBalance: { gte: walletAmountCents } },
        data: { walletBalance: { decrement: walletAmountCents } },
      })
      if (walletUpdate.count === 0) {
        // Balance changed since we read it — charge nothing from wallet
        walletAmountCents = 0
      } else {
        const updatedCustomer = await prisma.customer.findUnique({ where: { id: customerId }, select: { walletBalance: true } })
        await prisma.walletTransaction.create({
          data: { customerId, type: 'spend', amountCents: -walletAmountCents, balanceAfter: updatedCustomer?.walletBalance ?? 0, description: `Order ${order.id}`, orderId: order.id },
        })
      }
    }
    // Loyalty points deduction — atomic to prevent double-spend
    if (loyaltyPointsRedeemed > 0) {
      const loyaltyUpdate = await prisma.loyaltyAccount.updateMany({
        where: { customerId, pointsBalance: { gte: loyaltyPointsRedeemed } },
        data: { pointsBalance: { decrement: loyaltyPointsRedeemed } },
      })
      if (loyaltyUpdate.count > 0) {
        const la = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
        if (la) {
          const ltx = await prisma.loyaltyTransaction.create({
            data: { loyaltyAccountId: la.id, orderId: order.id, type: 'redeem', pointsDelta: -loyaltyPointsRedeemed, description: `Redeemed on order ${order.id}` },
          })
          const { postLoyaltyRedeem } = await import('../accounting/loyaltyPosting.js')
          postLoyaltyRedeem(ltx.id).catch((err) =>
            req.log.error({ err: (err as Error).message, ltxId: ltx.id }, 'postLoyaltyRedeem failed'),
          )
        }
      } else {
        loyaltyPointsRedeemed = 0
        loyaltyDiscountCents  = 0
      }
    }

    // QR conversion tracking
    if (body.qrCodeId) {
      await prisma.qrCode.update({ where: { id: body.qrCodeId }, data: { conversions: { increment: 1 } } }).catch(() => {})
    }

    return reply.status(201).send({ ...order, promoDiscountCents, walletAmountCents, loyaltyPointsRedeemed, loyaltyDiscountCents })
  })

  // GET /storefront/orders/:id — customer order status
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, customerId: req.customer!.id },
        include: {
          items: { include: { modifiers: true } },
          concept: { select: { name: true, slug: true, primaryColor: true } },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      return order
    },
  )

  // POST /storefront/guest-orders — no auth required, for walk-in / first-time customers
  fastify.post('/guest-orders', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = createGuestOrderSchema.parse(req.body)

    const concept = await prisma.concept.findFirst({
      where: { slug: body.conceptSlug, isActive: true },
    })
    if (!concept) throw new NotFoundError('Concept', body.conceptSlug)

    let itemTotal = 0
    const resolvedItems = []
    const itemsForSettle: Array<{ menuItemId: string; quantity: number; portionsAvailable: number | null }> = []

    for (const item of body.items) {
      const menuItem = await prisma.menuItem.findFirst({
        where: { id: item.menuItemId, conceptId: concept.id, isAvailable: true, deletedAt: null },
      })
      if (!menuItem) throw new AppError('ITEM_UNAVAILABLE', `Item ${item.menuItemId} is not available`, 400)

      const lineTotal = menuItem.priceCents * item.quantity
      itemTotal += lineTotal

      resolvedItems.push({
        externalItemId: item.menuItemId,
        menuItemId: item.menuItemId,
        name: menuItem.name,
        quantity: item.quantity,
        unitPriceCents: menuItem.priceCents,
        modifiers: [],
        notes: item.notes,
      })

      itemsForSettle.push({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        portionsAvailable: menuItem.portionsAvailable ?? null,
      })
    }

    const envTaxRate = Number(process.env['DEFAULT_TAX_RATE'])
    const taxRate = concept.taxRate ?? (Number.isFinite(envTaxRate) ? envTaxRate : 17)
    const taxCents = Math.round(itemTotal * (taxRate / 100))
    const totalCents = itemTotal + taxCents

    const dto: OrderDTO = {
      source: 'servd',
      external_id: `guest-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      concept_id: concept.id,
      placed_at: new Date().toISOString(),
      scheduled_for: body.scheduledFor ?? null,
      is_pre_order: !!body.scheduledFor,
      customer_id: null,
      customer_name: body.customerName,
      table_id: null,
      items: resolvedItems,
      payment: { provider: 'cash' as never, amountCents: totalCents, status: 'pending' },
      loyalty_points_earned: null,
      delivery_notes: body.deliveryAddress ?? body.notes ?? null,
      estimated_pickup: null,
    }

    const { order } = await ingestOrder(dto)

    if (body.cartId) {
      await settleCart(body.cartId, itemsForSettle, false)
      // Mark any recorded abandoned cart as recovered
      await prisma.abandonedCart.updateMany({
        where: { cartId: body.cartId, recoveredAt: null },
        data: { recoveredAt: new Date() },
      })
    }
    if (body.qrCodeId) {
      await prisma.qrCode.update({ where: { id: body.qrCodeId }, data: { conversions: { increment: 1 } } }).catch(() => {})
    }

    return reply.status(201).send({ id: order.id, status: order.status, totalCents, taxCents, itemTotal })
  })

  // GET /storefront/guest-orders/:id — public order status (no auth, by ID)
  fastify.get<{ Params: { id: string } }>('/guest-orders/:id', async (req) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: {
        items: true,
        concept: { select: { name: true, slug: true, primaryColor: true } },
      },
    })
    if (!order) throw new NotFoundError('Order', req.params.id)
    return order
  })

  // GET /storefront/account — customer profile + loyalty + wallet
  fastify.get('/account', { preHandler: requireCustomerAuth }, async (req) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.id },
      select: {
        id: true, name: true, email: true, phone: true,
        marketingOptIn: true, birthdayMmDd: true,
        firstOrderAt: true, lastOrderAt: true,
        totalSpentCents: true, walletBalance: true,
        isBlacklisted: true, createdAt: true,
        loyaltyAccount: true,
        orders: {
          orderBy: { placedAt: 'desc' },
          take: 10,
          select: {
            id: true, status: true, totalCents: true, placedAt: true, source: true,
            concept: { select: { name: true } },
          },
        },
        walletTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, type: true, amountCents: true, balanceAfter: true, description: true, createdAt: true },
        },
      },
    })
    if (!customer) throw new NotFoundError('Customer')
    return customer
  })

  // ── Saved addresses ────────────────────────────────────────────────────────

  fastify.get('/addresses', { preHandler: requireCustomerAuth }, async (req) => {
    return prisma.customerAddress.findMany({
      where: { customerId: req.customer!.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    })
  })

  fastify.post('/addresses', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const body = z.object({
      label:     z.string().min(1).max(32),
      address:   z.string().min(1),
      lat:       z.number().optional(),
      lng:       z.number().optional(),
      isDefault: z.boolean().optional(),
    }).parse(req.body)

    if (body.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: req.customer!.id },
        data:  { isDefault: false },
      })
    }
    const addr = await prisma.customerAddress.create({
      data: { customerId: req.customer!.id, ...body, isDefault: body.isDefault ?? false },
    })
    return reply.status(201).send(addr)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/addresses/:id', { preHandler: requireCustomerAuth }, async (req) => {
      const body = z.object({
        label:     z.string().min(1).max(32).optional(),
        address:   z.string().min(1).optional(),
        lat:       z.number().optional(),
        lng:       z.number().optional(),
        isDefault: z.boolean().optional(),
      }).parse(req.body)

      if (body.isDefault) {
        await prisma.customerAddress.updateMany({
          where: { customerId: req.customer!.id },
          data:  { isDefault: false },
        })
      }
      return prisma.customerAddress.update({
        where: { id: req.params.id, customerId: req.customer!.id } as Parameters<typeof prisma.customerAddress.update>[0]['where'],
        data:  body,
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/addresses/:id', { preHandler: requireCustomerAuth }, async (req, reply) => {
      await prisma.customerAddress.deleteMany({
        where: { id: req.params.id, customerId: req.customer!.id },
      })
      return reply.status(204).send()
    },
  )

  // POST /storefront/cart/abandon — record an abandoned cart for CRM/analytics
  fastify.post('/cart/abandon', async (req, reply) => {
    const body = z.object({
      cartId: z.string().min(1),
      conceptSlug: z.string(),
      items: z.array(z.object({ menuItemId: z.string(), name: z.string(), quantity: z.number().int(), priceCents: z.number().int() })),
      subtotalCents: z.number().int(),
      customerPhone: z.string().optional(),
      customerEmail: z.string().email().optional(),
      customerId: z.string().uuid().optional(),
    }).parse(req.body)

    const concept = await prisma.concept.findFirst({ where: { slug: body.conceptSlug }, select: { id: true } })
    if (!concept) return reply.status(204).send()

    await prisma.abandonedCart.upsert({
      where: { cartId: body.cartId },
      create: {
        cartId: body.cartId,
        conceptId: concept.id,
        customerId: body.customerId ?? null,
        customerPhone: body.customerPhone ?? null,
        customerEmail: body.customerEmail ?? null,
        items: body.items,
        subtotalCents: body.subtotalCents,
      },
      update: { subtotalCents: body.subtotalCents, items: body.items },
    })
    return reply.status(204).send()
  })

  // ── Homepage Promos ────────────────────────────────────────────────────────

  // GET /storefront/promos — public, active promos for homepage deals strip
  fastify.get('/promos', async () => {
    return prisma.storefrontPromo.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, emoji: true, badge: true, headline: true, sub: true, bg: true, shadow: true },
    })
  })

  // GET /storefront/admin/promos — all promos (auth required)
  fastify.get('/admin/promos', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.storefrontPromo.findMany({ orderBy: { sortOrder: 'asc' } })
  })

  // POST /storefront/admin/promos — create
  fastify.post('/admin/promos', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      emoji:     z.string().min(1).default('🔥'),
      badge:     z.string().min(1),
      headline:  z.string().min(1),
      sub:       z.string().min(1),
      bg:        z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#c0392b'),
      shadow:    z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#922b21'),
      sortOrder: z.number().int().default(0),
      isActive:  z.boolean().default(true),
    }).parse(req.body)
    const promo = await prisma.storefrontPromo.create({ data: body })
    return reply.status(201).send(promo)
  })

  // PATCH /storefront/admin/promos/:id — update
  fastify.patch<{ Params: { id: string } }>(
    '/admin/promos/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        emoji:     z.string().min(1).optional(),
        badge:     z.string().min(1).optional(),
        headline:  z.string().min(1).optional(),
        sub:       z.string().min(1).optional(),
        bg:        z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        shadow:    z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        sortOrder: z.number().int().optional(),
        isActive:  z.boolean().optional(),
      }).parse(req.body)
      return prisma.storefrontPromo.update({ where: { id: req.params.id }, data: body })
    },
  )

  // DELETE /storefront/admin/promos/:id — delete
  fastify.delete<{ Params: { id: string } }>(
    '/admin/promos/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.storefrontPromo.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // GET /storefront/abandoned-carts/metrics — staff analytics
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/abandoned-carts/metrics',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const where = {
        ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        ...(req.query.dateFrom && { abandonedAt: { gte: new Date(req.query.dateFrom) } }),
        ...(req.query.dateTo && { abandonedAt: { lte: new Date(req.query.dateTo) } }),
      }
      const [total, abandoned, recovered] = await Promise.all([
        prisma.abandonedCart.count({ where }),
        prisma.abandonedCart.count({ where: { ...where, recoveredAt: null } }),
        prisma.abandonedCart.count({ where: { ...where, recoveredAt: { not: null } } }),
      ])
      const valueAgg = await prisma.abandonedCart.aggregate({ where, _sum: { subtotalCents: true } })
      const recoveredAgg = await prisma.abandonedCart.aggregate({ where: { ...where, recoveredAt: { not: null } }, _sum: { subtotalCents: true } })
      return {
        total,
        abandoned,
        recovered,
        conversionRate: total > 0 ? Math.round((recovered / total) * 100) : 0,
        totalValue: valueAgg._sum.subtotalCents ?? 0,
        recoveredValue: recoveredAgg._sum.subtotalCents ?? 0,
        abandonedValue: (valueAgg._sum.subtotalCents ?? 0) - (recoveredAgg._sum.subtotalCents ?? 0),
      }
    },
  )
}
