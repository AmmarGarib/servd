// FOH-01 (till audit, 2026-10-10): cashiers and waiters got 403 on the brand
// list, so the admin till showed no brands and nothing could be rung.
//
//   - GET /concepts and GET /concepts/:id now admit the till roles (cashier,
//     foh) — scoped to the caller's company in read scope, active brands only,
//     and the narrow till fields (no strategy brief, legal/tax registration,
//     FBR/SRB POS ids, legacy taxRate).
//   - Company B's cashier sees only B's brands, and A's brand id 404s.
//   - A staffer with no company sees nothing (an empty scope denies).
//   - Write access is NOT widened: POST/PATCH/DELETE stay management/CEO.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')

const PREFIX = `tillui-${Date.now()}`
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string, conceptB2: string, conceptBRetired: string, conceptNoCompany: string
const users: string[] = []

async function staff(role: UserRole, tenantId: string | null) {
  const n = users.length + 1
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${role} ${n}`,
      email: `${PREFIX}.${role}.${n}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role,
      tenantId,
      isActive: true,
      accountStatus: 'active',
      ...(tenantId && { tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] } }),
    },
    select: { id: true, name: true, email: true, role: true },
  })
  users.push(u.id)
  const s = issueStaffSession({ id: u.id, name: u.name ?? '', email: u.email, role: u.role })
  return { authorization: `Bearer ${s.accessToken}` }
}

let cashierB: Record<string, string>
let waiterB: Record<string, string>
let managerA: Record<string, string>
let cashierNoCompany: Record<string, string>

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Till UI A', slug: `${PREFIX}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Till UI B', slug: `${PREFIX}-b` } })).id
  const mk = (slug: string, tenantId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.concept.create({
      data: {
        name: slug, slug, tenantId, type: 'restaurant',
        taxRate: 17, taxRateCash: 15, taxRateCard: 8,
        strn: 'STRN-SECRET', ntn: 'NTN-SECRET', conceptStatement: 'strategy brief', ...extra,
      },
    })
  conceptA = (await mk(`${PREFIX}-a1`, tenantA)).id
  conceptB = (await mk(`${PREFIX}-b1`, tenantB)).id
  conceptB2 = (await mk(`${PREFIX}-b2`, tenantB, { taxRateCash: 16, taxRateCard: 5 })).id
  conceptBRetired = (await mk(`${PREFIX}-b3`, tenantB, { isActive: false })).id
  conceptNoCompany = (await mk(`${PREFIX}-none`, null)).id

  cashierB = await staff('cashier', tenantB)
  waiterB = await staff('foh', tenantB)
  managerA = await staff('management', tenantA)
  cashierNoCompany = await staff('cashier', null)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  if (!tenantA || !tenantB) return
  await prisma.tenantMember.deleteMany({ where: { userId: { in: users } } })
  await prisma.user.deleteMany({ where: { id: { in: users } } })
  await prisma.concept.deleteMany({ where: { slug: { startsWith: PREFIX } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

const TILL_FIELDS = ['id', 'isActive', 'logoUrl', 'name', 'primaryColor', 'slug', 'taxRateCard', 'taxRateCash', 'tenantId', 'type']

describe('FOH-01: till roles can read their own company\'s brands', () => {
  it('company B\'s cashier lists only B\'s active brands, with the till fields only', async () => {
    const r = await app.inject({ method: 'GET', url: '/concepts', headers: cashierB })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.map((c) => c.id).sort()).toEqual([conceptB, conceptB2].sort())
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(TILL_FIELDS)
      expect(row.tenantId).toBe(tenantB)
      // Never the legacy single rate, tax registration or the strategy brief.
      expect(row).not.toHaveProperty('taxRate')
      expect(row).not.toHaveProperty('strn')
      expect(row).not.toHaveProperty('conceptStatement')
    }
    const b2 = rows.find((c) => c.id === conceptB2)!
    expect(b2.taxRateCash).toBe(16)
    expect(b2.taxRateCard).toBe(5)
  })

  it('a waiter (foh) gets the same list', async () => {
    const r = await app.inject({ method: 'GET', url: '/concepts', headers: waiterB })
    expect(r.statusCode).toBe(200)
    expect((r.json() as Array<{ id: string }>).map((c) => c.id).sort()).toEqual([conceptB, conceptB2].sort())
  })

  it('retired brands stay hidden from the till, even when asked for', async () => {
    const r = await app.inject({ method: 'GET', url: '/concepts?includeInactive=1', headers: cashierB })
    expect(r.statusCode).toBe(200)
    expect((r.json() as Array<{ id: string }>).map((c) => c.id)).not.toContain(conceptBRetired)
  })

  it('portfolio and active-company headers cannot reach a company the cashier is not in', async () => {
    const r = await app.inject({
      method: 'GET', url: '/concepts',
      headers: { ...cashierB, 'x-servd-portfolio': '1', 'x-servd-active-tenant': tenantA },
    })
    expect(r.statusCode).toBe(200)
    const ids = (r.json() as Array<{ id: string }>).map((c) => c.id)
    expect(ids).not.toContain(conceptA)
    expect(ids.sort()).toEqual([conceptB, conceptB2].sort())
  })

  it('company B\'s cashier cannot read A\'s brand by id (404), but reads B\'s', async () => {
    const foreign = await app.inject({ method: 'GET', url: `/concepts/${conceptA}`, headers: cashierB })
    expect(foreign.statusCode).toBe(404)
    const own = await app.inject({ method: 'GET', url: `/concepts/${conceptB}`, headers: cashierB })
    expect(own.statusCode).toBe(200)
    expect(Object.keys(own.json()).sort()).toEqual(TILL_FIELDS)
    const retired = await app.inject({ method: 'GET', url: `/concepts/${conceptBRetired}`, headers: cashierB })
    expect(retired.statusCode).toBe(404)
  })

  it('a staffer with no company sees nothing — never the company-less brands', async () => {
    const list = await app.inject({ method: 'GET', url: '/concepts', headers: cashierNoCompany })
    expect(list.statusCode).toBe(200)
    expect(list.json()).toEqual([])
    const one = await app.inject({ method: 'GET', url: `/concepts/${conceptNoCompany}`, headers: cashierNoCompany })
    expect(one.statusCode).toBe(404)
  })

  it('management still gets the full rows, of its own company only', async () => {
    const r = await app.inject({ method: 'GET', url: '/concepts', headers: managerA })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.map((c) => c.id)).toEqual([conceptA])
    expect(rows[0]).toHaveProperty('strn', 'STRN-SECRET')
    const foreign = await app.inject({ method: 'GET', url: `/concepts/${conceptB}`, headers: managerA })
    expect(foreign.statusCode).toBe(404)
    const own = await app.inject({ method: 'GET', url: `/concepts/${conceptA}`, headers: managerA })
    expect(own.statusCode).toBe(200)
    expect(own.json()).toHaveProperty('conceptStatement', 'strategy brief')
  })

  it('write access is not widened: a cashier cannot create, edit or delete a brand', async () => {
    const create = await app.inject({
      method: 'POST', url: '/concepts', headers: cashierB,
      payload: { name: 'x', slug: `${PREFIX}-x`, type: 'restaurant' },
    })
    expect(create.statusCode).toBe(403)
    const patch = await app.inject({ method: 'PATCH', url: `/concepts/${conceptB}`, headers: cashierB, payload: { name: 'hijacked' } })
    expect(patch.statusCode).toBe(403)
    const del = await app.inject({ method: 'DELETE', url: `/concepts/${conceptB}`, headers: waiterB })
    expect(del.statusCode).toBe(403)
    const still = await prisma.concept.findUniqueOrThrow({ where: { id: conceptB }, select: { name: true, deletedAt: true } })
    expect(still).toEqual({ name: `${PREFIX}-b1`, deletedAt: null })
  })
})
