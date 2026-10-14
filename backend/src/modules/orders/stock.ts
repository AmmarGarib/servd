// What a sale takes out of stock — on FIFO lots (finance wave B, H16).
//
// What a sale consumes comes from THE recipe explosion (lib/recipeCost.ts
// consumptionPerLine): the dish's ingredients and sub-recipes, its add-ons'
// modifier recipes, and its Packaging section when packagingApplies (the
// owner's FINAL packaging rule: takeaway / delivery; a brand whose service
// vessel is packaging; a dine-in line marked "Box given"). Only the ORDER's
// company's items are consumed — another company's (or a company-less) item
// is excluded and flagged 'recipe_foreign_stock' once per (dish, company).
//
// TIMING — at order creation (ingestOrder, fire-and-forget; a held pre-order
// at its release), and ensured again before a completion books its cost
// (ensureOrderDepleted). Chosen over "at completion" because the till writes
// its own completion and the auto-86 needs stock already promised to tickets
// on the line.
//
// Every draw goes through lib/stockLedger.ts (THE stock writer):
//   sale            consumeFifoTx kind 'sale', 'order_item.sale' + line id —
//                   oldest lot first, clamped (a shortfall is recorded, the
//                   sale never fails), brand + outlet + line on every row
//   "Box given"     the dish's packaging, kind 'sale',
//                   'order_item.box_given' + '<line id>@<tap time>' (a tap
//                   after an undo is a new tap); undo puts it back in the
//                   same lots ('order_item.box_given_undo')
//   unfired void /  returnToLotsTx kind 'sale_return', 'order_item.return' +
//   cancel          line id — back into the very lots it came from
//   fired void /    inventory/voidWaste.ts wasteSoldLineTx — relabelled to
//   cancel          waste (sale_void + waste rows), stock unchanged, booked
//                   Dr 5040 / Cr class inventory ('pos.void_waste:<line>')
//   KDS remake      bookRemakeWaste — the recipe cooked again, as waste
//                   'remake' (its own WasteLog per recall, 'inventory.waste:<id>')
//
// The depletion is claimed once per order by a write-once audit row (action
// stock.sale_deplete, metadata.mode 'fifo'); the cancel's restore by
// stock.sale_restore. Both run under the order's row lock, so a cancel racing
// the fire-and-forget depletion can't restore before it lands or deplete
// after it.
//
// Before the company's FIFO cut-over (lib/stockLedger.ts ensureFifoReady runs
// it on the first stock write) an order was depleted the OLD way: its claim
// row holds the `taken` JSON and it has no lot movements. Such an order still
// restores / voids through that JSON; once the company is cut over, what it
// gives back comes in as a 'legacy_return' lot at the item's head cost, keyed
// by event ('<orderId>:cancel', '<orderItemId>:void') so a void and a later
// cancel never collide. A company not cut over yet (the cut-over module not
// installed) keeps the old path end to end.
//
// Failures never block a sale or a cancel: they are flagged
// 'stock_restore_failed' in the order's company (never only logged).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { emitItem86d } from '../../lib/ws.js'
import { flagException } from '../../lib/exceptions.js'
import { consumptionPerLine, type ExcludedItem, type NeedRow, type SoldLine } from '../../lib/recipeCost.js'
import {
  addLotTx, consumeFifoTx, ensureFifoReady, lockItemsTx, readFifoCutoverAt, returnToLotsTx, STOCK_EPS, STOCK_SOURCE,
} from '../../lib/stockLedger.js'
import { lineNetOutRowsTx, wasteSoldLineTx, VOID_WASTE_SOURCE, type SoldLineWasteResult } from '../inventory/voidWaste.js'

type Tx = Prisma.TransactionClient

export const STOCK_DEPLETE = 'stock.sale_deplete'
export const STOCK_RESTORE = 'stock.sale_restore'
/** Audit row of a legacy (pre-cut-over) unfired void's return. */
const STOCK_VOID_RESTORE = 'stock.void_restore'
/** Audit action stamped on a menu item the stock switched off (autoEightySixDepletedItems). */
export const AUTO_86 = 'menu.auto_86'
const NO_SALE: string[] = ['cancelled', 'rejected']
/** Lines the kitchen has not started: cancelling / voiding them gives their stock back. */
const UNFIRED: ReadonlySet<string> = new Set(['pending', 'held'])

/** sourceType conventions of the order side (the food-cost report reads them). */
export const ORDER_STOCK_SOURCE = {
  sale:      STOCK_SOURCE.orderItemSale,  // 'order_item.sale'  + OrderItem.id
  ret:       'order_item.return',          // unfired void / cancel back to the lots — + OrderItem.id
  boxGiven:  'order_item.box_given',       // + '<OrderItem.id>@<boxGivenAt ms>'
  boxUndo:   'order_item.box_given_undo',  // + the tap's sourceId
  legacy:    'order.legacy_return',        // + '<orderId>:cancel' | '<orderItemId>:void'
} as const

const TX_OPTS = { maxWait: 10_000, timeout: 30_000 }

const boxKey = (lineId: string, at: Date | null): string => `${lineId}@${at ? at.getTime() : 0}`

/** Lock the order row (FOR UPDATE) and read its status and company. */
export async function lockOrderForStock(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<Array<{ status: string; tenantId: string | null }>>`
    SELECT o.status::text AS status, c."tenantId" AS "tenantId"
    FROM orders o JOIN concepts c ON c.id = o."conceptId"
    WHERE o.id = ${orderId}
    FOR UPDATE OF o
  `
  return rows[0] ?? null
}

async function claimsTx(tx: Tx, orderId: string) {
  const [depleted, restored] = await Promise.all([
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_DEPLETE }, select: { id: true, metadata: true } }),
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: STOCK_RESTORE }, select: { id: true } }),
  ])
  return { depleted, restored }
}

const isFifoClaim = (meta: Prisma.JsonValue | null | undefined): boolean =>
  !!meta && typeof meta === 'object' && !Array.isArray(meta) && (meta as { mode?: unknown }).mode === 'fifo'

const ORDER_LINE_SELECT = {
  id: true, menuItemId: true, quantity: true, status: true, serviceVessel: true, boxGiven: true, boxGivenAt: true, name: true,
  modifiers: { select: { modifierId: true } },
} satisfies Prisma.OrderItemSelect

type OrderLine = Prisma.OrderItemGetPayload<{ select: typeof ORDER_LINE_SELECT }>

function soldLine(l: OrderLine, o: { boxGiven?: boolean } = {}): SoldLine {
  return {
    id: l.id, menuItemId: l.menuItemId, quantity: l.quantity, status: l.status,
    modifierIds: l.modifiers.map((m) => m.modifierId), serviceVessel: l.serviceVessel,
    boxGiven: o.boxGiven ?? l.boxGiven,
  }
}

// ─── Flags ───────────────────────────────────────────────────────────────────

/**
 * A stock step for an order failed after (or outside) its transaction: flag it
 * 'stock_restore_failed' in the order's company — once per (order, phase)
 * while open. Never throws.
 */
export async function flagOrderStockFailure(
  orderId: string, phase: 'deplete' | 'restore' | 'remake' | 'box_given', err: unknown, actorId?: string | null,
): Promise<void> {
  try {
    const message = (err as Error)?.message ?? String(err)
    console.error(`[inventory] ${phase} failed for order ${orderId}:`, message)
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { conceptId: true, concept: { select: { tenantId: true } } } })
    const open = await prisma.exceptionFlag.findFirst({
      where: { kind: 'stock_restore_failed', entityType: 'Order', entityId: orderId, status: { in: ['open', 'acknowledged'] }, metadata: { path: ['phase'], equals: phase } },
      select: { id: true },
    })
    if (open) return
    const what: Record<typeof phase, string> = {
      deplete: 'Stock was not taken out for an order',
      restore: 'A cancelled order\'s stock was not returned or wasted',
      remake: 'A KDS remake was not booked as waste',
      box_given: '"Box given" packaging was not taken out of stock',
    }
    await flagException({
      tenantId: o?.concept.tenantId ?? null,
      kind: 'stock_restore_failed',
      severity: 'high',
      title: what[phase],
      description: `Order ${orderId.slice(-8).toUpperCase()}: ${message.slice(0, 400)}. The lots and the food-cost report are off by this order until it is fixed — `
        + 'fix the cause (for example the item\'s company, or the FIFO cut-over), then re-run it from Reconciliation.',
      entityType: 'Order',
      entityId: orderId,
      conceptId: o?.conceptId ?? null,
      actorId: actorId ?? null,
      metadata: { phase, error: message.slice(0, 500) },
    })
  } catch (e) {
    console.error(`[inventory] could not flag the ${phase} failure of order ${orderId}:`, (e as Error).message)
  }
}

/** One open recipe_foreign_stock flag per (dish, company). */
async function flagForeignStock(tenantId: string, conceptId: string | null, excluded: ExcludedItem[]): Promise<void> {
  const byDish = new Map<string, ExcludedItem[]>()
  for (const e of excluded) {
    if (!e.menuItemId) continue
    byDish.set(e.menuItemId, [...(byDish.get(e.menuItemId) ?? []), e])
  }
  for (const [menuItemId, list] of byDish) {
    try {
      const open = await prisma.exceptionFlag.findFirst({
        where: { kind: 'recipe_foreign_stock', tenantId, entityType: 'MenuItem', entityId: menuItemId, status: { in: ['open', 'acknowledged'] } },
        select: { id: true },
      })
      if (open) continue
      const [dish, items] = await Promise.all([
        prisma.menuItem.findUnique({ where: { id: menuItemId }, select: { name: true } }),
        prisma.inventoryItem.findMany({ where: { id: { in: list.map((e) => e.itemId) } }, select: { id: true, name: true } }),
      ])
      const names = new Map(items.map((i) => [i.id, i.name]))
      const what = list.map((e) => `${names.get(e.itemId) ?? e.itemId} (${e.reason === 'foreign' ? 'another company\'s item' : 'an item with no company'})`).join(', ')
      await flagException({
        tenantId,
        kind: 'recipe_foreign_stock',
        severity: 'medium',
        title: `${dish?.name ?? 'A dish'}'s recipe draws stock outside its company`,
        description: `Selling it does not take ${what} out of stock — a sale only consumes its own company's items. `
          + 'Point the recipe (or its sub-recipe) at this company\'s own item, or give the item a company.',
        entityType: 'MenuItem',
        entityId: menuItemId,
        conceptId,
        metadata: { items: list.map((e) => ({ itemId: e.itemId, reason: e.reason })) },
      })
    } catch (err) {
      console.error('[inventory] recipe_foreign_stock flag failed:', (err as Error).message)
    }
  }
}

// ─── Depletion ───────────────────────────────────────────────────────────────

/**
 * Take an order's recipe consumption out of the lots (see the header).
 * Idempotent per order (the claim row), does nothing for an order that has
 * already ended without a sale. Throws on failure — ingestOrder catches and
 * flags; completion calls ensureOrderDepleted (never throws).
 */
export async function deductInventoryForOrder(orderId: string): Promise<void> {
  const head = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, concept: { select: { tenantId: true } } } })
  if (!head || NO_SALE.includes(head.status)) return
  const tenantId = head.concept.tenantId
  if (!tenantId) {
    console.warn(`[inventory] order ${orderId}: its brand belongs to no company — no stock to take`)
    return
  }
  await ensureFifoReady(tenantId)
  if (!(await readFifoCutoverAt(prisma, tenantId))) {
    const ranOut = await legacyDeduct(orderId)
    if (ranOut === 'cut_over') return deductInventoryForOrder(orderId)
    if (ranOut.length > 0) await autoEightySixDepletedItems(ranOut)
    return
  }

  const result = await prisma.$transaction(async (tx) => {
    const locked = await lockOrderForStock(tx, orderId)
    if (!locked || NO_SALE.includes(locked.status)) return null
    const { depleted } = await claimsTx(tx, orderId)
    if (depleted) return null
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true, conceptId: true, locationId: true, fulfilmentType: true, concept: { select: { serviceVessel: true } },
        items: { select: ORDER_LINE_SELECT, orderBy: { id: 'asc' } },
      },
    })
    const opts = { tenantId, fulfilmentType: order.fulfilmentType, serviceVessel: order.concept.serviceVessel }
    // Box-given packaging is drawn under its own key (so an undo can give it back): the sale itself is costed as if not boxed.
    const per = await consumptionPerLine(order.items.map((l) => soldLine(l, { boxGiven: false })), tx, opts)
    const plans: Array<{ line: OrderLine; sale: Map<string, NeedRow>; box: Map<string, NeedRow> }> = []
    const excluded: ExcludedItem[] = []
    per.forEach((p, i) => {
      const line = order.items[i]!
      excluded.push(...p.excluded)
      plans.push({ line, sale: p.need, box: line.boxGiven && !p.packagingApplies ? p.packaging : new Map() })
    })
    // Every item the order touches, locked in id order before the first draw (no deadlock between two orders).
    await lockItemsTx(tx, plans.flatMap((p) => [...p.sale.keys(), ...p.box.keys()]))

    const occurredAt = new Date()
    const takenByLine: Record<string, Record<string, number>> = {}
    const shortfall: Record<string, number> = {}
    const touched = new Set<string>()
    for (const p of plans) {
      const draws: Array<[string, NeedRow, string, string]> = [
        ...[...p.sale].map(([id, r]) => [id, r, ORDER_STOCK_SOURCE.sale, p.line.id] as [string, NeedRow, string, string]),
        ...[...p.box].map(([id, r]) => [id, r, ORDER_STOCK_SOURCE.boxGiven, boxKey(p.line.id, p.line.boxGivenAt)] as [string, NeedRow, string, string]),
      ]
      for (const [itemId, need, sourceType, sourceId] of draws) {
        const r = await consumeFifoTx(tx, {
          tenantId, inventoryItemId: itemId, qty: need.qty, kind: 'sale', sourceType, sourceId, clamp: true,
          orderId, orderItemId: p.line.id, conceptId: order.conceptId, locationId: order.locationId,
          theoreticalQty: need.qty, occurredAt,
        })
        if (r.takenQty > 0) {
          touched.add(itemId)
          const byItem = (takenByLine[p.line.id] ??= {})
          byItem[itemId] = (byItem[itemId] ?? 0) + r.takenQty
        }
        if (r.shortfallQty > 0) {
          shortfall[itemId] = (shortfall[itemId] ?? 0) + r.shortfallQty
          console.warn(`[inventory] item ${itemId} short on order ${orderId}: needed ${need.qty.toFixed(4)}, ${r.shortfallQty.toFixed(4)} not on the books (recorded)`)
        }
      }
    }
    // Ingredients THIS sale ran out: it took stock and left none. Only these
    // may auto-86 (R2) — an item already at zero (never counted in) is not
    // "this sale ran out".
    const after = touched.size === 0 ? [] : await tx.inventoryItem.findMany({ where: { id: { in: [...touched] } }, select: { id: true, currentStock: true } })
    const ranOut = after.filter((i) => i.currentStock <= STOCK_EPS).map((i) => i.id)
    await tx.auditLog.create({
      data: {
        category: 'stock',
        tenantId,
        action: STOCK_DEPLETE,
        entity: 'Order',
        entityId: orderId,
        metadata: { mode: 'fifo', taken: takenByLine, shortfall, excluded: excluded.map((e) => ({ itemId: e.itemId, reason: e.reason })) } as Prisma.InputJsonValue,
      },
    })
    return { ranOut, excluded, conceptId: order.conceptId }
  }, TX_OPTS)
  if (!result) return
  if (result.excluded.length > 0) await flagForeignStock(tenantId, result.conceptId, result.excluded)
  // Auto-86: a sale that took an ingredient to zero switches off every dish
  // that depends on it (cross-channel: storefront + KDS read isAvailable).
  if (result.ranOut.length > 0) await autoEightySixDepletedItems(result.ranOut)
}

/**
 * The pre-cut-over depletion (a company the FIFO cut-over has not reached —
 * transitional only): currentStock clamped at zero and the `taken` JSON on the
 * claim row. Returns the ingredients this sale ran out, or 'cut_over' when the
 * cut-over landed while it waited for the locks (the caller re-runs on lots).
 */
async function legacyDeduct(orderId: string): Promise<string[] | 'cut_over'> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockOrderForStock(tx, orderId)
    if (!locked || NO_SALE.includes(locked.status) || !locked.tenantId) return []
    const { depleted } = await claimsTx(tx, orderId)
    if (depleted) return []
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { fulfilmentType: true, concept: { select: { serviceVessel: true } }, items: { select: ORDER_LINE_SELECT } },
    })
    const per = await consumptionPerLine(order.items.map((l) => soldLine(l)), tx, {
      tenantId: locked.tenantId, fulfilmentType: order.fulfilmentType, serviceVessel: order.concept.serviceVessel,
    })
    const need = new Map<string, number>()
    for (const p of per) for (const [id, r] of p.need) need.set(id, (need.get(id) ?? 0) + r.qty)
    if (need.size === 0) return []
    const ids = [...need.keys()].sort()
    const stock = await tx.$queryRaw<Array<{ id: string; currentStock: number }>>`
      SELECT id, "currentStock" FROM inventory_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`
    if (await readFifoCutoverAt(tx, locked.tenantId)) return 'cut_over' as const
    const taken: Record<string, number> = {}
    const ranOut: string[] = []
    for (const row of stock) {
      const before = Number(row.currentStock)
      const after = Math.max(0, before - (need.get(row.id) ?? 0))
      const actual = before - after
      if (actual > 0) {
        await tx.inventoryItem.update({ where: { id: row.id }, data: { currentStock: after } })
        taken[row.id] = actual
        if (after <= 0) ranOut.push(row.id)
      }
    }
    await tx.auditLog.create({
      data: {
        category: 'stock', tenantId: locked.tenantId, action: STOCK_DEPLETE, entity: 'Order', entityId: orderId,
        metadata: { taken, requested: Object.fromEntries(need) } as Prisma.InputJsonValue,
      },
    })
    return ranOut
  }, TX_OPTS)
}

/**
 * Make sure an order's stock has come out before its cost is booked
 * (completeOrder, a staff meal): deducts once if it has not run — skipping a
 * held pre-order not released yet (its release takes the stock). Never throws:
 * a failure is flagged 'stock_restore_failed'. Call it OUTSIDE any transaction.
 */
export async function ensureOrderDepleted(orderId: string): Promise<void> {
  try {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { status: true, scheduledFor: true, createdAt: true } })
    if (!o || NO_SALE.includes(o.status)) return
    const { heldAtCreation, PRE_ORDER_RELEASE } = await import('./service.js')
    if (heldAtCreation(o)) {
      const released = await prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: PRE_ORDER_RELEASE }, select: { id: true } })
      if (!released) return
    }
    await deductInventoryForOrder(orderId)
  } catch (err) {
    await flagOrderStockFailure(orderId, 'deplete', err)
  }
}

// ─── Giving back: cancel, unfired void ───────────────────────────────────────

export interface RestoreOptions {
  /** Fired lines of a cancelled order are wasted with this reason (and photo). Default 'cancelled_after_fire'. */
  cookedFood?: { wasteReason: 'cancelled_after_fire'; photoUrl?: string }
  actorId?: string | null
  approverId?: string | null
}

/**
 * An order ended without a sale (cancelOrder): exactly once, every live line
 * that was not fired goes back into the very lots it came from; every fired
 * line is wasted 'cancelled_after_fire' (food that never left the kitchen) —
 * Dr 5040 / Cr class inventory in the order's company. Lines voided earlier
 * were handled by their void. Menu items the depletion 86'd are NOT switched
 * back on (the kitchen re-enables them). A refused waste posting is flagged
 * posting_failed after commit; any other failure throws (the caller flags it).
 */
export async function restoreInventoryForOrder(orderId: string, o: RestoreOptions = {}): Promise<void> {
  const res = await prisma.$transaction(async (tx) => {
    const order = await lockOrderForStock(tx, orderId)
    if (!order) return null
    const { depleted, restored } = await claimsTx(tx, orderId)
    if (!depleted || restored) return null
    if (!isFifoClaim(depleted.metadata)) {
      await legacyRestoreTx(tx, orderId, order, depleted, o)
      return null
    }
    const tenantId = order.tenantId
    if (!tenantId) return null
    const ord = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { conceptId: true } })
    const lines = await tx.orderItem.findMany({
      where: { orderId, status: { not: 'voided' }, voidedAt: null },
      select: { id: true, status: true, name: true, quantity: true },
      orderBy: { id: 'asc' },
    })
    const outByLine = new Map<string, Awaited<ReturnType<typeof lineNetOutRowsTx>>>()
    for (const l of lines) outByLine.set(l.id, await lineNetOutRowsTx(tx, { tenantId, orderItemId: l.id }))
    await lockItemsTx(tx, [...outByLine.values()].flatMap((rows) => rows.map((r) => r.inventoryItemId)))

    const at = new Date()
    let returnedCents = 0
    let wastedCents = 0
    const failures: Array<{ line: (typeof lines)[number]; waste: SoldLineWasteResult }> = []
    for (const l of lines) {
      const rows = outByLine.get(l.id) ?? []
      if (rows.length === 0) continue
      if (UNFIRED.has(l.status)) {
        const r = await returnToLotsTx(tx, {
          rows, kind: 'sale_return', sourceType: ORDER_STOCK_SOURCE.ret, sourceId: l.id, occurredAt: at, tenantId, createdById: o.actorId ?? null,
        })
        returnedCents += r.valueCents
      } else {
        const w = await wasteSoldLineTx(tx, {
          orderId, tenantId, line: { id: l.id }, wasteReason: o.cookedFood?.wasteReason ?? 'cancelled_after_fire',
          actorId: o.actorId ?? null, conceptId: ord.conceptId, approverId: o.approverId ?? null, photoUrl: o.cookedFood?.photoUrl ?? null,
        })
        wastedCents += w.wasteCostCents
        if (w.postingError) failures.push({ line: l, waste: w })
      }
    }
    await tx.auditLog.create({
      data: {
        category: 'stock', tenantId, action: STOCK_RESTORE, entity: 'Order', entityId: orderId,
        metadata: { mode: 'fifo', status: order.status, returnedCents, wastedCents } as Prisma.InputJsonValue,
      },
    })
    return { tenantId, conceptId: ord.conceptId, failures }
  }, TX_OPTS)
  if (!res) return
  for (const f of res.failures) await flagSoldLineWastePosting(res.tenantId, orderId, res.conceptId, f.line, f.waste, o.actorId ?? null)
}

/** A sold line's waste posting was refused: flag it so Backfill unposted re-posts 'pos.void_waste:<line>'. */
export async function flagSoldLineWastePosting(
  tenantId: string | null, orderId: string, conceptId: string | null,
  line: { id: string; name: string; quantity: number }, waste: SoldLineWasteResult, actorId: string | null,
): Promise<void> {
  if (!waste.postingError) return
  const { flagPostingFailed } = await import('../accounting/journal.js')
  await flagPostingFailed({
    tenantId,
    sourceType: VOID_WASTE_SOURCE,
    sourceId: line.id,
    entityType: 'OrderItem',
    entityId: line.id,
    reason: `${waste.postingError.code}: ${waste.postingError.message}`,
    title: `Waste from a sold line not posted (${waste.postingError.code})`,
    conceptId,
    actorId,
    amountCents: waste.wasteCostCents,
    metadata: { orderId, wasteLogIds: waste.wasteLogIds, line: `${line.quantity} × ${line.name}`, code: waste.postingError.code },
  })
}

/**
 * A voided line the kitchen had NOT started gives its stock back, inside the
 * void's transaction (the order row locked): its net-out rows return to the
 * same lots ('sale_return', 'order_item.return' + line id — once). Nothing
 * when the depletion has not run (it skips a voided line) or the order's stock
 * was already given back. A pre-cut-over order returns through its `taken`
 * JSON (see the header).
 */
export async function returnVoidedLineStockTx(tx: Tx, a: {
  orderId: string; tenantId: string | null; line: { id: string; quantity: number }; actorId?: string | null
}): Promise<{ valueCents: number; restored: Record<string, number>; skipped: 'not_depleted' | 'nothing_taken' | 'no_company' | null }> {
  if (!a.tenantId) return { valueCents: 0, restored: {}, skipped: 'no_company' }
  const tenantId = a.tenantId
  const { depleted, restored } = await claimsTx(tx, a.orderId)
  if (!depleted || restored) return { valueCents: 0, restored: {}, skipped: 'not_depleted' }
  if (!isFifoClaim(depleted.metadata)) return legacyVoidReturnTx(tx, a.orderId, tenantId, a.line.id, depleted)
  const rows = await lineNetOutRowsTx(tx, { tenantId, orderItemId: a.line.id })
  if (rows.length === 0) return { valueCents: 0, restored: {}, skipped: 'nothing_taken' }
  const r = await returnToLotsTx(tx, {
    rows, kind: 'sale_return', sourceType: ORDER_STOCK_SOURCE.ret, sourceId: a.line.id, occurredAt: new Date(), tenantId, createdById: a.actorId ?? null,
  })
  const back: Record<string, number> = {}
  for (const row of rows) back[row.inventoryItemId] = (back[row.inventoryItemId] ?? 0) + Math.abs(row.qty)
  return { valueCents: r.valueCents, restored: back, skipped: null }
}

// ─── Legacy (pre-cut-over) give-backs ────────────────────────────────────────

/** Put `qty` of an item back: a 'legacy_return' lot at its head cost once cut over, else straight onto currentStock (the old way). */
async function legacyGiveBackTx(tx: Tx, tenantId: string, cutOver: boolean, itemId: string, qty: number, key: string, actorId: string | null): Promise<void> {
  if (!(qty > STOCK_EPS)) return
  if (!cutOver) {
    await tx.inventoryItem.updateMany({ where: { id: itemId }, data: { currentStock: { increment: qty } } })
    return
  }
  const item = await tx.inventoryItem.findUnique({ where: { id: itemId }, select: { tenantId: true, unitCostCents: true } })
  if (!item || item.tenantId !== tenantId) return   // never return into another company's (or a company-less) item
  await addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents: Math.max(0, Math.round(item.unitCostCents ?? 0)),
    kind: 'legacy_return', lotSourceType: 'legacy_return', lotSourceId: key,
    movementSourceType: ORDER_STOCK_SOURCE.legacy, movementSourceId: key, receivedAt: new Date(), createdById: actorId,
  })
}

async function legacyRestoreTx(
  tx: Tx, orderId: string, order: { status: string; tenantId: string | null },
  depleted: { id: string; metadata: Prisma.JsonValue | null }, o: RestoreOptions,
): Promise<void> {
  const taken = ((depleted.metadata ?? {}) as { taken?: Record<string, number> }).taken ?? {}
  const tenantId = order.tenantId
  if (tenantId) {
    const cutOver = !!(await readFifoCutoverAt(tx, tenantId))
    const ids = Object.keys(taken).filter((id) => (taken[id] ?? 0) > 0).sort()
    await lockItemsTx(tx, ids)
    for (const id of ids) await legacyGiveBackTx(tx, tenantId, cutOver, id, taken[id]!, `${orderId}:cancel`, o.actorId ?? null)
  }
  await tx.auditLog.create({
    data: {
      category: 'stock', tenantId, action: STOCK_RESTORE, entity: 'Order', entityId: orderId,
      metadata: { restored: taken, status: order.status } as Prisma.InputJsonValue,
    },
  })
}

async function legacyVoidReturnTx(
  tx: Tx, orderId: string, tenantId: string, lineId: string, depleted: { id: string; metadata: Prisma.JsonValue | null },
): Promise<{ valueCents: number; restored: Record<string, number>; skipped: 'nothing_taken' | null }> {
  const meta = (depleted.metadata ?? {}) as { taken?: Record<string, number>; takenAtSale?: Record<string, number>; voidRestored?: Record<string, Record<string, number>> } & Record<string, unknown>
  if (meta.voidRestored?.[lineId]) return { valueCents: 0, restored: {}, skipped: 'nothing_taken' }
  const line = await tx.orderItem.findUniqueOrThrow({
    where: { id: lineId },
    select: { ...ORDER_LINE_SELECT, order: { select: { fulfilmentType: true, concept: { select: { serviceVessel: true } } } } },
  })
  const [per] = await consumptionPerLine([soldLine(line)].map((l) => ({ ...l, status: 'pending' })), tx, {
    tenantId, fulfilmentType: line.order.fulfilmentType, serviceVessel: line.order.concept.serviceVessel,
  })
  const taken = { ...(meta.taken ?? {}) }
  const give: Record<string, number> = {}
  for (const [id, r] of per?.need ?? []) {
    const out = taken[id] ?? 0
    const back = Math.min(r.qty, out)
    if (back > 0) {
      give[id] = back
      taken[id] = out - back
    }
  }
  if (Object.keys(give).length === 0) return { valueCents: 0, restored: {}, skipped: 'nothing_taken' }
  const cutOver = !!(await readFifoCutoverAt(tx, tenantId))
  await lockItemsTx(tx, Object.keys(give))
  for (const id of Object.keys(give).sort()) await legacyGiveBackTx(tx, tenantId, cutOver, id, give[id]!, `${lineId}:void`, null)
  await tx.auditLog.update({
    where: { id: depleted.id },
    data: { metadata: { ...meta, takenAtSale: meta.takenAtSale ?? meta.taken ?? {}, taken, voidRestored: { ...(meta.voidRestored ?? {}), [lineId]: give } } as Prisma.InputJsonValue },
  })
  await tx.auditLog.create({
    data: { category: 'stock', tenantId, action: STOCK_VOID_RESTORE, entity: 'OrderItem', entityId: lineId, metadata: { orderId, restored: give } as Prisma.InputJsonValue },
  })
  return { valueCents: 0, restored: give, skipped: null }
}

// ─── "Box given" ─────────────────────────────────────────────────────────────

/** The companies a staff login acts in (write scope): its memberships plus its active company. */
async function writeScopeOf(userId: string): Promise<string[]> {
  const [u, m] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } }),
    prisma.tenantMember.findMany({ where: { userId }, select: { tenantId: true } }),
  ])
  return [...new Set([...m.map((x) => x.tenantId), ...(u?.tenantId ? [u.tenantId] : [])])]
}

/**
 * Staff tapped "Box given" on a dine-in line at a plate brand (the leftovers
 * were boxed) — or undid it. The line must be in the actor's write scope
 * (`actor.tenantIds`, else the login's companies; foreign → 404). Takeaway /
 * delivery lines and a packaging-vessel brand's lines already count their
 * packaging → 409 BOX_NOT_NEEDED. A tap sets boxGiven / boxGivenAt /
 * boxGivenById and, when the order's stock has already been taken, takes the
 * dish's packaging out of its lots (FIFO, kind 'sale', 'order_item.box_given');
 * a second tap or a replay writes nothing. An undo (only until the order
 * completes — then 409 BOX_GIVEN_FINAL) puts it back into the same lots.
 * Audited 'order.box_given' / 'order.box_given_undo' in the ORDER's company.
 */
export async function markBoxGiven(
  orderItemId: string,
  actor: { id: string; tenantIds?: string[] },
  opts: { undo?: boolean } = {},
): Promise<{ boxGiven: boolean; depleted: boolean }> {
  const line = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      id: true, orderId: true, status: true, voidedAt: true, serviceVessel: true, name: true,
      order: { select: { status: true, fulfilmentType: true, conceptId: true, concept: { select: { tenantId: true, serviceVessel: true } } } },
    },
  })
  const tenantId = line?.order.concept.tenantId ?? null
  const scope = actor.tenantIds ?? await writeScopeOf(actor.id)
  if (!line || !tenantId || !scope.includes(tenantId)) throw new NotFoundError('OrderItem', orderItemId)
  const vessel = line.serviceVessel ?? line.order.concept.serviceVessel
  if (line.order.fulfilmentType !== 'dine_in' || vessel === 'packaging') {
    throw new AppError('BOX_NOT_NEEDED', 'This line already counts its packaging (takeaway, delivery or a brand that serves in packaging) — no "Box given" needed.', 409)
  }
  if (line.voidedAt || line.status === 'voided') throw new AppError('LINE_VOIDED', 'This line was voided.', 409)
  if (['cancelled', 'rejected', 'refunded'].includes(line.order.status)) throw new AppError('ORDER_ENDED', 'This order has ended — nothing to box.', 409)
  await ensureFifoReady(tenantId)

  const res = await prisma.$transaction(async (tx) => {
    const locked = await lockOrderForStock(tx, line.orderId)
    if (!locked) throw new NotFoundError('OrderItem', orderItemId)
    if (['cancelled', 'rejected', 'refunded'].includes(locked.status)) throw new AppError('ORDER_ENDED', 'This order has ended — nothing to box.', 409)
    const cur = await tx.orderItem.findUniqueOrThrow({ where: { id: orderItemId }, select: { ...ORDER_LINE_SELECT, voidedAt: true } })
    if (cur.voidedAt || cur.status === 'voided') throw new AppError('LINE_VOIDED', 'This line was voided.', 409)
    const { depleted, restored } = await claimsTx(tx, line.orderId)
    const fifo = !!depleted && !restored && isFifoClaim(depleted.metadata)
    const boxRows = () => lineNetOutRowsTx(tx, {
      tenantId, orderItemId, saleSourceTypes: [ORDER_STOCK_SOURCE.boxGiven], returnSourceTypes: [ORDER_STOCK_SOURCE.boxUndo],
    })

    if (opts.undo) {
      if (!cur.boxGiven) return { changed: false, boxGiven: false, depleted: false }
      if (locked.status === 'completed') {
        throw new AppError('BOX_GIVEN_FINAL', 'The order is complete — "Box given" can no longer be undone.', 409)
      }
      if (fifo) {
        const rows = await boxRows()
        if (rows.length > 0) {
          await returnToLotsTx(tx, {
            rows, kind: 'sale_return', sourceType: ORDER_STOCK_SOURCE.boxUndo, sourceId: boxKey(cur.id, cur.boxGivenAt),
            occurredAt: new Date(), tenantId, createdById: actor.id,
          })
        }
      }
      await tx.orderItem.updateMany({ where: { id: orderItemId, boxGiven: true }, data: { boxGiven: false, boxGivenAt: null, boxGivenById: null } })
      return { changed: true, boxGiven: false, depleted: false }
    }

    if (cur.boxGiven) return { changed: false, boxGiven: true, depleted: fifo && (await boxRows()).length > 0 }
    const at = new Date()
    const claimed = await tx.orderItem.updateMany({
      where: { id: orderItemId, boxGiven: false },
      data: { boxGiven: true, boxGivenAt: at, boxGivenById: actor.id },
    })
    if (claimed.count === 0) return { changed: false, boxGiven: true, depleted: false }
    if (!fifo) return { changed: true, boxGiven: true, depleted: false }   // not taken yet: the depletion takes it (or a legacy order)

    const order = await tx.order.findUniqueOrThrow({
      where: { id: line.orderId },
      select: { conceptId: true, locationId: true, fulfilmentType: true, concept: { select: { serviceVessel: true } } },
    })
    const [per] = await consumptionPerLine([soldLine(cur, { boxGiven: false })], tx, {
      tenantId, fulfilmentType: order.fulfilmentType, serviceVessel: order.concept.serviceVessel,
    })
    const pack = per?.packaging ?? new Map<string, NeedRow>()
    await lockItemsTx(tx, [...pack.keys()])
    let took = false
    for (const [itemId, need] of [...pack].sort(([x], [y]) => x.localeCompare(y))) {
      const r = await consumeFifoTx(tx, {
        tenantId, inventoryItemId: itemId, qty: need.qty, kind: 'sale', sourceType: ORDER_STOCK_SOURCE.boxGiven, sourceId: boxKey(cur.id, at),
        clamp: true, orderId: line.orderId, orderItemId, conceptId: order.conceptId, locationId: order.locationId,
        theoreticalQty: need.qty, occurredAt: at, createdById: actor.id,
      })
      if (r.rows.length > 0) took = true
    }
    if (per && per.excluded.length > 0) await flagForeignStock(tenantId, order.conceptId, per.excluded)
    return { changed: true, boxGiven: true, depleted: took }
  }, TX_OPTS)

  if (res.changed) {
    const { audit } = await import('../../lib/audit.js')
    await audit({
      category: 'identity',
      action: opts.undo ? 'order.box_given_undo' : 'order.box_given',
      entity: 'OrderItem',
      entityId: orderItemId,
      userId: actor.id,
      tenantId,
      metadata: { orderId: line.orderId, line: line.name, depleted: res.depleted },
    })
  }
  return { boxGiven: res.boxGiven, depleted: res.depleted }
}

// ─── KDS remake ──────────────────────────────────────────────────────────────

/**
 * A recalled line is cooked again (KDS recall → remake): its recipe — the
 * dish's ingredients and add-ons, not its packaging — is booked as waste
 * 'remake', one WasteLog per item per recall (FIFO value; Dr 5040 / Cr class
 * inventory, 'inventory.waste:<wasteLogId>', brand = the order's). What the
 * lots do not hold is not invented (the note says so). A refused posting is
 * flagged posting_failed after commit; any other failure throws (the caller
 * flags it).
 */
export async function bookRemakeWaste(orderItemId: string, actorId: string | null): Promise<{ wasteLogIds: string[]; costCents: number }> {
  const line = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    select: {
      ...ORDER_LINE_SELECT, orderId: true,
      order: { select: { conceptId: true, locationId: true, concept: { select: { tenantId: true, serviceVessel: true } } } },
    },
  })
  const tenantId = line?.order.concept.tenantId
  if (!line || !tenantId) return { wasteLogIds: [], costCents: 0 }
  await ensureFifoReady(tenantId)
  if (!(await readFifoCutoverAt(prisma, tenantId))) return { wasteLogIds: [], costCents: 0 }   // not on lots yet: nothing to draw from

  const { postInventoryDocInSavepoint } = await import('../accounting/inventoryPosting.js')
  const res = await prisma.$transaction(async (tx) => {
    // The cooked food only: as a dine-in plate, never boxed.
    const [per] = await consumptionPerLine([{ ...soldLine(line, { boxGiven: false }), status: 'pending', serviceVessel: 'plate' }], tx, {
      tenantId, fulfilmentType: 'dine_in', serviceVessel: 'plate',
    })
    const need = per?.need ?? new Map<string, NeedRow>()
    const ids = [...need.keys()].sort()
    await lockItemsTx(tx, ids)
    const items = await tx.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, unit: true, currentStock: true } })
    const byId = new Map(items.map((i) => [i.id, i]))
    const at = new Date()
    const wasteLogIds: string[] = []
    const failures: Array<Awaited<ReturnType<typeof postInventoryDocInSavepoint>>['failure']> = []
    let costCents = 0
    for (const id of ids) {
      const item = byId.get(id)
      if (!item) continue
      const want = need.get(id)!.qty
      const qty = Math.min(want, Math.max(0, item.currentStock))
      if (!(qty > STOCK_EPS)) continue
      const short = want - qty > STOCK_EPS ? ` — ${String(Math.round((want - qty) * 1000) / 1000)} ${item.unit} more was needed than the lots hold` : ''
      const log = await tx.wasteLog.create({
        data: {
          tenantId, conceptId: line.order.conceptId, locationId: line.order.locationId, orderItemId,
          inventoryItemId: id, quantity: qty, unit: item.unit, reason: 'remake', recordedById: actorId,
          notes: `KDS remake: ${line.quantity} × ${line.name} cooked again (order ${line.orderId}, line ${orderItemId})${short}`.slice(0, 1000),
        },
        select: { id: true },
      })
      const r = await consumeFifoTx(tx, {
        tenantId, inventoryItemId: id, qty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false,
        orderId: line.orderId, orderItemId, conceptId: line.order.conceptId, locationId: line.order.locationId, occurredAt: at, createdById: actorId,
      })
      await tx.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
      const post = await postInventoryDocInSavepoint(tx, 'inventory.waste', log.id, { tenantId, actorId, conceptId: line.order.conceptId, amountCents: r.valueCents })
      if (post.failure) failures.push(post.failure)
      wasteLogIds.push(log.id)
      costCents += r.valueCents
    }
    return { wasteLogIds, costCents, failures }
  }, TX_OPTS)
  if (res.failures.length > 0) {
    const { flagPostingFailed } = await import('../accounting/journal.js')
    for (const f of res.failures) if (f) await flagPostingFailed(f)
  }
  return { wasteLogIds: res.wasteLogIds, costCents: res.costCents }
}

// ─── Auto-86 ─────────────────────────────────────────────────────────────────

export async function autoEightySixDepletedItems(ingredientIds: string[]) {
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
    select: { menuItemId: true, menuItem: { select: { id: true, conceptId: true, isAvailable: true, concept: { select: { tenantId: true } } } } },
  })
  const toDisable = recipes
    .filter((r): r is typeof r & { menuItem: NonNullable<typeof r.menuItem> } => r.menuItem !== null && r.menuItem.isAvailable)
    .map((r) => ({ id: r.menuItem.id, conceptId: r.menuItem.conceptId, tenantId: r.menuItem.concept.tenantId }))

  if (toDisable.length === 0) return

  // Conditional on isAvailable so two depletions racing over the same dish
  // record (and announce) the 86 once.
  await prisma.menuItem.updateMany({
    where: { id: { in: toDisable.map((m) => m.id) }, isAvailable: true },
    data: { isAvailable: false },
  })
  // The updatedAt this 86 left on each dish: while it is unchanged, nobody
  // has touched the dish since (standingAutoEightySix).
  const stamped = new Map((await prisma.menuItem.findMany({
    where: { id: { in: toDisable.map((m) => m.id) } },
    select: { id: true, updatedAt: true },
  })).map((m) => [m.id, m.updatedAt.toISOString()]))

  // The record of WHY it went off (BOH-15): an auto-86 is the stock running
  // out, not a chef's decision, so when the delivery comes in the kitchen is
  // shown these dishes as "back in stock — put back on?"
  // (listAutoEightySixedBackInStock / GET /kds/auto-86/back-in-stock). Nothing
  // switches them back on by itself — a manual 86 may be standing on top.
  await prisma.auditLog.createMany({
    data: toDisable.map((m) => ({
      category: 'stock',
      tenantId: m.tenantId,
      action: AUTO_86,
      entity: 'MenuItem',
      entityId: m.id,
      metadata: { depletedInventoryItemIds: depleted.map((d) => d.id), itemUpdatedAt: stamped.get(m.id) ?? null },
    })),
  }).catch((err: Error) => console.error('[auto-86] audit write failed:', err.message))

  for (const m of toDisable) {
    emitItem86d(m.id, m.conceptId, false)
    console.warn(`[auto-86] Menu item ${m.id} disabled — depleted ingredient`)
  }
}

