// Fixed assets v2 — the depreciation schedule (pure maths, PKT months).
//
//   - the lifetime total is exactly cost − salvage, the last month takes the
//     remainder;
//   - full-month convention: the in-service month is charged, the disposal
//     month is not;
//   - a 24-month smallwares layer, land never charged, a leasehold capped at
//     the lease end;
//   - M-01: legacy months charged out of order never push the total past
//     cost − salvage;
//   - impairment, change of estimate and partial outs act prospectively;
//   - NBV at a past date; the PKT month boundary (00:30 PKT on the 1st).
import { describe, it, expect } from 'vitest'
import {
  planCharges, forecast, nextMonthlyCharge, nbvAt, periodOfPkt, lastDayPkt, endOfMonthPkt, startOfMonthPkt,
  addMonths, lastPeriodEndingBy, lifeWindow, type ScheduleAsset, type ScheduleAdjustment,
} from '../src/modules/fixedAssets/schedule.js'

const pkt = (s: string) => new Date(`${s}+05:00`)
const sumOf = (xs: Array<{ amountCents: number }>) => xs.reduce((t, x) => t + x.amountCents, 0)

function asset(over: Partial<ScheduleAsset> = {}): ScheduleAsset {
  return {
    inServiceAt: pkt('2025-01-15T12:00:00'),
    costCents: 100_001,
    salvageCents: 1,
    usefulLifeMonths: 36,
    method: 'straight_line',
    ...over,
  }
}

describe('PKT months', () => {
  it('00:30 PKT on the 1st is already the new month; 23:30 PKT on the last day is not', () => {
    expect(periodOfPkt(pkt('2026-03-01T00:30:00'))).toBe('2026-03')
    expect(periodOfPkt(pkt('2026-02-28T23:30:00'))).toBe('2026-02')
    // The same instants in UTC sit in the other month — the old engine's UTC months were wrong.
    expect(pkt('2026-03-01T00:30:00').getUTCMonth()).toBe(1)
  })

  it('month boundaries', () => {
    expect(lastDayPkt('2026-02').toISOString()).toBe(pkt('2026-02-28T12:00:00').toISOString())
    expect(startOfMonthPkt('2026-03').toISOString()).toBe(pkt('2026-03-01T00:00:00').toISOString())
    expect(endOfMonthPkt('2026-02').toISOString()).toBe(pkt('2026-02-28T23:59:59.999').toISOString())
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(lastPeriodEndingBy(pkt('2026-09-30T23:59:59.999'))).toBe('2026-09')
    expect(lastPeriodEndingBy(pkt('2026-09-29T23:59:59.999'))).toBe('2026-08')
  })

  it('an asset in service at 00:30 PKT on the 1st starts that month', () => {
    const a = asset({ inServiceAt: pkt('2026-03-01T00:30:00'), costCents: 1200, salvageCents: 0, usefulLifeMonths: 12 })
    expect(planCharges(a, new Map(), [], '2026-03')).toEqual([{ period: '2026-03', amountCents: 100 }])
    expect(planCharges(a, new Map(), [], '2026-02')).toEqual([])
  })
})

describe('the plan', () => {
  it('charges exactly cost − salvage over the life, the remainder in the last month', () => {
    const plan = planCharges(asset(), new Map(), [], '2030-12')
    expect(plan).toHaveLength(36)
    expect(plan[0]!.period).toBe('2025-01')
    expect(plan[35]!.period).toBe('2027-12')
    expect(sumOf(plan)).toBe(100_000)
    // remaining ÷ remaining months, floored: 2777 or 2778 a month — never drifts, the last month closes it exactly
    expect(plan[0]!.amountCents).toBe(2777)
    expect(plan.every((p) => p.amountCents === 2777 || p.amountCents === 2778)).toBe(true)
    expect(plan[35]!.amountCents).toBe(100_000 - sumOf(plan.slice(0, 35)))

    const small = planCharges(asset({ costCents: 100, salvageCents: 0, usefulLifeMonths: 3 }), new Map(), [], '2030-01')
    expect(small.map((p) => p.amountCents)).toEqual([33, 33, 34])
  })

  it('full-month convention: the in-service month is charged, the disposal month is not', () => {
    const a = asset({ inServiceAt: pkt('2025-01-31T22:00:00'), costCents: 1200, salvageCents: 0, usefulLifeMonths: 12, disposedAt: pkt('2025-06-10T10:00:00') })
    const plan = planCharges(a, new Map(), [], '2025-12')
    expect(plan.map((p) => p.period)).toEqual(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05'])
    expect(plan.every((p) => p.amountCents === 100)).toBe(true)
  })

  it('a 24-month smallwares layer', () => {
    const layer = asset({ inServiceAt: pkt('2026-01-05T12:00:00'), costCents: 240_000, salvageCents: 0, usefulLifeMonths: 24 })
    const plan = planCharges(layer, new Map(), [], '2030-01')
    expect(plan).toHaveLength(24)
    expect(plan.every((p) => p.amountCents === 10_000)).toBe(true)
    expect(plan[23]!.period).toBe('2027-12')
  })

  it('land is never charged', () => {
    expect(planCharges(asset({ method: 'none', usefulLifeMonths: 0 }), new Map(), [], '2030-01')).toEqual([])
    expect(planCharges(asset({ depreciable: false }), new Map(), [], '2030-01')).toEqual([])
    expect(lifeWindow(asset({ method: 'none' }))).toBeNull()
  })

  it('a leasehold is capped at the lease end', () => {
    const fitOut = asset({ inServiceAt: pkt('2026-01-10T12:00:00'), costCents: 2_400_000, salvageCents: 0, usefulLifeMonths: 120, leaseEndsAt: pkt('2027-12-31T12:00:00') })
    const plan = planCharges(fitOut, new Map(), [], '2040-01')
    expect(plan).toHaveLength(24)
    expect(sumOf(plan)).toBe(2_400_000)
  })

  it('skips months already charged and charges strictly in order', () => {
    const a = asset({ costCents: 1200, salvageCents: 0, usefulLifeMonths: 12 })
    const charged = new Map([['2025-01', 100], ['2025-02', 100]])
    expect(planCharges(a, charged, [], '2025-04').map((p) => p.period)).toEqual(['2025-03', '2025-04'])
  })

  it('M-01: legacy months charged out of order never pass cost − salvage', () => {
    // The old engine charged months 2..10 first; month 10 took "the remainder"
    // of what had been charged BEFORE it, so the life was already used up.
    const a = asset({ inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 1000, salvageCents: 0, usefulLifeMonths: 10 })
    const legacy = new Map<string, number>()
    for (let m = 2; m <= 9; m++) legacy.set(`2025-${String(m).padStart(2, '0')}`, 100)
    legacy.set('2025-10', 200)
    expect(planCharges(a, legacy, [], '2026-12')).toEqual([]) // the old engine would charge January again → 1100

    // One later month charged first: the rest re-spreads and the total is exact.
    const partial = new Map([['2025-05', 100]])
    const plan = planCharges(a, partial, [], '2026-12')
    expect(plan).toHaveLength(9)
    expect(sumOf(plan) + 100).toBe(1000)
  })

  it('an impairment acts prospectively', () => {
    const a = asset({ inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 1200, salvageCents: 0, usefulLifeMonths: 12 })
    const charged = new Map([['2025-01', 100], ['2025-02', 100], ['2025-03', 100]])
    const adj: ScheduleAdjustment[] = [{ period: '2025-04', kind: 'impairment', cents: 300 }]
    const plan = planCharges(a, charged, adj, '2026-12')
    expect(plan).toHaveLength(9)
    expect(plan[0]!.amountCents).toBe(66) // 600 left over 9 months
    expect(sumOf(plan) + 300 + 300).toBe(1200)
  })

  it('a change of estimate acts prospectively (the row carries the new life and salvage)', () => {
    // 3 months charged of a 12-month life; from month 4 the remaining life is 3 months and salvage 300.
    const a = asset({ inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 1200, salvageCents: 300, usefulLifeMonths: 6 })
    const charged = new Map([['2025-01', 100], ['2025-02', 100], ['2025-03', 100]])
    const plan = planCharges(a, charged, [], '2026-12')
    expect(plan.map((p) => [p.period, p.amountCents])).toEqual([['2025-04', 200], ['2025-05', 200], ['2025-06', 200]])
  })

  it('a partial out (half a pool layer written off) re-spreads what remains', () => {
    // 10 units, 1000, 10 months; 2 months charged (200); 5 units out: cost 500 and accumulated 100 leave.
    const layer = asset({ inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 500, salvageCents: 0, usefulLifeMonths: 10 })
    const charged = new Map([['2025-01', 100], ['2025-02', 100]])
    const adj: ScheduleAdjustment[] = [{ period: '2025-03', kind: 'accum_out', cents: 100 }]
    const plan = planCharges(layer, charged, adj, '2026-12')
    expect(plan).toHaveLength(8)
    expect(plan.every((p) => p.amountCents === 50)).toBe(true)
  })

  it('a layer split off by a unit transfer charges only from its own month, to the source\'s life end', () => {
    const split = asset({
      inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 400, salvageCents: 0, usefulLifeMonths: 10,
      carriedAccumulatedCents: 120, chargeFrom: pkt('2025-04-02T09:00:00'),
    })
    const plan = planCharges(split, new Map(), [], '2026-12')
    expect(plan.map((p) => p.period)).toEqual(['2025-04', '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10'])
    expect(sumOf(plan)).toBe(280)
  })

  it('forecast and next monthly charge', () => {
    const a = asset({ inServiceAt: pkt('2025-01-10T12:00:00'), costCents: 1200, salvageCents: 0, usefulLifeMonths: 12 })
    const charged = new Map([['2025-01', 100]])
    expect(forecast(a, charged)).toHaveLength(11)
    expect(nextMonthlyCharge(a, charged)).toBe(100)
    expect(nextMonthlyCharge(a, new Map(Array.from({ length: 12 }, (_, i) => [`2025-${String(i + 1).padStart(2, '0')}`, 100])))).toBe(0)
  })
})

describe('NBV at a date', () => {
  const base = {
    originalCostCents: 1200, costCents: 1200, carriedAccumulatedCents: 0,
    inServiceAt: pkt('2025-01-10T12:00:00'), status: 'active', disposedAt: null,
  }
  const charges = [
    { period: '2025-01', amountCents: 100 }, { period: '2025-02', amountCents: 100 }, { period: '2025-03', amountCents: 100 },
  ]

  it('counts only months ended by the date', () => {
    expect(nbvAt(base, [], charges, pkt('2025-02-28T23:59:59.999'))).toEqual({ costCents: 1200, accumulatedCents: 200, nbvCents: 1000 })
    expect(nbvAt(base, [], charges, pkt('2025-06-30T23:59:59.999')).nbvCents).toBe(900)
  })

  it('is zero before it is on the books, after disposal and when voided', () => {
    expect(nbvAt(base, [], charges, pkt('2024-12-31T23:59:59.999')).costCents).toBe(0)
    expect(nbvAt({ ...base, status: 'disposed', disposedAt: pkt('2025-04-02T12:00:00') }, [], charges, pkt('2025-05-01T00:00:00')).nbvCents).toBe(0)
    expect(nbvAt({ ...base, status: 'disposed', disposedAt: pkt('2025-04-02T12:00:00') }, [], charges, pkt('2025-03-31T23:59:59.999')).nbvCents).toBe(900)
    expect(nbvAt({ ...base, status: 'voided' }, [], charges, pkt('2025-06-30T00:00:00')).nbvCents).toBe(0)
  })

  it('takes impairments and partial outs on their dates, and ignores a charge reversed by then', () => {
    const events = [
      { kind: 'impairment', status: 'posted', effectiveDate: pkt('2025-04-15T12:00:00'), amountCents: 300 },
      { kind: 'pool_write_off_alloc', status: 'posted', effectiveDate: pkt('2025-05-15T12:00:00'), costOutCents: 600, accumOutCents: 300 },
      { kind: 'impairment', status: 'pending', effectiveDate: pkt('2025-04-15T12:00:00'), amountCents: 999 },
    ]
    expect(nbvAt(base, events, charges, pkt('2025-04-30T23:59:59.999'))).toEqual({ costCents: 1200, accumulatedCents: 600, nbvCents: 600 })
    expect(nbvAt(base, events, charges, pkt('2025-05-31T23:59:59.999'))).toEqual({ costCents: 600, accumulatedCents: 300, nbvCents: 300 })
    const reversed = [...charges.slice(0, 2), { period: '2025-03', amountCents: 100, reversedAt: pkt('2025-04-05T10:00:00') }]
    expect(nbvAt(base, [], reversed, pkt('2025-03-31T23:59:59.999')).accumulatedCents).toBe(300)
    expect(nbvAt(base, [], reversed, pkt('2025-04-30T23:59:59.999')).accumulatedCents).toBe(200)
  })
})

// ── The equipment guard (classes.ts — used by bills, OpEx, petty cash, cash requests, stock items) ──
import { looksLikeEquipment, assertNotEquipmentLine, ASSET_CLASS_DEFAULTS, SMALLWARE_TYPES } from '../src/modules/fixedAssets/classes.js'

describe('the class list', () => {
  it('one list: codes per class, smallwares pooled over 24 months, land never depreciated', () => {
    const by = new Map(ASSET_CLASS_DEFAULTS.map((c) => [c.key, c]))
    expect(ASSET_CLASS_DEFAULTS).toHaveLength(10)
    expect(by.get('kitchen_equipment')).toMatchObject({ costAccountCode: '1510', accumAccountCode: '1591', defaultLifeMonths: 60, taxRateBp: 1500, taxInitialAllowanceBp: 2500 })
    expect(by.get('it_equipment')).toMatchObject({ costAccountCode: '1530', accumAccountCode: '1593', defaultLifeMonths: 36, taxRateBp: 3000 })
    expect(by.get('smallwares')).toMatchObject({ costAccountCode: '1560', accumAccountCode: '1599', pooled: true, defaultLifeMonths: 24 })
    expect(by.get('land')).toMatchObject({ costAccountCode: '1500', accumAccountCode: null, depreciable: false })
    expect(new Set(ASSET_CLASS_DEFAULTS.map((c) => c.accumAccountCode).filter(Boolean)).size).toBe(9)
    expect(SMALLWARE_TYPES).toContain('plates')
  })
})

describe('the equipment guard', () => {
  it('spots equipment and smallwares, not repairs, disposables or consumables', () => {
    expect(looksLikeEquipment('Deep fryer 2-basket').matched).toMatch(/deep fryer/i)
    expect(looksLikeEquipment('Stainless steel ladles').matched).toMatch(/ladles/i)
    expect(looksLikeEquipment('Dell laptop for the office').matched).toMatch(/laptop/i)
    expect(looksLikeEquipment('UPS 3kVA').matched).toBe('UPS')
    expect(looksLikeEquipment('Mobile top ups').matched).toBeNull()
    expect(looksLikeEquipment('Fryer repair').matched).toBeNull()
    expect(looksLikeEquipment('Oven servicing — annual').matched).toBeNull()
    expect(looksLikeEquipment('Kraft bowl 500ml').matched).toBeNull()
    expect(looksLikeEquipment('Paper plates').matched).toBeNull()
    expect(looksLikeEquipment('Fryer oil 16L').matched).toBeNull()
    expect(looksLikeEquipment('Chicken thighs').matched).toBeNull()
  })

  it('refuses equipment as an expense; finance or the CEO may override with a reason', () => {
    const fryer = { description: 'Deep fryer', expenseAccountCode: '6050' }
    expect(() => assertNotEquipmentLine(fryer, { role: 'procurement' })).toThrow(expect.objectContaining({ code: 'USE_CAPEX', statusCode: 422 }))
    expect(() => assertNotEquipmentLine({ ...fryer, notEquipment: true, notEquipmentReason: 'It is a toy fryer for display' }, { role: 'procurement' }))
      .toThrow(expect.objectContaining({ code: 'OVERRIDE_NOT_ALLOWED', statusCode: 403 }))
    expect(() => assertNotEquipmentLine({ ...fryer, notEquipment: true, notEquipmentReason: 'short' }, { role: 'finance' }))
      .toThrow(expect.objectContaining({ code: 'OVERRIDE_REASON_REQUIRED' }))
    expect(assertNotEquipmentLine({ ...fryer, notEquipment: true, notEquipmentReason: 'Rented fryer part, not an asset' }, { role: 'finance' })).toEqual({ overridden: true })
    expect(assertNotEquipmentLine({ description: 'Fryer repair', expenseAccountCode: '6050' }, { role: 'procurement' })).toEqual({ overridden: false })
    // A register-controlled code or 1340 is never an expense, override or not.
    for (const code of ['1510', '1599', '2012', '1340']) {
      expect(() => assertNotEquipmentLine({ description: 'Anything', expenseAccountCode: code, notEquipment: true, notEquipmentReason: 'I really insist on it' }, { role: 'admin' }))
        .toThrow(expect.objectContaining({ code: 'USE_CAPEX' }))
    }
  })
})
