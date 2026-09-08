// Cross-checks module — the closed-loop inventory + exception endpoints.
// Bundled in one file because they all share the ExceptionFlag spine.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF, ADMIN_ONLY } from '../auth/middleware.js'
import { flagException, acknowledgeException, resolveException, type ExceptionKind } from '../../lib/exceptions.js'
import { assertNotSelfApproval } from '../../lib/separation-of-duties.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { conceptIdsInScope } from '../../lib/tenantScope.js'

// Variance thresholds. Hardcoded for now; later config-driven.
const RECEIVING_VARIANCE_THRESHOLD = 0.05    // 5%
const PRICE_DRIFT_THRESHOLD        = 0.03    // 3%
const YIELD_LOW_THRESHOLD          = 0.85    // < 85% of expected = leak
const SHRINKAGE_THRESHOLD          = 0.02    // > 2% physical vs system = flag

export async function crosschecksRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // RECEIVING — 3-way match between PO, GRN, and supplier bill
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/receiving', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { status } = req.query as { status?: string }
    return prisma.goodsReceipt.findMany({
      where: { ...(status && { status }) },
      include: {
        lines: { include: { } },
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
    })
  })

  fastify.post('/receiving', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = z.object({
      poId:       z.string().uuid().nullable().optional(),
      supplierId: z.string().uuid(),
      photoUrl:   z.string().url().nullable().optional(),
      notes:      z.string().max(500).nullable().optional(),
      lines: z.array(z.object({
        inventoryItemId: z.string().uuid().nullable().optional(),
        description:     z.string().min(1).max(200),
        poQty:           z.number().nullable().optional(),
        receivedQty:     z.number().min(0),
        poUnitCostCents: z.number().int().nullable().optional(),
        unit:            z.string().max(20).default('kg'),
        notes:           z.string().max(200).nullable().optional(),
      })).min(1),
    }).parse(req.body)

    // Separation of duties: receiver ≠ PO creator
    if (body.poId) {
      const po = await prisma.purchaseOrder.findUnique({ where: { id: body.poId }, select: { createdBy: true } })
      if (po) {
        await assertNotSelfApproval({
          actorId: req.staffUser!.id,
          creatorId: po.createdBy,
          action: 'receive_goods',
          entity: 'PurchaseOrder',
          entityId: body.poId,
        })
      }
    }

    // Photo enforcement — above the configured threshold (sum of line value
    // when costs are present) a photo is required to accept the delivery.
    const { getOperationsConfig } = await import('../../lib/setup-config.js')
    const ops = await getOperationsConfig(req.staffUser!.tenantId)
    const photoThreshold = ops?.photoRequiredAboveCents ?? 50000
    const totalValue = body.lines.reduce((s, l) => s + (l.poUnitCostCents ?? 0) * l.receivedQty, 0)
    if (totalValue >= photoThreshold && !body.photoUrl) {
      throw new AppError(
        'PHOTO_REQUIRED',
        `Deliveries above PKR ${(photoThreshold / 100).toFixed(0)} require a dock-door photo. Snap the goods before submitting.`,
        400,
      )
    }

    // Compute variance per line; collect flags to fire after commit
    const flagsToFire: Array<{ kind: ExceptionKind; line: typeof body.lines[number]; variancePct: number }> = []

    const linesData = body.lines.map((l) => {
      let variancePct: number | null = null
      if (l.poQty != null && l.poQty > 0) {
        variancePct = (l.receivedQty - l.poQty) / l.poQty
        if (Math.abs(variancePct) > RECEIVING_VARIANCE_THRESHOLD) {
          flagsToFire.push({
            kind: variancePct < 0 ? 'short_shipment' : 'receiving_variance',
            line: l, variancePct,
          })
        }
      }
      return {
        inventoryItemId: l.inventoryItemId ?? null,
        description: l.description,
        poQty: l.poQty ?? null,
        receivedQty: l.receivedQty,
        poUnitCostCents: l.poUnitCostCents ?? null,
        unit: l.unit,
        variancePct,
        notes: l.notes ?? null,
      }
    })

    const hasVariance = flagsToFire.length > 0

    const receipt = await prisma.goodsReceipt.create({
      data: {
        poId: body.poId ?? null,
        supplierId: body.supplierId,
        receivedById: req.staffUser!.id,
        photoUrl: body.photoUrl ?? null,
        notes: body.notes ?? null,
        status: hasVariance ? 'disputed' : 'accepted',
        varianceFlag: hasVariance,
        lines: { create: linesData },
      },
      include: { lines: true },
    })

    // Bump InventoryItem.currentStock for each line that maps to one
    for (const l of body.lines) {
      if (l.inventoryItemId) {
        await prisma.inventoryItem.update({
          where: { id: l.inventoryItemId },
          data: { currentStock: { increment: l.receivedQty } },
        }).catch(() => {})
      }
    }

    // Fire exception flags (variance, short shipment)
    for (const f of flagsToFire) {
      const sev = f.kind === 'short_shipment' && Math.abs(f.variancePct) > 0.15 ? 'high' : 'medium'
      await flagException({
        kind: f.kind,
        severity: sev,
        title: `${f.kind === 'short_shipment' ? 'Short shipment' : 'Receiving variance'}: ${f.line.description}`,
        description: `Ordered ${f.line.poQty} ${f.line.unit}, received ${f.line.receivedQty} ${f.line.unit} (${(f.variancePct * 100).toFixed(1)}% variance).`,
        entityType: 'GoodsReceipt',
        entityId: receipt.id,
        actorId: req.staffUser!.id,
        metadata: { line: f.line, variancePct: f.variancePct },
      })
    }

    return reply.status(201).send(receipt)
  })

  // ════════════════════════════════════════════════════════════════════════
  // PREP BATCHES — yield tracking
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/prep-batches', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return prisma.prepBatch.findMany({
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

    const batch = await prisma.prepBatch.create({
      data: {
        recipeId: body.recipeId ?? null,
        itemName: body.itemName,
        inputs: body.inputs as never,
        expectedYieldQty: body.expectedYieldQty ?? null,
        actualYieldQty: body.actualYieldQty,
        unit: body.unit,
        yieldVariancePct,
        staffId: req.staffUser!.id,
        photoUrl: body.photoUrl ?? null,
        notes: body.notes ?? null,
      },
    })

    // Deduct each input from inventory at the actual qty drawn
    for (const i of body.inputs) {
      await prisma.inventoryItem.update({
        where: { id: i.inventoryItemId },
        data: { currentStock: { decrement: i.qtyDrawn } },
      }).catch(() => {})
    }

    // Flag if yield is suspiciously low
    if (yieldVariancePct != null && yieldVariancePct < YIELD_LOW_THRESHOLD) {
      const staffUser = await prisma.user.findUnique({ where: { id: req.staffUser!.id }, select: { name: true } })
      await flagException({
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

  fastify.get('/physical-counts', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.physicalCount.findMany({
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

    // Snapshot system stock for each item BEFORE the count adjusts anything
    const items = await prisma.inventoryItem.findMany({
      where: { id: { in: body.lines.map((l) => l.inventoryItemId) } },
      select: { id: true, name: true, currentStock: true },
    })
    const stockMap = new Map(items.map((i) => [i.id, i]))

    const linesData = body.lines.map((l) => {
      const sysQty = stockMap.get(l.inventoryItemId)?.currentStock ?? 0
      const variancePct = sysQty > 0 ? (l.physicalQty - sysQty) / sysQty : 0
      return {
        inventoryItemId: l.inventoryItemId,
        systemQty: sysQty,
        physicalQty: l.physicalQty,
        variancePct,
        reason: l.reason ?? null,
      }
    })

    const count = await prisma.physicalCount.create({
      data: {
        countedById: req.staffUser!.id,
        notes: body.notes ?? null,
        status: 'completed',
        lines: { create: linesData },
      },
      include: { lines: true },
    })

    // Adjust inventory to physical truth + flag significant variances
    for (const l of body.lines) {
      const sysQty = stockMap.get(l.inventoryItemId)?.currentStock ?? 0
      const itemName = stockMap.get(l.inventoryItemId)?.name ?? 'unknown'
      await prisma.inventoryItem.update({
        where: { id: l.inventoryItemId },
        data: { currentStock: l.physicalQty },
      }).catch(() => {})

      const variancePct = sysQty > 0 ? (l.physicalQty - sysQty) / sysQty : 0
      if (Math.abs(variancePct) > SHRINKAGE_THRESHOLD && sysQty > 0) {
        await flagException({
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

    return reply.status(201).send(count)
  })

  // ════════════════════════════════════════════════════════════════════════
  // EXCEPTION INBOX — owner sees only what's broken
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/exceptions', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { status, severity, kind } = req.query as { status?: string; severity?: string; kind?: string }
    return prisma.exceptionFlag.findMany({
      where: {
        ...(status   ? { status: status as never }     : { status: 'open' }),
        ...(severity && { severity: severity as never }),
        ...(kind     && { kind }),
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })
  })

  fastify.get('/exceptions/stats', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const [open, ack, last24h, byKind] = await Promise.all([
      prisma.exceptionFlag.count({ where: { status: 'open' } }),
      prisma.exceptionFlag.count({ where: { status: 'acknowledged' } }),
      prisma.exceptionFlag.count({ where: { createdAt: { gte: new Date(Date.now() - 86400_000) } } }),
      prisma.exceptionFlag.groupBy({
        by: ['kind'], where: { status: 'open' }, _count: { _all: true },
      }),
    ])
    return { open, acknowledged: ack, last24h, byKind: byKind.map((b) => ({ kind: b.kind, count: b._count._all })) }
  })

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/acknowledge',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      try {
        await acknowledgeException(req.params.id, req.staffUser!.id)
        return reply.status(204).send()
      } catch (err) {
        throw new NotFoundError('ExceptionFlag', req.params.id)
      }
    },
  )

  fastify.patch<{ Params: { id: string } }>('/exceptions/:id/resolve',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ resolution: z.string().min(1).max(500) }).parse(req.body)
      try {
        await resolveException(req.params.id, req.staffUser!.id, body.resolution)
        return reply.status(204).send()
      } catch (err) {
        throw new NotFoundError('ExceptionFlag', req.params.id)
      }
    },
  )

  fastify.delete<{ Params: { id: string } }>('/exceptions/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      // Brand-scoped flags belong to one company; company-less platform flags
      // (conceptId null) stay dismissible by anyone who can see them.
      const owned = await prisma.exceptionFlag.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { conceptId: { in: await conceptIdsInScope(req, 'write') } },
          ],
        },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('ExceptionFlag', req.params.id)
      await prisma.exceptionFlag.update({ where: { id: owned.id }, data: { status: 'dismissed' } })
      return reply.status(204).send()
    },
  )
}
