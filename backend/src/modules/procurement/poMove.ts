// Move a purchase order to another company (owner, 2026-11-14: "Give button to transfer to other company, she will
// do it manually" — POs raised in the wrong company).
//
// A PO has no company column: it belongs to its SUPPLIER's company, and every line names a stock item of that
// company. So a move is never an in-place re-point (the number series, the items, the brand and the buyer are all the
// old company's). It is:
//   1. a NEW draft PO in the target company through createPo — THE one way a PO is made (its checks, its PO-0000n
//      series): the same servd supplier on the target's own account (lib/supplierMaster.ts; a PO with no supplier, or
//      one whose supplier is not on the servd list, arrives with "no supplier yet"), every line on the target's own
//      item for the same servd ingredient (lib/ingredientMaster.ts ensureCompanyItemForMasterTx), in the unit and at
//      the rate it was ordered; the buyer is kept only when the target lists them; the brand is cleared (a brand is
//      one company's);
//   2. the old PO cancelled through cancelPo ("Moved to <company> as PO-0000n").
// Only BEFORE the CEO's approval (draft | pending_approval): after it a cash voucher, a buyer and receipts hang off
// the PO in the old company's books — 409 PO_MOVE_TOO_LATE (cancel it and raise it again). Nothing posts.
// The new PO is a draft: it is submitted to the target company's CEO again.

import { prisma, serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ensureCompanyItemForMasterTx } from '../../lib/ingredientMaster.js'
import { ensureCompanySupplierForMasterTx } from '../../lib/supplierMaster.js'
import { createPo, cancelPo, noSupplierFor } from './service.js'
import type { TypedLine } from './poUnits.js'

export const PO_MOVABLE_STATUSES = ['draft', 'pending_approval'] as const

export interface MovePoResult {
  fromTenantId: string; toTenantId: string; toCompany: string
  oldId: string; oldReference: string | null
  newId: string; newReference: string | null
  supplierKept: boolean; buyerKept: boolean
}

export async function movePoToCompany(input: { poId: string; toTenantId: string; userId: string }): Promise<MovePoResult> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: input.poId },
    include: {
      supplier: { select: { tenantId: true, systemKind: true, masterSupplierId: true } },
      lines: { include: { inventoryItem: { select: { id: true, name: true, unit: true, masterIngredientId: true } } } },
    },
  })
  if (!po) throw new NotFoundError('PurchaseOrder', input.poId)
  const fromTenantId = po.supplier.tenantId
  if (!fromTenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'This purchase order has no company yet — give its supplier a company first', 422)
  if (fromTenantId === input.toTenantId) throw new AppError('SAME_COMPANY', 'This purchase order is already in that company', 422)
  if (!(PO_MOVABLE_STATUSES as readonly string[]).includes(po.status)) {
    throw new AppError('PO_MOVE_TOO_LATE', 'Only a draft or a PO still waiting for approval can be moved. Cancel this one and raise it again in the other company.', 409)
  }
  if (po.lines.length === 0) throw new AppError('NO_LINES', 'This purchase order has no lines to move', 422)

  const target = await serviceClient.tenant.findFirst({
    where: { id: input.toTenantId, kind: 'company', isActive: true }, select: { id: true, name: true },
  })
  if (!target) throw new NotFoundError('Company', input.toTenantId)

  const offSheet = po.lines.filter((l) => !l.inventoryItem.masterIngredientId).map((l) => l.inventoryItem.name)
  if (offSheet.length) {
    throw new AppError('ITEM_NOT_ON_SHEET', `Not on the servd Ingredients sheet, so ${target.name} has no matching item: ${[...new Set(offSheet)].join(', ')}. Remove them from this PO, or add them to the sheet first.`, 422, { items: offSheet })
  }

  // The target company's own account and items (found, or opened on first use) — through the service client: the rows
  // are the TARGET company's, the caller's request may be scoped to the old one.
  const resolved = await serviceClient.$transaction(async (tx) => {
    const supplierKept = !po.supplier.systemKind && !!po.supplier.masterSupplierId
    const supplierId = supplierKept ? (await ensureCompanySupplierForMasterTx(tx, po.supplier.masterSupplierId!, target.id)).id : null
    const itemIdByMaster = new Map<string, string>()
    for (const l of po.lines) {
      const m = l.inventoryItem.masterIngredientId!
      if (!itemIdByMaster.has(m)) itemIdByMaster.set(m, (await ensureCompanyItemForMasterTx(tx, target.id, m)).id)
    }
    const buyerKept = !!po.buyerUserId && !!(await tx.poBuyer.findFirst({ where: { tenantId: target.id, userId: po.buyerUserId, active: true }, select: { id: true } }))
    return { supplierId, supplierKept, itemIdByMaster, buyerKept }
  })
  const supplierId = resolved.supplierId ?? await noSupplierFor(target.id)

  // Each line as it was ORDERED (its unit and rate); a line typed in the stock unit names the old item's unit, so the
  // target's item — which may keep another unit of the same family (g for kg) — is converted by poUnits, never guessed.
  const lines: TypedLine[] = po.lines.map((l) => {
    const typed = !!l.orderUnit && l.orderUnitCostCents != null && l.orderUnitFactor > 0
    return {
      inventoryItemId:    resolved.itemIdByMaster.get(l.inventoryItem.masterIngredientId!)!,
      notes:              l.notes,
      orderUnit:          typed ? l.orderUnit : l.inventoryItem.unit,
      orderQuantity:      typed ? l.quantityOrdered / l.orderUnitFactor : l.quantityOrdered,
      orderUnitCostCents: typed ? l.orderUnitCostCents! : l.unitCostCents,
    }
  })

  const created = await createPo({
    supplierId,
    expectedDate: po.expectedDate ? po.expectedDate.toISOString() : null,
    notes:        po.notes,
    conceptId:    null,
    buyerUserId:  resolved.buyerKept ? po.buyerUserId : null,
    lines,
    createdBy:    po.createdBy ?? input.userId,
  })

  try {
    await cancelPo(po.id, input.userId, `Moved to ${target.name} as ${created.reference ?? 'a new PO'}`)
  } catch (e) {
    // The old one could not be cancelled (it moved on meanwhile): never leave two live copies.
    await cancelPo(created.id, input.userId, 'Move not completed — the original could not be cancelled').catch(() => undefined)
    throw e
  }
  await serviceClient.poActivityLog.create({
    data: { purchaseOrderId: created.id, userId: input.userId, action: 'edited', details: { movedFrom: { poId: po.id, reference: po.reference, tenantId: fromTenantId } } },
  })

  return {
    fromTenantId, toTenantId: target.id, toCompany: target.name,
    oldId: po.id, oldReference: po.reference, newId: created.id, newReference: created.reference ?? null,
    supplierKept: resolved.supplierKept, buyerKept: resolved.buyerKept,
  }
}
