// Move a PO to another company (owner, 2026-11-14: "Give button to transfer to other company"): a new draft in the
// target on its own supplier account and items, the old one cancelled; member of both; only before approval.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
let C: Company
let both: Who
let onlyA: Who
let supA = ''
let itemA = ''
let masterId = ''

const hdr = (w: Who, t?: string) => ({ authorization: `Bearer ${w.token}`, ...(t ? { 'x-servd-active-tenant': t } : {}) })
const mkPo = async (lines: unknown[], supplierId: string | null = supA) => {
  const r = await app.inject({ method: 'POST', url: '/procurement/purchase-orders', payload: { supplierId, lines } as never, headers: hdr(both, A.tenantId) })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
const move = (id: string, tenantId: string, w: Who = both) =>
  app.inject({ method: 'POST', url: `/procurement/purchase-orders/${id}/move-company`, payload: { tenantId }, headers: hdr(w, A.tenantId) })

beforeAll(async () => {
  A = await mkCompany('pomv-a'); B = await mkCompany('pomv-b'); C = await mkCompany('pomv-c')
  both = await mkUser('pomvBoth', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: both.id } })
  onlyA = await mkUser('pomvOnlyA', 'admin', A.tenantId)
  const m = await prisma.ingredientMaster.create({ data: { name: 'POMV Beef mince', normalizedName: 'pomv beef mince', stockUnit: 'g', category: 'food' } as never })
  masterId = m.id
  itemA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'POMV Beef mince', unit: 'kg', category: 'food', unitCostCents: 170000, masterIngredientId: m.id } as never })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
  const s = await app.inject({ method: 'POST', url: '/procurement/suppliers', payload: { name: 'POMV Karachi Meat' }, headers: hdr(both, A.tenantId) })
  expect(s.statusCode, s.body).toBe(201)
  supA = s.json().id
}, 60_000)
afterAll(async () => { await app?.close() })

describe('move a PO to another company', () => {
  it('makes a draft in the target on its own account and item, same value, and cancels the old one', async () => {
    const id = await mkPo([{ inventoryItemId: itemA, quantityOrdered: 5, unitCostCents: 170000 }])
    const r = await move(id, B.tenantId)
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.supplierKept).toBe(true)
    const old = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })
    expect(old.status).toBe('cancelled')
    expect(old.cancelReason).toContain('Moved to')
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: body.newId }, include: { supplier: true, lines: { include: { inventoryItem: true } } } })
    expect(po.status).toBe('draft')
    expect(po.supplier.tenantId).toBe(B.tenantId)
    expect(po.supplier.name).toBe('POMV Karachi Meat')
    expect(po.reference).toMatch(/^PO-\d{5}$/)
    expect(po.lines).toHaveLength(1)
    expect(po.lines[0].inventoryItem.tenantId).toBe(B.tenantId)
    expect(po.lines[0].inventoryItem.masterIngredientId).toBe(masterId)
    expect(Number(po.totalCents)).toBe(Number(old.totalCents))
    expect(Number(po.totalCents)).toBe(850000)
    // Both companies carry the audit row.
    expect(await prisma.auditLog.count({ where: { action: 'po.move_company', tenantId: { in: [A.tenantId, B.tenantId] }, OR: [{ entityId: id }, { entityId: body.newId }] } })).toBe(2)
  })

  it('a PO with no supplier arrives with no supplier yet', async () => {
    const id = await mkPo([{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 170000 }], null)
    const r = await move(id, B.tenantId)
    expect(r.statusCode, r.body).toBe(200)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().newId }, include: { supplier: true } })
    expect(po.supplier.tenantId).toBe(B.tenantId)
    expect(po.supplier.systemKind).toBeTruthy()
  })

  it('refuses a company the caller is not in, the same company, and an item not on the sheet', async () => {
    const id = await mkPo([{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 170000 }])
    expect((await move(id, C.tenantId)).json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    expect((await move(id, B.tenantId, onlyA)).json().error.code).toBe('NOT_IN_BOTH_COMPANIES')
    expect((await move(id, A.tenantId)).json().error.code).toBe('SAME_COMPANY')
    const loose = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'POMV loose item', unit: 'pcs', category: 'packaging', unitCostCents: 100 } as never })).id
    const id2 = await mkPo([{ inventoryItemId: loose, quantityOrdered: 1, unitCostCents: 100 }])
    const r = await move(id2, B.tenantId)
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('ITEM_NOT_ON_SHEET')
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: id2 } })).status).toBe('draft')
  })

  it('refuses once approved, and another company cannot see the PO', async () => {
    const id = await mkPo([{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 170000 }])
    await prisma.purchaseOrder.update({ where: { id }, data: { status: 'approved' } })
    const r = await move(id, B.tenantId)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('PO_MOVE_TOO_LATE')
    const outsider = await mkUser('pomvC', 'admin', C.tenantId)
    const x = await app.inject({ method: 'POST', url: `/procurement/purchase-orders/${id}/move-company`, payload: { tenantId: C.tenantId }, headers: hdr(outsider, C.tenantId) })
    expect(x.statusCode).toBe(404)
  })
})
