// Cost of sales from the FIFO lots (finance wave B, H16) — THE one place an
// order's cost of goods is computed for the ledger.
//
// An order's cost of sales is the value of the lots it actually relieved, at
// the prices actually paid (no Q factor — that is a pricing allowance only,
// H18): −Σ valueCents of its 'sale', 'sale_return' and 'sale_void' movements,
// split by class:
//
//   food       Dr 5010 Food Cost      / Cr 1210 Inventory – Food
//   beverage   Dr 5020 Beverage Cost  / Cr 1220 Inventory – Beverage
//   packaging  Dr 5030 Packaging Cost / Cr 1230 Inventory – Packaging
//
// One balanced pair per class, both lines tagged with the brand. Used by the
// online completion entry ('order.complete:<orderId>', orderPosting.ts) and the
// till close ('shift.close:<shiftId>', per brand, shiftPosting.ts).
// 'shortfall_settle' rows are NOT read here: a late receipt posts them itself
// ('inventory.shortfall_settle:<lotId>'), so counting them would book them
// twice.
//
// Legacy fallback: an order placed BEFORE its company's FIFO cut-over (or of a
// company not cut over yet) that has no movements was depleted by the old
// path; it books the old theoretical plate cost (lib/recipeCost.ts
// cogsForSoldLines) to 5010 / 1210 with the memo 'pre-FIFO order'. An order
// placed after the cut-over with no movements (nothing on a recipe) costs 0.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { sumCents } from '../../lib/money.js'
import { CLASS_ACCOUNTS, CLASS_LABEL, COST_CLASSES, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { ORDER_COGS_KINDS, readFifoCutoverAt } from '../../lib/stockLedger.js'
import { cogsForSoldLines } from '../../lib/recipeCost.js'
import { ACCT, TILL_CLEARING_CODES, type JournalLineInput } from './journal.js'

type Db = Prisma.TransactionClient | PrismaClient

/** Memo marker of the legacy (pre-cut-over) cost-of-sales pair. */
export const PRE_FIFO_MEMO = 'pre-FIFO order'

const asClass = (v: string): CostClass => ((COST_CLASSES as readonly string[]).includes(v) ? (v as CostClass) : 'food')

/** Net lot value relieved by `orderIds` in `tenantId`, per class, and which orders have any such movement. */
async function relievedByClass(db: Db, tenantId: string, orderIds: string[]): Promise<{ byClass: Record<CostClass, number>; withMovements: Set<string> }> {
  const byClass = zeroByClass()
  const withMovements = new Set<string>()
  if (orderIds.length === 0) return { byClass, withMovements }
  const sums = await db.stockMovement.groupBy({
    by: ['orderId', 'costClass'],
    where: { tenantId, orderId: { in: orderIds }, kind: { in: [...ORDER_COGS_KINDS] } },
    _sum: { valueCents: true },
  })
  for (const s of sums) {
    if (s.orderId) withMovements.add(s.orderId)
    byClass[asClass(s.costClass)] += -sumCents(s._sum.valueCents)
  }
  return { byClass, withMovements }
}

/**
 * Old theoretical plate cost of the orders among `orderIds` that belong to the
 * company and were placed before its FIFO cut-over (all of them while it has
 * not been cut over). Callers pass only orders with no movements.
 */
async function legacyCogsCents(db: Db, tenantId: string, orderIds: string[]): Promise<number> {
  if (orderIds.length === 0) return 0
  const cutoverAt = await readFifoCutoverAt(db, tenantId)
  const orders = await db.order.findMany({
    where: { id: { in: orderIds }, concept: { tenantId }, ...(cutoverAt ? { placedAt: { lt: cutoverAt } } : {}) },
    select: { items: { select: { menuItemId: true, quantity: true, status: true } } },
  })
  if (orders.length === 0) return 0
  return cogsForSoldLines(orders.flatMap((o) => o.items), db)
}

/**
 * The cost-of-sales lines of `orderIds` in `tenantId`'s books: one Dr 50x0 /
 * Cr 12x0 pair per class (reversed when a class nets negative), both lines
 * tagged `o.conceptId`, plus the legacy 'pre-FIFO order' pair for pre-cut-over
 * orders with no movements. Balanced by construction; [] when nothing cost.
 */
export async function cogsLinesForOrders(
  tenantId: string,
  orderIds: string[],
  o: { conceptId: string | null; memo: string },
  db: Db = prisma,
): Promise<JournalLineInput[]> {
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (ids.length === 0) return []
  const { byClass, withMovements } = await relievedByClass(db, tenantId, ids)
  const lines: JournalLineInput[] = []
  const conceptId = o.conceptId ?? null
  for (const c of COST_CLASSES) {
    const cents = byClass[c]
    if (cents === 0) continue
    const { inv, cogs } = CLASS_ACCOUNTS[c]
    const label = CLASS_LABEL[c]
    if (cents > 0) {
      lines.push({ accountCode: cogs, type: 'debit',  amountCents: cents, memo: `COGS (${label}) ${o.memo}`.slice(0, 250), conceptId })
      lines.push({ accountCode: inv,  type: 'credit', amountCents: cents, memo: `Inventory used (${label}) ${o.memo}`.slice(0, 250), conceptId })
    } else {
      // More came back than went out (a return booked after its sale's close): reverse the pair.
      lines.push({ accountCode: inv,  type: 'debit',  amountCents: -cents, memo: `Inventory returned (${label}) ${o.memo}`.slice(0, 250), conceptId })
      lines.push({ accountCode: cogs, type: 'credit', amountCents: -cents, memo: `COGS returned (${label}) ${o.memo}`.slice(0, 250), conceptId })
    }
  }
  const legacy = await legacyCogsCents(db, tenantId, ids.filter((id) => !withMovements.has(id)))
  if (legacy > 0) {
    lines.push({ accountCode: ACCT.FOOD_COST,      type: 'debit',  amountCents: legacy, memo: `COGS (${PRE_FIFO_MEMO}) ${o.memo}`.slice(0, 250), conceptId })
    lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: legacy, memo: `Inventory used (${PRE_FIFO_MEMO}) ${o.memo}`.slice(0, 250), conceptId })
  }
  return lines
}

/**
 * An order's net lot value (paisa): −Σ valueCents of its sale / sale_return /
 * sale_void movements in the order's company — what cogsLinesForOrders books
 * for it (staff meals store it as their cost). A pre-cut-over order with no
 * movements returns the legacy plate cost; any other order with none is 0.
 */
export async function orderStockCostCents(orderId: string, db: Db = prisma): Promise<number> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { id: true, concept: { select: { tenantId: true } } } })
  const tenantId = order?.concept.tenantId
  if (!order || !tenantId) return 0
  const { byClass, withMovements } = await relievedByClass(db, tenantId, [order.id])
  if (withMovements.has(order.id)) return COST_CLASSES.reduce((s, c) => s + byClass[c], 0)
  return legacyCogsCents(db, tenantId, [order.id])
}

/**
 * When `orderId`'s cost of sales reached `tenantId`'s ledger, or null while it
 * has not:
 *   - its own 'order.complete:<id>' entry (online orders; a till bill a gift
 *     card paid in full), else
 *   - a till order: its HOME drawer's 'shift.close:<shiftId>' (homeShiftOf —
 *     the drawer of its earliest receipt), when that close booked it as a live
 *     sale — not when the close saw it cancelled (a REFUND DUE line naming the
 *     order, or a close posted after the cancel with no money of it to hold).
 * The entry's createdAt is returned: a lot movement written AFTER it is not in
 * that entry, so giving such a booked line back or wasting it moves cost of
 * sales, not inventory again (orders/stock.ts, inventory/voidWaste.ts). Pass
 * the transaction to see what it has written.
 */
export async function orderCostBookedAt(db: Db, tenantId: string, orderId: string): Promise<Date | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, source: true, status: true, cancelledAt: true,
      payments: { select: { id: true, shiftId: true, method: true, status: true, gatewayRef: true, amountCents: true, createdAt: true, raastReceipt: { select: { status: true } } } },
    },
  })
  if (!order) return null
  // Lazy: orderPosting.ts imports this module.
  const { homeShiftOf, isShiftReceipt, isVoidedRaast, REFUND_DUE_PREFIX } = await import('./orderPosting.js')
  const completeRef = `order.complete:${order.id}`
  const home = order.source === 'pos' ? homeShiftOf(order) : null
  const closeRef = home ? `shift.close:${home}` : null
  const entries = await db.journalEntry.findMany({
    where: { tenantId, reference: { in: closeRef ? [completeRef, closeRef] : [completeRef] } },
    select: { id: true, reference: true, createdAt: true },
  })
  const complete = entries.find((e) => e.reference === completeRef)
  if (complete) return complete.createdAt
  const close = closeRef ? entries.find((e) => e.reference === closeRef) : undefined
  if (!close) return null
  const due = await db.journalLine.findFirst({
    where: {
      // Till clearing: 1110 before the company's cut-over, 1115 after it.
      journalEntryId: close.id, type: 'credit', account: { tenantId, code: { in: TILL_CLEARING_CODES } },
      AND: [{ memo: { startsWith: REFUND_DUE_PREFIX } }, { memo: { contains: order.id } }],
    },
    select: { id: true },
  })
  if (due) return null
  const dead = order.status === 'cancelled' || order.status === 'rejected'
  if (dead && order.cancelledAt && order.cancelledAt <= close.createdAt) {
    // Posted after the cancel: the close treated it as no sale. With money it
    // holds a REFUND DUE (above); with none (a comp, an on-account charge, a
    // voided Raast) nothing.
    const money = order.payments.some((p) => p.shiftId === home && p.amountCents > 0 && p.method !== 'comp' && p.method !== 'on_account' && !isVoidedRaast(p) && isShiftReceipt(p))
    if (!money) return null
  }
  return close.createdAt
}

/**
 * Cost of sales already taken out of the lots (or, before the cut-over, out of
 * stock) but not yet booked to the ledger, per class — an order counts only
 * while its cost is NOT in the ledger (orderCostBookedAt's rule):
 *   - open orders (received → ready) — a till ticket only while its home
 *     drawer (homeShiftOf) has no posted 'shift.close' (an open ticket whose
 *     first drawer has closed was booked by that close);
 *   - completed till orders whose home drawer's close is not posted yet (the
 *     drawer is still open, or its close was refused — the cost is out of the
 *     lots and not in the GL either way). A completed till order whose home
 *     close posted is booked, even with a later payment on an open drawer.
 * Any order with an 'order.complete' entry is booked. FIFO orders count their
 * relieved lot value; a pre-cut-over order with no movements counts its legacy
 * plate cost (food). The FIFO alignment and the valuation tie-out read it as a
 * reconciling item: it shrinks as those orders complete, close or cancel.
 */
export async function unbookedSalesCostByClass(db: Db, tenantId: string): Promise<Record<CostClass, number>> {
  const out = zeroByClass()
  // The company's posted drawer closes ('shift.close:' is 12 characters).
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH posted AS (
      SELECT substr(je.reference, 13) AS sid FROM journal_entries je
       WHERE je."tenantId" = ${tenantId} AND je.reference LIKE 'shift.close:%'
    )
    SELECT o.id FROM orders o JOIN concepts c ON c.id = o."conceptId"
     WHERE c."tenantId" = ${tenantId}
       AND (o.status::text IN ('received', 'confirmed', 'preparing', 'ready')
            OR (o.status::text = 'completed' AND o.source::text = 'pos' AND EXISTS (
                  SELECT 1 FROM payments p JOIN shifts s ON s.id = p."shiftId"
                   WHERE p."orderId" = o.id
                     AND (s."closedAt" IS NULL OR NOT EXISTS (SELECT 1 FROM posted WHERE posted.sid = s.id)))))`
  if (rows.length === 0) return out
  const candidates = await db.order.findMany({
    where: { id: { in: rows.map((r) => r.id) } },
    select: { id: true, source: true, status: true, payments: { select: { id: true, shiftId: true, method: true, status: true, gatewayRef: true, createdAt: true } } },
  })
  const { homeShiftOf } = await import('./orderPosting.js')
  const homeOf = new Map(candidates.map((o) => [o.id, o.source === 'pos' ? homeShiftOf(o) : null]))
  const refs = [
    ...candidates.map((o) => `order.complete:${o.id}`),
    ...[...new Set([...homeOf.values()].filter((s): s is string => !!s))].map((s) => `shift.close:${s}`),
  ]
  const bookedRefs = new Set((await db.journalEntry.findMany({ where: { tenantId, reference: { in: refs } }, select: { reference: true } })).map((e) => e.reference))
  const ids = candidates.filter((o) => {
    if (bookedRefs.has(`order.complete:${o.id}`)) return false
    if (o.source !== 'pos') return o.status !== 'completed'
    const home = homeOf.get(o.id)
    if (!home) return o.status !== 'completed'   // a completed till order with no drawer receipt is booked by its own entry
    return !bookedRefs.has(`shift.close:${home}`)
  }).map((o) => o.id)
  if (ids.length === 0) return out
  const { byClass, withMovements } = await relievedByClass(db, tenantId, ids)
  for (const c of COST_CLASSES) out[c] += byClass[c]
  out.food += await legacyCogsCents(db, tenantId, ids.filter((id) => !withMovements.has(id)))
  return out
}
