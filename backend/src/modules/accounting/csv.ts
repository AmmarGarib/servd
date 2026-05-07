// Tiny CSV writer for accountant exports. RFC 4180-ish: quotes only when
// needed, CRLF row separator (Excel-friendly on Windows), UTF-8 with BOM so
// non-ASCII names don't garble in MS Excel.

const BOM = '﻿'

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

export function toCsv(rows: Array<Record<string, string | number | null | undefined>>, columns?: string[]): string {
  if (rows.length === 0) return BOM
  const cols = columns ?? Object.keys(rows[0]!)
  const header = cols.map(csvEscape).join(',')
  const body = rows.map((r) => cols.map((c) => csvEscape(r[c])).join(',')).join('\r\n')
  return `${BOM}${header}\r\n${body}\r\n`
}

// PKR centavos → "1,234.56" (no currency symbol — accountants apply it themselves)
export function fmtPkr(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const rupees = Math.floor(abs / 100)
  const paisa = abs % 100
  return `${sign}${rupees.toLocaleString('en-PK')}.${String(paisa).padStart(2, '0')}`
}
