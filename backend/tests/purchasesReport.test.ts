// Purchases by supplier (owner, 2026-11-26; procurement/purchasesReport.ts). Two companies (A, B).
//   • billed = bill lines + tax, credit notes off; grn = receipts at any stage, never an undone one;
//   • all = receipts + bill lines not for a receipt + what is still to arrive on live POs, each counted once;
//   • company B sees none of A's; a foreign supplierId is 404; a manager / finance read it, a cashier never.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let A: string
let B: string
let supA: string
let supA2: string
let supB: string
let brandA: string
let brandB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({ data: { name: key, email: `${key}.${RUN}@purrep.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary } })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const get = (who: string, qs: string) => app.inject({ method: 'GET', url: `/api/v1/procurement/purchases-report?${qs}`, headers: { authorization: `Bearer ${users[who]!.token}` } })
const D = (s: string) => new Date(`${s}T07:00:00Z`)
const RANGE = 'from=2026-11-01&to=2026-11-30'

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `PR A ${RUN}`, slug: `pr-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `PR B ${RUN}`, slug: `pr-b-${RUN}` } })).id
  supA = (await prisma.supplier.create({ data: { name: `Meat One ${RUN}`, tenantId: A } })).id
  supA2 = (await prisma.supplier.create({ data: { name: `Dairy Two ${RUN}`, tenantId: A } })).id
  supB = (await prisma.supplier.create({ data: { name: `B Supplier ${RUN}`, tenantId: B } })).id
  await mkUser('finA', 'finance', A)
  await mkUser('mgrA', 'manager', A)
  await mkUser('cashA', 'cashier', A)
  await mkUser('finB', 'finance', B)
  const item = (await prisma.inventoryItem.create({ data: { tenantId: A, name: `PR Beef ${RUN}`, unit: 'kg', category: 'food', unitCostCents: 150000 } as never })).id

  // A PO for 10 kg at 1,500: 6 kg received (GRN, waiting for finance), 4 kg still to arrive.
  const po = await prisma.purchaseOrder.create({ data: { supplierId: supA, status: 'partial', orderDate: D('2026-11-05'), reference: 'PO-TEST-1', totalCents: 1_500_000, lines: { create: [{ inventoryItemId: item, quantityOrdered: 10, quantityReceived: 6, unitCostCents: 150000 }] } }, include: { lines: true } })
  const grn = await prisma.goodsReceipt.create({ data: { tenantId: A, supplierId: supA, poId: po.id, receivedById: users['mgrA']!.id, receivedAt: D('2026-11-08'), grnNumber: `GRN-${RUN}-1`, grnStatus: 'finance_review', invoiceNumber: 'INV-9', invoiceTaxCents: 12_300, lines: { create: [{ inventoryItemId: item, description: 'Beef mince', receivedQty: 6, unit: 'kg', lotUnitCostCents: 150000, poLineId: po.lines[0]!.id }] } }, include: { lines: true } })
  // The PO and its receipt are brand A's; everything else has no brand.
  brandA = (await prisma.concept.create({ data: { name: `PR Brand ${RUN}`, slug: `pr-ba-${RUN}`, type: 'restaurant', tenantId: A } as never })).id
  brandB = (await prisma.concept.create({ data: { name: `PR Brand B ${RUN}`, slug: `pr-bb-${RUN}`, type: 'restaurant', tenantId: B } as never })).id
  await prisma.purchaseOrder.update({ where: { id: po.id }, data: { conceptId: brandA } })
  await prisma.goodsReceipt.update({ where: { id: grn.id }, data: { conceptId: brandA } })
  // An undone receipt never counts.
  await prisma.goodsReceipt.create({ data: { tenantId: A, supplierId: supA, receivedById: users['mgrA']!.id, receivedAt: D('2026-11-09'), grnNumber: `GRN-${RUN}-2`, grnStatus: 'undone', lines: { create: [{ description: 'Undone', receivedQty: 99, unit: 'kg', lotUnitCostCents: 100 }] } } })
  // A bill for that receipt (3 kg billed so far) and a direct expense bill; one credit note; one void bill.
  await prisma.supplierBill.create({ data: { supplierId: supA, billNumber: 'BILL-1', billDate: D('2026-11-10'), dueDate: D('2026-12-10'), status: 'open', subtotalCents: 450_000, taxCents: 12_300, totalCents: 462_300, lines: { create: [{ inventoryItemId: item, description: 'Beef mince', quantity: 3, unitCostCents: 150000, lineTotalCents: 450_000, receiptLineId: grn.lines[0]!.id }] } } })
  await prisma.supplierBill.create({ data: { supplierId: supA2, billNumber: 'BILL-2', billDate: D('2026-11-12'), dueDate: D('2026-12-12'), status: 'paid', subtotalCents: 80_000, taxCents: 0, totalCents: 80_000, lines: { create: [{ description: 'Cleaning', quantity: 2, unitCostCents: 40_000, lineTotalCents: 80_000, expenseAccountCode: '6040' }] } } })
  await prisma.supplierBill.create({ data: { supplierId: supA2, billNumber: 'CN-1', kind: 'credit_note', billDate: D('2026-11-13'), dueDate: D('2026-11-13'), status: 'open', subtotalCents: 10_000, totalCents: 10_000, lines: { create: [{ description: 'Rebate', quantity: 1, unitCostCents: 10_000, lineTotalCents: 10_000 }] } } })
  await prisma.supplierBill.create({ data: { supplierId: supA2, billNumber: 'VOID-1', billDate: D('2026-11-14'), dueDate: D('2026-12-14'), status: 'void', totalCents: 999_999, lines: { create: [{ description: 'Void', quantity: 1, unitCostCents: 999_999, lineTotalCents: 999_999 }] } } })
  // Company B's own bill.
  await prisma.supplierBill.create({ data: { supplierId: supB, billNumber: 'B-1', billDate: D('2026-11-10'), dueDate: D('2026-12-10'), status: 'open', subtotalCents: 70_000, totalCents: 70_000, lines: { create: [{ description: 'B item', quantity: 1, unitCostCents: 70_000, lineTotalCents: 70_000 }] } } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/api/v1/procurement' })
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close() })

type Rep = { suppliers: { supplierName: string; itemsCents: number; taxCents: number; totalCents: number; lines: { source: string; stage: string; amountCents: number; quantity: number }[] }[]; totals: { itemsCents: number; taxCents: number; totalCents: number } }
const of = (r: Rep, name: string) => r.suppliers.find((s) => s.supplierName.startsWith(name))

describe('purchases by supplier', () => {
  it('billed: bill lines and tax, credit notes off, void bills out', async () => {
    const res = await get('finA', `${RANGE}&basis=billed`)
    expect(res.statusCode, res.body).toBe(200)
    const r = res.json() as Rep
    expect(of(r, 'Meat One')).toMatchObject({ itemsCents: 450_000, taxCents: 12_300, totalCents: 462_300 })
    expect(of(r, 'Dairy Two')).toMatchObject({ itemsCents: 70_000, totalCents: 70_000 })
    expect(r.totals.totalCents).toBe(532_300)
    expect(r.suppliers.some((s) => s.supplierName.startsWith('B Supplier'))).toBe(false)
  })

  it('grn: every receipt at any stage, never an undone one', async () => {
    const r = (await get('mgrA', `${RANGE}&basis=grn`)).json() as Rep
    expect(r.suppliers).toHaveLength(1)
    expect(of(r, 'Meat One')).toMatchObject({ itemsCents: 900_000, taxCents: 12_300 })
    expect(of(r, 'Meat One')!.lines[0]!.stage).toContain('finance')
  })

  it('all: receipts + bills not for a receipt + what is still to arrive, each once', async () => {
    const r = (await get('finA', `${RANGE}&basis=all`)).json() as Rep
    const meat = of(r, 'Meat One')!
    // 6 kg received (900,000) + 4 kg still on the PO (600,000); the bill for the receipt is NOT counted again.
    expect(meat.itemsCents).toBe(1_500_000)
    expect(meat.lines.map((l) => l.source).sort()).toEqual(['GRN', 'Purchase order'])
    expect(meat.lines.find((l) => l.source === 'Purchase order')).toMatchObject({ quantity: 4, amountCents: 600_000 })
    expect(of(r, 'Dairy Two')).toMatchObject({ itemsCents: 80_000 })
    expect(r.totals.itemsCents).toBe(1_580_000)
  })

  it('brand filter: the brand on the order / delivery; a bill follows its receipt; another company\'s brand is 404', async () => {
    const all = (await get('finA', `${RANGE}&basis=all&conceptId=${brandA}`)).json() as Rep
    expect(all.suppliers).toHaveLength(1)
    expect(of(all, 'Meat One')).toMatchObject({ itemsCents: 1_500_000, taxCents: 12_300 })
    const billed = (await get('finA', `${RANGE}&basis=billed&conceptId=${brandA}`)).json() as Rep
    expect(billed.totals).toMatchObject({ itemsCents: 450_000, taxCents: 12_300 })
    const none = (await get('finA', `${RANGE}&basis=billed&conceptId=none`)).json() as Rep
    expect(none.suppliers.map((s) => s.supplierName.split(' ')[0])).toEqual(['Dairy'])
    expect(none.totals.totalCents).toBe(70_000)
    expect(((await get('finA', `${RANGE}&basis=grn&conceptId=none`)).json() as Rep).suppliers).toHaveLength(0)
    expect((await get('finA', `${RANGE}&conceptId=${brandB}`)).statusCode).toBe(404)
    expect((await get('finB', `${RANGE}&conceptId=${brandA}`)).statusCode).toBe(404)
  })

  it('company separation, one supplier, dates, access and the export', async () => {
    const b = (await get('finB', `${RANGE}&basis=all`)).json() as Rep
    expect(b.suppliers.map((s) => s.supplierName.split(' ')[0])).toEqual(['B'])
    expect((await get('finB', `${RANGE}&supplierId=${supA}`)).statusCode).toBe(404)
    const one = (await get('finA', `${RANGE}&basis=all&supplierId=${supA2}`)).json() as Rep
    expect(one.suppliers).toHaveLength(1)
    expect(((await get('finA', 'from=2026-10-01&to=2026-10-31&basis=all')).json() as Rep).suppliers).toHaveLength(0)
    expect((await get('finA', 'from=2026-11-30&to=2026-11-01')).statusCode).toBe(422)
    expect((await get('cashA', RANGE)).statusCode).toBe(403)
    const csv = await get('finA', `${RANGE}&basis=billed&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('Beef mince')
    expect(csv.body).toContain('TOTAL')
    expect((await get('finA', `${RANGE}&basis=all&format=pdf`)).statusCode).toBe(200)
  })
})
