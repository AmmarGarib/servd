// HR → Org setup business units (HR, 2026-11-03: "I want to edit the code, but the system only allows me to edit the
// name. If I deactivate the existing entry and try to create a new one with the correct code, it doesn't allow me").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance; let A: Company; let B: Company; let ceo: Who; let ceoB: Who
const call = (who: Who, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`hrou-a-${Date.now()}`); B = await mkCompany(`hrou-b-${Date.now()}`)
  ceo = await mkUser('hrouCeo', 'admin', A.tenantId); ceoB = await mkUser('hrouCeoB', 'admin', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

describe('business units', () => {
  it('edits the code; a deactivated duplicate says reactivate; a rename onto a taken name is 409; company B 404', async () => {
    const made = await call(ceo, 'POST', '/hr/org/units', { kind: 'business_unit', name: 'Food & Beverage', code: 'SUB-KOP-001' })
    expect(made.statusCode, made.body).toBe(201)
    const id = made.json().id
    const ed = await call(ceo, 'PATCH', `/hr/org/units/${id}`, { name: 'Food & Beverage', code: 'BU-FB-001' })
    expect(ed.statusCode, ed.body).toBe(200)
    expect((await prisma.hrOrgUnit.findUniqueOrThrow({ where: { id } })).code).toBe('BU-FB-001')

    await call(ceo, 'PATCH', `/hr/org/units/${id}`, { isActive: false })
    const dup = await call(ceo, 'POST', '/hr/org/units', { kind: 'business_unit', name: 'food & beverage', code: 'X' })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.message).toContain('Reactivate')

    await call(ceo, 'POST', '/hr/org/units', { kind: 'business_unit', name: 'Retail' })
    const clash = await call(ceo, 'PATCH', `/hr/org/units/${id}`, { name: 'Retail' })
    expect(clash.statusCode).toBe(409)
    expect((await call(ceoB, 'PATCH', `/hr/org/units/${id}`, { code: 'HACK' })).statusCode).toBe(404)
  })
})
