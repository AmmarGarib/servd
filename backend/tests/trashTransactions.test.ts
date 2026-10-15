// The Trash's transaction providers (stream B7; modules/trash/providers/transactions).
//
//   - Two companies: B never lists, reads or copies A's cancelled / voided rows (404).
//   - A copy never carries payments, discounts, approvals or fiscal / CPR numbers.
//   - An order copy drops deleted dishes and re-prices at today's menu.
//   - A PO copy is a DRAFT in the ACTIVE company (the module's own create route).
//   - A copy of another company's row while acting in this one → 422 COPY_SWITCH_COMPANY.
//   - A journal copy is a DRAFT JournalRequest and posts nothing.
//   - The original's status is untouched.
//   - Purge of any transaction → 409 NOT_ERASABLE; restore → 422 NOT_RESTORABLE.
//   - Archive hides it from the default list.
//   - An online order shows with no copy action (owner Q1 default).
//   - The F1 money snapshot (voided tax payment): listed, never restored or
//     erased, its copy carries no CPR / bank / posting.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { registerTrashPlugin } = await import('../src/modules/trash/index.js')
const { trashProviders } = await import('../src/modules/trash/registry.js')
const { TRANSACTION_TRASH_PROVIDERS } = await import('../src/modules/trash/providers/transactions/index.js')
const { moveToTrash } = await import('../src/lib/trash.js')
const { takeSnapshot } = await import('../src/modules/trash/snapshot.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { procurementRoutes } = await import('../src/modules/procurement/routes.js')

const P = `trx${Date.now()}`
let app: FastifyInstance
const T = { A: '', B: '' }
const U: Record<string, { id: string; token: string; tenantId: string }> = {}

async function mkUser(key: string, role: string, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@trx.pk`, password: 'x', role: role as 'admin', tenantId: members[0]!,
      isActive: true, accountStatus: 'active',
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken, tenantId: members[0]! }
}

function call(who: string, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, opts: { tenant?: string; portfolio?: boolean } = {}) {
  return app.inject({
    method, url: `/api/v1/trash${url}`,
    headers: {
      authorization: `Bearer ${U[who]!.token}`,
      'x-servd-active-tenant': opts.tenant ?? U[who]!.tenantId,
      ...(opts.portfolio ? { 'x-servd-portfolio': '1' } : {}),
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  })
}
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code
type Item = { id: string; type: string; tenantId: string; canCopy: boolean; notCopyableReason: string | null; erasable?: boolean; statusLabel: string | null }
const items = async (who: string, q: string, opts?: { tenant?: string; portfolio?: boolean }) => {
  const r = await call(who, 'GET', `?${q}`, undefined, opts)
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as { items: Item[] }).items
}

const ids = {
  conceptA: '', conceptB: '', dishLive: '', dishGone: '', mod: '',
  posOrder: '', onlineOrder: '', openOrder: '', voidedOnOpen: '', voidedOnClosed: '', orderB: '',
  supplierA: '', itemA: '', poA: '', entryA: '', taxPay: '',
}

async function mkOrder(conceptId: string, source: 'pos' | 'servd', status: 'cancelled' | 'received', extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      conceptId, source, status, totalCents: 1_000, discountCents: 100, tipCents: 50,
      ...(status === 'cancelled' ? { cancelledAt: new Date(), cancellationReason: 'Guest left' } : {}),
      ...extra,
    },
  })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} Co A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} Co B`, slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await mkUser('ceo', 'admin', [T.A, T.B])
  await mkUser('ownerA', 'owner', [T.A])
  await mkUser('ownerB', 'owner', [T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('cashierA', 'cashier', [T.A])

  // ── Menu: a live dish (re-priced since) with a modifier, a deleted dish ──
  ids.conceptA = (await prisma.concept.create({ data: { name: `${P} Cafe A`, slug: `${P}-cafe-a`, type: 'restaurant', tenantId: T.A } })).id
  ids.conceptB = (await prisma.concept.create({ data: { name: `${P} Cafe B`, slug: `${P}-cafe-b`, type: 'restaurant', tenantId: T.B } })).id
  const cat = (await prisma.category.create({ data: { conceptId: ids.conceptA, name: 'Mains' } })).id
  ids.dishLive = (await prisma.menuItem.create({ data: { conceptId: ids.conceptA, categoryId: cat, name: 'Club sandwich', priceCents: 700 } })).id
  ids.dishGone = (await prisma.menuItem.create({ data: { conceptId: ids.conceptA, categoryId: cat, name: 'Old soup', priceCents: 300, deletedAt: new Date() } })).id
  const grp = (await prisma.modifierGroup.create({ data: { menuItemId: ids.dishLive, name: 'Extras' } })).id
  ids.mod = (await prisma.modifier.create({ data: { groupId: grp, name: 'Cheese', priceDeltaCents: 80 } })).id

  // ── Orders ──
  const pos = await mkOrder(ids.conceptA, 'pos', 'cancelled', { fbrInvoiceNumber: 'FBR-123' })
  ids.posOrder = pos.id
  const line = await prisma.orderItem.create({ data: { orderId: pos.id, menuItemId: ids.dishLive, name: 'Club sandwich', quantity: 2, unitPriceCents: 500, notes: 'no onion' } })
  await prisma.orderItemModifier.create({ data: { orderItemId: line.id, modifierId: ids.mod, name: 'Cheese', priceDeltaCents: 50 } })
  await prisma.orderItem.create({ data: { orderId: pos.id, menuItemId: ids.dishGone, name: 'Old soup', quantity: 1, unitPriceCents: 300 } })
  await prisma.payment.create({ data: { orderId: pos.id, method: 'cash', amountCents: 900, status: 'refunded' } }).catch(() => undefined)
  ids.voidedOnClosed = (await prisma.orderItem.create({ data: { orderId: pos.id, menuItemId: ids.dishLive, name: 'Club sandwich', quantity: 1, unitPriceCents: 500, status: 'voided', voidedAt: new Date(), voidReason: 'wrong dish' } })).id

  ids.onlineOrder = (await mkOrder(ids.conceptA, 'servd', 'cancelled')).id
  const open = await mkOrder(ids.conceptA, 'pos', 'received')
  ids.openOrder = open.id
  ids.voidedOnOpen = (await prisma.orderItem.create({ data: { orderId: open.id, menuItemId: ids.dishLive, name: 'Club sandwich', quantity: 1, unitPriceCents: 500, status: 'voided', voidedAt: new Date(), voidReason: 'rang twice' } })).id
  ids.orderB = (await mkOrder(ids.conceptB, 'pos', 'cancelled')).id

  // ── A cancelled PO in A ──
  ids.supplierA = (await prisma.supplier.create({ data: { name: `${P} Mills`, tenantId: T.A } })).id
  ids.itemA = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A, category: 'dry', unitCostCents: 1_200 } })).id
  ids.poA = (await prisma.purchaseOrder.create({
    data: {
      supplierId: ids.supplierA, status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Supplier out of stock', cancelledById: U.ownerA!.id,
      approvedById: U.ceo!.id, approvedAt: new Date(), sentAt: new Date(), totalCents: 10_000, reference: 'PO-OLD',
      lines: { create: [{ inventoryItemId: ids.itemA, quantityOrdered: 10, unitCostCents: 1_000 }] },
    },
  })).id

  // ── A reversed MANUAL journal entry in A ──
  const acct = async (c: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId: T.A, code: c }, select: { id: true } })).id
  const src = randomUUID()
  const [rent, bank] = [await acct('6010'), await acct('1020')]
  ids.entryA = (await prisma.journalEntry.create({
    data: {
      tenantId: T.A, reference: `manual:${src}`, description: `${P} rent accrual`, postedBy: U.finA!.id,
      lines: { create: [{ accountId: rent, type: 'debit', amountCents: 250_000, memo: 'rent' }, { accountId: bank, type: 'credit', amountCents: 250_000 }] },
    },
  })).id
  await prisma.journalEntry.create({
    data: {
      tenantId: T.A, reference: `manual.reversal:${src}`, description: 'Reversal: posted twice', postedBy: U.ceo!.id,
      lines: { create: [{ accountId: rent, type: 'credit', amountCents: 250_000 }, { accountId: bank, type: 'debit', amountCents: 250_000 }] },
    },
  })

  // ── F1: a voided tax payment, kept as a snapshot (as B6's route writes it) ──
  ids.taxPay = randomUUID()
  await prisma.$transaction(async (tx) => {
    await moveToTrash(tx, { userId: U.finA!.id }, {
      type: 'sales_tax_payment', entityId: ids.taxPay, tenantId: T.A, title: 'SRB payment — PKR 5,000', reason: 'wrong period',
      snapshot: takeSnapshot('SalesTaxPayment', {
        id: ids.taxPay, tenantId: T.A, authority: 'srb', periodFrom: new Date('2026-08-31T19:00:00Z'), periodTo: new Date('2026-09-30T18:59:59Z'),
        outputSetOffCents: 0n, inputSetOffCents: 10_000n, paidCents: 500_000n, paidAt: new Date(), bankAccountId: randomUUID(),
        cprNumber: 'CPR-SECRET-1', journalEntryId: randomUUID(), linked: false, createdById: U.finA!.id, createdAt: new Date(),
      }),
    })
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await registerTrashPlugin(api)
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('registry', () => {
  it('every transaction type is never erasable, keys are unique', () => {
    const keys = trashProviders().map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const p of TRANSACTION_TRASH_PROVIDERS) {
      expect(p.kind, p.key).toBe('transaction')
      expect(p.erasable(null, []), p.key).toBe(false)
      expect(p.strategy === 'none' ? typeof p.list === 'function' && typeof p.get === 'function' : p.restorable === false, p.key).toBe(true)
    }
  })
})

describe('two companies', () => {
  it('A lists its own cancelled orders (till and online); B sees none of them', async () => {
    const a = await items('ownerA', 'type=order')
    const aIds = a.map((i) => i.id)
    expect(aIds).toEqual(expect.arrayContaining([ids.posOrder, ids.onlineOrder]))
    expect(aIds).not.toContain(ids.orderB)
    expect(aIds).not.toContain(ids.openOrder)
    const b = await items('ownerB', 'type=order')
    expect(b.map((i) => i.id)).toEqual([ids.orderB])
  })

  it('B gets 404 on A\'s rows for read and copy, across types', async () => {
    for (const [t, id] of [['order', ids.posOrder], ['purchase_order', ids.poA], ['order_item', ids.voidedOnOpen], ['journal_entry', ids.entryA], ['sales_tax_payment', ids.taxPay]] as const) {
      expect((await call('ownerB', 'GET', `/${t}/${id}`)).statusCode, `${t} get`).toBe(404)
      expect((await call('ownerB', 'POST', `/${t}/${id}/copy`, {})).statusCode, `${t} copy`).toBe(404)
    }
  })

  it('a login without the role sees nothing of the type', async () => {
    expect(await items('cashierA', 'type=order')).toEqual([])
    expect((await call('cashierA', 'POST', `/order/${ids.posOrder}/copy`, {})).statusCode).toBe(404)
  })

  it('a copy of another company\'s row while acting in this one → COPY_SWITCH_COMPANY', async () => {
    const r = await call('ceo', 'POST', `/purchase_order/${ids.poA}/copy`, {}, { tenant: T.B, portfolio: true })
    expect(r.statusCode, r.body).toBe(422)
    expect(code(r)).toBe('COPY_SWITCH_COMPANY')
    expect(await prisma.purchaseOrder.count({ where: { supplierId: ids.supplierA } })).toBe(1)
  })
})

describe('orders', () => {
  it('an online order is listed with no copy action, and its copy is refused', async () => {
    const online = (await items('ownerA', 'type=order')).find((i) => i.id === ids.onlineOrder)!
    expect(online.canCopy).toBe(false)
    expect(online.notCopyableReason).toMatch(/online/i)
    const r = await call('ownerA', 'POST', `/order/${ids.onlineOrder}/copy`, {})
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('NOT_COPYABLE')
  })

  it('a till order copy re-prices at today\'s menu, drops the deleted dish, carries no money or fiscal number', async () => {
    const r = await call('ownerA', 'POST', `/order/${ids.posOrder}/copy`, {})
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json() as { mode: string; link: string; payload: Record<string, unknown> }
    expect(c.mode).toBe('prefill')
    expect(c.link).toBe('/pos')
    const lines = c.payload.items as Array<{ menuItemId: string; quantity: number; unitPriceCents: number; modifierIds: string[]; notes: string }>
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ menuItemId: ids.dishLive, quantity: 2, unitPriceCents: 780, modifierIds: [ids.mod], notes: 'no onion' })
    expect((c.payload.warnings as string[]).some((w) => w.includes('Old soup'))).toBe(true)
    const flat = JSON.stringify(c.payload)
    for (const k of ['discountCents', 'tipCents', 'payments', 'fbrInvoiceNumber', 'FBR-123', 'serviceChargeCents', 'promoCodeId']) expect(flat).not.toContain(k)
    // The original is untouched; the copy is logged.
    const o = await prisma.order.findUniqueOrThrow({ where: { id: ids.posOrder } })
    expect(o.status).toBe('cancelled')
    expect(o.totalCents).toBe(1_000)
    expect(await prisma.trashCopy.count({ where: { entityType: 'order', entityId: ids.posOrder, mode: 'prefill', tenantId: T.A } })).toBe(1)
    const a = await prisma.auditLog.findFirst({ where: { entity: 'order', entityId: ids.posOrder, action: 'trash.copy' } })
    expect(a!.tenantId).toBe(T.A)
  })

  it('a voided line copies onto its open ticket; on a closed ticket it is not copyable', async () => {
    const r = await call('ownerA', 'POST', `/order_item/${ids.voidedOnOpen}/copy`, {})
    expect(r.statusCode, r.body).toBe(200)
    const p = (r.json() as { payload: Record<string, unknown> }).payload
    expect(p.orderId).toBe(ids.openOrder)
    expect((p.item as { menuItemId: string }).menuItemId).toBe(ids.dishLive)
    const closed = await call('ownerA', 'POST', `/order_item/${ids.voidedOnClosed}/copy`, {})
    expect(closed.statusCode).toBe(422)
    expect(code(closed)).toBe('NOT_COPYABLE')
  })

  it('a transaction is never restored, and never erased — even by the CEO', async () => {
    const res = await call('ceo', 'POST', `/order/${ids.posOrder}/restore`, {})
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('NOT_RESTORABLE')
    const del = await call('ceo', 'DELETE', `/order/${ids.posOrder}`, { reason: 'clean up the trash bin please' })
    expect(del.statusCode).toBe(409)
    expect(code(del)).toBe('NOT_ERASABLE')
    expect((await prisma.order.findUnique({ where: { id: ids.posOrder } }))?.status).toBe('cancelled')
  })

  it('archive (the CEO) hides it from the default list; archived shows it', async () => {
    expect((await call('ownerA', 'POST', `/order/${ids.onlineOrder}/archive`, {})).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/order/${ids.onlineOrder}/archive`, {})).statusCode).toBe(204)
    expect((await items('ownerA', 'type=order')).map((i) => i.id)).not.toContain(ids.onlineOrder)
    expect((await items('ceo', 'type=order&state=archived')).map((i) => i.id)).toContain(ids.onlineOrder)
    expect((await prisma.order.findUnique({ where: { id: ids.onlineOrder } }))?.status).toBe('cancelled')
  })
})

describe('purchase orders', () => {
  it('a copy is a DRAFT in the active company, through the module\'s own route, at today\'s cost', async () => {
    const r = await call('ownerA', 'POST', `/purchase_order/${ids.poA}/copy`, {})
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json() as { mode: string; id: string }
    expect(c.mode).toBe('created')
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: c.id }, include: { lines: true, supplier: true } })
    expect(po.status).toBe('draft')
    expect(po.supplier.tenantId).toBe(T.A)
    expect(po.createdBy).toBe(U.ownerA!.id)
    expect(po.approvedById).toBeNull()
    expect(po.sentAt).toBeNull()
    expect(po.lines).toHaveLength(1)
    expect(po.lines[0]!.unitCostCents).toBe(1_200)
    expect(await prisma.trashCopy.findFirst({ where: { entityType: 'purchase_order', entityId: ids.poA, newEntityId: c.id } })).not.toBeNull()
    // The original stays cancelled.
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: ids.poA } })).status).toBe('cancelled')
  })
})

describe('journals', () => {
  it('a reversed manual entry copies to a DRAFT journal request and posts nothing', async () => {
    const listed = await items('finA', 'type=journal_entry')
    expect(listed.map((i) => i.id)).toContain(ids.entryA)
    const before = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const r = await call('finA', 'POST', `/journal_entry/${ids.entryA}/copy`, {})
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json() as { mode: string; id: string }
    expect(c.mode).toBe('created')
    const jr = await prisma.journalRequest.findUniqueOrThrow({ where: { id: c.id } })
    expect(jr).toMatchObject({ tenantId: T.A, kind: 'post', status: 'draft', preparedById: U.finA!.id, postedEntryId: null, decidedById: null })
    expect(jr.lines).toHaveLength(2)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(before)
  })
})

describe('money snapshots (F1)', () => {
  it('a voided tax payment is listed, never restored, never erased, and its copy carries no CPR / bank / posting', async () => {
    const listed = await items('finA', 'type=sales_tax_payment')
    expect(listed.map((i) => i.id)).toEqual([ids.taxPay])
    expect(listed[0]!.erasable).toBe(false)
    const res = await call('ceo', 'POST', `/sales_tax_payment/${ids.taxPay}/restore`, {})
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('NOT_RESTORABLE')
    const del = await call('ceo', 'DELETE', `/sales_tax_payment/${ids.taxPay}`, { reason: 'try erasing a tax record' })
    expect(del.statusCode).toBe(409)
    expect(code(del)).toBe('NOT_ERASABLE')
    const r = await call('finA', 'POST', `/sales_tax_payment/${ids.taxPay}/copy`, {})
    expect(r.statusCode, r.body).toBe(200)
    const p = (r.json() as { payload: Record<string, unknown> }).payload
    expect(p).toMatchObject({ authority: 'srb', periodFrom: '2026-09-01', periodTo: '2026-09-30', paidCents: 500_000, inputSetOffCents: 10_000 })
    const flat = JSON.stringify(p)
    for (const k of ['cprNumber', 'CPR-SECRET-1', 'bankAccountId', 'journalEntryId']) expect(flat).not.toContain(k)
    expect(await items('ownerB', 'type=sales_tax_payment')).toEqual([])
  })
})

describe('every transaction type answers its list', () => {
  it('list with search, dates and a cursor works for each type (CEO, both companies)', async () => {
    const cursor = Buffer.from(JSON.stringify({ at: new Date(Date.now() + 60_000).toISOString(), id: 'zzzz' })).toString('base64url')
    for (const p of TRANSACTION_TRASH_PROVIDERS) {
      for (const q of [`type=${p.key}`, `type=${p.key}&q=x&from=2020-01-01&to=2030-01-01`, `type=${p.key}&cursor=${cursor}`]) {
        const r = await call('ceo', 'GET', `?${q}`, undefined, { portfolio: true })
        expect(r.statusCode, `${p.key}: ${r.body}`).toBe(200)
      }
      if (p.get) expect(await p.get({ readScope: { tenantId: { in: [] } } } as never, randomUUID()), p.key).toBeNull()
    }
  })
})
