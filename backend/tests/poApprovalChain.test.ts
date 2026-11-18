// The PO → GRN workflow (owner, 2026-11-05 — REPLACES the buyer → finance → CEO chain of 2026-11-03):
//
//   requester raises → the CEO approves (names the buyer: named / the company's one buyer / the requester; the cash
//   voucher in the buyer's name, as before) → the buyer buys, attaches the invoice, marks it completed → the REQUESTER
//   confirms receipt (a GRN: Dr 12x0 / Cr 2015) or sends it back with a note → finance verifies the GRN (never the
//   requester / buyer) or returns it to the buyer → the buyer resubmits → the CEO approves the GRN: the supplier bill
//   (Dr 2015 / Cr 2010) linked to the PO and the GRN → the buyer's box pays it.
//   No bypass: the dock / PO receive and a hand-made bill on such a PO are refused; a GRN is not approved before
//   finance. Two companies: B gets 404 on A's PO, GRN and files; my-tasks shows only the caller's own.
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
import { recordFileRoutes } from '../src/modules/recordFiles/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { approverIdsFor } from '../src/lib/approvalRights.js'
import { flushNotifications } from '../src/lib/staffNotify.js'

const P = `poch${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
let supA = '', supB = '', flour = '', soap = '', itemB = '', locA = ''
const today = () => new Date().toISOString().slice(0, 10)
const PDF = { fileName: 'invoice.pdf', mime: 'application/pdf', dataBase64: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]).toString('base64') }

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

/** The chef raises 10 kg flour @ 200 + 5 soap (non-food) @ 300 = PKR 35. */
async function chefPo(): Promise<{ id: string; lines: Array<{ id: string; inventoryItemId: string }> }> {
  const r = await call('chefA', 'POST', '/procurement/purchase-orders', {
    supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 10, unitCostCents: 200 }, { inventoryItemId: soap, quantityOrdered: 5, unitCostCents: 300 }],
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}
const upload = (who: string, poId: string) => call(who, 'POST', `/record-files/purchase_order/${poId}`, { files: [PDF] })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'PO Flow A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'PO Flow B', slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) await ensureChartOfAccounts(t)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('buyerA', 'procurement', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('chefA', 'boh_management', [T.A])
  await mkUser('storeA', 'manager', [T.A])
  await mkUser('ceoB', 'admin', [T.B])
  await mkUser('buyerB', 'procurement', [T.B])
  await mkUser('buyerB2', 'procurement', [T.B])
  await mkUser('mgrB', 'manager', [T.B])
  await mkUser('finB', 'finance', [T.B])

  supA = (await prisma.supplier.create({ data: { name: `${P} Metro`, tenantId: T.A, paymentTermsDays: 7, filerStatus: 'filer' } })).id
  supB = (await prisma.supplier.create({ data: { name: `${P} B Mart`, tenantId: T.B, paymentTermsDays: 0, filerStatus: 'filer' } })).id
  flour = (await prisma.inventoryItem.create({ data: { name: `${P} Flour`, unit: 'kg', tenantId: T.A, category: 'flour_grain', currentStock: 0, unitCostCents: 200 } })).id
  soap = (await prisma.inventoryItem.create({ data: { name: `${P} Dish soap`, unit: 'pcs', tenantId: T.A, category: 'non_food', issueOnReceipt: true, currentStock: 0, unitCostCents: 300 } })).id
  itemB = (await prisma.inventoryItem.create({ data: { name: `${P} B Flour`, unit: 'kg', tenantId: T.B, category: 'flour_grain', currentStock: 0, unitCostCents: 200 } })).id
  locA = (await prisma.location.create({ data: { slug: `${P}-la`, name: 'Flow outlet', tenantId: T.A } })).id

  app = Fastify({ bodyLimit: 30 * 1024 * 1024 })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(recordFileRoutes, { prefix: '/record-files' })
    await api.register(crosschecksRoutes, { prefix: '/crosschecks' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('the whole flow: CEO → buyer → requester → GRN → finance → CEO → bill → paid from the box', () => {
  let poId = ''
  let lines: Array<{ id: string; inventoryItemId: string }> = []
  let voucherId = ''
  let grnId = ''
  let billId = ''

  it('submit → straight to the CEO; only the CEO approves; B is 404', async () => {
    const po = await chefPo()
    poId = po.id
    lines = po.lines
    const s = await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/submit`)
    expect(s.statusCode, s.body).toBe(200)
    expect(s.json().status).toBe('pending_approval')
    expect((await approverIdsFor('purchase_order', poId))?.userIds).toEqual([U.ceoA!.id])
    expect((await call('finA', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(403)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${poId}/approve`)).statusCode).toBe(404)
    // The buyer cannot buy before the CEO approves.
    await upload('chefA', poId)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/complete`, { invoiceNumber: 'X', invoiceDate: today() })).statusCode).toBe(409)
  })

  it("the CEO approves: the company's one buyer is named, NO cash advance (owner, 2026-11-18); the log says how", async () => {
    const bad = await call('ceoA', 'POST', `/procurement/purchase-orders/${poId}/approve`, { buyerUserId: U.buyerB!.id })
    expect(bad.statusCode).toBe(422)
    expect(code(bad)).toBe('BUYER_NOT_IN_COMPANY')
    const a = await call('ceoA', 'POST', `/procurement/purchase-orders/${poId}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ status: 'approved', buyerUserId: U.buyerA!.id, buyerChosen: 'company_buyer', cashVoucher: null })
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })
    expect(row).toMatchObject({ grnWorkflow: true, buyerUserId: U.buyerA!.id, approvedById: U.ceoA!.id, payByCash: true, cashAfterPurchase: true })
    expect(await prisma.cashVoucher.count({ where: { OR: [{ purchaseOrderId: poId }, { tenantId: T.A, payeeUserId: U.buyerA!.id }] } })).toBe(0)
    const log = await prisma.poActivityLog.findFirstOrThrow({ where: { purchaseOrderId: poId, action: 'approved' } })
    expect(log.details).toMatchObject({ buyerUserId: U.buyerA!.id, buyerChosen: 'company_buyer', cashAfterPurchase: true })
    // The buyer is told; it is his task.
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: U.buyerA!.id, kind: 'task.next', entityId: poId } })).toBeGreaterThan(0)
    const tasks = (await call('buyerA', 'GET', '/procurement/my-tasks')).json()
    expect(tasks.toBuy.map((p: { id: string }) => p.id)).toContain(poId)
    expect((await call('chefA', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).not.toContain(poId)
    expect((await call('buyerB', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).not.toContain(poId)
  })

  it('only the buyer completes it, with an invoice file and number; the actual rate is logged', async () => {
    // Files: the buyer attaches; B's people cannot see or attach (404).
    expect((await upload('ceoB', poId)).statusCode).toBe(404)
    expect((await call('buyerB', 'GET', `/record-files/purchase_order/${poId}`)).statusCode).toBe(404)
    const body = { invoiceNumber: `${P}-INV1`, invoiceDate: today(), lines: [{ poLineId: lines.find((l) => l.inventoryItemId === flour)!.id, rateCents: 210 }] }
    const notBuyer = await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/complete`, body)
    expect(notBuyer.statusCode).toBe(403)
    expect(code(notBuyer)).toBe('PO_NOT_YOUR_TASK')
    expect(code(await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/complete`, { ...body, invoiceDate: '2099-01-01' }))).toBe('INVOICE_DATE_IN_FUTURE')
    expect((await call('buyerB', 'POST', `/procurement/purchase-orders/${poId}/complete`, body)).statusCode).toBe(404)
    const up = await upload('buyerA', poId)
    expect(up.statusCode, up.body).toBe(201)
    const done = await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/complete`, body)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json().status).toBe('completed')
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { lines: true } })
    expect(row).toMatchObject({ status: 'completed', invoiceNumber: `${P}-INV1`, completedById: U.buyerA!.id })
    expect(Number(row.totalCents)).toBe(10 * 210 + 5 * 300)
    const log = await prisma.poActivityLog.findFirstOrThrow({ where: { purchaseOrderId: poId, action: 'completed' } })
    expect(log.details).toMatchObject({ rateChanges: [{ fromRateCents: 200, toRateCents: 210 }] })
    // Twice: no.
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/complete`, body)).statusCode).toBe(409)
    expect((await call('chefA', 'GET', '/procurement/my-tasks')).json().toConfirm.map((p: { id: string }) => p.id)).toContain(poId)
  })

  it('no bypass: the dock, the PO receive route and the buyer cannot receive it; only the requester confirms', async () => {
    const rl = lines.map((l) => ({ poLineId: l.id, quantityReceived: l.inventoryItemId === flour ? 10 : 5 }))
    const dock = await call('storeA', 'POST', '/crosschecks/receiving', { poId, locationId: locA, photoUrl: 'https://example.com/d.jpg', lines: rl })
    expect(dock.statusCode).toBe(409)
    expect(code(dock)).toBe('USE_RECEIPT_CONFIRMATION')
    const viaPo = await call('storeA', 'POST', `/procurement/purchase-orders/${poId}/receive`, { locationId: locA, photoUrl: 'https://example.com/d.jpg', lines: rl })
    expect(code(viaPo)).toBe('USE_RECEIPT_CONFIRMATION')
    const buyer = await call('buyerA', 'POST', `/procurement/purchase-orders/${poId}/confirm-receipt`, { lines: rl })
    expect(code(buyer)).toBe('PO_NOT_YOUR_TASK')
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${poId}/confirm-receipt`, { lines: rl })).statusCode).toBe(404)
    // A hand-made bill on the PO is refused too.
    const hand = await call('finA', 'POST', '/procurement/bills', {
      supplierId: supA, poId, billNumber: `${P}-HAND`, billDate: today(),
      lines: [{ poLineId: rl[0]!.poLineId, description: 'x', quantity: 1, unitCostCents: 200 }],
    })
    expect(code(hand)).toBe('USE_GRN_APPROVAL')

    const ok = await call('chefA', 'POST', `/procurement/purchase-orders/${poId}/confirm-receipt`, { locationId: locA, lines: rl })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().status).toBe('received')
    grnId = ok.json().grn.id
    const g = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grnId } })
    expect(g).toMatchObject({ poId, tenantId: T.A, grnStatus: 'finance_review', invoiceNumber: `${P}-INV1`, receivedById: U.chefA!.id })
    expect(g.grnNumber).toMatch(/^GRN-\d{5}$/)
    // Stock in at the actual rate: Dr 1210 food, Dr 6045 non-food / Cr 2015.
    expect(await entryLines(`procurement.receipt:${grnId}`)).toEqual([['1210', 'debit', 2_100], ['2015', 'credit', 3_600], ['6045', 'debit', 1_500]])
    // Finance is told; the activity log carries the GRN.
    expect((await approverIdsFor('grn_finance', grnId))?.userIds).toEqual([U.finA!.id])
    expect(await prisma.poActivityLog.count({ where: { purchaseOrderId: poId, action: 'received' } })).toBe(1)
  })

  it('finance verifies — never the requester or buyer; a return needs a note and goes to the buyer, who resubmits', async () => {
    expect(code(await call('ceoA', 'POST', `/procurement/grns/${grnId}/approve`))).toBe('INVALID_STATE')   // not before finance
    expect((await call('ceoA', 'POST', `/procurement/grns/${grnId}/approve`)).statusCode).toBe(409)
    expect((await call('buyerA', 'POST', `/procurement/grns/${grnId}/finance-pass`)).statusCode).toBe(403)
    expect((await call('chefA', 'POST', `/procurement/grns/${grnId}/finance-pass`)).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/procurement/grns/${grnId}/finance-pass`)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/procurement/grns/${grnId}`)).statusCode).toBe(404)
    // Finance's queue lists it; the buyer has no finance queue.
    expect((await call('finA', 'GET', '/procurement/grns?queue=finance')).json().map((g: { id: string }) => g.id)).toContain(grnId)
    expect((await call('buyerA', 'GET', '/procurement/grns?queue=finance')).statusCode).toBe(403)
    expect((await call('finB', 'GET', '/procurement/grns?queue=finance')).json().map((g: { id: string }) => g.id)).not.toContain(grnId)

    const short = await call('finA', 'POST', `/procurement/grns/${grnId}/return`, { note: 'no' })
    expect(short.statusCode).toBe(422)
    expect(code(short)).toBe('NOTE_REQUIRED')
    expect((await call('finA', 'POST', `/procurement/grns/${grnId}/return`, { note: 'The invoice number has a typo, fix it' })).statusCode).toBe(200)
    expect((await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grnId } })).grnStatus).toBe('buyer_fix')
    expect((await call('buyerA', 'GET', '/procurement/my-tasks')).json().toFix.map((g: { id: string }) => g.id)).toContain(grnId)
    expect((await call('chefA', 'POST', `/procurement/grns/${grnId}/resubmit`, { invoiceNumber: `${P}-INV1A` })).statusCode).toBe(403)
    const re = await call('buyerA', 'POST', `/procurement/grns/${grnId}/resubmit`, { invoiceNumber: `${P}-INV1A` })
    expect(re.statusCode, re.body).toBe(200)
    expect(re.json().grnStatus).toBe('finance_review')
    const pass = await call('finA', 'POST', `/procurement/grns/${grnId}/finance-pass`)
    expect(pass.statusCode, pass.body).toBe(200)
    expect(pass.json().grnStatus).toBe('ceo_review')
    expect((await approverIdsFor('grn', grnId))?.userIds).toEqual([U.ceoA!.id])
    // Finance pulls it back from the CEO (owner, 2026-11-07), then verifies it again; company B 404, a buyer 403.
    expect((await call('finB', 'POST', `/procurement/grns/${grnId}/pull-back`)).statusCode).toBe(404)
    expect((await call('buyerA', 'POST', `/procurement/grns/${grnId}/pull-back`)).statusCode).toBe(403)
    const pb = await call('finA', 'POST', `/procurement/grns/${grnId}/pull-back`)
    expect(pb.statusCode, pb.body).toBe(200)
    expect(pb.json().grnStatus).toBe('finance_review')
    expect((await call('finA', 'POST', `/procurement/grns/${grnId}/finance-pass`)).statusCode).toBe(200)
    const actions = (await prisma.poActivityLog.findMany({ where: { purchaseOrderId: poId }, orderBy: { createdAt: 'asc' } })).map((a) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['created', 'submitted', 'approved', 'completed', 'received', 'grn_returned', 'grn_resubmitted', 'grn_finance_checked']))
  })

  it('the CEO approves the GRN: the supplier bill from the invoice, linked to the PO and the GRN; B is 404', async () => {
    expect((await call('finA', 'POST', `/procurement/grns/${grnId}/approve`)).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/procurement/grns/${grnId}/approve`)).statusCode).toBe(404)
    const a = await call('ceoA', 'POST', `/procurement/grns/${grnId}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    billId = a.json().supplierBillId
    const bill = await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId }, include: { lines: true } })
    expect(bill).toMatchObject({ supplierId: supA, poId, billNumber: `${P}-INV1A` })
    expect(Number(bill.totalCents)).toBe(3_600)
    expect(bill.lines.every((l) => !!l.receiptLineId && !!l.poLineId)).toBe(true)
    // Due = invoice date + the supplier's 7 days.
    expect(Math.round((bill.dueDate.getTime() - bill.billDate.getTime()) / 86_400_000)).toBe(7)
    expect(await entryLines(`supplier.bill:${billId}`)).toEqual([['2010', 'credit', 3_600], ['2015', 'debit', 3_600]])
    const g = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grnId } })
    expect(g).toMatchObject({ grnStatus: 'approved', supplierBillId: billId, approvedById: U.ceoA!.id })
    expect((await call('ceoA', 'POST', `/procurement/grns/${grnId}/approve`)).statusCode).toBe(409)
    // Finance (and the buyer, paying from his box) is told to pay.
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: U.finA!.id, entityId: grnId, kind: 'task.next' } })).toBe(1)
    const detail = (await call('finA', 'GET', `/procurement/grns/${grnId}`)).json()
    expect(detail.bill.id).toBe(billId)
    expect(detail.files.length).toBeGreaterThan(0)
  })

  it('the CEO\'s GRN approval raised the buyer\'s pay-back voucher at the bill; nobody else pays the bill', async () => {
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { reimbursesBillId: billId } })
    voucherId = v.id
    expect(v).toMatchObject({ tenantId: T.A, status: 'approved', amountCents: 3_600, payeeUserId: U.buyerA!.id, directorSignedById: U.ceoA!.id, financeApprovedById: U.finA!.id, purchaseOrderId: null })
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: U.finA!.id, entityId: v.id } })).toBeGreaterThan(0)
    // Locked: never edited; another company's finance 404; Supplier payments may not pay the bill around it.
    expect(code(await call('finA', 'PATCH', `/trustops/cash-vouchers/${v.id}`, { purpose: 'Something else entirely' }))).toBe('PO_VOUCHER_LOCKED')
    expect((await call('finB', 'POST', `/trustops/cash-vouchers/${v.id}/pay`, { source: 'cash_on_hand' })).statusCode).toBe(404)
    const around = await call('finA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: today(), method: 'cash', reference: 'x', amountCents: 3_600, applications: [{ billId, amountAppliedCents: 3_600 }],
    })
    expect(code(around), around.body).toBe('BILL_AWAITING_BUYER_PAYBACK')
    // Not on credit, never the buyer's own box.
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${v.id}/pay`, { source: 'credit' }))).toBe('PAY_BACK_CASH_ONLY')
    // The PO's screen shows it.
    const po = (await call('chefA', 'GET', `/procurement/purchase-orders/${poId}`)).json()
    expect(po.payBackVouchers.map((x: { id: string }) => x.id)).toEqual([v.id])
  })

  it('finance pays the buyer back: that IS the supplier payment — 2015 and 2010 cleared, cash out once', async () => {
    const cashBefore = await netDebit(T.A, '1010')
    const r = await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, { source: 'cash_on_hand' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })).toMatchObject({ status: 'posted', paySource: 'cash_on_hand', settledCents: 3_600 })
    const bill = await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } })
    expect(bill.status).toBe('paid')
    const pay = await prisma.supplierPayment.findUniqueOrThrow({ where: { id: r.json().supplierPaymentId } })
    expect(await entryLines(`supplier.payment:${pay.id}`)).toEqual([['1010', 'credit', 3_600], ['2010', 'debit', 3_600]])
    expect(await netDebit(T.A, '1010') - cashBefore).toBe(-3_600)
    expect(await netDebit(T.A, '2015')).toBe(0)
    expect(await netDebit(T.A, '2010')).toBe(0)
    expect(await netDebit(T.A, '1011')).toBe(0)
    expect(await netDebit(T.A, '1210')).toBe(2_100)
    expect(await netDebit(T.A, '6045')).toBe(1_500)
    // Twice: no.
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, { source: 'cash_on_hand' }))).toBe('ALREADY_PAID')
  })
})

describe('stock or expense at receipt (owner, 2026-11-18): the receiver picks, finance can change', () => {
  it('a line received as EXPENSE goes straight to its account, no stock; finance moves it, or turns a stock line into expense', async () => {
    const r = await call('chefA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, payByCash: false,
      lines: [{ inventoryItemId: flour, quantityOrdered: 4, unitCostCents: 250 }, { inventoryItemId: soap, quantityOrdered: 2, unitCostCents: 300 }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const po = r.json() as { id: string; lines: Array<{ id: string; inventoryItemId: string }> }
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).payByCash).toBe(false)   // the raiser's route
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    const ap = await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`)
    expect(ap.statusCode, ap.body).toBe(200)
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).cashAfterPurchase).toBe(false)
    await upload('buyerA', po.id)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-EXP1`, invoiceDate: today() })).statusCode).toBe(200)
    const fl = po.lines.find((l) => l.inventoryItemId === flour)!.id
    const sp = po.lines.find((l) => l.inventoryItemId === soap)!.id
    const stockBefore = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour } })).currentStock
    // Never cost of sales or a code only its own module posts to; B's account cannot be named either.
    for (const bad of ['5010', '6200', '1210']) {
      const x = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, { locationId: locA, lines: [{ poLineId: fl, quantityReceived: 4, expenseAccountCode: bad }, { poLineId: sp, quantityReceived: 2 }] })
      expect(code(x), bad).toBe('EXPENSE_ACCOUNT_NOT_ALLOWED')
    }
    // Flour stays stock, soap goes to 6120 (any 6xxx expense).
    const ok = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, { locationId: locA, lines: [{ poLineId: fl, quantityReceived: 4 }, { poLineId: sp, quantityReceived: 2, expenseAccountCode: '6120' }] })
    expect(ok.statusCode, ok.body).toBe(201)
    const g = ok.json().grn.id as string
    expect(await entryLines(`procurement.receipt:${g}`)).toEqual([['1210', 'debit', 1_000], ['2015', 'credit', 1_600], ['6120', 'debit', 600]])
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour } })).currentStock).toBeCloseTo(stockBefore + 4)
    const rls = await prisma.goodsReceiptLine.findMany({ where: { receiptId: g } })
    const flLine = rls.find((l) => l.poLineId === fl)!
    const spLine = rls.find((l) => l.poLineId === sp)!
    // Who changes it: finance at its step (not the requester, not company B).
    expect((await call('chefA', 'PUT', `/procurement/grns/${g}/lines/${spLine.id}/expense`, { accountCode: '6110' })).statusCode).toBe(403)
    expect((await call('finB', 'PUT', `/procurement/grns/${g}/lines/${spLine.id}/expense`, { accountCode: '6110' })).statusCode).toBe(404)
    // Expense → another expense account: one move entry.
    const mv = await call('finA', 'PUT', `/procurement/grns/${g}/lines/${spLine.id}/expense`, { accountCode: '6110' })
    expect(mv.statusCode, mv.body).toBe(200)
    expect(await entryLines(`procurement.receipt_expense:${spLine.id}:1`)).toEqual([['6110', 'debit', 600], ['6120', 'credit', 600]])
    // Expensed never goes back to stock.
    expect(code(await call('finA', 'PUT', `/procurement/grns/${g}/lines/${spLine.id}/expense`, { accountCode: null }))).toBe('EXPENSED_STAYS_EXPENSE')
    // Stock → expense: the untouched lot is issued, Dr expense / Cr 1210.
    const se = await call('finA', 'PUT', `/procurement/grns/${g}/lines/${flLine.id}/expense`, { accountCode: '6120' })
    expect(se.statusCode, se.body).toBe(200)
    expect(await entryLines(`procurement.receipt_expense:${flLine.id}:1`)).toEqual([['1210', 'credit', 1_000], ['6120', 'debit', 1_000]])
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: flour } })).currentStock).toBeCloseTo(stockBefore)
    expect((await prisma.stockLot.findFirstOrThrow({ where: { receiptLineId: flLine.id } }))).toMatchObject({ remainingQty: 0, costClass: 'non_food' })
    // After finance passes it, finance can no longer change it.
    expect((await call('finA', 'POST', `/procurement/grns/${g}/finance-pass`)).statusCode).toBe(200)
    expect(code(await call('finA', 'PUT', `/procurement/grns/${g}/lines/${spLine.id}/expense`, { accountCode: '6120' }))).toBe('GRN_STEP_NOT_YOURS')
    // A supplier PO: the GRN approval raises no pay-back; finance pays the supplier.
    const ap2 = await call('ceoA', 'POST', `/procurement/grns/${g}/approve`)
    expect(ap2.statusCode, ap2.body).toBe(200)
    expect(ap2.json().payBackVoucher).toBeNull()
    expect(await prisma.cashVoucher.count({ where: { reimbursesBillId: ap2.json().supplierBillId } })).toBe(0)
  })
})

describe('the requester sends it back; a partial delivery makes a second GRN', () => {
  it('"Not received" needs a note and goes back to the buyer', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { payByCash: false, buyerUserId: U.storeA!.id })
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).buyerUserId).toBe(U.storeA!.id)
    // No invoice yet → refused.
    const noFile = await call('storeA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-INV2`, invoiceDate: today() })
    expect(code(noFile)).toBe('INVOICE_REQUIRED')
    await upload('storeA', po.id)
    expect((await call('storeA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-INV2`, invoiceDate: today() })).statusCode).toBe(200)
    expect(code(await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/reject-receipt`, { note: 'short' }))).toBe('NOTE_REQUIRED')
    const back = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/reject-receipt`, { note: 'Soap never came, flour bag torn' })
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json().status).toBe('approved')
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })
    expect(row).toMatchObject({ status: 'approved', receiptReturnNote: 'Soap never came, flour bag torn', receiptReturnedById: U.chefA!.id })
    expect((await call('storeA', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).toContain(po.id)
  })

  it('the buyer changes the quantity bought as well as the rate (owner, 2026-11-11); never below what came', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { payByCash: false })
    await upload('buyerA', po.id)
    const flourLine = po.lines.find((l) => l.inventoryItemId === flour)!
    const base = { invoiceNumber: `${P}-Q1`, invoiceDate: today() }
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { ...base, lines: [{ poLineId: flourLine.id, rateCents: 200, quantity: 0 }] })).statusCode).toBe(400)
    const done = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { ...base, lines: [{ poLineId: flourLine.id, rateCents: 220, quantity: 8 }] })
    expect(done.statusCode, done.body).toBe(200)
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } })
    expect(row.lines.find((l) => l.id === flourLine.id)!.quantityOrdered).toBe(8)
    expect(Number(row.totalCents)).toBe(8 * 220 + 5 * 300)
    const log = await prisma.poActivityLog.findFirstOrThrow({ where: { purchaseOrderId: po.id, action: 'completed' } })
    expect(log.details).toMatchObject({ rateChanges: [{ fromRateCents: 200, toRateCents: 220, fromQuantity: 10, toQuantity: 8 }] })
    // Part of it arrives; the next completion cannot go below what came.
    const first = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, {
      locationId: locA, lines: po.lines.map((l) => ({ poLineId: l.id, quantityReceived: l.id === flourLine.id ? 6 : 5 })),
    })
    expect(first.json().status).toBe('partial')
    await upload('buyerA', po.id)
    const low = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-Q2`, invoiceDate: today(), lines: [{ poLineId: flourLine.id, rateCents: 220, quantity: 5 }] })
    expect(code(low)).toBe('QUANTITY_BELOW_RECEIVED')
  })

  it('a part delivery: GRN 1 for what came, back to the buyer, a NEW invoice for GRN 2', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { payByCash: false })
    await upload('buyerA', po.id)
    await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-P1`, invoiceDate: today() })
    const first = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, {
      locationId: locA, lines: po.lines.map((l) => ({ poLineId: l.id, quantityReceived: l.inventoryItemId === flour ? 4 : 5 })),
    })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().status).toBe('partial')
    // The old invoice file does not count for the rest.
    const again = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-P2`, invoiceDate: today() })
    expect(code(again)).toBe('INVOICE_REQUIRED')
    await upload('buyerA', po.id)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-P2`, invoiceDate: today() })).statusCode).toBe(200)
    const flourLine = po.lines.find((l) => l.inventoryItemId === flour)!
    const second = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, { locationId: locA, lines: [{ poLineId: flourLine.id, quantityReceived: 6 }] })
    expect(second.statusCode, second.body).toBe(201)
    expect(second.json().status).toBe('received')
    const grns = await prisma.goodsReceipt.findMany({ where: { poId: po.id }, orderBy: { receivedAt: 'asc' } })
    expect(grns.map((g) => g.invoiceNumber)).toEqual([`${P}-P1`, `${P}-P2`])
    expect(new Set(grns.map((g) => g.grnNumber)).size).toBe(2)
  })

  it("the invoice's sales tax: entered by the buyer, carried onto the GRN, billed as input tax of that authority", async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { payByCash: false })
    await upload('buyerA', po.id)
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-TX`, invoiceDate: today(), taxCents: -1 })).statusCode).toBe(400)
    const c = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-TX`, invoiceDate: today(), taxCents: 1_700, taxAuthority: 'srb' })
    expect(c.statusCode, c.body).toBe(200)
    const cf = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, { locationId: locA, lines: po.lines.map((l) => ({ poLineId: l.id, quantityReceived: l.quantityOrdered })) })
    expect(cf.statusCode, cf.body).toBe(201)
    const grnId2 = cf.json().grn.id as string
    expect(await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: grnId2 } })).toMatchObject({ invoiceTaxCents: 1_700, invoiceTaxAuthority: 'srb' })
    // Finance sends it back; the buyer corrects the tax.
    await call('finA', 'POST', `/procurement/grns/${grnId2}/return`, { note: 'Tax on the invoice is PKR 18, not 17' })
    expect((await call('buyerA', 'POST', `/procurement/grns/${grnId2}/resubmit`, { taxCents: 1_800 })).statusCode).toBe(200)
    expect((await call('finA', 'POST', `/procurement/grns/${grnId2}/finance-pass`)).statusCode).toBe(200)
    const ap = await call('ceoA', 'POST', `/procurement/grns/${grnId2}/approve`)
    expect(ap.statusCode, ap.body).toBe(200)
    const bill = await prisma.supplierBill.findUniqueOrThrow({ where: { id: ap.json().supplierBillId } })
    expect([Number(bill.taxCents), bill.taxAuthority]).toEqual([1_800, 'srb'])
    expect(Number(bill.totalCents)).toBe(Number(bill.subtotalCents) + 1_800)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: T.A, reference: `supplier.bill:${bill.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.lines.filter((l) => l.account.code === '1322' && l.type === 'debit').reduce((s, l) => s + Number(l.amountCents), 0)).toBe(1_800)
  })
})

describe("the CEO's return / reject at approval, and editing a draft", () => {
  it('return needs a note (→ draft, editable, resubmitted); reject needs a reason (→ cancelled)', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    expect(code(await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/return`, { note: 'no' }))).toBe('NOTE_REQUIRED')
    expect((await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/return`, { note: 'Order half the flour this week' })).statusCode).toBe(403)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/return`, { note: 'Order half the flour this week' })).statusCode).toBe(200)
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).toMatchObject({ status: 'draft', returnCount: 1, returnedById: U.ceoA!.id })
    const edit = await call('chefA', 'PATCH', `/procurement/purchase-orders/${po.id}`, { supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 5, unitCostCents: 200 }] })
    expect(edit.statusCode, edit.body).toBe(200)
    expect((await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)).json().status).toBe('pending_approval')
    expect(code(await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/reject`, { reason: 'No' }))).toBe('NOTE_REQUIRED')
    const rej = await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/reject`, { reason: 'Not needed this month' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('cancelled')
    expect(await prisma.cashVoucher.count({ where: { purchaseOrderId: po.id } })).toBe(0)
  })

  it('only the raiser or the CEO edits a draft; never once submitted', async () => {
    const po = await chefPo()
    expect(code(await call('buyerA', 'PATCH', `/procurement/purchase-orders/${po.id}`, { supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 1, unitCostCents: 200 }] }))).toBe('PO_EDIT_RAISER_ONLY')
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    expect(code(await call('chefA', 'PATCH', `/procurement/purchase-orders/${po.id}`, { supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 1, unitCostCents: 200 }] }))).toBe('PO_NOT_DRAFT')
  })

  it('the CEO corrects a PO that is waiting for the CEO: it stays waiting, and is locked again once approved', async () => {
    const po = await chefPo()
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    const body = { supplierId: supA, notes: 'Corrected by the CEO', lines: [{ inventoryItemId: flour, quantityOrdered: 3, unitCostCents: 200 }] }
    // The buyer and another company's CEO still cannot.
    expect(code(await call('buyerA', 'PATCH', `/procurement/purchase-orders/${po.id}`, body))).toBe('PO_EDIT_RAISER_ONLY')
    expect((await call('ceoB', 'PATCH', `/procurement/purchase-orders/${po.id}`, body)).statusCode).toBe(404)
    const r = await call('ceoA', 'PATCH', `/procurement/purchase-orders/${po.id}`, body)
    expect(r.statusCode, r.body).toBe(200)
    const row = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } })
    expect(row.status).toBe('pending_approval')
    expect(row.notes).toBe('Corrected by the CEO')
    expect(row.lines).toHaveLength(1)
    expect(row.lines[0].quantityOrdered).toBe(3)
    expect(Number(row.totalCents)).toBe(600)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { payByCash: false })).statusCode).toBe(200)
    expect(code(await call('ceoA', 'PATCH', `/procurement/purchase-orders/${po.id}`, body))).toBe('PO_NOT_DRAFT')
  })
})

describe('company B: its own buyer rule, never A\'s people', () => {
  it('with two buyers and none named, the requester buys it; the CEO may hand it to a buyer of B only', async () => {
    const r = await call('mgrB', 'POST', '/procurement/purchase-orders', { supplierId: supB, lines: [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 200 }] })
    expect(r.statusCode, r.body).toBe(201)
    await call('mgrB', 'POST', `/procurement/purchase-orders/${r.json().id}/submit`)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`)).statusCode).toBe(404)
    const a = await call('ceoB', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ buyerUserId: U.mgrB!.id, buyerChosen: 'requester' })
    expect(a.json().cashVoucher).toBeNull()
    expect(code(await call('ceoB', 'PUT', `/procurement/purchase-orders/${r.json().id}/buyer`, { buyerUserId: U.buyerA!.id }))).toBe('BUYER_NOT_IN_COMPANY')
    expect((await call('ceoA', 'PUT', `/procurement/purchase-orders/${r.json().id}/buyer`, { buyerUserId: U.buyerA!.id })).statusCode).toBe(404)
    expect((await call('mgrB', 'PUT', `/procurement/purchase-orders/${r.json().id}/buyer`, { buyerUserId: U.buyerB2!.id })).statusCode).toBe(403)
    const re = await call('ceoB', 'PUT', `/procurement/purchase-orders/${r.json().id}/buyer`, { buyerUserId: U.buyerB2!.id })
    expect(re.statusCode, re.body).toBe(200)
    expect(await prisma.poActivityLog.count({ where: { purchaseOrderId: r.json().id, action: 'buyer_assigned' } })).toBe(1)
    expect((await call('buyerB2', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).toContain(r.json().id)
    expect((await call('buyerA', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).not.toContain(r.json().id)
    // A's GRN list never shows B's.
    expect((await call('finA', 'GET', `/procurement/grns?poId=${r.json().id}`)).json()).toEqual([])
  })
})

describe('the buyers list (owner, 2026-11-10): managers add buyers; whoever raises the PO picks one', () => {
  it('a manager adds a login of the active company; another company\'s people are refused / 404', async () => {
    expect(code(await call('mgrB', 'POST', '/procurement/buyers', { userId: U.chefA!.id }))).toBe('BUYER_NOT_IN_COMPANY')
    expect((await call('buyerB', 'POST', '/procurement/buyers', { userId: U.buyerB2!.id })).statusCode).toBe(403)
    const add = await call('mgrB', 'POST', '/procurement/buyers', { userId: U.buyerB2!.id })
    expect(add.statusCode, add.body).toBe(201)
    expect(add.json()).toMatchObject({ tenantId: T.B, userId: U.buyerB2!.id, active: true })
    expect((await call('mgrB', 'POST', '/procurement/buyers', { userId: U.buyerB2!.id })).statusCode).toBe(200)
    const list = (await call('buyerB', 'GET', '/procurement/buyers?active=1')).json()
    expect(list.map((b: { userId: string }) => b.userId)).toEqual([U.buyerB2!.id])
    expect((await call('chefA', 'GET', '/procurement/buyers')).json().map((b: { userId: string }) => b.userId)).not.toContain(U.buyerB2!.id)
    expect((await call('ceoA', 'PATCH', `/procurement/buyers/${add.json().id}`, { active: false })).statusCode).toBe(404)
    const cands = (await call('mgrB', 'GET', '/procurement/buyers/candidates')).json().map((u: { id: string }) => u.id)
    expect(cands).toContain(U.buyerB!.id)
    expect(cands).not.toContain(U.buyerB2!.id)
    expect(cands).not.toContain(U.chefA!.id)
  })

  it('the raiser picks a listed buyer; the CEO\'s approval keeps it; a buyer not listed (or switched off) is refused', async () => {
    const line = [{ inventoryItemId: itemB, quantityOrdered: 1, unitCostCents: 200 }]
    expect(code(await call('mgrB', 'POST', '/procurement/purchase-orders', { supplierId: supB, buyerUserId: U.buyerB!.id, lines: line }))).toBe('BUYER_NOT_LISTED')
    const r = await call('mgrB', 'POST', '/procurement/purchase-orders', { supplierId: supB, buyerUserId: U.buyerB2!.id, lines: line })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().buyerUserId).toBe(U.buyerB2!.id)
    // Not on the buyer's tasks before the CEO approves.
    expect((await call('buyerB2', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).not.toContain(r.json().id)
    const list = (await call('mgrB', 'GET', '/procurement/purchase-orders')).json()
    expect(list.find((p: { id: string }) => p.id === r.json().id)).toMatchObject({ buyerName: `${P} buyerB2` })
    await call('mgrB', 'POST', `/procurement/purchase-orders/${r.json().id}/submit`)
    const a = await call('ceoB', 'POST', `/procurement/purchase-orders/${r.json().id}/approve`)
    expect(a.statusCode, a.body).toBe(200)
    expect(a.json()).toMatchObject({ buyerUserId: U.buyerB2!.id, buyerChosen: 'named' })
    expect((await call('buyerB2', 'GET', '/procurement/my-tasks')).json().toBuy.map((p: { id: string }) => p.id)).toContain(r.json().id)

    const row = (await call('mgrB', 'GET', '/procurement/buyers')).json().find((b: { userId: string }) => b.userId === U.buyerB2!.id)
    expect((await call('mgrB', 'PATCH', `/procurement/buyers/${row.id}`, { active: false })).statusCode).toBe(200)
    expect(code(await call('mgrB', 'POST', '/procurement/purchase-orders', { supplierId: supB, buyerUserId: U.buyerB2!.id, lines: line }))).toBe('BUYER_NOT_LISTED')
  })
})

describe('finance raises POs (owner, 2026-11-10: "Allow finance to create POs")', () => {
  const line = () => [{ inventoryItemId: flour, quantityOrdered: 2, unitCostCents: 200 }]
  it('finance raises, edits, submits and cancels its OWN PO; never another\'s; B is 404', async () => {
    const r = await call('finA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: line() })
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id
    expect((await call('finA', 'PATCH', `/procurement/purchase-orders/${id}`, { supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 3, unitCostCents: 200 }] })).statusCode).toBe(200)
    expect((await call('finB', 'POST', `/procurement/purchase-orders/${id}/submit`)).statusCode).toBe(404)
    const sub = await call('finA', 'POST', `/procurement/purchase-orders/${id}/submit`)
    expect(sub.statusCode, sub.body).toBe(200)
    expect(sub.json().status).toBe('pending_approval')
    // Finance never approves it, and never sends one.
    expect((await call('finA', 'POST', `/procurement/purchase-orders/${id}/approve`)).statusCode).toBe(403)
    // Someone else's PO: finance cannot submit or cancel it.
    const other = await chefPo()
    expect(code(await call('finA', 'POST', `/procurement/purchase-orders/${other.id}/submit`))).toBe('PO_FINANCE_OWN_ONLY')
    expect(code(await call('finA', 'POST', `/procurement/purchase-orders/${other.id}/cancel`, { reason: 'not needed any more' }))).toBe('PO_FINANCE_OWN_ONLY')
    const c = await call('finA', 'POST', `/procurement/purchase-orders/${id}/cancel`, { reason: 'raised by mistake' })
    expect(c.statusCode, c.body).toBe(200)
    // The buyers list is readable to finance (to pick one), never writable.
    expect((await call('finA', 'GET', '/procurement/buyers')).statusCode).toBe(200)
    expect((await call('finA', 'POST', '/procurement/buyers', { userId: U.buyerA!.id })).statusCode).toBe(403)
    expect((await call('finA', 'GET', '/procurement/my-tasks')).statusCode).toBe(200)
  })

  it('finance verifies the GRN of a PO it raised (owner, 2026-11-11); the CEO approves it', async () => {
    const r = await call('finA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: line() })
    const id = r.json().id
    await call('finA', 'POST', `/procurement/purchase-orders/${id}/submit`)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${id}/approve`, { payByCash: false, buyerUserId: U.buyerA!.id })).statusCode).toBe(200)
    await upload('buyerA', id)
    // The buyer types the whole amount; the rate is worked out.
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: true } })
    const done = await call('buyerA', 'POST', `/procurement/purchase-orders/${id}/complete`, { invoiceNumber: `${P}-FIN1`, invoiceDate: today(), lines: [{ poLineId: po.lines[0]!.id, amountCents: 500 }] })
    expect(done.statusCode, done.body).toBe(200)
    expect(Number((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).totalCents)).toBe(500)
    const conf = await call('finA', 'POST', `/procurement/purchase-orders/${id}/confirm-receipt`, { locationId: locA, lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 2 }] })
    expect(conf.statusCode, conf.body).toBe(201)
    const g = conf.json().grn.id
    // The GRN shows what the CEO approved next to what was bought.
    const detail = (await call('finA', 'GET', `/procurement/grns/${g}`)).json() as { lines: Array<{ approved: { quantity: number; rateCents: number; valueCents: number } | null; boughtValueCents: number }> }
    expect(detail.lines[0]!.approved).toMatchObject({ quantity: 2, rateCents: 200, valueCents: 400 })
    expect(detail.lines[0]!.boughtValueCents).toBe(500)
    const pass = await call('finA', 'POST', `/procurement/grns/${g}/finance-pass`)
    expect(pass.statusCode, pass.body).toBe(200)
    const ok = await call('ceoA', 'POST', `/procurement/grns/${g}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
  })
})

describe('old advance vouchers follow the buyer\'s actual amounts (owner, 2026-11-18: "make sure no extra amount is lost")', () => {
  /** A PO approved the OLD way: approved, then its advance voucher raised for the estimate (as before 2026-11-18). */
  async function oldAdvancePo(estimate: number) {
    const r = await call('chefA', 'POST', '/procurement/purchase-orders', { supplierId: supA, payByCash: true, lines: [{ inventoryItemId: flour, quantityOrdered: 10, unitCostCents: estimate }] })
    const po = r.json() as { id: string; lines: Array<{ id: string }> }
    await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/submit`)
    expect((await call('ceoA', 'POST', `/procurement/purchase-orders/${po.id}/approve`, { buyerUserId: U.buyerA!.id })).statusCode).toBe(200)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { cashAfterPurchase: false } })
    const { prepareCashVoucher, raisePoCashVoucherTx } = await import('../src/modules/procurement/poCash.js')
    const plan = await prepareCashVoucher(po.id, U.buyerA!.id)
    const v = await prisma.$transaction((tx) => raisePoCashVoucherTx(tx, plan, U.ceoA!.id))
    await upload('buyerA', po.id)
    return { po, voucherId: v.id }
  }

  it('an UNPAID voucher takes the PO total the buyer entered', async () => {
    const { po, voucherId } = await oldAdvancePo(250)   // 10 × 250 = PKR 25
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })).amountCents).toBe(2_500)
    const done = await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-SYNC1`, invoiceDate: today(), lines: [{ poLineId: po.lines[0]!.id, amountCents: 1_260 }] })
    expect(done.statusCode, done.body).toBe(200)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })).amountCents).toBe(1_260)
    expect(await prisma.auditLog.count({ where: { action: 'cash_voucher.po_amount_synced', entityId: voucherId } })).toBe(1)
  })

  it('a PAID voucher shows the extra, flags it, and finance returns it from the buyer\'s box to the safe', async () => {
    const { po, voucherId } = await oldAdvancePo(250)
    expect((await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/finance-approve`, {})).statusCode).toBe(200)
    const pay = await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/pay`, { source: 'cash_on_hand' })
    expect(pay.statusCode, pay.body).toBe(200)
    const box = await prisma.pettyCashBox.findFirstOrThrow({ where: { tenantId: T.A, custodianId: U.buyerA!.id } })
    const floatBefore = box.floatCents
    // Nothing to return before the buyer says what he bought.
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, {}))).toBe('PO_NOT_BOUGHT_YET')
    expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: `${P}-SYNC2`, invoiceDate: today(), lines: [{ poLineId: po.lines[0]!.id, amountCents: 1_260 }] })).statusCode).toBe(200)
    // The paid amount stays what was handed over; the detail shows the extra.
    const d = (await call('finA', 'GET', `/trustops/cash-vouchers/${voucherId}`)).json()
    expect(d.amountCents).toBe(2_500)
    expect(d.poCash).toMatchObject({ paid: true, givenCents: 2_500, boughtCents: 1_260, excessCents: 1_240, boxId: box.id })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'po_cash_excess', entityId: voucherId } })
    expect(flag).toMatchObject({ status: 'open', tenantId: T.A })
    expect(Number(flag.amountCents)).toBe(1_240)
    // Who: finance or the CEO only; another company 404; never more than the extra.
    expect((await call('buyerA', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, {})).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, {})).statusCode).toBe(404)
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, { amountCents: 1_241 }))).toBe('MORE_THAN_EXTRA')
    const cashBefore = await netDebit(T.A, '1010')
    const r = await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, { destination: 'safe' })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.pettyCashBox.findUniqueOrThrow({ where: { id: box.id } })).floatCents).toBe(floatBefore - 1_240)
    expect(await netDebit(T.A, '1010') - cashBefore).toBe(1_240)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })).returnedCents).toBe(1_240)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flag.id } })).status).toBe('resolved')
    expect(code(await call('finA', 'POST', `/trustops/cash-vouchers/${voucherId}/return-po-excess`, {}))).toBe('NOTHING_TO_RETURN')
  })

  it('a REJECTED advance: the CEO\'s GRN approval raises the buyer\'s pay-back voucher (owner, 2026-11-18); so does the boot sweep', async () => {
    const run = async (inv: string) => {
      const { po, voucherId } = await oldAdvancePo(250)
      await prisma.cashVoucher.update({ where: { id: voucherId }, data: { status: 'rejected', rejectedAt: new Date(), rejectedById: U.ceoA!.id, rejectNote: 'Buyer pays first' } })
      expect((await call('buyerA', 'POST', `/procurement/purchase-orders/${po.id}/complete`, { invoiceNumber: inv, invoiceDate: today(), lines: [{ poLineId: po.lines[0]!.id, amountCents: 1_260 }] })).statusCode).toBe(200)
      const ok = await call('chefA', 'POST', `/procurement/purchase-orders/${po.id}/confirm-receipt`, { locationId: locA, lines: [{ poLineId: po.lines[0]!.id, quantityReceived: 10 }] })
      expect(ok.statusCode, ok.body).toBe(201)
      const grnId = ok.json().grn.id as string
      expect((await call('finA', 'POST', `/procurement/grns/${grnId}/finance-pass`)).statusCode).toBe(200)
      return { po, voucherId, grnId }
    }
    const a = await run(`${P}-REJ1`)
    const ap = await call('ceoA', 'POST', `/procurement/grns/${a.grnId}/approve`)
    expect(ap.statusCode, ap.body).toBe(200)
    const billId = ap.json().supplierBillId as string
    const pb = await prisma.cashVoucher.findUniqueOrThrow({ where: { reimbursesBillId: billId } })
    expect(pb).toMatchObject({ status: 'approved', payeeUserId: U.buyerA!.id, amountCents: 1_260, tenantId: T.A })
    // The PO shows the pay-back, not the rejected advance.
    const detail = (await call('ceoA', 'GET', `/procurement/purchase-orders/${a.po.id}`)).json()
    expect((detail.purchaseOrder ?? detail).cashVoucher?.id).toBe(pb.id)

    // Approved before this rule (no pay-back raised): the boot sweep raises it once.
    const b = await run(`${P}-REJ2`)
    const { paysBuyerBackTx, raiseMissedPayBacks } = await import('../src/modules/procurement/poCash.js')
    expect(await paysBuyerBackTx(prisma, { id: b.po.id, payByCash: true, cashAfterPurchase: false })).toBe(true)
    const ap2 = await call('ceoA', 'POST', `/procurement/grns/${b.grnId}/approve`)
    const bill2 = ap2.json().supplierBillId as string
    await prisma.cashVoucher.deleteMany({ where: { reimbursesBillId: bill2 } })   // as on live before this rule
    const raised = await raiseMissedPayBacks()
    expect(raised.length).toBeGreaterThanOrEqual(1)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { reimbursesBillId: bill2 } })).amountCents).toBe(1_260)
    expect((await raiseMissedPayBacks()).find((v) => v.id === raised[0]!.id)).toBeUndefined()
  })

  it('the boot sweep fixes vouchers already out of step', async () => {
    const { po, voucherId } = await oldAdvancePo(300)
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { totalCents: 1_800 } })   // changed without the sync (as on live)
    const { sweepPoCashVouchers } = await import('../src/modules/procurement/poCashSync.js')
    const r = await sweepPoCashVouchers()
    expect(r.synced).toBeGreaterThanOrEqual(1)
    expect((await prisma.cashVoucher.findUniqueOrThrow({ where: { id: voucherId } })).amountCents).toBe(1_800)
  })
})
