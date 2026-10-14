// Simulated-shift audit fixes, procurement (BOH-09, BOH-13, BOH-14, BOOKS-04).
//
// What this guards:
//   - BOH-09: the buyer role ('procurement') holds the procurement module, so
//     it can raise / list / submit / send / mark-sent POs and read bills,
//     payments, AP aging, reorder and price history — it used to get the page
//     and a 403 on every call. Money (bills, payments), receiving and
//     approval stay with managers / the CEO. Company B's buyer gets 404 on
//     company A's rows; a supplier the buyer adds binds to the active company.
//   - BOH-14: an auto-approved (or CEO-approved) PO is 'approved', not 'sent';
//     it becomes 'sent' only when sendPoToSupplier actually delivers it or a
//     buyer marks it sent (phone / WhatsApp / in person). A supplier with no
//     contact fails the send and the PO stays approved; an approved-but-unsent
//     PO cannot be received; an approved PO counts as on order.
//   - BOOKS-04: a bill or payment dated in a closed period is 422
//     PERIOD_LOCKED and NOTHING is saved (the save and the posting are one
//     transaction); an open-period one is on the books on save; AP aging equals
//     ledger AP 2010; one company's close never blocks another; createPaymentTx
//     (the petty-cash / till path) posts in its caller's transaction; voids
//     reverse with the void; POST /procurement/post-unposted backfills the
//     caller's companies only and reports closed-month rows.
//   - BOH-13 (FIFO lots, wave B): the receipt booked the goods at the PO
//     price (Dr 1210 / Cr 2015); a bill above / below it clears 2015 at that
//     cost and re-prices the lot (ItemPriceHistory 'bill_match') — the share
//     still on hand to 1210, the share already used to 5060; posting twice
//     changes nothing; a void restores the lot cost and trues up 5060 for
//     stock used in between.
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
import { createPo, submitPo, createPaymentTx, agingReport } from '../src/modules/procurement/service.js'
import { postSupplierBill } from '../src/modules/accounting/supplierPosting.js'
import { consumeFifoTx } from '../src/lib/stockLedger.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

let tenantA: string
let tenantB: string
let supA: string        // A, no email / phone
let supMailA: string    // A, email on file
let supB: string
let flourA: string
let flourB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
const PHOTO = 'https://example.com/dock.jpg'
const DAY = 86_400_000
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()

async function mkUser(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.auditproc@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

/** Net debit (debit − credit) on `code` in `tenantId`, optionally one entry. */
async function netDebit(tenantId: string, code: string, reference?: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code } })
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    where: { accountId: acct.id, ...(reference ? { journalEntry: { reference, tenantId } } : {}) },
    _sum: { amountCents: true },
  })
  const dr = sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0
  const cr = sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0
  return dr - cr
}

const entry = (tenantId: string, reference: string) =>
  prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })

/** A PO raised by the buyer, submitted (auto-approved) and marked sent. */
async function sentPoFor(supplierId: string, inventoryItemId: string, qty: number, cost: number) {
  const created = await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId, lines: [{ inventoryItemId, quantityOrdered: qty, unitCostCents: cost }] })
  expect(created.statusCode).toBe(201)
  const po = created.json() as { id: string; lines: Array<{ id: string }> }
  expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)).json().status).toBe('approved')
  expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/mark-sent`, { channel: 'phone' })).statusCode).toBe(200)
  return { poId: po.id, poLineId: po.lines[0]!.id }
}

async function receive(poId: string, poLineId: string, qty: number) {
  const r = await call('mgrA', 'POST', `/procurement/purchase-orders/${poId}/receive`, { photoUrl: PHOTO, lines: [{ poLineId, quantityReceived: qty }] })
  expect(r.statusCode).toBe(201)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'AUDIT-P A', slug: 'audit-proc-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'AUDIT-P B', slug: 'audit-proc-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()

  supA     = (await prisma.supplier.create({ data: { name: 'Clifton Bakers Supply', tenantId: tenantA, paymentTermsDays: 10 } })).id
  supMailA = (await prisma.supplier.create({ data: { name: 'Karachi Meat Co', tenantId: tenantA, paymentTermsDays: 10, email: 'orders@kmc.example' } })).id
  supB     = (await prisma.supplier.create({ data: { name: 'B Farms', tenantId: tenantB, paymentTermsDays: 10 } })).id
  flourA   = (await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 1_000 } })).id
  flourB   = (await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', tenantId: tenantB, currentStock: 0, unitCostCents: 1_000 } })).id

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('mgrA', 'management', tenantA)
  await mkUser('buyerA', 'procurement', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('buyerB', 'procurement', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ─── BOH-09 ──────────────────────────────────────────────────────────────────

describe('BOH-09: the buyer role can buy', () => {
  let poA: string
  let billA: string

  it('raises, lists, opens, submits and marks sent a PO; reads bills, payments, AP aging, reorder, price history, statements', async () => {
    const created = await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: flourA, quantityOrdered: 5, unitCostCents: 1_000 }] })
    expect(created.statusCode).toBe(201)
    poA = created.json().id

    const list = await call('buyerA', 'GET', '/procurement/purchase-orders')
    expect(list.statusCode).toBe(200)
    expect((list.json() as Array<{ id: string }>).map((p) => p.id)).toContain(poA)
    expect((await call('buyerA', 'GET', `/procurement/purchase-orders/${poA}`)).statusCode).toBe(200)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poA}/submit`)).json().status).toBe('approved')
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poA}/mark-sent`, { channel: 'phone' })).json().status).toBe('sent')

    billA = (await call('ceoA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: 'CBS-1', billDate: iso(0), lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: 1_000, expenseAccountCode: '6040' }],
    })).json().id

    for (const url of ['/procurement/bills', `/procurement/bills/${billA}`, `/procurement/bills/${billA}/match`, '/procurement/payments',
      '/procurement/ap-aging', '/procurement/reorder', '/procurement/price-history', `/procurement/suppliers/${supA}/statement`]) {
      expect([url, (await call('buyerA', 'GET', url)).statusCode]).toEqual([url, 200])
    }
  })

  it('money, receiving and approval stay with managers and the CEO', async () => {
    expect((await call('buyerA', 'POST', '/procurement/bills', { supplierId: supA, billNumber: 'CBS-X', billDate: iso(0), lines: [{ description: 'x', quantity: 1, unitCostCents: 1 }] })).statusCode).toBe(403)
    expect((await call('buyerA', 'POST', '/procurement/payments', { supplierId: supA, paymentDate: iso(0), method: 'cash', amountCents: 100 })).statusCode).toBe(403)
    expect((await call('buyerA', 'POST', `/procurement/bills/${billA}/void`, { reason: 'x' })).statusCode).toBe(403)
    expect((await call('buyerA', 'POST', '/procurement/post-unposted', {})).statusCode).toBe(403)
    const line = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: poA } })).id
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poA}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: line, quantityReceived: 5 }] })).statusCode).toBe(403)

    const big = await createPo({ supplierId: supA, lines: [{ inventoryItemId: flourA, quantityOrdered: 1, unitCostCents: 6_000_000 }], createdBy: users['buyerA']!.id })
    expect((await submitPo(big.id, users['buyerA']!.id)).status).toBe('pending_approval')
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${big.id}/approve`)).statusCode).toBe(403)
  })

  it("company B's buyer gets 404 on company A's POs, bills and suppliers, and never sees them listed", async () => {
    expect((await call('buyerB', 'GET', `/procurement/purchase-orders/${poA}`)).statusCode).toBe(404)
    expect((await call('buyerB', 'POST', `/procurement/purchase-orders/${poA}/cancel`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call('buyerB', 'POST', `/procurement/purchase-orders/${poA}/send`)).statusCode).toBe(404)
    expect((await call('buyerB', 'GET', `/procurement/bills/${billA}`)).statusCode).toBe(404)
    expect((await call('buyerB', 'GET', `/procurement/bills/${billA}/match`)).statusCode).toBe(404)
    expect((await call('buyerB', 'GET', `/procurement/suppliers/${supA}/statement`)).statusCode).toBe(404)
    expect((await call('buyerB', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: flourA, quantityOrdered: 1, unitCostCents: 1 }] })).statusCode).toBe(404)
    // B's own supplier with A's item: cross-company attach is 422.
    expect((await call('buyerB', 'POST', '/procurement/purchase-orders', { supplierId: supB, lines: [{ inventoryItemId: flourA, quantityOrdered: 1, unitCostCents: 1 }] })).statusCode).toBe(422)
    const listB = (await call('buyerB', 'GET', '/procurement/purchase-orders')).json() as Array<{ id: string }>
    expect(listB.map((p) => p.id)).not.toContain(poA)
    const billsB = (await call('buyerB', 'GET', '/procurement/bills')).json() as Array<{ id: string }>
    expect(billsB.map((b) => b.id)).not.toContain(billA)
    const reorderB = JSON.stringify((await call('buyerB', 'GET', '/procurement/reorder')).json())
    expect(reorderB).not.toContain(flourA)
  })

  it('a buyer adds a supplier to the active company; the opening balance and company moves stay with managers', async () => {
    const r = await call('buyerA', 'POST', '/procurement/suppliers', { name: 'New Veg Co', openingBalanceCents: 0 })
    expect(r.statusCode).toBe(201)
    expect(r.json().tenantId).toBe(tenantA)
    expect((await call('buyerA', 'POST', '/procurement/suppliers', { name: 'Owed Co', openingBalanceCents: 50_000 })).statusCode).toBe(403)
    // The edit form re-sends the unchanged balance and company — allowed.
    expect((await call('buyerA', 'PATCH', `/procurement/suppliers/${r.json().id}`, { phone: '0300', openingBalanceCents: 0, tenantId: tenantA })).statusCode).toBe(200)
    expect((await call('buyerA', 'PATCH', `/procurement/suppliers/${r.json().id}`, { openingBalanceCents: 10_000 })).statusCode).toBe(403)
    expect((await call('buyerB', 'PATCH', `/procurement/suppliers/${r.json().id}`, { phone: '0301' })).statusCode).toBe(404)
  })
})

// ─── BOH-14 ──────────────────────────────────────────────────────────────────

describe('BOH-14: approved is not sent', () => {
  it('a small PO is approved with no send date; a send with no contact fails and leaves it approved; it cannot be received until sent', async () => {
    const po = (await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: flourA, quantityOrdered: 40, unitCostCents: 500 }] })).json()
    const submit = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    expect(submit.json()).toMatchObject({ status: 'approved', needsApproval: false })
    let row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row.status).toBe('approved')
    expect(row.sentAt).toBeNull()
    expect(row.approvedAt).not.toBeNull()

    const send = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/send`)
    expect(send.statusCode).toBe(400)
    expect(send.json().error.code).toBe('NO_CONTACT')
    row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row.status).toBe('approved')
    expect(row.sentAt).toBeNull()

    const line = po.lines[0].id as string
    const rcv = await call('mgrA', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: line, quantityReceived: 40 }] })
    expect(rcv.statusCode).toBe(400)
    expect(rcv.json().error.code).toBe('PO_NOT_SENT')

    const marked = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/mark-sent`, { channel: 'whatsapp', note: 'sent from my phone' })
    expect(marked.json()).toMatchObject({ status: 'sent', channel: 'whatsapp' })
    row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row.status).toBe('sent')
    expect(row.sentAt).not.toBeNull()
    const log = await prisma.poActivityLog.findFirstOrThrow({ where: { purchaseOrderId: po.id, action: 'marked_sent' } })
    expect(log.details).toMatchObject({ channel: 'whatsapp', note: 'sent from my phone' })
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/mark-sent`, { channel: 'phone' })).statusCode).toBe(400)

    expect((await call('mgrA', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: line, quantityReceived: 40 }] })).statusCode).toBe(201)
  })

  it('sending by email marks it sent; a draft or unapproved PO cannot be sent or marked sent', async () => {
    const po = (await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId: supMailA, lines: [{ inventoryItemId: flourA, quantityOrdered: 1, unitCostCents: 500 }] })).json()
    const draftSend = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/send`)
    expect(draftSend.statusCode).toBe(400)
    expect(draftSend.json().error.code).toBe('PO_NOT_APPROVED')
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/mark-sent`, { channel: 'phone' })).json().error.code).toBe('PO_NOT_APPROVED')

    await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    const sent = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/send`)
    expect(sent.statusCode).toBe(200)
    expect(sent.json()).toMatchObject({ status: 'sent', channels: ['email'] })
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row).toMatchObject({ status: 'sent', sentToEmail: 'orders@kmc.example' })
    expect(row.sentAt).not.toBeNull()
  })

  it("the CEO's approval of a large PO approves it — it does not send it", async () => {
    const big = await createPo({ supplierId: supA, lines: [{ inventoryItemId: flourA, quantityOrdered: 1, unitCostCents: 7_000_000 }], createdBy: users['buyerA']!.id })
    await submitPo(big.id, users['buyerA']!.id)
    const r = await call('ceoA', 'POST', `/procurement/purchase-orders/${big.id}/approve`)
    expect(r.json().status).toBe('approved')
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: big.id } })
    expect(row.status).toBe('approved')
    expect(row.sentAt).toBeNull()
  })

  it('an approved PO counts as on order in the reorder list', async () => {
    const yeast = (await prisma.inventoryItem.create({ data: { name: 'Yeast', unit: 'kg', tenantId: tenantA, currentStock: 0, parLevel: 10, unitCostCents: 100, supplierId: supA } })).id
    const before = JSON.stringify((await call('buyerA', 'GET', '/procurement/reorder')).json())
    expect(before).toContain(yeast)
    const po = (await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: yeast, quantityOrdered: 10, unitCostCents: 100 }] })).json()
    await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    const after = JSON.stringify((await call('buyerA', 'GET', '/procurement/reorder')).json())
    expect(after).not.toContain(yeast)
  })
})

// ─── BOOKS-04 ────────────────────────────────────────────────────────────────

describe('BOOKS-04: supplier bills and payments post with their save', () => {
  let openBill: string

  beforeAll(async () => {
    // Company B's books are closed through two days ago.
    await prisma.periodLock.create({ data: { tenantId: tenantB, lockedThrough: new Date(Date.now() - 2 * DAY), lockedBy: users['ceoB']!.id } })
  })

  it('a bill dated in a closed period is 422 PERIOD_LOCKED and nothing is saved', async () => {
    const r = await call('ceoB', 'POST', '/procurement/bills', {
      supplierId: supB, billNumber: 'KMC-10388', billDate: iso(-5 * DAY), dueDate: iso(10 * DAY),
      lines: [{ description: 'Kitchen cleaning 10 packs', quantity: 10, unitCostCents: 220_000, expenseAccountCode: '6040' }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.supplierBill.count({ where: { billNumber: 'KMC-10388' } })).toBe(0)
  })

  it('a bill in the open period is on the books the moment it is saved', async () => {
    const r = await call('ceoB', 'POST', '/procurement/bills', {
      supplierId: supB, billNumber: 'KMC-10389', billDate: iso(0), lines: [{ description: 'Kitchen cleaning 10 packs', quantity: 10, unitCostCents: 220_000, expenseAccountCode: '6040' }],
    })
    expect(r.statusCode).toBe(201)
    openBill = r.json().id
    const je = await entry(tenantB, `supplier.bill:${openBill}`)
    expect(je).not.toBeNull()
    expect(je!.lines.find((l) => l.account.code === '2010')).toMatchObject({ type: 'credit', amountCents: 2_200_000 })
  })

  it('a payment dated in a closed period is refused and the bill is untouched; an open-period one posts', async () => {
    const locked = await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supB, paymentDate: iso(-3 * DAY), method: 'cash', amountCents: 500_000,
      applications: [{ billId: openBill, amountAppliedCents: 500_000 }],
    })
    expect(locked.statusCode).toBe(422)
    expect(locked.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.supplierPayment.count({ where: { supplierId: supB } })).toBe(0)
    expect(await prisma.supplierBill.findUniqueOrThrow({ where: { id: openBill } })).toMatchObject({ paidCents: 0, status: 'open' })

    const ok = await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supB, paymentDate: iso(0), method: 'cash', amountCents: 500_000,
      applications: [{ billId: openBill, amountAppliedCents: 500_000 }],
    })
    expect(ok.statusCode).toBe(201)
    expect(await entry(tenantB, `supplier.payment:${ok.json().id}`)).not.toBeNull()
  })

  it('AP aging equals ledger AP 2010', async () => {
    const aging = await agingReport([tenantB], { includeUnassigned: false })
    expect(aging.total.total).toBe(1_700_000)
    expect(-(await netDebit(tenantB, '2010'))).toBe(aging.total.total)
  })

  it("company B's closed period does not block company A", async () => {
    const r = await call('ceoA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: 'CBS-OLD', billDate: iso(-5 * DAY), lines: [{ description: 'Cleaning supplies', quantity: 1, unitCostCents: 3_000, expenseAccountCode: '6040' }],
    })
    expect(r.statusCode).toBe(201)
    expect(await entry(tenantA, `supplier.bill:${r.json().id}`)).not.toBeNull()
  })

  it('the petty-cash / till path (createPaymentTx) posts inside its caller\'s transaction', async () => {
    const bill = (await call('ceoB', 'POST', '/procurement/bills', {
      supplierId: supB, billNumber: 'KMC-PC', billDate: iso(0), lines: [{ description: 'Detergent', quantity: 1, unitCostCents: 40_000, expenseAccountCode: '6040' }],
    })).json()
    await expect(prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supB, paymentDate: iso(-4 * DAY), method: 'cash', amountCents: 40_000,
      applications: [{ billId: bill.id, amountAppliedCents: 40_000 }], createdBy: users['ceoB']!.id,
    }))).rejects.toMatchObject({ code: 'PERIOD_LOCKED' })
    expect(await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).toMatchObject({ paidCents: 0 })

    const p = await prisma.$transaction((tx) => createPaymentTx(tx, {
      supplierId: supB, paymentDate: iso(0), method: 'cash', amountCents: 40_000,
      applications: [{ billId: bill.id, amountAppliedCents: 40_000 }], createdBy: users['ceoB']!.id,
    }))
    expect(await entry(tenantB, `supplier.payment:${p.id}`)).not.toBeNull()
  })

  it('voiding a bill reverses it in the same transaction', async () => {
    const bill = (await call('ceoB', 'POST', '/procurement/bills', {
      supplierId: supB, billNumber: 'KMC-VOID', billDate: iso(0), lines: [{ description: 'Pest control', quantity: 1, unitCostCents: 90_000, expenseAccountCode: '6050' }],
    })).json()
    expect((await call('ceoB', 'POST', `/procurement/bills/${bill.id}/void`, { reason: 'duplicate' })).statusCode).toBe(200)
    expect(await entry(tenantB, `supplier.bill.void:${bill.id}`)).not.toBeNull()
    const aging = await agingReport([tenantB], { includeUnassigned: false })
    expect(-(await netDebit(tenantB, '2010'))).toBe(aging.total.total)
  })

  it("the backfill posts the caller's companies' unposted bills and payments, and lists closed-period ones", async () => {
    // Legacy rows saved before posting moved into the save's transaction.
    const mk = (supplierId: string, billNumber: string, billDate: string, cents: number) => prisma.supplierBill.create({
      // createdAt before the company's FIFO cut-over: a pre-FIFO bill posts the old way (Dr 1210).
      data: { supplierId, billNumber, billDate: new Date(billDate), dueDate: new Date(billDate), subtotalCents: cents, totalCents: cents, status: 'open',
        createdAt: new Date(Date.now() - 60 * DAY),
        lines: { create: [{ description: 'legacy', quantity: 1, unitCostCents: cents, lineTotalCents: cents }] } },
    })
    const openB   = await mk(supB, 'LEG-1', iso(0), 10_000)
    const lockedB = await mk(supB, 'LEG-2', iso(-5 * DAY), 20_000)
    const legacyA = await mk(supA, 'LEG-A', iso(0), 30_000)
    const payB = await prisma.supplierPayment.create({ data: { supplierId: supB, paymentDate: new Date(), method: 'bank_transfer', amountCents: 5_000 } })

    const dry = await call('ceoB', 'POST', '/procurement/post-unposted', {})
    expect(dry.statusCode).toBe(200)
    const dryRows = dry.json().rows as Array<{ id: string; outcome: string }>
    expect(dryRows.map((r) => r.id).sort()).toEqual([openB.id, lockedB.id, payB.id].sort())
    expect(dryRows.every((r) => r.outcome === 'would_post')).toBe(true)
    expect(await entry(tenantB, `supplier.bill:${openB.id}`)).toBeNull()

    const run = (await call('ceoB', 'POST', '/procurement/post-unposted', { dryRun: false })).json().rows as Array<{ id: string; outcome: string }>
    expect(run.find((r) => r.id === openB.id)!.outcome).toBe('posted')
    expect(run.find((r) => r.id === payB.id)!.outcome).toBe('posted')
    expect(run.find((r) => r.id === lockedB.id)!.outcome).toMatch(/^PERIOD_LOCKED/)
    expect(run.map((r) => r.id)).not.toContain(legacyA.id)
    expect(await entry(tenantB, `supplier.bill:${openB.id}`)).not.toBeNull()
    expect(await entry(tenantA, `supplier.bill:${legacyA.id}`)).toBeNull()
  })
})

// ─── BOH-13 ──────────────────────────────────────────────────────────────────

describe('BOH-13: a bill priced off the PO re-prices the lot; 1210 follows the lots', () => {
  async function stockItem(name: string, cost: number) {
    return (await prisma.inventoryItem.create({ data: { name, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: cost } })).id
  }
  const item = (id: string) => prisma.inventoryItem.findUniqueOrThrow({ where: { id } })
  const lotValue = async (id: string) => (await prisma.stockLot.findMany({ where: { inventoryItemId: id } })).reduce((s, l) => s + Number(l.remainingValueCents), 0)
  const use = (inventoryItemId: string, qty: number, key: string) => prisma.$transaction((tx) => consumeFifoTx(tx, {
    tenantId: tenantA, inventoryItemId, qty, kind: 'waste', sourceType: 'test.use', sourceId: key, clamp: false, occurredAt: new Date(),
  }))
  const billFor = async (number: string, poId: string, poLineId: string, inventoryItemId: string, qty: number, cost: number) => {
    const r = await call('ceoA', 'POST', '/procurement/bills', {
      supplierId: supMailA, poId, billNumber: number, billDate: iso(0),
      lines: [{ inventoryItemId, poLineId, description: number, quantity: qty, unitCostCents: cost }],
    })
    expect(r.statusCode).toBe(201)
    return r.json().id as string
  }

  it('billed above the PO price: 2015 clears at the PO cost, the lot is re-priced and 1210 carries the difference', async () => {
    const beef = await stockItem('Beef', 180_000)
    const { poId, poLineId } = await sentPoFor(supMailA, beef, 20, 180_000)
    await receive(poId, poLineId, 20)
    expect(await item(beef)).toMatchObject({ currentStock: 20, unitCostCents: 180_000 })

    const billId = await billFor('KMC-BEEF', poId, poLineId, beef, 20, 185_000)
    const after = await item(beef)
    expect(after.unitCostCents).toBe(185_000)
    const ref = `supplier.bill:${billId}`
    expect(await netDebit(tenantA, '2015', ref)).toBe(3_600_000)
    expect(await netDebit(tenantA, '1210', ref)).toBe(100_000)
    expect(await netDebit(tenantA, '5060', ref)).toBe(0)
    expect(await netDebit(tenantA, '2010', ref)).toBe(-3_700_000)
    expect(await lotValue(beef)).toBe(3_700_000)
    const history = await prisma.itemPriceHistory.findMany({ where: { inventoryItemId: beef, source: 'bill_match' } })
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ oldCostCents: 180_000, newCostCents: 185_000, supplierId: supMailA, poLineId })

    // Posting again is a no-op — the difference is applied once.
    expect((await postSupplierBill(billId)).posted).toBe(false)
    expect((await item(beef)).unitCostCents).toBe(185_000)
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: beef, source: 'bill_match' } })).toBe(1)
  })

  it('stock used before the bill: the used share of the difference goes to 5060, the rest re-prices the lot', async () => {
    const cheese = await stockItem('Cheese', 100_000)
    const { poId, poLineId } = await sentPoFor(supMailA, cheese, 10, 100_000)
    await receive(poId, poLineId, 10)
    await use(cheese, 4, 'cheese-1')   // 4 kg used at 1,000

    const billId = await billFor('KMC-CHEESE', poId, poLineId, cheese, 10, 110_000)
    expect((await item(cheese)).unitCostCents).toBe(110_000)
    const ref = `supplier.bill:${billId}`
    expect(await netDebit(tenantA, '2015', ref)).toBe(1_000_000)
    expect(await netDebit(tenantA, '1210', ref)).toBe(60_000)      // 6 on hand × 100 difference
    expect(await netDebit(tenantA, '5060', ref)).toBe(40_000)      // 4 used × 100 difference
    expect(await netDebit(tenantA, '2010', ref)).toBe(-1_100_000)
    expect(await lotValue(cheese)).toBe(660_000)

    // 3 more kg used at the new cost, then the bill is voided: the lot goes
    // back to the PO price and 5060 gives back what those 3 kg over-costed.
    await use(cheese, 3, 'cheese-2')
    expect((await call('ceoA', 'POST', `/procurement/bills/${billId}/void`, { reason: 'wrong price' })).statusCode).toBe(200)
    expect((await item(cheese)).unitCostCents).toBe(100_000)
    expect(await netDebit(tenantA, '1210', `supplier.bill.void:${billId}`)).toBe(-60_000)
    expect(await netDebit(tenantA, '5060', `supplier.bill.void:${billId}`)).toBe(-40_000)
    expect(await netDebit(tenantA, '2015', `supplier.bill.void:${billId}`)).toBe(-1_000_000)   // GRNI re-opened
    expect(await netDebit(tenantA, '1210', `supplier.bill.void.price:${billId}`)).toBe(30_000)
    expect(await netDebit(tenantA, '5060', `supplier.bill.void.price:${billId}`)).toBe(-30_000)
    expect(await lotValue(cheese)).toBe(300_000)                    // 3 kg left at 1,000
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { poLineId } })).billedQty).toBe(0)
  })

  it('billed below the PO price: the lot cost comes down with it', async () => {
    const oil = await stockItem('Oil', 50_000)
    const { poId, poLineId } = await sentPoFor(supMailA, oil, 10, 50_000)
    await receive(poId, poLineId, 10)
    const billId = await billFor('KMC-OIL', poId, poLineId, oil, 10, 45_000)
    const after = await item(oil)
    expect(after.unitCostCents).toBe(45_000)
    expect(await netDebit(tenantA, '1210', `supplier.bill:${billId}`)).toBe(-50_000)
    expect(await netDebit(tenantA, '5060', `supplier.bill:${billId}`)).toBe(0)
    expect(await lotValue(oil)).toBe(450_000)
  })

  it("company A's bill never re-costs company B's item", async () => {
    expect((await item(flourB)).unitCostCents).toBe(1_000)
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: flourB } })).toBe(0)
  })
})
