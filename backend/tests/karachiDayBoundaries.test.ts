// Date-only values ('YYYY-MM-DD') compared against the current INSTANT gave
// answers that depended on the hour (Karachi is UTC+5, no DST). Each site now
// compares Karachi calendar days. Pinned on both sides of the boundaries:
//   2026-10-15T03:00:00Z = 08:00 PKT on the 15th (before noon PKT)
//   2026-10-15T09:00:00Z = 14:00 PKT on the 15th (after noon PKT)
//   2026-10-14T20:00:00Z = 01:00 PKT on the 15th (UTC still says the 14th)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { isFuturePktDay } from '../src/modules/fixedAssets/events.js'
import { parseEffectiveDate } from '../src/modules/fixedAssets/requests.js'
import { quickBuyPaidAt } from '../src/modules/financePlanning/routes.js'
import { assertNotFuturePaid, cashflowWindow } from '../src/modules/opex/routes.js'
import { overdueCutoff } from '../src/modules/procurement/routes.js'
import { effectDue } from '../src/modules/hr/service.js'

const MORNING = new Date('2026-10-15T03:00:00Z')
const AFTERNOON = new Date('2026-10-15T09:00:00Z')
const SMALL_HOURS = new Date('2026-10-14T20:00:00Z')
const ALL = [MORNING, AFTERNOON, SMALL_HOURS]

afterEach(() => { vi.useRealTimers() })

/** How the fixed-asset routes read a date-only input: noon PKT of the day. */
const noonPkt = (day: string) => new Date(`${day}T12:00:00+05:00`)
/** How opex / procurement / HR store a date-only input: UTC midnight. */
const utcMidnight = (day: string) => new Date(day)

describe('fixed assets — capitalisation in-service date and smallwares count date', () => {
  it.each(ALL)('today is accepted, tomorrow refused (now %s)', (now) => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    expect(isFuturePktDay(noonPkt('2026-10-15'))).toBe(false)
    expect(isFuturePktDay(noonPkt('2026-10-14'))).toBe(false)
    expect(isFuturePktDay(noonPkt('2026-10-16'))).toBe(true)
    // the count route's parse path
    expect(isFuturePktDay(parseEffectiveDate('2026-10-15')!)).toBe(false)
    expect(isFuturePktDay(parseEffectiveDate('2026-10-16')!)).toBe(true)
  })

  it('the old instant check refused today before noon PKT (regression shape)', () => {
    vi.useFakeTimers(); vi.setSystemTime(MORNING)
    expect(noonPkt('2026-10-15').getTime() > Date.now()).toBe(true) // what used to 422
    expect(isFuturePktDay(noonPkt('2026-10-15'))).toBe(false)
  })
})

describe('Quick buy paidAt', () => {
  it.each(ALL)('today and earlier pass, tomorrow is refused with no slack (now %s)', (now) => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    expect(quickBuyPaidAt('2026-10-15').toISOString()).toBe('2026-10-15T07:00:00.000Z')
    expect(() => quickBuyPaidAt('2026-10-14')).not.toThrow()
    expect(() => quickBuyPaidAt('2026-10-16')).toThrow(/not in the future/)
  })

  it('a garbage date is refused', () => {
    expect(() => quickBuyPaidAt('2026-13-45', MORNING)).toThrow(/real date/)
  })
})

describe('OpEx — paid date', () => {
  it.each(ALL)('today accepted, tomorrow refused (now %s)', (now) => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    expect(() => assertNotFuturePaid(utcMidnight('2026-10-15'))).not.toThrow()
    expect(() => assertNotFuturePaid(utcMidnight('2026-10-14'))).not.toThrow()
    expect(() => assertNotFuturePaid(null)).not.toThrow()
    expect(() => assertNotFuturePaid(undefined)).not.toThrow()
    expect(() => assertNotFuturePaid(utcMidnight('2026-10-16'))).toThrow(/has not come yet/)
  })

  it('a full timestamp later today (PKT) is still today', () => {
    expect(() => assertNotFuturePaid(new Date('2026-10-15T23:30:00+05:00'), MORNING)).not.toThrow()
    expect(() => assertNotFuturePaid(new Date('2026-10-16T00:10:00+05:00'), MORNING)).toThrow()
  })
})

describe('OpEx — cash-flow window', () => {
  it.each(ALL)('a line due today stays in, yesterday drops out (now %s)', (now) => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const { from, to } = cashflowWindow()
    const inWindow = (d: Date) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime()
    expect(from.toISOString()).toBe('2026-10-15T00:00:00.000Z')
    expect(inWindow(utcMidnight('2026-10-15'))).toBe(true)
    expect(inWindow(utcMidnight('2026-10-14'))).toBe(false)
    expect(inWindow(utcMidnight('2027-01-13'))).toBe(true)  // day 90
    expect(inWindow(utcMidnight('2027-01-14'))).toBe(false) // day 91
  })
})

describe('Procurement — ?overdue=true', () => {
  it.each(ALL)('due today is not overdue, due yesterday is (now %s)', (now) => {
    vi.useFakeTimers(); vi.setSystemTime(now)
    const overdue = (due: Date) => due.getTime() < overdueCutoff().getTime()
    expect(overdue(utcMidnight('2026-10-15'))).toBe(false)
    expect(overdue(utcMidnight('2026-10-16'))).toBe(false)
    expect(overdue(utcMidnight('2026-10-14'))).toBe(true)
  })
})

describe('HR — effectDue', () => {
  const rec = (effectiveDate: Date | null) => ({ section: 'salary_revision', category: null, effectiveDate } as never)

  it.each(ALL)("today's effect applies, tomorrow's waits (now %s)", (now) => {
    expect(effectDue(rec(utcMidnight('2026-10-15')), now)).toBe(true)
    expect(effectDue(rec(utcMidnight('2026-10-14')), now)).toBe(true)
    expect(effectDue(rec(null), now)).toBe(true)
    expect(effectDue(rec(utcMidnight('2026-10-16')), now)).toBe(false)
  })

  it('separations and probation extensions apply at approval regardless of date', () => {
    expect(effectDue({ section: 'resignation', category: null, effectiveDate: utcMidnight('2027-01-01') } as never, SMALL_HOURS)).toBe(true)
    expect(effectDue({ section: 'probation_review', category: 'extend', effectiveDate: utcMidnight('2027-01-01') } as never, SMALL_HOURS)).toBe(true)
  })
})
