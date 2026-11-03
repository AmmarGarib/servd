// Creating a brand on a web address another live brand already uses (owner, 2026-11-03: the hidden "G's Kitchen"
// held /g-s-kitchen and onboarding answered "Internal server error") is a clear 409 SLUG_TAKEN, never a 500.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'

let app: FastifyInstance; let A: Company; let ceo: Who
beforeAll(async () => {
  A = await mkCompany(`slug-${Date.now()}`)
  ceo = await mkUser('slug-ceo', 'admin', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

describe('brand web address already taken', () => {
  it('409 SLUG_TAKEN, and nothing is created', async () => {
    const taken = (await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).slug
    const before = await prisma.concept.count()
    const r = await app.inject({
      method: 'POST', url: '/concepts', headers: { authorization: `Bearer ${ceo.token}` },
      payload: { name: 'Second kitchen', slug: taken, type: 'restaurant', serviceVessel: 'plate' },
    })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('SLUG_TAKEN')
    expect(await prisma.concept.count()).toBe(before)
  })
})
