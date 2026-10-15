import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { emitOrderNew, emitOrderUpdated, emitItemUpdated } from '../../lib/ws.js'
import { AppError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { sendOrderReceipt, sendOrderStatusUpdate } from '../../lib/notify.js'
import { postOrderCompletion, postOrderRefund } from '../accounting/orderPosting.js'
import type { OrderDTO } from '@servd/types'
import { Prisma } from '@prisma/client'
import type { OrderStatus, ItemStatus } from '@prisma/client'
import { tenantIdOfConcept } from '../../lib/webhook-events.js'
import { consumptionForSoldLines } from '../../lib/recipeCost.js'
import {
  AUTO_86, bookRemakeWaste, deductInventoryForOrder, ensureOrderDepleted, flagOrderStockFailure, lockOrderForStock,
  restoreInventoryForOrder,
} from './stock.js'
import type { OrderPrice } from '../../lib/pricing.js'
import { generateDeliveryOtp } from '../../lib/deliveryOtp.js'
import { courseOf, isLiveLine, isFireable, fireOrderItems } from '../expo/fire.js'
import type { FiscalView } from '../../connectors/fiscal/view.js'
import { withSavepoint } from '../../lib/savepoint.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'

// ─── Inventory (recipe-driven, FIFO lots) ────────────────────────────────────
//
// The depletion, the cancel's give-back, the unfired void's return, "Box
// given" and the KDS remake waste live in ./stock.ts (finance wave B: FIFO
// lots). Re-exported here so existing importers keep working.

export {
  deductInventoryForOrder, restoreInventoryForOrder, ensureOrderDepleted, returnVoidedLineStockTx, markBoxGiven,
} from './stock.js'

const NO_SALE: string[] = ['cancelled', 'rejected']
/** An order that ended without food going out — no kitchen work (hold, recall, firing) applies to it. */
const ENDED_NO_SALE: OrderStatus[] = ['cancelled', 'rejected', 'refunded']

export interface BackInStockItem {
  menuItemId: string
  name: string
  conceptId: string
  conceptName: string
  eightySixedAt: Date
}

/**
 * Dishes the stock auto-86'd that could be cooked again now: still switched
 * off, auto-86'd in the last 30 days with nobody switching them on or off
 * since (standingAutoEightySix), and every ingredient of their recipe
 * (sub-recipes exploded, in purchase units — THE explosion the depletion uses)
 * is in stock for at least one portion. A suggestion list for a manager's
 * one-tap "back on" (PATCH /menu/items/:id/availability); never acted on
 * automatically. `conceptIds` is the caller's company scope — required, an
 * empty list returns nothing.
 */
/** A manual availability change (PATCH /menu/items/:id/availability), when the menu route records one. */
const MANUAL_AVAILABILITY = 'menu.availability'
/**
 * Of these switched-off menu items, the ones whose LATEST availability change
 * is still the stock's auto-86 (in the last 30 days) — id → when. A dish a
 * person switched on or off after the auto-86 is not here: the chef's own 86
 * stands on top of it (R6). A manual toggle is seen two ways: a
 * 'menu.availability' audit row after the auto-86 (written by the menu route
 * once it records toggles), or the item's updatedAt no longer being the one
 * the auto-86 left on it (recorded in its audit row as itemUpdatedAt; rows
 * without it fall back to "not updated after the row was written"). Any
 * other edit after the auto-86 (a price change) also hides it — the safe
 * direction: a person has touched the dish.
 */
export async function standingAutoEightySix(
  items: Array<{ id: string; updatedAt: Date }>,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>()
  if (items.length === 0) return out
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: [AUTO_86, MANUAL_AVAILABILITY] }, entity: 'MenuItem', entityId: { in: items.map((m) => m.id) },
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 3_600_000) },
    },
    select: { entityId: true, action: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  })
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (r.entityId && !latest.has(r.entityId)) latest.set(r.entityId, r)
  for (const m of items) {
    const last = latest.get(m.id)
    if (!last || last.action !== AUTO_86) continue
    const left = (last.metadata as { itemUpdatedAt?: string | null } | null)?.itemUpdatedAt
    const untouchedSince = left ? Date.parse(left) : last.createdAt.getTime()
    if (m.updatedAt.getTime() > untouchedSince) continue
    out.set(m.id, last.createdAt)
  }
  return out
}

export async function listAutoEightySixedBackInStock(conceptIds: string[]): Promise<BackInStockItem[]> {
  if (conceptIds.length === 0) return []
  const off = await prisma.menuItem.findMany({
    where: { conceptId: { in: conceptIds }, isAvailable: false, deletedAt: null },
    select: { id: true, name: true, conceptId: true, updatedAt: true, concept: { select: { name: true, tenantId: true } } },
  })
  if (off.length === 0) return []
  const lastAuto = await standingAutoEightySix(off)

  const out: BackInStockItem[] = []
  for (const m of off) {
    const at = lastAuto.get(m.id)
    if (!at || !m.concept.tenantId) continue
    // One plated portion (dine-in, never boxed): what cooking it again needs, in the dish's own company.
    const { need } = await consumptionForSoldLines(
      [{ menuItemId: m.id, quantity: 1, status: 'pending', serviceVessel: 'plate', boxGiven: false }],
      prisma, { tenantId: m.concept.tenantId, fulfilmentType: 'dine_in', serviceVessel: 'plate' },
    )
    if (need.size === 0) continue
    const stock = await prisma.inventoryItem.findMany({
      where: { id: { in: [...need.keys()] } },
      select: { id: true, currentStock: true },
    })
    const have = new Map(stock.map((s) => [s.id, Number(s.currentStock)]))
    const enough = [...need.entries()].every(([id, r]) => (have.get(id) ?? 0) > 0 && (have.get(id) ?? 0) + 1e-9 >= r.qty)
    if (enough) out.push({ menuItemId: m.id, name: m.name, conceptId: m.conceptId, conceptName: m.concept.name, eightySixedAt: at })
  }
  return out.sort((a, b) => b.eightySixedAt.getTime() - a.eightySixedAt.getTime())
}

// ─── Ingest canonical OrderDTO ────────────────────────────────────────────────

/**
 * The order DTO ingestOrder takes. `tip_cents` (optional, backward compatible)
 * is the part of payment.amountCents that is a tip — written to Order.tipCents
 * in the same insert as the total. (Belongs on OrderDTO in @servd/types.)
 */
export type IngestOrderDTO = OrderDTO & { tip_cents?: number }

/** The DB's OrderSource enum. A DTO with anything else fails here, not as a Prisma error mid-transaction. */
const ORDER_SOURCES: ReadonlyArray<OrderDTO['source']> = ['servd', 'pos', 'cart', 'manual']

// A key that is nothing but a clock reading ("pos-1760102400123" — what the
// till mints when the caller sent no idempotencyKey) is not an idempotency
// key: two waiters ringing up in the same millisecond share it. Deduping on
// it handed the second waiter the first one's order (across companies) and
// dropped the second order's items before they reached the kitchen (FOH-06).
// Such an order is created with a fresh UUID key instead. Real client keys
// are `pos-<uuid>` (or `pos-<ms>-<random>`), storefront `direct-<uuid>`,
// group orders `group-<shareCode>` — none of them match.
const CLOCK_ONLY_KEY = /^pos-\d{10,14}$/

function idempotencyKeyOf(dto: OrderDTO): string | null {
  const key = dto.external_id?.trim()
  if (!key || CLOCK_ONLY_KEY.test(key)) return null
  return key
}

/**
 * A dedupe hit is only a retry if it is the same request: the same brand (so
 * the same company) and the same till operator. Anything else is a different
 * order that happens to carry the same key — 409, never the other order.
 */
function assertSameRequest(existing: { conceptId: string; posStaffId: string | null }, dto: OrderDTO): void {
  if (existing.conceptId !== dto.concept_id || (existing.posStaffId ?? null) !== (dto.pos_staff_id ?? null)) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This order key was already used for a different order. Send the order again with a new key.',
      409,
    )
  }
}

/**
 * The brand's expo / pass station (an active station named "Expo" or "Pass"),
 * where a ticket whose own station is retired is sent so somebody sees it.
 * Null when the brand has none — the ticket then stays unrouted for expo.
 */
async function passStationOf(conceptId: string): Promise<string | null> {
  const stations = await prisma.station.findMany({
    where: {
      conceptId, isActive: true, deletedAt: null,
      OR: [{ name: { contains: 'expo', mode: 'insensitive' } }, { name: { contains: 'pass', mode: 'insensitive' } }],
    },
    select: { id: true, name: true },
    orderBy: { displayOrder: 'asc' },
  })
  return stations.find((s) => /\b(expo|pass)\b/i.test(s.name))?.id ?? null
}

/**
 * Create an order — the one door every channel comes through. `price` is the
 * channel's priceOrder() result (lib/pricing.ts): its GST, rate, staff
 * discount and service charge are written on the order as it is created, so
 * the ticket fires with the bill the customer is charged. `totalCents` is
 * always dto.payment.amountCents — the caller's figure after customer credits.
 */
export async function ingestOrder(dto: IngestOrderDTO, opts: { price?: OrderPrice } = {}) {
  if (!ORDER_SOURCES.includes(dto.source)) {
    throw new AppError('UNKNOWN_ORDER_SOURCE', `Unknown order source '${String(dto.source)}'`, 422)
  }
  // The tip's own column, written in the same insert as the total it is part
  // of (F1) — the storefront used to patch it in a second write right after.
  // The tip is inside what the customer pays — the tender plus any wallet
  // share — never on top of it.
  const tipCents = dto.tip_cents ?? 0
  const tipCeiling = dto.payment.amountCents + Math.max(0, dto.wallet_amount_cents ?? 0)
  if (!Number.isInteger(tipCents) || tipCents < 0 || tipCents > tipCeiling) {
    throw new AppError('INVALID_TIP', 'The tip must be a whole amount between zero and the order total.', 422)
  }
  // Idempotency: deduplicate by source + external_id — but only a real
  // idempotency key, and only for the same request (FOH-06). See
  // idempotencyKeyOf / assertSameRequest.
  const externalId = idempotencyKeyOf(dto)
  if (externalId) {
    const existing = await prisma.order.findUnique({
      where: { source_externalId: { source: dto.source, externalId } },
    })
    if (existing) {
      assertSameRequest(existing, dto)
      return { order: existing, created: false }
    }
  }

  // Pre-fetch all station mappings in one query to avoid N+1 inside the transaction
  const menuItemIds = dto.items.map((i) => i.menuItemId).filter(Boolean) as string[]
  const menuItemStations = menuItemIds.length > 0
    ? await prisma.menuItem.findMany({
        where: { id: { in: menuItemIds } },
        select: {
          id: true, conceptId: true, stationId: true, priceCents: true, name: true,
          isAvailable: true, deletedAt: true, updatedAt: true,
        },
      })
    : []
  const routedStationIds = [...new Set(menuItemStations.map((m) => m.stationId).filter((s): s is string => !!s))]
  const routedStations = new Map((routedStationIds.length > 0
    ? await prisma.station.findMany({
        where: { id: { in: routedStationIds } },
        select: { id: true, conceptId: true, isActive: true, deletedAt: true },
      })
    : []).map((s) => [s.id, s]))

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

  // 86'd / deleted items are refused on EVERY channel (BOH-10). The storefront
  // already refused them, but the till checked only brand + not-deleted, so a
  // till holding a menu loaded before the 86 (or an offline-queue resend)
  // sold food the kitchen had run out of and the depletion clamped at zero.
  // A retry of an order created before the 86 never gets here — it is
  // answered by the idempotency check above.
  //
  // The till is the one exception, and only for the STOCK's 86 (R2): a dish
  // the depletion switched off because the counted stock ran out is still
  // sold at the till — the cashier has the food in front of them, a sale
  // queued offline has already been handed over and paid, and the counted
  // stock is often behind reality on day one. It is logged and the stock
  // clamps at zero, as before BOH-10. A chef's (or manager's) own 86 — or
  // any change a person made after the auto-86 — is refused everywhere, the
  // till included; so is a deleted dish. The storefront, group orders and
  // WhatsApp refuse every 86.
  const off = menuItemStations.filter((m) => !m.isAvailable || m.deletedAt !== null)
  if (off.length > 0) {
    const tillOverride = dto.source === 'pos'
      ? await standingAutoEightySix(off.filter((m) => m.deletedAt === null))
      : new Map<string, Date>()
    const refused = off.find((m) => !tillOverride.has(m.id))
    if (refused) {
      throw new AppError('ITEM_UNAVAILABLE', `"${refused.name}" is not available right now (86'd).`, 409)
    }
    console.warn(`[auto-86] till sold ${off.map((m) => `"${m.name}"`).join(', ')} while the stock count says it ran out — recount the ingredients.`)
  }

  // Routing (BOH-03): a ticket goes to the item's station only while that
  // station is live — not soft-deleted, not switched off, and the brand's
  // own. A retired station is on no screen (my-stations and the expo station
  // list filter it out), so a ticket routed there was cooked by nobody and
  // expo's fire reported nothing. Those items go to the brand's expo / pass
  // station when it has one, otherwise they stay unrouted (stationId null):
  // expo's fire lists them as unroutedItems and GET /kds/unrouted shows them
  // on the kitchen dashboard with a bump button.
  const isLive = (stationId: string | null) => {
    const s = stationId ? routedStations.get(stationId) : undefined
    return !!s && s.isActive && s.deletedAt === null && s.conceptId === dto.concept_id
  }
  // Only a station that EXISTED and is retired falls back (R5). A menu item
  // with no station at all keeps stationId null: it is either step-routed
  // (its recipe's service steps put it on Fry / Assembly when it is fired —
  // parked on the pass before that, the pass cook could bump it pending →
  // bumped, the fire then skipped it and no station ever cooked it) or it has
  // nothing to cook (a bottled drink, a market chiller item). Custom lines
  // (no menu item) have no routing of their own, so they do fall back.
  const retired = (m: { stationId: string | null }) => !!m.stationId && !isLive(m.stationId)
  const needsFallback = menuItemStations.some(retired) || dto.items.some((i) => !i.menuItemId)
  const fallbackStationId = needsFallback ? await passStationOf(dto.concept_id) : null
  const stationMap = new Map(menuItemStations.map((m) => [m.id, retired(m) ? fallbackStationId : m.stationId]))
  const dead = menuItemStations.filter(retired)
  if (dead.length > 0) {
    console.warn(`[routing] ${dead.map((m) => `"${m.name}"`).join(', ')} routed to a retired station — sent to ${fallbackStationId ? `pass station ${fallbackStationId}` : 'unrouted (expo)'} instead. Fix the routing in /menu.`)
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

  // The brand's service vessel at ring-up, snapshotted on every line (owner's
  // FINAL packaging rule): a later change of the brand's vessel never restates
  // a line already rung up (lib/recipeCost.ts packagingApplies).
  const brand = await prisma.concept.findUnique({ where: { id: dto.concept_id }, select: { serviceVessel: true } })
  const serviceVessel = brand?.serviceVessel === 'packaging' ? 'packaging' : 'plate'
  // An add-on's id is kept only when it is one of THIS dish's live modifier
  // groups' modifiers (its modifier recipe is what the sale consumes); any
  // other id — another dish's, another brand's or company's, a deleted
  // group's — is stored as null (the name and price still ride on the line).
  const sentModifierIds = [...new Set(dto.items.flatMap((i) => (i.modifiers ?? []).map((m) => m.modifierId).filter((x): x is string => !!x)))]
  const modifierDish = new Map((sentModifierIds.length > 0
    ? await prisma.modifier.findMany({
        where: { id: { in: sentModifierIds }, group: { deletedAt: null } },
        select: { id: true, group: { select: { menuItemId: true } } },
      })
    : []).map((m) => [m.id, m.group.menuItemId]))
  const modifierIdFor = (menuItemId: string | null | undefined, modifierId: string | null | undefined): string | null =>
    modifierId && menuItemId && modifierDish.get(modifierId) === menuItemId ? modifierId : null

  async function runTransaction() {
    return prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          conceptId: dto.concept_id,
          source: dto.source,
          fulfilmentType,
          // The caller's idempotency key, or — when it sent none (or only a
          // clock reading) — a fresh collision-free one of our own.
          externalId: externalId ?? `${dto.source}-${randomUUID()}`,
          status: 'received',
          customerId: dto.customer_id,
          customerName: dto.customer_name,
          tableId: dto.table_id ?? null,
          posStaffId: dto.pos_staff_id ?? null,
          shiftId: dto.shift_id ?? null,
          totalCents: dto.payment.amountCents,
          tipCents,
          // GST. Every storefront order charges it — it is folded into the
          // total the customer pays — but it was never written to the order,
          // so Order.taxCents sat at its default of 0 for the entire history.
          // The fiscal POS document reads this field, and so does the sales-tax
          // return, which means GST collected was being filed as zero.
          taxCents: opts.price?.taxCents ?? dto.tax_cents ?? 0,
          // The standard GST rate this order was priced at (tender rate,
          // decision 9) — what the receipt, tax invoice and the fiscal POS document read.
          // Null only for a channel that does not price through lib/pricing.
          taxRatePct: opts.price?.taxRatePct ?? null,
          ...(opts.price && {
            discountCents: opts.price.discountCents,
            serviceChargeCents: opts.price.serviceChargeCents,
            // The delivery fee and its GST, added on top (owner, 2026-10-13; H9) —
            // inside taxCents above, stored apart so receipts, the fiscal
            // payload and the sales-tax return can show them.
            deliveryFeeCents: opts.price.deliveryFeeCents,
            deliveryFeeTaxCents: opts.price.deliveryFeeTaxCents,
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
              stationId: item.menuItemId ? (stationMap.get(item.menuItemId) ?? null) : fallbackStationId,
              externalItemId: item.externalItemId,
              name: item.name,
              quantity: item.quantity,
              unitPriceCents: item.unitPriceCents,
              status: 'pending' as ItemStatus,
              notes: item.notes ?? null,
              course: item.course ?? null,
              serviceVessel,
              modifiers: {
                create: item.modifiers.map((mod) => ({
                  modifierId: modifierIdFor(item.menuItemId, mod.modifierId),
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
    // A concurrent request with the same key already created this order —
    // return it, but only if it IS the same request (same brand, same
    // staff). A different caller that happens to hold the same key gets a
    // 409, never someone else's order (FOH-06).
    const prismaErr = err as Prisma.PrismaClientKnownRequestError
    if (prismaErr.code === 'P2002' && externalId) {
      const existing = await prisma.order.findUnique({
        where: { source_externalId: { source: dto.source, externalId } },
      })
      if (existing) {
        assertSameRequest(existing, dto)
        return { order: existing, created: false }
      }
    }
    throw err
  }

  const orderId = txResult.order.id
  // A pre-order for later than the prep window (O-RV-3) is HELD: the kitchen
  // is not told and its stock is not taken until the pre-order release worker
  // (workers/preOrderRelease.ts → releaseDuePreOrders) lets it through at
  // scheduledFor − PRE_ORDER_PREP_MS. Tomorrow's ticket used to land on the
  // KDS straight away and drain today's stock (and auto-86 today's menu).
  if (heldAtCreation(txResult.order)) {
    console.log(`[pre-order] order ${orderId.slice(0, 8)} held until ${new Date(txResult.order.scheduledFor!.getTime() - PRE_ORDER_PREP_MS).toISOString()}`)
  } else {
    // Emit WebSocket event to KDS
    emitOrderNew({
      orderId,
      conceptId: txResult.order.conceptId,
      source: txResult.order.source,
      stationIds: txResult.stationIds,
      placedAt: txResult.order.placedAt.toISOString(),
    })
    // Fire-and-forget: deduct inventory (a failure is flagged, never only logged)
    deductInventoryForOrder(orderId).catch((err) => flagOrderStockFailure(orderId, 'deplete', err))
  }

  // Fire-and-forget: notify customer + schedule course pacing (the customer's
  // receipt goes out for a pre-order too; pacing is re-anchored when expo
  // fires it, so a creation-time schedule never fires a held order).
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

// ─── Pre-orders (O-RV-3) ──────────────────────────────────────────────────────
// A pre-order (scheduledFor in the future) stays off the kitchen until its
// prep window opens: PRE_ORDER_PREP_MS before its time. Until then
//   - expo's awaiting-fire / in-progress columns, the station queues, the KDS
//     unrouted list and station loads leave it out (kitchenDueWhere) — expo
//     sees it under `upcoming` with its time;
//   - rider dispatch does not offer it (workers/riderDispatch.ts);
//   - the pacing worker does not fire it, even if staff acknowledged it;
//   - ingestOrder neither emits order:new nor takes its stock.
// releaseDuePreOrders (the preOrderRelease worker, per company, every minute)
// then emits order:new and deducts the stock, exactly once per order: the
// claim is a PRE_ORDER_RELEASE audit row written under the order's row lock.
// Expo firing a held pre-order early releases it on the spot, and so does any
// status change that takes it into the kitchen or past it before its window
// (transitionOrder → 'preparing' / 'ready' / 'refunded') and its completion
// (completeOrder, before the sale's COGS posts) — OK2-RV-1: a pre-order
// handed over early through the status buttons used to keep its stock while
// the ledger booked its cost. Acknowledging it ('confirmed') does not release
// it: it stays held until its window. A release after the kitchen is done
// (ready / completed / refunded) takes the stock but sends no order:new.
//
// "Held" is decided from the stored row — scheduledFor later than createdAt +
// the window — so ingestOrder's decision and the worker's query agree; an
// order placed inside the window (or with no scheduledFor) was never held and
// is never "released" a second time.

/** How long before a pre-order's time it reaches the kitchen (and dispatch). */
export const PRE_ORDER_PREP_MS = 60 * 60_000
/** A held pre-order whose time passed longer ago than this is no longer released (the auto-cancel sweep has it by then). */
const PRE_ORDER_RELEASE_LOOKBACK_MS = 24 * 60 * 60_000
/** Audit marker: this held pre-order was released to the kitchen. */
export const PRE_ORDER_RELEASE = 'order.pre_order_released'

/** The order was held at creation: its time was beyond the prep window when it was placed. */
export function heldAtCreation(o: { scheduledFor: Date | null; createdAt: Date }): boolean {
  return !!o.scheduledFor && o.scheduledFor.getTime() > o.createdAt.getTime() + PRE_ORDER_PREP_MS
}

/**
 * `where` fragment: an order the kitchen should see now — no scheduled time,
 * or one inside the prep window.
 */
export function kitchenDueWhere(now: Date = new Date()): Prisma.OrderWhereInput {
  return { OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date(now.getTime() + PRE_ORDER_PREP_MS) } }] }
}

/** Order statuses in which a released pre-order still has its kitchen ahead of it (order:new is worth sending). */
const KITCHEN_AHEAD: string[] = ['received', 'confirmed', 'preparing']

/**
 * Release one held pre-order: order:new to its company's rooms and stations
 * (only while its kitchen work is still ahead — never for an order already
 * ready, completed or refunded), then its stock deduction. Idempotent —
 * returns false for an order that was never held, was cancelled / rejected,
 * or was released already. `via` says who released it: the worker at the
 * window, expo / fire-course firing it early, a status change that moved it
 * on before its window (OK2-RV-1: 'preparing', 'ready', 'refunded'), or its
 * completion (completeOrder — the stock leaves no later than its COGS).
 * A refunded order IS released: the food was made, so the depletion stays
 * (same rule as deductInventoryForOrder's NO_SALE).
 */
/**
 * When a pre-order is still held off the kitchen, the time it is due there
 * (scheduledFor − PRE_ORDER_PREP_MS); null once it is due, released, or was
 * never held. Sending a held pre-order to the kitchen early (expo Fire,
 * fire-course) takes its stock days ahead, so only a manager or the
 * expediter may (the routes check the role).
 */
export async function preOrderHeldUntil(orderId: string, now = new Date()): Promise<Date | null> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { scheduledFor: true, createdAt: true } })
  if (!o || !heldAtCreation(o)) return null
  const kitchenAt = new Date(o.scheduledFor!.getTime() - PRE_ORDER_PREP_MS)
  if (kitchenAt.getTime() <= now.getTime()) return null
  const released = await prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: PRE_ORDER_RELEASE }, select: { id: true } })
  return released ? null : kitchenAt
}

/** The refusal for sending a held pre-order to the kitchen early without the role. */
export function preOrderHeldError(kitchenAt: Date): AppError {
  const t = kitchenAt.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
  return new AppError('PRE_ORDER_HELD', `This pre-order reaches the kitchen at ${t}. Only a manager or the expediter can send it early.`, 403)
}

export async function releasePreOrder(
  orderId: string,
  via: 'worker' | 'expo_fire' | 'fire_course' | 'status' | 'completion',
): Promise<boolean> {
  // Cheap pre-check outside the lock: most orders were never held.
  const pre = await prisma.order.findUnique({ where: { id: orderId }, select: { scheduledFor: true, createdAt: true } })
  if (!pre || !heldAtCreation(pre)) return false
  const claimed = await prisma.$transaction(async (tx) => {
    const locked = await lockOrderForStock(tx, orderId)
    if (!locked || NO_SALE.includes(locked.status)) return null
    const o = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, conceptId: true, source: true, placedAt: true, scheduledFor: true, createdAt: true, deletedAt: true },
    })
    if (!o || o.deletedAt || !heldAtCreation(o)) return null
    const done = await tx.auditLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: PRE_ORDER_RELEASE },
      select: { id: true },
    })
    if (done) return null
    await tx.auditLog.create({
      data: {
        category: 'system',
        tenantId: locked.tenantId,
        action: PRE_ORDER_RELEASE,
        entity: 'Order',
        entityId: orderId,
        metadata: { via, scheduledFor: o.scheduledFor!.toISOString(), status: locked.status },
      },
    })
    return { ...o, status: locked.status }
  })
  if (!claimed) return false

  if (KITCHEN_AHEAD.includes(claimed.status)) {
    const stations = await prisma.orderItem.findMany({
      where: { orderId, stationId: { not: null }, status: { not: 'voided' }, voidedAt: null },
      select: { stationId: true },
    })
    emitOrderNew({
      orderId,
      conceptId: claimed.conceptId,
      source: claimed.source,
      stationIds: [...new Set(stations.map((s) => s.stationId!))],
      placedAt: claimed.placedAt.toISOString(),
    })
  }
  try {
    await deductInventoryForOrder(orderId)
  } catch (err) {
    await flagOrderStockFailure(orderId, 'deplete', err)
  }
  return true
}

/**
 * Release one company's pre-orders whose prep window has opened. Returns the
 * ids released. Safe to run on several processes at once (releasePreOrder
 * claims each order under its row lock).
 */
export async function releaseDuePreOrders(tenantId: string, now: Date = new Date()): Promise<string[]> {
  const horizon = new Date(now.getTime() + PRE_ORDER_PREP_MS)
  const lookback = new Date(now.getTime() - PRE_ORDER_RELEASE_LOOKBACK_MS)
  const prepMinutes = PRE_ORDER_PREP_MS / 60_000
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT o.id FROM orders o JOIN concepts c ON c.id = o."conceptId"
    WHERE c."tenantId" = ${tenantId}
      AND o."deletedAt" IS NULL
      -- Only no-sale ends are skipped (OK2-RV-1): a refunded order was made,
      -- so its stock must still come out (the NO_SALE rule of deductInventoryForOrder).
      AND o.status::text NOT IN ('cancelled', 'rejected')
      AND o."scheduledFor" IS NOT NULL
      AND o."scheduledFor" <= ${horizon}
      AND o."scheduledFor" >= ${lookback}
      AND o."scheduledFor" > o."createdAt" + interval '1 minute' * ${prepMinutes}::float8
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs a
        WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = ${PRE_ORDER_RELEASE}
      )
    ORDER BY o."scheduledFor" ASC
    LIMIT 200
  `
  const released: string[] = []
  for (const r of rows) {
    try {
      if (await releasePreOrder(r.id, 'worker')) released.push(r.id)
    } catch (err) {
      console.error(`[pre-order] release failed for ${r.id}:`, (err as Error).message)
    }
  }
  return released
}

// ─── Course pacing ────────────────────────────────────────────────────────────
// Compute when each item of the order's FIRST course should auto-fire so that
// course plates together. Anchor: "now" + max(laborMinutes) within the course.
// The longest item fires immediately; shorter ones are delayed by
// (maxLabor - itemLabor) so they finish in sync.
//
// Courses (BOH-06). Pacing never crosses a course boundary: only the order's
// first course (the lowest course of its live lines) is ever scheduled. Later
// courses keep scheduledFireAt null and wait for expo's "Fire course"
// (POST /orders/:id/fire-course) — a main must never start before its
// starter. An item with no course is course 1 (expo/fire.ts courseOf).
//
// When. The schedule is (re)anchored when the order is fired out of
// 'received' (transitionOrder), and laid down at creation for a till sale that
// is paid — and so completed — without passing through expo. The worker never
// fires anything on an order that is still 'received' (expo has not fired it)
// or has ended without a sale.
//
// Firing. The worker, "Fire course" and expo's "Confirm & Fire" all go through
// ONE engine, expo/fire.ts fireOrderItems: it claims only pending, never-voided
// lines, lays out a step-routed dish's recipe steps on their stations and
// emits item:updated per line to the station room and the company's order
// room (BOH-16). A dish that routes only through recipe steps used to reach
// no screen when fired from here.

/** Order statuses whose paced items the worker may fire: the order has been fired / sent. */
const PACING_FIRED: OrderStatus[] = ['confirmed', 'preparing', 'ready', 'completed']

export async function scheduleCoursePacing(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      items: { select: { id: true, menuItemId: true, course: true, status: true, voidedAt: true } },
    },
  })
  if (!order) return
  const live = order.items.filter(isLiveLine)
  if (live.length === 0) return
  // The order's first course — not "the lowest course still pending": once
  // expo has fired course 1, course 2 must not become the paced course.
  const firstCourse = Math.min(...live.map(courseOf))
  // Later courses never carry a fire time (R7): rows paced before pacing
  // learned about courses had one on every course; clear it whenever the
  // schedule is (re)laid so "Fire course" is the only thing that fires them.
  const later = live.filter((i) => isFireable(i) && courseOf(i) > firstCourse).map((i) => i.id)
  if (later.length > 0) {
    await prisma.orderItem.updateMany({
      where: { id: { in: later }, status: 'pending', scheduledFireAt: { not: null } },
      data: { scheduledFireAt: null },
    })
  }
  const course = live.filter((i) => isFireable(i) && courseOf(i) === firstCourse && i.menuItemId)
  if (course.length < 2) return  // a single item doesn't need pacing

  const menuItemIds = course.map((i) => i.menuItemId).filter((x): x is string => !!x)
  const recipes = await prisma.recipe.findMany({
    where: { menuItemId: { in: menuItemIds } },
    select: { menuItemId: true, laborMinutes: true },
  })
  const laborMap = new Map(recipes.map((r) => [r.menuItemId, r.laborMinutes]))

  // Items without a recipe assume 0 minutes (instant — like drinks)
  const itemLabors = course.map((i) => ({
    id: i.id,
    labor: laborMap.get(i.menuItemId!) ?? 0,
  }))
  const maxLabor = Math.max(...itemLabors.map((i) => i.labor))
  if (maxLabor === 0) return  // nothing has a labor time; let kitchen fire manually

  const now = Date.now()
  // Conditional on 'pending': an item a cook has already started keeps its state.
  await prisma.$transaction(
    itemLabors.map(({ id, labor }) =>
      prisma.orderItem.updateMany({
        where: { id, status: 'pending', voidedAt: null },
        data: { scheduledFireAt: new Date(now + (maxLabor - labor) * 60_000) },
      }),
    ),
  )
}

// Worker entry point: find items past their fire time and fire them.
export async function processCoursePacingTick(): Promise<number> {
  const due = await prisma.orderItem.findMany({
    where: {
      status: 'pending',
      voidedAt: null,
      scheduledFireAt: { lte: new Date(), not: null },
      // Only orders that have been fired / sent — never one still waiting for
      // expo in 'received', never one that ended without a sale, and never a
      // pre-order before its prep window opens (O-RV-3: acknowledging
      // tomorrow's pre-order used to start cooking it on the next tick) —
      // unless the kitchen already fired part of it early (expo Fire on a held
      // pre-order): then its paced dishes follow at their own times, not hours
      // later at the window.
      order: {
        status: { in: PACING_FIRED }, deletedAt: null,
        OR: [...(kitchenDueWhere().OR as Prisma.OrderWhereInput[]), { items: { some: { firedAt: { not: null } } } }],
      },
    },
    select: { id: true, orderId: true, course: true },
    orderBy: { scheduledFireAt: 'asc' },
    take: 200,
  })
  if (due.length === 0) return 0

  // The worker paces the order's FIRST course only (its lowest live course —
  // the one scheduleCoursePacing lays out). A later-course row that still has
  // a fire time was scheduled before pacing learned about courses (orders
  // open at the deploy): it is never auto-fired — it waits for "Fire course"
  // — and its stale fire time is cleared so it stops coming back every tick
  // (and can't crowd real work out of the batch). R7.
  const live = await prisma.orderItem.findMany({
    where: { orderId: { in: [...new Set(due.map((d) => d.orderId))] }, status: { not: 'voided' }, voidedAt: null },
    select: { orderId: true, course: true, status: true, firedAt: true },
  })
  const firstCourse = new Map<string, number>()
  for (const l of live) {
    firstCourse.set(l.orderId, Math.min(firstCourse.get(l.orderId) ?? Infinity, courseOf(l)))
  }
  // Orders that reached a fired status WITHOUT transitionOrder's re-anchor
  // and whose first course has not started at all (no line of it out of
  // 'pending', none ever fired): a till sale completed at payment (its
  // schedule was laid at ring-up — paid ten minutes later, every dish of the
  // course was due in the same tick, K-RV-02), and a pre-order whose hold
  // just lifted (its schedule was laid when it was acknowledged, hours ago).
  // They are re-anchored to now before anything fires, so the longest dish
  // starts now and the rest keep their gaps. This covers every way a till
  // sale leaves 'received' (cash, card, split, group bill) without hooking
  // each payment path. An order confirmed / fired through transitionOrder was
  // re-anchored then; its times stand.
  const orderMeta = new Map((await prisma.order.findMany({
    where: { id: { in: [...new Set(due.map((d) => d.orderId))] } },
    select: { id: true, status: true, scheduledFor: true, source: true, rawPayload: true },
  })).map((o) => [o.id, o]))
  const started = new Set<string>()
  for (const l of live) {
    if (courseOf(l) === firstCourse.get(l.orderId) && (l.status !== 'pending' || l.firedAt != null)) started.add(l.orderId)
  }
  // An order whose food has already gone out without the kitchen (OK2-RV-2):
  // a non-till order handed over ('completed'), or one marked 'ready' before
  // anything of its first course started (a pre-order finished early through
  // the status buttons while its lines were held off every station). Nothing
  // of it is fired any more — its stale fire times are cleared instead. A
  // till sale is 'completed' at PAYMENT, before it is cooked (UI-05), so it
  // still fires.
  const kitchenSkipped = (orderId: string) => {
    const o = orderMeta.get(orderId)
    if (!o) return false
    if (o.status === 'completed') return !isTillSale(o)
    return o.status === 'ready' && !started.has(orderId)
  }
  const reanchor = (orderId: string) => {
    const o = orderMeta.get(orderId)
    if (!o || started.has(orderId)) return false
    // K-RV-02: a till sale paid after its creation-time schedule expired;
    // O-RV-3: a pre-order whose hold just lifted while it is still in the kitchen.
    return (o.status === 'completed' && isTillSale(o))
      || (o.scheduledFor != null && (o.status === 'confirmed' || o.status === 'preparing'))
  }
  const byOrder = new Map<string, string[]>()
  const stale: string[] = []
  for (const d of due) {
    if (courseOf(d) > (firstCourse.get(d.orderId) ?? Infinity) || kitchenSkipped(d.orderId)) { stale.push(d.id); continue }
    byOrder.set(d.orderId, [...(byOrder.get(d.orderId) ?? []), d.id])
  }
  if (stale.length > 0) {
    await prisma.orderItem.updateMany({
      where: { id: { in: stale }, status: 'pending' },
      data: { scheduledFireAt: null },
    })
  }

  let fired = 0
  for (const [orderId, dueIds] of byOrder) {
    let ids = dueIds
    if (reanchor(orderId)) {
      try {
        await scheduleCoursePacing(orderId)
        const now = new Date()
        const fresh = await prisma.orderItem.findMany({
          where: { id: { in: ids } },
          select: { id: true, scheduledFireAt: true },
        })
        ids = fresh.filter((f) => f.scheduledFireAt == null || f.scheduledFireAt.getTime() <= now.getTime()).map((f) => f.id)
      } catch (err) {
        // Not fatal: fire what the rows say is due rather than nothing.
        console.error(`[Pacing] Re-anchor failed for order ${orderId}:`, (err as Error).message)
      }
    }
    const r = await fireOrderItems(orderId, ids)
    fired += r.fired.length
  }
  return fired
}

/**
 * Fire one course of an order now (expo's "Fire course") through the one
 * firing engine (expo/fire.ts fireOrderItems): pending, never-voided lines of
 * that course go to 'preparing', step-routed dishes get their recipe steps on
 * their stations, and every station hears about it (BOH-16 — this used to be a
 * bare updateMany that told no screen and laid out no steps).
 *
 * The order's FIRST course is paced (K-RV-01), the same way expo's Fire paces
 * it: only its lines that are due (scheduledFireAt null or passed) fire; the
 * shorter dishes stay pending for the pacing worker and come back as `paced`
 * with their time. When nothing of the first course has started yet the
 * schedule is re-anchored to now first, so the longest dish is due. Firing
 * any course of an order expo has not fired yet ('received') is refused here
 * (409 FIRE_FROM_EXPO) — that is expo's Confirm & Fire — so the order never
 * ends up cooking while it still reads 'received'. `fireAll` (the caller checks the
 * role: managers and the expediter) fires every pending line of the course
 * now. Later courses are fired whole, as before.
 */
export async function fireCourse(orderId: string, course: number, opts: { fireAll?: boolean } = {}) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      status: true, scheduledFor: true,
      items: { select: { id: true, name: true, course: true, status: true, voidedAt: true, firedAt: true, scheduledFireAt: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (ENDED_NO_SALE.includes(order.status)) {
    throw new AppError('ORDER_ENDED', `Order is ${order.status} — nothing to fire.`, 409)
  }
  const live = order.items.filter(isLiveLine)
  const firstCourse = live.length > 0 ? Math.min(...live.map(courseOf)) : null
  const isFirst = course === firstCourse
  const inCourse = live.filter((i) => isFireable(i) && courseOf(i) === course)
  // ANY course of an order expo has not fired (OK2-RV-5): firing course 2 of a
  // 'received' order used to start the mains before the starters, with the
  // order still reading 'received' (and release a held pre-order on the way).
  if (order.status === 'received' && inCourse.length > 0) {
    throw new AppError('FIRE_FROM_EXPO', 'This order has not been fired yet — fire it from expo (Confirm & Fire).', 409)
  }
  // A held pre-order fired early (O-RV-3): the kitchen is told and its stock
  // taken now, once.
  if (order.scheduledFor && inCourse.length > 0) {
    await releasePreOrder(orderId, 'fire_course').catch((err) =>
      console.error(`[pre-order] release on fire-course failed for ${orderId}:`, (err as Error).message),
    )
  }

  type Paced = { id: string; name: string; scheduledFireAt: string }
  if (!isFirst || opts.fireAll) {
    const r = await fireOrderItems(orderId, inCourse.map((i) => i.id))
    return { ...r, paced: [] as Paced[] }
  }

  const courseStarted = live.some((i) => courseOf(i) === course && (i.status !== 'pending' || i.firedAt != null))
  let schedule = inCourse.map((i) => ({ id: i.id, name: i.name, scheduledFireAt: i.scheduledFireAt }))
  if (!courseStarted && inCourse.length > 0) {
    try {
      await scheduleCoursePacing(orderId)
      schedule = await prisma.orderItem.findMany({
        where: { id: { in: inCourse.map((i) => i.id) } },
        select: { id: true, name: true, scheduledFireAt: true },
      })
    } catch (err) {
      console.error(`[Pacing] Re-anchor on fire-course failed for order ${orderId}:`, (err as Error).message)
    }
  }
  const now = Date.now()
  const isDue = (at: Date | null) => at == null || at.getTime() <= now
  let dueIds = schedule.filter((s) => isDue(s.scheduledFireAt)).map((s) => s.id)
  // Safety net (same as expo's Fire): nothing due and nothing of the course
  // started means the schedule has no anchor — the earliest line(s) start now.
  if (dueIds.length === 0 && !courseStarted && schedule.length > 0) {
    const earliest = Math.min(...schedule.map((s) => s.scheduledFireAt?.getTime() ?? 0))
    dueIds = schedule.filter((s) => (s.scheduledFireAt?.getTime() ?? 0) === earliest).map((s) => s.id)
  }
  const dueSet = new Set(dueIds)
  const r = await fireOrderItems(orderId, dueIds)
  const paced: Paced[] = schedule
    .filter((s) => !dueSet.has(s.id) && s.scheduledFireAt != null)
    .sort((a, b) => a.scheduledFireAt!.getTime() - b.scheduledFireAt!.getTime())
    .map((s) => ({ id: s.id, name: s.name, scheduledFireAt: s.scheduledFireAt!.toISOString() }))
  return { ...r, paced }
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
      // A Raast QR payment carries its reconciliation state: 'provisional'
      // until a bank-statement line matches it (spec §7.6).
      payments: {
        include: {
          raastReceipt: { select: { status: true, bankRef: true, confirmedVia: true, smsConfirmedAt: true, matchedAt: true } },
        },
      },
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
    /** Cancel / reject: the MANAGER who approved it (null = the system), stamped on the order's pre-bills. */
    approverId?: string | null
    /**
     * Cancel / reject only: run inside the cancel transaction, straight after
     * the pre-bills are cancelled, and only when this call's claim changed the
     * status (the order lock is held). A throw rolls the whole cancel back.
     */
    inCancelTx?: (tx: Prisma.TransactionClient) => Promise<void>
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
  // entries, loyalty earns, fiscal filing. The state machine rejects with a
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
  const now = new Date()
  const claimStatus = (db: Prisma.TransactionClient | typeof prisma) => db.order.updateMany({
    where: { id, status: order.status },
    data: {
      status,
      ...(status === 'completed' && { completedAt: now }),
      ...(isCancel && { cancelledAt: now, cancellationReason: opts.cancellationReason ?? null }),
    },
  })
  // A cancel / reject ends the order before its full & final bill: in the
  // SAME transaction its pre-bills become 'cancelled' with the approving
  // manager (§17.1 / §17.4 — they show on Finance → Voided pre bills). Nothing
  // goes to the fiscal POS: there was no sale.
  //
  // W4-MONEY-4: a cancel / reject takes the order lock (the one every money
  // move on the order takes) and is refused while the card machine is
  // charging the bill (409 TERMINAL_CHARGE_ACTIVE) — the card would otherwise
  // be charged for an order that no longer exists. The system auto-cancel
  // sweep gets the same refusal and simply tries again on its next tick.
  const result = isCancel
    ? await prisma.$transaction(async (tx) => {
      await lockOrderForStock(tx, id)
      const { assertNoActiveTerminalChargeTx } = await import('../../connectors/terminal/guard.js')
      await assertNoActiveTerminalChargeTx(tx, id)
      const r = await claimStatus(tx)
      if (r.count > 0) {
        const { markPreBillsCancelledTx } = await import('../prebills/service.js')
        await markPreBillsCancelledTx(tx, id, opts.approverId ?? null, opts.cancellationReason ?? null, now)
        if (opts.inCancelTx) await opts.inCancelTx(tx)
      }
      return r
    }, { maxWait: 10_000, timeout: 15_000 })
    : await claimStatus(prisma)
  if (result.count === 0) {
    // Lost the race; the other writer already moved us to (or past) this
    // status. Treat as success but skip the side-effect cascade.
    emitOrderUpdated(id, status)
    const refreshed = await prisma.order.findUnique({ where: { id } })
    return { order: refreshed!, changed: false }
  }
  const updated = await prisma.order.update({ where: { id }, data: {} })   // refetch shape

  emitOrderUpdated(id, status)

  // Fired out of 'received': (re)anchor the first course's pacing to now. The
  // worker held it while expo had not fired the order (BOH-06); a schedule
  // laid at creation would otherwise have expired while it waited and fired
  // every item at once.
  if (order.status === 'received' && (status === 'confirmed' || status === 'preparing')) {
    scheduleCoursePacing(id).catch((err) =>
      console.error(`[Pacing] Failed for order ${id}:`, (err as Error).message),
    )
  }

  // A held pre-order sent to the kitchen, or finished / refunded, before its
  // window (OK2-RV-1): release it now — its stock comes out (and the kitchen
  // hears of it while cooking is still ahead). Acknowledging it ('confirmed')
  // keeps it held. Completion releases inside completeOrder, before COGS.
  // A no-op for an order never held or already released.
  if (order.scheduledFor && (status === 'preparing' || status === 'ready' || status === 'refunded')) {
    await releasePreOrder(id, 'status').catch((err) =>
      console.error(`[pre-order] release on ${status} failed for ${id}:`, (err as Error).message),
    )
  }

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

  // On completion: the one completion routine — ledger, tax invoice, fiscal POS,
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
    // BOOKS-R2-01: a refused restore posting is flagged, never only logged.
    void postRefundOrFlag(id, `Order ${status}`, status === 'refunded')
    import('../invoices/service.js')
      .then(({ issueCreditNoteForOrder }) => issueCreditNoteForOrder(id, `Order ${status}`))
      .catch((err) => {
        // No invoice was issued in the first place (brand not registered for
        // invoicing) — fine to skip. Decided on the error CODE: the message of
        // a NotFoundError is "TaxInvoice '…' not found", so the old
        // msg.includes('NOT_FOUND') never matched and every such refund
        // logged a false failure (FOH-25).
        if (!isNoInvoiceToCredit(err)) {
          console.error(`[invoice] auto credit-note failed for ${id}:`, (err as Error).message)
        }
      })
    // The customer's lifetime spend, first / last order dates are computed
    // from COMPLETED orders only; a refunded sale (or a cancelled one) must
    // leave them now, not at the customer's next order (FOH-18) — they feed
    // the referral payout, the first-order welcome and the CRM segments.
    if (order.customerId) {
      import('../../lib/customerRollups.js')
        .then(({ bumpCustomerRollups }) => bumpCustomerRollups(order.customerId))
        .catch(() => {})
    }
  }

  // Refunded in full after the full & final bill: whatever part of the sale
  // no refund document returns yet (the gift-card / wallet share, which the
  // restores above give back) is returned now as one 'void:<orderId>'
  // document, so the fiscal POS sees the whole sale reversed — once
  // (idempotent on its key). Each tender refund already filed its own in
  // refundOrder's transaction. Never blocks the status change.
  if (status === 'refunded') {
    await enqueueFiscalVoidRemainder(id).catch((err) =>
      console.error(`[fiscal] COMPLIANCE: void document for refunded order ${id} failed:`, (err as Error).message),
    )
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

/**
 * The 'void:<orderId>' fiscal return of a sale refunded in full: the sale's
 * filed value less every refund document already queued for it. Nothing when
 * the refunds already cover it, or when the company has no fiscal document
 * for the order and does not report sales (§17.7).
 */
async function enqueueFiscalVoidRemainder(orderId: string): Promise<void> {
  const { enqueueFiscalRefundTx, kickFiscal } = await import('../../connectors/fiscal/outbox.js')
  const doc = await prisma.$transaction(async (tx) => {
    const row = await lockOrderForStock(tx, orderId)
    if (!row?.tenantId || row.status !== 'refunded') return null
    const docs = await tx.fiscalDocument.findMany({
      where: { orderId, tenantId: row.tenantId },
      select: { kind: true, amountCents: true },
    })
    const sale = docs.find((d) => d.kind === 'sale')
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { totalCents: true } })
    const saleTotal = sale?.amountCents ?? order.totalCents
    const returned = docs.filter((d) => d.kind === 'refund').reduce((t, d) => t + d.amountCents, 0)
    const remainder = saleTotal - returned
    if (remainder <= 0) return null
    return enqueueFiscalRefundTx(tx, {
      orderId, tenantId: row.tenantId, refundPaymentId: null, amountCents: remainder, reason: 'Order refunded in full',
    })
  }, { maxWait: 10_000, timeout: 15_000 })
  if (doc?.status === 'pending') void kickFiscal(doc.id)
}

/** issueCreditNoteForOrder found no tax invoice to credit — the order was never invoiced. */
export function isNoInvoiceToCredit(err: unknown): boolean {
  return err instanceof AppError && err.code === 'NOT_FOUND' && err.message.startsWith('TaxInvoice')
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
// cancel on /orders and /refunds, the expo reject, food a rider brought back
// (orders/returnedFood.ts) and the auto-cancel sweep — comes through here, so each one gets the state machine,
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
  /**
   * The MANAGER who approved the cancel (§17.4): the actor when they are one,
   * else the owner of the manager PIN the route verified. Null only for a
   * system cancel (the auto-cancel sweep) or a customer's own cancel online.
   * Recorded in the audit and on the order's pre-bills.
   */
  approverId?: string | null
  metadata?: Record<string, unknown>
  /**
   * Food the kitchen had already fired: wasted 'cancelled_after_fire' (it
   * never left the kitchen) — the photo, when one was taken, rides on the
   * waste logs. Unfired lines always go back into their lots. Default
   * { wasteReason: 'cancelled_after_fire' }: every cancel follows this rule,
   * A delivery the rider brought back (`returned`) wastes EVERY line as
   * 'returned_food' (wasteAll — the food left the kitchen in the bag).
   */
  cookedFood?: { wasteReason: 'cancelled_after_fire' | 'returned_food'; photoUrl?: string; wasteAll?: boolean }
  /**
   * The food came back with the rider (orders/returnedFood.ts — Emergency
   * overrides → Food came back). Inside the cancel transaction the order is
   * stamped returnedAt / returnCause and its PENDING cash (cash on delivery
   * that was never collected) becomes 'failed' with gatewayMeta.voided — no
   * posting: nothing was booked for money that never arrived. Every line is
   * then wasted 'returned_food' (cookedFood is ignored).
   */
  returned?: {
    cause: ReturnCause
    actorId: string
    /**
     * Called inside the cancel transaction once THIS call's claim stamped the
     * return (never on a replay or a lost race) with the cash on delivery it
     * voided. Its effect is only meaningful once cancelOrder resolves.
     */
    onClaimed?: (r: { codVoidedCents: number; codPaymentIds: string[] }) => void
  }
}

export const RETURN_CAUSES = ['refused', 'unreachable', 'other'] as const
export type ReturnCause = typeof RETURN_CAUSES[number]

/** The cancel guard's message (code-only delivery on — lib/deliveryRules.ts). */
export const USE_EMERGENCY_OVERRIDE_MESSAGE =
  'This delivery is out with the rider. If the food comes back, a manager logs it in Emergency overrides.'

/**
 * Is this delivery out with its rider? Ready, not delivered, a rider on it,
 * and either picked up (an app job) or handed to a rider without the app (a
 * dispatcher's assignment: rider set, never offered through the app).
 */
export function deliveryOutWithRider(o: {
  fulfilmentType: string; status: string; riderId: string | null; deliveredAt: Date | null
  pickedUpAt: Date | null; riderAssignedAt: Date | null
}): boolean {
  if (o.fulfilmentType !== 'delivery' || o.status !== 'ready' || !o.riderId || o.deliveredAt) return false
  return !!o.pickedUpAt || !o.riderAssignedAt
}

export async function cancelOrder(id: string, input: CancelOrderInput) {
  const status: CancelStatus = input.status ?? 'cancelled'
  const reason = input.reason.trim()
  if (!reason) throw new AppError('REASON_REQUIRED', 'A reason is required to cancel an order', 422)

  const before = await prisma.order.findFirst({
    where: { id, deletedAt: null },
    select: { status: true, totalCents: true, concept: { select: { tenantId: true } } },
  })
  if (!before) throw new NotFoundError('Order', id)

  const approverId = input.approverId === undefined ? (input.actor?.id ?? null) : input.approverId
  const returned = input.returned ?? null
  // Read under the order lock, inside the cancel transaction, so the guard
  // and the returned-food stamps act on the state the claim was made on.
  const inCancelTx = async (tx: Prisma.TransactionClient): Promise<void> => {
    const o = await tx.order.findUniqueOrThrow({
      where: { id },
      select: { fulfilmentType: true, riderId: true, deliveredAt: true, pickedUpAt: true, riderAssignedAt: true },
    })
    // Code-only delivery ON (per company): a delivery out with its rider is
    // not cancelled by hand — if the food comes back it is logged through
    // Emergency overrides (booked as waste, the rider accounted for). The
    // system auto-cancel (no actor) and an intake reject are exempt. OFF:
    // today's behaviour.
    if (!returned && input.actor && status !== 'rejected'
      && deliveryOutWithRider({ ...o, status: before.status })
      && await codeOnlyDelivery(tx, before.concept.tenantId)) {
      throw new AppError('USE_EMERGENCY_OVERRIDE', USE_EMERGENCY_OVERRIDE_MESSAGE, 409)
    }
    if (!returned) return
    const at = new Date()
    await tx.order.update({ where: { id }, data: { returnedAt: at, returnCause: returned.cause } })
    // The uncollected cash on delivery: claimed row by row (the order lock is
    // held) so a concurrent pay-in cannot be overwritten — only a row still
    // 'pending' moves.
    const cod = await tx.payment.findMany({
      where: { orderId: id, method: 'cash', status: 'pending' },
      select: { id: true, gatewayMeta: true, amountCents: true },
    })
    let codVoidedCents = 0
    const codPaymentIds: string[] = []
    for (const p of cod) {
      const meta = (p.gatewayMeta && typeof p.gatewayMeta === 'object' && !Array.isArray(p.gatewayMeta))
        ? (p.gatewayMeta as Prisma.JsonObject) : {}
      const claimed = await tx.payment.updateMany({
        where: { id: p.id, status: 'pending' },
        data: {
          status: 'failed',
          gatewayMeta: { ...meta, voided: { reason: 'returned_undelivered', at: at.toISOString(), by: returned.actorId } },
        },
      })
      if (claimed.count > 0) {
        codVoidedCents += p.amountCents
        codPaymentIds.push(p.id)
      }
    }
    returned.onClaimed?.({ codVoidedCents, codPaymentIds })
  }
  const { order, changed } = await transitionOrder(id, status, {
    cancellationReason: reason,
    onlyFrom: input.onlyFrom,
    approverId,
    inCancelTx,
  })

  // No sale → what the kitchen had not started goes back into its lots, and
  // what it had fired is wasted 'cancelled_after_fire' (Dr 1290 / Cr class
  // inventory in the order's company). When a drawer close already booked the
  // ticket's cost of sales, both go against cost of sales instead (Dr 12x0 /
  // Cr 50x0 for what comes back, Dr 1290 / Cr 50x0 for the waste) — see
  // orders/stock.ts. Only on the
  // call that actually made the change; the restore is itself once-only, so
  // a retry after a failure is safe. A failure is flagged, never only logged.
  if (changed) {
    try {
      await restoreInventoryForOrder(id, {
        cookedFood: returned
          ? { wasteReason: 'returned_food', wasteAll: true }
          : (input.cookedFood ?? { wasteReason: 'cancelled_after_fire' }),
        actorId: input.actor?.id ?? null,
        approverId,
      })
    } catch (err) {
      await flagOrderStockFailure(id, 'restore', err, input.actor?.id ?? null)
    }
    // Its rider (if any) is freed, with an `unassigned` job event — an order
    // that will never be delivered must not keep a rider 'busy' or on the
    // rider app's job list (docs/rider-app.md).
    const { releaseRiderFromEndedOrder } = await import('../dispatch/service.js')
    await releaseRiderFromEndedOrder(id, `order ${status}: ${reason}`).catch((err) =>
      console.error(`[dispatch] rider release failed for ${status} order ${id}:`, (err as Error).message),
    )
    // The books of a ticket that ends without a sale (LEDGER R5-B / R5-C):
    // whatever a drawer close or a pre-cancel refund already booked for it as
    // a SALE is undone now, once — a ticket refunded in full before the
    // cancel, or a till bill whose home drawer booked the sale but took no
    // money, has no hand-back that would post it. Idempotent; nothing to
    // undo → no entry. Never blocks the cancel; a refusal is flagged
    // posting_failed in the order's company and re-posted by Reconciliation →
    // Backfill unposted (the unwind is idempotent on the order).
    const { postCancelledTicketUnwind, CANCEL_UNWIND_SOURCE } = await import('../pos/service.js')
    try {
      await postCancelledTicketUnwind(id, input.actor?.id ?? 'system')
    } catch (err) {
      const { flagPostingFailed } = await import('../accounting/journal.js')
      const o = await orderBooksOf(id).catch(() => null)
      await flagPostingFailed({
        tenantId: o?.concept.tenantId ?? null,
        sourceType: CANCEL_UNWIND_SOURCE, sourceId: id,
        entityType: 'Order', entityId: id,
        reason: (err as Error).message,
        title: `A ${status} order's earlier sale booking was not undone in the ledger`,
        conceptId: o?.conceptId ?? null,
        actorId: input.actor?.id ?? null,
        amountCents: o?.totalCents ?? null,
      })
    }
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
      // The ORDER's company (its brand's) — never the operator's active one.
      tenantId: before.concept.tenantId ?? input.actor?.tenantId ?? null,
      before: { status: before.status, totalCents: before.totalCents },
      after: { status },
      metadata: { reason, approverId, ...(returned ? { returnCause: returned.cause } : {}), ...(input.metadata ?? {}) },
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

  // A Bump on a recalled line (R4): the station screens that only have a
  // Bump button (the tablet KDS) sent recalled → bumped, which the state
  // machine refuses, so a remake recalled from the admin KDS could not be
  // cleared on a tablet and its order stayed stuck in 'preparing'. Bump on a
  // remake means "the remake is done": walk it through 'preparing' (the
  // remake starting), then bump — two legal moves, each with its own effects.
  //
  // A HELD line is not walked: a hold is "don't cook this yet", and bumping
  // through it would defeat it on a screen that can't show the hold. It is
  // resumed first (Resume on the admin KDS — the screen that holds lines).
  // The station queue leaves held lines out for screens that don't ask for
  // them (?states=all), so a Bump-only tablet never offers one.
  if (status === 'bumped' && item.status === 'held') {
    throw new AppError('ITEM_ON_HOLD', 'This item is on hold — resume it before bumping it.', 409)
  }
  if (status === 'bumped' && item.status === 'recalled') {
    await updateItemStatus(itemId, 'preparing', staffId)
    return updateItemStatus(itemId, 'bumped', staffId)
  }

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

  // Hold and recall are kitchen work on food that is still the kitchen's
  // (BOH-04). Neither on an order that ended without a sale, nor on food that
  // has left (R8 — a hold used to be accepted there and left a HELD card on
  // the station for food already served): a pickup / dine-in order completes
  // at the hand-off and a delivery leaves with its rider. A till sale is
  // complete at PAYMENT (decision 8) — usually before the kitchen has cooked
  // it — so it can still be held or recalled.
  if (item.status !== status && (status === 'held' || status === 'recalled')) {
    await assertKitchenOwnsOrder(item.orderId, status)
  }

  // Set completedAt when the item leaves active service (ready or bumped).
  // Bumped is the canonical "done" state — kitchens often skip 'ready' and go
  // straight from 'preparing' → 'bumped', so we treat both as completion.
  // A recall is a remake: the old completion no longer stands, so ticket
  // times measure the remake.
  const isCompleting = status === 'ready' || status === 'bumped'
  // Conditional update prevents two parallel KDS bumps from both succeeding.
  const result = await prisma.orderItem.updateMany({
    where: { id: itemId, status: item.status },
    data: {
      status,
      ...(isCompleting && !item.completedAt && { completedAt: new Date() }),
      ...(status === 'recalled' && { completedAt: null }),
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

  // A recalled item reopens a 'ready' order: it leaves expo's ready column
  // and the hand-off (which only takes 'ready') is refused until the remake
  // is bumped, which moves it back to 'ready' below (BOH-04). Only a real move
  // INTO 'recalled' is a recall: a repeated tap (or a resend) on a line that
  // is already recalled matches the conditional update above but is not a
  // second remake — it books nothing.
  if (status === 'recalled' && item.status !== 'recalled') {
    await reopenOrderForRemake(item.orderId)
    // The remake cooks the dish again: its recipe is booked as waste 'remake'
    // (its own WasteLog per recall, FIFO value, Dr 1290 / Cr inventory) —
    // never silently left as unexplained variance. A failure is flagged on
    // the LINE (the re-run needs to know which line to re-book).
    try {
      await bookRemakeWaste(itemId, staffId ?? null)
    } catch (err) {
      await flagOrderStockFailure(item.orderId, 'remake', err, staffId ?? null, itemId)
    }
  }

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

/**
 * "READY" on a till sale that was paid before the kitchen finished (R4).
 *
 * Such an order is already 'completed' (decision 8: a till sale completes at
 * payment) and expo places it by its LINES (UI-05), so its status can't — and
 * needn't — go back to 'ready'. The kitchen's "this ticket is done" is the
 * same as bumping each of its fired lines, which is what this does, through
 * updateItemStatus (one line at a time, conditional, with its events). The
 * order's status is not touched; expo moves it to its ready column once every
 * line is bumped, and the hand-off takes it off the pass.
 *
 * Refused (nothing bumped) while a line is HELD (resume it first) or not
 * fired yet (a later course waiting for "Fire course").
 */
export async function bumpPaidTillSale(orderId: string, staffId?: string) {
  const lines = await prisma.orderItem.findMany({
    where: { orderId, status: { not: 'voided' } },
    select: { id: true, status: true },
  })
  if (lines.some((l) => l.status === 'held')) {
    throw new AppError('ITEM_ON_HOLD', 'An item on this order is on hold — resume it before marking the order ready.', 409)
  }
  if (lines.some((l) => l.status === 'pending')) {
    throw new AppError('ITEMS_NOT_FIRED', 'Part of this order has not been fired yet — fire it before marking the order ready.', 409)
  }
  for (const l of lines) {
    if (l.status === 'bumped') continue
    try {
      await updateItemStatus(l.id, 'bumped', staffId)
    } catch (e) {
      // Another screen moved it first — its end state is what we wanted.
      if ((e as { code?: string })?.code !== 'INVALID_TRANSITION') throw e
    }
  }
  return prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } })
}

/** What a hold / recall needs to know about the order. */
export interface KitchenOrderState {
  status: OrderStatus
  source: string
  fulfilmentType: string
  rawPayload?: unknown
  pickedUpAt: Date | null
  deliveredAt: Date | null
}

/**
 * Why an item of this order can't be recalled — or, with action 'hold',
 * held — (its food has left the kitchen's hands), or null when it can. `handedOff` = expo recorded the
 * hand-off ('expo.handoff'). Shared by the recall guard and the KDS
 * "recently bumped" list so the screen only offers what the server accepts.
 */
export function recallBlock(
  order: KitchenOrderState,
  handedOff: boolean,
  action: 'recall' | 'hold' = 'recall',
): { code: string; message: string } | null {
  const after = action === 'recall' ? 'a remake is a new order.' : 'there is nothing left to hold.'
  if (ENDED_NO_SALE.includes(order.status)) {
    return { code: 'ORDER_ENDED', message: `Order is ${order.status} — there is nothing to ${action}.` }
  }
  if (order.pickedUpAt || order.deliveredAt) {
    return { code: 'ORDER_HANDED_OFF', message: `This order has left with its rider — ${after}` }
  }
  const door = completionDoor(order)
  if (order.status === 'completed' && door !== 'payment') {
    return { code: 'ORDER_ALREADY_SERVED', message: `This order has been handed over and completed — ${after}` }
  }
  if (door === 'delivery' && handedOff) {
    return { code: 'ORDER_HANDED_OFF', message: `This order has been handed to its rider — ${after}` }
  }
  return null
}

async function assertKitchenOwnsOrder(orderId: string, status: 'held' | 'recalled'): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, source: true, fulfilmentType: true, rawPayload: true, pickedUpAt: true, deliveredAt: true },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const handedOff = completionDoor(order) === 'delivery'
    ? (await prisma.auditLog.count({ where: { entity: 'Order', entityId: orderId, action: 'expo.handoff' } })) > 0
    : false
  const block = recallBlock(order, handedOff, status === 'held' ? 'hold' : 'recall')
  if (block) throw new AppError(block.code, block.message, 409)
}

/**
 * Move a 'ready' order back to 'preparing' because one of its items was
 * recalled for a remake. Deliberately not through transitionOrder: ready →
 * preparing is not a lifecycle step any caller may request (the state machine
 * does not offer it, so PATCH /orders/:id/status can't do it), it is only the
 * consequence of a recall — and it must not re-run the 'preparing' side
 * effects (the customer's "being prepared" notice, the order.confirmed
 * webhook). Conditional on 'ready', so it never moves an order anywhere else.
 */
async function reopenOrderForRemake(orderId: string): Promise<void> {
  const res = await prisma.order.updateMany({
    where: { id: orderId, status: 'ready', deletedAt: null },
    data: { status: 'preparing' },
  })
  if (res.count > 0) emitOrderUpdated(orderId, 'preparing')
}

// ─── Customer notification helpers ───────────────────────────────────────────

async function notifyNewOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true, tenantId: true } },
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
    tenantId: order.concept.tenantId, // a test company never messages its customer
  })
}

async function notifyStatusChange(orderId: string, status: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: { select: { name: true, tenantId: true } },
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
    tenantId: order.concept.tenantId, // a test company never messages its customer
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
// finds the claim and does nothing). In that SAME transaction (the outbox,
// spec D4 / §17.1) it:
//   - enqueues the order's ONE sale FiscalDocument (connectors/fiscal/outbox
//     enqueueFiscalSaleTx) — completion is the full & final bill, so the sale
//     is filed with the fiscal POS exactly once, from here and nowhere else.
//     A company that does not report sales (§17.7) gets none. Refunds taken
//     before completion (a line voided on a paid, still-open order) are
//     enqueued behind it so the return files once the sale has its number;
//   - marks the order's pre-bills converted (prebills markPreBillsConvertedTx)
//     — a pre-bill itself never touches the fiscal POS.
// Then, exactly once:
//   - the ledger entry (postOrderCompletion; till sales post with their
//     shift's close). The FinancialEntry register is gone (decision 39).
//   - the tax invoice (TaxInvoice — kept as servd's own reference; the
//     receipt's headline is the fiscal number once filed, owner flag a)
//   - the loyalty earn (loyalty/service awardOrderPoints, once per order)
//   - the customer rollups (firstOrderAt / lastOrderAt / totalSpentCents)
//   - the 'order.delivered' webhook and the customer's "completed" notice
//   - the fiscal send: the till (`syncFiscal`) tries the POS within the
//     company's bounded budget so the receipt can carry the number and QR;
//     every other door kicks the outbox worker.
// Each step is fire-and-forget or bounded: a failure is logged and never
// unwinds a sale that has happened.

export interface CompletionActor { id: string; email?: string | null; tenantId?: string | null }

export type CompletionVia =
  | 'till_payment'
  | 'till_comp'
  | 'expo_handoff'
  | 'rider_delivered'
  | 'otp_verified'
  | 'status_update'
  /** recoverIncompleteCompletions: a completed order whose completion claim never committed. */
  | 'recovery'

const COMPLETE_CLAIM = 'order.complete'

// ─── Ledger postings of a completion / refund, never silent (BOOKS-R2-01) ─────
//
// The till close raises a high posting_failed exception when the ledger
// refuses it (pos/service flagShiftPostingFailed). The order completion, the
// refund restores and the order's loyalty earn are wrapped the same way: a
// refusal (a locked period, a missing account, an unbalanced entry) is put on
// the company's exceptions inbox with the order id, and
// POST /reconciliation/backfill-unposted re-posts it (and resolves the flag).

/** Reasons a posting legitimately has nothing to book — not a failure. */
const NOTHING_TO_POST = new Set([
  'pos_skipped', 'zero_value_order', 'order_not_found',                 // postOrderCompletion
  'sale_booked_without_gift_card', 'original_not_booked',              // postOrderRefund / postLoyaltyReversal
  'tx_not_found', 'not_reversible', 'not_earn_tx', 'zero_value',       // loyalty postings
  'not_redeem_tx', 'reversed',                                         // loyalty: a redeem looked up as an earn; an earn reversed before it posted
])

async function orderBooksOf(orderId: string) {
  return prisma.order.findUnique({
    where: { id: orderId },
    select: { conceptId: true, totalCents: true, concept: { select: { tenantId: true } } },
  })
}

/** postOrderCompletion; a refusal is flagged posting_failed for the order's company. Never throws. */
export async function postCompletionOrFlag(orderId: string): Promise<{ posted: boolean; reason?: string }> {
  const { flagPostingFailed } = await import('../accounting/journal.js')
  let reason: string | null = null
  let posted = false
  try {
    const r = await postOrderCompletion(orderId)
    posted = r.posted
    if (!r.posted && r.reason && !NOTHING_TO_POST.has(r.reason)) reason = r.reason
  } catch (err) {
    reason = (err as Error).message
  }
  if (reason) {
    const o = await orderBooksOf(orderId).catch(() => null)
    await flagPostingFailed({
      tenantId: o?.concept.tenantId ?? null,
      sourceType: 'order.complete', sourceId: orderId,
      entityType: 'Order', entityId: orderId,
      reason,
      title: 'Completed order did not reach the ledger',
      conceptId: o?.conceptId ?? null,
      amountCents: o?.totalCents ?? null,
    })
    return { posted: false, reason }
  }
  return { posted }
}

/** postOrderRefund; every refused restore posting is flagged for the order's company. Never throws. */
export async function postRefundOrFlag(orderId: string, reason: string, bookWalletRestore: boolean): Promise<{ failed: string[] }> {
  const { flagPostingFailed } = await import('../accounting/journal.js')
  const failed: string[] = []
  try {
    const results = await postOrderRefund(orderId, reason, { bookWalletRestore })
    for (const r of results) {
      if (!r.posted && r.reason && !NOTHING_TO_POST.has(r.reason)) failed.push(r.reason)
    }
  } catch (err) {
    failed.push((err as Error).message)
  }
  if (failed.length > 0) {
    const o = await orderBooksOf(orderId).catch(() => null)
    await flagPostingFailed({
      tenantId: o?.concept.tenantId ?? null,
      sourceType: 'order.refund', sourceId: orderId,
      entityType: 'Order', entityId: orderId,
      reason: failed.join('; '),
      title: 'Refund / cancel of an order did not reach the ledger',
      conceptId: o?.conceptId ?? null,
      amountCents: o?.totalCents ?? null,
    })
  }
  return { failed }
}

/**
 * The order's loyalty earn is on the books: posts it when missing (idempotent
 * on 'loyalty.earn:<tx>'), and flags posting_failed with the order id when the
 * ledger refuses it. Never throws.
 */
export async function ensureLoyaltyEarnBooked(loyaltyTxId: string, orderId: string | null): Promise<{ posted: boolean; reason?: string }> {
  const { flagPostingFailed } = await import('../accounting/journal.js')
  const booked = await prisma.journalEntry.findFirst({ where: { reference: `loyalty.earn:${loyaltyTxId}` }, select: { id: true } })
  if (booked) return { posted: true }
  let reason: string | null = null
  try {
    const { postLoyaltyEarn } = await import('../accounting/loyaltyPosting.js')
    const r = await postLoyaltyEarn(loyaltyTxId)
    if (r.posted) return { posted: true }
    if (r.reason && !NOTHING_TO_POST.has(r.reason)) reason = r.reason
  } catch (err) {
    reason = (err as Error).message
  }
  if (!reason) return { posted: false }
  const tx = await prisma.loyaltyTransaction.findUnique({
    where: { id: loyaltyTxId },
    select: { pointsDelta: true, loyaltyAccount: { select: { tenantId: true } } },
  }).catch(() => null)
  const o = orderId ? await orderBooksOf(orderId).catch(() => null) : null
  await flagPostingFailed({
    tenantId: tx?.loyaltyAccount.tenantId ?? o?.concept.tenantId ?? null,
    sourceType: 'loyalty.earn', sourceId: loyaltyTxId,
    entityType: orderId ? 'Order' : 'LoyaltyTransaction', entityId: orderId ?? loyaltyTxId,
    reason,
    title: `Loyalty points earned${orderId ? ' on an order' : ''} did not reach the ledger (2060)`,
    conceptId: o?.conceptId ?? null,
  })
  return { posted: false, reason }
}

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

// withSavepoint (lib/savepoint.ts) runs the completion claim's outbox writes
// behind a SAVEPOINT, so a fiscal bug can never stop a sale's ledger, loyalty
// and notice — and is flagged, never silent.

type QueuedDoc = { id: string; status: string }

/**
 * THE sale document of a completed order, inside the caller's (order-locked)
 * transaction: enqueueFiscalSaleTx, then the returns that have no document
 * yet queued behind it. Idempotent on every key, so completeOrder and the
 * recovery (recoverOrderCompletion) share it.
 *
 *   - Money given back BEFORE completion (a line voided on a paid order still
 *     in the kitchen — TILL-R3) has no return document: the sale did not
 *     exist. Each is queued behind the sale (idempotent per refund payment),
 *     so the return files once the sale has its number. The sale lists the
 *     voided line (connectors/fiscal/payload buildFiscalSaleTx — the bill was
 *     not lowered) and the return takes it off once, with no tip share: a
 *     void's refund is pure line value (W4-FISCAL-1).
 *   - A return queued while the sale had NO document (the completion claim
 *     failed and was recovered later — W4-FISCAL-2) was auto-skipped as
 *     no_sale_document; it is a real return of THIS sale, so it is adopted:
 *     linked to the sale and 'waiting' until the sale files.
 * Null sale when the company does not report sales (§17.7).
 */
async function enqueueSaleDocumentsTx(tx: Prisma.TransactionClient, orderId: string, tenantId: string): Promise<{ sale: QueuedDoc | null; refunds: QueuedDoc[] }> {
  const { enqueueFiscalSaleTx, enqueueFiscalRefundTx, voidRefundShape } = await import('../../connectors/fiscal/outbox.js')
  const sale = await enqueueFiscalSaleTx(tx, { orderId, tenantId })
  if (!sale) return { sale: null, refunds: [] }
  const given = await tx.payment.findMany({
    where: { orderId, status: 'refunded', amountCents: { lt: 0 } },
    select: { id: true, amountCents: true, method: true, gatewayMeta: true },
    orderBy: { createdAt: 'asc' },
  })
  const refunds: QueuedDoc[] = []
  for (const p of given) {
    const meta = (p.gatewayMeta ?? {}) as { refund?: { reason?: unknown } }
    const r = await enqueueFiscalRefundTx(tx, {
      orderId, tenantId, refundPaymentId: p.id, amountCents: Math.abs(p.amountCents),
      reason: typeof meta.refund?.reason === 'string' ? meta.refund.reason : undefined, method: p.method,
      // A voided line's refund: no tip share, and its exact split on its own line (TILL-R3).
      ...voidRefundShape(p),
    })
    if (r) refunds.push(r)
  }
  if (sale.status !== 'skipped') {
    await tx.fiscalDocument.updateMany({
      where: { tenantId, orderId, kind: 'refund', saleDocumentId: null, status: 'skipped', statusReason: 'no_sale_document' },
      data: { saleDocumentId: sale.id, status: 'waiting', statusReason: null },
    })
  }
  return { sale, refunds }
}

export interface CompletionResult {
  /** False when the completion had already been claimed (a replay) — nothing ran. */
  ran: boolean
  /**
   * The order's sale fiscal document as the till shows it: after the bounded
   * till attempt when `syncFiscal`, else as enqueued. Null when the company
   * does not report sales (§17.7) or nothing ran.
   */
  fiscal: FiscalView | null
}

/**
 * Run the completion side effects of an order whose status is already
 * 'completed'. Idempotent: only the first call for an order does anything.
 * `syncFiscal` (the till) makes a bounded attempt to file the sale with the
 * fiscal POS before returning, so the receipt can carry the fiscal number.
 */
export async function completeOrder(
  orderId: string,
  actor: CompletionActor | null,
  opts: { via: CompletionVia; syncFiscal?: boolean },
): Promise<CompletionResult> {
  // A held pre-order completed before its window (OK2-RV-1): its stock comes
  // out now, before the sale entry books its COGS — it used to wait for the
  // window, and never came out at all if the order was refunded first.
  // Idempotent; a no-op for an order never held or already released.
  await releasePreOrder(orderId, 'completion').catch((err) =>
    console.error(`[pre-order] release on completion failed for ${orderId}:`, (err as Error).message),
  )
  // The sale's stock is out before its cost is booked (the fire-and-forget
  // depletion may not have landed, or failed): once, never blocking the sale —
  // a failure is flagged 'stock_restore_failed'.
  await ensureOrderDepleted(orderId)
  const { markPreBillsConvertedTx } = await import('../prebills/service.js')
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
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { totalCents: true, conceptId: true, completedAt: true },
    })

    // The outbox (D4): THE sale document, in the claim's transaction — the
    // only place a sale is ever enqueued (recoverOrderCompletion re-runs this
    // same step when it failed). enqueueFiscalSaleTx reads the company's
    // "fiscal reporting required" switch itself (§17.7 → null).
    let fiscalDoc: { id: string; status: string } | null = null
    const refundDocs: Array<{ id: string; status: string }> = []
    if (row.tenantId) {
      const tenantId = row.tenantId
      const enq = await withSavepoint(tx, 'fiscal_sale', () => enqueueSaleDocumentsTx(tx, orderId, tenantId))
      if (enq.ok) {
        fiscalDoc = enq.value.sale
        refundDocs.push(...enq.value.refunds)
      } else {
        // Never silent: the sale stands (it has happened) and the missing
        // fiscal document is on the exceptions inbox for the CEO / IT. The
        // recovery sweep (recoverIncompleteCompletions) re-runs the enqueue
        // every few minutes and resolves this flag once the document exists.
        console.error(`[fiscal] COMPLIANCE: sale document for order ${orderId} could not be enqueued:`, enq.error.message)
        await tx.exceptionFlag.create({
          data: {
            tenantId,
            kind: 'fiscal_failed',
            severity: 'high',
            title: 'Sale not queued for the fiscal POS',
            description: `Order ${orderId.slice(-8).toUpperCase()} completed but its fiscal sale document could not be created (${enq.error.message.slice(0, 200)}). servd retries it automatically every few minutes; if this stays open, IT must fix the cause (the error above).`,
            entityType: 'Order',
            entityId: orderId,
            conceptId: current.conceptId,
            amountCents: current.totalCents,
          },
        })
      }
    }

    // Pre-bills (§17.1): the open one becomes 'converted', with the final
    // total on every print of the order. Never fiscal, never the ledger.
    const pb = await withSavepoint(tx, 'prebill_convert', () =>
      markPreBillsConvertedTx(tx, orderId, current.totalCents, current.completedAt ?? new Date()))
    if (!pb.ok) console.error(`[prebill] convert failed for order ${orderId}:`, pb.error.message)

    return { tenantId: row.tenantId, fiscalDoc, refundDocs }
  }, { maxWait: 10_000, timeout: 15_000 })
  if (!claim) return { ran: false, fiscal: null }

  const order = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, conceptId: true, customerId: true, totalCents: true },
  })

  // Ledger. Till sales are skipped inside (they post with the shift close).
  // BOOKS-R2-01: a refusal (a locked period, a missing account, …) raises a
  // high posting_failed exception for the order's company — never only a log
  // line — and /reconciliation/backfill-unposted re-posts it.
  void postCompletionOrFlag(orderId)

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

  if (order.customerId) {
    // THE order earn (modules/loyalty/service.ts): once per order, never throws.
    // Its liability posting (bookEarn) flags a refusal itself; this re-checks
    // that the earn reached the books (same flag key, so never two flags —
    // BOOKS-R2-01).
    void import('../loyalty/service.js')
      .then(({ awardOrderPoints }) => awardOrderPoints(orderId))
      .then((r) => (r?.txId ? ensureLoyaltyEarnBooked(r.txId, orderId) : undefined))
      .catch((err) => console.error(`[loyalty] earn check failed for order ${orderId}:`, (err as Error).message))
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

  // Fiscal send, after commit (spec §6.3). Never throws, never blocks a sale
  // beyond the company's bounded till budget (D10).
  let fiscal: FiscalView | null = null
  if (claim.fiscalDoc) {
    const { submitFiscalAtTill, kickFiscal } = await import('../../connectors/fiscal/outbox.js')
    const { fiscalViewForOrder } = await import('../../connectors/fiscal/view.js')
    if (opts.syncFiscal) {
      fiscal = await submitFiscalAtTill(claim.fiscalDoc.id)
    } else {
      if (claim.fiscalDoc.status === 'pending') void kickFiscal(claim.fiscalDoc.id)
      fiscal = await fiscalViewForOrder(orderId, 'sale', { staff: true }).catch(() => null)
    }
    for (const r of claim.refundDocs) if (r.status === 'pending') void kickFiscal(r.id)
  }

  return { ran: true, fiscal }
}

// ─── Completion recovery (W4-FISCAL-2) ────────────────────────────────────────
//
// The status write and the completion claim are separate transactions: a till
// sale is marked completed inside its payment transaction, every other door in
// transitionOrder's claim; completeOrder then claims the completion (and
// enqueues the sale document) in its own. If that claim transaction fails — a
// lock wait past its timeout, pool exhaustion, a dropped connection — the order
// is 'completed' with no ledger entry, loyalty earn, notice or fiscal sale
// document, and a retry is a same-state no-op. If only the fiscal enqueue
// inside it fails, the claim commits without the sale document (flagged
// fiscal_failed). Either way "one sale document per completed order" would
// silently become "at most one" and the order's later returns would be
// skipped as no_sale_document. The recovery closes both holes, never silently:
//
//   - a COMPLETED order with no 'order.complete' claim → completeOrder runs
//     now ('recovery'), once (the claim makes it idempotent);
//   - a claimed order of a company that reports sales but with no sale
//     document → the sale (and its returns) are enqueued now
//     (enqueueSaleDocumentsTx), and the order's fiscal_failed flag resolved;
//   - what cannot be recovered (a refunded order whose completion never ran,
//     or a recovery that fails again) stays on the exceptions inbox
//     (fiscal_failed, one open flag per order).
// Only orders completed / claimed since this code first booted
// (completionRecoverySince — a Setting written once) are considered, so
// history from before the outbox is never re-completed or late-filed. The
// workers run recoverIncompleteCompletions every two minutes (index.ts).

const RECOVERY_SINCE_KEY = 'orders.completionRecoverySince'

/** When the completion recovery starts counting (written once, the first time it is read). */
export async function completionRecoverySince(now: Date = new Date()): Promise<Date> {
  await prisma.setting.createMany({ data: [{ key: RECOVERY_SINCE_KEY, value: now.toISOString() }], skipDuplicates: true })
  const row = await prisma.setting.findUnique({ where: { key: RECOVERY_SINCE_KEY } })
  const at = row ? new Date(row.value) : now
  return Number.isFinite(at.getTime()) ? at : now
}

/** One open fiscal_failed flag per order (never a flag per sweep). */
async function flagCompletionOnce(orderId: string, title: string, description: string): Promise<void> {
  const open = await prisma.exceptionFlag.findFirst({
    where: { kind: 'fiscal_failed', entityType: 'Order', entityId: orderId, status: { in: ['open', 'acknowledged'] } },
    select: { id: true },
  })
  if (open) return
  const o = await prisma.order.findUnique({
    where: { id: orderId },
    select: { conceptId: true, totalCents: true, concept: { select: { tenantId: true } } },
  })
  if (!o) return
  await prisma.exceptionFlag.create({
    data: {
      tenantId: o.concept.tenantId,
      kind: 'fiscal_failed',
      severity: 'high',
      title,
      description: description.slice(0, 900),
      entityType: 'Order',
      entityId: orderId,
      conceptId: o.conceptId,
      amountCents: o.totalCents,
    },
  })
}

export type CompletionRecovery = 'completed' | 'sale_enqueued' | 'flagged' | 'nothing'

/**
 * Recover ONE order's completion (see above). Never throws: a failure is
 * logged and flagged, and the next sweep tries again.
 */
export async function recoverOrderCompletion(orderId: string, since?: Date): Promise<CompletionRecovery> {
  const from = since ?? await completionRecoverySince()
  try {
    const order = await prisma.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { status: true, completedAt: true, concept: { select: { tenantId: true } } },
    })
    if (!order || (order.status !== 'completed' && order.status !== 'refunded')) return 'nothing'
    const claim = await prisma.auditLog.findFirst({
      where: { entity: 'Order', entityId: orderId, action: COMPLETE_CLAIM },
      select: { createdAt: true },
    })

    if (!claim) {
      if (!order.completedAt || order.completedAt < from) return 'nothing'
      if (order.status === 'refunded') {
        // Refunded before its completion ever ran: completing it now would
        // book a sale over its refunds. A person decides.
        await flagCompletionOnce(orderId, 'Completed sale never processed',
          `Order ${orderId.slice(-8).toUpperCase()} was completed and then refunded, but its completion (ledger, loyalty, fiscal sale document) never ran. File the sale and its return by hand and check its books.`)
        return 'flagged'
      }
      const r = await completeOrder(orderId, null, { via: 'recovery' })
      return r.ran ? 'completed' : 'nothing'
    }

    // Claimed: the sale document is the one thing that may be missing.
    const tenantId = order.concept.tenantId
    if (!tenantId || claim.createdAt < from) return 'nothing'
    const exists = await prisma.fiscalDocument.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: `sale:${orderId}` } },
      select: { id: true },
    })
    if (exists) return 'nothing'
    const enq = await prisma.$transaction(async (tx) => {
      await lockOrderForStock(tx, orderId)
      return enqueueSaleDocumentsTx(tx, orderId, tenantId)
    }, { maxWait: 10_000, timeout: 15_000 })
    if (!enq.sale) return 'nothing'   // the company does not report sales (§17.7)
    await prisma.exceptionFlag.updateMany({
      where: { kind: 'fiscal_failed', entityType: 'Order', entityId: orderId, status: { in: ['open', 'acknowledged'] } },
      data: { status: 'resolved', resolvedAt: new Date(), resolution: 'Recovered automatically: the sale document is queued for the fiscal POS.' },
    })
    const { kickFiscal } = await import('../../connectors/fiscal/outbox.js')
    for (const d of [enq.sale, ...enq.refunds]) if (d.status === 'pending') void kickFiscal(d.id)
    return 'sale_enqueued'
  } catch (err) {
    const msg = (err as Error).message
    console.error(`[complete] COMPLIANCE: recovery of order ${orderId} failed:`, msg)
    await flagCompletionOnce(orderId, 'Sale not queued for the fiscal POS',
      `Order ${orderId.slice(-8).toUpperCase()} is completed but its completion or fiscal sale document could not be recovered (${msg.slice(0, 200)}). servd keeps retrying; if this stays open, IT must fix the cause.`,
    ).catch(() => {})
    return 'flagged'
  }
}

export interface RecoveryStats { completed: number; saleEnqueued: number; flagged: number }

/**
 * The sweep: every order that needs recoverOrderCompletion, since the
 * recovery marker and at least `graceMs` old (a completion still in flight is
 * left to finish — it would be a no-op anyway, the claim is locked).
 * `tenantIds` narrows it to some companies (tests).
 */
export async function recoverIncompleteCompletions(opts: { graceMs?: number; limit?: number; tenantIds?: string[]; now?: Date } = {}): Promise<RecoveryStats> {
  const now = opts.now ?? new Date()
  const since = await completionRecoverySince(now)
  const cutoff = new Date(now.getTime() - (opts.graceMs ?? 120_000))
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500))
  const stats: RecoveryStats = { completed: 0, saleEnqueued: 0, flagged: 0 }
  // Never older than a week (a sweep runs every two minutes) — keeps the scans
  // on the indexes and the history before the marker out.
  const from = new Date(Math.max(since.getTime(), now.getTime() - 7 * 86_400_000))
  if (cutoff < from) return stats
  const scoped = opts.tenantIds
    ? Prisma.sql`AND c."tenantId" IN (${opts.tenantIds.length ? Prisma.join(opts.tenantIds) : Prisma.sql`NULL`})`
    : Prisma.empty

  // (1) Completed (or since refunded) with no completion claim.
  const unclaimed = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT o.id FROM orders o JOIN concepts c ON c.id = o."conceptId"
     WHERE o.status IN ('completed', 'refunded') AND o."deletedAt" IS NULL
       AND o."placedAt" >= ${new Date(from.getTime() - 30 * 86_400_000)}
       AND o."completedAt" >= ${from} AND o."completedAt" <= ${cutoff}
       ${scoped}
       AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = ${COMPLETE_CLAIM})
       AND NOT (o.status = 'refunded' AND EXISTS (SELECT 1 FROM exception_flags e WHERE e.kind = 'fiscal_failed' AND e."entityType" = 'Order' AND e."entityId" = o.id))
     ORDER BY o."completedAt" ASC
     LIMIT ${limit}`

  // (2) Claimed, in a company that reports sales, with no sale document.
  const undocumented = await prisma.$queryRaw<Array<{ id: string; tenantId: string; completedAt: Date | null }>>`
    SELECT o.id, c."tenantId", o."completedAt" FROM audit_logs a
      JOIN orders o ON o.id = a."entityId"
      JOIN concepts c ON c.id = o."conceptId"
     WHERE a.entity = 'Order' AND a.action = ${COMPLETE_CLAIM}
       AND a."createdAt" >= ${from} AND a."createdAt" <= ${cutoff}
       AND o.status IN ('completed', 'refunded') AND o."deletedAt" IS NULL
       AND c."tenantId" IS NOT NULL
       ${scoped}
       AND NOT EXISTS (SELECT 1 FROM fiscal_documents f WHERE f."tenantId" = c."tenantId" AND f."idempotencyKey" = 'sale:' || o.id)
     ORDER BY a."createdAt" ASC
     LIMIT ${limit * 5}`
  // Only sales that file (config.ts saleFileable — fr-2): reporting on, not
  // a test company, and completed after reporting became required. A test
  // company's sales are never picked up here once test mode is turned off.
  // enqueueFiscalSaleTx applies the same rule again under the order lock.
  const { saleFileable } = await import('../../connectors/config.js')
  const { isTestTenant } = await import('../../lib/testCompany.js')
  const companies = new Map<string, { settings: unknown; hasRow: boolean; isTest: boolean }>()
  const needSale: string[] = []
  for (const u of undocumented) {
    let co = companies.get(u.tenantId)
    if (!co) {
      const row = await prisma.posConnector.findUnique({ where: { tenantId_kind: { tenantId: u.tenantId, kind: 'fiscal' } }, select: { settings: true } })
      co = { settings: row?.settings ?? {}, hasRow: !!row, isTest: await isTestTenant(u.tenantId) }
      companies.set(u.tenantId, co)
    }
    if (saleFileable(co.settings, { hasRow: co.hasRow, isTest: co.isTest, completedAt: u.completedAt })) needSale.push(u.id)
    if (needSale.length >= limit) break
  }

  for (const id of [...unclaimed.map((u) => u.id), ...needSale]) {
    const r = await recoverOrderCompletion(id, from)
    if (r === 'completed') stats.completed++
    else if (r === 'sale_enqueued') stats.saleEnqueued++
    else if (r === 'flagged') stats.flagged++
  }
  return stats
}
