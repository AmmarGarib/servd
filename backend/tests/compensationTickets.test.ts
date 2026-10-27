// Compensation tickets (owner, 2026-10-27: "extend Complaints").
//
// Every customer compensation at the till becomes ONE OrderComplaint of kind
// 'compensation', made from the rows the till already writes (audit rows for
// void / cancel / comp / refund / refund-due / credit-note pay-out; review
// flags for a discount above the limit and a price override). Two companies:
//   - each of the five actions makes exactly one ticket; running the sync /
//     worker again makes none (compSourceRef unique)
//   - rows that are not compensation make none (a staff meal, a system cancel,
//     the refund a line void makes)
//   - company B sees none of A's tickets; B's CEO flagging an A ticket → 404
//   - a manager flagging → 403; the CEO flags (note ≥10) → ExceptionFlag
//     'compensation_flagged' in A naming the approving manager; again → 409;
//     unflag resolves that flag
//   - the ordinary complaint list / stats do not show tickets; PATCH on one → 409
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

const Fastify = (await import('fastify')).default
const { ZodError } = await import('zod')
const bcrypt = (await import('bcryptjs')).default
const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { complaintRoutes } = await import('../src/modules/complaints/routes.js')
const { audit } = await import('../src/lib/audit.js')
const { flagException } = await import('../src/lib/exceptions.js')
const { syncCompensationTicketsForCompany } = await import('../src/modules/complaints/compensation.js')
const { runCompensationTicketsOnce } = await import('../src/workers/compensationTickets.js')

type App = Awaited<ReturnType<typeof Fastify>>
const RUN = Math.random().toString(36).slice(2, 8)
let app: App
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
const staff: Record<string, { id: string; token: string }> = {}
const orders: Record<string, string> = {}

async function mkStaff(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@comp.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as 'admin', isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const as = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({ method, url, ...(payload && { payload }), headers: { authorization: `Bearer ${staff[who]!.token}` } })

async function mkOrder(key: string, conceptId: string) {
  const o = await prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'completed', totalCents: 250_000, completedAt: new Date(),
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 250_000 }] },
    },
  })
  orders[key] = o.id
  return o.id
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Comp A', slug: `comp-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Comp B', slug: `comp-b-${RUN}` } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Comp Alpha', slug: `comp-alpha-${RUN}`, type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Comp Bravo', slug: `comp-bravo-${RUN}`, type: 'restaurant', tenantId: tenantB, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkStaff('ceo', 'admin', tenantA)
  await mkStaff('ceoB', 'admin', tenantB)
  await mkStaff('mgrA', 'foh_management', tenantA)
  await mkStaff('mgrB', 'manager', tenantB)
  await mkStaff('cashA', 'cashier', tenantA)

  for (const k of ['void', 'cancel', 'sysCancel', 'comp', 'meal', 'refund', 'voidRefund', 'due', 'payout', 'discount', 'price']) await mkOrder(k, conceptA)
  await mkOrder('bComp', conceptB)

  const mgr = staff['mgrA']!.id
  const cash = staff['cashA']!.id
  // Shapes as the till writes them (pos/service.ts, orders/service.ts cancelOrder).
  await audit({ category: 'identity', action: 'order_item_void', entity: 'OrderItem', entityId: 'item-1', userId: cash, tenantId: tenantA,
    metadata: { orderId: orders['void'], lineCents: 120_000, reason: 'Wrong dish fired', approverId: mgr } })
  await audit({ category: 'identity', action: 'order.cancel', entity: 'Order', entityId: orders['cancel'], userId: cash, tenantId: tenantA,
    before: { status: 'confirmed', totalCents: 250_000 }, after: { status: 'cancelled' }, metadata: { reason: 'Guest left', approverId: mgr } })
  await audit({ category: 'identity', action: 'order.cancel', entity: 'Order', entityId: orders['sysCancel'], userId: null, tenantId: tenantA,
    before: { status: 'placed', totalCents: 250_000 }, after: { status: 'cancelled' }, metadata: { reason: 'checkout undo', approverId: null } })
  await audit({ category: 'identity', action: 'order_comp', entity: 'Order', entityId: orders['comp'], userId: mgr, tenantId: tenantA,
    metadata: { amountCents: 250_000, reason: 'Hair in food', approverId: mgr } })
  await audit({ category: 'identity', action: 'order_staff_meal', entity: 'Order', entityId: orders['meal'], userId: mgr, tenantId: tenantA,
    metadata: { amountCents: 50_000, reason: 'Shift meal', approverId: mgr } })
  await audit({ category: 'identity', action: 'order_refund', entity: 'Order', entityId: orders['refund'], userId: cash, tenantId: tenantA,
    metadata: { amountCents: 80_000, method: 'card', reason: 'Cold food', approverId: mgr, terminalChargeId: 'tc-1' } })
  await audit({ category: 'identity', action: 'order_refund', entity: 'Order', entityId: orders['voidRefund'], userId: cash, tenantId: tenantA,
    metadata: { amountCents: 30_000, method: 'cash', reason: 'void', approverId: mgr, voidedItemId: 'item-2' } })
  await audit({ category: 'identity', action: 'order_refund_due', entity: 'Order', entityId: orders['due'], userId: cash, tenantId: tenantA,
    metadata: { amountCents: 40_000, method: 'cash', reason: 'Cancelled ticket hand-back', approverId: mgr } })
  await audit({ category: 'identity', action: 'order_credit_note_payout', entity: 'Order', entityId: orders['payout'], userId: cash, tenantId: tenantA,
    metadata: { amountCents: 60_000, method: 'cash', reason: 'Credit note owed back', approverId: mgr, creditNoteId: 'cn-1' } })
  await flagException({ tenantId: tenantA, kind: 'discount_above_cap', title: '30% discount on POS order', description: 'Cashier applied 30%.',
    conceptId: conceptA, actorId: cash, amountCents: 75_000, entityType: 'Order', entityId: orders['discount'],
    metadata: { realKind: 'discount_above_cap', reason: 'Regular guest' } })
  await flagException({ tenantId: tenantA, kind: 'price_override', title: 'Price override on POS order', description: '1 item(s) priced differently from menu. Reason: Happy hour.',
    conceptId: conceptA, actorId: mgr, amountCents: 20_000, entityType: 'Order', entityId: orders['price'], metadata: { overrides: [] } })
  // Company B: one comp.
  await audit({ category: 'identity', action: 'order_comp', entity: 'Order', entityId: orders['bComp'], userId: staff['mgrB']!.id, tenantId: tenantB,
    metadata: { amountCents: 99_000, reason: 'B comp', approverId: staff['mgrB']!.id } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(complaintRoutes, { prefix: '/complaints' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

const ticketsOf = (orderKeys: string[]) => prisma.orderComplaint.findMany({
  where: { kind: 'compensation', orderId: { in: orderKeys.map((k) => orders[k]!) } },
})

describe('compensation tickets', () => {
  it('each of the five actions makes exactly one ticket, and a second run makes none', async () => {
    const first = await syncCompensationTicketsForCompany(tenantA)
    expect(first).toBe(8)
    expect(await syncCompensationTicketsForCompany(tenantA)).toBe(0)
    await runCompensationTicketsOnce()
    await runCompensationTicketsOnce()

    const all = await ticketsOf(Object.keys(orders).filter((k) => k !== 'bComp'))
    expect(all).toHaveLength(8)
    const byOrder = new Map(all.map((t) => [t.orderId, t]))
    const t = (k: string) => byOrder.get(orders[k]!)
    expect(t('void')).toMatchObject({ compType: 'void', compValueCents: 120_000, compApproverId: staff['mgrA']!.id, compActorId: staff['cashA']!.id, status: 'resolved', description: 'Wrong dish fired' })
    expect(t('cancel')).toMatchObject({ compType: 'void', compValueCents: 250_000 })
    expect(t('comp')).toMatchObject({ compType: 'comp', compValueCents: 250_000 })
    expect(t('refund')).toMatchObject({ compType: 'refund', compValueCents: 80_000 })
    expect(t('due')).toMatchObject({ compType: 'refund', compValueCents: 40_000 })
    expect(t('payout')).toMatchObject({ compType: 'refund', compValueCents: 60_000 })
    // A cashier's discount: the PIN approver is not recorded → null.
    expect(t('discount')).toMatchObject({ compType: 'discount', compValueCents: 75_000, compApproverId: null, description: 'Regular guest' })
    // A manager's own price override: approved by themselves.
    expect(t('price')).toMatchObject({ compType: 'price_override', compValueCents: 20_000, compApproverId: staff['mgrA']!.id })
    // Not compensation: staff meal, a system cancel, the refund a line void makes.
    expect(t('meal')).toBeUndefined()
    expect(t('sysCancel')).toBeUndefined()
    expect(t('voidRefund')).toBeUndefined()
    // The worker made B's too.
    expect(await ticketsOf(['bComp'])).toHaveLength(1)
  })

  it('lists tickets of the companies in view only', async () => {
    const a = await as('mgrA', 'GET', '/complaints/compensation?limit=200')
    expect(a.statusCode).toBe(200)
    const aIds = (a.json().tickets as Array<{ orderId: string; orderRef: string; approver: { name: string } | null }>)
    expect(aIds.map((x) => x.orderId)).not.toContain(orders['bComp'])
    expect(aIds.length).toBeGreaterThanOrEqual(8)
    const v = aIds.find((x) => x.orderId === orders['void'])!
    expect(v.orderRef).toBe(orders['void']!.slice(-8).toUpperCase())
    expect(v.approver?.name).toBe('mgrA person')
    expect(a.json().canFlag).toBe(false)

    const b = await as('mgrB', 'GET', '/complaints/compensation?limit=200')
    expect(b.statusCode).toBe(200)
    const bOrders = (b.json().tickets as Array<{ orderId: string }>).map((x) => x.orderId)
    expect(bOrders).toContain(orders['bComp'])
    for (const k of Object.keys(orders).filter((k) => k !== 'bComp')) expect(bOrders).not.toContain(orders[k])

    const refunds = await as('mgrA', 'GET', '/complaints/compensation?type=refund')
    expect((refunds.json().tickets as Array<{ type: string }>).every((x) => x.type === 'refund')).toBe(true)
    expect(await as('cashA', 'GET', '/complaints/compensation').then((r) => r.statusCode)).toBe(403)
  })

  it('only the CEO flags; the flag raises an exception naming the approving manager; unflag resolves it', async () => {
    const ticket = (await ticketsOf(['void']))[0]!
    expect((await as('mgrA', 'POST', `/complaints/${ticket.id}/flag`, { note: 'Too many voids tonight' })).statusCode).toBe(403)
    expect((await as('ceoB', 'POST', `/complaints/${ticket.id}/flag`, { note: 'Too many voids tonight' })).statusCode).toBe(404)
    expect((await as('ceo', 'POST', `/complaints/${ticket.id}/flag`, { note: 'short' })).statusCode).toBe(400)

    const r = await as('ceo', 'POST', `/complaints/${ticket.id}/flag`, { note: 'Too many voids tonight' })
    expect(r.statusCode).toBe(200)
    const flagId = r.json().exceptionFlagId as string
    const flag = await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flagId } })
    expect(flag).toMatchObject({ kind: 'compensation_flagged', tenantId: tenantA, actorId: staff['mgrA']!.id, entityType: 'OrderComplaint', entityId: ticket.id, status: 'open' })
    expect(flag.title).toContain('mgrA person')

    expect((await as('ceo', 'POST', `/complaints/${ticket.id}/flag`, { note: 'Too many voids tonight' })).json().error.code).toBe('ALREADY_FLAGGED')
    const flaggedList = await as('mgrA', 'GET', '/complaints/compensation?flagged=1')
    expect((flaggedList.json().tickets as Array<{ id: string; flagged: { note: string } | null }>).find((x) => x.id === ticket.id)?.flagged?.note).toBe('Too many voids tonight')

    expect((await as('mgrA', 'POST', `/complaints/${ticket.id}/unflag`, {})).statusCode).toBe(403)
    expect((await as('ceo', 'POST', `/complaints/${ticket.id}/unflag`, { note: 'Checked with the manager' })).statusCode).toBe(200)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flagId } })).status).toBe('resolved')
    expect((await prisma.orderComplaint.findUniqueOrThrow({ where: { id: ticket.id } })).compFlaggedAt).toBeNull()
    expect((await as('ceo', 'POST', `/complaints/${ticket.id}/unflag`, {})).json().error.code).toBe('NOT_FLAGGED')
  })

  it('the ordinary complaint list and stats do not show tickets; a ticket is not edited', async () => {
    const c = await prisma.orderComplaint.create({ data: { conceptId: conceptA, title: 'Cold fries', description: 'Fries were cold', category: 'quality' } })
    const list = await as('mgrA', 'GET', '/complaints?limit=200')
    expect(list.statusCode).toBe(200)
    const rows = list.json().complaints as Array<{ id: string; kind: string }>
    expect(rows.map((x) => x.id)).toContain(c.id)
    expect(rows.some((x) => x.kind === 'compensation')).toBe(false)
    const stats = await as('mgrA', 'GET', '/complaints/stats')
    const open = await prisma.orderComplaint.count({ where: { concept: { tenantId: tenantA }, kind: { in: ['complaint', 'ban_appeal'] }, status: 'open' } })
    expect(stats.json().stats.open).toBe(open)

    const ticket = (await ticketsOf(['comp']))[0]!
    const p = await as('mgrA', 'PATCH', `/complaints/${ticket.id}`, { status: 'closed' })
    expect(p.statusCode).toBe(409)
    expect(p.json().error.code).toBe('COMPENSATION_TICKET_READ_ONLY')
  })
})
