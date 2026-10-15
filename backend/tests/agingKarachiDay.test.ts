// AP and AR aging count days past due in KARACHI calendar days (UTC+5, no
// DST). dueDate is stored as UTC midnight of its day; asOf is an instant.
// Between 00:00 and 05:00 PKT a bill due yesterday is already 1 day overdue.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agingBucket as apBucket, apDaysPastDue } from '../src/modules/procurement/service.js'
import { agingBucket as arBucket } from '../src/modules/receivables/routes.js'

const due = (d: string) => new Date(d)            // as stored: UTC midnight of the day
const AS_OF = new Date('2026-10-15T20:30:00Z')    // 01:30 PKT on 16 Oct

describe('aging in Karachi calendar days', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a bill due yesterday is 1 day overdue at 01:30 PKT (AP)', () => {
    expect(apDaysPastDue(due('2026-10-15'), AS_OF)).toBe(1)
    expect(apBucket(apDaysPastDue(due('2026-10-15'), AS_OF))).toBe('1_30')
  })

  it('a bill due today is current at 01:30 PKT (AP)', () => {
    expect(apDaysPastDue(due('2026-10-16'), AS_OF)).toBe(0)
    expect(apBucket(apDaysPastDue(due('2026-10-16'), AS_OF))).toBe('current')
    expect(apBucket(apDaysPastDue(due('2026-10-20'), AS_OF))).toBe('current')
  })

  it('AP boundaries 30/31 and 60/61 and 90/91', () => {
    // asOf Karachi date = 2026-10-16
    expect(apDaysPastDue(due('2026-09-16'), AS_OF)).toBe(30)
    expect(apBucket(apDaysPastDue(due('2026-09-16'), AS_OF))).toBe('1_30')
    expect(apBucket(apDaysPastDue(due('2026-09-15'), AS_OF))).toBe('31_60')
    expect(apDaysPastDue(due('2026-08-17'), AS_OF)).toBe(60)
    expect(apBucket(apDaysPastDue(due('2026-08-17'), AS_OF))).toBe('31_60')
    expect(apBucket(apDaysPastDue(due('2026-08-16'), AS_OF))).toBe('61_90')
    expect(apBucket(apDaysPastDue(due('2026-07-18'), AS_OF))).toBe('61_90')
    expect(apBucket(apDaysPastDue(due('2026-07-17'), AS_OF))).toBe('90_plus')
  })

  it('a PKT-midnight instant reads as its own Karachi day', () => {
    expect(apDaysPastDue(new Date('2026-10-15T00:00:00+05:00'), AS_OF)).toBe(1)
  })

  it('AR: same rules, with an explicit now', () => {
    expect(arBucket(due('2026-10-15'), AS_OF)).toBe('1-30')
    expect(arBucket(due('2026-10-16'), AS_OF)).toBe('current')
    expect(arBucket(due('2026-09-16'), AS_OF)).toBe('1-30')
    expect(arBucket(due('2026-09-15'), AS_OF)).toBe('31-60')
    expect(arBucket(due('2026-08-17'), AS_OF)).toBe('31-60')
    expect(arBucket(due('2026-08-16'), AS_OF)).toBe('61-90')
    expect(arBucket(due('2026-07-17'), AS_OF)).toBe('90+')
  })

  it('AR: the default now follows the system clock (vi.setSystemTime)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(AS_OF)
    expect(arBucket(due('2026-10-15'))).toBe('1-30')
    expect(arBucket(due('2026-10-16'))).toBe('current')
    // 18:59 UTC on the 15th = 23:59 PKT the 15th: due the 15th is still current
    vi.setSystemTime(new Date('2026-10-15T18:59:00Z'))
    expect(arBucket(due('2026-10-15'))).toBe('current')
  })
})
