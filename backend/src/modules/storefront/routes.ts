// Public storefront API — no auth for menu/concept reads; customer auth for orders
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS } from '../auth/middleware.js'
import { verifyCustomerToken } from '../auth/service.js'
import { ingestOrder, type IngestOrderDTO } from '../orders/service.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { reserveItem, settleCart, getAvailability, getBatchAvailability } from '../../lib/reservation.js'
import { priceOrder, tenderOf, deliveryFeeFor } from '../../lib/pricing.js'
import { haversineKm } from '../../lib/geo.js'
import { redis } from '../../lib/redis.js'
import { scopeTenantWhere, conceptWhere } from '../../lib/tenantScope.js'
import { formatBrandName } from '../../lib/brandName.js'
import { assertPaymentMethodAvailable, availablePaymentMethods } from './paymentMethods.js'
import { assertOpenForOrders, orderingState, orderTime, sectionVisibleAt } from './serviceHours.js'
import { publicBrandWhere, isTestCompanyOf } from '../../lib/publicBrands.js'
import { walletBalanceAt, holdWalletForCheckout, attachHoldToOrder, releaseWalletHold, spendWalletOnOrder } from '../wallet/service.js'


// Snap rider coordinates to a ~110m grid before returning to customers.
// 3 decimal places of latitude = ~111m; same in longitude at Karachi's
// latitude (24°N) = ~101m. Enough for "rider is in this neighborhood"
// without enabling turn-by-turn stalking. Full precision stays internal
// to dispatch and the rider tablet.
function bufferCoord(v: number | null | undefined): number | null {
  if (v == null) return null
  return Math.round(v * 1000) / 1000
}

const createDirectOrderSchema = z.object({
  conceptSlug: z.string(),
  type: z.enum(['delivery', 'pickup', 'dine-in', 'curbside']),
  deliveryAddress: z.string().optional(),
  deliveryLat: z.number().optional(),     // delivery zone lookup
  deliveryLng: z.number().optional(),
  tableId: z.string().uuid().optional(),
  // Dine-in: customer types the table label printed on the QR card at
  // their seat (e.g. "T-7", "12"). Server-side we look up the matching
  // Table row for this concept and set Order.tableId on success;
  // otherwise we patch the raw label into Order.rawPayload so expo
  // can still see it. Required when type='dine-in'.
  tableLabel: z.string().trim().min(1).max(20).optional(),
  // Curbside fields — only meaningful when type='curbside'. Customer enters
  // them at checkout so staff knows which car to run the food to.
  curbsideVehicle: z.string().min(2).max(80).optional(),
  curbsidePlate:   z.string().max(20).optional(),
  curbsideSpot:    z.string().max(20).optional(),
  scheduledFor: z.string().datetime().optional(),
  promoCode: z.string().optional(),
  useWallet: z.boolean().default(false),
  qrCodeId: z.string().uuid().optional(),
  items: z.array(
    z.object({
      menuItemId: z.string().uuid(),
      quantity: z.number().int().min(1),
      notes: z.string().optional(),
      // Client supplies only modifier ids — name and priceDelta are looked up
      // server-side from the DB. Accepting them from the client would let an
      // attacker pass `priceDeltaCents: -9999999` and zero the order total.
      modifiers: z
        .array(z.object({ modifierId: z.string().uuid() }))
        .default([]),
    }),
  ),
  loyaltyPointsToRedeem: z.number().int().min(0).default(0),
  paymentGateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'cash', 'wallet']).default('cash'),
  paymentPhone: z.string().max(20).optional(),                      // JazzCash / EasyPaisa mobile wallet number
  tipCents: z.number().int().min(0).max(1_000_000).default(0),     // optional tip on top of bill
  giftCardCode: z.string().optional(),                              // redeem against this order
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

/**
 * Resolve a storefront basket against the DB: every item must be an
 * available item of this brand, every modifier one attached to that item's
 * groups (names and price deltas come from the DB, never the client — a
 * client-sent priceDelta of -9999999 used to zero the bill). Shared by
 * checkout and GET /storefront/quote so the two can never price different
 * baskets.
 *
 * `at` is when the order is for (now, or a pre-order's time): an item in a
 * time-limited menu section (breakfast, dinner specials) can only be ordered
 * while that section shows, in Karachi time (ONL-13) — the menu hiding it was
 * never enough, because the basket is the client's.
 */
async function resolveCheckoutItems(
  conceptId: string,
  items: Array<{ menuItemId: string; quantity: number; notes?: string; modifiers: Array<{ modifierId: string }> }>,
  at: Date = new Date(),
) {
  const resolvedItems: Array<{
    externalItemId: string
    menuItemId: string
    name: string
    quantity: number
    unitPriceCents: number
    modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>
    notes?: string
  }> = []
  let itemTotal = 0
  for (const item of items) {
    const menuItem = await prisma.menuItem.findFirst({
      where: { id: item.menuItemId, conceptId, isAvailable: true, deletedAt: null },
      include: {
        modifierGroups: { include: { modifiers: { where: { deletedAt: null } } } },
        category: { select: { timeRestrictionStart: true, timeRestrictionEnd: true } },
      },
    })
    if (!menuItem) throw new AppError('ITEM_UNAVAILABLE', `Item ${item.menuItemId} is not available`, 400)
    const section = menuItem.category
    if (section && !sectionVisibleAt(section.timeRestrictionStart, section.timeRestrictionEnd, at)) {
      throw new AppError(
        'ITEM_UNAVAILABLE',
        `${menuItem.name} is only served ${section.timeRestrictionStart}–${section.timeRestrictionEnd ?? '24:00'}`,
        400,
      )
    }

    const validMods = new Map<string, { id: string; name: string; priceDeltaCents: number }>()
    for (const g of menuItem.modifierGroups) {
      for (const m of g.modifiers) validMods.set(m.id, { id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })
    }
    const resolvedMods: Array<{ modifierId: string; name: string; priceDeltaCents: number }> = []
    let modTotal = 0
    for (const incoming of item.modifiers) {
      const m = validMods.get(incoming.modifierId)
      if (!m) {
        throw new AppError('INVALID_MODIFIER', `Modifier ${incoming.modifierId} does not belong to item ${menuItem.name}`, 400)
      }
      modTotal += m.priceDeltaCents
      resolvedMods.push({ modifierId: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents })
    }
    itemTotal += (menuItem.priceCents + modTotal) * item.quantity
    resolvedItems.push({
      externalItemId: item.menuItemId,
      menuItemId: item.menuItemId,
      name: menuItem.name,
      quantity: item.quantity,
      unitPriceCents: menuItem.priceCents,
      modifiers: resolvedMods,
      notes: item.notes,
    })
  }
  return { resolvedItems, itemTotal }
}

/**
 * Can this gift card pay at this brand? (ONL-15) A card of the brand's own
 * company only (owner decision 14), active, unexpired, with a balance.
 * Another company's card and an unknown code answer alike — the answer never
 * confirms a card exists elsewhere. Checkout refuses an unusable card with a
 * 422 BEFORE anything is claimed or created (it used to drop the card with a
 * log line and charge the full price); the quote reports it as giftCardError.
 */
type GiftCardCheck =
  | { ok: true; balanceCents: number }
  | { ok: false; code: string; message: string }
async function checkGiftCard(rawCode: string, concept: { tenantId: string | null; name: string }): Promise<GiftCardCheck> {
  const code = rawCode.trim().toUpperCase()
  const card = concept.tenantId && code
    ? await prisma.giftCard.findFirst({
        where: { code, tenantId: concept.tenantId },
        select: { status: true, balanceCents: true, expiresAt: true },
      })
    : null
  if (!card) {
    return { ok: false, code: 'GIFT_CARD_NOT_VALID_HERE', message: `This gift card can't be used at ${formatBrandName(concept.name)}.` }
  }
  if ((card.expiresAt && card.expiresAt.getTime() < Date.now()) || card.status === 'expired') {
    return { ok: false, code: 'GIFT_CARD_EXPIRED', message: 'This gift card has expired.' }
  }
  if (card.status === 'redeemed_full' || (card.status === 'active' && card.balanceCents <= 0)) {
    return { ok: false, code: 'GIFT_CARD_EMPTY', message: 'This gift card has no balance left.' }
  }
  if (card.status !== 'active') {
    return { ok: false, code: 'GIFT_CARD_INACTIVE', message: 'This gift card can’t be used right now.' }
  }
  return { ok: true, balanceCents: card.balanceCents }
}

const quoteQuerySchema = z.object({
  conceptSlug: z.string().min(1),
  type: z.enum(['delivery', 'pickup', 'dine-in', 'curbside']).default('pickup'),
  paymentGateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'cash', 'wallet']).default('cash'),
  // The basket, as JSON: [{ menuItemId, quantity, modifiers: [{ modifierId }] }]
  items: z.string().min(2).max(20_000),
  deliveryLat: z.coerce.number().optional(),
  deliveryLng: z.coerce.number().optional(),
  promoCode: z.string().max(40).optional(),
  loyaltyPointsToRedeem: z.coerce.number().int().min(0).default(0),
  useWallet: z.enum(['true', 'false', '1', '0']).optional(),
  tipCents: z.coerce.number().int().min(0).max(1_000_000).default(0),
  // A percentage tip (the page's chips) — of food + the food's GST, never the
  // delivery fee or its GST. Ignored when tipCents is set.
  tipPct: z.coerce.number().min(0).max(100).optional(),
  giftCardCode: z.string().max(40).optional(),
  // A pre-order's time — opening hours and time-limited sections are checked
  // for it instead of now (same as checkout).
  scheduledFor: z.string().datetime().optional(),
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
            ...publicBrandWhere(),
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
            concept: { isActive: true, deletedAt: null, storefrontVisible: true, ...publicBrandWhere() },
            OR: [
              { name:        { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true, name: true, description: true, priceCents: true, imageUrl: true, videoUrl: true,
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
          concept: { select: { id: true, slug: true, taxRate: true, taxRateCard: true, taxRateCash: true } },
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
          modifiers: i.modifiers.map((m) => ({ modifierId: m.modifierId ?? undefined, name: m.name, priceDeltaCents: m.priceDeltaCents })),
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

      // Time-limited sections (breakfast, dinner specials) show by KARACHI
      // time (ONL-13). This compared against the server clock, which is UTC
      // in production — five hours off. Filtered here rather than in SQL so a
      // section that runs past midnight (22:00–02:00) works too; checkout
      // applies the same rule (resolveCheckoutItems).
      const now = new Date()

      const allCategories = await prisma.category.findMany({
        where: {
          conceptId: concept.id,
          deletedAt: null,
          isActive: true,
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
      const categories = allCategories.filter((c) => sectionVisibleAt(c.timeRestrictionStart, c.timeRestrictionEnd, now))

      // Enrich items with live availability counts — single Redis MGET instead of N round-trips
      const allItems = categories.flatMap((cat) => cat.items)
      const availMap = await getBatchAvailability(
        allItems.map((i) => ({ id: i.id, portionsAvailable: i.portionsAvailable ?? null })),
      )
      const enrichedCategories = categories.map((cat) => ({
        ...cat,
        items: cat.items.map((item) => ({ ...item, available: availMap.get(item.id) ?? null })),
      }))

      // Whether the brand takes orders right now (its opening hours in PKT,
      // ONL-14) and how a customer can pay (ONL-02) — so the brand page and
      // checkout can say "closed, opens at …" and offer only what checkout
      // will accept.
      const ordering = await orderingState(concept, now)

      return {
        concept: {
          name: concept.name,
          slug: concept.slug,
          description: concept.description,
          heroTagline: concept.heroTagline,
          logoUrl: concept.logoUrl,
          primaryColor: concept.primaryColor,
          storefrontLayout: concept.storefrontLayout,
          // A test company's brand still works by its direct URL; the
          // storefront shows a TEST stripe (lib/publicBrands.ts).
          isTestCompany: await isTestCompanyOf(concept.tenantId),
        },
        categories: enrichedCategories,
        ordering: {
          open: ordering.open,
          opensAt: ordering.opensAt?.toISOString() ?? null,
          message: ordering.message,
        },
        paymentMethods: availablePaymentMethods(),
      }
    },
  )

  // GET /storefront/payment-methods — what checkout accepts (ONL-02). Online
  // gateways appear only once checkout really charges through them; until
  // then this is cash only. The same list is on /:concept/menu and /quote.
  fastify.get('/payment-methods', async () => ({ methods: availablePaymentMethods() }))

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

  // GET /storefront/brands/:slug/hours — service hours for the Open/Closed badge.
  // Returns all ServiceHours rows for the concept, shaped as { dayOfWeek, openMin,
  // closeMin, isReservable }. The frontend computes "is open now" in PKT (UTC+5).
  // Public — no auth required.
  fastify.get<{ Params: { slug: string } }>('/brands/:slug/hours', async (req) => {
    const concept = await prisma.concept.findFirst({
      where: { slug: req.params.slug, deletedAt: null },
      select: { id: true, isActive: true },
    })
    if (!concept) throw new NotFoundError('Concept', req.params.slug)

    const hours = await prisma.serviceHours.findMany({
      where: { conceptId: concept.id },
      select: { dayOfWeek: true, openMin: true, closeMin: true, isReservable: true },
      orderBy: [{ dayOfWeek: 'asc' }, { openMin: 'asc' }],
    })

    return { isActive: concept.isActive, hours }
  })

  // GET /storefront/concepts?lat=X&lng=Y — list active concepts within delivery radius
  fastify.get('/concepts', async (req) => {
    const { lat, lng } = req.query as { lat?: string; lng?: string }

    const all = await prisma.concept.findMany({
      where: { isActive: true, storefrontVisible: true, deletedAt: null, ...publicBrandWhere() },
      select: {
        id: true, name: true, slug: true, type: true, description: true,
        // tenantId identifies the operating company. The storefront is a
        // multi-company marketplace, so this list spans companies — and the
        // "other lines from the same kitchen group" strip on a brand page must
        // only offer siblings from the SAME company, or it tells a customer a
        // different operator's restaurant is run by this one.
        tenantId: true,
        logoUrl: true, primaryColor: true, heroTagline: true,
        // Brand microsite artwork. This select is explicit, so a new column is
        // invisible to the storefront until it is named here.
        wordmarkUrl: true, mascotUrl: true,
        latitude: true, longitude: true, deliveryRadiusKm: true,
        reservationsEnabled: true,
        phone: true, whatsapp: true, email: true,
        address: true, addressLocality: true,
        cuisine: true, priceTier: true,
        serviceHours: {
          select: { dayOfWeek: true, openMin: true, closeMin: true },
          orderBy: [{ dayOfWeek: 'asc' }, { openMin: 'asc' }],
        },
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

    return filtered.map(({ deliveryRadiusKm: _r, ...rest }) => rest)
  })

  // POST /storefront/orders — direct order (customer auth required)
  // A promo's usage count is claimed BEFORE the order exists — that ordering is
  // deliberate, it's what stops two simultaneous checkouts from both taking the
  // last use of a limited code. The cost is that anything failing between the
  // claim and the order being written leaks a use: the count stays incremented
  // and the code is a little more exhausted for everyone else, with nobody
  // having got a discount. One error path already compensated by hand; the
  // others (order creation itself, the curbside and delivery validations, any
  // database error) did not.
  //
  // Compensating in an onError hook covers all of them at once, including
  // future ones, instead of relying on every new throw remembering to undo it.
  // `promoClaim` is set at the moment of the increment and cleared once the
  // usage row exists, so this only ever fires for a claim that never became a
  // real usage.
  // GET /storefront/quote — the checkout bill, priced by the server. The
  // checkout page shows exactly this and computes nothing itself: the same
  // basket resolver, THE pricing function (GST by tender — cash on delivery
  // 15%, paid online 8%, decision 9 — item tax classes, the zone's delivery
  // fee with its GST on top at the tender rate (H9), service charge), THE
  // promo evaluation (percentage on food only, decision 10) and THE loyalty
  // redeem quote as checkout, in checkout's order: priced total − promo −
  // points − wallet, + tip, − gift card. Nothing is claimed or reserved. A
  // customer bearer is optional; without one, points and wallet are not
  // applied and the per-customer promo limit is not checked.
  //
  // taxCents = itemTaxCents (GST on the food) + deliveryFeeTaxCents (GST on
  // the delivery fee); pricedTotalCents includes both. A tip given as a % is a
  // share of the food and its GST only — never the fee or the fee's GST.
  fastify.get('/quote', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const q = quoteQuerySchema.parse(req.query)
    let items: z.infer<typeof createDirectOrderSchema>['items']
    try {
      items = createDirectOrderSchema.shape.items.parse(JSON.parse(q.items))
    } catch {
      throw new AppError('INVALID_BASKET', 'items must be a JSON array of { menuItemId, quantity, modifiers }', 400)
    }
    const concept = await prisma.concept.findFirst({ where: { slug: q.conceptSlug, isActive: true } })
    if (!concept) throw new NotFoundError('Concept', q.conceptSlug)

    // The same refusals checkout makes, so the page says so before the
    // customer presses the button: an online method checkout cannot charge
    // (422, ONL-02), and a brand that is closed for this order's time (409,
    // ONL-14).
    assertPaymentMethodAvailable(q.paymentGateway)
    const when = orderTime(q.scheduledFor)
    await assertOpenForOrders(concept, when.at, when.scheduled)

    // Optional customer session (points, wallet, per-customer promo limit).
    let customerId: string | null = null
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) {
      try { customerId = verifyCustomerToken(auth.slice(7)).sub } catch { customerId = null }
    }

    const { resolvedItems, itemTotal } = await resolveCheckoutItems(concept.id, items, when.at)
    const deliveryFeeCents = q.type === 'delivery'
      ? (await deliveryFeeFor(concept, itemTotal, q.deliveryLat, q.deliveryLng)).feeCents
      : 0
    const price = await priceOrder(resolvedItems, tenderOf(q.paymentGateway), 'storefront', concept, { deliveryFeeCents })

    let due = price.totalCents
    let promo: { code: string; discountCents: number; description: string } | null = null
    let promoError: { code: string; message: string } | null = null
    if (q.promoCode?.trim()) {
      const { evaluatePromo } = await import('../../lib/promoEval.js')
      const ev = await evaluatePromo({
        code: q.promoCode,
        tenantId: concept.tenantId,
        conceptId: concept.id,
        foodSubtotalCents: itemTotal,
        customerId,
      })
      if (ev.ok) {
        promo = { code: ev.promo.code, discountCents: ev.discountCents, description: ev.description }
        due -= ev.discountCents
      } else {
        promoError = { code: ev.reason, message: ev.message }
      }
    }

    let loyalty = { points: 0, discountCents: 0 }
    if (customerId && q.loyaltyPointsToRedeem > 0) {
      const { quoteRedemption } = await import('../loyalty/service.js')
      const r = await quoteRedemption({
        customerId,
        requestedPoints: q.loyaltyPointsToRedeem,
        tenantId: concept.tenantId,
        capCents: Math.max(0, due),
      })
      loyalty = { points: r.points, discountCents: r.discountCents }
      due -= r.discountCents
    }

    // The wallet as a top-up (the toggle) comes off before the tip; as the
    // payment method it pays the tip too — checkout's order (ONLINE-R5).
    const walletIsMethod = q.paymentGateway === 'wallet'
    let walletCents = 0
    let walletBalance = 0
    if (customerId && (walletIsMethod || q.useWallet === 'true' || q.useWallet === '1')) {
      // The wallet at THIS brand's company only (ONL-R2-01) — another
      // company's balance never pays here.
      walletBalance = await walletBalanceAt(concept.tenantId, customerId)
    }
    if (!walletIsMethod && walletBalance > 0) {
      walletCents = Math.min(walletBalance, Math.max(0, due))
      due -= walletCents
    }

    const tipCents = q.tipCents > 0
      ? q.tipCents
      : Math.round(((price.itemTotalCents + price.itemTaxCents) * (q.tipPct ?? 0)) / 100)
    due = Math.max(0, due) + tipCents
    if (walletIsMethod && walletBalance > 0) {
      walletCents = Math.min(walletBalance, due)
      due -= walletCents
    }

    // Gift card: an estimate from the card's balance (a card of this brand's
    // company, active, not expired — decision 14). The redeem at checkout is
    // what actually applies it. A card that can't be used is reported, like a
    // promo (ONL-15) — checkout refuses it with the same code and message.
    let giftCardCents = 0
    let giftCardError: { code: string; message: string } | null = null
    if (q.giftCardCode?.trim()) {
      const gc = await checkGiftCard(q.giftCardCode, concept)
      if (gc.ok) {
        giftCardCents = Math.max(0, Math.min(gc.balanceCents, due))
        due -= giftCardCents
      } else {
        giftCardError = { code: gc.code, message: gc.message }
      }
    }

    return {
      tender: price.tender,
      taxRatePct: price.taxRatePct,
      itemTotalCents: price.itemTotalCents,
      itemTaxCents: price.itemTaxCents,
      taxCents: price.taxCents,
      deliveryFeeCents: price.deliveryFeeCents,
      deliveryFeeTaxCents: price.deliveryFeeTaxCents,
      serviceChargeCents: price.serviceChargeCents,
      pricedTotalCents: price.totalCents,
      promo,
      promoError,
      loyaltyPoints: loyalty.points,
      loyaltyDiscountCents: loyalty.discountCents,
      walletCents,
      tipCents,
      giftCardCents,
      giftCardError,
      totalCents: due,
      paymentMethods: availablePaymentMethods(),
    }
  })

  fastify.post('/orders', {
    preHandler: requireCustomerAuth,
    onError: async (req, _reply, _err) => {
      // A wallet taken up front for a wallet-paid order (ONLINE-R5) goes back
      // if the order was never written.
      const hold = (req as { walletHold?: { tenantId: string; customerId: string; amountCents: number; transactionId: string } }).walletHold
      if (hold) {
        ;(req as { walletHold?: unknown }).walletHold = undefined
        // Back to the same company's wallet it was taken from (ONL-R2-01).
        await releaseWalletHold(hold).catch((err) =>
          req.log.error({ err: (err as Error).message, hold }, 'wallet hold not released'))
      }
      const claim = (req as { promoClaim?: { promoId: string; counted: boolean; lockKey: string | null } }).promoClaim
      if (!claim) return
      ;(req as { promoClaim?: unknown }).promoClaim = undefined
      if (claim.counted) {
        await prisma.promoCode
          .update({ where: { id: claim.promoId }, data: { usedCount: { decrement: 1 } } })
          .catch(() => {})
      }
      if (claim.lockKey) await redis.del(claim.lockKey).catch(() => {})
    },
  }, async (req, reply) => {
    const body = createDirectOrderSchema.parse(req.body)
    const customerId = req.customer!.id

    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    const concept = await prisma.concept.findFirst({ where: { slug: body.conceptSlug, isActive: true } })
    if (!concept) throw new NotFoundError('Concept', body.conceptSlug)
    // The wallet is per company (ONL-R2-01): only the balance at THIS brand's
    // company can pay here — value another company granted never crosses
    // over. Read now; it is TAKEN later under the wallet row's lock.
    const walletIsMethod = body.paymentGateway === 'wallet'
    const walletBalance = (walletIsMethod || body.useWallet) && concept.tenantId
      ? await walletBalanceAt(concept.tenantId, customerId)
      : 0

    // Ban check — one mechanism (CustomerBan), per company (owner decision
    // 15): an active ban raised by THIS brand's company, matched on the
    // customer, their email or their phone. Customer.isBlacklisted is no
    // longer read; the CRM block button raises a ban.
    const { assertNotBannedAtCompany } = await import('../../lib/strikes.js')
    await assertNotBannedAtCompany({
      customerId,
      email:    customer?.email,
      phone:    customer?.phone,
      tenantId: concept.tenantId,
      ip:       req.ip ?? null,
      intent:   'order',
    })

    // Refusals that must come before anything is claimed or created:
    //  - an online method checkout cannot actually charge (ONL-02): a Keenu /
    //    JazzCash / EasyPaisa order used to go to the kitchen with a pending
    //    payment no gateway was ever asked to take;
    //  - a brand that is closed for this order's time, in PKT (ONL-14) — a
    //    pre-order (scheduledFor in the future) is checked at its own time;
    //  - a gift card that can't pay here (ONL-15) — it used to be dropped
    //    with a log line and the customer charged the full price.
    assertPaymentMethodAvailable(body.paymentGateway)
    if (body.type === 'curbside' && !body.curbsideVehicle) {
      // Checked here, not after the order is written (it used to create the
      // order and then answer 422).
      throw new AppError('CURBSIDE_VEHICLE_REQUIRED', 'Tell us about your car so we can find you.', 422)
    }
    const when = orderTime(body.scheduledFor)
    await assertOpenForOrders(concept, when.at, when.scheduled)
    let giftCardBalanceCents = 0
    if (body.giftCardCode?.trim()) {
      const gc = await checkGiftCard(body.giftCardCode, concept)
      if (!gc.ok) throw new AppError(gc.code, gc.message, 422)
      giftCardBalanceCents = gc.balanceCents
    }

    // Items and modifiers resolved from the DB (the one resolver, shared
    // with GET /storefront/quote).
    const { resolvedItems, itemTotal } = await resolveCheckoutItems(concept.id, body.items, when.at)

    // THE order pricing (lib/pricing.ts), the same function GET
    // /storefront/quote shows the customer. GST by tender (decision 9): cash
    // on delivery / cash at pickup is the cash rate (15%), paid online (Keenu,
    // JazzCash, EasyPaisa, wallet) the card rate (8%) — this used to charge
    // the card rate always while the checkout page showed 15% for cash. Item
    // tax classes apply; service charge sits on food + GST, never on the
    // delivery fee. The delivery fee is the zone's (coordinates required,
    // decision 19 coverage, zone minimum), with GST on top at the tender's
    // standard rate (H9): price.taxCents = food GST + delivery GST, and the
    // order stores the fee and its GST (Order.deliveryFeeCents /
    // deliveryFeeTaxCents) through ingestOrder's `price`.
    const deliveryFeeCents = body.type === 'delivery'
      ? (await deliveryFeeFor(concept, itemTotal, body.deliveryLat, body.deliveryLng)).feeCents
      : 0
    const price = await priceOrder(resolvedItems, tenderOf(body.paymentGateway), 'storefront', concept, { deliveryFeeCents })
    const taxCents = price.taxCents

    let subtotal = price.totalCents

    // Promo code — THE evaluation (lib/promoEval.ts, shared with
    // /promo-preview): a percentage discounts the FOOD subtotal only (owner
    // decision 10), which is also the minimum-order base. The usage claim
    // below is atomic to prevent races on usage limits.
    let promoCodeId: string | null = null
    let promoDiscountCents = 0
    // Redis key held while a promo is being applied, released once the usage
    // row exists (or on the error paths below).
    let promoLock: string | null = null
    if (body.promoCode) {
      const { evaluatePromo } = await import('../../lib/promoEval.js')
      const ev = await evaluatePromo({
        code: body.promoCode,
        tenantId: concept.tenantId,
        conceptId: concept.id,
        foodSubtotalCents: itemTotal,
        customerId,
      })
      if (!ev.ok) throw new AppError(ev.reason, ev.message, 400)
      const promo = ev.promo

      // Atomic increment: only succeeds if limit not yet reached
      if (promo.maxUsageCount != null) {
        const updated = await prisma.promoCode.updateMany({
          where: { id: promo.id, usedCount: { lt: promo.maxUsageCount } },
          data: { usedCount: { increment: 1 } },
        })
        if (updated.count === 0) throw new AppError('PROMO_EXHAUSTED', 'Promo code usage limit reached', 400)
      }
      // From here on the claim is outstanding; the onError hook above returns it
      // if this request doesn't finish.
      ;(req as { promoClaim?: unknown }).promoClaim = {
        promoId: promo.id,
        counted: promo.maxUsageCount != null,
        lockKey: null,
      }

      // Per-customer limit. The usage row can only be written after the order
      // exists, so a plain count-then-check leaves a window where two
      // simultaneous checkouts both pass. Hold a short lock on
      // (promo, customer) across that window — a second concurrent attempt is
      // refused rather than silently granted a second discount.
      const promoLockKey = `promo:lock:${promo.id}:${customerId}`
      const gotLock = await redis.set(promoLockKey, '1', 'EX', 60, 'NX').catch(() => 'OK')
      if (gotLock !== 'OK') {
        if (promo.maxUsageCount != null) {
          await prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { decrement: 1 } } }).catch(() => {})
        }
        ;(req as { promoClaim?: unknown }).promoClaim = undefined
        throw new AppError('PROMO_LIMIT_REACHED', 'This promo code is already being applied to another order', 400)
      }
      promoLock = promoLockKey
      {
        const claim = (req as { promoClaim?: { lockKey: string | null } }).promoClaim
        if (claim) claim.lockKey = promoLockKey
      }

      // Re-count under the lock (evaluatePromo counted before it was held).
      const usageCount = await prisma.promoCodeUsage.count({ where: { promoCodeId: promo.id, customerId } })
      if (usageCount >= promo.perCustomerLimit) {
        // Undo the increment if we already bumped it
        if (promo.maxUsageCount != null) {
          await prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { decrement: 1 } } }).catch(() => {})
        }
        await redis.del(promoLockKey).catch(() => {})
        promoLock = null
        // Already compensated by hand above — drop the claim so the onError
        // hook doesn't decrement the same count a second time.
        ;(req as { promoClaim?: unknown }).promoClaim = undefined
        throw new AppError('PROMO_LIMIT_REACHED', 'You have already used this promo code', 400)
      }

      promoDiscountCents = ev.discountCents
      promoCodeId = promo.id
      subtotal -= promoDiscountCents
    }

    // Loyalty points — THE redeem (modules/loyalty/service.ts): the company's
    // point value (owner decision 12: PKR 0.10), min_redeem_points, capped at
    // what is left of the bill. The points are claimed once the order exists;
    // the discount is recorded on the order (discountCents) so the books see
    // it, and the liability is discharged.
    const loyaltySvc = await import('../loyalty/service.js')
    let loyaltyQuote = { points: 0, discountCents: 0, pointValueCents: 0 }
    if (body.loyaltyPointsToRedeem > 0) {
      loyaltyQuote = await loyaltySvc.quoteRedemption({
        customerId,
        requestedPoints: body.loyaltyPointsToRedeem,
        tenantId: concept.tenantId,
        capCents: Math.max(0, subtotal),
      })
      subtotal -= loyaltyQuote.discountCents
    }
    let loyaltyPointsRedeemed = loyaltyQuote.points
    let loyaltyDiscountCents = loyaltyQuote.discountCents

    // Wallet as a top-up on another method (the "use my wallet" toggle):
    // taken after the order exists, atomically (see below), from the wallet
    // of the brand's company (walletBalance, read above).
    let walletAmountCents = 0
    if (!walletIsMethod && body.useWallet && walletBalance > 0) {
      walletAmountCents = Math.min(walletBalance, Math.max(0, subtotal))
      subtotal -= walletAmountCents
    }

    // What the customer owes, tip included (ONL-03). The tip goes into the
    // order total AND the pending payment in the same insert (ingestOrder
    // writes both from payment.amountCents). It used to be added to the order
    // total afterwards and never to the payment, so the rider collected the
    // bill without the tip, the ledger booked the gap as a card receivable on
    // a cash order, and a full refund was refused as exceeding what was paid.
    let totalCents = Math.max(0, subtotal) + body.tipCents

    // The servd wallet is not a gateway: as the payment method it can only
    // cover the whole bill (with a gift card). Anything left would be a
    // pending online payment nobody ever collects — the ONL-02 hole again.
    //
    // ONLINE-R5: as the method, the wallet pays the bill INCLUDING the tip (it
    // used to be capped at the pre-tip subtotal, so any tip made a well-funded
    // wallet "not cover" the order), and it is TAKEN before the order is
    // written — atomically, so a second checkout spending the same wallet at
    // the same moment is refused here, with nothing created. It used to be
    // taken afterwards; a lost race then raised the pending row (a 'card' row,
    // as for every non-cash method) to the whole bill, and the order went to
    // the kitchen with a card receivable no gateway would ever settle.
    if (walletIsMethod) {
      walletAmountCents = Math.min(walletBalance, totalCents)
      totalCents -= walletAmountCents
    }
    if (walletIsMethod && totalCents - Math.min(giftCardBalanceCents, totalCents) > 0) {
      throw new AppError(
        'PAYMENT_METHOD_UNAVAILABLE',
        'Your wallet doesn’t cover this order. Please pay the rest with cash.',
        422,
        { available: availablePaymentMethods() },
      )
    }
    let walletTakenUpFront = false
    let walletHoldTxId: string | null = null
    if (walletIsMethod && walletAmountCents > 0) {
      // From the wallet of the brand's company, under its row lock.
      const taken = concept.tenantId
        ? await holdWalletForCheckout({ tenantId: concept.tenantId, customerId, amountCents: walletAmountCents })
        : null
      if (!taken) {
        throw new AppError(
          'WALLET_BALANCE_CHANGED',
          'Your wallet balance just changed. Please check your order and try again.',
          409,
        )
      }
      // Given back by the onError hook if the order is never written.
      ;(req as { walletHold?: unknown }).walletHold = {
        tenantId: concept.tenantId!, customerId, amountCents: walletAmountCents, transactionId: taken.transactionId,
      }
      walletHoldTxId = taken.transactionId
      walletTakenUpFront = true
    }

    // The tip's own column goes in the same insert as the total and the
    // pending payment (F1) — it used to be patched in a second write after.
    // ingestOrder bounds the tip by what the order is paid with: the pending
    // payment plus the wallet share. Both checkout shapes stay inside it — a
    // wallet top-up leaves the tip in payment.amountCents, and when the wallet
    // is the method its share covers the tip — so it is always written here.
    const dto: IngestOrderDTO = {
      source: 'servd',
      // Unique per request. This was `direct-${Date.now()}` — millisecond
      // precision, with nothing in it identifying the customer or the cart —
      // and ingestOrder deduplicates on (source, external_id). Two checkouts
      // landing in the same millisecond therefore collided: the second one got
      // back the FIRST one's order with created:false, so its items were never
      // ordered and it was handed a stranger's order id, while every
      // post-creation step (loyalty, promo usage, gift card) ran a second time
      // against that one shared row.
      //
      // A server-generated timestamp was never real idempotency in any case —
      // a client retry produces a new one — so it was pure collision surface.
      // Genuine retry-safety needs a client-supplied idempotency key; that is a
      // separate change, and this at least stops one customer's checkout
      // landing on another's order.
      external_id: `direct-${randomUUID()}`,
      concept_id: concept.id,
      placed_at: new Date().toISOString(),
      // A pre-order only when the time is really in the future (orderTime):
      // a past or present scheduledFor is "now" — stored as neither a time nor
      // a pre-order, so the kitchen and dispatch don't hold it (O-RV-3).
      scheduled_for: when.scheduled ? when.at.toISOString() : null,
      is_pre_order: when.scheduled,
      customer_id: customerId,
      customer_name: customer?.name ?? null,
      table_id: body.tableId ?? null,
      items: resolvedItems,
      // amountCents is the order total and the pending payment (tip included).
      payment: { provider: body.paymentGateway, amountCents: totalCents, status: 'pending' },
      loyalty_points_earned: null,
      delivery_notes: body.deliveryAddress ?? null,
      estimated_pickup: null,
      tax_cents: taxCents,
      // Decision 8 keys completion on this: a delivery completes at the
      // drop-off, pickup / curbside / dine-in at the expo hand-off. It was
      // never sent, so every storefront delivery was stored as 'takeout'.
      fulfilment_type: body.type === 'delivery' ? 'delivery' : body.type === 'dine-in' ? 'dine_in' : 'takeout',
      promo_code_id: promoCodeId,
      promo_discount_cents: promoDiscountCents,
      wallet_amount_cents: walletAmountCents,
      tip_cents: body.tipCents,
    }

    const { order } = await ingestOrder(dto, { price })
    if (walletTakenUpFront) {
      // The order exists and carries the wallet share: from here a cancel /
      // refund restores it (orderPosting postOrderRefund), not the hook.
      ;(req as { walletHold?: unknown }).walletHold = undefined
      // The spend row written at the hold now names its order.
      await attachHoldToOrder(walletHoldTxId!, order.id)
    }

    // Persist computed surcharges + curbside details. ingestOrder() doesn't
    // know about zones / service charge / curbside so we patch after creation.
    // (GST, its rate and the service charge were written by ingestOrder from
    // `price`.)
    const orderPatch: Record<string, unknown> = {}
    if (body.type === 'curbside' && body.curbsideVehicle) {
      orderPatch.curbsideVehicle = body.curbsideVehicle
      if (body.curbsidePlate) orderPatch.curbsidePlate = body.curbsidePlate
      if (body.curbsideSpot)  orderPatch.curbsideSpot = body.curbsideSpot
    }
    if (body.type === 'dine-in' && body.tableLabel) {
      // Resolve the table label the customer typed at the QR card to an
      // actual Table row for this concept. Case-insensitive on label.
      // If no Table matches (operator hasn't set up the floor plan yet,
      // or the customer typed a typo), store the raw string in
      // rawPayload so the expo screen still shows it on the ticket.
      const table = await prisma.table.findFirst({
        where: {
          conceptId: concept.id,
          deletedAt: null,
          label: { equals: body.tableLabel, mode: 'insensitive' },
        },
        select: { id: true },
      })
      if (table) {
        orderPatch.tableId = table.id
      } else {
        orderPatch.rawPayload = {
          ...(orderPatch.rawPayload as Record<string, unknown> | undefined),
          tableLabelRaw: body.tableLabel,
        }
      }
    }
    // Store payment phone (JazzCash/EasyPaisa) in rawPayload for later integration
    if (body.paymentPhone && (body.paymentGateway === 'jazzcash' || body.paymentGateway === 'easypaisa')) {
      orderPatch.rawPayload = {
        ...(orderPatch.rawPayload as Record<string, unknown> | undefined),
        paymentPhone: body.paymentPhone, paymentGateway: body.paymentGateway,
      }
    }
    // The drop-off pin, when the customer gave one: the rider app navigates to
    // it (docs/rider-app.md, Job.dropoff). The address text stays in
    // deliveryNotes.
    if (
      body.type === 'delivery' && body.deliveryLat != null && body.deliveryLng != null
      && Math.abs(body.deliveryLat) <= 90 && Math.abs(body.deliveryLng) <= 180
    ) {
      orderPatch.rawPayload = {
        ...(orderPatch.rawPayload as Record<string, unknown> | undefined),
        deliveryLat: body.deliveryLat, deliveryLng: body.deliveryLng,
      }
    }
    if (Object.keys(orderPatch).length > 0) {
      await prisma.order.update({ where: { id: order.id }, data: orderPatch })
    }

    // Gift card — THE redeem (modules/giftCards/service.ts): a card of this
    // brand's company only (owner decision 14), up to what is owed on the
    // (post-tip) bill, with the bill and pending payment lowered in the same
    // transaction. The card was checked before anything was created, so this
    // only fails if its balance moved in the last moment (another order spent
    // it). Then the order stands at its full price and the response says so
    // (giftCardError) — never silently.
    let giftCardAppliedCents = 0
    let giftCardError: { code: string; message: string } | null = null
    if (body.giftCardCode?.trim() && totalCents > 0) {
      try {
        const { redeemGiftCard } = await import('../giftCards/service.js')
        const gc = await redeemGiftCard({ code: body.giftCardCode, orderId: order.id })
        giftCardAppliedCents = gc.appliedCents
      } catch (err) {
        const e = err as { code?: string; message?: string }
        giftCardError = {
          code: e.code ?? 'GIFT_CARD_NOT_APPLIED',
          message: 'Your gift card could not be applied, so this order is at its full price. Contact us and we will adjust it.',
        }
        req.log.warn({ err: e.message, orderId: order.id }, 'gift card not applied at checkout')
      }
    }

    // Post-order: record promo usage (count already atomically incremented above) + deduct wallet
    if (promoCodeId && promoDiscountCents > 0) {
      await prisma.promoCodeUsage.create({ data: { promoCodeId, customerId, orderId: order.id, discountCents: promoDiscountCents } })
      // The claim is now a recorded usage — nothing to give back.
      ;(req as { promoClaim?: unknown }).promoClaim = undefined
    }
    // Usage is now on record, so a concurrent attempt would see the real count.
    if (promoLock) {
      await redis.del(promoLock).catch(() => {})
      promoLock = null
    }
    if (walletAmountCents > 0 && !walletTakenUpFront) {
      // Atomic deduction from the ORDER's company's wallet (order row locked,
      // then the wallet row): only succeeds if the balance still covers it.
      const spent = await spendWalletOnOrder({ customerId, orderId: order.id, amountCents: walletAmountCents })
      if (!spent) {
        // Balance changed since we read it, so nothing was charged. The order
        // total was ALREADY discounted by this amount above — leaving it there
        // gave the customer free credit they never had. Put the amount back on
        // the bill AND on the pending payment (adjustOrderBill raises both;
        // this used to raise only the total, so the rider / counter collected
        // the wallet's share short), and clear the wallet attribution.
        await loyaltySvc.adjustOrderBill(order.id, -walletAmountCents)
        await prisma.order.update({ where: { id: order.id }, data: { walletAmountCents: 0 } })
        walletAmountCents = 0
      }
    }
    // Loyalty points — claim what was quoted. If the balance moved and nothing
    // was taken, the discount goes back on the bill (and the pending payment),
    // exactly as the wallet path above does.
    if (loyaltyPointsRedeemed > 0) {
      const claimed = await loyaltySvc.claimRedemption({ customerId, orderId: order.id, quote: loyaltyQuote })
      if (!claimed) {
        await loyaltySvc.adjustOrderBill(order.id, -loyaltyDiscountCents)
        loyaltyPointsRedeemed = 0
        loyaltyDiscountCents  = 0
      }
    }

    // A wallet-paid order must owe nothing (ONLINE-R5). If a gift card or the
    // points were lost to a race after the order was written, the rest would
    // sit on a pending 'card' row no gateway ever collects. Cancel the order
    // instead — the cancel gives back the wallet, the gift card, the points
    // and the promo (orders/service cancelOrder → postOrderRefund) — and say
    // so.
    if (walletIsMethod) {
      const due = await prisma.payment.aggregate({
        where: { orderId: order.id, status: 'pending' },
        _sum: { amountCents: true },
      })
      if ((due._sum.amountCents ?? 0) > 0) {
        const { cancelOrder } = await import('../orders/service.js')
        await cancelOrder(order.id, {
          reason: 'Wallet-paid checkout left an amount due (gift card or points changed during checkout)',
          actor: null,
        })
        throw new AppError(
          'PAYMENT_NOT_COVERED',
          'Your gift card or points changed while we placed your order, so your wallet no longer covers it. Nothing was charged — please check your order and try again.',
          409,
        )
      }
    }

    // Nothing left to collect (ONL-R2-06): a bill the gift card, wallet or
    // points covered in full leaves a PKR 0 pending row behind (ingestOrder
    // writes one for every order; the redeems lower it to 0). It is not a
    // payment — the rider / counter cash-due list showed it as "PKR 0 to
    // collect". Drop it; the order's value is booked from its own figures.
    await prisma.payment.deleteMany({ where: { orderId: order.id, status: 'pending', amountCents: { lte: 0 } } })

    // QR conversion tracking
    // Only a QR code of THIS order's brand is credited — a client-supplied id
    // for another brand's (or another company's) code is ignored rather than
    // skewing that brand's conversion numbers.
    if (body.qrCodeId) {
      await prisma.qrCode.updateMany({
        where: { id: body.qrCodeId, conceptId: concept.id },
        data: { conversions: { increment: 1 } },
      }).catch(() => {})
    }

    // The order as it now stands — tip, gift card, wallet and points all
    // applied (ONL-03: this returned the in-memory row from before the tip,
    // so the confirmation showed the pre-tip total). The delivery fee and its
    // GST are the order's own stored columns (H9).
    const placed = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { include: { modifiers: true } }, concept: true },
    })
    return reply.status(201).send({
      ...placed,
      deliveryFeeCents: placed.deliveryFeeCents,
      deliveryFeeTaxCents: placed.deliveryFeeTaxCents,
      promoDiscountCents, walletAmountCents, loyaltyPointsRedeemed, loyaltyDiscountCents,
      giftCardAppliedCents, giftCardError,
    })
  })

  // POST /storefront/orders/:id/arrived — customer marks "I'm here" for a
  // curbside order. Stamps curbsideArrivedAt and, optionally, lets the
  // customer correct their vehicle description in case they swapped cars.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/arrived',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const body = z.object({
        curbsideVehicle: z.string().min(2).max(80).optional(),
        curbsidePlate:   z.string().max(20).optional(),
        curbsideSpot:    z.string().max(20).optional(),
      }).parse(req.body ?? {})

      const order = await prisma.order.findFirst({
        where: { id: req.params.id, customerId: req.customer!.id },
        select: { id: true, status: true, curbsideArrivedAt: true, curbsideVehicle: true, conceptId: true },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      if (!order.curbsideVehicle) {
        // Allow upgrading any pickup/dine-in to curbside on arrival if the
        // customer changed their mind in the parking lot. Requires vehicle.
        if (!body.curbsideVehicle) {
          throw new AppError('NOT_CURBSIDE', 'Add your car description first.', 422)
        }
      }

      const updated = await prisma.order.update({
        where: { id: order.id },
        data: {
          curbsideArrivedAt: order.curbsideArrivedAt ?? new Date(),
          ...(body.curbsideVehicle && { curbsideVehicle: body.curbsideVehicle }),
          ...(body.curbsidePlate   && { curbsidePlate:   body.curbsidePlate   }),
          ...(body.curbsideSpot    && { curbsideSpot:    body.curbsideSpot    }),
        },
        select: { id: true, curbsideArrivedAt: true, curbsideVehicle: true, curbsideSpot: true, status: true },
      })

      // Light up the kitchen / front-of-house immediately.
      const { getIO, tenantOfConcept } = await import('../../lib/ws.js')
      try {
        const io = getIO()
        // Company-scoped fan-out: only the brand's own company hears about it.
        const ownerTenant = await tenantOfConcept(order.conceptId)
        if (ownerTenant) io.to(`tenant:${ownerTenant}:orders`).emit('order:curbsideArrived', {
          orderId: updated.id,
          conceptId: order.conceptId,
          vehicle: updated.curbsideVehicle,
          spot:    updated.curbsideSpot,
          arrivedAt: updated.curbsideArrivedAt,
        })
        io.to(`concept:${order.conceptId}`).emit('order:curbsideArrived', {
          orderId: updated.id,
          conceptId: order.conceptId,
          vehicle: updated.curbsideVehicle,
          spot:    updated.curbsideSpot,
          arrivedAt: updated.curbsideArrivedAt,
        })
      } catch { /* ws may not be up in tests; non-blocking */ }

      return updated
    },
  )

  // GET /storefront/orders/:id — customer order status. Includes a flag
  // indicating whether this order has already been reviewed, used by the
  // /orders/[id]/review page to short-circuit straight to the "thanks"
  // state instead of showing the form again.
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, customerId: req.customer!.id },
        include: {
          items: { include: { modifiers: true } },
          concept: { select: { name: true, slug: true, primaryColor: true, tenantId: true } },
          rider: { select: { id: true, name: true, phone: true, vehicleType: true } },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      // The tracker shows a TEST stripe for a test company's order.
      const isTestCompany = await isTestCompanyOf(order.concept.tenantId)
      const { tenantId: _ct, ...conceptPublic } = order.concept
      const review = await prisma.orderReview.findUnique({
        where: { orderId: order.id },
        select: { id: true },
      })

      // Attach the rider's last-known location if a rider is assigned.
      // Coordinates are deliberately blurred to ~110m (3 decimal places) so
      // the customer sees the rider's rough neighborhood for ETA confidence
      // without being able to stalk them turn-by-turn. Dispatch + tablet keep
      // full precision via /dispatch/riders/:id/track for operational use.
      let riderInfo: {
        id: string; name: string; phone: string; vehicleType: string
        lastLat: number | null; lastLng: number | null; lastReportedAt: string | null
      } | null = null
      if (order.rider) {
        const loc = await prisma.riderLocation.findFirst({
          where: { riderId: order.rider.id },
          orderBy: { recordedAt: 'desc' },
          select: { lat: true, lng: true, recordedAt: true },
        })
        riderInfo = {
          ...order.rider,
          lastLat:        bufferCoord(loc?.lat),
          lastLng:        bufferCoord(loc?.lng),
          lastReportedAt: loc?.recordedAt.toISOString() ?? null,
        }
      }

      // The delivery hand-over code is the customer's to give their rider at
      // the door (docs/rider-app.md), so their own order page shows it — on a
      // delivery order only. Pickup and dine-in orders have no rider; a code
      // minted on one (ingestOrder issues one whenever delivery notes are
      // present) is nothing the customer needs. Once an emergency override
      // sent the code to the RIDER (Order.handoverReroutedAt), the page stops
      // showing it and says so (handoverRerouted) — the rider holds it now.
      // The reroute's staff-side details (which rider, attempts) stay out.
      // deliveryFeeCents / deliveryFeeTaxCents are the order's own columns
      // (H9), in the spread.
      const { handoverRerouteRiderId: _rr, handoverRerouteAttempts: _ra, ...visible } = order
      const handoverRerouted = order.handoverReroutedAt != null
      return {
        ...visible,
        concept: { ...conceptPublic, isTestCompany },
        isTestCompany,
        deliveryOtp: order.fulfilmentType === 'delivery' && !handoverRerouted ? order.deliveryOtp : null,
        handoverRerouted,
        rider: riderInfo,
        alreadyReviewed: review != null,
      }
    },
  )

  // POST /storefront/guest-orders — REMOVED.
  //
  // Anonymous order placement was a free-food primitive: anyone on the
  // internet could POST a payload with `payment.status: 'pending'` and the
  // kitchen would fire the ticket before a real payment ever cleared. Plus
  // the naughty-list gate only triggered on previously-banned phones, so
  // first-time abusers were never caught.
  //
  // Per CEO decision: every storefront order requires a logged-in customer.
  // Sign-up uses magic-link or phone OTP — both verify a real contact channel.
  fastify.post('/guest-orders', async (_req, reply) => {
    return reply.status(410).send({
      error: {
        code: 'GUEST_ORDERS_DISABLED',
        message: 'Guest checkout has been removed. Please sign in or create an account to place an order.',
      },
    })
  })

  // GET /storefront/guest-orders/:id — REMOVED.
  //
  // Returned full order detail (items, totals, rider name + phone + live
  // location) to anyone with the UUID. Order IDs aren't enumerable, but they
  // leak through SMS tracking links, screenshots, support tickets, etc. Once
  // out, the URL exposed PII indefinitely. Per CEO decision: viewing an order
  // requires sign-in.
  //
  // Old SMS links still hit this path — they get a 410 with a code the
  // storefront tracker UI can detect and redirect to /login.
  fastify.get('/guest-orders/:id', async (_req, reply) => {
    return reply.status(410).send({
      error: {
        code: 'GUEST_ORDERS_DISABLED',
        message: 'Sign in to view this order.',
      },
    })
  })

  // GET /storefront/account — customer profile + loyalty + wallet + referrals
  // Loyalty accounts are per company (one per customer per company).
  // `loyaltyAccount` stays in the response for the pages that read it: the
  // account at the company of ?conceptSlug= (checkout passes its brand), else
  // at the company the customer last ordered from. `loyaltyAccounts` has all.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/account', { preHandler: requireCustomerAuth }, async (req) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.id },
      select: {
        id: true, name: true, email: true, phone: true,
        phoneVerifiedAt: true, emailVerifiedAt: true,
        marketingOptIn: true, birthdayMmDd: true,
        firstOrderAt: true, lastOrderAt: true,
        totalSpentCents: true,
        // No global isBlacklisted flag: a block is per company (CustomerBan,
        // owner decision 15) — the account page reads GET
        // /storefront/account/blocks for the customer's own blocks.
        createdAt: true,
        // Referral fields surfaced so the storefront /account can render the
        // share box ("Invite friends, get 200 pts each").
        referralCode: true, referredAt: true, referralRewardCreditedAt: true,
        loyaltyAccounts: true,
        orders: {
          orderBy: { placedAt: 'desc' },
          take: 10,
          select: {
            id: true, status: true, totalCents: true, placedAt: true, source: true,
            concept: { select: { name: true } },
          },
        },
      },
    })
    if (!customer) throw new NotFoundError('Customer')
    const { loyaltyCompanyOf, companyOfConceptSlug } = await import('../loyalty/service.js')
    const tenantId = (await companyOfConceptSlug(req.query.conceptSlug)) ?? (await loyaltyCompanyOf(customer.id))
    const loyaltyAccount = customer.loyaltyAccounts.find((a) => a.tenantId === tenantId) ?? null
    // The wallet is per company too (ONL-R2-01): `walletBalance` and
    // `walletTransactions` are the wallet at the same company as
    // `loyaltyAccount` — the one that can pay at this brand. `wallets` lists
    // every company's balance (each spendable only at its own brands).
    const wallets = await prisma.customerWallet.findMany({
      where: { customerId: customer.id },
      orderBy: { createdAt: 'asc' },
      select: { tenantId: true, balanceCents: true },
    })
    const companyNames = new Map((await prisma.tenant.findMany({
      where: { id: { in: wallets.map((w) => w.tenantId) } },
      select: { id: true, name: true },
    })).map((t) => [t.id, t.name]))
    const walletTransactions = tenantId
      ? await prisma.walletTransaction.findMany({
          where: { customerId: customer.id, tenantId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, type: true, amountCents: true, balanceAfter: true, description: true, createdAt: true },
        })
      : []
    return {
      ...customer,
      loyaltyAccount,
      walletTenantId: tenantId,
      walletBalance: Math.max(0, wallets.find((w) => w.tenantId === tenantId)?.balanceCents ?? 0),
      walletTransactions,
      wallets: wallets.map((w) => ({ ...w, companyName: companyNames.get(w.tenantId) ?? null })),
    }
  })

  // GET /storefront/my-reservations — upcoming + recent reservations for the
  // signed-in customer. Powers the /account "Bookings" tab. Customer can
  // cancel from here directly.
  fastify.get('/my-reservations', { preHandler: requireCustomerAuth }, async (req) => {
    const now = new Date()
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000)
    const reservations = await prisma.reservation.findMany({
      where: {
        customerId: req.customer!.id,
        startTime: { gte: ninetyDaysAgo },
      },
      orderBy: { startTime: 'desc' },
      select: {
        id: true, partySize: true, startTime: true, endTime: true, status: true,
        notes: true, isVip: true, confirmToken: true,
        concept: { select: { name: true, slug: true, primaryColor: true } },
        table:   { select: { label: true } },
      },
    })
    const upcoming = reservations.filter((r) =>
      r.startTime > now && ['booked', 'confirmed'].includes(r.status),
    )
    const past     = reservations.filter((r) => !upcoming.includes(r))
    return { upcoming, past }
  })

  // GET /storefront/my-reviews — reviews this customer has left. Lets them
  // see their own history + the manager's response (if any).
  fastify.get('/my-reviews', { preHandler: requireCustomerAuth }, async (req) => {
    const reviews = await prisma.orderReview.findMany({
      where: { customerId: req.customer!.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true, rating: true, comment: true, tags: true, categoryRatings: true,
        managerResponse: true, managerResponseAt: true,
        createdAt: true,
        concept: { select: { name: true, slug: true } },
        order:   { select: { id: true, totalCents: true, placedAt: true } },
      },
    })
    return reviews
  })

  // GET /storefront/my-perks — tier perks the customer has unlocked. Used
  // by the /account page to render the "what your tier gets you" panel and
  // by mobile to show the same.
  fastify.get<{ Querystring: { conceptSlug?: string } }>('/my-perks', { preHandler: requireCustomerAuth }, async (req) => {
    const { getTierPerks } = await import('../../lib/tierPerks.js')
    const { tierStatus, loyaltyCompanyOf, loyaltyAccountOf, companyOfConceptSlug } = await import('../loyalty/service.js')
    const customerId = req.customer!.id
    // Accounts and tier ladders are per company: the brand's company when a
    // slug is given, else the company the customer last ordered from.
    const tenantId = (await companyOfConceptSlug(req.query.conceptSlug)) ?? (await loyaltyCompanyOf(customerId))
    const account = await loyaltyAccountOf(customerId, tenantId)
    if (!account) return { tier: 'bronze', pointsBalance: 0, lifetimePoints: 0, perks: null, nextTier: null }

    // Tiers are the company's ladder and unlock on lifetime spend (owner
    // decision 13); tierStatus knows the ladder, the spend and what is next.
    const status = await tierStatus(customerId, tenantId)
    const perks = await getTierPerks(account.tier, tenantId)
    const nextPerks = status.nextTier ? await getTierPerks(status.nextTier.slug, tenantId) : null

    return {
      tier: account.tier,
      pointsBalance: account.pointsBalance,
      lifetimePoints: account.lifetimePoints,
      perks,
      nextTier: status.nextTier?.slug ?? null,
      spendToNextCents: status.spendToNextCents,
      nextPerks,
    }
  })

  // GET /storefront/my-referrals — share box on /account: how many people
  // signed up via my code, how many actually placed a first order (the
  // moment my bonus credits), how many points I've earned from referrals.
  fastify.get('/my-referrals', { preHandler: requireCustomerAuth }, async (req) => {
    const referrals = await prisma.customer.findMany({
      where: { referredById: req.customer!.id },
      select: {
        id: true, name: true,
        referredAt: true, firstOrderAt: true, referralRewardCreditedAt: true,
      },
      orderBy: { referredAt: 'desc' },
    })
    const totalReferred = referrals.length
    const completedFirstOrder = referrals.filter((r) => r.firstOrderAt != null).length
    const pendingPayout       = referrals.filter((r) => r.firstOrderAt == null).length
    const paidOut             = referrals.filter((r) => r.referralRewardCreditedAt != null).length

    // Sum loyalty points earned from referrals, by reading transaction descriptions.
    // Relies on the worker's deterministic prefix; if missing, just shows 0.
    // Across the customer's accounts (one per company).
    const accounts = await prisma.loyaltyAccount.findMany({
      where: { customerId: req.customer!.id },
      select: { id: true },
    })
    const earnedPoints = accounts.length > 0
      ? await prisma.loyaltyTransaction.aggregate({
          where: { loyaltyAccountId: { in: accounts.map((a) => a.id) }, description: { startsWith: 'Referral bonus:' } },
          _sum: { pointsDelta: true },
        }).then((r) => r._sum.pointsDelta ?? 0)
      : 0

    return {
      summary: { totalReferred, completedFirstOrder, pendingPayout, paidOut, earnedPoints },
      referrals: referrals.map((r) => ({
        // Don't leak the referee's email/phone — just first name.
        firstName: (r.name ?? '').split(' ')[0] ?? 'A guest',
        referredAt: r.referredAt,
        firstOrderAt: r.firstOrderAt,
        rewarded: r.referralRewardCreditedAt != null,
      })),
    }
  })

  // GET /storefront/my-favorites — items the customer has ordered most often,
  // grouped by menu item with last-ordered date + counts. Powers the
  // /account "Favorites" tab + a fast reorder. We compute on-the-fly because
  // the dataset is small per-customer (typically <500 orders ever).
  fastify.get('/my-favorites', { preHandler: requireCustomerAuth }, async (req) => {
    const items = await prisma.orderItem.findMany({
      where: {
        order: { customerId: req.customer!.id, status: 'completed' },
        menuItemId: { not: null },
      },
      select: {
        menuItemId: true,
        name: true,
        quantity: true,
        unitPriceCents: true,
        order: { select: { placedAt: true, conceptId: true } },
      },
    })
    // Aggregate by menuItemId
    const byItem = new Map<string, {
      menuItemId: string
      name: string
      timesOrdered: number
      lastOrderedAt: Date
      conceptId: string
      avgPriceCents: number
    }>()
    for (const it of items) {
      if (!it.menuItemId) continue
      const existing = byItem.get(it.menuItemId)
      if (existing) {
        existing.timesOrdered += it.quantity
        if (it.order.placedAt > existing.lastOrderedAt) existing.lastOrderedAt = it.order.placedAt
      } else {
        byItem.set(it.menuItemId, {
          menuItemId: it.menuItemId,
          name: it.name,
          timesOrdered: it.quantity,
          lastOrderedAt: it.order.placedAt,
          conceptId: it.order.conceptId,
          avgPriceCents: it.unitPriceCents,
        })
      }
    }
    // Top 12 by times ordered. Cross-reference back to MenuItem to get
    // current availability + concept slug for the "Order again" link.
    const top = [...byItem.values()].sort((a, b) => b.timesOrdered - a.timesOrdered).slice(0, 12)
    if (top.length === 0) return []
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: top.map((t) => t.menuItemId) } },
      select: {
        id: true, name: true, priceCents: true, isAvailable: true, imageUrl: true,
        concept: { select: { name: true, slug: true } },
      },
    })
    const menuById = new Map(menuItems.map((m) => [m.id, m]))
    return top.map((t) => {
      const m = menuById.get(t.menuItemId)
      return {
        menuItemId: t.menuItemId,
        name: m?.name ?? t.name,
        priceCents: m?.priceCents ?? t.avgPriceCents,
        imageUrl: m?.imageUrl ?? null,
        isAvailable: m?.isAvailable ?? false,
        timesOrdered: t.timesOrdered,
        lastOrderedAt: t.lastOrderedAt,
        concept: m?.concept ?? null,
      }
    })
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
  fastify.post('/cart/abandon', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({
      cartId: z.string().min(1),
      conceptSlug: z.string(),
      items: z.array(z.object({ menuItemId: z.string(), name: z.string(), quantity: z.number().int(), priceCents: z.number().int() })),
      subtotalCents: z.number().int(),
      // Accepted so older clients don't fail validation, but DELIBERATELY
      // IGNORED — see the note below. Contact details are read from the
      // session. Do not wire these back in.
      customerPhone: z.string().optional(),
      customerEmail: z.string().email().optional(),
      customerId: z.string().uuid().optional(),
    }).parse(req.body)

    const concept = await prisma.concept.findFirst({ where: { slug: body.conceptSlug }, select: { id: true } })
    if (!concept) return reply.status(204).send()

    // Contact details come from the SESSION, never from the body.
    //
    // This route is unauthenticated and stored whatever email, phone and
    // customerId it was handed. Two hours later runAbandonedCartTrigger emails
    // or texts that contact "you left something in your cart" — so anyone could
    // POST here with a stranger's address, or a thousand strangers' addresses
    // under a thousand cart ids, and have GS Foods send every one of them a
    // marketing message from its own domain and number. Cost, complaints and
    // sender reputation, all pointed at us.
    //
    // An anonymous cart is still recorded — it is the analytics that matter for
    // the funnel — it just carries no one to message.
    let cartCustomerId: string | null = null
    let cartPhone: string | null = null
    let cartEmail: string | null = null
    const bearer = req.headers.authorization
    if (bearer?.startsWith('Bearer ')) {
      try {
        const payload = verifyCustomerToken(bearer.slice(7))
        const self = await prisma.customer.findFirst({
          where: { id: payload.sub, deletedAt: null },
          select: { id: true, email: true, phone: true },
        })
        if (self) {
          cartCustomerId = self.id
          cartEmail = self.email ?? null
          cartPhone = self.phone ?? null
        }
      } catch {
        // Not a valid customer token — record the cart anonymously.
      }
    }

    await prisma.abandonedCart.upsert({
      where: { cartId: body.cartId },
      create: {
        cartId: body.cartId,
        conceptId: concept.id,
        customerId: cartCustomerId,
        customerPhone: cartPhone,
        customerEmail: cartEmail,
        items: body.items,
        subtotalCents: body.subtotalCents,
      },
      update: { subtotalCents: body.subtotalCents, items: body.items },
    })
    return reply.status(204).send()
  })

  // ── Homepage Promos ────────────────────────────────────────────────────────

  // GET /storefront/promo-preview — validate a promo code without consuming it.
  // Used by the checkout page's "Apply" button. Same evaluation as checkout
  // (lib/promoEval.ts): `subtotalCents` is the FOOD subtotal (items and
  // modifiers, before GST, delivery, service charge and tip), which is what a
  // percentage applies to and what the minimum order is measured on (owner
  // decision 10). With a customer bearer the per-customer limit applies too.
  fastify.get<{ Querystring: { code?: string; conceptSlug?: string; subtotalCents?: string } }>(
    '/promo-preview',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const code = (req.query.code ?? '').trim().toUpperCase()
      const conceptSlug = (req.query.conceptSlug ?? '').trim()
      const foodSubtotalCents = parseInt(req.query.subtotalCents ?? '0', 10) || 0
      if (!code) return reply.send({ valid: false, reason: 'No code provided' })

      const concept = conceptSlug
        ? await prisma.concept.findFirst({ where: { slug: conceptSlug, isActive: true }, select: { id: true, tenantId: true } })
        : null
      // Without a brand there is no company to look the code up in.
      if (!concept?.tenantId) return reply.send({ valid: false, reason: 'This code isn’t valid' })

      let customerId: string | null = null
      const bearer = req.headers.authorization
      if (bearer?.startsWith('Bearer ')) {
        try { customerId = verifyCustomerToken(bearer.slice(7)).sub } catch { /* anonymous preview */ }
      }

      const { evaluatePromo } = await import('../../lib/promoEval.js')
      const ev = await evaluatePromo({ code, tenantId: concept.tenantId, conceptId: concept.id, foodSubtotalCents, customerId })
      if (!ev.ok) {
        // Unknown, not-yet-active and expired codes answer alike, so the
        // endpoint can't be used to enumerate which codes exist.
        const generic = ev.reason === 'INVALID_PROMO' || ev.reason === 'PROMO_NOT_STARTED' || ev.reason === 'PROMO_EXPIRED'
        return reply.send({ valid: false, reason: generic ? 'This code isn’t valid' : ev.message })
      }
      return reply.send({ valid: true, discountCents: ev.discountCents, description: ev.description })
    },
  )

  // GET /storefront/promos — public, active promos for homepage deals strip
  fastify.get<{ Querystring: { concept?: string } }>('/promos', async (req) => {
    // The strip is a company's: with a brand slug it shows that company's
    // promos, without one it shows nothing rather than every company's.
    const concept = req.query.concept
      ? await prisma.concept.findFirst({ where: { slug: req.query.concept, isActive: true }, select: { tenantId: true } })
      : null
    if (!concept?.tenantId) return []
    return prisma.storefrontPromo.findMany({
      where: { isActive: true, tenantId: concept.tenantId },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, emoji: true, badge: true, headline: true, sub: true, bg: true, shadow: true },
    })
  })

  // ── Admin: homepage deals strip ────────────────────────────────────────────
  // StorefrontPromo rows belong to ONE company (tenantId, stamped with the
  // ACTIVE company at create). The admin list shows the companies in view;
  // edit/delete are 404 for another company's row. These used to be global —
  // any manager at any company edited every company's strip.

  // GET /storefront/admin/promos — the companies in view (auth required)
  fastify.get('/admin/promos', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.storefrontPromo.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { sortOrder: 'asc' },
    })
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
    const tenantId = req.staffUser?.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    const promo = await prisma.storefrontPromo.create({ data: { ...body, tenantId } })
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
      const owned = await prisma.storefrontPromo.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('StorefrontPromo', req.params.id)
      return prisma.storefrontPromo.update({ where: { id: owned.id }, data: body })
    },
  )

  // DELETE /storefront/admin/promos/:id — delete
  fastify.delete<{ Params: { id: string } }>(
    '/admin/promos/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.storefrontPromo.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('StorefrontPromo', req.params.id)
      await prisma.storefrontPromo.delete({ where: { id: owned.id } })
      return reply.status(204).send()
    },
  )

  // GET /storefront/abandoned-carts/metrics — staff analytics
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/abandoned-carts/metrics',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // Never unscoped: a named brand must be in view (404 otherwise), and no
      // brand means every brand of the companies in view — not every company.
      // (dateFrom/dateTo are merged into one range; the second used to
      // overwrite the first.)
      const where = {
        ...(await conceptWhere(req, req.query.conceptId, 'read')),
        ...((req.query.dateFrom || req.query.dateTo) && {
          abandonedAt: {
            ...(req.query.dateFrom && { gte: new Date(req.query.dateFrom) }),
            ...(req.query.dateTo && { lte: new Date(req.query.dateTo) }),
          },
        }),
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
