// Procurement company separation.
//
// A supplier carries the company; every PO, bill, payment, conversation and
// portal token belongs to its supplier's company. What this guards:
//   - An operator with NO company sees nothing (the old supplier filter
//     returned `{}` — every company — for an empty scope).
//   - Company B's manager can't read or reply in company A's supplier
//     threads, can't list them, and can't mint or list A's portal tokens.
//   - A PO / bill can't reference another company's inventory items, POs or
//     PO lines (422), and a foreign supplier is 404.
//   - The PO approval threshold is per company, with the old global key as a
//     read fallback; submitPo applies the PO's own company's threshold.
//   - Price history without a supplier is its item's company's only.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createPo, submitPo } from '../src/modules/procurement/service.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { supplierChatRoutes } from '../src/modules/procurement/chat.js'

let tenantA: string
let tenantB: string
let supA: string
let supB: string
let orphan: string
let itemA: string
let itemB: string
let poA: string
let poLineA: string
let convA: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string | null) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.sepproc@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  if (primary) await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'SEP-P A', slug: 'sep-proc-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SEP-P B', slug: 'sep-proc-b' } })).id
  invalidateSetupCache()

  // No email / phone on file, so the chat fan-out has nothing to send.
  supA   = (await prisma.supplier.create({ data: { name: 'A Mills', tenantId: tenantA } })).id
  supB   = (await prisma.supplier.create({ data: { name: 'B Farms', tenantId: tenantB } })).id
  orphan = (await prisma.supplier.create({ data: { name: 'Nobody Ltd', tenantId: null } })).id
  itemA  = (await prisma.inventoryItem.create({ data: { name: 'A Flour', unit: 'kg', tenantId: tenantA } })).id
  itemB  = (await prisma.inventoryItem.create({ data: { name: 'B Onion', unit: 'kg', tenantId: tenantB } })).id

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('mgrB', 'boh_management', tenantB)
  await mkUser('buyerB', 'procurement', tenantB)   // procurement module, not a manager
  await mkUser('nobody', 'admin', null)

  const po = await createPo({ supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 2, unitCostCents: 100 }], createdBy: users['ceoA']!.id })
  poA = po.id
  poLineA = po.lines[0]!.id

  await prisma.itemPriceHistory.create({ data: { inventoryItemId: itemA, supplierId: null, newCostCents: 123, source: 'manual_adjust' } })
  await prisma.itemPriceHistory.create({ data: { inventoryItemId: itemB, supplierId: supB, newCostCents: 456, source: 'po_receive' } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.register(supplierChatRoutes, { prefix: '/procurement' })
  await app.ready()

  const conv = await call('ceoA', 'POST', '/procurement/conversations', { supplierId: supA, subject: 'Q4 flour price', message: 'Our best offer is 90/kg' })
  expect(conv.statusCode).toBe(201)
  convA = conv.json().id
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('supplier conversations and portal tokens', () => {
  it('B never lists, reads or replies in A\'s supplier thread', async () => {
    const listB = (await call('ceoB', 'GET', '/procurement/conversations')).json() as Array<{ id: string }>
    expect(listB.map((c) => c.id)).not.toContain(convA)
    const listA = (await call('ceoA', 'GET', '/procurement/conversations')).json() as Array<{ id: string }>
    expect(listA.map((c) => c.id)).toContain(convA)

    expect((await call('ceoB', 'GET', `/procurement/conversations/${convA}/messages`)).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/procurement/conversations/${convA}/messages`)).statusCode).toBe(404)
    const reply = await call('ceoB', 'POST', `/procurement/conversations/${convA}/messages`, { body: 'we will pay 95' })
    expect(reply.statusCode).toBe(404)
    expect(await prisma.supplierMessage.count({ where: { conversationId: convA } })).toBe(1)

    // A itself still can.
    expect((await call('ceoA', 'GET', `/procurement/conversations/${convA}/messages`)).statusCode).toBe(200)
  })

  it('B can\'t start a thread with A\'s supplier', async () => {
    const res = await call('ceoB', 'POST', '/procurement/conversations', { supplierId: supA, message: 'hello' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.supplierConversation.count({ where: { supplierId: supA } })).toBe(1)
  })

  it('a non-manager only reaches their own threads', async () => {
    const mine = await call('ceoB', 'POST', '/procurement/conversations', { supplierId: supB, message: 'hi B' })
    expect(mine.statusCode).toBe(201)
    expect((await call('buyerB', 'GET', `/procurement/conversations/${mine.json().id}/messages`)).statusCode).toBe(404)
    expect((await call('buyerB', 'GET', '/procurement/conversations')).json()).toEqual([])
  })

  it('B can\'t mint or list a portal token for A\'s supplier', async () => {
    const mint = await call('ceoB', 'POST', `/procurement/suppliers/${supA}/portal-token`, {})
    expect(mint.statusCode).toBe(404)
    expect(await prisma.supplierPortalToken.count({ where: { supplierId: supA } })).toBe(0)

    const ownMint = await call('ceoA', 'POST', `/procurement/suppliers/${supA}/portal-token`, {})
    expect(ownMint.statusCode).toBe(201)
    const list = await call('ceoB', 'GET', `/procurement/suppliers/${supA}/portal-tokens`)
    expect(list.statusCode).toBe(404)
    expect(JSON.stringify(list.json())).not.toContain(ownMint.json().token)
    expect((await call('ceoA', 'GET', `/procurement/suppliers/${supA}/portal-tokens`)).json()).toHaveLength(1)
  })
})

describe('POs and bills stay inside the supplier\'s company', () => {
  it('B can\'t put A\'s inventory item on B\'s PO (422), nor order from A\'s supplier (404)', async () => {
    const foreignItem = await call('ceoB', 'POST', '/procurement/purchase-orders', {
      supplierId: supB, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 100 }],
    })
    expect(foreignItem.statusCode).toBe(422)
    expect(foreignItem.json().error.code).toBe('ITEM_NOT_IN_COMPANY')

    const foreignSupplier = await call('ceoB', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 100 }],
    })
    expect(foreignSupplier.statusCode).toBe(404)
    expect(await prisma.purchaseOrder.count({ where: { supplierId: supB } })).toBe(0)

    const ok = await call('ceoB', 'POST', '/procurement/purchase-orders', {
      supplierId: supB, lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 100 }],
    })
    expect(ok.statusCode).toBe(201)
  })

  it('a supplier with no company can\'t be ordered from', async () => {
    await expect(createPo({ supplierId: orphan, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1 }], createdBy: users['ceoA']!.id }))
      .rejects.toMatchObject({ code: 'SUPPLIER_HAS_NO_COMPANY', statusCode: 422 })
  })

  it('B\'s bill can\'t reference A\'s PO, PO lines or items', async () => {
    const base = { supplierId: supB, billDate: new Date().toISOString() }
    const po = await call('ceoB', 'POST', '/procurement/bills', { ...base, billNumber: 'X-1', poId: poA, lines: [{ description: 'x', quantity: 1, unitCostCents: 1 }] })
    expect(po.statusCode).toBe(422)
    expect(po.json().error.code).toBe('PO_SUPPLIER_MISMATCH')

    const line = await call('ceoB', 'POST', '/procurement/bills', { ...base, billNumber: 'X-2', lines: [{ description: 'x', poLineId: poLineA, quantity: 1, unitCostCents: 1 }] })
    expect(line.statusCode).toBe(422)
    expect(line.json().error.code).toBe('PO_LINE_MISMATCH')

    const item = await call('ceoB', 'POST', '/procurement/bills', { ...base, billNumber: 'X-3', lines: [{ description: 'x', inventoryItemId: itemA, quantity: 1, unitCostCents: 1 }] })
    expect(item.statusCode).toBe(422)
    expect(item.json().error.code).toBe('ITEM_NOT_IN_COMPANY')

    expect(await prisma.supplierBill.count({ where: { supplierId: supB } })).toBe(0)
  })

  it('B can\'t read or act on A\'s PO', async () => {
    expect((await call('ceoB', 'GET', `/procurement/purchase-orders/${poA}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${poA}/cancel`, { reason: 'no' })).statusCode).toBe(404)
    const listB = (await call('ceoB', 'GET', '/procurement/purchase-orders')).json() as Array<{ id: string }>
    expect(listB.map((p) => p.id)).not.toContain(poA)
  })

  it('B can\'t edit A\'s supplier; nobody can strip a supplier\'s company', async () => {
    expect((await call('ceoB', 'PATCH', `/procurement/suppliers/${supA}`, { name: 'Mine now' })).statusCode).toBe(404)
    const strip = await call('ceoA', 'PATCH', `/procurement/suppliers/${supA}`, { tenantId: null })
    expect(strip.statusCode).toBe(422)
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: supA } })).tenantId).toBe(tenantA)
  })
})

describe('an operator with no company sees nothing', () => {
  it('every list is empty and every id is 404', async () => {
    for (const url of [
      '/procurement/suppliers', '/procurement/purchase-orders', '/procurement/bills', '/procurement/payments',
      '/procurement/approvals', '/procurement/price-history', '/procurement/reorder', '/procurement/conversations',
    ]) {
      const res = await call('nobody', 'GET', url)
      expect(res.statusCode, url).toBe(200)
      expect(res.json(), url).toEqual([])
    }
    expect((await call('nobody', 'GET', `/procurement/suppliers/${supA}/statement`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/procurement/suppliers/${orphan}/statement`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/procurement/purchase-orders/${poA}`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/procurement/conversations/${convA}/messages`)).statusCode).toBe(404)
    expect((await call('nobody', 'POST', `/procurement/suppliers/${supA}/portal-token`, {})).statusCode).toBe(404)
  })

  it('can\'t create a company-less supplier or read a threshold', async () => {
    const res = await call('nobody', 'POST', '/procurement/suppliers', { name: 'Stray Co' })
    expect(res.statusCode).toBe(422)
    expect(await prisma.supplier.count({ where: { name: 'Stray Co' } })).toBe(0)
    expect((await call('nobody', 'GET', '/procurement/settings/approval-threshold')).statusCode).toBe(422)
  })
})

describe('approval threshold is per company', () => {
  it('falls back to the old global key, and one company\'s change leaves the other alone', async () => {
    await prisma.setting.create({ data: { key: 'procurement.approvalThresholdCents', value: '777' } })
    expect((await call('ceoB', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents).toBe(777)

    const put = await call('ceoA', 'PUT', '/procurement/settings/approval-threshold', { thresholdCents: 1_000_000 })
    expect(put.statusCode).toBe(200)
    expect((await call('ceoA', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents).toBe(1_000_000)
    expect((await call('ceoB', 'GET', '/procurement/settings/approval-threshold')).json().thresholdCents).toBe(777)
    // The legacy row is never rewritten.
    expect((await prisma.setting.findUniqueOrThrow({ where: { key: 'procurement.approvalThresholdCents' } })).value).toBe('777')

    // B can't set A's.
    expect((await call('ceoB', 'PUT', '/procurement/settings/approval-threshold', { thresholdCents: 1, tenantId: tenantA })).statusCode).toBe(403)
  })

  it('submitPo applies the PO\'s own company\'s threshold', async () => {
    // 50,000 paisa: under A's 1,000,000 → auto-approved; over B's fallback 777 → needs approval.
    const a = await createPo({ supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 50_000 }], createdBy: users['ceoA']!.id })
    expect((await submitPo(a.id, users['ceoA']!.id)).status).toBe('approved')
    const b = await createPo({ supplierId: supB, lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 50_000 }], createdBy: users['ceoB']!.id })
    expect((await submitPo(b.id, users['ceoB']!.id)).status).toBe('pending_approval')

    const approvalsA = (await call('ceoA', 'GET', '/procurement/approvals')).json() as Array<{ id: string }>
    expect(approvalsA.map((p) => p.id)).not.toContain(b.id)
  })
})

describe('price history', () => {
  it('a row with no supplier is its item\'s company\'s only', async () => {
    const a = (await call('ceoA', 'GET', '/procurement/price-history')).json() as Array<{ inventoryItemId: string }>
    const b = (await call('ceoB', 'GET', '/procurement/price-history')).json() as Array<{ inventoryItemId: string }>
    expect(a.map((r) => r.inventoryItemId)).toEqual([itemA])
    expect(b.map((r) => r.inventoryItemId)).toEqual([itemB])
  })
})
