// Customer ordering switched off servd-wide (owner, 2026-10-27: "ordering needs to be off on all brands for
// now"). lib/onlineOrdering.ts — absent = OFF; orderingState answers closed for every brand.
//   - off (absent or on:false): every brand closed, whatever its hours
//   - only the CEO switches it (PUT /ordering-switch, reason ≥10, audited); switched on, hours decide again
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { orderingSwitchRoutes } from '../src/modules/storefront/orderingSwitchRoutes.js'
import { orderingState } from '../src/modules/storefront/serviceHours.js'
import { resetOnlineOrderingCache } from '../src/lib/onlineOrdering.js'

const P = `oo${Date.now()}`
let app: FastifyInstance
let T = ''
let concept = { id: '', name: 'Flipd' }
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@oo.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId: T, tenantMemberships: { create: [{ tenant: { connect: { id: T } }, role: 'member' }] },
    },
  })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const put = (who: string, body: unknown) => app.inject({ method: 'PUT', url: '/ordering-switch', headers: { authorization: `Bearer ${tokens[who]}` }, payload: body as object })

beforeAll(async () => {
  T = (await prisma.tenant.create({ data: { name: 'OO Co', slug: `${P}-t` } })).id
  const c = await prisma.concept.create({ data: { name: 'Flipd', slug: `${P}-flipd`, type: 'restaurant', tenantId: T, taxRateCash: 15, taxRateCard: 8 } })
  concept = { id: c.id, name: c.name }
  // No service hours = open every day (serviceHours.ts), so only the switch can close it.
  await mkUser('ceo', 'admin')
  await mkUser('mgr', 'foh_management')
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(orderingSwitchRoutes, { prefix: '/ordering-switch' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Leave the suite as tests/setup.ts set it: ordering ON.
  await prisma.setting.upsert({ where: { key: 'ordering.online' }, create: { key: 'ordering.online', value: '{"on":true}' }, update: { value: '{"on":true}' } })
  resetOnlineOrderingCache()
  await app?.close()
})

describe('customer ordering switch', () => {
  it('absent = off: every brand is closed, whatever its hours', async () => {
    await prisma.setting.deleteMany({ where: { key: 'ordering.online' } })
    resetOnlineOrderingCache()
    const s = await orderingState(concept, new Date())
    expect(s.open).toBe(false)
    expect(s.message).toMatch(/isn't taking orders online yet/)
  })

  it('only the CEO switches it, with a reason; on = the hours decide again', async () => {
    expect((await put('mgr', { on: true, reason: 'opening the kitchen now' })).statusCode).toBe(403)
    expect((await put('ceo', { on: true, reason: 'short' })).statusCode).toBe(400)
    const on = await put('ceo', { on: true, reason: 'We are open for orders' })
    expect(on.statusCode, on.body).toBe(200)
    expect(on.json().on).toBe(true)
    expect((await orderingState(concept, new Date())).open).toBe(true)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'ordering.online.on', entityId: 'ordering.online' }, orderBy: { createdAt: 'desc' } })
    expect(audit).toBeTruthy()

    const off = await put('ceo', { on: false, reason: 'Closed until the opening' })
    expect(off.json().on).toBe(false)
    expect((await orderingState(concept, new Date())).open).toBe(false)
  })
})
