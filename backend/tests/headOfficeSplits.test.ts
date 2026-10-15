// Head office (D1) — the one rounding rule for a recharge split (spec §0 / §4.2):
// floor(|base| × bps / 10000) per company; at exactly 100% the leftover paisa go
// to the largest share (ties: the lowest company id) so the head office nets to
// zero; below 100% the leftover stays with the head office; the sign is
// re-applied and zero lines are dropped. Pure — no database.
import { describe, it, expect } from 'vitest'
import { splitByBps, assertSplitLines, FULL_BPS } from '../src/modules/headOffices/splits.js'
import { MAX_MONEY_CENTS } from '../src/lib/money.js'

const sum = (xs: Array<{ amountCents: number }>) => xs.reduce((s, x) => s + x.amountCents, 0)
const byId = (xs: Array<{ companyTenantId: string; amountCents: number }>) => Object.fromEntries(xs.map((x) => [x.companyTenantId, x.amountCents]))

describe('splitByBps', () => {
  it('100,001 paisa over 3 × 3333 bps (99.99%): each gets the floor, the leftover stays with the head office', () => {
    const out = splitByBps(100_001, [
      { companyTenantId: 'c', shareBps: 3333 },
      { companyTenantId: 'a', shareBps: 3333 },
      { companyTenantId: 'b', shareBps: 3333 },
    ])
    expect(out.map((l) => l.companyTenantId)).toEqual(['a', 'b', 'c'])
    expect(out.every((l) => l.amountCents === 33_330)).toBe(true)
    expect(sum(out)).toBe(99_990)
    expect(100_001 - sum(out)).toBe(11) // retained
  })

  it('100% nets the head office to zero: the residue goes to the largest share', () => {
    const out = splitByBps(100_001, [
      { companyTenantId: 'a', shareBps: 3333 },
      { companyTenantId: 'b', shareBps: 3334 },
      { companyTenantId: 'c', shareBps: 3333 },
    ])
    expect(sum(out)).toBe(100_001)
    expect(byId(out)).toEqual({ a: 33_330, b: 33_340 + 1, c: 33_330 })
  })

  it('residue tie-break: equal largest shares → the lowest company id', () => {
    const out = splitByBps(101, [
      { companyTenantId: 'zeta', shareBps: 5000 },
      { companyTenantId: 'alpha', shareBps: 5000 },
    ])
    expect(byId(out)).toEqual({ alpha: 51, zeta: 50 })
    const three = splitByBps(100, [
      { companyTenantId: 'b', shareBps: 4000 },
      { companyTenantId: 'c', shareBps: 4000 },
      { companyTenantId: 'a', shareBps: 2000 },
    ])
    // floors: b 40, c 40, a 20 → no residue
    expect(byId(three)).toEqual({ a: 20, b: 40, c: 40 })
    const odd = splitByBps(7, [
      { companyTenantId: 'b', shareBps: 4000 },
      { companyTenantId: 'c', shareBps: 4000 },
      { companyTenantId: 'a', shareBps: 2000 },
    ])
    // floors: b 2, c 2, a 1 = 5 → residue 2 to b (largest, lowest id of the tie)
    expect(byId(odd)).toEqual({ a: 1, b: 4, c: 2 })
  })

  it('the owner split 37.5% / 62.5% of a month', () => {
    const out = splitByBps(80_000_000, [
      { companyTenantId: 'gsfoods', shareBps: 3750 },
      { companyTenantId: 'gsxviva', shareBps: 6250 },
    ])
    expect(byId(out)).toEqual({ gsfoods: 30_000_000, gsxviva: 50_000_000 })
  })

  it('a negative base is split on its absolute value and re-signed (credits to the companies)', () => {
    const out = splitByBps(-100_001, [
      { companyTenantId: 'a', shareBps: 3333 },
      { companyTenantId: 'b', shareBps: 3334 },
      { companyTenantId: 'c', shareBps: 3333 },
    ])
    expect(byId(out)).toEqual({ a: -33_330, b: -33_341, c: -33_330 })
    expect(sum(out)).toBe(-100_001)
    const partial = splitByBps(-100_001, [{ companyTenantId: 'a', shareBps: 3333 }, { companyTenantId: 'b', shareBps: 3333 }])
    expect(byId(partial)).toEqual({ a: -33_330, b: -33_330 })
  })

  it('zero lines are dropped (and a zero base gives nothing)', () => {
    const out = splitByBps(3, [{ companyTenantId: 'a', shareBps: 1 }, { companyTenantId: 'b', shareBps: 9999 }])
    // a: floor(3 × 1 / 10000) = 0, b gets 2 + the residue 1
    expect(out).toEqual([{ companyTenantId: 'b', shareBps: 9999, amountCents: 3 }])
    expect(splitByBps(0, [{ companyTenantId: 'a', shareBps: 10_000 }])).toEqual([])
    expect(splitByBps(5, [])).toEqual([])
  })

  it('stays exact on the largest amount the books allow (no float drift past 2^53)', () => {
    const base = MAX_MONEY_CENTS - 1
    const out = splitByBps(base, [{ companyTenantId: 'a', shareBps: 3333 }, { companyTenantId: 'b', shareBps: 6667 }])
    expect(out.every((l) => Number.isSafeInteger(l.amountCents))).toBe(true)
    expect(sum(out)).toBe(base)
    // floor(base × 3333 / 10000) computed by hand: base = 89_999_999_999_999
    expect(byId(out).a).toBe(29_996_999_999_999)
    expect(() => splitByBps(1.5, [{ companyTenantId: 'a', shareBps: 10_000 }])).toThrow()
  })

  it('is pure: the input lines are not changed', () => {
    const lines = [{ companyTenantId: 'b', shareBps: 5000 }, { companyTenantId: 'a', shareBps: 5000 }]
    const copy = JSON.parse(JSON.stringify(lines))
    splitByBps(101, lines)
    expect(lines).toEqual(copy)
  })
})

describe('assertSplitLines', () => {
  it('shares 1..10000, no company twice, total ≤ 100%', () => {
    expect(assertSplitLines([{ companyTenantId: 'a', shareBps: 3750 }, { companyTenantId: 'b', shareBps: 6250 }])).toBe(FULL_BPS)
    expect(() => assertSplitLines([{ companyTenantId: 'a', shareBps: 6000 }, { companyTenantId: 'b', shareBps: 4001 }])).toThrow(/100%/)
    expect(() => assertSplitLines([{ companyTenantId: 'a', shareBps: 0 }])).toThrow()
    expect(() => assertSplitLines([{ companyTenantId: 'a', shareBps: 10_001 }])).toThrow()
    expect(() => assertSplitLines([{ companyTenantId: 'a', shareBps: 1 }, { companyTenantId: 'a', shareBps: 1 }])).toThrow(/twice/)
  })
})
