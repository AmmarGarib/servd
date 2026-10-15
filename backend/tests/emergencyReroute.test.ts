// Emergency override: send the customer's hand-over code to the rider
// (dispatch/service rerouteHandoverCode / resendReroutedCode), and code-only
// delivery behind its per-company switch (lib/deliveryRules.ts).
//
// What this guards:
//   - once per order; the code rotates (the old one no longer delivers); the
//     wrong-code count resets with the old count kept; the job event names the
//     manager; the exception and audit land in the ORDER's company; WhatsApp
//     goes to the rider's own number;
//   - the order is pinned to that rider: a dispatcher's assign / unassign is
//     409 CODE_WITH_RIDER, the system loops' guarded take-offs are no-ops;
//   - a fleet rider of B carrying A's order: the event is A's, rider's B;
//   - the refusals, in order;
//   - the switch: OFF, staff "Delivered" and the support code read work as
//     today; ON, Delivered is 404, markDelivered without a code is 409
//     CODE_REQUIRED, the code read is 404 and nobody (CEO included) sees it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const sent: Array<{ to: string; msg: string }> = []
const failSend = { on: false }
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    sendText: vi.fn(async (to: string, msg: string) => {
      if (failSend.on) throw new Error('gateway down')
      sent.push({ to, msg })
    }),
  }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { setCodeOnlyDelivery } = await import('../src/lib/deliveryRules.js')
const { canReadDeliveryOtp, redactDeliveryOtp } = await import('../src/lib/deliveryOtp.js')
const {
  rerouteHandoverCode, resendReroutedCode, assignRider, unassignRider, takeRiderOff, withdrawOffer, markDelivered,
} = await import('../src/modules/dispatch/service.js')
const { deliverJob } = await import('../src/modules/rider/service.js')
const { dispatchRoutes } = await import('../src/modules/dispatch/routes.js')
const { trustopsRoutes } = await import('../src/modules/trustops/routes.js')

let app: FastifyInstance
let tenantA: string
let tenantB: string
let tenantC: string   // code-only switched ON
let conceptA: string
let conceptC: string
const users: Record<string, { id: string; token: string }> = {}
let n = 0

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.reroute@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as 'admin', isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function rider(tenantId: string, phone?: string) {
  n += 1
  return prisma.rider.create({
    data: { tenantId, name: `Reroute Rider ${n}`, phone: phone ?? `0312${String(7_000_000 + n)}`, status: 'busy', isActive: true },
  })
}

async function job(conceptId: string, riderId: string | null, o: Partial<{
  status: 'preparing' | 'ready' | 'completed'
  fulfilmentType: 'delivery' | 'takeout'
  pickedUp: boolean
  app: boolean
  attempts: number
}> = {}) {
  const now = new Date()
  const app = o.app ?? true
  return prisma.order.create({
    data: {
      conceptId, source: 'servd', status: o.status ?? 'ready', totalCents: 80_000,
      fulfilmentType: o.fulfilmentType ?? 'delivery', deliveryOtp: '1234',
      deliveryOtpAttempts: o.attempts ?? 0,
      riderId,
      riderAssignedAt: riderId && app ? now : null,
      riderAcceptedAt: riderId && app ? now : null,
      pickedUpAt: riderId && app && (o.pickedUp ?? true) ? now : null,
      items: { create: [{ name: 'Sandwich', quantity: 1, unitPriceCents: 80_000 }] },
    },
  })
}

const actorA = () => ({ id: users.mgrA!.id, email: 'mgrA.reroute@gsfoods.pk', tenantId: tenantA })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Reroute A', slug: 'reroute-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Reroute B', slug: 'reroute-b' } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'Reroute C', slug: 'reroute-c' } })).id
  for (const t of [tenantA, tenantB, tenantC]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'stackd', slug: 'reroute-cafe-a', type: 'restaurant', tenantId: tenantA } })).id
  await prisma.concept.create({ data: { name: 'Reroute Cafe B', slug: 'reroute-cafe-b', type: 'restaurant', tenantId: tenantB } })
  conceptC = (await prisma.concept.create({ data: { name: 'Reroute Cafe C', slug: 'reroute-cafe-c', type: 'restaurant', tenantId: tenantC } })).id
  await mkUser('mgrA', 'admin', tenantA)
  await mkUser('mgrB', 'admin', tenantB)
  await mkUser('mgrC', 'admin', tenantC)
  await mkUser('cashC', 'cashier', tenantC)
  await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: tenantC, on: true, actorId: users.mgrC!.id, reason: 'go live with code-only delivery' }))

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(dispatchRoutes, { prefix: '/dispatch' })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.ready()
})

afterAll(async () => { await app.close() })

beforeEach(() => { sent.length = 0; failSend.on = false })

describe('rerouteHandoverCode', () => {
  it('rotates the code, resets the count (snapshot kept), names the manager, flags and audits in A, texts the rider', async () => {
    const r = await rider(tenantA, '0312-9998877')
    const o = await job(conceptA, r.id, { attempts: 4 })

    const res = await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'customer phone dead' })
    expect(res).toEqual({ ok: true, sentToRider: true, riderPhoneHint: '877' })

    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.deliveryOtp).toMatch(/^\d{4}$/)
    expect(row.handoverReroutedAt).toBeInstanceOf(Date)
    expect(row.handoverRerouteRiderId).toBe(r.id)
    expect(row.handoverRerouteAttempts).toBe(4)
    expect(row.deliveryOtpAttempts).toBe(0)

    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'code_rerouted' } })
    expect(ev.actorId).toBe(users.mgrA!.id)
    expect(ev.tenantId).toBe(tenantA)
    expect(ev.riderTenantId).toBe(tenantA)
    expect(ev.note).toBe('customer phone dead')

    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'delivery_code_rerouted', entityId: o.id } })
    expect(flag.tenantId).toBe(tenantA)
    expect(flag.severity).toBe('high')
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'delivery.code_rerouted', entityId: o.id } })
    expect(auditRow.tenantId).toBe(tenantA)
    expect(JSON.stringify(auditRow.metadata)).not.toContain(row.deliveryOtp!)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('923129998877')
    expect(sent[0]!.msg).toContain(row.deliveryOtp!)
    expect(sent[0]!.msg).toContain('Stackd order')
    expect(sent[0]!.msg).toContain('Collect any cash first')

    // Once per order.
    await expect(rerouteHandoverCode(o.id, { actor: actorA(), reason: 'again' }))
      .rejects.toMatchObject({ code: 'ALREADY_REROUTED', statusCode: 409 })
  })

  it('the old code no longer delivers; the new one does, with the reroute in the event note', async () => {
    const r = await rider(tenantA)
    const o = await job(conceptA, r.id, { attempts: 5 })   // locked
    await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'code locked at the door' })
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtp!
    // (1 in 10,000 the new code happens to equal the old one.)
    if (code !== '1234') {
      await expect(deliverJob(r, o.id, { otp: '1234' })).rejects.toMatchObject({ code: 'OTP_MISMATCH', statusCode: 403 })
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtpAttempts).toBe(1)
    }
    await deliverJob(r, o.id, { otp: code })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.deliveredAt).toBeInstanceOf(Date)
    expect(row.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
    expect(row.status).toBe('completed')
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'delivered' } })
    expect(ev.note).toBe('hand-over code verified (code sent to the rider by a manager)')
  })

  it('pins the order to that rider: dispatcher assign/unassign 409, system loops are no-ops', async () => {
    const r = await rider(tenantA)
    const other = await rider(tenantA)
    await prisma.rider.update({ where: { id: other.id }, data: { status: 'available' } })
    const o = await job(conceptA, r.id)
    await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'customer cannot read the code' })

    await expect(assignRider(o.id, other.id)).rejects.toMatchObject({ code: 'CODE_WITH_RIDER', statusCode: 409 })
    await expect(unassignRider(o.id)).rejects.toMatchObject({ code: 'CODE_WITH_RIDER', statusCode: 409 })
    expect(await withdrawOffer(o.id, r.id, { event: 'timed_out', note: 'offer timed out' })).toBe(false)
    expect((await takeRiderOff(o.id, { onlyIfNotPickedUp: true })).changed).toBe(false)
    expect((await takeRiderOff(o.id, { onlyIfRiderId: r.id })).changed).toBe(false)
    // The same rider is a no-op, not a refusal.
    await expect(assignRider(o.id, r.id)).resolves.toMatchObject({ riderId: r.id })
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.riderId).toBe(r.id)
    expect(row.pickedUpAt).toBeInstanceOf(Date)

    // Over HTTP too.
    const res = await call('mgrA', 'POST', `/dispatch/orders/${o.id}/unassign`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('CODE_WITH_RIDER')
  })

  it("a fleet rider of B carrying A's order: A's manager reroutes; the event is A's, the rider's B", async () => {
    await prisma.fleetAgreement.create({ data: { providerTenantId: tenantB, clientTenantId: tenantA, createdById: users.mgrB!.id } })
    const r = await rider(tenantB)
    const o = await job(conceptA, r.id)
    const res = await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'fleet rider at the door' })
    expect(res.ok).toBe(true)
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'code_rerouted' } })
    expect(ev.tenantId).toBe(tenantA)
    expect(ev.riderTenantId).toBe(tenantB)
    expect((await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'delivery_code_rerouted', entityId: o.id } })).tenantId).toBe(tenantA)
  })

  it('refuses, in order: not a delivery, delivered, not ready, no rider, not picked up, no phone', async () => {
    const r = await rider(tenantA)
    const reroute = (id: string) => rerouteHandoverCode(id, { actor: actorA(), reason: 'test' })
    await expect(reroute((await job(conceptA, r.id, { fulfilmentType: 'takeout' })).id))
      .rejects.toMatchObject({ code: 'NOT_A_DELIVERY', statusCode: 422 })
    const done = await job(conceptA, r.id)
    await prisma.order.update({ where: { id: done.id }, data: { deliveredAt: new Date() } })
    await expect(reroute(done.id)).rejects.toMatchObject({ code: 'ALREADY_DELIVERED', statusCode: 409 })
    await expect(reroute((await job(conceptA, r.id, { status: 'preparing' })).id))
      .rejects.toMatchObject({ code: 'NOT_READY', statusCode: 409 })
    await expect(reroute((await job(conceptA, null)).id)).rejects.toMatchObject({ code: 'NO_RIDER', statusCode: 422 })
    await expect(reroute((await job(conceptA, r.id, { pickedUp: false })).id))
      .rejects.toMatchObject({ code: 'NOT_PICKED_UP', statusCode: 409 })
    // A rider without the app (no riderAssignedAt) needs no pick-up.
    const noApp = await job(conceptA, r.id, { app: false })
    await expect(reroute(noApp.id)).resolves.toMatchObject({ ok: true })
    const noPhone = await rider(tenantA, '12345')
    const np = await job(conceptA, noPhone.id)
    await expect(reroute(np.id)).rejects.toMatchObject({ code: 'RIDER_HAS_NO_PHONE', statusCode: 422 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: np.id } })).handoverReroutedAt).toBeNull()
  })

  it('a failed WhatsApp still commits the reroute; sentToRider is false', async () => {
    const r = await rider(tenantA)
    const o = await job(conceptA, r.id)
    failSend.on = true
    const res = await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'gateway test' })
    expect(res.sentToRider).toBe(false)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).handoverReroutedAt).toBeInstanceOf(Date)
  })
})

describe('resendReroutedCode', () => {
  it('needs a reroute; sends the same code to the same rider; refuses once delivered', async () => {
    const r = await rider(tenantA, '03125550001')
    const o = await job(conceptA, r.id)
    await expect(resendReroutedCode(o.id, { actor: actorA() })).rejects.toMatchObject({ code: 'NOT_REROUTED', statusCode: 409 })
    await rerouteHandoverCode(o.id, { actor: actorA(), reason: 'first send' })
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtp!
    sent.length = 0
    expect(await resendReroutedCode(o.id, actorA())).toEqual({ ok: true, sentToRider: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('923125550001')
    expect(sent[0]!.msg).toContain(code)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtp).toBe(code)
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'delivery.code_resent', entityId: o.id } })).tenantId).toBe(tenantA)
    await prisma.order.update({ where: { id: o.id }, data: { deliveredAt: new Date() } })
    await expect(resendReroutedCode(o.id, { actor: actorA() })).rejects.toMatchObject({ code: 'ALREADY_DELIVERED', statusCode: 409 })
  })
})

describe('code-only switch', () => {
  it('OFF (company A): staff Delivered and the support code read work as today', async () => {
    const r = await rider(tenantA)
    const o = await job(conceptA, r.id, { app: false })
    const otp = await call('mgrA', 'GET', `/trustops/orders/${o.id}/otp`)
    expect(otp.statusCode).toBe(200)
    expect(otp.json().otp).toBe('1234')
    const res = await call('mgrA', 'POST', `/dispatch/orders/${o.id}/delivered`)
    expect(res.statusCode).toBe(200)
    expect(res.json().order.deliveredAt).toBeTruthy()
    expect(res.json().order.deliveryOtp).toBe('1234')   // admin reads it while OFF
  })

  it('ON (company C): Delivered is 404, markDelivered needs the code, the code read is 404', async () => {
    const r = await rider(tenantC)
    const o = await job(conceptC, r.id, { app: false })
    expect((await call('mgrC', 'POST', `/dispatch/orders/${o.id}/delivered`)).statusCode).toBe(404)
    await expect(markDelivered(o.id, { staffClose: { manager: true } }))
      .rejects.toMatchObject({ code: 'CODE_REQUIRED', statusCode: 409 })
    await expect(markDelivered(o.id)).rejects.toMatchObject({ code: 'CODE_REQUIRED' })
    expect((await call('mgrC', 'GET', `/trustops/orders/${o.id}/otp`)).statusCode).toBe(404)
    let row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.deliveredAt).toBeNull()
    expect(row.status).toBe('ready')

    // The board flags it so the admin hides Delivered; nobody sees the code.
    const board = await call('mgrC', 'GET', '/dispatch/board')
    expect(board.statusCode).toBe(200)
    const onBoard = (board.json() as Array<{ orders: Array<Record<string, unknown>> }>).flatMap((x) => x.orders).find((x) => x.id === o.id)
    expect(onBoard).toMatchObject({ codeOnly: true, handoverReroutedAt: null, handoverRerouteRiderId: null })
    expect(onBoard).not.toHaveProperty('deliveryOtp')

    // The code itself still closes it (staff "Enter code").
    const v = await call('cashC', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '1234' })
    expect(v.statusCode).toBe(200)
    row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.deliveredAt).toBeInstanceOf(Date)
    expect(row.deliveryOtpVerifiedAt).toBeInstanceOf(Date)
  })

  it("ON: a locked code points at Emergency overrides; A's board is not flagged", async () => {
    const r = await rider(tenantC)
    const o = await job(conceptC, r.id, { app: false, attempts: 5 })
    const res = await call('cashC', 'POST', `/trustops/orders/${o.id}/verify-otp`, { otp: '1234' })
    expect(res.statusCode).toBe(423)
    expect(res.json().error.message).toBe('Too many wrong codes on this order. Ask a manager to send the code to the rider (Emergency overrides).')

    const ra = await rider(tenantA)
    const oa = await job(conceptA, ra.id, { app: false, attempts: 5 })
    const lockedA = await call('mgrA', 'POST', `/trustops/orders/${oa.id}/verify-otp`, { otp: '1234' })
    expect(lockedA.json().error.message).toBe('Too many wrong codes on this order. A manager has to mark it delivered from Dispatch.')
    const boardA = await call('mgrA', 'GET', '/dispatch/board')
    const rowA = (boardA.json() as Array<{ orders: Array<Record<string, unknown>> }>).flatMap((x) => x.orders).find((x) => x.id === oa.id)
    expect(rowA).toMatchObject({ codeOnly: false })
    // C's board never shows A's order.
    const boardC = await call('mgrC', 'GET', '/dispatch/board')
    expect((boardC.json() as Array<{ orders: Array<{ id: string }> }>).flatMap((x) => x.orders).some((x) => x.id === oa.id)).toBe(false)
  })

  it('B cannot press Delivered or read the code on A\'s order (404)', async () => {
    const r = await rider(tenantA)
    const o = await job(conceptA, r.id, { app: false })
    expect((await call('mgrB', 'POST', `/dispatch/orders/${o.id}/delivered`)).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/trustops/orders/${o.id}/otp`)).statusCode).toBe(404)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveredAt).toBeNull()
  })

  it('ON: no role reads the code, the CEO included', () => {
    expect(canReadDeliveryOtp('admin')).toBe(true)
    expect(canReadDeliveryOtp('admin', true)).toBe(false)
    expect(canReadDeliveryOtp('management', true)).toBe(false)
    expect(redactDeliveryOtp({ deliveryOtp: '1234' }, 'admin', true)).toEqual({ deliveryOtp: null })
    expect(redactDeliveryOtp({ deliveryOtp: '1234' }, 'admin')).toEqual({ deliveryOtp: '1234' })
  })
})
