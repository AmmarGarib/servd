// Petty cash on the books (finance wave B, 2026-10-14; H1–H3).
//
// Two companies A and B with their full charts (and C for the history
// backfill, L for a closed period). Every movement of a box is booked by the
// one poster in the BOX's company, inside its own transaction:
//   top-ups      garibsons → Cr 2210, safe → Cr 1010, bank → Cr the bank's
//                code, till → a 'payout' CashMovement on an open drawer +
//                'pettycash.till_topup:<cashMovementId>' Dr 1011 / Cr 1015 that
//                the shift close never books again (drawer expectation lower,
//                deposit expectation unchanged); B's bank or drawer → 422,
//                nothing saved;
//   spends       by category key (6xxx, brand-tagged), explicit 6xxx by a keeper
//                only, 'cogs' keys → 422 USE_STOCK_LINE, 1210 → 422, none → 400,
//                equipment → 422 USE_CAPEX (finance override flagged), B's outlet
//                or brand → 422, stock / capex lines → 422 (W3), a bill →
//                Dr 2010 / Cr 1010 + Dr 1010 / Cr 1011, receipts;
//   counts       → 8010; transfers → nothing; returns → Dr 2210 / bank / 1010;
//   a closed day → 422 PERIOD_LOCKED, float unchanged; a replay is a no-op;
//   tie-out      ok after a mixed sequence, a hand-edited float → not ok;
//   backfill     dry run outcomes, one real run, picks, re-runs find nothing,
//                B's rows untouched, CEO only; an old-flow cash voucher's spend
//                is expensed in its category (H3), never an advance on 1355;
//   scope        B → 404 on A's box, receipt and line reclass; boxes?mine=1;
//   the till     offers only the 'expense' categories; a 'cogs' pay-out → 400.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import pettyCashBackfillRoutes from '../src/modules/reconciliation/pettyCashBackfillRoutes.js'
import { postPettyCashMovementTx, pettyCashTieOut, cashRequestPaidAccountTx } from '../src/modules/accounting/pettyCashPosting.js'
import { drawerExpectation } from '../src/lib/drawer.js'
import { expectedShiftDeposit } from '../src/modules/accounting/depositPosting.js'

let app: FastifyInstance
let A: Company, B: Company, C: Company, L: Company
let ceoA: Who, finA: Who, custA: Who, cashA2: Who, ceoB: Who, finB: Who, ceoC: Who, finC: Who, ceoL: Who
let bankA: string, bankB: string, shiftA: string, shiftB: string
let boxA: string, boxA2: string, boxB: string, boxL: string

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]).toString('base64')

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const floatOf = async (id: string) => (await prisma.pettyCashBox.findUniqueOrThrow({ where: { id } })).floatCents
/** [code, type, amount, conceptId?] of `reference` in `tenantId`'s books, sorted. */
async function linesOf(reference: string, tenantId: string, withConcept = false) {
  const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je.lines.map((l) => withConcept ? [l.account.code, l.type, l.amountCents, l.conceptId] : [l.account.code, l.type, l.amountCents]).sort()
}
const entries = (tenantId: string) => prisma.journalEntry.count({ where: { tenantId } })

beforeAll(async () => {
  const tag = randomBytes(2).toString('hex')
  A = await mkCompany(`pcl-a-${tag}`)
  B = await mkCompany(`pcl-b-${tag}`)
  C = await mkCompany(`pcl-c-${tag}`)
  L = await mkCompany(`pcl-l-${tag}`)
  ceoA = await mkUser('pcl-ceo-a', 'admin', A.tenantId)
  finA = await mkUser('pcl-fin-a', 'finance', A.tenantId)
  custA = await mkUser('pcl-cust-a', 'cashier', A.tenantId)
  cashA2 = await mkUser('pcl-cash-a2', 'cashier', A.tenantId)
  ceoB = await mkUser('pcl-ceo-b', 'admin', B.tenantId)
  finB = await mkUser('pcl-fin-b', 'finance', B.tenantId)
  ceoC = await mkUser('pcl-ceo-c', 'admin', C.tenantId)
  finC = await mkUser('pcl-fin-c', 'finance', C.tenantId)
  ceoL = await mkUser('pcl-ceo-l', 'admin', L.tenantId)
  bankA = (await prisma.bankAccount.create({ data: { tenantId: A.tenantId, name: 'HBL A', accountCode: '1020', isActive: true } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: B.tenantId, name: 'MCB B', accountCode: '1020', isActive: true } })).id
  shiftA = (await prisma.shift.create({ data: { tenantId: A.tenantId, userId: custA.id, openingFloatCents: 30_000 } })).id
  shiftB = (await prisma.shift.create({ data: { tenantId: B.tenantId, userId: ceoB.id, openingFloatCents: 30_000 } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(pettyCashBackfillRoutes, { prefix: '/reconciliation/backfill-petty-cash' })
  await app.ready()
}, 120_000)

afterAll(async () => { await app?.close() })

// ─── Boxes and top-ups ────────────────────────────────────────────────────────

describe('a top-up books Dr 1011 / Cr its source, in the box\'s company', () => {
  it('a new box\'s opening comes from the Garibsons cashier by default (2210), or the chosen source', async () => {
    const r = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Office', custodianId: custA.id, floatCents: 40_000, conceptId: A.conceptId })
    expect(r.statusCode, r.body).toBe(201)
    boxA = r.json().id
    const open = await prisma.pettyCashMovement.findFirstOrThrow({ where: { boxId: boxA } })
    expect(open).toMatchObject({ source: 'garibsons', accountCode: '2210', tenantId: A.tenantId })
    expect(await linesOf(`pettycash.topup:${open.id}`, A.tenantId, true)).toEqual([['1011', 'debit', 40_000, A.conceptId], ['2210', 'credit', 40_000, A.conceptId]])

    const r2 = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Kitchen', custodianId: cashA2.id, floatCents: 10_000, openingSource: 'bank', bankAccountId: bankA })
    expect(r2.statusCode, r2.body).toBe(201)
    boxA2 = r2.json().id
    const open2 = await prisma.pettyCashMovement.findFirstOrThrow({ where: { boxId: boxA2 } })
    expect(await linesOf(`pettycash.topup:${open2.id}`, A.tenantId)).toEqual([['1011', 'debit', 10_000], ['1020', 'credit', 10_000]])

    // B's bank as A's opening source: 422, and no box is left behind.
    const boxes = await prisma.pettyCashBox.count({ where: { tenantId: A.tenantId } })
    const bad = await call(finA, 'POST', '/trustops/petty-cash/boxes', { name: 'Bad', custodianId: custA.id, floatCents: 1_000, openingSource: 'bank', bankAccountId: bankB })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.pettyCashBox.count({ where: { tenantId: A.tenantId } })).toBe(boxes)

    boxB = (await call(ceoB, 'POST', '/trustops/petty-cash/boxes', { name: 'B box', custodianId: ceoB.id, floatCents: 5_000, openingSource: 'safe' })).json().id
  })

  it('safe → 1010, Garibsons → 2210, bank → the bank\'s code; B\'s bank is 422 and nothing is saved', async () => {
    const up = (who: Who, body: Record<string, unknown>) => call(who, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', reason: 'refill', ...body })
    const safe = await up(custA, { amountCents: 1_000, source: 'safe' })
    expect(safe.statusCode, safe.body).toBe(201)
    expect(await linesOf(`pettycash.topup:${safe.json().movement.id}`, A.tenantId)).toEqual([['1010', 'credit', 1_000], ['1011', 'debit', 1_000]])
    const gb = await up(finA, { amountCents: 2_000, source: 'garibsons' })
    expect(await linesOf(`pettycash.topup:${gb.json().movement.id}`, A.tenantId)).toEqual([['1011', 'debit', 2_000], ['2210', 'credit', 2_000]])
    const bk = await up(finA, { amountCents: 3_000, source: 'bank', bankAccountId: bankA })
    expect(bk.json().movement).toMatchObject({ source: 'bank', bankAccountId: bankA, accountCode: '1020' })
    expect(await linesOf(`pettycash.topup:${bk.json().movement.id}`, A.tenantId)).toEqual([['1011', 'debit', 3_000], ['1020', 'credit', 3_000]])
    expect(await floatOf(boxA)).toBe(46_000)

    const before = await entries(A.tenantId)
    const foreign = await up(finA, { amountCents: 1_000, source: 'bank', bankAccountId: bankB })
    expect(foreign.statusCode).toBe(422)
    expect(await floatOf(boxA)).toBe(46_000)
    expect(await entries(A.tenantId)).toBe(before)
  })

  it('till: a pay-out on the drawer + Dr 1011 / Cr 1015 once; the close never books it again', async () => {
    const drawerBefore = (await drawerExpectation(shiftA)).expectedCents
    const depositBefore = (await expectedShiftDeposit(shiftA)).expectedCents
    // The custodian cannot empty a drawer into his box; a keeper can.
    const notKeeper = await call(custA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 5_000, reason: 'from till', source: 'till', shiftId: shiftA })
    expect(notKeeper.statusCode).toBe(403)
    const r = await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 5_000, reason: 'from till', source: 'till', shiftId: shiftA })
    expect(r.statusCode, r.body).toBe(201)
    const m = r.json().movement
    expect(m).toMatchObject({ source: 'till', shiftId: shiftA, accountCode: '1015' })
    const cm = await prisma.cashMovement.findUniqueOrThrow({ where: { id: m.cashMovementId } })
    expect(cm).toMatchObject({ shiftId: shiftA, type: 'payout', amountCents: 5_000, managerOverridePin: null })
    expect(cm.reason).toMatch(/^Petty cash top-up/)
    expect(await linesOf(`pettycash.till_topup:${cm.id}`, A.tenantId)).toEqual([['1011', 'debit', 5_000], ['1015', 'credit', 5_000]])
    expect(await prisma.journalEntry.count({ where: { reference: `pos.payout:${cm.id}` } })).toBe(0)
    expect((await drawerExpectation(shiftA)).expectedCents).toBe(drawerBefore - 5_000)
    expect((await expectedShiftDeposit(shiftA)).expectedCents).toBe(depositBefore)

    // More than the drawer should hold: 422, nothing written.
    const tooMuch = await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 26_000, reason: 'x', source: 'till', shiftId: shiftA })
    expect(tooMuch.json().error.code).toBe('INSUFFICIENT_DRAWER_CASH')
    // B's drawer on A's box: 422, no pay-out on B's drawer, float unchanged.
    const floatBefore = await floatOf(boxA)
    const foreign = await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 1_000, reason: 'x', source: 'till', shiftId: shiftB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
    expect(await prisma.cashMovement.count({ where: { shiftId: shiftB } })).toBe(0)
    expect(await floatOf(boxA)).toBe(floatBefore)

    // Close the drawer (a drop so the close has something to book): the
    // close skips the box top-up — no 8010 pay-out line for it.
    await prisma.cashMovement.create({ data: { shiftId: shiftA, type: 'drop', amountCents: 1_000, reason: 'to safe', recordedById: custA.id } })
    const expected = (await drawerExpectation(shiftA)).expectedCents
    await prisma.shift.update({ where: { id: shiftA }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: expected } })
    const { postShiftClose } = await import('../src/modules/accounting/shiftPosting.js')
    const closed = await postShiftClose(shiftA)
    expect(closed.posted, JSON.stringify(closed)).toBe(true)
    expect(await linesOf(`shift.close:${shiftA}`, A.tenantId)).toEqual([['1010', 'debit', 1_000], ['1015', 'credit', 1_000]])
    await prisma.shift.update({ where: { id: shiftA }, data: { status: 'open', closedAt: null, closingFloatCents: null } })
  })
})

// ─── Spends ───────────────────────────────────────────────────────────────────

describe('a spend books its lines against 1011', () => {
  const spend = (who: Who, body: Record<string, unknown>) =>
    call(who, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'spend', amountCents: 1_500, reason: 'Printer paper', ...body })

  it('by category key, tagged with the brand; a kitchen (cogs) key is 422 USE_STOCK_LINE', async () => {
    const r = await spend(custA, { categoryKey: 'office', conceptId: A.conceptId })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().booked).toBe(true)
    expect(await linesOf(`pettycash.spend:${r.json().movement.id}`, A.tenantId, true)).toEqual([['1011', 'credit', 1_500, A.conceptId], ['6170', 'debit', 1_500, A.conceptId]])
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: r.json().movement.id } })
    expect(line).toMatchObject({ tenantId: A.tenantId, kind: 'expense', categoryKey: 'office', accountCode: '6170', amountCents: 1_500 })

    const food = await spend(custA, { categoryKey: 'kitchen_food', reason: 'Tomatoes' })
    expect(food.statusCode).toBe(422)
    expect(food.json().error.code).toBe('USE_STOCK_LINE')
  })

  it('explicit 6xxx by a keeper; a custodian → 403; 1210 → 422; nothing → 400', async () => {
    const keeper = await spend(finA, { accountCode: '6175', reason: 'Courier' })
    expect(keeper.statusCode, keeper.body).toBe(201)
    expect(await linesOf(`pettycash.spend:${keeper.json().movement.id}`, A.tenantId)).toEqual([['1011', 'credit', 1_500], ['6175', 'debit', 1_500]])
    const cust = await spend(custA, { accountCode: '6175' })
    expect(cust.statusCode).toBe(403)
    expect(cust.json().error.code).toBe('EXPLICIT_ACCOUNT_NOT_ALLOWED')
    const stock = await spend(finA, { accountCode: '1210' })
    expect(stock.statusCode).toBe(422)
    expect(stock.json().error.code).toBe('NOT_AN_EXPENSE_CODE')
    const none = await spend(finA, {})
    expect(none.statusCode).toBe(400)
    expect(none.json().error.code).toBe('SPEND_CATEGORY_REQUIRED')
    // Someone who neither holds the box nor keeps cash cannot spend from it.
    expect((await spend(cashA2, { categoryKey: 'office' })).json().error.code).toBe('SPEND_NOT_ALLOWED')
  })

  it('equipment → 422 USE_CAPEX; a finance override books it and is flagged', async () => {
    const r = await spend(custA, { categoryKey: 'repairs', reason: 'Deep fryer' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('USE_CAPEX')
    const ok = await call(finA, 'POST', '/trustops/petty-cash/movements', {
      boxId: boxA, type: 'spend', amountCents: 1_200, reason: 'Deep fryer basket',
      lines: [{ categoryKey: 'repairs', amountCents: 1_200, description: 'Deep fryer basket', notEquipment: true, notEquipmentReason: 'A spare wire basket, not a fryer' }],
    })
    expect(ok.statusCode, ok.body).toBe(201)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'equipment_override', entityId: ok.json().movement.id } })
    expect(flag.tenantId).toBe(A.tenantId)
  })

  it('lines: several, each its own code; B\'s outlet or brand → 422; stock / capex of another company → 422; must add up', async () => {
    const r = await call(finA, 'POST', '/trustops/petty-cash/movements', {
      boxId: boxA, type: 'spend', amountCents: 3_000, reason: 'Sundries',
      lines: [
        { categoryKey: 'cleaning', amountCents: 1_000, description: 'Bleach', locationId: A.locationId },
        { categoryKey: 'courier', amountCents: 2_000, description: 'TCS', conceptId: A.conceptId },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(await linesOf(`pettycash.spend:${r.json().movement.id}`, A.tenantId)).toEqual([['1011', 'credit', 3_000], ['6040', 'debit', 1_000], ['6175', 'debit', 2_000]])
    const floatBefore = await floatOf(boxA)
    const bad = async (line: Record<string, unknown>, code: string) => {
      const x = await call(finA, 'POST', '/trustops/petty-cash/movements', {
        boxId: boxA, type: 'spend', amountCents: 1_000, reason: 'x', lines: [{ categoryKey: 'cleaning', amountCents: 1_000, description: 'x', ...line }],
      })
      expect(x.json().error?.code, JSON.stringify(line)).toBe(code)
    }
    await bad({ locationId: B.locationId }, 'LOCATION_NOT_IN_COMPANY')
    await bad({ conceptId: B.conceptId }, 'CONCEPT_NOT_IN_COMPANY')
    await bad({ kind: 'stock', inventoryItemId: 'x', quantity: 1 }, 'ITEM_NOT_IN_COMPANY')
    await bad({ kind: 'capex', capexLineId: 'x' }, 'CAPEX_LINE_NOT_IN_COMPANY')
    await bad({ amountCents: 900 }, 'LINES_DONT_ADD_UP')
    expect(await floatOf(boxA)).toBe(floatBefore)
  })

  it('a bill paid from the box: Dr 2010 / Cr 1010 (the payment) + Dr 1010 / Cr 1011 (the box)', async () => {
    const sup = await prisma.supplier.create({ data: { name: 'A Dairy', tenantId: A.tenantId } })
    const bill = await prisma.supplierBill.create({
      data: { supplierId: sup.id, billNumber: `A-${randomBytes(2).toString('hex')}`, billDate: new Date(), dueDate: new Date(), subtotalCents: 2_500, totalCents: 2_500, status: 'open' },
    })
    const r = await call(custA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'spend', amountCents: 2_500, reason: 'Milk bill', supplierBillId: bill.id })
    expect(r.statusCode, r.body).toBe(201)
    const m = r.json().movement
    expect(m).toMatchObject({ accountCode: '1010' })
    expect(await linesOf(`pettycash.spend:${m.id}`, A.tenantId)).toEqual([['1010', 'debit', 2_500], ['1011', 'credit', 2_500]])
    expect(await linesOf(`supplier.payment:${m.supplierPaymentId}`, A.tenantId)).toEqual([['1010', 'credit', 2_500], ['2010', 'debit', 2_500]])
  })

  it('receipts: above the threshold a photo is required; one receipt, one spend; B never reaches it', async () => {
    const big = { boxId: boxA, type: 'spend', amountCents: 60_000, reason: 'Stationery order', categoryKey: 'office' }
    await call(finA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'topup', amountCents: 60_000, reason: 'refill', source: 'garibsons' })
    const noPhoto = await call(custA, 'POST', '/trustops/petty-cash/movements', big)
    expect(noPhoto.json().error.code).toBe('PHOTO_REQUIRED')
    // Only the custodian or a keeper uploads; B gets 404.
    expect((await call(cashA2, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA, photo: JPEG, mime: 'image/jpeg' })).statusCode).toBe(403)
    expect((await call(ceoB, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA, photo: JPEG, mime: 'image/jpeg' })).statusCode).toBe(404)
    expect((await call(custA, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA, photo: Buffer.from('not an image at all, just text....').toString('base64'), mime: 'image/jpeg' })).statusCode).toBe(400)
    const up = await call(custA, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA, photo: JPEG, mime: 'image/jpeg' })
    expect(up.statusCode, up.body).toBe(201)
    const rid = up.json().id
    const ok = await call(custA, 'POST', '/trustops/petty-cash/movements', { ...big, receiptIds: [rid] })
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await prisma.cashVoucherAttachment.findUniqueOrThrow({ where: { id: rid } })).movementId).toBe(ok.json().movement.id)
    const again = await call(custA, 'POST', '/trustops/petty-cash/movements', { ...big, amountCents: 100, receiptIds: [rid] })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('RECEIPT_IN_USE')
    // Read back: the custodian yes, B 404; delete a linked one → 409.
    const got = await call(custA, 'GET', `/trustops/petty-cash/receipts/${rid}`)
    expect(got.statusCode).toBe(200)
    expect(got.headers['x-content-type-options']).toBe('nosniff')
    expect((await call(ceoB, 'GET', `/trustops/petty-cash/receipts/${rid}`)).statusCode).toBe(404)
    expect((await call(custA, 'DELETE', `/trustops/petty-cash/receipts/${rid}`)).statusCode).toBe(409)
    const loose = (await call(custA, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA, photo: JPEG, mime: 'image/jpeg' })).json().id
    expect((await call(ceoB, 'DELETE', `/trustops/petty-cash/receipts/${loose}`)).statusCode).toBe(404)
    expect((await call(custA, 'DELETE', `/trustops/petty-cash/receipts/${loose}`)).statusCode).toBe(204)
    // A receipt of another box is refused.
    const other = (await call(finA, 'POST', '/trustops/petty-cash/receipts', { boxId: boxA2, photo: JPEG, mime: 'image/jpeg' })).json().id
    const wrongBox = await call(custA, 'POST', '/trustops/petty-cash/movements', { ...big, amountCents: 100, receiptIds: [other] })
    expect(wrongBox.json().error.code).toBe('RECEIPT_NOT_ON_BOX')
  })

  it('a reclass reverses and reposts (one live entry); B → 404; the movement is re-stamped', async () => {
    const r = await call(custA, 'POST', '/trustops/petty-cash/movements', { boxId: boxA, type: 'spend', amountCents: 700, reason: 'Tea for staff', categoryKey: 'office' })
    const m = r.json().movement
    const line = await prisma.pettyCashSpendLine.findFirstOrThrow({ where: { movementId: m.id } })
    expect((await call(ceoB, 'PATCH', `/trustops/petty-cash/movements/${m.id}/lines/${line.id}`, { categoryKey: 'staff_welfare' })).statusCode).toBe(404)
    expect((await call(custA, 'PATCH', `/trustops/petty-cash/movements/${m.id}/lines/${line.id}`, { categoryKey: 'staff_welfare' })).statusCode).toBe(403)
    const re = await call(finA, 'PATCH', `/trustops/petty-cash/movements/${m.id}/lines/${line.id}`, { categoryKey: 'staff_welfare' })
    expect(re.statusCode, re.body).toBe(200)
    expect(re.json().outcome).toBe('reposted')
    expect(await linesOf(`pettycash.spend.reversal:${m.id}`, A.tenantId)).toEqual([['1011', 'debit', 700], ['6170', 'credit', 700]])
    expect(await linesOf(`pettycash.spend:${m.id}@2`, A.tenantId)).toEqual([['1011', 'credit', 700], ['6180', 'debit', 700]])
    const after = await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: m.id } })
    expect(after.journalEntryId).toBe((await prisma.journalEntry.findFirstOrThrow({ where: { reference: `pettycash.spend:${m.id}@2` } })).id)
  })
})

// ─── Counts, transfers, returns, locks, replays ───────────────────────────────

describe('counts, transfers, returns, a closed day and a replay', () => {
  it('a count short → Dr 8010, over → Cr 8010, zero → nothing; a transfer books nothing', async () => {
    const f = await floatOf(boxA)
    const short = await call(finA, 'POST', `/trustops/petty-cash/boxes/${boxA}/reconcile`, { countedCents: f - 300 })
    expect(await linesOf(`pettycash.reconcile:${short.json().movement.id}`, A.tenantId)).toEqual([['1011', 'credit', 300], ['8010', 'debit', 300]])
    const over = await call(finA, 'POST', `/trustops/petty-cash/boxes/${boxA}/reconcile`, { countedCents: f })
    expect(await linesOf(`pettycash.reconcile:${over.json().movement.id}`, A.tenantId)).toEqual([['1011', 'debit', 300], ['8010', 'credit', 300]])
    const before = await entries(A.tenantId)
    const zero = await call(finA, 'POST', `/trustops/petty-cash/boxes/${boxA}/reconcile`, { countedCents: f })
    expect(zero.json().varianceCents).toBe(0)
    const t = await call(finA, 'POST', '/trustops/petty-cash/transfers', { fromBoxId: boxA, toBoxId: boxA2, amountCents: 1_000, reason: 'float' })
    expect(t.statusCode, t.body).toBe(201)
    expect(await entries(A.tenantId)).toBe(before)
  })

  it('cash returned to Garibsons → Dr 2210, to the bank → Dr 1020; more than the float → 400; B → 404', async () => {
    const g = await call(finA, 'POST', '/trustops/petty-cash/returns', { boxId: boxA, amountCents: 1_000, destination: 'garibsons', reason: 'Back to Jamil sb' })
    expect(g.statusCode, g.body).toBe(201)
    expect(await linesOf(`pettycash.return:${g.json().movement.id}`, A.tenantId)).toEqual([['1011', 'credit', 1_000], ['2210', 'debit', 1_000]])
    const b = await call(finA, 'POST', '/trustops/petty-cash/returns', { boxId: boxA, amountCents: 500, destination: 'bank', bankAccountId: bankA, reason: 'Banked' })
    expect(await linesOf(`pettycash.return:${b.json().movement.id}`, A.tenantId)).toEqual([['1011', 'credit', 500], ['1020', 'debit', 500]])
    expect((await call(finA, 'POST', '/trustops/petty-cash/returns', { boxId: boxA, amountCents: 99_999_999, destination: 'safe', reason: 'x' })).json().error.code).toBe('INSUFFICIENT_FLOAT')
    expect((await call(ceoB, 'POST', '/trustops/petty-cash/returns', { boxId: boxA, amountCents: 1, destination: 'safe', reason: 'x' })).statusCode).toBe(404)
    expect((await call(custA, 'POST', '/trustops/petty-cash/returns', { boxId: boxA, amountCents: 1, destination: 'safe', reason: 'x' })).statusCode).toBe(403)
  })

  it('books closed through today: 422 PERIOD_LOCKED and the float is unchanged', async () => {
    boxL = (await call(ceoL, 'POST', '/trustops/petty-cash/boxes', { name: 'L box', custodianId: ceoL.id, floatCents: 5_000 })).json().id
    await prisma.periodLock.create({ data: { tenantId: L.tenantId, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: 'test' } })
    const moves = await prisma.pettyCashMovement.count({ where: { boxId: boxL } })
    for (const [url, body] of [
      ['/trustops/petty-cash/movements', { boxId: boxL, type: 'spend', amountCents: 1_000, reason: 'x', categoryKey: 'office' }],
      ['/trustops/petty-cash/movements', { boxId: boxL, type: 'topup', amountCents: 1_000, reason: 'x', source: 'safe' }],
      ['/trustops/petty-cash/returns', { boxId: boxL, amountCents: 1_000, destination: 'safe', reason: 'x' }],
      [`/trustops/petty-cash/boxes/${boxL}/reconcile`, { countedCents: 1_000 }],
    ] as const) {
      const r = await call(ceoL, 'POST', url, body)
      expect(r.statusCode, `${url} ${r.body}`).toBe(422)
      expect(r.json().error.code).toBe('PERIOD_LOCKED')
    }
    expect(await floatOf(boxL)).toBe(5_000)
    expect(await prisma.pettyCashMovement.count({ where: { boxId: boxL } })).toBe(moves)
  })

  it('a replay is a no-op: one entry per movement', async () => {
    const m = await prisma.pettyCashMovement.findFirstOrThrow({ where: { boxId: boxA, type: 'spend', journalEntryId: { not: null } } })
    const again = await prisma.$transaction((tx) => postPettyCashMovementTx(tx, m.id))
    expect(again.outcome).toBe('unchanged')
    expect(again.entryId).toBe(m.journalEntryId)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { startsWith: `pettycash.spend:${m.id}` } } })).toBe(1)
  })
})

// ─── Tie-out, scope, lists ────────────────────────────────────────────────────

describe('tie-out, the custodian\'s boxes, the categories', () => {
  it('A ties out after the mixed sequence; a hand-edited float does not', async () => {
    const r = await call(finA, 'GET', '/trustops/petty-cash/tie-out')
    expect(r.statusCode).toBe(200)
    const a = (r.json().companies as Array<Record<string, unknown>>).find((c) => c.tenantId === A.tenantId)!
    expect(a, JSON.stringify(r.json())).toMatchObject({ ok: true, unbookedMovements: 0, openAdvancesCents: 0, ledger1355Cents: 0 })
    expect(a.floatsCents).toBe(a.ledger1011Cents)
    // B's operator sees only B.
    expect((await call(finB, 'GET', '/trustops/petty-cash/tie-out')).json().companies.map((c: { tenantId: string }) => c.tenantId)).toEqual([B.tenantId])

    await prisma.pettyCashBox.update({ where: { id: boxA }, data: { floatCents: { increment: 100 } } })
    const [bad] = await pettyCashTieOut([A.tenantId])
    expect(bad!.ok).toBe(false)
    expect(bad!.floatsCents - bad!.ledger1011Cents).toBe(100)
    await prisma.pettyCashBox.update({ where: { id: boxA }, data: { floatCents: { decrement: 100 } } })
  })

  it('boxes?mine=1 lists only the boxes I hold; the full list stays the keepers\'', async () => {
    const mine = await call(custA, 'GET', '/trustops/petty-cash/boxes?mine=1')
    expect(mine.statusCode).toBe(200)
    expect(mine.json().map((b: { id: string }) => b.id)).toEqual([boxA])
    expect(mine.json()[0].movements).toBeUndefined()
    expect((await call(ceoB, 'GET', '/trustops/petty-cash/boxes?mine=1')).json().map((b: { id: string }) => b.id)).toEqual([boxB])
    expect((await call(custA, 'GET', '/trustops/petty-cash/boxes')).statusCode).toBe(403)
    const full = (await call(finA, 'GET', '/trustops/petty-cash/boxes')).json() as Array<{ id: string; movements: Array<{ ledger: string; attachments: Array<Record<string, unknown>> }> }>
    const a = full.find((b) => b.id === boxA)!
    expect(a.movements.length).toBeGreaterThan(0)
    for (const m of a.movements) {
      expect(['booked', 'no_entry']).toContain(m.ledger)
      for (const att of m.attachments) expect(att.data).toBeUndefined()
    }
    expect(full.find((b) => b.id === boxB)).toBeUndefined()
  })

  it('open drawers of the box\'s company; B → 404', async () => {
    const r = await call(finA, 'GET', `/trustops/petty-cash/open-drawers?boxId=${boxA}`)
    expect(r.statusCode).toBe(200)
    expect(r.json().drawers.map((d: { id: string }) => d.id)).toEqual([shiftA])
    expect((await call(finB, 'GET', `/trustops/petty-cash/open-drawers?boxId=${boxA}`)).statusCode).toBe(404)
  })

  it('the box and the till offer only the expense categories; a kitchen pay-out at the till → 400', async () => {
    const box = (await call(custA, 'GET', '/trustops/petty-cash/categories')).json().categories as Array<{ key: string; kind: string; code: string }>
    const till = (await call(custA, 'GET', '/pos/payout-categories')).json().categories as Array<{ key: string; kind: string }>
    for (const list of [box, till]) {
      expect(list.every((c) => c.kind === 'expense')).toBe(true)
      expect(list.map((c) => c.key)).toEqual(expect.arrayContaining(['office', 'courier', 'staff_welfare', 'phone', 'cleaning']))
      expect(list.map((c) => c.key)).not.toContain('kitchen_food')
    }
    const payout = await call(custA, 'POST', `/pos/shifts/${shiftA}/cash-movements`, { type: 'payout', amountCents: 100, reason: 'veg', category: 'kitchen_food' })
    expect(payout.statusCode).toBe(400)
  })
})

// ─── History backfill ─────────────────────────────────────────────────────────

describe('history backfill (CEO): openings and unbooked movements, placed by owner decision 6', () => {
  let c1: string, c2: string
  const ids: Record<string, string> = {}
  const AUG = (d: number) => new Date(`2026-08-${String(d).padStart(2, '0')}T08:00:00Z`)

  beforeAll(async () => {
    // C's boxes before petty cash was booked: an opening float never written
    // as a movement, and movements with no source / account.
    c1 = (await prisma.pettyCashBox.create({ data: { tenantId: C.tenantId, name: 'C front', custodianId: ceoC.id, floatCents: 0, createdAt: AUG(1) } })).id
    c2 = (await prisma.pettyCashBox.create({ data: { tenantId: C.tenantId, name: 'C back', custodianId: ceoC.id, floatCents: 0, createdAt: AUG(1) } })).id
    const mv = async (key: string, boxId: string, type: string, amountCents: number, reason: string, extra: Record<string, unknown> = {}, at = AUG(10)) => {
      ids[key] = (await prisma.pettyCashMovement.create({ data: { boxId, type, amountCents, reason, createdById: ceoC.id, createdAt: at, ...extra } })).id
    }
    await mv('topup', c1, 'topup', 10_000, 'Refill')
    await mv('cleaning', c1, 'spend', -1_000, 'Phenyl', { category: 'cleaning' })
    await mv('words', c1, 'spend', -500, 'Generator fuel', { category: null })
    await mv('random', c1, 'spend', -700, 'Misc', { category: 'stuff' })
    await mv('count', c1, 'reconcile', -200, 'Monthly count')
    await mv('oneSided', c1, 'transfer', 1_500, 'Transfer TRF-AAAA1111 from Old box: float')
    await mv('pairOut', c1, 'transfer', -2_000, 'Transfer TRF-BBBB2222 to C back: float')
    await mv('pairIn', c2, 'transfer', 2_000, 'Transfer TRF-BBBB2222 from C front: float')
    // An old-flow voucher's spend (the signed voucher was the final payment and
    // carried the voucher's category) — H3: expensed when paid, never 1355.
    await mv('voucher', c1, 'spend', -3_000, 'Cash voucher CV-00001: Event setup', { category: 'marketing' })
    await mv('today', c1, 'spend', -400, 'Courier today', { category: 'courier' }, new Date())
    await prisma.cashVoucher.create({
      data: {
        tenantId: C.tenantId, seq: 1, number: 'CV-00001', voucherDate: AUG(10), payeeName: 'Event lead', purpose: 'Event setup', category: 'marketing',
        amountCents: 3_000, boxId: c1, status: 'disbursed', preparedById: ceoC.id, pettyCashMovementId: ids['voucher'], disbursedAt: AUG(10),
      },
    })
    // Floats: an opening of 20,000 on c1 not explained by any movement.
    const sum = async (b: string) => (await prisma.pettyCashMovement.aggregate({ where: { boxId: b }, _sum: { amountCents: true } }))._sum.amountCents ?? 0
    await prisma.pettyCashBox.update({ where: { id: c1 }, data: { floatCents: 20_000 + await sum(c1) } })
    await prisma.pettyCashBox.update({ where: { id: c2 }, data: { floatCents: await sum(c2) } })
    // August is closed in C.
    await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: new Date('2026-09-30T18:59:59Z'), lockedBy: 'test' } })
    // B's own unbooked history — A / C's runs never touch it.
    ids['bLegacy'] = (await prisma.pettyCashMovement.create({ data: { boxId: boxB, type: 'spend', amountCents: -100, reason: 'B legacy', category: 'cleaning', createdById: ceoB.id } })).id
  })

  const run = (who: Who, body: Record<string, unknown>) => call(who, 'POST', '/reconciliation/backfill-petty-cash', body)

  it('a non-CEO is 403; another company is 404', async () => {
    expect((await run(finC, {})).statusCode).toBe(403)
    expect((await run(ceoC, { tenantId: B.tenantId })).statusCode).toBe(404)
  })

  it('the dry run lists every outcome and writes nothing', async () => {
    const before = await entries(C.tenantId)
    const r = await run(ceoC, {})
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Array<{ kind: string; id: string; outcome: string; accountCode: string | null; detail: string; amountCents: number }>
    const by = (id: string) => rows.find((x) => x.id === id)
    expect(by(c1)).toMatchObject({ kind: 'opening', amountCents: 20_000, accountCode: '1010', outcome: 'would_post_into_current_month' })
    expect(by(c1)!.detail).toMatch(/posted late into the open month/)
    expect(by(ids['topup']!)).toMatchObject({ accountCode: '1010', outcome: 'would_post_into_current_month' })
    expect(by(ids['topup']!)!.detail).toMatch(/source not recorded/)
    expect(by(ids['cleaning']!)).toMatchObject({ accountCode: '6040', outcome: 'would_post_into_current_month' })
    expect(by(ids['words']!)).toMatchObject({ accountCode: '6020' })
    expect(by(ids['random']!)).toMatchObject({ outcome: 'needs_category' })
    expect(by(ids['count']!)).toMatchObject({ accountCode: '8010' })
    expect(by(ids['oneSided']!)).toMatchObject({ outcome: 'needs_review' })
    expect(by(ids['pairOut']!)).toBeUndefined()
    expect(by(ids['pairIn']!)).toBeUndefined()
    expect(by(ids['voucher']!)).toMatchObject({ accountCode: '6060' })
    expect(by(ids['voucher']!)!.detail).toMatch(/expensed when paid/)
    expect(by(ids['today']!)).toMatchObject({ accountCode: '6175', outcome: 'would_post' })
    // GS Foods holds no cash: with the safe as the source, 1010 goes negative.
    const coh = rows.find((x) => x.kind === 'cash_on_hand')!
    expect(coh.outcome).toBe('warning')
    expect(coh.amountCents).toBeLessThan(0)
    // With Garibsons as the source, the opening and the top-up credit 2210.
    const g = (await run(ceoC, { historicTopupSource: 'garibsons' })).json().rows as typeof rows
    expect(g.find((x) => x.id === c1)!.accountCode).toBe('2210')
    expect(g.find((x) => x.kind === 'cash_on_hand')).toBeUndefined()
    expect(await entries(C.tenantId)).toBe(before)
    expect(await prisma.pettyCashMovement.count({ where: { id: { in: Object.values(ids) }, OR: [{ journalEntryId: { not: null } }, { accountCode: { not: null } }] } })).toBe(0)
  })

  it('a real run with picks posts each once, ties C out, and a second run finds nothing; B is untouched', async () => {
    const r = await run(ceoC, {
      dryRun: false,
      picks: { [ids['random']!]: { categoryKey: 'office' }, [ids['oneSided']!]: { source: 'garibsons' } },
    })
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Array<{ id: string; outcome: string }>
    expect(rows.filter((x) => x.outcome === 'needs_category' || x.outcome === 'needs_review' || x.outcome === 'error'), r.body).toEqual([])
    expect(await linesOf(`pettycash.opening:${c1}`, C.tenantId)).toEqual([['1010', 'credit', 20_000], ['1011', 'debit', 20_000]])
    expect(await linesOf(`pettycash.spend:${ids['random']}`, C.tenantId)).toEqual([['1011', 'credit', 700], ['6170', 'debit', 700]])
    expect(await linesOf(`pettycash.transfer:${ids['oneSided']}`, C.tenantId)).toEqual([['1011', 'debit', 1_500], ['2210', 'credit', 1_500]])
    expect(await linesOf(`pettycash.spend:${ids['voucher']}`, C.tenantId)).toEqual([['1011', 'credit', 3_000], ['6060', 'debit', 3_000]])
    // The request's paid account is now its category's 6xxx: receipts and change reclass out of it (H3).
    const cv = await prisma.cashVoucher.findFirstOrThrow({ where: { tenantId: C.tenantId, number: 'CV-00001' } })
    expect(await cashRequestPaidAccountTx(prisma, cv.id)).toBe('6060')
    const late = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: C.tenantId, reference: `pettycash.reconcile:${ids['count']}` } })
    expect(late.entryDate.getTime()).toBeGreaterThan(new Date('2026-09-30T19:00:00Z').getTime())
    expect(late.description).toMatch(/posted late/)
    expect((await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: ids['topup']! } }))).toMatchObject({ source: 'safe', accountCode: '1010' })
    expect((await prisma.cashVoucher.findFirstOrThrow({ where: { tenantId: C.tenantId } })).status).toBe('disbursed')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'petty_cash.backfill', tenantId: C.tenantId } })
    expect(audit.userId).toBe(ceoC.id)

    const [tie] = await pettyCashTieOut([C.tenantId])
    expect(tie, JSON.stringify(tie)).toMatchObject({ ok: true, openAdvancesCents: 0, ledger1355Cents: 0, unbookedMovements: 0, boxesWithoutOpening: 0 })

    const again = await run(ceoC, { dryRun: false })
    expect(again.json().rows).toEqual([])
    expect((await prisma.pettyCashMovement.findUniqueOrThrow({ where: { id: ids['bLegacy']! } })).journalEntryId).toBeNull()
  })
})
