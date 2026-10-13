// Card payouts at payout (H12, finance wave B) — reconciliation/cardPayouts.ts
// on top of BOOKS-11 (service.ts postCardPayoutSplitTx).
//
//   - exact fit: Dr payout bank net / Dr 6080 fee / Cr 1030 gross, balanced,
//     the line matched to the bank leg, the days claimed
//   - two fitting runs → nothing posted; suggestions list both; confirm posts
//   - a 3-day weekend batch; a re-import never double-posts
//   - a locked period → the line stays unmatched with its reason (import 201),
//     one card_payout_unmatched flag
//   - confirm refusals (fee above maxFeeBps, no card money, a settled day, …)
//   - undo frees the days; the line re-matches as '@2'
//   - unit 'brand' keys days per brand
//   - a manual BOOKS-11 split on the payout bank claims its days (and the
//     same day never auto-matches after) or answers 409 USE_CARD_PAYOUT_CONFIRM
//   - rematch; the close check; the bank-line unmatch of a payout is 409
//   - two companies: B never consumes A's days, B gets 404 on A's line /
//     settlement / suggestions, A's settings refuse B's bank (422)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, mkOrder, type Company, type Who } from './connectorsFixtures.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { adjustStatementLine, type AdjustmentLine } from '../src/modules/reconciliation/service.js'
import {
  cardPayoutCloseChecks, unsettledCardDaysThrough, cardSettlementSettings, dayNumOf, dayStr,
} from '../src/modules/reconciliation/cardPayouts.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { toCents } from '../src/lib/money.js'

const DAY = 86_400_000
const T = dayNumOf(new Date())
const d = (offset: number) => dayStr(T + offset)

let app: FastifyInstance

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

interface Scene {
  co: Company
  admin: Who
  finance: Who
  owner: Who
  bank: { id: string; code: string }
}

/** A bank account of the company on a fresh 102x chart code. */
async function mkBank(co: Company, code = '1021'): Promise<{ id: string; code: string }> {
  await prisma.account.upsert({
    where: { tenantId_code: { tenantId: co.tenantId, code } },
    update: { isActive: true },
    create: { tenantId: co.tenantId, code, name: `Bank — Payout ${code}`, type: 'asset' },
  })
  const b = await prisma.bankAccount.create({
    data: { tenantId: co.tenantId, name: `Payout ${code}`, bankName: 'HBL', accountNumber: `00${randomBytes(4).toString('hex').replace(/[^0-9]/g, '5').slice(0, 8)}`, accountCode: code, isActive: true },
  })
  return { id: b.id, code }
}

let n = 0
async function scene(enable = true, extra: Record<string, unknown> = {}): Promise<Scene> {
  const slug = `cp-${++n}-${randomBytes(2).toString('hex')}`
  const co = await mkCompany(slug)
  const admin = await mkUser(`${slug}-admin`, 'admin', co.tenantId)
  const finance = await mkUser(`${slug}-fin`, 'finance', co.tenantId)
  const owner = await mkUser(`${slug}-owner`, 'owner', co.tenantId)
  const bank = await mkBank(co)
  if (enable) {
    const r = await call(finance, 'PUT', '/reconciliation/card-payouts/settings', {
      enabled: true, payoutBankAccountId: bank.id, mdrBps: 200, feeTaxBps: 1600, startDay: d(-40), ...extra,
    })
    if (r.statusCode !== 200) throw new Error(`settings ${r.statusCode} ${r.body}`)
  }
  return { co, admin, finance, owner, bank }
}

/** Card money taken at noon PKT of day T+offset (negative cents = a card refund). */
async function cardSale(co: Company, cents: number, offset: number, conceptId?: string): Promise<string> {
  const orderId = await mkOrder({ ...co, conceptId: conceptId ?? co.conceptId }, {
    items: [{ menuItemId: null, name: 'Sandwich', quantity: 1, unitPriceCents: Math.abs(cents) }],
    taxCents: 0, taxRatePct: 8, totalCents: Math.abs(cents),
  })
  const at = new Date((T + offset) * DAY + 7 * 3_600_000)
  const p = await prisma.payment.create({
    data: { orderId, method: 'card', amountCents: cents, status: cents > 0 ? 'paid' : 'refunded', gateway: 'card_terminal', processedAt: at },
  })
  return p.id
}

async function importCsv(who: Who, bankAccountId: string, rows: Array<{ day: string; description: string; amount: string }>) {
  const csv = ['date,description,amount', ...rows.map((r) => `${r.day},"${r.description}","${r.amount}"`)].join('\n')
  return call(who, 'POST', '/reconciliation/bank/imports', {
    bankAccountId, statementDate: d(0), openingBalanceCents: 0, closingBalanceCents: 0,
    filename: 'statement.csv', fileUrl: 'https://files.test/statement.csv', csv,
  })
}

async function lineOf(importId: string, amountCents?: number) {
  const lines = await prisma.bankStatementLine.findMany({ where: { importId }, orderBy: { postedDate: 'asc' } })
  return amountCents === undefined ? lines[0]! : lines.find((l) => toCents(l.amountCents) === amountCents)!
}

async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } } })
  if (!je) return null
  const rows = je.lines.map((l) => ({ id: l.id, code: l.account.code, tenantId: l.account.tenantId, type: l.type, amount: toCents(l.amountCents), conceptId: l.conceptId }))
  const dr = rows.filter((r) => r.type === 'debit').reduce((s, r) => s + r.amount, 0)
  const cr = rows.filter((r) => r.type === 'credit').reduce((s, r) => s + r.amount, 0)
  return { id: je.id, tenantId: je.tenantId, entryDate: je.entryDate, rows, dr, cr }
}

const PKR = (cents: number) => (cents / 100).toFixed(2)
/** Keenu's payout for `gross` at 2% MDR + 16% tax on it. */
const netOf = (gross: number) => gross - Math.round((gross * 200 * 11_600) / 100_000_000)

beforeAll(async () => {
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('settings', () => {
  it('GET shows defaults; PUT is admin / finance only, validated, audited, binds the ACTIVE company; startDay = today on first enable', async () => {
    const s = await scene(false)
    const g = await call(s.finance, 'GET', '/reconciliation/card-payouts/settings')
    expect(g.statusCode, g.body).toBe(200)
    expect(g.json()).toMatchObject({ settings: { enabled: false, lagDays: 2, toleranceBps: 30, maxBatchDays: 3, maxFeeBps: 500, unitMode: 'company' }, canEdit: true })
    expect((await call(s.owner, 'GET', '/reconciliation/card-payouts/settings')).json().canEdit).toBe(false)
    expect((await call(s.owner, 'PUT', '/reconciliation/card-payouts/settings', { mdrBps: 200 })).statusCode).toBe(403)

    const noBank = await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { enabled: true })
    expect(noBank.statusCode).toBe(422)
    expect(noBank.json().error.code).toBe('PAYOUT_BANK_REQUIRED')
    expect((await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { mdrBps: 5000 })).statusCode).toBe(400)
    expect((await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { lagDays: 9 })).statusCode).toBe(400)
    expect((await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { bogus: 1 })).statusCode).toBe(400)
    // A cash / card-clearing code is never a payout bank.
    const cardCode = await prisma.bankAccount.create({ data: { tenantId: s.co.tenantId, name: 'Not a bank', accountCode: '1030', isActive: true } })
    const nb = await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { payoutBankAccountId: cardCode.id })
    expect(nb.json().error.code).toBe('BANK_ACCOUNT_NOT_A_BANK')

    const ok = await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { enabled: true, payoutBankAccountId: s.bank.id, mdrBps: 200, feeTaxBps: 1600 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().settings).toMatchObject({ enabled: true, payoutBankAccountId: s.bank.id, startDay: d(0) })
    expect(await prisma.auditLog.count({ where: { action: 'card_payouts.settings', tenantId: s.co.tenantId } })).toBe(1)
    // A later save keeps the startDay.
    const again = await call(s.admin, 'PUT', '/reconciliation/card-payouts/settings', { toleranceBps: 50 })
    expect(again.json().settings).toMatchObject({ startDay: d(0), toleranceBps: 50 })
    expect((await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { startDay: d(3) })).json().error.code).toBe('START_DAY_IN_FUTURE')
  })

  it('switching matching off and on again starts afresh today (days of the off spell were cleared by hand)', async () => {
    const s = await scene()
    expect((await cardSettlementSettings(prisma, s.co.tenantId)).startDay).toBe(d(-40))
    expect((await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { enabled: false })).statusCode).toBe(200)
    const on = await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { enabled: true })
    expect(on.json().settings).toMatchObject({ enabled: true, startDay: d(0) })
  })
})

describe('BOOKS-11: a split onto a fixed-asset register account', () => {
  it('needs registerOverride (≥ 10 characters); with it the entry posts, is audited and flagged fixed_asset_gl_mismatch', async () => {
    const s = await scene(false)
    const imp = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'OVEN SUPPLIER', amount: '-2500.00' }])
    const line = await lineOf(imp.json().importId)
    await expect(adjustStatementLine({ lineId: line.id, memo: 'oven', postedById: s.admin.id, contraAccountCode: '1510' }))
      .rejects.toMatchObject({ code: 'REGISTER_CONTROLLED_ACCOUNT' })
    await expect(adjustStatementLine({ lineId: line.id, memo: 'oven', postedById: s.admin.id, contraAccountCode: '1510', registerOverride: { reason: 'short' } }))
      .rejects.toMatchObject({ code: 'REGISTER_CONTROLLED_ACCOUNT' })
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).matchStatus).toBe('unmatched')
    await adjustStatementLine({ lineId: line.id, memo: 'oven', postedById: s.admin.id, contraAccountCode: '1510', registerOverride: { reason: 'Oven deposit paid before the CapEx project existed' } })
    const je = await entry(s.co.tenantId, `reconciliation.adjustment:${line.id}`)
    expect(je!.rows.map((r) => [r.code, r.type, r.amount]).sort()).toEqual([['1021', 'credit', 250_000], ['1510', 'debit', 250_000]].sort())
    expect(await prisma.auditLog.count({ where: { action: 'reconciliation.adjustment.register_override', entityId: line.id, tenantId: s.co.tenantId } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: s.co.tenantId, kind: 'fixed_asset_gl_mismatch', entityId: line.id } })).toBe(1)
  })
})

describe('the import pass', () => {
  it('an exact fit books Dr bank net / Dr 6080 fee / Cr 1030 gross, matches the line to the bank leg and claims the day', async () => {
    const s = await scene()
    await cardSale(s.co, 6_000_000, -2)
    await cardSale(s.co, 4_000_000, -2)
    const net = netOf(10_000_000) // 9,768,000
    const res = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU SETTLEMENT', amount: PKR(net) }])
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ cardPayoutMatchedCount: 1, matchedCount: 1, unmatchedCount: 0 })
    const line = await lineOf(res.json().importId)
    expect(line.matchStatus).toBe('matched')

    const je = await entry(s.co.tenantId, `card.settlement:${line.id}`)
    expect(je).not.toBeNull()
    expect(je!.dr).toBe(je!.cr)
    expect(je!.rows.map((r) => [r.code, r.type, r.amount]).sort()).toEqual([
      ['1021', 'debit', net], ['6080', 'debit', 232_000], ['1030', 'credit', 10_000_000],
    ].sort())
    expect(je!.rows.every((r) => r.tenantId === s.co.tenantId)).toBe(true)
    expect(dayNumOf(je!.entryDate)).toBe(T)
    expect(line.matchedJournalLineId).toBe(je!.rows.find((r) => r.code === '1021')!.id)

    const st = await prisma.cardSettlement.findFirstOrThrow({ where: { statementLineId: line.id }, include: { days: true } })
    expect(st).toMatchObject({ tenantId: s.co.tenantId, unit: 'company', status: 'auto', dayFrom: d(-2), dayTo: d(-2), journalEntryId: je!.id, bankAccountId: s.bank.id })
    expect(toCents(st.grossCents)).toBe(10_000_000)
    expect(toCents(st.feeCents)).toBe(232_000)
    expect(toCents(st.feeTaxCents)).toBe(32_000) // 16% inside the 232,000 fee
    expect(st.days.map((x) => [x.day, toCents(x.grossCents)])).toEqual([[d(-2), 10_000_000]])

    // A re-import of the same statement never books the day twice.
    const again = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU SETTLEMENT', amount: PKR(net) }])
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ cardPayoutMatchedCount: 0, matchedCount: 0 })
    const dup = await lineOf(again.json().importId)
    expect(dup.matchStatus).toBe('unmatched')
    expect(await prisma.journalEntry.count({ where: { tenantId: s.co.tenantId, reference: { startsWith: 'card.settlement:' } } })).toBe(1)

    // The generic unmatch is refused — a payout is undone on the Card payouts tab.
    const un = await call(s.admin, 'POST', `/reconciliation/bank/lines/${line.id}/unmatch`, { reason: 'try' })
    expect(un.statusCode).toBe(409)
    expect(un.json().error.code).toBe('CARD_PAYOUT_LINE')

    // Undo (approvers): reversed today, the day freed, the line unmatched — then it re-matches as '@2'.
    expect((await call(s.finance, 'POST', `/reconciliation/card-payouts/${st.id}/undo`, { reason: 'wrong bank' })).statusCode).toBe(403)
    const undo = await call(s.admin, 'POST', `/reconciliation/card-payouts/${st.id}/undo`, { reason: 'wrong day picked' })
    expect(undo.statusCode, undo.body).toBe(200)
    expect(undo.json().days).toEqual([d(-2)])
    const rev = await entry(s.co.tenantId, `card.settlement.reversal:${line.id}`)
    expect(rev).not.toBeNull()
    expect(rev!.rows.map((r) => [r.code, r.type, r.amount]).sort()).toEqual([
      ['1021', 'credit', net], ['6080', 'credit', 232_000], ['1030', 'debit', 10_000_000],
    ].sort())
    expect(await prisma.cardSettlementDay.count({ where: { tenantId: s.co.tenantId } })).toBe(0)
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).matchStatus).toBe('unmatched')
    expect(await prisma.auditLog.count({ where: { action: 'card_payouts.undo', tenantId: s.co.tenantId } })).toBe(1)

    // Two unmatched lines now fit the same day → re-run matches neither (never a guess)…
    const rm = await call(s.finance, 'POST', '/reconciliation/card-payouts/rematch', {})
    expect(rm.statusCode, rm.body).toBe(200)
    expect(rm.json()).toMatchObject({ matched: 0, candidates: 2 })
    // …ignore the duplicate, and the original re-matches as '@2'.
    expect((await call(s.finance, 'POST', `/reconciliation/bank/lines/${dup.id}/ignore`, {})).statusCode).toBe(200)
    const rm2 = await call(s.finance, 'POST', '/reconciliation/card-payouts/rematch', {})
    expect(rm2.json()).toMatchObject({ matched: 1 })
    expect(await entry(s.co.tenantId, `card.settlement:${line.id}@2`)).not.toBeNull()
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).matchStatus).toBe('matched')
  })

  it('two runs that fit → nothing posted; the suggestions list both; finance confirms one', async () => {
    const s = await scene()
    await cardSale(s.co, 10_000_000, -2)
    await cardSale(s.co, 10_000_000, -3)
    const net = netOf(10_000_000)
    const res = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU SETTLEMENT', amount: PKR(net) }])
    expect(res.json()).toMatchObject({ cardPayoutMatchedCount: 0 })
    const line = await lineOf(res.json().importId)
    expect(line.matchStatus).toBe('unmatched')
    expect(await prisma.journalEntry.count({ where: { tenantId: s.co.tenantId } })).toBe(0)

    const sug = await call(s.finance, 'GET', `/reconciliation/card-payouts/lines/${line.id}/suggestions`)
    expect(sug.statusCode, sug.body).toBe(200)
    const fits = sug.json().suggestions.filter((x: { fits: boolean }) => x.fits)
    expect(fits.map((x: { dayFrom: string; dayTo: string }) => [x.dayFrom, x.dayTo]).sort()).toEqual([[d(-3), d(-3)], [d(-2), d(-2)]])
    expect(fits[0]).toMatchObject({ grossCents: 10_000_000, impliedFeeCents: 232_000, impliedFeeBps: 232, expectedNetCents: net })

    expect((await call(s.owner, 'GET', `/reconciliation/card-payouts/lines/${line.id}/suggestions`)).statusCode).toBe(200)
    const ok = await call(s.finance, 'POST', `/reconciliation/card-payouts/lines/${line.id}/confirm`, { days: [d(-2)] })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json()).toMatchObject({ status: 'confirmed', dayFrom: d(-2), dayTo: d(-2), grossCents: 10_000_000, feeCents: 232_000, netCents: net })
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).matchStatus).toBe('matched')
    expect(await prisma.auditLog.count({ where: { action: 'card_payouts.confirm', tenantId: s.co.tenantId } })).toBe(1)
    // The other day is still waiting for its own payout.
    const list = await call(s.finance, 'GET', '/reconciliation/card-payouts')
    expect(list.statusCode, list.body).toBe(200)
    const mine = list.json().companies.find((c: { tenantId: string }) => c.tenantId === s.co.tenantId)
    expect(mine.unsettled.map((x: { day: string }) => x.day)).toEqual([d(-3)])
    expect(list.json().settlements.map((x: { id: string }) => x.id)).toEqual([ok.json().id])
    expect(list.json()).toMatchObject({ canConfirm: true, canUndo: false })
    // Confirming again: the line is matched (409).
    const twice = await call(s.finance, 'POST', `/reconciliation/card-payouts/lines/${line.id}/confirm`, { days: [d(-3)] })
    expect(twice.statusCode).toBe(409)
    expect(twice.json().error.code).toBe('LINE_NOT_UNMATCHED')
  })

  it('a 3-day weekend batch fits as one payout', async () => {
    const s = await scene()
    await cardSale(s.co, 3_000_000, -3)
    await cardSale(s.co, 4_000_000, -2)
    await cardSale(s.co, 5_000_000, -1)
    const net = netOf(12_000_000) // 11,721,600
    const res = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU WEEKEND', amount: PKR(net) }])
    expect(res.json().cardPayoutMatchedCount).toBe(1)
    const line = await lineOf(res.json().importId)
    const st = await prisma.cardSettlement.findFirstOrThrow({ where: { statementLineId: line.id }, include: { days: { orderBy: { day: 'asc' } } } })
    expect(st).toMatchObject({ dayFrom: d(-3), dayTo: d(-1) })
    expect(st.days.map((x) => x.day)).toEqual([d(-3), d(-2), d(-1)])
    const je = await entry(s.co.tenantId, `card.settlement:${line.id}`)
    expect(je!.rows.find((r) => r.code === '1030')!.amount).toBe(12_000_000)
    expect(je!.rows.find((r) => r.code === '6080')!.amount).toBe(278_400)
  })

  it('card refunds of the day net off; a payout dated in a closed period stays unmatched with the reason (import 201), one flag', async () => {
    const s = await scene()
    await cardSale(s.co, 11_000_000, -4)
    await cardSale(s.co, -1_000_000, -4) // a card refund that day
    await prisma.periodLock.create({ data: { tenantId: s.co.tenantId, lockedThrough: parsePktEndOfDay(d(-1)), lockedBy: s.admin.id } })
    const net = netOf(10_000_000)
    const res = await importCsv(s.finance, s.bank.id, [{ day: d(-2), description: 'KEENU SETTLEMENT', amount: PKR(net) }])
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json()).toMatchObject({ cardPayoutMatchedCount: 0, unmatchedCount: 1 })
    const line = await lineOf(res.json().importId)
    expect(line.matchStatus).toBe('unmatched')
    expect(line.notes).toContain('PERIOD_LOCKED')
    expect(await prisma.cardSettlement.count({ where: { tenantId: s.co.tenantId } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: s.co.tenantId } })).toBe(0)
    const flags = () => prisma.exceptionFlag.findMany({ where: { tenantId: s.co.tenantId, kind: 'card_payout_unmatched', status: { in: ['open', 'acknowledged'] } } })
    expect(await flags()).toHaveLength(1)
    expect((await flags())[0]).toMatchObject({ entityType: 'BankStatementLine', entityId: line.id })
    // Re-running is refused the same way — still ONE flag.
    expect((await call(s.finance, 'POST', '/reconciliation/card-payouts/rematch', {})).json()).toMatchObject({ matched: 0 })
    expect(await flags()).toHaveLength(1)
    // Confirming by hand is the same refusal, as a 422.
    const c = await call(s.finance, 'POST', `/reconciliation/card-payouts/lines/${line.id}/confirm`, { days: [d(-4)] })
    expect(c.statusCode).toBe(422)
    expect(c.json().error.code).toBe('PERIOD_LOCKED')
    // The books reopen (the lock is removed): re-run books it and resolves the flag.
    await prisma.periodLock.deleteMany({ where: { tenantId: s.co.tenantId } })
    expect((await call(s.finance, 'POST', '/reconciliation/card-payouts/rematch', {})).json()).toMatchObject({ matched: 1 })
    expect(await flags()).toHaveLength(0)
  })
})

describe('confirm refusals and the period close', () => {
  it('fee above maxFeeBps, no card money, a day already settled, a day after the payout, matching off', async () => {
    const s = await scene()
    await cardSale(s.co, 10_000_000, -2)
    await cardSale(s.co, 2_000_000, -6)
    const imp = await importCsv(s.finance, s.bank.id, [
      { day: d(0), description: 'KEENU A', amount: PKR(9_000_000) },  // a 10% fee on day -2 → out of range
      { day: d(0), description: 'KEENU B', amount: PKR(netOf(2_000_000)) },
    ])
    expect(imp.json().cardPayoutMatchedCount).toBe(0) // day -6 is outside the lag window
    const a = await lineOf(imp.json().importId, 9_000_000)
    const b = await lineOf(imp.json().importId, netOf(2_000_000))
    const url = (id: string) => `/reconciliation/card-payouts/lines/${id}/confirm`
    const fee = await call(s.finance, 'POST', url(a.id), { days: [d(-2)] })
    expect(fee.statusCode).toBe(422)
    expect(fee.json().error.code).toBe('FEE_OUT_OF_RANGE')
    const none = await call(s.finance, 'POST', url(a.id), { days: [d(-5)] })
    expect(none.json().error.code).toBe('NO_CARD_MONEY_ON_DAYS')
    const gap = await call(s.finance, 'POST', url(a.id), { days: [d(-6), d(-2)] })
    expect(gap.json().error.code).toBe('CARD_DAYS_INVALID')
    const after = await call(s.finance, 'POST', url(a.id), { days: [d(0)] })
    expect(after.json().error.code).toBe('DAYS_NOT_BEFORE_PAYOUT')
    const before = await call(s.finance, 'POST', url(a.id), { days: [d(-41)] })
    expect(before.json().error.code).toBe('DAY_BEFORE_START')
    expect((await call(s.owner, 'POST', url(b.id), { days: [d(-6)] })).statusCode).toBe(201)
    const taken = await call(s.finance, 'POST', url(a.id), { days: [d(-6)] })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error.code).toBe('DAY_ALREADY_SETTLED')
    // Brand unit while the company is paid as one.
    expect((await call(s.finance, 'POST', url(a.id), { days: [d(-2)], unit: `brand:${s.co.conceptId}` })).json().error.code).toBe('CARD_UNIT_INVALID')

    const off = await scene(false)
    const offImp = await importCsv(off.finance, off.bank.id, [{ day: d(0), description: 'KEENU', amount: PKR(1_000) }])
    const offLine = await lineOf(offImp.json().importId)
    const o = await call(off.finance, 'POST', url(offLine.id), { days: [d(-1)] })
    expect(o.statusCode).toBe(422)
    expect(o.json().error.code).toBe('CARD_PAYOUTS_OFF')
    expect((await call(off.finance, 'POST', '/reconciliation/card-payouts/rematch', {})).json().error.code).toBe('CARD_PAYOUTS_OFF')
  })

  it("the close check 'card_unsettled' blocks (overridable) days older than lockedThrough − (lagDays + 3); nothing when off", async () => {
    const s = await scene()
    await cardSale(s.co, 1_500_000, -20)
    await cardSale(s.co, 2_500_000, -3) // too recent for a close through yesterday
    const lockedThrough = parsePktEndOfDay(d(-1))
    const r = await unsettledCardDaysThrough(prisma, s.co.tenantId, lockedThrough)
    expect(r).toEqual({ count: 1, cents: 1_500_000, days: [d(-20)] })
    const [check] = cardPayoutCloseChecks
    expect(check).toMatchObject({ key: 'card_unsettled', severity: 'block', overridable: true })
    const ctx = { db: prisma, tenantId: s.co.tenantId, prevLock: null, newLock: lockedThrough, months: [], isYearEnd: false }
    const problem = await check!.run(ctx)
    expect(problem).toMatchObject({ key: 'card_unsettled', count: 1, cents: 1_500_000, link: '/reconciliation?tab=card-payouts', overridable: true })
    // Another company's close never sees these days.
    const other = await scene()
    expect(await check!.run({ ...ctx, tenantId: other.co.tenantId })).toBeNull()
    const off = await scene(false)
    await cardSale(off.co, 1_000_000, -20)
    expect(await unsettledCardDaysThrough(prisma, off.co.tenantId, lockedThrough)).toEqual({ count: 0, cents: 0, days: [] })
  })
})

describe('units per brand', () => {
  it("unitMode 'brand' keys days per brand: each brand's payout matches its own day, the lines carry the brand", async () => {
    const s = await scene(true, { unitMode: 'brand' })
    const brand2 = (await prisma.concept.create({
      data: { name: 'Brand two', slug: `b2-${randomBytes(3).toString('hex')}`, type: 'restaurant', tenantId: s.co.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8 },
    })).id
    await cardSale(s.co, 10_000_000, -2)
    await cardSale(s.co, 5_000_000, -2, brand2)
    const n1 = netOf(10_000_000)
    const n2 = netOf(5_000_000)
    const res = await importCsv(s.finance, s.bank.id, [
      { day: d(0), description: 'KEENU MID 1', amount: PKR(n1) },
      { day: d(0), description: 'KEENU MID 2', amount: PKR(n2) },
    ])
    expect(res.json().cardPayoutMatchedCount).toBe(2)
    const days = await prisma.cardSettlementDay.findMany({ where: { tenantId: s.co.tenantId }, orderBy: { grossCents: 'desc' } })
    expect(days.map((x) => [x.unit, x.day, toCents(x.grossCents)])).toEqual([
      [`brand:${s.co.conceptId}`, d(-2), 10_000_000], [`brand:${brand2}`, d(-2), 5_000_000],
    ])
    const l1 = await lineOf(res.json().importId, n1)
    const je = await entry(s.co.tenantId, `card.settlement:${l1.id}`)
    expect(je!.rows.find((r) => r.code === '1030')!.conceptId).toBe(s.co.conceptId)
    expect(je!.rows.find((r) => r.code === '6080')!.conceptId).toBe(s.co.conceptId)
    expect(je!.rows.find((r) => r.code === '1021')!.conceptId).toBeNull()
    // Confirm names the brand; another family's unit is refused.
    expect((await call(s.finance, 'POST', `/reconciliation/card-payouts/lines/${l1.id}/confirm`, { days: [d(-2)] })).json().error.code).toBe('LINE_NOT_UNMATCHED')
    const s2 = await cardSettlementSettings(prisma, s.co.tenantId)
    expect(s2.unitMode).toBe('brand')
  })
})

describe('BOOKS-11: the manual split on the payout bank', () => {
  it('without card days → 409 USE_CARD_PAYOUT_CONFIRM; with them the days are claimed (manual_adjust) and never auto-match again', async () => {
    const s = await scene()
    await cardSale(s.co, 10_000_000, -2)
    // A payout 3% short of the gross — outside the tolerance, so no automatic fit.
    const imp = await importCsv(s.finance, s.bank.id, [
      { day: d(0), description: 'KEENU SETTLEMENT', amount: PKR(9_700_000) },
      { day: d(0), description: 'Bank charges', amount: '-150.00' },
    ])
    expect(imp.json().cardPayoutMatchedCount).toBe(0)
    const line = await lineOf(imp.json().importId, 9_700_000)
    const charges = await lineOf(imp.json().importId, -15_000)
    const splitLines: AdjustmentLine[] = [{ accountCode: '1030', type: 'credit', amountCents: 10_000_000 }, { accountCode: '6080', type: 'debit', amountCents: 300_000 }]
    const split = { memo: 'Keenu settlement', lines: splitLines }
    const refused = await call(s.admin, 'POST', `/reconciliation/bank/lines/${line.id}/adjust`, split)
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('USE_CARD_PAYOUT_CONFIRM')
    // A single contra to 1030 is refused too.
    expect((await call(s.admin, 'POST', `/reconciliation/bank/lines/${line.id}/adjust`, { memo: 'x', contraAccountCode: '1030' })).json().error.code).toBe('USE_CARD_PAYOUT_CONFIRM')
    expect(await prisma.journalEntry.count({ where: { tenantId: s.co.tenantId } })).toBe(0)
    // Money OUT of the payout bank (bank charges) is not a payout — booked as before.
    expect((await call(s.admin, 'POST', `/reconciliation/bank/lines/${charges.id}/adjust`, { memo: 'HBL charges', contraAccountCode: '6080' })).statusCode).toBe(200)

    // The split naming its card day (service — the route passes cardDays once routes.ts forwards them).
    const done = await adjustStatementLine({ lineId: line.id, memo: 'Keenu settlement, MDR disputed', postedById: s.admin.id, lines: splitLines, cardDays: [d(-2)] })
    expect(done.cardSettlementId).toBeTruthy()
    const st = await prisma.cardSettlement.findUniqueOrThrow({ where: { id: done.cardSettlementId! }, include: { days: true } })
    expect(st).toMatchObject({ status: 'manual_adjust', statementLineId: line.id, dayFrom: d(-2), dayTo: d(-2) })
    expect(toCents(st.grossCents)).toBe(10_000_000)
    expect(toCents(st.feeCents)).toBe(300_000)
    const je = await entry(s.co.tenantId, `reconciliation.adjustment:${line.id}`)
    expect(st.journalEntryId).toBe(je!.id)
    expect(je!.rows.map((r) => [r.code, r.type, r.amount]).sort()).toEqual([['1021', 'debit', 9_700_000], ['1030', 'credit', 10_000_000], ['6080', 'debit', 300_000]].sort())
    expect((await prisma.bankStatementLine.findUniqueOrThrow({ where: { id: line.id } })).matchStatus).toBe('adjusted')

    // The same day never auto-matches afterwards.
    const later = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU AGAIN', amount: PKR(netOf(10_000_000)) }])
    expect(later.json().cardPayoutMatchedCount).toBe(0)
    // …nor can it be claimed by hand a second time.
    const laterLine = await lineOf(later.json().importId)
    await expect(adjustStatementLine({ lineId: laterLine.id, memo: 'x', postedById: s.admin.id, contraAccountCode: '1030', cardDays: [d(-2)] }))
      .rejects.toMatchObject({ code: 'DAY_ALREADY_SETTLED' })
    // startDay may not move back over a manual split.
    const back = await call(s.finance, 'PUT', '/reconciliation/card-payouts/settings', { startDay: d(-10) })
    expect(back.statusCode).toBe(422)
    expect(back.json().error.code).toBe('START_DAY_BEFORE_MANUAL_SPLIT')

    // Undo of the manual claim: reversed, days freed; the next adjustment is '@2'.
    const u = await call(s.admin, 'POST', `/reconciliation/card-payouts/${st.id}/undo`, { reason: 'wrong day' })
    expect(u.statusCode, u.body).toBe(200)
    expect(await entry(s.co.tenantId, `reconciliation.adjustment.reversal:${line.id}`)).not.toBeNull()
    await adjustStatementLine({ lineId: line.id, memo: 'Keenu settlement again', postedById: s.admin.id, lines: splitLines, cardDays: [d(-2)] })
    expect(await entry(s.co.tenantId, `reconciliation.adjustment:${line.id}@2`)).not.toBeNull()
  })

  it('matching off: the BOOKS-11 card split books exactly as before (no claim)', async () => {
    const s = await scene(false)
    const imp = await importCsv(s.finance, s.bank.id, [{ day: d(0), description: 'KEENU', amount: PKR(453_740) }])
    const line = await lineOf(imp.json().importId)
    const r = await call(s.admin, 'POST', `/reconciliation/bank/lines/${line.id}/adjust`, {
      memo: 'Keenu', lines: [{ accountCode: '1030', type: 'credit', amountCents: 463_000, memo: 'card sales' }, { accountCode: '6080', type: 'debit', amountCents: 9_260, memo: 'MDR 2%' }],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(await prisma.cardSettlement.count({ where: { tenantId: s.co.tenantId } })).toBe(0)
    const je = await entry(s.co.tenantId, `reconciliation.adjustment:${line.id}`)
    expect(je!.rows.map((x) => [x.code, x.type, x.amount]).sort()).toEqual([['1021', 'debit', 453_740], ['1030', 'credit', 463_000], ['6080', 'debit', 9_260]].sort())
  })
})

describe('two companies', () => {
  it("B's import never consumes A's card days; B gets 404 on A's line, suggestions and settlement; A refuses B's bank (422)", async () => {
    const A = await scene()
    const B = await scene()
    await cardSale(A.co, 10_000_000, -2)
    const net = netOf(10_000_000)
    const bImp = await importCsv(B.finance, B.bank.id, [{ day: d(0), description: 'KEENU', amount: PKR(net) }])
    expect(bImp.statusCode, bImp.body).toBe(201)
    expect(bImp.json().cardPayoutMatchedCount).toBe(0)
    expect(await prisma.cardSettlementDay.count({ where: { day: d(-2), tenantId: { in: [A.co.tenantId, B.co.tenantId] } } })).toBe(0)
    expect((await lineOf(bImp.json().importId)).matchStatus).toBe('unmatched')

    const aImp = await importCsv(A.finance, A.bank.id, [{ day: d(0), description: 'KEENU', amount: PKR(net) }])
    expect(aImp.json().cardPayoutMatchedCount).toBe(1)
    const aLine = await lineOf(aImp.json().importId)
    const st = await prisma.cardSettlement.findFirstOrThrow({ where: { statementLineId: aLine.id } })
    expect(st.tenantId).toBe(A.co.tenantId)

    expect((await call(B.finance, 'GET', `/reconciliation/card-payouts/lines/${aLine.id}/suggestions`)).statusCode).toBe(404)
    expect((await call(B.finance, 'POST', `/reconciliation/card-payouts/lines/${aLine.id}/confirm`, { days: [d(-2)] })).statusCode).toBe(404)
    expect((await call(B.admin, 'POST', `/reconciliation/card-payouts/${st.id}/undo`, { reason: 'not mine' })).statusCode).toBe(404)
    const bList = await call(B.finance, 'GET', '/reconciliation/card-payouts')
    expect(bList.statusCode).toBe(200)
    expect(bList.json().settlements.find((x: { id: string }) => x.id === st.id)).toBeUndefined()
    expect(bList.json().companies.map((c: { tenantId: string }) => c.tenantId)).toEqual([B.co.tenantId])

    const foreign = await call(A.finance, 'PUT', '/reconciliation/card-payouts/settings', { payoutBankAccountId: B.bank.id })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await cardSettlementSettings(prisma, A.co.tenantId)).payoutBankAccountId).toBe(A.bank.id)
    // B's settings stayed B's.
    expect((await call(B.finance, 'GET', '/reconciliation/card-payouts/settings')).json().settings.payoutBankAccountId).toBe(B.bank.id)
  })
})
