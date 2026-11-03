// The PO approval chain and its cash (owner, 2026-11-03: "Whatever is being purchased, lets start making PO on
// servd. PO goes to Asif. Asif push to Hasnain. Hasnain push to me. approved by me. asif takes cash from hasnain.
// asif buys. person that created po marks received" — cash: "Cash voucher tied to PO").
//
//   - draft → buyer_check (the buyer) → finance_check (finance) → pending_approval (the CEO) → approved, whatever the
//     total; each step only its own role, never the raiser / an earlier signer; another company's PO is 404.
//   - Every step returns (→ draft, note ≥ 10) or rejects (→ cancelled).
//   - A buyer's own PO skips the buyer step (signed by raising).
//   - The CEO's approval raises ONE cash voucher (CV series of the PO's company) in the buyer's name, already approved.
//   - Finance's pay of it TOPS UP the buyer's box (opened at float 0 when none): Dr 1011 / Cr 1010 — never an
//     expense. The raiser receives the PO (Dr 1210 food, Dr 6045 non-food / Cr 2015). Finance bills the receipt
//     (Dr 2015 / Cr 2010) and the buyer pays it from the box (Dr 2010 / Cr 1011 net): the money is booked once.
//   - Two companies: B's buyer / finance / CEO get 404 on A's PO and voucher.
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

const P = `poch${Date.now()}`
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
const call = (key: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
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

/** The chef (a kitchen manager) raises a PO for 10 kg flour @ 200 + 5 soap (non-food) @ 300 = PKR 35. */
async function chefPo(): Promise<{ id: string; lines: Array<{ id: string; inventoryItemId: string }> }> {
  const r = await call('chefA', 'POST', '/procurement/purchase-orders', {
    supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 10, unitCostCents: 200 }, { inventoryItemId: soap, quantityOrdered: 5, unitCostCents: 300 }],
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
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

describe('the chain: buyer → finance → the CEO, each step its own people', () => {
  let poId = ''
  let lines: Array<{ id: string; inventoryItemId: string }> = []
  let voucherId = ''

  it('submit → the buyer; nobody else passes that step; B is 404', async () => {
    const po = await chefPo()
    poId = po.id
    lines = po.lines
    const s = await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/submit`)
    expect(s.statusCode, s.body).toBe(200)
    expect(s.json().status).toBe('buyer_check')
    // The bell: the buyer is told.
    expect((await approverIdsFor('purchase_order_buyer', poId))?.userIds).toEqual([U.buyerA!.id])
    // The buyer's queue lists it; finance's does not.
    expect(((await call('buyerA', 'GET', '/procurement/po-steps?step=buyer')).json() as Array<{ id: string }>).map((p) => p.id)).toContain(poId)
    expect(((await call('finA', 'GET', '/procurement/po-steps?step=finance')).json() as Array<{ id: string }>).map((p) => p.id)).not.toContain(poId)
    // The raiser, finance and the CEO's final route cannot take the buyer's step.
    expect((await call('chefA', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(403)
    expect((await call('finA', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(403)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(400)
    // Company B's buyer: A's PO does not exist.
    expect((await call('buyerB', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(404)
    expect(((await call('buyerB', 'GET', '/procurement/po-steps?step=buyer')).json() as Array<{ id: string }>).map((p) => p.id)).not.toContain(poId)
    const pass = await call('buyerA', 'POST', `/procurement/po-steps/${poId}/pass`)
    expect(pass.statusCode, pass.body).toBe(200)
    expect(pass.json().status).toBe('finance_check')
  })

  it('finance passes it to the CEO; the buyer who checked it cannot; B is 404', async () => {
    expect((await approverIdsFor('purchase_order_finance', poId))?.userIds).toEqual([U.finA!.id])
    expect((await call('buyerA', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/procurement/po-steps/${poId}/pass`)).statusCode).toBe(404)
    const pass = await call('finA', 'POST', `/procurement/po-steps/${poId}/pass`)
    expect(pass.statusCode, pass.body).toBe(200)
    expect(pass.json().status).toBe('pending_approval')
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })
    expect(po).toMatchObject({ buyerCheckedById: U.buyerA!.id, financeCheckedById: U.finA!.id, submittedById: U.chefA!.id })
  })

  it("the CEO approves (B's CEO 404, finance 403) and the PO's cash voucher is raised in the buyer's name", async () => {
    expect((await call('finA', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(404)
    const a = await call('ceoA', 'POST', `/procurement/purchase-orders/${poId}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json().status).toBe('approved')
    voucherId = a.json().cashVoucher.id
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })
    expect(v).toMatchObject({
      tenantId: T.A, purchaseOrderId: poId, status: 'approved', kind: 'request', amountCents: 3_500,
      payeeUserId: U.buyerA!.id, financeApprovedById: U.finA!.id, directorSignedById: U.ceoA!.id, category: null,
    })
    expect(v.number).toMatch(/^CV-\d{5}$/)
    // Raising it posted nothing.
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A, reference: { contains: voucherId } } })).toBe(0)
  })

  it("the voucher is locked to the PO, cash only, and B's finance cannot see it", async () => {
    const patch = await call('finA', 'PATCH', `/trustops/cash-vouchers/${voucherId}`, { amountCents: 1 })
    expect(patch.statusCode).toBe(409)
    expect(code(patch)).toBe('PO_VOUCHER_LOCKED')
    const credit = await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, { source: 'credit', supplierId: supA })
    expect(credit.statusCode).toBe(422)
    expect(code(credit)).toBe('PO_VOUCHER_CASH_ONLY')
    expect((await call('finB', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, {})).statusCode).toBe(404)
    // The buyer does not pay himself: finance pays.
    expect((await call('buyerA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, {})).statusCode).toBe(403)
  })

  it("finance pays: the cash goes into the buyer's box (opened at 0) — Dr 1011 / Cr 1010, never an expense", async () => {
    const before6xxx = await prisma.journalLine.count({ where: { journalEntry: { tenantId: T.A }, account: { code: { startsWith: '6' } } } })
    const r = await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, { source: 'cash_on_hand' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().toBox.opened).toBe(true)
    const box = await prisma.pettyCashBox.findFirstOrThrow({ where: { tenantId: T.A, custodianId: U.buyerA!.id } })
    expect(box.floatCents).toBe(3_500)
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })
    expect(v).toMatchObject({ status: 'disbursed', paySource: 'cash_on_hand', payAccountCode: '1010', bookedAtPay: true })
    expect(await entryLines(`pettycash.topup:${v.pettyCashMovementId}`)).toEqual([['1010', 'credit', 3_500], ['1011', 'debit', 3_500]])
    expect(await prisma.journalLine.count({ where: { journalEntry: { tenantId: T.A }, account: { code: { startsWith: '6' } } } })).toBe(before6xxx)
    expect(r.json().voucher.paidAccountCode).toBe('1011')
    // Paid once.
    expect((await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, {})).statusCode).toBe(409)
    // Change is never "returned on the voucher": it stays in the box.
    const back = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box.id, type: 'topup', source: 'cash_request', cashVoucherId: voucherId, amountCents: 100, reason: 'change' })
    expect(back.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('the raiser receives it: flour on 1210, the non-food soap straight to 6045, all against 2015', async () => {
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/mark-sent`, { channel: 'in_person' })).statusCode).toBe(200)
    const r = await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/receive`, {
      locationId: locA, photoUrl: 'https://example.com/dock.jpg',
      lines: lines.map((l) => ({ poLineId: l.id, quantityReceived: l.inventoryItemId === flour ? 10 : 5 })),
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(await entryLines(`procurement.receipt:${r.json().receipt.id}`)).toEqual([
      ['1210', 'debit', 2_000], ['2015', 'credit', 3_500], ['6045', 'debit', 1_500],
    ])
    // Soap: a lot opened and issued at once — no stock value, no 50x0 / 12x0 issue entry.
    const soapLot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: soap } })
    expect(soapLot).toMatchObject({ costClass: 'non_food', remainingQty: 0, remainingValueCents: 0 })
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A, reference: `inventory.issue_on_receipt:${soapLot.id}` } })).toBe(0)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: soap } })).currentStock).toBe(0)
    expect(await netDebit(T.A, '1230')).toBe(0)
    expect(await netDebit(T.A, '5010')).toBe(0)
  })

  it('finance bills the receipt and the buyer pays it from his box: the money is booked once', async () => {
    const receipt = await prisma.goodsReceipt.findFirstOrThrow({ where: { poId }, include: { lines: true } })
    const bill = await call('finA', 'POST', '/procurement/bills', {
      supplierId: supA, poId, billNumber: `${P}-INV1`, billDate: new Date().toISOString().slice(0, 10),
      lines: receipt.lines.map((l) => ({ receiptLineId: l.id, inventoryItemId: l.inventoryItemId, description: l.description ?? 'x', quantity: l.receivedQty, unitCostCents: l.inventoryItemId === flour ? 200 : 300 })),
    })
    expect(bill.statusCode, bill.body).toBe(201)
    expect(await entryLines(`supplier.bill:${bill.json().id}`)).toEqual([['2010', 'credit', 3_500], ['2015', 'debit', 3_500]])
    const box = await prisma.pettyCashBox.findFirstOrThrow({ where: { tenantId: T.A, custodianId: U.buyerA!.id } })
    const pay = await call('buyerA', 'POST', '/trustops/petty-cash/movements', { boxId: box.id, type: 'spend', amountCents: 3_500, reason: 'Paid Metro for the PO', supplierBillId: bill.json().id })
    expect(pay.statusCode, pay.body).toBe(201)
    expect((await prisma.pettyCashBox.findUniqueOrThrow({ where: { id: box.id } })).floatCents).toBe(0)
    // Cash 1010 → the buyer's box 1011 → the supplier; 2015 and 2010 cleared; flour on 1210, soap on 6045.
    expect(await netDebit(T.A, '1011')).toBe(0)
    expect(await netDebit(T.A, '1010')).toBe(-3_500)
    expect(await netDebit(T.A, '2015')).toBe(0)
    expect(await netDebit(T.A, '2010')).toBe(0)
    expect(await netDebit(T.A, '1210')).toBe(2_000)
    expect(await netDebit(T.A, '6045')).toBe(1_500)
  })
})

describe('returns, rejects and the buyer raising', () => {
  it('every step can return (note ≥ 10) to draft; a resubmit starts the chain again', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    const short = await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/return`, { note: 'no' })
    expect(short.statusCode).toBe(400)
    const back = await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/return`, { note: 'Soap is cheaper at Metro, change it' })
    expect(back.statusCode, back.body).toBe(200)
    let row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row).toMatchObject({ status: 'draft', returnCount: 1, returnedById: U.buyerA!.id, returnNote: 'Soap is cheaper at Metro, change it' })
    expect((await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)).json().status).toBe('buyer_check')
    await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    // Finance returns too; then the CEO returns from the final step.
    expect((await call('finA', 'POST', `/procurement/po-steps/${po.id}/return`, { note: 'Attach the quotation please' })).statusCode).toBe(200)
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    await call('finA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    expect((await call('ceoA', 'POST', `/procurement/po-steps/${po.id}/return`, { note: 'Order half the flour this week' })).statusCode).toBe(200)
    row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row).toMatchObject({ status: 'draft', returnCount: 3, buyerCheckedById: null, financeCheckedById: null })
    expect(await prisma.cashVoucher.count({ where: { purchaseOrderId: po.id } })).toBe(0)
  })

  it("a reject at any step is final (cancelled); the CEO's reject too", async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    const rej = await call('finA', 'POST', `/procurement/po-steps/${po.id}/reject`, { reason: 'Not in this month budget' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe('cancelled')

    const po2 = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po2.id}/submit`)
    await call('buyerA', 'POST', `/procurement/po-steps/${po2.id}/pass`)
    await call('finA', 'POST', `/procurement/po-steps/${po2.id}/pass`)
    const ceoRej = await call('ceoA', 'POST', `/procurement/purchase-orders/${po2.id}/reject`, { reason: 'Not needed' })
    expect(ceoRej.statusCode, ceoRej.body).toBe(200)
    expect(ceoRej.json().status).toBe('cancelled')
  })

  it("a buyer's own PO skips the buyer step; the CEO may approve without cash; cancelling a PO cancels its unpaid voucher", async () => {
    const r = await call('buyerA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 1, unitCostCents: 200 }] })
    const s = await call('buyerA', 'POST', `/procurement/purchase-orders/${r.json().id}/submit`)
    expect(s.json().status).toBe('finance_check')
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: r.json().id } })).buyerCheckedById).toBe(U.buyerA!.id)
    await call('finA', 'POST', `/procurement/po-steps/${r.json().id}/pass`)
    const noCash = await call('ceoA', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`, { payByCash: false })
    expect(noCash.statusCode, noCash.body).toBe(200)
    expect(noCash.json().cashVoucher).toBeNull()
    expect(await prisma.cashVoucher.count({ where: { purchaseOrderId: r.json().id } })).toBe(0)

    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('buyerA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    await call('finA', 'POST', `/procurement/po-steps/${po.id}/pass`)
    const a = await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    expect((await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/cancel`, { reason: 'Bought elsewhere' })).statusCode).toBe(200)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: a.json().cashVoucher.id } })).status).toBe('cancelled')
  })

  it("B's PO stays B's: B's chain never reaches A's people", async () => {
    const r = await call('buyerB', 'POST', '/procurement/purchase-orders', { supplierId: supB, lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 200 }] })
    expect(r.statusCode, r.body).toBe(201)
    await call('buyerB', 'POST', `/procurement/purchase-orders/${r.json().id}/submit`)
    expect((await call('finA', 'POST', `/procurement/po-steps/${r.json().id}/pass`)).statusCode).toBe(404)
    expect((await approverIdsFor('purchase_order_finance', r.json().id))?.userIds).toEqual([U.finB!.id])
    expect((await call('finB', 'POST', `/procurement/po-steps/${r.json().id}/pass`)).statusCode).toBe(200)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`)).statusCode).toBe(404)
    const a = await call('ceoB', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: a.json().cashVoucher.id } })
    expect(v).toMatchObject({ tenantId: T.B, payeeUserId: U.buyerB!.id })
    expect((await call('finA', 'POST', `/trustops/cash-vouchers/${v.id}/pay`, {})).statusCode).toBe(404)
  })
})
