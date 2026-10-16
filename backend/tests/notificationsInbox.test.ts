// The bell's inbox — /notifications/inbox, /unread-count, /:id/read, /read-all
// (modules/notifications/inboxRoutes.ts). Two companies:
//
//   - a login sees only its OWN rows, only of companies it belongs to (or
//     reaches through a live head office); company B's login gets 404 on A's
//     row and the row stays unread;
//   - a login removed from company A stops seeing A's rows at once;
//   - the CEO in A + B sees both, each with its companyName; company=active
//     narrows to the active company; NULL-company rows are the CEO's only;
//   - cursor paging, unread=1, read-all respects `before`, unread-count matches;
//   - switchCompany is false for pages that span companies (/ceo/approvals,
//     /exceptions), true for a company page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { notificationRoutes } from '../src/modules/notifications/routes.js'

const RUN = Date.now().toString(36)
let seq = 0
let app: FastifyInstance
let A: string, B: string, HO: string
let ceo: Who, mgrA: Who, mgrB: Who, both: Who, hoHr: Who

const tenant = async (name: string, kind: 'company' | 'head_office' = 'company') =>
  (await prisma.tenant.create({ data: { name: `Inbox ${name}`, slug: `ibx-${++seq}-${RUN}`, kind } })).id
const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, ...(payload !== undefined && { payload }), headers: { authorization: `Bearer ${who.token}` } })

let clock = Date.now() - 3_600_000
async function note(userId: string, tenantId: string | null, title: string, extra: { link?: string; readAt?: Date } = {}) {
  clock += 1000
  return (await prisma.staffNotification.create({
    data: {
      userId, tenantId, kind: 'approval.waiting', title, dedupeKey: `ibx:${randomUUID()}`,
      createdAt: new Date(clock), link: extra.link ?? null, readAt: extra.readAt ?? null,
    },
  })).id
}

const ids: Record<string, string> = {}

beforeAll(async () => {
  A = await tenant('A')
  B = await tenant('B')
  HO = await tenant('HO', 'head_office')
  ceo = await mkUser('ibx-ceo', 'admin', A)
  await prisma.tenantMember.create({ data: { tenantId: B, userId: ceo.id } })
  mgrA = await mkUser('ibx-mgr-a', 'manager', A)
  mgrB = await mkUser('ibx-mgr-b', 'manager', B)
  both = await mkUser('ibx-both', 'manager', B)
  await prisma.tenantMember.create({ data: { tenantId: A, userId: both.id } })
  hoHr = await mkUser('ibx-ho-hr', 'hr', HO)
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: ceo.id } })

  ids.a1 = await note(mgrA.id, A, 'A one', { link: '/ceo/approvals?type=purchase_order' })
  ids.a2 = await note(mgrA.id, A, 'A two', { link: '/finance/cash-vouchers?id=x' })
  ids.a3 = await note(mgrA.id, A, 'A three (read)', { readAt: new Date() })
  ids.aNull = await note(mgrA.id, null, 'A null company (never shown to a non-admin)')
  ids.b1 = await note(mgrB.id, B, 'B one')
  ids.ceoA = await note(ceo.id, A, 'CEO in A', { link: '/exceptions?flag=f1' })
  ids.ceoB = await note(ceo.id, B, 'CEO in B', { link: '/finance/night-audit?day=2026-10-15' })
  ids.ceoNull = await note(ceo.id, null, 'CEO company-less')
  ids.bothA = await note(both.id, A, 'Both: A')
  ids.bothB = await note(both.id, B, 'Both: B')
  ids.hoA = await note(hoHr.id, A, 'HO: reached A')
  ids.hoB = await note(hoHr.id, B, 'HO: B (not reached)')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(notificationRoutes, { prefix: '/notifications' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

type Item = { id: string; title: string; tenantId: string | null; companyName: string | null; switchCompany: boolean; readAt: string | null }

describe('the wall', () => {
  it('a login sees only its own rows of its companies — never a NULL-company row', async () => {
    const res = await call(mgrA, 'GET', '/notifications/inbox')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as { items: Item[]; unread: number; nextCursor: string | null }
    expect(body.items.map((i) => i.id)).toEqual([ids.a3, ids.a2, ids.a1])
    expect(body.unread).toBe(2)
    expect(body.nextCursor).toBeNull()
  })

  it('company B\'s login gets 404 on A\'s row, and the row stays unread', async () => {
    const res = await call(mgrB, 'POST', `/notifications/${ids.a1}/read`)
    expect(res.statusCode).toBe(404)
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: ids.a1 } })).readAt).toBeNull()
    // And the CEO, member of A, cannot mark a manager's row either.
    expect((await call(ceo, 'POST', `/notifications/${ids.a1}/read`)).statusCode).toBe(404)
  })

  it('a login removed from company A stops seeing A\'s rows at once', async () => {
    let items = ((await call(both, 'GET', '/notifications/inbox')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id).sort()).toEqual([ids.bothA, ids.bothB].sort())
    await prisma.tenantMember.deleteMany({ where: { tenantId: A, userId: both.id } })
    items = ((await call(both, 'GET', '/notifications/inbox')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([ids.bothB])
    expect((await call(both, 'POST', `/notifications/${ids.bothA}/read`)).statusCode).toBe(404)
  })

  it('a head-office login sees rows of the company it reaches, not others', async () => {
    const items = ((await call(hoHr, 'GET', '/notifications/inbox')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([ids.hoA])
  })

  it('the CEO in A and B sees both (with company names) and the company-less row', async () => {
    const items = ((await call(ceo, 'GET', '/notifications/inbox')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([ids.ceoNull, ids.ceoB, ids.ceoA])
    const byId = new Map(items.map((i) => [i.id, i]))
    expect(byId.get(ids.ceoA)).toMatchObject({ tenantId: A, companyName: 'Inbox A', switchCompany: false })
    expect(byId.get(ids.ceoB)).toMatchObject({ tenantId: B, companyName: 'Inbox B', switchCompany: true })
    expect(byId.get(ids.ceoNull)).toMatchObject({ tenantId: null, companyName: null, switchCompany: false })
  })

  it('company=active narrows to the active company', async () => {
    const items = ((await call(ceo, 'GET', '/notifications/inbox?company=active')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([ids.ceoA])
  })
})

describe('paging, counts and marking read', () => {
  it('cursor pages newest first; a foreign cursor is 404; bad input is 400', async () => {
    const p1 = (await call(mgrA, 'GET', '/notifications/inbox?limit=2')).json() as { items: Item[]; nextCursor: string }
    expect(p1.items.map((i) => i.id)).toEqual([ids.a3, ids.a2])
    expect(p1.nextCursor).toBe(ids.a2)
    const p2 = (await call(mgrA, 'GET', `/notifications/inbox?limit=2&cursor=${p1.nextCursor}`)).json() as { items: Item[]; nextCursor: string | null }
    expect(p2.items.map((i) => i.id)).toEqual([ids.a1])
    expect(p2.nextCursor).toBeNull()
    expect((await call(mgrA, 'GET', `/notifications/inbox?cursor=${ids.b1}`)).statusCode).toBe(404)
    expect((await call(mgrA, 'GET', '/notifications/inbox?limit=500')).statusCode).toBe(400)
    expect((await call(mgrA, 'GET', '/notifications/inbox?cursor=not-a-uuid')).statusCode).toBe(400)
  })

  it('unread=1 lists only unread; unread-count matches', async () => {
    const items = ((await call(mgrA, 'GET', '/notifications/inbox?unread=1')).json() as { items: Item[] }).items
    expect(items.map((i) => i.id)).toEqual([ids.a2, ids.a1])
    expect((await call(mgrA, 'GET', '/notifications/unread-count')).json()).toEqual({ unread: 2 })
    expect((await call(ceo, 'GET', '/notifications/unread-count')).json()).toEqual({ unread: 3 })
  })

  it('mark one read (twice is still 200)', async () => {
    expect((await call(mgrA, 'POST', `/notifications/${ids.a1}/read`)).json()).toEqual({ ok: true })
    expect((await call(mgrA, 'POST', `/notifications/${ids.a1}/read`)).statusCode).toBe(200)
    expect((await call(mgrA, 'GET', '/notifications/unread-count')).json()).toEqual({ unread: 1 })
  })

  it('read-all only marks rows created at or before `before`', async () => {
    // ceoA and ceoB are older than ceoNull; cut just before ceoNull.
    const ceoNullAt = (await prisma.staffNotification.findUniqueOrThrow({ where: { id: ids.ceoNull } })).createdAt
    const cut = new Date(ceoNullAt.getTime() - 1).toISOString()
    const res = await call(ceo, 'POST', '/notifications/read-all', { before: cut })
    expect(res.json()).toEqual({ updated: 2 })
    expect((await call(ceo, 'GET', '/notifications/unread-count')).json()).toEqual({ unread: 1 })
    expect((await call(ceo, 'POST', '/notifications/read-all', {})).json()).toEqual({ updated: 1 })
    // Another login's rows are untouched by the CEO's read-all.
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: ids.a2 } })).readAt).toBeNull()
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: ids.aNull } })).readAt).toBeNull()
  })

  it('a non-admin\'s read-all never touches a NULL-company row', async () => {
    expect((await call(mgrA, 'POST', '/notifications/read-all')).json()).toEqual({ updated: 1 })
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: ids.aNull } })).readAt).toBeNull()
  })
})
