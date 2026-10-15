// Trash — till orders and voided order lines (stream B7, spec §1c).
//
//   order       Order `cancelled` / `rejected` (cancelledAt, cancellationReason).
//               Copy = PREFILL of the till cart (/pos): brand, order type, the
//               table when it is still free, the customer, and each line
//               (dish, qty, modifiers, notes) RE-PRICED at today's menu. A dish
//               or modifier that is deleted or unavailable is dropped with a
//               warning. Never copied: payments, discounts / comps / promo /
//               gift card / loyalty / wallet, tips, service charge (the till
//               recomputes it), fiscal / pre-bill numbers. The ring-up goes
//               through POST /pos/orders with all its guards (open drawer…).
//               Online orders (servd.pk / WhatsApp / cart) are listed but
//               read-only (owner Q1 default): the customer re-orders.
//   order_item  OrderItem `voided` (voidedAt, voidReason). Copy = PREFILL of
//               the same open ticket on the till; once the order is closed it is
//               not copyable ("copy the order").
//
// Company: an order is its brand's company (concept.tenantId). Roles = the
// managers who cancel and void (MANAGERS); module `orders`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { orderRefOf } from '../../../../lib/orderRef.js'
import { MANAGERS } from '../../../auth/middleware.js'
import type { TrashCtx, TrashListFilter, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, pkr, prefill, qWhere, roles, scopeIds, sortRows } from './common.js'

export const TRASH_ORDERS = { order: 'order', order_item: 'order_item' } as const

const MGR = roles(MANAGERS)
const OPEN_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const
export const ONLINE_ORDER_NOT_COPYABLE =
  'An online order stays read-only in the Trash — the customer re-orders on servd.pk or WhatsApp.'
const STATUS_LABEL: Record<string, string> = { cancelled: 'Cancelled', rejected: 'Rejected' }

const orderScope = (ctx: TrashCtx): Prisma.OrderWhereInput => ({ concept: { tenantId: { in: scopeIds(ctx.readScope) } } })

const ORDER_SELECT = {
  id: true, status: true, source: true, fulfilmentType: true, totalCents: true, conceptId: true,
  customerName: true, cancelledAt: true, cancellationReason: true, updatedAt: true,
  concept: { select: { tenantId: true } },
} satisfies Prisma.OrderSelect
type OrderRowSel = Prisma.OrderGetPayload<{ select: typeof ORDER_SELECT }>

function orderRow(o: OrderRowSel): TrashRow {
  return {
    id: o.id,
    tenantId: o.concept.tenantId ?? null,
    conceptId: o.conceptId,
    title: `Order ${orderRefOf(o.id)} — ${pkr(o.totalCents)}`,
    subtitle: [o.customerName, o.fulfilmentType.replace('_', '-'), o.source === 'pos' ? 'till' : 'online'].filter(Boolean).join(' · '),
    at: o.cancelledAt ?? o.updatedAt,
    reason: o.cancellationReason,
    statusLabel: STATUS_LABEL[o.status] ?? o.status,
    notCopyableReason: o.source === 'pos' ? null : ONLINE_ORDER_NOT_COPYABLE,
  }
}

async function listOrders(ctx: TrashCtx, f: TrashListFilter): Promise<TrashRow[]> {
  const q = f.q?.trim()
  const rows = await db.order.findMany({
    where: {
      AND: [
        orderScope(ctx),
        { status: { in: ['cancelled', 'rejected'] }, cancelledAt: { not: null }, deletedAt: null },
        atWhere('cancelledAt', f),
        q ? { OR: [
          { customerName: { contains: q, mode: 'insensitive' } },
          { cancellationReason: { contains: q, mode: 'insensitive' } },
          { id: { endsWith: q.toLowerCase() } },
        ] } : {},
      ],
    },
    orderBy: [{ cancelledAt: 'desc' }, { id: 'desc' }],
    take: f.limit,
    select: ORDER_SELECT,
  })
  return rows.map(orderRow)
}

async function getOrder(ctx: TrashCtx, id: string): Promise<TrashRow | null> {
  const o = await db.order.findFirst({
    where: { id, ...orderScope(ctx), status: { in: ['cancelled', 'rejected'] }, deletedAt: null },
    select: ORDER_SELECT,
  })
  return o ? orderRow(o) : null
}

interface PrefillLine {
  menuItemId: string
  name: string
  quantity: number
  notes: string | null
  modifierIds: string[]
  modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>
  unitPriceCents: number
}

/**
 * Today's version of the original lines: only dishes still live on the brand's
 * menu, only modifiers still live, at today's prices. Everything dropped is a
 * warning the till shows.
 */
async function repriceLines(
  conceptId: string,
  items: Array<{ menuItemId: string | null; name: string; quantity: number; notes: string | null; modifiers: Array<{ modifierId: string | null; name: string }> }>,
): Promise<{ lines: PrefillLine[]; warnings: string[] }> {
  const ids = [...new Set(items.map((i) => i.menuItemId).filter((x): x is string => !!x))]
  const modIds = [...new Set(items.flatMap((i) => i.modifiers.map((m) => m.modifierId)).filter((x): x is string => !!x))]
  const [menu, mods] = await Promise.all([
    ids.length
      ? db.menuItem.findMany({ where: { id: { in: ids }, conceptId, deletedAt: null }, select: { id: true, name: true, priceCents: true, isAvailable: true } })
      : [],
    modIds.length
      ? db.modifier.findMany({
          where: { id: { in: modIds }, deletedAt: null, group: { deletedAt: null, menuItem: { conceptId, deletedAt: null } } },
          select: { id: true, name: true, priceDeltaCents: true, group: { select: { menuItemId: true } } },
        })
      : [],
  ])
  const menuById = new Map(menu.map((m) => [m.id, m]))
  const modById = new Map(mods.map((m) => [m.id, m]))
  const lines: PrefillLine[] = []
  const warnings: string[] = []
  for (const it of items) {
    const m = it.menuItemId ? menuById.get(it.menuItemId) : undefined
    if (!m || !m.isAvailable) {
      warnings.push(`${it.name} is no longer on the menu — left out`)
      continue
    }
    const keep: PrefillLine['modifiers'] = []
    for (const om of it.modifiers) {
      const mm = om.modifierId ? modById.get(om.modifierId) : undefined
      if (!mm || mm.group.menuItemId !== m.id) { warnings.push(`${it.name}: "${om.name}" is no longer offered — left out`); continue }
      keep.push({ modifierId: mm.id, name: mm.name, priceDeltaCents: mm.priceDeltaCents })
    }
    lines.push({
      menuItemId: m.id,
      name: m.name,
      quantity: it.quantity,
      notes: it.notes,
      modifierIds: keep.map((k) => k.modifierId),
      modifiers: keep,
      unitPriceCents: m.priceCents + keep.reduce((s, k) => s + k.priceDeltaCents, 0),
    })
  }
  return { lines, warnings }
}

const order: TrashProvider = {
  key: TRASH_ORDERS.order,
  label: 'Order',
  moduleId: 'orders',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/orders',
  list: listOrders,
  get: getOrder,
  async preview(ctx, id) {
    const o = await db.order.findFirst({
      where: { id, ...orderScope(ctx) },
      select: {
        status: true, source: true, fulfilmentType: true, totalCents: true, customerName: true, placedAt: true, cancellationReason: true,
        items: { where: { status: { not: 'voided' } }, select: { name: true, quantity: true } },
      },
    })
    if (!o) return []
    return [
      { label: 'Status', value: STATUS_LABEL[o.status] ?? o.status },
      { label: 'Source', value: o.source === 'pos' ? 'Till' : 'Online' },
      { label: 'Order type', value: o.fulfilmentType.replace('_', '-') },
      { label: 'Total', value: pkr(o.totalCents) },
      { label: 'Placed', value: o.placedAt.toISOString() },
      ...(o.customerName ? [{ label: 'Customer', value: o.customerName }] : []),
      ...(o.cancellationReason ? [{ label: 'Reason', value: o.cancellationReason }] : []),
      { label: 'Lines', value: o.items.map((i) => `${i.quantity} × ${i.name}`).join(', ') || '—' },
    ]
  },
  async copy(ctx, id) {
    const o = await db.order.findFirst({
      where: { id, ...orderScope(ctx), status: { in: ['cancelled', 'rejected'] }, deletedAt: null },
      select: {
        id: true, source: true, conceptId: true, fulfilmentType: true, tableId: true, customerId: true,
        items: {
          where: { status: { not: 'voided' } },
          orderBy: { createdAt: 'asc' },
          select: { menuItemId: true, name: true, quantity: true, notes: true, modifiers: { select: { modifierId: true, name: true } } },
        },
      },
    })
    if (!o) throw new NotFoundError('Trash item', id)
    const { lines, warnings } = await repriceLines(o.conceptId, o.items)
    // The table only when it is still the brand's, live and free.
    let tableId: string | null = null
    if (o.tableId) {
      const t = await db.table.findFirst({ where: { id: o.tableId, conceptId: o.conceptId, deletedAt: null }, select: { status: true } })
      if (t && t.status === 'available') tableId = o.tableId
      else warnings.push('The table is taken or gone — pick one on the till')
    }
    if (!lines.length) warnings.push('Nothing from this order is on today\'s menu')
    return prefill('/pos', {
      fromOrderId: o.id,
      fromOrderRef: orderRefOf(o.id),
      conceptId: o.conceptId,
      fulfilmentType: o.fulfilmentType,
      tableId,
      customerId: o.customerId,
      items: lines,
      warnings,
    })
  },
  erasable: () => false,
}

// ── Voided order lines ───────────────────────────────────────────────────────

const ITEM_SELECT = {
  id: true, name: true, quantity: true, unitPriceCents: true, voidedAt: true, voidReason: true, updatedAt: true,
  order: { select: { id: true, status: true, source: true, conceptId: true, concept: { select: { tenantId: true } } } },
} satisfies Prisma.OrderItemSelect
type ItemSel = Prisma.OrderItemGetPayload<{ select: typeof ITEM_SELECT }>

function itemNotCopyable(o: ItemSel['order']): string | null {
  if (o.source !== 'pos') return ONLINE_ORDER_NOT_COPYABLE
  if (!(OPEN_STATUSES as readonly string[]).includes(o.status)) return 'The ticket is closed — recover the order as a copy instead'
  return null
}

function itemRow(i: ItemSel): TrashRow {
  return {
    id: i.id,
    tenantId: i.order.concept.tenantId ?? null,
    conceptId: i.order.conceptId,
    title: `${i.quantity} × ${i.name}`,
    subtitle: `Order ${orderRefOf(i.order.id)} · ${pkr(i.unitPriceCents * i.quantity)}`,
    at: i.voidedAt ?? i.updatedAt,
    reason: i.voidReason,
    statusLabel: 'Voided',
    notCopyableReason: itemNotCopyable(i.order),
  }
}

const itemScope = (ctx: TrashCtx): Prisma.OrderItemWhereInput => ({ order: { deletedAt: null, ...orderScope(ctx) } })

const orderItem: TrashProvider = {
  key: TRASH_ORDERS.order_item,
  label: 'Voided order line',
  moduleId: 'orders',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'accounting',
  linkOf: () => '/orders',
  async list(ctx, f) {
    const q = f.q?.trim()
    const rows = await db.orderItem.findMany({
      where: {
        AND: [
          itemScope(ctx),
          { status: 'voided', voidedAt: { not: null } },
          atWhere('voidedAt', f),
          qWhere(q, ['name', 'voidReason']),
        ],
      },
      orderBy: [{ voidedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: ITEM_SELECT,
    })
    return sortRows(rows.map(itemRow), f.limit)
  },
  async get(ctx, id) {
    const i = await db.orderItem.findFirst({ where: { id, status: 'voided', ...itemScope(ctx) }, select: ITEM_SELECT })
    return i ? itemRow(i) : null
  },
  async copy(ctx, id) {
    const i = await db.orderItem.findFirst({
      where: { id, status: 'voided', ...itemScope(ctx) },
      select: {
        menuItemId: true, name: true, quantity: true, notes: true,
        modifiers: { select: { modifierId: true, name: true } },
        order: { select: { id: true, conceptId: true, tableId: true } },
      },
    })
    if (!i) throw new NotFoundError('Trash item', id)
    const { lines, warnings } = await repriceLines(i.order.conceptId, [i])
    return prefill('/pos', {
      orderId: i.order.id,
      orderRef: orderRefOf(i.order.id),
      conceptId: i.order.conceptId,
      tableId: i.order.tableId,
      item: lines[0] ?? null,
      items: lines,
      warnings,
    })
  },
  erasable: () => false,
}

export const ORDER_TRASH_PROVIDERS: readonly TrashProvider[] = [order, orderItem]
