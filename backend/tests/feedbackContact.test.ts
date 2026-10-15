// Contact form on the feedback system (SEO round 1, WP4): a public submit
// stores under the brand's company, a client-sent tenant is never trusted,
// the caps and honeypot hold, nothing is messaged, and staff of company B
// cannot read company A's contact messages.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { feedbackRoutes } = await import('../src/modules/feedback/routes.js')
const { resetContactLimit } = await import('../src/modules/feedback/contactLimit.js')

const STAMP = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
let brandA: string, brandB: string, slugA: string
const userIds: string[] = []
type U = { id: string; name: string; email: string; role: string }
let mgrA: U, mgrB: U

async function makeUser(label: string, tenant: string): Promise<U> {
  const u = await prisma.user.create({
    data: {
      name: `fbc ${label}`, email: `fbc.${label}.${STAMP}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4), role: 'marketing' as never,
      tenantId: tenant, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenant } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  userIds.push(u.id)
  return u as U
}
const auth = (u: U) => ({ authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` })

let n = 0
const form = (over: Record<string, unknown> = {}) => ({
  kind: 'contact', name: 'Sana Khan', replyPhone: `0300 123 ${String(4000 + n++)}`, topic: 'catering',
  comment: 'Do you cater for 80 people in Clifton?', ...over,
})
// A fresh caller address per call (the address bucket lives in Redis and
// outlasts the test), unless the test pins one.
let ipN = 0
const freshIp = () => `10.${STAMP % 250}.${Math.floor(++ipN / 250)}.${ipN % 250}`
const submit = (payload: unknown, ip = freshIp()) =>
  app.inject({ method: 'POST', url: '/api/v1/feedback', payload: payload as object, remoteAddress: ip })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'FBC Co A', slug: `fbc-a-${STAMP}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'FBC Co B', slug: `fbc-b-${STAMP}` } })).id
  slugA = `fbc-brand-a-${STAMP}`
  brandA = (await prisma.concept.create({ data: { name: 'FBC A', slug: slugA, type: 'restaurant', tenantId: tenantA } })).id
  brandB = (await prisma.concept.create({ data: { name: 'FBC B', slug: `fbc-brand-b-${STAMP}`, type: 'restaurant', tenantId: tenantB } })).id
  mgrA = await makeUser('a', tenantA)
  mgrB = await makeUser('b', tenantB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(feedbackRoutes, { prefix: '/feedback' }) }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

beforeEach(() => resetContactLimit())

afterAll(async () => {
  await app?.close()
  await prisma.feedbackEntry.deleteMany({ where: { OR: [{ tenantId: { in: [tenantA, tenantB] } }, { conceptId: { in: [brandA, brandB] } }] } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.concept.deleteMany({ where: { id: { in: [brandA, brandB] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('public contact submit', () => {
  it('stores under the brand company, with the reply fields and topic', async () => {
    const r = await submit(form({ conceptId: brandA }))
    expect(r.statusCode).toBe(201)
    const row = await prisma.feedbackEntry.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row).toMatchObject({
      kind: 'contact', tenantId: tenantA, conceptId: brandA, topic: 'catering',
      contactName: 'Sana Khan', source: 'contact_page',
    })
    expect(row.replyPhone).toMatch(/^0300123/)
    expect(row.comment).toContain('80 people')
  })

  it('a brand slug resolves the same way; an unknown or hidden brand is 422', async () => {
    const r = await submit(form({ brandSlug: slugA }))
    expect(r.statusCode).toBe(201)
    expect((await prisma.feedbackEntry.findUniqueOrThrow({ where: { id: r.json().id } })).tenantId).toBe(tenantA)
    expect((await submit(form({ brandSlug: 'no-such-brand' }))).statusCode).toBe(422)
    expect((await submit(form({ conceptId: '00000000-0000-4000-8000-000000000000' }))).statusCode).toBe(422)
  })

  it('never trusts a client tenant: a tenantId in the body is ignored', async () => {
    const r = await submit(form({ conceptId: brandA, tenantId: tenantB }))
    expect(r.statusCode).toBe(201)
    expect((await prisma.feedbackEntry.findUniqueOrThrow({ where: { id: r.json().id } })).tenantId).toBe(tenantA)
  })

  it('with no brand it binds to the primary company, not a client choice', async () => {
    const r = await submit(form({ tenantId: tenantB }))
    expect(r.statusCode).toBe(201)
    const row = await prisma.feedbackEntry.findUniqueOrThrow({ where: { id: r.json().id } })
    const primary = await prisma.tenant.findFirst({ where: { isActive: true, deletedAt: null }, orderBy: { createdAt: 'asc' } })
    expect(row.tenantId).toBe(primary!.id)
    expect(row.conceptId).toBeNull()
    await prisma.feedbackEntry.delete({ where: { id: row.id } })
  })

  it('validates name, message, topic and a way to reply', async () => {
    for (const bad of [
      form({ name: '' }), form({ comment: 'hi' }), form({ topic: null }), form({ topic: 'spam' }),
      form({ replyPhone: null }), form({ replyPhone: 'abc' }), form({ replyPhone: null, replyEmail: 'nope' }),
    ]) {
      const r = await submit(bad)
      expect([400, 422]).toContain(r.statusCode)
    }
    expect((await submit(form({ replyPhone: null, replyEmail: 'sana@example.com' }))).statusCode).toBe(201)
  })

  it('honeypot: a filled hidden field answers 201 but stores nothing', async () => {
    const before = await prisma.feedbackEntry.count({ where: { contactName: 'Bot Bot' } })
    const r = await submit(form({ name: 'Bot Bot', website: 'http://spam.example' }))
    expect(r.statusCode).toBe(201)
    expect(await prisma.feedbackEntry.count({ where: { contactName: 'Bot Bot' } })).toBe(before)
  })

  it('rate limit: 3 per reply phone per hour, 5 per address per hour', async () => {
    const phone = '0321 555 0199'
    for (let i = 0; i < 3; i++) expect((await submit(form({ conceptId: brandA, replyPhone: phone }), freshIp())).statusCode).toBe(201)
    const over = await submit(form({ conceptId: brandA, replyPhone: phone }), freshIp())
    expect(over.statusCode).toBe(429)
    expect(over.json().error.code).toBe('RATE_LIMITED')
    // A different phone is fine, until the address is used up.
    const ip = freshIp()
    for (let i = 0; i < 5; i++) expect((await submit(form({ conceptId: brandA }), ip)).statusCode).toBe(201)
    expect((await submit(form({ conceptId: brandA }), ip)).statusCode).toBe(429)
  })
})

describe('staff inbox is company-scoped', () => {
  let aRow: string
  beforeAll(async () => {
    aRow = (await prisma.feedbackEntry.create({
      data: { tenantId: tenantA, conceptId: brandA, kind: 'contact', comment: 'A private press enquiry', topic: 'press', contactName: 'Zed', replyEmail: 'zed@example.com' },
    })).id
    await prisma.feedbackEntry.create({
      data: { tenantId: tenantA, conceptId: null, kind: 'contact', comment: 'A brandless note to company A', topic: 'jobs', contactName: 'Yara', replyPhone: '0300111222' },
    })
  })

  it('company A sees its brand and brandless contact messages, with the new fields', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/feedback?kind=contact&limit=200', headers: auth(mgrA) })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<{ id: string; topic: string; contactName: string; replyEmail: string | null }>
    expect(rows.find((x) => x.id === aRow)).toMatchObject({ topic: 'press', contactName: 'Zed', replyEmail: 'zed@example.com' })
    expect(rows.some((x) => x.contactName === 'Yara')).toBe(true)
    const filtered = await app.inject({ method: 'GET', url: '/api/v1/feedback?kind=contact&topic=jobs', headers: auth(mgrA) })
    expect((filtered.json() as Array<{ topic: string }>).every((x) => x.topic === 'jobs')).toBe(true)
  })

  it('company B sees none of company A rows, and a foreign brand filter is 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/feedback?kind=contact&limit=200', headers: auth(mgrB) })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<{ id: string; contactName: string }>
    expect(rows.find((x) => x.id === aRow)).toBeUndefined()
    expect(rows.some((x) => x.contactName === 'Yara' || x.contactName === 'Zed')).toBe(false)
    const foreign = await app.inject({ method: 'GET', url: `/api/v1/feedback?conceptId=${brandA}`, headers: auth(mgrB) })
    expect(foreign.statusCode).toBe(404)
  })

  it('no token, no inbox', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/feedback' })).statusCode).toBe(401)
  })
})
