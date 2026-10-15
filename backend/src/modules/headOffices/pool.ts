// Head office (D1) — the monthly cost pool a recharge run splits (spec §4.1,
// amendment A9).
//
//   pool(H, M) = Σ (debit − credit) of the head office's journal lines dated in
//                the PKT month M, on EXPENSE accounts of its chart that the
//                pool selects:
//                  • a numeric code inside one of `include` ranges, or a code in
//                    `includeCodes`;
//                  • and not in `excludeCodes`;
//                  • and NEVER the head office's recharge account
//                    (HeadOfficeBooks.rechargeAccountId — A9: whatever the
//                    codes say, the recovery account cannot feed itself).
//
// Lines of the recharge itself never count: an entry referenced 'ho.recharge…'
// (spec §4.1) or the 'ic.transfer:<id>' / 'ic.transfer.reversal:<id>' entries
// of the head office's own 'ho_recharge' transfers (the engine the owner chose,
// 2026-10-15). Those only touch the recharge account and the pair accounts
// anyway; the exclusion keeps a recharge account re-mapped later from pulling
// the old recoveries back in.
//
// Everything else posted in the head office's books counts: its payroll accrual
// (dated the month's last day), bills, manual journals, depreciation, and a
// paired adjustment that moves a cost in or out of the head office.
//
// Model API only (no raw SQL): journalLine.groupBy sums come back as numbers
// through lib/money.ts and are added with sumCents.

import type { Prisma, PrismaClient } from '@prisma/client'
import { NotFoundError } from '../../lib/errors.js'
import { sumCents } from '../../lib/money.js'
import { monthBounds } from '../intercompany/fleet.js'
import { parseCostPool, type CostPool } from './books.js'

export type Tx = Prisma.TransactionClient
export type Db = Tx | PrismaClient

/** The reference prefix of the spec's recharge entries (never counted). */
export const HO_RECHARGE_REF_PREFIX = 'ho.recharge'

export interface PoolBasisLine {
  accountId: string
  code: string
  name: string
  /** Debits − credits in the month (a credit-heavy account is negative). */
  netCents: number
}

export interface PoolResult {
  hoId: string
  period: string
  poolCents: number
  /** One row per pool account with any movement in the month, by code. */
  basis: PoolBasisLine[]
  /** The pool definition used (HeadOfficeBooks.costPool, parsed). */
  costPool: CostPool
  /** The recharge account always left out (A9), or null when none is mapped. */
  rechargeAccountId: string | null
}

/** Does an account code fall inside the pool definition (the recharge account is checked separately)? */
export function codeInPool(code: string, pool: CostPool): boolean {
  if (pool.excludeCodes.includes(code)) return false
  if (pool.includeCodes.includes(code)) return true
  if (!/^\d+$/.test(code)) return false
  const n = Number(code)
  return pool.include.some((r) => n >= r.from && n <= r.to)
}

/** The journal references of a head office's own recharge transfers (and their reversals). */
async function rechargeTransferRefs(db: Db, hoId: string): Promise<string[]> {
  const rows = await db.intercompanyTransfer.findMany({
    where: { source: 'ho_recharge', OR: [{ tenantId: hoId }, { counterpartyTenantId: hoId }] },
    select: { id: true },
  })
  return rows.flatMap((r) => [`ic.transfer:${r.id}`, `ic.transfer.reversal:${r.id}`])
}

/**
 * The head office's pool for a PKT month. 404 when the tenant has no
 * head-office books. Reads only the head office's own books.
 */
export async function computePool(db: Db, hoId: string, period: string): Promise<PoolResult> {
  const { from, to } = monthBounds(period)
  const books = await db.headOfficeBooks.findUnique({
    where: { tenantId: hoId },
    select: { costPool: true, rechargeAccountId: true },
  })
  if (!books) throw new NotFoundError('Head office books', hoId)
  const costPool = parseCostPool(books.costPool)

  const accounts = await db.account.findMany({
    where: { tenantId: hoId, type: 'expense' },
    select: { id: true, code: true, name: true },
  })
  const inPool = accounts.filter((a) => a.id !== books.rechargeAccountId && codeInPool(a.code, costPool))
  if (inPool.length === 0) return { hoId, period, poolCents: 0, basis: [], costPool, rechargeAccountId: books.rechargeAccountId }

  const excludedRefs = await rechargeTransferRefs(db, hoId)
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    where: {
      accountId: { in: inPool.map((a) => a.id) },
      journalEntry: {
        tenantId: hoId,
        entryDate: { gte: from, lte: to },
        NOT: [
          { reference: { startsWith: HO_RECHARGE_REF_PREFIX } },
          ...(excludedRefs.length > 0 ? [{ reference: { in: excludedRefs } }] : []),
        ],
      },
    },
    _sum: { amountCents: true },
  })
  const net = new Map<string, number>()
  for (const s of sums) {
    const v = sumCents(s._sum.amountCents)
    net.set(s.accountId, (net.get(s.accountId) ?? 0) + (s.type === 'debit' ? v : -v))
  }
  const basis: PoolBasisLine[] = inPool
    .filter((a) => net.has(a.id) && net.get(a.id) !== 0)
    .map((a) => ({ accountId: a.id, code: a.code, name: a.name, netCents: net.get(a.id)! }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const poolCents = basis.reduce((s, b) => s + b.netCents, 0)
  return { hoId, period, poolCents, basis, costPool, rechargeAccountId: books.rechargeAccountId }
}
