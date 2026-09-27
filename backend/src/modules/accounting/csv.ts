// The ONE CSV writer and the ONE backend PKR formatter (D16).
//
// CSV: RFC 4180-ish — quotes only when needed. Every cell goes through the
// same escape, which also guards against spreadsheet formula injection (a cell
// starting with = + - @ tab or CR is prefixed with ') while leaving plain
// numbers — including negative and thousands-grouped amounts — as numbers.
//
//   toCsv(records, columns?) — accountant exports: header row from the keys,
//                              CRLF rows, UTF-8 BOM so Excel reads non-ASCII.
//   csv(rows)                — array-of-arrays (HR reports / payroll bank
//                              files): no BOM, LF rows, arrays joined "; ",
//                              dates as YYYY-MM-DD.

const BOM = '﻿'

// A plain number, optionally negative, optionally thousands-grouped
// ("-1,234.56"). These are never formula-prefixed.
const NUMERIC = /^-?\d[\d,]*(\.\d+)?$/

/** One CSV cell. */
export function csvCell(v: unknown): string {
  const s = v == null ? '' : Array.isArray(v) ? v.join('; ') : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
  const numeric = typeof v === 'number' || NUMERIC.test(s)
  const safe = !numeric && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Array<Record<string, string | number | null | undefined>>, columns?: string[]): string {
  if (rows.length === 0) return BOM
  const cols = columns ?? Object.keys(rows[0]!)
  const header = cols.map(csvCell).join(',')
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\r\n')
  return `${BOM}${header}\r\n${body}\r\n`
}

export function csv(rows: Array<Array<unknown>>): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n')
}

export interface FmtPkrOptions {
  /** Prefix "PKR " (receipts, WhatsApp). Default false — accountants apply it themselves. */
  symbol?: boolean
  /** 2 (default) shows paisa; 0 rounds to whole rupees. */
  decimals?: 0 | 2
  /** Thousands separators (en-PK). Default true. */
  group?: boolean
}

/**
 * PKR paisa → text. Default "1,234.56". `{ symbol: true, group: false }` gives
 * the receipt's "PKR 1234.56"; `{ symbol: true, decimals: 0, group: false }`
 * the WhatsApp bot's "PKR 1234".
 */
export function fmtPkr(cents: number, opts: FmtPkrOptions = {}): string {
  const { symbol = false, decimals = 2, group = true } = opts
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const rupees = decimals === 0 ? Math.round(abs / 100) : Math.floor(abs / 100)
  const whole = group ? rupees.toLocaleString('en-PK') : String(rupees)
  const frac = decimals === 0 ? '' : `.${String(abs % 100).padStart(2, '0')}`
  return `${symbol ? 'PKR ' : ''}${sign}${whole}${frac}`
}
