// Simulated-shift audit (2026-10-10), the books and settings findings:
//
//   BOOKS-03  manual journal entries can be posted from the admin and REVERSED
//             (POST /accounting/journal/:id/reverse): CEO only, the entry's
//             own company, foreign entries 404, manual entries only, once.
//   BOOKS-07  the books cannot be closed through a date after today (PKT).
//   BOOKS-09  the cash flow nets transfers between the company's own cash
//             accounts (safe drops, pay-ins, deposits) out of inflow/outflow.
//   BOOKS-13  the "All companies" trial balance labels every row with its
//             company, and each company's books balance on their own.
//   BOOKS-14  account 4002 is "Revenue — Stackd"; the data migration renames
//             only charts still on the old default.
//   BOOKS-02  finance can open (and maintain) Bank accounts.
//   PPL-09    only the CEO / co-owner change the company's operations rules
//             (clock-in selfie / geofence, tip split), and every change is
//             audited.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts, CHART_OF_ACCOUNTS, REQUIRED_ACCOUNT_CODES } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { cashFlow, splitEntryCash, trialBalance } from '../src/modules/accounting/reports.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.auditacct@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
const call = (who: string, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method, url, payload: payload as never,
    headers: { authorization: `Bearer ${users[who]!.token}`, ...headers },
  })

async function acct(tenantId: string, code: string): Promise<string> {
  return (await prisma.account.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } })).id
}

async function postManual(who: string, lines: Array<{ code: string; type: 'debit' | 'credit'; amountCents: number }>, opts: { tenantId?: string; description?: string; entryDate?: string } = {}) {
  const tenantId = opts.tenantId ?? tenantA
  const payload = {
    description: opts.description ?? 'Opening bank balance',
    ...(opts.entryDate && { entryDate: opts.entryDate }),
    lines: await Promise.all(lines.map(async (l) => ({ accountId: await acct(tenantId, l.code), type: l.type, amountCents: l.amountCents }))),
  }
  return call(who, 'POST', '/accounting/journal', payload, { 'x-servd-active-tenant': tenantId })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Audit Foods', slug: 'audit-foods-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Audit Viva', slug: 'audit-viva-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Audit Cafe', slug: 'audit-cafe-a', type: 'restaurant', tenantId: tenantA } })).id

  await mkUser('ceo', 'admin', tenantA, [tenantA, tenantB])     // the CEO, in both companies
  await mkUser('adminB', 'admin', tenantB, [tenantB])           // company B only
  await mkUser('fin', 'finance', tenantA, [tenantA])
  await mkUser('finB', 'finance', tenantB, [tenantB])
  await mkUser('owner', 'owner', tenantA, [tenantA])
  await mkUser('foh', 'foh_management', tenantA, [tenantA])
  await mkUser('mgmt', 'management', tenantA, [tenantA])
  await mkUser('hr', 'hr', tenantA, [tenantA])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ─── BOOKS-03 ────────────────────────────────────────────────────────────────

describe('BOOKS-03 — manual journal entries can be reversed', () => {
  it('the CEO reverses a manual entry: every line flipped, in the entry\'s company, on the trail', async () => {
    const posted = await postManual('ceo', [
      { code: '1020', type: 'debit', amountCents: 5_000_000 },
      { code: '3010', type: 'credit', amountCents: 5_000_000 },
    ])
    expect(posted.statusCode).toBe(201)
    const entry = posted.json() as { id: string; reference: string }

    const rev = await call('ceo', 'POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'Posted to the wrong bank' })
    expect(rev.statusCode).toBe(201)
    const reversal = rev.json() as { id: string; tenantId: string; reference: string; postedBy: string; lines: Array<{ account: { code: string }; type: string; amountCents: number }> }
    expect(reversal.tenantId).toBe(tenantA)
    expect(reversal.reference).toBe(entry.reference.replace(/^manual:/, 'manual.reversal:'))
    expect(reversal.postedBy).toBe(users.ceo!.id)
    const flipped = reversal.lines.map((l) => `${l.account.code}:${l.type}:${l.amountCents}`).sort()
    expect(flipped).toEqual(['1020:credit:5000000', '3010:debit:5000000'])

    // The two entries cancel: both accounts are back at zero — so the trial balance (net balances, zero rows
    // hidden — owner, 2026-10-16) does not list them.
    const tb = await trialBalance([tenantA], new Date(Date.now() + 60_000))
    for (const code of ['1020', '3010']) {
      expect(tb.rows.find((r) => r.code === code)).toBeUndefined()
    }

    const trail = await prisma.auditLog.findFirst({ where: { action: 'journal.reverse', entityId: reversal.id } })
    expect(trail?.category).toBe('accounting')
    expect(trail?.tenantId).toBe(tenantA)
    expect((trail?.metadata as { reason: string }).reason).toBe('Posted to the wrong bank')
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'manual_journal', entityId: reversal.id } })
    expect(flag?.tenantId).toBe(tenantA)

    // The ledger shows the original as reversed, and source=manual lists both.
    const ledger = await call('ceo', 'GET', `/accounting/ledger?source=manual&dateFrom=${fmtPktDate(new Date())}&dateTo=${fmtPktDate(new Date())}`)
    expect(ledger.statusCode).toBe(200)
    const rows = ledger.json().data as Array<{ id: string; reference: string; reversedBy: { id: string } | null }>
    expect(rows.find((r) => r.id === entry.id)?.reversedBy?.id).toBe(reversal.id)
    expect(rows.some((r) => r.id === reversal.id)).toBe(true)
    expect(rows.every((r) => r.reference.startsWith('manual'))).toBe(true)
  })

  it('reversing twice is refused, and two simultaneous clicks post one reversal', async () => {
    const posted = await postManual('ceo', [
      { code: '6010', type: 'debit', amountCents: 25_000_00 },
      { code: '2090', type: 'credit', amountCents: 25_000_00 },
    ], { description: 'October rent accrual' })
    const id = (posted.json() as { id: string; reference: string }).id
    const ref = (posted.json() as { reference: string }).reference

    const [a, b] = await Promise.all([
      call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Accrual reversed' }),
      call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Accrual reversed' }),
    ])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
    const again = await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Accrual reversed again' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_REVERSED')
    expect(await prisma.journalEntry.count({ where: { reference: ref.replace(/^manual:/, 'manual.reversal:') } })).toBe(1)
  })

  it('company B gets 404 on company A\'s entry; nothing is posted', async () => {
    const posted = await postManual('ceo', [
      { code: '1010', type: 'debit', amountCents: 1_000 },
      { code: '3010', type: 'credit', amountCents: 1_000 },
    ])
    const id = (posted.json() as { id: string }).id
    const res = await call('adminB', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Not mine to reverse' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'manual.reversal:' }, tenantId: tenantB } })).toBe(0)
    // And B's ledger never shows it.
    const ledger = await call('adminB', 'GET', `/accounting/ledger?id=${id}`)
    expect(ledger.json().data).toEqual([])
    // An id that does not exist is the same 404.
    expect((await call('ceo', 'POST', '/accounting/journal/00000000-0000-0000-0000-000000000000/reverse', { reason: 'No such entry' })).statusCode).toBe(404)
  })

  it('creates bind to the active company; a reversal lands in the ENTRY\'s company, not the active one', async () => {
    const posted = await postManual('ceo', [
      { code: '1020', type: 'debit', amountCents: 7_000 },
      { code: '3010', type: 'credit', amountCents: 7_000 },
    ], { tenantId: tenantB })
    expect(posted.statusCode).toBe(201)
    const entry = posted.json() as { id: string; tenantId: string }
    expect(entry.tenantId).toBe(tenantB)
    // A's accounts cannot be posted into B's books.
    const crossed = await call('ceo', 'POST', '/accounting/journal', {
      description: 'Cross-company',
      lines: [
        { accountId: await acct(tenantA, '1020'), type: 'debit', amountCents: 100 },
        { accountId: await acct(tenantB, '3010'), type: 'credit', amountCents: 100 },
      ],
    }, { 'x-servd-active-tenant': tenantB })
    expect(crossed.statusCode).toBe(422)

    // The CEO is working in A; the reversal still goes to B's books.
    const rev = await call('ceo', 'POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'Wrong company picked' }, { 'x-servd-active-tenant': tenantA })
    expect(rev.statusCode).toBe(201)
    expect(rev.json().tenantId).toBe(tenantB)
    const trail = await prisma.auditLog.findFirst({ where: { action: 'journal.reverse', entityId: rev.json().id } })
    expect(trail?.tenantId).toBe(tenantB)
  })

  // Owner, 2026-10-16: finance posts and reverses manual journals directly; the co-owner still cannot.
  it('finance may post and reverse; the co-owner may not', async () => {
    const posted = await postManual('ceo', [
      { code: '1020', type: 'debit', amountCents: 2_000 },
      { code: '3010', type: 'credit', amountCents: 2_000 },
    ])
    const id = (posted.json() as { id: string }).id
    expect((await postManual('fin', [
      { code: '1020', type: 'debit', amountCents: 2_000 },
      { code: '3010', type: 'credit', amountCents: 2_000 },
    ])).statusCode).toBe(201)
    expect((await call('owner', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Owner tries' })).statusCode).toBe(403)
    // Since 2026-10-23 finance's cancel waits for the CEO (202, a journal request of kind reverse).
    expect((await call('fin', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Finance reverses' })).statusCode).toBe(202)
  })

  it('needs a reason, and only reverses manual entries (not a source document\'s posting, not a reversal)', async () => {
    const posted = await postManual('ceo', [
      { code: '1020', type: 'debit', amountCents: 3_000 },
      { code: '3010', type: 'credit', amountCents: 3_000 },
    ])
    const id = (posted.json() as { id: string }).id
    expect((await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, {})).statusCode).toBe(400)
    expect((await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'x' })).statusCode).toBe(400)

    const sale = await postJournalEntry({
      tenantId: tenantA, sourceType: 'order.complete', sourceId: 'audit-order-1', description: 'Order',
      lines: [{ accountCode: '1010', type: 'debit', amountCents: 1_150 }, { accountCode: '4001', type: 'credit', amountCents: 1_150 }],
    })
    const sys = await call('ceo', 'POST', `/accounting/journal/${sale.entryId}/reverse`, { reason: 'Customer complained' })
    expect(sys.statusCode).toBe(422)
    expect(sys.json().error.code).toBe('NOT_A_MANUAL_ENTRY')

    const rev = await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Duplicate entry' })
    expect(rev.statusCode).toBe(201)
    const revRev = await call('ceo', 'POST', `/accounting/journal/${rev.json().id}/reverse`, { reason: 'Undo the undo' })
    expect(revRev.statusCode).toBe(422)
    expect(revRev.json().error.code).toBe('NOT_A_MANUAL_ENTRY')
  })

  it('respects the period lock: a reversal dated in a closed month is refused; dated today it posts', async () => {
    const posted = await postManual('ceo', [
      { code: '6010', type: 'debit', amountCents: 9_000 },
      { code: '2090', type: 'credit', amountCents: 9_000 },
    ], { description: 'January rent accrual', entryDate: '2026-01-15T07:00:00.000Z' })
    expect(posted.statusCode).toBe(201)
    const id = (posted.json() as { id: string }).id
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-01-31T23:59:59.999+05:00'), lockedBy: users.ceo!.id } })
    try {
      const inClosed = await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Reverse in January', entryDate: '2026-01-20T07:00:00.000Z' })
      expect(inClosed.statusCode).toBe(422)
      expect(inClosed.json().error.code).toBe('PERIOD_LOCKED')
      expect(inClosed.json().error.message).toContain('closed through 2026-01-31')

      const today = await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Reverse in the open period' })
      expect(today.statusCode).toBe(201)
      expect(fmtPktDate(new Date(today.json().entryDate))).toBe(fmtPktDate(new Date()))
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })

  it('refuses to reverse onto a deactivated account, with the fix', async () => {
    const posted = await postManual('ceo', [
      { code: '6060', type: 'debit', amountCents: 4_000 },
      { code: '1020', type: 'credit', amountCents: 4_000 },
    ], { description: 'Flyers' })
    const id = (posted.json() as { id: string }).id
    const mkt = await acct(tenantA, '6060')
    await prisma.account.update({ where: { id: mkt }, data: { isActive: false } })
    try {
      const res = await call('ceo', 'POST', `/accounting/journal/${id}/reverse`, { reason: 'Wrong month' })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('ACCOUNT_INACTIVE')
    } finally {
      await prisma.account.update({ where: { id: mkt }, data: { isActive: true } })
    }
  })
})

// ─── BOOKS-07 ────────────────────────────────────────────────────────────────

describe('BOOKS-07 — the books cannot be closed through a future date', () => {
  const plusDays = (iso: string, n: number) => new Date(new Date(`${iso}T12:00:00+05:00`).getTime() + n * 86400_000 + 5 * 3600_000).toISOString().slice(0, 10)

  // BOOKS-R2-01: today is still trading, so it is refused too — the latest
  // lockable date is yesterday.
  it('refuses today, tomorrow (PKT) and a typo year ahead; accepts yesterday; refuses garbage', async () => {
    const today = fmtPktDate(new Date())
    for (const date of [today, plusDays(today, 1), `${Number(today.slice(0, 4)) + 1}-12-31`]) {
      const res = await call('adminB', 'POST', '/accounting/period-close', { lockedThrough: date, note: 'typo' })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('LOCK_IN_FUTURE')
    }
    expect(await prisma.periodLock.count({ where: { tenantId: tenantB } })).toBe(0)
    expect((await call('adminB', 'POST', '/accounting/period-close', { lockedThrough: 'next friday' })).json().error.code).toBe('INVALID_DATE')

    const ok = await call('adminB', 'POST', '/accounting/period-close', { lockedThrough: plusDays(today, -1) })
    expect(ok.statusCode).toBe(201)
    const noToday = await call('adminB', 'POST', '/accounting/period-close', { lockedThrough: today })
    expect(noToday.statusCode).toBe(422)
    expect(noToday.json().error.code).toBe('LOCK_IN_FUTURE')
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantB } })
  })
})

// ─── BOOKS-09 ────────────────────────────────────────────────────────────────

describe('BOOKS-09 — transfers between own cash accounts are not cash flow', () => {
  const CASH = new Set(['drawer', 'safe', 'bank'])
  const isCash = (id: string) => CASH.has(id)

  it('a shift close with sales, a safe drop and COGS: inflow is the sales, the drop is a transfer', () => {
    const split = splitEntryCash([
      { accountId: 'drawer', type: 'debit', amountCents: 218_500, memo: 'POS cash sales' },
      { accountId: 'safe', type: 'debit', amountCents: 300_000, memo: 'Cash dropped to safe' },
      { accountId: 'drawer', type: 'credit', amountCents: 300_000, memo: 'Cash dropped to safe' },
      { accountId: 'cogs', type: 'debit', amountCents: 80_000 },
      { accountId: 'inventory', type: 'credit', amountCents: 80_000 },
      { accountId: 'revenue', type: 'credit', amountCents: 190_000 },
      { accountId: 'gst', type: 'credit', amountCents: 28_500 },
    ], isCash)
    expect(split.inflowCents).toBe(218_500)
    expect(split.outflowCents).toBe(0)
    expect(split.perAccount.get('safe')).toEqual({ inflowCents: 0, outflowCents: 0, transferInCents: 300_000, transferOutCents: 0 })
    expect(split.perAccount.get('drawer')).toEqual({ inflowCents: 218_500, outflowCents: 0, transferInCents: 0, transferOutCents: 300_000 })
  })

  it('a deposit split across safe and drawer is all transfer; refunds stay outflow', () => {
    const deposit = splitEntryCash([
      { accountId: 'bank', type: 'debit', amountCents: 500_000, memo: 'Cash deposited' },
      { accountId: 'safe', type: 'credit', amountCents: 300_000, memo: 'Deposit from safe' },
      { accountId: 'drawer', type: 'credit', amountCents: 200_000, memo: 'Deposit of shift takings' },
    ], isCash)
    expect([deposit.inflowCents, deposit.outflowCents]).toEqual([0, 0])
    expect(deposit.perAccount.get('bank')!.transferInCents).toBe(500_000)

    const mixed = splitEntryCash([
      { accountId: 'drawer', type: 'debit', amountCents: 100_000, memo: 'sales' },
      { accountId: 'revenue', type: 'credit', amountCents: 100_000 },
      { accountId: 'refunds', type: 'debit', amountCents: 20_000 },
      { accountId: 'drawer', type: 'credit', amountCents: 20_000, memo: 'refund' },
    ], isCash)
    expect([mixed.inflowCents, mixed.outflowCents]).toEqual([100_000, 20_000])
  })

  it('the report: inflow is real receipts, transfers reported apart, nets still equal each balance change', async () => {
    const tenantC = (await prisma.tenant.create({ data: { name: 'Audit Cash Co', slug: 'audit-cash-c' } })).id
    await ensureChartOfAccounts(tenantC)
    // A second bank, linked from Configuration → Bank accounts.
    await prisma.account.create({ data: { tenantId: tenantC, code: '1021', name: 'Bank — Meezan', type: 'asset' } })
    await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'Meezan', accountCode: '1021' } })
    const day = new Date()
    const post = (sourceId: string, lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; memo?: string }>) =>
      postJournalEntry({ tenantId: tenantC, sourceType: 'test.cash', sourceId, description: sourceId, entryDate: day, lines })

    // Shift close: PKR 2,185 of cash sales, a PKR 3,000 safe drop, COGS.
    await post('shift', [
      { accountCode: '1015', type: 'debit', amountCents: 218_500, memo: 'POS cash sales' },
      { accountCode: '1010', type: 'debit', amountCents: 300_000, memo: 'Cash dropped to safe' },
      { accountCode: '1015', type: 'credit', amountCents: 300_000, memo: 'Cash dropped to safe' },
      { accountCode: '5010', type: 'debit', amountCents: 50_000 },
      { accountCode: '1210', type: 'credit', amountCents: 50_000 },
      { accountCode: '4001', type: 'credit', amountCents: 190_000 },
      { accountCode: '2030', type: 'credit', amountCents: 28_500 },
    ])
    // COD pay-in to the drawer, a deposit to the second bank, rent from the bank.
    await post('payin', [
      { accountCode: '1015', type: 'debit', amountCents: 212_750, memo: 'Cash paid in' },
      { accountCode: '1010', type: 'credit', amountCents: 212_750, memo: 'Cash paid in' },
    ])
    await post('deposit', [
      { accountCode: '1021', type: 'debit', amountCents: 250_000, memo: 'Cash deposited' },
      { accountCode: '1010', type: 'credit', amountCents: 250_000, memo: 'Deposit from safe' },
    ])
    await post('rent', [
      { accountCode: '6010', type: 'debit', amountCents: 100_000 },
      { accountCode: '1021', type: 'credit', amountCents: 100_000 },
    ])

    const cf = await cashFlow([tenantC], new Date(day.getTime() - 86400_000), new Date(day.getTime() + 86400_000))
    expect(cf.totals.inflowCents).toBe(218_500)
    expect(cf.totals.outflowCents).toBe(100_000)
    expect(cf.totals.netCents).toBe(118_500)
    expect(cf.totals.transfersCents).toBe(300_000 + 212_750 + 250_000)
    const operating = cf.byCategory.find((c) => c.category === 'operating')!
    expect([operating.inflowCents, operating.outflowCents]).toEqual([218_500, 100_000])

    // Each account's net is its true balance change, transfers included.
    const tb = await trialBalance([tenantC], new Date(day.getTime() + 86400_000))
    for (const row of cf.byCashAccount) {
      const t = tb.rows.find((r) => r.code === row.code)
      expect(row.netCents).toBe(t ? t.debitCents - t.creditCents : 0)
    }
    expect(cf.byCashAccount.map((r) => r.code)).toContain('1021')
    expect(cf.byCashAccount.reduce((s, r) => s + r.netCents, 0)).toBe(cf.totals.netCents)
  })
})

// ─── BOOKS-13 ────────────────────────────────────────────────────────────────

describe('BOOKS-13 — the "All companies" trial balance labels each row with its company', () => {
  it('two 2030 rows are told apart, each company balances, totals still add up', async () => {
    for (const [tenantId, amt] of [[tenantA, 128_796], [tenantB, 110_700]] as const) {
      await postJournalEntry({
        tenantId, sourceType: 'test.gst', sourceId: `gst-${tenantId}`, description: 'GST on sales',
        lines: [{ accountCode: '1010', type: 'debit', amountCents: amt }, { accountCode: '2030', type: 'credit', amountCents: amt }],
      })
    }
    const res = await call('ceo', 'GET', '/accounting/trial-balance', undefined, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    const tb = res.json() as Awaited<ReturnType<typeof trialBalance>>
    expect(tb.companies.map((c) => c.name).sort()).toEqual(['Audit Foods', 'Audit Viva'])
    const gst = tb.rows.filter((r) => r.code === '2030')
    expect(gst.map((r) => r.companyName).sort()).toEqual(['Audit Foods', 'Audit Viva'])
    expect(gst.find((r) => r.tenantId === tenantB)!.creditCents).toBeGreaterThanOrEqual(110_700)
    expect(tb.totals.differenceCents).toBe(0)
    expect(tb.companyTotals).toHaveLength(2)
    for (const c of tb.companyTotals) expect(c.differenceCents).toBe(0)
    expect(tb.companyTotals.reduce((s, c) => s + c.debitCents, 0)).toBe(tb.totals.debitCents)

    const csv = await call('ceo', 'GET', '/accounting/trial-balance?format=csv', undefined, { 'x-servd-portfolio': '1' })
    const lines = csv.body.replace(/^﻿/, '').split('\r\n')
    expect(lines[0]).toBe('company,code,account,type,debit,credit')
    expect(lines.filter((l) => l.includes(',2030,')).map((l) => l.split(',')[0]).sort()).toEqual(['Audit Foods', 'Audit Viva'])

    // Company B's operator sees only B, and the CSV stays the single-company shape.
    const b = await call('adminB', 'GET', '/accounting/trial-balance', undefined, { 'x-servd-portfolio': '1' })
    expect((b.json() as { rows: Array<{ tenantId: string }> }).rows.every((r) => r.tenantId === tenantB)).toBe(true)
    const bCsv = await call('adminB', 'GET', '/accounting/trial-balance?format=csv')
    expect(bCsv.body.replace(/^﻿/, '').split('\r\n')[0]).toBe('code,account,type,debit,credit')
  })

  it('the balance sheet and cash flow rows carry their company too', async () => {
    const bs = await call('ceo', 'GET', '/accounting/balance-sheet', undefined, { 'x-servd-portfolio': '1' })
    const cash = (bs.json() as { assets: Array<{ code: string; companyName: string }> }).assets.filter((a) => a.code === '1010')
    expect(cash.map((a) => a.companyName).sort()).toEqual(['Audit Foods', 'Audit Viva'])
    const cf = await call('ceo', 'GET', `/accounting/cash-flow?dateFrom=${fmtPktDate(new Date())}&dateTo=${fmtPktDate(new Date())}`, undefined, { 'x-servd-portfolio': '1' })
    const rows = (cf.json() as { byCashAccount: Array<{ code: string; companyName: string }> }).byCashAccount.filter((a) => a.code === '1010')
    expect(rows.map((a) => a.companyName).sort()).toEqual(['Audit Foods', 'Audit Viva'])
  })
})

// ─── BOOKS-14 ────────────────────────────────────────────────────────────────

describe('BOOKS-14 — 4002 is Revenue — Stackd', () => {
  it('the starting chart says Stackd; 4006 Stax @ Padel is untouched', async () => {
    expect(CHART_OF_ACCOUNTS.find((a) => a.code === '4002')!.name).toBe('Revenue — Stackd')
    expect(CHART_OF_ACCOUNTS.find((a) => a.code === '4006')!.name).toBe('Revenue — Stax @ Padel')
    const fresh = (await prisma.tenant.create({ data: { name: 'Audit New Co', slug: 'audit-new-co' } })).id
    await ensureChartOfAccounts(fresh)
    expect((await prisma.account.findFirstOrThrow({ where: { tenantId: fresh, code: '4002' } })).name).toBe('Revenue — Stackd')
  })

  it('every required code (incl. 5050, where stock counts post) is in the starting chart, so a new company gets it', async () => {
    expect(REQUIRED_ACCOUNT_CODES).toContain('5050')
    const canonical = new Set(CHART_OF_ACCOUNTS.map((a) => a.code))
    expect(REQUIRED_ACCOUNT_CODES.filter((c) => !canonical.has(c))).toEqual([])
    const fresh = (await prisma.tenant.create({ data: { name: 'Audit Required Co', slug: 'audit-required-co' } })).id
    await ensureChartOfAccounts(fresh)
    const have = new Set((await prisma.account.findMany({ where: { tenantId: fresh, isActive: true }, select: { code: true } })).map((a) => a.code))
    expect(REQUIRED_ACCOUNT_CODES.filter((c) => !have.has(c))).toEqual([])
  })

  it('the migration renames only charts still on the old default, and is idempotent', async () => {
    const old = (await prisma.tenant.create({ data: { name: 'Audit Old Chart', slug: 'audit-old-chart' } })).id
    const custom = (await prisma.tenant.create({ data: { name: 'Audit Custom Chart', slug: 'audit-custom-chart' } })).id
    await prisma.account.createMany({ data: [
      { tenantId: old, code: '4002', name: 'Revenue — Stax', type: 'revenue' },
      { tenantId: old, code: '4006', name: 'Revenue — Stax @ Padel', type: 'revenue' },
      { tenantId: custom, code: '4002', name: 'Café sales (Stackd)', type: 'revenue' },
    ] })
    const sql = readFileSync(new URL('../prisma/migrations/20261010150200_rename_stackd_revenue/migration.sql', import.meta.url), 'utf8')
    await prisma.$executeRawUnsafe(sql)
    await prisma.$executeRawUnsafe(sql)
    const names = await prisma.account.findMany({ where: { tenantId: { in: [old, custom] } }, select: { tenantId: true, code: true, name: true } })
    const nameOf = (t: string, c: string) => names.find((n) => n.tenantId === t && n.code === c)!.name
    expect(nameOf(old, '4002')).toBe('Revenue — Stackd')
    expect(nameOf(old, '4006')).toBe('Revenue — Stax @ Padel')
    expect(nameOf(custom, '4002')).toBe('Café sales (Stackd)')
  })
})

// ─── BOOKS-02 ────────────────────────────────────────────────────────────────

describe('BOOKS-02 — finance can open and maintain Bank accounts', () => {
  it('finance lists its company\'s banks and adds one bound to the active company; company B gets 404', async () => {
    await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Ops', accountCode: '1020' } })
    const created = await call('fin', 'POST', '/setup/bank-accounts', { name: 'HBL Ops', bankName: 'HBL' })
    expect(created.statusCode).toBe(201)
    const bank = created.json() as { id: string; tenantId: string; accountCode: string }
    expect(bank.tenantId).toBe(tenantA)
    expect(bank.accountCode).toBe('1020')

    const list = await call('fin', 'GET', '/setup/bank-accounts')
    expect(list.statusCode).toBe(200)
    const rows = list.json() as Array<{ tenantId: string; name: string }>
    expect(rows.map((r) => r.name)).toContain('HBL Ops')
    expect(rows.every((r) => r.tenantId === tenantA)).toBe(true)

    expect((await call('fin', 'PATCH', `/setup/bank-accounts/${bank.id}`, { branchCode: '0042' })).statusCode).toBe(200)
    // Company B's finance never sees or edits A's bank.
    expect((await call('finB', 'GET', '/setup/bank-accounts')).json().map((r: { name: string }) => r.name)).toEqual(['B Ops'])
    expect((await call('finB', 'PATCH', `/setup/bank-accounts/${bank.id}`, { branchCode: '9999' })).statusCode).toBe(404)
    expect((await call('finB', 'DELETE', `/setup/bank-accounts/${bank.id}`)).statusCode).toBe(404)
    // HR (no accounting module) still cannot.
    expect((await call('hr', 'GET', '/setup/bank-accounts')).statusCode).toBe(403)
  })
})

// ─── PPL-09 ──────────────────────────────────────────────────────────────────

describe('PPL-09 — only the CEO / co-owner change the company\'s operations rules', () => {
  it('a floor manager, the exec, finance and HR are refused, and nothing changes', async () => {
    const before = await call('foh', 'GET', '/setup/operations-config')
    expect(before.statusCode).toBe(200)     // reading stays open — the till and clock-in read it
    for (const who of ['foh', 'mgmt', 'fin', 'hr']) {
      const res = await call(who, 'PATCH', '/setup/operations-config', { tipPoolEnabled: true, tipPoolDistribution: 'by_hours', selfieRequiredAtClockIn: false })
      expect(res.statusCode, who).toBe(403)
    }
    const cfg = await prisma.operationsConfig.findFirstOrThrow({ where: { tenantId: tenantA, scope: 'global' } })
    expect(cfg.selfieRequiredAtClockIn).toBe((before.json() as { selfieRequiredAtClockIn: boolean }).selfieRequiredAtClockIn)
    expect(cfg.tipPoolDistribution).toBe((before.json() as { tipPoolDistribution: string }).tipPoolDistribution)
  })

  it('the co-owner and the CEO can, and every change is on the trail with before and after', async () => {
    const start = await prisma.operationsConfig.findFirstOrThrow({ where: { tenantId: tenantA, scope: 'global' } })
    const res = await call('owner', 'PATCH', '/setup/operations-config', { selfieRequiredAtClockIn: !start.selfieRequiredAtClockIn, tipPoolDistribution: 'by_role_weight', serviceChargePct: start.serviceChargePct })
    expect(res.statusCode).toBe(200)
    const trail = await prisma.auditLog.findFirstOrThrow({ where: { action: 'operations_config.update', userId: users.owner!.id }, orderBy: { createdAt: 'desc' } })
    expect(trail.tenantId).toBe(tenantA)
    expect(trail.entityId).toBe(start.id)
    // Only the fields that actually changed are recorded.
    expect((trail.metadata as { fields: string[] }).fields.sort()).toEqual(['selfieRequiredAtClockIn', 'tipPoolDistribution'])
    expect(trail.before).toEqual({ selfieRequiredAtClockIn: start.selfieRequiredAtClockIn, tipPoolDistribution: start.tipPoolDistribution })
    expect(trail.after).toEqual({ selfieRequiredAtClockIn: !start.selfieRequiredAtClockIn, tipPoolDistribution: 'by_role_weight' })

    expect((await call('ceo', 'PATCH', '/setup/operations-config', { tipPoolEnabled: true })).statusCode).toBe(200)
  })

  it('a change made in company B never touches company A', async () => {
    const a = await prisma.operationsConfig.findFirstOrThrow({ where: { tenantId: tenantA, scope: 'global' } })
    const res = await call('ceo', 'PATCH', '/setup/operations-config', { geofenceRadiusMetres: 321 }, { 'x-servd-active-tenant': tenantB })
    expect(res.statusCode).toBe(200)
    const b = await prisma.operationsConfig.findFirstOrThrow({ where: { tenantId: tenantB, scope: 'global' } })
    expect(b.geofenceRadiusMetres).toBe(321)
    expect((await prisma.operationsConfig.findFirstOrThrow({ where: { id: a.id } })).geofenceRadiusMetres).toBe(a.geofenceRadiusMetres)
    const trail = await prisma.auditLog.findFirstOrThrow({ where: { action: 'operations_config.update', entityId: b.id } })
    expect(trail.tenantId).toBe(tenantB)
  })
})
