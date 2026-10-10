import { prisma } from '../../lib/prisma.js'
import { emitOrderNew, emitOrderUpdated, emitItemUpdated, emitItem86d } from '../../lib/ws.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { sendOrderReceipt, sendOrderStatusUpdate } from '../../lib/notify.js'
import { postOrderCompletion, postOrderRefund } from '../accounting/orderPosting.js'
import type { OrderDTO } from '@servd/types'
import { Prisma } from '@prisma/client'
import type { OrderStatus, ItemStatus } from '@prisma/client'
import { tenantIdOfConcept } from '../../lib/webhook-events.js'
import { consumptionForSoldLines } from '../../lib/recipeCost.js'
import type { OrderPrice } from '../../lib/pricing.js'
import { generateDeliveryOtp } from '../../lib/deliveryOtp.js'

// ─── Inventory deduction (recipe-driven) ─────────────────────────────────────
//
// What a sale takes out of stock comes from THE recipe explosion
// (lib/recipeCost.ts consumptionForSoldLines) — the same one the ledger's COGS
// uses — so it is in PURCHASE units (kg / litres / pcs, the unit currentStock is
// held in) and it recurses through sub-recipes. The old inline copy subtracted
// recipe grams from kilo stock (150 g off a 20 kg sack clamped it to zero and
// auto-86'd every dish on it) and skipped sub-recipe lines entirely.
//
// TIMING — at order creation, restored on cancel / reject. Chosen over "at
// completion, like COGS" for two reasons:
//   1. The till writes its own completion status (a till sale goes received →
//      completed at payment, outside transitionOrder); only the side effects
//      are shared (completeOrder). ingestOrder is the one door every channel
//      comes through.
//   2. The auto-86 needs stock that is already promised to tickets on the
//      line; depleting at completion would keep selling the last portions
//      while earlier tickets are still cooking.
// Stock and COGS still agree: a completed order has had exactly the quantities
// its COGS was costed on taken out; an order that ends without a sale
// (cancelled / rejected) gets them back and never books COGS. A REFUND keeps
// the depletion — the food was made and eaten (see postOrderRefund).
//
// Each depletion writes a 'stock' category audit row (action
// stock.sale_deplete) holding what was ACTUALLY taken per item — clamping at
// zero can take less than requested — and the restore gives back exactly that,
// once (stock.sale_restore). Both lock the order row, so a cancel racing the
// fire-and-forget depletion can't restore before it lands or deplete after it.

const STOCK_DEPLETE = 'stock.sale_deplete'
const STOCK_RESTORE = 'stock.sale_restore'
const NO_SALE: string[] = ['cancelled', 'rejected']

async function lockOrderForStock(tx: Prisma.TransactionClient, orderId: string) {
  const rows = await tx.$queryRaw<Array<{ status: string; tenantId: string | null }>>`
    SELECT o.status::text AS status, c."tenantId" AS "tenantId"
    FROM orders o JOIN concepts c ON c.id = o."conceptId"
    WHERE o.id = ${orderId}
    FOR UPDATE OF o
  `
  return rows[0] ?? null
}

/**
 * Take an order's recipe consumption out of stock. Idempotent per order, never
 * blocks order creation (callers fire and forget), silently skips items with
 * no recipe, and does nothing for an order that has already ended without a
 * sale.
 */
export async function deductInventoryForOrder(orderId: string): Promise<void> {
  const touched = await prisma.$transaction(async (tx) => {
    const order = await lockOrderForStock(tx, orderId)
    if (!order || NO_SALE.includes(order.status)) return []
    const done = await tx.auditLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: STOCK_DEPLETE },
      select: { id: true },
    })
    if (done) return []

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { menuItemId: true, quantity: true, status: true },
    })
    const need = await consumptionForSoldLines(items, tx)
    if (need.size === 0) return []

    // Row-lock the items in a fixed order (no deadlock between two orders for
    // the same ingredients), then clamp at zero. Reading under the lock is
    // what lets us record what was really taken — the old RETURNING computed
    // "before" as after + requested, which is wrong exactly when it clamps.
    const ids = [...need.keys()].sort()
    const stock = await tx.$queryRaw<Array<{ id: string; name: string; currentStock: number }>>`
      SELECT id, name, "currentStock" FROM inventory_items
      WHERE id IN (${Prisma.join(ids)})
      ORDER BY id
      FOR UPDATE
    `
    const taken: Record<string, number> = {}
    for (const row of stock) {
      const requested = need.get(row.id) ?? 0
      const before = Number(row.currentStock)
      const after = Math.max(0, before - requested)
      const actual = before - after
      if (actual > 0) {
        await tx.inventoryItem.update({ where: { id: row.id }, data: { currentStock: after } })
        taken[row.id] = actual
      }
      if (actual + 0.0001 < requested) {
        console.warn(`[inventory] ${row.name} shortfall on order ${orderId}: requested ${requested.toFixed(4)}, deducted ${actual.toFixed(4)} (clamped to 0)`)
      }
    }
    await tx.auditLog.create({
      data: {
        category: 'stock',
        tenantId: order.tenantId,
        action: STOCK_DEPLETE,
        entity: 'Order',
        entityId: orderId,
        metadata: { taken, requested: Object.fromEntries(need) } as never,
      },
    })
    return ids
  }, { maxWait: 10_000, timeout: 15_000 })

  // Auto-86: if any deducted ingredient is now at or below zero, mark every
  // menu item whose recipe depends on it as unavailable. Cross-channel: the
  // emitted event reaches storefront clients and KDS (everything reads
  // MenuItem.isAvailable).
  if (touched.length > 0) await autoEightySixDepletedItems(touched)
}

/**
 * Give back what deductInventoryForOrder took, exactly once. Called when an
 * order ends without a sale (cancelOrder). Menu items the depletion 86'd are
 * NOT switched back on automatically — an operator may have 86'd them for
 * another reason; the kitchen re-enables them.
 */
export async function restoreInventoryForOrder(orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await lockOrderForStock(tx, orderId)
    if (!order) return
    const [depleted, restored] = await Promise.all([
      tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_DEPLETE }, select: { metadata: true } }),
      tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_RESTORE }, select: { id: true } }),
    ])
    if (!depleted || restored) return
    const taken = ((depleted.metadata ?? {}) as { taken?: Record<string, number> }).taken ?? {}
    for (const [id, qty] of Object.entries(taken)) {
      if (!(qty > 0)) continue
      await tx.inventoryItem.updateMany({ where: { id }, data: { currentStock: { increment: qty } } })
    }
    await tx.auditLog.create({
      data: {
        category: 'stock',
        tenantId: order.tenantId,
        action: STOCK_RESTORE,
        entity: 'Order',
        entityId: orderId,
        metadata: { restored: taken, status: order.status } as never,
      },
    })
  }, { maxWait: 10_000, timeout: 15_000 })
}

async function autoEightySixDepletedItems(ingredientIds: string[]) {
  const depleted = await prisma.inventoryItem.findMany({
    where: { id: { in: ingredientIds }, currentStock: { lte: 0 } },
    select: { id: true },
  })
  if (depleted.length === 0) return

  // Every plate that uses a depleted ingredient — directly, or through a
  // sub-recipe at any depth (the depletion explodes sub-recipes, so the 86
  // has to follow them too).
  const recipeIds = new Set<string>()
  let frontier = (await prisma.recipeIngredient.findMany({
    where: { inventoryItemId: { in: depleted.map((d) => d.id) } },
    select: { recipeId: true },
  })).map((r) => r.recipeId)
  while (frontier.length > 0) {
    const fresh = frontier.filter((id) => !recipeIds.has(id))
    fresh.forEach((id) => recipeIds.add(id))
    if (fresh.length === 0) break
    frontier = (await prisma.recipeIngredient.findMany({
      where: { prepRecipeId: { in: fresh } },
      select: { recipeId: true },
    })).map((r) => r.recipeId)
  }
  const recipes = await prisma.recipe.findMany({
    where: { id: { in: [...recipeIds] }, menuItemId: { not: null } },
    select: { menuItemId: true, menuItem: { select: { id: true, conceptId: true, isAvailable: true } } },
  })
  const toDisable = recipes
    .filter((r): r is typeof r & { menuItem: NonNullable<typeof r.menuItem> } => r.menuItem !== null && r.menuItem.isAvailable)
    .map((r) => ({ id: r.menuItem.id, conceptId: r.menuItem.conceptId }))

  if (toDisable.length === 0) return

  await prisma.menuItem.updateMany({
    where: { id: { in: toDisable.map((m) => m.id) } },
    data: { isAvailable: false },
  })

  for (const m of toDisable) {
    emitItem86d(m.id, m.conceptId, false)
    console.warn(`[auto-86] Menu item ${m.id} disabled — depleted ingredient`)
  }
}

// ─── Ingest canonical OrderDTO ────────────────────────────────────────────────

/**
 * Create an order — the one door every channel comes through. `price` is the
 * channel's priceOrder() result (lib/pricing.ts): its GST, rate, staff
 * discount and service charge are written on the order as it is created, so
 * the ticket fires with the bill the customer is charged. `totalCents` is
 * always dto.payment.amountCents — the caller's figure after customer credits.
 */
export async function ingestOrder(dto: OrderDTO, opts: { price?: OrderPrice } = {}) {
  // Idempotency: deduplicate by source + external_id
  if (dto.external_id) {
    const existing = await prisma.order.findUnique({
      where: { source_externalId: { source: dto.source as never, externalId: dto.external_id } },
    })
    if (existing) return { order: existing, created: false }
  }

  // Pre-fetch all station mappings in one query to avoid N+1 inside the transaction
  const menuItemIds = dto.items.map((i) => i.menuItemId).filter(Boolean) as string[]
  const menuItemStations = menuItemIds.length > 0
    ? await prisma.menuItem.findMany({
        where: { id: { in: menuItemIds } },
        select: { id: true, conceptId: true, stationId: true, priceCents: true, name: true },
      })
    : []
  const stationMap = new Map(menuItemStations.map((m) => [m.id, m.stationId]))

  // Brand consistency — every channel (manual, POS, storefront, WhatsApp)
  // funnels through here, so this is the one place that guarantees an order
  // for brand X only carries brand X's items and sits at brand X's table.
  // A guessed id from another brand (or another company) would otherwise
  // route the ticket to that brand's station / pin it to that brand's table.
  // 422 either way — an unknown id and a foreign id read the same, so we
  // never confirm that a row outside this brand exists.
  const itemConcept = new Map(menuItemStations.map((m) => [m.id, m.conceptId]))
  if (menuItemIds.some((id) => itemConcept.get(id) !== dto.concept_id)) {
    throw new AppError('ITEM_NOT_IN_BRAND', 'One or more items do not belong to this brand', 422)
  }
  if (dto.table_id) {
    const table = await prisma.table.findFirst({
      where: { id: dto.table_id, conceptId: dto.concept_id, deletedAt: null },
      select: { id: true },
    })
    if (!table) throw new AppError('TABLE_NOT_IN_BRAND', 'Table does not belong to this brand', 422)
  }

  // Revenue guard: refuse to take an order for an unpriced (PKR 0) menu item.
  // Items are staged at 0 before the operator sets prices; they may be visible
  // ("coming soon") but must never be orderable, or customers get free food.
  const unpriced = menuItemStations.find((m) => (m.priceCents ?? 0) <= 0)
  if (unpriced) {
    throw new AppError('ITEM_NOT_PRICED', `"${unpriced.name}" isn't available to order yet.`, 409)
  }

  // Decide fulfilment type once, up front. Upstream channels may have
  // already told us (storefront, POS), but most won't — infer from the
  // source + tableId combination. The CEO needs every ticket to clearly
  // show plate vs package, so we never leave this null.
  const fulfilmentType: 'dine_in' | 'takeout' | 'delivery' =
    dto.fulfilment_type ?? (dto.table_id ? 'dine_in' : 'takeout')

  async function runTransaction() {
    return prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          conceptId: dto.concept_id,
          source: dto.source as never,
          fulfilmentType,
          externalId: dto.external_id || null,
          status: 'received',
          customerId: dto.customer_id,
          customerName: dto.customer_name,
          tableId: dto.table_id ?? null,
          posStaffId: dto.pos_staff_id ?? null,
          shiftId: dto.shift_id ?? null,
          totalCents: dto.payment.amountCents,
          // GST. Every storefront order charges it — it is folded into the
          // total the customer pays — but it was never written to the order,
          // so Order.taxCents sat at its default of 0 for the entire history.
          // The FBR/SRB tax invoice reads this field, and so does the sales-tax
          // return, which means GST collected was being filed as zero.
          taxCents: opts.price?.taxCents ?? dto.tax_cents ?? 0,
          // The standard GST rate this order was priced at (tender rate,
          // decision 9) — what the receipt, tax invoice, FBR and SRB read.
          // Null only for a channel that does not price through lib/pricing.
          taxRatePct: opts.price?.taxRatePct ?? null,
          ...(opts.price && {
            discountCents: opts.price.discountCents,
            serviceChargeCents: opts.price.serviceChargeCents,
          }),
          promoCodeId: dto.promo_code_id ?? null,
          promoDiscountCents: dto.promo_discount_cents ?? 0,
          walletAmountCents: dto.wallet_amount_cents ?? 0,
          scheduledFor: dto.scheduled_for ? new Date(dto.scheduled_for) : null,
          isPreOrder: dto.is_pre_order ?? false,
          deliveryNotes: dto.delivery_notes,
          estimatedPickup: dto.estimated_pickup ? new Date(dto.estimated_pickup) : null,
          placedAt: new Date(dto.placed_at),
          // Generate a 4-digit hand-off OTP for delivery orders. Customer
          // sees it on the order page; rider verifies at dropoff. From a
          // CSPRNG (lib/deliveryOtp.ts) — it used to be Math.random.
          deliveryOtp: fulfilmentType === 'delivery' || dto.delivery_notes
            ? generateDeliveryOtp()
            : null,
          rawPayload: dto.raw_payload as never ?? null,
          items: {
            create: dto.items.map((item) => ({
              menuItemId: item.menuItemId,
              stationId: item.menuItemId ? (stationMap.get(item.menuItemId) ?? null) : null,
              externalItemId: item.externalItemId,
              name: item.name,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              status: 'pending' as ItemStatus,
              notes: item.notes ?? null,
              course: item.course ?? null,
              modifiers: {
                create: item.modifiers.map((mod) => ({
                  name: mod.name,
                  priceDeltaCents: mod.priceDeltaCents,
                })),
              },
            })),
          },
          payments: dto.payment.provider
            ? {
                create: {
                  method: dto.payment.provider === 'cash' ? 'cash' : 'card',
                  amountCents: dto.payment.amountCents,
                  status: dto.payment.status === 'paid' ? 'paid' : 'pending',
                },
              }
            : undefined,
        },
        include: { items: { include: { modifiers: true } }, concept: true },
      })

      const stationIds = new Set<string>()
      for (const item of newOrder.items) {
        if (item.stationId) stationIds.add(item.stationId)
      }

      return { order: newOrder, stationIds: Array.from(stationIds) }
    }, {
      // Default Prisma timeout is 5s — too tight for cold-start Neon under load.
      // 15s gives the cloud DB time to warm up + still trips on real deadlocks.
      maxWait: 10_000,
      timeout: 15_000,
    })
  }

  let txResult: Awaited<ReturnType<typeof runTransaction>>
  try {
    txResult = await runTransaction()
  } catch (err) {
    // Concurrent request already created this order — return it
    const prismaErr = err as Prisma.PrismaClientKnownRequestError
    if (prismaErr.code === 'P2002' && dto.external_id) {
      const existing = await prisma.order.findUnique({
        where: { source_externalId: { source: dto.source as never, externalId: dto.external_id } },
      })
      if (existing) return { order: existing, created: false }
    }
    throw err
  }

  // Emit WebSocket event to KDS
  emitOrderNew({
    orderId: txResult.order.id,
    conceptId: txResult.order.conceptId,
    source: txResult.order.source,
    stationIds: txResult.stationIds,
    placedAt: txResult.order.placedAt.toISOString(),
  })

  // Fire-and-forget: deduct inventory + notify customer + schedule course pacing
  const orderId = txResult.order.id
  deductInventoryForOrder(orderId).catch((err) =>
    console.error(`[Inventory] Deduction failed for order ${orderId}:`, (err as Error).message),
  )
  notifyNewOrder(orderId).catch((err) =>
    console.error(`[Notify] Order receipt failed for ${orderId}:`, (err as Error).message),
  )
  scheduleCoursePacing(orderId).catch((err) =>
    console.error(`[Pacing] Failed for order ${orderId}:`, (err as Error).message),
  )
  // Bump customer rollups (lastOrderAt, visit counts, etc.) when order is placed.
  if (txResult.order.customerId) {
    import('../../lib/customerRollups.js')
      .then(({ bumpCustomerRollups }) => bumpCustomerRollups(txResult.order.customerId))
      .catch(() => {})
  }

  return { order: txResult.order, created: true }
}

// ─── Course pacing ────────────────────────────────────────────────────────────
// Compute when each item should auto-fire so all items plate together.
// Anchor: "now" + max(laborMinutes). The longest item fires immediately;
// shorter items get delayed by (maxLabor - itemLabor) so they finish in sync.

export async function scheduleCoursePacing(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      items: {
        where: { status: 'pending', menuItemId: { not: null } },
        select: { id: true, menuItemId: true },
      },
    },
  })
  if (!order || order.items.length < 2) return  // single-item orders don't need pacing

  const menuItemIds = order.items.map((i) => i.menuItemId).filter((x): x is string => !!x)
  const recipes = await prisma.recipe.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: { menuItemId: true, laborMinutes: true },
  })
  const laborMap = new Map(recipes.map((r) => [r.menuItemId, r.laborMinutes]))

  // Items without a recipe assume 0 minutes (instant — like drinks)
  const itemLabors = order.items.map((i) => ({
    id: i.id,
    labor: laborMap.get(i.menuItemId!) ?? 0,
  }))
  const maxLabor = Math.max(...itemLabors.map((i) => i.labor))
  if (maxLabor === 0) return  // nothing has a labor time; let kitchen fire manually

  const now = Date.now()
  await prisma.$transaction(
    itemLabors.map(({ id, labor }) =>
      prisma.orderItem.update({
        where: { id },
        data: { scheduledFireAt: new Date(now + (maxLabor - labor) * 60_000) },
      }),
    ),
  )
}

// Worker entry point: find items past their fire time and promote to 'preparing'
export async function processCoursePacingTick(): Promise<number> {
  const due = await prisma.orderItem.findMany({
    where: {
      status: 'pending',
      scheduledFireAt: { lte: new Date(), not: null },
    },
    select: { id: true, stationId: true },
    take: 100,
  })
  if (due.length === 0) return 0

  await prisma.$transaction(
    due.map(({ id }) =>
      prisma.orderItem.update({
        where: { id },
        data: { status: 'preparing', firedAt: new Date() },
      }),
    ),
  )

  for (const { id, stationId } of due) {
    emitItemUpdated(id, 'preparing', stationId)
  }
  return due.length
}

// ─── List orders ──────────────────────────────────────────────────────────────

export interface ListOrdersFilter {
  conceptId?: string
  conceptIds?: string[]
  source?: string
  status?: string
  dateFrom?: string
  dateTo?: string
  cursor?: string
  limit?: number
}

export async function listOrders(filter: ListOrdersFilter) {
  const limit = Math.min(filter.limit ?? 50, 200)

  // conceptIds (from staff + company scoping) is the hard boundary of the
  // result set; conceptId (explicit filter) only narrows WITHIN it. The scope
  // is always applied — an empty scope returns nothing, never everything.
  // (It used to fall through to an unscoped query when the intersection was
  // empty, which listed every company's orders.)
  const scopedIds = filter.conceptIds ?? []
  const conceptIds = filter.conceptId
    ? (scopedIds.includes(filter.conceptId) ? [filter.conceptId] : [])
    : scopedIds
  if (conceptIds.length === 0) return { data: [], cursor: null, hasMore: false }

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      conceptId: { in: conceptIds },
      ...(filter.source && { source: filter.source as never }),
      ...(filter.status && filter.status.includes(',')
        ? { status: { in: filter.status.split(',') as OrderStatus[] } }
        : filter.status ? { status: filter.status as OrderStatus } : {}),
      ...(filter.dateFrom || filter.dateTo
        ? {
            placedAt: {
              ...(filter.dateFrom && { gte: new Date(filter.dateFrom) }),
              ...(filter.dateTo && { lte: new Date(filter.dateTo) }),
            },
          }
        : {}),
      ...(filter.cursor && { id: { lt: filter.cursor } }),
    },
    include: {
      items: {
        include: {
          modifiers: true,
          station: { select: { name: true } },
          menuItem: { select: { imageUrl: true, nameUrdu: true, instructions: true, instructionsUrdu: true } },
        },
      },
      concept: { select: { name: true, slug: true } },
      table: { select: { label: true } },
      payments: true,
      rider: { select: { id: true, name: true, phone: true } },
    },
    orderBy: { placedAt: 'desc' },
    take: limit + 1,
  })

  const hasMore = orders.length > limit
  if (hasMore) orders.pop()

  return {
    data: orders,
    cursor: hasMore ? (orders[orders.length - 1]?.id ?? null) : null,
    hasMore,
  }
}

// ─── Get single order ─────────────────────────────────────────────────────────

// `scope` is the caller's company boundary (e.g. `{ concept: { tenantId } }`
// from the route's orderInCompany helper) so a foreign id 404s at the lookup
// itself — the row is never fetched and then filtered.
export async function getOrder(id: string, scope: Prisma.OrderWhereInput = {}) {
  const order = await prisma.order.findFirst({
    where: { id, deletedAt: null, ...scope },
    include: {
      items: {
        include: {
          modifiers: true,
          station: true,
          menuItem: { select: { imageUrl: true, nameUrdu: true, instructions: true, instructionsUrdu: true } },
        },
      },
      concept: true,
      table: true,
      customer: true,
      payments: true,
      posStaff: { select: { name: true } },
      // The numbered legal documents (tax invoice, credit notes) — the order
      // page links each to /invoices/:id/html.
      taxInvoices: { select: { id: true, invoiceNumber: true, type: true, issuedAt: true }, orderBy: { issuedAt: 'asc' } },
    },
  })
  if (!order) throw new NotFoundError('Order', id)
  return order
}

// ─── Update order status ──────────────────────────────────────────────────────

/** Statuses that end an order without a sale. Only cancelOrder() writes them. */
export type CancelStatus = Extract<OrderStatus, 'cancelled' | 'rejected'>

/**
 * Move an order along the kitchen / service lifecycle (confirm, fire, ready,
 * complete, refund). Cancelling or rejecting is NOT done here — it needs a
 * reason and an audit entry, so it goes through cancelOrder(), which the type
 * enforces.
 */
export async function updateOrderStatus(
  id: string,
  status: Exclude<OrderStatus, CancelStatus>,
  completion: { actor?: CompletionActor | null; via?: CompletionVia } = {},
) {
  return (await transitionOrder(id, status, completion)).order
}

/**
 * The one writer of Order.status. Validates the transition, claims it with a
 * conditional update, and runs the side effects exactly once. `changed` is
 * false for a same-state write or a lost race — nothing ran.
 */
async function transitionOrder(
  id: string,
  status: OrderStatus,
  opts: {
    cancellationReason?: string
    onlyFrom?: OrderStatus[]
    actor?: CompletionActor | null
    via?: CompletionVia
  } = {},
) {
  const order = await prisma.order.findFirst({ where: { id, deletedAt: null } })
  if (!order) throw new NotFoundError('Order', id)

  // A caller that decided on a stale read (the auto-cancel sweep picked this
  // order up while it sat in 'received') must not act on an order that has
  // since moved on — the kitchen confirming it is exactly the case it must not
  // cancel.
  if (opts.onlyFrom && !opts.onlyFrom.includes(order.status)) {
    throw new AppError('ORDER_MOVED_ON', `Order ${id} is now ${order.status}`, 409)
  }

  // B19: validate the transition. Retried webhooks / repeated client requests
  // that try to move a `completed` order back to `received` (or `confirmed`)
  // used to silently succeed and re-fire all the side effects — financial
  // entries, loyalty earns, FBR submission. The state machine rejects with a
  // 409 here so the caller can dedupe.
  const { canTransitionOrder } = await import('../../lib/orderStateMachine.js')
  if (!canTransitionOrder(order.status, status)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot move order ${id} from ${order.status} → ${status}`,
      409,
    )
  }

  // A same-state write is a no-op, not a transition. The state machine allows
  // it (gateway retries of the same callback must not 409), and the
  // conditional update below would still match, so without this every side
  // effect ran again: a second 'completed' — the admin bulk "Complete" over an
  // already-completed order is enough — awarded the loyalty points twice and
  // re-sent the customer notice and the webhook; a second 'cancelled'
  // re-ran the reversal.
  if (order.status === status) return { order, changed: false }

  // Conditional update so two parallel writers don't both succeed. Whoever
  // gets through second sees count===0 and we no-op without re-firing side
  // effects (still emit the WS event — same end-state, idempotent).
  const isCancel = status === 'cancelled' || status === 'rejected'
  const result = await prisma.order.updateMany({
    where: { id, status: order.status },
    data: {
      status,
      ...(status === 'completed' && { completedAt: new Date() }),
      ...(isCancel && { cancelledAt: new Date(), cancellationReason: opts.cancellationReason ?? null }),
    },
  })
  if (result.count === 0) {
    // Lost the race; the other writer already moved us to (or past) this
    // status. Treat as success but skip the side-effect cascade.
    emitOrderUpdated(id, status)
    const refreshed = await prisma.order.findUnique({ where: { id } })
    return { order: refreshed!, changed: false }
  }
  const updated = await prisma.order.update({ where: { id }, data: {} })   // refetch shape

  emitOrderUpdated(id, status)

  // Outbound webhook fan-out — operators may subscribe to order state changes
  // for accounting / BI / Slack etc. Fire-and-forget; never blocks the update.
  // (Completion's 'order.delivered' is sent by completeOrder, once.)
  void (async () => {
    const { emitDomainEvent } = await import('../../lib/webhook-events.js')
    const eventName =
      status === 'refunded'  ? 'order.refunded'  :
      status === 'preparing' ? 'order.confirmed' :
      status === 'ready'     ? 'order.dispatched' :
      null
    if (eventName) {
      emitDomainEvent(eventName, { orderId: id, status, conceptId: order.conceptId, totalCents: order.totalCents }, await tenantIdOfConcept(order.conceptId))
    }
  })()

  // On completion: the one completion routine — ledger, tax invoice, FBR/SRB,
  // loyalty earn, customer rollups, webhook, customer notice — exactly once.
  // The till, expo hand-off, rider drop-off and OTP verify all end up there.
  if (status === 'completed') {
    await completeOrder(id, opts.actor ?? null, { via: opts.via ?? 'status_update' })
  }

  // Notify customer on key status transitions ('completed' is completeOrder's)
  if (['preparing', 'ready', 'cancelled', 'rejected'].includes(status)) {
    notifyStatusChange(id, status).catch((err) =>
      console.error(`[Notify] Status update failed for ${id}:`, (err as Error).message),
    )
  }

  // Terminal status transitions give back what the customer spent at
  // checkout: wallet, gift-card balance, earned points (idempotent — replays
  // are safe). A rejected order is a cancelled one the kitchen declined at
  // intake — it kept the customer's money before this. 'refunded' is written
  // ONLY by the one refund engine (refundOrder in pos/service.ts) once the
  // order is refunded in full; the money handed back is already on the books
  // through each refund payment's own 'order.refund' entry, so there is no
  // journal reversal here — only the wallet share of a refunded sale is
  // booked back (Cr 2050). Errors are logged but never block the status update.
  if (status === 'refunded' || isCancel) {
    postOrderRefund(id, `Order ${status}`, { bookWalletRestore: status === 'refunded' }).catch((err) =>
      console.error(`[journal] postOrderRefund failed for ${id}:`, (err as Error).message),
    )
    import('../invoices/service.js')
      .then(({ issueCreditNoteForOrder }) => issueCreditNoteForOrder(id, `Order ${status}`))
      .catch((err) => {
        const msg = (err as Error).message
        // No invoice was issued in the first place (concept not registered) — fine to skip
        if (!msg.includes('NOT_FOUND')) {
          console.error(`[invoice] auto credit-note failed for ${id}:`, msg)
        }
      })
  }

  // A refund in full ends a till-paid order that may still be out with a
  // rider (it was 'completed', so on their hands — dispatch/service
  // riderOpenOrderWhere): free them, as cancelOrder does for a cancel.
  if (status === 'refunded') {
    const { releaseRiderFromEndedOrder } = await import('../dispatch/service.js')
    await releaseRiderFromEndedOrder(id, 'order refunded').catch((err) =>
      console.error(`[dispatch] rider release failed for refunded order ${id}:`, (err as Error).message),
    )
  }

  // A promo applied to an order that never happened is given back: the usage
  // row goes, so the per-customer limit no longer counts it, and a capped
  // promo's usedCount comes back down. Refunds keep the usage — the sale did
  // happen.
  if (isCancel && order.promoCodeId) {
    releasePromoUsage(id, order.promoCodeId).catch((err) =>
      console.error(`[promo] usage release failed for ${id}:`, (err as Error).message),
    )
  }

  return { order: updated, changed: true }
}

async function releasePromoUsage(orderId: string, promoCodeId: string): Promise<void> {
  // Deleting is the claim: a second run finds nothing and gives nothing back.
  const released = await prisma.promoCodeUsage.deleteMany({ where: { orderId, promoCodeId } })
  if (released.count === 0) return
  const promo = await prisma.promoCode.findUnique({ where: { id: promoCodeId }, select: { maxUsageCount: true } })
  // usedCount is only counted for capped promos (checkout increments it only
  // when maxUsageCount is set), so only those are given the count back.
  if (promo?.maxUsageCount == null) return
  await prisma.promoCode.updateMany({
    where: { id: promoCodeId, usedCount: { gte: released.count } },
    data: { usedCount: { decrement: released.count } },
  })
}

// ─── Cancel / reject ──────────────────────────────────────────────────────────
//
// The one way an order ends without a sale. Every entry point — the manager
// cancel on /orders and /refunds, the expo reject, refused-at-door and the
// auto-cancel sweep — comes through here, so each one gets the state machine,
// the cancelledAt + reason stamp, the customer notice, the restores (wallet,
// gift card, points earned on it, the stock the sale took), the promo release
// and an audit entry.

export interface CancelOrderInput {
  /** Why. Required — stored on the order and in the audit trail. */
  reason: string
  /** 'rejected' = declined at intake (expo). Defaults to 'cancelled'. */
  status?: CancelStatus
  /** The staff member acting; null for the system (auto-cancel sweep). */
  actor: { id: string; email?: string | null; tenantId?: string | null } | null
  /** Audit action. Defaults to order.cancel / order.reject. */
  action?: string
  /** Only act if the order is still in one of these statuses. */
  onlyFrom?: OrderStatus[]
  metadata?: Record<string, unknown>
}

export async function cancelOrder(id: string, input: CancelOrderInput) {
  const status: CancelStatus = input.status ?? 'cancelled'
  const reason = input.reason.trim()
  if (!reason) throw new AppError('REASON_REQUIRED', 'A reason is required to cancel an order', 422)

  const before = await prisma.order.findFirst({
    where: { id, deletedAt: null },
    select: { status: true, totalCents: true },
  })
  if (!before) throw new NotFoundError('Order', id)

  const { order, changed } = await transitionOrder(id, status, {
    cancellationReason: reason,
    onlyFrom: input.onlyFrom,
  })

  // No sale → the stock the order took at creation goes back (and it never
  // books COGS). Only on the call that actually made the change; the restore
  // is itself once-only, so a retry after a failure is safe.
  if (changed) {
    await restoreInventoryForOrder(id).catch((err) =>
      console.error(`[inventory] restore failed for ${status} order ${id}:`, (err as Error).message),
    )
    // Its rider (if any) is freed, with an `unassigned` job event — an order
    // that will never be delivered must not keep a rider 'busy' or on the
    // rider app's job list (docs/rider-app.md).
    const { releaseRiderFromEndedOrder } = await import('../dispatch/service.js')
    await releaseRiderFromEndedOrder(id, `order ${status}: ${reason}`).catch((err) =>
      console.error(`[dispatch] rider release failed for ${status} order ${id}:`, (err as Error).message),
    )
  }

  // Audit only what actually happened: a repeat cancel is a no-op, not a
  // second cancellation.
  if (changed) {
    const { audit } = await import('../../lib/audit.js')
    await audit({
      category: 'identity',
      action: input.action ?? (status === 'rejected' ? 'order.reject' : 'order.cancel'),
      entity: 'Order',
      entityId: id,
      userId: input.actor?.id ?? null,
      userEmail: input.actor?.email ?? null,
      tenantId: input.actor?.tenantId ?? null,
      before: { status: before.status, totalCents: before.totalCents },
      after: { status },
      metadata: { reason, ...(input.metadata ?? {}) },
    })
  }
  return order
}

// ─── Update order item status (KDS interactions) ──────────────────────────────

// Kitchen moves only. A void is voidOrderItem() in pos/service.ts — caps, PIN,
// reason and audit — so 'voided' is not accepted here.
export async function updateItemStatus(itemId: string, status: Exclude<ItemStatus, 'voided'>, staffId?: string) {
  // Belt and braces for callers that cast past the type.
  if ((status as ItemStatus) === 'voided') {
    throw new AppError('USE_POS_VOID', 'Void a line through POST /pos/orders/:orderId/void', 422)
  }
  const item = await prisma.orderItem.findUnique({ where: { id: itemId } })
  if (!item) throw new NotFoundError('OrderItem', itemId)

  // B19: validate the kitchen transition. Pre-fix, a recall on an already-
  // bumped item that had a duplicate event in flight could leave the item in
  // a "voided then revived" state that broke the all-done check below.
  const { canTransitionItem, canTransitionOrder } = await import('../../lib/orderStateMachine.js')
  if (!canTransitionItem(item.status, status)) {
    throw new AppError(
      'INVALID_TRANSITION',
      `Cannot move item ${itemId} from ${item.status} → ${status}`,
      409,
    )
  }

  // Set completedAt when the item leaves active service (ready or bumped).
  // Bumped is the canonical "done" state — kitchens often skip 'ready' and go
  // straight from 'preparing' → 'bumped', so we treat both as completion.
  const isCompleting = status === 'ready' || status === 'bumped'
  // Conditional update prevents two parallel KDS bumps from both succeeding.
  const result = await prisma.orderItem.updateMany({
    where: { id: itemId, status: item.status },
    data: {
      status,
      ...(isCompleting && !item.completedAt && { completedAt: new Date() }),
      ...(status === 'preparing' && { firedAt: new Date() }),
    },
  })
  if (result.count === 0) {
    // Race lost — somebody else already moved this item. Return the current
    // shape so callers don't blow up; emit the event since the end state is
    // already what they wanted.
    emitItemUpdated(itemId, status, item.stationId)
    return prisma.orderItem.findUnique({ where: { id: itemId } })
  }
  const updated = await prisma.orderItem.findUnique({ where: { id: itemId } })

  emitItemUpdated(itemId, status, item.stationId)

  // All dishes done → hand the order up to expo's "ready" queue. The kitchen
  // NEVER completes an order: completion is the expo hand-off (pickup), the
  // drop-off (delivery) or the payment (till sale) — decision 8, completeOrder
  // below. The kitchen path must NOT complete the order itself: that skips expo's sign-off, and because the state machine only
  // allows ready → completed it used to throw INVALID_TRANSITION and silently
  // strand the order in 'preparing' — never completed, never invoiced.
  if (status === 'bumped') {
    const order = await prisma.order.findUnique({
      where: { id: item.orderId },
      include: { items: true },
    })
    if (order) {
      const allDone = order.items.every((i) => ['bumped', 'voided'].includes(i.status))
      if (allDone && order.status !== 'ready' && canTransitionOrder(order.status, 'ready')) {
        await updateOrderStatus(item.orderId, 'ready')
      }
    }
  }

  return updated
}

// ─── Customer notification helpers ───────────────────────────────────────────

async function notifyNewOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true } },
      customer: { select: { email: true, phone: true, name: true } },
      items: { select: { name: true, quantity: true, unitPriceCents: true } },
    },
  })
  if (!order || (!order.customer?.email && !order.customer?.phone)) return

  await sendOrderReceipt({
    email: order.customer?.email,
    phone: order.customer?.phone,
    orderId: order.id,
    conceptName: order.concept.name,
    totalCents: order.totalCents,
    items: order.items,
  })
}

async function notifyStatusChange(orderId: string, status: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true } },
      customer: { select: { email: true, phone: true, name: true } },
    },
  })
  if (!order || (!order.customer?.email && !order.customer?.phone)) return

  await sendOrderStatusUpdate({
    email: order.customer?.email,
    phone: order.customer?.phone,
    conceptName: order.concept.name,
    conceptId: order.conceptId,
    orderId: order.id,
    status,
    customerName: order.customer?.name ?? order.customerName,
  })
}

// ─── Order completion ────────────────────────────────────────────────────────
//
// THE completion routine. Every way an order becomes a sale ends here, after
// that path's own status write:
//
//   till sale    POST /pos/payments (processPayment) and the comp engine, once
//                the bill is fully settled — decision 8: a till sale is
//                complete at payment
//   pickup       POST /expo/orders/:id/handoff (and a staff "Complete" on the
//                same kind of order) — complete at expo hand-off
//   delivery     POST /dispatch/orders/:id/delivered and
//                POST /trustops/orders/:id/verify-otp — complete when the rider
//                drops it off; expo handing the bag to the rider does NOT
//                complete it
//
// The KDS never completes an order: all items bumped moves it to 'ready' and
// no further.
//
// It claims the completion once (the order row locked, an 'order.complete'
// audit row as the claim — a replay, a retried request or a second path
// finds the claim and does nothing) and then runs, exactly once:
//   - the ledger entry (postOrderCompletion; till sales post with their
//     shift's close). The FinancialEntry register is gone (decision 39).
//   - the tax invoice (TaxInvoice, the one customer tax document)
//   - FBR and SRB filing — every source, not only the till. A till sale tries
//     SRB synchronously so the verification QR can print on its receipt.
//   - the loyalty earn (loyalty/service awardOrderPoints, once per order)
//   - the customer rollups (firstOrderAt / lastOrderAt / totalSpentCents)
//   - the 'order.delivered' webhook and the customer's "completed" notice
// Each step is fire-and-forget except the till's SRB attempt: a failure is
// logged and never unwinds a sale that has happened.

export interface CompletionActor { id: string; email?: string | null; tenantId?: string | null }

export type CompletionVia =
  | 'till_payment'
  | 'till_comp'
  | 'expo_handoff'
  | 'rider_delivered'
  | 'otp_verified'
  | 'status_update'

export interface SrbReceipt { srbInvoiceId: string; qrCodeLink: string | null }

const COMPLETE_CLAIM = 'order.complete'

/**
 * A sale settled at the till: rung up at the POS, or a group order (one
 * table's bill, split and paid at the till). These complete at payment.
 */
export function isTillSale(order: { source: string; rawPayload?: unknown }): boolean {
  if (order.source === 'pos') return true
  const raw = order.rawPayload as { channel?: unknown } | null | undefined
  return raw?.channel === 'group_order'
}

/** Decision 8: which door completes an order. */
export type CompletionDoor = 'payment' | 'delivery' | 'handoff'
export function completionDoor(order: { source: string; fulfilmentType: string; rawPayload?: unknown }): CompletionDoor {
  if (isTillSale(order)) return 'payment'
  if (order.fulfilmentType === 'delivery') return 'delivery'
  return 'handoff'
}

/**
 * Run the completion side effects of an order whose status is already
 * 'completed'. Idempotent: only the first call for an order does anything.
 * `syncSrb` (the till) submits SRB inline so the receipt can carry the QR.
 */
export async function completeOrder(
  orderId: string,
  actor: CompletionActor | null,
  opts: { via: CompletionVia; syncSrb?: boolean },
): Promise<{ ran: boolean; srb: SrbReceipt | null }> {
  const claim = await prisma.$transaction(async (tx) => {
    const row = await lockOrderForStock(tx, orderId)
    if (!row || row.status !== 'completed') return null
    const done = await tx.auditLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: COMPLETE_CLAIM },
      select: { id: true },
    })
    if (done) return null
    // The claim row. Its own 'order' trail (like the 'stock' depletion rows),
    // not the managers' identity trail — every sale writes one.
    await tx.auditLog.create({
      data: {
        category: 'order',
        tenantId: row.tenantId ?? actor?.tenantId ?? null,
        action: COMPLETE_CLAIM,
        entity: 'Order',
        entityId: orderId,
        userId: actor?.id ?? null,
        userEmail: actor?.email ?? null,
        metadata: { via: opts.via },
      },
    })
    return { tenantId: row.tenantId }
  }, { maxWait: 10_000, timeout: 15_000 })
  if (!claim) return { ran: false, srb: null }

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, conceptId: true, customerId: true, totalCents: true },
  })

  // Ledger. Till sales are skipped inside (they post with the shift close).
  postOrderCompletion(orderId).catch((err) =>
    console.error(`[journal] postOrderCompletion failed for ${orderId}:`, (err as Error).message),
  )

  // Tax invoice. Skipped silently when the brand is not set up for invoicing
  // (no invoiceLegalName); POST /invoices/orders/:id/issue can issue it later.
  import('../invoices/service.js')
    .then(({ issueInvoiceForOrder }) => issueInvoiceForOrder({ orderId }))
    .catch((err) => {
      const msg = (err as Error).message
      if (!msg.includes('CONCEPT_NOT_REGISTERED') && !msg.includes('invoice legal name')) {
        console.error(`[invoice] auto-issue failed for ${orderId}:`, msg)
      }
    })

  // FBR (federal) and SRB (Sindh). The builders skip brands that are not
  // registered. jobId dedupes a second enqueue of the same order.
  const { getFbrQueue, getSrbQueue } = await import('../../lib/queue.js')
  getFbrQueue()
    ?.add('submit', { orderId }, { jobId: `fbr-${orderId}` })
    .catch((err: Error) => console.warn(`[FBR] enqueue failed for ${orderId}:`, err.message))
  let srb: SrbReceipt | null = null
  if (opts.syncSrb) {
    srb = await submitSrbForReceipt(orderId)
  } else {
    getSrbQueue()
      ?.add('submit', { orderId }, { jobId: `srb-${orderId}` })
      .catch((err: Error) => console.warn(`[SRB] enqueue failed for ${orderId}:`, err.message))
  }

  if (order.customerId) {
    // THE order earn (modules/loyalty/service.ts): once per order, never throws.
    void import('../loyalty/service.js').then(({ awardOrderPoints }) => awardOrderPoints(orderId))
    const { bumpCustomerRollups } = await import('../../lib/customerRollups.js')
    bumpCustomerRollups(order.customerId)
  }

  void (async () => {
    const { emitDomainEvent } = await import('../../lib/webhook-events.js')
    emitDomainEvent(
      'order.delivered',
      { orderId, status: 'completed', conceptId: order.conceptId, totalCents: order.totalCents },
      claim.tenantId ?? await tenantIdOfConcept(order.conceptId),
    )
  })().catch((err) => console.error(`[webhook] order.delivered failed for ${orderId}:`, (err as Error).message))

  notifyStatusChange(orderId, 'completed').catch((err) =>
    console.error(`[Notify] Status update failed for ${orderId}:`, (err as Error).message),
  )

  return { ran: true, srb }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// SRB for the till receipt: tries the live gateway synchronously (the SRB POS
// spec requires the verification QR on the receipt) but NEVER blocks the sale —
// on any error or timeout it falls back to the async retry queue and returns
// null. Null too when the brand is not SRB-registered.
async function submitSrbForReceipt(orderId: string): Promise<SrbReceipt | null> {
  try {
    const { buildSrbDataForOrder, submitSrbInvoice } = await import('../../adapters/srb/index.js')
    const data = await buildSrbDataForOrder(orderId)
    if (!data) return null
    const result = await withTimeout(submitSrbInvoice(data), 8000, 'SRB submit')
    await prisma.order.update({
      where: { id: orderId },
      data: { srbInvoiceNumber: result.srbInvoiceId, srbQrCodeLink: result.qrCodeLink },
    })
    return result
  } catch (err) {
    console.warn(`[SRB] sync submit failed for ${orderId}; falling back to queue: ${(err as Error).message}`)
    const { getSrbQueue } = await import('../../lib/queue.js')
    getSrbQueue()
      ?.add('submit', { orderId }, { jobId: `srb-${orderId}` })
      .catch((e: Error) => console.warn('[SRB] Failed to enqueue fallback submission:', e.message))
    return null
  }
}
