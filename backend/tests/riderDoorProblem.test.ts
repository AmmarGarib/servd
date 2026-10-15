// Rider door problems, cash held at shift-off, and rider scoring changes
// (Delivery & customers, resumed 2026-10-15).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return { ...real, sendText: vi.fn(async () => undefined) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { redis } = await import('../src/lib/redis.js')
const { AppError } = await import('../src/lib/errors.js')
const { issueRiderSession } = await import('../src/modules/riderAuth/service.js')
const { riderAppRoutes } = await import('../src/modules/rider/routes.js')
const { setCodeOnlyDelivery } = await import('../src/lib/deliveryRules.js')
const { runOnce, runForTenant } = await import('../src/workers/riderScoring.js')

let app: FastifyInstance
let tenantA: string
let tenantB: string
let headOffice: string
let conceptA: string
let conceptB: string
let adminId: string
const tok: Record<string, string> = {}
const ids: Record<string, string> = {}
let n = 0

const rider = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/rider${url}`, payload: payload as never, headers: { authorization: `Bearer ${tok[key]}` } })

async function mkRider(key: string, tenantId: string, phone: string) {
  const r = await prisma.rider.create({ data: { tenantId, name: `Rider ${key}`, phone, status: 'available', isActive: true } })
  ids[key] = r.id
  tok[key] = issueRiderSession(r).accessToken
}

async function mkJob(conceptId: string, riderKey: string, o: { picked?: boolean; extra?: Record<string, unknown> } = {}) {
  n += 1
  return prisma.order.create({
    data: {
      conceptId, source: 'servd', status: 'ready', fulfilmentType: 'delivery', totalCents: 100_000, customerName: 'Sana',
      deliveryNotes: 'House 1', deliveryOtp: '1234', externalId: `doorprob-${n}-${Date.now()}`,
      riderId: ids[riderKey]!, riderAssignedAt: new Date(), riderAcceptedAt: new Date(),
      pickedUpAt: o.picked === false ? null : new Date(),
      items: { create: [{ name: 'Burger', quantity: 1, unitPriceCents: 100_000, status: 'bumped' }] },
      ...(o.extra ?? {}),
    } as never,
  })
}

const switchCodeOnly = (tenantId: string, on: boolean) =>
  prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId, on, actorId: adminId, reason: 'door problem test' }))

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Door A', slug: 'doorprob-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Door B', slug: 'doorprob-b' } })).id
  headOffice = (await prisma.tenant.create({ data: { name: 'Door HO', slug: 'doorprob-ho', kind: 'head_office' } as never })).id
  conceptA = (await prisma.concept.create({ data: { name: 'doora', slug: 'doorprob-a-brand', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'doorb', slug: 'doorprob-b-brand', type: 'restaurant', tenantId: tenantB } })).id
  adminId = (await prisma.user.create({
    data: { name: 'door admin', email: 'door.admin@gsfoods.pk', password: 'x', role: 'admin' as never, isActive: true, accountStatus: 'active', tenantId: tenantA },
  })).id
  await mkRider('a1', tenantA, '923115550301')
  await mkRider('a2', tenantA, '923115550302')
  await mkRider('fleet', tenantA, '923115550303') // company A's rider carrying B's order
  await prisma.fleetAgreement.create({
    data: { providerTenantId: tenantA, clientTenantId: tenantB, isActive: true, createdById: adminId },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => { await api.register(riderAppRoutes, { prefix: '/rider' }) }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

beforeEach(async () => {
  const keys = await redis.keys('ratelimit:rider-*')
  if (keys.length) await redis.del(...keys)
})

describe('POST /rider/jobs/:orderId/door-problem', () => {
  it('404 for an order that is not the rider\'s own open job', async () => {
    await switchCodeOnly(tenantA, true)
    const o = await mkJob(conceptA, 'a1')
    expect((await rider('a2', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'no_code' })).statusCode).toBe(404)
    expect((await rider('a1', 'POST', `/jobs/00000000-0000-0000-0000-000000000000/door-problem`, { kind: 'no_code' })).statusCode).toBe(404)
  })

  it('409 NOT_PICKED_UP, then 409 DOOR_PROBLEM_OFF while the switch is off', async () => {
    await switchCodeOnly(tenantA, true)
    const early = await mkJob(conceptA, 'a1', { picked: false })
    const r1 = await rider('a1', 'POST', `/jobs/${early.id}/door-problem`, { kind: 'refused' })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('NOT_PICKED_UP')

    await switchCodeOnly(tenantA, false)
    const o = await mkJob(conceptA, 'a1')
    const r2 = await rider('a1', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'refused' })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('DOOR_PROBLEM_OFF')
    expect(await prisma.riderJobEvent.count({ where: { orderId: o.id, type: 'door_problem' } })).toBe(0)
  })

  it('writes the event and a flag; the same kind within 5 minutes is a duplicate; another kind is not', async () => {
    await switchCodeOnly(tenantA, true)
    const o = await mkJob(conceptA, 'a1')
    const a = await rider('a1', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'no_code', note: 'phone off' })
    expect(a.statusCode).toBe(200)
    expect(a.json()).toEqual({ ok: true, duplicate: false })
    const b = await rider('a1', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'no_code' })
    expect(b.json()).toEqual({ ok: true, duplicate: true })
    const c = await rider('a1', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'refused' })
    expect(c.json().duplicate).toBe(false)
    expect(await prisma.riderJobEvent.count({ where: { orderId: o.id, type: 'door_problem' } })).toBe(2)
    const flags = await prisma.exceptionFlag.findMany({ where: { entityId: o.id, kind: 'delivery_door_problem' }, orderBy: { createdAt: 'asc' } })
    expect(flags.map((f) => f.severity)).toEqual(['medium', 'high'])
    const job = (await rider('a1', 'GET', `/jobs/${o.id}`)).json().job
    expect(job.doorProblemEnabled).toBe(true)
    expect(job.doorProblem.kind).toBe('refused')
  })

  it("a fleet rider's exception lands in the ORDER's company, the event stamped client B / provider A", async () => {
    await switchCodeOnly(tenantB, true)
    const o = await mkJob(conceptB, 'fleet')
    const res = await rider('fleet', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'unreachable' })
    expect(res.statusCode).toBe(200)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: o.id, kind: 'delivery_door_problem' } })
    expect(flag.tenantId).toBe(tenantB)
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'door_problem' } })
    expect(ev).toMatchObject({ tenantId: tenantB, riderTenantId: tenantA })
    await switchCodeOnly(tenantB, false)
  })

  it('rejects a bad kind (400)', async () => {
    const o = await mkJob(conceptA, 'a1')
    expect((await rider('a1', 'POST', `/jobs/${o.id}/door-problem`, { kind: 'bored' })).statusCode).toBe(400)
  })
})

describe('shift off reports the cash held', () => {
  it('cashHeldCents is a warning: off shift still succeeds', async () => {
    await prisma.rider.updateMany({ where: { id: ids['a2']! }, data: { status: 'available' } })
    const res = await rider('a2', 'POST', '/shift', { online: false })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().cashHeldCents).toBe('number')
    expect(res.json().rider.status).toBe('offline')
    const on = await rider('a2', 'POST', '/shift', { online: true })
    expect(on.json().cashHeldCents).toBeUndefined()
  })
})

describe('rider scoring', () => {
  async function scored(tenantId: string, concept: string, riderKey: string, rows: Array<Record<string, unknown>>) {
    for (const r of rows) {
      n += 1
      await prisma.order.create({
        data: {
          conceptId: concept, source: 'servd', fulfilmentType: 'delivery', totalCents: 1000, externalId: `score-${n}-${Date.now()}`,
          riderId: ids[riderKey]!, completedAt: new Date(), status: 'completed', ...r,
        } as never,
      })
    }
    return runForTenant(tenantId)
  }

  it('cancels with returnCause refused do not count toward the lost rate; others do', async () => {
    await mkRider('sc1', tenantA, '923115550311')
    const refused = Array.from({ length: 4 }, () => ({ status: 'cancelled', returnCause: 'refused' }))
    const r1 = await scored(tenantA, conceptA, 'sc1', [...refused, ...Array.from({ length: 6 }, () => ({}))])
    expect(r1.checked).toBeGreaterThan(0)
    expect(await prisma.exceptionFlag.count({ where: { entityId: ids['sc1']!, kind: 'lost_package' } })).toBe(0)

    await mkRider('sc2', tenantA, '923115550312')
    await scored(tenantA, conceptA, 'sc2', [
      ...Array.from({ length: 3 }, () => ({ status: 'cancelled', returnCause: 'unreachable' })),
      ...Array.from({ length: 6 }, () => ({})),
    ])
    expect(await prisma.exceptionFlag.count({ where: { entityId: ids['sc2']!, kind: 'lost_package' } })).toBe(1)
  })

  it('rerouted orders count as OTP trouble and are recorded in the metadata', async () => {
    await mkRider('sc3', tenantA, '923115550313')
    await scored(tenantA, conceptA, 'sc3', [
      ...Array.from({ length: 3 }, () => ({ handoverReroutedAt: new Date(), handoverRerouteAttempts: 3 })),
      ...Array.from({ length: 4 }, () => ({})),
    ])
    const f = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: ids['sc3']!, kind: 'lost_package' } })
    expect((f.metadata as { reroutedOrders: number }).reroutedOrders).toBe(3)
  })

  it('the nightly sweep skips head offices', async () => {
    await mkRider('hoRider', headOffice, '923115550399')
    const seen: string[] = []
    const orig = prisma.rider.findMany.bind(prisma.rider)
    const spy = vi.spyOn(prisma.rider, 'findMany').mockImplementation(((args: { where?: { tenantId?: string } }) => {
      if (args?.where?.tenantId) seen.push(args.where.tenantId)
      return orig(args as never)
    }) as never)
    await runOnce()
    spy.mockRestore()
    expect(seen).toContain(tenantA)
    expect(seen).not.toContain(headOffice)
  })
})
