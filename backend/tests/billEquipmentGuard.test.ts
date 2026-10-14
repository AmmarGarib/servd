// Equipment never comes in on a supplier bill (owner: "equipment only via
// CapEx") — fixedAssets/classes.ts assertNotEquipmentLine, called by
// procurement/service.ts createBill on every line that is not stock.
//
//   - 'Deep fryer' and 'Dinner plates x24' (smallwares) → 422 USE_CAPEX;
//     'Fryer repair' (service), 'Kraft bowl 500ml' (packaging) and stock lines
//     pass; a register-kept expense code (15xx) is always refused.
//   - An override (notEquipment + a reason ≥ 10) only by finance or the CEO:
//     audited 'supplier_bill.not_equipment_override' + a HIGH
//     'bill_equipment_override' flag in the supplier's company; a manager's
//     override is 403 and nothing is saved.
//   - Credit notes are not checked (they credit a bill already recorded).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createBill } from '../src/modules/procurement/service.js'
import { createCreditNote } from '../src/modules/procurement/creditNotes.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, supA: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
let n = 0

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@billeq.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const post = (who: string, lines: unknown[]) => app.inject({
  method: 'POST', url: '/procurement/bills', headers: { authorization: `Bearer ${users[who]!.token}` },
  payload: { supplierId: supA, billNumber: `EQ-${++n}-${RUN}`, billDate: new Date().toISOString(), lines },
})
const line = (description: string, extra: Record<string, unknown> = {}) => ({ description, quantity: 1, unitCostCents: 50_000, expenseAccountCode: '6050', ...extra })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'EQ A', slug: `eq-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'EQ B', slug: `eq-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('finA', 'finance', tenantA)
  supA = (await prisma.supplier.create({ data: { name: `EQ Traders ${RUN}`, tenantId: tenantA } })).id
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('equipment and smallwares are refused on a bill', () => {
  it("'Deep fryer' and 'Dinner plates x24' → 422 USE_CAPEX; nothing saved", async () => {
    for (const d of ['Deep fryer', 'Dinner plates x24']) {
      const r = await post('mgrA', [line(d)])
      expect(r.statusCode, d).toBe(422)
      expect(r.json().error.code).toBe('USE_CAPEX')
      expect(r.json().error.message).toMatch(/CapEx/)
    }
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(0)
  })

  it("a register-kept code is always refused, override or not (15xx → USE_CAPEX)", async () => {
    const r = await post('ceoA', [line('Fit-out works', { expenseAccountCode: '1510', notEquipment: true, notEquipmentReason: 'it is really an expense' })])
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('USE_CAPEX')
  })

  it("'Fryer repair', 'Kraft bowl 500ml' and stock lines pass", async () => {
    const r = await post('mgrA', [line('Fryer repair'), line('Kraft bowl 500ml', { expenseAccountCode: '6040' })])
    expect(r.statusCode, r.body).toBe(201)
    // A stock item named like equipment is never checked (it is stock, received first).
    const basket = (await prisma.inventoryItem.create({ data: { name: `Deep fryer basket liners ${RUN}`, unit: 'pcs', tenantId: tenantA, currentStock: 0 } })).id
    const rcv = await receiveGoods({ actor: { id: users['mgrA']!.id, role: 'manager' }, supplierId: supA, photoUrl: 'https://example.com/d.jpg', lines: [{ inventoryItemId: basket, quantityReceived: 10, unitCostCents: 100 }] })
    const s = await post('mgrA', [{ inventoryItemId: basket, receiptLineId: rcv.receipt.lines[0]!.id, description: 'Deep fryer', quantity: 10, unitCostCents: 100 }])
    expect(s.statusCode, s.body).toBe(201)
  })
})

describe('the override — finance or the CEO, with a reason, audited and flagged', () => {
  it('a manager\'s override is 403 OVERRIDE_NOT_ALLOWED; nothing saved', async () => {
    const before = await prisma.supplierBill.count({ where: { supplierId: supA } })
    const r = await post('mgrA', [line('Deep fryer', { notEquipment: true, notEquipmentReason: 'Hire for the weekend event' })])
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('OVERRIDE_NOT_ALLOWED')
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(before)
  })

  it('finance overrides with a reason: the bill records, audited and a HIGH flag in the supplier\'s company', async () => {
    await expect(createBill({
      supplierId: supA, billNumber: `EQ-FIN-SHORT-${RUN}`, billDate: new Date().toISOString(), createdBy: users['finA']!.id, actorRole: 'finance',
      lines: [line('Deep fryer', { notEquipment: true, notEquipmentReason: 'short' })],
    })).rejects.toMatchObject({ code: 'OVERRIDE_REASON_REQUIRED', statusCode: 422 })
    const b = await createBill({
      supplierId: supA, billNumber: `EQ-FIN-${RUN}`, billDate: new Date().toISOString(), createdBy: users['finA']!.id, actorRole: 'finance', actorEmail: 'fin@eq.test',
      lines: [line('Deep fryer', { notEquipment: true, notEquipmentReason: 'Rental of a deep fryer for one event' })],
    })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'supplier_bill.not_equipment_override', entityId: b.id } })
    expect(audit).toMatchObject({ tenantId: tenantA, userId: users['finA']!.id })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'bill_equipment_override', entityId: b.id } })
    expect(flag).toMatchObject({ tenantId: tenantA, severity: 'high' })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'bill_equipment_override', tenantId: tenantB } })).toBe(0)
  })

  it('a credit note is not checked: crediting the overridden line records', async () => {
    const r = await post('ceoA', [line('Coffee machine', { notEquipment: true, notEquipmentReason: 'Monthly rental of the coffee machine' })])
    expect(r.statusCode, r.body).toBe(201)
    const cn = await createCreditNote({
      billId: r.json().id, number: `EQ-CN-${RUN}`, date: new Date().toISOString(), reason: 'price',
      lines: [{ billLineId: r.json().lines[0].id, qty: 1, unitCostCents: 5_000 }], createdBy: users['ceoA']!.id,
    })
    expect(cn.creditNote.kind).toBe('credit_note')
  })
})
