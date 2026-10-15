// The Trash service (README.md): list, detail, restore, copy, purge, archive —
// the shared guards. Providers (registry.ts) hold each type's own rules.
//
// trash_entries is read on serviceClient (company-less entries are invisible
// under RLS) with an EXPLICIT company scope built from scopeTenantWhere: an
// empty scope denies, a company-less entry is the CEO's only, a foreign entry
// is 404.

import { Prisma, type TrashEntry } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { moveToTrash } from '../../lib/trash.js'
import type { TenantIdWhere } from '../../lib/tenantScope.js'
import { trashProviders, trashProvider } from './registry.js'
import { restoreSnapshot, type Snapshot } from './snapshot.js'
import type {
  CopyResult, RestoreOpts, TrashCtx, TrashItem, TrashKind, TrashProvider, TrashRow, TrashState, Tx,
} from './types.js'

const db = serviceClient

// ── Who may see / do what ────────────────────────────────────────────────────

export function canList(ctx: TrashCtx, p: TrashProvider): boolean {
  if (ctx.isCeo) return true
  if (p.ceoOnly) return false
  return ctx.modules.has(p.moduleId) && p.roles.list.includes(ctx.user.role)
}

export function canRestore(ctx: TrashCtx, p: TrashProvider): boolean {
  if (p.kind !== 'master' || p.strategy === 'none' || p.restorable === false) return false
  if (ctx.isCeo) return true
  return canList(ctx, p) && p.roles.restore.includes(ctx.user.role)
}

export function canCopy(ctx: TrashCtx, p: TrashProvider): boolean {
  if (!p.copy) return false
  if (ctx.isCeo) return true
  return canList(ctx, p) && (p.roles.copy ?? p.roles.restore).includes(ctx.user.role)
}

export function visibleProviders(ctx: TrashCtx): TrashProvider[] {
  return trashProviders().filter((p) => canList(ctx, p))
}

function providerOr404(ctx: TrashCtx, type: string): TrashProvider {
  const p = trashProvider(type)
  // An unknown type and a type this login may not see answer the same 404.
  if (!p || !canList(ctx, p)) throw new NotFoundError('Trash type', type)
  return p
}

// ── Company scope on trash_entries ──────────────────────────────────────────

function idsOf(scope: TenantIdWhere): string[] {
  const t = scope.tenantId
  return typeof t === 'string' ? [t] : [...t.in]
}

/** Entries in `scope`; the CEO also sees company-less entries. Empty scope → nothing. */
function entryScope(ctx: TrashCtx, scope: TenantIdWhere): Prisma.TrashEntryWhereInput {
  const ids = idsOf(scope)
  if (ctx.isCeo) return { OR: [{ tenantId: { in: ids } }, { tenantId: null }] }
  return { tenantId: { in: ids } }
}

function inScope(ctx: TrashCtx, scope: TenantIdWhere, tenantId: string | null): boolean {
  if (tenantId === null) return ctx.isCeo
  return idsOf(scope).includes(tenantId)
}

function stateOf(e: Pick<TrashEntry, 'restoredAt' | 'purgedAt' | 'archivedAt'>): TrashState {
  if (e.purgedAt) return 'purged'
  if (e.restoredAt) return 'restored'
  if (e.archivedAt) return 'archived'
  return 'in_trash'
}

function stateWhere(state: TrashState): Prisma.TrashEntryWhereInput {
  switch (state) {
    case 'in_trash': return { restoredAt: null, purgedAt: null, archivedAt: null }
    case 'restored': return { restoredAt: { not: null } }
    case 'purged':   return { purgedAt: { not: null } }
    case 'archived': return { archivedAt: { not: null }, purgedAt: null, restoredAt: null }
  }
}

// ── Cursor ───────────────────────────────────────────────────────────────────

export interface Cursor { at: Date; id: string }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ at: c.at.toISOString(), id: c.id })).toString('base64url')
}

export function decodeCursor(s: string | undefined): Cursor | undefined {
  if (!s) return undefined
  try {
    const o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as { at: string; id: string }
    const at = new Date(o.at)
    if (Number.isNaN(at.getTime()) || typeof o.id !== 'string') throw new Error('bad')
    return { at, id: o.id }
  } catch {
    throw new AppError('BAD_CURSOR', 'The list position is not valid — reload the Trash', 400)
  }
}

const olderThan = (a: { at: Date; id: string }, c: Cursor) =>
  a.at.getTime() < c.at.getTime() || (a.at.getTime() === c.at.getTime() && a.id < c.id)

// ── Name lookups (one query each per page) ───────────────────────────────────

async function names(userIds: Array<string | null | undefined>, tenantIds: Array<string | null | undefined>, conceptIds: Array<string | null | undefined>) {
  const u = [...new Set(userIds.filter(Boolean) as string[])]
  const t = [...new Set(tenantIds.filter(Boolean) as string[])]
  const c = [...new Set(conceptIds.filter(Boolean) as string[])]
  const [users, tenants, concepts] = await Promise.all([
    u.length ? db.user.findMany({ where: { id: { in: u } }, select: { id: true, name: true, email: true } }) : [],
    t.length ? db.tenant.findMany({ where: { id: { in: t } }, select: { id: true, name: true } }) : [],
    c.length ? db.concept.findMany({ where: { id: { in: c } }, select: { id: true, name: true } }) : [],
  ])
  return {
    user: new Map(users.map((x) => [x.id, x.name || x.email || 'Someone'])),
    tenant: new Map(tenants.map((x) => [x.id, x.name])),
    concept: new Map(concepts.map((x) => [x.id, x.name])),
  }
}

async function copyCounts(keys: Array<{ type: string; id: string }>) {
  const out = new Map<string, { count: number; lastBy: string | null; lastAt: Date }>()
  if (!keys.length) return out
  const rows = await db.trashCopy.findMany({
    where: { OR: keys.map((k) => ({ entityType: k.type, entityId: k.id })) },
    orderBy: { copiedAt: 'desc' },
    select: { entityType: true, entityId: true, copiedById: true, copiedAt: true },
  })
  for (const r of rows) {
    const k = `${r.entityType}:${r.entityId}`
    const cur = out.get(k)
    if (cur) cur.count++
    else out.set(k, { count: 1, lastBy: r.copiedById, lastAt: r.copiedAt })
  }
  return out
}

// ── Types ────────────────────────────────────────────────────────────────────

export async function listTypes(ctx: TrashCtx) {
  const visible = visibleProviders(ctx)
  const entryTypes = visible.filter((p) => p.strategy !== 'none').map((p) => p.key)
  const counts = entryTypes.length
    ? await db.trashEntry.groupBy({
        by: ['entityType'],
        where: { entityType: { in: entryTypes }, ...stateWhere('in_trash'), ...entryScope(ctx, ctx.readScope) },
        _count: { _all: true },
      })
    : []
  const byType = new Map(counts.map((c) => [c.entityType, c._count._all]))
  return {
    types: visible.map((p) => ({
      key: p.key,
      label: p.label,
      kind: p.kind,
      moduleId: p.moduleId,
      strategy: p.strategy,
      count: p.strategy === 'none' ? null : (byType.get(p.key) ?? 0),
      canRestore: canRestore(ctx, p),
      canCopy: canCopy(ctx, p),
      ceoOnly: !!p.ceoOnly,
    })),
  }
}

// ── List ─────────────────────────────────────────────────────────────────────

export interface ListQuery {
  type?: string
  module?: string
  kind?: TrashKind
  state: TrashState
  from?: Date
  to?: Date
  q?: string
  cursor?: string
  limit: number
}

interface Merged { p: TrashProvider; row: TrashRow; entry: TrashEntry | null }

export async function listTrash(ctx: TrashCtx, q: ListQuery): Promise<{ items: TrashItem[]; nextCursor: string | null }> {
  if ((q.state === 'purged' || q.state === 'archived') && !ctx.isCeo) throw new ForbiddenError('Only the CEO sees deleted-forever and archived items')
  const cursor = decodeCursor(q.cursor)
  const providers = visibleProviders(ctx).filter((p) =>
    (!q.type || p.key === q.type) && (!q.module || p.moduleId === q.module) && (!q.kind || p.kind === q.kind))
  const take = q.limit + 1
  const merged: Merged[] = []

  // 1. Entry-backed: every master; plus archived / restored transaction entries.
  const entryTypes = providers
    .filter((p) => p.strategy !== 'none' || q.state === 'archived')
    .map((p) => p.key)
  if (entryTypes.length) {
    const where: Prisma.TrashEntryWhereInput = {
      AND: [
        { entityType: { in: entryTypes } },
        stateWhere(q.state),
        entryScope(ctx, ctx.readScope),
        ...(q.from ? [{ deletedAt: { gte: q.from } }] : []),
        ...(q.to ? [{ deletedAt: { lte: q.to } }] : []),
        ...(q.q ? [{ OR: [{ title: { contains: q.q, mode: 'insensitive' as const } }, { subtitle: { contains: q.q, mode: 'insensitive' as const } }] }] : []),
        ...(cursor ? [{ OR: [{ deletedAt: { lt: cursor.at } }, { deletedAt: cursor.at, entityId: { lt: cursor.id } }] }] : []),
      ],
    }
    const rows = await db.trashEntry.findMany({ where, orderBy: [{ deletedAt: 'desc' }, { entityId: 'desc' }], take })
    for (const e of rows) {
      const p = providers.find((x) => x.key === e.entityType)!
      merged.push({
        p, entry: e,
        row: { id: e.entityId, tenantId: e.tenantId, conceptId: e.conceptId, title: e.title, subtitle: e.subtitle, at: e.deletedAt, byId: e.deletedById, reason: e.reason },
      })
    }
  }

  // 2. Transactions read from their own status (only "in the Trash" — a
  //    transaction is never restored or purged; archived ones come from 1).
  if (q.state === 'in_trash') {
    const txProviders = providers.filter((p) => p.strategy === 'none' && p.list)
    const results = await Promise.all(txProviders.map(async (p) => {
      const rows = await p.list!(ctx, { from: q.from, to: q.to, q: q.q, before: cursor, limit: take })
      if (!rows.length) return [] as Merged[]
      const archived = await db.trashEntry.findMany({
        where: { entityType: p.key, entityId: { in: rows.map((r) => r.id) }, archivedAt: { not: null }, purgedAt: null },
        select: { entityId: true },
      })
      const hide = new Set(archived.map((a) => a.entityId))
      return rows
        .filter((r) => !hide.has(r.id) && inScope(ctx, ctx.readScope, r.tenantId) && (!cursor || olderThan(r, cursor)))
        .map((row) => ({ p, row, entry: null }))
    }))
    for (const r of results) merged.push(...r)
  }

  merged.sort((a, b) => b.row.at.getTime() - a.row.at.getTime() || (b.row.id < a.row.id ? -1 : b.row.id > a.row.id ? 1 : 0))
  const page = merged.slice(0, q.limit)
  const next = merged.length > q.limit ? page[page.length - 1] : null
  return { items: await toItems(ctx, page), nextCursor: next ? encodeCursor({ at: next.row.at, id: next.row.id }) : null }
}

async function toItems(ctx: TrashCtx, page: Merged[]): Promise<TrashItem[]> {
  const n = await names(
    page.flatMap((m) => [m.row.byId, m.entry?.restoredById]),
    page.map((m) => m.row.tenantId),
    page.map((m) => m.row.conceptId),
  )
  const copies = await copyCounts(page.map((m) => ({ type: m.p.key, id: m.row.id })))
  return page.map(({ p, row, entry }) => {
    const c = copies.get(`${p.key}:${row.id}`)
    const state = entry ? stateOf(entry) : 'in_trash'
    const notCopyable = row.notCopyableReason ?? (p.copy ? null : p.notCopyableReason ?? null)
    return {
      type: p.key,
      id: row.id,
      kind: p.kind,
      label: p.label,
      title: row.title,
      subtitle: row.subtitle ?? null,
      tenantId: row.tenantId,
      companyName: row.tenantId ? n.tenant.get(row.tenantId) ?? null : null,
      brandName: row.conceptId ? n.concept.get(row.conceptId) ?? null : null,
      at: row.at.toISOString(),
      byName: row.byId ? n.user.get(row.byId) ?? null : null,
      reason: row.reason ?? null,
      state,
      restoredAt: entry?.restoredAt?.toISOString() ?? null,
      restoredByName: entry?.restoredById ? n.user.get(entry.restoredById) ?? null : null,
      purgedAt: entry?.purgedAt?.toISOString() ?? null,
      archivedAt: entry?.archivedAt?.toISOString() ?? null,
      statusLabel: row.statusLabel ?? null,
      canRestore: state === 'in_trash' && canRestore(ctx, p) && inScope(ctx, ctx.writeScope, row.tenantId),
      canCopy: (state === 'in_trash' || state === 'archived') && canCopy(ctx, p) && !notCopyable,
      notCopyableReason: notCopyable,
      erasable: p.kind === 'master' && p.strategy !== 'status' && p.strategy !== 'none' && p.erasable(entry, []),
      link: p.linkOf?.(row.id, entry) ?? null,
      copies: c ? { count: c.count, lastByName: c.lastBy ? n.user.get(c.lastBy) ?? null : null, lastAt: c.lastAt.toISOString() } : undefined,
    }
  })
}

// ── One item ─────────────────────────────────────────────────────────────────

async function latestEntry(type: string, id: string): Promise<TrashEntry | null> {
  return db.trashEntry.findFirst({ where: { entityType: type, entityId: id }, orderBy: { createdAt: 'desc' } })
}

/** The provider + entry / row for (type, id) in `scope`, or 404. */
async function resolve(ctx: TrashCtx, type: string, id: string, scope: TenantIdWhere) {
  const p = providerOr404(ctx, type)
  const entry = await latestEntry(type, id)
  if (entry && !inScope(ctx, scope, entry.tenantId)) throw new NotFoundError('Trash item', id)
  let row: TrashRow | null = null
  if (p.strategy === 'none' && p.get) {
    row = await p.get(ctx, id)
    if (row && !inScope(ctx, scope, row.tenantId)) row = null
    if (!row) throw new NotFoundError('Trash item', id)
  } else if (!entry) {
    throw new NotFoundError('Trash item', id)
  } else {
    row = { id: entry.entityId, tenantId: entry.tenantId, conceptId: entry.conceptId, title: entry.title, subtitle: entry.subtitle, at: entry.deletedAt, byId: entry.deletedById, reason: entry.reason }
  }
  return { p, entry, row }
}

function snapshotPreview(entry: TrashEntry | null): Array<{ label: string; value: string }> {
  const snap = entry?.snapshot as Snapshot | null | undefined
  if (!snap?.row) return []
  const hidden = /^(id|tenantId|.*Hash|.*Secret|password.*|.*Token)$/i
  return Object.entries(snap.row)
    .filter(([k, v]) => !hidden.test(k) && v !== null && v !== '' && typeof v !== 'object')
    .slice(0, 24)
    .map(([k, v]) => ({ label: k, value: String(v) }))
}

export async function getTrashItem(ctx: TrashCtx, type: string, id: string) {
  const { p, entry, row } = await resolve(ctx, type, id, ctx.readScope)
  const [item] = await toItems(ctx, [{ p, row, entry }])
  const parentRef = entry ? p.parentOf?.(entry) ?? null : null
  const parentEntry = parentRef ? await db.trashEntry.findFirst({
    where: { entityType: parentRef.type, entityId: parentRef.id, restoredAt: null, purgedAt: null },
  }) : null
  const references = entry && p.references && !entry.purgedAt
    ? await db.$transaction((tx) => p.references!(tx, entry))
    : []
  const [audits, copies] = await Promise.all([
    db.auditLog.findMany({
      where: { entity: type, entityId: id, action: { startsWith: 'trash.' } },
      orderBy: { createdAt: 'desc' }, take: 50,
      select: { createdAt: true, action: true, userId: true, metadata: true },
    }),
    db.trashCopy.findMany({ where: { entityType: type, entityId: id }, orderBy: { copiedAt: 'desc' }, take: 50 }),
  ])
  const n = await names([...audits.map((a) => a.userId), ...copies.map((c) => c.copiedById)], [], [])
  return {
    item,
    preview: p.preview ? await p.preview(ctx, id, entry) : snapshotPreview(entry),
    parent: parentRef ? { ...parentRef, title: parentEntry?.title ?? parentRef.type, inTrash: !!parentEntry } : null,
    references,
    history: audits.map((a) => ({
      at: a.createdAt.toISOString(),
      action: a.action.replace(/^trash\./, ''),
      byName: a.userId ? n.user.get(a.userId) ?? null : null,
      note: ((a.metadata as Record<string, unknown> | null)?.reason as string | undefined) ?? null,
    })),
    copyHistory: copies.map((c) => ({
      at: c.copiedAt.toISOString(),
      byName: n.user.get(c.copiedById) ?? null,
      newId: c.newEntityId,
      link: null,
    })),
  }
}

// ── Restore ──────────────────────────────────────────────────────────────────

async function lockLatestEntry(tx: Tx, type: string, id: string): Promise<TrashEntry | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "trash_entries" WHERE "entityType" = ${type} AND "entityId" = ${id}
    ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`
  return rows[0] ? tx.trashEntry.findUnique({ where: { id: rows[0].id } }) : null
}

function modelDelegate(tx: Tx, model: string) {
  const key = model.charAt(0).toLowerCase() + model.slice(1)
  const d = (tx as unknown as Record<string, {
    update(a: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>
    delete(a: { where: { id: string } }): Promise<unknown>
  }>)[key]
  if (!d) throw new AppError('TRASH_PROVIDER_BROKEN', `No model ${model}`, 500)
  return d
}

async function defaultRestore(tx: Tx, p: TrashProvider, entry: TrashEntry): Promise<void> {
  if (p.strategy === 'snapshot') {
    if (!entry.snapshot) throw new AppError('PURGED', 'This item was deleted forever', 409)
    await restoreSnapshot(tx, entry.snapshot as unknown as Snapshot, { tenantId: entry.tenantId })
    return
  }
  if (!p.model) throw new AppError('TRASH_PROVIDER_BROKEN', `${p.key} has no restore`, 500)
  if (p.strategy === 'soft') {
    await modelDelegate(tx, p.model).update({ where: { id: entry.entityId }, data: { deletedAt: null } })
  } else if (p.strategy === 'status') {
    const prev = (entry.meta as Record<string, unknown> | null)?.previous as Record<string, unknown> | undefined
    if (!prev || !Object.keys(prev).length) throw new AppError('NOT_RESTORABLE', 'What this item was before is not known — set it again on its own screen', 422)
    await modelDelegate(tx, p.model).update({ where: { id: entry.entityId }, data: prev })
  }
}

export async function restoreTrashItem(ctx: TrashCtx, type: string, id: string, opts: RestoreOpts) {
  const p = providerOr404(ctx, type)
  if (p.kind !== 'master' || p.strategy === 'none') {
    throw new AppError('NOT_RESTORABLE', 'A voided or cancelled transaction is never restored — recover it as a copy', 422)
  }
  if (p.restorable === false) throw new AppError('NOT_RESTORABLE', `${p.label} is kept as a record and cannot be restored`, 422)
  if (!canRestore(ctx, p)) throw new ForbiddenError(p.ceoOnly ? 'Only the CEO can restore this' : 'You cannot restore this')

  const result = await db.$transaction(async (tx) => {
    const entry = await lockLatestEntry(tx, type, id)
    if (!entry || !inScope(ctx, ctx.writeScope, entry.tenantId)) throw new NotFoundError('Trash item', id)
    if (entry.purgedAt) throw new AppError('PURGED', 'This item was deleted forever', 409)
    if (entry.restoredAt) throw new AppError('ALREADY_RESTORED', 'This item was already restored', 409)

    const parent = p.parentOf?.(entry)
    if (parent) {
      const pe = await tx.trashEntry.findFirst({ where: { entityType: parent.type, entityId: parent.id, restoredAt: null, purgedAt: null } })
      if (pe) {
        throw new AppError('PARENT_IN_TRASH', `Restore "${pe.title}" first — it is in the Trash too`, 409, {
          parent: { type: parent.type, id: parent.id, title: pe.title },
        })
      }
    }
    const clash = await p.clashOf?.(tx, entry, opts)
    if (clash) {
      throw new AppError(clash.code ?? 'TRASH_CLASH', clash.message ?? `Another live ${p.label.toLowerCase()} already uses "${clash.value}"`, 409, clash)
    }
    const out = p.restore ? await p.restore(tx, ctx, entry, opts) : await defaultRestore(tx, p, entry)
    const now = new Date()
    await tx.trashEntry.update({ where: { id: entry.id }, data: { restoredAt: now, restoredById: ctx.user.id } })
    await tx.auditLog.create({
      data: {
        category: p.auditCategory, tenantId: entry.tenantId, action: 'trash.restore', entity: type, entityId: id,
        userId: ctx.user.id, userEmail: ctx.user.email,
        metadata: { title: entry.title, reason: opts.reason ?? null, rename: opts.rename ?? null, unlink: !!opts.unlink } as Prisma.InputJsonValue,
      },
    })
    const restoredId = (out && 'id' in out ? out.id : null) ?? id
    return { type, id: restoredId, link: (out && 'link' in out ? out.link : null) ?? p.linkOf?.(restoredId, entry) ?? null }
  })
  return result
}

// ── Recover as copy ──────────────────────────────────────────────────────────

export async function copyTrashItem(ctx: TrashCtx, type: string, id: string): Promise<CopyResult> {
  const { p, row } = await resolve(ctx, type, id, ctx.readScope)
  if (!p.copy) throw new AppError('NOT_COPYABLE', p.notCopyableReason ?? `${p.label} cannot be copied`, 422, { reason: p.notCopyableReason ?? null })
  if (row.notCopyableReason) throw new AppError('NOT_COPYABLE', row.notCopyableReason, 422, { reason: row.notCopyableReason })
  if (!canCopy(ctx, p)) throw new ForbiddenError('You cannot copy this')
  if (row.tenantId && row.tenantId !== ctx.activeTenantId) {
    throw new AppError('COPY_SWITCH_COMPANY', 'This belongs to another company — switch to it first, then recover the copy', 422, { tenantId: row.tenantId })
  }
  const result = await p.copy(ctx, id)
  await db.trashCopy.create({
    data: {
      tenantId: row.tenantId, entityType: type, entityId: id, mode: result.mode,
      newEntityType: result.mode === 'created' ? result.newEntityType ?? type : null,
      newEntityId: result.mode === 'created' ? result.id : null,
      copiedById: ctx.user.id,
    },
  })
  await db.auditLog.create({
    data: {
      category: p.auditCategory, tenantId: row.tenantId, action: 'trash.copy', entity: type, entityId: id,
      userId: ctx.user.id, userEmail: ctx.user.email,
      metadata: { title: row.title, mode: result.mode, newId: result.mode === 'created' ? result.id : null } as Prisma.InputJsonValue,
    },
  })
  return result
}

// ── Delete forever (CEO) ─────────────────────────────────────────────────────

export async function purgeTrashItem(ctx: TrashCtx, type: string, id: string, reason: string) {
  if (!ctx.isCeo) throw new ForbiddenError('Only the CEO can delete from the Trash forever')
  const p = providerOr404(ctx, type)
  if (reason.trim().length < 10) throw new AppError('REASON_REQUIRED', 'Say why it is being erased (10 characters or more)', 422)
  if (p.kind !== 'master' || p.strategy === 'none' || p.strategy === 'status') {
    throw new AppError('NOT_ERASABLE', 'This touched the books, tax or stock and is never erased — archive it instead', 409)
  }
  await db.$transaction(async (tx) => {
    const entry = await lockLatestEntry(tx, type, id)
    if (!entry || !inScope(ctx, ctx.writeScope, entry.tenantId)) throw new NotFoundError('Trash item', id)
    if (entry.purgedAt) throw new AppError('PURGED', 'This item was already deleted forever', 409)
    if (entry.restoredAt) throw new AppError('ALREADY_RESTORED', 'This item was restored — it is no longer in the Trash', 409)
    if (!p.erasable(entry, [])) {
      throw new AppError('NOT_ERASABLE', 'This touched the books, tax or stock and is never erased — archive it instead', 409)
    }
    const refs = (await p.references?.(tx, entry)) ?? []
    if (refs.length && refs.some((r) => r.count > 0)) {
      throw new AppError('IN_USE', 'Other records still point at this, so it cannot be erased', 409, { references: refs.filter((r) => r.count > 0) })
    }
    if (!p.erasable(entry, refs)) {
      throw new AppError('NOT_ERASABLE', 'This touched the books, tax or stock and is never erased — archive it instead', 409)
    }
    if (p.purge) await p.purge(tx, entry)
    else if (p.strategy === 'soft' && p.model) await modelDelegate(tx, p.model).delete({ where: { id: entry.entityId } })
    await tx.trashEntry.update({
      where: { id: entry.id },
      data: { purgedAt: new Date(), purgedById: ctx.user.id, purgeReason: reason.trim().slice(0, 500), snapshot: Prisma.DbNull },
    })
    await tx.auditLog.create({
      data: {
        category: p.auditCategory, tenantId: entry.tenantId, action: 'trash.purge', entity: type, entityId: id,
        userId: ctx.user.id, userEmail: ctx.user.email,
        metadata: { title: entry.title, reason: reason.trim() } as Prisma.InputJsonValue,
      },
    })
  })
}

// ── Archive (CEO): hide from the default list ─────────────────────────────────

export async function archiveTrashItem(ctx: TrashCtx, type: string, id: string, archive: boolean) {
  if (!ctx.isCeo) throw new ForbiddenError('Only the CEO can archive Trash items')
  const { p, entry, row } = await resolve(ctx, type, id, ctx.writeScope)
  await db.$transaction(async (tx) => {
    const open = entry && !entry.restoredAt && !entry.purgedAt ? entry : null
    if (archive) {
      if (open?.archivedAt) return
      if (open) {
        await tx.trashEntry.update({ where: { id: open.id }, data: { archivedAt: new Date(), archivedById: ctx.user.id } })
        await tx.auditLog.create({
          data: { category: p.auditCategory, tenantId: open.tenantId, action: 'trash.archive', entity: type, entityId: id, userId: ctx.user.id, userEmail: ctx.user.email },
        })
      } else {
        if (p.strategy !== 'none') throw new AppError('NOT_IN_TRASH', 'This item is not in the Trash', 409)
        await moveToTrash(tx, { userId: ctx.user.id }, {
          type, entityId: id, tenantId: row.tenantId, conceptId: row.conceptId ?? null,
          title: row.title, subtitle: row.subtitle ?? null, archived: true,
        })
      }
    } else {
      if (!open?.archivedAt) return
      await tx.trashEntry.update({ where: { id: open.id }, data: { archivedAt: null, archivedById: null } })
      await tx.auditLog.create({
        data: { category: p.auditCategory, tenantId: open.tenantId, action: 'trash.unarchive', entity: type, entityId: id, userId: ctx.user.id, userEmail: ctx.user.email },
      })
    }
  })
}
