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

let conceptA: string
let conceptB: string
let app: FastifyInstance
const tokens: Record<string, string> = {}

async function mkUser(key: string, primary: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.sepops@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: 'admin', isActive: true, accountStatus: 'active', tenantId: primary,
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
  await mkUser('a', tA)
  await mkUser('b', tB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(opsReportRoutes, { prefix: '/ops' })
  await app.ready()
})

describe('ops reports — company separation', () => {
  it('prep list: each company gets its own brand, never the other', async () => {
    expect((await get('a', `/ops/prep-list?conceptId=${conceptA}`)).statusCode).toBe(200)
    expect((await get('b', `/ops/prep-list?conceptId=${conceptB}`)).statusCode).toBe(200)
    expect((await get('b', `/ops/prep-list?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await get('a', `/ops/prep-list?conceptId=${conceptB}`)).statusCode).toBe(404)
  })

  it('prep list without a brand is refused, not "everything"', async () => {
    expect((await get('a', '/ops/prep-list')).statusCode).toBe(400)
  })

  it('anomalies: a foreign brand id gives nothing from that brand', async () => {
    const r = await get('b', `/ops/anomalies?conceptId=${conceptA}`)
    expect([200, 404]).toContain(r.statusCode)
    if (r.statusCode === 200) expect(JSON.stringify(r.json())).not.toContain(conceptA)
  })
})
