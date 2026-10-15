// Trash — cancelled stock transfers (stream B7, spec §1c).
//
//   stock_transfer  StockTransfer `cancelled` (cancelledAt, cancelReason).
//                   Copy = PREFILL of the transfer request (a request is
//                   already a submission): item, from / to outlet, quantity,
//                   unit, reason, notes. Approvals, shipped / received
//                   quantities are never copied. POST /stock-transfers binds
//                   both outlets and the item to the ACTIVE company again.
//
// Company: a transfer has no tenantId — it is owned through its outlets
// (Location.tenantId), exactly like stockTransfers/routes.ts. The row's
// company is the sending outlet's (else the receiving one's). Roles =
// MANAGERS (the module's guard); module `inventory`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { MANAGERS } from '../../../auth/middleware.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, prefill, roles, scopeIds } from './common.js'

export const TRASH_STOCK = { stock_transfer: 'stock_transfer' } as const

const MGR = roles(MANAGERS)

function scope(ctx: TrashCtx): Prisma.StockTransferWhereInput {
  const ids = scopeIds(ctx.readScope)
  return { OR: [{ fromLocation: { tenantId: { in: ids } } }, { toLocation: { tenantId: { in: ids } } }] }
}

const SELECT = {
  id: true, quantity: true, unit: true, cancelledAt: true, cancelReason: true, requestedAt: true,
  inventoryItem: { select: { name: true } },
  fromLocation: { select: { name: true, tenantId: true } },
  toLocation: { select: { name: true, tenantId: true } },
} satisfies Prisma.StockTransferSelect
type Sel = Prisma.StockTransferGetPayload<{ select: typeof SELECT }>

function row(ctx: TrashCtx, t: Sel): TrashRow {
  const ids = scopeIds(ctx.readScope)
  const from = t.fromLocation.tenantId
  const to = t.toLocation.tenantId
  return {
    id: t.id,
    tenantId: from && ids.includes(from) ? from : to && ids.includes(to) ? to : from ?? to ?? null,
    title: `${t.quantity} ${t.unit} ${t.inventoryItem.name}`,
    subtitle: `${t.fromLocation.name} → ${t.toLocation.name}`,
    at: t.cancelledAt ?? t.requestedAt,
    reason: t.cancelReason,
    statusLabel: 'Cancelled',
  }
}

const stockTransfer: TrashProvider = {
  key: TRASH_STOCK.stock_transfer,
  label: 'Stock transfer',
  moduleId: 'inventory',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/inventory',
  async list(ctx, f) {
    const q = f.q?.trim()
    const rows = await db.stockTransfer.findMany({
      where: {
        AND: [
          scope(ctx),
          { status: 'cancelled', cancelledAt: { not: null } },
          atWhere('cancelledAt', f),
          q ? { OR: [
            { inventoryItem: { name: { contains: q, mode: 'insensitive' } } },
            { cancelReason: { contains: q, mode: 'insensitive' } },
          ] } : {},
        ],
      },
      orderBy: [{ cancelledAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    return rows.map((t) => row(ctx, t))
  },
  async get(ctx, id) {
    const t = await db.stockTransfer.findFirst({ where: { id, status: 'cancelled', ...scope(ctx) }, select: SELECT })
    return t ? row(ctx, t) : null
  },
  async copy(ctx, id) {
    const t = await db.stockTransfer.findFirst({
      where: { id, status: 'cancelled', ...scope(ctx) },
      select: { inventoryItemId: true, fromLocationId: true, toLocationId: true, quantity: true, unit: true, reason: true, notes: true },
    })
    if (!t) throw new NotFoundError('Trash item', id)
    return prefill('/inventory', {
      inventoryItemId: t.inventoryItemId,
      fromLocationId: t.fromLocationId,
      toLocationId: t.toLocationId,
      quantity: t.quantity,
      unit: t.unit,
      reason: t.reason,
      notes: t.notes,
    })
  },
  erasable: () => false,
}

export const STOCK_TRASH_PROVIDERS: readonly TrashProvider[] = [stockTransfer]
