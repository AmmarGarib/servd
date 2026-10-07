// Brand / customer-config reconcile (2026-09-27): one writer per job.
//
//   - PATCH /concepts/:id is the ONE brand writer: it takes the tender GST
//     split, srbPosId and forecast portions, and refuses the fields that moved
//     (address + pin → Location, delivery radius → delivery zones).
//   - The duplicate writers are gone: PATCH /setup/brand-identity, the
//     /setup/webhooks CRUD; /setup/operations-config no longer writes the
//     unread brand-asset columns.
//   - Location is the kitchen's address + pin (decision 18): creating /
//     editing a location mirrors them onto its brands, and GET
//     /locations/public lists a brand's kitchens with public fields only.
//   - Custom domains: /domains/hosts + /domains/lookup read the Domain table
//     (with the brand slug), and the CORS host cache is built from it.
//   - Delivery zones are the only coverage (decision 19): beyond the last
//     zone computeDeliveryFee refuses; no zone at all → delivery unavailable.
//   - The reservation worker reads the company's ReservationPolicy: reminders
//     off means none, the lead time is the policy's, and the no-show cutoff
//     is startTime + noShowGraceMinutes.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

// Capture outbound messages instead of sending them.
const sentWhatsApp: Array<{ to: string; text: string }> = []
const sentEmail: Array<{ to: string; subject: string }> = []
vi.mock('../src/lib/whatsapp.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/whatsapp.js')>()),
  sendText: async (to: string, text: string) => { sentWhatsApp.push({ to, text }); return {} },
}))
vi.mock('../src/lib/notify.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/notify.js')>()),
  sendEmail: async (to: string, subject: string) => { sentEmail.push({ to, subject }) },
}))

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { locationRoutes } = await import('../src/modules/locations/routes.js')
const { domainRoutes } = await import('../src/modules/domains/routes.js')
const { refreshDomainOrigins, isDomainOriginAllowed } = await import('../src/modules/domains/hostCache.js')
const { computeDeliveryFee, deliveryReachKm, invalidateSetupCache } = await import('../src/lib/setup-config.js')
const { runReminderSweep } = await import('../src/workers/reservationReminders.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')

const PREFIX = `brandrec-${Date.now()}`
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptA2: string, conceptB: string, conceptNoZone: string
let auth: Record<string, string>
const users: string[] = []

async function owner(tenantId: string) {
  const n = users.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} owner ${n}`,
      email: `${PREFIX}.owner.${n}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: 'admin',
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
  tenantA = (await prisma.tenant.create({ data: { name: 'Brand Rec A', slug: `${PREFIX}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Brand Rec B', slug: `${PREFIX}-b` } })).id
  const mk = (slug: string, tenantId: string) =>
    prisma.concept.create({ data: { name: slug, slug, tenantId, type: 'restaurant', storefrontVisible: true } })
  conceptA = (await mk(`${PREFIX}-ca`, tenantA)).id
  conceptA2 = (await mk(`${PREFIX}-ca2`, tenantA)).id
  conceptB = (await mk(`${PREFIX}-cb`, tenantB)).id
  conceptNoZone = conceptB
  auth = await owner(tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.register(locationRoutes, { prefix: '/locations' })
  await app.register(domainRoutes, { prefix: '/domains' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  if (!tenantA || !tenantB) return
  const concepts = [conceptA, conceptA2, conceptB]
  await prisma.reservation.deleteMany({ where: { conceptId: { in: concepts } } })
  await prisma.reservationPolicy.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.operationsConfig.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.deliveryZone.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.domain.deleteMany({ where: { hostname: { startsWith: PREFIX } } })
  await prisma.conceptLocation.deleteMany({ where: { conceptId: { in: concepts } } })
  await prisma.location.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.concept.deleteMany({ where: { id: { in: concepts } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

describe('PATCH /concepts/:id is the one brand writer', () => {
  it('saves the tender GST split, SRB POS id, contact, voice and forecast portions', async () => {
    const r = await app.inject({
      method: 'PATCH', url: `/concepts/${conceptA}`, headers: auth,
      payload: {
        taxRateCash: 16, taxRateCard: 5, srbPosId: 4242, forecastPortionsPerMonth: 9000,
        whatsapp: '923001112223', brandVoice: 'plain, warm', addressLocality: 'DHA Phase 6',
      },
    })
    expect(r.statusCode).toBe(200)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })
    expect(row.taxRateCash).toBe(16)
    expect(row.taxRateCard).toBe(5)
    expect(row.srbPosId).toBe(4242)
    expect(row.forecastPortionsPerMonth).toBe(9000)
    expect(row.whatsapp).toBe('923001112223')
    expect(row.brandVoice).toBe('plain, warm')
  })

  it('saves the brand email trimmed + lowercase, clears it on blank, rejects a bad one', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/concepts/${conceptA}`, headers: auth, payload: { email: '  Brand@GSFoods.PK ' } })
    expect(r.statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })).email).toBe('brand@gsfoods.pk')

    const bad = await app.inject({ method: 'PATCH', url: `/concepts/${conceptA}`, headers: auth, payload: { email: 'not-an-email' } })
    expect(bad.statusCode).toBe(400)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })).email).toBe('brand@gsfoods.pk')

    const clear = await app.inject({ method: 'PATCH', url: `/concepts/${conceptA}`, headers: auth, payload: { email: '' } })
    expect(clear.statusCode).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })).email).toBeNull()
  })

  it.each([
    ['latitude', { latitude: 24.8 }],
    ['address', { address: '1 Main St' }],
    ['deliveryRadiusKm', { deliveryRadiusKm: 7 }],
  ])('refuses %s with FIELD_MOVED instead of silently saving it', async (_k, payload) => {
    const r = await app.inject({ method: 'PATCH', url: `/concepts/${conceptA}`, headers: auth, payload })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('FIELD_MOVED')
  })

  it("cannot edit another company's brand", async () => {
    const r = await app.inject({ method: 'PATCH', url: `/concepts/${conceptB}`, headers: auth, payload: { name: 'x' } })
    expect(r.statusCode).toBe(404)
  })
})

describe('duplicate writers are gone', () => {
  it('PATCH /setup/brand-identity no longer exists', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/setup/brand-identity/${conceptA}`, headers: auth, payload: { heroTagline: 'x' } })
    expect(r.statusCode).toBe(404)
  })

  it('/setup/webhooks no longer exists (the API is /webhooks/endpoints)', async () => {
    const list = await app.inject({ method: 'GET', url: '/setup/webhooks', headers: auth })
    expect(list.statusCode).toBe(404)
    const create = await app.inject({ method: 'POST', url: '/setup/webhooks', headers: auth, payload: { url: 'https://x.example.com', events: ['order.confirmed'] } })
    expect(create.statusCode).toBe(404)
  })

  it('/setup/operations-config no longer writes the unread brand-asset columns', async () => {
    const r = await app.inject({
      method: 'PATCH', url: '/setup/operations-config', headers: auth,
      payload: { brandVoiceNotes: 'loud', socialInstagramHandle: '@x', serviceChargePct: 0.05 },
    })
    expect(r.statusCode).toBe(200)
    const cfg = await prisma.operationsConfig.findFirstOrThrow({ where: { tenantId: tenantA, scope: 'global' } })
    expect(cfg.serviceChargePct).toBe(0.05)
    expect(cfg.brandVoiceNotes).toBeNull()
    expect(cfg.socialInstagramHandle).toBeNull()
  })
})

describe('Location is the kitchen address and pin (decision 18)', () => {
  let locId: string

  it("creating a location mirrors its address and pin onto the brands it runs", async () => {
    const r = await app.inject({
      method: 'POST', url: '/locations', headers: auth,
      payload: { name: `${PREFIX} kitchen`, address: 'Shop 4, Ittehad Commercial', city: 'Karachi', latitude: 24.8015, longitude: 67.0736, conceptIds: [conceptA, conceptA2] },
    })
    expect(r.statusCode).toBe(201)
    locId = r.json().id
    for (const id of [conceptA, conceptA2]) {
      const c = await prisma.concept.findUniqueOrThrow({ where: { id } })
      expect(c.address).toBe('Shop 4, Ittehad Commercial')
      expect(c.latitude).toBeCloseTo(24.8015)
      expect(c.longitude).toBeCloseTo(67.0736)
    }
  })

  it('moving the pin on the location moves it for every brand', async () => {
    const r = await app.inject({ method: 'PATCH', url: `/locations/${locId}`, headers: auth, payload: { latitude: 24.9, longitude: 67.1 } })
    expect(r.statusCode).toBe(200)
    const c = await prisma.concept.findUniqueOrThrow({ where: { id: conceptA2 } })
    expect(c.latitude).toBeCloseTo(24.9)
    expect(c.longitude).toBeCloseTo(67.1)
  })

  it('GET /locations/public lists the brand’s kitchens with public fields only', async () => {
    const slug = (await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })).slug
    const r = await app.inject({ method: 'GET', url: `/locations/public?brand=${slug}` })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]!['address']).toBe('Shop 4, Ittehad Commercial')
    expect(rows[0]!['isPrimary']).toBe(true)
    expect(rows[0]).not.toHaveProperty('tenantId')
    expect(rows[0]).not.toHaveProperty('phone')
  })
})

describe('custom domains: the Domain table is the one list', () => {
  it('/domains/hosts and /domains/lookup return active domains with the brand slug', async () => {
    const slug = (await prisma.concept.findUniqueOrThrow({ where: { id: conceptA } })).slug
    await prisma.domain.create({ data: { hostname: `${PREFIX}.example.pk`, conceptId: conceptA, tenantId: tenantA, purpose: 'brand_microsite', status: 'active', verificationToken: 't1' } })
    await prisma.domain.create({ data: { hostname: `${PREFIX}-pending.example.pk`, conceptId: conceptA, tenantId: tenantA, status: 'pending', verificationToken: 't2' } })

    const hosts = await app.inject({ method: 'GET', url: '/domains/hosts' })
    const mine = (hosts.json().hosts as Array<{ hostname: string; slug: string }>).filter((h) => h.hostname.startsWith(PREFIX))
    expect(mine).toEqual([{ hostname: `${PREFIX}.example.pk`, slug, purpose: 'brand_microsite' }])

    const look = await app.inject({ method: 'GET', url: `/domains/lookup?hostname=${PREFIX}.example.pk` })
    expect(look.json().slug).toBe(slug)
    const pending = await app.inject({ method: 'GET', url: `/domains/lookup?hostname=${PREFIX}-pending.example.pk` })
    expect(pending.body === '' || pending.json() === null).toBe(true)
  })

  it('the CORS host cache allows active domains only', async () => {
    await refreshDomainOrigins()
    expect(isDomainOriginAllowed(`https://${PREFIX}.example.pk`)).toBe(true)
    expect(isDomainOriginAllowed(`https://${PREFIX}-pending.example.pk`)).toBe(false)
    expect(isDomainOriginAllowed('https://eatstrata.com')).toBe(false)
  })
})

describe('delivery zones are the only coverage (decision 19)', () => {
  beforeAll(async () => {
    await prisma.deliveryZone.createMany({
      data: [
        { tenantId: tenantA, conceptId: conceptA, name: 'Inner', radiusKmMin: 0, radiusKmMax: 3, feeCents: 10000 },
        { tenantId: tenantA, conceptId: conceptA, name: 'Outer', radiusKmMin: 3, radiusKmMax: 6, feeCents: 20000, minOrderCents: 150000 },
      ],
    })
    invalidateSetupCache()
  })

  it('prices inside a zone', async () => {
    const q = await computeDeliveryFee(200000, 4.5, conceptA)
    expect(q.zoneName).toBe('Outer')
    expect(q.feeCents).toBe(20000)
    expect(q.meetsMinimum).toBe(true)
  })

  it('refuses beyond the last zone instead of delivering free', async () => {
    await expect(computeDeliveryFee(200000, 9, conceptA)).rejects.toMatchObject({ code: 'OUTSIDE_DELIVERY_AREA', statusCode: 422 })
    expect(await deliveryReachKm(conceptA)).toBe(6)
  })

  it('a brand with no zone at all does not deliver', async () => {
    await expect(computeDeliveryFee(200000, 1, conceptNoZone)).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' })
    expect(await deliveryReachKm(conceptNoZone)).toBeNull()
  })
})

describe('the reservation worker reads the company policy', () => {
  const at = (base: Date, mins: number) => new Date(base.getTime() + mins * 60_000)

  it('reminds at the policy lead time, skips a company with reminders off, and no-shows after the grace', async () => {
    invalidateSetupCache()
    await prisma.reservationPolicy.create({ data: { tenantId: tenantA, scope: 'global', remindersEnabled: true, reminderHoursBefore: 6, noShowGraceMinutes: 20 } })
    await prisma.reservationPolicy.create({ data: { tenantId: tenantB, scope: 'global', remindersEnabled: false, reminderHoursBefore: 6, noShowGraceMinutes: 20 } })
    const now = new Date()
    const made = at(now, -48 * 60)
    const base = { partySize: 2, guestName: 'Guest', guestPhone: '+92 300 1112223', guestEmail: `${PREFIX}@example.com`, createdAt: made }

    // A: 5h out, policy lead 6h → due now.
    const dueA = await prisma.reservation.create({ data: { ...base, conceptId: conceptA, startTime: at(now, 5 * 60), endTime: at(now, 6 * 60 + 30) } })
    // A: 10h out → not due yet (the old worker's 24h window would have sent it).
    const laterA = await prisma.reservation.create({ data: { ...base, conceptId: conceptA, startTime: at(now, 10 * 60), endTime: at(now, 11 * 60 + 30) } })
    // B: 5h out, but company B has reminders off.
    const dueB = await prisma.reservation.create({ data: { ...base, conceptId: conceptB, startTime: at(now, 5 * 60), endTime: at(now, 6 * 60 + 30) } })
    // A: started 25 min ago, never seated → past the 20 min grace.
    const lateA = await prisma.reservation.create({ data: { ...base, guestPhone: null, guestEmail: null, conceptId: conceptA, startTime: at(now, -25), endTime: at(now, 65) } })
    // A: started 10 min ago → still inside the grace (old rule: endTime + 30).
    const graceA = await prisma.reservation.create({ data: { ...base, guestPhone: null, guestEmail: null, conceptId: conceptA, startTime: at(now, -10), endTime: at(now, 80) } })

    const res = await runReminderSweep(now)

    expect(res.reminded).toContain(dueA.id)
    expect(res.reminded).not.toContain(laterA.id)
    expect(res.reminded).not.toContain(dueB.id)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: dueA.id } })).reminder24hSentAt).not.toBeNull()
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: dueB.id } })).reminder24hSentAt).toBeNull()
    // The phone reminder goes over WhatsApp (decision 17), digits only.
    expect(sentWhatsApp.some((m) => m.to === '923001112223' && m.text.includes('in 6 hours'))).toBe(true)

    expect(res.noShows).toContain(lateA.id)
    expect(res.noShows).not.toContain(graceA.id)
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: lateA.id } })).status).toBe('no_show')
    expect((await prisma.reservation.findUniqueOrThrow({ where: { id: graceA.id } })).status).toBe('booked')

    // A second sweep does not re-send.
    const again = await runReminderSweep(now)
    expect(again.reminded).not.toContain(dueA.id)
  })
})
