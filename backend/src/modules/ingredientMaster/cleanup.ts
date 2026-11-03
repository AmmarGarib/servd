// Ingredients sheet clean-up (owner, 2026-11-03: "remove all ingredients that are not in a recipe or that have not
// been manually entered or don't have manually entered price — basically all that came from an old seasonal
// mastersheet"). The master-level sibling of inventory/unusedCleanup.ts (which clears ONE company's unused stock
// items); this one clears servd's shared list.
//
//   GET  /ingredient-master/cleanup              preview: { toRemove[], kept: {counts}, counts }
//   POST /ingredient-master/cleanup {ids}         apply:   { removed[], skipped[], counts }
//   POST /ingredient-master/:id/restore           undo one (status back to approved)
//
// CEO only. A master is REMOVED only when ALL of these hold:
//   • it was not typed in by a person (createdByUserId null — it came from the old sheet / the backfill);
//   • it has no price typed on the sheet (no ingredient_master_prices row);
//   • no recipe line names it (recipe_ingredients.masterIngredientId), and none of its companies' stock items is in
//     use, holds stock or has purchase / stock history (inventory/unusedCleanup.ts itemUsage — the same rule).
// Removing = status 'retired' (hidden from the sheet and every picker; nothing deleted, restorable) and each of its
// unused company stock items is parked in the Trash exactly as the stock clean-up does. One transaction per master,
// re-checked under the item locks; one audit row per run (`ingredient_master.cleanup`).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { lockItemsTx } from '../../lib/stockLedger.js'
import { moveToTrash } from '../../lib/trash.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError } from '../../lib/errors.js'
import { itemUsage, INVENTORY_ITEM_TRASH } from '../inventory/unusedCleanup.js'

export const RETIRED = 'retired'
const TX_OPTS = { maxWait: 10_000, timeout: 60_000 }

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

interface Row { id: string; name: string; stockUnit: string; category: string | null }

/** Why a master must stay ([] = it may go). */
async function keepReasons(db: Db, ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  if (ids.length === 0) return out
  const add = (id: string, why: string) => { const l = out.get(id); if (l && !l.includes(why)) l.push(why) }
  const masters = await db.ingredientMaster.findMany({ where: { id: { in: ids } }, select: { id: true, createdByUserId: true } })
  for (const m of masters) if (m.createdByUserId) add(m.id, 'Entered by hand')
  for (const p of await db.ingredientMasterPrice.groupBy({ by: ['masterIngredientId'], where: { masterIngredientId: { in: ids } }, _count: { _all: true } })) {
    add(p.masterIngredientId, 'Has a typed price')
  }
  for (const r of await db.recipeIngredient.groupBy({ by: ['masterIngredientId'], where: { masterIngredientId: { in: ids } }, _count: { _all: true } })) {
    if (r.masterIngredientId) add(r.masterIngredientId, 'In a recipe')
  }
  const items = await db.inventoryItem.findMany({
    where: { masterIngredientId: { in: ids }, deletedAt: null },
    select: { id: true, masterIngredientId: true, currentStock: true },
  })
  const usage = await itemUsage(db, items)
  for (const it of items) {
    const u = usage.get(it.id)!
    if (u.used.length) add(it.masterIngredientId!, 'In a recipe')
    if (u.stock.length) add(it.masterIngredientId!, 'Holds stock')
    if (u.history.length) add(it.masterIngredientId!, 'Bought / stock history')
  }
  return out
}

async function preview() {
  const masters = await prisma.ingredientMaster.findMany({
    where: { mergedIntoId: null, status: { not: RETIRED } },
    select: { id: true, name: true, stockUnit: true, category: true },
    orderBy: { name: 'asc' },
  })
  const reasons = await keepReasons(prisma, masters.map((m) => m.id))
  const toRemove: Row[] = []
  const kept: Record<string, number> = {}
  for (const m of masters) {
    const why = reasons.get(m.id)!
    if (why.length === 0) toRemove.push(m)
    else for (const w of why) kept[w] = (kept[w] ?? 0) + 1
  }
  return { toRemove, kept, counts: { total: masters.length, toRemove: toRemove.length, kept: masters.length - toRemove.length } }
}

export async function ingredientMasterCleanupRoutes(fastify: FastifyInstance) {
  fastify.get('/cleanup', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => preview())

  fastify.post('/cleanup', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req: FastifyRequest) => {
    const ids = [...new Set(z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(5000) }).parse(req.body).ids)]
    const removed: Row[] = []
    const skipped: Array<Row & { reasons: string[] }> = []
    for (const id of ids) {
      try {
        const res = await prisma.$transaction(async (tx) => {
          const items = await tx.inventoryItem.findMany({ where: { masterIngredientId: id, deletedAt: null }, select: { id: true } })
          await lockItemsTx(tx, items.map((i) => i.id))
          const m = await tx.ingredientMaster.findFirst({ where: { id, mergedIntoId: null, status: { not: RETIRED } }, select: { id: true, name: true, stockUnit: true, category: true } })
          if (!m) return { skip: { id, name: '—', stockUnit: '', category: null, reasons: ['Not on the sheet'] } }
          const why = (await keepReasons(tx, [id])).get(id)!
          if (why.length) return { skip: { ...m, reasons: why } }
          const live = await tx.inventoryItem.findMany({ where: { masterIngredientId: id, deletedAt: null }, select: { id: true, name: true, unit: true, tenantId: true } })
          for (const it of live) {
            if (!it.tenantId) continue
            await moveToTrash(tx, req, { type: INVENTORY_ITEM_TRASH, entityId: it.id, tenantId: it.tenantId, title: it.name, subtitle: it.unit, reason: 'Ingredients sheet clean-up (old mastersheet)' })
            await tx.inventoryItem.update({ where: { id: it.id }, data: { deletedAt: new Date() } })
          }
          await tx.ingredientMaster.update({ where: { id }, data: { status: RETIRED } })
          return { removed: m }
        }, TX_OPTS)
        if ('removed' in res && res.removed) removed.push(res.removed)
        else if ('skip' in res && res.skip) skipped.push(res.skip)
      } catch (err) {
        req.log.error({ err, masterId: id }, 'ingredient master clean-up: not removed')
        skipped.push({ id, name: '—', stockUnit: '', category: null, reasons: ['Could not be removed — try again'] })
      }
    }
    const counts = { requested: ids.length, removed: removed.length, skipped: skipped.length }
    await audit({
      category: 'identity', tenantId: null, action: 'ingredient_master.cleanup', entity: 'IngredientMaster',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
      metadata: { ...counts, removedIds: removed.map((r) => r.id) },
    })
    return { removed, skipped, counts }
  })

  fastify.post<{ Params: { id: string } }>('/:id/restore', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const m = await prisma.ingredientMaster.findFirst({ where: { id: req.params.id, status: RETIRED } })
    if (!m) throw new NotFoundError('Removed ingredient', req.params.id)
    await prisma.ingredientMaster.update({ where: { id: m.id }, data: { status: 'approved' } })
    await audit({
      category: 'identity', tenantId: null, action: 'ingredient_master.restore', entity: 'IngredientMaster', entityId: m.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
    })
    return { restored: true, note: 'Its company stock items are in the Trash — restore them there if a company needs them back.' }
  })
}
