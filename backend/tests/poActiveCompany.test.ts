// A new PO binds to the ACTIVE company (owner, 2026-11-14: POs raised with Flipd picked landed in GS Foods because the
// supplier was GS Foods'). Suppliers are servd's: the pick resolves to the active company's own account with them.
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
let buyer: Who
let supA = ''
let itemA = ''
let itemB = ''

beforeAll(async () => {
  A = await mkCompany('poac-a')
  B = await mkCompany('poac-b')
  buyer = await mkUser('poacBuyer', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: buyer.id } })
  supA = (await prisma.supplier.create({ data: { name: 'POAC Pack It Up', tenantId: A.tenantId, phone: '03000000001' } })).id
  itemA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'POAC box A', unit: 'pcs', category: 'packaging', unitCostCents: 1000 } as never })).id
  itemB = (await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: 'POAC box B', unit: 'pcs', category: 'packaging', unitCostCents: 1000 } as never })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

const post = (payload: unknown, activeTenant?: string) => app.inject({
  method: 'POST', url: '/procurement/purchase-orders', payload: payload as Record<string, unknown>,
  headers: { authorization: `Bearer ${buyer.token}`, ...(activeTenant ? { 'x-servd-active-tenant': activeTenant } : {}) },
})

describe('a new PO lands in the company picked', () => {
  it("company B picked + company A's supplier → the PO is company B's, on B's own account with that supplier", async () => {
    // Suppliers are servd's (owner, 2026-11-14): A's account is linked to its servd supplier first.
    const patched = await app.inject({ method: 'PATCH', url: `/procurement/suppliers/${supA}`, payload: { notes: 'link' }, headers: { authorization: `Bearer ${buyer.token}` } })
    expect(patched.statusCode, patched.body).toBe(200)
    const r = await post({ supplierId: supA, lines: [{ inventoryItemId: itemB, quantityOrdered: 2, unitCostCents: 1000 }] }, B.tenantId)
    expect(r.statusCode, r.body).toBe(201)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().id }, include: { supplier: true } })
    expect(po.supplier.tenantId).toBe(B.tenantId)
    expect(po.supplier.name).toBe('POAC Pack It Up')
    expect(po.supplierId).not.toBe(supA)
    const a = await prisma.supplier.findUniqueOrThrow({ where: { id: supA } })
    expect(po.supplier.masterSupplierId).toBe(a.masterSupplierId)
    // A second PO reuses B's account — never a second one.
    const again = await post({ supplierId: supA, lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 1000 }] }, B.tenantId)
    expect(again.statusCode, again.body).toBe(201)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: again.json().id } })).supplierId).toBe(po.supplierId)
    expect(await prisma.supplier.count({ where: { tenantId: B.tenantId, masterSupplierId: a.masterSupplierId, deletedAt: null } })).toBe(1)
  })

  it('company B picked + no supplier → the PO is company B\'s', async () => {
    const r = await post({ lines: [{ inventoryItemId: itemB, quantityOrdered: 2, unitCostCents: 1000 }] }, B.tenantId)
    expect(r.statusCode, r.body).toBe(201)
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().id }, include: { supplier: true } })
    expect(po.supplier.tenantId).toBe(B.tenantId)
  })

  it("company A active + its own supplier still works", async () => {
    const r = await post({ supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1000 }] })
    expect(r.statusCode, r.body).toBe(201)
  })
})
