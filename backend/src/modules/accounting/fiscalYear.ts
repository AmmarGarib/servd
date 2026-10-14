// Fiscal years and the income-tax year — THE one year definition (people
// plan; H29: 30 June year end, virtual roll-forward).
//
// A company's fiscal year ends on the last day of `Tenant.fiscalYearEndMonth`
// (1–12, default 6 = 30 June). All boundaries are PKT (Asia/Karachi, UTC+5, no
// DST), like every accounting period: a year starts 00:00 PKT on the 1st of the
// month after the end month and ends 23:59:59.999 PKT on the last day of the
// end month — the same inclusive end-of-day instant a PeriodLock stores.
//
// The income-tax year (ITO 2001) is always 1 July – 30 June, named by the year
// it ends in (tax year 2027 = 1 Jul 2026 – 30 Jun 2027). The fixed-asset tax
// schedule reads it ONLY through `taxYearOf`.
//
// This part is pure (wave 0). The database helpers (fiscalYearEndMonthOf,
// fiscalYearsFor) are added below by the close build.

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = Prisma.TransactionClient | PrismaClient

const PKT_OFFSET_MS = 5 * 3600_000

/** H29: a company's fiscal year ends 30 June unless the CEO sets otherwise. */
export const DEFAULT_FISCAL_YEAR_END_MONTH = 6

export interface FiscalYear {
  /** 00:00 PKT on the first day of the year. */
  start: Date
  /** 23:59:59.999 PKT on the last day of the year (inclusive). */
  end: Date
  /** 'FY2026-27' (or 'FY2026' when the year is a calendar year). */
  label: string
}

function assertEndMonth(endMonth: number): void {
  if (!Number.isInteger(endMonth) || endMonth < 1 || endMonth > 12) {
    throw new RangeError(`fiscal year end month must be 1–12, got ${endMonth}`)
  }
}

/** The PKT calendar year and month (1–12) of an instant. */
function pktYearMonth(at: Date): { year: number; month: number } {
  const p = new Date(at.getTime() + PKT_OFFSET_MS)
  return { year: p.getUTCFullYear(), month: p.getUTCMonth() + 1 }
}

/** 23:59:59.999 PKT on the last day of `month` (1–12) of `year`. */
function pktEndOfMonth(year: number, month: number): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return new Date(Date.UTC(year, month - 1, lastDay, 23, 59, 59, 999) - PKT_OFFSET_MS)
}

/** 00:00 PKT on the 1st of `month` (1–12) of `year`. */
function pktStartOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - PKT_OFFSET_MS)
}

/** The fiscal year ending in `endYear` for a company whose year ends in `endMonth`. */
function fiscalYearEnding(endMonth: number, endYear: number): FiscalYear {
  const startYear = endMonth === 12 ? endYear : endYear - 1
  const startMonth = endMonth === 12 ? 1 : endMonth + 1
  const label = startYear === endYear
    ? `FY${endYear}`
    : `FY${startYear}-${String(endYear % 100).padStart(2, '0')}`
  return { start: pktStartOfMonth(startYear, startMonth), end: pktEndOfMonth(endYear, endMonth), label }
}

/** The fiscal year that contains `at`, for a year ending in `endMonth` (1–12). */
export function fiscalYearOf(endMonth: number, at: Date): FiscalYear {
  assertEndMonth(endMonth)
  const { year, month } = pktYearMonth(at)
  return fiscalYearEnding(endMonth, month <= endMonth ? year : year + 1)
}

/** The income-tax year (1 July – 30 June) that contains `at`, named by the year it ends in. */
export function taxYearOf(at: Date): { taxYear: number; start: Date; end: Date } {
  const { year, month } = pktYearMonth(at)
  const taxYear = month <= 6 ? year : year + 1
  return { taxYear, start: pktStartOfMonth(taxYear - 1, 7), end: pktEndOfMonth(taxYear, 6) }
}

/**
 * True when a close from `prevLock` (exclusive) through `newLock` (inclusive)
 * passes a fiscal year end — the close is then a year-end close. `prevLock`
 * null (never closed) counts every year end on or before `newLock`; to bound a
 * first close, pass the instant just before the company's first entry.
 */
export function isFiscalYearEndInRange(endMonth: number, prevLock: Date | null, newLock: Date): boolean {
  assertEndMonth(endMonth)
  // The latest year end on or before newLock.
  const { year, month } = pktYearMonth(newLock)
  let end = pktEndOfMonth(month >= endMonth ? year : year - 1, endMonth)
  if (end.getTime() > newLock.getTime()) end = pktEndOfMonth(pktYearMonth(end).year - 1, endMonth)
  return prevLock === null || end.getTime() > prevLock.getTime()
}

// ─── Database helpers (the close build) ──────────────────────────────────────

/** A company's own fiscal year end month (1–12) — `Tenant.fiscalYearEndMonth`, else 30 June (H29). */
export async function fiscalYearEndMonthOf(db: Db, tenantId: string): Promise<number> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { fiscalYearEndMonth: true } })
  const m = t?.fiscalYearEndMonth
  return Number.isInteger(m) && m! >= 1 && m! <= 12 ? m! : DEFAULT_FISCAL_YEAR_END_MONTH
}

export interface CompanyFiscalYear {
  tenantId: string
  endMonth: number
  start: Date
  end: Date
  label: string
}

/**
 * The fiscal year each company is in AT `at` — a report passes its own asOf,
 * never today, so a balance sheet as of last June shows last year's split.
 * Every company keeps its own year end; one in the list that does not exist
 * gets the default year end (it has no books to split anyway).
 */
export async function fiscalYearsFor(db: Db, tenantIds: string[], at: Date): Promise<CompanyFiscalYear[]> {
  if (tenantIds.length === 0) return []
  const rows = await db.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, fiscalYearEndMonth: true } })
  const monthOf = new Map(rows.map((r) => [r.id, r.fiscalYearEndMonth]))
  return tenantIds.map((tenantId) => {
    const m = monthOf.get(tenantId)
    const endMonth = Number.isInteger(m) && m! >= 1 && m! <= 12 ? m! : DEFAULT_FISCAL_YEAR_END_MONTH
    const fy = fiscalYearOf(endMonth, at)
    return { tenantId, endMonth, start: fy.start, end: fy.end, label: fy.label }
  })
}

/**
 * Whether the company's books have been closed across a fiscal year end — for
 * any of `endMonths` (pass the current and a proposed month): some year end
 * lies between its first journal entry and its latest lock. Changing the year
 * end then re-presents years already closed, so it needs the CEO's reason.
 */
export async function closedAcrossYearEnd(db: Db, tenantId: string, endMonths: number[]): Promise<boolean> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  if (!lock) return false
  const first = await db.journalEntry.findFirst({ where: { tenantId }, orderBy: { entryDate: 'asc' }, select: { entryDate: true } })
  const from = new Date((first?.entryDate ?? lock.lockedThrough).getTime() - 1)
  if (from.getTime() >= lock.lockedThrough.getTime()) return false
  return endMonths.some((m) => isFiscalYearEndInRange(m, from, lock.lockedThrough))
}
