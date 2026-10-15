// moveToTrash — the ONE writer of trash_entries (modules/trash/README.md).
//
// Every module delete route that sends something to the Trash calls this in
// the SAME transaction as its delete / status write, so a delete that rolls
// back leaves no entry and an entry never exists without its delete:
//
//   await prisma.$transaction(async (tx) => {
//     await moveToTrash(tx, req, { type: TRASH.menu_item, entityId: item.id, tenantId, conceptId, title: item.name })
//     await tx.menuItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } })
//   })
//
// Strategy 'snapshot': pass `snapshot: takeSnapshot('Model', row, children)`
// (modules/trash/snapshot.ts) BEFORE the hard delete. The route keeps answering
// 204. `tenantId` is the ROW's company (never the operator's); null only for a
// deliberate company-less row (servd:* pages, legacy logins) — CEO only.

import type { FastifyRequest } from 'fastify'
import type { Prisma, TrashEntry } from '@prisma/client'
import type { Snapshot } from '../modules/trash/snapshot.js'

export type TrashActor = { userId: string | null; actingTenantId?: string | null }

export interface MoveToTrashInput {
  /** Registry key (modules/trash/registry.ts). */
  type: string
  entityId: string
  tenantId: string | null
  conceptId?: string | null
  title: string
  subtitle?: string | null
  parent?: { type: string; id: string } | null
  reason?: string | null
  snapshot?: Snapshot | null
  /** Restore hints: { previous: {...} } for status types, unlinked ids, brand links… */
  meta?: Record<string, unknown>
  /** CEO archive of a transaction: written already archived. */
  archived?: boolean
}

function actorOf(a: FastifyRequest | TrashActor): TrashActor {
  if ('userId' in a) return a
  const su = (a as FastifyRequest).staffUser
  return { userId: su?.id ?? null, actingTenantId: su?.tenantId ?? null }
}

/** The reason a delete request carried (?reason= or body.reason), trimmed, ≤500. */
export function trashReasonOf(req: FastifyRequest): string | null {
  const q = (req.query as Record<string, unknown> | undefined)?.reason
  const b = (req.body as Record<string, unknown> | undefined | null)?.reason
  const r = typeof b === 'string' ? b : typeof q === 'string' ? q : ''
  return r.trim() ? r.trim().slice(0, 500) : null
}

export async function moveToTrash(
  tx: Prisma.TransactionClient,
  who: FastifyRequest | TrashActor,
  input: MoveToTrashInput,
): Promise<TrashEntry> {
  const actor = actorOf(who)
  // One OPEN entry per thing (partial unique trash_entries_open_key): a repeat
  // delete of something already in the Trash keeps the first entry.
  const open = await tx.trashEntry.findFirst({
    where: { entityType: input.type, entityId: input.entityId, restoredAt: null, purgedAt: null },
  })
  if (open) return open
  const now = new Date()
  const entry = await tx.trashEntry.create({
    data: {
      tenantId: input.tenantId,
      entityType: input.type,
      entityId: input.entityId,
      conceptId: input.conceptId ?? null,
      title: input.title.slice(0, 300) || input.type,
      subtitle: input.subtitle?.slice(0, 300) ?? null,
      parentType: input.parent?.type ?? null,
      parentId: input.parent?.id ?? null,
      reason: input.reason ?? null,
      deletedById: actor.userId,
      deletedAt: now,
      snapshot: (input.snapshot ?? undefined) as Prisma.InputJsonValue | undefined,
      meta: (input.meta ?? {}) as Prisma.InputJsonValue,
      ...(input.archived ? { archivedAt: now, archivedById: actor.userId } : {}),
    },
  })
  await tx.auditLog.create({
    data: {
      // A money snapshot (F1–F5) is filed on the books' trail by its provider's
      // own audit; the move itself is an identity event (who deleted what).
      category: 'identity',
      tenantId: input.tenantId,
      action: input.archived ? 'trash.archive' : 'trash.move',
      entity: input.type,
      entityId: input.entityId,
      userId: actor.userId,
      metadata: { title: input.title, reason: input.reason ?? null, entryId: entry.id } as Prisma.InputJsonValue,
    },
  })
  return entry
}
