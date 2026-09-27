// Company separation for outbound webhooks and the KDS socket registry.
//
//   - emitDomainEvent requires the owning company and only queues deliveries
//     for THAT company's active subscriptions.
//   - /webhooks/endpoints list/patch/delete/test are scoped to the operator's
//     companies; a foreign id is 404; create stamps the active company.
//   - /webhooks/deliveries is scoped through the subscription's company.
//   - A KDS device registered under one company cannot be re-homed by a
//     socket from another company.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

// Capture queued deliveries instead of talking to BullMQ.
const queued: Array<{ subscriptionId: string; event: string; payload: unknown }> = []
vi.mock('../src/lib/queue.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/queue.js')>()),
  getWebhookQueue: () => ({
    add: async (_name: string, data: { subscriptionId: string; event: string; payload: unknown }) => {
      queued.push(data)
      return { id: String(queued.length) }
    },
  }),
}))

// The SSRF guard resolves the host; give it a public address offline.
vi.mock('dns', async (orig) => {
  const real = await orig<typeof import('dns')>()
  const promises = { ...real.promises, lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
  return { ...real, promises, default: { ...real, promises } }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { webhookManagementRoutes } = await import('../src/modules/webhooks/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { emitDomainEvent, tenantIdOfConcept } = await import('../src/lib/webhook-events.js')
const { registerKdsDevice } = await import('../src/lib/ws.js')

const PREFIX = `sepwh-${Date.now()}`
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let subA: string, subB: string
let authA: Record<string, string>, authB: Record<string, string>
const users: string[] = []

async function manager(tenantId: string) {
  const n = users.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} mgr ${n}`,
      email: `${PREFIX}.mgr.${n}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: 'owner',
      tenantId,
      isActive: true,
      accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  users.push(u.id)
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role })
  return { authorization: `Bearer ${s.accessToken}` }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Sep WH A', slug: `${PREFIX}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Sep WH B', slug: `${PREFIX}-b` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'WH A', slug: `${PREFIX}-ca`, tenantId: tenantA, type: 'restaurant' } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'WH B', slug: `${PREFIX}-cb`, tenantId: tenantB, type: 'restaurant' } })).id
  subA = (await prisma.webhookSubscription.create({
    data: { tenantId: tenantA, url: 'https://a.example.com/hook', events: ['order.confirmed'], secret: 'a'.repeat(32) },
  })).id
  subB = (await prisma.webhookSubscription.create({
    data: { tenantId: tenantB, url: 'https://b.example.com/hook', events: ['order.confirmed'], secret: 'b'.repeat(32) },
  })).id
  await prisma.webhookDelivery.create({
    data: { subscriptionId: subA, event: 'order.confirmed', url: 'https://a.example.com/hook', requestBody: '{"secret-a":1}', status: 'success' },
  })
  await prisma.webhookDelivery.create({
    data: { subscriptionId: subB, event: 'order.confirmed', url: 'https://b.example.com/hook', requestBody: '{"b":1}', status: 'success' },
  })
  authA = await manager(tenantA)
  authB = await manager(tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(webhookManagementRoutes, { prefix: '/webhooks' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  if (!tenantA || !tenantB) return
  await prisma.webhookDelivery.deleteMany({ where: { subscription: { tenantId: { in: [tenantA, tenantB] } } } })
  await prisma.webhookSubscription.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.kdsDevice.deleteMany({ where: { deviceFingerprint: { startsWith: PREFIX } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.concept.deleteMany({ where: { id: { in: [conceptA, conceptB] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('emitDomainEvent is per company', () => {
  it("queues company A's order event only for A's endpoint", async () => {
    queued.length = 0
    await emitDomainEvent('order.confirmed', { orderId: 'o-a', conceptId: conceptA }, await tenantIdOfConcept(conceptA))
    const ours = queued.filter((q) => q.subscriptionId === subA || q.subscriptionId === subB)
    expect(ours.map((q) => q.subscriptionId)).toEqual([subA])
    expect(ours[0]!.event).toBe('order.confirmed')
  })

  it('drops an event whose company cannot be resolved instead of fanning out', async () => {
    queued.length = 0
    await emitDomainEvent('order.confirmed', { orderId: 'o-x' }, await tenantIdOfConcept('no-such-concept'))
    expect(queued).toHaveLength(0)
  })
})

describe('/webhooks/endpoints scoping', () => {
  it("B's list never shows A's endpoint", async () => {
    const r = await app.inject({ method: 'GET', url: '/webhooks/endpoints', headers: authB })
    expect(r.statusCode).toBe(200)
    const ids = (r.json() as Array<{ id: string }>).map((e) => e.id)
    expect(ids).toContain(subB)
    expect(ids).not.toContain(subA)
  })

  it('B cannot edit, test or delete A\'s endpoint (404) and it is untouched', async () => {
    const patch = await app.inject({
      method: 'PATCH', url: `/webhooks/endpoints/${subA}`, headers: authB,
      payload: { url: 'https://attacker.example.com/hook' },
    })
    expect(patch.statusCode).toBe(404)
    const test = await app.inject({ method: 'POST', url: `/webhooks/endpoints/${subA}/test`, headers: authB })
    expect(test.statusCode).toBe(404)
    const del = await app.inject({ method: 'DELETE', url: `/webhooks/endpoints/${subA}`, headers: authB })
    expect(del.statusCode).toBe(404)

    const row = await prisma.webhookSubscription.findUnique({ where: { id: subA } })
    expect(row!.url).toBe('https://a.example.com/hook')
    expect(row!.deletedAt).toBeNull()
    expect(row!.isActive).toBe(true)
    expect(await prisma.webhookDelivery.count({ where: { subscriptionId: subA, event: 'ping' } })).toBe(0)
  })

  it('A can still edit its own endpoint', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/webhooks/endpoints/${subA}`, headers: authA, payload: { notes: 'accounting' },
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().notes).toBe('accounting')
  })

  it('create stamps the active company and does not receive the other company\'s events', async () => {
    const r = await app.inject({
      method: 'POST', url: '/webhooks/endpoints', headers: authB,
      payload: { url: 'https://b2.example.com/hook', events: ['order.confirmed'] },
    })
    expect(r.statusCode).toBe(201)
    const created = r.json() as { id: string; tenantId: string }
    expect(created.tenantId).toBe(tenantB)

    queued.length = 0
    await emitDomainEvent('order.confirmed', { orderId: 'o-a2' }, await tenantIdOfConcept(conceptA))
    expect(queued.map((q) => q.subscriptionId)).not.toContain(created.id)
    expect(queued.map((q) => q.subscriptionId)).not.toContain(subB)
  })
})

describe('/webhooks/deliveries scoping', () => {
  it("B's deliveries never include A's payloads", async () => {
    const r = await app.inject({ method: 'GET', url: '/webhooks/deliveries', headers: authB })
    expect(r.statusCode).toBe(200)
    const subs = new Set((r.json() as Array<{ subscriptionId: string }>).map((d) => d.subscriptionId))
    expect(subs.has(subA)).toBe(false)
    expect(subs.has(subB)).toBe(true)
  })

  it('filtering B\'s list by A\'s subscription id returns nothing', async () => {
    const r = await app.inject({ method: 'GET', url: `/webhooks/deliveries?subscriptionId=${subA}`, headers: authB })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual([])
  })

  it('A sees its own deliveries', async () => {
    const r = await app.inject({ method: 'GET', url: `/webhooks/deliveries?subscriptionId=${subA}`, headers: authA })
    expect((r.json() as unknown[]).length).toBeGreaterThan(0)
  })
})

describe('KDS device registry', () => {
  it("a socket of company B cannot re-home company A's device", async () => {
    const fp = `${PREFIX}-device-1`
    const base = { deviceFingerprint: fp, ipAddress: '10.0.0.1' }
    expect(await registerKdsDevice({ ...base, tenantId: tenantA, tenantIds: [tenantA] })).toBe(tenantA)
    expect(await registerKdsDevice({ ...base, tenantId: tenantB, tenantIds: [tenantB] })).toBeNull()
    const row = await prisma.kdsDevice.findUnique({ where: { deviceFingerprint: fp } })
    expect(row!.tenantId).toBe(tenantA)
  })

  it('a member of both companies refreshes the device without moving it', async () => {
    const fp = `${PREFIX}-device-1`
    expect(await registerKdsDevice({ deviceFingerprint: fp, ipAddress: '10.0.0.2', tenantId: tenantB, tenantIds: [tenantA, tenantB] })).toBe(tenantA)
    const row = await prisma.kdsDevice.findUnique({ where: { deviceFingerprint: fp } })
    expect(row!.tenantId).toBe(tenantA)
    expect(row!.ipAddress).toBe('10.0.0.2')
  })
})
