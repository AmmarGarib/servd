// /emergency-overrides — the API module (modules/emergencyOverrides). Two
// companies A and B.
//
// What this guards:
//   - B's manager gets 404 on A's order on every order route (send-code,
//     resend, food-returned, return-preview) and never sees it in the list;
//   - roles: cashier and co-owner 403 (the module gate); foh_management,
//     boh_management, fnb_manager and management 200; a CEO untick of the
//     module on a saved RoleModuleAccess row → 403;
//   - the switch: GET /settings per company; PUT is CEO only and only for a
//     company the CEO belongs to; every action is 409 CODE_ONLY_OFF while
//     the order's company has it off;
//   - reroute once (the second is 409 ALREADY_REROUTED), the job event and
//     the WhatsApp land in A;
//   - a fleet rider of B carrying A's order: A reroutes; B sees nothing;
//   - the resend limit: 3 per 10 minutes per order, then 429;
//   - food-returned end to end (cancelled + returnedAt, the COD row failed,
//     waste logged, a strike for 'refused' only);
//   - the list carries codeLocked, doorProblem, cashToCollectCents, stage,
//     rerouted and the fleet partner's name; recent shows the overrides.
// WhatsApp is mocked.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

const sent: Array<{ to: string; msg: string }> = []
vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    sendText: vi.fn(async (to: string, msg: string) => { sent.push({ to, msg }) }),
  }
})

const Fastify = (await import('fastify')).default
const rateLimit = (await import('@fastify/rate-limit')).default
const { ZodError } = await import('zod')
const { randomUUID } = await import('node:crypto')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { prisma, mkCompany, mkUser, caller } = await import('./connectorsFixtures.js')
const { addLotTx, fifoCutoverKey } = await import('../src/lib/stockLedger.js')
const { ingestOrder, deductInventoryForOrder } = await import('../src/modules/orders/service.js')
const { setCodeOnlyDelivery } = await import('../src/lib/deliveryRules.js')
const { setFiscalKicker } = await import('../src/connectors/fiscal/outbox.js')
const { applyModuleGrants, invalidateModuleAccessCache, DEFAULT_MODULE_ACCESS } = await import('../src/lib/moduleAccess.js')
const { default: emergencyOverridesRoutes } = await import('../src/modules/emergencyOverrides/routes.js')

type Company = Awaited<ReturnType<typeof mkCompany>>
type Who = Awaited<ReturnType<typeof mkUser>>

let app: import('fastify').FastifyInstance
let A: Company
let B: Company
let C: Company   // A's CEO is NOT a member of C
const u: Record<string, Who> = {}
let riderA: string
let riderB: string
let beefA: string
let seq = 0
const DAY = 86_400_000

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)
const base = '/emergency-overrides'

async function job(co: Company, riderId: string, o: Partial<{ attempts: number; pickedUp: boolean; cod: number }> = {}) {
  const now = new Date()
  return prisma.order.create({
    data: {
      conceptId: co.conceptId, source: 'servd', status: 'ready', totalCents: 80_000, fulfilmentType: 'delivery',
      deliveryOtp: '1234', deliveryOtpAttempts: o.attempts ?? 0, customerName: `Guest ${++seq}`,
      riderId, riderAssignedAt: now, riderAcceptedAt: now, pickedUpAt: (o.pickedUp ?? true) ? new Date(now.getTime() - 20 * 60_000) : null,
      items: { create: [{ name: 'Sandwich', quantity: 1, unitPriceCents: 80_000 }] },
      ...(o.cod ? { payments: { create: [{ method: 'cash', status: 'pending', amountCents: o.cod }] } } : {}),
    },
  })
}

async function setSwitch(co: Company, on: boolean) {
  await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: co.tenantId, on, actorId: u.ceoA!.id, reason: 'test switch for the suite' }))
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`eo-a-${Date.now()}`)
  B = await mkCompany(`eo-b-${Date.now()}`)
  C = await mkCompany(`eo-c-${Date.now()}`)
  await prisma.setting.create({ data: { key: fifoCutoverKey(A.tenantId), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  u.ceoA = await mkUser('eo-ceo-a', 'admin', A.tenantId)
  u.fohA = await mkUser('eo-foh-a', 'foh_management', A.tenantId)
  u.bohA = await mkUser('eo-boh-a', 'boh_management', A.tenantId)
  u.fnbA = await mkUser('eo-fnb-a', 'fnb_manager', A.tenantId)
  u.mgmtA = await mkUser('eo-mgmt-a', 'management', A.tenantId)
  u.cashA = await mkUser('eo-cash-a', 'cashier', A.tenantId)
  u.ownerA = await mkUser('eo-owner-a', 'owner', A.tenantId)
  u.fohB = await mkUser('eo-foh-b', 'foh_management', B.tenantId)
  u.ceoB = await mkUser('eo-ceo-b', 'admin', B.tenantId)
  riderA = (await prisma.rider.create({ data: { tenantId: A.tenantId, name: 'EO Rider A', phone: '03125550001', status: 'busy', isActive: true } })).id
  riderB = (await prisma.rider.create({ data: { tenantId: B.tenantId, name: 'EO Rider B', phone: '03125550002', status: 'busy', isActive: true } })).id

  // A recipe so "Food came back" has something to waste.
  beefA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  const src = `eo-lot-${++seq}`
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: beefA, qty: 50, unitCostCents: 150_000, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: beefA, quantity: 150, unit: 'kg' }] } },
  })

  await setSwitch(A, true)
  await setSwitch(B, true)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(rateLimit, { global: false })
  await app.register(emergencyOverridesRoutes, { prefix: base })
  await app.ready()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  await app?.close()
})

beforeEach(() => { sent.length = 0 })

describe('company separation', () => {
  it("B's manager gets 404 on A's order on every route and never sees it", async () => {
    const o = await job(A, riderA)
    const posts: Array<[string, Record<string, unknown>]> = [
      [`${base}/orders/${o.id}/send-code-to-rider`, { reason: 'customer phone is dead' }],
      [`${base}/orders/${o.id}/send-code-to-rider/resend`, {}],
      [`${base}/orders/${o.id}/food-returned`, { cause: 'refused', reason: 'refused at the door' }],
    ]
    for (const [url, body] of posts) {
      const r = await call(u.fohB!, 'POST', url, body)
      expect(r.statusCode, url).toBe(404)
    }
    expect((await call(u.fohB!, 'GET', `${base}/orders/${o.id}/return-preview`)).statusCode).toBe(404)
    const list = (await call(u.fohB!, 'GET', `${base}/orders`)).json()
    expect(list.onTheRoad.map((r: { orderId: string }) => r.orderId)).not.toContain(o.id)
    // Nothing happened to the order.
    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row.handoverReroutedAt).toBeNull()
    expect(row.status).toBe('ready')
    expect(sent).toHaveLength(0)
  })

  it('an unknown or malformed id is 404', async () => {
    expect((await call(u.fohA!, 'POST', `${base}/orders/${randomUUID()}/send-code-to-rider`, { reason: 'customer phone is dead' })).statusCode).toBe(404)
    expect((await call(u.fohA!, 'GET', `${base}/orders/not-a-uuid/return-preview`)).statusCode).toBe(404)
  })

  it("a fleet rider of B carrying A's order: A reroutes, B sees nothing", async () => {
    const o = await job(A, riderB)
    const listA = (await call(u.fohA!, 'GET', `${base}/orders`)).json()
    const rowA = listA.onTheRoad.find((r: { orderId: string }) => r.orderId === o.id)
    const nameB = (await prisma.tenant.findUniqueOrThrow({ where: { id: B.tenantId } })).name
    expect(rowA.rider).toEqual({ id: riderB, name: 'EO Rider B', fleetPartner: nameB })

    const r = await call(u.fohA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider`, { reason: 'customer phone is dead' })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ ok: true, sentToRider: true, riderPhoneHint: '002' })
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'code_rerouted' } })
    expect(ev.tenantId).toBe(A.tenantId)
    expect(ev.riderTenantId).toBe(B.tenantId)
    expect(ev.actorId).toBe(u.fohA!.id)
    expect(sent[0]!.to).toBe('923125550002')

    const listB = (await call(u.fohB!, 'GET', `${base}/orders`)).json()
    expect(listB.onTheRoad.map((x: { orderId: string }) => x.orderId)).not.toContain(o.id)
    expect(listB.recent.map((x: { orderId: string }) => x.orderId)).not.toContain(o.id)
    expect((await call(u.fohB!, 'POST', `${base}/orders/${o.id}/send-code-to-rider/resend`, {})).statusCode).toBe(404)
  })
})

describe('roles and the module', () => {
  it('cashier and co-owner 403; the four manager roles and the CEO 200', async () => {
    for (const k of ['cashA', 'ownerA']) {
      expect((await call(u[k]!, 'GET', `${base}/orders`)).statusCode, k).toBe(403)
      expect((await call(u[k]!, 'GET', `${base}/settings`)).statusCode, k).toBe(403)
    }
    for (const k of ['fohA', 'bohA', 'fnbA', 'mgmtA', 'ceoA']) {
      expect((await call(u[k]!, 'GET', `${base}/orders`)).statusCode, k).toBe(200)
    }
  })

  it('a CEO untick on a saved Module Access row closes it (403)', async () => {
    await applyModuleGrants()
    const modules = DEFAULT_MODULE_ACCESS.boh_management.filter((m) => m !== 'emergency_overrides')
    await prisma.roleModuleAccess.upsert({ where: { role: 'boh_management' }, create: { role: 'boh_management', modules }, update: { modules } })
    invalidateModuleAccessCache()
    try {
      expect((await call(u.bohA!, 'GET', `${base}/orders`)).statusCode).toBe(403)
      const o = await job(A, riderA)
      expect((await call(u.bohA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider`, { reason: 'customer phone is dead' })).statusCode).toBe(403)
      // Other roles keep it.
      expect((await call(u.fohA!, 'GET', `${base}/orders`)).statusCode).toBe(200)
    } finally {
      await prisma.roleModuleAccess.deleteMany({ where: { role: 'boh_management' } })
      invalidateModuleAccessCache()
    }
    expect((await call(u.bohA!, 'GET', `${base}/orders`)).statusCode).toBe(200)
  })
})

describe('the switch', () => {
  it('GET /settings lists the companies in scope with their switch', async () => {
    const r = (await call(u.fohA!, 'GET', `${base}/settings`)).json()
    expect(r.companies).toHaveLength(1)
    expect(r.companies[0]).toMatchObject({ tenantId: A.tenantId, codeOnly: true })
    expect(typeof r.companies[0].since).toBe('string')
  })

  it('PUT /settings is the CEO only, for a company the CEO belongs to, and audits', async () => {
    const body = { tenantId: C.tenantId, codeOnly: true, reason: 'going live with code-only' }
    expect((await call(u.fohA!, 'PUT', `${base}/settings`, body)).statusCode).toBe(403)
    expect((await call(u.mgmtA!, 'PUT', `${base}/settings`, body)).statusCode).toBe(403)
    expect((await call(u.ceoA!, 'PUT', `${base}/settings`, body)).statusCode).toBe(404)          // not a member of C
    expect((await call(u.ceoA!, 'PUT', `${base}/settings`, { ...body, tenantId: A.tenantId, reason: 'short' })).statusCode).toBe(400)

    const off = await call(u.ceoA!, 'PUT', `${base}/settings`, { tenantId: A.tenantId, codeOnly: false, reason: 'pausing for the test run' })
    expect(off.statusCode).toBe(200)
    expect(off.json().company).toMatchObject({ tenantId: A.tenantId, codeOnly: false, since: null })
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'delivery.code_only.switch', tenantId: A.tenantId, userId: u.ceoA!.id }, orderBy: { createdAt: 'desc' },
    })
    expect(audit.metadata).toMatchObject({ reason: 'pausing for the test run' })

    // OFF: every action is 409 CODE_ONLY_OFF; the list still reads.
    try {
      const o = await job(A, riderA)
      for (const [url, payload] of [
        [`${base}/orders/${o.id}/send-code-to-rider`, { reason: 'customer phone is dead' }],
        [`${base}/orders/${o.id}/send-code-to-rider/resend`, {}],
        [`${base}/orders/${o.id}/food-returned`, { cause: 'refused', reason: 'refused at the door' }],
      ] as const) {
        const r = await call(u.fohA!, 'POST', url, payload)
        expect(r.statusCode, url).toBe(409)
        expect(r.json().error.code).toBe('CODE_ONLY_OFF')
      }
      const list = (await call(u.fohA!, 'GET', `${base}/orders`)).json()
      expect(list.onTheRoad.find((x: { orderId: string }) => x.orderId === o.id).codeOnly).toBe(false)
    } finally {
      const on = await call(u.ceoA!, 'PUT', `${base}/settings`, { tenantId: A.tenantId, codeOnly: true, reason: 'back on for the rest' })
      expect(on.statusCode).toBe(200)
      expect(on.json().company.codeOnly).toBe(true)
    }
  })
})

describe('send the code to the rider', () => {
  it('works once; the second is 409 ALREADY_REROUTED', async () => {
    const o = await job(A, riderA, { attempts: 5 })
    const r1 = await call(u.bohA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider`, { reason: 'code locked at the door' })
    expect(r1.statusCode).toBe(200)
    expect(sent).toHaveLength(1)
    const r2 = await call(u.bohA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider`, { reason: 'code locked at the door' })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('ALREADY_REROUTED')
    // A short reason is refused.
    const o2 = await job(A, riderA)
    expect((await call(u.bohA!, 'POST', `${base}/orders/${o2.id}/send-code-to-rider`, { reason: 'short' })).statusCode).toBe(400)
  })

  it('resend: 3 per 10 minutes per order, then 429', async () => {
    const o = await job(A, riderA)
    expect((await call(u.fnbA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider`, { reason: 'customer phone is dead' })).statusCode).toBe(200)
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).deliveryOtp!
    for (let i = 0; i < 3; i += 1) {
      const r = await call(u.fnbA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider/resend`, {})
      expect(r.statusCode, `resend ${i + 1}`).toBe(200)
    }
    // The same code each time.
    expect(sent.slice(1).every((m) => m.msg.includes(code))).toBe(true)
    // A different manager hits the same order's limit.
    expect((await call(u.mgmtA!, 'POST', `${base}/orders/${o.id}/send-code-to-rider/resend`, {})).statusCode).toBe(429)
    // Another order has its own budget: NOT_REROUTED, not 429.
    const other = await job(A, riderA)
    const r = await call(u.fnbA!, 'POST', `${base}/orders/${other.id}/send-code-to-rider/resend`, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_REROUTED')
  })
})

describe('the list', () => {
  it('carries codeLocked, doorProblem, cash to collect, stage, rerouted and the recent overrides', async () => {
    const locked = await job(A, riderA, { attempts: 5, cod: 80_000 })
    await prisma.riderJobEvent.create({
      data: { riderId: riderA, orderId: locked.id, tenantId: A.tenantId, riderTenantId: A.tenantId, type: 'door_problem', note: 'unreachable: no answer at the gate' },
    })
    const fresh = await job(A, riderA, { pickedUp: false })
    const rer = await job(A, riderA)
    await call(u.mgmtA!, 'POST', `${base}/orders/${rer.id}/send-code-to-rider`, { reason: 'customer phone is dead' })

    const list = (await call(u.fohA!, 'GET', `${base}/orders`)).json()
    const byId = (id: string) => list.onTheRoad.find((x: { orderId: string }) => x.orderId === id)
    const l = byId(locked.id)
    expect(l).toMatchObject({
      codeLocked: true, cashToCollectCents: 80_000, stage: 'picked_up', codeOnly: true,
      doorProblem: { kind: 'unreachable' }, rerouted: null,
      rider: { id: riderA, name: 'EO Rider A', fleetPartner: null },
    })
    expect(l.ref).toBe(locked.id.slice(-8).toUpperCase())
    expect(l.minutesOut).toBeGreaterThanOrEqual(19)
    expect(byId(fresh.id)).toMatchObject({ codeLocked: false, doorProblem: null, stage: 'accepted', cashToCollectCents: 0 })
    expect(byId(rer.id).rerouted).toMatchObject({ byName: 'eo-mgmt-a' })
    const recent = list.recent.find((x: { orderId: string }) => x.orderId === rer.id)
    expect(recent).toMatchObject({ type: 'code_rerouted', actorName: 'eo-mgmt-a', riderName: 'EO Rider A', note: 'customer phone is dead' })
    // The deliveryOtp is never in the payload.
    const code = (await prisma.order.findUniqueOrThrow({ where: { id: rer.id } })).deliveryOtp!
    expect(JSON.stringify(list)).not.toContain(`"${code}"`)
    expect(JSON.stringify(list)).not.toContain('deliveryOtp"')
  })
})

describe('food came back', () => {
  async function outForDelivery() {
    const customerId = (await prisma.customer.create({ data: { name: `Return guest ${++seq}` } })).id
    const { order } = await ingestOrder({
      source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date().toISOString(),
      customer_id: customerId, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      fulfilment_type: 'delivery',
      items: [{ externalItemId: '', menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 2, unitPriceCents: 100_000, modifiers: [] }],
      payment: { provider: 'cash', amountCents: 200_000, status: 'pending' },
    })
    await deductInventoryForOrder(order.id)
    const now = new Date()
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'ready', customerId, riderId: riderA, riderAssignedAt: now, riderAcceptedAt: now, pickedUpAt: now },
    })
    return { id: order.id, customerId }
  }

  it('preview, then refused end to end: cancelled, COD failed, waste, one strike; a replay is 409', async () => {
    const o = await outForDelivery()
    const pv = await call(u.bohA!, 'GET', `${base}/orders/${o.id}/return-preview`)
    expect(pv.statusCode).toBe(200)
    expect(pv.json()).toEqual({ lines: [{ name: 'Beef Nihari', quantity: 2 }], codToVoidCents: 200_000, paidCents: 0 })

    const r = await call(u.bohA!, 'POST', `${base}/orders/${o.id}/food-returned`, { cause: 'refused', reason: 'Customer refused at the door' })
    expect(r.statusCode).toBe(200)
    const body = r.json()
    expect(body).toMatchObject({ ok: true, codVoidedCents: 200_000, refundDueCents: 0, strike: { recorded: true, duplicate: false } })
    expect(body.wasteLogIds.length).toBeGreaterThan(0)
    expect(body.wasteCostCents).toBeGreaterThan(0)

    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } })
    expect(row.status).toBe('cancelled')
    expect(row.returnedAt).toBeInstanceOf(Date)
    expect(row.returnCause).toBe('refused')
    expect(row.payments.every((p) => p.status === 'failed')).toBe(true)
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'returned' } })
    expect(ev.actorId).toBe(u.bohA!.id)
    expect(ev.tenantId).toBe(A.tenantId)
    expect(await prisma.customerStrike.count({ where: { customerId: o.customerId, sourceId: o.id } })).toBe(1)

    const again = await call(u.bohA!, 'POST', `${base}/orders/${o.id}/food-returned`, { cause: 'refused', reason: 'Customer refused at the door' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_RETURNED')
    expect(await prisma.customerStrike.count({ where: { customerId: o.customerId, sourceId: o.id } })).toBe(1)

    // It shows in recent, not on the road.
    const list = (await call(u.fohA!, 'GET', `${base}/orders`)).json()
    expect(list.onTheRoad.map((x: { orderId: string }) => x.orderId)).not.toContain(o.id)
    expect(list.recent.find((x: { orderId: string; type: string }) => x.orderId === o.id && x.type === 'returned')).toBeTruthy()
  })

  it("'unreachable' records no strike; a bad cause or short reason is 400", async () => {
    const o = await outForDelivery()
    expect((await call(u.fohA!, 'POST', `${base}/orders/${o.id}/food-returned`, { cause: 'stolen', reason: 'no one at the door' })).statusCode).toBe(400)
    expect((await call(u.fohA!, 'POST', `${base}/orders/${o.id}/food-returned`, { cause: 'unreachable', reason: 'no' })).statusCode).toBe(400)
    const r = await call(u.fohA!, 'POST', `${base}/orders/${o.id}/food-returned`, { cause: 'unreachable', reason: 'No answer on the phone' })
    expect(r.statusCode).toBe(200)
    expect(r.json().strike).toBeNull()
    expect(await prisma.customerStrike.count({ where: { customerId: o.customerId } })).toBe(0)
  })
})
