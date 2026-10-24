// Cash requests after payment (H3, Hasnain 2026-10-14: "expense at payment;
// receipts kept for the file") — the LEGACY rules: since 2026-10-15 every new
// pay is held on 1357 and booked when finance verifies the documents
// (cashVoucherFlow20261015.test.ts). Rows paid under H3 (expenseOnVerify
// false) keep these rules, so the requests here are paid the H3 way
// (legacyPay: the pay as it was booked before 2026-10-15).
//
//   - The pay booked Dr <category 6xxx> / Cr 1011. Receipts are evidence and
//     book nothing; a settlement only RECLASSES what they show out of that
//     account: another category Dr 6xxx / Cr paid; stock Dr 12x0 / Cr paid (a
//     settled goods receipt + FIFO lots); equipment via its CapEx payment
//     (Dr 1340, net Cr paid); the same category nothing. ONE entry
//     'cashvoucher.settle:<settlementId>'.
//   - Change returned: Dr 1011 / Cr paid, then 'settled'.
//   - Σ lines ≤ what is still open, also when two settlements race.
//   - A legacy row already booked as an advance on 1355 settles against
//     1355; nothing new ever touches 1355 (the history backfill expenses an
//     old-flow voucher's spend in its category, H3).
//   - One brand per request: settlements, CapEx moves and change credit the
//     paid account under the brand the pay was booked to.
//   - A pay reclass waits for the request's row, so it never races a
//     settlement past CASH_REQUEST_PAID_FIXED.
//
// Real route handlers through Fastify inject; needs the disposable test DB.
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
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { cashRequestPayLine, pettyCashTieOut, postCashVoucherSettlementTx, postPettyCashMovementTx } from '../src/modules/accounting/pettyCashPosting.js'
import { recordPettyCashSpendTx } from '../src/modules/trustops/pettyCash.js'
import { recordCapexPaymentFromCashTx } from '../src/modules/financePlanning/capexPosting.js'

const P = `crs${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: UserRole }> = {}
const box: Record<string, string> = {}
const item: Record<string, string> = {}
const capex: Record<string, string> = {}

const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
const JPEG = Buffer.from(JPEG_B64, 'base64')
const PHOTO = { photo: JPEG_B64, mime: 'image/jpeg' }

async function mkUser(key: string, role: UserRole, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@crs.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name, email: u.email!, role: u.role }
}
const call = (key: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${issueStaffSession(U[key]!).accessToken}` }, ...(payload !== undefined && { payload: payload as object }) })

const V = '/trustops/cash-vouchers'
type Req = { id: string; tenantId: string; number: string; status: string; stage: string; settledCents: number; returnedCents: number; remainingCents: number; pettyCashMovementId: string | null; settlements?: Array<{ id: string; lines: Array<{ id: string; kind: string; accountCode: string }> }> }

/**
 * Finance (finA2) and the CEO (ceoA) approve; then the pay exactly as it was
 * booked under H3, before 2026-10-15 (one expense line in the category, Dr
 * 6xxx / Cr 1011; expenseOnVerify false) — the legacy rows this file covers.
 */
async function legacyPay(id: string, boxId: string): Promise<void> {
  expect((await call('finA2', 'POST', `${V}/${id}/finance-approve`)).statusCode).toBe(200)
  expect((await call('ceoA', 'POST', `${V}/${id}/approve`)).statusCode).toBe(200)
  const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id } })
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.cashVoucher.updateMany({
      where: { id, status: 'approved' },
      data: { status: 'disbursed', boxId, disbursedAt: new Date(), disbursedById: U['cashA']!.id, dueBy: new Date(Date.now() + 30 * 86_400_000) },
    })
    expect(claimed.count).toBe(1)
    const s = await recordPettyCashSpendTx(tx, {
      box: { id: boxId }, amountCents: v.amountCents, reason: `Cash request ${v.number}: ${v.purpose}`, vendorName: v.payeeName,
      approvedById: v.directorSignedById, createdById: U['cashA']!.id, nature: 'expense', lines: [cashRequestPayLine(v)], cashVoucherId: id,
      conceptId: v.conceptId, actor: { id: U['cashA']!.id, role: 'cashier' }, allowExplicit: true, equipmentCheck: false, stockAllowed: false,
    })
    await tx.cashVoucher.update({ where: { id }, data: { pettyCashMovementId: s.movement.id } })
  })
}

/** Raised by finA for `holder`, approved by finance and the CEO, paid (H3) by cashA from box A. */
async function paid(amountCents: number, holder = 'cookA', categoryKey = 'transport'): Promise<Req> {
  const r = await call('finA', 'POST', V, { purpose: `Market run ${amountCents}`, categoryKey, amountCents, holderUserId: U[holder]!.id, sendTo: 'finance' })
  expect(r.statusCode, r.body).toBe(201)
  const id = (r.json() as Req).id
  await legacyPay(id, box['A']!)
  const p = await call('finA', 'GET', `${V}/${id}`)
  expect(p.statusCode, p.body).toBe(200)
  return p.json() as Req
}
async function receipt(key: string, id: string): Promise<string> {
  const r = await call(key, 'POST', `${V}/${id}/receipts`, PHOTO)
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}
async function entry(reference: string, tenantId = T.A) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je ? je.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() : null
}
const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Settle Co A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Settle Co B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', [T.A])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('finA2', 'finance', [T.A])
  await mkUser('mgrA', 'management', [T.A])
  await mkUser('cashA', 'cashier', [T.A])
  await mkUser('cookA', 'boh', [T.A])
  await mkUser('waiterA', 'foh', [T.A])
  await mkUser('finB', 'finance', [T.B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => { await api.register(trustopsRoutes, { prefix: '/trustops' }) }, { prefix: '/api/v1' })
  await app.ready()

  // Boxes start empty and are funded through the ledger, so the tie-out holds.
  box['A'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Head office box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['A2'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Kitchen box', custodianId: U['cashA']!.id, floatCents: 0, topUpLimitCents: 100_000_000 } })).id
  box['B'] = (await prisma.pettyCashBox.create({ data: { tenantId: T.B, name: 'B box', custodianId: U['finB']!.id, floatCents: 0 } })).id
  for (const b of ['A', 'A2']) {
    const r = await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: box[b], type: 'topup', amountCents: 500_000, reason: 'Float from Garibsons', source: 'garibsons' })
    expect(r.statusCode, r.body).toBe(201)
  }

  item['tomato'] = (await prisma.inventoryItem.create({ data: { name: `${P} Tomato`, unit: 'kg', tenantId: T.A, currentStock: 0, category: 'produce' } })).id
  item['cups'] = (await prisma.inventoryItem.create({ data: { name: `${P} Cups`, unit: 'pcs', tenantId: T.A, currentStock: 0, category: 'packaging' } })).id
  item['B'] = (await prisma.inventoryItem.create({ data: { name: `${P} B Tomato`, unit: 'kg', tenantId: T.B, currentStock: 0, category: 'produce' } })).id
  const projA = (await prisma.capexProject.create({ data: { tenantId: T.A, name: `${P} kitchen fit-out` } })).id
  capex['A'] = (await prisma.capexLine.create({ data: { projectId: projA, scope: 'Equipment', item: 'Deep fryer', unitCostCents: 1_000_000 } })).id
  const projB = (await prisma.capexProject.create({ data: { tenantId: T.B, name: `${P} B fit-out` } })).id
  capex['B'] = (await prisma.capexLine.create({ data: { projectId: projB, scope: 'Equipment', item: 'B fryer', unitCostCents: 1_000_000 } })).id

}, 120_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

describe('receipts are evidence: they book nothing', () => {
  it('the holder uploads; bad bytes → 400; another user → 403; not paid → 409; > 20 → 409; delete rules', async () => {
    const draft = await call('cookA', 'POST', V, { purpose: 'Not paid yet', categoryKey: 'office', amountCents: 1_000 })
    expect((await call('cookA', 'POST', `${V}/${draft.json().id}/receipts`, PHOTO)).json().error.code).toBe('VOUCHER_NOT_PAID')

    const v = await paid(10_000)
    const entries = await prisma.journalEntry.count({ where: { tenantId: T.A } })
    const bad = await call('cookA', 'POST', `${V}/${v.id}/receipts`, { photo: Buffer.alloc(200, 7).toString('base64'), mime: 'image/jpeg' })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('BAD_FILE')
    expect((await call('waiterA', 'POST', `${V}/${v.id}/receipts`, PHOTO)).statusCode).toBe(403)
    const custodian = await call('cashA', 'POST', `${V}/${v.id}/receipts`, PHOTO)
    expect(custodian.statusCode).toBe(403)
    expect(custodian.json().error.code).toBe('RECEIPT_NOT_ALLOWED')

    const rid = await receipt('cookA', v.id)
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A } })).toBe(entries)
    const seen = (await call('cookA', 'GET', `${V}/${v.id}`)).json() as Req
    expect(seen.stage).toBe('receipts_in')
    const img = await call('finA', 'GET', `${V}/${v.id}/attachments/${rid}`)
    expect(img.statusCode).toBe(200)
    expect(img.headers['content-type']).toBe('image/jpeg')
    expect(img.rawPayload.equals(JPEG)).toBe(true)
    expect((await call('waiterA', 'GET', `${V}/${v.id}/attachments/${rid}`)).statusCode).toBe(403)

    // Delete: the uploader or a keeper, while it is on no settlement.
    expect((await call('cashA', 'DELETE', `${V}/${v.id}/receipts/${rid}`)).statusCode).toBe(403)
    expect((await call('cookA', 'DELETE', `${V}/${v.id}/receipts/${rid}`)).statusCode).toBe(204)

    // 20 per request.
    for (let i = 0; i < 20; i++) {
      await prisma.cashVoucherAttachment.create({ data: { tenantId: T.A, voucherId: v.id, kind: 'receipt', mime: 'image/jpeg', sizeBytes: JPEG.length, data: JPEG, uploadedById: U['cookA']!.id } })
    }
    const many = await call('cookA', 'POST', `${V}/${v.id}/receipts`, PHOTO)
    expect(many.statusCode).toBe(409)
    expect(many.json().error.code).toBe('TOO_MANY_RECEIPTS')
  })
})

describe('a settlement reclasses out of the account the pay booked', () => {
  it('partial: another category Dr 6170 / Cr 6140, the same category posts nothing; stays paid', async () => {
    const v = await paid(10_000)
    const r1 = await receipt('cookA', v.id)
    const s = await call('cookA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [
        { categoryKey: 'office', amountCents: 3_000, description: 'Printer paper' },
        { categoryKey: 'transport', amountCents: 2_000, description: 'Rickshaw' },
      ],
      receiptIds: [r1],
      note: 'First receipts',
    })
    expect(s.statusCode, s.body).toBe(200)
    const sid = s.json().settlementId as string
    expect(await entry(`cashvoucher.settle:${sid}`)).toEqual([['6140', 'credit', 3_000], ['6170', 'debit', 3_000]])
    const after = s.json().voucher as Req
    expect(after).toMatchObject({ status: 'disbursed', settledCents: 5_000, remainingCents: 5_000 })
    expect(after.settlements).toHaveLength(1)
    const row = await prisma.cashVoucherSettlement.findUniqueOrThrow({ where: { id: sid }, include: { lines: true, attachments: true } })
    expect(row).toMatchObject({ tenantId: T.A, seq: 1, totalCents: 5_000, note: 'First receipts', submittedById: U['cookA']!.id })
    expect(row.lines.every((l) => l.tenantId === T.A)).toBe(true)
    expect(row.attachments.map((a) => a.id)).toEqual([r1])
    // A linked receipt can no longer be removed.
    expect((await call('cookA', 'DELETE', `${V}/${v.id}/receipts/${r1}`)).json().error.code).toBe('RECEIPT_IN_USE')
    // Nothing new on 1355.
    expect(await prisma.journalEntry.count({ where: { tenantId: T.A, lines: { some: { account: { code: '1355' } } } } })).toBe(0)
  })

  it('over the remaining → 422; no receipt → 400; no lines → 400; another request\'s receipt → 422; a used receipt → 409', async () => {
    const v = await paid(4_000)
    const other = await paid(1_000)
    const r1 = await receipt('cookA', v.id)
    const rOther = await receipt('cookA', other.id)
    const line = (amountCents: number) => [{ categoryKey: 'office', amountCents, description: 'Stuff' }]
    const over = await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: line(4_001), receiptIds: [r1] })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('RECEIPTS_OVER_REQUEST')
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: line(100), receiptIds: [] })).json().error.code).toBe('RECEIPT_REQUIRED')
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: [], receiptIds: [r1] })).json().error.code).toBe('LINES_EMPTY')
    const foreign = await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: line(100), receiptIds: [rOther] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('RECEIPT_NOT_ON_REQUEST')
    expect((await call('waiterA', 'POST', `${V}/${v.id}/settlements`, { lines: line(100), receiptIds: [r1] })).statusCode).toBe(403)
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: line(1_000), receiptIds: [r1] })).statusCode).toBe(200)
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: line(1_000), receiptIds: [r1] })).json().error.code).toBe('RECEIPT_IN_USE')
    expect(await prisma.cashVoucherSettlement.count({ where: { voucherId: v.id } })).toBe(1)
  })

  it('a stock line creates a settled goods receipt + lots and Dr 1210 / 1230 / Cr the paid account in ONE entry', async () => {
    const v = await paid(9_000)
    const r1 = await receipt('cookA', v.id)
    const s = await call('cookA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [
        { kind: 'stock', inventoryItemId: item['tomato'], quantity: 2_000, unit: 'g', amountCents: 4_000 },
        { kind: 'stock', inventoryItemId: item['cups'], quantity: 50, unit: 'pcs', amountCents: 1_000, description: 'Takeaway cups' },
      ],
      receiptIds: [r1],
    })
    expect(s.statusCode, s.body).toBe(200)
    const sid = s.json().settlementId as string
    expect(await entry(`cashvoucher.settle:${sid}`)).toEqual([['1210', 'debit', 4_000], ['1230', 'debit', 1_000], ['6140', 'credit', 5_000]])
    const gr = await prisma.goodsReceipt.findFirstOrThrow({ where: { settledById: sid }, include: { lines: true } })
    expect(gr).toMatchObject({ tenantId: T.A, settledByType: 'cash_voucher_settlement', settledAccountCode: '6140' })
    expect(gr.lines.find((l) => l.inventoryItemId === item['tomato'])!.receivedQty).toBe(2)
    const lines = await prisma.pettyCashSpendLine.findMany({ where: { settlementId: sid }, orderBy: { createdAt: 'asc' } })
    expect(lines.map((l) => [l.kind, l.accountCode, l.receiptLineId ? 'linked' : null])).toEqual([['stock', '1210', 'linked'], ['stock', '1230', 'linked']])
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: item['tomato'] } })
    expect(Number(lot.valueInCents)).toBe(4_000)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item['tomato'] } })).currentStock).toBe(2)
  })

  it('stock lines: a holder without the inventory module → 403; another company\'s item → 422; a bad unit → 422', async () => {
    const v = await paid(3_000, 'waiterA')
    const r1 = await receipt('waiterA', v.id)
    const no = await call('waiterA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 1, unit: 'kg', amountCents: 1_000 }], receiptIds: [r1],
    })
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('STOCK_LINES_NOT_ALLOWED')
    // A keeper may.
    const foreign = await call('finA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [{ kind: 'stock', inventoryItemId: item['B'], quantity: 1, unit: 'kg', amountCents: 1_000 }], receiptIds: [r1],
    })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('ITEM_NOT_IN_COMPANY')
    const unit = await call('finA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 3, unit: 'pcs', amountCents: 1_000 }], receiptIds: [r1],
    })
    expect(unit.json().error.code).toBe('UNIT_MISMATCH')
    expect(await prisma.cashVoucherSettlement.count({ where: { voucherId: v.id } })).toBe(0)
  })

  it('a capex line creates the CapEx payment once and moves the money to 1340; another company\'s line → 422', async () => {
    const v = await paid(8_000)
    const r1 = await receipt('cookA', v.id)
    const foreign = await call('finA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [{ kind: 'capex', capexLineId: capex['B'], amountCents: 6_000, description: 'Fryer' }], receiptIds: [r1],
    })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('CAPEX_LINE_NOT_IN_COMPANY')
    const gl = async () => Object.fromEntries(await Promise.all(['1340', '1011', '6140'].map(async (code) => {
      const rows = await prisma.journalLine.findMany({ where: { account: { tenantId: T.A, code } }, select: { type: true, amountCents: true } })
      return [code, rows.reduce((s, r) => s + (r.type === 'debit' ? 1 : -1) * Number(r.amountCents), 0)]
    })))
    const before = await gl()
    const floatBefore = await floatOf(box['A']!)
    const s = await call('finA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [{ kind: 'capex', capexLineId: capex['A'], amountCents: 6_000, description: 'Deep fryer' }], receiptIds: [r1],
    })
    expect(s.statusCode, s.body).toBe(200)
    const sid = s.json().settlementId as string
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { settlementId: sid } })
    expect(line).toMatchObject({ kind: 'capex', accountCode: '1340', capexLineId: capex['A'] })
    const pay = await prisma.capexPayment.findUniqueOrThrow({ where: { id: line.capexPaymentId! } })
    expect(pay).toMatchObject({ source: 'cash', paidAmountCents: 6_000, lineId: capex['A'] })
    const after = await gl()
    // Net: Dr 1340 / Cr 6140; 1011 (and the box) untouched.
    expect(after['1340']! - before['1340']!).toBe(6_000)
    expect(after['6140']! - before['6140']!).toBe(-6_000)
    expect(after['1011']! - before['1011']!).toBe(0)
    expect(await floatOf(box['A']!)).toBe(floatBefore)
    // A replay pays nothing twice.
    const again = await prisma.$transaction((tx) => recordCapexPaymentFromCashTx(tx, {
      tenantId: T.A, lineId: capex['A']!, spendLineId: line.id, amountCents: 6_000, paidAt: new Date(), creditCode: '1011', actorId: U['finA']!.id,
    }))
    expect(again.capexPaymentId).toBe(pay.id)
    // The CapEx payment credits the paid 6140 itself (no 1011 bridge), so the
    // settlement has nothing left to move: no settlement entry.
    expect(await entry(`capex.payment:${pay.id}`)).toEqual([['1340', 'debit', 6_000], ['6140', 'credit', 6_000]])
    expect(await entry(`cashvoucher.settle:${sid}`)).toBeNull()
    const replay = await prisma.$transaction((tx) => postCashVoucherSettlementTx(tx, sid))
    expect(replay.entryId).toBeNull()
    expect(await prisma.capexPayment.count({ where: { lineId: capex['A'] } })).toBe(1)
    expect(await gl()).toEqual(after)
  })

  it('a capex line out of a brand-tagged request credits the paid 6xxx with that brand (the brand\'s expense nets to zero)', async () => {
    const conceptA = (await prisma.concept.create({ data: { name: `${P} brand A`, slug: `${P}-brand-a`, type: 'restaurant', tenantId: T.A } })).id
    const r = await call('finA', 'POST', V, { purpose: 'Blender for brand A', categoryKey: 'transport', amountCents: 4_000, holderUserId: U['cookA']!.id, conceptId: conceptA, sendTo: 'finance' })
    expect(r.statusCode, r.body).toBe(201)
    const id = (r.json() as Req).id
    await legacyPay(id, box['A']!)
    const r1 = await receipt('cookA', id)
    const s = await call('finA', 'POST', `${V}/${id}/settlements`, {
      lines: [{ kind: 'capex', capexLineId: capex['A'], amountCents: 4_000, description: 'Blender' }], receiptIds: [r1],
    })
    expect(s.statusCode, s.body).toBe(200)
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { settlementId: s.json().settlementId as string } })
    const brandNet = async (ref: string) => {
      const rows = await prisma.journalLine.findMany({
        where: { account: { tenantId: T.A, code: '6140' }, journalEntry: { tenantId: T.A, reference: { startsWith: ref } } },
        select: { type: true, amountCents: true, conceptId: true },
      })
      return rows.map((x) => [x.type, Number(x.amountCents), x.conceptId])
    }
    expect(await brandNet(`capex.payment:${line.capexPaymentId}`)).toEqual([['credit', 4_000, conceptA]])
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id }, select: { pettyCashMovementId: true } })
    expect(await brandNet(`pettycash.spend:${v.pettyCashMovementId}`)).toEqual([['debit', 4_000, conceptA]])
  })

  it('a request with no brand paid from a branded box: stock and change credit the paid 6xxx under the box\'s brand; it nets to the spend (cash-brand-mismatch)', async () => {
    const conceptK = (await prisma.concept.create({ data: { name: `${P} brand K`, slug: `${P}-brand-k`, type: 'restaurant', tenantId: T.A } })).id
    const boxK = (await prisma.pettyCashBox.create({ data: { tenantId: T.A, name: 'Brand K box', custodianId: U['cashA']!.id, floatCents: 0, conceptId: conceptK, topUpLimitCents: 100_000_000 } })).id
    expect((await call('finA', 'POST', '/trustops/petty-cash/movements', { boxId: boxK, type: 'topup', amountCents: 50_000, reason: 'Float', source: 'garibsons' })).statusCode).toBe(201)
    const r = await call('finA', 'POST', V, { purpose: 'Market run for K', categoryKey: 'transport', amountCents: 5_000, holderUserId: U['cookA']!.id, sendTo: 'finance' })
    expect(r.statusCode, r.body).toBe(201)
    const id = (r.json() as Req).id
    await legacyPay(id, boxK)
    const r1 = await receipt('cookA', id)
    const s = await call('cookA', 'POST', `${V}/${id}/settlements`, {
      lines: [{ kind: 'stock', inventoryItemId: item['tomato'], quantity: 1_000, unit: 'g', amountCents: 3_000 }], receiptIds: [r1],
    })
    expect(s.statusCode, s.body).toBe(200)
    // The change goes back into ANOTHER box (no brand) — it still credits K.
    const c = await call('cashA', 'POST', `${V}/${id}/return-change`, { amountCents: 2_000, boxId: box['A'] })
    expect(c.statusCode, c.body).toBe(200)
    const v = await prisma.cashVoucher.findUniqueOrThrow({ where: { id }, select: { pettyCashMovementId: true } })
    const refs = [`pettycash.spend:${v.pettyCashMovementId}`, `cashvoucher.settle:${s.json().settlementId}`, `pettycash.topup:${c.json().movement.id}`]
    const rows = await prisma.journalLine.findMany({
      where: { account: { tenantId: T.A, code: '6140' }, journalEntry: { tenantId: T.A, reference: { in: refs } } },
      select: { type: true, amountCents: true, conceptId: true },
    })
    // Every 6140 line of this request is under K, and K's 6140 nets to zero (all of it went to stock or back).
    expect(rows.length).toBe(3)
    expect(rows.every((x) => x.conceptId === conceptK)).toBe(true)
    expect(rows.reduce((t, x) => t + (x.type === 'debit' ? 1 : -1) * Number(x.amountCents), 0)).toBe(0)
  })

  it('change returned posts Dr 1011 / Cr the paid account, then the request is settled', async () => {
    const v = await paid(5_000)
    const r1 = await receipt('cookA', v.id)
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: [{ categoryKey: 'transport', amountCents: 3_000, description: 'Fuel' }], receiptIds: [r1] })).statusCode).toBe(200)
    const float = await floatOf(box['A']!)
    expect((await call('cookA', 'POST', `${V}/${v.id}/return-change`, { amountCents: 2_000 })).statusCode).toBe(403)
    const over = await call('cashA', 'POST', `${V}/${v.id}/return-change`, { amountCents: 2_001 })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('OVER_REMAINING')
    expect((await call('finA', 'POST', `${V}/${v.id}/return-change`, { amountCents: 100, boxId: box['B'] })).json().error.code).toBe('BOX_NOT_IN_COMPANY')
    const r = await call('cashA', 'POST', `${V}/${v.id}/return-change`, { amountCents: 2_000 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().voucher).toMatchObject({ status: 'settled', stage: 'settled', returnedCents: 2_000, settledCents: 3_000, remainingCents: 0 })
    expect(r.json().newFloatCents).toBe(float + 2_000)
    expect(await entry(`pettycash.topup:${r.json().movement.id}`)).toEqual([['1011', 'debit', 2_000], ['6140', 'credit', 2_000]])
    // Settled: nothing more comes in.
    expect((await call('cookA', 'POST', `${V}/${v.id}/receipts`, PHOTO)).json().error.code).toBe('VOUCHER_NOT_PAID')
    expect((await call('cashA', 'POST', `${V}/${v.id}/return-change`, { amountCents: 1 })).json().error.code).toBe('VOUCHER_NOT_PAID')
  })

  it('racing settlements never exceed the amount', async () => {
    const v = await paid(5_000)
    const r1 = await receipt('cookA', v.id)
    const r2 = await receipt('cookA', v.id)
    const body = (rid: string) => ({ lines: [{ categoryKey: 'office', amountCents: 4_000, description: 'Race' }], receiptIds: [rid] })
    const [a, b] = await Promise.all([
      call('cookA', 'POST', `${V}/${v.id}/settlements`, body(r1)),
      call('finA', 'POST', `${V}/${v.id}/settlements`, body(r2)),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 422])
    const row = await prisma.cashVoucher.findUniqueOrThrow({ where: { id: v.id } })
    expect(row.settledCents).toBe(4_000)
    expect(await prisma.cashVoucherSettlement.count({ where: { voucherId: v.id } })).toBe(1)
  })

  it('finance reclasses an expense line: the entry is reversed and reposted; stock lines are fixed', async () => {
    const v = await paid(6_000)
    const r1 = await receipt('cookA', v.id)
    const s = await call('cookA', 'POST', `${V}/${v.id}/settlements`, {
      lines: [
        { categoryKey: 'office', amountCents: 2_000, description: 'Paper' },
        { kind: 'stock', inventoryItemId: item['tomato'], quantity: 1, unit: 'kg', amountCents: 1_000 },
      ],
      receiptIds: [r1],
    })
    expect(s.statusCode, s.body).toBe(200)
    const sid = s.json().settlementId as string
    const lines = await prisma.pettyCashSpendLine.findMany({ where: { settlementId: sid }, orderBy: { createdAt: 'asc' } })
    const url = (lineId: string) => `${V}/${v.id}/settlements/${sid}/lines/${lineId}`
    expect((await call('cookA', 'PATCH', url(lines[0]!.id), { categoryKey: 'marketing' })).statusCode).toBe(403)
    expect((await call('finA', 'PATCH', url(lines[1]!.id), { categoryKey: 'marketing' })).json().error.code).toBe('STOCK_LINE_FIXED')
    const r = await call('finA', 'PATCH', url(lines[0]!.id), { categoryKey: 'marketing' })
    expect(r.statusCode, r.body).toBe(200)
    expect(await entry(`cashvoucher.settle.reversal:${sid}`)).toBeTruthy()
    expect(await entry(`cashvoucher.settle:${sid}@2`)).toEqual([['1210', 'debit', 1_000], ['6060', 'debit', 2_000], ['6140', 'credit', 3_000]])
    // Moving a line INTO the paid account takes it out of the entry.
    const back = await call('finA', 'PATCH', url(lines[0]!.id), { categoryKey: 'transport' })
    expect(back.statusCode).toBe(200)
    expect(await entry(`cashvoucher.settle:${sid}@3`)).toEqual([['1210', 'debit', 1_000], ['6140', 'credit', 1_000]])
  })

  it('once receipts are booked, the pay itself can no longer be moved to another account (409)', async () => {
    const v = await paid(2_000)
    const r1 = await receipt('cookA', v.id)
    expect((await call('cookA', 'POST', `${V}/${v.id}/settlements`, { lines: [{ categoryKey: 'office', amountCents: 500, description: 'Pens' }], receiptIds: [r1] })).statusCode).toBe(200)
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: v.pettyCashMovementId! } })
    const r = await call('finA', 'PATCH', `/trustops/petty-cash/movements/${v.pettyCashMovementId}/lines/${line.id}`, { categoryKey: 'marketing' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('CASH_REQUEST_PAID_FIXED')
    expect((await prisma.pettyCashSpendLine.findUniqueOrThrow({ where: { id: line.id } })).accountCode).toBe('6140')
  })

  it('a pay reclass racing a settlement waits for the request and then sees it (cash-pay-reclass-race)', async () => {
    const v = await paid(2_500)
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: v.pettyCashMovementId! } })
    // A settlement in flight: it holds the request's row, then commits its counters.
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    const settling = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${v.id} FOR UPDATE`
      await gate
      await tx.cashVoucher.update({ where: { id: v.id }, data: { settledCents: { increment: 500 } } })
    }, { timeout: 60_000, maxWait: 10_000 })
    const reclass = call('finA', 'PATCH', `/trustops/petty-cash/movements/${v.pettyCashMovementId}/lines/${line.id}`, { categoryKey: 'marketing' })
    // The reclass queues on the request's row lock (it used to take only the box's).
    for (let i = 0; ; i++) {
      const rows = await prisma.$queryRaw<Array<{ c: bigint }>>`SELECT count(*)::bigint AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`
      if (Number(rows[0]!.c) >= 1) break
      if (i > 200) throw new Error('the pay reclass never waited for the request')
      await new Promise((res) => setTimeout(res, 50))
    }
    release()
    await settling
    const r = await reclass
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('CASH_REQUEST_PAID_FIXED')
    expect((await prisma.pettyCashSpendLine.findUniqueOrThrow({ where: { id: line.id } })).accountCode).toBe('6140')
  })
})

describe('a legacy voucher booked as an advance settles against 1355', () => {
  it('Dr expense / Cr 1355, change Dr 1011 / Cr 1355; the tie-out holds', async () => {
    // What the history backfill leaves: a lineless spend booked Dr 1355 / Cr 1011.
    const legacy = await prisma.cashVoucher.create({
      data: {
        tenantId: T.A, seq: 900, number: 'CV-00900', voucherDate: new Date(), payeeName: 'Old payee', payeeUserId: U['cookA']!.id,
        purpose: 'Old flow', amountCents: 3_000, boxId: box['A2'], status: 'disbursed', preparedById: U['finA']!.id, disbursedAt: new Date(),
      },
    })
    const moved = await prisma.$transaction(async (tx) => {
      await tx.pettyCashBox.update({ where: { id: box['A2']! }, data: { floatCents: { decrement: 3_000 } } })
      const m = await tx.pettyCashMovement.create({
        data: { boxId: box['A2']!, tenantId: T.A, type: 'spend', amountCents: -3_000, reason: 'Cash voucher CV-00900', createdById: U['cashA']!.id, source: 'box', accountCode: '1355', cashVoucherId: legacy.id },
      })
      await postPettyCashMovementTx(tx, m.id)
      await tx.cashVoucher.update({ where: { id: legacy.id }, data: { pettyCashMovementId: m.id } })
      return m
    })
    expect(await entry(`pettycash.spend:${moved.id}`)).toEqual([['1011', 'credit', 3_000], ['1355', 'debit', 3_000]])
    expect((await pettyCashTieOut([T.A]))[0]).toMatchObject({ openAdvancesCents: 3_000, ledger1355Cents: 3_000 })

    const r1 = await receipt('cookA', legacy.id)
    const s = await call('cookA', 'POST', `${V}/${legacy.id}/settlements`, { lines: [{ categoryKey: 'office', amountCents: 2_500, description: 'Old receipts' }], receiptIds: [r1] })
    expect(s.statusCode, s.body).toBe(200)
    expect(await entry(`cashvoucher.settle:${s.json().settlementId}`)).toEqual([['1355', 'credit', 2_500], ['6170', 'debit', 2_500]])
    const c = await call('cashA', 'POST', `${V}/${legacy.id}/return-change`, { amountCents: 500 })
    expect(c.statusCode, c.body).toBe(200)
    expect(c.json().voucher.status).toBe('settled')
    expect(await entry(`pettycash.topup:${c.json().movement.id}`)).toEqual([['1011', 'debit', 500], ['1355', 'credit', 500]])
    const tie = (await pettyCashTieOut([T.A]))[0]!
    expect(tie, JSON.stringify(tie)).toMatchObject({ ok: true, openAdvancesCents: 0, ledger1355Cents: 0, unbookedMovements: 0, boxesWithoutOpening: 0 })
    expect(tie.floatsCents).toBe(tie.ledger1011Cents)
  })
})
