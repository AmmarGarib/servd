// Food bought with cash (a petty-cash spend, a cash-request settlement) enters
// stock here — decision P6, one stock-in contract (critic). A THIN caller of
// procurement/receiving.ts receiveGoodsTx: a no-PO receipt from the company's
// system supplier 'Cash purchases', its lines born billed, unique per cash
// document, at exactly the amount paid per line.
//
// It posts NOTHING: the cash document's own entry carries Dr 12x0 (the
// accountCode returned per line, by the item's class) / Cr its cash account
// (1011 box / 1355 advance) for exactly these values, so the receipt adds no
// 2015 and the books and the lots agree to the paisa.
//
// The caller (w3 cash requests / petty cash) calls ensureFifoReady(tenantId)
// before opening its transaction and restricts stock lines to stock keepers.

import type { Prisma } from '@prisma/client'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertMoneyFits } from '../../lib/money.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { CLASS_ACCOUNTS, costClassOf, zeroByClass, type CostClass } from '../../lib/inventoryClass.js'
import { receiveGoodsTx, type SettledBy } from '../procurement/receiving.js'

type Tx = Prisma.TransactionClient

export interface CashPurchaseLine {
  /** The cash document's own line id (returned with its receipt line). */
  spendLineId: string
  inventoryItemId: string
  qty: number
  /** The unit the quantity was bought in; converted to the item's purchase unit (422 UNIT_MISMATCH). */
  unit: string
  /** What was paid for the line — the lot's exact value. */
  totalCents: number
}

export interface CashPurchaseResult {
  goodsReceiptId: string
  lines: Array<{ spendLineId: string; receiptLineId: string; accountCode: string; valueCents: number }>
  byClass: Record<CostClass, number>
}

/**
 * Bring cash-bought food into stock as FIFO lots (header), in the cash
 * document's transaction. Items must be the company's (another company's or
 * an unknown one is 404). A second call for the same cash document is 409
 * ALREADY_RECEIVED (the receipt is unique per document).
 */
export async function recordCashPurchaseStockTx(tx: Tx, a: {
  tenantId: string
  settledBy: SettledBy
  lines: CashPurchaseLine[]
  locationId?: string | null
  occurredAt: Date
  actorId: string
}): Promise<CashPurchaseResult> {
  if (!a.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — stock belongs to one company', 422)
  if (a.lines.length === 0) throw new AppError('NO_LINES', 'No stock lines to bring in', 400)
  const ids = [...new Set(a.lines.map((l) => l.inventoryItemId))]
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: ids }, tenantId: a.tenantId, deletedAt: null },
    select: { id: true, name: true, unit: true, category: true },
  })
  const byId = new Map(items.map((i) => [i.id, i]))
  const prepared = a.lines.map((l) => {
    const item = byId.get(l.inventoryItemId)
    // Another company's item is as unknown as a missing one.
    if (!item) throw new NotFoundError('InventoryItem', l.inventoryItemId)
    if (!Number.isFinite(l.qty) || !(l.qty > 0)) throw new AppError('INVALID_QTY', `${item.name}: the quantity must be more than zero`, 400)
    if (!Number.isInteger(l.totalCents) || l.totalCents < 0) throw new AppError('INVALID_AMOUNT', `${item.name}: the amount must be whole paisa, zero or more`, 400)
    assertMoneyFits(l.totalCents, `${item.name}'s amount`)
    const qty = toPurchaseUnits(l.qty, l.unit, item.unit)
    if (qty == null || !(qty > 0)) {
      throw new AppError('UNIT_MISMATCH', `${item.name} is counted in ${item.unit} — ${l.unit} cannot be converted to it`, 422)
    }
    return { l, item, qty }
  })

  const done = await receiveGoodsTx(tx, {
    tenantId: a.tenantId,
    locationId: a.locationId ?? null,
    receivedById: a.actorId,
    receivedAt: a.occurredAt,
    settledBy: a.settledBy,
    notes: `Bought with cash (${a.settledBy.kind === 'petty_cash_movement' ? 'petty cash' : 'cash request'})`,
    lines: prepared.map((p) => ({
      inventoryItemId: p.item.id,
      receivedQty: p.qty,
      unit: p.item.unit,
      valueCents: p.l.totalCents,
      description: p.item.name,
    })),
  })

  const byClass = zeroByClass()
  const lines = prepared.map((p, i) => {
    const r = done.lines[i]!
    const cls = costClassOf(p.item.category)
    byClass[cls] += p.l.totalCents
    if (r.valueCents !== p.l.totalCents) {
      throw new AppError('CASH_PURCHASE_VALUE_MISMATCH', `${p.item.name}: the lot came to ${r.valueCents}, the cash line to ${p.l.totalCents}`, 500)
    }
    return { spendLineId: p.l.spendLineId, receiptLineId: r.receiptLineId, accountCode: CLASS_ACCOUNTS[cls].inv, valueCents: p.l.totalCents }
  })
  return { goodsReceiptId: done.receiptId, lines, byClass }
}
