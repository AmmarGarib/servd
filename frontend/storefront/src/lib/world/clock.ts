// The world clock: what time it is in Karachi, and what part of the day that
// makes it.
//
// Pure and server-safe (no 'use client', no DOM). The layout calls it on the
// server to stamp <html data-daypart>, the middleware calls parseDayPart on the
// edge, and the client hooks in lib/world/* re-run it on a timer. Everything is
// computed in Asia/Karachi so a reader abroad sees the kitchens' day, not their
// own.

export type DayPart = 'morning' | 'lunch' | 'afternoon' | 'dinner' | 'late' | 'night'

export const DAYPARTS: readonly DayPart[] = ['morning', 'lunch', 'afternoon', 'dinner', 'late', 'night']

export interface KarachiTime {
  /** 0 = Sunday … 6 = Saturday, as Date.getDay(). */
  day: number
  /** Minutes since Karachi midnight, 0..1439. */
  mins: number
  hour: number
  minute: number
}

const TZ = 'Asia/Karachi'
const PKT_OFFSET_MS = 5 * 3600_000 // Pakistan has no DST; UTC+5 all year.
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

// One formatter, built lazily. Constructing Intl.DateTimeFormat is the
// expensive part and this runs on every tick of every hook.
let formatter: Intl.DateTimeFormat | null | undefined
function karachiFormatter(): Intl.DateTimeFormat | null {
  if (formatter !== undefined) return formatter
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })
  } catch {
    formatter = null
  }
  return formatter
}

function fallbackNow(d: Date): KarachiTime {
  // Shift the instant by +5h and read it back in UTC — independent of the
  // host's own timezone, which is what the old getTimezoneOffset maths got
  // wrong (it read local fields off a UTC-shifted date).
  const k = new Date(d.getTime() + PKT_OFFSET_MS)
  const hour = k.getUTCHours()
  const minute = k.getUTCMinutes()
  return { day: k.getUTCDay(), hour, minute, mins: hour * 60 + minute }
}

/** The current day and minute in Karachi. */
export function karachiNow(d: Date = new Date()): KarachiTime {
  const f = karachiFormatter()
  if (!f) return fallbackNow(d)
  try {
    const parts = f.formatToParts(d)
    let wd = '', hh = '', mm = ''
    for (const p of parts) {
      if (p.type === 'weekday') wd = p.value
      else if (p.type === 'hour') hh = p.value
      else if (p.type === 'minute') mm = p.value
    }
    const day = WEEKDAYS.indexOf(wd.slice(0, 3).toLowerCase())
    const hour = Number(hh) % 24 // some engines print '24' for midnight
    const minute = Number(mm)
    if (day < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return fallbackNow(d)
    return { day, hour, minute, mins: hour * 60 + minute }
  } catch {
    return fallbackNow(d)
  }
}

/** '9:42pm', '12:05am', '7:00am'. */
export function karachiClockLabel(d: Date = new Date()): string {
  const { hour, minute } = karachiNow(d)
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}:${String(minute).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`
}

/**
 * morning 300–659 · lunch 660–899 · afternoon 900–1079 · dinner 1080–1319 ·
 * late 1320–1439 and 0–119 · night 120–299.
 */
export function dayPartFor(mins: number): DayPart {
  const m = ((Math.floor(mins) % 1440) + 1440) % 1440
  if (m < 120) return 'late'
  if (m < 300) return 'night'
  if (m < 660) return 'morning'
  if (m < 900) return 'lunch'
  if (m < 1080) return 'afternoon'
  if (m < 1320) return 'dinner'
  return 'late'
}

export interface WorldMood {
  dayPart: DayPart
  /** 0..1, how lively the crowd and ambient motion should be. */
  energy: number
  /** 0..1, how drowsy the crowd is. */
  sleepy: number
  /** late and night: the page is under a dark sky. */
  dark: boolean
  label: string
}

const ENERGY: Record<DayPart, number> = {
  morning: 0.35, lunch: 0.8, afternoon: 0.45, dinner: 1, late: 0.6, night: 0.15,
}
const SLEEPY: Record<DayPart, number> = {
  morning: 0, lunch: 0, afternoon: 0, dinner: 0, late: 0.3, night: 0.9,
}
const MOOD_LABEL: Record<DayPart, string> = {
  morning: 'breakfast hours',
  lunch: 'lunch rush',
  afternoon: 'afternoon lull',
  dinner: 'dinner rush',
  late: 'late night',
  night: 'the small hours',
}

export function moodFor(dayPart: DayPart, openCount: number): WorldMood {
  let energy = ENERGY[dayPart]
  let sleepy = SLEEPY[dayPart]
  if (openCount === 0) {
    energy *= 0.4
    sleepy = Math.max(sleepy, 0.6)
  }
  return {
    dayPart,
    energy,
    sleepy,
    dark: dayPart === 'late' || dayPart === 'night',
    label: MOOD_LABEL[dayPart],
  }
}

/** A valid DayPart, or null (including for 'live', which means "no override"). */
export function parseDayPart(v: unknown): DayPart | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return (DAYPARTS as readonly string[]).includes(s) ? (s as DayPart) : null
}
