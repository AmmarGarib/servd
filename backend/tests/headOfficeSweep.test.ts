// Head-office kind sweep (D1/D3, amendment A24): a head office trades nothing,
// so no fleet agreement may name one and no trading worker visits one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { riderRoutes } = await import('../src/modules/riders/routes.js')
const { runOnce: shrinkageOnce } = await import('../src/workers/shrinkageTrend.js')
const { runPreOrderReleaseTick } = await import('../src/workers/preOrderRelease.js')
const { runGiftCardExpiryOnce } = await import('../src/workers/giftCardExpiry.js')
const { computeAllSegments } = await import('../src/modules/crm/segmentComputation.js')

const PREFIX = `hos-${Date.now()}`
let app: FastifyInstance
let co: string, co2: string, ho: string
let token: string

async function mk(name: string, kind: 'company' | 'head_office'): Promise<string> {
  return (await prisma.tenant.create({ data: { name: `${PREFIX} ${name}`, slug: `${PREFIX}-${name}`, kind } })).id
}

beforeAll(async () => {
  co = await mk('co', 'company')
  co2 = await mk('co2', 'company')
  ho = await mk('ho', 'head_office')
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ceo`, email: `${PREFIX}@hos.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: 'admin', tenantId: co, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [co, co2, ho].map((t) => ({ tenant: { connect: { id: t } }, role: 'admin' as const })) },
    },
  })
  token = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(riderRoutes, { prefix: '/riders' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await prisma.fleetAgreement.deleteMany({ where: { OR: [{ providerTenantId: { in: [co, co2, ho] } }, { clientTenantId: { in: [co, co2, ho] } }] } })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [co, co2, ho] } } })
})

const put = (providerTenantId: string, clientTenantId: string) =>
  app.inject({ method: 'PUT', url: '/riders/fleet/agreements', headers: { authorization: token }, payload: { providerTenantId, clientTenantId, isActive: true } })

describe('fleet agreements', () => {
  it('refuses a head office as provider or client with 422 FLEET_HEAD_OFFICE', async () => {
    for (const [p, c] of [[ho, co], [co, ho]] as const) {
      const r = await put(p, c)
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('FLEET_HEAD_OFFICE')
    }
    expect(await prisma.fleetAgreement.count({ where: { OR: [{ providerTenantId: ho }, { clientTenantId: ho }] } })).toBe(0)
  })
  it('still makes an agreement between two companies', async () => {
    const r = await put(co, co2)
    expect(r.statusCode).toBe(200)
  })
  it('the tenant picker lists companies, never the head office', async () => {
    const r = await app.inject({ method: 'GET', url: '/riders/fleet/agreements', headers: { authorization: token } })
    const ids = (r.json().companies as { id: string }[]).map((c) => c.id)
    expect(ids).toContain(co)
    expect(ids).not.toContain(ho)
  })
})

/** Run fn while recording every tenant id the workers' tenant.findMany returned. */
async function seen(fn: () => Promise<unknown>): Promise<Set<string>> {
  const ids = new Set<string>()
  const model = prisma.tenant as unknown as { findMany: (a?: unknown) => Promise<{ id: string }[]> }
  const orig = model.findMany
  model.findMany = async function (this: unknown, a?: unknown) {
    const rows = await orig.call(this, a)
    for (const r of rows) ids.add(r.id)
    return rows
  }
  try { await fn() } finally { model.findMany = orig }
  return ids
}

describe('worker ticks skip a head office', () => {
  it.each([
    ['shrinkageTrend', () => shrinkageOnce()],
    ['preOrderRelease', () => runPreOrderReleaseTick()],
    ['giftCardExpiry', () => runGiftCardExpiryOnce()],
    ['segment computation', () => computeAllSegments()],
  ])('%s', async (_n, fn) => {
    const ids = await seen(fn)
    expect(ids.has(co)).toBe(true)
    expect(ids.has(co2)).toBe(true)
    expect(ids.has(ho)).toBe(false)
  })
})
