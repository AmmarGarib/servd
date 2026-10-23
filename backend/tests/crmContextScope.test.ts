// F2 — the guest card side panel (GET /crm/customers/:id/context) must show
// the figures of the companies in view only. The Customer rollup columns
// (totalSpentCents, first/last order, no-show / complaint / review counts) are
// servd-wide; a customer who spent PKR 60k at company A is not company B's VIP.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { crmRoutes } from '../src/modules/crm/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, tenantC: string, conceptA: string, conceptB: string
let shared: string, onlyA: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@crmctx.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}

const ctx = (who: string, id: string) =>
  app.inject({ method: 'GET', url: `/crm/customers/${id}/context`, headers: { authorization: `Bearer ${tokens[who]}` } })

async function order(conceptId: string, customerId: string, totalCents: number, completedAt: Date) {
  await prisma.order.create({
    data: {
      conceptId, customerId, source: 'pos', status: 'completed', totalCents, completedAt, placedAt: completedAt,
      items: { create: [{ name: 'Latte', quantity: 1, unitPriceCents: totalCents }] },
    } as never,
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Ctx A', slug: `ctx-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Ctx B', slug: `ctx-b-${RUN}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'Ctx C', slug: `ctx-c-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Ctx Brand A', slug: `ctx-brand-a-${RUN}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Ctx Brand B', slug: `ctx-brand-b-${RUN}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await mkUser('mgrA', tenantA)
  await mkUser('mgrB', tenantB)
  await mkUser('mgrC', tenantC)

  // Global rollups as lib/customerRollups.ts would write them — servd-wide.
  shared = (await prisma.customer.create({
    data: {
      name: 'Shared', email: `shared.${RUN}@crmctx.test`, phone: `+92301${Math.floor(Math.random() * 1e7)}`,
      totalSpentCents: 6_010_000, noShowCount: 4, complaintCount: 3, reviewCount: 2, avgReviewRating: 1.5,
      firstOrderAt: new Date('2026-01-01T10:00:00Z'), lastOrderAt: new Date('2026-10-01T10:00:00Z'),
      lastVisitAt: new Date('2026-10-01T10:00:00Z'), preferredConceptId: conceptA,
    } as never,
  })).id
  await order(conceptA, shared, 6_000_000, new Date('2026-01-01T10:00:00Z'))
  await order(conceptA, shared, 0, new Date('2026-10-01T10:00:00Z'))
  await order(conceptB, shared, 10_000, new Date('2026-05-05T10:00:00Z'))
  onlyA = (await prisma.customer.create({ data: { name: 'OnlyA', email: `onlya.${RUN}@crmctx.test` } })).id
  await order(conceptA, onlyA, 5_000, new Date('2026-06-01T10:00:00Z'))

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.ready()
})

afterAll(async () => { await app?.close() })

describe('GET /crm/customers/:id/context — company figures only (F2)', () => {
  it("company B sees only its own totals, never A's spend or the global rollups", async () => {
    const r = await ctx('mgrB', shared)
    expect(r.statusCode).toBe(200)
    const b = r.json()
    expect(b.totalSpentCents).toBe(10_000)
    expect(b._count.orders).toBe(1)
    expect(new Date(b.firstOrderAt).toISOString()).toBe('2026-05-05T10:00:00.000Z')
    expect(new Date(b.lastOrderAt).toISOString()).toBe('2026-05-05T10:00:00.000Z')
    expect(new Date(b.lastVisitAt).toISOString()).toBe('2026-05-05T10:00:00.000Z')
    expect(b.noShowCount).toBe(0)
    expect(b.complaintCount).toBe(0)
    expect(b.reviewCount).toBe(0)
    expect(b.avgReviewRating).toBeNull()
    // A's brand is not B's preferred-brand business.
    expect(b.preferredConceptId).toBeNull()
    expect(b.preferredConcept).toBeNull()
    expect(JSON.stringify(b)).not.toContain('6010000')
    expect(b.recent.orders.map((o: { concept: { name: string } }) => o.concept.name)).toEqual(['Ctx Brand B'])
  })

  it('company A sees its own totals', async () => {
    const a = (await ctx('mgrA', shared)).json()
    expect(a.totalSpentCents).toBe(6_000_000)
    expect(a._count.orders).toBe(2)
    expect(new Date(a.firstOrderAt).toISOString()).toBe('2026-01-01T10:00:00.000Z')
    expect(new Date(a.lastOrderAt).toISOString()).toBe('2026-10-01T10:00:00.000Z')
    expect(a.preferredConcept?.name).toBe('Ctx Brand A')
  })

  it("company B gets 404 on a customer only A has served; a company with none gets 404", async () => {
    expect((await ctx('mgrB', onlyA)).statusCode).toBe(404)
    expect((await ctx('mgrC', shared)).statusCode).toBe(404)
  })
})
