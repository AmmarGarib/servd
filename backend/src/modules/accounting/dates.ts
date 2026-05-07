// PKT (Asia/Karachi, UTC+5, no DST) date helpers for accounting reports.
// All financial periods are operator-local — "October P&L" means PKT October.

const PKT_OFFSET_HOURS = 5

// Parse a YYYY-MM-DD string (or ISO datetime) as a PKT date and return the
// UTC instant corresponding to its start-of-day-in-PKT.
export function parsePktStartOfDay(input: string): Date {
  const dateOnly = input.slice(0, 10)
  // 00:00 PKT = 19:00 UTC the previous day
  return new Date(`${dateOnly}T00:00:00+05:00`)
}

// End of day inclusive — 23:59:59.999 PKT.
export function parsePktEndOfDay(input: string): Date {
  const dateOnly = input.slice(0, 10)
  return new Date(`${dateOnly}T23:59:59.999+05:00`)
}

// Today in PKT, returning [start, end] UTC instants.
export function pktToday(): { from: Date; to: Date } {
  const now = new Date()
  // Shift to PKT, then drop time
  const pktNow = new Date(now.getTime() + PKT_OFFSET_HOURS * 3600_000)
  const yyyymmdd = pktNow.toISOString().slice(0, 10)
  return { from: parsePktStartOfDay(yyyymmdd), to: parsePktEndOfDay(yyyymmdd) }
}

// Resolves a date-range query — defaults to "today PKT" when both ends are absent;
// otherwise treats either bound as start/end of PKT day.
export function resolveDateRange(dateFrom?: string, dateTo?: string): { from: Date; to: Date } {
  if (!dateFrom && !dateTo) return pktToday()
  const today = pktToday()
  return {
    from: dateFrom ? parsePktStartOfDay(dateFrom) : today.from,
    to:   dateTo   ? parsePktEndOfDay(dateTo)     : today.to,
  }
}

// Format a date as YYYY-MM-DD in PKT, suitable for report headings / CSV.
export function fmtPktDate(d: Date): string {
  return new Date(d.getTime() + PKT_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10)
}
