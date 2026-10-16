// Combining companies (POST /tenants/merge) — the bell's notifications follow
// their company (a plain repoint: the (userId, dedupeKey) key has no company,
// so nothing can clash), and the target's own rows are untouched.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0
let ceo: Who

async function company(name: string): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name: `TMN ${name}`, slug: `tmn-${++seq}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  await prisma.tenantMember.create({ data: { tenantId: id, userId: ceo.id } })
  return id
}

beforeAll(async () => {
  ceo = await mkUser('tmn-ceo', 'admin', null)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('notifications move with their company', () => {
  it('repoints the source company\'s notifications to the target', async () => {
    const S = await company('Source')
    const D = await company('Target')
    // The same dedupe key on both sides for the same person: still no clash.
    const src = await prisma.staffNotification.create({ data: { userId: ceo.id, tenantId: S, kind: 'exception', title: 'S', dedupeKey: 'exception:s1' } })
    const dst = await prisma.staffNotification.create({ data: { userId: ceo.id, tenantId: D, kind: 'exception', title: 'D', dedupeKey: 'exception:d1' } })
    const res = await app.inject({
      method: 'POST', url: '/tenants/merge',
      headers: { authorization: `Bearer ${ceo.token}` }, payload: { sourceId: S, targetId: D },
    })
    expect(res.statusCode, res.body).toBe(200)
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: src.id } })).tenantId).toBe(D)
    expect((await prisma.staffNotification.findUniqueOrThrow({ where: { id: dst.id } })).tenantId).toBe(D)
    expect(await prisma.staffNotification.count({ where: { tenantId: S } })).toBe(0)
  })
})
