// Open-items batch (owner, 2026-10-26): B8 guest tag catalogue (two companies), B10 WhatsApp as its own channel,
// C9 pre-orders at most 3 days ahead.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { salesByChannel } from '../src/modules/reports/service.js'
import { orderChannelOf } from '../src/lib/orderChannel.js'
import { orderTime, MAX_PREORDER_AHEAD_DAYS } from '../src/modules/storefront/serviceHours.js'

const P = `gtc${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const C: Record<string, string> = {}
const tok: Record<string, string> = {}
const O: string[] = []
let custA = ''

async function mkUser(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@gtc.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'manager', isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${tok[who]}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'GTC A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'GTC B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} A`, slug: `${P}-ca`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} B`, slug: `${P}-cb`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('mgrA', T.A!)
  await mkUser('mgrB', T.B!)
  custA = (await prisma.customer.create({ data: { name: 'Guest A', phone: `+9230${String(Date.now()).slice(-8)}` } as never })).id
  const mk = async (conceptId: string, rawPayload: unknown, n: number) => {
    const o = await prisma.order.create({
      data: { conceptId, source: 'servd', externalId: `${P}-${n}`, status: 'completed', placedAt: new Date(), completedAt: new Date(), totalCents: 1000_00, customerId: custA, rawPayload } as never,
    })
    O.push(o.id)
  }
  await mk(C.A!, { channel: 'whatsapp' }, 1)
  await mk(C.A!, { channel: 'whatsapp' }, 2)
  await mk(C.A!, null, 3)
  await mk(C.B!, { channel: 'whatsapp' }, 4)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.guestTag.deleteMany({ where: { customerId: custA } })
  await prisma.guestTagType.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await prisma.order.deleteMany({ where: { id: { in: O } } })
  await prisma.customer.deleteMany({ where: { id: custA } })
  await prisma.concept.deleteMany({ where: { id: { in: [C.A!, C.B!] } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: P } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [T.A!, T.B!] } } })
  await app.close()
})

describe('B8 guest tag catalogue', () => {
  let tagA = ''
  it('a create binds to the active company; a duplicate name is 409', async () => {
    const r = await call('mgrA', 'POST', '/reservations/guest-tag-types', { name: 'VIP', color: '#6a0dad' })
    expect(r.statusCode).toBe(201)
    tagA = r.json().id
    expect((await prisma.guestTagType.findUnique({ where: { id: tagA } }))!.tenantId).toBe(T.A)
    expect((await call('mgrA', 'POST', '/reservations/guest-tag-types', { name: '  vip ' })).statusCode).toBe(409)
    // Company B may use the same name.
    expect((await call('mgrB', 'POST', '/reservations/guest-tag-types', { name: 'VIP' })).statusCode).toBe(201)
  })
  it('company B sees only its own list and gets 404 on company A\'s entry', async () => {
    const list = (await call('mgrB', 'GET', '/reservations/guest-tag-types?all=1')).json() as Array<{ id: string; tenantId: string }>
    expect(list.length).toBe(1)
    expect(list.every((t) => t.tenantId === T.B)).toBe(true)
    expect((await call('mgrB', 'PATCH', `/reservations/guest-tag-types/${tagA}`, { name: 'Hacked' })).statusCode).toBe(404)
    expect((await prisma.guestTagType.findUnique({ where: { id: tagA } }))!.name).toBe('VIP')
  })
  it('attach from the list (company A); B cannot attach A\'s tag; switched off refuses', async () => {
    const ok = await call('mgrA', 'POST', '/reservations/guest-tags', { customerId: custA, tagTypeId: tagA })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ label: 'VIP', tenantId: T.A, tagTypeId: tagA })
    expect((await call('mgrA', 'POST', '/reservations/guest-tags', { customerId: custA, tagTypeId: tagA })).statusCode).toBe(409)
    expect((await call('mgrB', 'POST', '/reservations/guest-tags', { customerId: custA, tagTypeId: tagA })).statusCode).toBe(404)
    // B's view of the guest does not list A's typed tag.
    expect(((await call('mgrB', 'GET', `/reservations/guest-tags?customerId=${custA}`)).json() as unknown[]).length).toBe(0)
    expect(((await call('mgrA', 'GET', `/reservations/guest-tags?customerId=${custA}`)).json() as unknown[]).length).toBe(1)
    expect((await call('mgrB', 'DELETE', `/reservations/guest-tags/${ok.json().id}`)).statusCode).toBe(404)
  })
  it('rename carries to guests; switch off hides it from the pick list and refuses new attaches', async () => {
    expect((await call('mgrA', 'PATCH', `/reservations/guest-tag-types/${tagA}`, { name: 'Very VIP' })).statusCode).toBe(200)
    const tags = (await call('mgrA', 'GET', `/reservations/guest-tags?customerId=${custA}`)).json() as Array<{ label: string }>
    expect(tags[0]!.label).toBe('Very VIP')
    expect((await call('mgrA', 'PATCH', `/reservations/guest-tag-types/${tagA}`, { active: false })).statusCode).toBe(200)
    expect(((await call('mgrA', 'GET', '/reservations/guest-tag-types')).json() as unknown[]).length).toBe(0)
    expect(((await call('mgrA', 'GET', '/reservations/guest-tag-types?all=1')).json() as unknown[]).length).toBe(1)
    const r2 = await call('mgrA', 'POST', '/reservations/guest-tags', { customerId: custA, tagTypeId: tagA })
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('TAG_SWITCHED_OFF')
  })
})

describe('B10 WhatsApp is its own channel', () => {
  it('orderChannelOf', () => {
    expect(orderChannelOf({ source: 'servd', rawPayload: { channel: 'whatsapp' } })).toBe('whatsapp')
    expect(orderChannelOf({ source: 'servd', rawPayload: null })).toBe('servd')
    expect(orderChannelOf({ source: 'pos', rawPayload: { channel: 'whatsapp' } })).toBe('pos')
  })
  it('salesByChannel splits WhatsApp from the website, per company', async () => {
    const q = { company: { tenantId: T.A! }, from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) }
    const rows = await salesByChannel(q)
    const by = Object.fromEntries(rows.map((r) => [r.source, r]))
    expect(by.whatsapp!.orders).toBe(2)
    expect(by.servd!.orders).toBe(1)
    expect(by.whatsapp!.gross).toBe(2000_00)
    expect(by.servd!.gross).toBe(1000_00)
    const filtered = await salesByChannel({ ...q, channel: 'whatsapp' })
    expect(filtered.map((r) => r.source)).toEqual(['whatsapp'])
  })
})

describe('C9 pre-orders', () => {
  it('limit is 3 days', () => {
    expect(MAX_PREORDER_AHEAD_DAYS).toBe(3)
    const now = new Date()
    expect(orderTime(new Date(now.getTime() + 2.9 * 86_400_000).toISOString(), now).scheduled).toBe(true)
    expect(() => orderTime(new Date(now.getTime() + 3.1 * 86_400_000).toISOString(), now)).toThrowError(/3 days/)
  })
})
