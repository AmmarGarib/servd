// Automatic check-in only on the office network (owner, 2026-10-22: "It should
// happen only when someone open servd on Office wifi").
//   - networkKey: IPv4 exact, IPv6 by /64, IPv4-mapped IPv6 read as IPv4
//   - HR registers a network per company; /time-clock/status says
//     onOfficeNetwork only from a network of the caller's OWN company
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { networkKey, onOfficeNetwork } from '../src/lib/officeNetwork.js'

describe('networkKey', () => {
  it('reads IPv4, IPv4-mapped and IPv6 /64', () => {
    expect(networkKey('39.45.1.2')).toBe('39.45.1.2')
    expect(networkKey('::ffff:39.45.1.2')).toBe('39.45.1.2')
    expect(networkKey('2400:adc1:1a2:3b00:1111:2222:3333:4444')).toBe('2400:adc1:1a2:3b00::/64')
    expect(networkKey('2400:adc1:1a2:3b00::9')).toBe('2400:adc1:1a2:3b00::/64')
    expect(networkKey('nonsense')).toBeNull()
    expect(onOfficeNetwork('2400:adc1:1a2:3b00:aaaa::1', [{ address: '2400:adc1:1a2:3b00::5', label: 'Office' }])).toBe(true)
    expect(onOfficeNetwork('39.45.1.3', [{ address: '39.45.1.2', label: 'Office' }])).toBe(false)
  })
})

const P = `ofn${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const users: Record<string, string> = {}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@ofn.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, method: 'GET' | 'PUT' | 'POST', url: string, ip: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, remoteAddress: ip, headers: { authorization: `Bearer ${users[who]}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'OFN A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'OFN B', slug: `${P}-b` } })).id
  await mkUser('hrA', 'hr', T.A)
  await mkUser('staffA', 'kitchen', T.A)
  await mkUser('staffB', 'kitchen', T.B)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(timeClockRoutes, { prefix: '/time-clock' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('office networks', () => {
  it('HR adds the network it is on; only that company\'s staff on it are "on the office network"', async () => {
    const cur = await call('hrA', 'GET', '/hr/settings/current-network', '39.45.1.2')
    expect(cur.statusCode, cur.body).toBe(200)
    expect(cur.json()).toEqual({ address: '39.45.1.2', registered: false })
    const bad = await call('hrA', 'PUT', '/hr/settings', '39.45.1.2', { ...(await call('hrA', 'GET', '/hr/settings', '39.45.1.2')).json(), officeNetworks: [{ address: 'x', label: 'Office' }] })
    expect(bad.statusCode).toBe(400)
    const settings = (await call('hrA', 'GET', '/hr/settings', '39.45.1.2')).json()
    const put = await call('hrA', 'PUT', '/hr/settings', '39.45.1.2', { ...settings, officeNetworks: [{ address: '39.45.1.2', label: 'Head office Wi-Fi' }] })
    expect(put.statusCode, put.body).toBe(200)
    expect((await call('hrA', 'GET', '/hr/settings/current-network', '39.45.1.2')).json().registered).toBe(true)

    expect((await call('staffA', 'GET', '/time-clock/status', '39.45.1.2')).json().onOfficeNetwork).toBe(true)
    expect((await call('staffA', 'GET', '/time-clock/status', '182.180.9.9')).json().onOfficeNetwork).toBe(false)
    // Company B registered nothing: A's office network is not B's.
    expect((await call('staffB', 'GET', '/time-clock/status', '39.45.1.2')).json().onOfficeNetwork).toBe(false)
  })

  it('two check-ins at the same moment write one punch', async () => {
    const [a, b] = await Promise.all([1, 2].map(() => call('staffA', 'POST', '/time-clock/punch-in', '39.45.1.2', {})))
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([200, 201])
    const me = await prisma.user.findFirstOrThrow({ where: { email: `${P}.staffA@ofn.pk` } })
    expect(await prisma.clockLog.count({ where: { userId: me.id, type: 'in' } })).toBe(1)
  })
})
