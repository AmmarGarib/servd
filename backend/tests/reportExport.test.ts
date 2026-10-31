// Report exports (owner, 2026-10-20: "Add option to export BS, P&L, GL, and
// any other report/account statement in PDF and Excel also").
//
// lib/reportExport.ts renders every report as CSV (unchanged bytes), Excel
// (money as numbers) and PDF (paged, header repeated, never throws on text the
// font cannot draw). Each report route takes ?format=csv|xlsx|pdf with its
// own auth, module gate and company scope — export never widens access.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { PDFDocument } from 'pdf-lib'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { toCsv, fmtPkr } from '../src/modules/accounting/csv.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { paymentsRoutes } from '../src/modules/accounting/paymentsRoutes.js'
import { statutoryRoutes } from '../src/modules/accounting/statutoryRoutes.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import foodCostRoutes from '../src/modules/reports/foodCostRoutes.js'
import { fixedAssetRoutes } from '../src/modules/fixedAssets/routes.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { invoiceRoutes } from '../src/modules/invoices/routes.js'
import { reportCsv, reportXlsx, reportPdf, reportFileName, exportFormatOf, type ReportTable } from '../src/lib/reportExport.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let A = '', B = ''
const who: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: UserRole, tenants: string[], extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${key} ${RUN}`, email: `${key}.${RUN}@rptexp.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId: tenants[0]!, moduleDeny: extra.moduleDeny ?? [],
    },
  })
  for (const t of tenants) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  who[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const get = (w: string, url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${who[w]!.token}` } })

const today = fmtPktDate(new Date())
const monthStart = `${today.slice(0, 7)}-01`
/** A day well before this month, for the opening balance. */
const earlier = (() => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 2); return fmtPktDate(d) })()

async function manual(tenantId: string, tag: string, cents: number, debit: string, credit: string, entryDate?: Date, description = `Manual ${tag}`) {
  return (await postJournalEntry({
    tenantId, sourceType: 'manual', sourceId: `${tag}-${RUN}`, description, postedBy: 'test',
    ...(entryDate ? { entryDate } : {}),
    lines: [{ accountCode: debit, type: 'debit', amountCents: cents }, { accountCode: credit, type: 'credit', amountCents: cents }],
  })).entryId
}

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

beforeAll(async () => {
  invalidateSetupCache()
  A = (await prisma.tenant.create({ data: { name: `Export A ${RUN}`, slug: `rptexp-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `Export B ${RUN}`, slug: `rptexp-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  await mkUser('ceoA', 'admin', [A])
  await mkUser('finA', 'finance', [A])
  await mkUser('finB', 'finance', [B])
  await mkUser('finNoAcctA', 'finance', [A], { moduleDeny: ['accounting'] })
  await mkUser('cookA', 'boh', [A])

  // A: capital in two months ago (opening), then a sale, rent and a cash payment this month.
  await manual(A, 'capital', 1_000_000, '1010', '3010', new Date(`${earlier}T07:00:00Z`))
  await manual(A, 'sale', 250_050, '1010', '4001')
  await manual(A, 'rent', 80_000, '6040', '1010', undefined, 'Manual rent · ref CH# 77')
  // B: its own books, never in A's exports.
  await manual(B, 'capitalB', 777_700, '1010', '3010')

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(paymentsRoutes, { prefix: '/accounting/payments' })
    await api.register(statutoryRoutes, { prefix: '/accounting/statutory' })
    await api.register(fixedAssetRoutes, { prefix: '/accounting/fixed-assets' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(foodCostRoutes, { prefix: '/reports/food-cost' })
    await api.register(reportRoutes, { prefix: '/reports' })
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(invoiceRoutes, { prefix: '/invoices' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => { invalidateSetupCache(); await app?.close() })

// ─── Renderer ────────────────────────────────────────────────────────────────

const sample = (n: number): ReportTable => ({
  title: 'Sample report',
  companies: ['GS Foods'],
  period: 'As at 2026-10-20',
  rows: Array.from({ length: n }, (_, i) => ({
    section: i < n / 2 ? 'Assets' : 'Liabilities',
    code: String(1000 + i),
    name: i === 3 ? 'کراچی cash — ✓ emoji 🍔 and a very long account name that will never fit in its column on an A4 page at all' : `Account ${i}`,
    balance: fmtPkr(i * 12_345),
  })),
  sectionKey: 'section',
  types: { balance: 'pkr' },
})

describe('lib/reportExport.ts', () => {
  it('csv is toCsv of the records, byte for byte', () => {
    const t = sample(5)
    expect(reportCsv(t)).toBe(toCsv(t.rows as Array<Record<string, string | number>>))
    expect(reportCsv({ title: 'x', rows: [] })).toBe('﻿')
    expect(reportCsv({ title: 'x', rows: [], columns: [{ key: 'a' }, { key: 'b' }], csvEmpty: 'header' })).toBe('﻿a,b\r\n')
    expect(reportCsv({ title: 'x', rows: [{ a: 1 }], csv: 'legacy body' })).toBe('legacy body')
  })

  it('xlsx is a zip holding the sheet, money as numbers, header frozen', () => {
    const buf = reportXlsx(sample(6))
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    const text = buf.toString('utf8')
    expect(text).toContain('xl/worksheets/sheet1.xml')
    expect(text).toContain('state="frozen"')
    // fmtPkr(5 * 12,345) = "617.25" → the NUMBER 617.25 with the amount style, never text.
    expect(text).toMatch(/<c r="C\d+" s="7"><v>617\.25<\/v><\/c>/)
    expect(text).not.toContain('<t xml:space="preserve">617.25</t>')
    expect(text).toContain('Sample report')
    expect(text).toContain('Liabilities')
  })

  it('pdf: A4, more than one page for 200 rows, page numbers, never throws on Urdu or emoji', async () => {
    const buf = await reportPdf(sample(200))
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    const doc = await PDFDocument.load(buf)
    expect(doc.getPageCount()).toBeGreaterThan(1)
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()]
    expect(Math.round(w)).toBe(595)
    expect(Math.round(h)).toBe(842)
    // More than 6 columns → landscape.
    const wide = await reportPdf({ title: 'Wide', rows: [{ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }] })
    const wdoc = await PDFDocument.load(wide)
    expect(wdoc.getPage(0).getWidth()).toBeGreaterThan(wdoc.getPage(0).getHeight())
    // Empty report still renders.
    expect((await reportPdf({ title: 'Empty', rows: [] })).subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('file names: csv keeps the legacy name; xlsx / pdf add the one company in view', () => {
    expect(reportFileName('csv', { base: 'balance-sheet', suffix: '2026-10-20' }, ['GS Foods'])).toBe('balance-sheet-2026-10-20.csv')
    expect(reportFileName('pdf', { base: 'balance-sheet', suffix: '2026-10-20' }, ['GS Foods'])).toBe('balance-sheet-gs-foods-2026-10-20.pdf')
    expect(reportFileName('xlsx', { base: 'balance-sheet', suffix: '2026-10-20' }, ['A', 'B'])).toBe('balance-sheet-2026-10-20.xlsx')
    expect(exportFormatOf('pdf')).toBe('pdf')
    expect(exportFormatOf('json')).toBeNull()
    expect(exportFormatOf(undefined, 'csv')).toBe('csv')
  })
})

// ─── Legacy CSV builders (the code the routes ran before 2026-10-20) ─────────

type Tb = { companies: Array<{ name: string }>; rows: Array<{ companyName: string | null; code: string; name: string; virtual?: boolean; type: string; debitCents: number; creditCents: number }>; totals: { debitCents: number; creditCents: number }; companyTotals: Array<{ name: string; debitCents: number; creditCents: number }> }
function legacyTb(report: Tb): string {
  const multi = report.companies.length > 1
  const rows: Array<Record<string, string | number>> = report.rows.map((r) => ({
    ...(multi && { company: r.companyName ?? '' }),
    code: r.code, account: r.virtual ? `${r.name} (computed)` : r.name, type: r.type,
    debit: fmtPkr(r.debitCents), credit: fmtPkr(r.creditCents),
  }))
  rows.push({ ...(multi && { company: '' }), code: '', account: 'TOTAL', type: '', debit: fmtPkr(report.totals.debitCents), credit: fmtPkr(report.totals.creditCents) })
  return toCsv(rows)
}
type Bal = { companyName: string | null; code: string; name: string; balanceCents: number }
type Bs = {
  companies: Array<{ name: string }>; assets: Bal[]; liabilities: Bal[]; equity: Bal[]
  earningsByCompany: Array<{ companyName: string; fiscalYear: { start: string; label: string }; retainedEarningsBroughtForwardCents: number; currentYearEarningsCents: number }>
  ppe: Array<{ companyName: string; costCode: string; accumCode: string; label: string; costCents: number; accumulatedCents: number; netCents: number }>
  totals: { assetsCents: number; liabilitiesCents: number; equityCents: number; currentEarningsCents: number; currentYearEarningsCents: number }
}
function legacyBs(report: Bs): string {
  const multi = report.companies.length > 1
  const co = (name: string | null): Record<string, string> => (multi ? { company: name ?? '' } : {})
  const flat: Array<Record<string, string | number>> = []
  for (const a of report.assets) flat.push({ section: 'Assets', ...co(a.companyName), code: a.code, name: a.name, balance: fmtPkr(a.balanceCents) })
  flat.push({ section: 'Assets', ...co(''), code: '', name: 'TOTAL ASSETS', balance: fmtPkr(report.totals.assetsCents) })
  for (const l of report.liabilities) flat.push({ section: 'Liabilities', ...co(l.companyName), code: l.code, name: l.name, balance: fmtPkr(l.balanceCents) })
  flat.push({ section: 'Liabilities', ...co(''), code: '', name: 'TOTAL LIABILITIES', balance: fmtPkr(report.totals.liabilitiesCents) })
  for (const e of report.equity) flat.push({ section: 'Equity', ...co(e.companyName), code: e.code, name: e.name, balance: fmtPkr(e.balanceCents) })
  for (const e of report.earningsByCompany) {
    flat.push({ section: 'Equity', ...co(e.companyName), code: '', name: `Retained earnings b/f (before ${e.fiscalYear.start})`, balance: fmtPkr(e.retainedEarningsBroughtForwardCents) })
    flat.push({ section: 'Equity', ...co(e.companyName), code: '', name: `Profit for the year to date (${e.fiscalYear.label})`, balance: fmtPkr(e.currentYearEarningsCents) })
  }
  const unowned = report.totals.currentYearEarningsCents - report.earningsByCompany.reduce((s, e) => s + e.currentYearEarningsCents, 0)
  if (unowned !== 0) flat.push({ section: 'Equity', ...co(''), code: '', name: 'Profit on accounts with no company', balance: fmtPkr(unowned) })
  flat.push({ section: 'Equity', ...co(''), code: '', name: 'TOTAL EQUITY', balance: fmtPkr(report.totals.equityCents + report.totals.currentEarningsCents) })
  for (const p of report.ppe) {
    flat.push({ section: 'Fixed assets by class', ...co(p.companyName), code: [p.costCode, p.accumCode].filter(Boolean).join(' / '), name: `${p.label}: cost ${fmtPkr(p.costCents)}, accumulated ${fmtPkr(p.accumulatedCents)}`, balance: fmtPkr(p.netCents) })
  }
  return toCsv(flat)
}
type Line = { code: string; name: string; amountCents: number }
type Pl = { revenue: Line[]; contraRevenue: Line[]; cogs: Line[]; opex: Line[]; otherIncome: Line[]; totals: Record<string, number> }
function legacyPl(report: Pl): string {
  const t = report.totals
  const flat: Array<Record<string, string | number>> = []
  for (const r of report.revenue) flat.push({ section: 'Revenue', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
  flat.push({ section: 'Revenue', code: '', name: 'TOTAL REVENUE', amount: fmtPkr(t['revenueCents']!) })
  for (const r of report.contraRevenue) flat.push({ section: 'Discounts/Refunds', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
  for (const r of report.cogs) flat.push({ section: 'COGS', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
  flat.push({ section: 'COGS', code: '', name: 'TOTAL COGS', amount: fmtPkr(t['cogsCents']!) })
  flat.push({ section: 'Margin', code: '', name: 'GROSS PROFIT', amount: fmtPkr(t['grossProfitCents']!) })
  flat.push({ section: 'Margin', code: '', name: 'GROSS MARGIN %', amount: t['grossMarginPct']! })
  for (const r of report.opex) flat.push({ section: 'OpEx', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
  flat.push({ section: 'OpEx', code: '', name: 'TOTAL OPEX', amount: fmtPkr(t['opexCents']!) })
  if (t['depreciationCents'] !== 0) flat.push({ section: 'OpEx', code: '', name: 'of which depreciation', amount: fmtPkr(t['depreciationCents']!) })
  if (t['impairmentCents'] !== 0) flat.push({ section: 'OpEx', code: '', name: 'of which impairment', amount: fmtPkr(t['impairmentCents']!) })
  flat.push({ section: 'Result', code: '', name: 'OPERATING PROFIT', amount: fmtPkr(t['operatingProfitCents']!) })
  for (const r of report.otherIncome) flat.push({ section: 'Other income', code: r.code, name: r.name, amount: fmtPkr(r.amountCents) })
  flat.push({ section: 'Other income', code: '', name: 'TOTAL OTHER INCOME', amount: fmtPkr(t['otherIncomeCents']!) })
  flat.push({ section: 'Result', code: '', name: 'NET PROFIT', amount: fmtPkr(t['netProfitCents']!) })
  return toCsv(flat)
}
type Entry = { description: string; voucherNo?: string | null; reference: string | null; entryDate: string; lines: Array<{ type: string; amountCents: number; memo: string | null; account: { code: string; name: string } }> }
function legacyLedger(entries: Entry[]): string {
  const flat: Array<Record<string, string | number>> = []
  for (const e of entries) {
    for (const l of e.lines) {
      flat.push({
        date: fmtPktDate(new Date(e.entryDate)), voucherNo: e.voucherNo ?? '', accountCode: l.account.code, accountName: l.account.name,
        memo: l.memo?.trim() || e.description,
        debit: l.type === 'debit' ? fmtPkr(l.amountCents) : '', credit: l.type === 'credit' ? fmtPkr(l.amountCents) : '',
      })
    }
  }
  const sum = (t: string) => entries.reduce((s, e) => s + e.lines.reduce((x, l) => x + (l.type === t ? l.amountCents : 0), 0), 0)
  if (flat.length) flat.push({ date: '', voucherNo: '', accountCode: '', accountName: 'TOTAL', memo: '', debit: fmtPkr(sum('debit')), credit: fmtPkr(sum('credit')) })
  return toCsv(flat)
}

// ─── Routes ──────────────────────────────────────────────────────────────────

async function expectFiles(path: string, w = 'finA') {
  const x = await get(w, `${path}${path.includes('?') ? '&' : '?'}format=xlsx`)
  expect(x.statusCode, x.body).toBe(200)
  expect(x.headers['content-type']).toBe(XLSX)
  expect(String(x.headers['content-disposition'])).toMatch(/^attachment; filename=".+\.xlsx"$/)
  expect(x.rawPayload.subarray(0, 2).toString()).toBe('PK')
  const p = await get(w, `${path}${path.includes('?') ? '&' : '?'}format=pdf`)
  expect(p.statusCode, p.body).toBe(200)
  expect(p.headers['content-type']).toBe('application/pdf')
  expect(String(p.headers['content-disposition'])).toMatch(/^attachment; filename=".+\.pdf"$/)
  expect(p.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
  return { xlsx: x.rawPayload, pdf: p.rawPayload }
}

describe('balance sheet, P&L, trial balance: CSV unchanged, Excel and PDF added', () => {
  it('trial balance', async () => {
    const json = await get('finA', `/accounting/trial-balance?asOf=${today}&basis=year`)
    expect(json.statusCode, json.body).toBe(200)
    const csv = await get('finA', `/accounting/trial-balance?asOf=${today}&basis=year&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="trial-balance-year-${today}.csv"`)
    expect(csv.body).toBe(legacyTb(json.json() as Tb))
    const { xlsx, pdf } = await expectFiles(`/accounting/trial-balance?asOf=${today}&basis=year`)
    expect(xlsx.toString('utf8')).toContain(`Export A ${RUN}`)
    expect(xlsx.toString('utf8')).not.toContain(`Export B ${RUN}`)
    expect((await PDFDocument.load(pdf)).getPageCount()).toBeGreaterThanOrEqual(1)
  })

  it('balance sheet (the file name carries the company for Excel / PDF)', async () => {
    const json = await get('finA', `/accounting/balance-sheet?asOf=${today}`)
    const csv = await get('finA', `/accounting/balance-sheet?asOf=${today}&format=csv`)
    expect(csv.statusCode).toBe(200)
    // Since 2026-10-31 the CSV splits assets and liabilities into non-current / current (owner) — the
    // equity part is unchanged, and every total is still there.
    expect(csv.body.slice(csv.body.indexOf('\r\nEquity'))).toBe(legacyBs(json.json() as Bs).slice(legacyBs(json.json() as Bs).indexOf('\r\nEquity')))
    for (const t of ['TOTAL NON-CURRENT ASSETS', 'TOTAL CURRENT ASSETS', 'TOTAL ASSETS', 'TOTAL CURRENT LIABILITIES', 'TOTAL NON-CURRENT LIABILITIES', 'TOTAL LIABILITIES']) expect(csv.body).toContain(t)
    const { xlsx } = await expectFiles(`/accounting/balance-sheet?asOf=${today}`)
    // Cash 1010 = 1,000,000 + 250,050 − 80,000 paisa = PKR 11,700.50, as a number.
    expect(xlsx.toString('utf8')).toMatch(/<v>11700\.5<\/v>/)
    const pdf = await get('finA', `/accounting/balance-sheet?asOf=${today}&format=pdf`)
    expect(String(pdf.headers['content-disposition'])).toContain(`balance-sheet-export-a-${RUN}-${today}.pdf`)
  })

  it('profit and loss', async () => {
    const json = await get('finA', `/accounting/pl-ledger?dateFrom=${monthStart}&dateTo=${today}`)
    const csv = await get('finA', `/accounting/pl-ledger?dateFrom=${monthStart}&dateTo=${today}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toBe(legacyPl(json.json() as Pl))
    await expectFiles(`/accounting/pl-ledger?dateFrom=${monthStart}&dateTo=${today}`)
    await expectFiles(`/accounting/pl-ledger/brands?dateFrom=${monthStart}&dateTo=${today}`)
    await expectFiles(`/accounting/cash-flow?dateFrom=${monthStart}&dateTo=${today}`)
  })

  it('format=json (or none) still answers JSON', async () => {
    const r = await get('finA', `/accounting/balance-sheet?asOf=${today}&format=json`)
    expect(r.headers['content-type']).toMatch(/application\/json/)
  })
})

describe('general ledger and the account statement', () => {
  it('ledger: Date, Voucher no., Code, Account, Memo, Debit, Credit in every format', async () => {
    const json = await get('finA', `/accounting/ledger?dateFrom=${earlier}&dateTo=${today}&limit=1000`)
    expect(json.statusCode).toBe(200)
    const csv = await get('finA', `/accounting/ledger?dateFrom=${earlier}&dateTo=${today}&limit=1000&format=csv`)
    expect(csv.body).toBe(legacyLedger((json.json() as { data: Entry[] }).data))
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="ledger-${earlier}-${today}.csv"`)
    await expectFiles(`/accounting/ledger?dateFrom=${earlier}&dateTo=${today}&limit=1000`)
  })

  it('account statement: opening, running balance, closing — in every format', async () => {
    const cash = await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: '1010' } })
    const st = await get('finA', `/accounting/ledger?accountId=${cash.id}&view=statement&dateFrom=${monthStart}&dateTo=${today}`)
    expect(st.statusCode, st.body).toBe(200)
    const s = st.json() as { openingCents: number; closingCents: number; lines: Array<{ balanceCents: number }>; account: { normal: string } }
    expect(s.account.normal).toBe('debit')
    expect(s.openingCents).toBe(1_000_000)
    expect(s.lines.map((l) => l.balanceCents)).toEqual([1_250_050, 1_170_050])
    expect(s.closingCents).toBe(1_170_050)
    const csv = await get('finA', `/accounting/ledger?accountId=${cash.id}&view=statement&dateFrom=${monthStart}&dateTo=${today}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body.split('\r\n')[0]).toBe('﻿date,voucherNo,particulars,chequeReference,memo,debit,credit,balance')
    // The cheque reference typed on the entry, never the system key "manual:<id>" (owner, 2026-10-23).
    expect(csv.body).toContain('Manual rent,CH# 77,')
    expect(csv.body).not.toContain('manual:')
    // A reversal names "the original entry", never its system key.
    const rentId = await manual(A, 'oops', 1, '6040', '1010')
    await postJournalEntry({
      tenantId: A, sourceType: 'manual.reversal', sourceId: `oops-${RUN}`, description: `Reversal of manual:${rentId}`, postedBy: 'test',
      lines: [{ accountCode: '1010', type: 'debit', amountCents: 1 }, { accountCode: '6040', type: 'credit', amountCents: 1 }],
    })
    const csv2 = await get('finA', `/accounting/ledger?accountId=${cash.id}&view=statement&dateFrom=${monthStart}&dateTo=${today}&format=csv&showCancelled=1`)
    expect(csv2.body).toContain('Reversal of the original entry')
    expect(csv2.body).not.toContain(rentId)
    expect(csv.body).toContain('OPENING BALANCE')
    expect(csv.body).toContain('"11,700.50"')
    const { xlsx } = await expectFiles(`/accounting/ledger?accountId=${cash.id}&view=statement&dateFrom=${monthStart}&dateTo=${today}`)
    expect(xlsx.toString('utf8')).toMatch(/<v>11700\.5<\/v>/)
  })

  it('another company\'s account is 404 — for the statement and every format', async () => {
    const cashA = await prisma.account.findFirstOrThrow({ where: { tenantId: A, code: '1010' } })
    for (const f of ['', '&format=csv', '&format=xlsx', '&format=pdf']) {
      const r = await get('finB', `/accounting/ledger?accountId=${cashA.id}&view=statement&dateFrom=${monthStart}&dateTo=${today}${f}`)
      expect(r.statusCode, f).toBe(404)
    }
    expect((await get('finA', `/accounting/ledger?view=statement`)).statusCode).toBe(422)
  })
})

describe('company scope and access are the route\'s own', () => {
  it('company B exports only its own books', async () => {
    const csv = await get('finB', `/accounting/trial-balance?asOf=${today}&format=csv`)
    expect(csv.statusCode).toBe(200)
    expect(csv.body).toContain('"7,777.00"')
    expect(csv.body).not.toContain('"10,000.00"')
    const x = await get('finB', `/accounting/balance-sheet?asOf=${today}&format=xlsx`)
    expect(x.rawPayload.toString('utf8')).toContain(`Export B ${RUN}`)
    expect(x.rawPayload.toString('utf8')).not.toContain(`Export A ${RUN}`)
    const led = await get('finB', `/accounting/ledger?dateFrom=${earlier}&dateTo=${today}&format=pdf`)
    expect(led.statusCode).toBe(200)
    const ledCsv = await get('finB', `/accounting/ledger?dateFrom=${earlier}&dateTo=${today}&format=csv`)
    expect(ledCsv.body).not.toContain(`Manual sale`)
  })

  it('a role without the module, or outside the route\'s roles, gets 403 in every format', async () => {
    for (const f of ['csv', 'xlsx', 'pdf']) {
      expect((await get('finNoAcctA', `/accounting/balance-sheet?asOf=${today}&format=${f}`)).statusCode, f).toBe(403)
      expect((await get('cookA', `/accounting/pl-ledger?format=${f}`)).statusCode, f).toBe(403)
      expect((await get('cookA', `/accounting/payments/payments.csv?format=${f}`)).statusCode, f).toBe(403)
    }
  })
})

describe('payments register', () => {
  it('CSV (Date, Voucher no., Narration, Method, Total, O/U/UC) the same on both paths; Excel and PDF on both', async () => {
    const json = await get('ceoA', `/accounting/payments?from=${monthStart}&to=${today}`)
    expect(json.statusCode, json.body).toBe(200)
    const out = json.json() as { rows: Array<Record<string, unknown> & { entryDate: string }>; multiCompany: boolean }
    expect(out.rows.length).toBeGreaterThan(0)
    const SHORT: Record<string, string> = { official: 'O', unofficial: 'U', unclassified: 'UC' }
    const recs: Array<Record<string, string>> = out.rows.map((r) => ({
      ...(out.multiCompany && { company: (r['companyName'] as string) ?? '' }),
      date: fmtPktDate(new Date(r.entryDate)), voucher_no: ((r['voucherNo'] as string | null) ?? (r['voucherNumber'] as string)),
      narration: r['narration'] as string, payment_method: r['methodLabel'] as string,
      total_amount: fmtPkr(r['netCents'] as number), classification: SHORT[r['classification'] as string]!,
    }))
    recs.push({ ...(out.multiCompany && { company: '' }), date: '', voucher_no: '', narration: 'TOTAL', payment_method: '', total_amount: fmtPkr(out.rows.reduce((t, r) => t + (r['netCents'] as number), 0)), classification: '' })
    const legacy = toCsv(recs)
    const a = await get('ceoA', `/accounting/payments/payments.csv?from=${monthStart}&to=${today}`)
    expect(a.statusCode).toBe(200)
    expect(a.body).toBe(legacy)
    expect(a.headers['content-disposition']).toBe(`attachment; filename="payments-all-${monthStart}-to-${today}.csv"`)
    const b = await get('ceoA', `/accounting/payments?from=${monthStart}&to=${today}&format=csv`)
    expect(b.body).toBe(legacy)
    await expectFiles(`/accounting/payments/payments.csv?from=${monthStart}&to=${today}`, 'ceoA')
    await expectFiles(`/accounting/payments?from=${monthStart}&to=${today}`, 'ceoA')
    // Company B's register has none of A's payments.
    const bCsv = await get('finB', `/accounting/payments/payments.csv?from=${monthStart}&to=${today}`)
    expect(bCsv.statusCode).toBe(200)
    expect(bCsv.body).not.toContain('Manual rent')
  })
})

describe('the other reports and statements export too', () => {
  it('AP aging, statutory, sales reports, fixed assets, tax invoices, HR', async () => {
    for (const path of [
      `/procurement/ap-aging?asOf=${today}`,
      `/accounting/statutory`,
      `/accounting/fixed-assets`,
      `/accounting/fixed-assets/reports/nbv`,
      `/reports/sales?dateFrom=${monthStart}&dateTo=${today}`,
      `/reports/top-items?dateFrom=${monthStart}&dateTo=${today}`,
      `/reports/by-source?dateFrom=${monthStart}&dateTo=${today}`,
      `/reports/by-tender?dateFrom=${monthStart}&dateTo=${today}`,
      `/reports/food-cost/export.csv?view=valuation&tenantId=${A}`,
      `/invoices/register.csv`,
    ]) await expectFiles(path, 'ceoA')
    await expectFiles('/hr/reports/employees.csv', 'ceoA')
    const hr = await get('ceoA', '/hr/reports/employee_master.pdf')
    expect(hr.statusCode, hr.body).toBe(200)
    expect(hr.headers['content-type']).toBe('application/pdf')
  })

  it('supplier statement and employee loan statement: own company only', async () => {
    const sup = await prisma.supplier.create({ data: { tenantId: A, name: `Meat Co ${RUN}` } })
    const { pdf } = await expectFiles(`/procurement/suppliers/${sup.id}/statement`, 'ceoA')
    expect(pdf.length).toBeGreaterThan(500)
    const csv = await get('ceoA', `/procurement/suppliers/${sup.id}/statement?format=csv`)
    expect(csv.body).toContain('OPENING BALANCE')
    expect((await get('finB', `/procurement/suppliers/${sup.id}/statement?format=pdf`)).statusCode).toBe(404)
    const emp = await prisma.hrEmployee.create({ data: { tenantId: A, fullName: `Loan Person ${RUN}`, employeeCode: `LP-${RUN}`, joiningDate: new Date() } })
    await expectFiles(`/hr/employees/${emp.id}/loan-statement`, 'ceoA')
    await mkUser('ceoB', 'admin', [B])
    expect((await get('ceoB', `/hr/employees/${emp.id}/loan-statement?format=pdf`)).statusCode).toBe(404)
  })
})
