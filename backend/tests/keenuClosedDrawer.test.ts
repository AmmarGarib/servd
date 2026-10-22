// Finance review fixes (2026-10-22), one company each step:
//   - a drawer with a bill pushed to Keenu and no outcome cannot close (409 SHIFT_HAS_KEENU_PUSH), even with
//     confirmOpenTickets;
//   - a payment never lands on a closed drawer (processPayment 409 SHIFT_CLOSED): a Keenu push that settles after
//     its drawer closed is held as needs_attention and flagged, never recorded where its close cannot book it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { posTillFlowRoutes } from '../src/modules/pos/tillFlowRoutes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { ensureBrandRevenueAccounts } from '../src/modules/accounting/brandRevenueAccount.js'
import { prisma, mkCompany, mkUser, setConnector, resetConnectorCache, openDrawer, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let cashierA: Who
let drawerA: string

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`kl-a-${Date.now()}`, { srbPosId: 8901 })
  cashierA = await mkUser(`kl-cashier-a-${Date.now()}`, 'cashier', A.tenantId)
  drawerA = await openDrawer(A, cashierA)
  await ensureBrandRevenueAccounts()
  setFiscalKicker(async () => {})
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok', push: 'pending' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(posTillFlowRoutes, { prefix: '/pos' })
  await registerConnectorPlugins(a)
  await a.ready()
  app = a
}, 60_000)

afterAll(async () => { setFiscalKicker(null); resetConnectorCache(); await app?.close() })

describe('Keenu push and a closed drawer', () => {
  it('a drawer with a pending Keenu push cannot close; a push settling after the drawer closed is held and flagged', async () => {
    const o = (await call(cashierA, 'POST', '/pos/orders', { conceptId: A.conceptId, items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }] })).json()
    const p = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push`, { shiftId: drawerA, method: 'card' })
    expect(p.statusCode, p.body).toBe(202)

    const close = await call(cashierA, 'POST', `/pos/shifts/${drawerA}/close`, { closingFloatCents: 0, confirmOpenTickets: true })
    expect(close.statusCode, close.body).toBe(409)
    expect(close.json().error.code).toBe('SHIFT_HAS_KEENU_PUSH')

    // The drawer closed anyway (an older release): Keenu settles later and the till presses Check.
    await prisma.shift.update({ where: { id: drawerA }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'ok', push: 'settle' } } })
    resetConnectorCache()
    const chk = await call(cashierA, 'POST', `/pos/orders/${o.id}/keenu-push/check`)
    expect(chk.statusCode).toBe(409)
    expect(chk.json().error.code).toBe('SHIFT_CLOSED')
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(0)
    const ord = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: { status: true, settlementMeta: true } })
    expect(ord.status).not.toBe('completed')
    expect((ord.settlementMeta as { keenu?: { state?: string } }).keenu?.state).toBe('needs_attention')
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, entityId: o.id, title: { contains: 'could not record' } } })).toBe(1)
  })
})
