// A stock item's history (owner, 2026-10-27: "add history on each stock item") — every stock movement of ONE item,
// newest first, read from the ONE store (stock_movements, written only by lib/stockLedger.ts). Read only.
//
//   GET /inventory/:id/movements?locationId=&before=&limit=
//
// The item goes through the inventory route's own auth and company scope (another company's item 404). A locationId
// must be an outlet of the ITEM's company (422 LOCATION_NOT_IN_COMPANY). Rows of one document (a sale line, a receipt
// line, a count line, a waste log…) drawn from several lots are shown as ONE row: the quantities and values summed.
// Values are hidden from the kitchen floor (the inventory route's costsHidden rule). Paging: `before` = the oldest
// `at` of the previous page.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { orderRefOf } from '../../lib/orderRef.js'

/** What each movement kind means, in plain words. */
const KIND_LABEL: Record<string, string> = {
  receipt: 'Delivery received',
  opening: 'Opening stock',
  fifo_cutover: 'Opening stock (system start)',
  count_gain: 'Count — more than the books',
  count_loss: 'Count — less than the books',
  sale: 'Sold (plate recipe)',
  sale_return: 'Sale returned',
  sale_void: 'Sold line voided — wasted',
  waste: 'Waste',
  prep_draw: 'Used in prep',
  prep_make: 'Prep made',
  supplier_return: 'Returned to supplier',
  cost_adjust: 'Cost corrected',
  class_reclass: 'Category changed',
  legacy_return: 'Returned (old record)',
  issue_on_receipt: 'Issued on delivery',
  shortfall_settle: 'Earlier shortfall covered',
  transfer_out: 'Sent to another outlet / brand',
  transfer_in: 'Received from another outlet / brand',
}

export interface ItemHistoryOpts { readers: UserRole[]; hideCosts: (req: FastifyRequest) => boolean; itemWhere: (req: FastifyRequest) => Promise<object> }

export async function itemHistoryRoutes(fastify: FastifyInstance, opts: ItemHistoryOpts) {
  fastify.get<{ Params: { id: string }; Querystring: { locationId?: string; before?: string; limit?: string } }>(
    '/:id/movements', { preHandler: requireAuth(...opts.readers) },
    async (req) => {
      const item = await prisma.inventoryItem.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await opts.itemWhere(req)) },
        select: { id: true, name: true, unit: true, tenantId: true, currentStock: true },
      })
      if (!item) throw new NotFoundError('InventoryItem', req.params.id)
      if (!item.tenantId) return { item: { id: item.id, name: item.name, unit: item.unit }, costsHidden: opts.hideCosts(req), rows: [], nextBefore: null }

      const locationId = req.query.locationId || null
      if (locationId) {
        const loc = await prisma.location.findFirst({ where: { id: locationId, tenantId: item.tenantId }, select: { id: true } })
        if (!loc) throw new AppError('LOCATION_NOT_IN_COMPANY', 'That location is not one of this item\'s company outlets', 422)
      }
      const before = req.query.before ? new Date(req.query.before) : null
      if (before && Number.isNaN(before.getTime())) throw new AppError('INVALID_DATE', 'before must be a date', 422)
      const limit = Math.min(Math.max(parseInt(req.query.limit ?? '100', 10) || 100, 1), 300)
      const hide = opts.hideCosts(req)

      const raw = await prisma.stockMovement.findMany({
        where: {
          tenantId: item.tenantId, inventoryItemId: item.id,
          ...(locationId ? { locationId } : {}),
          ...(before ? { occurredAt: { lt: before } } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
        take: limit * 4,
        select: { id: true, kind: true, qty: true, valueCents: true, occurredAt: true, locationId: true, conceptId: true, orderId: true, sourceType: true, sourceId: true, createdById: true },
      })

      // One row per document: the same source, kind, site and brand (a draw over several lots).
      type Row = { key: string; at: Date; kind: string; qty: number; valueCents: number; locationId: string | null; conceptId: string | null; orderId: string | null; sourceType: string; sourceId: string; createdById: string | null }
      const rows: Row[] = []
      const byKey = new Map<string, Row>()
      for (const m of raw) {
        const key = `${m.sourceType}|${m.sourceId}|${m.kind}|${m.locationId ?? ''}|${m.conceptId ?? ''}`
        const hit = byKey.get(key)
        if (hit) { hit.qty += m.qty; hit.valueCents += toCents(m.valueCents); continue }
        if (rows.length >= limit) break
        const row: Row = { key, at: m.occurredAt, kind: m.kind, qty: m.qty, valueCents: toCents(m.valueCents), locationId: m.locationId, conceptId: m.conceptId, orderId: m.orderId, sourceType: m.sourceType, sourceId: m.sourceId, createdById: m.createdById }
        byKey.set(key, row); rows.push(row)
      }
      // Never cut a document in half at the page edge: drop the oldest row when the fetch may have stopped inside it.
      const full = raw.length === limit * 4
      if (full && rows.length > 1) rows.pop()

      const ids = <T>(xs: (T | null)[]) => [...new Set(xs.filter((x): x is T => x != null))]
      const saleLineIds = ids(rows.filter((r) => r.sourceType === 'order_item.sale').map((r) => r.sourceId))
      const receiptLineIds = ids(rows.filter((r) => r.sourceType === 'goods_receipt_line').map((r) => r.sourceId))
      const [locs, brands, users, lines, receiptLines] = await Promise.all([
        prisma.location.findMany({ where: { id: { in: ids(rows.map((r) => r.locationId)) }, tenantId: item.tenantId }, select: { id: true, name: true } }),
        prisma.concept.findMany({ where: { id: { in: ids(rows.map((r) => r.conceptId)) }, tenantId: item.tenantId }, select: { id: true, name: true } }),
        prisma.user.findMany({ where: { id: { in: ids(rows.map((r) => r.createdById)) } }, select: { id: true, name: true } }),
        saleLineIds.length ? prisma.orderItem.findMany({ where: { id: { in: saleLineIds } }, select: { id: true, name: true, quantity: true } }) : Promise.resolve([]),
        receiptLineIds.length ? prisma.goodsReceiptLine.findMany({ where: { id: { in: receiptLineIds } }, select: { id: true, receipt: { select: { supplierId: true, tenantId: true } } } }) : Promise.resolve([]),
      ])
      const suppliers = await prisma.supplier.findMany({
        where: { id: { in: ids(receiptLines.filter((l) => l.receipt.tenantId === item.tenantId).map((l) => l.receipt.supplierId)) } }, select: { id: true, name: true },
      })
      const name = <X extends { id: string; name: string }>(xs: X[], id: string | null) => (id ? xs.find((x) => x.id === id)?.name ?? null : null)
      const lineOf = new Map(lines.map((l) => [l.id, l]))
      const supplierOfLine = new Map(receiptLines.map((l) => [l.id, suppliers.find((s) => s.id === l.receipt.supplierId)?.name ?? null]))

      return {
        item: { id: item.id, name: item.name, unit: item.unit, onHand: item.currentStock },
        costsHidden: hide,
        rows: rows.map((r) => {
          const line = r.sourceType === 'order_item.sale' ? lineOf.get(r.sourceId) : undefined
          const detail = line ? `${line.quantity} × ${line.name}` : r.sourceType === 'goods_receipt_line' ? (supplierOfLine.get(r.sourceId) ?? null) : null
          return {
            id: r.key, at: r.at, kind: r.kind, kindLabel: KIND_LABEL[r.kind] ?? r.kind,
            qty: Math.round(r.qty * 1000) / 1000,
            valueCents: hide ? null : r.valueCents,
            location: name(locs, r.locationId), brand: name(brands, r.conceptId),
            orderRef: r.orderId ? orderRefOf(r.orderId) : null, detail,
            by: name(users, r.createdById),
          }
        }),
        nextBefore: rows.length === limit || full ? rows[rows.length - 1]?.at ?? null : null,
      }
    },
  )
}
