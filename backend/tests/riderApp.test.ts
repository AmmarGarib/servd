// Rider app v1 — the backend half of docs/rider-app.md.
//
// What this guards:
//   - Sign-in: a WhatsApp code to a phone a manager added in admin → Riders;
//     the request answers the same for any number; the code is checked again
//     at verify; tokens are the rider's own type and rotate on refresh.
//   - A rider token never passes a staff guard (or the socket handshake), and
//     a staff token never passes the rider guard.
//   - A rider only ever reads or acts on orders assigned to them.
//   - The shared fleet: a rider of company A carries an order of company B
//     only while an active FleetAgreement A → B exists, and only an operator
//     who belongs to both companies can start or end one.
//   - The job: accept / decline / picked up (only when ready) / arrived /
//     deliver with the customer's code — timing-safe, five tries, then 423,
//     completing once. The customer gets their code on WhatsApp at pick-up.
//   - The auto-dispatcher: delivery orders only, never re-offers to a rider
//     who declined, times its own offers out after three minutes.
//   - Cancelling frees the rider; location fixes never flip 'offline'; old
//     fixes are pruned.
//   - Staff order payloads no longer carry the hand-over code (admin /
//     management excepted); the customer still sees their own.
//   - The review fixes: every limit and every state change is a claim, so
//     parallel requests cannot get past a limit (code guesses, code requests,
//     hand-over codes, refresh rotation) or undo each other (auto vs manual
//     assign, offer timeout vs accept, ended agreement vs accept).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'

const sent: Array<{ to: string; msg: string }> = []
const sendTiming = { delayMs: 0 }
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    sendText: vi.fn(async (to: string, msg: string) => {
      if (sendTiming.delayMs) await new Promise((r) => setTimeout(r, sendTiming.delayMs))
      sent.push({ to, msg })
    }),
  }
})

// The socket server is not running here: capture what the fan-out was asked
// to send, and work out the rooms with the real (pure) function.
const locations: Array<import('../src/lib/ws.js').RiderLocationInput> = []
vi.mock('../src/lib/ws.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/ws.js')>()
  return { ...real, emitRiderLocation: vi.fn((o: import('../src/lib/ws.js').RiderLocationInput) => { locations.push(o) }) }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { redis } = await import('../src/lib/redis.js')
const { AppError } = await import('../src/lib/errors.js')
const { issueStaffSession, verifyStaffToken, verifyCustomerToken, hashPassword } = await import('../src/modules/auth/service.js')
const PW = 'RiderPass123'
const { issueRiderSession } = await import('../src/modules/riderAuth/service.js')
const { riderAuthRoutes } = await import('../src/modules/riderAuth/routes.js')
const { riderAppRoutes } = await import('../src/modules/rider/routes.js')
const { riderRoutes } = await import('../src/modules/riders/routes.js')
const { dispatchRoutes } = await import('../src/modules/dispatch/routes.js')
const { orderRoutes } = await import('../src/modules/orders/routes.js')
const { trustopsRoutes } = await import('../src/modules/trustops/routes.js')
const { storefrontRoutes } = await import('../src/modules/storefront/routes.js')
const { assignRider, unassignRider, withdrawOffer, markDelivered, AUTO_OFFER_NOTE } = await import('../src/modules/dispatch/service.js')
const { cancelOrder, updateOrderStatus } = await import('../src/modules/orders/service.js')
const { runDispatchSweep, pruneRiderLocations, OFFER_TIMEOUT_MS, DISPATCH_WINDOW_MS } = await import('../src/workers/riderDispatch.js')
const { generateDeliveryOtp, deliveryOtpMatches } = await import('../src/lib/deliveryOtp.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { riderLocationFanout } = await import('../src/lib/ws.js')
const { setCodeOnlyDelivery } = await import('../src/lib/deliveryRules.js')

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let customerId: string
const CUSTOMER_PHONE = '03115550777'
const staff: Record<string, { id: string; token: string }> = {}
const riders: Record<string, { id: string; phone: string; token: string; refresh: string }> = {}
let n = 0

async function mkStaff(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.riderapp@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, isActive: true, accountStatus: 'active', tenantId: primary,
    },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = { id: u.id, token: issueStaffSession(u).accessToken }
}

async function mkRider(key: string, tenantId: string, phone: string, extra: { lat?: number; lng?: number } = {}) {
  const r = await prisma.rider.create({
    data: { tenantId, name: `Rider ${key}`, phone, status: 'available', isActive: true, lastLat: extra.lat ?? null, lastLng: extra.lng ?? null },
  })
  const s = issueRiderSession(r)
  riders[key] = { id: r.id, phone, token: s.accessToken, refresh: s.refreshToken }
  return r
}

async function mkOrder(conceptId: string, opts: Partial<{
  status: 'received' | 'confirmed' | 'preparing' | 'ready' | 'completed'
  fulfilmentType: 'delivery' | 'takeout'
  otp: string | null
  cashCents: number
}> = {}) {
  n += 1
  return prisma.order.create({
    data: {
      conceptId, source: 'servd', status: opts.status ?? 'confirmed',
      fulfilmentType: opts.fulfilmentType ?? 'delivery',
      totalCents: 150_000, customerId, customerName: 'Sana',
      deliveryNotes: 'House 12, Street 4, DHA Phase 6',
      deliveryOtp: opts.otp === undefined ? '4821' : opts.otp,
      rawPayload: { deliveryLat: 24.81, deliveryLng: 67.06 },
      externalId: `riderapp-${n}-${Date.now()}`,
      items: { create: [{ name: 'Club sandwich', quantity: 2, unitPriceCents: 75_000, status: 'bumped' }] },
      ...(opts.cashCents ? { payments: { create: { method: 'cash', status: 'pending', amountCents: opts.cashCents } } } : {}),
    },
  })
}

const rider = (key: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1/rider${url}`, payload: payload as never, headers: { authorization: `Bearer ${riders[key]!.token}` } })

const asStaff = (key: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${staff[key]!.token}` } })

const authPost = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/rider-auth${url}`, payload: payload as never, headers, remoteAddress: '10.7.7.7' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(read: () => T | Promise<T>, done: (v: T) => boolean, ms = 3000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 25))
    v = await read()
  }
  return v
}

const events = (orderId: string) =>
  prisma.riderJobEvent.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })

/**
 * Everyone off shift except the named riders, and no open orders left over
 * from earlier tests (in the dispatch queue or on a rider's hands) — keeps
 * each sweep test to its own riders and orders.
 */
async function onlyAvailable(...keys: string[]) {
  await prisma.order.updateMany({ where: { deliveredAt: null, deletedAt: null }, data: { deletedAt: new Date() } })
  await prisma.rider.updateMany({ data: { status: 'offline' } })
  await prisma.rider.updateMany({ where: { id: { in: keys.map((k) => riders[k]!.id) } }, data: { status: 'available' } })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods Fleet', slug: 'riderapp-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'GSX Viva', slug: 'riderapp-b' } })).id
  conceptA = (await prisma.concept.create({
    data: { name: 'stackd', slug: 'riderapp-stackd', type: 'restaurant', tenantId: tenantA, latitude: 24.80, longitude: 67.05, phone: '+922100000001', address: 'Bukhari Commercial' },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'Viva Grill', slug: 'riderapp-viva', type: 'restaurant', tenantId: tenantB, latitude: 24.85, longitude: 67.00 },
  })).id
  customerId = (await prisma.customer.create({ data: { name: 'Sana', phone: CUSTOMER_PHONE, email: 'sana.riderapp@example.com' } })).id

  await mkStaff('adminAB', 'admin', tenantA, [tenantA, tenantB])
  await mkStaff('mgrA', 'foh_management', tenantA, [tenantA])
  await mkStaff('cashierA', 'cashier', tenantA, [tenantA])
  // A floor role that works dispatch without being a manager (foh holds the
  // 'dispatch' module; cashier does not, so /dispatch and /riders refuse it
  // by module since wave 3 — UI-12).
  await mkStaff('fohA', 'foh', tenantA, [tenantA])
  await mkStaff('mgrB', 'foh_management', tenantB, [tenantB])

  await mkRider('a1', tenantA, '923115550201', { lat: 24.801, lng: 67.051 })
  await mkRider('a2', tenantA, '923115550202', { lat: 24.9, lng: 67.2 })
  await mkRider('b1', tenantB, '923115550203')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(riderAuthRoutes, { prefix: '/rider-auth' })
    await api.register(riderAppRoutes, { prefix: '/rider' })
    await api.register(riderRoutes, { prefix: '/riders' })
    await api.register(dispatchRoutes, { prefix: '/dispatch' })
    await api.register(orderRoutes, { prefix: '/orders' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(storefrontRoutes, { prefix: '/storefront' })
  }, { prefix: '/api/v1' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

beforeEach(async () => {
  sent.length = 0
  locations.length = 0
  sendTiming.delayMs = 0
  const keys = await redis.keys('ratelimit:rider-*')
  if (keys.length) await redis.del(...keys)
  await prisma.phoneOtp.deleteMany({ where: { purpose: 'rider_login' } })
})

/** The code request sends in the background — wait for it (and any stragglers) to land. */
async function codeFor(phone: string): Promise<string> {
  const m = await waitFor(() => sent.filter((x) => x.to === phone).at(-1), (v) => !!v)
  await sleep(100)
  return m!.msg.match(/\d{6}/)![0]
}

// ─── Sign-in ──────────────────────────────────────────────────────────────────

describe('rider sign-in', () => {
  // Riders sign in like staff (owner, 2026-10-28: "Riders same as staff — Gsfoods email + password").
  it('the WhatsApp code sign-in is retired: 410, nothing sent', async () => {
    const req = await authPost('/otp/request', { phone: '03115550201' })
    expect(req.statusCode).toBe(410)
    expect(req.json().error.code).toBe('RIDER_CODE_LOGIN_RETIRED')
    expect((await authPost('/otp/verify', { phone: '03115550201', code: '123456', newPassword: PW })).statusCode).toBe(410)
    await sleep(100)
    expect(sent).toHaveLength(0)
  })

  it('a manager adds a rider with an @gsfoods.pk email and issues a password; the rider signs in with them', async () => {
    const add = await asStaff('mgrA', 'POST', '/riders', { name: 'Email Rider', phone: '03115550271', email: 'Email.Rider@GSFoods.pk' })
    expect(add.statusCode, add.body).toBe(201)
    expect(add.json()).toMatchObject({ email: 'email.rider@gsfoods.pk', hasPassword: false })
    expect(add.json()).not.toHaveProperty('passwordHash')
    const id = add.json().id as string

    // No password yet: the same 401 as a wrong one.
    const none = await authPost('/login', { email: 'email.rider@gsfoods.pk', password: PW })
    expect(none.statusCode).toBe(401)
    expect(none.json().error.code).toBe('INVALID_CREDENTIALS')

    const issued = await asStaff('mgrA', 'POST', `/riders/${id}/new-password`)
    expect(issued.statusCode, issued.body).toBe(200)
    const pw = issued.json().temporaryPassword as string
    expect(pw.length).toBeGreaterThanOrEqual(12)
    const row = await prisma.rider.findUniqueOrThrow({ where: { id } })
    expect(row.passwordHash).toMatch(/^\$2/)
    expect(row.passwordHash).not.toContain(pw)

    const ok = await authPost('/login', { email: 'EMAIL.RIDER@gsfoods.pk', password: pw })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().rider).toMatchObject({ id, email: 'email.rider@gsfoods.pk' })
    expect((jwt.decode(ok.json().accessToken) as { type: string }).type).toBe('rider')
    expect(JSON.stringify(ok.json())).not.toContain('passwordHash')

    const wrong = await authPost('/login', { email: 'email.rider@gsfoods.pk', password: 'Wrong-pass-1' })
    expect(wrong.json()).toEqual(none.json())
    expect((await authPost('/login', { email: 'nobody@gsfoods.pk', password: pw })).json()).toEqual(none.json())

    // The roster never carries the hash.
    const list = await asStaff('mgrA', 'GET', '/riders')
    const mine = (list.json() as Array<Record<string, unknown>>).find((r) => r['id'] === id)!
    expect(mine['hasPassword']).toBe(true)
    expect(mine).not.toHaveProperty('passwordHash')

    // A new password ends the old session and the old password.
    const again = await asStaff('mgrA', 'POST', `/riders/${id}/new-password`)
    expect((await authPost('/login', { email: 'email.rider@gsfoods.pk', password: pw })).statusCode).toBe(401)
    expect((await authPost('/login', { email: 'email.rider@gsfoods.pk', password: again.json().temporaryPassword })).statusCode).toBe(200)
  })

  it('a rider email must be @gsfoods.pk, required on add, never a staff login\'s, and never another company\'s rider to reissue', async () => {
    expect((await asStaff('mgrA', 'POST', '/riders', { name: 'No Email', phone: '03115550272' })).json().error.code).toBe('EMAIL_REQUIRED')
    expect((await asStaff('mgrA', 'POST', '/riders', { name: 'Gmail', phone: '03115550273', email: 'x@gmail.com' })).statusCode).toBe(400)
    const staffEmail = (await prisma.user.findUniqueOrThrow({ where: { id: staff['mgrA']!.id } })).email!
    const clash = await asStaff('mgrA', 'POST', '/riders', { name: 'Clash', phone: '03115550274', email: staffEmail })
    expect(clash.statusCode).toBe(409)
    expect(clash.json().error.code).toBe('EMAIL_TAKEN')
    expect((await asStaff('mgrB', 'POST', `/riders/${riders['a1']!.id}/new-password`)).statusCode).toBe(404)
  })

  it('a deactivated rider cannot sign in, and their live token stops working', async () => {
    const r = await mkRider('gone', tenantA, '923115550209')
    await prisma.rider.update({ where: { id: r.id }, data: { email: 'gone.rider@gsfoods.pk', passwordHash: await hashPassword(PW), isActive: false } })
    expect((await authPost('/login', { email: 'gone.rider@gsfoods.pk', password: PW })).statusCode).toBe(401)
    expect((await rider('gone', 'GET', '/me')).statusCode).toBe(401)
  })

  it('normalises the common ways of writing a Pakistani number', () => {
    for (const p of ['03001234567', '+92 300 1234567', '+92 (0)300 1234567', '0092 300 1234567', '0092 0300 1234567', '3001234567', '923001234567']) {
      expect(normalisePhone(p)).toBe('923001234567')
    }
    expect(normalisePhone('+92 (0)21 34567890')).toBe('922134567890')
  })

  it('two simultaneous refreshes with one token mint ONE session, and reuse ends every session', async () => {
    await mkRider('race', tenantA, '923115550207')
    const [x, y] = await Promise.all([
      authPost('/refresh', { refreshToken: riders['race']!.refresh }),
      authPost('/refresh', { refreshToken: riders['race']!.refresh }),
    ])
    expect([x.statusCode, y.statusCode].sort()).toEqual([200, 401])
    expect(await redis.get(`tva:${riders['race']!.id}`)).toBeTruthy()

    // Sequentially, with time moving on: the rotated token presented again
    // kills the session that rotation minted too.
    await mkRider('reuse', tenantA, '923115550206')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    try {
      const first = await authPost('/refresh', { refreshToken: riders['reuse']!.refresh })
      expect(first.statusCode).toBe(200)
      const pair = first.json() as { accessToken: string; refreshToken: string }
      vi.setSystemTime(Date.now() + 5_000)
      expect((await authPost('/refresh', { refreshToken: riders['reuse']!.refresh })).statusCode).toBe(401)
      expect((await authPost('/refresh', { refreshToken: pair.refreshToken })).statusCode).toBe(401)
      expect((await app.inject({ method: 'GET', url: '/api/v1/rider/me', headers: { authorization: `Bearer ${pair.accessToken}` } })).statusCode).toBe(401)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logout revokes the refresh token even when the access token has expired', async () => {
    const r = await mkRider('idle', tenantA, '923115550205')
    const expired = jwt.sign({ sub: r.id, type: 'rider', jti: 'x' }, process.env['JWT_SECRET']!, { expiresIn: -10 })
    const out = await authPost('/logout', { refreshToken: riders['idle']!.refresh }, { authorization: `Bearer ${expired}` })
    expect(out.statusCode).toBe(204)
    expect((await authPost('/refresh', { refreshToken: riders['idle']!.refresh })).statusCode).toBe(401)
  })

  it('replaying a refused token from one IP is cut off (429); other IPs are not', async () => {
    const r = await mkRider('fired', tenantA, '923115550204')
    await prisma.rider.update({ where: { id: r.id }, data: { isActive: false } })
    const hit = (token: string, ip: string) =>
      app.inject({ method: 'GET', url: '/api/v1/rider/me', headers: { authorization: `Bearer ${token}` }, remoteAddress: ip })
    const codes: number[] = []
    for (let i = 0; i < 125; i++) codes.push((await hit(riders['fired']!.token, '10.9.9.9')).statusCode)
    expect(codes.slice(0, 120).every((c) => c === 401)).toBe(true)
    expect(codes.slice(120).every((c) => c === 429)).toBe(true)
    expect((await hit(riders['a1']!.token, '10.9.9.10')).statusCode).toBe(200)
  })

  it('refresh rotates the pair and revokes the old refresh token; logout ends the session', async () => {
    const r = await mkRider('rot', tenantA, '923115550208')
    const first = await authPost('/refresh', { refreshToken: riders['rot']!.refresh })
    expect(first.statusCode).toBe(200)
    const pair = first.json() as { accessToken: string; refreshToken: string }
    expect(pair.refreshToken).not.toBe(riders['rot']!.refresh)
    // The old one is spent.
    expect((await authPost('/refresh', { refreshToken: riders['rot']!.refresh })).statusCode).toBe(401)
    // An access token is not a refresh token.
    expect((await authPost('/refresh', { refreshToken: pair.accessToken })).statusCode).toBe(401)

    const out = await authPost('/logout', { refreshToken: pair.refreshToken }, { authorization: `Bearer ${pair.accessToken}` })
    expect(out.statusCode).toBe(204)
    expect((await app.inject({ method: 'GET', url: '/api/v1/rider/me', headers: { authorization: `Bearer ${pair.accessToken}` } })).statusCode).toBe(401)
    expect((await authPost('/refresh', { refreshToken: pair.refreshToken })).statusCode).toBe(401)
    expect(r.id).toBeTruthy()
  })
})

// ─── Token separation ─────────────────────────────────────────────────────────

describe('rider and staff tokens never cross', () => {
  it('a rider token is refused on a staff route, and by the staff/socket and customer verifiers', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { authorization: `Bearer ${riders['a1']!.token}` } })
    expect(res.statusCode).toBe(401)
    const board = await app.inject({ method: 'GET', url: '/api/v1/dispatch/board', headers: { authorization: `Bearer ${riders['a1']!.token}` } })
    expect(board.statusCode).toBe(401)
    // lib/ws.ts authenticates sockets with verifyStaffToken(token, 'access').
    expect(() => verifyStaffToken(riders['a1']!.token, 'access')).toThrow()
    expect(() => verifyCustomerToken(riders['a1']!.token)).toThrow()
  })

  it('a staff token (and a customer token) is refused on /rider', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/rider/me', headers: { authorization: `Bearer ${staff['adminAB']!.token}` } })).statusCode).toBe(401)
    const customer = jwt.sign({ sub: customerId, type: 'customer' }, process.env['JWT_SECRET']!, { expiresIn: '1h' })
    expect((await app.inject({ method: 'GET', url: '/api/v1/rider/jobs', headers: { authorization: `Bearer ${customer}` } })).statusCode).toBe(401)
    expect((await app.inject({ method: 'GET', url: '/api/v1/rider/jobs' })).statusCode).toBe(401)
  })
})

// ─── Only my jobs ─────────────────────────────────────────────────────────────

describe('a rider sees only their own orders', () => {
  it('lists, reads and acts on own jobs only', async () => {
    await prisma.rider.updateMany({ where: { id: { in: [riders['a1']!.id, riders['a2']!.id] } }, data: { status: 'available' } })
    const mine = await mkOrder(conceptA, { cashCents: 150_000 })
    const theirs = await mkOrder(conceptA)
    await assignRider(mine.id, riders['a1']!.id)
    await assignRider(theirs.id, riders['a2']!.id)

    const list = await rider('a1', 'GET', '/jobs')
    expect(list.statusCode).toBe(200)
    const ids = (list.json().jobs as Array<{ orderId: string }>).map((j) => j.orderId)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)

    const job = (await rider('a1', 'GET', `/jobs/${mine.id}`)).json().job
    expect(job).toMatchObject({
      orderId: mine.id,
      orderNumber: mine.id.slice(-8).toUpperCase(),
      stage: 'offered',
      brand: { name: 'Stackd', slug: 'riderapp-stackd' },
      company: { id: tenantA, name: 'GS Foods Fleet' },
      pickup: { name: 'Stackd', address: 'Bukhari Commercial', lat: 24.8, lng: 67.05 },
      dropoff: { name: 'Sana', phone: CUSTOMER_PHONE, address: 'House 12, Street 4, DHA Phase 6', lat: 24.81, lng: 67.06 },
      itemCount: 2,
      items: [{ name: 'Club sandwich', qty: 2 }],
      cashToCollectCents: 150_000,
      otpAttemptsLeft: 5,
    })
    // The hand-over code is the customer's — never in the rider's job.
    expect(JSON.stringify(job)).not.toContain('4821')

    expect((await rider('a1', 'GET', `/jobs/${theirs.id}`)).statusCode).toBe(404)
    expect((await rider('a1', 'POST', `/jobs/${theirs.id}/accept`, {})).statusCode).toBe(404)
    expect((await rider('a1', 'POST', `/jobs/${theirs.id}/decline`, {})).statusCode).toBe(404)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: theirs.id } })).riderId).toBe(riders['a2']!.id)
  })
})

// ─── Shared fleet ─────────────────────────────────────────────────────────────

describe('fleet agreements', () => {
  it("company B's order is not assignable to A's rider without an agreement (422), and is with one", async () => {
    await prisma.rider.update({ where: { id: riders['a1']!.id }, data: { status: 'available' } })
    const bOrder = await mkOrder(conceptB)
    await expect(assignRider(bOrder.id, riders['a1']!.id)).rejects.toMatchObject({ code: 'RIDER_NOT_IN_COMPANY', statusCode: 422 })
    // Through the route too, by an operator of both companies.
    const refused = await asStaff('adminAB', 'POST', `/dispatch/orders/${bOrder.id}/assign`, { riderId: riders['a1']!.id })
    expect(refused.statusCode).toBe(422)

    const put = await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: true })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toMatchObject({ providerTenantId: tenantA, providerName: 'GS Foods Fleet', clientTenantId: tenantB, clientName: 'GSX Viva', isActive: true })

    const ok = await asStaff('adminAB', 'POST', `/dispatch/orders/${bOrder.id}/assign`, { riderId: riders['a1']!.id })
    expect(ok.statusCode).toBe(200)
    const ev = await events(bOrder.id)
    expect(ev.at(-1)).toMatchObject({ type: 'offered', riderId: riders['a1']!.id, tenantId: tenantB, riderTenantId: tenantA })

    // The rider sees it, labelled with the CLIENT company.
    const job = (await rider('a1', 'GET', `/jobs/${bOrder.id}`)).json().job
    expect(job.company).toEqual({ id: tenantB, name: 'GSX Viva' })

    // B's dispatch board shows A's rider while (and only while) they carry
    // B's order — with only B's orders on them — and none of A's idle riders.
    const board = (await asStaff('mgrB', 'GET', '/dispatch/board')).json() as Array<{ id: string; fleetPartner: boolean; orders: Array<{ id: string }> }>
    const a1 = board.find((r) => r.id === riders['a1']!.id)
    expect(a1?.fleetPartner).toBe(true)
    expect(a1?.orders.map((o) => o.id)).toEqual([bOrder.id])
    expect(board.find((r) => r.id === riders['a2']!.id)).toBeUndefined()
    // …and B's manager cannot move A's rider about.
    expect((await asStaff('mgrB', 'POST', `/dispatch/riders/${riders['a1']!.id}/status`, { status: 'offline' })).statusCode).toBe(404)

    // The agreement does not run the other way: B's rider still cannot take A's order.
    const aOrder = await mkOrder(conceptA)
    await expect(assignRider(aOrder.id, riders['b1']!.id)).rejects.toMatchObject({ code: 'RIDER_NOT_IN_COMPANY' })

    // Ending it stops new assignments.
    const end = await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: false })
    expect(end.json().isActive).toBe(false)
    const bOrder2 = await mkOrder(conceptB)
    await expect(assignRider(bOrder2.id, riders['a2']!.id)).rejects.toMatchObject({ code: 'RIDER_NOT_IN_COMPANY' })
    await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: true })
  })

  it('only an operator who belongs to BOTH companies may start or end one', async () => {
    const res = await asStaff('mgrA', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: false })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    const same = await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantA, isActive: true })
    expect(same.statusCode).toBe(422)
    // A cashier is not a manager at all.
    expect((await asStaff('cashierA', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: true })).statusCode).toBe(403)
    // Unchanged.
    const row = await prisma.fleetAgreement.findFirstOrThrow({ where: { providerTenantId: tenantA, clientTenantId: tenantB } })
    expect(row.isActive).toBe(true)

    // A's manager can see the agreement that touches A, and only A as a choice.
    const list = await asStaff('mgrA', 'GET', '/riders/fleet/agreements')
    expect(list.statusCode).toBe(200)
    expect(list.json().companies).toEqual([{ id: tenantA, name: 'GS Foods Fleet' }])
    expect(list.json().agreements).toHaveLength(1)
  })
})

// ─── The job ──────────────────────────────────────────────────────────────────

describe('accept → picked up → arrived → deliver', () => {
  it('runs the whole job, texts the customer their code, and completes once', async () => {
    await prisma.rider.update({ where: { id: riders['a1']!.id }, data: { status: 'available', totalDeliveries: 0 } })
    const o = await mkOrder(conceptA, { status: 'preparing', otp: '4821' })
    await assignRider(o.id, riders['a1']!.id)

    // Picking up before accepting is refused.
    const early = await rider('a1', 'POST', `/jobs/${o.id}/picked-up`, {})
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('NOT_ACCEPTED')

    const acc = await rider('a1', 'POST', `/jobs/${o.id}/accept`, { lat: 24.8, lng: 67.05 })
    expect(acc.statusCode).toBe(200)
    expect(acc.json().job.stage).toBe('accepted')
    expect(acc.json().job.acceptedAt).toBeTruthy()

    // The kitchen has not finished it.
    const notReady = await rider('a1', 'POST', `/jobs/${o.id}/picked-up`, {})
    expect(notReady.statusCode).toBe(409)
    expect(notReady.json().error.code).toBe('NOT_READY')
    // Arriving before picking up is refused too.
    expect((await rider('a1', 'POST', `/jobs/${o.id}/arrived`, {})).statusCode).toBe(409)

    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    const pick = await rider('a1', 'POST', `/jobs/${o.id}/picked-up`, { lat: 24.8, lng: 67.05 })
    expect(pick.statusCode).toBe(200)
    expect(pick.json().job.stage).toBe('picked_up')
    // The customer gets their code on WhatsApp, at the number on file.
    const msg = await waitFor(() => sent.find((m) => m.msg.includes('4821')), (m) => !!m)
    expect(msg?.to).toBe('923115550777')
    expect(msg?.msg).toContain('Stackd')

    const arr = await rider('a1', 'POST', `/jobs/${o.id}/arrived`, { lat: 24.81, lng: 67.06 })
    expect(arr.json().job.stage).toBe('arrived')

    const wrong = await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })
    expect(wrong.statusCode).toBe(403)
    expect(wrong.json().error.code).toBe('OTP_MISMATCH')
    expect(wrong.json().error.attemptsLeft).toBe(4)

    const right = await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '4821', lat: 24.81, lng: 67.06 })
    expect(right.statusCode).toBe(200)
    expect(right.json()).toMatchObject({ orderId: o.id, status: 'completed', alreadyDelivered: false })

    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('completed')
    expect(after.deliveredAt).toBeInstanceOf(Date)
    expect(after.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
    expect(after.deliveryOtpAttempts).toBe(1)   // the one wrong code; the right one is not a failure
    const r = await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })
    expect(r.totalDeliveries).toBe(1)

    // Once only.
    const again = await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '4821' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_DELIVERED')
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).totalDeliveries).toBe(1)
    // Off the job list.
    expect(((await rider('a1', 'GET', '/jobs')).json().jobs as Array<{ orderId: string }>).map((j) => j.orderId)).not.toContain(o.id)

    const types = (await events(o.id)).map((e) => e.type)
    expect(types).toEqual(['offered', 'accepted', 'picked_up', 'arrived', 'otp_failed', 'delivered'])
    expect((await events(o.id)).every((e) => e.tenantId === tenantA && e.riderTenantId === tenantA)).toBe(true)
  })

  it('locks the hand-over after five wrong codes (423), even for the right one', async () => {
    await prisma.rider.update({ where: { id: riders['a2']!.id }, data: { status: 'available' } })
    const o = await mkOrder(conceptA, { status: 'ready', otp: '7314' })
    await assignRider(o.id, riders['a2']!.id)
    await rider('a2', 'POST', `/jobs/${o.id}/accept`, {})
    await rider('a2', 'POST', `/jobs/${o.id}/picked-up`, {})

    const left: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await rider('a2', 'POST', `/jobs/${o.id}/deliver`, { otp: '9999' })
      expect(res.statusCode).toBe(403)
      left.push(res.json().error.attemptsLeft)
    }
    expect(left).toEqual([4, 3, 2, 1, 0])
    const locked = await rider('a2', 'POST', `/jobs/${o.id}/deliver`, { otp: '7314' })
    expect(locked.statusCode).toBe(423)
    expect(locked.json().error.code).toBe('OTP_LOCKED')
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.deliveredAt).toBeNull()
    expect(after.status).toBe('ready')
    expect(after.deliveryOtpAttempts).toBe(5)
    // The company's inbox hears about it.
    expect(await prisma.exceptionFlag.count({ where: { kind: 'lost_package', entityId: o.id, tenantId: tenantA } })).toBeGreaterThan(0)
  })

  it('a decline hands the order back, and the auto-dispatcher never re-offers it to that rider', async () => {
    await onlyAvailable('a1', 'a2')
    const o = await mkOrder(conceptA, { status: 'confirmed' })

    await runDispatchSweep()
    const first = (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId
    expect(first).toBe(riders['a1']!.id)   // a1 is nearest the kitchen

    const dec = await rider('a1', 'POST', `/jobs/${o.id}/decline`, { reason: 'puncture' })
    expect(dec.statusCode).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBeNull()
    expect((await events(o.id)).at(-1)).toMatchObject({ type: 'declined', riderId: riders['a1']!.id, note: 'puncture' })

    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(riders['a2']!.id)
    await rider('a2', 'POST', `/jobs/${o.id}/decline`, {})

    // Both declined: nobody gets it, even though both are free.
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBeNull()
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).status).toBe('available')
  })

  it('auto-dispatch takes delivery orders only, and times out its own offers after 3 minutes', async () => {
    await onlyAvailable('a1', 'a2')
    const pickup = await mkOrder(conceptA, { status: 'confirmed', fulfilmentType: 'takeout' })
    const o = await mkOrder(conceptA, { status: 'confirmed' })
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pickup.id } })).riderId).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(riders['a1']!.id)

    // Not yet three minutes: stays.
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(riders['a1']!.id)

    await prisma.order.update({ where: { id: o.id }, data: { riderAssignedAt: new Date(Date.now() - OFFER_TIMEOUT_MS - 1000) } })
    await runDispatchSweep()
    const ev = await events(o.id)
    expect(ev.map((e) => e.type)).toContain('timed_out')
    expect(ev.find((e) => e.type === 'timed_out')!.riderId).toBe(riders['a1']!.id)
    // …and straight on to the next rider.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBe(riders['a2']!.id)

    // A dispatcher's own (manual) offer is not timed out.
    await onlyAvailable('a1')
    const manual = await mkOrder(conceptA, { status: 'confirmed' })
    await assignRider(manual.id, riders['a1']!.id)
    await prisma.order.update({ where: { id: manual.id }, data: { riderAssignedAt: new Date(Date.now() - 10 * 60_000) } })
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: manual.id } })).riderId).toBe(riders['a1']!.id)
  })

  it('cancelling an order frees its rider and takes it off their list', async () => {
    await onlyAvailable('a1')
    const o = await mkOrder(conceptA, { status: 'preparing' })
    await assignRider(o.id, riders['a1']!.id)
    await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})
    // Nothing else on a1's hands for this check.
    await prisma.order.updateMany({ where: { riderId: riders['a1']!.id, id: { not: o.id }, deliveredAt: null }, data: { riderId: null } })
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).status).toBe('busy')

    await cancelOrder(o.id, { reason: 'Customer called to cancel', actor: { id: staff['mgrA']!.id, tenantId: tenantA } })
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).status).toBe('available')
    expect((await events(o.id)).at(-1)).toMatchObject({ type: 'unassigned', riderId: riders['a1']!.id })
    const jobs = (await rider('a1', 'GET', '/jobs')).json().jobs as Array<{ orderId: string }>
    expect(jobs.map((j) => j.orderId)).not.toContain(o.id)
    expect((await rider('a1', 'GET', `/jobs/${o.id}`)).statusCode).toBe(404)
  })
})

// ─── Shift and location ───────────────────────────────────────────────────────

describe('shift and location', () => {
  it('going on shift is the rider\'s action; off shift is refused while carrying an accepted job', async () => {
    await prisma.order.updateMany({ where: { riderId: riders['a2']!.id, deliveredAt: null }, data: { riderId: null } })
    await prisma.rider.update({ where: { id: riders['a2']!.id }, data: { status: 'offline', lastLat: null, lastLng: null, lastReportedAt: null } })
    const fixesBefore = await prisma.riderLocation.count({ where: { riderId: riders['a2']!.id } })

    // Off shift, the app's own fix is refused (409 OFF_SHIFT — both clients
    // stop sharing on it), nothing is stored, and the rider stays off shift.
    const fix = await rider('a2', 'POST', '/location', { lat: 24.82, lng: 67.03, heading: 90 })
    expect(fix.statusCode).toBe(409)
    expect(fix.json().error.code).toBe('OFF_SHIFT')
    const afterFix = await prisma.rider.findUniqueOrThrow({ where: { id: riders['a2']!.id } })
    expect(afterFix.status).toBe('offline')
    expect(afterFix.lastLat).toBeNull()
    expect(afterFix.lastReportedAt).toBeNull()
    expect(await prisma.riderLocation.count({ where: { riderId: riders['a2']!.id } })).toBe(fixesBefore)
    expect(locations).toHaveLength(0)
    // The staff relay still records a fix, and does not put them on shift either.
    const relay = await asStaff('mgrA', 'POST', `/dispatch/riders/${riders['a2']!.id}/location`, { lat: 24.83, lng: 67.02 })
    expect(relay.statusCode).toBe(200)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a2']!.id } })).status).toBe('offline')

    const on = await rider('a2', 'POST', '/shift', { online: true })
    expect(on.statusCode).toBe(200)
    expect(on.json().rider.status).toBe('available')

    const o = await mkOrder(conceptA, { status: 'ready' })
    await assignRider(o.id, riders['a2']!.id)
    await rider('a2', 'POST', `/jobs/${o.id}/accept`, {})
    const off = await rider('a2', 'POST', '/shift', { online: false })
    expect(off.statusCode).toBe(409)
    expect(off.json().error.code).toBe('ACTIVE_JOBS')

    // A fix may be pinned to my job, never to someone else's order.
    expect((await rider('a2', 'POST', '/location', { lat: 24.82, lng: 67.03, orderId: o.id })).statusCode).toBe(200)
    const other = await mkOrder(conceptA)
    expect((await rider('a2', 'POST', '/location', { lat: 24.82, lng: 67.03, orderId: other.id })).statusCode).toBe(422)
    expect((await rider('a2', 'POST', '/location', { lat: 124, lng: 67 })).statusCode).toBe(400)
  })

  it('going off shift hands back offers not yet accepted', async () => {
    await onlyAvailable('a1')
    await prisma.order.updateMany({ where: { riderId: riders['a1']!.id, deliveredAt: null }, data: { riderId: null } })
    const o = await mkOrder(conceptA, { status: 'confirmed' })
    await assignRider(o.id, riders['a1']!.id)
    const off = await rider('a1', 'POST', '/shift', { online: false })
    expect(off.statusCode).toBe(200)
    expect(off.json().rider.status).toBe('offline')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).riderId).toBeNull()
  })

  it('prunes location fixes older than 24 hours', async () => {
    const old = await prisma.riderLocation.create({ data: { riderId: riders['a1']!.id, lat: 1, lng: 1, recordedAt: new Date(Date.now() - 25 * 3600_000) } })
    const recent = await prisma.riderLocation.create({ data: { riderId: riders['a1']!.id, lat: 2, lng: 2 } })
    expect(await pruneRiderLocations()).toBeGreaterThanOrEqual(1)
    expect(await prisma.riderLocation.findUnique({ where: { id: old.id } })).toBeNull()
    expect(await prisma.riderLocation.findUnique({ where: { id: recent.id } })).not.toBeNull()
  })
})

// ─── The hand-over code in staff and customer payloads ───────────────────────

describe('who can read the hand-over code', () => {
  it('a cashier no longer sees it in GET /orders or GET /orders/:id; admin does', async () => {
    const o = await mkOrder(conceptA, { status: 'ready', otp: '5150' })
    const list = await asStaff('cashierA', 'GET', '/orders?limit=200')
    expect(list.statusCode).toBe(200)
    const rows = list.json().data as Array<{ id: string; deliveryOtp: string | null }>
    expect(rows.find((r) => r.id === o.id)).toBeTruthy()
    expect(rows.every((r) => r.deliveryOtp === null)).toBe(true)
    expect(list.body).not.toContain('5150')

    const one = await asStaff('cashierA', 'GET', `/orders/${o.id}`)
    expect(one.json().deliveryOtp).toBeNull()
    expect((await asStaff('adminAB', 'GET', `/orders/${o.id}`)).json().deliveryOtp).toBe('5150')

    // The support read is admin / management only now.
    expect((await asStaff('cashierA', 'GET', `/trustops/orders/${o.id}/otp`)).statusCode).toBe(403)
    expect((await asStaff('adminAB', 'GET', `/trustops/orders/${o.id}/otp`)).json().otp).toBe('5150')
  })

  it("the customer's own order page shows it — on a delivery order only", async () => {
    const token = jwt.sign({ sub: customerId, type: 'customer' }, process.env['JWT_SECRET']!, { expiresIn: '1h' })
    const del = await mkOrder(conceptA, { status: 'ready', otp: '6262' })
    const pick = await mkOrder(conceptA, { status: 'ready', otp: '7373', fulfilmentType: 'takeout' })
    const a = await app.inject({ method: 'GET', url: `/api/v1/storefront/orders/${del.id}`, headers: { authorization: `Bearer ${token}` } })
    expect(a.statusCode).toBe(200)
    expect(a.json().deliveryOtp).toBe('6262')
    const b = await app.inject({ method: 'GET', url: `/api/v1/storefront/orders/${pick.id}`, headers: { authorization: `Bearer ${token}` } })
    expect(b.json().deliveryOtp).toBeNull()
  })

  it('codes are 4 digits from a CSPRNG and compared exactly', () => {
    for (let i = 0; i < 50; i++) expect(generateDeliveryOtp()).toMatch(/^\d{4}$/)
    expect(deliveryOtpMatches('0427', '0427')).toBe(true)
    expect(deliveryOtpMatches('0427', ' 0427 ')).toBe(true)
    expect(deliveryOtpMatches('0427', '427')).toBe(false)
    expect(deliveryOtpMatches(null, '0427')).toBe(false)
  })
})

// ─── Roster ───────────────────────────────────────────────────────────────────

describe('rider roster', () => {
  it('stores a new rider\'s phone normalised, and refuses a number another rider has', async () => {
    const res = await asStaff('mgrA', 'POST', '/riders', { name: 'New Rider', phone: '0311-555 0299', email: 'new.rider@gsfoods.pk' })
    expect(res.statusCode).toBe(201)
    expect(res.json().phone).toBe('923115550299')
    expect(res.json().tenantId).toBe(tenantA)
    const dup = await asStaff('mgrA', 'POST', '/riders', { name: 'Same Number', phone: '+92 311 5550299', email: 'same.number@gsfoods.pk' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('PHONE_TAKEN')
    const dupEmail = await asStaff('mgrA', 'POST', '/riders', { name: 'Same Email', phone: '03115550298', email: 'NEW.rider@gsfoods.pk' })
    expect(dupEmail.statusCode).toBe(409)
    expect(dupEmail.json().error.code).toBe('EMAIL_TAKEN')
  })
})

// ─── Review fixes: the shared fleet end to end ───────────────────────────────

async function ensureAgreement(isActive: boolean) {
  await prisma.fleetAgreement.upsert({
    where: { providerTenantId_clientTenantId: { providerTenantId: tenantA, clientTenantId: tenantB } },
    create: { providerTenantId: tenantA, clientTenantId: tenantB, isActive, createdById: staff['adminAB']!.id },
    update: { isActive },
  })
}

const riderOf = async (orderId: string) => (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).riderId
const statusOf = async (key: string) => (await prisma.rider.findUniqueOrThrow({ where: { id: riders[key]!.id } })).status

describe('the shared fleet, end to end', () => {
  it("B-only staff cannot hand B's order to A's rider (404) — only an operator of both companies can", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')
    const o = await mkOrder(conceptB)
    const res = await asStaff('mgrB', 'POST', `/dispatch/orders/${o.id}/assign`, { riderId: riders['a1']!.id })
    expect(res.statusCode).toBe(404)
    expect(await riderOf(o.id)).toBeNull()
  })

  it("the auto-dispatcher offers B's order to A's rider under the agreement — never A's to B's, and not once it ends", async () => {
    await ensureAgreement(true)
    // A's order with only B's rider free: the agreement runs A → B only.
    await onlyAvailable('b1')
    const aOrder = await mkOrder(conceptA)
    await runDispatchSweep()
    expect(await riderOf(aOrder.id)).toBeNull()

    // B's order with only A's rider free: offered, stamped client B / provider A.
    await onlyAvailable('a1')
    const bOrder = await mkOrder(conceptB)
    await runDispatchSweep()
    expect(await riderOf(bOrder.id)).toBe(riders['a1']!.id)
    expect((await events(bOrder.id)).at(-1)).toMatchObject({
      type: 'offered', note: AUTO_OFFER_NOTE, riderId: riders['a1']!.id, tenantId: tenantB, riderTenantId: tenantA,
    })

    // Ended: A's fleet gets no more of B's orders.
    await ensureAgreement(false)
    await onlyAvailable('a2')
    const bOrder2 = await mkOrder(conceptB)
    await runDispatchSweep()
    expect(await riderOf(bOrder2.id)).toBeNull()
    await ensureAgreement(true)
  })

  it("A's rider runs B's job end to end, every event stamped client B / provider A; an accepted job outlives the agreement", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')
    const o = await mkOrder(conceptB, { status: 'ready', otp: '2468' })
    await assignRider(o.id, riders['a1']!.id)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})).statusCode).toBe(200)

    // The agreement ends mid-route: an accepted job is under way and is finished.
    const end = await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: false })
    expect(end.statusCode).toBe(200)
    expect(await riderOf(o.id)).toBe(riders['a1']!.id)
    // The two companies whose data is shared both have it in their audit log.
    for (const t of [tenantA, tenantB]) {
      expect(await prisma.auditLog.count({ where: { entityId: end.json().id, action: 'fleet_agreement.end', tenantId: t } })).toBeGreaterThan(0)
    }

    expect((await rider('a1', 'POST', `/jobs/${o.id}/picked-up`, {})).statusCode).toBe(200)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/arrived`, {})).statusCode).toBe(200)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '2468' })).statusCode).toBe(200)

    const ev = await events(o.id)
    expect(ev.map((e) => e.type)).toEqual(['offered', 'accepted', 'picked_up', 'arrived', 'delivered'])
    expect(ev.every((e) => e.tenantId === tenantB && e.riderTenantId === tenantA)).toBe(true)
    expect(await statusOf('a1')).toBe('available')
    await ensureAgreement(true)
  })

  it("B's staff can unassign, mark delivered and cancel B's orders carried by A's rider — and A's rider is freed each time", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')

    const o1 = await mkOrder(conceptB, { status: 'ready' })
    await assignRider(o1.id, riders['a1']!.id)
    expect((await asStaff('mgrB', 'POST', `/dispatch/orders/${o1.id}/unassign`)).statusCode).toBe(200)
    expect(await riderOf(o1.id)).toBeNull()
    expect(await statusOf('a1')).toBe('available')
    expect((await events(o1.id)).at(-1)).toMatchObject({ type: 'unassigned', tenantId: tenantB, riderTenantId: tenantA })

    const before = (await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).totalDeliveries
    const o2 = await mkOrder(conceptB, { status: 'ready' })
    await assignRider(o2.id, riders['a1']!.id)
    const del = await asStaff('mgrB', 'POST', `/dispatch/orders/${o2.id}/delivered`)
    expect(del.statusCode).toBe(200)
    expect(del.json().order.deliveryOtp).toBeNull()   // a manager, not admin / management
    const a1 = await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })
    expect(a1.status).toBe('available')
    expect(a1.totalDeliveries).toBe(before + 1)
    expect((await events(o2.id)).at(-1)).toMatchObject({ type: 'delivered', tenantId: tenantB, riderTenantId: tenantA })

    const o3 = await mkOrder(conceptB, { status: 'preparing' })
    await assignRider(o3.id, riders['a1']!.id)
    expect(await statusOf('a1')).toBe('busy')
    await cancelOrder(o3.id, { reason: 'Customer cancelled', actor: { id: staff['mgrB']!.id, tenantId: tenantB } })
    expect(await statusOf('a1')).toBe('available')
  })

  it("rider:location reaches B's order room with only B's order id — including an expo-completed last leg", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')
    const aJob = await mkOrder(conceptA, { status: 'preparing' })
    const bJob = await mkOrder(conceptB, { status: 'ready' })
    await assignRider(aJob.id, riders['a1']!.id)
    await assignRider(bJob.id, riders['a1']!.id)
    // Expo completes B's order as the bag goes out: still on a1's hands.
    await prisma.order.update({ where: { id: bJob.id }, data: { status: 'completed' } })
    expect(((await rider('a1', 'GET', '/jobs')).json().jobs as Array<{ orderId: string }>).map((j) => j.orderId)).toContain(bJob.id)

    locations.length = 0
    expect((await rider('a1', 'POST', '/location', { lat: 24.82, lng: 67.03 })).statusCode).toBe(200)
    const input = await waitFor(() => locations.at(-1), (v) => !!v)
    const fan = riderLocationFanout(input!)
    const bCopy = fan.find((f) => f.rooms.includes(`tenant:${tenantB}:orders`))!
    expect(bCopy.rooms).toEqual([`tenant:${tenantB}:orders`])
    expect(bCopy.payload.orderId).toBe(bJob.id)
    const aCopy = fan.find((f) => f.rooms.includes(`tenant:${tenantA}`))!
    expect([...aCopy.rooms].sort()).toEqual([`tenant:${tenantA}`, `tenant:${tenantA}:orders`].sort())
    expect(aCopy.payload.orderId).toBe(aJob.id)
    expect(fan).toHaveLength(2)
  })
})

// ─── Review fixes: races and edges ───────────────────────────────────────────

describe('claims, not read-then-write', () => {
  it('the auto-dispatcher never overwrites a manual assignment, and never stacks an offer on a busy rider', async () => {
    await onlyAvailable('a1', 'a2')
    const o = await mkOrder(conceptA)
    // The dispatcher assigns by hand after the sweep read the order…
    await assignRider(o.id, riders['a2']!.id)
    // …so the sweep's offer, made on that stale read, is refused.
    await expect(assignRider(o.id, riders['a1']!.id, { note: AUTO_OFFER_NOTE, expectRiderId: null, requireAvailable: true }))
      .rejects.toMatchObject({ code: 'ORDER_CHANGED', statusCode: 409 })
    expect(await riderOf(o.id)).toBe(riders['a2']!.id)
    expect((await events(o.id)).map((e) => e.type)).toEqual(['offered'])

    const o2 = await mkOrder(conceptA)
    await expect(assignRider(o2.id, riders['a2']!.id, { note: AUTO_OFFER_NOTE, expectRiderId: null, requireAvailable: true }))
      .rejects.toMatchObject({ code: 'RIDER_NOT_AVAILABLE' })
    expect(await riderOf(o2.id)).toBeNull()
  })

  it('an offer timing out never takes back a job the rider has accepted', async () => {
    await onlyAvailable('a1')
    const o = await mkOrder(conceptA)
    await assignRider(o.id, riders['a1']!.id, { note: AUTO_OFFER_NOTE })
    expect((await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})).statusCode).toBe(200)
    // The timer read the order before the accept landed:
    expect(await withdrawOffer(o.id, riders['a1']!.id, { event: 'timed_out', note: 'offer not accepted within 3 minutes' })).toBe(false)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.riderId).toBe(riders['a1']!.id)
    expect(after.riderAcceptedAt).toBeInstanceOf(Date)
    // …and the sweep leaves an accepted job alone however old the offer.
    await prisma.order.update({ where: { id: o.id }, data: { riderAssignedAt: new Date(Date.now() - OFFER_TIMEOUT_MS - 60_000) } })
    await runDispatchSweep()
    expect(await riderOf(o.id)).toBe(riders['a1']!.id)
    expect((await events(o.id)).map((e) => e.type)).not.toContain('timed_out')
  })

  it("another company's offer cannot be accepted once the agreement has ended — and ending it withdraws such offers", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1', 'a2')
    const o = await mkOrder(conceptB)
    await assignRider(o.id, riders['a1']!.id)
    // Ended between the offer and the accept (no PUT sweep in between):
    await prisma.fleetAgreement.updateMany({ where: { providerTenantId: tenantA, clientTenantId: tenantB }, data: { isActive: false } })
    const acc = await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})
    expect(acc.statusCode).toBe(409)
    expect(acc.json().error.code).toBe('OFFER_WITHDRAWN')
    expect(await riderOf(o.id)).toBeNull()
    expect((await events(o.id)).at(-1)).toMatchObject({ type: 'unassigned', note: 'fleet agreement ended' })

    // Through the PUT: every offer not yet accepted comes back; accepted jobs stay.
    await ensureAgreement(true)
    const offered = await mkOrder(conceptB)
    await assignRider(offered.id, riders['a2']!.id)
    const accepted = await mkOrder(conceptB)
    await assignRider(accepted.id, riders['a1']!.id)
    await rider('a1', 'POST', `/jobs/${accepted.id}/accept`, {})
    const end = await asStaff('adminAB', 'PUT', '/riders/fleet/agreements', { providerTenantId: tenantA, clientTenantId: tenantB, isActive: false })
    expect(end.statusCode).toBe(200)
    expect(await riderOf(offered.id)).toBeNull()
    expect(await riderOf(accepted.id)).toBe(riders['a1']!.id)
    expect(await statusOf('a2')).toBe('available')
    await ensureAgreement(true)
  })

  it('a delivered order takes no new rider and keeps the one who delivered it', async () => {
    await onlyAvailable('a1', 'a2')
    const o = await mkOrder(conceptA, { status: 'ready' })
    await assignRider(o.id, riders['a1']!.id)
    await markDelivered(o.id, { actor: null })
    await expect(assignRider(o.id, riders['a2']!.id)).rejects.toMatchObject({ code: 'ALREADY_DELIVERED', statusCode: 409 })
    await expect(unassignRider(o.id)).rejects.toMatchObject({ code: 'ALREADY_DELIVERED', statusCode: 409 })
    expect(await riderOf(o.id)).toBe(riders['a1']!.id)
    expect(await statusOf('a2')).toBe('available')
  })

  it('a rider still carrying an expo-completed order is not freed when another job ends; a refund in full frees them', async () => {
    await onlyAvailable('a1')
    const x = await mkOrder(conceptA, { status: 'ready' })
    const y = await mkOrder(conceptA, { status: 'ready' })
    await assignRider(x.id, riders['a1']!.id)
    await assignRider(y.id, riders['a1']!.id)
    // Expo completes X as the bag goes out with a1.
    await prisma.order.update({ where: { id: x.id }, data: { status: 'completed', completedAt: new Date() } })
    expect((await rider('a1', 'POST', `/jobs/${y.id}/decline`, {})).statusCode).toBe(200)
    expect(await statusOf('a1')).toBe('busy')   // X is still on the bike

    await updateOrderStatus(x.id, 'refunded')
    expect(await statusOf('a1')).toBe('available')
    expect((await events(x.id)).at(-1)).toMatchObject({ type: 'unassigned', note: 'order refunded' })
  })

  it('auto-dispatch leaves orders older than its window alone', async () => {
    await onlyAvailable('a1')
    const stale = await mkOrder(conceptA, { status: 'preparing' })
    await prisma.order.update({ where: { id: stale.id }, data: { placedAt: new Date(Date.now() - DISPATCH_WINDOW_MS - 60_000) } })
    await runDispatchSweep()
    expect(await riderOf(stale.id)).toBeNull()
    expect(await statusOf('a1')).toBe('available')
  })
})

describe('the hand-over code, every door', () => {
  it('the staff check shares the five-try budget with the rider app, and locks too (423)', async () => {
    await onlyAvailable('a2')
    const o = await mkOrder(conceptA, { status: 'ready', otp: '8642' })
    await assignRider(o.id, riders['a2']!.id)
    await rider('a2', 'POST', `/jobs/${o.id}/accept`, {})
    await rider('a2', 'POST', `/jobs/${o.id}/picked-up`, {})

    for (let i = 0; i < 3; i++) {
      expect((await asStaff('mgrA', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '0000' })).statusCode).toBe(403)
    }
    const r4 = await rider('a2', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })
    expect(r4.json().error.attemptsLeft).toBe(1)
    const r5 = await rider('a2', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })
    expect(r5.json().error.attemptsLeft).toBe(0)

    expect((await rider('a2', 'POST', `/jobs/${o.id}/deliver`, { otp: '8642' })).statusCode).toBe(423)
    const staffTry = await asStaff('mgrA', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '8642' })
    expect(staffTry.statusCode).toBe(423)
    expect(staffTry.json().error.code).toBe('OTP_LOCKED')
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.deliveryOtpAttempts).toBe(5)
    expect(after.deliveredAt).toBeNull()
  })

  it("a rider's delivery history never carries a live hand-over code", async () => {
    // Till-paid and out with the rider: 'completed', not yet delivered.
    const o = await mkOrder(conceptA, { status: 'ready', otp: '5151' })
    await prisma.order.update({
      where: { id: o.id },
      data: { status: 'completed', completedAt: new Date(), riderId: riders['a1']!.id, riderAssignedAt: new Date() },
    })
    // A FOH manager (not admin/management) — the roster is the 'riders' module.
    const res = await asStaff('mgrA', 'GET', `/riders/${riders['a1']!.id}/history`)
    expect(res.statusCode).toBe(200)
    const rows = res.json().orders as Array<Record<string, unknown>>
    expect(rows.find((r) => r['id'] === o.id)).toBeTruthy()
    expect(rows.every((r) => !('deliveryOtp' in r))).toBe(true)
    expect(res.body).not.toContain('5151')
  })
})

// ─── Staff closing a rider-app job ───────────────────────────────────────────

describe('"Mark delivered" by staff on a rider-app job', () => {
  const markDeliveredAs = (key: string, orderId: string) => asStaff(key, 'POST', `/dispatch/orders/${orderId}/delivered`)

  it('is a manager override, refused while the rider can still close it with the code, allowed once the code locks', async () => {
    await onlyAvailable('a1')
    await prisma.rider.update({ where: { id: riders['a1']!.id }, data: { totalDeliveries: 0 } })
    const o = await mkOrder(conceptA, { status: 'ready', otp: '3579' })
    await assignRider(o.id, riders['a1']!.id)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})).statusCode).toBe(200)

    // A cashier never closes a rider-app job; a manager not while the code works.
    expect((await markDeliveredAs('fohA', o.id)).statusCode).toBe(403)
    const early = await markDeliveredAs('mgrA', o.id)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('RIDER_CLOSES_WITH_CODE')
    // Nothing moved: not completed, not delivered, the rider still on it.
    let after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('ready')
    expect(after.completedAt).toBeNull()
    expect(after.deliveredAt).toBeNull()
    expect(await statusOf('a1')).toBe('busy')

    // Picked up, four wrong codes: one try left, so still the rider's to close.
    expect((await rider('a1', 'POST', `/jobs/${o.id}/picked-up`, {})).statusCode).toBe(200)
    for (let i = 0; i < 4; i++) expect((await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })).statusCode).toBe(403)
    expect((await markDeliveredAs('mgrA', o.id)).json().error.code).toBe('RIDER_CLOSES_WITH_CODE')

    // The fifth locks it (the rider is told a manager closes it) — now one may.
    await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })
    expect((await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '3579' })).statusCode).toBe(423)
    expect((await markDeliveredAs('fohA', o.id)).statusCode).toBe(403)
    // Company B's manager cannot reach company A's order at all.
    expect((await markDeliveredAs('mgrB', o.id)).statusCode).toBe(404)

    const ok = await markDeliveredAs('mgrA', o.id)
    expect(ok.statusCode).toBe(200)
    expect(ok.json().alreadyDelivered).toBe(false)
    expect(ok.json().order.deliveryOtp).toBeNull()
    after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.status).toBe('completed')
    expect(after.deliveredAt).toBeInstanceOf(Date)
    expect(after.deliveryOtpVerifiedAt).toBeNull()
    expect((await events(o.id)).at(-1)).toMatchObject({
      type: 'delivered', riderId: riders['a1']!.id, tenantId: tenantA, note: 'marked delivered by a manager — hand-over code locked',
    })
    expect(await statusOf('a1')).toBe('available')
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).totalDeliveries).toBe(1)

    // Pressed again: the same 200, counted once.
    const again = await markDeliveredAs('mgrA', o.id)
    expect(again.statusCode).toBe(200)
    expect(again.json().alreadyDelivered).toBe(true)
    expect((await prisma.rider.findUniqueOrThrow({ where: { id: riders['a1']!.id } })).totalDeliveries).toBe(1)
  })

  it('a manager may close a job the rider never accepted; an order from before the rider app keeps the old rule', async () => {
    await onlyAvailable('a1')
    const offered = await mkOrder(conceptA, { status: 'ready' })
    await assignRider(offered.id, riders['a1']!.id)
    expect((await markDeliveredAs('fohA', offered.id)).statusCode).toBe(403)
    const ok = await markDeliveredAs('mgrA', offered.id)
    expect(ok.statusCode).toBe(200)
    expect((await events(offered.id)).at(-1)).toMatchObject({ type: 'delivered', note: 'marked delivered by a manager — rider never accepted' })

    // Before the rider app: a rider recorded on the order, no riderAssignedAt.
    const legacy = await mkOrder(conceptA, { status: 'ready' })
    await prisma.order.update({ where: { id: legacy.id }, data: { riderId: riders['a2']!.id } })
    const res = await markDeliveredAs('fohA', legacy.id)
    expect(res.statusCode).toBe(200)
    expect(res.json().alreadyDelivered).toBe(false)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: legacy.id } })).deliveredAt).toBeInstanceOf(Date)
  })
})

// ─── The dispatch board ───────────────────────────────────────────────────────

type BoardOrder = Record<string, unknown> & { id: string }
type BoardRider = { id: string; fleetPartner: boolean; orders: BoardOrder[] }

describe('the dispatch board', () => {
  it("keeps an expo-completed order on its rider until it is delivered, with the code's attempts but never the code", async () => {
    await onlyAvailable('a1')
    const o = await mkOrder(conceptA, { status: 'ready', otp: '1357' })
    await assignRider(o.id, riders['a1']!.id)
    // Expo completes it as the bag goes out; two wrong codes at the door so far.
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date(), deliveryOtpAttempts: 2 } })
    // A completed order from before the rider app (no riderAssignedAt) is history.
    const old = await mkOrder(conceptA, { status: 'completed' })
    await prisma.order.update({ where: { id: old.id }, data: { riderId: riders['a1']!.id } })
    // …and so is a rider-app one handed out more than a day ago.
    const stale = await mkOrder(conceptA, { status: 'completed' })
    await prisma.order.update({ where: { id: stale.id }, data: { riderId: riders['a1']!.id, riderAssignedAt: new Date(Date.now() - 25 * 3600_000) } })

    const res = await asStaff('mgrA', 'GET', '/dispatch/board')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('1357')
    expect(res.body).not.toContain('deliveryOtp"')
    const a1 = (res.json() as BoardRider[]).find((r) => r.id === riders['a1']!.id)!
    const row = a1.orders.find((x) => x.id === o.id)
    expect(row).toMatchObject({
      status: 'completed', deliveryOtpAttempts: 2,
      riderAssignedAt: expect.any(String), riderAcceptedAt: null, pickedUpAt: null, arrivedAt: null,
    })
    expect(row && 'deliveryOtp' in row).toBe(false)
    expect(a1.orders.map((x) => x.id)).not.toContain(old.id)
    expect(a1.orders.map((x) => x.id)).not.toContain(stale.id)

    // Delivered: off the board.
    await markDelivered(o.id, { actor: null })
    const later = (await asStaff('mgrA', 'GET', '/dispatch/board')).json() as BoardRider[]
    expect(later.find((r) => r.id === riders['a1']!.id)!.orders.map((x) => x.id)).not.toContain(o.id)
  })

  it("shows a fleet partner's rider on the client's board while they carry its expo-completed order — and only that order", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')
    const aJob = await mkOrder(conceptA, { status: 'ready' })
    const bJob = await mkOrder(conceptB, { status: 'ready' })
    await assignRider(aJob.id, riders['a1']!.id)
    await assignRider(bJob.id, riders['a1']!.id)
    await prisma.order.update({ where: { id: bJob.id }, data: { status: 'completed', completedAt: new Date() } })

    const board = (await asStaff('mgrB', 'GET', '/dispatch/board')).json() as BoardRider[]
    const a1 = board.find((r) => r.id === riders['a1']!.id)
    expect(a1?.fleetPartner).toBe(true)
    expect(a1?.orders.map((o) => o.id)).toEqual([bJob.id])
    expect(board.find((r) => r.id === riders['a2']!.id)).toBeUndefined()

    // Delivered: A's rider leaves B's board (they still carry A's order).
    await markDelivered(bJob.id, { actor: null })
    const after = (await asStaff('mgrB', 'GET', '/dispatch/board')).json() as BoardRider[]
    expect(after.find((r) => r.id === riders['a1']!.id)).toBeUndefined()
    expect(await statusOf('a1')).toBe('busy')
  })
})

// ─── The roster ───────────────────────────────────────────────────────────────

describe('GET /riders', () => {
  it("carries each rider's company and latest job event — own fleet only, never a hand-over code", async () => {
    await ensureAgreement(true)
    await onlyAvailable('a1')
    const o = await mkOrder(conceptB, { status: 'ready', otp: '9753' })   // a fleet job for B
    await assignRider(o.id, riders['a1']!.id)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/accept`, {})).statusCode).toBe(200)

    const res = await asStaff('mgrA', 'GET', '/riders')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('9753')
    expect(res.body).not.toContain('deliveryOtp')
    type Row = { id: string; name: string; status: string; tenantId: string; tenant: { name: string } | null; jobEvents: Array<Record<string, unknown>>; orders: unknown[] }
    const list = res.json() as Row[]
    const a1 = list.find((r) => r.id === riders['a1']!.id)!
    expect(a1.tenant).toEqual({ name: 'GS Foods Fleet' })
    // The latest event only, and only its type and time — a fleet job for
    // another company is still this rider's work.
    expect(a1.jobEvents).toEqual([{ type: 'accepted', createdAt: expect.any(String) }])
    // Otherwise the response is as before: the rider row and its live orders.
    expect(a1).toMatchObject({ name: 'Rider a1', tenantId: tenantA, status: 'busy', orders: expect.any(Array) })
    // A rider with no job events yet has an empty list.
    const newcomer = await mkRider('roster', tenantA, '923115550210')
    const again = (await asStaff('mgrA', 'GET', '/riders')).json() as Row[]
    expect(again.find((r) => r.id === newcomer.id)).toMatchObject({ tenant: { name: 'GS Foods Fleet' }, jobEvents: [] })

    // B's manager sees B's fleet only — not A's rider, though they carry B's order.
    const b = (await asStaff('mgrB', 'GET', '/riders')).json() as Row[]
    expect(b.map((r) => r.id)).toContain(riders['b1']!.id)
    expect(b.map((r) => r.id)).not.toContain(riders['a1']!.id)
    expect(b.every((r) => r.tenant?.name === 'GSX Viva')).toBe(true)
  })
})

// ─── Code-only delivery: the rerouted code and the switch ───────────────────

describe('the rerouted hand-over code and the code-only switch', () => {
  it('deliver is unchanged with the switch off; the Job carries no code and no door-problem option', async () => {
    await onlyAvailable('a1')
    const o = await mkOrder(conceptA, { status: 'ready', otp: '3141' })
    await prisma.order.update({ where: { id: o.id }, data: { riderId: riders['a1']!.id, riderAssignedAt: new Date(), riderAcceptedAt: new Date(), pickedUpAt: new Date() } })
    const job = (await rider('a1', 'GET', `/jobs/${o.id}`)).json().job
    expect(job.handover).toEqual({ rerouted: false, reroutedAt: null, code: null, whatsappSent: false })
    expect(job.doorProblem).toBeNull()
    expect(job.doorProblemEnabled).toBe(false)
    const bad = await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '0000' })
    expect(bad.statusCode).toBe(403)
    expect(bad.json().error.attemptsLeft).toBe(4)
    expect((await rider('a1', 'POST', `/jobs/${o.id}/deliver`, { otp: '3141' })).statusCode).toBe(200)
  })

  it('handover.code shows only to the rider it was rerouted to, and the admin read follows the switch', async () => {
    await onlyAvailable('a1', 'a2')
    const o = await mkOrder(conceptA, { status: 'ready', otp: '2718' })
    await prisma.order.update({
      where: { id: o.id },
      data: {
        riderId: riders['a1']!.id, riderAssignedAt: new Date(), riderAcceptedAt: new Date(), pickedUpAt: new Date(),
        handoverReroutedAt: new Date(), handoverRerouteRiderId: riders['a1']!.id,
      },
    })
    const mine = (await rider('a1', 'GET', `/jobs/${o.id}`)).json().job
    expect(mine.handover).toMatchObject({ rerouted: true, code: '2718' })
    // Another rider never sees the order at all; a job row read for another
    // rider id would carry rerouted: true but no code.
    expect((await rider('a2', 'GET', `/jobs/${o.id}`)).statusCode).toBe(404)
    expect(JSON.stringify((await rider('a1', 'GET', '/jobs')).json())).toContain('2718')

    const off = await asStaff('adminAB', 'GET', `/orders/${o.id}`)
    expect(off.json().deliveryOtp).toBe('2718')
    await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantA, on: true, actorId: staff['adminAB']!.id, reason: 'test switch on' }))
    try {
      // The admin read rule follows the switch (lib/deliveryOtp.ts); the orders
      // route passes codeOnlyDelivery() to it — wired by the DLV-core stream.
      const { codeOnlyDelivery } = await import('../src/lib/deliveryRules.js')
      const { redactDeliveryOtp } = await import('../src/lib/deliveryOtp.js')
      const codeOnly = await codeOnlyDelivery(prisma, tenantA)
      expect(codeOnly).toBe(true)
      expect(redactDeliveryOtp({ deliveryOtp: '2718' }, 'admin', codeOnly).deliveryOtp).toBeNull()
      expect(redactDeliveryOtp({ deliveryOtp: '2718' }, 'admin', false).deliveryOtp).toBe('2718')
      expect((await rider('a1', 'GET', `/jobs/${o.id}`)).json().job.doorProblemEnabled).toBe(true)
    } finally {
      await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantA, on: false, actorId: staff['adminAB']!.id, reason: 'test switch off' }))
    }
  })
})
