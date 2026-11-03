// See the describe block below.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { approverIdsFor } from '../src/lib/approvalRights.js'

const P = `pons${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
let supA = '', supB = '', flour = '', soap = '', itemB = '', locA = ''

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@poch.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

async function entryLines(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
async function netDebit(tenantId: string, codeOf: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code: codeOf } })
  const sums = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: acct.id }, _sum: { amountCents: true } })
  return Number(sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0) - Number(sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0)
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'PO Chain A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'PO Chain B', slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('buyerA', 'procurement', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('chefA', 'boh_management', [T.A])
  await mkUser('storeA', 'manager', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('buyerB', 'procurement', [T.B])
  await mkUser('finB', 'finance', [T.B])

  supA = (await prisma.supplier.create({ data: { name: `${P} Metro`, tenantId: T.A, paymentTermsDays: 0, filerStatus: 'filer' } })).id
  supB = (await prisma.supplier.create({ data: { name: `${P} B Mart`, tenantId: T.B, paymentTermsDays: 0, filerStatus: 'filer' } })).id
  flour = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A, category: 'flour_grain', currentStock: 0, unitCostCents: 200 } })).id
  soap = (await prisma.inventoryItem.create({ data: { name: `${P} Dish soap`, unit: 'pcs', tenantId: T.A, category: 'non_food', issueOnReceipt: true, currentStock: 0, unitCostCents: 300 } })).id
  itemB = (await prisma.inventoryItem.create({ data: { name: `${P} B Flour`, unit: 'kg', tenantId: T.B, category: 'flour_grain', currentStock: 0, unitCostCents: 200 } })).id
  locA = (await prisma.location.create({ data: { slug: `${P}-la`, name: 'Chain outlet', tenantId: T.A } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})


// POs without a supplier (owner, 2026-11-03: "POs should be able to go thru without supplier attached"): raised with
// none (held by the company's "Cash purchases" system supplier, in the ACTIVE company), approved through the whole chain,
// never sent or received until the supplier is chosen (422 PO_SUPPLIER_NOT_CHOSEN); the supplier is chosen once
// (PUT /purchase-orders/:id/supplier), only one of the PO's own company; company B gets 404.
describe('a PO with no supplier', () => {
  let poId = ''
  let lines: Array<{ id: string; inventoryItemId: string }> = []

  it('is raised with no supplier, in the raiser\'s company, and goes through the chain', async () => {
    const r = await call('chefA', 'POST', '/procurement/purchase-orders', { lines: [{ inventoryItemId: flour, quantityOrdered: 10, unitCostCents: 200 }] })
    expect(r.statusCode, r.body).toBe(201)
    poId = r.json().id
    lines = r.json().lines
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { supplier: true } })
    expect(po.supplier.tenantId).toBe(T.A)
    expect(po.supplier.systemKind).toBe('cash_purchases')
    expect(po.reference).toMatch(/^PO-\d{5}$/)
    // An item of another company is still refused.
    const bad = await call('chefA', 'POST', '/procurement/purchase-orders', { lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 200 }] })
    expect(bad.statusCode).toBe(422)

    expect((await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/submit`)).statusCode).toBe(200)
    expect((await call('buyerA', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(200)
    const ap = await call('ceoA', 'POST', `/procurement/purchase-orders/${poId}/approve`, { payByCash: true })
    expect(ap.statusCode, ap.body).toBe(200)
    const v = await prisma.cashVoucher.findFirstOrThrow({ where: { purchaseOrderId: poId } })
    expect(v.tenantId).toBe(T.A)
  })

  it('cannot be sent or received until its supplier is chosen', async () => {
    const sent = await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/mark-sent`, { channel: 'in_person' })
    expect(code(sent)).toBe('PO_SUPPLIER_NOT_CHOSEN')
    const rc = await call('storeA', 'POST', `/procurement/purchase-orders/${poId}/receive`, {
      locationId: locA, photoUrl: 'https://example.com/dock.jpg', lines: lines.map((l) => ({ poLineId: l.id, quantityReceived: 10 })),
    })
    expect(rc.statusCode).toBe(422)
  })

  it('company B cannot see or set it; another company\'s supplier is refused; then it is chosen once', async () => {
    expect((await call('buyerB', 'PUT', `/procurement/purchase-orders/${poId}/supplier`, { supplierId: supB })).statusCode).toBe(404)
    expect((await call('buyerA', 'PUT', `/procurement/purchase-orders/${poId}/supplier`, { supplierId: supB })).statusCode).toBe(404)
    const ok = await call('buyerA', 'PUT', `/procurement/purchase-orders/${poId}/supplier`, { supplierId: supA })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).supplierId).toBe(supA)
    const again = await call('buyerA', 'PUT', `/procurement/purchase-orders/${poId}/supplier`, { supplierId: supA })
    expect(code(again)).toBe('PO_SUPPLIER_ALREADY_CHOSEN')
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/mark-sent`, { channel: 'in_person' })).statusCode).toBe(200)
    const rc = await call('storeA', 'POST', `/procurement/purchase-orders/${poId}/receive`, {
      locationId: locA, photoUrl: 'https://example.com/dock.jpg', lines: lines.map((l) => ({ poLineId: l.id, quantityReceived: 10 })),
    })
    expect(rc.statusCode, rc.body).toBe(201)
  })
})
