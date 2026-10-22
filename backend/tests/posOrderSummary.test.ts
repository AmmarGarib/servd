// Till Order Summary list (owner, 2026-10-22): GET /pos/orders/summary.
//   - one brand, one Karachi day: counts per tab (running / settled / voided),
//     No Charge = a paid comp covering the bill, the type filter and search
//   - another company's brand: 404; another day: not listed
//   - ?format=pdf answers a PDF (same scope)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { orderSummaryRoutes } from '../src/modules/pos/orderSummary.js'
import { orderRefOf } from '../src/lib/orderRef.js'

const P = `pos${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const C: Record<string, string> = {}
const users: Record<string, string> = {}
const O: Record<string, string> = {}
const DAY = '2026-10-21'
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00.000+05:00`)

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@pos.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
  return u.id
}
const get = (who: string, qs: string) => app.inject({ method: 'GET', url: `/pos/orders/summary?${qs}`, headers: { authorization: `Bearer ${users[who]}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'POS A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'POS B', slug: `${P}-b` } })).id
  C.A = (await prisma.concept.create({ data: { name: `${P} A`, slug: `${P}-ca`, type: 'restaurant', tenantId: T.A } })).id
  C.B = (await prisma.concept.create({ data: { name: `${P} B`, slug: `${P}-cb`, type: 'restaurant', tenantId: T.B } })).id
  const cashier = await mkUser('cashierA', 'cashier', T.A)
  await mkUser('cashierB', 'cashier', T.B)
  const mk = (k: string, d: Record<string, unknown>) => prisma.order.create({ data: { conceptId: C.A!, source: 'pos', totalCents: 1000_00, posStaffId: cashier, externalId: `${P}-${k}`, ...d } as never }).then((o) => { O[k] = o.id })
  await mk('open', { status: 'preparing', placedAt: at('13:00'), customerName: 'Room Guest' })
  await mk('paid', { status: 'completed', placedAt: at('12:00'), fulfilmentType: 'takeout', completedAt: at('12:10') })
  await mk('comp', { status: 'completed', placedAt: at('11:00'), totalCents: 450_00 })
  await mk('void', { status: 'cancelled', placedAt: at('10:00') })
  await mk('other', { status: 'completed', placedAt: at('12:00', '2026-10-20') })
  await prisma.payment.create({ data: { orderId: O.comp!, method: 'comp', amountCents: 450_00, status: 'paid', processedAt: at('11:05') } })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(orderSummaryRoutes, { prefix: '/pos' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { orderId: { in: Object.values(O) } } })
  await prisma.order.deleteMany({ where: { id: { in: Object.values(O) } } })
  await app?.close()
})

describe('order summary', () => {
  it('lists the day by tab with counts; No Charge is a comp covering the bill', async () => {
    const r = await get('cashierA', `conceptId=${C.A}&date=${DAY}`)
    expect(r.statusCode, r.body).toBe(200)
    const v = r.json()
    expect(v.counts).toEqual({ all: 4, running: 1, settled: 2, voided: 1 })
    expect(v.rows.map((x: { orderNo: string }) => x.orderNo)).toEqual([O.open, O.paid, O.comp, O.void].map((id) => orderRefOf(id!)))
    const comp = v.rows.find((x: { id: string }) => x.id === O.comp)
    expect(comp).toMatchObject({ type: 'no_charge', status: 'settled', compCents: 450_00, user: 'cashierA' })
    expect(v.rows.find((x: { id: string }) => x.id === O.paid)).toMatchObject({ type: 'takeout', time: '12:00:00 pm' })

    const settled = (await get('cashierA', `conceptId=${C.A}&date=${DAY}&tab=settled&type=no_charge`)).json()
    expect(settled.rows.map((x: { id: string }) => x.id)).toEqual([O.comp])
    expect(settled.counts).toEqual({ all: 1, running: 0, settled: 1, voided: 0 })
    expect((await get('cashierA', `conceptId=${C.A}&date=${DAY}&q=room`)).json().rows.map((x: { id: string }) => x.id)).toEqual([O.open])
  })

  it('another company’s brand is 404; the PDF answers in the same scope', async () => {
    expect((await get('cashierB', `conceptId=${C.A}&date=${DAY}`)).statusCode).toBe(404)
    const pdf = await get('cashierA', `conceptId=${C.A}&date=${DAY}&format=pdf`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toMatch(/pdf/)
    expect((await get('cashierB', `conceptId=${C.A}&date=${DAY}&format=pdf`)).statusCode).toBe(404)
  })
})
