// Fixed assets — base layer.
//
// A register of what the business owns (ovens, fit-out, vehicles), with
// straight-line depreciation charged monthly to the ledger. Before this, the
// fixed-asset accounts sat at zero: no asset base on the balance sheet, no
// depreciation in the P&L, and equipment lived only as project spend in CapEx.
//
// Ledger postings, all idempotent on (sourceType, sourceId):
//   acquire   Dr 15x0 asset      / Cr chosen account (bank, cash or payable)
//   depreciate Dr 6150 expense   / Cr 1590 accumulated depreciation
//   dispose   Dr 1590 accumulated + Dr 1020 proceeds / Cr 15x0 cost,
//             difference to 8030 gain/loss on disposal
//
// Depreciation is one entry per asset per month (sourceId `${assetId}:${period}`)
// so re-running a month, or adding an asset after the month was run, can
// never double-charge or skip.

import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { postJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { toCents } from '../../lib/money.js'

export const ASSET_CATEGORIES = {
  kitchen_equipment:  { label: 'Kitchen equipment',      account: '1510' },
  furniture_fixtures: { label: 'Furniture & fixtures',   account: '1520' },
  it_equipment:       { label: 'IT equipment',           account: '1530' },
  vehicles:           { label: 'Vehicles',               account: '1540' },
  leasehold:          { label: 'Leasehold improvements', account: '1550' },
} as const
export type AssetCategory = keyof typeof ASSET_CATEGORIES

/**
 * How an asset was paid for — the credit side of the acquisition entry. Every
 * asset is put on the books one way or another: an asset that depreciates in
 * the ledger without ever having been capitalised would leave 1590 crediting
 * against nothing. Equipment the business already owned before servd goes in
 * as owner's capital.
 */
export const FUNDING = {
  bank:     { label: 'Paid from bank',                 account: '1020' },
  cash:     { label: 'Paid in cash',                   account: '1010' },
  payable:  { label: 'On credit from the supplier',    account: '2010' },
  existing: { label: 'Already owned (opening balance)', account: '3010' },
  // Capex (owner decision 24): instalments were booked as advances to the
  // supplier (Dr 1340 / Cr bank) as they were paid; on delivery the asset is
  // capitalised against those advances. Only through capitaliseCapexLine —
  // the register's own form never offers it.
  advance:  { label: 'Paid as supplier advances (capex)', account: '1340' },
} as const
export type Funding = keyof typeof FUNDING

const DEPRECIATION_EXPENSE = '6150'
const ACCUMULATED_DEPRECIATION = '1590'
const DISPOSAL_GAIN_LOSS = '8030'
const BANK = '1020'

export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function periodIndex(period: string): number {
  const [y, m] = period.split('-').map(Number)
  return y! * 12 + (m! - 1)
}

function lastDayOf(period: string): Date {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y!, m!, 0, 12))
}

/**
 * The charge for one asset in one month, given what has already been charged.
 *
 * Straight line over usefulLifeMonths, starting the month of acquisition.
 * Integer cents: the monthly amount is floored and the remainder lands in the
 * final month, so the lifetime total is exactly cost − salvage, never a cent
 * over or under. Nothing is charged before the start month, after disposal,
 * or once the asset is fully depreciated.
 */
export function chargeFor(
  asset: { acquiredAt: Date; costCents: number; salvageCents: number; usefulLifeMonths: number; disposedAt: Date | null },
  period: string,
  alreadyChargedCents: number,
): number {
  const depreciable = Math.max(0, asset.costCents - asset.salvageCents)
  const remaining = depreciable - alreadyChargedCents
  if (remaining <= 0 || asset.usefulLifeMonths <= 0) return 0

  const start = periodIndex(periodOf(asset.acquiredAt))
  const p = periodIndex(period)
  if (p < start) return 0
  if (asset.disposedAt && p > periodIndex(periodOf(asset.disposedAt))) return 0

  const monthNo = p - start + 1 // 1-based
  if (monthNo > asset.usefulLifeMonths) return 0
  if (monthNo === asset.usefulLifeMonths) return remaining // last month takes the remainder
  return Math.min(remaining, Math.floor(depreciable / asset.usefulLifeMonths))
}

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Capitalise an asset: Dr its 15x0 account / Cr how it was paid for. `credits`
 * splits the credit side (a capex line paid partly in advances, the rest owed
 * to the supplier); it must add up to the cost. Default: one credit to the
 * asset's funding account.
 */
export async function postAcquisition(
  assetId: string,
  postedBy?: string,
  opts: { tx?: Tx; credits?: Array<{ accountCode: string; amountCents: number; memo?: string }>; description?: string } = {},
) {
  const db = (opts.tx ?? prisma) as typeof prisma
  const a = await db.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })
  if (!a.acquisitionCreditCode) throw new AppError('ASSET_FUNDING', 'Say how this asset was paid for', 422)
  const assetAccount = ASSET_CATEGORIES[a.category as AssetCategory]?.account
  if (!assetAccount) throw new AppError('ASSET_CATEGORY', `Unknown asset category ${a.category}`, 422)
  const cost = toCents(a.costCents)
  const credits = opts.credits ?? [{ accountCode: a.acquisitionCreditCode, amountCents: cost }]
  if (credits.reduce((t, c) => t + c.amountCents, 0) !== cost) {
    throw new AppError('ASSET_FUNDING_SPLIT', 'How the asset was paid for must add up to its cost', 422)
  }
  return postJournalEntry({
    tenantId: a.tenantId,
    sourceType: 'fixed_asset.acquire',
    sourceId: a.id,
    description: opts.description ?? `Acquired ${a.name}`,
    entryDate: a.acquiredAt,
    postedBy: postedBy ?? 'system',
    reference: a.assetTag ?? undefined,
    lines: [
      { accountCode: assetAccount, type: 'debit', amountCents: cost, conceptId: a.conceptId, memo: a.name },
      ...credits.map((c) => ({ accountCode: c.accountCode, type: 'credit' as const, amountCents: c.amountCents, memo: c.memo ?? a.name })),
    ],
  }, { tx: opts.tx })
}

/**
 * Charge depreciation for `period` on every active asset of one company.
 * Safe to run any number of times: each asset-month is recorded once in
 * fixed_asset_depreciation and posted once to the ledger.
 */
export async function runDepreciation(tenantId: string, period: string, postedBy?: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new AppError('BAD_PERIOD', 'Period must be YYYY-MM', 400)
  if (periodIndex(period) > periodIndex(periodOf(new Date()))) {
    throw new AppError('FUTURE_PERIOD', 'Depreciation cannot be charged for a month that has not started', 400)
  }

  // Disposed assets are skipped outright. Their accumulated depreciation was
  // cleared out of 1590 at disposal; charging them again afterwards would put
  // it back with no asset left to set it against. Charge the final month
  // BEFORE disposing.
  const assets = await prisma.fixedAsset.findMany({
    where: { tenantId, status: 'active' },
    include: { depreciation: { select: { period: true, amountCents: true } } },
  })

  const results: Array<{ assetId: string; name: string; amountCents: number; status: 'charged' | 'already' | 'none' }> = []
  for (const a of assets) {
    if (a.depreciation.some((d) => d.period === period)) {
      results.push({ assetId: a.id, name: a.name, amountCents: toCents(a.depreciation.find((d) => d.period === period)!.amountCents), status: 'already' })
      continue
    }
    // Only months BEFORE this one count as already charged — a later month run
    // out of order must not eat into this month's share.
    const before = a.depreciation
      .filter((d) => periodIndex(d.period) < periodIndex(period))
      .reduce((s, d) => s + toCents(d.amountCents), 0)
    const amount = chargeFor({ ...a, costCents: toCents(a.costCents), salvageCents: toCents(a.salvageCents) }, period, before)
    if (amount <= 0) { results.push({ assetId: a.id, name: a.name, amountCents: 0, status: 'none' }); continue }

    await prisma.$transaction(async (tx) => {
      await tx.fixedAssetDepreciation.create({ data: { tenantId, assetId: a.id, period, amountCents: amount } })
      await postJournalEntry({
        tenantId,
        sourceType: 'fixed_asset.depreciation',
        sourceId: `${a.id}:${period}`,
        description: `Depreciation ${period} — ${a.name}`,
        entryDate: lastDayOf(period),
        postedBy: postedBy ?? 'system',
        lines: [
          { accountCode: DEPRECIATION_EXPENSE, type: 'debit', amountCents: amount, conceptId: a.conceptId, memo: a.name },
          { accountCode: ACCUMULATED_DEPRECIATION, type: 'credit', amountCents: amount, memo: a.name },
        ],
      }, { tx: tx as never })
    })
    results.push({ assetId: a.id, name: a.name, amountCents: amount, status: 'charged' })
  }
  return {
    period,
    chargedCents: results.filter((r) => r.status === 'charged').reduce((s, r) => s + r.amountCents, 0),
    results,
  }
}

export async function disposeAsset(
  assetId: string,
  opts: { disposedAt: Date; proceedsCents: number; postedBy?: string },
) {
  const a = await prisma.fixedAsset.findUniqueOrThrow({
    where: { id: assetId },
    include: { depreciation: { select: { amountCents: true } } },
  })
  if (a.status === 'disposed') throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409)
  const assetAccount = ASSET_CATEGORIES[a.category as AssetCategory]?.account
  if (!assetAccount) throw new AppError('ASSET_CATEGORY', `Unknown asset category ${a.category}`, 422)

  const cost = toCents(a.costCents)
  const accumulated = a.depreciation.reduce((s, d) => s + toCents(d.amountCents), 0)
  const bookValue = cost - accumulated
  const gainLoss = opts.proceedsCents - bookValue // > 0 gain, < 0 loss

  const lines: JournalLineInput[] = [
    { accountCode: ACCUMULATED_DEPRECIATION, type: 'debit', amountCents: accumulated, memo: a.name },
    { accountCode: BANK, type: 'debit', amountCents: opts.proceedsCents, memo: 'Disposal proceeds' },
    { accountCode: assetAccount, type: 'credit', amountCents: cost, memo: a.name },
  ]
  // Gain is a credit to 8030, loss a debit — it is an expense-type account, so
  // a gain shows as a negative expense, which is how the P&L should read it.
  if (gainLoss > 0) lines.push({ accountCode: DISPOSAL_GAIN_LOSS, type: 'credit', amountCents: gainLoss, memo: 'Gain on disposal' })
  if (gainLoss < 0) lines.push({ accountCode: DISPOSAL_GAIN_LOSS, type: 'debit', amountCents: -gainLoss, memo: 'Loss on disposal' })

  await prisma.$transaction(async (tx) => {
    // Claim the disposal before posting so two clicks cannot post twice.
    const claimed = await tx.fixedAsset.updateMany({
      where: { id: a.id, status: 'active' },
      data: { status: 'disposed', disposedAt: opts.disposedAt, disposalProceedsCents: opts.proceedsCents },
    })
    if (claimed.count === 0) throw new AppError('ALREADY_DISPOSED', 'This asset has already been disposed of', 409)
    {
      await postJournalEntry({
        tenantId: a.tenantId,
        sourceType: 'fixed_asset.dispose',
        sourceId: a.id,
        description: `Disposed ${a.name}`,
        entryDate: opts.disposedAt,
        postedBy: opts.postedBy ?? 'system',
        lines,
      }, { tx: tx as never })
    }
  })
  return { bookValueCents: bookValue, proceedsCents: opts.proceedsCents, gainLossCents: gainLoss }
}
