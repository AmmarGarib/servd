// Dashboard starter numbers (owner, 2026-10-26, C4): company B's numbers never include company A's sales / headcount;
// money is hidden from roles that may not see it; a bad dashboard id is 404; a role without the module is 403.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { dashboardRoutes } from '../src/modules/dashboards/routes.js'

const P = `dsh${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const C: Record<string, string> = {}
const tok: Record<string, string> = {}
const O: string[] = []

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@dsh.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok[who]}` } })
type N = { key: string; value: number | null; hidden?: boolean; breakdown?: Array<{ label: string; value: number | null }> }
const numbers = (r: { json: () => unknown }) => Object.fromEntries((r.json() as { numbers: N[] }).numbers.map((n) => [n.key, n]))

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'DSH A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'DSH B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} A`, slug: `${P}-ca`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} B`, slug: `${P}-cb`, type: 'restaurant', tenantId: T.B } })).id
  await mkUser('ceoA', 'admin', T.A!)
  await mkUser('ceoB', 'admin', T.B!)
  await mkUser('cashierA', 'cashier', T.A!)
  const mk = async (conceptId: string, total: number, n: number, status: string, partySize: number) => {
    const o = await prisma.order.create({
      data: { conceptId, source: 'pos', externalId: `${P}-${n}`, status, placedAt: new Date(), completedAt: status === 'completed' ? new Date() : null, totalCents: total, partySize } as never,
    })
    O.push(o.id)
  }
  await mk(C.A!, 5000_00, 1, 'completed', 4)
  await mk(C.A!, 5000_00, 2, 'completed', 2)
  await mk(C.A!, 1000_00, 3, 'preparing', 1)
  await mk(C.B!, 700_00, 4, 'completed', 1)
  for (let i = 0; i < 3; i++) await prisma.hrEmployee.create({ data: { tenantId: T.A!, employeeCode: `A-${i}`, fullName: `A person ${i}` } })
  await prisma.hrEmployee.create({ data: { tenantId: T.B!, employeeCode: 'B-1', fullName: 'B person' } })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { message: (err as Error).message } })
  })
  await app.register(dashboardRoutes, { prefix: '/dashboards' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: O } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await prisma.concept.deleteMany({ where: { id: { in: [C.A!, C.B!] } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: P } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [T.A!, T.B!] } } })
  await app.close()
})

describe('dashboard numbers', () => {
  it('company A sees its own sales, tickets and headcount; company B sees only its own', async () => {
    const a = numbers(await get('ceoA', '/dashboards/finance/numbers'))
    expect(a.sales!.value).toBeGreaterThan(0)
    const opsA = numbers(await get('ceoA', '/dashboards/operations/numbers'))
    expect(opsA.open_tickets!.value).toBe(1)
    expect(opsA.covers!.value).toBe(6)
    const hrA = numbers(await get('ceoA', '/dashboards/hr/numbers'))
    expect(hrA.headcount!.value).toBe(3)

    const b = numbers(await get('ceoB', '/dashboards/finance/numbers'))
    expect(b.sales!.value).toBeGreaterThan(0)
    expect(b.sales!.value!).toBeLessThan(a.sales!.value!)
    const opsB = numbers(await get('ceoB', '/dashboards/operations/numbers'))
    expect(opsB.open_tickets!.value).toBe(0)
    expect(opsB.covers!.value).toBe(1)
    expect(opsB.sales_by_brand!.breakdown!.map((r) => r.label)).toEqual([`${P} B`])
    expect(numbers(await get('ceoB', '/dashboards/hr/numbers')).headcount!.value).toBe(1)
  })
  it('a failing source never fails the call; marketing and CEO sets answer', async () => {
    const r = await get('ceoA', '/dashboards/ceo/numbers')
    expect(r.statusCode).toBe(200)
    expect((r.json() as { numbers: N[] }).numbers.map((n) => n.key)).toEqual(['sales_by_brand', 'food_cost_pct', 'cash_bank', 'approvals_waiting'])
    const m = numbers(await get('ceoA', '/dashboards/marketing/numbers'))
    expect(m.orders_by_channel!.value).toBe(2)
  })
  it('unknown dashboard 404; a role without the module 403; money hidden from non-viewers', async () => {
    expect((await get('ceoA', '/dashboards/nope/numbers')).statusCode).toBe(404)
    expect((await get('cashierA', '/dashboards/hr/numbers')).statusCode).toBe(403)
    const ops = await get('cashierA', '/dashboards/operations/numbers')
    expect(ops.statusCode).toBe(200)
    expect((ops.json() as { moneyHidden: boolean }).moneyHidden).toBe(true)
    const s = numbers(ops).sales_by_brand!
    expect(s.hidden).toBe(true)
    expect(s.value).toBeNull()
  })
})
