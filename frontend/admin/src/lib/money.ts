// Centralised money formatting for the admin UI (D18 — pages import these
// instead of keeping their own copies). Three flavours:
//   fmtPkr       "PKR 1,234.56"  full precision, ledger / accounting views
//   fmtPkrWhole  "PKR 1,235"     whole rupees, operational screens and tickets
//   fmtPkrShort  "PKR 1.2M"      abbreviated, KPI cards and dense tables
// Paisa in, text out. Negative amounts keep their sign in front of "PKR".

export function fmtPkr(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const rupees = Math.floor(abs / 100)
  const paisa = abs % 100
  return `${sign}PKR ${rupees.toLocaleString('en-PK')}.${String(paisa).padStart(2, '0')}`
}

export function fmtPkrWhole(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return '—'
  const sign = cents < 0 ? '-' : ''
  return `${sign}PKR ${Math.round(Math.abs(cents) / 100).toLocaleString('en-PK')}`
}

export function fmtPkrShort(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return '—'
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

/** ISO instant -> `YYYY-MM-DDTHH:mm` Karachi wall time (for datetime-local inputs). */
export function isoToPktLocal(iso: string): string {
  return new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 16)
}

/** `YYYY-MM-DDTHH:mm` read as Karachi wall time -> ISO instant (UTC). */
export function pktLocalToIso(local: string): string {
  return new Date(`${local.length === 16 ? `${local}:00` : local}+05:00`).toISOString()
}

/** Local calendar day of a Date (browser's Y/M/D) as YYYY-MM-DD — never via toISOString. */
export function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
