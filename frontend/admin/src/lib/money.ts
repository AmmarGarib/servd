// Centralised money formatting for the admin UI. Two flavours: full precision
// for ledger views, abbreviated ("PKR 1.2M") for KPI cards.

export function fmtPkr(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const rupees = Math.floor(abs / 100)
  const paisa = abs % 100
  return `${sign}PKR ${rupees.toLocaleString('en-PK')}.${String(paisa).padStart(2, '0')}`
}

export function fmtPkrShort(cents: number): string {
  const n = cents / 100
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}PKR ${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000)     return `${sign}PKR ${(abs / 1_000).toFixed(0)}K`
  return `${sign}PKR ${abs.toFixed(0)}`
}

export function todayPktIso(): string {
  // YYYY-MM-DD in PKT (UTC+5)
  const now = new Date()
  const pkt = new Date(now.getTime() + 5 * 3600_000)
  return pkt.toISOString().slice(0, 10)
}

export function startOfMonthPktIso(): string {
  const now = new Date()
  const pkt = new Date(now.getTime() + 5 * 3600_000)
  return `${pkt.toISOString().slice(0, 7)}-01`
}
