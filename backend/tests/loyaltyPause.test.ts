// Loyalty paused servd-wide (owner, 2026-10-22: "stop the Loyalty points
// section for now … until then no amount should go to loyalty points
// account"). lib/loyaltyPause.ts — absent = PAUSED.
//   - paused: no earn (no loyalty row, no 2060 entry), redeem refused 409,
//     expiry does nothing, the point value cannot change
//   - only the CEO switches it (PUT /loyalty/pause); switched on, earns work
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { creditPoints, quoteRedemption, loyaltyAccountOf } from '../src/modules/loyalty/service.js'
import { writeLoyaltySettingsWithRevaluation, pointValueCentsTx } from '../src/modules/loyalty/revaluation.js'
import { runExpirationSweep } from '../src/workers/loyaltyExpiration.js'
import { resetLoyaltyPauseCache, isLoyaltyPaused } from '../src/lib/loyaltyPause.js'

const P = `lp${Date.now()}`
let app: FastifyInstance
let T = ''
let customerId = ''
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@lp.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId: T, tenantMemberships: { create: [{ tenant: { connect: { id: T } }, role: 'member' }] },
    },
  })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const loyaltyEntries = () => prisma.journalEntry.count({ where: { tenantId: T, lines: { some: { account: { code: '2060' } } } } })

beforeAll(async () => {
  T = (await prisma.tenant.create({ data: { name: 'LP Co', slug: `${P}-t` } })).id
  await ensureChartOfAccounts(T)
  await mkUser('ceo', 'admin')
  await mkUser('mkt', 'marketing')
  customerId = (await prisma.customer.create({ data: { name: 'Guest', email: `${P}@lp.test` } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('loyalty paused', () => {
  // Paused = the setting absent (live today). Here, not in the file's beforeAll: tests/setup.ts
  // switches loyalty ON for the rest of the suite and its hook runs after the file's root hook.
  beforeAll(async () => {
    await prisma.setting.deleteMany({ where: { key: 'loyalty.paused' } })
    resetLoyaltyPauseCache()
  })

  it('absent switch = paused: nothing earned, nothing booked to 2060', async () => {
    expect(await isLoyaltyPaused()).toBe(true)
    const r = await creditPoints({ customerId, points: 50, description: 'Birthday bonus', tenantId: T })
    expect(r.credited).toBe(false)
    expect(await prisma.loyaltyTransaction.count({ where: { loyaltyAccount: { customerId } } })).toBe(0)
    expect(await loyaltyEntries()).toBe(0)
  })

  it('redeeming is refused; asking for no points is fine', async () => {
    await expect(quoteRedemption({ customerId, requestedPoints: 10, tenantId: T, capCents: 10_000 })).rejects.toMatchObject({ code: 'LOYALTY_PAUSED' })
    expect((await quoteRedemption({ customerId, requestedPoints: 0, tenantId: T, capCents: 10_000 })).points).toBe(0)
  })

  it('the point value cannot change; the expiry sweep does nothing', async () => {
    const cur = await pointValueCentsTx(prisma, T)
    await expect(writeLoyaltySettingsWithRevaluation(T, [['loyalty.point_value_cents', cur + 1]])).rejects.toMatchObject({ code: 'LOYALTY_PAUSED' })
    await writeLoyaltySettingsWithRevaluation(T, [['loyalty.point_value_cents', cur]])   // unchanged value passes
    await runExpirationSweep()
    expect(await prisma.loyaltyTransaction.count({ where: { type: 'expire' } })).toBe(0)
  })

  it('only the CEO switches it; switched on, points are earned again', async () => {
    const no = await app.inject({ method: 'PUT', url: '/loyalty/pause', headers: { authorization: `Bearer ${tokens.mkt}` }, payload: { paused: false, reason: 'Opening the programme' } })
    expect(no.statusCode).toBe(403)
    const yes = await app.inject({ method: 'PUT', url: '/loyalty/pause', headers: { authorization: `Bearer ${tokens.ceo}` }, payload: { paused: false, reason: 'Opening the programme' } })
    expect(yes.statusCode, yes.body).toBe(200)
    expect(yes.json().paused).toBe(false)
    const program = (await app.inject({ method: 'GET', url: '/loyalty/program' })).json()
    expect(program.paused).toBe(false)
    const r = await creditPoints({ customerId, points: 50, description: 'Birthday bonus', tenantId: T })
    expect(r.credited).toBe(true)
    expect((await loyaltyAccountOf(customerId, T))?.pointsBalance).toBe(50)
    expect(await prisma.auditLog.count({ where: { action: 'loyalty.resume' } })).toBe(1)
  })
})
