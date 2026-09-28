// Realtime topic authorization — the one function that decides which live
// channels a staff member may hear, on both transports (socket.io rooms and
// the Supabase token's `servd_topics` claim).
//
// What these defend: a company's kitchen feed is never audible from another
// company, whatever ids a client asks for; role gating matches what the socket
// server historically allowed; the token endpoint re-reads the live account.
//
// Needs the disposable test database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

// Token revocation lives in Redis; this suite is about topic authorization,
// so treat every session as live rather than require a Redis alongside the
// test database.
vi.mock('../src/lib/tokenRevocation.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/tokenRevocation.js')>()
  return { ...real, isRevoked: vi.fn(async () => false) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { resolveRealtimeTopics, loadRealtimePrincipal } = await import('../src/lib/realtimeTopics.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')

const PREFIX = 'rt-test'
const created: string[] = []
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let stationA: string
let stationB: string
let app: FastifyInstance

async function makeUser(role: string, tenantId: string | null, extra: { accountStatus?: 'active' | 'suspended' } = {}) {
  const n = created.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${role} ${n}`,
      email: `${PREFIX}.${role}.${n}.${Date.now()}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: role as never,
      tenantId,
      isActive: extra.accountStatus !== 'suspended',
      accountStatus: extra.accountStatus ?? 'active',
      ...(tenantId ? { tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] } } : {}),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  created.push(u.id)
  return u
}

function bearer(u: { id: string; name: string | null; email: string | null; role: string }) {
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}

beforeAll(async () => {
  const stamp = Date.now()
  tenantA = (await prisma.tenant.create({ data: { name: 'RT Co A', slug: `${PREFIX}-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'RT Co B', slug: `${PREFIX}-b-${stamp}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'rt a', slug: `${PREFIX}-ca-${stamp}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: 'rt b', slug: `${PREFIX}-cb-${stamp}`, type: 'restaurant', tenantId: tenantB } as never })).id
  stationA = (await prisma.station.create({ data: { name: 'grill a', conceptId: conceptA } as never })).id
  stationB = (await prisma.station.create({ data: { name: 'grill b', conceptId: conceptB } as never })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  await prisma.tenantMember.deleteMany({ where: { userId: { in: created } } })
  await prisma.user.deleteMany({ where: { id: { in: created } } })
  await prisma.station.deleteMany({ where: { id: { in: [stationA, stationB] } } })
  await prisma.concept.deleteMany({ where: { id: { in: [conceptA, conceptB] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('resolveRealtimeTopics', () => {
  it('a manager hears their own company feeds and nothing of another company', async () => {
    const p = { id: 'x', role: 'manager', tenantId: tenantA, tenantIds: [tenantA] }
    const topics = await resolveRealtimeTopics(p, { stationId: stationB, conceptId: conceptB })
    expect(topics).toEqual(expect.arrayContaining([`tenant:${tenantA}`, `tenant:${tenantA}:orders`, `tenant:${tenantA}:reservations`, 'all-orders']))
    expect(topics).not.toContain(`station:${stationB}`)
    expect(topics).not.toContain(`concept:${conceptB}`)
    expect(topics.some((t) => t.includes(tenantB))).toBe(false)
  })

  it('owned station and concept rooms are granted, unknown ids are ignored', async () => {
    const p = { id: 'x', role: 'kitchen', tenantId: tenantA, tenantIds: [tenantA] }
    const topics = await resolveRealtimeTopics(p, { stationId: stationA, conceptId: conceptA })
    expect(topics).toContain(`station:${stationA}`)
    expect(topics).toContain(`concept:${conceptA}`)
    const none = await resolveRealtimeTopics(p, { stationId: 'does-not-exist', conceptId: 'nope' })
    expect(none.filter((t) => t.startsWith('station:') || t.startsWith('concept:'))).toEqual([])
  })

  it('role gating matches the socket server: kitchen gets reservations but not the order feed; cashier gets reservations; procurement gets only the company room', async () => {
    const kitchen = await resolveRealtimeTopics({ id: 'k', role: 'kitchen', tenantId: tenantA, tenantIds: [tenantA] })
    expect(kitchen).toContain(`tenant:${tenantA}:reservations`)
    expect(kitchen).not.toContain(`tenant:${tenantA}:orders`)
    expect(kitchen).not.toContain('all-orders')

    const cashier = await resolveRealtimeTopics({ id: 'c', role: 'cashier', tenantId: tenantA, tenantIds: [tenantA] })
    expect(cashier).toContain(`tenant:${tenantA}:reservations`)
    expect(cashier).not.toContain('all-orders')

    const procurement = await resolveRealtimeTopics({ id: 'p', role: 'procurement', tenantId: tenantA, tenantIds: [tenantA] })
    expect(procurement).toEqual([`tenant:${tenantA}`])
  })

  it('a multi-company operator hears every company they belong to', async () => {
    const topics = await resolveRealtimeTopics({ id: 'o', role: 'owner', tenantId: tenantA, tenantIds: [tenantA, tenantB] }, { conceptId: conceptB })
    expect(topics).toContain(`tenant:${tenantB}:orders`)
    expect(topics).toContain(`concept:${conceptB}`)
  })

  it('a user with no company hears nothing', async () => {
    expect(await resolveRealtimeTopics({ id: 'n', role: 'admin', tenantId: null, tenantIds: [] }, { stationId: stationA })).toEqual(['all-orders'])
  })
})

describe('loadRealtimePrincipal', () => {
  it('returns the live role and memberships, and null for a suspended account', async () => {
    const u = await makeUser('manager', tenantA)
    await prisma.tenantMember.create({ data: { tenantId: tenantB, userId: u.id } as never })
    const p = await loadRealtimePrincipal(u.id)
    expect(p?.role).toBe('manager')
    expect(p?.tenantIds.sort()).toEqual([tenantA, tenantB].sort())

    const s = await makeUser('manager', tenantA, { accountStatus: 'suspended' })
    expect(await loadRealtimePrincipal(s.id)).toBeNull()
  })
})

describe('GET /auth/realtime-token', () => {
  it('mints a Supabase JWT whose servd_topics claim is exactly the allowed list', async () => {
    process.env['REALTIME_DRIVER'] = 'supabase'
    process.env['SUPABASE_URL'] = 'https://example.supabase.co'
    process.env['SUPABASE_ANON_KEY'] = 'anon'
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = 'service-role'
    process.env['SUPABASE_JWT_SECRET'] = 'test-supabase-jwt-secret-with-enough-length'
    const u = await makeUser('expediter', tenantA)
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/realtime-token?stationId=${stationA}&conceptId=${conceptB}`,
      headers: bearer(u),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { driver: string; token: string; topics: string[]; url: string; anonKey: string; expiresAt: string }
    expect(body.driver).toBe('supabase')
    expect(body.url).toBe('https://example.supabase.co')
    expect(body.anonKey).toBe('anon')
    const claims = jwt.verify(body.token, process.env['SUPABASE_JWT_SECRET']!, { algorithms: ['HS256'] }) as Record<string, unknown>
    expect(claims['role']).toBe('authenticated')
    expect(claims['sub']).toBe(u.id)
    expect(claims['servd_topics']).toEqual(body.topics)
    expect(body.topics).toContain(`station:${stationA}`)
    // Foreign concept asked for, never granted.
    expect(body.topics).not.toContain(`concept:${conceptB}`)
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('refuses without a staff session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/realtime-token' })
    expect(res.statusCode).toBe(401)
  })
})
