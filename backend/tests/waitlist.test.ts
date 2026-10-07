// servd new-brand waitlist (owner, 2026-10-07).
//
// Opt-in, WhatsApp-verified, ONE servd-level list. Defended here:
//   - no consent, no code sent; wrong code, no sign-up;
//   - the right code files the person into the customer master (phone
//     verified) and onto the list; joining again reuses them;
//   - an existing customer's name/email are never overwritten;
//   - codes are capped per phone (an IP limit alone is the easy half);
//   - a visit stores nothing personal;
//   - stats/sign-ups need a staff login with module crm or campaigns;
//   - the campaign audience `waitlist` is exactly the subscribed, reachable
//     members with a contact — never the company's customer base.
//
// WhatsApp is stubbed at sendText (as tests/dualContactVerification.test.ts
// does) and the code read from the message. Needs the test Postgres + Redis.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const sentCodes = new Map<string, string>()   // normalised phone → last code
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    sendText: vi.fn(async (to: string, msg: string) => {
      const m = msg.match(/\d{6}/)
      if (m) sentCodes.set(to, m[0])
    }),
  }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { waitlistRoutes } = await import('../src/modules/waitlist/routes.js')
const { crmRoutes } = await import('../src/modules/crm/routes.js')
const { WAITLIST_CONSENT_TEXT, waitlistUnsubscribeToken } = await import('../src/modules/waitlist/service.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { redis } = await import('../src/lib/redis.js')

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, brandA: string
const tokens: Record<string, string> = {}

async function mkStaff(key: string, role: 'admin' | 'kitchen' | 'marketing') {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@waitlist.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId: tenantA,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId: tenantA, userId: u.id } })
  tokens[key] = issueStaffSession(u).accessToken
}

const post = (url: string, payload: unknown, ip = '10.7.7.7', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/waitlist${url}`, payload: payload as never, remoteAddress: ip, headers })
const staff = (who: string | null, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: who ? { authorization: `Bearer ${tokens[who]}` } : {} })

const form = (phone: string, extra: Record<string, unknown> = {}) => ({
  name: 'Wait Lister', phone, consent: true, consentText: WAITLIST_CONSENT_TEXT, source: 'instagram', ...extra,
})

/** Lets the next code for this phone skip otp.ts's 30-second resend cooldown. */
async function ageCodes(normalised: string) {
  await prisma.phoneOtp.updateMany({ where: { phone: normalised }, data: { createdAt: new Date(Date.now() - 60_000) } })
}

async function join(phone: string, normalised: string, extra: Record<string, unknown> = {}) {
  const r = await post('/request-code', form(phone, extra))
  expect(r.statusCode).toBe(200)
  const res = await post('/join', { ...form(phone, extra), code: sentCodes.get(normalised) })
  await ageCodes(normalised)
  return res
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Waitlist Co', slug: `wl-co-${RUN}` } })).id
  brandA = (await prisma.concept.create({ data: { name: 'WL Brand', slug: `wl-brand-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  await mkStaff('ceo', 'admin')
  await mkStaff('cook', 'kitchen')
  await mkStaff('mkt', 'marketing')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: String((err as Error).message) } })
  })
  await app.register(waitlistRoutes, { prefix: '/waitlist' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

beforeEach(async () => {
  const keys = await redis.keys('ratelimit:waitlist*')
  if (keys.length) await redis.del(...keys)
})

describe('request-code', () => {
  it('refuses without consent and sends nothing', async () => {
    const r = await post('/request-code', form('03001110001', { consent: false }))
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('CONSENT_REQUIRED')
    expect(await prisma.phoneOtp.count({ where: { phone: '923001110001' } })).toBe(0)
  })

  it('refuses consent wording that is not ours', async () => {
    const r = await post('/request-code', form('03001110001', { consentText: 'Spam me' }))
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('CONSENT_MISMATCH')
  })

  it('sends a code to the normalised number through the shared store', async () => {
    const r = await post('/request-code', form('0300-111-0002'))
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ sent: true, phoneHint: expect.stringContaining('0002') })
    expect(sentCodes.get('923001110002')).toMatch(/^\d{6}$/)
    expect(await prisma.phoneOtp.count({ where: { phone: '923001110002', purpose: 'waitlist' } })).toBe(1)
  })

  it('caps codes per phone, whatever the IP', async () => {
    const phone = '03001110009'
    for (let i = 0; i < 3; i++) {
      const r = await post('/request-code', form(phone), `10.8.0.${i + 1}`)
      expect(r.statusCode).toBe(200)
      await ageCodes('923001110009')
    }
    const r = await post('/request-code', form(phone), '10.8.0.99')
    expect(r.statusCode).toBe(429)
    expect(r.json().error.code).toBe('RATE_LIMITED')
  })
})

describe('join', () => {
  it('fails with a wrong code and creates nothing', async () => {
    await post('/request-code', form('03001110003'))
    const good = sentCodes.get('923001110003')!
    const wrong = good === '000000' ? '111111' : '000000'
    const r = await post('/join', { ...form('03001110003'), code: wrong })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('INVALID_CODE')
    expect(await prisma.customer.count({ where: { phone: '923001110003' } })).toBe(0)
    await ageCodes('923001110003')
  })

  it('with the right code creates a verified customer and a sign-up; again → alreadyOnList', async () => {
    const r = await join('03001110004', '923001110004', { email: 'Joiner@Example.com', area: 'DHA', interest: 'Ramen' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ joined: true, alreadyOnList: false })
    const c = await prisma.customer.findUnique({ where: { phone: '923001110004' }, include: { waitlistSignups: true } })
    expect(c!.phoneVerifiedAt).not.toBeNull()
    expect(c!.email).toBe('joiner@example.com')
    expect(c!.waitlistSignups).toHaveLength(1)
    const s = c!.waitlistSignups[0]!
    expect(s).toMatchObject({ list: 'servd_new_brand', source: 'instagram', area: 'DHA', interest: 'Ramen', consentText: WAITLIST_CONSENT_TEXT })

    const again = await join('+92 300 1110004', '923001110004')
    expect(again.json()).toEqual({ joined: true, alreadyOnList: true })
    expect(await prisma.customer.count({ where: { phone: '923001110004' } })).toBe(1)
    expect(await prisma.waitlistSignup.count({ where: { customerId: c!.id } })).toBe(1)
  })

  it("never overwrites an existing customer's name or email", async () => {
    const existing = await prisma.customer.create({
      data: { name: 'Original Name', email: `orig.${RUN}@example.com`, phone: '+923001110005' },
    })
    const r = await join('03001110005', '923001110005', { name: 'Someone Else', email: `new.${RUN}@example.com` })
    expect(r.json()).toEqual({ joined: true, alreadyOnList: false })
    const after = await prisma.customer.findUnique({ where: { id: existing.id } })
    expect(after!.name).toBe('Original Name')
    expect(after!.email).toBe(`orig.${RUN}@example.com`)
    expect(after!.phoneVerifiedAt).not.toBeNull()
    expect(await prisma.waitlistSignup.count({ where: { customerId: existing.id } })).toBe(1)
  })

  it('unsubscribe leaves the list (signed token only)', async () => {
    const r0 = await join('03001110006', '923001110006')
    expect(r0.statusCode).toBe(200)
    const c = await prisma.customer.findUnique({ where: { phone: '923001110006' }, include: { waitlistSignups: true } })
    const id = c!.waitlistSignups[0]!.id
    expect((await post('/unsubscribe', { token: `${id}.forged-signature` })).statusCode).toBe(400)
    const r = await post('/unsubscribe', { token: waitlistUnsubscribeToken(id) })
    expect(r.statusCode).toBe(200)
    expect((await prisma.waitlistSignup.findUnique({ where: { id } }))!.unsubscribedAt).not.toBeNull()
    // Rejoining puts them back on the list.
    expect((await join('03001110006', '923001110006')).json()).toEqual({ joined: true, alreadyOnList: false })
  })
})

describe('visit', () => {
  it('stores only source, device and country — nothing personal', async () => {
    const r = await post('/visit', { source: 'Insta Gram!' }, '203.0.113.9', {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148',
      'cf-ipcountry': 'PK',
    })
    expect(r.statusCode).toBe(204)
    const v = await prisma.waitlistVisit.findFirst({ orderBy: { createdAt: 'desc' } })
    expect(Object.keys(v!).sort()).toEqual(['country', 'createdAt', 'device', 'id', 'list', 'source'])
    expect(v).toMatchObject({ source: 'instagram', device: 'mobile', country: 'PK' })
    expect(JSON.stringify(v)).not.toContain('203.0.113.9')
  })
})

describe('staff views', () => {
  it('need a staff login and module crm or campaigns', async () => {
    expect((await staff(null, 'GET', '/waitlist/stats')).statusCode).toBe(401)
    expect((await staff('cook', 'GET', '/waitlist/stats')).statusCode).toBe(403)
    expect((await staff('cook', 'GET', '/waitlist/signups')).statusCode).toBe(403)
    expect((await staff('cook', 'GET', '/waitlist/signups.csv')).statusCode).toBe(403)
    expect((await staff('mkt', 'GET', '/waitlist/stats')).statusCode).toBe(200)
  })

  it('stats and sign-ups', async () => {
    const s = (await staff('ceo', 'GET', '/waitlist/stats')).json()
    expect(s.signups).toBeGreaterThanOrEqual(3)
    expect(s.visits).toBeGreaterThanOrEqual(1)
    expect(s.bySource.find((x: { source: string }) => x.source === 'instagram')).toBeTruthy()
    expect(s.byDevice).toContainEqual({ device: 'mobile', visits: expect.any(Number) })
    expect(s.last7Days).toHaveLength(7)

    const l = (await staff('ceo', 'GET', '/waitlist/signups?q=joiner')).json()
    expect(l.total).toBe(1)
    expect(l.rows[0]).toMatchObject({ name: 'Wait Lister', phone: '923001110004', email: 'joiner@example.com', source: 'instagram' })

    const csv = await staff('ceo', 'GET', '/waitlist/signups.csv?source=instagram')
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body).toContain('923001110004')
  })
})

describe('campaign audience: waitlist', () => {
  it('counts subscribed members with a contact, skips the opted-out and the company\'s other customers', async () => {
    // A customer of the company who is NOT on the list.
    await prisma.customer.create({ data: { name: 'Regular', phone: '923001119991', email: `reg.${RUN}@example.com`, preferredConceptId: brandA } })
    // On the list but unsubscribed from all marketing.
    const optedOut = await join('03001110007', '923001110007')
    expect(optedOut.statusCode).toBe(200)
    await prisma.customer.update({ where: { phone: '923001110007' }, data: { marketingOptOutAt: new Date() } })
    // On the list but left it.
    await join('03001110008', '923001110008')
    const left = await prisma.customer.findUnique({ where: { phone: '923001110008' }, select: { id: true } })
    await prisma.waitlistSignup.updateMany({ where: { customerId: left!.id }, data: { unsubscribedAt: new Date() } })

    // Expected: subscribed members, reachable. 004 (email), 005 (email), 006 (no email).
    const members = await prisma.customer.findMany({
      where: { marketingOptOutAt: null, deletedAt: null, waitlistSignups: { some: { unsubscribedAt: null } } },
      select: { phone: true, email: true },
    })
    expect(members.map((m) => m.phone).sort()).toEqual(['+923001110005', '923001110004', '923001110006'])

    const wa = await staff('ceo', 'GET', '/crm/campaigns/audience?channel=whatsapp&segment=waitlist')
    expect(wa.statusCode).toBe(200)
    expect(wa.json()).toEqual({ total: 3, optedOut: 1 })
    const em = await staff('ceo', 'GET', '/crm/campaigns/audience?channel=email&segment=waitlist')
    expect(em.json().total).toBe(2)   // 006 has no email

    // The company's own base (no segment) includes Regular, the waitlist does not.
    const base = (await staff('ceo', 'GET', '/crm/campaigns/audience?channel=whatsapp')).json()
    expect(base.total).toBe(1)
  })

  it('a campaign can target it, and an unknown slug is still refused', async () => {
    const r = await staff('ceo', 'POST', '/crm/campaigns', { name: `wl-${RUN}`, channel: 'whatsapp', body: 'New brand soon', segment: 'waitlist', conceptIds: [] })
    expect(r.statusCode).toBe(201)
    expect(r.json().segment).toEqual({ slug: 'waitlist', name: 'New-brand waitlist' })
    const listed = (await staff('ceo', 'GET', '/crm/campaigns')).json()
    expect(listed.find((c: { id: string }) => c.id === r.json().id).segment.slug).toBe('waitlist')

    expect((await staff('ceo', 'GET', '/crm/campaigns/audience?channel=whatsapp&segment=bogus')).statusCode).toBe(404)
    expect((await staff('ceo', 'POST', '/crm/campaigns', { name: 'x', channel: 'whatsapp', body: 'b', segment: 'bogus' })).statusCode).toBe(400)
  })
})
