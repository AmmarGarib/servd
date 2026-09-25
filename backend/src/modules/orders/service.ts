import { prisma } from '../../lib/prisma.js'
import { emitOrderNew, emitOrderUpdated, emitItemUpdated, emitItem86d } from '../../lib/ws.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { sendOrderReceipt, sendOrderStatusUpdate } from '../../lib/notify.js'
import { postOrderCompletion, postOrderRefund } from '../accounting/orderPosting.js'
import type { OrderDTO } from '@servd/types'
import type { OrderStatus, ItemStatus, Prisma } from '@prisma/client'
import { calculatePointsEarned } from '../../lib/loyaltySettings.js'

// ─── Inventory deduction (recipe-driven) ─────────────────────────────────────
// Called fire-and-forget after a new order is created.
// Silently skips items without a configured recipe — never blocks order creation.

export async function deductInventoryForOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      items: {
        where: { status: { not: 'voided' } },
        select: { menuItemId: true, quantity: true },
      },
    },
  })
  if (!order) return

  const menuItemIds = order.items
    .map((i) => i.menuItemId)
    .filter((id): id is string => id !== null)
  if (!menuItemIds.length) return

  const recipes = await prisma.recipe.findMany({
    where: { menuItemId: { in: menuItemIds } },
    include: { ingredients: { select: { inventoryItemId: true, quantity: true, yieldPct: true } } },
  })
  if (!recipes.length) return

  const recipeMap = new Map(recipes.map((r) => [r.menuItemId, r]))

  // Accumulate total deduction per inventory item across all order items
  const deductions = new Map<string, number>()
  for (const item of order.items) {
    if (!item.menuItemId) continue
    const recipe = recipeMap.get(item.menuItemId)
    if (!recipe || recipe.servings < 1) continue
    for (const ing of recipe.ingredients) {
      if (!ing.inventoryItemId) continue
      // quantity per serving adjusted for yield loss
      const rawQtyPerServing = ing.quantity / recipe.servings
      const purchaseQty = ing.yieldPct > 0 ? rawQtyPerServing / ing.yieldPct : rawQtyPerServing
      const total = purchaseQty * item.quantity
      deductions.set(ing.inventoryItemId, (deductions.get(ing.inventoryItemId) ?? 0) + total)
    }
  }

  if (!deductions.size) return

  // Atomic clamped decrement — the read-then-write pattern races under
  // concurrent orders for the same item (two orders both reading 0.05kg,
  // both decrementing, ending at -0.05kg). GREATEST(0, …) at the DB level
  // makes each UPDATE self-contained: PostgreSQL row-locks the row for the
  // duration of the UPDATE, so concurrent decrements serialise correctly.
  // The trade-off: we lose the per-item "shortfall" log unless we read the
  // before/after values. We compute shortfall via a RETURNING clause.
  const ids = Array.from(deductions.keys())

  for (const [id, qty] of deductions.entries()) {
    // Single-statement clamped decrement, returning the change so we can
    // detect (and log) shortfalls without a separate read.
    const result = await prisma.$queryRaw<Array<{ name: string; before: number; after: number }>>`
      UPDATE inventory_items
      SET "currentStock" = GREATEST(0, "currentStock" - ${qty})
      WHERE id = ${id}
      RETURNING name, ("currentStock" + ${qty}) AS before, "currentStock" AS after
    `
    const row = result[0]
    if (!row) continue
    const requested = qty
    const actual = Number(row.before) - Number(row.after)
    if (actual + 0.0001 < requested) {
      console.warn(`[inventory] ${row.name} shortfall: requested ${requested.toFixed(4)}, deducted ${actual.toFixed(4)} (clamped to 0)`)
    }
  }

  // Auto-86: if any deducted ingredient is now at or below zero, mark every
  // menu item whose recipe depends on it as unavailable. Cross-channel: the
  // emitted event reaches storefront clients and KDS (everything reads
  // MenuItem.isAvailable).
  await autoEightySixDepletedItems(ids)
}

async function autoEightySixDepletedItems(ingredientIds: string[]) {
  const depleted = await prisma.inventoryItem.findMany({
    where: { id: { in: ingredientIds }, currentStock: { lte: 0 } },
    select: { id: true },
  })
  if (depleted.length === 0) return

  // Find every recipe that uses any depleted ingredient, then map to menu items
  const recipes = await prisma.recipe.findMany({
    where: { ingredients: { some: { inventoryItemId: { in: depleted.map((d) => d.id) } } } },
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

export async function ingestOrder(dto: OrderDTO) {
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
    (dto as { fulfilment_type?: 'dine_in' | 'takeout' | 'delivery' }).fulfilment_type
    ?? (dto.table_id ? 'dine_in' : 'takeout')

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
          taxCents: dto.tax_cents ?? 0,
          promoCodeId: dto.promo_code_id ?? null,
          promoDiscountCents: dto.promo_discount_cents ?? 0,
          walletAmountCents: dto.wallet_amount_cents ?? 0,
          scheduledFor: dto.scheduled_for ? new Date(dto.scheduled_for) : null,
          isPreOrder: dto.is_pre_order ?? false,
          deliveryNotes: dto.delivery_notes,
          estimatedPickup: dto.estimated_pickup ? new Date(dto.estimated_pickup) : null,
          placedAt: new Date(dto.placed_at),
          // Generate a 4-digit hand-off OTP for delivery orders. Customer
          // sees it on the order page; rider verifies at dropoff.
          deliveryOtp: dto.delivery_notes ? Math.floor(1000 + Math.random() * 9000).toString() : null,
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
export async function updateOrderStatus(id: string, status: Exclude<OrderStatus, CancelStatus>) {
  return (await transitionOrder(id, status)).order
}

/**
 * The one writer of Order.status. Validates the transition, claims it with a
 * conditional update, and runs the side effects exactly once. `changed` is
 * false for a same-state write or a lost race — nothing ran.
 */
async function transitionOrder(
  id: string,
  status: OrderStatus,
  opts: { cancellationReason?: string; onlyFrom?: OrderStatus[] } = {},
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
  void (async () => {
    const { emitDomainEvent } = await import('../../lib/webhook-events.js')
    const eventName =
      status === 'completed' ? 'order.delivered' :
      status === 'refunded'  ? 'order.refunded'  :
      status === 'preparing' ? 'order.confirmed' :
      status === 'ready'     ? 'order.dispatched' :
      null
    if (eventName) {
      emitDomainEvent(eventName, { orderId: id, status, conceptId: order.conceptId, totalCents: order.totalCents })
    }
  })()

  // On completion: award loyalty points + refresh customer rollups.
  // Both are fire-and-forget — a failure here must never block the kitchen bump.
  if (status === 'completed' && order.customerId) {
    const customerId = order.customerId

    // ── Loyalty points earn ──────────────────────────────────────────────────
    // Mirror the rate used in the loyalty routes: 1 point per PKR 1 (100 paisa).
    // Use the operator's configured earn rate (admin → Loyalty), not a
    // hardcoded 1 point per PKR 1 — changing the rate on the settings page had
    // no effect on what customers actually earned.
    const pointsToEarn = await calculatePointsEarned(order.totalCents)
    if (pointsToEarn > 0) {
      void (async () => {
        try {
          // Upsert account so guest-converted customers get one automatically.
          let account = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
          if (!account) {
            account = await prisma.loyaltyAccount.create({
              data: { customerId, stampCounts: {} },
            })
          }
          await prisma.$transaction([
            prisma.loyaltyAccount.update({
              where: { id: account.id },
              data: {
                pointsBalance:  { increment: pointsToEarn },
                lifetimePoints: { increment: pointsToEarn },
              },
            }),
            prisma.loyaltyTransaction.create({
              data: {
                loyaltyAccountId: account.id,
                orderId:          id,
                type:             'earn',
                pointsDelta:      pointsToEarn,
                description:      `Earned ${pointsToEarn} pts — order #${id.slice(0, 8)} completed`,
              },
            }),
          ])
        } catch (err) {
          console.error('[loyalty] earn failed for order', id, ':', (err as Error).message)
        }
      })()
    }

    // ── Customer rollups ─────────────────────────────────────────────────────
    const { bumpCustomerRollups } = await import('../../lib/customerRollups.js')
    bumpCustomerRollups(customerId)
  }

  // On completion: post the financial entry, journal, and tax invoice. These
  // live here (not in the item-bump path) so they fire exactly when an order
  // actually completes — expo hand-off or a manual completion — and never on
  // the intermediate kitchen-done → ready step. All three are idempotent and
  // fire-and-forget so an accounting/invoice misconfig never blocks the pass.
  if (status === 'completed') {
    createFinancialEntry(id).catch((err) =>
      console.error(`[financial] createFinancialEntry failed for ${id}:`, (err as Error).message),
    )
    postOrderCompletion(id).catch((err) =>
      console.error(`[journal] postOrderCompletion failed for ${id}:`, (err as Error).message),
    )
    // Auto-issue tax invoice. Skipped silently if the concept hasn't been
    // configured for invoicing (missing invoiceLegalName); the operator can
    // issue manually via POST /invoices/orders/:id/issue later.
    import('../invoices/service.js')
      .then(({ issueInvoiceForOrder }) => issueInvoiceForOrder({ orderId: id }))
      .catch((err) => {
        const msg = (err as Error).message
        if (!msg.includes('CONCEPT_NOT_REGISTERED')) {
          console.error(`[invoice] auto-issue failed for ${id}:`, msg)
        }
      })
  }

  // Notify customer on key status transitions
  if (['preparing', 'ready', 'completed', 'cancelled', 'rejected'].includes(status)) {
    notifyStatusChange(id, status).catch((err) =>
      console.error(`[Notify] Status update failed for ${id}:`, (err as Error).message),
    )
  }

  // Journal posting on terminal status transitions. Refund, cancellation and
  // rejection all reverse the original completion entry (idempotent — replays
  // are safe) and give back what the customer spent at checkout: wallet,
  // gift-card balance, earned points. A rejected order is a cancelled one the
  // kitchen declined at intake — it kept the customer's money before this.
  // Posting errors are logged but never block the status update.
  if (status === 'refunded' || isCancel) {
    postOrderRefund(id, `Order ${status}`).catch((err) =>
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
// gift card, points earned on it), the promo release and an audit entry.

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

  // All dishes done → hand the order up to expo's "ready" queue. Expo owns the
  // final hand-off (serve / dispatch / pickup) via POST /expo/orders/:id/handoff,
  // and that completion is where the financial entry, journal, and tax invoice
  // fire (see updateOrderStatus). The kitchen path must NOT complete the order
  // itself: that skips expo's sign-off, and because the state machine only
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

// ─── Financial entry on completion ───────────────────────────────────────────

async function createFinancialEntry(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { concept: true, payments: true },
  })
  if (!order || order.source === 'pos') return // POS handles its own via shift close

  // B03: the unique index on (orderId) is the real guard now; this read-check
  // is just a cheap fast-path to skip the round trip when we already have an
  // entry. The catch block below handles the genuine race.
  const existing = await prisma.financialEntry.findUnique({ where: { orderId } })
  if (existing) return

  // No third-party commission — servd is operator-direct only. The
  // financial entry still records a commission line for schema parity
  // with legacy historical rows, but the rate is always zero.
  const commissionCents = 0

  try {
    await prisma.financialEntry.create({
      data: {
        orderId: order.id,
        conceptId: order.conceptId,
        locationId: order.locationId,            // copied from Order — null is fine, falls under "unassigned"
        channel: order.source,
        grossCents: order.totalCents,
        commissionCents,
        discountCents: order.discountCents,
        taxCents: order.taxCents,
        netCents: order.totalCents - commissionCents - order.discountCents,
      },
    })
  } catch (err) {
    // Another concurrent request already created the entry — ignore
    const prismaErr = err as Prisma.PrismaClientKnownRequestError
    if (prismaErr.code !== 'P2002') throw err
  }
}
