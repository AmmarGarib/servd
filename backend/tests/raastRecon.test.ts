// Raast QR — finance (spec §7, amendments M4, S3, S6; stream D).
//
//   - the statement's Raast pass: reference + amount + date → matched; one hit
//     with another amount → raast_statement_mismatch, nothing matched; two
//     lines naming one reference → nothing (never a guess)
//   - the generic matcher never pairs a RAAST RECEIPTS journal line, and (S3)
//     leaves a credit equal to a provisional receipt for the Raast tab
//   - a reference a manager dismissed as "not a sale" never matches (M4)
//   - company separation: B's statement never matches A's receipts; B gets
//     404 on A's receipts / lines; a line of another account is 422
//   - manual match / unmatch / reference fix (APPROVERS, M4) / not received
//     (+ the write-off reversed when the statement later shows it; the
//     'customer owes' contra is the company's till clearing, resolved
//     server-side: 1110 before the CEO's 1110 → 1115 cut-over, 1115 after —
//     an explicit '1115' or legacy '1110' lands on that same code)
//   - POST /bank/lines/:id/unmatch (S3), /rematch, /alerts, /summary
//   - the daily raast_unmatched flag (one per bank account, resolved at 0)
//   - period close: 409 RAAST_UNMATCHED unless the CEO closes anyway (S6)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, mkOrder, mkRaastAccount, setConnector, type Company, type Who } from './connectorsFixtures.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { RAAST_RECEIPTS_MEMO, refundDueMemo } from '../src/modules/accounting/orderPosting.js'
import { flagUnmatchedReceipts } from '../src/modules/reconciliation/raast.js'
import { cutoverTillClearing } from '../src/modules/accounting/tillClearing.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { toCents } from '../src/lib/money.js'

let app: FastifyInstance
let A: Company
let B: Company
let C: Company
let bankA: { bankAccountId: string; ledgerCode: string }
let bankA2: { bankAccountId: string; ledgerCode: string }
let bankB: { bankAccountId: string; ledgerCode: string }
let bankC: { bankAccountId: string; ledgerCode: string }
let adminA: Who, financeA: Who, adminB: Who, financeB: Who, adminC: Who, cashierA: Who

const DAY = 86_400_000
const today = () => fmtPktDate(new Date())

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const newRef = () => `RAA${String(Date.now()).slice(-6)}${randomBytes(3).toString('hex').replace(/[^0-9]/g, '7').padEnd(4, '3').slice(0, 4)}`

/** A Raast sale of `amountCents` on `co`, with its provisional receipt (as the till writes it). */
async function mkReceipt(co: Company, bank: { bankAccountId: string; ledgerCode: string }, opts: {
  amountCents: number; bankRef?: string | null; status?: 'provisional' | 'needs_attention' | 'matched'; confirmedAt?: Date | null; createdAt?: Date; shiftId?: string | null
}) {
  const who = co === A ? cashierA : adminB
  const orderId = await mkOrder(co, {
    items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: opts.amountCents }],
    taxCents: 0, taxRatePct: 8, totalCents: opts.amountCents,
    payments: [{ method: 'raast', amountCents: opts.amountCents }],
    shiftId: opts.shiftId ?? null,
  })
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } })
  const ref = opts.bankRef === undefined ? newRef() : opts.bankRef
  if (ref) await prisma.payment.update({ where: { id: payment.id }, data: { gateway: 'raast', gatewayRef: ref } })
  const status = opts.status ?? 'provisional'
  return prisma.raastReceipt.create({
    data: {
      tenantId: co.tenantId, orderId, conceptId: co.conceptId, shiftId: opts.shiftId ?? null,
      paymentId: status === 'needs_attention' ? null : payment.id,
      bankAccountId: bank.bankAccountId, ledgerCode: bank.ledgerCode,
      amountCents: opts.amountCents, dueCents: opts.amountCents, bankRef: ref, bankRefRaw: ref, status,
      confirmedVia: status === 'needs_attention' ? null : 'cashier',
      confirmedAt: opts.confirmedAt === undefined ? (status === 'needs_attention' ? null : new Date()) : opts.confirmedAt,
      cashierVerified: true, idempotencyKey: `pay:${payment.id}`, createdById: who.id,
      ...(opts.createdAt && { createdAt: opts.createdAt }),
    },
  })
}

async function importCsv(who: Who, bankAccountId: string, rows: Array<{ date?: string; description: string; amount: string; reference?: string }>) {
  const csv = ['date,description,amount,reference', ...rows.map((r) => `${r.date ?? today()},"${r.description}","${r.amount}",${r.reference ?? ''}`)].join('\n')
  return call(who, 'POST', '/reconciliation/bank/imports', {
    bankAccountId, statementDate: today(), openingBalanceCents: 0, closingBalanceCents: 0,
    filename: 'statement.csv', fileUrl: 'https://files.test/statement.csv', csv,
  })
}

async function linesOf(importId: string) {
  return prisma.bankStatementLine.findMany({ where: { importId }, orderBy: { postedDate: 'asc' } })
}

async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  if (!je) return null
  const rows = je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: toCents(l.amountCents), memo: l.memo ?? '' }))
  const dr = rows.filter((r) => r.type === 'debit').reduce((s, r) => s + r.amount, 0)
  const cr = rows.filter((r) => r.type === 'credit').reduce((s, r) => s + r.amount, 0)
  return { id: je.id, rows, dr, cr }
}

/** The sale posted as the ledger would (memo marked Raast, so no generic match can use it). */
async function bookSale(co: Company, r: { orderId: string; amountCents: number; ledgerCode: string }) {
  await postJournalEntry({
    tenantId: co.tenantId, sourceType: 'order.complete', sourceId: r.orderId, description: 'test sale',
    lines: [
      { accountCode: r.ledgerCode, type: 'debit', amountCents: r.amountCents, memo: `${RAAST_RECEIPTS_MEMO} — test` },
      { accountCode: '4100', type: 'credit', amountCents: r.amountCents },
    ],
  })
}

/** A bank SMS alert row (device + connector made on first use). */
async function mkAlert(co: Company, data: { bankRef: string; amountCents: number; status: 'dismissed' | 'unmatched'; kind?: 'credit' | 'debit'; claimedRef?: string | null; body?: string }) {
  await setConnector(co.tenantId, 'raast', { enabled: false })
  const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: co.tenantId, kind: 'raast' } } })
  let device = await prisma.bankSmsDevice.findFirst({ where: { tenantId: co.tenantId } })
  if (!device) {
    device = await prisma.bankSmsDevice.create({
      data: { tenantId: co.tenantId, connectorId: conn.id, label: 'Counter phone', tokenHash: randomBytes(32).toString('hex'), tokenEnc: 'x', tokenHint: 'sms_…abcd', createdById: adminA.id },
    })
  }
  return prisma.bankSmsAlert.create({
    data: {
      tenantId: co.tenantId, deviceId: device.id, sender: 'MEEZAN', bodyHash: randomBytes(16).toString('hex'), body: data.body ?? 'Rs 100 received',
      receivedAt: new Date(), kind: data.kind ?? 'credit', amountCents: data.amountCents, bankRef: data.bankRef, occurredAt: new Date(),
      bankAccountId: co === A ? bankA.bankAccountId : bankB.bankAccountId, status: data.status, claimedRef: data.claimedRef ?? null,
    },
  })
}

beforeAll(async () => {
  A = await mkCompany('rrecon-a')
  B = await mkCompany('rrecon-b')
  C = await mkCompany('rrecon-c')
  adminA = await mkUser('rr-admin-a', 'admin', A.tenantId)
  financeA = await mkUser('rr-fin-a', 'finance', A.tenantId)
  cashierA = await mkUser('rr-cash-a', 'cashier', A.tenantId)
  adminB = await mkUser('rr-admin-b', 'admin', B.tenantId)
  financeB = await mkUser('rr-fin-b', 'finance', B.tenantId)
  adminC = await mkUser('rr-admin-c', 'admin', C.tenantId)
  bankA = await mkRaastAccount(A, { code: '1021' })
  bankA2 = await mkRaastAccount(A, { code: '1022', isDefault: false })
  bankB = await mkRaastAccount(B, { code: '1021' })
  bankC = await mkRaastAccount(C, { code: '1021' })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('statement import — the Raast pass', () => {
  it('matches a credit naming the reference with the same amount (automatic, matchedById null)', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 118_800 })
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST P2P CR ${r.bankRef} ALI KHAN`, amount: '1,188.00' }])
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().raastMatchedCount).toBe(1)
    const [line] = await linesOf(res.json().importId)
    expect(line!.matchStatus).toBe('matched')
    expect(line!.notes).toContain(r.bankRef!)
    const after = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.status).toBe('matched')
    expect(after.statementLineId).toBe(line!.id)
    expect(after.matchedById).toBeNull()
  })

  it('a reference in the reference column with spaces / dashes still matches', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 55_000 })
    const spaced = `${r.bankRef!.slice(0, 5)}-${r.bankRef!.slice(5)}`
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: 'IBFT INWARD', amount: '550.00', reference: spaced }])
    expect(res.json().raastMatchedCount).toBe(1)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('matched')
  })

  it('one hit with a different amount → nothing matched, raast_statement_mismatch raised', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 70_000 })
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '600.00' }])
    expect(res.json().raastMatchedCount).toBe(0)
    const [line] = await linesOf(res.json().importId)
    expect(line!.matchStatus).toBe('unmatched')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
    const flags = await prisma.exceptionFlag.findMany({ where: { tenantId: A.tenantId, kind: 'raast_statement_mismatch', entityId: r.id } })
    expect(flags).toHaveLength(1)
  })

  it('two lines naming the same reference → neither matched (never a guess)', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 33_300 })
    const res = await importCsv(financeA, bankA.bankAccountId, [
      { description: `RAAST CR ${r.bankRef}`, amount: '333.00' },
      { description: `RAAST CR ${r.bankRef} REVERSAL RE-CREDIT`, amount: '333.00' },
    ])
    expect(res.json().raastMatchedCount).toBe(0)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
  })

  it('a line outside ±statementMatchDays never matches', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 44_400, confirmedAt: new Date(Date.now() - 10 * DAY) })
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '444.00' }])
    expect(res.json().raastMatchedCount).toBe(0)
  })

  it('M4: a reference a manager dismissed as "not a sale" is never matched', async () => {
    const ref = newRef()
    await mkAlert(A, { bankRef: ref, amountCents: 25_000, status: 'dismissed', claimedRef: ref })
    const r = await mkReceipt(A, bankA, { amountCents: 25_000, bankRef: ref })
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${ref}`, amount: '250.00' }])
    expect(res.json().raastMatchedCount).toBe(0)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
  })

  it("company B's statement never matches company A's receipt (same reference, same amount)", async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 81_000 })
    const res = await importCsv(financeB, bankB.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '810.00' }])
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().raastMatchedCount).toBe(0)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
    // …nor a statement of A's OTHER bank account.
    const res2 = await importCsv(financeA, bankA2.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '810.00' }])
    expect(res2.json().raastMatchedCount).toBe(0)
  })
})

describe('the generic matcher (S3)', () => {
  it('never pairs a RAAST RECEIPTS journal line; a plain deposit still matches', async () => {
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.raast_shift', sourceId: randomBytes(6).toString('hex'), description: 'shift raast',
      lines: [
        { accountCode: bankA.ledgerCode, type: 'debit', amountCents: 12_300, memo: `${RAAST_RECEIPTS_MEMO} — POS Raast sales (1) (shift x)` },
        { accountCode: '4100', type: 'credit', amountCents: 12_300 },
      ],
    })
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.deposit', sourceId: randomBytes(6).toString('hex'), description: 'cash deposit',
      lines: [
        { accountCode: bankA.ledgerCode, type: 'debit', amountCents: 45_600, memo: 'Cash deposit' },
        { accountCode: '1010', type: 'credit', amountCents: 45_600 },
      ],
    })
    const res = await importCsv(financeA, bankA.bankAccountId, [
      { description: 'CREDIT NO REF', amount: '123.00' },
      { description: 'CASH DEPOSIT', amount: '456.00' },
    ])
    const lines = await linesOf(res.json().importId)
    const byAmt = new Map(lines.map((l) => [toCents(l.amountCents), l]))
    expect(byAmt.get(12_300)!.matchStatus).toBe('unmatched')
    expect(byAmt.get(45_600)!.matchStatus).toBe('matched')
  })

  it('leaves a credit equal to a provisional Raast receipt on that account for the Raast tab', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 98_700 })
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.deposit', sourceId: randomBytes(6).toString('hex'), description: 'equal deposit',
      lines: [
        { accountCode: bankA.ledgerCode, type: 'debit', amountCents: 98_700, memo: 'Cash deposit' },
        { accountCode: '1010', type: 'credit', amountCents: 98_700 },
      ],
    })
    const res = await importCsv(financeA, bankA.bankAccountId, [{ description: 'INWARD TRANSFER RRN 99887766', amount: '987.00' }])
    const [line] = await linesOf(res.json().importId)
    expect(line!.matchStatus).toBe('unmatched')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')

    // The Raast tab SUGGESTS it (same amount, same day, no reference hit) —
    // finance confirms; nothing was matched automatically.
    const cand = await call(financeA, 'GET', `/reconciliation/raast/receipts/${r.id}/candidates`)
    expect(cand.statusCode, cand.body).toBe(200)
    const sug = cand.json().candidates.find((c: { id: string }) => c.id === line!.id)
    expect(sug.suggested).toBe(true)
    expect(sug.refHit).toBe(false)
    const m = await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: line!.id })
    expect(m.statusCode, m.body).toBe(200)
    expect(m.json().status).toBe('matched')
    expect(m.json().matchedAutomatically).toBe(false)
  })

  it('POST /bank/lines/:id/unmatch undoes a generic match (approvers, audited); a Raast-matched line is 409', async () => {
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.deposit', sourceId: randomBytes(6).toString('hex'), description: 'deposit',
      lines: [
        { accountCode: bankA.ledgerCode, type: 'debit', amountCents: 77_700, memo: 'Cash deposit' },
        { accountCode: '1010', type: 'credit', amountCents: 77_700 },
      ],
    })
    const r = await mkReceipt(A, bankA, { amountCents: 11_100 })
    const res = await importCsv(financeA, bankA.bankAccountId, [
      { description: 'CASH DEPOSIT', amount: '777.00' },
      { description: `RAAST CR ${r.bankRef}`, amount: '111.00' },
    ])
    const lines = await linesOf(res.json().importId)
    const generic = lines.find((l) => toCents(l.amountCents) === 77_700)!
    const raastLine = lines.find((l) => toCents(l.amountCents) === 11_100)!
    expect(generic.matchStatus).toBe('matched')
    expect(raastLine.matchStatus).toBe('matched')

    // Finance (with accounting) may unmatch too since 2026-10-16 (finance final #19) — the CEO does it here.
    expect((await call(adminB, 'POST', `/reconciliation/bank/lines/${generic.id}/unmatch`, {})).statusCode).toBe(404)
    const ok = await call(adminA, 'POST', `/reconciliation/bank/lines/${generic.id}/unmatch`, { reason: 'wrong deposit' })
    expect(ok.statusCode, ok.body).toBe(200)
    const back = await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: generic.id } })
    expect(back.matchStatus).toBe('unmatched')
    expect(back.matchedJournalLineId).toBeNull()
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation.line.unmatch', entityId: generic.id } })).toBe(1)

    const no = await call(adminA, 'POST', `/reconciliation/bank/lines/${raastLine.id}/unmatch`, {})
    expect(no.statusCode).toBe(409)
    expect(no.json().error.code).toBe('RAAST_MATCHED_LINE')

    // The import's lines carry the Raast receipt chip.
    const listed = await call(financeA, 'GET', `/reconciliation/bank/imports/${res.json().importId}/lines`)
    const chip = listed.json().find((l: { id: string }) => l.id === raastLine.id)
    expect(chip.raastReceipt).toMatchObject({ id: r.id, bankRef: r.bankRef, orderId: r.orderId, amountCents: 11_100 })
  })
})

describe('the Raast tab — manual actions', () => {
  it('lists the company\'s receipts with totals; B sees none of them and gets 404 on A\'s', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 20_200 })
    const list = await call(financeA, 'GET', `/reconciliation/raast/receipts?q=${r.bankRef}`)
    expect(list.statusCode, list.body).toBe(200)
    expect(list.json().receipts.map((x: { id: string }) => x.id)).toEqual([r.id])
    expect(list.json().receipts[0].orderRef).toBe(r.orderId.slice(-8).toUpperCase())
    expect(list.json().totals.provisional.count).toBe(1)

    const all = await call(financeA, 'GET', '/reconciliation/raast/receipts?limit=200')
    expect(all.json().receipts.length).toBeGreaterThan(1)
    expect(all.json().kpis.provisional.count).toBeGreaterThan(0)

    const bList = await call(financeB, 'GET', '/reconciliation/raast/receipts?limit=200')
    expect(bList.json().receipts.find((x: { id: string }) => x.id === r.id)).toBeUndefined()
    expect((await call(financeB, 'GET', `/reconciliation/raast/receipts/${r.id}/candidates`)).statusCode).toBe(404)
    expect((await call(financeB, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: 'x' })).statusCode).toBe(404)
    expect((await call(adminB, 'POST', `/reconciliation/raast/receipts/${r.id}/unmatch`, {})).statusCode).toBe(404)
    expect((await call(adminB, 'PATCH', `/reconciliation/raast/receipts/${r.id}/reference`, { bankRef: newRef(), reason: 'typo fix' })).statusCode).toBe(404)
    expect((await call(adminB, 'POST', `/reconciliation/raast/receipts/${r.id}/unreceived`, { reason: 'never came' })).statusCode).toBe(404)
  })

  it('match refuses another account\'s or company\'s line (422) and a different amount (422); unmatch is approvers-only', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 30_300 })
    const other = await importCsv(financeA, bankA2.bankAccountId, [{ description: 'CR', amount: '303.00' }])
    const [otherLine] = await linesOf(other.json().importId)
    const x = await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: otherLine!.id })
    expect(x.statusCode).toBe(422)
    expect(x.json().error.code).toBe('RAAST_LINE_NOT_ON_ACCOUNT')

    const bImp = await importCsv(financeB, bankB.bankAccountId, [{ description: 'CR', amount: '303.00' }])
    const [bLine] = await linesOf(bImp.json().importId)
    expect((await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: bLine!.id })).statusCode).toBe(422)

    const wrong = await importCsv(financeA, bankA.bankAccountId, [{ description: 'CR WRONG', amount: '304.00' }])
    const [wrongLine] = await linesOf(wrong.json().importId)
    const w = await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: wrongLine!.id })
    expect(w.statusCode).toBe(422)
    expect(w.json().error.code).toBe('RAAST_AMOUNT_MISMATCH')

    const good = await importCsv(financeA, bankA.bankAccountId, [{ description: 'CR NO REF', amount: '303.00', date: fmtPktDate(new Date(Date.now() - DAY)) }])
    const [goodLine] = await linesOf(good.json().importId)
    const m = await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: goodLine!.id })
    expect(m.statusCode, m.body).toBe(200)
    expect(m.json().status).toBe('matched')
    expect(await prisma.auditLog.count({ where: { action: 'raast.receipt.match', entityId: r.id } })).toBe(1)

    expect((await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/unmatch`, {})).statusCode).toBe(403)
    const u = await call(adminA, 'POST', `/reconciliation/raast/receipts/${r.id}/unmatch`, { reason: 'wrong line' })
    expect(u.statusCode, u.body).toBe(200)
    expect(u.json().status).toBe('provisional')
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: goodLine!.id } })).matchStatus).toBe('unmatched')
  })

  it('reference fix (M4): approvers only, the till\'s checks, payment updated, audited, statement re-matched', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 40_400 })
    const realRef = newRef()
    // The statement already shows the transfer under its real reference.
    const imp = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${realRef}`, amount: '404.00' }])
    const [line] = await linesOf(imp.json().importId)
    expect(line!.matchStatus).toBe('unmatched')

    const url = `/reconciliation/raast/receipts/${r.id}/reference`
    expect((await call(financeA, 'PATCH', url, { bankRef: realRef, reason: 'cashier typo' })).statusCode).toBe(403)
    const bad = await call(adminA, 'PATCH', url, { bankRef: 'AAAAAA', reason: 'cashier typo' })
    expect(bad.json().error.code).toBe('RAAST_REF_INVALID')
    const own = await call(adminA, 'PATCH', url, { bankRef: r.orderId.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, '') + '', reason: 'cashier typo' })
    expect([400, 422]).toContain(own.statusCode)

    const taken = await mkReceipt(A, bankA, { amountCents: 1_000 })
    const used = await call(adminA, 'PATCH', url, { bankRef: taken.bankRef, reason: 'cashier typo' })
    expect(used.statusCode).toBe(409)
    expect(used.json().error.code).toBe('RAAST_REF_USED')

    const dismissedRef = newRef()
    await mkAlert(A, { bankRef: dismissedRef, amountCents: 40_400, status: 'dismissed', claimedRef: dismissedRef })
    const dis = await call(adminA, 'PATCH', url, { bankRef: dismissedRef, reason: 'cashier typo' })
    expect(dis.statusCode).toBe(409)
    expect(dis.json().error.code).toBe('RAAST_REF_DISMISSED')

    const ok = await call(adminA, 'PATCH', url, { bankRef: realRef.toLowerCase(), reason: 'cashier typo' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().bankRef).toBe(realRef)
    expect(ok.json().statementMatchedNow).toBe(true)
    expect(ok.json().status).toBe('matched')
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.paymentId! } })).gatewayRef).toBe(realRef)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'raast.receipt.reference', entityId: r.id } })
    expect(log.before).toMatchObject({ bankRef: r.bankRef })
    expect(log.after).toMatchObject({ bankRef: realRef })

    // Matched now: no further fix.
    const again = await call(adminA, 'PATCH', url, { bankRef: newRef(), reason: 'again' })
    expect(again.json().error.code).toBe('RAAST_NOT_PROVISIONAL')
  })

  it('not received: only once the sale is booked; Dr contra / Cr bank; a later statement line reverses it', async () => {
    const r = await mkReceipt(A, bankA, { amountCents: 60_600 })
    const url = `/reconciliation/raast/receipts/${r.id}/unreceived`
    const notBooked = await call(adminA, 'POST', url, { reason: 'bank says no such transfer' })
    expect(notBooked.statusCode).toBe(409)
    expect(notBooked.json().error.code).toBe('RAAST_SALE_NOT_BOOKED')
    await bookSale(A, { orderId: r.orderId, amountCents: r.amountCents, ledgerCode: r.ledgerCode })

    expect((await call(financeA, 'POST', url, { reason: 'bank says no such transfer' })).statusCode).toBe(403)
    expect((await call(adminA, 'POST', url, { reason: 'x', contraAccountCode: '4100' })).statusCode).toBe(400)
    const w = await call(adminA, 'POST', url, { reason: 'bank says no such transfer', contraAccountCode: '1350' })
    expect(w.statusCode, w.body).toBe(200)
    expect(w.json().status).toBe('unreceived')
    const je = await entry(A.tenantId, `raast.unreceived:${r.id}`)
    expect(je).not.toBeNull()
    expect(je!.dr).toBe(je!.cr)
    expect(je!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: '1350', type: 'debit', amount: 60_600 }),
      expect.objectContaining({ code: bankA.ledgerCode, type: 'credit', amount: 60_600 }),
    ]))
    expect(je!.rows.every((x) => x.memo.startsWith(RAAST_RECEIPTS_MEMO))).toBe(true)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).writeOffEntryId).toBe(je!.id)
    // Once written off it can't be written off again.
    expect((await call(adminA, 'POST', url, { reason: 'twice' })).json().error.code).toBe('RAAST_NOT_PROVISIONAL')

    // The money turns up on the statement after all: matched, write-off reversed.
    const imp = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '606.00' }])
    expect(imp.json().raastMatchedCount).toBe(1)
    const after = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
    expect(after.status).toBe('matched')
    expect(after.writeOffEntryId).toBeNull()
    const rev = await entry(A.tenantId, `raast.unreceived.reversal:${r.id}`)
    expect(rev).not.toBeNull()
    expect(rev!.dr).toBe(rev!.cr)
    expect(rev!.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: bankA.ledgerCode, type: 'debit', amount: 60_600 }),
      expect.objectContaining({ code: '1350', type: 'credit', amount: 60_600 }),
    ]))
    // The write-off lines carry the Raast memo — no generic match ever uses them.
    expect(rev!.rows.every((x) => x.memo.startsWith(RAAST_RECEIPTS_MEMO))).toBe(true)
  })

  it('rematch: a line imported before the receipt existed is matched by POST /rematch (active company only)', async () => {
    const ref = newRef()
    const imp = await importCsv(financeA, bankA.bankAccountId, [{ description: `RAAST CR ${ref}`, amount: '505.00' }])
    const [line] = await linesOf(imp.json().importId)
    expect(line!.matchStatus).toBe('unmatched')
    const r = await mkReceipt(A, bankA, { amountCents: 50_500, bankRef: ref })
    expect((await call(financeB, 'POST', '/reconciliation/raast/rematch', { importId: imp.json().importId })).statusCode).toBe(404)
    const bRun = await call(financeB, 'POST', '/reconciliation/raast/rematch', {})
    expect(bRun.json().matched).toBe(0)
    const res = await call(financeA, 'POST', '/reconciliation/raast/rematch', {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().receiptIds).toContain(r.id)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).statementLineId).toBe(line!.id)
  })

  it('GET /alerts shows the company\'s bank SMS (B never sees A\'s)', async () => {
    const a = await mkAlert(A, { bankRef: newRef(), amountCents: 9_900, status: 'unmatched', body: 'Meezan: PKR 99 received' })
    const mine = await call(financeA, 'GET', '/reconciliation/raast/alerts')
    expect(mine.statusCode, mine.body).toBe(200)
    expect(mine.json().alerts.find((x: { id: string }) => x.id === a.id)).toMatchObject({ amountCents: 9_900, body: 'Meezan: PKR 99 received' })
    const theirs = await call(financeB, 'GET', '/reconciliation/raast/alerts')
    expect(theirs.json().alerts.find((x: { id: string }) => x.id === a.id)).toBeUndefined()
  })
})

describe('summary, daily flag, period close', () => {
  it('/summary counts Raast in the shift\'s sales', async () => {
    const shift = await prisma.shift.create({ data: { userId: cashierA.id, tenantId: A.tenantId, status: 'open', openingFloatCents: 0 } })
    await mkReceipt(A, bankA, { amountCents: 15_000, shiftId: shift.id })
    await prisma.payment.updateMany({ where: { order: { shiftId: shift.id } }, data: { shiftId: shift.id } })
    await prisma.payment.create({ data: { orderId: (await mkOrder(A, { items: [{ menuItemId: null, name: 'x', quantity: 1, unitPriceCents: 5_000 }], taxCents: 0, taxRatePct: 15, totalCents: 5_000, payments: [] })), shiftId: shift.id, method: 'cash', amountCents: 5_000, status: 'paid', processedAt: new Date() } })
    const res = await call(financeA, 'GET', '/reconciliation/summary')
    expect(res.statusCode, res.body).toBe(200)
    const row = res.json().shifts.find((s: { shiftId: string }) => s.shiftId === shift.id)
    expect(row.raastSalesCents).toBe(15_000)
    expect(row.totalSalesCents).toBe(20_000)
  })

  it('raises ONE raast_unmatched flag per bank account, refreshes it, resolves it at zero', async () => {
    const old = new Date(Date.now() - 5 * DAY)
    const r1 = await mkReceipt(C, bankC, { amountCents: 10_000, confirmedAt: old })
    const r2 = await mkReceipt(C, bankC, { amountCents: 12_000, confirmedAt: new Date(Date.now() - 4 * DAY) })
    await mkReceipt(C, bankC, { amountCents: 13_000 }) // fresh — not counted yet
    expect(await flagUnmatchedReceipts(C.tenantId)).toBe(1)
    expect(await flagUnmatchedReceipts(C.tenantId)).toBe(1)
    const flags = await prisma.exceptionFlag.findMany({ where: { tenantId: C.tenantId, kind: 'raast_unmatched', status: { in: ['open', 'acknowledged'] } } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.entityType).toBe('BankAccount')
    expect(flags[0]!.entityId).toBe(bankC.bankAccountId)
    expect(flags[0]!.metadata).toMatchObject({ count: 2, totalCents: 22_000, noStatement: true })
    expect(flags[0]!.description).toContain('No statement')
    // No other company sees it.
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'raast_unmatched', entityId: bankC.bankAccountId } })).toBe(0)

    await prisma.raastReceipt.updateMany({ where: { id: { in: [r1.id, r2.id] } }, data: { status: 'matched' } })
    await flagUnmatchedReceipts(C.tenantId)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: C.tenantId, kind: 'raast_unmatched', status: { in: ['open', 'acknowledged'] } } })).toBe(0)
  })

  it('period close: 409 RAAST_UNMATCHED (provisional + needs_attention by COALESCE(confirmedAt, createdAt)); the CEO may close anyway', async () => {
    const yesterday = fmtPktDate(new Date(Date.now() - DAY))
    const old = new Date(Date.now() - 3 * DAY)
    await prisma.raastReceipt.updateMany({ where: { tenantId: C.tenantId }, data: { status: 'matched' } })
    await mkReceipt(C, bankC, { amountCents: 21_000, confirmedAt: old })
    // S6: an attention receipt from an intent has no confirmedAt — its creation counts.
    await mkReceipt(C, bankC, { amountCents: 9_000, status: 'needs_attention', confirmedAt: null, createdAt: old })
    // Today's receipt is after the close date — not counted.
    await mkReceipt(C, bankC, { amountCents: 1_000 })

    const view = await call(adminC, 'GET', `/accounting/period-close?lockedThrough=${yesterday}`)
    expect(view.statusCode, view.body).toBe(200)
    expect(view.json().raastUnmatched).toMatchObject({ count: 2, cents: 30_000 })

    const refused = await call(adminC, 'POST', '/accounting/period-close', { lockedThrough: yesterday })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('RAAST_UNMATCHED')
    expect(refused.json().error.details ?? refused.json().error).toMatchObject({ count: 2, cents: 30_000 })
    expect(await prisma.periodLock.count({ where: { tenantId: C.tenantId } })).toBe(0)

    // Company A's unmatched receipts never block B's close.
    const bClose = await call(adminB, 'POST', '/accounting/period-close', { lockedThrough: yesterday })
    expect(bClose.statusCode, bClose.body).toBe(201)

    const forced = await call(adminC, 'POST', '/accounting/period-close', { lockedThrough: yesterday, closeWithUnmatchedRaast: true })
    expect(forced.statusCode, forced.body).toBe(201)
    expect(await prisma.auditLog.count({ where: { action: 'period.close_with_unmatched_raast', tenantId: C.tenantId } })).toBe(1)
  })
})

// ─── Review fixes (RV-MONEY-1, RV-FRAUD-1, RV-FIN-1/2/3) ─────────────────────

describe('review fixes', () => {
  let D: Company, E: Company
  let bankD: { bankAccountId: string; ledgerCode: string }
  let bankE: { bankAccountId: string; ledgerCode: string }
  let adminD: Who, financeD: Who, adminE: Who, financeE: Who

  beforeAll(async () => {
    D = await mkCompany('rrecon-d')
    E = await mkCompany('rrecon-e')
    adminD = await mkUser('rr-admin-d', 'admin', D.tenantId)
    financeD = await mkUser('rr-fin-d', 'finance', D.tenantId)
    adminE = await mkUser('rr-admin-e', 'admin', E.tenantId)
    financeE = await mkUser('rr-fin-e', 'finance', E.tenantId)
    bankD = await mkRaastAccount(D, { code: '1021' })
    bankE = await mkRaastAccount(E, { code: '1021' })
  })

  /** A receipt of `co` as mkReceipt writes it (mkReceipt is bound to A / B for its cashier). */
  async function receiptOf(co: Company, bank: { bankAccountId: string; ledgerCode: string }, who: Who, opts: { amountCents: number; shiftId?: string | null; status?: 'provisional' | 'needs_attention'; createdAt?: Date; orderStatus?: 'completed' | 'ready' | 'cancelled' | 'preparing'; source?: string }) {
    const orderId = await mkOrder(co, {
      items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: opts.amountCents }],
      taxCents: 0, taxRatePct: 8, totalCents: opts.amountCents, payments: [{ method: 'raast', amountCents: opts.amountCents }], shiftId: opts.shiftId ?? null,
    })
    if (opts.source || opts.orderStatus) {
      await prisma.order.update({ where: { id: orderId }, data: { ...(opts.source && { source: opts.source }), ...(opts.orderStatus && { status: opts.orderStatus }) } })
    }
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } })
    const ref = newRef()
    const status = opts.status ?? 'provisional'
    return prisma.raastReceipt.create({
      data: {
        tenantId: co.tenantId, orderId, conceptId: co.conceptId, shiftId: opts.shiftId ?? null,
        paymentId: status === 'needs_attention' ? null : payment.id, bankAccountId: bank.bankAccountId, ledgerCode: bank.ledgerCode,
        amountCents: opts.amountCents, dueCents: opts.amountCents, bankRef: ref, bankRefRaw: ref, status,
        confirmedVia: status === 'needs_attention' ? null : 'cashier', confirmedAt: status === 'needs_attention' ? null : (opts.createdAt ?? new Date()),
        cashierVerified: true, idempotencyKey: `pay:${payment.id}`, createdById: who.id, ...(opts.createdAt && { createdAt: opts.createdAt }),
      },
    })
  }

  async function bankNet(tenantId: string, code: string): Promise<number> {
    const lines = await prisma.journalLine.findMany({ where: { account: { tenantId, code } }, select: { type: true, amountCents: true } })
    return lines.reduce((s, l) => s + (l.type === 'debit' ? 1 : -1) * toCents(l.amountCents), 0)
  }

  it('RV-MONEY-1: a non-till order\'s Raast write-off waits for the entry that debited the bank for THAT receipt', async () => {
    const shift = await prisma.shift.create({ data: { userId: adminD.id, tenantId: D.tenantId, status: 'closed', openingFloatCents: 0, closedAt: new Date(), closingFloatCents: 0 } })
    const r = await receiptOf(D, bankD, adminD, { amountCents: 108_000, shiftId: shift.id, orderStatus: 'ready', source: 'servd' })
    // The drawer's close is posted — but it books only non-till CASH, never this Raast receipt.
    await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'shift.close', sourceId: shift.id, description: 'test close',
      lines: [{ accountCode: '1015', type: 'debit', amountCents: 5_000 }, { accountCode: '4100', type: 'credit', amountCents: 5_000 }],
    })
    const url = `/reconciliation/raast/receipts/${r.id}/unreceived`
    const refused = await call(adminD, 'POST', url, { reason: 'never arrived', contraAccountCode: '1110' })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('RAAST_SALE_NOT_BOOKED')
    expect(await bankNet(D.tenantId, bankD.ledgerCode)).toBe(0)

    // The order completes: its own entry debits the bank. Now the write-off nets it to zero.
    await bookSale(D, { orderId: r.orderId, amountCents: r.amountCents, ledgerCode: r.ledgerCode })
    const ok = await call(adminD, 'POST', url, { reason: 'never arrived', contraAccountCode: '1110' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await bankNet(D.tenantId, bankD.ledgerCode)).toBe(0)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: D.tenantId, reference: `raast.unreceived:${r.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.lines.map((l) => [l.account.code, l.type, toCents(l.amountCents)]).sort()).toEqual([['1110', 'debit', 108_000], [bankD.ledgerCode, 'credit', 108_000]].sort())
  })

  it('the default "customer owes" contra is the till-clearing code: 1110 while the company is not cut over', async () => {
    const r = await receiptOf(D, bankD, adminD, { amountCents: 21_500 })
    await bookSale(D, { orderId: r.orderId, amountCents: r.amountCents, ledgerCode: r.ledgerCode })
    const ok = await call(adminD, 'POST', `/reconciliation/raast/receipts/${r.id}/unreceived`, { reason: 'customer reversed it' })
    expect(ok.statusCode, ok.body).toBe(200)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: D.tenantId, reference: `raast.unreceived:${r.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.lines.find((l) => l.type === 'debit')!.account.code).toBe('1110')
  })

  it('before the cut-over an explicit "1115" (customer owes) still lands on 1110, the company\'s till-clearing code', async () => {
    const r = await receiptOf(D, bankD, adminD, { amountCents: 12_300 })
    await bookSale(D, { orderId: r.orderId, amountCents: r.amountCents, ledgerCode: r.ledgerCode })
    const ok = await call(adminD, 'POST', `/reconciliation/raast/receipts/${r.id}/unreceived`, { reason: 'customer reversed it', contraAccountCode: '1115' })
    expect(ok.statusCode, ok.body).toBe(200)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: D.tenantId, reference: `raast.unreceived:${r.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(je.lines.find((l) => l.type === 'debit')!.account.code).toBe('1110')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'raast.receipt.unreceived', entityId: r.id } })
    expect(log.metadata).toMatchObject({ contraAccountCode: '1110', contraRequested: '1115' })
  })

  it('after the CEO\'s cut-over: the default and the legacy "1110" both land on 1115; 8010 / 1350 stay as chosen; another company is untouched', async () => {
    const F = await mkCompany('rrecon-f')
    const adminF = await mkUser('rr-admin-f', 'admin', F.tenantId)
    const bankF = await mkRaastAccount(F, { code: '1021' })
    const cut = await cutoverTillClearing(F.tenantId, adminF.id, { reason: 'test cut-over of F' })
    expect(cut).toMatchObject({ status: 'cut_over', reason: 'zero' })
    const debitOf = async (id: string) => {
      const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: F.tenantId, reference: `raast.unreceived:${id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
      return je.lines.find((l) => l.type === 'debit')!.account.code
    }
    const cases: Array<[string | undefined, string]> = [[undefined, '1115'], ['1110', '1115'], ['1115', '1115'], ['8010', '8010'], ['1350', '1350']]
    for (const [contra, expected] of cases) {
      const r = await receiptOf(F, bankF, adminF, { amountCents: 10_100 })
      await bookSale(F, { orderId: r.orderId, amountCents: r.amountCents, ledgerCode: r.ledgerCode })
      const res = await call(adminF, 'POST', `/reconciliation/raast/receipts/${r.id}/unreceived`, { reason: 'never arrived', ...(contra && { contraAccountCode: contra }) })
      expect(res.statusCode, res.body).toBe(200)
      expect(await debitOf(r.id)).toBe(expected)
    }
    // D (not cut over) still defaults to 1110.
    const d = await receiptOf(D, bankD, adminD, { amountCents: 10_200 })
    await bookSale(D, { orderId: d.orderId, amountCents: d.amountCents, ledgerCode: d.ledgerCode })
    expect((await call(adminD, 'POST', `/reconciliation/raast/receipts/${d.id}/unreceived`, { reason: 'never arrived' })).statusCode).toBe(200)
    const dje = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: D.tenantId, reference: `raast.unreceived:${d.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(dje.lines.find((l) => l.type === 'debit')!.account.code).toBe('1110')
  })

  it('RV-MONEY-1: a cancelled non-till ticket — only a close that held it as a refund due (1110 till clearing, before the cut-over) lets it be written off', async () => {
    const shift = await prisma.shift.create({ data: { userId: adminD.id, tenantId: D.tenantId, status: 'closed', openingFloatCents: 0, closedAt: new Date(), closingFloatCents: 0 } })
    const held = await receiptOf(D, bankD, adminD, { amountCents: 33_300, shiftId: shift.id, orderStatus: 'cancelled', source: 'servd' })
    const bare = await receiptOf(D, bankD, adminD, { amountCents: 44_400, shiftId: shift.id, orderStatus: 'cancelled', source: 'servd' })
    await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'shift.close', sourceId: shift.id, description: 'test close',
      lines: [
        { accountCode: bankD.ledgerCode, type: 'debit', amountCents: 33_300, memo: `${RAAST_RECEIPTS_MEMO} — REFUND DUE — test` },
        { accountCode: '1110', type: 'credit', amountCents: 33_300, memo: refundDueMemo(held.orderId, 'test') },
      ],
    })
    const bareRes = await call(adminD, 'POST', `/reconciliation/raast/receipts/${bare.id}/unreceived`, { reason: 'never arrived' })
    expect(bareRes.statusCode).toBe(409)
    expect(bareRes.json().error.code).toBe('RAAST_SALE_NOT_BOOKED')
    const heldRes = await call(adminD, 'POST', `/reconciliation/raast/receipts/${held.id}/unreceived`, { reason: 'never arrived' })
    expect(heldRes.statusCode, heldRes.body).toBe(200)
  })

  it('RV-MONEY-1: a refund due held on 1115 (TILL_CLEARING_CODES — the code after the cut-over) counts as booked too', async () => {
    const shift = await prisma.shift.create({ data: { userId: adminD.id, tenantId: D.tenantId, status: 'closed', openingFloatCents: 0, closedAt: new Date(), closingFloatCents: 0 } })
    const held = await receiptOf(D, bankD, adminD, { amountCents: 36_600, shiftId: shift.id, orderStatus: 'cancelled', source: 'servd' })
    await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'shift.close', sourceId: shift.id, description: 'test close',
      lines: [
        { accountCode: bankD.ledgerCode, type: 'debit', amountCents: 36_600, memo: `${RAAST_RECEIPTS_MEMO} — REFUND DUE — test` },
        { accountCode: '1115', type: 'credit', amountCents: 36_600, memo: refundDueMemo(held.orderId, 'test') },
      ],
    })
    const res = await call(adminD, 'POST', `/reconciliation/raast/receipts/${held.id}/unreceived`, { reason: 'never arrived' })
    expect(res.statusCode, res.body).toBe(200)
    // …and is therefore never a "void, never booked".
    expect((await call(adminD, 'POST', `/reconciliation/raast/receipts/${held.id}/void`, { reason: 'trying a void after a write-off' })).json().error.code).toBe('RAAST_NOT_PROVISIONAL')
  })

  it('RV-FRAUD-1: a statement credit dated before the bill existed never matches it (a borrowed reference stays provisional)', async () => {
    const r = await receiptOf(D, bankD, adminD, { amountCents: 200_000 })
    const twoDaysAgo = fmtPktDate(new Date(Date.now() - 2 * DAY))
    const imp = await importCsv(financeD, bankD.bankAccountId, [{ date: twoDaysAgo, description: `RAAST CR ${r.bankRef} OWNER`, amount: '2,000.00' }])
    expect(imp.statusCode, imp.body).toBe(201)
    expect(imp.json().raastMatchedCount).toBe(0)
    const [line] = await linesOf(imp.json().importId)
    expect(line!.matchStatus).toBe('unmatched')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
    const cand = await call(financeD, 'GET', `/reconciliation/raast/receipts/${r.id}/candidates`)
    const c = cand.json().candidates.find((x: { id: string }) => x.id === line!.id)
    expect(c).toMatchObject({ beforeBill: true, refHit: false, suggested: false })
    // The same line dated today matches.
    const ok = await importCsv(financeD, bankD.bankAccountId, [{ description: `RAAST CR ${r.bankRef} ALI`, amount: '2,000.00' }])
    expect(ok.json().raastMatchedCount).toBe(1)
  })

  it('RV-FIN-2: a credit naming a Raast reference with another amount is never paired with an equal deposit by the generic matcher', async () => {
    const r = await receiptOf(D, bankD, adminD, { amountCents: 70_000 })
    const dep = await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'test.deposit', sourceId: randomBytes(6).toString('hex'), description: 'deposit',
      lines: [
        { accountCode: bankD.ledgerCode, type: 'debit', amountCents: 60_000, memo: 'Cash deposit' },
        { accountCode: '1010', type: 'credit', amountCents: 60_000 },
      ],
    })
    const imp = await importCsv(financeD, bankD.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '600.00' }])
    const [line] = await linesOf(imp.json().importId)
    expect(line!.matchStatus).toBe('unmatched')
    expect(line!.matchedJournalLineId).toBeNull()
    const depLine = await prisma.journalLine.findFirstOrThrow({ where: { journalEntryId: dep.entryId, type: 'debit' } })
    expect(await prisma.bankStatementLine.count({ where: { matchedJournalLineId: depLine.id } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: D.tenantId, kind: 'raast_statement_mismatch', entityId: r.id } })).toBe(1)

    // A written-off receipt's late credit (no reference on the line) is the Raast tab's too.
    const w = await receiptOf(D, bankD, adminD, { amountCents: 81_800 })
    await bookSale(D, { orderId: w.orderId, amountCents: w.amountCents, ledgerCode: w.ledgerCode })
    expect((await call(adminD, 'POST', `/reconciliation/raast/receipts/${w.id}/unreceived`, { reason: 'not on statement' })).statusCode).toBe(200)
    await postJournalEntry({
      tenantId: D.tenantId, sourceType: 'test.deposit', sourceId: randomBytes(6).toString('hex'), description: 'deposit 2',
      lines: [
        { accountCode: bankD.ledgerCode, type: 'debit', amountCents: 81_800, memo: 'Cash deposit' },
        { accountCode: '1010', type: 'credit', amountCents: 81_800 },
      ],
    })
    const imp2 = await importCsv(financeD, bankD.bankAccountId, [{ description: 'INWARD IBFT 77665544', amount: '818.00' }])
    const [line2] = await linesOf(imp2.json().importId)
    expect(line2!.matchStatus).toBe('unmatched')
  })

  it('RV-FIN-3: ignoring a Raast-matched line is refused; an ignored line is freed by the receipt\'s unmatch', async () => {
    const r = await receiptOf(D, bankD, adminD, { amountCents: 12_300 })
    const imp = await importCsv(financeD, bankD.bankAccountId, [{ description: `RAAST CR ${r.bankRef}`, amount: '123.00' }])
    const [line] = await linesOf(imp.json().importId)
    expect(line!.matchStatus).toBe('matched')
    const ig = await call(financeD, 'POST', `/reconciliation/bank/lines/${line!.id}/ignore`, {})
    expect(ig.statusCode).toBe(409)
    expect(ig.json().error.code).toBe('RAAST_MATCHED_LINE')
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line!.id } })).matchStatus).toBe('matched')

    // A line someone ignored the old way is freed by the unmatch, then re-matchable.
    await prisma.bankStatementLine.update({ where: { id: line!.id }, data: { matchStatus: 'ignored' } })
    const un = await call(adminD, 'POST', `/reconciliation/raast/receipts/${r.id}/unmatch`, {})
    expect(un.statusCode, un.body).toBe(200)
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line!.id } })).matchStatus).toBe('unmatched')
    const re = await call(financeD, 'POST', `/reconciliation/raast/receipts/${r.id}/match`, { statementLineId: line!.id })
    expect(re.statusCode, re.body).toBe(200)

    // A plain unmatched line can be ignored (twice is harmless); a generically matched one cannot.
    const imp2 = await importCsv(financeD, bankD.bankAccountId, [{ description: 'BANK CHARGE', amount: '-1.23' }])
    const [plain] = await linesOf(imp2.json().importId)
    const why = { reason: 'Test charge reversed by the bank' }
    expect((await call(financeD, 'POST', `/reconciliation/bank/lines/${plain!.id}/ignore`, why)).statusCode).toBe(200)
    expect((await call(financeD, 'POST', `/reconciliation/bank/lines/${plain!.id}/ignore`, why)).statusCode).toBe(200)
    await prisma.bankStatementLine.update({ where: { id: plain!.id }, data: { matchStatus: 'adjusted' } })
    expect((await call(financeD, 'POST', `/reconciliation/bank/lines/${plain!.id}/ignore`, {})).json().error.code).toBe('LINE_NOT_UNMATCHED')
  })

  it('RV-FIN-1: finance resolves a needs-attention receipt on a closed bill; the period then closes without the override', async () => {
    const yesterday = fmtPktDate(new Date(Date.now() - DAY))
    const old = new Date(Date.now() - 5 * DAY)
    const att = await receiptOf(E, bankE, adminE, { amountCents: 9_000, status: 'needs_attention', createdAt: old })
    // Its bank SMS (left open after the refused settle).
    await setConnector(E.tenantId, 'raast', { enabled: false })
    const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: E.tenantId, kind: 'raast' } } })
    const device = await prisma.bankSmsDevice.create({
      data: { tenantId: E.tenantId, connectorId: conn.id, label: 'Counter', tokenHash: randomBytes(32).toString('hex'), tokenEnc: 'x', tokenHint: 'x', createdById: adminE.id },
    })
    const alert = await prisma.bankSmsAlert.create({
      data: {
        tenantId: E.tenantId, deviceId: device.id, sender: 'MEEZAN', bodyHash: randomBytes(16).toString('hex'), body: 'x', receivedAt: old, occurredAt: old,
        kind: 'credit', amountCents: 9_000, bankRef: 'ATTN123456', bankAccountId: bankE.bankAccountId, status: 'needs_attention',
      },
    })
    await prisma.raastReceipt.update({ where: { id: att.id }, data: { smsAlertId: alert.id, attentionReason: 'SHIFT_CLOSED' } })

    expect((await call(adminE, 'POST', '/accounting/period-close', { lockedThrough: yesterday })).json().error.code).toBe('RAAST_UNMATCHED')

    const url = `/reconciliation/raast/receipts/${att.id}/resolve`
    const body = { outcome: 'refunded_to_customer', reason: 'customer paid cash, transfer sent back', refundReference: 'OUT-998877' }
    expect((await call(financeE, 'POST', url, body)).statusCode).toBe(403)
    expect((await call(adminB, 'POST', url, body)).statusCode).toBe(404)
    expect((await call(adminE, 'POST', url, { ...body, reason: 'x' })).statusCode).toBe(400)
    const ok = await call(adminE, 'POST', url, body)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('cancelled')
    const after = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: att.id } })
    expect(after).toMatchObject({ status: 'cancelled', smsAlertId: null })
    expect(after.cancelReason).toContain('finance:refunded_to_customer')
    expect(after.cancelReason).toContain('OUT998877')
    // Its SMS is closed and its reference can never pay a bill.
    expect(await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).toMatchObject({ status: 'dismissed', claimedRef: 'ATTN123456', resolvedById: adminE.id })
    expect(await prisma.auditLog.count({ where: { action: 'raast.receipt.resolve', entityId: att.id } })).toBe(1)
    // No ledger posting.
    expect(await prisma.journalEntry.count({ where: { tenantId: E.tenantId, description: { contains: att.orderId.slice(-8).toUpperCase() } } })).toBe(0)
    // Twice → 409.
    expect((await call(adminE, 'POST', url, body)).json().error.code).toBe('RAAST_NOT_ATTENTION')

    const close = await call(adminE, 'POST', '/accounting/period-close', { lockedThrough: yesterday })
    expect(close.statusCode, close.body).toBe(201)
    expect(await prisma.auditLog.count({ where: { action: 'period.close_with_unmatched_raast', tenantId: E.tenantId } })).toBe(0)
  })

  it('RV-FIN-1: while the bill is still open the till must attach or cancel it (409 RAAST_ATTACH_AT_TILL)', async () => {
    const att = await receiptOf(E, bankE, adminE, { amountCents: 7_700, status: 'needs_attention', orderStatus: 'preparing' })
    const r = await call(adminE, 'POST', `/reconciliation/raast/receipts/${att.id}/resolve`, { outcome: 'not_a_sale', reason: 'owner transfer' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('RAAST_ATTACH_AT_TILL')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: att.id } })).status).toBe('needs_attention')
  })
})
