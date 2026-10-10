// Public discount endpoint scoping.
//
// GET /discounts/active is unauthenticated on purpose — the public menu shows
// a live discount before anyone signs in. That makes its where-clause the only
// boundary between one company's pricing and every other company's, and it had
// two fail-open holes:
//
//   1. `conceptId` was declared required in the type but never checked. Omitted,
//      Prisma sees `{ conceptId: undefined }` and drops the condition, so the
//      OR collapsed to `[{}, …]` — every active discount in the database, for
//      every company.
//   2. `{ conceptId: null }` matched "all brands" rows. SectionDiscount carries
//      no tenantId, so such a row belongs to no company and was served to all.
//
// These tests build two companies with their own brands plus a legacy global
// row, and assert a caller can only ever see the brand they asked for.

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { PrismaClient } from '@prisma/client'
import { discountRoutes } from '../src/modules/discounts/routes.js'
import { AppError } from '../src/lib/errors.js'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

// In-process (app.inject), like every other suite: this file used to fetch()
// a separate API on :3011 that nothing ever started.
let app: FastifyInstance

const stamp = Date.now()
const ids: { tenantA?: string; tenantB?: string; conceptA?: string; conceptB?: string } = {}
const discountIds: string[] = []

const window = () => {
  const now = new Date()
  return {
    startDate: new Date(now.getTime() - 86_400_000),
    endDate: new Date(now.getTime() + 86_400_000),
    startTime: '00:00',
    endTime: '23:59',
  }
}

beforeAll(async () => {
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: String((err as Error).message) } })
  })
  await app.register(discountRoutes, { prefix: '/api/v1/discounts' })
  await app.ready()

  const a = await prisma.tenant.create({ data: { name: `A${stamp}`, slug: `a-${stamp}` } })
  const b = await prisma.tenant.create({ data: { name: `B${stamp}`, slug: `b-${stamp}` } })
  ids.tenantA = a.id; ids.tenantB = b.id

  const ca = await prisma.concept.create({
    data: { name: 'CA', slug: `ca-${stamp}`, type: 'restaurant', tenantId: a.id, isActive: true },
  })
  const cb = await prisma.concept.create({
    data: { name: 'CB', slug: `cb-${stamp}`, type: 'restaurant', tenantId: b.id, isActive: true },
  })
  ids.conceptA = ca.id; ids.conceptB = cb.id

  const w = window()
  const mk = async (conceptId: string | null, pct: number) => {
    const d = await prisma.sectionDiscount.create({
      data: { conceptId, discountPercent: pct, isActive: true, ...w },
    })
    discountIds.push(d.id)
    return d
  }
  await mk(ca.id, 11)    // company A's own
  await mk(cb.id, 22)    // company B's own — must never reach a caller asking for A
  await mk(null, 33)     // legacy "all brands" row, owned by nobody
})

afterAll(async () => {
  await app.close()
  await prisma.sectionDiscount.deleteMany({ where: { id: { in: discountIds } } })
  await prisma.concept.deleteMany({ where: { id: { in: [ids.conceptA!, ids.conceptB!] } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [ids.tenantA!, ids.tenantB!] } } })
})

const get = async (qs: string) => {
  const r = await app.inject({ method: 'GET', url: `/api/v1/discounts/active${qs}` })
  let body: unknown = null
  try { body = r.json() } catch { /* not JSON */ }
  return { status: r.statusCode, body }
}

describe('GET /discounts/active — public, so scoping is the only boundary', () => {
  test('a brand sees only its OWN discount', async () => {
    const r = await get(`?conceptId=${ids.conceptA}`)
    expect(r.status).toBe(200)
    const pcts = (r.body as Array<{ discountPercent: number }>).map((d) => d.discountPercent).sort()
    expect(pcts).toEqual([11])
  })

  test("another company's discount never leaks", async () => {
    const r = await get(`?conceptId=${ids.conceptA}`)
    const pcts = (r.body as Array<{ discountPercent: number }>).map((d) => d.discountPercent)
    expect(pcts).not.toContain(22)
  })

  test('the ownerless "all brands" row is not served to anyone', async () => {
    for (const c of [ids.conceptA, ids.conceptB]) {
      const r = await get(`?conceptId=${c}`)
      const pcts = (r.body as Array<{ discountPercent: number }>).map((d) => d.discountPercent)
      expect(pcts).not.toContain(33)
    }
  })

  test('omitting conceptId is refused, not treated as "everything"', async () => {
    // This is the regression that mattered: before the fix this returned 200
    // with every active discount in the database.
    const r = await get('')
    expect(r.status).toBe(400)
    expect((r.body as { error?: { code?: string } })?.error?.code).toBe('CONCEPT_REQUIRED')
  })

  test('a junk conceptId is refused rather than pattern-matched', async () => {
    const r = await get('?conceptId=--')
    expect(r.status).toBe(400)
  })
})
