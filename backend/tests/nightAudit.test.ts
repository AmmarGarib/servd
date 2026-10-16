// The night audit (owner, 2026-10-16; SALES module only): finance runs each
// past sales day; the night step blocks on open tills, unreviewed cash
// differences, open tickets, Raast, COD, unresolved tenders and refused SALES
// postings (never on a supplier bill's or petty cash's); the CEO alone pushes
// past a block, with a reason (audited, flagged); days run in order; an
// audited day closes when its card payout and the bank side of its sales
// money are matched (an unmatched supplier payment never holds it); the CEO
// alone reopens. Two companies: each sees and binds only its own days.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { fmtPktDate, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { postDepositDrop } from '../src/modules/accounting/depositPosting.js'
import { nightAuditRoutes } from '../src/modules/nightAudit/routes.js'
import { refreshAuditedDays } from '../src/modules/nightAudit/service.js'

let app: FastifyInstance
let A: string
let B: string
let conceptA: string
let conceptB: string
let bankB: string
const users: Record<string, { id: string; token: string }> = {}

const DAY_MS = 86_400_000
const dayAgo = (n: number) => fmtPktDate(new Date(Date.now() - n * DAY_MS))
const at = (day: string, hhmm = '13:00') => new Date(`${day}T${hhmm}:00+05:00`)
const today = dayAgo(0)
const D1 = dayAgo(1) // A: the day with every block
const D2 = dayAgo(2) // A: only non-sales activity
const D3 = dayAgo(3) // A: a clean sales day
const D4 = dayAgo(4) // A: the start day, clean
const YB = dayAgo(1) // B: the settlement day

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.na@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, tenant: string, payload?: unknown) =>
  app.inject({
    method, url: `/accounting/night-audit${url}`, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}`, 'x-servd-active-tenant': tenant },
  })

type Problem = { key: string; severity: string; count: number }
const blockKeys = (detail: { checks: { blocks: Problem[] } | null }) => (detail.checks?.blocks ?? []).map((b) => b.key).sort()

async function order(conceptId: string, data: Record<string, unknown>) {
  return prisma.order.create({ data: { conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 0, taxCents: 0, ...data } as never })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Night Foods', slug: 'na-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Night Viva', slug: 'na-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer N', slug: 'simmer', type: 'restaurant', tenantId: A, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Flipd N', slug: 'flipd', type: 'restaurant', tenantId: B, taxRateCash: 15, taxRateCard: 8 } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: B, name: 'HBL B', accountCode: '1020' } })).id
  await mkUser('ceo', 'admin', A, [A, B])
  await mkUser('fin', 'finance', A, [A])
  await mkUser('adminB', 'admin', B, [B])
  await mkUser('finB', 'finance', B, [B])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'FORBIDDEN', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(nightAuditRoutes, { prefix: '/accounting/night-audit' })
  await app.ready()

  // ── Company A ──
  // D4, D3: clean sales days (a bill with no money; a cancelled ticket).
  await order(conceptA, { placedAt: at(D4, '12:00'), completedAt: at(D4, '12:10') })
  await order(conceptA, { status: 'cancelled', placedAt: at(D3, '12:00'), cancelledAt: at(D3, '12:05') })
  // D2: a supplier bill, a petty-cash spend and a manual journal only.
  for (const [sourceType, d, c] of [['supplier.bill', '5010', '2010'], ['pettycash.spend', '6170', '1011'], ['manual', '6170', '1010']] as const) {
    await postJournalEntry({ tenantId: A, sourceType, sourceId: `d2-${sourceType}`, description: 'not sales', entryDate: at(D2), lines: [
      { accountCode: d, type: 'debit', amountCents: 1_000 }, { accountCode: c, type: 'credit', amountCents: 1_000 },
    ] })
  }
  // D1: every night block.
  await prisma.shift.create({ data: { userId: users.ceo!.id, tenantId: A, status: 'open', openedAt: at(D1, '09:00') } })
  const closed = await prisma.shift.create({ data: { userId: users.ceo!.id, tenantId: A, status: 'closed', openedAt: at(D1, '09:00'), closedAt: at(D1, '23:00'), closingFloatCents: 0 } })
  await prisma.exceptionFlag.create({ data: { tenantId: A, kind: 'cash_variance', severity: 'medium', title: 'Short', description: 'x', entityType: 'Shift', entityId: closed.id, amountCents: -5_000 } })
  const open = await order(conceptA, { status: 'received', placedAt: at(D1, '20:00'), totalCents: 30_000 })
  const bankA = (await prisma.bankAccount.create({ data: { tenantId: A, name: 'HBL A', accountCode: '1020' } })).id
  await prisma.raastReceipt.create({ data: {
    tenantId: A, orderId: open.id, conceptId: conceptA, bankAccountId: bankA, ledgerCode: '1020', amountCents: 30_000, dueCents: 30_000,
    status: 'needs_attention', idempotencyKey: 'rr-1', createdById: users.ceo!.id, createdAt: at(D1, '20:05'),
  } })
  const cod = await order(conceptA, { source: 'servd', fulfilmentType: 'delivery', placedAt: at(D1, '19:00'), completedAt: at(D1, '19:40'), totalCents: 25_000 })
  await prisma.payment.create({ data: { orderId: cod.id, method: 'cash', amountCents: 25_000, status: 'pending', createdAt: at(D1, '19:00') } })
  const web = await order(conceptA, { source: 'servd', placedAt: at(D1, '18:00'), completedAt: at(D1, '18:30'), totalCents: 12_000 })
  await prisma.payment.create({ data: { orderId: web.id, method: 'card', gateway: 'keenu', amountCents: 12_000, status: 'pending', createdAt: at(D1, '18:00') } })
  const conn = await prisma.posConnector.create({ data: { tenantId: A, kind: 'terminal', webhookToken: randomBytes(16).toString('hex') } })
  await prisma.terminalCharge.create({ data: {
    tenantId: A, connectorId: conn.id, terminalId: 'trm-1', orderId: open.id, amountCents: 30_000, quoteDueCents: 30_000,
    idempotencyKey: 'tc-1', status: 'unknown', expiresAt: at(D1, '21:00'), createdById: users.ceo!.id, createdAt: at(D1, '20:10'),
  } })
  // Refused postings of D1 from OTHER modules — never a night block.
  for (const sourceType of ['supplier.bill', 'pettycash.spend']) {
    await prisma.exceptionFlag.create({ data: {
      tenantId: A, kind: 'posting_failed', severity: 'high', title: 'refused', description: 'x', entityType: 'SupplierBill', entityId: `x-${sourceType}`,
      metadata: { sourceType, sourceId: `x-${sourceType}`, documentDate: at(D1).toISOString() },
    } })
  }
})

afterAll(async () => { await app.close() })

describe('company separation and the basics', () => {
  it('B sees only its own day — nothing of A leaks', async () => {
    const r = await call('adminB', 'GET', `/${D1}`, B)
    expect(r.statusCode).toBe(200)
    expect(r.json().tenantId).toBe(B)
    expect(r.json().active).toBe(false)
    expect(blockKeys(r.json())).toEqual([])
    const a = await call('ceo', 'GET', `/${D1}`, A)
    expect(a.json().active).toBe(true)
    expect(a.json().checks.blocks.length).toBeGreaterThan(0)
  })

  it('today cannot be run (DAY_NOT_OVER); a bad day is INVALID_DATE', async () => {
    expect((await call('fin', 'POST', `/${today}/run`, A, {})).json().error.code).toBe('DAY_NOT_OVER')
    expect((await call('fin', 'POST', '/2026-02-30/run', A, {})).json().error.code).toBe('INVALID_DATE')
  })

  it('a day with only a supplier bill, petty cash and a manual journal is not an active sales day', async () => {
    const r = await call('fin', 'GET', `/?month=${D2.slice(0, 7)}`, A)
    expect(r.statusCode).toBe(200)
    const day = (r.json().days as Array<{ day: string; active: boolean }>).find((d) => d.day === D2)
    expect(day?.active).toBe(false)
    expect((r.json().days as Array<{ day: string; active: boolean }>).find((d) => d.day === D4)?.active).toBe(true)
  })
})

describe('order of days and the start day', () => {
  it('only the CEO sets the start day, with a reason', async () => {
    expect((await call('fin', 'PUT', '/settings', A, { startDay: D4, reason: 'Go live from here' })).statusCode).toBe(403)
    expect((await call('ceo', 'PUT', '/settings', A, { startDay: D4, reason: 'short' })).json().error.code).toBe('REASON_REQUIRED')
    const r = await call('ceo', 'PUT', '/settings', A, { startDay: D4, reason: 'Night audit goes live' })
    expect(r.json()).toEqual({ startDay: D4 })
  })

  it('EARLIER_DAYS_OPEN until the earlier sales days are run; clean days close at once', async () => {
    const r = await call('fin', 'POST', `/${D1}/run`, A, {})
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('EARLIER_DAYS_OPEN')
    expect(r.json().error.details.days).toEqual([D4, D3])
    for (const d of [D4, D3]) {
      const ok = await call('fin', 'POST', `/${d}/run`, A, {})
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json().status).toBe('closed')
      expect(ok.json().closedVia).toBe('auto')
      expect(ok.json().report.day).toBe(d)
    }
    expect((await call('fin', 'POST', `/${D4}/run`, A, {})).json().error.code).toBe('ALREADY_AUDITED')
  })
})

describe('the night blocks', () => {
  it('every sales block shows on the day; other modules\' refused postings do not', async () => {
    const r = await call('fin', 'GET', `/${D1}`, A)
    expect(blockKeys(r.json())).toEqual(['cash_variance_open', 'cod_pending', 'open_orders', 'open_tills', 'raast_open_night', 'tenders_unresolved'])
  })

  it('a refused SALES posting of the day is a block', async () => {
    await prisma.exceptionFlag.create({ data: {
      tenantId: A, kind: 'posting_failed', severity: 'high', title: 'refused', description: 'x', entityType: 'Order', entityId: 'ord-x',
      metadata: { sourceType: 'order.complete', sourceId: 'ord-x', documentDate: at(D1).toISOString() },
    } })
    const r = await call('fin', 'GET', `/${D1}`, A)
    expect(blockKeys(r.json())).toContain('posting_failed')
  })

  it('finance cannot run over blocks; only the CEO acknowledges, with a reason — audited and flagged', async () => {
    const refused = await call('fin', 'POST', `/${D1}/run`, A, {})
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('NIGHT_AUDIT_NOT_READY')
    const keys = (refused.json().error.details.blocks as Problem[]).map((b) => b.key)
    expect(keys).toHaveLength(7)

    const finAck = await call('fin', 'POST', `/${D1}/run`, A, { acknowledge: { keys, reason: 'Finance wants to push it' } })
    expect(finAck.statusCode).toBe(403)
    expect(finAck.json().error.code).toBe('OVERRIDE_CEO_ONLY')
    const short = await call('ceo', 'POST', `/${D1}/run`, A, { acknowledge: { keys, reason: 'short' } })
    expect(short.json().error.code).toBe('OVERRIDE_REASON_REQUIRED')
    const partial = await call('ceo', 'POST', `/${D1}/run`, A, { acknowledge: { keys: keys.slice(1), reason: 'Pushing most of it through' } })
    expect(partial.statusCode).toBe(409)
    expect(partial.json().error.details.missing).toEqual([keys[0]])
    // The calendar shows the last check.
    const month = await call('fin', 'GET', `/?month=${D1.slice(0, 7)}`, A)
    expect((month.json().days as Array<{ day: string; lastCheck: { blocks: unknown[] } | null }>).find((d) => d.day === D1)?.lastCheck?.blocks).toHaveLength(7)

    const ok = await call('ceo', 'POST', `/${D1}/run`, A, { acknowledge: { keys, reason: 'Owner approved: rider cash in tomorrow' } })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(['audited', 'closed']).toContain(ok.json().status)
    expect(ok.json().nightOverrides.map((o: { key: string }) => o.key).sort()).toEqual([...keys].sort())
    expect(ok.json().nightOverrideReason).toBe('Owner approved: rider cash in tomorrow')
    const row = await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: A, businessDate: D1 } } })
    expect(row.tenantId).toBe(A)
    expect(await prisma.nightAuditDay.count({ where: { tenantId: B } })).toBe(0)
    expect(await prisma.auditLog.count({ where: { tenantId: A, action: 'night_audit.override' } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A, kind: 'night_audit_override' } })).toBe(1)
  })
})

describe('settlement (company B)', () => {
  let shiftId: string
  let dropEntryLineId: string

  it('audited, not closed, while the card payout and the till cash are not in the bank', async () => {
    const shift = await prisma.shift.create({ data: { userId: users.finB!.id, tenantId: B, status: 'closed', openedAt: at(YB, '09:00'), closedAt: at(YB, '23:00'), openingFloatCents: 0, closingFloatCents: 5_000 } })
    shiftId = shift.id
    const o = await order(conceptB, { placedAt: at(YB, '12:00'), completedAt: at(YB, '12:30'), totalCents: 25_000, items: { create: [{ name: 'Burger', quantity: 1, unitPriceCents: 25_000 }] } })
    await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: 5_000, status: 'paid', processedAt: at(YB, '12:30') } })
    await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'card', amountCents: 20_000, status: 'paid', processedAt: at(YB, '12:30') } })
    const posted = await postShiftClose(shiftId)
    expect(posted.posted).toBe(true)

    const run = await call('finB', 'POST', `/${YB}/run`, B, {})
    expect(run.statusCode, run.body).toBe(200)
    expect(run.json().status).toBe('audited')
    expect(blockKeys(run.json())).toEqual(['card_matching_off', 'cash_not_banked'])
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: B } })).nightAuditStartDay).toBe(YB)
  })

  it('card matching on: card_unsettled_day; the deposit dropped the NEXT day is sales_bank_unmatched until the statement shows it', async () => {
    await prisma.operationsConfig.create({ data: { tenantId: B, scope: 'global', scopeId: null, cardSettlement: { enabled: true, payoutBankAccountId: bankB, startDay: YB } } })
    const s1 = await call('finB', 'POST', `/${YB}/settle`, B, {})
    expect(s1.statusCode).toBe(409)
    expect(s1.json().error.code).toBe('SETTLEMENT_NOT_READY')
    expect((s1.json().error.details.blocks as Problem[]).map((b) => b.key).sort()).toEqual(['card_unsettled_day', 'cash_not_banked'])

    const drop = await prisma.depositDrop.create({ data: { tenantId: B, shiftId, bankAccountId: bankB, amountCents: 5_000, expectedCents: 5_000, varianceCents: 0, droppedById: users.finB!.id } })
    expect((await postDepositDrop(drop.id)).posted).toBe(true)
    const je = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: B, reference: `deposit.drop:${drop.id}` }, include: { lines: { include: { account: true } } } })
    expect(fmtPktDate(je.entryDate)).toBe(today)
    dropEntryLineId = je.lines.find((l) => l.account.code === '1020')!.id
    // A supplier payment out of the same bank on that day, unmatched: not sales — never read.
    await postJournalEntry({ tenantId: B, sourceType: 'supplier.payment', sourceId: 'sp-1', description: 'Supplier paid', entryDate: at(YB), lines: [
      { accountCode: '2010', type: 'debit', amountCents: 7_777 }, { accountCode: '1020', type: 'credit', amountCents: 7_777 },
    ] })

    const s2 = await call('finB', 'POST', `/${YB}/settle`, B, {})
    expect(s2.statusCode).toBe(409)
    const blocks = s2.json().error.details.blocks as Problem[]
    expect(blocks.map((b) => b.key).sort()).toEqual(['card_unsettled_day', 'sales_bank_unmatched'])
    expect(blocks.find((b) => b.key === 'sales_bank_unmatched')?.count).toBe(1)
  })

  it('card payout matched + the deposit on the statement → closed automatically', async () => {
    const imp = await prisma.bankStatementImport.create({ data: { tenantId: B, bankAccountId: bankB, source: 'csv', accountCode: '1020', statementDate: new Date(), openingBalanceCents: 0, closingBalanceCents: 0 } })
    const payoutLine = await prisma.bankStatementLine.create({ data: { importId: imp.id, postedDate: new Date(), description: 'KEENU', amountCents: 19_500, matchStatus: 'matched' } })
    await prisma.bankStatementLine.create({ data: { importId: imp.id, postedDate: new Date(), description: 'CASH DEP', amountCents: 5_000, matchStatus: 'matched', matchedJournalLineId: dropEntryLineId } })
    const st = await prisma.cardSettlement.create({ data: {
      tenantId: B, unit: 'company', bankAccountId: bankB, statementLineId: payoutLine.id, grossCents: 20_000, feeCents: 500, feeTaxCents: 0, netCents: 19_500,
      dayFrom: YB, dayTo: YB, status: 'confirmed',
    } })
    await prisma.cardSettlementDay.create({ data: { tenantId: B, settlementId: st.id, unit: 'company', day: YB, grossCents: 20_000 } })
    const r = await refreshAuditedDays(B)
    expect(r.closed).toBe(1)
    const row = await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: B, businessDate: YB } } })
    expect(row.status).toBe('closed')
    expect(row.closedVia).toBe('auto')
    const closing = (row.report as { closing?: { card: { settledCents: number }; bank: { unmatchedLines: number } } }).closing
    expect(closing?.card.settledCents).toBe(20_000)
    expect(closing?.bank.unmatchedLines).toBe(0)
  })
})

describe('reopen (CEO only)', () => {
  it('finance → 403; a short reason → 422; the CEO reopens and the history is kept', async () => {
    expect((await call('finB', 'POST', `/${YB}/reopen`, B, { reason: 'Need to fix a bill' })).statusCode).toBe(403)
    expect((await call('adminB', 'POST', `/${YB}/reopen`, B, { reason: 'short' })).json().error.code).toBe('REASON_REQUIRED')
    const r = await call('adminB', 'POST', `/${YB}/reopen`, B, { reason: 'A Raast bill was missed' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('open')
    const actions = (r.json().history as Array<{ action: string }>).map((h) => h.action)
    expect(actions).toEqual(['run', 'settle_auto', 'reopen'])
    expect(await prisma.auditLog.count({ where: { tenantId: B, action: 'night_audit.reopen' } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: B, kind: 'night_audit_reopened' } })).toBe(1)
    // Re-run it: everything is settled, so it closes again.
    const again = await call('finB', 'POST', `/${YB}/run`, B, {})
    expect(again.json().status).toBe('closed')
    expect((again.json().report.previousRuns as unknown[]).length).toBe(1)
  })

  it('DAY_IN_CLOSED_PERIOD: a day inside a closed month is neither reopened nor run', async () => {
    await prisma.periodLock.create({ data: { tenantId: B, lockedThrough: parsePktEndOfDay(YB), lockedBy: users.adminB!.id } })
    expect((await call('adminB', 'POST', `/${YB}/reopen`, B, { reason: 'Need to fix a bill' })).json().error.code).toBe('DAY_IN_CLOSED_PERIOD')
    expect((await call('finB', 'POST', `/${dayAgo(2)}/run`, B, {})).json().error.code).toBe('DAY_IN_CLOSED_PERIOD')
    await prisma.periodLock.deleteMany({ where: { tenantId: B } })
  })
})
