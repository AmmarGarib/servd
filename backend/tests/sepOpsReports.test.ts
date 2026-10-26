// Prep list and anomalies are company-scoped: company B never sees company A's
// brand, and an empty scope denies rather than falling open.
import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { opsReportRoutes } from '../src/modules/opsReports/routes.js'
import { kitchenRoutes } from '../src/modules/kitchen/routes.js'

let conceptA: string
let conceptB: string
let locA: string
let locB: string
let app: FastifyInstance
const tokens: Record<string, string> = {}

async function mkUser(key: string, primary: string, role = 'admin', moduleDeny: string[] = []) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.sepops@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, isActive: true, accountStatus: 'active', tenantId: primary, moduleDeny,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}

const get = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tokens[who]}` } })

beforeAll(async () => {
  const tA = (await prisma.tenant.create({ data: { name: 'Ops A', slug: 'sepops-a' } })).id
  const tB = (await prisma.tenant.create({ data: { name: 'Ops B', slug: 'sepops-b' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Ops Cafe A', slug: 'sepops-cafe-a', type: 'restaurant', tenantId: tA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Ops Cafe B', slug: 'sepops-cafe-b', type: 'restaurant', tenantId: tB } })).id
  locA = (await prisma.location.create({ data: { slug: 'sepops-loc-a', name: 'Outlet A', tenantId: tA } })).id
  locB = (await prisma.location.create({ data: { slug: 'sepops-loc-b', name: 'Outlet B', tenantId: tB } })).id
  await prisma.conceptLocation.create({ data: { conceptId: conceptA, locationId: locA, isPrimary: true } })
  await prisma.conceptLocation.create({ data: { conceptId: conceptB, locationId: locB, isPrimary: true } })
  await mkUser('a', tA)
  await mkUser('b', tB)
  await mkUser('bohA', tA, 'boh')
  await mkUser('bohNoStock', tA, 'boh', ['inventory', 'par_sheet'])
  await mkUser('itA', tA, 'it')
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(opsReportRoutes, { prefix: '/ops' })
  await app.register(kitchenRoutes, { prefix: '/kitchen' })
  await app.ready()
})

describe('ops reports — company separation', () => {
  it('prep list: each company gets its own brand, never the other', async () => {
    expect((await get('a', `/kitchen/prep-list?locationId=${locA}`)).statusCode).toBe(200)
    expect((await get('b', `/kitchen/prep-list?locationId=${locB}`)).statusCode).toBe(200)
    expect((await get('b', `/kitchen/prep-list?locationId=${locA}`)).statusCode).toBe(404)
    expect((await get('a', `/kitchen/prep-list?locationId=${locB}`)).statusCode).toBe(404)
  })

  it('prep list without an outlet is refused, not "everything"; the old /ops/prep-list is gone (one prep list)', async () => {
    expect((await get('a', '/kitchen/prep-list')).statusCode).toBe(400)
    expect((await get('a', `/ops/prep-list?conceptId=${conceptA}`)).statusCode).toBe(404)
  })

  it('anomalies: a foreign brand id gives nothing from that brand', async () => {
    const r = await get('b', `/ops/anomalies?conceptId=${conceptA}`)
    expect([200, 404]).toContain(r.statusCode)
    if (r.statusCode === 200) expect(JSON.stringify(r.json())).not.toContain(conceptA)
  })
})

describe('prep list — opened to the kitchen (owner 2026-10-16: Inventory links to the prep list)', () => {
  it('BOH with the inventory module reads its own brand, never the other company', async () => {
    expect((await get('bohA', `/kitchen/prep-list?locationId=${locA}`)).statusCode).toBe(200)
    expect((await get('bohA', `/kitchen/prep-list?locationId=${locB}`)).statusCode).toBe(404)
  })
  it('a login without ops, inventory or par_sheet is refused', async () => {
    expect((await get('itA', `/kitchen/prep-list?locationId=${locA}`)).statusCode).toBe(403)
    expect((await get('bohNoStock', `/kitchen/prep-list?locationId=${locA}`)).statusCode).toBe(403)
  })
})
