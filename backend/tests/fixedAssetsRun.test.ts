// Fixed assets v2 — the automatic depreciation run (engine part; w3-fa-api adds
// the worker cases).
//
//   - missing months are charged strictly in order, idempotently, on the
//     class's own accumulated account (1591…);
//   - a month whose end is closed posts into the open month with the note,
//     under the SAME reference, and postedPeriod records where it landed; a
//     re-sync keeps the live date (no reversal churn);
//   - a refused asset (deactivated account) raises depreciation_failed +
//     posting_failed, the others still charge, and the re-poster clears it;
//   - concurrent runs post once; an unfinished month is 422 MONTH_NOT_ENDED;
//   - two companies charge into their own ledgers;
//   - the legacy 1590 reclass runs once;
//   - the close check blocks and chargeForClose clears it.
import { describe, it, expect } from 'vitest'
import type { FixedAsset } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import {
  chargeThrough, chargeAssetThrough, postAcquisition, nextAssetTag, reclassLegacyAccumulated,
} from '../src/modules/fixedAssets/service.js'
import {
  currentPeriodPkt, addMonths, lastDayPkt, endOfMonthPkt, startOfMonthPkt, periodOfPkt,
} from '../src/modules/fixedAssets/schedule.js'
import { fixedAssetCloseChecks, chargeForClose } from '../src/modules/fixedAssets/closeCheck.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'

const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k) // m(-1) = the last completed month
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * 86_400_000 + 12 * 3_600_000) // the 15th, 12:00 PKT

interface Co { tenantId: string; conceptId: string; concept2: string; locationId: string }
let seq = 0
async function mkCo(slug: string): Promise<Co> {
  const s = `${slug}-${++seq}-${Date.now().toString(36)}`
  const tenantId = (await prisma.tenant.create({ data: { name: `FA ${s}`, slug: `fa-${s}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const conceptId = (await prisma.concept.create({ data: { name: `Brand ${s}`, slug: `fa-b-${s}`, type: 'restaurant', tenantId } })).id
  const concept2 = (await prisma.concept.create({ data: { name: `Brand2 ${s}`, slug: `fa-b2-${s}`, type: 'restaurant', tenantId } })).id
  const locationId = (await prisma.location.create({ data: { slug: `fa-l-${s}`, name: `Outlet ${s}`, tenantId } })).id
  return { tenantId, conceptId, concept2, locationId }
}

/** Fixture: an asset put on the register through postAcquisition (CapEx capitalisation arrives in W2). */
async function mkAsset(co: Co, o: { name: string; classKey?: string; costCents: number; inServiceAt: Date; life: number; salvageCents?: number }): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: o.name, category: o.classKey ?? 'kitchen_equipment', assetTag: await nextAssetTag(tx, co.tenantId),
        acquiredAt: o.inServiceAt, inServiceAt: o.inServiceAt, costCents: o.costCents, originalCostCents: o.costCents,
        salvageCents: o.salvageCents ?? 0, usefulLifeMonths: o.life, conceptId: co.conceptId, locationId: co.locationId,
        acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: o.costCents, inputTaxCents: 0, inputTaxCode: null, natural: o.inServiceAt })
    return asset
  })
}

async function balance(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code, tenantId }, journalEntry: { tenantId } }, select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}

async function trialBalance(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}

describe('chargeThrough — the one depreciation path', () => {
  it('charges the missing months in order, on the class account, idempotently', async () => {
    const co = await mkCo('order')
    const a = await mkAsset(co, { name: 'Combi oven', costCents: 120_000, inServiceAt: mid(m(-4)), life: 12 })

    const first = await chargeThrough(co.tenantId, m(-3), { postedBy: 'system' })
    expect(first.results[0]!.months.map((x) => x.period)).toEqual([m(-4), m(-3)])
    const second = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(second.results[0]!.months.map((x) => x.period)).toEqual([m(-2), m(-1)])
    expect(second.chargedCents).toBe(20_000)

    const rows = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: a.id }, orderBy: { period: 'asc' } })
    expect(rows.map((r) => [r.period, Number(r.amountCents), r.accumCode, r.conceptId, r.postedPeriod])).toEqual(
      [m(-4), m(-3), m(-2), m(-1)].map((p) => [p, 10_000, '1591', co.conceptId, null]),
    )
    const entry = await prisma.journalEntry.findFirst({
      where: { tenantId: co.tenantId, reference: `fixed_asset.depreciation:${a.id}:${m(-4)}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    expect(entry!.entryDate.toISOString()).toBe(lastDayPkt(m(-4)).toISOString())
    expect(entry!.lines.map((l) => [l.account.code, l.type, l.conceptId]).sort()).toEqual([['1591', 'credit', co.conceptId], ['6150', 'debit', co.conceptId]])
    expect(await balance(co.tenantId, '6150')).toBe(40_000)
    expect(await balance(co.tenantId, '1591')).toBe(-40_000)
    expect(await balance(co.tenantId, '1590')).toBe(0)

    const again = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(again.chargedCount).toBe(0)
    expect(again.results[0]!.status).toBe('already')
    const runs = await prisma.fixedAssetRun.findMany({ where: { tenantId: co.tenantId }, orderBy: { startedAt: 'asc' } })
    expect(runs.map((r) => [r.kind, r.throughPeriod, r.chargedCount, Number(r.chargedCents), r.failedCount, r.triggeredBy])).toEqual([
      ['depreciation', m(-3), 2, 20_000, 0, 'worker'],
      ['depreciation', m(-1), 2, 20_000, 0, 'worker'],
      ['depreciation', m(-1), 0, 0, 0, 'worker'],
    ])
    expect(runs.every((r) => r.finishedAt)).toBe(true)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a closed month posts into the open month with the note under the same reference; a re-sync keeps the live date', async () => {
    const co = await mkCo('late')
    const a = await mkAsset(co, { name: 'Walk-in chiller', costCents: 120_000, inServiceAt: mid(m(-3)), life: 12 })
    await prisma.periodLock.create({ data: { tenantId: co.tenantId, lockedThrough: endOfMonthPkt(m(-2)), lockedBy: 'test' } })

    const r = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(r.chargedCount).toBe(3)
    expect(r.lateCount).toBe(2)
    const rows = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: a.id }, orderBy: { period: 'asc' } })
    expect(rows.map((x) => [x.period, x.postedPeriod])).toEqual([[m(-3), cur], [m(-2), cur], [m(-1), null]])

    const late = await prisma.journalEntry.findMany({
      where: { tenantId: co.tenantId, reference: { startsWith: `fixed_asset.depreciation:${a.id}:${m(-3)}` } },
      include: { lines: true },
    })
    expect(late).toHaveLength(1)
    expect(late[0]!.reference).toBe(`fixed_asset.depreciation:${a.id}:${m(-3)}`)
    expect(periodOfPkt(late[0]!.entryDate)).toBe(cur)
    expect(late[0]!.description).toMatch(/posted late into the open month/)
    expect(late[0]!.lines.every((l) => /posted late/.test(l.memo ?? ''))).toBe(true)
    const onTime = await prisma.journalEntry.findFirst({ where: { tenantId: co.tenantId, reference: `fixed_asset.depreciation:${a.id}:${m(-1)}` } })
    expect(onTime!.entryDate.toISOString()).toBe(lastDayPkt(m(-1)).toISOString())

    // The register row goes missing (crash, hand fix): the re-sync finds the
    // live late entry, keeps its date and does not reverse + repost it.
    await prisma.fixedAssetDepreciation.delete({ where: { assetId_period: { assetId: a.id, period: m(-3) } } })
    const again = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(again.results[0]!.months.map((x) => [x.period, x.postedPeriod])).toEqual([[m(-3), cur]])
    const refs = await prisma.journalEntry.count({ where: { tenantId: co.tenantId, reference: { contains: `${a.id}:${m(-3)}` } } })
    expect(refs).toBe(1)
    expect(await balance(co.tenantId, '6150')).toBe(30_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a refused asset is flagged and the others still charge; the re-poster clears it', async () => {
    const co = await mkCo('fail')
    const laptop = await mkAsset(co, { name: 'Laptop', classKey: 'it_equipment', costCents: 36_000, inServiceAt: mid(m(-2)), life: 36 })
    const fryer = await mkAsset(co, { name: 'Fryer', costCents: 60_000, inServiceAt: mid(m(-2)), life: 60 })
    await prisma.account.updateMany({ where: { tenantId: co.tenantId, code: '1593' }, data: { isActive: false } })

    const r = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(r.failedCount).toBe(1)
    expect(r.results.find((x) => x.assetId === laptop.id)!.status).toBe('failed')
    expect(r.results.find((x) => x.assetId === fryer.id)!.months).toHaveLength(2)
    const flags = await prisma.exceptionFlag.findMany({ where: { tenantId: co.tenantId, entityId: laptop.id, status: 'open' } })
    expect(flags.map((f) => f.kind).sort()).toEqual(['depreciation_failed', 'posting_failed'])
    const pf = flags.find((f) => f.kind === 'posting_failed')!
    expect(pf.entityType).toBe('FixedAsset')
    expect(pf.metadata).toMatchObject({ sourceType: 'fixed_asset.depreciation', sourceId: laptop.id })
    const run = await prisma.fixedAssetRun.findUnique({ where: { id: r.runId } })
    expect(run!.failedCount).toBe(1)
    expect(run!.error).toMatch(/1593/)

    // A second run does not raise the flags twice.
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(await prisma.exceptionFlag.count({ where: { tenantId: co.tenantId, entityId: laptop.id, status: 'open' } })).toBe(2)

    await prisma.account.updateMany({ where: { tenantId: co.tenantId, code: '1593' }, data: { isActive: true } })
    const fixed = await chargeAssetThrough(laptop.id, cur, { entryDate: new Date('2020-01-01'), memoNote: 'ignored' })
    expect(fixed.results[0]!.months.map((x) => x.period)).toEqual([m(-2), m(-1)])
    expect(await prisma.exceptionFlag.count({ where: { tenantId: co.tenantId, entityId: laptop.id, status: 'open' } })).toBe(0)
    expect(await balance(co.tenantId, '1593')).toBe(-2_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('concurrent runs post each month once', async () => {
    const co = await mkCo('race')
    const a1 = await mkAsset(co, { name: 'Range', costCents: 90_000, inServiceAt: mid(m(-3)), life: 9 })
    const a2 = await mkAsset(co, { name: 'Hood', costCents: 45_000, inServiceAt: mid(m(-3)), life: 9 })
    const [r1, r2] = await Promise.all([
      chargeThrough(co.tenantId, m(-1), { postedBy: 'system' }),
      chargeThrough(co.tenantId, m(-1), { postedBy: 'system' }),
    ])
    expect(r1.chargedCount + r2.chargedCount).toBe(6)
    for (const a of [a1, a2]) {
      for (const p of [m(-3), m(-2), m(-1)]) {
        expect(await prisma.journalEntry.count({ where: { tenantId: co.tenantId, reference: { startsWith: `fixed_asset.depreciation:${a.id}:${p}` } } })).toBe(1)
      }
    }
    expect(await prisma.fixedAssetDepreciation.count({ where: { tenantId: co.tenantId } })).toBe(6)
    expect(await balance(co.tenantId, '6150')).toBe(45_000)
  })

  it('refuses a month that has not ended, and a bad period', async () => {
    const co = await mkCo('future')
    await expect(chargeThrough(co.tenantId, cur, { postedBy: 'system' })).rejects.toMatchObject({ code: 'MONTH_NOT_ENDED', statusCode: 422 })
    await expect(chargeThrough(co.tenantId, '2026-13', { postedBy: 'system' })).rejects.toMatchObject({ code: 'BAD_PERIOD', statusCode: 400 })
  })

  it('two companies charge into their own ledgers', async () => {
    const A = await mkCo('two-a')
    const B = await mkCo('two-b')
    const a = await mkAsset(A, { name: 'Oven A', costCents: 24_000, inServiceAt: mid(m(-2)), life: 24 })
    const b = await mkAsset(B, { name: 'Oven B', costCents: 48_000, inServiceAt: mid(m(-2)), life: 24 })
    await chargeThrough(A.tenantId, m(-1), { postedBy: 'system' })
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: b.id } })).toBe(0)
    expect(await balance(B.tenantId, '6150')).toBe(0)
    // Company A's run cannot charge B's asset even when named.
    const cross = await chargeThrough(A.tenantId, m(-1), { postedBy: 'system', assetIds: [b.id] })
    expect(cross.results).toHaveLength(0)

    await chargeThrough(B.tenantId, m(-1), { postedBy: 'system' })
    expect(await balance(A.tenantId, '6150')).toBe(2_000)
    expect(await balance(B.tenantId, '6150')).toBe(4_000)
    const bEntries = await prisma.journalEntry.findMany({ where: { reference: { startsWith: `fixed_asset.depreciation:${b.id}` } }, select: { tenantId: true } })
    expect(bEntries.every((e) => e.tenantId === B.tenantId)).toBe(true)
    expect(await prisma.fixedAssetDepreciation.count({ where: { assetId: a.id, tenantId: A.tenantId } })).toBe(2)
    expect(await trialBalance(A.tenantId)).toBe(0)
    expect(await trialBalance(B.tenantId)).toBe(0)
  })

  it('moves legacy 1590 accumulated to the class account once', async () => {
    const co = await mkCo('legacy')
    const a = await mkAsset(co, { name: 'Old fryer', costCents: 60_000, inServiceAt: mid(m(-5)), life: 6 })
    // Charges the pre-v2 engine made: Cr 1590, no brand on the credit.
    for (const p of [m(-5), m(-4)]) {
      await prisma.fixedAssetDepreciation.create({ data: { tenantId: co.tenantId, assetId: a.id, period: p, amountCents: 10_000 } })
      await postJournalEntry({
        tenantId: co.tenantId, sourceType: 'fixed_asset.depreciation', sourceId: `${a.id}:${p}`, description: `Depreciation ${p}`,
        entryDate: lastDayPkt(p), lines: [
          { accountCode: '6150', type: 'debit', amountCents: 10_000, conceptId: co.conceptId },
          { accountCode: '1590', type: 'credit', amountCents: 10_000 },
        ],
      })
    }
    expect(await balance(co.tenantId, '1590')).toBe(-20_000)

    expect(await reclassLegacyAccumulated(co.tenantId)).toEqual({ posted: true, cents: 20_000 })
    expect(await balance(co.tenantId, '1590')).toBe(0)
    expect(await balance(co.tenantId, '1591')).toBe(-20_000)
    expect((await prisma.fixedAssetDepreciation.findMany({ where: { assetId: a.id } })).every((r) => r.accumCode === '1591')).toBe(true)
    expect(await reclassLegacyAccumulated(co.tenantId)).toEqual({ posted: false, cents: 0 })
    expect(await prisma.journalEntry.count({ where: { tenantId: co.tenantId, reference: { startsWith: 'fixed_asset.acc_dep_reclass:' } } })).toBe(1)

    // The run carries on from there on 1591: cost − salvage exactly.
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(await balance(co.tenantId, '1591')).toBe(-50_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })
})

describe('the period-close check', () => {
  it('blocks while a covered month is uncharged; chargeForClose clears it; pending capitalisations warn', async () => {
    const co = await mkCo('close')
    await mkAsset(co, { name: 'Dishwasher', costCents: 30_000, inServiceAt: mid(m(-3)), life: 6 })
    const dep = fixedAssetCloseChecks.find((c) => c.key === 'depreciation')!
    const cap = fixedAssetCloseChecks.find((c) => c.key === 'capitalisation_pending')!
    expect(dep).toMatchObject({ severity: 'block', overridable: true })
    const ctx = (newLock: Date): CloseCheckContext => ({ db: prisma, tenantId: co.tenantId, prevLock: null, newLock, months: [], isYearEnd: false })

    const two = await dep.run(ctx(endOfMonthPkt(m(-2))))
    expect(two).toMatchObject({ key: 'depreciation', severity: 'block', count: 1, cents: 10_000, months: [m(-3), m(-2)], overridable: true })
    expect(two!.fix).toMatchObject({ method: 'POST', path: '/accounting/fixed-assets/depreciate' })
    expect(two!.link).toBe('/accounting/fixed-assets?uncharged=1')
    const three = await dep.run(ctx(endOfMonthPkt(m(-1))))
    expect(three!.months).toEqual([m(-3), m(-2), m(-1)])

    await chargeForClose(co.tenantId, endOfMonthPkt(m(-2)), 'system')
    expect(await dep.run(ctx(endOfMonthPkt(m(-2))))).toBeNull()
    expect((await dep.run(ctx(endOfMonthPkt(m(-1)))))!.months).toEqual([m(-1)])
    await chargeForClose(co.tenantId, endOfMonthPkt(m(-1)), 'system')
    expect(await dep.run(ctx(endOfMonthPkt(m(-1))))).toBeNull()

    expect(await cap.run(ctx(endOfMonthPkt(m(-1))))).toBeNull()
    await prisma.fixedAssetEvent.create({
      data: {
        tenantId: co.tenantId, capexLineId: 'line-not-real', kind: 'capitalise', status: 'pending', effectiveDate: mid(m(-2)),
        payload: { classKey: 'kitchen_equipment' }, amountCents: 55_000, reason: 'Delivered and installed', requestedById: 'u',
      },
    })
    expect(await cap.run(ctx(endOfMonthPkt(m(-1))))).toMatchObject({ key: 'capitalisation_pending', severity: 'warn', count: 1, cents: 55_000 })
    expect(await cap.run(ctx(endOfMonthPkt(m(-3))))).toBeNull()
  })
})
