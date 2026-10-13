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
