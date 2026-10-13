// Brand usage shares (H20) — THE one rule for charging a brand-less stock
// amount to brands.
//
// Waste with no brand, count differences, ad-hoc prep draws, price
// differences on stock already used (5060), issue-on-receipt consumables and
// GRNI write-offs carry no brand of their own. Each is split across the
// company's brands by how much of THAT ingredient each brand's recipes used in
// the trailing window (default 30 days): Σ StockMovement.theoreticalQty of the
// item's `sale` rows, by conceptId. Nobody used it in the window → [] → the
// amount stays brand-less (head office).
//
// The posting stores the shares it used on the movement rows
// (StockMovement.brandShares), so the food-cost report reads what was posted
// instead of recomputing a split that may since have moved. `[]` stored means
// "computed: no brand used it"; null means "not computed yet".
//
// splitCents is largest-remainder rounding: the parts always sum exactly to
// the total, so a split pair of journal lines stays balanced to the paisa.

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = Prisma.TransactionClient | PrismaClient

export interface BrandShare { conceptId: string; share: number }

/** Default trailing window of recipe use (days). */
export const BRAND_SHARE_DAYS = 30

const DAY_MS = 86_400_000

/**
 * Each brand's share of the item's recipe use in (at − days, at]: Σ
 * theoreticalQty of the company's `sale` movements of the item by conceptId,
 * divided by the total. Sorted by conceptId (deterministic splits). [] when no
 * brand used the item in the window.
 */
export async function brandUsageShares(
  db: Db, tenantId: string, itemId: string, at: Date, days: number = BRAND_SHARE_DAYS,
): Promise<BrandShare[]> {
  const from = new Date(at.getTime() - Math.max(0, days) * DAY_MS)
  const rows = await db.stockMovement.groupBy({
    by: ['conceptId'],
    where: {
      tenantId,
      inventoryItemId: itemId,
      kind: 'sale',
      conceptId: { not: null },
      theoreticalQty: { not: null },
      occurredAt: { gt: from, lte: at },
    },
    _sum: { theoreticalQty: true },
  })
  const used = rows
    .map((r) => ({ conceptId: r.conceptId as string, qty: r._sum.theoreticalQty ?? 0 }))
    .filter((r) => r.conceptId && Number.isFinite(r.qty) && r.qty > 0)
  const total = used.reduce((s, r) => s + r.qty, 0)
  if (!(total > 0)) return []
  return used
    .sort((a, b) => (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0))
    .map((r) => ({ conceptId: r.conceptId, share: r.qty / total }))
}

/**
 * Split `totalCents` across `shares` with largest-remainder rounding: every
 * part is an integer and the parts sum EXACTLY to the total (negative totals
 * split the same way, signs kept). Shares are normalised by their sum; zero /
 * negative / non-finite shares are ignored. No usable share → one brand-less
 * part. A zero total → []. Parts of 0 paisa are dropped.
 */
export function splitCents(totalCents: number, shares: ReadonlyArray<BrandShare>): Array<{ conceptId: string | null; cents: number }> {
  if (!Number.isInteger(totalCents)) throw new Error(`splitCents: total must be integer paisa (got ${totalCents})`)
  if (totalCents === 0) return []
  const usable = shares.filter((s) => s.conceptId && Number.isFinite(s.share) && s.share > 0)
  const weight = usable.reduce((s, x) => s + x.share, 0)
  if (usable.length === 0 || !(weight > 0)) return [{ conceptId: null, cents: totalCents }]

  const sign = totalCents < 0 ? -1 : 1
  const abs = Math.abs(totalCents)
  const parts = usable.map((s, i) => {
    const exact = (abs * s.share) / weight
    const floor = Math.floor(exact)
    return { i, conceptId: s.conceptId, cents: floor, rem: exact - floor }
  })
  let left = abs - parts.reduce((s, p) => s + p.cents, 0)
  // Largest remainder first; ties by input order (brandUsageShares sorts by conceptId).
  const byRem = [...parts].sort((a, b) => (b.rem - a.rem) || (a.i - b.i))
  for (let k = 0; left > 0 && byRem.length > 0; k = (k + 1) % byRem.length) {
    byRem[k]!.cents += 1
    left -= 1
  }
  // Float noise can floor a part one above its true value: take it back from
  // the smallest remainders so the parts still sum exactly.
  for (let k = byRem.length - 1; left < 0 && k >= 0; k--) {
    if (byRem[k]!.cents > 0) { byRem[k]!.cents -= 1; left += 1 }
  }
  return parts
    .filter((p) => p.cents !== 0)
    .map((p) => ({ conceptId: p.conceptId, cents: sign * p.cents }))
}

/**
 * Read stored brand shares (StockMovement.brandShares) back. Returns null when
 * nothing usable is stored (null / not an array); `[]` when the posting found
 * no brand (head office).
 */
export function parseBrandShares(v: Prisma.JsonValue | null | undefined): BrandShare[] | null {
  if (!Array.isArray(v)) return null
  const out: BrandShare[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) continue
    const o = x as Record<string, unknown>
    if (typeof o['conceptId'] === 'string' && typeof o['share'] === 'number' && Number.isFinite(o['share'])) {
      out.push({ conceptId: o['conceptId'], share: o['share'] })
    }
  }
  return out
}

/** Shares as a plain JSON value for StockMovement.brandShares. */
export function brandSharesJson(shares: ReadonlyArray<BrandShare>): Prisma.InputJsonValue {
  return shares.map((s) => ({ conceptId: s.conceptId, share: s.share }))
}
