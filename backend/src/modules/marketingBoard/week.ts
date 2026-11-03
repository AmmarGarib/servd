// Karachi weeks and months for the marketing board's weekly report and the tracker (PKT = UTC+5, no DST).

const PKT_MS = 5 * 3_600_000
const DAY = 86_400_000

/** YYYY-MM-DD of the Karachi day an instant falls on. */
export function pktDay(d: Date): string {
  return new Date(d.getTime() + PKT_MS).toISOString().slice(0, 10)
}

/** The Monday (YYYY-MM-DD, Karachi) of the week a Karachi day falls in. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00.000Z`)
  const dow = new Date(t).getUTCDay() // 0 = Sunday
  const back = (dow + 6) % 7
  return new Date(t - back * DAY).toISOString().slice(0, 10)
}

/** The week starting on Monday `monday` (Karachi) as instants: [from, to). */
export function weekWindow(monday: string): { from: Date; to: Date; monday: string; sunday: string } {
  const from = new Date(Date.parse(`${monday}T00:00:00.000Z`) - PKT_MS)
  const to = new Date(from.getTime() + 7 * DAY)
  return { from, to, monday, sunday: new Date(Date.parse(`${monday}T00:00:00.000Z`) + 6 * DAY).toISOString().slice(0, 10) }
}

/** The Monday of the week BEFORE the one `now` falls in (Karachi). */
export function lastWeekMonday(now: Date = new Date()): string {
  const thisMonday = mondayOf(pktDay(now))
  return new Date(Date.parse(`${thisMonday}T00:00:00.000Z`) - 7 * DAY).toISOString().slice(0, 10)
}

export function isYmd(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`))
}
