// Cross-checks module — the closed-loop inventory + exception endpoints.
// Bundled in one file because they all share the ExceptionFlag spine.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'
import { flagException, acknowledgeException, resolveException, type ExceptionKind } from '../../lib/exceptions.js'
import { receiveGoods } from '../procurement/receiving.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { toPurchaseUnits } from '../../lib/recipeCost.js'
import { conceptIdsInScope, resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'

// Variance thresholds. Hardcoded for now; later config-driven.
const PRICE_DRIFT_THRESHOLD        = 0.03    // 3%
const YIELD_LOW_THRESHOLD          = 0.85    // < 85% of expected = leak
const SHRINKAGE_THRESHOLD          = 0.02    // > 2% physical vs system = flag

export async function crosschecksRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // RECEIVING — the dock-door page. Thin wrappers over procurement
  // receiveGoods(), the ONE receiving path (the PO receive route calls it
  // too): GoodsReceipt + PO line quantities + stock + moving-average cost in
  // one transaction, variance flags after commit. Manager tiers only (owner
  // decision 27) and deliberately not behind the procurement module, so a
  // kitchen manager can take a delivery at the door.
  // ════════════════════════════════════════════════════════════════════════

  // Suppliers the operator can see: their companies' plus company-less ones
  // (which can still carry an old PO). Fails closed on an empty scope.
  async function receivingSupplierIds(req: FastifyRequest): Promise<string[]> {
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return []
    const rows = await prisma.supplier.findMany({
      where:  { OR: [{ tenantId: { in: scope.tenantIds } }, { tenantId: null }] },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  }

  fastify.get('/receiving', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { status } = req.query as { status?: string }
    return prisma.goodsReceipt.findMany({
      where: { supplierId: { in: await receivingSupplierIds(req) }, ...(status && { status }) },
      include: { lines: true },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    })
  })

  // Suppliers a delivery WITHOUT a PO can come from: the active company's.
  fastify.get('/receiving/suppliers', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return []
    return prisma.supplier.findMany({
      where:   { tenantId, deletedAt: null },
      select:  { id: true, name: true },
      orderBy: { name: 'asc' },
    })
  })

  // POs waiting at the dock: approved and sent, or part-received.
  fastify.get('/receiving/open-pos', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.purchaseOrder.findMany({
      where: { supplierId: { in: await receivingSupplierIds(req) }, status: { in: ['sent', 'partial'] } },
      include: {
        supplier: { select: { id: true, name: true } },
        lines:    { include: { inventoryItem: { select: { id: true, name: true, unit: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  })

  fastify.post('/receiving', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      poId:       z.string().uuid().nullable().optional(),
      supplierId: z.string().uuid().nullable().optional(),
      photoUrl:   z.string().url().nullable().optional(),
      notes:      z.string().max(500).nullable().optional(),
      lines: z.array(z.object({
        poLineId:          z.string().uuid().nullable().optional(),
        inventoryItemId:   z.string().uuid().nullable().optional(),
        quantityReceived:  z.number().min(0),
        unitCostCents:     z.number().int().min(0).nullable().optional(),
        discrepancyReason: z.enum(['short_shipment', 'over_shipment', 'damaged', 'wrong_item', 'quality_issue']).nullable().optional(),
        notes:             z.string().max(200).nullable().optional(),
      })).min(1),
    }).parse(req.body)

    // The supplier must be one the operator can see; a delivery without a PO
    // binds new stock, so it must be the ACTIVE company's supplier.
    const supplierId = body.poId
      ? (await prisma.purchaseOrder.findUnique({ where: { id: body.poId }, select: { supplierId: true } }))?.supplierId
      : body.supplierId
    if (!supplierId) throw body.poId ? new NotFoundError('PurchaseOrder', body.poId) : new AppError('SUPPLIER_REQUIRED', 'Pick the supplier for a delivery without a PO', 400)
    if (!(await receivingSupplierIds(req)).includes(supplierId)) {
      throw body.poId ? new NotFoundError('PurchaseOrder', body.poId) : new NotFoundError('Supplier', supplierId)
    }
    if (!body.poId) {
      const sup = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { tenantId: true } })
      if (sup?.tenantId && sup.tenantId !== req.staffUser!.tenantId) {
        throw new AppError('SUPPLIER_NOT_IN_ACTIVE_COMPANY', 'Switch to the supplier\'s company to receive a delivery without a PO', 422)
      }
    }

    const result = await receiveGoods({
      actor:      req.staffUser!,
      poId:       body.poId ?? null,
      supplierId,
      photoUrl:   body.photoUrl ?? null,
      notes:      body.notes ?? null,
      lines:      body.lines,
    })
    return reply.status(201).send({ ...result.receipt, poStatus: result.poStatus, flagged: result.flagged })
  })

  // ════════════════════════════════════════════════════════════════════════
  // PREP BATCHES — yield tracking
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/prep-batches', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return prisma.prepBatch.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
  })

  fastify.post('/prep-batches', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      recipeId:         z.string().uuid().nullable().optional(),
      itemName:         z.string().min(1).max(120),
      inputs:           z.array(z.object({
        inventoryItemId: z.string().uuid(),
        qtyDrawn:        z.number().min(0),
        unit:            z.string().max(20).default('g'),
      })).min(1),
      expectedYieldQty: z.number().min(0).nullable().optional(),
      actualYieldQty:   z.number().min(0),
      unit:             z.string().max(20).default('g'),
      photoUrl:         z.string().url().nullable().optional(),
      notes:            z.string().max(500).nullable().optional(),
    }).parse(req.body)

    let yieldVariancePct: number | null = null
    if (body.expectedYieldQty && body.expectedYieldQty > 0) {
      yieldVariancePct = body.actualYieldQty / body.expectedYieldQty
    }

    // Inputs are weighed in the kitchen (grams by default) but stock is held
    // in PURCHASE units (kg / litres / pcs). The old code subtracted the gram
    // figure straight from kilo stock — 500 g of garlic took 500 kg. Convert
    // through lib/recipeCost.ts (the same unit rules as the recipe explosion)
    // and refuse a unit that can't be reconciled rather than guess.
    // Inputs must be the active company's own items: a batch draws that
    // company's stock, and the batch is stamped with it.
    const tenantId = req.staffUser?.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — a prep batch draws one company\'s stock', 422)
    const invItems = await prisma.inventoryItem.findMany({
      where: { id: { in: body.inputs.map((i) => i.inventoryItemId) }, deletedAt: null, tenantId },
      select: { id: true, name: true, unit: true },
    })
    const invById = new Map(invItems.map((i) => [i.id, i]))
    const inputs = body.inputs.map((i) => {
      const inv = invById.get(i.inventoryItemId)
      if (!inv) throw new NotFoundError('InventoryItem', i.inventoryItemId)
      const qtyPurchaseUnits = toPurchaseUnits(i.qtyDrawn, i.unit, inv.unit)
      if (qtyPurchaseUnits == null) {
        throw new AppError('UNIT_MISMATCH', `${inv.name} is stocked in ${inv.unit}; ${i.unit} can't be converted to it`, 422)
      }
      return { ...i, qtyPurchaseUnits, stockUnit: inv.unit }
    })

    // A batch of a SUB-RECIPE (recipeId → kind 'component') is a yield record
    // only: sale-time depletion already explodes that sub-recipe into its raw
    // ingredients when the plates using it sell (the same explosion the ledger
    // costs COGS on), so taking the inputs out here as well would count them
    // twice. Ad-hoc batches (no recipe) still draw their inputs from stock.
    const subRecipe = body.recipeId
      ? await prisma.recipe.findFirst({ where: { id: body.recipeId, kind: 'component' }, select: { id: true } })
      : null

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.prepBatch.create({
        data: {
          tenantId,
          recipeId: body.recipeId ?? null,
          itemName: body.itemName,
          inputs: inputs as never,
          expectedYieldQty: body.expectedYieldQty ?? null,
          actualYieldQty: body.actualYieldQty,
          unit: body.unit,
          yieldVariancePct,
          staffId: req.staffUser!.id,
          photoUrl: body.photoUrl ?? null,
          notes: body.notes ?? null,
        },
      })
      if (!subRecipe) {
        for (const i of inputs) {
          if (!(i.qtyPurchaseUnits > 0)) continue
          // Conditional: never take stock below zero, and fail the whole
          // batch (transaction) rather than record a draw that did not happen.
          const n = await tx.inventoryItem.updateMany({
            where: { id: i.inventoryItemId, currentStock: { gte: i.qtyPurchaseUnits } },
            data: { currentStock: { decrement: i.qtyPurchaseUnits } },
          })
          if (n.count === 0) throw new AppError('INSUFFICIENT_STOCK', `Not enough ${invById.get(i.inventoryItemId)?.name ?? 'stock'} on hand for this batch`, 409)
        }
      }
      return created
    })

    // Flag if yield is suspiciously low
    if (yieldVariancePct != null && yieldVariancePct < YIELD_LOW_THRESHOLD) {
      const staffUser = await prisma.user.findUnique({ where: { id: req.staffUser!.id }, select: { name: true } })
      await flagException({
        tenantId,
        kind: 'yield_low',
        severity: yieldVariancePct < 0.7 ? 'high' : 'medium',
        title: `Low yield: ${body.itemName}`,
        description: `Expected ${body.expectedYieldQty}${body.unit}, actual ${body.actualYieldQty}${body.unit} (${(yieldVariancePct * 100).toFixed(0)}% yield) — chef ${staffUser?.name ?? req.staffUser!.id}.`,
        entityType: 'PrepBatch',
        entityId: batch.id,
        actorId: req.staffUser!.id,
        metadata: { yieldPct: yieldVariancePct, inputs: body.inputs },
      })
    }

    return reply.status(201).send(batch)
  })

  // ════════════════════════════════════════════════════════════════════════
  // PHYSICAL COUNT — periodic spot-checks
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/physical-counts', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.physicalCount.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: { lines: true },
      orderBy: { countedAt: 'desc' },
      take: 50,
    })
  })

  fastify.post('/physical-counts', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      lines: z.array(z.object({
        inventoryItemId: z.string().uuid(),
        physicalQty:     z.number().min(0),
        reason:          z.string().max(200).nullable().optional(),
      })).min(1),
      notes: z.string().max(500).nullable().optional(),
    }).parse(req.body)

    // A count is the ONE way stock on hand is set (decision 28), so it has to
    // be exact: every line is an item of the active company, and the snapshot,
    // the count and the stock set happen together or not at all.
    const tenantId = req.staffUser?.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — a count sets one company\'s stock', 422)
    const ids = body.lines.map((l) => l.inventoryItemId)
    if (new Set(ids).size !== ids.length) throw new AppError('DUPLICATE_LINE', 'An item appears twice in the count', 400)
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, name: true, currentStock: true, tenantId: true },
    })
    for (const id of ids) {
      const it = items.find((x) => x.id === id)
      if (!it || (it.tenantId && it.tenantId !== tenantId)) throw new NotFoundError('InventoryItem', id)
      if (!it.tenantId) throw new AppError('ITEM_UNASSIGNED', `${it.name} belongs to no company yet — assign it on the Sourcing sheet first`, 422)
    }
    const nameOf = new Map(items.map((i) => [i.id, i.name]))

    const count = await prisma.$transaction(async (tx) => {
      // The "system said" snapshot is taken under a row lock, in the same
      // transaction that overwrites stock: a sale deducting between the
      // snapshot and the overwrite would otherwise be counted as shrinkage
      // too, and the ledger adjustment below is valued from this snapshot.
      // Locked in id order so two overlapping counts can't deadlock.
      for (const id of [...ids].sort()) {
        await tx.$queryRaw`SELECT id FROM inventory_items WHERE id = ${id} FOR UPDATE`
      }
      const current = await tx.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, currentStock: true } })
      const stockNow = new Map(current.map((i) => [i.id, i.currentStock]))
      const linesData = body.lines.map((l) => {
        const sysQty = stockNow.get(l.inventoryItemId) ?? 0
        const variancePct = sysQty > 0 ? (l.physicalQty - sysQty) / sysQty : 0
        return {
          inventoryItemId: l.inventoryItemId,
          systemQty: sysQty,
          physicalQty: l.physicalQty,
          variancePct,
          reason: l.reason ?? null,
        }
      })

      const created = await tx.physicalCount.create({
        data: {
          tenantId,
          countedById: req.staffUser!.id,
          notes: body.notes ?? null,
          status: 'completed',
          lines: { create: linesData },
        },
        include: { lines: true },
      })
      // Stock becomes what was counted — inside the same transaction, so a
      // count is never recorded without its stock set (or the reverse).
      for (const l of body.lines) {
        await tx.inventoryItem.update({ where: { id: l.inventoryItemId }, data: { currentStock: l.physicalQty } })
      }
      return created
    })

    // The value of what the count found short / over goes to the ledger in the
    // count's company (countPosting.ts), so the inventory account follows the
    // stock. Idempotent on the count id. A posting failure must not undo a
    // count the kitchen has already made — it is logged with the count id
    // (postStockCount(id) can be re-run) and reported in the response.
    let ledger: { posted: boolean; entryId: string | null; reason?: string }
    try {
      const { postStockCount } = await import('./countPosting.js')
      ledger = await postStockCount(count.id)
    } catch (err) {
      req.log.error({ err: (err as Error).message, physicalCountId: count.id }, 'postStockCount failed')
      ledger = { posted: false, entryId: null, reason: (err as { code?: string }).code ?? 'posting_failed' }
    }

    // Flag significant variances once the count is committed.
    for (const l of count.lines) {
      const sysQty = l.systemQty
      const itemName = nameOf.get(l.inventoryItemId) ?? 'unknown'
      const variancePct = sysQty > 0 ? (l.physicalQty - sysQty) / sysQty : 0
      if (Math.abs(variancePct) > SHRINKAGE_THRESHOLD && sysQty > 0) {
        await flagException({
        tenantId,
        kind: 'shrinkage',
          severity: Math.abs(variancePct) > 0.1 ? 'high' : 'medium',
          title: `Shrinkage detected: ${itemName}`,
          description: `System said ${sysQty.toFixed(2)}, physical count ${l.physicalQty.toFixed(2)} (${(variancePct * 100).toFixed(1)}%).`,
          entityType: 'PhysicalCount',
          entityId: count.id,
          actorId: req.staffUser!.id,
          metadata: { itemId: l.inventoryItemId, itemName, sysQty, physicalQty: l.physicalQty, variancePct, reason: l.reason },
        })
      }
    }

    return reply.status(201).send({ ...count, ledger })
  })

  // ════════════════════════════════════════════════════════════════════════
  // EXCEPTION INBOX — owner sees only what's broken
  // ════════════════════════════════════════════════════════════════════════

  // Every read and write here is scoped by ExceptionFlag.tenantId: the inbox
  // shows the operator's companies' flags only ('read' — view-aware), and a
  // flag of any other company is 404 on acknowledge / resolve / dismiss
  // ('write' — every company the operator belongs to). Company-less flags
  // (legacy rows nothing could attribute) are shown to nobody.
  //
  // Who: the manager tiers plus finance (FINANCE_TEAM). Finance holds the
  // `exceptions` module by default (lib/moduleAccess.ts) and the inbox is in
  // the Finance workspace — cash variances, refunds, manual journals land
  // here — yet the routes refused it with 403 (2026-10-10 audit, BOOKS-02).
  // Finance can read, acknowledge and resolve; dismissing stays CEO-only.

  fastify.get('/exceptions', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const { status, severity, kind } = req.query as { status?: string; severity?: string; kind?: string }
    return prisma.exceptionFlag.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(status   ? { status: status as never }     : { status: 'open' }),
        ...(severity && { severity: severity as never }),
        ...(kind     && { kind }),
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })
  })

  fastify.get('/exceptions/stats', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const [open, ack, last24h, byKind] = await Promise.all([
      prisma.exceptionFlag.count({ where: { ...scope, status: 'open' } }),
      prisma.exceptionFlag.count({ where: { ...scope, status: 'acknowledged' } }),
      prisma.exceptionFlag.count({ where: { ...scope, createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
      prisma.exceptionFlag.groupBy({
        by: ['kind'], where: { ...scope, status: 'open' }, _count: { _all: true },
      }),
    ])
    return { open, acknowledged: ack, last24h, byKind: byKind.map((b) => ({ kind: b.kind, count: b._count._all })) }
  })

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/acknowledge',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req, reply) => {
      const ok = await acknowledgeException(req.params.id, req.staffUser!.id, await scopeTenantWhere(req, 'write'))
      if (!ok) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/resolve',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req, reply) => {
      const body = z.object({ resolution: z.string().min(1).max(500) }).parse(req.body)
      const ok = await resolveException(req.params.id, req.staffUser!.id, body.resolution, await scopeTenantWhere(req, 'write'))
      if (!ok) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )

  fastify.delete<{ Params: { id: string } }>('/exceptions/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      // Dismiss only a flag of one of the operator's companies. (The old
      // `conceptId: null` branch let anyone dismiss any brand-less flag —
      // most of them — of any company.)
      const r = await prisma.exceptionFlag.updateMany({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        data: { status: 'dismissed' },
      })
      if (r.count === 0) throw new NotFoundError('ExceptionFlag', req.params.id)
      return reply.status(204).send()
    },
  )
}
