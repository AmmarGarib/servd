// Goods receiving — THE one path that brings stock in from outside (finance
// wave B: FIFO lots + GRNI, H16 / H17; owner decision 30's moving average is
// replaced by lots at the price actually paid).
//
// Every caller — the dock page (POST /crosschecks/receiving), the PO receive
// route, and the cash areas (inventory/cashPurchase.ts for food bought with
// petty cash or a cash request) — ends in receiveGoodsTx(), which in the
// caller's transaction:
//   - writes the GoodsReceipt (tenantId = the receiving company, locationId =
//     one of ITS locations, else 422 LOCATION_NOT_IN_COMPANY) and its lines;
//   - opens the FIFO lots of each line through lib/stockLedger.ts addLotTx — a
//     line may open SEVERAL lots: quantity a supplier bill already charged for
//     (a pending GrniMatch on the PO line, oldest bill first) opens a lot at
//     the BILLED price and the match turns 'live' ('<lineId>:<matchId>'); the
//     rest opens one lot at the PO price ('<lineId>:po') or the price entered
//     at the dock ('<lineId>:dock'). lotUnitCostCents stores the cost of the
//     line's still-unbilled quantity. addLotTx records the purchase price
//     (ItemPriceHistory), settles recent sale shortfalls and issues
//     issue-on-receipt items;
//   - a line without a PO typed in the item's purchase unit (InventoryItem.purchaseUnit, e.g. "case") becomes
//     quantity × purchaseUnitFactor stock units at unit cost ÷ factor (owner 2026-10-24); PO lines stay in stock units;
//   - against a PO: raises PurchaseOrderLine.quantityReceived;
//   - posts 'procurement.receipt:<receiptId>' Dr 12x0 per class / Cr 2015
//     (accounting/inventoryPosting.ts postGoodsReceiptTx) — a pending-bill
//     quantity is credited at the billed price, netting that bill's Dr 2015.
// receiveGoods() (the dock and PO routes) wraps it: request checks,
// ensureFifoReady, ONE transaction (PO lock, receiveGoodsTx, discrepancy log,
// PO status + activity log), then the variance / short-shipment flags after
// commit.
//
// Company: the supplier's company receives. A supplier or item with no
// company is refused on EVERY path (422 SUPPLIER_HAS_NO_COMPANY /
// ITEM_HAS_NO_COMPANY), an item of another company is 422 ITEM_NOT_IN_COMPANY.
//
// Cash-settled receipts (decision P6): `settledBy` names the cash document
// (a petty-cash movement or a cash-request settlement). The supplier is the
// company's system supplier 'Cash purchases' (ensureCashPurchaseSupplier —
// never listed, never billed), the lines are born billed (billedQty =
// receivedQty), the receipt is unique per cash document (the same food can't
// come in twice) and it posts NOTHING — the cash document's own entry carries
// Dr 12x0 / Cr its cash account.
//
// Owner decision 27 (2026-09-27), receiveGoods only:
//   - receiving WITHOUT a PO is allowed (market runs, ad-hoc deliveries), but
//     the unit cost must be entered at the dock;
//   - only manager tiers may receive (MANAGERS);
//   - whoever raised the PO cannot receive it — everyone except the CEO.
// A cash-settled receipt is not a delivery taken at the dock: the cash area
// restricts its stock lines to stock keepers itself.

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { flagException, type ExceptionKind } from '../../lib/exceptions.js'
import { assertNotSelfApproval } from '../../lib/separation-of-duties.js'
import { getOperationsConfig } from '../../lib/setup-config.js'
import { MANAGERS } from '../auth/middleware.js'
import { assertInt4Fits, assertMoneyFits, toCents } from '../../lib/money.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { costClassOf, type CostClass } from '../../lib/inventoryClass.js'
import { addLotTx, ensureFifoReady, lockItemsTx, STOCK_SOURCE } from '../../lib/stockLedger.js'
import { postGoodsReceiptTx } from '../accounting/inventoryPosting.js'
import { writeRecordFilesTx, type DecodedRecordFile, type RecordFileMeta } from '../../lib/recordFiles.js'
import { audit } from '../../lib/audit.js'
import { useByForReceipt } from '../../lib/useBy.js'

/** Line variance above this (either way) raises an exception flag. */
export const RECEIVING_VARIANCE_THRESHOLD = 0.05   // 5%

/**
 * A PO can be received only once it has been approved AND sent — emailed /
 * WhatsApped (sendPoToSupplier) or marked sent by whoever phoned it in
 * (markPoSent). Approval alone no longer stamps 'sent'.
 */
export const RECEIVABLE_PO_STATUSES = ['sent', 'partial'] as const

/** Supplier.systemKind of the company's cash-purchases supplier (decision P6). */
export const CASH_PURCHASE_SUPPLIER_KIND = 'cash_purchases'

export type DiscrepancyReason = 'short_shipment' | 'over_shipment' | 'damaged' | 'wrong_item' | 'quality_issue'

type Tx = Prisma.TransactionClient
const EPS = 1e-9

// ─── receiveGoodsTx — the one stock-in contract ──────────────────────────────

export interface SettledBy {
  kind: 'petty_cash_movement' | 'cash_voucher_settlement'
  id: string
  /** The credit side the cash document books (1011 box / 1355 advance). */
  creditAccountCode: string
}

export interface ReceiveGoodsInput {
  tenantId: string
  supplierId?: string
  poId?: string
  locationId?: string | null
  receivedById: string
  receivedAt?: Date
  lines: Array<{
    inventoryItemId: string
    receivedQty: number
    unit: string
    /** Per `unit`. Required without a PO line (the dock price); a PO line uses its PO price. */
    unitCostCents?: number
    poLineId?: string
    description?: string
    /** Book exactly this value for the line (a cash buy's total) instead of quantity × unit cost. */
    valueCents?: number
    /** Receipt-line extras the dock / PO routes record. */
    poQty?: number | null
    variancePct?: number | null
    notes?: string | null
    /** Use-by day 'YYYY-MM-DD' (owner B6, 2026-10-26) — stored on the line's lots. See lib/useBy.ts. */
    useBy?: string | null
  }>
  /** The dock and the PO receive (owner B6): a perishable line with no shelf life must carry a use-by (422
   *  USE_BY_REQUIRED). A cash buy (petty cash / cash request) records one only when typed or defaulted. */
  requireUseBy?: boolean
  settledBy?: SettledBy
  /** Receipt extras the dock / PO routes record. */
  photoUrl?: string | null
  notes?: string | null
  status?: string
  varianceFlag?: boolean
}

export interface ReceiveGoodsTxResult {
  receiptId: string
  lines: Array<{ receiptLineId: string; lotIds: string[]; valueCents: number; costClass: CostClass }>
}

/**
 * The company's system supplier of cash-bought goods ('Cash purchases',
 * Supplier.systemKind 'cash_purchases'), created on first use. Never listed,
 * never billed. Race-safe (ON CONFLICT on the per-company unique key).
 */
export async function ensureCashPurchaseSupplier(tx: Tx, tenantId: string): Promise<{ id: string }> {
  const found = await tx.supplier.findFirst({ where: { tenantId, systemKind: CASH_PURCHASE_SUPPLIER_KIND }, select: { id: true } })
  if (found) return found
  await tx.$executeRaw`
    INSERT INTO suppliers (id, "tenantId", name, "systemKind", notes, "updatedAt")
    VALUES (${randomUUID()}, ${tenantId}, 'Cash purchases', ${CASH_PURCHASE_SUPPLIER_KIND},
            'System supplier: food bought with petty cash or a cash request (never billed)', now())
    ON CONFLICT ("tenantId", "systemKind") DO NOTHING`
  return tx.supplier.findFirstOrThrow({ where: { tenantId, systemKind: CASH_PURCHASE_SUPPLIER_KIND }, select: { id: true } })
}

/**
 * Bring goods in (header): receipt + lines + lots + pending-bill settlement +
 * PO quantities + 'procurement.receipt' posting, in the caller's
 * transaction. The caller has called ensureFifoReady(tenantId) BEFORE opening
 * it. Refusals: 422 SUPPLIER_HAS_NO_COMPANY / ITEM_HAS_NO_COMPANY /
 * ITEM_NOT_IN_COMPANY / LOCATION_NOT_IN_COMPANY / UNIT_MISMATCH /
 * UNIT_COST_REQUIRED; 404 an unknown item / supplier / PO line; 409
 * ALREADY_RECEIVED for a cash document already received.
 */
export async function receiveGoodsTx(tx: Tx, input: ReceiveGoodsInput): Promise<ReceiveGoodsTxResult> {
  const tenantId = input.tenantId
  if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Goods are received into a company — none was given', 422)
  if (input.lines.length === 0) throw new AppError('NO_LINES', 'Nothing to receive', 400)
  const settled = input.settledBy ?? null
  if (settled && input.poId) throw new AppError('SETTLED_RECEIPT_NO_PO', 'Goods bought with cash are received without a purchase order', 400)

  // ── Supplier ──
  let supplierId: string
  if (settled) {
    supplierId = (await ensureCashPurchaseSupplier(tx, tenantId)).id
    const dup = await tx.goodsReceipt.findFirst({ where: { tenantId, settledByType: settled.kind, settledById: settled.id }, select: { id: true } })
    if (dup) throw new AppError('ALREADY_RECEIVED', 'The goods of this cash document are already in stock', 409, { goodsReceiptId: dup.id })
  } else {
    let sid = input.supplierId ?? null
    if (input.poId) {
      // The PO's lock serialises receipts and bills of its lines (pending matches).
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${input.poId} FOR UPDATE`
      const po = await tx.purchaseOrder.findUnique({ where: { id: input.poId }, select: { supplierId: true } })
      if (!po) throw new NotFoundError('PurchaseOrder', input.poId)
      if (sid && sid !== po.supplierId) throw new AppError('SUPPLIER_MISMATCH', 'That PO belongs to a different supplier', 400)
      sid = po.supplierId
    }
    if (!sid) throw new AppError('SUPPLIER_REQUIRED', 'Pick the supplier for a delivery without a PO', 400)
    const supplier = await tx.supplier.findUnique({ where: { id: sid }, select: { id: true, name: true, tenantId: true } })
    if (!supplier) throw new NotFoundError('Supplier', sid)
    if (!supplier.tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', `Assign ${supplier.name} to a company before receiving from it`, 422)
    if (supplier.tenantId !== tenantId) throw new AppError('SUPPLIER_NOT_IN_COMPANY', `${supplier.name} belongs to a different company`, 422)
    supplierId = supplier.id
  }

  // ── Location: one of the receiving company's ──
  if (input.locationId) {
    const loc = await tx.location.findFirst({ where: { id: input.locationId, deletedAt: null }, select: { tenantId: true } })
    if (!loc || loc.tenantId !== tenantId) {
      throw new AppError('LOCATION_NOT_IN_COMPANY', 'That outlet is not one of this company\'s', 422)
    }
  }

  // ── Items + PO lines ──
  const itemIds = [...new Set(input.lines.map((l) => l.inventoryItemId))]
  const items = await tx.inventoryItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, name: true, unit: true, tenantId: true, category: true, purchaseUnit: true, purchaseUnitFactor: true, perishable: true, shelfLifeDays: true },
  })
  const itemById = new Map(items.map((i) => [i.id, i]))
  for (const id of itemIds) {
    const it = itemById.get(id)
    if (!it) throw new NotFoundError('InventoryItem', id)
    if (!it.tenantId) throw new AppError('ITEM_HAS_NO_COMPANY', `${it.name} belongs to no company — assign it to a company before receiving it`, 422)
    if (it.tenantId !== tenantId) throw new AppError('ITEM_NOT_IN_COMPANY', `${it.name} belongs to a different company`, 422)
  }
  const poLineIds = input.lines.map((l) => l.poLineId).filter((x): x is string => !!x)
  const poLines = poLineIds.length === 0 ? [] : await tx.purchaseOrderLine.findMany({
    where: { id: { in: poLineIds } },
    select: { id: true, purchaseOrderId: true, inventoryItemId: true, unitCostCents: true },
  })
  const poLineById = new Map(poLines.map((p) => [p.id, p]))

  interface Prepared { line: ReceiveGoodsInput['lines'][number]; item: NonNullable<ReturnType<typeof itemById.get>>; qty: number; unitCost: number | null; poLine: (typeof poLines)[number] | null; useBy: Date | null }
  const receivedAtForUseBy = input.receivedAt ?? new Date()
  const prepared: Prepared[] = input.lines.map((l) => {
    const item = itemById.get(l.inventoryItemId)!
    if (!Number.isFinite(l.receivedQty) || l.receivedQty < 0) throw new AppError('INVALID_QTY', 'Received quantity must be zero or more', 400)
    let poLine: Prepared['poLine'] = null
    if (l.poLineId) {
      poLine = poLineById.get(l.poLineId) ?? null
      if (!poLine) throw new NotFoundError('PurchaseOrderLine', l.poLineId)
      if ((input.poId && poLine.purchaseOrderId !== input.poId) || poLine.inventoryItemId !== item.id) {
        throw new AppError('LINE_NOT_ON_PO', `Line ${l.poLineId} is not ${item.name} on this purchase order`, 400)
      }
    }
    // Quantities are held in the item's purchase unit.
    let qty = l.receivedQty
    let exactValue: number | null = null
    let unitCost: number | null = poLine ? poLine.unitCostCents : (l.unitCostCents ?? null)
    const norm = (u: string | null | undefined) => (u ?? '').trim().toLowerCase()
    if (!poLine && l.unit && item.purchaseUnit && norm(l.unit) === norm(item.purchaseUnit) && norm(l.unit) !== norm(item.unit)) {
      // Typed in the item's PURCHASE unit (owner 2026-10-24: "units"): qty × factor stock units, cost ÷ factor.
      const f = item.purchaseUnitFactor > 0 ? item.purchaseUnitFactor : 1
      qty = l.receivedQty * f
      // The lot is worth exactly what was typed (cost per purchase unit × purchase units), never the rounded unit cost × qty.
      if (unitCost != null && l.valueCents == null) exactValue = Math.round(unitCost * l.receivedQty)
      if (unitCost != null) unitCost = Math.round(unitCost / f)
    } else if (!poLine && l.unit && l.unit !== item.unit) {
      const pu = toPurchaseUnits(l.receivedQty, l.unit, item.unit)
      if (pu == null) throw new AppError('UNIT_MISMATCH', `${item.name} is counted in ${item.unit} — ${l.unit} cannot be converted to it`, 422)
      if (unitCost != null && pu > EPS) unitCost = Math.round((unitCost * l.receivedQty) / pu)
      qty = pu
    }
    if (qty > EPS && l.valueCents != null) {
      if (!Number.isInteger(l.valueCents) || l.valueCents < 0) throw new AppError('INVALID_AMOUNT', `${item.name}: the value must be whole paisa, zero or more`, 400)
      assertMoneyFits(l.valueCents, `${item.name}'s value`)
      unitCost = Math.round(l.valueCents / qty)
    }
    if (qty > EPS && (unitCost == null || !Number.isInteger(unitCost) || unitCost < 0)) {
      throw new AppError('UNIT_COST_REQUIRED', `Enter the unit cost paid for ${item.name}`, 400)
    }
    if (unitCost != null) {
      assertInt4Fits(unitCost, `${item.name}'s unit cost`)
      assertMoneyFits(Math.round(unitCost * qty), `${item.name} (quantity × unit cost)`)
    }
    if (exactValue != null) assertMoneyFits(exactValue, `${item.name}'s value`)
    // Use-by (owner B6): only for a line that brings stock in.
    const useBy = qty > EPS ? useByForReceipt(item, l.useBy, receivedAtForUseBy, input.requireUseBy === true) : null
    return { line: exactValue != null ? { ...l, valueCents: exactValue } : l, item, qty, unitCost, poLine, useBy }
  })

  // Every item's row, locked in id order, before the first lot is written.
  await lockItemsTx(tx, itemIds)

  const receivedAt = receivedAtForUseBy
  let receipt: { id: string }
  try {
    receipt = await tx.goodsReceipt.create({
      data: {
        poId:               input.poId ?? null,
        supplierId,
        receivedById:       input.receivedById,
        receivedAt,
        photoUrl:           input.photoUrl ?? null,
        notes:              input.notes ?? null,
        status:             input.status ?? 'accepted',
        varianceFlag:       input.varianceFlag ?? false,
        tenantId,
        locationId:         input.locationId ?? null,
        settledByType:      settled?.kind ?? null,
        settledById:        settled?.id ?? null,
        settledAccountCode: settled?.creditAccountCode ?? null,
      },
      select: { id: true },
    })
  } catch (err) {
    if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
      throw new AppError('ALREADY_RECEIVED', 'The goods of this cash document are already in stock', 409)
    }
    throw err
  }

  const out: ReceiveGoodsTxResult['lines'] = []
  for (const p of prepared) {
    const rl = await tx.goodsReceiptLine.create({
      data: {
        receiptId:       receipt.id,
        inventoryItemId: p.item.id,
        poLineId:        p.poLine?.id ?? null,
        description:     p.line.description ?? p.item.name,
        poQty:           p.line.poQty ?? null,
        receivedQty:     p.qty,
        poUnitCostCents: p.unitCost,
        unit:            p.item.unit,
        variancePct:     p.line.variancePct ?? null,
        notes:           p.line.notes ?? null,
        billedQty:       settled ? p.qty : 0,
      },
      select: { id: true },
    })
    const lotIds: string[] = []
    let valueCents = 0
    let restCost: number | null = null
    let pendingCost: number | null = null
    if (p.qty > EPS) {
      let left = p.qty
      let billed = 0
      const lotArgs = {
        tenantId, inventoryItemId: p.item.id, kind: 'receipt' as const, lotSourceType: 'goods_receipt_line' as const,
        movementSourceType: STOCK_SOURCE.receiptLine, movementSourceId: rl.id, receiptLineId: rl.id,
        locationId: input.locationId ?? null, receivedAt, createdById: input.receivedById, useBy: p.useBy,
      }
      // 1. Quantity a bill already charged for (oldest bill first): at the billed price.
      if (p.poLine && !settled) {
        const pending = await tx.grniMatch.findMany({
          where: { tenantId, poLineId: p.poLine.id, status: 'pending' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        for (const pm of pending) {
          if (left < EPS) break
          if (!(pm.qty > EPS)) continue
          const take = Math.min(pm.qty, left)
          const pmGrni = toCents(pm.grniCents)
          const whole = take >= pm.qty - EPS
          const part = whole ? pmGrni : Math.round((pmGrni * take) / pm.qty)
          if (!whole) {
            await tx.grniMatch.create({
              data: {
                tenantId, billId: pm.billId, billLineId: pm.billLineId, receiptLineId: null, poLineId: pm.poLineId,
                qty: pm.qty - take, billedUnitCostCents: pm.billedUnitCostCents, grniCents: pmGrni - part, status: 'pending',
              },
            })
          }
          await tx.grniMatch.update({
            where: { id: pm.id },
            data: { qty: take, grniCents: part, receiptLineId: rl.id, receiptUnitCostCents: pm.billedUnitCostCents, status: 'live', settledAt: new Date() },
          })
          const lot = await addLotTx(tx, { ...lotArgs, qty: take, unitCostCents: pm.billedUnitCostCents, valueCents: part, lotSourceId: `${rl.id}:${pm.id}` })
          lotIds.push(lot.lotId)
          valueCents += part
          pendingCost ??= pm.billedUnitCostCents
          billed += take
          left -= take
        }
      }
      // 2. The rest at the PO price, else the dock price (a cash buy: its exact total).
      if (left > EPS) {
        const exact = p.line.valueCents != null && billed === 0 ? p.line.valueCents : undefined
        const unitCost = p.unitCost ?? 0
        const value = exact ?? Math.round(left * unitCost)
        const lot = await addLotTx(tx, { ...lotArgs, qty: left, unitCostCents: unitCost, valueCents: value, lotSourceId: `${rl.id}:${p.poLine ? 'po' : 'dock'}` })
        lotIds.push(lot.lotId)
        valueCents += value
        restCost = unitCost
      }
      await tx.goodsReceiptLine.update({
        where: { id: rl.id },
        data: { lotUnitCostCents: restCost ?? pendingCost, ...(billed > 0 && !settled ? { billedQty: billed } : {}) },
      })
      if (p.poLine) {
        await tx.purchaseOrderLine.update({ where: { id: p.poLine.id }, data: { quantityReceived: { increment: p.qty } } })
      }
    }
    out.push({ receiptLineId: rl.id, lotIds, valueCents, costClass: costClassOf(p.item.category) })
  }

  // Dr 12x0 / Cr 2015 for the lots opened (a cash-settled receipt posts nothing).
  await postGoodsReceiptTx(tx, receipt.id)
  return { receiptId: receipt.id, lines: out }
}

// ─── receiveGoods — the dock page and the PO receive route ───────────────────

export interface ReceiveGoodsLine {
  /** Required on a PO receipt; must be a line of that PO. */
  poLineId?:          string | null
  /** Required on a receipt without a PO. Ignored on a PO line (the PO names the item). */
  inventoryItemId?:   string | null
  /** What arrived. 0 = the line did not arrive (logged as short). */
  quantityReceived:   number
  /**
   * Unit cost in paisa. Required on a receipt without a PO (entered at the
   * dock). On a PO line the agreed PO price opens the lot; a bill at another
   * price re-prices the lot later (accounting/supplierPosting.ts).
   */
  unitCostCents?:     number | null
  discrepancyReason?: DiscrepancyReason | null
  notes?:             string | null
  /** No-PO lines: the unit typed — the item's purchase unit (e.g. "case") converts at the dock (quantity × factor). */
  unit?:              string | null
  /** Use-by day 'YYYY-MM-DD' — required for a perishable item with no shelf life (owner B6, 422 USE_BY_REQUIRED). */
  useBy?:             string | null
}

export interface ReceiveGoodsRequest {
  actor:       { id: string; role: string }
  poId?:       string | null
  /** Required without a PO; must match the PO's supplier when both are given. */
  supplierId?: string | null
  /** The outlet the goods arrived at — one of the supplier's company's locations. */
  locationId?: string | null
  photoUrl?:   string | null
  /** Dock-door photos uploaded with the delivery (owner, 2026-10-16: files, not a URL) — already decoded
   *  by lib/recordFiles.ts decodeRecordFiles; saved as record files of the receipt in its transaction. */
  photoFiles?: DecodedRecordFile[]
  notes?:      string | null
  lines:       ReceiveGoodsLine[]
}

export interface ReceiveGoodsResult {
  receipt:  Prisma.GoodsReceiptGetPayload<{ include: { lines: true } }>
  poStatus: string | null
  flagged:  number
  /** The dock-door photos saved with it (metadata only). */
  files:    RecordFileMeta[]
}

interface PreparedLine {
  poLineId:         string | null
  inventoryItemId:  string
  description:      string
  unit:             string
  expectedQty:      number | null     // outstanding on the PO before this receipt
  orderedQty:       number | null
  alreadyReceived:  number
  quantityReceived: number
  unitCostCents:    number
  discrepancyReason: DiscrepancyReason | null
  notes:            string | null
  variancePct:      number | null
  useBy:            string | null
}

export async function receiveGoods(input: ReceiveGoodsRequest): Promise<ReceiveGoodsResult> {
  if (!(MANAGERS as string[]).includes(input.actor.role)) {
    throw new ForbiddenError('Only managers can receive goods.')
  }
  if (input.lines.length === 0) throw new AppError('NO_LINES', 'Nothing to receive', 400)
  for (const l of input.lines) {
    if (!Number.isFinite(l.quantityReceived) || l.quantityReceived < 0) {
      throw new AppError('INVALID_QTY', 'Received quantity must be zero or more', 400)
    }
  }
  if (!input.lines.some((l) => l.quantityReceived > 0)) {
    throw new AppError('NOTHING_RECEIVED', 'Every line is zero — nothing arrived to receive', 400)
  }

  // ── Resolve supplier + PO ──────────────────────────────────────────────────
  const po = input.poId
    ? await prisma.purchaseOrder.findUnique({
        where:   { id: input.poId },
        include: { lines: { include: { inventoryItem: { select: { name: true, unit: true, tenantId: true } } } } },
      })
    : null
  if (input.poId && !po) throw new NotFoundError('PurchaseOrder', input.poId)
  if (po && input.supplierId && input.supplierId !== po.supplierId) {
    throw new AppError('SUPPLIER_MISMATCH', 'That PO belongs to a different supplier', 400)
  }
  const supplierId = po?.supplierId ?? input.supplierId
  if (!supplierId) throw new AppError('SUPPLIER_REQUIRED', 'Pick the supplier for a delivery without a PO', 400)
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, tenantId: true, systemKind: true } })
  if (!supplier) throw new NotFoundError('Supplier', supplierId)
  if (supplier.systemKind) {
    throw new AppError('SYSTEM_SUPPLIER', `${supplier.name} is for goods bought with cash — record them on the petty-cash spend or cash request`, 422)
  }
  // Company-less suppliers are refused on the PO path too (critic): the
  // receipt books into the supplier's company.
  if (!supplier.tenantId) {
    throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before receiving from it', 422)
  }
  const tenantId = supplier.tenantId

  if (po) {
    assertReceivable(po.status)
    await assertNotSelfApproval({
      tenantId,
      actor: input.actor, creatorId: po.createdBy,
      action: 'receive goods', entity: 'PurchaseOrder', entityId: po.id,
      message: 'You raised this purchase order, so someone else has to receive it (or the CEO).',
    })
  }

  // ── Prepare lines ──────────────────────────────────────────────────────────
  const prepared: PreparedLine[] = []
  if (po) {
    const seen = new Set<string>()
    for (const l of input.lines) {
      if (!l.poLineId) throw new AppError('LINE_NOT_ON_PO', 'Items that are not on the PO must be received as a separate delivery without a PO', 400)
      if (seen.has(l.poLineId)) throw new AppError('DUPLICATE_LINE', 'A PO line appears twice', 400)
      seen.add(l.poLineId)
      const pl = po.lines.find((x) => x.id === l.poLineId)
      if (!pl) throw new AppError('LINE_NOT_FOUND', `Line ${l.poLineId} is not part of this PO`, 400)
      if (!pl.inventoryItem.tenantId) {
        throw new AppError('ITEM_HAS_NO_COMPANY', `${pl.inventoryItem.name} belongs to no company — assign it to a company before receiving it`, 422)
      }
      if (pl.inventoryItem.tenantId !== tenantId) {
        throw new AppError('ITEM_NOT_IN_COMPANY', `${pl.inventoryItem.name} belongs to a different company than ${supplier.name}`, 422)
      }
      const outstanding = Math.max(0, pl.quantityOrdered - pl.quantityReceived)
      prepared.push({
        poLineId: pl.id, inventoryItemId: pl.inventoryItemId,
        description: pl.inventoryItem.name, unit: pl.inventoryItem.unit,
        expectedQty: outstanding, orderedQty: pl.quantityOrdered, alreadyReceived: pl.quantityReceived,
        quantityReceived: l.quantityReceived, unitCostCents: pl.unitCostCents,
        discrepancyReason: l.discrepancyReason ?? null, notes: l.notes ?? null,
        variancePct: outstanding > 0 ? (l.quantityReceived - outstanding) / outstanding : null,
        useBy: l.useBy ?? null,
      })
    }
  } else {
    const ids = input.lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x)
    if (ids.length !== input.lines.length) throw new AppError('ITEM_REQUIRED', 'Every line needs an inventory item', 400)
    const items = await prisma.inventoryItem.findMany({
      where:  { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, unit: true, tenantId: true, purchaseUnit: true },
    })
    for (const l of input.lines) {
      const it = items.find((x) => x.id === l.inventoryItemId)
      if (!it) throw new NotFoundError('InventoryItem', l.inventoryItemId!)
      if (!it.tenantId) {
        throw new AppError('ITEM_HAS_NO_COMPANY', `${it.name} belongs to no company — assign it to a company before receiving it`, 422)
      }
      if (it.tenantId !== tenantId) {
        throw new AppError('ITEM_NOT_IN_COMPANY', `${it.name} belongs to a different company than ${supplier.name}`, 422)
      }
      if (l.unitCostCents == null || !Number.isInteger(l.unitCostCents) || l.unitCostCents < 0) {
        throw new AppError('UNIT_COST_REQUIRED', `Enter the unit cost paid for ${it.name}`, 400)
      }
      // BOOKS-06: the unit cost lands in INT4 stock-cost columns (≤ PKR
      // 21,474,836.47); quantity × cost is not stored in INT4 (≤ PKR 900bn).
      assertInt4Fits(l.unitCostCents, `${it.name}'s unit cost`)
      assertMoneyFits(Math.round(l.unitCostCents * l.quantityReceived), `${it.name} (quantity × unit cost)`)
      prepared.push({
        poLineId: null, inventoryItemId: it.id, description: it.name,
        // Typed in the item's purchase unit (owner 2026-10-24): receiveGoodsTx converts it to stock units.
        unit: l.unit && it.purchaseUnit && l.unit.trim().toLowerCase() === it.purchaseUnit.trim().toLowerCase() ? it.purchaseUnit : it.unit,
        expectedQty: null, orderedQty: null, alreadyReceived: 0,
        quantityReceived: l.quantityReceived, unitCostCents: l.unitCostCents,
        discrepancyReason: l.discrepancyReason ?? null, notes: l.notes ?? null, variancePct: null,
        useBy: l.useBy ?? null,
      })
    }
  }

  // ── Dock-door photo above the company's threshold ──────────────────────────
  const ops = await getOperationsConfig(tenantId)
  const photoThreshold = ops?.photoRequiredAboveCents ?? 50_000
  const totalValue = prepared.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityReceived), 0)
  // An uploaded photo satisfies the rule; a legacy photoUrl still does too.
  if (totalValue >= photoThreshold && !input.photoUrl && !(input.photoFiles?.length)) {
    throw new AppError(
      'PHOTO_REQUIRED',
      `Deliveries above PKR ${(photoThreshold / 100).toFixed(0)} require a dock-door photo. Snap the goods before submitting.`,
      400,
    )
  }

  const flagged = prepared.filter((l) => l.variancePct != null && Math.abs(l.variancePct) > RECEIVING_VARIANCE_THRESHOLD)

  // The company's stock must be on FIFO lots before the first lot is written
  // (the one-time cut-over runs here if it has not yet) — outside the tx.
  await ensureFifoReady(tenantId)

  // ── One transaction: receipt, lots, GRNI, PO ───────────────────────────────
  const { receipt, poStatus, photos } = await prisma.$transaction(async (tx) => {
    let poStatus: string | null = null
    if (po) {
      // Serialise receipts of the same PO (and bills billing it) and re-read
      // it under the lock, so two receivers can't both receive the
      // "outstanding" quantity.
      await tx.$queryRaw`SELECT id FROM purchase_orders WHERE id = ${po.id} FOR UPDATE`
      const fresh = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } })
      assertReceivable(fresh.status)
      for (const l of prepared) {
        const fl = fresh.lines.find((x) => x.id === l.poLineId)!
        if (fl.quantityReceived !== l.alreadyReceived) {
          throw new AppError('PO_CHANGED', 'This PO was just received by someone else — reload and try again', 409)
        }
      }
    }

    const done = await receiveGoodsTx(tx, {
      tenantId,
      supplierId: supplier.id,
      ...(po ? { poId: po.id } : {}),
      locationId: input.locationId ?? null,
      receivedById: input.actor.id,
      photoUrl: input.photoUrl ?? null,
      notes: input.notes ?? null,
      status: flagged.length > 0 ? 'disputed' : 'accepted',
      varianceFlag: flagged.length > 0,
      requireUseBy: true,
      lines: prepared.map((l) => ({
        inventoryItemId: l.inventoryItemId,
        receivedQty:     l.quantityReceived,
        unit:            l.unit,
        unitCostCents:   l.unitCostCents,
        ...(l.poLineId ? { poLineId: l.poLineId } : {}),
        description:     l.description,
        poQty:           l.expectedQty,
        variancePct:     l.variancePct,
        notes:           l.notes,
        useBy:           l.useBy,
      })),
    })

    // The dock-door photos, stamped with the RECEIPT's company (record files,
    // owner 'goods_receipt' — modules/recordFiles/providers.ts).
    const photos = await writeRecordFilesTx(tx, {
      ownerType: 'goods_receipt', ownerId: done.receiptId, tenantId, uploadedById: input.actor.id,
      files: input.photoFiles ?? [], label: 'goods receipt',
    })

    if (po) {
      for (const l of prepared) {
        if (!l.poLineId) continue
        const cumulative = l.alreadyReceived + l.quantityReceived
        const variance   = cumulative - (l.orderedQty ?? 0)
        if (l.discrepancyReason || variance !== 0) {
          await tx.receivingDiscrepancy.create({
            data: {
              poLineId:     l.poLineId,
              expectedQty:  l.orderedQty ?? 0,
              receivedQty:  cumulative,
              reason:       l.discrepancyReason ?? (variance < 0 ? 'short_shipment' : 'over_shipment'),
              notes:        l.notes,
              recordedById: input.actor.id,
            },
          })
        }
      }
      const lines = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })
      const allReceived = lines.every((l) => l.quantityReceived >= l.quantityOrdered)
      poStatus = allReceived ? 'received' : 'partial'
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data:  { status: poStatus, receivedDate: new Date() },
      })
      await tx.poActivityLog.create({
        data: {
          purchaseOrderId: po.id,
          userId:          input.actor.id,
          action:          allReceived ? 'received' : 'received_partial',
          details:         { goodsReceiptId: done.receiptId, lineCount: prepared.length, photo: !!input.photoUrl || photos.length > 0 },
        },
      })
    }
    const receipt = await tx.goodsReceipt.findUniqueOrThrow({ where: { id: done.receiptId }, include: { lines: true } })
    return { receipt, poStatus, photos }
  }, { timeout: 30_000 })

  // ── Exception flags (after commit, so a failed flag never undoes a receipt) ─
  for (const l of flagged) {
    const pct  = l.variancePct!
    const kind: ExceptionKind = pct < 0 ? 'short_shipment' : 'receiving_variance'
    await flagException({
      tenantId,
      kind,
      severity: kind === 'short_shipment' && Math.abs(pct) > 0.15 ? 'high' : 'medium',
      title: `${kind === 'short_shipment' ? 'Short shipment' : 'Receiving variance'}: ${l.description}`,
      description: `${supplier.name}: expected ${l.expectedQty} ${l.unit}, received ${l.quantityReceived} ${l.unit} (${(pct * 100).toFixed(1)}% variance).`,
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      actorId: input.actor.id,
      metadata: { poId: po?.id ?? null, poLineId: l.poLineId, supplierId: supplier.id, tenantId, variancePct: pct },
    })
  }

  if (photos.length > 0) {
    await audit({
      category: 'identity', action: 'record_file.upload', entity: 'goods_receipt', entityId: receipt.id,
      userId: input.actor.id, tenantId,
      before: null, after: { files: photos.map((f) => ({ id: f.id, fileName: f.fileName, mime: f.mime, sizeBytes: f.sizeBytes })) },
    })
  }

  return { receipt, poStatus, flagged: flagged.length, files: photos }
}

function assertReceivable(status: string) {
  if (status === 'cancelled') throw new AppError('PO_CANCELLED', 'Cannot receive a cancelled PO', 400)
  if (status === 'received')  throw new AppError('PO_RECEIVED', 'PO is already fully received', 400)
  if (status === 'approved') {
    throw new AppError('PO_NOT_SENT', 'This PO is approved but was never sent to the supplier. Send it, or mark it as sent if it was phoned in, then receive it.', 400)
  }
  if (!(RECEIVABLE_PO_STATUSES as readonly string[]).includes(status)) {
    throw new AppError('PO_NOT_SENT', `A PO must be approved and sent before it can be received (this one is ${status})`, 400)
  }
}
