// BOOKS-06 — BIGINT money columns (migration 20261012140000_money_bigint).
//
// The ledger, AP, AR, bank lines and balances, exception amounts, allocation
// runs, fixed assets, capex/opex and Customer.totalSpentCents are BIGINT paisa.
// lib/money.ts is the one boundary: moneyAsNumbers (a Prisma query extension
// on the base client, under the RLS extension) returns every BIGINT as a JS
// number on `prisma`, `serviceClient` and every transaction client, so JSON
// stays numbers. One BIGINT amount ≤ MAX_MONEY_CENTS (PKR 900bn); INT4 columns
// (till, orders, payments, per-unit stock cost) ≤ INT4_MAX_CENTS — above
// either is 422 AMOUNT_TOO_LARGE.
//
//   (1) the boundary: constants, toCents/sumCents, the JSON net, the exact
//       set of BIGINT fields (DMMF canary), numbers through every read shape on
//       both clients, Json never walked, raw SQL left alone (the documented rule)
//   (2) a PKR 25m manual journal: posts, flags exactly, reports and CSVs exact,
//       reverses; above the cap 422; engine totals past 2^53 refused; company B
//       sees none of it
//   (3) a PKR 30m supplier bill and its payment (a stock purchase received at
//       the dock — Dr 1210 / Cr 2015 — then billed against its receipt,
//       clearing 2015; non-stock lines name their 6xxx account and stay at the
//       INT4 cap — capital spend is CapEx),
//       AP aging, the supplier opening balance; company B 404s
//   (4) a PKR 25m bank statement line and its adjustment; company B 404s
//   (5) group-scale AR, a fixed asset, a customer's lifetime spend
//   (6) a lot's per-unit cost stays INT4: a bill whose price on a tiny
//       quantity would re-price its lot past PKR 21,474,836.47 is 422 and
//       writes nothing (FIFO lots, wave B — the moving average is gone)
//   (7) source guard: no bigint literals, BigInt() or typeof 'bigint' in src/
//   (8) an INT4 money column left INT4 keeps its guard: a head-office
//       contribution above PKR 21,474,836.47 a month is 422, not a raw 500
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { prisma as appPrisma, serviceClient as prisma } from '../src/lib/prisma.js'
import {
  INT4_MAX_CENTS, MAX_MONEY_CENTS, toCents, sumCents, convertModelResult,
} from '../src/lib/money.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { contributionRoutes } from '../src/modules/positions/contributions.js'
import { createBill, voidBill } from '../src/modules/procurement/service.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { flagException } from '../src/lib/exceptions.js'
import { recomputeCustomerRollups } from '../src/lib/customerRollups.js'
import { findCustomerByPhone } from '../src/lib/customer-channels.js'

const RUN = Math.random().toString(36).slice(2, 8)
/** Today in PKT, YYYY-MM-DD. */
const pktToday = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
let tenantA: string, tenantB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@bigint.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const accountId = async (tenantId: string, code: string) =>
  (await prisma.account.findFirstOrThrow({ where: { tenantId, code } })).id

/** Σ debits − Σ credits over every journal line of a company (0 = balanced). */
async function imbalance(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}

/** Net debit on one account code of a company (optionally over some references). */
async function netDebit(tenantId: string, code: string, refs?: string[]): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code }, journalEntry: { tenantId, ...(refs && { reference: { in: refs } }) } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Bigint A', slug: `bigint-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Bigint B', slug: `bigint-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('finB', 'finance', tenantB)
  await mkUser('ceoAB', 'admin', tenantA) // acting as A, also a member of B
  await prisma.tenantMember.create({ data: { tenantId: tenantB, userId: users.ceoAB!.id } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.register(receivableRoutes, { prefix: '/accounting/receivables' })
  await app.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
  await app.register(contributionRoutes, { prefix: '/positions/contributions' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

// ─── (1) The boundary ───────────────────────────────────────────────────────

const EXPECTED_BIGINT_FIELDS = [
  'Customer.totalSpentCents',
  'Supplier.openingBalanceCents',
  'PurchaseOrder.totalCents',
  'SupplierBill.subtotalCents', 'SupplierBill.taxCents', 'SupplierBill.totalCents', 'SupplierBill.whtCents', 'SupplierBill.paidCents',
  'SupplierBillLine.unitCostCents', 'SupplierBillLine.lineTotalCents',
  'SupplierPayment.amountCents', 'SupplierPayment.appliedCents',
  'SupplierPaymentApplication.amountAppliedCents',
  'JournalLine.amountCents',
  'BankStatementImport.openingBalanceCents', 'BankStatementImport.closingBalanceCents',
  'BankStatementLine.amountCents',
  // A bank SMS credit is a bank-statement-class amount (Raast QR, 2026-10-12);
  // the till-side RaastReceipt amounts stay INT4 like every per-ticket figure.
  'BankSmsAlert.amountCents',
  'CostAllocationRun.totalAmountCents',
  'CapexProject.budgetEnvelopeCents', 'CapexProject.totalAskCents', 'CapexProject.consultantFeesCents', 'CapexProject.taxCents',
  'CapexLine.unitCostCents', 'CapexLine.quotedCents', 'CapexLine.negotiatedCents', 'CapexLine.paidCents',
  'CapexQuote.totalCents',
  'OpexCategory.budgetMonthlyCents',
  'OpexLine.amountCents',
  'OpexPayment.expectedCents', 'OpexPayment.actualCents',
  'CapexPayment.amountCents', 'CapexPayment.paidAmountCents',
  'ExceptionFlag.amountCents',
  'FixedAsset.costCents', 'FixedAsset.salvageCents', 'FixedAsset.disposalProceedsCents',
  'FixedAssetDepreciation.amountCents',
  'ReceivableInvoice.amountCents', 'ReceivableInvoice.taxCents', 'ReceivableInvoice.paidCents',
  // Finance gaps wave A (2026-10-13): credit notes, customer WHT, supplier credit notes, tax payments.
  'ReceivableInvoice.creditedCents', 'ReceivableInvoice.whtCents',
  'SupplierBill.creditedCents', 'SupplierCreditApplication.amountCents',
  'SalesTaxPayment.outputSetOffCents', 'SalesTaxPayment.inputSetOffCents', 'SalesTaxPayment.paidCents',
  'ReceivablePayment.amountCents',
  // Finance gaps wave B (2026-10-14, migration 20261014090000): company-level
  // money. FIFO stock lots and their movements, GRNI, count and prep values
  // (food cost); the fixed-asset register v2 (events, tax years, runs);
  // prepaid releases; CapEx / OpEx tax, WHT and deposits; customer-withheld
  // sales tax; inter-company transfers; card payouts; on-account clients and
  // bad-debt write-offs. Per-ticket, per-unit and per-box amounts stay INT4.
  'StockLot.valueInCents', 'StockLot.remainingValueCents',
  'StockMovement.valueCents', 'StockMovement.shortfallValueCents',
  'GrniMatch.grniCents', 'GrniMatch.priceDiffCents', 'GrniMatch.absorbedCents', 'GrniMatch.usedCents',
  'PhysicalCountLine.valueCents', 'PrepBatch.drawValueCents',
  'FixedAsset.originalCostCents', 'FixedAsset.inputTaxCents', 'FixedAsset.carriedAccumulatedCents',
  'FixedAssetEvent.amountCents', 'FixedAssetEvent.costOutCents', 'FixedAssetEvent.accumOutCents',
  'FixedAssetTaxYear.openingWdvCents', 'FixedAssetTaxYear.additionsCents', 'FixedAssetTaxYear.initialAllowanceCents',
  'FixedAssetTaxYear.depreciationCents', 'FixedAssetTaxYear.disposalProceedsCents', 'FixedAssetTaxYear.closingWdvCents',
  'FixedAssetRun.chargedCents', 'PrepaidRelease.amountCents',
  'CapexLine.inputTaxCents', 'CapexPayment.whtCents', 'CapexPayment.depositReturnedCents', 'CapexPayment.depositForfeitedCents',
  'OpexPayment.inputTaxCents', 'OpexPayment.whtCents',
  'SalesTaxPayment.customerWithheldSetOffCents', 'IntercompanyTransfer.amountCents',
  'CardSettlement.grossCents', 'CardSettlement.feeCents', 'CardSettlement.feeTaxCents', 'CardSettlement.netCents',
  'CardSettlementDay.grossCents',
  'CustomerAccount.creditLimitCents', 'CustomerAccount.requestedCreditLimitCents',
  'ReceivableInvoice.writtenOffCents', 'ReceivableWriteOff.amountCents', 'ReceivableWriteOff.recoveredCents',
].sort()

describe('(1) the money boundary', () => {
  it('constants: one BIGINT ceiling (PKR 900bn, exact for sums of 100) and one INT4 ceiling', () => {
    expect(INT4_MAX_CENTS).toBe(2_147_483_647)
    expect(MAX_MONEY_CENTS).toBe(9e13)
    expect(MAX_MONEY_CENTS * 100).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER)
  })

  it('toCents / sumCents convert exactly and refuse to round', () => {
    expect(toCents(2_500_000_000n)).toBe(2_500_000_000)
    expect(toCents(2_500_000_000)).toBe(2_500_000_000)
    expect(toCents(null)).toBeNull()
    expect(() => toCents(2n ** 60n)).toThrow(expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE', statusCode: 500 }))
    expect(sumCents(null)).toBe(0)
    expect(sumCents(undefined)).toBe(0)
    expect(sumCents(7n)).toBe(7)
  })

  it('the JSON safety net writes a bigint as a JSON number, and throws beyond 2^53', () => {
    expect(JSON.stringify({ a: 2_500_000_000n })).toBe('{"a":2500000000}')
    expect(() => JSON.stringify({ a: 2n ** 60n })).toThrow(expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }))
  })

  it('DMMF canary: the BIGINT fields are exactly the 92 money fields', () => {
    const got = Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.filter((f) => f.type === 'BigInt').map((f) => `${m.name}.${f.name}`)).sort()
    expect(got).toEqual(EXPECTED_BIGINT_FIELDS)
    expect(got).toHaveLength(92)
  })

  describe('a PKR 25m entry reads back as an exact JS number through every shape, on both clients', () => {
    let entryId: string, bankId: string
    const AMT = 2_500_000_000
    beforeAll(async () => {
      const r = await postJournalEntry({
        tenantId: tenantB, sourceType: 'test.boundary', sourceId: RUN, description: 'boundary',
        lines: [
          { accountCode: '1020', type: 'debit',  amountCents: AMT },
          { accountCode: '3010', type: 'credit', amountCents: AMT },
        ],
      })
      entryId = r.entryId!
      bankId = await accountId(tenantB, '1020')
    })
    const isExact = (v: unknown) => { expect(typeof v).toBe('number'); expect(v).toBe(AMT) }

    for (const [label, client] of [['prisma', appPrisma], ['serviceClient', prisma]] as const) {
      it(`${label}: findFirst, include, a non-BIGINT model selecting the relation, fluent, aggregate, groupBy`, async () => {
        isExact((await client.journalLine.findFirstOrThrow({ where: { journalEntryId: entryId, type: 'debit' } })).amountCents)
        const withLines = await client.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: true } })
        withLines.lines.forEach((l) => isExact(l.amountCents))
        const acc = await client.account.findUniqueOrThrow({ where: { id: bankId }, select: { journalLines: { where: { journalEntryId: entryId }, select: { amountCents: true } } } })
        isExact(acc.journalLines[0]!.amountCents)
        const fluent = await client.journalEntry.findUnique({ where: { id: entryId } }).lines()
        fluent!.forEach((l) => isExact(l.amountCents))
        const agg = await client.journalLine.aggregate({ where: { journalEntryId: entryId, type: 'debit' }, _sum: { amountCents: true }, _max: { amountCents: true } })
        isExact(agg._sum.amountCents)
        isExact(agg._max.amountCents)
        const grp = await client.journalLine.groupBy({ by: ['type'], where: { journalEntryId: entryId }, _sum: { amountCents: true } })
        grp.forEach((g) => isExact(g._sum.amountCents))
      })

      it(`${label}: $transaction(fn) and $transaction([...])`, async () => {
        const viaFn = await client.$transaction(async (tx) => tx.journalLine.findMany({ where: { journalEntryId: entryId } }))
        viaFn.forEach((l) => isExact(l.amountCents))
        const [rows, agg] = await client.$transaction([
          client.journalLine.findMany({ where: { journalEntryId: entryId } }),
          client.journalLine.aggregate({ where: { journalEntryId: entryId, type: 'credit' }, _sum: { amountCents: true } }),
        ])
        rows.forEach((l) => isExact(l.amountCents))
        isExact(agg._sum.amountCents)
      })
    }

    it('a null BIGINT stays null; writes take plain numbers (increment included)', async () => {
      const f = await prisma.exceptionFlag.create({ data: { tenantId: tenantB, kind: 'test', title: 't', description: 'd', amountCents: null } })
      expect(f.amountCents).toBeNull()
      const up = await prisma.exceptionFlag.update({ where: { id: f.id }, data: { amountCents: AMT } })
      isExact(up.amountCents)
      const inc = await prisma.exceptionFlag.update({ where: { id: f.id }, data: { amountCents: { increment: AMT } } })
      expect(inc.amountCents).toBe(2 * AMT)
    })

    it('raw SQL is NOT converted (the documented rule): SUM(int8) is a Decimal; ::bigint through toCents is the number', async () => {
      const [raw] = await prisma.$queryRaw<Array<{ s: unknown }>>`SELECT SUM("amountCents") AS s FROM journal_lines WHERE "journalEntryId" = ${entryId}`
      expect(typeof raw!.s).not.toBe('number')
      const [cast] = await prisma.$queryRaw<Array<{ s: bigint }>>`SELECT SUM("amountCents")::bigint AS s FROM journal_lines WHERE "journalEntryId" = ${entryId}`
      expect(toCents(cast!.s)).toBe(2 * AMT)
    })
  })

  it('Json is never walked: only BIGINT scalar keys and relation keys are converted', () => {
    const blocks = [{ type: 'section', fields: { n: 5n, nested: { deep: 7n } } }]
    const layout = { id: 'x', slug: 'servd:home', blocks, settings: { ab: { splitPct: 50 } } }
    const out = convertModelResult('SiteLayout', layout)
    expect(out).toBe(layout)
    expect(out.blocks).toBe(blocks)
    expect(typeof (out.blocks[0]!.fields as { n: unknown }).n).toBe('bigint')
    // A BIGINT model: its money field converts, its Json does not.
    const cust = { id: 'c', totalSpentCents: 3_000_000_000n, preferences: { big: 1n } }
    convertModelResult('Customer', cust)
    expect(cust.totalSpentCents).toBe(3_000_000_000)
    expect(typeof cust.preferences.big).toBe('bigint')
    // Relations are followed by target model: a bill's supplier's opening balance.
    const bill = { id: 'b', totalCents: 5n, supplier: { id: 's', openingBalanceCents: 6n, notes: { x: 1n } }, lines: [{ lineTotalCents: 7n }] }
    convertModelResult('SupplierBill', bill)
    expect([bill.totalCents, bill.supplier.openingBalanceCents, bill.lines[0]!.lineTotalCents]).toEqual([5, 6, 7])
    expect(typeof bill.supplier.notes.x).toBe('bigint')
  })

  it('a real SiteLayout read with select comes back unchanged', async () => {
    const blocks = [{ type: 'section', variant: 'servd.nav', fields: { items: [{ label: 'Home', href: '/home' }] } }]
    const row = await prisma.siteLayout.create({ data: { slug: `test:bigint-${RUN}`, tenantId: tenantB, blocks } })
    const read = await prisma.siteLayout.findUniqueOrThrow({ where: { id: row.id }, select: { slug: true, blocks: true, tenantId: true } })
    expect(read.blocks).toEqual(blocks)
    expect(read.tenantId).toBe(tenantB)
  })

  it('flagException rounds a fractional amount and keeps it; out of range → null (the flag still saves)', async () => {
    const a = await flagException({ tenantId: tenantB, kind: 'test_round', title: 'r', description: 'd', amountCents: 1234.6 })
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: a!.id } })).amountCents).toBe(1235)
    const b = await flagException({ tenantId: tenantB, kind: 'test_round', title: 'r', description: 'd', amountCents: MAX_MONEY_CENTS + 1 })
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: b!.id } })).amountCents).toBeNull()
    const c = await flagException({ tenantId: tenantB, kind: 'test_round', title: 'r', description: 'd', amountCents: Number.NaN })
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: c!.id } })).amountCents).toBeNull()
  })

  it('raw-SQL customer lookup re-reads through the boundary: totalSpentCents is a number', async () => {
    const phone = `0300${Math.floor(1_000_000 + Math.random() * 8_999_999)}`
    await prisma.customer.create({ data: { name: 'Corporate', phone, totalSpentCents: 3_000_000_000 } })
    const c = await findCustomerByPhone(phone)
    expect(typeof c!.totalSpentCents).toBe('number')
    expect(c!.totalSpentCents).toBe(3_000_000_000)
  })
})

// ─── (2) PKR 25m manual journal ─────────────────────────────────────────────

describe('(2) a PKR 25m manual journal entry', () => {
  const AMT = 2_500_000_000
  let entryId: string
  let tbBefore: { debit1020: number; debitCents: number; creditCents: number }

  async function tb(who: string, tenantId: string) {
    const body = (await call(who, 'GET', '/accounting/trial-balance')).json() as {
      rows: Array<{ tenantId: string; code: string; debitCents: number; creditCents: number }>
      totals: { debitCents: number; creditCents: number }
    }
    const row = body.rows.find((r) => r.tenantId === tenantId && r.code === '1020')
    return { debit1020: (row?.debitCents ?? 0) - (row?.creditCents ?? 0), debitCents: body.totals.debitCents, creditCents: body.totals.creditCents }
  }

  it('posts (201) with the exact amount in the raw JSON, and the review flag carries it', async () => {
    tbBefore = await tb('ceoA', tenantA)
    const r = await call('ceoA', 'POST', '/accounting/journal', {
      description: 'Capital injection',
      lines: [
        { accountId: await accountId(tenantA, '1020'), type: 'debit',  amountCents: AMT },
        { accountId: await accountId(tenantA, '3010'), type: 'credit', amountCents: AMT },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.body).toContain('"amountCents":2500000000')
    entryId = r.json().id
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'manual_journal', entityId: entryId } })
    expect(flag.amountCents).toBe(AMT)
    expect(flag.severity).toBe('high')
  })

  it('the trial balance and balance sheet are exact and balanced; the CSVs print PKR 25,000,000.00', async () => {
    const after = await tb('ceoA', tenantA)
    expect(after.debit1020 - tbBefore.debit1020).toBe(AMT)
    expect(after.debitCents).toBe(after.creditCents)
    expect((await call('ceoA', 'GET', '/accounting/trial-balance?format=csv')).body).toContain('25,000,000.00')
    const today = pktToday()
    const ledgerCsv = await call('ceoA', 'GET', `/accounting/ledger?format=csv&dateFrom=${today}&dateTo=${today}`)
    expect(ledgerCsv.statusCode).toBe(200)
    expect(ledgerCsv.body).toContain('25,000,000.00')
    const bs = (await call('ceoA', 'GET', '/accounting/balance-sheet')).json() as { totals: { differenceCents: number; assetsCents: number } }
    expect(bs.totals.differenceCents).toBe(0)
    expect(typeof bs.totals.assetsCents).toBe('number')
  })

  it('company B cannot see or reverse it, and its own trial balance is untouched', async () => {
    const tbB = await tb('ceoB', tenantB)
    const ledger = await call('ceoB', 'GET', `/accounting/ledger?id=${entryId}`)
    expect(ledger.body).not.toContain(entryId)
    expect((await call('ceoB', 'POST', `/accounting/journal/${entryId}/reverse`, { reason: 'not mine to reverse' })).statusCode).toBe(404)
    expect(await tb('ceoB', tenantB)).toEqual(tbB)
  })

  it('reverses (201): the reversal flag is exact and the trial balance returns to where it was', async () => {
    const r = await call('ceoA', 'POST', `/accounting/journal/${entryId}/reverse`, { reason: 'posted to the wrong account' })
    expect(r.statusCode, r.body).toBe(201)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'manual_journal', entityId: r.json().id } })
    expect(flag.amountCents).toBe(AMT)
    const after = await tb('ceoA', tenantA)
    expect(after.debit1020).toBe(tbBefore.debit1020)
    expect(after.debitCents).toBe(after.creditCents)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('above PKR 900bn is 422 and saves nothing; exactly PKR 900bn posts', async () => {
    const before = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const lines = (amt: number) => Promise.all([accountId(tenantA, '1020'), accountId(tenantA, '3010')])
      .then(([d, c]) => [{ accountId: d, type: 'debit', amountCents: amt }, { accountId: c, type: 'credit', amountCents: amt }])
    const tooBig = await call('ceoA', 'POST', '/accounting/journal', { description: 'typo', lines: await lines(MAX_MONEY_CENTS + 1) })
    expect(tooBig.statusCode).toBe(422)
    expect(tooBig.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(tooBig.json().error.message).toMatch(/PKR 900,000,000,000\.00/)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(before)
    const atCap = await call('ceoA', 'POST', '/accounting/journal', { description: 'at the cap', lines: await lines(MAX_MONEY_CENTS) })
    expect(atCap.statusCode, atCap.body).toBe(201)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('the engine refuses an entry whose totals pass 2^53 (101 maximal lines a side) with 422', async () => {
    const side = (type: 'debit' | 'credit', code: string) => Array.from({ length: 101 }, () => ({ accountCode: code, type, amountCents: MAX_MONEY_CENTS }))
    await expect(postJournalEntry({
      tenantId: tenantB, sourceType: 'test.unsafe', sourceId: RUN, description: 'unsafe totals',
      lines: [...side('debit', '1020'), ...side('credit', '3010')],
    })).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
  })
})

// ─── (3) PKR 30m supplier bill and payment ──────────────────────────────────

describe('(3) a PKR 30m supplier bill and its payment', () => {
  let supA: string, itemA: string, billId: string, billDue: number
  beforeAll(async () => {
    supA  = (await prisma.supplier.create({ data: { name: `Grain Co ${RUN}`, tenantId: tenantA } })).id
    itemA = (await prisma.inventoryItem.create({ data: { name: `Rice ${RUN}`, unit: 'kg', tenantId: tenantA } })).id
  })

  it('PO: two stock lines of PKR 15m each → 201, totalCents 3,000,000,000', async () => {
    const r = await call('mgrA', 'POST', '/procurement/purchase-orders', {
      supplierId: supA, lines: [
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
        { inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: 1_500_000_000 },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().totalCents).toBe(3_000_000_000)
  })

  it('PO: a unit cost above INT4 is 422 (PKR 21,474,836.47); a total above PKR 900bn is 422', async () => {
    const unit = await call('mgrA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 1, unitCostCents: INT4_MAX_CENTS + 1 }] })
    expect(unit.statusCode).toBe(422)
    expect(unit.json().error.message).toMatch(/PKR 21,474,836\.47/)
    const total = await call('mgrA', 'POST', '/procurement/purchase-orders', { supplierId: supA, lines: [{ inventoryItemId: itemA, quantityOrdered: 100_000, unitCostCents: 1_000_000_000 }] })
    expect(total.statusCode).toBe(422)
    expect(total.json().error.code).toBe('AMOUNT_TOO_LARGE')
  })

  it('bill: a PKR 30m stock purchase (2 × PKR 15m of an item, received first) + PKR 5.4m tax → 201, exact numbers, Dr 2015 / GST input, balanced', async () => {
    const rcv = await receiveGoods({
      actor: { id: users.mgrA!.id, role: 'manager' }, supplierId: supA, photoUrl: 'https://cdn.example/grn.jpg',
      lines: [{ inventoryItemId: itemA, quantityReceived: 2, unitCostCents: 1_500_000_000 }],
    })
    expect(await netDebit(tenantA, '1210', [`procurement.receipt:${rcv.receipt.id}`])).toBe(3_000_000_000)
    const r = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `BULK-${RUN}`, billDate: new Date().toISOString(), taxCents: 540_000_000,
      lines: [{ description: 'Bulk rice', inventoryItemId: itemA, receiptLineId: rcv.receipt.lines[0]!.id, quantity: 2, unitCostCents: 1_500_000_000 }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const b = r.json()
    expect(b).toMatchObject({ subtotalCents: 3_000_000_000, taxCents: 540_000_000, totalCents: 3_540_000_000 })
    expect(typeof b.whtCents).toBe('number')
    billId = b.id
    billDue = b.totalCents - b.whtCents
    const ref = `supplier.bill:${billId}`
    // Where it lands, not just that it balances: the goods clear 2015 (the
    // receipt booked them to 1210), the tax to GST input, the supplier (net
    // of WHT) to AP 2010.
    expect(await netDebit(tenantA, '2015', [ref])).toBe(3_000_000_000)
    expect(await netDebit(tenantA, '1320', [ref])).toBe(540_000_000)
    expect(await netDebit(tenantA, '2010', [ref])).toBe(-billDue)
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: ref }, include: { lines: true } })
    const dr = entry.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + toCents(l.amountCents), 0)
    const cr = entry.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + toCents(l.amountCents), 0)
    expect(dr).toBe(cr)
    expect(dr).toBe(3_540_000_000)
  })

  it('bill: non-stock lines stay at the INT4 cap (capital spend is CapEx) — a PKR 30m "Kitchen fit-out" is 422 pointing at CapEx, and so are two PKR 15m ones; nothing is saved or posted', async () => {
    const before = await prisma.supplierBill.count({ where: { supplierId: supA } })
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: tenantA } })
    const one = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `FIT-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ description: 'Kitchen fit-out', quantity: 1, unitCostCents: 3_000_000_000, expenseAccountCode: '6050' }],
    })
    expect(one.statusCode).toBe(422)
    expect(one.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(one.json().error.message).toMatch(/CapEx/)
    expect(one.json().error.message).toMatch(/PKR 21,474,836\.47/)
    const qty = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `FITQ-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ description: 'Chairs', quantity: 200, unitCostCents: 15_000_000, expenseAccountCode: '6050' }],
    })
    expect(qty.statusCode).toBe(422)
    const two = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `FIT2-${RUN}`, billDate: new Date().toISOString(),
      lines: [
        { description: 'Fit-out phase 1', quantity: 1, unitCostCents: 1_500_000_000, expenseAccountCode: '6050' },
        { description: 'Fit-out phase 2', quantity: 1, unitCostCents: 1_500_000_000, expenseAccountCode: '6050' },
      ],
    })
    expect(two.statusCode).toBe(422)
    expect(two.json().error.message).toMatch(/not stock items.*CapEx/)
    expect(await prisma.supplierBill.count({ where: { supplierId: supA } })).toBe(before)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA } })).toBe(entriesBefore)
  })

  it('bill: a non-stock line at exactly the INT4 cap still records (the existing rule, unchanged)', async () => {
    const r = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `SVC-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ description: 'Deep clean', quantity: 1, unitCostCents: INT4_MAX_CENTS, expenseAccountCode: '6040' }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().subtotalCents).toBe(INT4_MAX_CENTS)
    // Void it so the AP-aging test below sees only the bulk bill.
    expect((await call('mgrA', 'POST', `/procurement/bills/${r.json().id}/void`, { reason: 'test' })).statusCode).toBe(200)
  })

  it('bill: a stock-linked line above INT4 is 422; tax above PKR 900bn is 422', async () => {
    const stock = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `STK-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ description: 'steel', inventoryItemId: itemA, quantity: 1, unitCostCents: INT4_MAX_CENTS + 1 }],
    })
    expect(stock.statusCode).toBe(422)
    expect(stock.json().error.message).toMatch(/stock item/)
    const tax = await call('mgrA', 'POST', '/procurement/bills', {
      supplierId: supA, billNumber: `TAX-${RUN}`, billDate: new Date().toISOString(), taxCents: MAX_MONEY_CENTS + 1,
      lines: [{ description: 'x', quantity: 1, unitCostCents: 100, expenseAccountCode: '6040' }],
    })
    expect(tax.statusCode).toBe(422)
    expect(await prisma.supplierBill.count({ where: { supplierId: supA, status: { not: 'void' } } })).toBe(1)
  })

  it('AP aging shows the exact amount due; paying it in full clears the bill, the aging row and AP', async () => {
    const aging = (await call('ceoA', 'GET', '/procurement/ap-aging')).json() as { bySupplier: Array<{ supplierId: string; total: number }> }
    expect(aging.bySupplier.find((r) => r.supplierId === supA)?.total).toBe(billDue)

    const pay = await call('mgrA', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'bank_transfer', amountCents: billDue,
      applications: [{ billId, amountAppliedCents: billDue }],
    })
    expect(pay.statusCode, pay.body).toBe(201)
    expect(pay.json().amountCents).toBe(billDue)
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: billId } })).status).toBe('paid')
    const after = (await call('ceoA', 'GET', '/procurement/ap-aging')).json() as { bySupplier: Array<{ supplierId: string }> }
    expect(after.bySupplier.some((r) => r.supplierId === supA)).toBe(false)
    expect(await netDebit(tenantA, '2010', [`supplier.bill:${billId}`, `supplier.payment:${pay.json().id}`])).toBe(0)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('a PKR 25m supplier opening balance posts Dr 3020 / Cr 2010 exactly; above PKR 900bn is 422', async () => {
    const ok = await call('mgrA', 'POST', '/procurement/suppliers', { name: `Old Vendor ${RUN}`, openingBalanceCents: 2_500_000_000 })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().openingBalanceCents).toBe(2_500_000_000)
    const refs = (await prisma.journalEntry.findMany({ where: { tenantId: tenantA, reference: { startsWith: `supplier.opening:${ok.json().id}` } }, select: { reference: true } })).map((e) => e.reference!)
    expect(await netDebit(tenantA, '3020', refs)).toBe(2_500_000_000)
    expect(await netDebit(tenantA, '2010', refs)).toBe(-2_500_000_000)
    const big = await call('mgrA', 'POST', '/procurement/suppliers', { name: `Huge ${RUN}`, openingBalanceCents: MAX_MONEY_CENTS + 1 })
    expect(big.statusCode).toBe(422)
  })

  it('company B: A\'s bill is 404, and a payment to A\'s supplier is 404', async () => {
    expect((await call('ceoB', 'GET', `/procurement/bills/${billId}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', '/procurement/payments', {
      supplierId: supA, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 100,
    })).statusCode).toBe(404)
  })
})

// ─── (4) PKR 25m bank statement line ────────────────────────────────────────

describe('(4) a PKR 25m bank statement line', () => {
  let importId: string, lineId: string
  beforeAll(async () => {
    const bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: `HBL ${RUN}`, bankName: 'HBL', accountCode: '1020' } })).id
    const r = await call('finA', 'POST', '/reconciliation/bank/imports', {
      bankAccountId: bankA, statementDate: pktToday(), openingBalanceCents: 2_500_000_000, closingBalanceCents: 5_000_000_000,
      filename: 'big.csv', fileUrl: 'https://files.example.invalid/big.csv',
      csv: `Date,Description,Amount\n${pktToday()},Capital injection,25000000.00\n${pktToday()},Sponsor loan,26000000.00`,
    })
    expect(r.statusCode, r.body).toBe(201)
    importId = r.json().importId
  })

  it('the import lists exact balances; the lines read back exact, and the PKR 25m one matched the PKR 25m journal line', async () => {
    const list = (await call('finA', 'GET', '/reconciliation/bank/imports')).json() as Array<{ id: string; openingBalanceCents: unknown; closingBalanceCents: unknown }>
    expect(list.find((i) => i.id === importId)).toMatchObject({ openingBalanceCents: 2_500_000_000, closingBalanceCents: 5_000_000_000 })
    const lines = (await call('finA', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).json() as Array<{ id: string; amountCents: unknown; matchStatus: string }>
    expect(lines).toHaveLength(2)
    const capital = lines.find((l) => l.amountCents === 2_500_000_000)!
    // Matching indexes candidates by amount (a Map keyed by number): the
    // manual PKR 25m Dr 1020 from (2) is found.
    expect(capital.matchStatus).toBe('matched')
    const loan = lines.find((l) => l.amountCents === 2_600_000_000)!
    expect(loan.matchStatus).toBe('unmatched')
    lineId = loan.id
  })

  it('company B: the import is not listed, its lines 404, and adjusting is 404', async () => {
    expect(((await call('finB', 'GET', '/reconciliation/bank/imports')).json() as Array<{ id: string }>).some((i) => i.id === importId)).toBe(false)
    expect((await call('finB', 'GET', `/reconciliation/bank/imports/${importId}/lines`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/reconciliation/bank/lines/${lineId}/adjust`, { contraAccountCode: '3010', memo: 'not mine' })).statusCode).toBe(404)
  })

  it('the CEO adjusts the PKR 26m line against 3010: Dr 1020 2,600,000,000 exactly', async () => {
    const r = await call('ceoA', 'POST', `/reconciliation/bank/lines/${lineId}/adjust`, { contraAccountCode: '3010', memo: 'sponsor loan' })
    expect(r.statusCode, r.body).toBeLessThan(300)
    expect(await netDebit(tenantA, '1020', [`reconciliation.adjustment:${lineId}`])).toBe(2_600_000_000)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('a CSV line above PKR 900bn is 422 CSV_AMOUNT_TOO_LARGE; a balance above it is 422 AMOUNT_TOO_LARGE', async () => {
    const base = { accountCode: '1020', source: 'bank:test', statementDate: pktToday(), filename: 'x.csv', fileUrl: 'https://files.example.invalid/x.csv' }
    const line = await call('finA', 'POST', '/reconciliation/bank/imports', { ...base, openingBalanceCents: 0, closingBalanceCents: 0, csv: `Date,Description,Amount\n${pktToday()},typo,900000000000.01` })
    expect(line.statusCode).toBe(422)
    expect(line.json().error.code).toBe('CSV_AMOUNT_TOO_LARGE')
    const bal = await call('finA', 'POST', '/reconciliation/bank/imports', { ...base, openingBalanceCents: MAX_MONEY_CENTS + 1, closingBalanceCents: 0, csv: `Date,Description,Amount\n${pktToday()},x,1` })
    expect(bal.statusCode).toBe(422)
    expect(bal.json().error.code).toBe('AMOUNT_TOO_LARGE')
  })
})

// ─── (5) Group-scale AR, fixed assets, customer rollups ─────────────────────

describe('(5) group-scale receivables, fixed assets and a customer\'s lifetime spend', () => {
  it('a PKR 25m catering invoice and its PKR 25m payment end paid, posted exactly', async () => {
    const today = pktToday()
    const inv = await call('ceoA', 'POST', '/accounting/receivables', {
      customerName: 'Corporate Catering Ltd', issueDate: today, dueDate: today, description: 'Annual catering contract', amountCents: 2_500_000_000,
    })
    expect(inv.statusCode, inv.body).toBe(201)
    expect(inv.json().amountCents).toBe(2_500_000_000)
    const id = inv.json().id
    const list = (await call('ceoA', 'GET', '/accounting/receivables')).json() as { invoices: Array<{ id: string; balanceCents: number }> }
    expect(list.invoices.find((i) => i.id === id)?.balanceCents).toBe(2_500_000_000)
    const pay = await call('ceoA', 'POST', `/accounting/receivables/${id}/payments`, { amountCents: 2_500_000_000, receivedAt: today, method: 'bank' })
    expect(pay.statusCode, pay.body).toBe(201)
    expect((await prisma.receivableInvoice.findUniqueOrThrow({ where: { id } })).status).toBe('paid')
    const refs = [`receivable.issue:${id}`, `receivable.payment:${pay.json().id}`]
    const posted = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: tenantA, reference: { in: refs } } } })
    expect(posted).toHaveLength(4)
    expect(posted.every((l) => l.amountCents === 2_500_000_000)).toBe(true)
    // Receivable: Dr on issue, Cr on payment — nets to zero.
    const arCode = (await prisma.account.findUniqueOrThrow({ where: { id: posted.find((l) => l.type === 'debit')!.accountId } })).code
    expect(await netDebit(tenantA, arCode, [refs[0]!])).toBe(2_500_000_000)
    // Above the cap is 422; amount + tax above it too.
    expect((await call('ceoA', 'POST', '/accounting/receivables', { customerName: 'x', issueDate: today, dueDate: today, description: 'x', amountCents: MAX_MONEY_CENTS + 1 })).statusCode).toBe(422)
    expect((await call('ceoA', 'POST', '/accounting/receivables', { customerName: 'x', issueDate: today, dueDate: today, description: 'x', amountCents: MAX_MONEY_CENTS, taxCents: 1 })).statusCode).toBe(422)
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('a PKR 60m fixed asset over 60 months charges exactly PKR 1m a month and books exact values', async () => {
    // Equipment reaches the register only through CapEx (owner, 2026-10-13):
    // a delivered PKR 60m line, capitalised by the CEO (applied at once).
    const { prepareCapitalisation } = await import('../src/modules/financePlanning/capexPosting.js')
    const { scheduleAssetOf } = await import('../src/modules/fixedAssets/service.js')
    const { nextMonthlyCharge } = await import('../src/modules/fixedAssets/schedule.js')
    const { classOf } = await import('../src/modules/fixedAssets/classes.js')
    const ceo = { id: users['ceoA']!.id, role: 'admin' }
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, name: `Central kitchen ${RUN}` } })
    const line = await prisma.capexLine.create({ data: {
      projectId: project.id, scope: 'Equipment', item: `Central kitchen line ${RUN}`, unitCostCents: 6_000_000_000,
      status: 'delivered', actualDeliveryDate: new Date('2026-01-15T12:00:00+05:00'),
    } })
    const r = await prepareCapitalisation({ lineId: line.id, classKey: 'kitchen_equipment', usefulLifeMonths: 60 }, ceo)
    expect(r.applied).toBe(true)
    const a = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: r.assetIds[0]! } })
    expect(a).toMatchObject({ costCents: 6_000_000_000, originalCostCents: 6_000_000_000, capexLineId: line.id })
    expect(nextMonthlyCharge(scheduleAssetOf(a, await classOf(tenantA, 'kitchen_equipment')), new Map())).toBe(100_000_000)
    const acq = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: tenantA, reference: `fixed_asset.acquire:${a.id}` } }, include: { account: { select: { code: true } } } })
    expect(acq.map((l) => [l.account.code, l.type, l.amountCents]).sort()).toEqual([['1510', 'debit', 6_000_000_000], ['2012', 'credit', 6_000_000_000]])
    // Above the cap is 422 AMOUNT_TOO_LARGE, never a raw 500.
    const big = await prisma.capexLine.create({ data: {
      projectId: project.id, scope: 'Equipment', item: 'x', unitCostCents: 1, status: 'delivered', actualDeliveryDate: new Date('2026-01-15T12:00:00+05:00'),
    } })
    await expect(prepareCapitalisation({ lineId: big.id, classKey: 'kitchen_equipment', costCents: MAX_MONEY_CENTS + 1 }, ceo)).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    expect(await imbalance(tenantA)).toBe(0)
  })

  it('a customer with two PKR 15m orders has a lifetime spend of 3,000,000,000 (above INT4)', async () => {
    const conceptId = (await prisma.concept.create({ data: { name: `Bigint brand ${RUN}`, slug: `bigint-brand-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
    const customerId = (await prisma.customer.create({ data: { name: 'Corporate canteen' } })).id
    for (let i = 0; i < 2; i++) {
      await prisma.order.create({
        data: {
          conceptId, customerId, source: 'pos', fulfilmentType: 'takeout', status: 'completed', totalCents: 1_500_000_000, taxCents: 0,
          placedAt: new Date(), completedAt: new Date(),
        },
      })
    }
    await recomputeCustomerRollups(customerId)
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } })
    expect(c.totalSpentCents).toBe(3_000_000_000)
    expect(c.firstOrderAt).not.toBeNull()
  })
})

// ─── (6) A lot's per-unit cost stays INT4 ───────────────────────────────────

describe('(6) a lot\'s per-unit cost stays INT4: a bill that would re-price it past PKR 21,474,836.47 is 422 and writes nothing', () => {
  let supA: string
  beforeAll(async () => {
    supA = (await prisma.supplier.create({ data: { name: `Revalue Co ${RUN}`, tenantId: tenantA } })).id
  })

  it('bill: billed at the INT4 limit on a tiny quantity, the rounded lot cost would pass it → 422; no bill, the lot unchanged', async () => {
    const item = (await prisma.inventoryItem.create({ data: { name: `Saffron ${RUN}`, unit: 'kg', tenantId: tenantA, currentStock: 0, unitCostCents: 100 } })).id
    const rcv = await receiveGoods({
      actor: { id: users.mgrA!.id, role: 'manager' }, supplierId: supA, photoUrl: 'https://cdn.example/grn.jpg',
      lines: [{ inventoryItemId: item, quantityReceived: 0.0007, unitCostCents: 100 }],
    })
    // 0.0007 × 2,147,483,647 rounds to 1,503,239 paisa — 2,147,484,286 a kg.
    await expect(createBill({
      supplierId: supA, billNumber: `SAF-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId: item, receiptLineId: rcv.receipt.lines[0]!.id, description: 'saffron', quantity: 0.0007, unitCostCents: INT4_MAX_CENTS }],
      createdBy: users.ceoA!.id,
    })).rejects.toMatchObject({ code: 'AMOUNT_TOO_LARGE', statusCode: 422 })
    expect(await prisma.supplierBill.count({ where: { billNumber: `SAF-${RUN}` } })).toBe(0)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: item } })
    expect(lot.unitCostCents).toBe(100)
    expect((await prisma.goodsReceiptLine.findFirstOrThrow({ where: { receiptId: rcv.receipt.id } })).billedQty).toBe(0)
    expect(await imbalance(tenantA)).toBe(0)
  })
})

// ─── (7) Source guard ───────────────────────────────────────────────────────

describe('(7) no bigint in src/ outside lib/money.ts', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  }
  /** Strip // and block comments and string / template literals. */
  function code(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
      .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
      .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
      .replace(/\/\/[^\n]*/g, '')
  }
  it('no bigint literals, no BigInt(), no typeof … === \'bigint\'', () => {
    const root = new URL('../src', import.meta.url).pathname
    const offenders: string[] = []
    for (const file of walk(root)) {
      if (file.endsWith('/lib/money.ts')) continue
      const raw = readFileSync(file, 'utf8')
      if (/typeof\s+[^\n;]*?[!=]==?\s*['"]bigint['"]/.test(raw)) offenders.push(`${file.slice(root.length + 1)}: typeof … 'bigint'`)
      const lines = code(raw).split('\n')
      lines.forEach((line, i) => {
        if (/(^|[^\w$.])\d[\d_]*n\b/.test(line) || /\bBigInt\s*\(/.test(line)) {
          offenders.push(`${file.slice(root.length + 1)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

// ─── (8) TenantContribution.monthlyCents stays INT4, guarded ────────────────

describe('(8) a monthly head-office contribution above INT4 is 422 AMOUNT_TOO_LARGE, never a raw 500', () => {
  it('create: PKR 25m/month is 422 and nothing is saved; at the cap it records', async () => {
    const big = await call('ceoAB', 'POST', '/positions/contributions', {
      sourceTenantId: tenantA, destinationTenantId: tenantB, label: `HO ${RUN}`, monthlyCents: 2_500_000_000,
    })
    expect(big.statusCode, big.body).toBe(422)
    expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect(big.json().error.message).toMatch(/monthly contribution.*PKR 21,474,836\.47/)
    expect(await prisma.tenantContribution.count({ where: { label: `HO ${RUN}` } })).toBe(0)

    const ok = await call('ceoAB', 'POST', '/positions/contributions', {
      sourceTenantId: tenantA, destinationTenantId: tenantB, label: `HO ${RUN}`, monthlyCents: INT4_MAX_CENTS,
    })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().monthlyCents).toBe(INT4_MAX_CENTS)

    const patch = await call('ceoAB', 'PATCH', `/positions/contributions/${ok.json().id}`, { monthlyCents: INT4_MAX_CENTS + 1 })
    expect(patch.statusCode, patch.body).toBe(422)
    expect(patch.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect((await prisma.tenantContribution.findUniqueOrThrow({ where: { id: ok.json().id } })).monthlyCents).toBe(INT4_MAX_CENTS)
  })

  it('a negative or fractional amount is still a 400 validation error', async () => {
    const neg = await call('ceoAB', 'POST', '/positions/contributions', {
      sourceTenantId: tenantA, destinationTenantId: tenantB, label: `Neg ${RUN}`, monthlyCents: -1,
    })
    expect(neg.statusCode).toBe(400)
  })
})
