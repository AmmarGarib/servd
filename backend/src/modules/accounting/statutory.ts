// Statutory payroll payables — accrued vs paid (finance wave B, H7). The ONE
// computation of what payroll owes the authorities and what was paid: the
// Accounting → Statutory payments page reads it, the HR statutory report
// links here (it never recomputes from payslips), and the period close warns
// from it.
//
//   scheme       payable   accrued by                         paid by
//   salary tax   2042      payroll lock / approved F&F ('hr.') a 'salary_tax' tax payment
//   EOBI         2043      (employee + employer)               an 'eobi' tax payment
//   SESSI/PESSI  2044      (employer)                          a 'sessi' tax payment
//
// Per month and scheme:
//   • accrued — net credits on the payable from entries whose reference starts
//     'hr.' (payroll accruals, F&F accruals and their reversals) dated in the
//     PKT month;
//   • legacy accrued — what HR booked for the month to the stand-ins before
//     H7 (EOBI + SESSI on 2090 Accrued Expenses, salary tax on 2040), split
//     per entry from the run's payslips / the settlement's figures. The SAME
//     split the one-time reclass uses (legacyHrEntries below);
//   • reclass — what the one-time reclass moved onto the payable, dated in
//     the month (shown on its own: it is a move, not an accrual);
//   • paid — the scheme's payment(s) for the month (SalesTaxPayment, period
//     starting in the month; taxPayments.ts posts Dr the payable / Cr bank);
//   • owed = accrued + legacy accrued − paid; overpaid when below zero;
//   • the payable's ledger balance at the month's end.
//
// The one-time reclass (postReclass): 'statutory.reclass:<tenantId>' — Dr 2090
// (EOBI + SESSI) / Dr 2040 (salary tax) / Cr 2043 / Cr 2044 / Cr 2042, dated
// today, once per company, with NO reverse route. Its source is deliberately
// not 'hr.', so it is never counted as accrued.
//
// HR's old 'EOBI / SESSI payments' form (HrRecord section 'eobi_challan')
// recorded challans outside the books; those rows are listed as
// legacyHrChallans ("recorded in HR, not on the books").
//
// Every query is filtered on the company it is given.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { sumCents, toCents } from '../../lib/money.js'
import { ACCT, postJournalEntry, type JournalLineInput } from './journal.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from './dates.js'
import { STATUTORY, STATUTORY_KEYS, monthPeriod, type StatutoryKey } from './taxPayments.js'
import { TAX_PAYMENT_SOURCE } from './salesTaxReturn.js'
import { settlementParts } from '../hr/logic.js'
import type { CloseCheck, CloseCheckContext, CloseProblem } from './closeCheckTypes.js'

/** Any client: `prisma`, `serviceClient`, a transaction, a close check's db. */
type Db = Prisma.TransactionClient

/** Where HR booked EOBI + SESSI before H7 (Accrued Expenses). */
export const LEGACY_STATUTORY_CODE = '2090'
/** Where HR booked salary tax before H7 (Income Tax Withholding Payable). */
export const LEGACY_SALARY_TAX_CODE = ACCT.WHT_PAYABLE
/** The one-time reclass: 'statutory.reclass:<tenantId>'. Not 'hr.' — never counted as accrued. */
export const STATUTORY_RECLASS_SOURCE = 'statutory.reclass'
/** Accrual entries are the ones whose reference starts with this. */
const HR_PREFIX = 'hr.'
const HR_ACCRUAL = /^(hr\.payroll\.accrual|hr\.final_settlement\.accrual)(\.reversal)?:(.+)$/

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const MAX_MONTHS = 36
const END_OF_TIME = new Date('9999-12-31T00:00:00Z')

const ACCOUNT_OF: Record<StatutoryKey, string> = Object.fromEntries(STATUTORY.map((s) => [s.key, s.account])) as Record<StatutoryKey, string>
const KEY_OF_ACCOUNT = new Map(STATUTORY.map((s) => [s.account, s.key]))
const PAYABLE_CODES = STATUTORY.map((s) => s.account)

type Amounts = Record<StatutoryKey, number>
const zeroAmounts = (): Amounts => ({ salary_tax: 0, eobi: 0, sessi: 0 })

const monthOf = (d: Date) => fmtPktDate(d).slice(0, 7)
const monthStart = (m: string) => parsePktStartOfDay(`${m}-01`)
const monthEnd = (m: string) => parsePktEndOfDay(monthPeriod(m).to)

/** Every month from `from` to `to` inclusive. */
export function monthsBetween(from: string, to: string): string[] {
  if (!MONTH.test(from) || !MONTH.test(to)) throw new AppError('INVALID_DATE', 'Give the months as YYYY-MM', 422)
  if (to < from) throw new AppError('BAD_PERIOD', 'The range ends before it starts', 422)
  const out: string[] = []
  let [y, m] = from.split('-').map(Number) as [number, number]
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    out.push(key)
    if (out.length > MAX_MONTHS) throw new AppError('RANGE_TOO_LONG', `Pick at most ${MAX_MONTHS} months`, 422)
    if (key === to) break
    m += 1
    if (m === 13) { m = 1; y += 1 }
  }
  return out
}

/** Credit − debit of each code in `tenantId`'s chart, over every entry up to `asOf`. */
async function creditBalances(db: Db, tenantId: string, codes: string[], asOf: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>(codes.map((c) => [c, 0]))
  const accounts = await db.account.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true } })
  if (accounts.length === 0) return out
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    _sum: { amountCents: true },
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { tenantId, entryDate: { lte: asOf } } },
  })
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))
  for (const s of sums) {
    const code = codeOf.get(s.accountId)
    if (!code) continue
    const amt = sumCents(s._sum.amountCents)
    out.set(code, (out.get(code) ?? 0) + (s.type === 'credit' ? amt : -amt))
  }
  return out
}

// ─── The legacy split: HR entries that credited 2090 / 2040 ─────────────────

export interface LegacyHrEntry {
  entryId: string
  reference: string
  entryDate: string
  month: string
  kind: 'payroll' | 'final_settlement'
  /** The payroll run / full & final record. */
  sourceId: string
  reversal: boolean
  /** Net credit the entry put on 2090 / 2040 (negative for a reversal). */
  legacy2090Cents: number
  legacy2040Cents: number
  /** That credit by scheme (EOBI + SESSI from 2090, salary tax from 2040). */
  eobiCents: number
  sessiCents: number
  salaryTaxCents: number
  /**
   * exact — the payslips / settlement figures match the ledger;
   * pro_rata — they differ (a run edited after it posted), the ledger amount is split in their proportion;
   * estimated — no figures found (the run or record is gone): all of 2090 counted as EOBI.
   */
  basis: 'exact' | 'pro_rata' | 'estimated'
  createdAt: Date
}

/** Split a signed 2090 credit between EOBI and SESSI in the proportion of the source figures. */
function splitStatutory(credit: number, eobi: number, sessi: number): { eobi: number; sessi: number; basis: LegacyHrEntry['basis'] } {
  const abs = Math.abs(credit)
  const sign = credit < 0 ? -1 : 1
  if (abs === 0) return { eobi: 0, sessi: 0, basis: 'exact' }
  const total = eobi + sessi
  if (eobi < 0 || sessi < 0 || total <= 0) return { eobi: sign * abs, sessi: 0, basis: 'estimated' }
  if (total === abs) return { eobi: sign * eobi, sessi: sign * sessi, basis: 'exact' }
  // The fraction first, so a large amount never leaves the exact-integer range.
  const e = Math.round(abs * (eobi / total))
  return { eobi: sign * e, sessi: sign * (abs - e), basis: 'pro_rata' }
}

interface PayslipLine { kind?: string; code?: string; amountCents?: number }

/**
 * Every HR accrual entry of `tenantId` (payroll and full & final, with their
 * reversals) that touched 2090 or 2040, split by scheme. A reversal takes its
 * original's proportions and subtracts. Optionally only entries dated in
 * [from, to].
 */
export async function legacyHrEntries(db: Db, tenantId: string, range?: { from: Date; to: Date }): Promise<LegacyHrEntry[]> {
  const codes = [LEGACY_STATUTORY_CODE, LEGACY_SALARY_TAX_CODE]
  const entries = await db.journalEntry.findMany({
    where: {
      tenantId,
      OR: [{ reference: { startsWith: 'hr.payroll.accrual' } }, { reference: { startsWith: 'hr.final_settlement.accrual' } }],
      lines: { some: { account: { tenantId, code: { in: codes } } } },
      ...(range && { entryDate: { gte: range.from, lte: range.to } }),
    },
    select: {
      id: true, reference: true, entryDate: true, createdAt: true,
      lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } },
    },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }],
  })
  const parsed = entries.flatMap((e) => {
    const m = HR_ACCRUAL.exec(e.reference ?? '')
    return m ? [{ e, kind: m[1] === 'hr.payroll.accrual' ? 'payroll' as const : 'final_settlement' as const, reversal: !!m[2], sourceId: m[3]! }] : []
  })
  if (parsed.length === 0) return []

  // The figures each entry was posted from.
  const runIds = [...new Set(parsed.filter((p) => p.kind === 'payroll').map((p) => p.sourceId))]
  const recIds = [...new Set(parsed.filter((p) => p.kind === 'final_settlement').map((p) => p.sourceId))]
  const [slips, recs] = await Promise.all([
    runIds.length ? db.hrPayslip.findMany({ where: { tenantId, runId: { in: runIds } }, select: { runId: true, lines: true } }) : [],
    recIds.length ? db.hrRecord.findMany({ where: { tenantId, id: { in: recIds } }, select: { id: true, data: true } }) : [],
  ])
  const figures = new Map<string, { eobi: number; sessi: number }>()
  for (const s of slips) {
    const f = figures.get(`payroll:${s.runId}`) ?? { eobi: 0, sessi: 0 }
    for (const l of (Array.isArray(s.lines) ? s.lines : []) as PayslipLine[]) {
      const amt = typeof l.amountCents === 'number' ? l.amountCents : 0
      // 2090 took EOBI employee + EVERY employer contribution (hr/ledger.ts).
      if (l.code === 'eobi_employee' || l.code === 'eobi_employer') f.eobi += amt
      else if (l.kind === 'employer') f.sessi += amt
    }
    figures.set(`payroll:${s.runId}`, f)
  }
  for (const r of recs) {
    const p = settlementParts(r.data)
    figures.set(`final_settlement:${r.id}`, { eobi: p.eobiEmployee + p.eobiEmployer, sessi: p.sessiEmployer })
  }

  return parsed.map(({ e, kind, reversal, sourceId }) => {
    const net = (code: string) => e.lines
      .filter((l) => l.account.code === code)
      .reduce((t, l) => t + (l.type === 'credit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
    const l2090 = net(LEGACY_STATUTORY_CODE)
    const l2040 = net(LEGACY_SALARY_TAX_CODE)
    const f = figures.get(`${kind}:${sourceId}`)
    const split = splitStatutory(l2090, f?.eobi ?? 0, f?.sessi ?? 0)
    return {
      entryId: e.id,
      reference: e.reference ?? '',
      entryDate: fmtPktDate(e.entryDate),
      month: monthOf(e.entryDate),
      kind, sourceId, reversal,
      legacy2090Cents: l2090,
      legacy2040Cents: l2040,
      eobiCents: split.eobi,
      sessiCents: split.sessi,
      // Every 2040 credit an HR accrual made was salary tax (hr/ledger.ts).
      salaryTaxCents: l2040,
      basis: split.basis,
      createdAt: e.createdAt,
    }
  })
}

// ─── Accrued vs paid ────────────────────────────────────────────────────────

export interface StatutoryPaymentRef {
  id: string
  paidAt: string
  paidCents: number
  cprNumber: string | null
  linked: boolean
  journalEntryId: string | null
  bankAccountId: string | null
}

export interface StatutoryCell {
  key: StatutoryKey
  account: string
  /** Net credits on the payable from 'hr.' entries dated in the month. */
  accruedCents: number
  /** HR amounts of the month booked to 2090 / 2040 before H7 (the reclass split). */
  legacyAccruedCents: number
  /** What the one-time reclass moved onto the payable in this month (a move, not an accrual). */
  reclassCents: number
  /** Settled by the month's payment(s). */
  paidCents: number
  /** accrued + legacy accrued − paid. Negative = overpaid. */
  owedCents: number
  overpaid: boolean
  /** Something accrued and all of it paid. */
  cleared: boolean
  payments: StatutoryPaymentRef[]
  /** The payable's ledger balance (credit) at the month's end. */
  balanceAtMonthEndCents: number
}

export type StatutoryMonth = { month: string } & Record<StatutoryKey, StatutoryCell>

export interface LegacyHrChallan {
  id: string
  scheme: string | null
  month: string | null
  amountCents: number
  paidOn: string | null
  challanNo: string | null
  status: string
}

export interface StatutorySummary {
  tenantId: string
  from: string
  to: string
  schemes: Array<{ key: StatutoryKey; label: string; name: string; account: string }>
  months: StatutoryMonth[]
  totals: Record<StatutoryKey, { accruedCents: number; legacyAccruedCents: number; reclassCents: number; paidCents: number; owedCents: number }>
  /** HR's old 'EOBI / SESSI payments' rows — recorded in HR, not on the books. */
  legacyHrChallans: LegacyHrChallan[]
  /** The one-time reclass, once posted. */
  reclass: { entryId: string; entryDate: string } | null
}

/** Accrued vs paid per month and scheme for `tenantId`, months `fromMonth`..`toMonth` (YYYY-MM). */
export async function statutorySummary(db: Db, tenantId: string, fromMonth: string, toMonth: string): Promise<StatutorySummary> {
  const months = monthsBetween(fromMonth, toMonth)
  const from = monthStart(months[0]!)
  const to = monthEnd(months[months.length - 1]!)

  const [lines, legacy, payments, reclassEntry, challans] = await Promise.all([
    db.journalLine.findMany({
      where: {
        account: { tenantId, code: { in: PAYABLE_CODES } },
        journalEntry: {
          tenantId, entryDate: { gte: from, lte: to },
          OR: [{ reference: { startsWith: HR_PREFIX } }, { reference: { startsWith: `${STATUTORY_RECLASS_SOURCE}:` } }],
        },
      },
      select: { type: true, amountCents: true, account: { select: { code: true } }, journalEntry: { select: { entryDate: true, reference: true } } },
    }),
    legacyHrEntries(db, tenantId, { from, to }),
    db.salesTaxPayment.findMany({
      where: { tenantId, authority: { in: [...STATUTORY_KEYS] }, periodFrom: { gte: from, lte: to } },
      orderBy: { paidAt: 'asc' },
    }),
    db.journalEntry.findFirst({ where: { tenantId, reference: `${STATUTORY_RECLASS_SOURCE}:${tenantId}` }, select: { id: true, entryDate: true } }),
    db.hrRecord.findMany({
      where: { tenantId, section: 'eobi_challan', status: { not: 'cancelled' } },
      select: { id: true, data: true, effectiveDate: true, startDate: true, amountCents: true, status: true },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    }),
  ])

  const accrued = new Map<string, Amounts>()
  const reclass = new Map<string, Amounts>()
  const bucket = (m: Map<string, Amounts>, month: string) => {
    let a = m.get(month)
    if (!a) { a = zeroAmounts(); m.set(month, a) }
    return a
  }
  for (const l of lines) {
    const key = KEY_OF_ACCOUNT.get(l.account.code)
    if (!key) continue
    const amt = (l.type === 'credit' ? 1 : -1) * toCents(l.amountCents)
    const month = monthOf(l.journalEntry.entryDate)
    const target = (l.journalEntry.reference ?? '').startsWith(`${STATUTORY_RECLASS_SOURCE}:`) ? reclass : accrued
    bucket(target, month)[key] += amt
  }
  const legacyByMonth = new Map<string, Amounts>()
  for (const e of legacy) {
    const a = bucket(legacyByMonth, e.month)
    a.eobi += e.eobiCents
    a.sessi += e.sessiCents
    a.salary_tax += e.salaryTaxCents
  }
  const paid = new Map<string, Map<StatutoryKey, StatutoryPaymentRef[]>>()
  const paidCents = new Map<string, Amounts>()
  for (const p of payments) {
    const key = p.authority as StatutoryKey
    const month = monthOf(p.periodFrom)
    const byKey = paid.get(month) ?? new Map<StatutoryKey, StatutoryPaymentRef[]>()
    const list = byKey.get(key) ?? []
    list.push({
      id: p.id, paidAt: fmtPktDate(p.paidAt), paidCents: toCents(p.outputSetOffCents), cprNumber: p.cprNumber,
      linked: p.linked, journalEntryId: p.journalEntryId, bankAccountId: p.bankAccountId,
    })
    byKey.set(key, list)
    paid.set(month, byKey)
    // What the payment cleared from the payable (statutory payments take no set-off: = the money paid).
    bucket(paidCents, month)[key] += toCents(p.outputSetOffCents)
  }

  const balances = await Promise.all(months.map((m) => creditBalances(db, tenantId, PAYABLE_CODES, monthEnd(m))))

  const totals = Object.fromEntries(STATUTORY_KEYS.map((k) => [k, { accruedCents: 0, legacyAccruedCents: 0, reclassCents: 0, paidCents: 0, owedCents: 0 }])) as StatutorySummary['totals']
  const out: StatutoryMonth[] = months.map((month, i) => {
    const row = { month } as StatutoryMonth
    for (const key of STATUTORY_KEYS) {
      const acc = accrued.get(month)?.[key] ?? 0
      const leg = legacyByMonth.get(month)?.[key] ?? 0
      const rec = reclass.get(month)?.[key] ?? 0
      const pd = paidCents.get(month)?.[key] ?? 0
      const owed = acc + leg - pd
      row[key] = {
        key, account: ACCOUNT_OF[key],
        accruedCents: acc, legacyAccruedCents: leg, reclassCents: rec, paidCents: pd, owedCents: owed,
        overpaid: owed < 0,
        cleared: acc + leg > 0 && owed === 0,
        payments: paid.get(month)?.get(key) ?? [],
        balanceAtMonthEndCents: balances[i]!.get(ACCOUNT_OF[key]) ?? 0,
      }
      const t = totals[key]
      t.accruedCents += acc; t.legacyAccruedCents += leg; t.reclassCents += rec; t.paidCents += pd; t.owedCents += owed
    }
    return row
  })

  return {
    tenantId,
    from: months[0]!,
    to: months[months.length - 1]!,
    schemes: STATUTORY.map((s) => ({ ...s })),
    months: out,
    totals,
    legacyHrChallans: challans.map((c) => {
      const d = (c.data ?? {}) as Record<string, unknown>
      return {
        id: c.id,
        scheme: typeof d['scheme'] === 'string' ? d['scheme'] : null,
        month: c.effectiveDate ? monthOf(c.effectiveDate) : null,
        amountCents: c.amountCents ?? 0,
        paidOn: c.startDate ? fmtPktDate(c.startDate) : null,
        challanNo: typeof d['challanNo'] === 'string' ? d['challanNo'] : null,
        status: c.status,
      }
    }),
    reclass: reclassEntry ? { entryId: reclassEntry.id, entryDate: fmtPktDate(reclassEntry.entryDate) } : null,
  }
}

// ─── The one-time reclass out of 2090 / 2040 ────────────────────────────────

export interface ReclassAmounts { eobiCents: number; sessiCents: number; salaryTaxCents: number }

export interface ReclassPreview {
  tenantId: string
  /** The reclass already posted, with what it moved. Null = not done. */
  done: ({ entryId: string; entryDate: string } & ReclassAmounts) | null
  /** HR's EOBI / SESSI / salary tax credits on 2090 / 2040, net of reversals (every entry, ever). */
  hrSourced: ReclassAmounts
  /** Credit balances now. */
  balances: { accruedExpenses2090Cents: number; withholding2040Cents: number }
  /** What the panel offers: the HR amounts, never more than the accounts still hold. Zero once done. */
  suggested: ReclassAmounts
  /** HR entries dated / posted after the reclass that still moved 2090 / 2040 (e.g. a reversed old F&F) — fix by hand. */
  afterReclass: ReclassAmounts
  entries: Array<Omit<LegacyHrEntry, 'createdAt'>>
  /** Manual, bank-reconciliation and tax-payment entries that debited 2090 / 2040 — money already paid out of them. */
  manualDebits: Array<{ entryId: string; reference: string; entryDate: string; description: string; accountCode: string; debitCents: number; kind: 'manual' | 'reconciliation' | 'tax_payment' }>
}

const sumAmounts = (rows: Array<{ eobiCents: number; sessiCents: number; salaryTaxCents: number }>): ReclassAmounts =>
  rows.reduce((a, r) => ({ eobiCents: a.eobiCents + r.eobiCents, sessiCents: a.sessiCents + r.sessiCents, salaryTaxCents: a.salaryTaxCents + r.salaryTaxCents }),
    { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0 })

/** What the one-time reclass would move for `tenantId`, and whether it is done. */
export async function reclassPreview(db: Db, tenantId: string): Promise<ReclassPreview> {
  const debitKinds: Array<[string, 'manual' | 'reconciliation' | 'tax_payment']> = [
    ['manual:', 'manual'], ['reconciliation.adjustment:', 'reconciliation'], [`${TAX_PAYMENT_SOURCE}:`, 'tax_payment'],
  ]
  const [entries, balances, doneEntry, debits] = await Promise.all([
    legacyHrEntries(db, tenantId),
    creditBalances(db, tenantId, [LEGACY_STATUTORY_CODE, LEGACY_SALARY_TAX_CODE], END_OF_TIME),
    db.journalEntry.findFirst({
      where: { tenantId, reference: `${STATUTORY_RECLASS_SOURCE}:${tenantId}` },
      select: { id: true, entryDate: true, createdAt: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
    }),
    db.journalLine.findMany({
      where: {
        type: 'debit',
        account: { tenantId, code: { in: [LEGACY_STATUTORY_CODE, LEGACY_SALARY_TAX_CODE] } },
        journalEntry: { tenantId, OR: debitKinds.map(([p]) => ({ reference: { startsWith: p } })) },
      },
      select: {
        amountCents: true, account: { select: { code: true } },
        journalEntry: { select: { id: true, reference: true, entryDate: true, description: true } },
      },
      orderBy: { journalEntry: { entryDate: 'desc' } },
      take: 200,
    }),
  ])
  const hrSourced = sumAmounts(entries)
  const bal2090 = balances.get(LEGACY_STATUTORY_CODE) ?? 0
  const bal2040 = balances.get(LEGACY_SALARY_TAX_CODE) ?? 0

  let done: ReclassPreview['done'] = null
  let afterReclass: ReclassAmounts = { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0 }
  if (doneEntry) {
    const credit = (code: string) => doneEntry.lines
      .filter((l) => l.account.code === code)
      .reduce((t, l) => t + (l.type === 'credit' ? toCents(l.amountCents) : -toCents(l.amountCents)), 0)
    done = {
      entryId: doneEntry.id, entryDate: fmtPktDate(doneEntry.entryDate),
      eobiCents: credit(ACCT.EOBI_PAYABLE), sessiCents: credit(ACCT.SOCIAL_SECURITY_PAYABLE), salaryTaxCents: credit(ACCT.SALARY_TAX_PAYABLE),
    }
    afterReclass = sumAmounts(entries.filter((e) => e.createdAt > doneEntry.createdAt))
  }

  // The offer: HR's amounts, never below zero, never more than the accounts
  // still hold (EOBI and SESSI share 2090 — scaled down together).
  let suggested: ReclassAmounts = { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0 }
  if (!done) {
    const eobi = Math.max(0, hrSourced.eobiCents)
    const sessi = Math.max(0, hrSourced.sessiCents)
    const room90 = Math.max(0, bal2090)
    let e = eobi, s = sessi
    if (eobi + sessi > room90) {
      e = eobi + sessi > 0 ? Math.round(room90 * (eobi / (eobi + sessi))) : 0
      s = room90 - e
    }
    suggested = { eobiCents: e, sessiCents: s, salaryTaxCents: Math.min(Math.max(0, hrSourced.salaryTaxCents), Math.max(0, bal2040)) }
  }

  return {
    tenantId,
    done,
    hrSourced,
    balances: { accruedExpenses2090Cents: bal2090, withholding2040Cents: bal2040 },
    suggested,
    afterReclass,
    entries: entries.map(({ createdAt: _c, ...e }) => e),
    manualDebits: debits.map((d) => ({
      entryId: d.journalEntry.id,
      reference: d.journalEntry.reference ?? '',
      entryDate: fmtPktDate(d.journalEntry.entryDate),
      description: d.journalEntry.description,
      accountCode: d.account.code,
      debitCents: toCents(d.amountCents),
      kind: debitKinds.find(([p]) => (d.journalEntry.reference ?? '').startsWith(p))?.[1] ?? 'manual',
    })),
  }
}

/**
 * Post the one-time reclass for `tenantId`: Dr 2090 (EOBI + SESSI) / Dr 2040
 * (salary tax) / Cr 2043 / Cr 2044 / Cr 2042, dated today, reference
 * 'statutory.reclass:<tenantId>'. Each amount may be edited down from the
 * preview but never above what HR booked for it, and never above what 2090 /
 * 2040 still hold. Once only: 409 RECLASS_DONE; there is no reverse route.
 */
export async function postReclass(tenantId: string, amounts: ReclassAmounts, userId: string, note: string) {
  const { eobiCents, sessiCents, salaryTaxCents } = amounts
  for (const v of [eobiCents, sessiCents, salaryTaxCents]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new AppError('BAD_AMOUNT', 'Amounts must be whole paisa, zero or more', 422)
  }
  if (eobiCents + sessiCents + salaryTaxCents <= 0) {
    throw new AppError('NOTHING_TO_RECLASS', 'Enter an amount to move — every amount is zero', 422)
  }
  return prisma.$transaction(async (tx) => {
    // One reclass per company: a double click waits for the first, then finds it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext(${STATUTORY_RECLASS_SOURCE}::text))`
    const p = await reclassPreview(tx, tenantId)
    if (p.done) {
      throw new AppError('RECLASS_DONE', `The statutory reclass was already posted on ${p.done.entryDate} — it is done once per company`, 409)
    }
    const over: string[] = []
    if (eobiCents > Math.max(0, p.hrSourced.eobiCents)) over.push(`EOBI is more than the PKR ${(p.hrSourced.eobiCents / 100).toFixed(2)} HR booked to 2090`)
    if (sessiCents > Math.max(0, p.hrSourced.sessiCents)) over.push(`SESSI is more than the PKR ${(p.hrSourced.sessiCents / 100).toFixed(2)} HR booked to 2090`)
    if (salaryTaxCents > Math.max(0, p.hrSourced.salaryTaxCents)) over.push(`salary tax is more than the PKR ${(p.hrSourced.salaryTaxCents / 100).toFixed(2)} HR booked to 2040`)
    if (eobiCents + sessiCents > Math.max(0, p.balances.accruedExpenses2090Cents)) {
      over.push(`EOBI + SESSI is more than 2090 still holds (PKR ${(p.balances.accruedExpenses2090Cents / 100).toFixed(2)})`)
    }
    if (salaryTaxCents > Math.max(0, p.balances.withholding2040Cents)) {
      over.push(`salary tax is more than 2040 still holds (PKR ${(p.balances.withholding2040Cents / 100).toFixed(2)})`)
    }
    if (over.length > 0) throw new AppError('RECLASS_OVER_BALANCE', `Cannot move that much: ${over.join('; ')}.`, 422)

    const statutory = eobiCents + sessiCents
    await assertTemplateAccounts(tx, tenantId, [
      ...(statutory > 0 ? [LEGACY_STATUTORY_CODE] : []),
      ...(salaryTaxCents > 0 ? [LEGACY_SALARY_TAX_CODE, ACCT.SALARY_TAX_PAYABLE] : []),
      ...(eobiCents > 0 ? [ACCT.EOBI_PAYABLE] : []),
      ...(sessiCents > 0 ? [ACCT.SOCIAL_SECURITY_PAYABLE] : []),
    ])
    const memo = `Statutory reclass (H7): ${note}`.slice(0, 250)
    const all: JournalLineInput[] = [
      { accountCode: LEGACY_STATUTORY_CODE, type: 'debit', amountCents: statutory, memo },
      { accountCode: LEGACY_SALARY_TAX_CODE, type: 'debit', amountCents: salaryTaxCents, memo },
      { accountCode: ACCT.EOBI_PAYABLE, type: 'credit', amountCents: eobiCents, memo: `${memo} — EOBI` },
      { accountCode: ACCT.SOCIAL_SECURITY_PAYABLE, type: 'credit', amountCents: sessiCents, memo: `${memo} — SESSI / PESSI` },
      { accountCode: ACCT.SALARY_TAX_PAYABLE, type: 'credit', amountCents: salaryTaxCents, memo: `${memo} — salary tax` },
    ]
    const lines = all.filter((l) => l.amountCents > 0)
    const entryDate = new Date()
    const posted = await postJournalEntry({
      tenantId,
      sourceType: STATUTORY_RECLASS_SOURCE,
      sourceId: tenantId,
      description: 'Statutory payables reclass — EOBI / SESSI out of 2090, salary tax out of 2040, into 2042–2044',
      entryDate,
      postedBy: userId,
      lines,
    }, { tx })
    return {
      entryId: posted.entryId,
      reference: `${STATUTORY_RECLASS_SOURCE}:${tenantId}`,
      entryDate: fmtPktDate(entryDate),
      eobiCents, sessiCents, salaryTaxCents,
    }
  })
}

// ─── Period close (both warnings, never a block) ────────────────────────────

const fmtRs = (c: number) => `PKR ${(c / 100).toFixed(2)}`

export const statutoryCloseChecks: CloseCheck[] = [
  {
    key: 'statutory_reclass',
    severity: 'warn',
    overridable: false,
    async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
      const p = await reclassPreview(ctx.db as Db, ctx.tenantId)
      const left = p.done ? p.afterReclass : p.suggested
      const total = Math.abs(left.eobiCents) + Math.abs(left.sessiCents) + Math.abs(left.salaryTaxCents)
      if (total === 0) return null
      return {
        key: 'statutory_reclass',
        severity: 'warn',
        title: p.done ? 'HR moved 2090 / 2040 after the statutory reclass' : 'Statutory reclass not done',
        detail: p.done
          ? `Since the reclass, HR entries moved EOBI ${fmtRs(left.eobiCents)}, SESSI ${fmtRs(left.sessiCents)} and salary tax ${fmtRs(left.salaryTaxCents)} on 2090 / 2040 (for example a cancelled old full & final). Correct 2042–2044 with a manual journal.`
          : `Payroll booked EOBI ${fmtRs(left.eobiCents)}, SESSI ${fmtRs(left.sessiCents)} and salary tax ${fmtRs(left.salaryTaxCents)} to 2090 / 2040 before the statutory payables existed. Move them once in Accounting → Statutory payments.`,
        count: p.entries.length,
        cents: total,
        link: '/accounting/statutory',
        overridable: false,
      }
    },
  },
  {
    key: 'statutory_unpaid',
    severity: 'warn',
    overridable: false,
    async run(ctx: CloseCheckContext): Promise<CloseProblem | null> {
      // The last month's challans fall due next month — only the months before it.
      const months = [...ctx.months].sort()
      if (months.length < 2) return null
      const s = await statutorySummary(ctx.db as Db, ctx.tenantId, months[0]!, months[months.length - 2]!)
      const unpaid: Array<{ month: string; label: string; cents: number }> = []
      for (const m of s.months) {
        for (const st of STATUTORY) {
          const cell = m[st.key]
          if (cell.owedCents > 0) unpaid.push({ month: m.month, label: st.label, cents: cell.owedCents })
        }
      }
      if (unpaid.length === 0) return null
      const cents = unpaid.reduce((t, u) => t + u.cents, 0)
      return {
        key: 'statutory_unpaid',
        severity: 'warn',
        title: 'Statutory challans unpaid',
        detail: `Payroll accrued more than was paid: ${unpaid.slice(0, 6).map((u) => `${u.label} ${u.month} ${fmtRs(u.cents)}`).join('; ')}${unpaid.length > 6 ? ` and ${unpaid.length - 6} more` : ''}. Record the challans in Accounting → Statutory payments.`,
        count: unpaid.length,
        cents,
        months: [...new Set(unpaid.map((u) => u.month))],
        link: '/accounting/statutory',
        overridable: false,
      }
    },
  },
]
