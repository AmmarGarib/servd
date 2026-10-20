// The brand's primary service vessel (owner's FINAL packaging rule,
// 2026-10-13): Concept.serviceVessel 'plate' | 'packaging'.
//
// What this guards (two companies):
//   - POST /concepts without serviceVessel → 400 (a REQUIRED choice at brand
//     creation, no API default); with 'packaging' → stored, and binds to the
//     ACTIVE company;
//   - the company route that makes a brand (POST /tenants/apply-template)
//     without it → 400; with it → stored on that brand;
//   - PATCH by company B on A's brand → 404, nothing changes;
//   - PATCH is CEO only (Brands, 2026-10-14): A's management → 403;
//   - PATCH by A's CEO writes the 'concept.service_vessel' audit with from / to and
//     the "applies from now on" note, on the BRAND's company; a PATCH that
//     leaves the vessel alone writes no such audit;
//   - GET returns it;
//   - an order line rung up before the change keeps its snapshot
//     (OrderItem.serviceVessel); a line rung up after takes the new vessel.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { ingestOrder } from '../src/modules/orders/service.js'
import { fifoCutoverKey } from '../src/lib/stockLedger.js'

let app: FastifyInstance
let A: Company
let B: Company
let ceoA: Who
let ceoB: Who
let mgrA: Who
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

async function ring(conceptId: string, menuItemId: string) {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: 'dine_in',
    items: [{ externalItemId: '', menuItemId, name: 'Dish', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
    payment: { provider: null, amountCents: 145_000, status: 'pending' },
  })
  return prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
}

beforeAll(async () => {
  A = await mkCompany(`sv-a-${stamp}`)
  B = await mkCompany(`sv-b-${stamp}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 86_400_000).toISOString() } })
  ceoA = await mkUser('sv-ceo-a', 'admin', A.tenantId)
  ceoB = await mkUser('sv-ceo-b', 'admin', B.tenantId)
  mgrA = await mkUser('sv-mgr-a', 'manager', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('brand create requires the service vessel', () => {
  it('POST /concepts without serviceVessel → 400, nothing created', async () => {
    const slug = `sv-none-${stamp}`
    const r = await call(ceoA, 'POST', '/concepts', { name: 'No vessel', slug, type: 'restaurant' })
    expect(r.statusCode).toBe(400)
    expect(JSON.stringify(r.json())).toContain('serviceVessel')
    expect(await prisma.concept.count({ where: { slug } })).toBe(0)
  })

  it("an unknown vessel → 400", async () => {
    const r = await call(ceoA, 'POST', '/concepts', { name: 'Bowl', slug: `sv-bowl-${stamp}`, type: 'restaurant', serviceVessel: 'bowl' })
    expect(r.statusCode).toBe(400)
  })

  it("with 'packaging' → stored on a brand of the ACTIVE company, and GET returns it", async () => {
    const r = await call(ceoA, 'POST', '/concepts', { name: 'Stackd test', slug: `sv-stackd-${stamp}`, type: 'restaurant', serviceVessel: 'packaging' })
    expect(r.statusCode).toBe(201)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row.serviceVessel).toBe('packaging')
    expect(row.tenantId).toBe(A.tenantId)
    const got = await call(ceoA, 'GET', `/concepts/${row.id}`)
    expect(got.statusCode).toBe(200)
    expect(got.json().serviceVessel).toBe('packaging')
    // Company B cannot read it.
    expect((await call(ceoB, 'GET', `/concepts/${row.id}`)).statusCode).toBe(404)
  })

  it('POST /tenants/apply-template (the company route that makes a brand) without serviceVessel → 400; with it → stored', async () => {
    const before = await prisma.concept.count({ where: { tenantId: B.tenantId } })
    const bad = await call(ceoB, 'POST', '/tenants/apply-template', { templateKey: 'cafe', conceptName: `SV Cafe ${stamp}` })
    expect(bad.statusCode).toBe(400)
    expect(await prisma.concept.count({ where: { tenantId: B.tenantId } })).toBe(before)
    const ok = await call(ceoB, 'POST', '/tenants/apply-template', { templateKey: 'cafe', conceptName: `SV Cafe ${stamp}`, serviceVessel: 'packaging' })
    expect(ok.statusCode).toBe(201)
    const c = await prisma.concept.findUniqueOrThrow({ where: { id: ok.json().conceptId } })
    expect(c.serviceVessel).toBe('packaging')
    expect(c.tenantId).toBe(B.tenantId)
  })
})

describe('PATCH /concepts/:id serviceVessel', () => {
  it("company B → 404 on A's brand; nothing changes, no audit", async () => {
    const r = await call(ceoB, 'PATCH', `/concepts/${A.conceptId}`, { serviceVessel: 'packaging' })
    expect(r.statusCode).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).serviceVessel).toBe('plate')
    expect(await prisma.auditLog.count({ where: { action: 'concept.service_vessel', entityId: A.conceptId } })).toBe(0)
  })

  it('the vessel is the CEO\'s: management has no editor (403), nothing changes', async () => {
    const r = await call(mgrA, 'PATCH', `/concepts/${A.conceptId}`, { serviceVessel: 'packaging' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('BRAND_EDITOR_ONLY')
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).serviceVessel).toBe('plate')
  })

  it('a bad value → 400', async () => {
    expect((await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { serviceVessel: 'tray' })).statusCode).toBe(400)
  })

  it('a change is audited with from / to on the brand\'s company; an earlier line keeps its snapshot, a later line takes the new vessel', async () => {
    const before = await ring(A.conceptId, A.items.nihari)
    expect(before.serviceVessel).toBe('plate')

    const r = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { serviceVessel: 'packaging' })
    expect(r.statusCode).toBe(200)
    expect(r.json().serviceVessel).toBe('packaging')
    const audits = await prisma.auditLog.findMany({ where: { action: 'concept.service_vessel', entityId: A.conceptId } })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.tenantId).toBe(A.tenantId)
    expect(audits[0]!.userId).toBe(ceoA.id)
    expect(audits[0]!.before).toEqual({ serviceVessel: 'plate' })
    expect(audits[0]!.after).toEqual({ serviceVessel: 'packaging' })
    expect(JSON.stringify(audits[0]!.metadata)).toMatch(/from now on/i)

    // The line rung up before the change is not restated.
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: before.id } })).serviceVessel).toBe('plate')
    const after = await ring(A.conceptId, A.items.nihari)
    expect(after.serviceVessel).toBe('packaging')
  })

  it('a PATCH that does not change the vessel writes no vessel audit', async () => {
    expect((await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { serviceVessel: 'packaging', heroTagline: 'same vessel' })).statusCode).toBe(200)
    expect((await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { heroTagline: 'no vessel field' })).statusCode).toBe(200)
    expect(await prisma.auditLog.count({ where: { action: 'concept.service_vessel', entityId: A.conceptId } })).toBe(1)
  })
})
