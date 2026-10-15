// Projections trade on the real calendar (owner, 2026-10-16): each month's
// trading days are its days minus the brand's closed weekdays (Monday by
// default), counted on the actual calendar from the scenario's Month 1.
import { describe, it, expect } from 'vitest'
import { tradingDaysIn, addMonths, defaultStartPeriod } from '../src/modules/projections/routes.js'

describe('trading days', () => {
  it('counts the actual Mondays of each month', () => {
    expect(tradingDaysIn('2026-10', [1])).toBe(27) // 31 days, 4 Mondays
    expect(tradingDaysIn('2026-11', [1])).toBe(25) // 30 days, 5 Mondays
    expect(tradingDaysIn('2026-02', [1])).toBe(24) // 28 days, 4 Mondays
  })
  it('no closed days = every day; two closed days', () => {
    expect(tradingDaysIn('2026-10', [])).toBe(31)
    expect(tradingDaysIn('2026-10', [1, 2])).toBe(23) // 4 Mondays + 4 Tuesdays
  })
  it('months roll over the year and Month 1 defaults to next month', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01')
    expect(addMonths('2026-01', 11)).toBe('2026-12')
    expect(defaultStartPeriod(new Date('2026-10-16T10:00:00Z'))).toBe('2026-11')
    expect(defaultStartPeriod(new Date('2026-12-31T20:00:00Z'))).toBe('2027-02') // already 1 Jan in Karachi
  })
})
