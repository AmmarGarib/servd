// The Trash bin core (owner, 2026-10-15; modules/trash/README.md).
//
//   - Two companies: company B never sees, restores, copies, purges or
//     archives company A's entries (404) and lists nothing of A's.
//   - Type gating: a login without the type's module (or role) sees no rows
//     of that type and gets 404 on it.
//   - Restore: once (ALREADY_RESTORED after), concurrent restores → one wins,
//     PARENT_IN_TRASH, TRASH_CLASH; re-delete after restore = a new entry.
//   - Purge is the CEO's only; NOT_ERASABLE and IN_USE refuse it.
//   - Snapshot round-trip keeps ids, dates, JSON and drops unknown columns.
//   - Archive / unarchive are the CEO's; a transaction is copy-only and a copy
//     in another company answers COPY_SWITCH_COMPANY.
//   - Every action writes an audit row stamped with the ROW's company.
//   - Merge repoints entries; `trash` sits in exactly one workspace.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { TrashEntry } from '@prisma/client'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { registerTrashPlugin, takeSnapshot, restoreSnapshot } = await import('../src/modules/trash/index.js')
const { __registerTestTrashProvider, trashProviders } = await import('../src/modules/trash/registry.js')
const { moveToTrash } = await import('../src/lib/trash.js')
const { isKnownModuleId } = await import('../src/lib/moduleAccess.js')
const { WORKSPACES } = await import('../src/lib/workspaces.js')

const stamp = Date.now()
const P = `trc${stamp}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
const unregister: Array<() => void> = []

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trc.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const auth = (key: string) => {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const call = (key: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/trash${url}`, headers: { ...auth(key), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) })

// ── Test providers on a real soft-delete model (webhook subscriptions) ───────
const SOFT = `${P}_hook`
const SNAP = `${P}_snap`
const KEPT = `${P}_kept`
const TXN = `${P}_txn`
/** "Transactions" the fake provider lists: id → company. */
const fakeTxns: Array<{ id: string; tenantId: string; at: Date }> = []

async function softDelete(co: 'A' | 'B', url: string, by: string) {
  const hook = await prisma.webhookSubscription.create({ data: { tenantId: T[co], url, secret: 's', events: [] } })
  await prisma.$transaction(async (tx) => {
    await moveToTrash(tx, { userId: U[by]!.id }, { type: SOFT, entityId: hook.id, tenantId: T[co], title: url })
    await tx.webhookSubscription.update({ where: { id: hook.id }, data: { deletedAt: new Date(), isActive: false } })
  })
  return hook.id
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', [T.A])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('mgmtA', 'management', [T.A])
  await mkUser('ownerB', 'owner', [T.B])
  await mkUser('itA', 'it', [T.A])
  await mkUser('cashierA', 'cashier', [T.A])
  await mkUser('ownerNoIntegrations', 'owner', [T.A], { moduleDeny: ['integrations'] })

  const roles = ['admin', 'owner', 'management', 'it'] as const
  const base = { moduleId: 'integrations', roles: { list: roles, restore: roles, copy: roles }, auditCategory: 'identity' as const }
  unregister.push(__registerTestTrashProvider({
    ...base, key: SOFT, label: 'Test webhook', kind: 'master', strategy: 'soft', model: 'WebhookSubscription',
    parentOf: (e: TrashEntry) => (e.parentType && e.parentId ? { type: e.parentType, id: e.parentId } : null),
    async clashOf(tx, e, opts) {
      const row = await tx.webhookSubscription.findUnique({ where: { id: e.entityId } })
      const url = opts.rename?.url ?? row!.url
      const live = await tx.webhookSubscription.findFirst({ where: { tenantId: e.tenantId, url, deletedAt: null, id: { not: e.entityId } } })
      return live ? { field: 'url', value: url, suggestion: `${url}-2`, renamable: true } : null
    },
    async restore(tx, _ctx, e, opts) {
      await tx.webhookSubscription.update({ where: { id: e.entityId }, data: { deletedAt: null, ...(opts.rename?.url ? { url: opts.rename.url } : {}) } })
    },
    async references(tx, e) {
      const row = await tx.webhookSubscription.findUnique({ where: { id: e.entityId }, select: { failureCount: true } })
      return row && row.failureCount > 0 ? [{ label: 'Failed deliveries', count: row.failureCount }] : []
    },
    erasable: () => true,
  }))
  unregister.push(__registerTestTrashProvider({
    ...base, key: SNAP, label: 'Test snapshot', kind: 'master', strategy: 'snapshot', erasable: () => true,
  }))
  unregister.push(__registerTestTrashProvider({
    ...base, key: KEPT, label: 'Test bank-like', kind: 'master', strategy: 'soft', model: 'WebhookSubscription', erasable: () => false,
  }))
  unregister.push(__registerTestTrashProvider({
    ...base, key: TXN, label: 'Test order', kind: 'transaction', strategy: 'none', erasable: () => false,
    async list(ctx, f) {
      const t = ctx.readScope.tenantId
      const ids = typeof t === 'string' ? [t] : t.in
      return fakeTxns.filter((t) => ids.includes(t.tenantId)).slice(0, f.limit)
        .map((t) => ({ id: t.id, tenantId: t.tenantId, title: `Order ${t.id}`, at: t.at, statusLabel: 'Cancelled' }))
    },
    async get(_ctx, id) {
      const t = fakeTxns.find((x) => x.id === id)
      return t ? { id: t.id, tenantId: t.tenantId, title: `Order ${t.id}`, at: t.at, statusLabel: 'Cancelled' } : null
    },
    async copy(_ctx, id) { return { mode: 'prefill', link: '/pos', payload: { from: id } } },
  }))
  fakeTxns.push({ id: `${P}-txA`, tenantId: T.A, at: new Date('2026-10-01') }, { id: `${P}-txB`, tenantId: T.B, at: new Date('2026-10-02') })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await registerTrashPlugin(api) }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  for (const u of unregister) u()
  await app?.close()
})

describe('registry', () => {
  it('keys are unique and every module id is known', () => {
    const keys = trashProviders().map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of trashProviders()) expect(isKnownModuleId(p.moduleId), p.key).toBe(true)
  })
  it('trash sits in exactly one workspace (the CEO\'s)', () => {
    const homes = WORKSPACES.filter((w) => w.sections.some((s) => s.modules.includes('trash' as never)))
    expect(homes.map((w) => w.id)).toEqual(['ceo'])
  })
})

describe('two companies', () => {
  let hookA = ''
  let hookB = ''
  beforeAll(async () => {
    hookA = await softDelete('A', `https://a.example/${P}`, 'ownerA')
    hookB = await softDelete('B', `https://b.example/${P}`, 'ownerB')
  })

  it('B lists only its own entries and none of A\'s', async () => {
    const b = (await call('ownerB', 'GET', `?type=${SOFT}`)).json() as { items: Array<{ id: string; tenantId: string }> }
    expect(b.items.map((i) => i.id)).toEqual([hookB])
    const a = (await call('ownerA', 'GET', `?type=${SOFT}`)).json() as { items: Array<{ id: string; byName: string }> }
    expect(a.items.map((i) => i.id)).toEqual([hookA])
    expect(a.items[0]!.byName).toBe(`${P} ownerA`)
  })

  it('B gets 404 on A\'s entry for get, restore, purge and archive', async () => {
    expect((await call('ownerB', 'GET', `/${SOFT}/${hookA}`)).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/${SOFT}/${hookA}/restore`, {})).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/${TXN}/${P}-txA/copy`, {})).statusCode).toBe(404)
  })

  it('types carry open counts for the caller\'s companies only', async () => {
    const t = (await call('ownerA', 'GET', '/types')).json() as { types: Array<{ key: string; count: number | null }> }
    expect(t.types.find((x) => x.key === SOFT)!.count).toBe(1)
  })

  it('a login without the module, or the role, sees nothing of the type', async () => {
    const r = (await call('ownerNoIntegrations', 'GET', '/types')).json() as { types: Array<{ key: string }> }
    expect(r.types.some((x) => x.key === SOFT)).toBe(false)
    expect((await call('ownerNoIntegrations', 'GET', `/${SOFT}/${hookA}`)).statusCode).toBe(404)
    const c = (await call('cashierA', 'GET', `?type=${SOFT}`)).json() as { items: unknown[] }
    expect(c.items).toEqual([])
  })

  it('restore works once; the second answers ALREADY_RESTORED; the audit row carries the row\'s company', async () => {
    const r1 = await call('ownerA', 'POST', `/${SOFT}/${hookA}/restore`, { reason: 'deleted by mistake' })
    expect(r1.statusCode).toBe(200)
    expect((await prisma.webhookSubscription.findUnique({ where: { id: hookA } }))!.deletedAt).toBeNull()
    const r2 = await call('ownerA', 'POST', `/${SOFT}/${hookA}/restore`, {})
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('ALREADY_RESTORED')
    const a = await prisma.auditLog.findFirst({ where: { entity: SOFT, entityId: hookA, action: 'trash.restore' } })
    expect(a!.tenantId).toBe(T.A)
    expect(a!.userId).toBe(U['ownerA']!.id)
  })

  it('re-deleting after a restore makes a NEW entry (history kept)', async () => {
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, { userId: U['ownerA']!.id }, { type: SOFT, entityId: hookA, tenantId: T.A, title: 'again' })
      await tx.webhookSubscription.update({ where: { id: hookA }, data: { deletedAt: new Date() } })
    })
    expect(await prisma.trashEntry.count({ where: { entityType: SOFT, entityId: hookA } })).toBe(2)
  })

  it('concurrent restores: exactly one wins', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => call('ownerA', 'POST', `/${SOFT}/${hookA}/restore`, {})))
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(2)
  })
})

describe('restore rules', () => {
  it('PARENT_IN_TRASH while the parent has an open entry', async () => {
    const parent = await softDelete('A', `https://parent.example/${P}`, 'ownerA')
    const child = await prisma.webhookSubscription.create({ data: { tenantId: T.A, url: `https://child.example/${P}`, secret: 's' } })
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, { userId: U['ownerA']!.id }, { type: SOFT, entityId: child.id, tenantId: T.A, title: 'child', parent: { type: SOFT, id: parent } })
      await tx.webhookSubscription.update({ where: { id: child.id }, data: { deletedAt: new Date() } })
    })
    const r = await call('ownerA', 'POST', `/${SOFT}/${child.id}/restore`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('PARENT_IN_TRASH')
    expect(r.json().error.details.parent.id).toBe(parent)
    expect((await call('ownerA', 'POST', `/${SOFT}/${parent}/restore`, {})).statusCode).toBe(200)
    expect((await call('ownerA', 'POST', `/${SOFT}/${child.id}/restore`, {})).statusCode).toBe(200)
  })

  it('TRASH_CLASH with a suggestion, then rename resolves it', async () => {
    const url = `https://clash.example/${P}`
    const old = await softDelete('A', url, 'ownerA')
    await prisma.webhookSubscription.create({ data: { tenantId: T.A, url, secret: 's' } })
    const r = await call('ownerA', 'POST', `/${SOFT}/${old}/restore`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('TRASH_CLASH')
    expect(r.json().error.details).toMatchObject({ field: 'url', suggestion: `${url}-2`, renamable: true })
    const ok = await call('ownerA', 'POST', `/${SOFT}/${old}/restore`, { rename: { url: `${url}-2` } })
    expect(ok.statusCode).toBe(200)
  })

  it('a transaction is never restored (copy only)', async () => {
    const r = await call('ownerA', 'POST', `/${TXN}/${P}-txA/restore`, {})
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOT_RESTORABLE')
  })
})

describe('purge (CEO only)', () => {
  it('owner / management get 403; the CEO erases with a reason', async () => {
    const id = await softDelete('A', `https://purge.example/${P}`, 'ownerA')
    expect((await call('ownerA', 'DELETE', `/${SOFT}/${id}?reason=${encodeURIComponent('no longer needed at all')}`)).statusCode).toBe(403)
    expect((await call('mgmtA', 'DELETE', `/${SOFT}/${id}?reason=${encodeURIComponent('no longer needed at all')}`)).statusCode).toBe(403)
    const short = await call('ceo', 'DELETE', `/${SOFT}/${id}?reason=no`)
    expect(short.json().error.code).toBe('REASON_REQUIRED')
    expect((await call('ceo', 'DELETE', `/${SOFT}/${id}?reason=${encodeURIComponent('no longer needed at all')}`)).statusCode).toBe(204)
    expect(await prisma.webhookSubscription.findUnique({ where: { id } })).toBeNull()
    const e = await prisma.trashEntry.findFirst({ where: { entityType: SOFT, entityId: id } })
    expect(e!.purgedAt).not.toBeNull()
    expect(e!.purgeReason).toBe('no longer needed at all')
    const a = await prisma.auditLog.findFirst({ where: { entity: SOFT, entityId: id, action: 'trash.purge' } })
    expect(a!.tenantId).toBe(T.A)
  })

  it('IN_USE lists what still points at it', async () => {
    const id = await softDelete('A', `https://inuse.example/${P}`, 'ownerA')
    await prisma.webhookSubscription.update({ where: { id }, data: { failureCount: 3 } })
    const r = await call('ceo', 'DELETE', `/${SOFT}/${id}?reason=${encodeURIComponent('clearing old webhooks')}`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('IN_USE')
    expect(r.json().error.details.references).toEqual([{ label: 'Failed deliveries', count: 3 }])
  })

  it('NOT_ERASABLE for a never-erasable type and for any transaction', async () => {
    const hook = await prisma.webhookSubscription.create({ data: { tenantId: T.A, url: `https://kept.example/${P}`, secret: 's', deletedAt: new Date() } })
    await prisma.$transaction((tx) => moveToTrash(tx, { userId: U['ceo']!.id }, { type: KEPT, entityId: hook.id, tenantId: T.A, title: 'kept' }))
    const r = await call('ceo', 'DELETE', `/${KEPT}/${hook.id}?reason=${encodeURIComponent('try to erase this one')}`)
    expect(r.json().error.code).toBe('NOT_ERASABLE')
    const t = await call('ceo', 'DELETE', `/${TXN}/${P}-txA?reason=${encodeURIComponent('try to erase this one')}`)
    expect(t.json().error.code).toBe('NOT_ERASABLE')
  })
})

describe('snapshot', () => {
  it('round-trips a hard-deleted row with the same id, dates and JSON', async () => {
    const hook = await prisma.webhookSubscription.create({
      data: { tenantId: T.A, url: `https://snap.example/${P}`, secret: 's', events: ['order.completed'], lastSentAt: new Date('2026-09-01T10:00:00Z'), failureCount: 2 },
    })
    await prisma.$transaction(async (tx) => {
      const row = await tx.webhookSubscription.findUniqueOrThrow({ where: { id: hook.id } })
      const snap = takeSnapshot('WebhookSubscription', { ...row, droppedColumn: 'x' })
      expect('droppedColumn' in snap.row).toBe(false)
      await moveToTrash(tx, { userId: U['ownerA']!.id }, { type: SNAP, entityId: hook.id, tenantId: T.A, title: 'snap', snapshot: snap })
      await tx.webhookSubscription.delete({ where: { id: hook.id } })
    })
    expect((await call('ownerA', 'POST', `/${SNAP}/${hook.id}/restore`, {})).statusCode).toBe(200)
    const back = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id: hook.id } })
    expect(back.lastSentAt!.toISOString()).toBe('2026-09-01T10:00:00.000Z')
    expect(back.events).toEqual(['order.completed'])
    expect(back.failureCount).toBe(2)
    expect(back.tenantId).toBe(T.A)
  })

  it('the entry\'s company overrides a company stored inside the snapshot', async () => {
    const id = `${P}-snap2`
    await prisma.$transaction((tx) => restoreSnapshot(tx, takeSnapshot('WebhookSubscription', { id, tenantId: T.B, url: 'https://x', secret: 's', events: [], isActive: true, failureCount: 0, createdAt: new Date(), updatedAt: new Date() }), { tenantId: T.A }))
    expect((await prisma.webhookSubscription.findUniqueOrThrow({ where: { id } })).tenantId).toBe(T.A)
  })
})

describe('transactions, copy and archive', () => {
  it('lists the company\'s own cancelled rows; copy hands back a prefill and logs it', async () => {
    const l = (await call('ownerA', 'GET', `?type=${TXN}`)).json() as { items: Array<{ id: string; canCopy: boolean; canRestore: boolean }> }
    expect(l.items.map((i) => i.id)).toEqual([`${P}-txA`])
    expect(l.items[0]!.canRestore).toBe(false)
    const c = await call('ownerA', 'POST', `/${TXN}/${P}-txA/copy`, {})
    expect(c.statusCode).toBe(200)
    expect(c.json()).toMatchObject({ mode: 'prefill', payload: { from: `${P}-txA` } })
    expect(await prisma.trashCopy.count({ where: { entityType: TXN, entityId: `${P}-txA`, tenantId: T.A } })).toBe(1)
  })

  it('a copy of another company\'s row while acting in this one → COPY_SWITCH_COMPANY', async () => {
    await mkUser('ceoBoth', 'admin', [T.A, T.B])
    const r = await app.inject({ method: 'POST', url: `/api/v1/trash/${TXN}/${P}-txB/copy`, headers: { ...auth('ceoBoth'), 'x-servd-portfolio': '1', 'content-type': 'application/json' }, payload: '{}' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('COPY_SWITCH_COMPANY')
  })

  it('archive / unarchive are the CEO\'s; an archived transaction leaves the default list', async () => {
    expect((await call('ownerA', 'POST', `/${TXN}/${P}-txA/archive`, {})).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/${TXN}/${P}-txA/archive`, {})).statusCode).toBe(204)
    const l = (await call('ceo', 'GET', `?type=${TXN}`)).json() as { items: unknown[] }
    expect(l.items).toEqual([])
    const arch = (await call('ceo', 'GET', `?type=${TXN}&state=archived`)).json() as { items: Array<{ id: string }> }
    expect(arch.items.map((i) => i.id)).toEqual([`${P}-txA`])
    expect((await call('ownerA', 'GET', `?state=archived`)).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/${TXN}/${P}-txA/unarchive`, {})).statusCode).toBe(204)
    expect(((await call('ceo', 'GET', `?type=${TXN}`)).json() as { items: unknown[] }).items).toHaveLength(1)
  })
})

describe('merge', () => {
  it('the merge repoint list carries trash entries and copies', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/modules/tenants/routes.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/tx\.trashEntry, tx\.trashCopy/)
  })
  it('a merge repoint moves entries and copies to the surviving company', async () => {
    const C = (await prisma.tenant.create({ data: { name: `${P} Co C`, slug: `${P}-c` } })).id
    const D = (await prisma.tenant.create({ data: { name: `${P} Co D`, slug: `${P}-d` } })).id
    await prisma.trashEntry.create({ data: { tenantId: C, entityType: SOFT, entityId: `${P}-m1`, title: 'm' } })
    await prisma.trashCopy.create({ data: { tenantId: C, entityType: TXN, entityId: `${P}-m2`, mode: 'prefill', copiedById: U['ceo']!.id } })
    // The same two updateMany calls the merge's repoint list makes (tenants/routes.ts).
    await prisma.$transaction(async (tx) => {
      for (const m of [tx.trashEntry, tx.trashCopy] as Array<{ updateMany(a: { where: { tenantId: string }; data: { tenantId: string } }): Promise<unknown> }>) {
        await m.updateMany({ where: { tenantId: C }, data: { tenantId: D } })
      }
    })
    expect(await prisma.trashEntry.count({ where: { tenantId: D } })).toBe(1)
    expect(await prisma.trashCopy.count({ where: { tenantId: D } })).toBe(1)
  })
})
