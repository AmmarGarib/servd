// The simulated month — BOOKS and the MONTH CLOSE (finance readiness plan §4a
// items 8 "Books" and 9 "Month close by the CEO"). Its own world on the shared
// harness (tests/sim/harness.ts — its header is the API).
//
// The month, as the people who do it:
//   1–3 Oct     two tills a day in A and B (cash + Keenu card, the 5% service
//               charge), so the books carry sales, tax, card receivable;
//   3 Oct       A's service-charge account 4100 goes missing from the chart
//               (switched off underneath the books — the guard refuses it on
//               the API, so the world sets it): the till close is REFUSED and
//               flagged posting_failed; finance switches 4100 back on and
//               re-posts it through Reconciliation → Backfill unposted (dry
//               run first) — the entry lands on its own day and the flag closes;
//   5 Oct       a supplier bill with a non-stock line (finance) and the
//               October shop rent through OpEx (finance, untagged 6010);
//   8–14 Oct    finance posts a manual journal, edits it (the reversal half is
//               dated on the ORIGINAL's day, the corrected entry on the same
//               day — both in October), then cancels the corrected entry; a
//               second reversal / an edit of a reversed entry are refused;
//   15 Oct      a journal request by a management login (fnb_manager may not
//               prepare one; finance may not approve it), approved by the CEO
//               — the entry is a manual one, brand-tagged to Flipd on 6010;
//   16 Oct      the chart: finance adds and renames an account; the reserved
//               ranges are refused for finance AND the CEO
//               (ACCOUNT_CODE_RESERVED); a duplicate code is 409; a manager is 403;
//   1 Nov       FINANCE runs the 6010 allocation 60/40 Simmer/Flipd for the
//               whole of October (owner decision): only the untagged rent is
//               split (the Flipd-tagged request line stays), a second run of the
//               same month is RUN_OVERLAPS; reversed (reason ≥10, once) and
//               re-run — no double count;
//   2 Nov       the CEO closes October: refused without acknowledging the
//               blocks (CLOSE_NOT_READY), overriding trial_balance is refused
//               (NOT_OVERRIDABLE), a short reason is refused, finance cannot
//               close; with acknowledgements it closes. Finance then posts into
//               October (PERIOD_LOCKED); the CEO reopens; finance is refused in
//               the reopened window (CEO_ONLY_CLOSED_BOOKS) and cannot run a
//               real backfill (REOPENED_BOOKS_CEO_ONLY); the CEO posts; the
//               CEO closes again; November stays open to finance.
// Reports (per company): the trial balance — one net figure per account, no
// zero rows, balanced; the balance sheet balances (assets = liabilities +
// equity + earnings); P&L profit for the fiscal year to date = the balance
// sheet's year-to-date profit; the cash flow runs and ties to the cash
// accounts' movement. Company B: 404 on A's journals, journal requests, rules,
// runs and accounts; B's close is independent of A's.
//
// Runtime ≈ 1 minute. Requires a disposable database ("test" in DATABASE_URL).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  startSim, ok, errCode, pkt,
  type Sim, type SimCompany, type SimUser, type SimBrand, type SimItem,
} from './harness.js'

let sim: Sim

const FLOAT = 500_000
let seq = 0
const RUN = Math.random().toString(36).slice(2, 7).toUpperCase()
const key = (s: string) => `books-${s}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
const cardRef = () => `KB${RUN}${String(100000 + ++seq)}`
const iso = (day: string, hhmm = '09:00') => pkt(day, hhmm).toISOString()

// ─── Till helpers (the sales sim's shape, cash + card only) ─────────────────

const line = (item: SimItem, quantity = 1) => ({ menuItemId: item.id, name: item.name, quantity, unitPriceCents: item.priceCents, modifiers: [] })

async function openTill(co: SimCompany, who: SimUser): Promise<string> {
  return (ok(await sim.as(who, co).post('/pos/shifts/open', { openingFloatCents: FLOAT }), 201)).id as string
}
async function ringAndPay(co: SimCompany, who: SimUser, shiftId: string, brand: SimBrand, items: Array<[SimItem, number]>, tender: 'cash' | 'card') {
  const o = ok(await sim.as(who, co).post('/pos/orders', {
    conceptId: brand.id, shiftId, items: items.map(([i, q]) => line(i, q)), idempotencyKey: key('ring'), paymentMethod: tender,
  }), 201) as { id: string; totalCents: number }
  const payments = tender === 'card'
    ? [{ method: 'card', amountCents: o.totalCents, gateway: 'keenu', gatewayRef: cardRef() }]
    : [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }]
  ok(await sim.as(who, co).post('/pos/payments', { orderId: o.id, shiftId, idempotencyKey: key('pay'), payments }), 201)
  return o
}
async function closeTill(co: SimCompany, who: SimUser, shiftId: string) {
  const z = ok(await sim.as(co.manager, co).get(`/pos/shifts/${shiftId}/zreport`), 200)
  const expected = z.expectedCashCents ?? z.expectedCents ?? z.drawer?.expectedCents ?? z.cash?.expectedCents
  expect(typeof expected, `zreport has no expected cash: ${JSON.stringify(z).slice(0, 400)}`).toBe('number')
  ok(await sim.as(who, co).post(`/pos/shifts/${shiftId}/close`, { closingFloatCents: expected }), 200)
  await sim.settle()
}
async function tradingDay(co: SimCompany, day: string, hhmm: string): Promise<string> {
  sim.clock.at(day, hhmm)
  const s = await openTill(co, co.cashier)
  const { srb, fbr } = co.brands
  await ringAndPay(co, co.cashier, s, srb, [[srb.items.main, 1], [srb.items.drink, 2]], 'cash')
  await ringAndPay(co, co.cashier, s, fbr, [[fbr.items.main, 2], [fbr.items.side, 1]], 'card')
  await ringAndPay(co, co.cashier, s, srb, [[srb.items.dessert, 2]], 'card')
  await ringAndPay(co, co.cashier, s, fbr, [[fbr.items.drink, 3]], 'cash')
  return s
}

// ─── Ledger readers ─────────────────────────────────────────────────────────

const accountIds: Record<'A' | 'B', Map<string, string>> = { A: new Map(), B: new Map() }
async function loadChart(co: SimCompany) {
  const rows = ok(await sim.as(co.finance, co).get('/setup/chart-of-accounts'), 200) as Array<{ id: string; code: string; tenantId: string }>
  expect(rows.every((r) => r.tenantId === co.tenantId), 'the chart lists only the active company').toBe(true)
  accountIds[co.key] = new Map(rows.map((r) => [r.code, r.id]))
}
const acc = (co: SimCompany, code: string) => {
  const id = accountIds[co.key].get(code)
  if (!id) throw new Error(`${co.key} has no account ${code}`)
  return id
}

/** Σ debit − Σ credit on one account, split by brand tag (null = untagged), between two Karachi days. */
async function tagged(co: SimCompany, code: string, from: string, to: string): Promise<Map<string | null, number>> {
  const lines = await sim.prisma.journalLine.findMany({
    where: {
      account: { tenantId: co.tenantId, code },
      journalEntry: { tenantId: co.tenantId, entryDate: { gte: pkt(from, '00:00'), lte: new Date(`${to}T23:59:59.999+05:00`) } },
    },
    select: { type: true, amountCents: true, conceptId: true },
  })
  const out = new Map<string | null, number>()
  for (const l of lines) out.set(l.conceptId, (out.get(l.conceptId) ?? 0) + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents))
  return out
}

const manual = (co: SimCompany, description: string, day: string, lines: Array<{ code: string; type: 'debit' | 'credit'; cents: number; conceptId?: string }>) => ({
  description, entryDate: iso(day),
  lines: lines.map((l) => ({ accountId: acc(co, l.code), type: l.type, amountCents: l.cents, ...(l.conceptId && { conceptId: l.conceptId }) })),
})

// ─── State the steps hand on ────────────────────────────────────────────────

const st: {
  refusedShift?: string
  rentCents?: number
  firstJe?: string
  amendedJe?: string
  jrId?: string
  jrEntryId?: string
  ruleId?: string
  run1?: string
  run2?: string
  newAccountId?: string
  ceoReopenedJe?: string
  blockKeys?: string[]
} = {}
let mgmtA: SimUser

describe('Books and the month close — October 2026, companies A and B', () => {
  beforeAll(async () => {
    sim = await startSim()
    for (const co of [sim.A, sim.B]) await loadChart(co)
    // A management login (a journal-request preparer: JR_PREPARERS) in A —
    // the harness's manager is fnb_manager, who may not prepare one.
    const u = await sim.prisma.user.create({
      data: {
        name: 'Management A', email: 'management.a@sim.gsfoods.test', password: 'x', role: 'management',
        isActive: true, accountStatus: 'active', tenantId: sim.A.tenantId,
        tenantMemberships: { create: [{ tenant: { connect: { id: sim.A.tenantId } }, role: 'manager' }] },
      },
    })
    mgmtA = { id: u.id, name: u.name, email: u.email!, role: 'management', tenantId: sim.A.tenantId }
  }, 120_000)
  afterAll(async () => { await sim?.close() })

  it('1–2 Oct: two trading days in each company reach the books', async () => {
    for (const day of ['2026-10-01', '2026-10-02']) {
      const shifts = [await tradingDay(sim.A, day, '10:00'), await tradingDay(sim.B, day, '11:00')]
      for (const [i, co] of [sim.A, sim.B].entries()) {
        sim.clock.at(day, co.key === 'A' ? '18:00' : '19:00')
        await closeTill(co, co.cashier, shifts[i]!)
        expect((await sim.ledger.entriesBySource(co, `shift.close:${shifts[i]}`)).length, `${co.key} ${day} till close posted`).toBe(1)
      }
    }
    for (const co of [sim.A, sim.B]) await sim.ledger.assertBalanced(co)
  }, 120_000)

  it('3 Oct: a till close refused for a missing account is re-posted by finance through Backfill unposted', async () => {
    const A = sim.A
    const s = await tradingDay(A, '2026-10-03', '10:00')
    // 4100 (service charge) is gone from A's chart — the API refuses to switch
    // off an account the books post to (ACCOUNT_IN_USE), so the world does it.
    const r1 = await sim.as(A.finance, A).patch(`/setup/chart-of-accounts/${acc(A, '4100')}`, { isActive: false })
    expect(r1.statusCode, 'the API refuses to switch off a system-posted account').toBe(422)
    await sim.prisma.account.update({ where: { id: acc(A, '4100') }, data: { isActive: false } })
    sim.clock.at('2026-10-03', '18:00')
    await closeTill(A, A.cashier, s)
    st.refusedShift = s
    expect(await sim.ledger.entriesBySource(A, `shift.close:${s}`), 'the close was refused').toHaveLength(0)
    const flags = (await sim.ledger.openFlags(A, 'posting_failed')).filter((f) => f.entityId === s)
    expect(flags, 'the refusal is flagged posting_failed on the shift').toHaveLength(1)

    // The preview cannot see the missing account — it lists the shift as to post.
    const fin = sim.as(A.finance, A)
    const dry0 = ok(await fin.post('/reconciliation/backfill-unposted', { dryRun: true }), 200)
    expect(dry0.rows.find((r: { shiftId: string }) => r.shiftId === s)?.outcome).toBe('would_post')
    // The fix: finance switches 4100 back on (finance edits the chart, owner 2026-10-16).
    sim.clock.at('2026-10-04', '10:00')
    ok(await fin.patch(`/setup/chart-of-accounts/${acc(A, '4100')}`, { isActive: true }), 200)
    // A manager cannot run it; finance can (dry run by default, then for real).
    expect((await sim.as(A.manager, A).post('/reconciliation/backfill-unposted', { dryRun: false })).statusCode).toBe(403)
    const dry = ok(await fin.post('/reconciliation/backfill-unposted', {}), 200)
    expect(dry.dryRun).toBe(true)
    expect(await sim.ledger.entriesBySource(A, `shift.close:${s}`), 'a dry run posts nothing').toHaveLength(0)
    const real = ok(await fin.post('/reconciliation/backfill-unposted', { dryRun: false }), 200)
    expect(real.rows.find((r: { shiftId: string }) => r.shiftId === s)?.outcome).toBe('posted')
    const posted = await sim.ledger.entriesBySource(A, `shift.close:${s}`)
    expect(posted).toHaveLength(1)
    // On its own business day (3 Oct), not the day it was re-posted.
    expect(new Date(posted[0]!.entryDate.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)).toBe('2026-10-03')
    expect(posted[0]!.lines.some((l) => l.code === '4100' && l.type === 'credit'), 'the service charge is on 4100').toBe(true)
    // The second real run books nothing more.
    const again = ok(await fin.post('/reconciliation/backfill-unposted', { dryRun: false }), 200)
    expect(again.rows.find((r: { shiftId: string }) => r.shiftId === s)).toBeUndefined()
    expect(await sim.ledger.entriesBySource(A, `shift.close:${s}`)).toHaveLength(1)
    await sim.ledger.assertBalanced(A)
  }, 120_000)

  it('3 Oct (cont.): the re-posted till close closes its posting_failed flag', async () => {
    // CLAUDE.md: "re-post through Backfill unposted, which closes the flag itself".
    const open = (await sim.ledger.openFlags(sim.A, 'posting_failed')).filter((f) => f.entityId === st.refusedShift)
    expect(open, 'the shift is on the books — its posting_failed flag must not stay open (it blocks the close)').toHaveLength(0)
  })

  it('5 Oct: a supplier bill (finance) and the October rent through OpEx (finance)', async () => {
    const A = sim.A
    sim.clock.at('2026-10-05', '10:00')
    const sup = ok(await sim.as(sim.ceo, A).post('/procurement/suppliers', {
      name: 'Clifton Cleaning Co', phone: '923211234567', paymentTermsDays: 30, filerStatus: 'filer',
    }), 201)
    const fin = sim.as(A.finance, A)
    const bill = ok(await fin.post('/procurement/bills', {
      supplierId: sup.id, billNumber: 'CCC-1001', billDate: '2026-10-05', dueDate: '2026-11-04', whtSection: 'none',
      lines: [{ expenseAccountCode: '6040', description: 'Deep clean, October', quantity: 1, unitCostCents: 2_500_000 }],
    }), 201)
    expect(Number(bill.totalCents)).toBe(2_500_000)
    expect(await sim.ledger.balanceOf(A, '6040')).toBe(2_500_000)
    expect(await sim.ledger.balanceOf(A, '2010')).toBe(-2_500_000)

    const cat = ok(await fin.post('/opex/categories', { name: 'Rent', expenseAccountCode: '6010' }), 201)
    const ln = ok(await fin.post('/opex/lines', {
      categoryId: cat.id, name: 'Clifton shop rent', amountCents: 20_000_000, cadence: 'monthly',
      paymentMethod: 'bank_transfer', bankAccountId: A.banks.main.id, whtSection: 'none',
    }), 201)
    const pay = ok(await fin.post('/opex/payments', {
      lineId: ln.id, periodStart: '2026-10-01', periodEnd: '2026-10-31', expectedCents: 20_000_000,
      actualCents: 20_000_000, paidAt: '2026-10-05', paymentRef: 'RENT-OCT-26', whtSection: 'none',
      payFrom: 'bank', bankAccountId: A.banks.main.id,
    }), 201)
    expect(pay.ledger?.status, JSON.stringify(pay.ledger)).toBe('posted')
    st.rentCents = 20_000_000
    const rent = await tagged(A, '6010', '2026-10-01', '2026-10-31')
    expect(rent.get(null), 'the rent is shared (untagged) cost').toBe(20_000_000)
    expect(await sim.ledger.balanceOf(A, A.banks.main.code)).toBeLessThan(0) // nothing banked in this sim yet
    await sim.ledger.assertBalanced(A)
  }, 60_000)

  it('8–14 Oct: finance posts a manual journal, edits it (both halves in October), then cancels it', async () => {
    const A = sim.A
    const fin = sim.as(A.finance, A)
    sim.clock.at('2026-10-08', '11:00')
    // Unbalanced and other-company accounts are refused first.
    expect(errCode(await fin.post('/accounting/journal', { description: 'x', lines: [
      { accountId: acc(A, '6081'), type: 'debit', amountCents: 500_000 }, { accountId: acc(A, A.banks.main.code), type: 'credit', amountCents: 400_000 },
    ] }))).toBe('UNBALANCED_ENTRY')
    expect(errCode(await fin.post('/accounting/journal', { description: 'x', lines: [
      { accountId: acc(sim.B, '6081'), type: 'debit', amountCents: 500_000 }, { accountId: acc(A, A.banks.main.code), type: 'credit', amountCents: 500_000 },
    ] }))).toBe('ACCOUNT_NOT_IN_COMPANY')
    const je = ok(await fin.post('/accounting/journal', { ...manual(A, 'HBL charges September statement', '2026-10-08', [
      { code: '6081', type: 'debit', cents: 500_000 }, { code: A.banks.main.code, type: 'credit', cents: 500_000 },
    ]), reference: 'HBL-SEP' }), 201)
    st.firstJe = je.id
    expect(je.reference).toMatch(/^manual:/)
    expect(await sim.ledger.balanceOf(A, '6081')).toBe(500_000)

    // The edit, four days later: one transaction — the reversal dated on the
    // ORIGINAL's day (8 Oct) and the corrected entry (also 8 Oct).
    sim.clock.at('2026-10-12', '11:00')
    const amended = ok(await fin.post(`/accounting/journal/${je.id}/amend`, { ...manual(A, 'HBL charges September statement (corrected)', '2026-10-08', [
      { code: '6081', type: 'debit', cents: 650_000 }, { code: A.banks.main.code, type: 'credit', cents: 650_000 },
    ]), reason: 'Statement shows PKR 6,500 not 5,000' }), 201)
    st.amendedJe = amended.id
    const rev = await sim.prisma.journalEntry.findUniqueOrThrow({ where: { id: amended.replaces.reversalId } })
    expect(rev.reference).toBe(`manual.reversal:${je.reference.slice('manual:'.length)}`)
    expect(rev.entryDate.toISOString(), 'the reversal half is dated on the original\'s day').toBe(new Date(je.entryDate).toISOString())
    expect(new Date(amended.entryDate).toISOString()).toBe(iso('2026-10-08'))
    expect(await sim.ledger.balanceOf(A, '6081', '2026-10-08')).toBe(650_000)
    // The original cannot be edited or cancelled again.
    expect(errCode(await fin.post(`/accounting/journal/${je.id}/reverse`, { reason: 'twice over' }))).toBe('ALREADY_REVERSED')
    expect(errCode(await fin.post(`/accounting/journal/${je.id}/amend`, { ...manual(A, 'again', '2026-10-08', [
      { code: '6081', type: 'debit', cents: 1 }, { code: A.banks.main.code, type: 'credit', cents: 1 },
    ]), reason: 'second edit' }))).toBe('ALREADY_REVERSED')
    // A reversal itself is not reversible; a system entry (a till close) is not either.
    expect(errCode(await fin.post(`/accounting/journal/${rev.id}/reverse`, { reason: 'undo undo' }))).toBe('NOT_A_MANUAL_ENTRY')
    const till = (await sim.ledger.entriesBySource(A, 'shift.close:'))[0]!
    expect(errCode(await fin.post(`/accounting/journal/${till.id}/reverse`, { reason: 'not mine to undo' }))).toBe('NOT_A_MANUAL_ENTRY')

    // Cancelled on 14 Oct (bank refunded the charge).
    sim.clock.at('2026-10-14', '11:00')
    const cancel = ok(await fin.post(`/accounting/journal/${amended.id}/reverse`, { reason: 'HBL reversed the charges' }), 201)
    expect(cancel.reverses.id).toBe(amended.id)
    expect(await sim.ledger.balanceOf(A, '6081')).toBe(0)
    // Every manual entry is on the Exceptions list for review.
    expect((await sim.ledger.openFlags(A, 'manual_journal')).length).toBeGreaterThanOrEqual(4)
    // The journal page's list carries the reversal links.
    const list = ok(await fin.get('/accounting/ledger?source=manual&dateFrom=2026-10-01&dateTo=2026-10-31'), 200)
    const firstRow = list.data.find((e: { id: string }) => e.id === je.id)
    expect(firstRow?.reversedBy?.id).toBe(rev.id)
    await sim.ledger.assertBalanced(A)
  }, 60_000)

  it('15 Oct: a journal request by management is approved by the CEO (never by finance, never prepared by fnb_manager)', async () => {
    const A = sim.A
    sim.clock.at('2026-10-15', '10:00')
    const body = { ...manual(A, 'Flipd kiosk rent (brand-only)', '2026-10-15', [
      { code: '6010', type: 'debit', cents: 1_000_000, conceptId: A.brands.fbr.id }, { code: A.banks.main.code, type: 'credit', cents: 1_000_000 },
    ]), submit: true }
    expect((await sim.as(A.manager, A).post('/accounting/journal-requests', body)).statusCode, 'fnb_manager is not a preparer').toBe(403)
    const jr = ok(await sim.as(mgmtA, A).post('/accounting/journal-requests', body), 201).request
    expect(jr.status).toBe('submitted')
    st.jrId = jr.id
    // Nothing is booked until the CEO approves.
    expect((await tagged(A, '6010', '2026-10-01', '2026-10-31')).get(A.brands.fbr.id) ?? 0).toBe(0)
    const byFinance = await sim.as(A.finance, A).post(`/accounting/journal-requests/${jr.id}/approve`, {})
    expect([403, 404], byFinance.body).toContain(byFinance.statusCode)
    const byPreparer = await sim.as(mgmtA, A).post(`/accounting/journal-requests/${jr.id}/approve`, {})
    expect([403, 404], byPreparer.body).toContain(byPreparer.statusCode)
    // Company B cannot see it.
    expect((await sim.as(sim.B.finance, sim.B).get(`/accounting/journal-requests/${jr.id}`)).statusCode).toBe(404)
    const approved = ok(await sim.as(sim.ceo, A).post(`/accounting/journal-requests/${jr.id}/approve`, {}), 200)
    expect(approved.request.status).toBe('posted')
    st.jrEntryId = approved.entryId
    const e = await sim.prisma.journalEntry.findUniqueOrThrow({ where: { id: approved.entryId } })
    expect(e.tenantId).toBe(A.tenantId)
    expect(e.reference).toBe(`manual:${jr.id}`)
    expect((await tagged(A, '6010', '2026-10-01', '2026-10-31')).get(A.brands.fbr.id)).toBe(1_000_000)
    // Approving twice books nothing more.
    expect(errCode(await sim.as(sim.ceo, A).post(`/accounting/journal-requests/${jr.id}/approve`, {}))).toBe('REQUEST_NOT_PENDING')
    await sim.ledger.assertBalanced(A)
  }, 60_000)

  it('16 Oct: the chart — finance adds and renames an account; reserved ranges are refused', async () => {
    const A = sim.A
    sim.clock.at('2026-10-16', '10:00')
    const fin = sim.as(A.finance, A)
    const created = ok(await fin.post('/setup/chart-of-accounts', { code: '6197', name: 'Staff uniforms', type: 'expense' }), 201)
    expect(created.tenantId).toBe(A.tenantId)
    st.newAccountId = created.id
    accountIds.A.set('6197', created.id)
    const renamed = ok(await fin.patch(`/setup/chart-of-accounts/${created.id}`, { name: 'Staff uniforms & aprons' }), 200)
    expect(renamed.name).toBe('Staff uniforms & aprons')
    expect(errCode(await fin.post('/setup/chart-of-accounts', { code: '6197', name: 'dup', type: 'expense' }))).toBe('ACCOUNT_CODE_TAKEN')
    // The same code is free in company B (charts are per company).
    ok(await sim.as(sim.B.finance, sim.B).post('/setup/chart-of-accounts', { code: '6197', name: 'Uniforms', type: 'expense' }), 201)
    for (const code of ['1450', '1555', '1599.01', '2012', '2150', '6210', '6995']) {
      expect(errCode(await fin.post('/setup/chart-of-accounts', { code, name: `Reserved ${code}`, type: 'asset' })), `finance ${code}`).toBe('ACCOUNT_CODE_RESERVED')
    }
    expect(errCode(await sim.as(sim.ceo, A).post('/setup/chart-of-accounts', { code: '1520', name: 'Hand-made asset', type: 'asset' })), 'the CEO too').toBe('ACCOUNT_CODE_RESERVED')
    expect((await sim.as(A.manager, A).post('/setup/chart-of-accounts', { code: '6186', name: 'x', type: 'expense' })).statusCode).toBe(403)
    // Company B: A's account is 404.
    expect((await sim.as(sim.B.finance, sim.B).patch(`/setup/chart-of-accounts/${created.id}`, { name: 'hijack' })).statusCode).toBe(404)
    // The new account takes a posting (finance, open month).
    ok(await fin.post('/accounting/journal', manual(A, 'Aprons for the Simmer line', '2026-10-16', [
      { code: '6197', type: 'debit', cents: 300_000, conceptId: A.brands.srb.id }, { code: '1010', type: 'credit', cents: 300_000 },
    ])), 201)
  }, 60_000)

  it('1 Nov: finance runs the 6010 allocation 60/40 for October, reverses it and runs it again — no double count', async () => {
    const A = sim.A
    sim.clock.at('2026-11-01', '10:00')
    const fin = sim.as(A.finance, A)
    const weights = [{ conceptId: A.brands.srb.id, weightBps: 6000 }, { conceptId: A.brands.fbr.id, weightBps: 4000 }]
    expect(errCode(await fin.post('/allocations/rules', { name: 'Rent split', sourceAccountCode: '6010', driver: 'fixed_pct', weights: [{ conceptId: A.brands.srb.id, weightBps: 6000 }, { conceptId: A.brands.fbr.id, weightBps: 3000 }] }))).toBe('BAD_WEIGHTS')
    // A rule may not name another company's brand.
    const foreign = await fin.post('/allocations/rules', { name: 'Rent split', sourceAccountCode: '6010', driver: 'fixed_pct', weights: [{ conceptId: sim.B.brands.srb.id, weightBps: 10_000 }] })
    expect([403, 404, 422], foreign.body).toContain(foreign.statusCode)
    const rule = ok(await fin.post('/allocations/rules', { name: 'Clifton rent split', sourceAccountCode: '6010', driver: 'fixed_pct', weights }), 201)
    st.ruleId = rule.id
    expect((await sim.as(A.manager, A).post(`/allocations/rules/${rule.id}/run`, { periodStart: '2026-10-01', periodEnd: '2026-10-31' })).statusCode).toBe(403)

    const r1 = ok(await fin.post(`/allocations/rules/${rule.id}/run`, { periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 201)
    st.run1 = r1.runId
    expect(r1.totalAmountCents, 'only the shared (untagged) rent is split').toBe(st.rentCents)
    expect(r1.brandTaggedCents, 'the Flipd-tagged journal-request line is left where it is').toBe(1_000_000)
    const split = (m: Map<string | null, number>) => ({ shared: m.get(null) ?? 0, simmer: m.get(A.brands.srb.id) ?? 0, flipd: m.get(A.brands.fbr.id) ?? 0 })
    const want = { shared: 0, simmer: 12_000_000, flipd: 8_000_000 + 1_000_000 }
    expect(split(await tagged(A, '6010', '2026-10-01', '2026-10-31'))).toEqual(want)
    const runEntry = (await sim.ledger.entriesBySource(A, `allocation.run:${r1.runId}`))[0]!
    expect(new Date(runEntry.entryDate.getTime() + 5 * 3_600_000).toISOString().slice(0, 10), 'dated on the period end (31 Oct)').toBe('2026-10-31')
    // The same month again (or a part of it) is refused while the run stands.
    expect(errCode(await fin.post(`/allocations/rules/${rule.id}/run`, { periodStart: '2026-10-15', periodEnd: '2026-10-31' }))).toBe('RUN_OVERLAPS')
    // Company B cannot see, run or reverse A's.
    const finB = sim.as(sim.B.finance, sim.B)
    expect((await finB.post(`/allocations/rules/${rule.id}/run`, { periodStart: '2026-10-01', periodEnd: '2026-10-31' })).statusCode).toBe(404)
    expect((await finB.post(`/allocations/runs/${r1.runId}/reverse`, { reason: 'not my company at all' })).statusCode).toBe(404)
    expect((ok(await finB.get('/allocations/runs'), 200) as Array<{ id: string }>).some((r) => r.id === r1.runId)).toBe(false)
    expect((ok(await finB.get('/allocations/rules'), 200) as Array<{ id: string }>).some((r) => r.id === rule.id)).toBe(false)

    // Reversed (reason ≥ 10, once) …
    expect((await fin.post(`/allocations/runs/${r1.runId}/reverse`, { reason: 'short' })).statusCode).toBe(400)
    ok(await fin.post(`/allocations/runs/${r1.runId}/reverse`, { reason: 'Weights to be re-checked against floor area' }), 201)
    expect(errCode(await fin.post(`/allocations/runs/${r1.runId}/reverse`, { reason: 'Weights to be re-checked again' }))).toBe('RUN_ALREADY_REVERSED')
    expect(split(await tagged(A, '6010', '2026-10-01', '2026-10-31'))).toEqual({ shared: st.rentCents, simmer: 0, flipd: 1_000_000 })
    const runs = ok(await fin.get('/allocations/runs'), 200) as Array<{ id: string; reversedAt: string | null }>
    expect(runs.find((r) => r.id === r1.runId)?.reversedAt).toBeTruthy()
    // … and run again: the same split, nothing allocated twice.
    const r2 = ok(await fin.post(`/allocations/rules/${rule.id}/run`, { periodStart: '2026-10-01', periodEnd: '2026-10-31' }), 201)
    st.run2 = r2.runId
    expect(r2.totalAmountCents).toBe(st.rentCents)
    expect(split(await tagged(A, '6010', '2026-10-01', '2026-10-31'))).toEqual(want)
    expect(await sim.ledger.balanceOf(A, '6010')).toBe(st.rentCents! + 1_000_000)
    await sim.ledger.assertBalanced(A)
  }, 60_000)

  it('2 Nov: the CEO closes October — blocks need acknowledging, the trial balance never', async () => {
    const A = sim.A
    sim.clock.at('2026-11-02', '10:00')
    const ceo = sim.as(sim.ceo, A)
    const fin = sim.as(A.finance, A)
    const state = ok(await fin.get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    const checks = state.checks as Array<{ key: string; severity: string; overridable: boolean; title: string; count?: number }>
    const blocks = checks.filter((c) => c.severity === 'block')
    expect(blocks.length, `October has blocks to acknowledge: ${JSON.stringify(checks.map((c) => [c.key, c.severity]))}`).toBeGreaterThan(0)
    expect(blocks.find((b) => b.key === 'trial_balance'), 'the trial balance balances').toBeUndefined()
    expect(blocks.filter((b) => !b.overridable).map((b) => b.key), 'every October block can be closed over by the CEO').toEqual([])
    expect(checks.find((c) => c.key === 'posting_failed'), 'the re-posted till close left no refused posting open').toBeUndefined()
    expect(checks.find((c) => c.key === 'unposted_shifts')).toBeUndefined()
    st.blockKeys = blocks.map((b) => b.key)

    expect((await fin.post('/accounting/period-close', { lockedThrough: '2026-10-31' })).statusCode, 'finance cannot close').toBe(403)
    const bare = await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31' })
    expect(errCode(bare), bare.body).toBe('CLOSE_NOT_READY')
    expect(bare.statusCode).toBe(409)
    const tb = await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31', acknowledge: { keys: [...st.blockKeys, 'trial_balance'], reason: 'Closing over everything for the simulation' } })
    expect(errCode(tb)).toBe('NOT_OVERRIDABLE')
    const shortReason = await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31', acknowledge: { keys: st.blockKeys, reason: 'ok' } })
    expect(errCode(shortReason)).toBe('OVERRIDE_REASON_REQUIRED')
    // Part of the blocks acknowledged is still refused.
    if (st.blockKeys.length > 1) {
      expect(errCode(await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31', acknowledge: { keys: st.blockKeys.slice(1), reason: 'Partial acknowledgement for the simulation' } }))).toBe('CLOSE_NOT_READY')
    }
    expect(errCode(await ceo.post('/accounting/period-close', { lockedThrough: '2026-11-02', acknowledge: { keys: st.blockKeys, reason: 'Closing through today by mistake' } }))).toBe('LOCK_IN_FUTURE')
    expect(await sim.prisma.periodLock.count({ where: { tenantId: A.tenantId } }), 'nothing closed by the refusals').toBe(0)

    const closed = ok(await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31', note: 'October 2026', acknowledge: { keys: st.blockKeys, reason: 'Night audits and card payouts are run in the sales simulation; books reviewed' } }), 201)
    expect((closed.overrides as Array<{ key: string }>).map((o) => o.key).sort()).toEqual([...st.blockKeys].sort())
    expect(closed.overrideReason).toMatch(/books reviewed/)
    expect((await sim.ledger.openFlags(A, 'period_close_override')).length).toBe(1)

    // B's books are untouched by A's close.
    const bState = ok(await sim.as(sim.B.finance, sim.B).get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    expect(bState.lockedThrough, 'B is not closed').toBeNull()
  }, 180_000)

  it('2 Nov (cont.): closed October refuses finance; the CEO reopens, posts and closes again', async () => {
    const A = sim.A
    const ceo = sim.as(sim.ceo, A)
    const fin = sim.as(A.finance, A)
    const lateFee = (who: string) => manual(A, `Late October courier (${who})`, '2026-10-20', [
      { code: '6175', type: 'debit', cents: 120_000 }, { code: '1010', type: 'credit', cents: 120_000 },
    ])
    expect(errCode(await fin.post('/accounting/journal', lateFee('finance'))), 'closed month').toBe('PERIOD_LOCKED')
    expect(errCode(await ceo.post('/accounting/journal', lateFee('ceo'))), 'closed for the CEO too').toBe('PERIOD_LOCKED')
    // An allocation run reversal dated in the closed month would need the CEO; finance's November work goes on.
    ok(await fin.post('/accounting/journal', manual(A, 'November courier', '2026-11-01', [
      { code: '6175', type: 'debit', cents: 80_000 }, { code: '1010', type: 'credit', cents: 80_000 },
    ])), 201)
    expect((await fin.post('/accounting/period-close/reopen', { reason: 'finance wants to reopen' })).statusCode).toBe(403)

    ok(await ceo.post('/accounting/period-close/reopen', { reason: 'A courier bill for 20 Oct arrived late' }), 200)
    expect(await sim.prisma.periodLock.count({ where: { tenantId: A.tenantId } })).toBe(0)
    const st2 = ok(await fin.get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    expect(st2.reopenedThrough, 'the reopened window is shown').toBeTruthy()
    // Finance: refused in the reopened window, for a post, an edit and a cancel.
    expect(errCode(await fin.post('/accounting/journal', lateFee('finance')))).toBe('CEO_ONLY_CLOSED_BOOKS')
    expect(errCode(await fin.post(`/accounting/journal/${st.jrEntryId}/reverse`, { reason: 'wrong brand on it' }))).toBe('CEO_ONLY_CLOSED_BOOKS')
    expect(errCode(await fin.post(`/allocations/runs/${st.run2}/reverse`, { reason: 'Weights to be re-checked once more' }))).toBe('CEO_ONLY_CLOSED_BOOKS')
    expect(errCode(await fin.post('/reconciliation/backfill-unposted', { dryRun: false }))).toBe('REOPENED_BOOKS_CEO_ONLY')
    // The CEO posts the late bill on its own day.
    const ceoJe = ok(await ceo.post('/accounting/journal', lateFee('ceo')), 201)
    st.ceoReopenedJe = ceoJe.id
    expect(await sim.ledger.balanceOf(A, '6175', '2026-10-31')).toBe(120_000)
    // …and closes again (the blocks are the same; the TB still balances).
    const again = ok(await ceo.get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    const keys = (again.checks as Array<{ key: string; severity: string }>).filter((c) => c.severity === 'block').map((c) => c.key)
    expect(keys).not.toContain('trial_balance')
    ok(await ceo.post('/accounting/period-close', { lockedThrough: '2026-10-31', note: 'October 2026 (re-closed)', acknowledge: { keys, reason: 'Re-closed after booking the late courier bill' } }), 201)
    const st3 = ok(await fin.get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    expect(st3.reopenedThrough, 'the reopened window is forgotten once closed again').toBeNull()
    expect(new Date(st3.lockedThrough).toISOString()).toBe(new Date('2026-10-31T23:59:59.999+05:00').toISOString())
    expect(errCode(await fin.post('/accounting/journal', lateFee('finance')))).toBe('PERIOD_LOCKED')
    // November is finance's again.
    ok(await fin.post('/accounting/journal', manual(A, 'November courier 2', '2026-11-02', [
      { code: '6175', type: 'debit', cents: 40_000 }, { code: '1010', type: 'credit', cents: 40_000 },
    ])), 201)
    expect((await fin.post('/reconciliation/backfill-unposted', { dryRun: false })).statusCode).toBe(200)
    await sim.ledger.assertBalanced(A)
  }, 180_000)

  it('Company B: 404 on A\'s books; B\'s month stays open and is closed on its own', async () => {
    const A = sim.A, B = sim.B
    const finB = sim.as(B.finance, B)
    expect((await finB.post(`/accounting/journal/${st.ceoReopenedJe}/reverse`, { reason: 'not mine to touch' })).statusCode).toBe(404)
    expect((await finB.post(`/accounting/journal/${st.firstJe}/amend`, { ...manual(B, 'x', '2026-10-20', [
      { code: '6081', type: 'debit', cents: 1 }, { code: B.banks.main.code, type: 'credit', cents: 1 },
    ]), reason: 'not mine to edit' })).statusCode).toBe(404)
    const ledgerB = ok(await finB.get(`/accounting/ledger?id=${st.jrEntryId}`), 200)
    expect(ledgerB.data).toHaveLength(0)
    expect((await finB.post(`/accounting/journal-requests/${st.jrId}/approve`, {})).statusCode).toBeGreaterThanOrEqual(403)
    // B's finance posts into October — B is open while A is closed.
    const bJe = ok(await finB.post('/accounting/journal', manual(B, 'Viva courier October', '2026-10-20', [
      { code: '6175', type: 'debit', cents: 90_000 }, { code: '1010', type: 'credit', cents: 90_000 },
    ])), 201)
    expect(bJe.tenantId).toBe(B.tenantId)
    // The CEO closes B through 30 September (nothing to acknowledge beyond what is there) — A is unaffected.
    const ceoB = sim.as(sim.ceo, B)
    const bChecks = ok(await ceoB.get('/accounting/period-close?lockedThrough=2026-10-31'), 200)
    const bKeys = (bChecks.checks as Array<{ key: string; severity: string; overridable: boolean }>).filter((c) => c.severity === 'block')
    expect(bKeys.filter((b) => !b.overridable).map((b) => b.key)).toEqual([])
    ok(await ceoB.post('/accounting/period-close', { lockedThrough: '2026-10-31', acknowledge: { keys: bKeys.map((b) => b.key), reason: 'B October closed for the books simulation' } }), 201)
    const locks = await sim.prisma.periodLock.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })
    expect(locks.filter((l) => l.tenantId === A.tenantId)).toHaveLength(1)
    expect(locks.filter((l) => l.tenantId === B.tenantId)).toHaveLength(1)
    // A reopen in B leaves A closed.
    ok(await ceoB.post('/accounting/period-close/reopen', { reason: 'B reopened to check independence' }), 200)
    expect(await sim.prisma.periodLock.count({ where: { tenantId: A.tenantId } })).toBe(1)
    expect(errCode(await sim.as(A.finance, A).post('/accounting/journal', manual(A, 'still closed', '2026-10-20', [
      { code: '6175', type: 'debit', cents: 1_000 }, { code: '1010', type: 'credit', cents: 1_000 },
    ])))).toBe('PERIOD_LOCKED')
    expect(errCode(await finB.post('/accounting/journal', manual(B, 'B reopened', '2026-10-21', [
      { code: '6175', type: 'debit', cents: 1_000 }, { code: '1010', type: 'credit', cents: 1_000 },
    ])))).toBe('CEO_ONLY_CLOSED_BOOKS')
    await sim.ledger.assertBalanced(B)
  }, 180_000)

  it('Reports at month end (each company): TB net per account, BS balances, P&L = BS year to date, cash flow ties', async () => {
    for (const co of [sim.A, sim.B]) {
      const fin = sim.as(co.finance, co)
      const tb = ok(await fin.get('/accounting/trial-balance?asOf=2026-10-31'), 200)
      const rows = tb.rows as Array<{ tenantId: string | null; code: string; debitCents: number; creditCents: number }>
      expect(rows.length).toBeGreaterThan(5)
      expect(rows.every((r) => r.tenantId === co.tenantId), `${co.key} TB lists only its own company`).toBe(true)
      expect(rows.filter((r) => r.debitCents !== 0 && r.creditCents !== 0).map((r) => r.code), `${co.key} one net figure per account`).toEqual([])
      expect(rows.filter((r) => r.debitCents === 0 && r.creditCents === 0).map((r) => r.code), `${co.key} no zero rows`).toEqual([])
      expect(rows.every((r) => r.debitCents >= 0 && r.creditCents >= 0)).toBe(true)
      expect(tb.totals.differenceCents).toBe(0)
      expect(tb.totals.debitCents).toBe(tb.totals.creditCents)
      // 6081 netted to zero by the edit and cancel: not listed.
      if (co.key === 'A') expect(rows.find((r) => r.code === '6081')).toBeUndefined()
      // The TB agrees with the raw ledger, account by account.
      const raw = await sim.ledger.balances(co, '2026-10-31')
      for (const r of rows) expect(r.debitCents - r.creditCents, `${co.key} ${r.code}`).toBe(raw.get(r.code) ?? 0)
      for (const [code, bal] of raw) if (bal !== 0) expect(rows.some((r) => r.code === code), `${co.key} ${code} listed`).toBe(true)
      // Year basis: still one net figure per account and balanced.
      const tby = ok(await fin.get('/accounting/trial-balance?asOf=2026-10-31&basis=year'), 200)
      expect(tby.totals.differenceCents).toBe(0)
      expect((tby.rows as Array<{ debitCents: number; creditCents: number }>).filter((r) => (r.debitCents === 0) === (r.creditCents === 0))).toEqual([])

      const bs = ok(await fin.get('/accounting/balance-sheet?asOf=2026-10-31'), 200)
      expect(bs.totals.differenceCents, `${co.key} balance sheet`).toBe(0)
      expect(bs.totals.assetsCents).toBe(bs.totals.liabilitiesCents + bs.totals.equityCents + bs.totals.currentEarningsCents)
      const fy = (bs.earningsByCompany as Array<{ tenantId: string; fiscalYear: { start: string }; currentYearEarningsCents: number }>).find((e) => e.tenantId === co.tenantId)!
      expect(fy.fiscalYear.start).toBe('2026-07-01')
      const pl = ok(await fin.get(`/accounting/pl-ledger?dateFrom=${fy.fiscalYear.start}&dateTo=2026-10-31`), 200)
      expect(pl.totals.netProfitCents, `${co.key} P&L = BS profit for the year to date`).toBe(fy.currentYearEarningsCents)
      expect(pl.totals.revenueCents).toBeGreaterThan(0)
      if (co.key === 'A') {
        expect(pl.totals.netProfitCents).toBe(-(raw.get('4001') ?? 0) - (raw.get('4004') ?? 0) - (raw.get('4100') ?? 0) - [...raw].filter(([c]) => /^[4]/.test(c) && !['4001', '4004', '4100'].includes(c)).reduce((s, [, v]) => s + v, 0)
          - [...raw].filter(([c]) => /^[5-7]/.test(c)).reduce((s, [, v]) => s + v, 0))
      }

      const cf = ok(await fin.get('/accounting/cash-flow?dateFrom=2026-10-01&dateTo=2026-10-31'), 200)
      const byAcc = cf.byCashAccount as Array<{ code: string; netCents: number; inflowCents: number; outflowCents: number }>
      expect(byAcc.length).toBeGreaterThan(0)
      const before = await sim.ledger.balances(co, '2026-09-30')
      for (const a of byAcc) expect(a.netCents, `${co.key} cash ${a.code} movement`).toBe((raw.get(a.code) ?? 0) - (before.get(a.code) ?? 0))
      expect(cf.totals.netCents).toBe(byAcc.reduce((s, a) => s + a.netCents, 0))
      await sim.ledger.assertBalanced(co)
    }
  }, 120_000)
})
