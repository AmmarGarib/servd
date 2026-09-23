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

import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { postJournalEntry } from '../accounting/journal.js'

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

export async function postAcquisition(assetId: string, postedBy?: string) {
  const a = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })
  if (!a.acquisitionCreditCode) throw new AppError('ASSET_FUNDING', 'Say how this asset was paid for', 422)
  const assetAccount = ASSET_CATEGORIES[a.category as AssetCategory]?.account
  if (!assetAccount) throw new AppError('ASSET_CATEGORY', `Unknown asset category ${a.category}`, 422)
  return postJournalEntry({
    tenantId: a.tenantId,
    sourceType: 'fixed_asset.acquire',
    sourceId: a.id,
    description: `Acquired ${a.name}`,
    entryDate: a.acquiredAt,
    postedBy: postedBy ?? 'system',
    reference: a.assetTag ?? undefined,
    lines: [
      { accountCode: assetAccount, type: 'debit', amountCents: a.costCents, conceptId: a.conceptId, memo: a.name },
      { accountCode: a.acquisitionCreditCode, type: 'credit', amountCents: a.costCents, memo: a.name },
    ],
  })
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
      results.push({ assetId: a.id, name: a.name, amountCents: a.depreciation.find((d) => d.period === period)!.amountCents, status: 'already' })
      continue
    }
    // Only months BEFORE this one count as already charged — a later month run
    // out of order must not eat into this month's share.
    const before = a.depreciation
      .filter((d) => periodIndex(d.period) < periodIndex(period))
      .reduce((s, d) => s + d.amountCents, 0)
    const amount = chargeFor(a, period, before)
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

  const accumulated = a.depreciation.reduce((s, d) => s + d.amountCents, 0)
  const bookValue = a.costCents - accumulated
  const gainLoss = opts.proceedsCents - bookValue // > 0 gain, < 0 loss

  const lines = [
    { accountCode: ACCUMULATED_DEPRECIATION, type: 'debit' as const, amountCents: accumulated, memo: a.name },
    { accountCode: BANK, type: 'debit' as const, amountCents: opts.proceedsCents, memo: 'Disposal proceeds' },
    { accountCode: assetAccount, type: 'credit' as const, amountCents: a.costCents, memo: a.name },
  ]
  // Gain is a credit to 8030, loss a debit — it is an expense-type account, so
  // a gain shows as a negative expense, which is how the P&L should read it.
  if (gainLoss > 0) lines.push({ accountCode: DISPOSAL_GAIN_LOSS, type: 'credit', amountCents: gainLoss, memo: 'Gain on disposal' } as never)
  if (gainLoss < 0) lines.push({ accountCode: DISPOSAL_GAIN_LOSS, type: 'debit', amountCents: -gainLoss, memo: 'Loss on disposal' } as never)

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
