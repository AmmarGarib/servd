import { prisma } from '../../lib/prisma.js'
import { emitOrderNew, emitOrderUpdated, emitItemUpdated, emitItem86d } from '../../lib/ws.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { sendOrderReceipt, sendOrderStatusUpdate } from '../../lib/notify.js'
import { postOrderCompletion, postOrderRefund } from '../accounting/orderPosting.js'
import type { OrderDTO } from '@servd/types'
import type { OrderStatus, ItemStatus, Prisma } from '@prisma/client'

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
        select: { id: true, stationId: true },
      })
    : []
  const stationMap = new Map(menuItemStations.map((m) => [m.id, m.stationId]))

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

  // conceptIds (from staff scoping) constrains the result set; conceptId
  // (explicit filter) further narrows within that set.
  const conceptFilter: Record<string, unknown> | undefined =
    filter.conceptId
      ? { conceptId: filter.conceptId }
      : filter.conceptIds && filter.conceptIds.length > 0
        ? { conceptId: { in: filter.conceptIds } }
        : undefined

  const orders = await prisma.order.findMany({
    where: {
      deletedAt: null,
      ...conceptFilter,
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

export async function getOrder(id: string) {
  const order = await prisma.order.findFirst({
    where: { id, deletedAt: null },
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

export async function updateOrderStatus(id: string, status: OrderStatus) {
  const order = await prisma.order.findFirst({ where: { id, deletedAt: null } })
  if (!order) throw new NotFoundError('Order', id)

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

  // Conditional update so two parallel writers don't both succeed. Whoever
  // gets through second sees count===0 and we no-op without re-firing side
  // effects (still emit the WS event — same end-state, idempotent).
  const result = await prisma.order.updateMany({
    where: { id, status: order.status },
    data: {
      status,
      ...(status === 'completed' && { completedAt: new Date() }),
    },
  })
  if (result.count === 0) {
    // Lost the race; the other writer already moved us to (or past) this
    // status. Treat as success but skip the side-effect cascade.
    emitOrderUpdated(id, status)
    const refreshed = await prisma.order.findUnique({ where: { id } })
    return refreshed!
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
    const pointsToEarn = Math.floor(order.totalCents / 100)
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
  if (['preparing', 'ready', 'completed', 'cancelled'].includes(status)) {
    notifyStatusChange(id, status).catch((err) =>
      console.error(`[Notify] Status update failed for ${id}:`, (err as Error).message),
    )
  }

  // Journal posting on terminal status transitions. Refund and cancellation
  // both reverse the original completion entry (idempotent — replays are
  // safe). Posting errors are logged but never block the status update.
  if (status === 'refunded' || status === 'cancelled') {
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

  return updated
}

// ─── Update order item status (KDS interactions) ──────────────────────────────

export async function updateItemStatus(itemId: string, status: ItemStatus, staffId?: string) {
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
      ...(status === 'voided' && { voidedAt: new Date(), voidReason: 'staff void' }),
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
