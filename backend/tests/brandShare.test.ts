// lib/brandShare.ts — the H20 brand split of brand-less stock amounts.
//
// What this guards:
//   - Shares come from each brand's recipe use of THAT item (Σ theoreticalQty
//     of the item's sale movements in the company), in a trailing window.
//   - Nothing used → [] (head office); other items, other kinds and other
//     companies never count.
//   - splitCents is largest-remainder: integer parts that always sum to the
//     total exactly, for odd totals, negative totals and many brands.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { brandUsageShares, splitCents, parseBrandShares, BRAND_SHARE_DAYS } from '../src/lib/brandShare.js'

const DAY = 86_400_000
let A: string
let B: string
let c1: string
let c2: string
let c3: string
let cB: string
let seq = 0

async function item(tenantId: string) {
  return prisma.inventoryItem.create({ data: { name: `Share item ${++seq}`, unit: 'kg', tenantId } })
}

async function use(tenantId: string, itemId: string, conceptId: string | null, theoreticalQty: number | null, daysAgo: number, kind = 'sale') {
  await prisma.stockMovement.create({
    data: {
      tenantId, inventoryItemId: itemId, kind, qty: 0, valueCents: 0, unitCostCents: 0, costClass: 'food',
      theoreticalQty, conceptId, sourceType: 'test', sourceId: `use-${++seq}`, occurredAt: new Date(Date.now() - daysAgo * DAY),
    },
  })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Shares A', slug: 'brand-share-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Shares B', slug: 'brand-share-b' } })).id
  c1 = (await prisma.concept.create({ data: { name: 'Share One', slug: 'brand-share-1', type: 'restaurant', tenantId: A } })).id
  c2 = (await prisma.concept.create({ data: { name: 'Share Two', slug: 'brand-share-2', type: 'restaurant', tenantId: A } })).id
  c3 = (await prisma.concept.create({ data: { name: 'Share Three', slug: 'brand-share-3', type: 'restaurant', tenantId: A } })).id
  cB = (await prisma.concept.create({ data: { name: 'Share Bee', slug: 'brand-share-b1', type: 'restaurant', tenantId: B } })).id
})

describe('brandUsageShares', () => {
  it('splits by each brand\'s theoretical use of the item, sorted by brand', async () => {
    const it0 = await item(A)
    await use(A, it0.id, c1, 3, 1)
    await use(A, it0.id, c1, 3, 2)
    await use(A, it0.id, c2, 2, 3)
    const shares = await brandUsageShares(prisma, A, it0.id, new Date())
    const byConcept = Object.fromEntries(shares.map((s) => [s.conceptId, s.share]))
    expect(byConcept).toEqual({ [c1]: 0.75, [c2]: 0.25 })
    expect(shares.map((s) => s.conceptId)).toEqual([...shares.map((s) => s.conceptId)].sort())
    expect(shares.reduce((s, x) => s + x.share, 0)).toBeCloseTo(1, 12)
  })

  it('reads only the trailing window', async () => {
    const it0 = await item(A)
    await use(A, it0.id, c1, 5, BRAND_SHARE_DAYS + 1)   // outside the 30 days
    await use(A, it0.id, c2, 1, 2)
    expect(await brandUsageShares(prisma, A, it0.id, new Date())).toEqual([{ conceptId: c2, share: 1 }])
    // A longer window takes the old use in; a window ending in the past ignores later use.
    const wide = Object.fromEntries((await brandUsageShares(prisma, A, it0.id, new Date(), 60)).map((s) => [s.conceptId, s.share]))
    expect(wide[c1]).toBeCloseTo(5 / 6, 12)
    expect(await brandUsageShares(prisma, A, it0.id, new Date(Date.now() - 10 * DAY))).toEqual([{ conceptId: c1, share: 1 }])
  })

  it('nobody used it → [] (head office); other kinds, items, brand-less rows and companies never count', async () => {
    const it0 = await item(A)
    await use(A, it0.id, c1, 4, 1, 'waste')
    await use(A, it0.id, null, 4, 1)
    await use(A, it0.id, c2, null, 1)
    const other = await item(A)
    await use(A, other.id, c3, 9, 1)
    expect(await brandUsageShares(prisma, A, it0.id, new Date())).toEqual([])
    // A B row on an A item (never written by the ledger) is still not A's use.
    await use(B, it0.id, cB, 7, 1)
    expect(await brandUsageShares(prisma, A, it0.id, new Date())).toEqual([])
  })
})

describe('splitCents', () => {
  it('largest remainder: parts are integers and sum exactly', () => {
    expect(splitCents(100, [{ conceptId: 'a', share: 1 / 3 }, { conceptId: 'b', share: 1 / 3 }, { conceptId: 'c', share: 1 / 3 }]))
      .toEqual([{ conceptId: 'a', cents: 34 }, { conceptId: 'b', cents: 33 }, { conceptId: 'c', cents: 33 }])
    // 1001 × 2/3 = 667.33, × 1/3 = 333.67 → the larger remainder takes the odd paisa.
    expect(splitCents(1001, [{ conceptId: 'a', share: 2 / 3 }, { conceptId: 'b', share: 1 / 3 }]))
      .toEqual([{ conceptId: 'a', cents: 667 }, { conceptId: 'b', cents: 334 }])
    for (const total of [1, 7, 99, 12345, 9_000_000_001]) {
      const shares = [0.137, 0.2, 0.333, 0.33].map((share, i) => ({ conceptId: `k${i}`, share }))
      const parts = splitCents(total, shares)
      expect(parts.reduce((s, p) => s + p.cents, 0)).toBe(total)
      for (const p of parts) expect(Number.isInteger(p.cents)).toBe(true)
    }
  })

  it('negative totals keep their sign; no usable share → one brand-less part; zero → nothing', () => {
    const neg = splitCents(-101, [{ conceptId: 'a', share: 0.5 }, { conceptId: 'b', share: 0.5 }])
    expect(neg.reduce((s, p) => s + p.cents, 0)).toBe(-101)
    expect(neg.every((p) => p.cents < 0)).toBe(true)
    expect(splitCents(500, [])).toEqual([{ conceptId: null, cents: 500 }])
    expect(splitCents(500, [{ conceptId: 'a', share: 0 }])).toEqual([{ conceptId: null, cents: 500 }])
    expect(splitCents(0, [{ conceptId: 'a', share: 1 }])).toEqual([])
    // Tiny totals over many brands drop the empty parts.
    expect(splitCents(1, [{ conceptId: 'a', share: 0.5 }, { conceptId: 'b', share: 0.5 }])).toEqual([{ conceptId: 'a', cents: 1 }])
    expect(() => splitCents(1.5, [])).toThrow()
  })

  it('stored shares read back; anything else is "not computed"', () => {
    expect(parseBrandShares([{ conceptId: 'a', share: 0.4 }, { bad: 1 }])).toEqual([{ conceptId: 'a', share: 0.4 }])
    expect(parseBrandShares([])).toEqual([])
    expect(parseBrandShares(null)).toBeNull()
    expect(parseBrandShares({ conceptId: 'a' })).toBeNull()
  })
})
