// Company scope for procurement.
//
// A supplier carries the company (Supplier.tenantId); every procurement row —
// PO, bill, payment, conversation, portal token — belongs to its supplier's
// company. So every procurement route scopes THROUGH the supplier, here.
//
// Modes are lib/tenantScope.ts's:
//   read   — lists and detail views (view-aware: portfolio expands)
//   write  — acting on a supplier or anything under it, including attaching a
//            NEW PO/bill/payment/conversation/token to it: the new row's
//            company is the supplier's, so the operator must belong to that
//            company (every company they are a member of)
//
// Suppliers with no company (legacy orphans, tenantId null) stay visible to
// operators who have a company so one of them can claim it (the Monitor page
// badges them). An operator with NO company in scope sees nothing at all —
// `{ tenantId: { in: [] } }`, never `{}`: staff can have a null tenant, and an
// empty filter is "every company" to Prisma.

import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode, type TenantIdWhere } from '../../lib/tenantScope.js'

export function tenantIdsOf(where: TenantIdWhere): string[] {
  return typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in
}

/** The request's company ids for `mode` (empty = no company: deny). */
export async function scopeTenantIds(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<string[]> {
  return tenantIdsOf(await scopeTenantWhere(req, mode))
}

/**
 * Prisma `where` on Supplier for the request's companies in `mode`: the
 * companies' suppliers plus orphans — or nothing at all when the scope is
 * empty. Use it directly on `supplier.findMany` and as the `supplier:`
 * relation filter on POs, bills, payments, conversations and price history.
 */
export async function supplierScopeWhere(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<Prisma.SupplierWhereInput> {
  const ids = await scopeTenantIds(req, mode)
  if (ids.length === 0) return { tenantId: { in: [] } }
  return { OR: [{ tenantId: { in: ids } }, { tenantId: null }] }
}

/**
 * The supplier, or 404 when it is not in scope for `mode` (404, not 403, so a
 * foreign id doesn't confirm the supplier exists). `live` also 404s a
 * soft-deleted supplier — pass it when a new row is about to attach to it.
 */
export async function findSupplierInScope(
  req: FastifyRequest,
  supplierId: string,
  mode: ScopeMode,
  opts: { live?: boolean } = {},
) {
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, ...(opts.live ? { deletedAt: null } : {}), ...(await supplierScopeWhere(req, mode)) },
  })
  if (!supplier) throw new NotFoundError('Supplier', supplierId)
  return supplier
}

/**
 * 404 unless every inventory item exists (not deleted); 422 unless every one
 * belongs to `tenantId` — a PO or bill of company A must never move or cost
 * company B's stock.
 */
export async function assertItemsOfCompany(itemIds: string[], tenantId: string, supplierName: string): Promise<void> {
  const ids = Array.from(new Set(itemIds))
  if (ids.length === 0) return
  const items = await prisma.inventoryItem.findMany({
    where:  { id: { in: ids }, deletedAt: null },
    select: { id: true, name: true, tenantId: true },
  })
  for (const id of ids) {
    const it = items.find((x) => x.id === id)
    if (!it) throw new NotFoundError('InventoryItem', id)
    if (it.tenantId !== tenantId) {
      throw new AppError('ITEM_NOT_IN_COMPANY', `${it.name} belongs to a different company than ${supplierName}`, 422)
    }
  }
}

/** The one company a new company-owned setting/row binds to, or 422. */
export function activeTenantOr422(req: FastifyRequest, picked?: string | null): string {
  const su = req.staffUser
  const tenantId = picked ?? su?.tenantId ?? null
  if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
  if (!su || !su.memberTenantIds.includes(tenantId)) {
    throw new AppError('COMPANY_NOT_ALLOWED', 'You do not belong to that company', 403)
  }
  return tenantId
}
