// Waste of a SOLD line — food that was cooked and will never be eaten
// (finance wave B, food cost on FIFO lots; BOH-R2-03).
//
//   void_after_fire        a line voided at the till after the kitchen fired it
//   cancelled_after_fire   an order cancelled after some of its lines were fired
//                          (food that never left the kitchen)
//   returned_food          RESERVED for the parked delivery work (refused /
//                          returned food logged through Emergency overrides).
//                          Kept in the list so that work resumes without a
//                          change — NOTHING writes it in wave B.
//
// wasteSoldLineTx runs inside the void's / cancel's transaction (the order
// row is locked, as the depletion and the restore lock it):
//
//   - What the line still has out of the lots — its sale rows net of returns
//     and earlier relabels (lineNetOutRowsTx) — and never more: nothing when
//     the depletion has not run (it skips a voided line) or the order's stock
//     was already given back. Replays find nothing out and write nothing.
//   - Those rows are RELABELLED (lib/stockLedger relabelToWasteTx): a
//     'sale_void' row nets the sale out of the order's cost of sales and a
//     'waste' row takes it as waste — lots and currentStock do not change (the
//     food is gone either way).
//   - One WasteLog per item (tenantId, brand, outlet, orderItemId, the FIFO
//     value in estimatedCostCents), and ONE journal entry Dr 5040 Waste /
//     Cr the class inventory (1210 / 1220 / 1230 — packaging included) in the
//     ORDER's company, keyed 'pos.void_waste:<orderItemId>' (postVoidWaste),
//     posted behind a savepoint. A refusal (closed period, missing account)
//     leaves the waste logs standing and is returned as postingError: the
//     caller flags it AFTER commit (flagPostingFailed) and Reconciliation →
//     Backfill unposted re-posts the SAME entry and key through postVoidWaste.
//
// An order depleted before its company's FIFO cut-over (its depletion row
// holds the old `taken` JSON, no lot movements) takes the legacy path: the
// quantity comes off the JSON's `taken` (so a later cancel does not return
// it), the waste is valued at the item's current cost, and the same entry is
// posted.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { withSavepoint } from '../../lib/savepoint.js'
import { CLASS_ACCOUNTS, CLASS_LABEL, COST_CLASSES, costClassOf, type CostClass } from '../../lib/inventoryClass.js'
import { relabelToWasteTx, STOCK_EPS, STOCK_SOURCE, type MovementRow } from '../../lib/stockLedger.js'
import { consumptionPerLine } from '../../lib/recipeCost.js'
import { postJournalEntry, withLateNote, ACCT, type JournalLineInput, type RepostOptions } from '../accounting/journal.js'
import { orderCostBookedAt } from '../accounting/cogs.js'

type Tx = Prisma.TransactionClient

/** The depletion / restore claim rows of an order (modules/orders/stock.ts). */
const STOCK_DEPLETE = 'stock.sale_deplete'
const STOCK_RESTORE = 'stock.sale_restore'

export const VOID_WASTE_REASONS = ['void_after_fire', 'cancelled_after_fire', 'returned_food'] as const
export type VoidWasteReason = typeof VOID_WASTE_REASONS[number]
/** Returned / refused food — PARKED with the delivery work: nothing writes it in wave B. */
export const RETURN_WASTE_REASON = 'returned_food' as const
/** @deprecated the till void's reason; kept for older importers (reconciliation backfill). Use VOID_WASTE_REASONS. */
export const VOID_WASTE_REASON = 'void_after_fire'
export const VOID_WASTE_SOURCE = 'pos.void_waste'

const REASON_LABEL: Record<VoidWasteReason, string> = {
  void_after_fire: 'voided after firing',
  cancelled_after_fire: 'cancelled after firing',
  returned_food: 'returned food',
}

/**
 * The movement kinds that make up a sold line's draw on the lots: its sale
 * rows, a late receipt's settle of its shortfall (drawn for the line from the
 * new lot — already in cost of sales by the settle's own posting), and what
 * was already given back or relabelled. Giving a settled draw back (or
 * wasting it) nets that posting only when the order's own booking reads the
 * sale_return / sale_void later (cogsLinesForOrders); when the order was
 * booked before, the give-back books itself against cost of sales, and when
 * it is cancelled without ever being booked, the cancel takes every settle of
 * the order back out of cost of sales ('order.cancel_settle' —
 * orders/stock.ts).
 */
const LINE_KINDS = ['sale', 'shortfall_settle', 'sale_return', 'sale_void'] as const
const DRAW_KINDS: ReadonlySet<string> = new Set(['sale', 'shortfall_settle'])

const asClass = (v: string): CostClass => ((COST_CLASSES as readonly string[]).includes(v) ? (v as CostClass) : 'food')

/**
 * What a sold line still has out of each lot: its 'sale' (and
 * 'shortfall_settle') rows net of its 'sale_return' and 'sale_void' rows, per
 * (item, lot), as rows returnToLotsTx
 * and relabelToWasteTx take (signed out: qty and value negative; id = one of
 * the line's sale rows of that lot, so the original order / line / brand /
 * outlet are copied). Lot-less shortfall rows have nothing to give back.
 * `saleSourceTypes` / `returnSourceTypes` narrow which rows count (the
 * "Box given" packaging rows and their undo); the default is every row of the
 * line.
 */
export async function lineNetOutRowsTx(tx: Tx, a: {
  tenantId: string; orderItemId: string; saleSourceTypes?: string[]; returnSourceTypes?: string[]
}): Promise<MovementRow[]> {
  const rows = await tx.stockMovement.findMany({
    where: { tenantId: a.tenantId, orderItemId: a.orderItemId, kind: { in: [...LINE_KINDS] }, lotId: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, sourceType: true, lotId: true, inventoryItemId: true, qty: true, valueCents: true, costClass: true },
  })
  const net = new Map<string, { itemId: string; lotId: string; qty: number; value: number; saleId: string | null; costClass: CostClass }>()
  for (const r of rows) {
    const draw = DRAW_KINDS.has(r.kind)
    if (draw && a.saleSourceTypes && !a.saleSourceTypes.includes(r.sourceType)) continue
    if (!draw && a.returnSourceTypes && !a.returnSourceTypes.includes(r.sourceType)) continue
    const key = `${r.inventoryItemId}|${r.lotId}`
    const g = net.get(key) ?? { itemId: r.inventoryItemId, lotId: r.lotId!, qty: 0, value: 0, saleId: null, costClass: asClass(r.costClass) }
    g.qty += r.qty
    g.value += toCents(r.valueCents)
    if (draw && !g.saleId) g.saleId = r.id
    net.set(key, g)
  }
  const out: MovementRow[] = []
  for (const g of net.values()) {
    const outQty = -g.qty
    const outValue = -g.value
    if (!g.saleId || (outQty < STOCK_EPS && outValue <= 0)) continue
    out.push({ id: g.saleId, lotId: g.lotId, inventoryItemId: g.itemId, qty: -Math.max(0, outQty), valueCents: -Math.max(0, outValue), costClass: g.costClass })
  }
  return out.sort((x, y) => (x.inventoryItemId + x.lotId!).localeCompare(y.inventoryItemId + y.lotId!))
}

export interface SoldLineWasteResult {
  wasteLogIds: string[]
  /** FIFO value booked as waste (paisa). */
  wasteCostCents: number
  /** Same as wasteCostCents (the older field name the till's flagging reads). */
  costCents: number
  /** Inventory item id → quantity booked as waste (purchase units). */
  wasted: Record<string, number>
  entryId: string | null
  /** Why nothing was booked, when nothing was. */
  skipped: 'not_depleted' | 'nothing_taken' | 'no_company' | null
  /** The ledger refused the entry (e.g. PERIOD_LOCKED) — flag it after commit. */
  postingError?: AppError
}

const noneResult = (skipped: SoldLineWasteResult['skipped']): SoldLineWasteResult =>
  ({ wasteLogIds: [], wasteCostCents: 0, costCents: 0, wasted: {}, entryId: null, skipped })

/**
 * Book a sold, fired line as waste inside the caller's transaction (see the
 * header). `tenantId` is the ORDER's company; `conceptId` its brand (the
 * waste's brand). Idempotent: a line with nothing left out books nothing.
 */
export async function wasteSoldLineTx(tx: Tx, a: {
  orderId: string
  tenantId: string | null
  line: { id: string }
  wasteReason: VoidWasteReason
  actorId: string | null
  conceptId: string | null
  approverId?: string | null
  photoUrl?: string | null
  /** Free text appended to the waste logs' notes (the void's reason). */
  note?: string | null
}): Promise<SoldLineWasteResult> {
  if (!(VOID_WASTE_REASONS as readonly string[]).includes(a.wasteReason)) {
    throw new AppError('BAD_WASTE_REASON', `'${a.wasteReason}' is not a sold-line waste reason`, 500)
  }
  if (!a.tenantId) return noneResult('no_company')
  const tenantId = a.tenantId
  const [depleted, restoredAll] = await Promise.all([
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: a.orderId, action: STOCK_DEPLETE }, select: { id: true, metadata: true } }),
    tx.auditLog.findFirst({ where: { entity: 'Order', entityId: a.orderId, action: STOCK_RESTORE }, select: { id: true } }),
  ])
  if (!depleted || restoredAll) return noneResult('not_depleted')

  const line = await tx.orderItem.findUnique({
    where: { id: a.line.id },
    select: {
      id: true, orderId: true, name: true, quantity: true, menuItemId: true, serviceVessel: true, boxGiven: true,
      modifiers: { select: { modifierId: true } },
      order: { select: { locationId: true, fulfilmentType: true, concept: { select: { serviceVessel: true } } } },
    },
  })
  if (!line || line.orderId !== a.orderId) throw new AppError('ORDER_ITEM_NOT_FOUND', `Order line ${a.line.id} is not on order ${a.orderId}`, 404)
  const label = REASON_LABEL[a.wasteReason]
  const notes = `${line.quantity} × ${line.name} ${label} (order ${a.orderId}, line ${line.id})${a.note ? `. Reason: ${a.note}` : ''}`.slice(0, 1000)

  // ── What the line has out, per item (FIFO: its net-out rows; legacy: the JSON) ──
  const meta = (depleted.metadata ?? {}) as Record<string, unknown>
  const fifo = meta.mode === 'fifo'
  let rows: MovementRow[] = []
  const byItem = new Map<string, { qty: number; value: number; costClass: CostClass }>()
  if (fifo) {
    rows = await lineNetOutRowsTx(tx, { tenantId, orderItemId: line.id })
    for (const r of rows) {
      const g = byItem.get(r.inventoryItemId) ?? { qty: 0, value: 0, costClass: r.costClass }
      g.qty += Math.abs(r.qty)
      g.value += Math.abs(r.valueCents)
      byItem.set(r.inventoryItemId, g)
    }
  } else {
    const legacy = meta as { taken?: Record<string, number>; takenAtSale?: Record<string, number>; voidWasted?: Record<string, Record<string, number>> }
    if (legacy.voidWasted?.[line.id]) return noneResult('nothing_taken')
    const [per] = await consumptionPerLine([{
      id: line.id, menuItemId: line.menuItemId, quantity: line.quantity, status: 'pending',
      modifierIds: line.modifiers.map((m) => m.modifierId), serviceVessel: line.serviceVessel, boxGiven: line.boxGiven,
    }], tx, { tenantId, fulfilmentType: line.order.fulfilmentType, serviceVessel: line.order.concept.serviceVessel })
    const taken = { ...(legacy.taken ?? {}) }
    const wasted: Record<string, number> = {}
    for (const [id, r] of per?.need ?? []) {
      const out = taken[id] ?? 0
      const w = Math.min(r.qty, out)
      if (w > 0) {
        wasted[id] = w
        taken[id] = out - w
      }
    }
    if (Object.keys(wasted).length === 0) return noneResult('nothing_taken')
    await tx.auditLog.update({
      where: { id: depleted.id },
      data: {
        metadata: {
          ...meta, takenAtSale: legacy.takenAtSale ?? legacy.taken ?? {}, taken,
          voidWasted: { ...(legacy.voidWasted ?? {}), [line.id]: wasted },
        } as Prisma.InputJsonValue,
      },
    })
    const items = await tx.inventoryItem.findMany({ where: { id: { in: Object.keys(wasted) } }, select: { id: true, unitCostCents: true, category: true } })
    for (const it of items) {
      const q = wasted[it.id]!
      byItem.set(it.id, { qty: q, value: it.unitCostCents ? Math.round(it.unitCostCents * q) : 0, costClass: costClassOf(it.category) })
    }
  }
  if (byItem.size === 0) return noneResult('nothing_taken')

  const items = await tx.inventoryItem.findMany({ where: { id: { in: [...byItem.keys()] } }, select: { id: true, unit: true } })
  const unitOf = new Map(items.map((i) => [i.id, i.unit]))
  const wasteLogIdByItem: Record<string, string> = {}
  const wasteLogIds: string[] = []
  const wasted: Record<string, number> = {}
  let cost = 0
  for (const itemId of [...byItem.keys()].sort()) {
    const g = byItem.get(itemId)!
    const log = await tx.wasteLog.create({
      data: {
        tenantId, conceptId: a.conceptId, locationId: line.order.locationId, orderItemId: line.id,
        inventoryItemId: itemId, quantity: g.qty, unit: unitOf.get(itemId) ?? '',
        reason: a.wasteReason, estimatedCostCents: g.value,
        approvedById: a.approverId ?? null, recordedById: a.actorId, photoUrl: a.photoUrl ?? null, notes,
      },
      select: { id: true },
    })
    wasteLogIdByItem[itemId] = log.id
    wasteLogIds.push(log.id)
    wasted[itemId] = g.qty
    cost += g.value
  }
  if (fifo) {
    await relabelToWasteTx(tx, { rows, wasteLogIdByItem, conceptId: a.conceptId, occurredAt: new Date(), tenantId, createdById: a.actorId })
  }

  let entryId: string | null = null
  let postingError: AppError | undefined
  if (cost > 0) {
    const r = await withSavepoint(tx, 'sold_line_waste_posting', () =>
      postVoidWaste(tenantId, line.id, wasteLogIds, a.conceptId, { tx, postedBy: a.actorId ?? 'system' }))
    if (r.ok) entryId = r.value.entryId
    else postingError = r.error instanceof AppError ? r.error : new AppError('POSTING_FAILED', r.error.message, 500)
  }
  return { wasteLogIds, wasteCostCents: cost, costCents: cost, wasted, entryId, skipped: null, ...(postingError ? { postingError } : {}) }
}

/**
 * The till void's older entry point (a fired line voided) — same as
 * wasteSoldLineTx with reason 'void_after_fire'.
 */
export async function wasteVoidedFiredLineTx(tx: Tx, input: {
  orderId: string
  tenantId: string | null
  conceptId: string | null
  line: { id: string; name?: string; menuItemId?: string | null; quantity?: number }
  actorId: string
  approverId: string | null
  reason: string
}): Promise<SoldLineWasteResult> {
  return wasteSoldLineTx(tx, {
    orderId: input.orderId, tenantId: input.tenantId, line: { id: input.line.id }, wasteReason: 'void_after_fire',
    actorId: input.actorId, conceptId: input.conceptId, approverId: input.approverId, note: input.reason,
  })
}

/**
 * THE sold-line waste entry: Dr 5040 Waste per waste log (its FIFO value,
 * estimatedCostCents) / Cr the class inventory (1210 / 1220 / 1230 — the
 * class of the lots it relabelled, else the item's category), in `tenantId`
 * (the order's company), keyed 'pos.void_waste:<orderItemId>' — so the live
 * void / cancel and a re-post by Reconciliation → Backfill unposted can never
 * both book it.
 *
 * When the order's cost of sales was booked BEFORE the waste (a drawer close
 * took the open ticket as a live sale — accounting/cogs.ts orderCostBookedAt
 * at or before the log's recordedAt), that close already credited the
 * inventory: the log's credit goes to the class COST OF SALES instead
 * (5010 / 5020 / 5030 — a reclass Dr 5040 / Cr 50x0). Re-derived the same way
 * on a re-post, so both book the same lines.
 *
 * Only this line's sold-line waste logs count (a reason in VOID_WASTE_REASONS,
 * the line on WasteLog.orderItemId — or, for logs written before wave B, in
 * the note), restricted to `wasteLogIds` when any are given, and never
 * another company's item. Dated now unless `entryDate` is given; `memoNote`
 * names the original date when it is re-posted into the open month (owner
 * decision 6). Throws what postJournalEntry throws (PERIOD_LOCKED,
 * ACCOUNT_NOT_FOUND, …).
 */
export async function postVoidWaste(
  tenantId: string,
  orderItemId: string,
  wasteLogIds: string[],
  conceptId: string | null,
  opts: RepostOptions & { tx?: Tx } = {},
): Promise<{ posted: boolean; entryId: string | null; reason?: string; costCents: number }> {
  const db = opts.tx ?? prisma
  const line = await db.orderItem.findUnique({ where: { id: orderItemId }, select: { name: true, quantity: true, orderId: true } })
  if (!line) return { posted: false, entryId: null, reason: 'order_item_not_found', costCents: 0 }
  const logs = await db.wasteLog.findMany({
    where: {
      reason: { in: [...VOID_WASTE_REASONS] },
      OR: [{ orderItemId }, { orderItemId: null, notes: { contains: orderItemId } }],
      ...(wasteLogIds.length > 0 ? { id: { in: wasteLogIds } } : {}),
    },
    select: { id: true, reason: true, estimatedCostCents: true, recordedAt: true, inventoryItem: { select: { name: true, tenantId: true, category: true } } },
    orderBy: { id: 'asc' },
  })
  if (logs.length === 0) return { posted: false, entryId: null, reason: 'zero_cost', costCents: 0 }
  const moves = await db.stockMovement.findMany({
    where: { tenantId, sourceType: STOCK_SOURCE.wasteLog, sourceId: { in: logs.map((l) => l.id) }, kind: 'waste' },
    select: { sourceId: true, costClass: true },
  })
  const classOfLog = new Map(moves.map((m) => [m.sourceId, asClass(m.costClass)]))
  const bookedAt = await orderCostBookedAt(db, tenantId, line.orderId)
  const debits: JournalLineInput[] = []
  const credits = new Map<CostClass, number>()
  const cogsCredits = new Map<CostClass, number>()
  let costCents = 0
  const reasons = new Set<string>()
  for (const log of logs) {
    const cost = log.estimatedCostCents ?? 0
    // Never value another company's stock into this company's books.
    if (cost <= 0 || (log.inventoryItem.tenantId && log.inventoryItem.tenantId !== tenantId)) continue
    const cls = classOfLog.get(log.id) ?? costClassOf(log.inventoryItem.category)
    const why = REASON_LABEL[log.reason as VoidWasteReason] ?? log.reason
    reasons.add(why)
    costCents += cost
    const into = bookedAt && bookedAt <= log.recordedAt ? cogsCredits : credits
    into.set(cls, (into.get(cls) ?? 0) + cost)
    debits.push({ accountCode: ACCT.WASTE, type: 'debit', amountCents: cost, memo: `Waste (${why}): ${log.inventoryItem.name}`.slice(0, 250), conceptId })
  }
  if (costCents <= 0) return { posted: false, entryId: null, reason: 'zero_cost', costCents: 0 }
  const lines: JournalLineInput[] = [...debits]
  for (const c of COST_CLASSES) {
    const v = credits.get(c) ?? 0
    if (v > 0) lines.push({ accountCode: CLASS_ACCOUNTS[c].inv, type: 'credit', amountCents: v, memo: `Inventory derecognised (${CLASS_LABEL[c]}, sold-line waste)`, conceptId })
    const b = cogsCredits.get(c) ?? 0
    if (b > 0) lines.push({ accountCode: CLASS_ACCOUNTS[c].cogs, type: 'credit', amountCents: b, memo: `Cost of sales already booked — now waste (${CLASS_LABEL[c]}, sold-line waste)`, conceptId })
  }
  const dr = lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const cr = lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  if (dr !== cr) throw new AppError('JOURNAL_UNBALANCED', `${VOID_WASTE_SOURCE}:${orderItemId}: debits (${dr}) ≠ credits (${cr})`, 500)
  const late = withLateNote(`Waste — ${line.quantity} × ${line.name} ${[...reasons].join(' / ')}`, lines, opts.memoNote)
  const r = await postJournalEntry({
    tenantId,
    sourceType: VOID_WASTE_SOURCE,
    sourceId: orderItemId,
    description: late.description,
    entryDate: opts.entryDate ?? new Date(),
    postedBy: opts.postedBy ?? 'system',
    lines: late.lines,
  }, { tx: opts.tx })
  return { posted: r.posted, entryId: r.entryId, costCents }
}
