// Till clearing — the CEO's one-time 1110 → 1115 cut-over, the daily mover
// and the 1110 tie-out (accounting/tillClearing.ts, tillClearingRoutes.ts).
//
//   - legacy 1110 till lines (shift.close unsettled / REFUND DUE, a cancelled
//     ticket's hand-back, a till card failed after its close, a Raast
//     write-off): the cut-over moves exactly their net, per brand;
//   - ON ACCOUNT lines, a manual 1110 journal and a receivable.issue are NOT
//     moved (the tie-out lists the manual one as unexplained);
//   - a re-run is a no-op; company B's books and switch are untouched;
//   - no cut-over without the CEO (finance → 403), the active company only;
//   - the daily job moves a later reversal of a pre-cut-over entry (and a
//     close that raced the cut-over) once, and never an entry X already held;
//   - a post-marker manual 1110 line raises ONE till_clearing_unexpected flag;
//   - a locked period: the cut-over is refused and flagged posting_failed;
//     Reconciliation → Backfill unposted posts it once unlocked;
//   - the COD rider-debt reversal re-poster is registered.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, caller, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { postJournalEntry, reverseJournalEntry, flagPostingFailed, ON_ACCOUNT_MEMO } from '../src/modules/accounting/journal.js'
import { tillClearingCodeTx, tillClearingCutoverAt } from '../src/modules/accounting/tillClearingCode.js'
import {
  TILL_SPLIT_SOURCE, cutoverTillClearing, moveLateTillLines, tieOutOf, isTillClearingLine, TILL_SOURCES,
} from '../src/modules/accounting/tillClearing.js'
import { tillClearingRoutes } from '../src/modules/accounting/tillClearingRoutes.js'
import { backfillUnpostedOrders } from '../src/modules/reconciliation/backfillOrders.js'
import { toCents } from '../src/lib/money.js'

const RUN = Math.random().toString(36).slice(2, 7)

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company, C: Company
let ceoA: Who, financeA: Who, ceoB: Who, ceoC: Who

async function net(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}
async function entryLines(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: toCents(l.amountCents), conceptId: l.conceptId })) : null
}
const post = (tenantId: string, sourceType: string, sourceId: string, lines: Parameters<typeof postJournalEntry>[0]['lines']) =>
  postJournalEntry({ tenantId, sourceType, sourceId, description: `test ${sourceType}`, lines })

/** The legacy till lines of a company: net Dr on 1110 = 9_500. */
async function legacyBooks(co: Company) {
  const k = `${co.tenantId.slice(0, 6)}${RUN}`
  // A drawer close: unsettled 5_000 (Dr 1110), a refund due 2_000 (Cr 1110), an ON ACCOUNT client 7_000 (never moved).
  await post(co.tenantId, 'shift.close', `S1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 5_000, memo: 'Unsettled at close', conceptId: co.conceptId },
    { accountCode: '1110', type: 'credit', amountCents: 2_000, memo: 'REFUND DUE — cancelled order X', conceptId: co.conceptId },
    { accountCode: '1110', type: 'debit', amountCents: 7_000, memo: `${ON_ACCOUNT_MEMO} — C-0001 Acme — #AB12`, conceptId: co.conceptId },
    { accountCode: '1015', type: 'debit', amountCents: 10_000, conceptId: co.conceptId },
    { accountCode: '4100', type: 'credit', amountCents: 20_000, conceptId: co.conceptId },
  ])
  // The hand-back of that refund due (counts), and an on-account refund (does not).
  await post(co.tenantId, 'order.refund', `P1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 2_000, memo: 'Refund due handed back — cancelled order X', conceptId: co.conceptId },
    { accountCode: '1015', type: 'credit', amountCents: 2_000, conceptId: co.conceptId },
  ])
  await post(co.tenantId, 'order.refund', `P2-${k}`, [
    { accountCode: '4100', type: 'debit', amountCents: 1_200, conceptId: co.conceptId },
    { accountCode: '1110', type: 'credit', amountCents: 1_200, memo: `${ON_ACCOUNT_MEMO} — Refund on brand #CD34`, conceptId: co.conceptId },
  ])
  // A Raast payment written off as "the customer owes it" (no brand), a till card failed after its close.
  await post(co.tenantId, 'raast.unreceived', `R1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 3_000 },
    { accountCode: '1020', type: 'credit', amountCents: 3_000 },
  ])
  await post(co.tenantId, 'pos.card_failed', `F1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 1_500, conceptId: co.conceptId },
    { accountCode: '1030', type: 'credit', amountCents: 1_500, conceptId: co.conceptId },
  ])
  // Never moved: a manual journal and an invoice.
  await post(co.tenantId, 'manual', `M1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 9_999 },
    { accountCode: '3010', type: 'credit', amountCents: 9_999 },
  ])
  await post(co.tenantId, 'receivable.issue', `I1-${k}`, [
    { accountCode: '1110', type: 'debit', amountCents: 11_800 },
    { accountCode: '4090', type: 'credit', amountCents: 11_800 },
  ])
  return { raastSourceId: `R1-${k}`, manualRef: `manual:M1-${k}` }
}

let legacyA: Awaited<ReturnType<typeof legacyBooks>>

beforeAll(async () => {
  A = await mkCompany(`tca${RUN}`)
  B = await mkCompany(`tcb${RUN}`)
  C = await mkCompany(`tcc${RUN}`)
  ceoA = await mkUser(`ceoa${RUN}`, 'admin', A.tenantId)
  financeA = await mkUser(`fina${RUN}`, 'finance', A.tenantId)
  ceoB = await mkUser(`ceob${RUN}`, 'admin', B.tenantId)
  ceoC = await mkUser(`ceoc${RUN}`, 'admin', C.tenantId)
  legacyA = await legacyBooks(A)
  await legacyBooks(B)
  await prisma.receivableInvoice.create({
    data: {
      tenantId: A.tenantId, number: `AR-${RUN}-1`, customerName: 'Acme', issueDate: new Date(), dueDate: new Date(),
      description: 'Catering', amountCents: 11_800, kind: 'invoice',
    },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    return reply.status(status && status >= 400 && status < 500 ? status : 500).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(tillClearingRoutes, { prefix: '/accounting/till-clearing' })
  await app.ready()
  call = caller(app)
})

afterAll(async () => {
  await app?.close()
})

describe('the allow-list', () => {
  it('matches till sources and their reversals; order.refund only on hand-back lines; never ON ACCOUNT or receivable.*', () => {
    expect(TILL_SOURCES).toEqual(expect.arrayContaining(['shift.close:', 'shift.close.reversal:', 'raast.unreceived.reversal:', 'order.refund:']))
    expect(isTillClearingLine('shift.close:x', 'Unsettled')).toBe(true)
    expect(isTillClearingLine('shift.close:x', `${ON_ACCOUNT_MEMO} — C-1`)).toBe(false)
    expect(isTillClearingLine('order.refund:x', 'Refund due handed back — cancelled order 1')).toBe(true)
    expect(isTillClearingLine('order.refund:x', 'Refund on brand #1')).toBe(false)
    expect(isTillClearingLine('order.refund_wallet:x', 'Refund due handed back')).toBe(false)
    expect(isTillClearingLine('raast.unreceived.reversal:x', null)).toBe(true)
    expect(isTillClearingLine('receivable.issue:x', null)).toBe(false)
    expect(isTillClearingLine('manual:x', null)).toBe(false)
  })
})

describe('the cut-over (the CEO, per company)', () => {
  it('finance sees the preview but cannot cut over (403); a short reason is refused', async () => {
    const st = await call(financeA, 'GET', '/accounting/till-clearing/status')
    expect(st.statusCode, st.body).toBe(200)
    const a = st.json().companies.find((c: { tenantId: string }) => c.tenantId === A.tenantId)
    expect(a).toMatchObject({ cutoverAt: null, previewCents: 9_500, canCutover: false })
    expect(st.json().companies.some((c: { tenantId: string }) => c.tenantId === B.tenantId)).toBe(false)
    expect((await call(financeA, 'POST', '/accounting/till-clearing/cutover', { reason: 'CA confirmed the split' })).statusCode).toBe(403)
    expect((await call(ceoA, 'POST', '/accounting/till-clearing/cutover', { reason: 'ok' })).statusCode).toBe(400)
    const ceo = await call(ceoA, 'GET', '/accounting/till-clearing/status')
    expect(ceo.json().companies.find((c: { tenantId: string }) => c.tenantId === A.tenantId).canCutover).toBe(true)
    expect(await tillClearingCutoverAt(prisma, A.tenantId)).toBeNull()
    expect(await tillClearingCodeTx(prisma, A.tenantId)).toBe('1110')
  })

  it('moves exactly the till lines\' net (9_500) per brand; ON ACCOUNT, manual and receivable lines stay; B untouched', async () => {
    const before1110 = await net(A.tenantId, '1110')
    const b1110 = await net(B.tenantId, '1110')
    const res = await call(ceoA, 'POST', '/accounting/till-clearing/cutover', { reason: 'CA confirmed the 1115 split today' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ status: 'cut_over', movedCents: 9_500 })
    const lines = await entryLines(A.tenantId, `${TILL_SPLIT_SOURCE}:${A.tenantId}`)
    expect(lines).not.toBeNull()
    const sum = (code: string, type: string, conceptId?: string | null) => lines!
      .filter((l) => l.code === code && l.type === type && (conceptId === undefined || l.conceptId === conceptId))
      .reduce((t, l) => t + l.amount, 0)
    expect(sum('1110', 'credit')).toBe(9_500)
    expect(sum('1115', 'debit')).toBe(9_500)
    expect(sum('1110', 'debit') + sum('1115', 'credit')).toBe(0)
    // Per brand: 6_500 on the brand (5_000 − 2_000 + 2_000 + 1_500), 3_000 with no brand (the Raast write-off).
    expect(sum('1115', 'debit', A.conceptId)).toBe(6_500)
    expect(sum('1115', 'debit', null)).toBe(3_000)
    expect(await net(A.tenantId, '1110')).toBe(before1110 - 9_500)
    expect(await net(A.tenantId, '1115')).toBe(9_500)
    expect(await tillClearingCodeTx(prisma, A.tenantId)).toBe('1115')
    expect(await tillClearingCutoverAt(prisma, A.tenantId)).not.toBeNull()
    // Audited.
    expect(await prisma.auditLog.findFirst({ where: { action: 'ledger.till_clearing_cutover', entityId: A.tenantId, tenantId: A.tenantId } })).not.toBeNull()
    // Company B: no marker, nothing moved, still 1110 for new postings.
    expect(await net(B.tenantId, '1110')).toBe(b1110)
    expect(await net(B.tenantId, '1115')).toBe(0)
    expect(await tillClearingCutoverAt(prisma, B.tenantId)).toBeNull()
    expect(await tillClearingCodeTx(prisma, B.tenantId)).toBe('1110')
    expect(await prisma.journalEntry.count({ where: { tenantId: B.tenantId, reference: { startsWith: TILL_SPLIT_SOURCE } } })).toBe(0)
  })

  it('a re-run is a no-op (200, already cut over, nothing posted)', async () => {
    const count = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const again = await call(ceoA, 'POST', '/accounting/till-clearing/cutover', { reason: 'pressed the button twice' })
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ status: 'already_cut_over', entryId: null, movedCents: 0 })
    const direct = await cutoverTillClearing(A.tenantId, ceoA.id)
    expect(direct.status).toBe('already_cut_over')
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(count)
  })

  it('the tie-out: no till clearing left on 1110, invoices explained, the manual journal listed as unexplained', async () => {
    const t = await tieOutOf(A.tenantId)
    expect(t.cutoverAt).not.toBeNull()
    expect(t.tillClearingOn1110Cents).toBe(0)
    expect(t.openInvoicesCents).toBe(11_800)
    expect(t.gl1110).toBe(await net(A.tenantId, '1110'))
    expect(t.unexplainedLines.map((l) => l.reference)).toContain(legacyA.manualRef)
    expect(t.unexplainedLines.every((l) => !(l.reference ?? '').startsWith('receivable.'))).toBe(true)
    expect(t.unexplainedLines.every((l) => !(l.memo ?? '').startsWith(ON_ACCOUNT_MEMO))).toBe(true)
    // gl1110 = invoices (11_800) + ON ACCOUNT (7_000 − 1_200) + manual 9_999 → 5_800 + 9_999 unexplained by the subledger here.
    expect(t.differenceCents).toBe(t.gl1110 - 11_800)
    // B's tie-out: still on 1110, X shown.
    expect((await tieOutOf(B.tenantId)).tillClearingOn1110Cents).toBe(9_500)
  })
})

describe('the daily mover (after the cut-over)', () => {
  it('moves a later reversal of a pre-cut-over entry, and a close that raced the cut-over, once each', async () => {
    const cutoverAt = (await tillClearingCutoverAt(prisma, A.tenantId))!
    // A pre-cut-over Raast write-off is reversed (the money turned up): mirrors 1110.
    await reverseJournalEntry(A.tenantId, 'raast.unreceived', legacyA.raastSourceId, 'found on the statement')
    const rev = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `raast.unreceived.reversal:${legacyA.raastSourceId}` } })
    // A close that read 1110 just before the marker and committed after it.
    const raced = await post(A.tenantId, 'shift.close', `RACED-${RUN}`, [
      { accountCode: '1110', type: 'debit', amountCents: 800, memo: 'Unsettled at close', conceptId: A.conceptId },
      { accountCode: '4100', type: 'credit', amountCents: 800, conceptId: A.conceptId },
    ])
    await prisma.journalEntry.update({ where: { id: raced.entryId }, data: { createdAt: new Date(cutoverAt.getTime() - 1_000) } })

    const r = await moveLateTillLines(A.tenantId)
    expect(r.refused).toEqual([])
    expect(r.moved.map((m) => m.entryId).sort()).toEqual([rev.id, raced.entryId].sort())
    const revMove = await entryLines(A.tenantId, `${TILL_SPLIT_SOURCE}:${A.tenantId}:r:${rev.id}`)
    expect(revMove!.map((l) => [l.code, l.type, l.amount]).sort()).toEqual([['1110', 'debit', 3_000], ['1115', 'credit', 3_000]])
    const racedMove = await entryLines(A.tenantId, `${TILL_SPLIT_SOURCE}:${A.tenantId}:r:${raced.entryId}`)
    expect(racedMove!.map((l) => [l.code, l.type, l.amount]).sort()).toEqual([['1110', 'credit', 800], ['1115', 'debit', 800]])
    expect((await tieOutOf(A.tenantId)).tillClearingOn1110Cents).toBe(0)
    expect(await net(A.tenantId, '1115')).toBe(9_500 - 3_000 + 800)

    // Again: nothing (and nothing the cut-over already held is ever moved).
    const again = await moveLateTillLines(A.tenantId)
    expect(again.moved).toEqual([])
  })

  it('a post-marker manual 1110 line raises ONE till_clearing_unexpected flag; receivable and ON ACCOUNT lines do not', async () => {
    const manual = await post(A.tenantId, 'manual', `M2-${RUN}`, [
      { accountCode: '1110', type: 'debit', amountCents: 4_444 },
      { accountCode: '3010', type: 'credit', amountCents: 4_444 },
    ])
    const inv = await post(A.tenantId, 'receivable.issue', `I2-${RUN}`, [
      { accountCode: '1110', type: 'debit', amountCents: 2_000 },
      { accountCode: '4090', type: 'credit', amountCents: 2_000 },
    ])
    const onAcc = await post(A.tenantId, 'order.complete', `OA-${RUN}`, [
      { accountCode: '1110', type: 'debit', amountCents: 3_300, memo: `${ON_ACCOUNT_MEMO} — brand` },
      { accountCode: '4100', type: 'credit', amountCents: 3_300 },
    ])
    const r = await moveLateTillLines(A.tenantId)
    expect(r.moved).toEqual([])
    expect(r.flagged).toEqual([manual.entryId])
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'till_clearing_unexpected', tenantId: A.tenantId } })
    expect(flags.map((f) => f.entityId)).toEqual([manual.entryId])
    expect(flags.map((f) => f.entityId)).not.toContain(inv.entryId)
    expect(flags.map((f) => f.entityId)).not.toContain(onAcc.entryId)
    // Never moved, never flagged twice.
    expect((await moveLateTillLines(A.tenantId)).flagged).toEqual([])
    expect(await prisma.exceptionFlag.count({ where: { kind: 'till_clearing_unexpected', tenantId: A.tenantId } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `${TILL_SPLIT_SOURCE}:${A.tenantId}:r:${manual.entryId}` } })).toBe(0)
  })

  it('a company without the marker is never touched by the mover', async () => {
    const r = await moveLateTillLines(B.tenantId)
    expect(r).toMatchObject({ cutoverAt: null, moved: [], flagged: [] })
    expect(await net(B.tenantId, '1115')).toBe(0)
  })
})

describe('a refused cut-over (locked period) and the re-poster', () => {
  it('flags posting_failed on the company and nothing is written; the backfill posts it once unlocked', async () => {
    await post(C.tenantId, 'shift.close', `SC-${RUN}`, [
      { accountCode: '1110', type: 'debit', amountCents: 4_200, memo: 'Unsettled at close', conceptId: C.conceptId },
      { accountCode: '4100', type: 'credit', amountCents: 4_200, conceptId: C.conceptId },
    ])
    const lock = await prisma.periodLock.create({ data: { tenantId: C.tenantId, lockedThrough: new Date(Date.now() + 2 * 86_400_000), lockedBy: ceoC.id } })
    const refused = await call(ceoC, 'POST', '/accounting/till-clearing/cutover', { reason: 'CA confirmed the 1115 split today' })
    expect(refused.statusCode, refused.body).toBe(422)
    expect(refused.json().error.code).toBe('PERIOD_LOCKED')
    expect(await tillClearingCutoverAt(prisma, C.tenantId)).toBeNull()
    expect(await net(C.tenantId, '1115')).toBe(0)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', tenantId: C.tenantId, entityType: 'Tenant', entityId: C.tenantId } })
    expect(flag.status).toBe('open')
    expect(flag.metadata).toMatchObject({ sourceType: TILL_SPLIT_SOURCE, sourceId: C.tenantId })
    expect(typeof (flag.metadata as { documentDate?: unknown }).documentDate).toBe('string')

    // Still locked through today: the backfill lists it, posts nothing.
    const dry = await backfillUnpostedOrders({ tenantIds: [C.tenantId], dryRun: false, postedBy: ceoC.id })
    expect(dry.rows.find((r) => r.kind === 'ledger.till_clearing_split')?.outcome).toBe('locked')
    expect(await tillClearingCutoverAt(prisma, C.tenantId)).toBeNull()

    await prisma.periodLock.delete({ where: { id: lock.id } })
    const preview = await backfillUnpostedOrders({ tenantIds: [C.tenantId], dryRun: true })
    expect(preview.rows.find((r) => r.kind === 'ledger.till_clearing_split')).toMatchObject({ outcome: 'would_post', tenantId: C.tenantId })
    const run = await backfillUnpostedOrders({ tenantIds: [C.tenantId], dryRun: false, postedBy: ceoC.id })
    expect(run.rows.find((r) => r.kind === 'ledger.till_clearing_split')?.outcome).toBe('posted')
    expect(await tillClearingCutoverAt(prisma, C.tenantId)).not.toBeNull()
    expect(await net(C.tenantId, '1115')).toBe(4_200)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flag.id } })).status).toBe('resolved')
    // Another company's backfill never sees C's flag; B is untouched.
    expect(await tillClearingCutoverAt(prisma, B.tenantId)).toBeNull()
  })

  it('B\'s CEO cuts over B only (the active company), never A or C', async () => {
    const a1115 = await net(A.tenantId, '1115')
    const res = await call(ceoB, 'POST', '/accounting/till-clearing/cutover', { reason: 'CA confirmed the 1115 split for B' })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().movedCents).toBe(9_500)
    expect(await net(B.tenantId, '1115')).toBe(9_500)
    expect(await net(A.tenantId, '1115')).toBe(a1115)
  })
})

describe('the COD rider-debt reversal re-poster', () => {
  it('is registered: a flag on a payment that no longer exists is closed by the backfill', async () => {
    const paymentId = `00000000-0000-4000-8000-${RUN.padEnd(12, '0').slice(0, 12)}`
    await flagPostingFailed({
      tenantId: A.tenantId, sourceType: 'cod.rider_debt.reversal', sourceId: paymentId,
      entityType: 'Payment', entityId: paymentId, reason: 'test refusal', title: 'COD reversal refused',
    })
    const dry = await backfillUnpostedOrders({ tenantIds: [A.tenantId], dryRun: true })
    expect(dry.rows.find((r) => r.kind === 'cod.rider_debt.reversal' && r.id === paymentId)?.outcome).toBe('would_resolve')
  })
})
