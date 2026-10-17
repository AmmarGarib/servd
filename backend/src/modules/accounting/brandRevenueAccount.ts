// One sales account per brand (owner, 2026-10-17: "One sales account per brand").
//
// Every brand credits its sales to its OWN revenue account in its company's
// chart, recorded on `Concept.revenueAccountCode` and read through
// journal.ts `revenueCodeForConcept`:
//
//   • the legacy brands keep their fixed codes (CONCEPT_REVENUE_CODE:
//     4001–4007, template accounts every company has);
//   • every other brand gets "Sales — <brand>" at the first code in
//     BRAND_SALES_RANGE (4010–4089) that its company's chart does not use.
//     40xx is brand sales everywhere (reports.ts isBrandSalesCode), so the
//     new accounts count in brand sales, the food-cost denominator and the
//     P&L with no further change. 4090 (Other / Catering) stays the fallback
//     for a brand with no code; 41xx (service, delivery fee) and 42xx (other
//     income) are never brand sales.
//
// Assigned at brand create (POST /concepts, POST /tenants/apply-template) and
// at every boot for brands that still have none (ensureBrandRevenueAccounts —
// idempotent: a brand with a code is left alone, so a renamed or re-numbered
// account survives). Per company under an advisory lock, so two brands created
// at once never take the same code.
//
// History never moves: sales already credited to 4090 stay there, and their
// refunds / reversals debit 4090 (orderPosting.ts saleBookingOf reads the
// account the sale credited).

import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { CONCEPT_REVENUE_CODE, REVENUE_FALLBACK_CODE, revenueCodeForConcept } from './journal.js'
import { sumCents } from '../../lib/money.js'

/** The codes a brand's own sales account is numbered from (inclusive). */
export const BRAND_SALES_RANGE = { from: 4010, to: 4089 } as const

export function isBrandAccountRangeCode(code: string): boolean {
  if (!/^\d{4}$/.test(code)) return false
  const n = Number(code)
  return n >= BRAND_SALES_RANGE.from && n <= BRAND_SALES_RANGE.to
}

export function brandSalesAccountName(brandName: string): string {
  return `Sales — ${brandName}`.slice(0, 120)
}

/** The first code in BRAND_SALES_RANGE that is in none of `taken`, or null when the range is full. */
export function firstFreeBrandCode(taken: Iterable<string>): string | null {
  const used = new Set(taken)
  for (let n = BRAND_SALES_RANGE.from; n <= BRAND_SALES_RANGE.to; n++) {
    const code = String(n)
    if (!used.has(code)) return code
  }
  return null
}

async function lockCompanyChartTx(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'brand_revenue_account:' + tenantId}::text))`
}

/** Every code the company's chart or its brands already hold. */
async function takenCodesTx(tx: Prisma.TransactionClient, tenantId: string): Promise<Set<string>> {
  const [accounts, brands] = await Promise.all([
    tx.account.findMany({ where: { tenantId }, select: { code: true } }),
    tx.concept.findMany({ where: { tenantId, revenueAccountCode: { not: null } }, select: { revenueAccountCode: true } }),
  ])
  return new Set([...accounts.map((a) => a.code), ...brands.map((b) => b.revenueAccountCode!)])
}

export interface BrandRevenueAccountResult {
  conceptId: string
  code: string | null
  /** A new chart account was created for the brand. */
  created: boolean
}

/**
 * Give one brand its sales account, inside `tx`. A brand that already has a
 * code is left as it is (its account is created only if its company's chart
 * lacks it). A legacy brand takes its fixed code; any other brand the first
 * free code in BRAND_SALES_RANGE. A brand with no company, or a company whose
 * range is full, keeps NULL (posts to 4090) — never an error, so a brand
 * create is never blocked by its account.
 */
export async function ensureBrandRevenueAccountTx(tx: Prisma.TransactionClient, conceptId: string): Promise<BrandRevenueAccountResult> {
  const head = await tx.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } })
  if (!head?.tenantId) return { conceptId, code: null, created: false }
  const tenantId = head.tenantId
  await lockCompanyChartTx(tx, tenantId)
  // Re-read under the lock: a parallel call may have assigned it.
  const c = await tx.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true, slug: true, name: true, revenueAccountCode: true } })
  if (!c || c.tenantId !== tenantId) return { conceptId, code: c?.revenueAccountCode ?? null, created: false }

  const code = c.revenueAccountCode ?? CONCEPT_REVENUE_CODE[c.slug] ?? firstFreeBrandCode(await takenCodesTx(tx, tenantId))
  if (!code) return { conceptId, code: null, created: false }
  let created = false
  const existing = await tx.account.findFirst({ where: { tenantId, code }, select: { id: true } })
  if (!existing) {
    await tx.account.create({
      data: {
        tenantId, code, name: brandSalesAccountName(c.name), type: 'revenue', isActive: true,
        description: `Sales of the brand ${c.name} (one sales account per brand)`,
      },
    })
    created = true
  }
  if (c.revenueAccountCode !== code) {
    await tx.concept.update({ where: { id: conceptId }, data: { revenueAccountCode: code } })
  }
  return { conceptId, code, created }
}

/** ensureBrandRevenueAccountTx in its own transaction (service client — the chart is written for the brand's company). */
export async function ensureBrandRevenueAccount(conceptId: string): Promise<BrandRevenueAccountResult> {
  return prisma.$transaction((tx) => ensureBrandRevenueAccountTx(tx, conceptId))
}

/**
 * Boot step: every live brand with a company and no sales account gets one.
 * Idempotent (a brand with a code is skipped), so it runs at every boot and
 * catches a brand created by any path. Returns what it assigned.
 */
export async function ensureBrandRevenueAccounts(): Promise<BrandRevenueAccountResult[]> {
  const brands = await prisma.concept.findMany({
    where: { revenueAccountCode: null, tenantId: { not: null }, deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  const out: BrandRevenueAccountResult[] = []
  for (const b of brands) out.push(await ensureBrandRevenueAccount(b.id))
  return out
}

/**
 * Company merge (tenants/routes.ts): a source brand's own account (4010–4089)
 * whose code the target's chart already uses — another brand's sales account,
 * or an account of the target's own — would otherwise be folded into that
 * account by the code-by-code ledger merge, mixing two brands' sales. Such an
 * account is renumbered to a code free in BOTH charts first (same account row,
 * so its lines and history stay on it), and the brand follows. Runs before the
 * account merge, in the merge's transaction. Returns the renumberings.
 */
export async function renumberClashingBrandAccountsTx(
  tx: Prisma.TransactionClient,
  src: string,
  dst: string,
): Promise<Array<{ conceptId: string; from: string; to: string }>> {
  await lockCompanyChartTx(tx, dst)
  const brands = await tx.concept.findMany({
    where: { tenantId: { in: [src, dst] }, revenueAccountCode: { not: null } },
    select: { id: true, tenantId: true, revenueAccountCode: true },
  })
  const srcBrands = brands.filter((b) => b.tenantId === src && isBrandAccountRangeCode(b.revenueAccountCode!))
  if (srcBrands.length === 0) return []
  const taken = new Set([...(await takenCodesTx(tx, src)), ...(await takenCodesTx(tx, dst))])
  const dstCodes = new Set((await tx.account.findMany({ where: { tenantId: dst }, select: { code: true } })).map((a) => a.code))
  for (const b of brands) if (b.tenantId === dst) dstCodes.add(b.revenueAccountCode!)
  const out: Array<{ conceptId: string; from: string; to: string }> = []
  const renumbered = new Set<string>()
  for (const b of srcBrands) {
    const from = b.revenueAccountCode!
    if (!dstCodes.has(from)) continue
    if (renumbered.has(from)) {
      // Two source brands on one code (only by hand): follow the first move.
      const moved = out.find((o) => o.from === from)!
      await tx.concept.update({ where: { id: b.id }, data: { revenueAccountCode: moved.to } })
      out.push({ conceptId: b.id, from, to: moved.to })
      continue
    }
    const to = firstFreeBrandCode(taken)
    if (!to) continue   // range full: left to the code-by-code merge (reported by the caller's counts)
    taken.add(to)
    renumbered.add(from)
    await tx.account.updateMany({ where: { tenantId: src, code: from }, data: { code: to } })
    await tx.concept.update({ where: { id: b.id }, data: { revenueAccountCode: to } })
    out.push({ conceptId: b.id, from, to })
  }
  return out
}

type SalesDb = Pick<typeof prisma, 'journalLine' | 'account'> | Prisma.TransactionClient

/**
 * Brand sales per brand over a window, read from the brands' sales accounts:
 * each brand's own account (revenueCodeForConcept) plus 4090 (Other /
 * Catering), where brands without an account — and every brand before it got
 * one (2026-10-17) — booked their sales. Net credit − debit per brand.
 *
 *   • a line on an account exactly one listed brand uses → that brand;
 *   • on an account several listed brands use (stackd / stax on 4002, or
 *     brands still on 4090) → the brand it is tagged with, else the first;
 *   • on 4090 when no listed brand uses it → the brand it is tagged with,
 *     else `otherCents` (catering, receivable invoices with no brand).
 *
 * Each line is counted once, so a shared account is never summed per brand.
 */
export async function brandSalesByAccount(
  db: SalesDb,
  tenantId: string,
  concepts: Array<{ id: string; slug: string; revenueAccountCode?: string | null }>,
  window: { from: Date; to: Date },
): Promise<{ byConcept: Map<string, number>; otherCents: number }> {
  const users = new Map<string, string[]>()
  for (const c of concepts) {
    const code = revenueCodeForConcept(c)
    users.set(code, [...(users.get(code) ?? []), c.id])
  }
  const codes = Array.from(new Set([...users.keys(), REVENUE_FALLBACK_CODE]))
  const accounts = await db.account.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true } })
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))
  const byConcept = new Map<string, number>(concepts.map((c) => [c.id, 0]))
  let otherCents = 0
  if (accounts.length === 0) return { byConcept, otherCents }
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'conceptId', 'type'],
    _sum: { amountCents: true },
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { tenantId, entryDate: { gte: window.from, lte: window.to } } },
  })
  for (const g of sums) {
    const code = codeOf.get(g.accountId)!
    const amt = sumCents(g._sum.amountCents)
    const signed = g.type === 'credit' ? amt : -amt
    const owners = users.get(code)
    let to: string | null
    if (owners && owners.length > 0) to = g.conceptId && owners.includes(g.conceptId) ? g.conceptId : owners[0]
    else to = g.conceptId && byConcept.has(g.conceptId) ? g.conceptId : null
    if (to) byConcept.set(to, (byConcept.get(to) ?? 0) + signed)
    else otherCents += signed
  }
  return { byConcept, otherCents }
}
