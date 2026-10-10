// Goods receiving — THE one path that brings stock in from a supplier.
//
// There used to be three: the Procurement "Receive" modal (receivePo), the
// dock-door GRN page (POST /crosschecks/receiving) and the legacy
// /recipes/purchase-orders/:id/receive. They disagreed: the GRN never updated
// the PO or the cost and bumped stock outside a transaction (errors
// swallowed), the PO path wrote no GoodsReceipt and had no photo or
// separation-of-duties check, and the legacy path would receive a draft or an
// already-received PO. Receiving one delivery through two of them added the
// stock twice.
//
// Now every caller — the dock page, the PO receive route — calls
// receiveGoods(). In ONE transaction it:
//   - writes the GoodsReceipt (the receiving document) and its lines
//   - against a PO: bumps PurchaseOrderLine.quantityReceived, logs
//     ReceivingDiscrepancy rows, moves the PO to partial / received and
//     writes the PO activity log
//   - moves stock and the moving-average unit cost through applyReceiptLine
//     (owner decision 30: ingredient cost = moving average of actual
//     deliveries), with ItemPriceHistory when the cost moves
// After commit it raises the variance / short-shipment exception flags.
//
// Owner decision 27 (2026-09-27):
//   - receiving WITHOUT a PO is allowed (market runs, ad-hoc deliveries), but
//     the unit cost must be entered at the dock;
//   - only manager tiers may receive (MANAGERS);
//   - whoever raised the PO cannot receive it — everyone except the CEO.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { flagException, type ExceptionKind } from '../../lib/exceptions.js'
import { assertNotSelfApproval } from '../../lib/separation-of-duties.js'
import { getOperationsConfig } from '../../lib/setup-config.js'
import { MANAGERS } from '../auth/middleware.js'

/** Line variance above this (either way) raises an exception flag. */
export const RECEIVING_VARIANCE_THRESHOLD = 0.05   // 5%

/**
 * A PO can be received only once it has been approved AND sent — emailed /
 * WhatsApped (sendPoToSupplier) or marked sent by whoever phoned it in
 * (markPoSent). Approval alone no longer stamps 'sent'.
 */
export const RECEIVABLE_PO_STATUSES = ['sent', 'partial'] as const

export type DiscrepancyReason = 'short_shipment' | 'over_shipment' | 'damaged' | 'wrong_item' | 'quality_issue'

export interface ReceiveGoodsLine {
  /** Required on a PO receipt; must be a line of that PO. */
  poLineId?:          string | null
  /** Required on a receipt without a PO. Ignored on a PO line (the PO names the item). */
  inventoryItemId?:   string | null
  /** What arrived. 0 = the line did not arrive (logged as short). */
  quantityReceived:   number
  /**
   * Unit cost in paisa. Required on a receipt without a PO (entered at the
   * dock). On a PO line the agreed PO cost is used; when the supplier's bill
   * later charges a different price, postSupplierBill re-averages the item at
   * the billed price (accounting/supplierPosting.ts).
   */
  unitCostCents?:     number | null
  discrepancyReason?: DiscrepancyReason | null
  notes?:             string | null
}

export interface ReceiveGoodsInput {
  actor:       { id: string; role: string }
  poId?:       string | null
  /** Required without a PO; must match the PO's supplier when both are given. */
  supplierId?: string | null
  photoUrl?:   string | null
  notes?:      string | null
  lines:       ReceiveGoodsLine[]
}

export interface ReceiveGoodsResult {
  receipt:  Prisma.GoodsReceiptGetPayload<{ include: { lines: true } }>
  poStatus: string | null
  flagged:  number
}

type Tx = Prisma.TransactionClient

// ─── Stock + moving-average cost ─────────────────────────────────────────────

/**
 * Bring `qty` of an item into stock at `unitCostCents`, re-averaging the
 * item's unit cost over what was on hand and what arrived (negative stock
 * counts as zero on hand, so a count error can't drag the average). Records
 * ItemPriceHistory when the cost moves. The item row is locked so two
 * receipts of the same item can't both average against the same old stock.
 * Returns the new unit cost (null when nothing arrived).
 */
export async function applyReceiptLine(tx: Tx, input: {
  inventoryItemId: string
  quantity:        number
  unitCostCents:   number
  supplierId:      string | null
  poLineId?:       string | null
  source:          'po_receive' | 'dock_receive'
}): Promise<number | null> {
  if (!(input.quantity > 0)) return null
  await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${input.inventoryItemId} FOR UPDATE`
  const item = await tx.inventoryItem.findFirst({
    where:  { id: input.inventoryItemId, deletedAt: null },
    select: { id: true, currentStock: true, unitCostCents: true },
  })
  if (!item) throw new NotFoundError('InventoryItem', input.inventoryItemId)

  const onHand  = Math.max(0, item.currentStock)
  const oldCost = item.unitCostCents
  const newCost = oldCost == null || onHand + input.quantity <= 0
    ? input.unitCostCents
    : Math.round((oldCost * onHand + input.unitCostCents * input.quantity) / (onHand + input.quantity))

  await tx.inventoryItem.update({
    where: { id: item.id },
    data:  { currentStock: { increment: input.quantity }, unitCostCents: newCost },
  })

  if (oldCost !== newCost) {
    await tx.itemPriceHistory.create({
      data: {
        inventoryItemId: item.id,
        supplierId:      input.supplierId,
        oldCostCents:    oldCost,
        newCostCents:    newCost,
        source:          input.source,
        poLineId:        input.poLineId ?? null,
      },
    })
  }
  return newCost
}

// ─── receiveGoods ────────────────────────────────────────────────────────────

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
}

export async function receiveGoods(input: ReceiveGoodsInput): Promise<ReceiveGoodsResult> {
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
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, tenantId: true } })
  if (!supplier) throw new NotFoundError('Supplier', supplierId)

  if (po) {
    assertReceivable(po.status)
    await assertNotSelfApproval({
      tenantId: supplier.tenantId,
      actor: input.actor, creatorId: po.createdBy,
      action: 'receive goods', entity: 'PurchaseOrder', entityId: po.id,
      message: 'You raised this purchase order, so someone else has to receive it (or the CEO).',
    })
  } else if (!supplier.tenantId) {
    throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'Assign this supplier to a company before receiving from it', 422)
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
      // createPo refuses another company's item now; a PO raised before that
      // could still carry one, and receiving it would move that company's stock.
      if (supplier.tenantId && pl.inventoryItem.tenantId && pl.inventoryItem.tenantId !== supplier.tenantId) {
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
      })
    }
  } else {
    const ids = input.lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x)
    if (ids.length !== input.lines.length) throw new AppError('ITEM_REQUIRED', 'Every line needs an inventory item', 400)
    const items = await prisma.inventoryItem.findMany({
      where:  { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, unit: true, tenantId: true },
    })
    for (const l of input.lines) {
      const it = items.find((x) => x.id === l.inventoryItemId)
      if (!it) throw new NotFoundError('InventoryItem', l.inventoryItemId!)
      if (it.tenantId && it.tenantId !== supplier.tenantId) {
        throw new AppError('ITEM_NOT_IN_COMPANY', `${it.name} belongs to a different company than ${supplier.name}`, 422)
      }
      if (l.unitCostCents == null || !Number.isInteger(l.unitCostCents) || l.unitCostCents < 0) {
        throw new AppError('UNIT_COST_REQUIRED', `Enter the unit cost paid for ${it.name}`, 400)
      }
      prepared.push({
        poLineId: null, inventoryItemId: it.id, description: it.name, unit: it.unit,
        expectedQty: null, orderedQty: null, alreadyReceived: 0,
        quantityReceived: l.quantityReceived, unitCostCents: l.unitCostCents,
        discrepancyReason: l.discrepancyReason ?? null, notes: l.notes ?? null, variancePct: null,
      })
    }
  }

  // ── Dock-door photo above the company's threshold ──────────────────────────
  const ops = await getOperationsConfig(supplier.tenantId)
  const photoThreshold = ops?.photoRequiredAboveCents ?? 50_000
  const totalValue = prepared.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityReceived), 0)
  if (totalValue >= photoThreshold && !input.photoUrl) {
    throw new AppError(
      'PHOTO_REQUIRED',
      `Deliveries above PKR ${(photoThreshold / 100).toFixed(0)} require a dock-door photo. Snap the goods before submitting.`,
      400,
    )
  }

  const flagged = prepared.filter((l) => l.variancePct != null && Math.abs(l.variancePct) > RECEIVING_VARIANCE_THRESHOLD)

  // ── One transaction: receipt, PO, stock, cost ──────────────────────────────
  const { receipt, poStatus } = await prisma.$transaction(async (tx) => {
    let poStatus: string | null = null
    if (po) {
      // Serialise receipts of the same PO and re-read it under the lock, so two
      // receivers can't both receive the "outstanding" quantity.
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

    const receipt = await tx.goodsReceipt.create({
      data: {
        poId:         po?.id ?? null,
        supplierId:   supplier.id,
        receivedById: input.actor.id,
        photoUrl:     input.photoUrl ?? null,
        notes:        input.notes ?? null,
        status:       flagged.length > 0 ? 'disputed' : 'accepted',
        varianceFlag: flagged.length > 0,
        lines: {
          create: prepared.map((l) => ({
            inventoryItemId: l.inventoryItemId,
            description:     l.description,
            poQty:           l.expectedQty,
            receivedQty:     l.quantityReceived,
            poUnitCostCents: l.unitCostCents,
            unit:            l.unit,
            variancePct:     l.variancePct,
            notes:           l.notes,
          })),
        },
      },
      include: { lines: true },
    })

    for (const l of prepared) {
      if (l.quantityReceived > 0) {
        await applyReceiptLine(tx, {
          inventoryItemId: l.inventoryItemId,
          quantity:        l.quantityReceived,
          unitCostCents:   l.unitCostCents,
          supplierId:      supplier.id,
          poLineId:        l.poLineId,
          source:          po ? 'po_receive' : 'dock_receive',
        })
      }
      if (!po || !l.poLineId) continue

      if (l.quantityReceived > 0) {
        await tx.purchaseOrderLine.update({
          where: { id: l.poLineId },
          data:  { quantityReceived: { increment: l.quantityReceived } },
        })
      }
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

    if (po) {
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
          details:         { goodsReceiptId: receipt.id, lineCount: prepared.length, photo: !!input.photoUrl },
        },
      })
    }
    return { receipt, poStatus }
  })

  // ── Exception flags (after commit, so a failed flag never undoes a receipt) ─
  for (const l of flagged) {
    const pct  = l.variancePct!
    const kind: ExceptionKind = pct < 0 ? 'short_shipment' : 'receiving_variance'
    await flagException({
      tenantId: supplier.tenantId,
      kind,
      severity: kind === 'short_shipment' && Math.abs(pct) > 0.15 ? 'high' : 'medium',
      title: `${kind === 'short_shipment' ? 'Short shipment' : 'Receiving variance'}: ${l.description}`,
      description: `${supplier.name}: expected ${l.expectedQty} ${l.unit}, received ${l.quantityReceived} ${l.unit} (${(pct * 100).toFixed(1)}% variance).`,
      entityType: 'GoodsReceipt',
      entityId: receipt.id,
      actorId: input.actor.id,
      metadata: { poId: po?.id ?? null, poLineId: l.poLineId, supplierId: supplier.id, tenantId: supplier.tenantId, variancePct: pct },
    })
  }

  return { receipt, poStatus, flagged: flagged.length }
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
