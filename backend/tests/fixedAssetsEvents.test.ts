// Fixed assets v2 — events (every kind but capitalise, which arrives with CapEx
// in W2). Owner: disposals, scraps and write-downs — finance requests, the CEO
// approves; the F&B manager only counts.
//
//   - a finance request waits for the CEO; the CEO's own request applies at once;
//   - disposal proceeds to a named bank / cash, BANK_ACCOUNT_REQUIRED, gain or
//     loss to 8030; a backdated disposal reverses the later charges;
//   - pool write-off FIFO across two layers, units re-checked when applied;
//   - impairment to 6155; change of estimate; brand transfer (zero net, later
//     depreciation on the new brand); pool unit transfer with carried
//     accumulated; void; undispose; count (no money);
//   - a legacy row's disposal debits 1590;
//   - the trial balance is zero per company after each case.
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { FixedAsset, FixedAssetPool } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { ensureAssetClasses } from '../src/modules/fixedAssets/classes.js'
import { chargeThrough, postAcquisition, nextAssetTag, loadAssetState } from '../src/modules/fixedAssets/service.js'
import { createRequest, applyEvent, rejectEvent, cancelEvent, needsApproval } from '../src/modules/fixedAssets/events.js'
import { findOrCreatePool } from '../src/modules/fixedAssets/pools.js'
import {
  currentPeriodPkt, addMonths, lastDayPkt, startOfMonthPkt, forecast,
} from '../src/modules/fixedAssets/schedule.js'

const cur = currentPeriodPkt()
const m = (k: number) => addMonths(cur, k)
const mid = (p: string) => new Date(startOfMonthPkt(p).getTime() + 14 * 86_400_000 + 12 * 3_600_000)

interface Who { id: string; role: string }
interface Co { tenantId: string; conceptId: string; concept2: string; locationId: string; location2: string; ceo: Who; fin: Who; fnb: Who }

let seq = 0
async function mkUser(tenantId: string, role: 'admin' | 'finance' | 'fnb_manager', s: string): Promise<Who> {
  const u = await prisma.user.create({ data: { name: `${role} ${s}`, email: `${role}.${s}@fa.test`, password: 'x', role, tenantId } })
  return { id: u.id, role }
}
async function mkCo(slug: string): Promise<Co> {
  const s = `${slug}-${++seq}-${Date.now().toString(36)}`
  const tenantId = (await prisma.tenant.create({ data: { name: `FA ${s}`, slug: `fa-${s}` } })).id
  await ensureChartOfAccounts(tenantId)
  await ensureAssetClasses(tenantId)
  const conceptId = (await prisma.concept.create({ data: { name: `Brand ${s}`, slug: `fa-b-${s}`, type: 'restaurant', tenantId } })).id
  const concept2 = (await prisma.concept.create({ data: { name: `Brand2 ${s}`, slug: `fa-b2-${s}`, type: 'restaurant', tenantId } })).id
  const locationId = (await prisma.location.create({ data: { slug: `fa-l-${s}`, name: `Outlet ${s}`, tenantId } })).id
  const location2 = (await prisma.location.create({ data: { slug: `fa-l2-${s}`, name: `Outlet2 ${s}`, tenantId } })).id
  return {
    tenantId, conceptId, concept2, locationId, location2,
    ceo: await mkUser(tenantId, 'admin', s), fin: await mkUser(tenantId, 'finance', s), fnb: await mkUser(tenantId, 'fnb_manager', s),
  }
}

async function mkAsset(co: Co, o: { name: string; classKey?: string; costCents: number; inServiceAt: Date; life: number }): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: o.name, category: o.classKey ?? 'kitchen_equipment', assetTag: await nextAssetTag(tx, co.tenantId),
        acquiredAt: o.inServiceAt, inServiceAt: o.inServiceAt, costCents: o.costCents, originalCostCents: o.costCents,
        usefulLifeMonths: o.life, conceptId: co.conceptId, locationId: co.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, asset, { advancedCents: 0, owedCents: o.costCents, inputTaxCents: 0, inputTaxCode: null, natural: o.inServiceAt })
    return asset
  })
}

async function mkPool(co: Co, typeKey = 'plates'): Promise<FixedAssetPool> {
  return prisma.$transaction((tx) => findOrCreatePool(tx, { tenantId: co.tenantId, locationId: co.locationId, conceptId: co.conceptId, classKey: 'smallwares', typeKey }))
}

async function mkLayer(co: Co, pool: FixedAssetPool, o: { units: number; costCents: number; inServiceAt: Date }): Promise<FixedAsset> {
  return prisma.$transaction(async (tx) => {
    const layer = await tx.fixedAsset.create({
      data: {
        tenantId: co.tenantId, name: 'Dinner plates', category: 'smallwares', kind: 'pool_layer', poolId: pool.id,
        quantity: o.units, originalQuantity: o.units, assetTag: await nextAssetTag(tx, co.tenantId),
        acquiredAt: o.inServiceAt, inServiceAt: o.inServiceAt, costCents: o.costCents, originalCostCents: o.costCents,
        usefulLifeMonths: 24, conceptId: pool.conceptId, locationId: pool.locationId, acquisitionCreditCode: '2012',
      },
    })
    await postAcquisition(tx, layer, { advancedCents: 0, owedCents: o.costCents, inputTaxCents: 0, inputTaxCode: null, natural: o.inServiceAt })
    return layer
  })
}

async function balance(tenantId: string, code: string, conceptId?: string | null): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code, tenantId }, journalEntry: { tenantId }, ...(conceptId !== undefined ? { conceptId } : {}) },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
async function trialBalance(tenantId: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
const entries = (tenantId: string) => prisma.journalEntry.count({ where: { tenantId } })

afterEach(() => { vi.useRealTimers() })

describe('who raises and who approves', () => {
  it('approval kinds wait for the CEO; transfers and counts apply at once', () => {
    expect(['capitalise', 'disposal', 'pool_write_off', 'impairment', 'change_estimate', 'void', 'undispose'].every(needsApproval)).toBe(true)
    expect(['transfer', 'pool_transfer', 'count'].some(needsApproval)).toBe(false)
  })

  it('a finance request waits for the CEO; the CEO\'s own request applies at once', async () => {
    const co = await mkCo('approve')
    const oven = await mkAsset(co, { name: 'Oven', costCents: 120_000, inServiceAt: mid(m(-6)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })

    const req = await createRequest({
      kind: 'disposal', assetId: oven.id, tenantId: co.tenantId, reason: 'Sold to a second-hand dealer',
      payload: { kind: 'sale', proceedsCents: 70_000 },
    }, co.fin)
    expect(req.applied).toBe(false)
    expect(req.event.status).toBe('pending')
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: oven.id } })).status).toBe('active')

    await expect(applyEvent(req.event.id, co.fin.id)).rejects.toMatchObject({ code: 'APPROVER_ONLY', statusCode: 403 })
    const done = await applyEvent(req.event.id, co.ceo.id)
    expect(done).toMatchObject({ status: 'posted', decidedById: co.ceo.id })
    expect(Number(done.amountCents)).toBe(70_000)
    expect(Number(done.costOutCents)).toBe(120_000)
    expect(Number(done.accumOutCents)).toBe(60_000)
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: oven.id } })).status).toBe('disposed')
    expect(await balance(co.tenantId, '1510')).toBe(0)
    expect(await balance(co.tenantId, '1591')).toBe(0)
    expect(await balance(co.tenantId, '1020')).toBe(70_000)
    expect(await balance(co.tenantId, '8030')).toBe(-10_000) // gain: proceeds 70,000 − NBV 60,000
    await expect(applyEvent(req.event.id, co.ceo.id)).rejects.toMatchObject({ code: 'NOT_PENDING', statusCode: 409 })

    const mixer = await mkAsset(co, { name: 'Mixer', costCents: 30_000, inServiceAt: mid(m(-1)), life: 6 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    const own = await createRequest({ kind: 'disposal', assetId: mixer.id, reason: 'Motor burnt out, scrapped', payload: { kind: 'scrap' } }, co.ceo)
    expect(own.applied).toBe(true)
    expect(own.event.status).toBe('posted')
    expect(await balance(co.tenantId, '8030')).toBe(-10_000 + 25_000) // scrap: loss of NBV 25,000

    // One pending request of a kind per asset; reject and cancel.
    const grill = await mkAsset(co, { name: 'Grill', costCents: 60_000, inServiceAt: mid(m(-1)), life: 6 })
    const p1 = await createRequest({ kind: 'impairment', assetId: grill.id, reason: 'Cracked plate, reduced value', payload: { amountCents: 5_000 } }, co.fin)
    await expect(createRequest({ kind: 'impairment', assetId: grill.id, reason: 'Cracked plate, reduced value', payload: { amountCents: 5_000 } }, co.fin))
      .rejects.toMatchObject({ code: 'REQUEST_PENDING', statusCode: 409 })
    await expect(rejectEvent(p1.event.id, co.fin.id, 'no')).rejects.toMatchObject({ statusCode: 403 })
    expect((await rejectEvent(p1.event.id, co.ceo.id, 'Get a valuation first')).status).toBe('rejected')
    const p2 = await createRequest({ kind: 'impairment', assetId: grill.id, reason: 'Cracked plate, reduced value', payload: { amountCents: 5_000 } }, co.fin)
    expect((await cancelEvent(p2.event.id, co.fin.id)).status).toBe('cancelled')
    await expect(cancelEvent(p2.event.id, co.fin.id)).rejects.toMatchObject({ code: 'NOT_PENDING' })

    // Another company never reaches this company's asset.
    const other = await mkCo('approve-b')
    await expect(createRequest({ kind: 'disposal', assetId: grill.id, tenantId: other.tenantId, reason: 'Not my asset at all', payload: { kind: 'scrap' } }, other.fin))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('the F&B manager may only count — a count posts nothing', async () => {
    const co = await mkCo('fnb')
    const pool = await mkPool(co)
    await mkLayer(co, pool, { units: 20, costCents: 24_000, inServiceAt: mid(m(-2)) })
    const asset = await mkAsset(co, { name: 'Blender', costCents: 12_000, inServiceAt: mid(m(-2)), life: 12 })
    await expect(createRequest({ kind: 'disposal', assetId: asset.id, reason: 'Broken beyond repair', payload: { kind: 'scrap' } }, co.fnb))
      .rejects.toMatchObject({ code: 'FA_WRITE_FORBIDDEN', statusCode: 403 })
    await expect(createRequest({ kind: 'pool_write_off', poolId: pool.id, reason: 'Broken in service', payload: { units: 2 } }, co.fnb))
      .rejects.toMatchObject({ statusCode: 403 })

    const before = await entries(co.tenantId)
    const count = await createRequest({ kind: 'count', poolId: pool.id, reason: '', payload: { countedUnits: 17, note: 'Month-end count' } }, co.fnb)
    expect(count.applied).toBe(true)
    expect(count.event.status).toBe('posted')
    expect(count.event.payload).toMatchObject({ countedUnits: 17, onHandUnits: 20, shortfallUnits: 3 })
    expect(count.event.journalEntryId).toBeNull()
    expect(await entries(co.tenantId)).toBe(before)
  })
})

describe('disposals', () => {
  it('proceeds to a named bank or cash; BANK_ACCOUNT_REQUIRED; a loss to 8030', async () => {
    const co = await mkCo('proceeds')
    await prisma.account.create({ data: { tenantId: co.tenantId, code: '1021', name: 'Bank — MCB', type: 'asset', isActive: true } })
    await prisma.bankAccount.create({ data: { tenantId: co.tenantId, name: 'HBL Ops', accountCode: '1020' } })
    const mcb = await prisma.bankAccount.create({ data: { tenantId: co.tenantId, name: 'MCB Ops', accountCode: '1021' } })
    const d = await mkAsset(co, { name: 'Chiller', costCents: 60_000, inServiceAt: mid(m(-3)), life: 6 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })

    await expect(createRequest({ kind: 'disposal', assetId: d.id, reason: 'Sold, replaced by a bigger one', payload: { kind: 'sale', proceedsCents: 20_000 } }, co.fin))
      .rejects.toMatchObject({ code: 'BANK_ACCOUNT_REQUIRED', statusCode: 422 })
    await expect(createRequest({ kind: 'disposal', assetId: d.id, reason: 'Stolen from the back yard', payload: { kind: 'stolen', proceedsCents: 1 } }, co.fin))
      .rejects.toMatchObject({ code: 'PROCEEDS_NOT_ALLOWED' })
    const req = await createRequest({
      kind: 'disposal', assetId: d.id, reason: 'Sold, replaced by a bigger one',
      payload: { kind: 'sale', proceedsCents: 20_000, method: 'bank', bankAccountId: mcb.id },
    }, co.fin)
    await applyEvent(req.event.id, co.ceo.id)
    expect(await balance(co.tenantId, '1021')).toBe(20_000)
    expect(await balance(co.tenantId, '8030')).toBe(10_000) // NBV 30,000 − proceeds 20,000

    const e = await mkAsset(co, { name: 'Kettle', classKey: 'office_equipment', costCents: 6_000, inServiceAt: mid(m(-1)), life: 6 })
    await createRequest({ kind: 'disposal', assetId: e.id, reason: 'Sold to staff for cash', payload: { kind: 'sale', proceedsCents: 5_000, method: 'cash' } }, co.ceo)
    expect(await balance(co.tenantId, '1010')).toBe(5_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a backdated disposal reverses the later charges; future or pre-service dates are refused', async () => {
    const co = await mkCo('backdate')
    const f = await mkAsset(co, { name: 'Salamander', costCents: 120_000, inServiceAt: mid(m(-6)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(await balance(co.tenantId, '6150')).toBe(60_000)

    const tomorrow = new Date(Date.now() + 86_400_000)
    await expect(createRequest({ kind: 'disposal', assetId: f.id, effectiveDate: tomorrow, reason: 'Will be scrapped tomorrow', payload: { kind: 'scrap' } }, co.ceo))
      .rejects.toMatchObject({ code: 'DISPOSAL_DATE', statusCode: 422 })
    await expect(createRequest({ kind: 'disposal', assetId: f.id, effectiveDate: mid(m(-7)), reason: 'Before it was bought?!', payload: { kind: 'scrap' } }, co.ceo))
      .rejects.toMatchObject({ code: 'DISPOSAL_DATE' })

    const r = await createRequest({ kind: 'disposal', assetId: f.id, effectiveDate: mid(m(-3)), reason: 'Found broken at the stock take', payload: { kind: 'scrap' } }, co.ceo)
    expect(Number(r.event.accumOutCents)).toBe(30_000)
    const rows = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: f.id }, orderBy: { period: 'asc' } })
    expect(rows.map((x) => [x.period, x.reversedAt !== null])).toEqual([
      [m(-6), false], [m(-5), false], [m(-4), false], [m(-3), true], [m(-2), true], [m(-1), true],
    ])
    for (const p of [m(-3), m(-2), m(-1)]) {
      expect(await prisma.journalEntry.count({ where: { tenantId: co.tenantId, reference: `fixed_asset.depreciation.reversal:${f.id}:${p}` } })).toBe(1)
    }
    expect(await balance(co.tenantId, '6150')).toBe(30_000)
    expect(await balance(co.tenantId, '1591')).toBe(0)
    expect(await balance(co.tenantId, '1510')).toBe(0)
    expect(await balance(co.tenantId, '8030')).toBe(90_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a legacy row\'s disposal debits 1590, a v2 row 1591', async () => {
    const co = await mkCo('legacy')
    const a = await mkAsset(co, { name: 'Old range', costCents: 60_000, inServiceAt: mid(m(-3)), life: 6 })
    for (const p of [m(-3), m(-2)]) {
      await prisma.fixedAssetDepreciation.create({ data: { tenantId: co.tenantId, assetId: a.id, period: p, amountCents: 10_000 } })
      await postJournalEntry({
        tenantId: co.tenantId, sourceType: 'fixed_asset.depreciation', sourceId: `${a.id}:${p}`, description: `Depreciation ${p}`,
        entryDate: lastDayPkt(p), lines: [
          { accountCode: '6150', type: 'debit', amountCents: 10_000, conceptId: co.conceptId },
          { accountCode: '1590', type: 'credit', amountCents: 10_000 },
        ],
      })
    }
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(await balance(co.tenantId, '1591')).toBe(-10_000)
    const r = await createRequest({ kind: 'disposal', assetId: a.id, reason: 'Replaced by the new range', payload: { kind: 'scrap' } }, co.ceo)
    expect(Number(r.event.accumOutCents)).toBe(30_000)
    const entry = await prisma.journalEntry.findFirst({
      where: { tenantId: co.tenantId, reference: `fixed_asset.dispose:${a.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    const dr = (code: string) => entry!.lines.filter((l) => l.account.code === code && l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect(dr('1590')).toBe(20_000)
    expect(dr('1591')).toBe(10_000)
    expect(await balance(co.tenantId, '1590')).toBe(0)
    expect(await balance(co.tenantId, '1591')).toBe(0)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })
})

describe('smallwares pools', () => {
  it('a write-off comes out FIFO across two layers; units are re-checked when applied', async () => {
    const co = await mkCo('writeoff')
    const pool = await mkPool(co)
    const l1 = await mkLayer(co, pool, { units: 10, costCents: 24_000, inServiceAt: mid(m(-4)) })
    const l2 = await mkLayer(co, pool, { units: 10, costCents: 48_000, inServiceAt: mid(m(-2)) })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(await balance(co.tenantId, '1599')).toBe(-8_000) // 4 × 1,000 + 2 × 2,000

    const r1 = await createRequest({ kind: 'pool_write_off', poolId: pool.id, reason: 'Breakage over the busy week', payload: { units: 12 } }, co.fin)
    const r2 = await createRequest({ kind: 'pool_write_off', poolId: pool.id, reason: 'More breakage reported later', payload: { units: 10, cause: 'loss' } }, co.fin)
    await expect(createRequest({ kind: 'pool_write_off', poolId: pool.id, reason: 'More than the pool holds', payload: { units: 25 } }, co.fin))
      .rejects.toMatchObject({ code: 'UNITS_EXCEED_POOL', statusCode: 422 })

    const done = await applyEvent(r1.event.id, co.ceo.id)
    expect(Number(done.costOutCents)).toBe(24_000 + 9_600)
    expect(Number(done.accumOutCents)).toBe(4_000 + 800)
    expect(Number(done.amountCents)).toBe(20_000 + 8_800)
    const allocs = (await prisma.fixedAssetEvent.findMany({ where: { parentEventId: done.id } }))
      .sort((a, b) => (a.assetId === l1.id ? 0 : 1) - (b.assetId === l1.id ? 0 : 1))
    expect(allocs.map((a) => [a.kind, a.assetId, (a.payload as { units: number }).units, Number(a.costOutCents), Number(a.accumOutCents)])).toEqual([
      ['pool_write_off_alloc', l1.id, 10, 24_000, 4_000],
      ['pool_write_off_alloc', l2.id, 2, 9_600, 800],
    ])
    expect(allocs.every((a) => a.journalEntryId === done.journalEntryId && a.status === 'posted')).toBe(true)
    const after1 = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: l1.id } })
    expect([after1.status, after1.quantity, Number(after1.costCents), after1.disposalKind]).toEqual(['disposed', 0, 0, 'written_off'])
    const after2 = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: l2.id } })
    expect([after2.status, after2.quantity, Number(after2.costCents)]).toEqual(['active', 8, 38_400])
    expect(await balance(co.tenantId, '1560')).toBe(38_400)
    expect(await balance(co.tenantId, '1599')).toBe(-3_200)
    expect(await balance(co.tenantId, '8030')).toBe(28_800)

    // Two pending requests together exceed the pool: the second is refused at approval.
    await expect(applyEvent(r2.event.id, co.ceo.id)).rejects.toMatchObject({ code: 'UNITS_EXCEED_POOL', statusCode: 409 })
    const stuck = await prisma.fixedAssetEvent.findUniqueOrThrow({ where: { id: r2.event.id } })
    expect(stuck.status).toBe('pending')
    expect(stuck.errorMessage).toMatch(/holds 8/)

    // The 8 units left keep depreciating at their own rate: (38,400 − 3,200) over 22 months.
    const s = await loadAssetState(prisma, l2.id)
    expect(forecast(s.schedule, s.charged, s.adjustments)[0]!.amountCents).toBe(1_600)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a unit transfer splits a layer, carrying its accumulated; a brand change nets to zero', async () => {
    const co = await mkCo('pooltransfer')
    const pool = await mkPool(co)
    const layer = await mkLayer(co, pool, { units: 10, costCents: 20_000, inServiceAt: mid(m(-4)) })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    const accumBefore = -(await balance(co.tenantId, '1599'))
    expect(accumBefore).toBe(3_332)

    const other = await mkCo('pooltransfer-b')
    await expect(createRequest({ kind: 'pool_transfer', poolId: pool.id, reason: 'Moving to the other company', payload: { units: 2, toLocationId: other.locationId } }, co.fin))
      .rejects.toMatchObject({ code: 'LOCATION_NOT_IN_COMPANY', statusCode: 422 })

    const r = await createRequest({
      kind: 'pool_transfer', poolId: pool.id, reason: 'Second outlet opening, plates moved',
      payload: { units: 4, toLocationId: co.location2, toConceptId: co.concept2 },
    }, co.fin)
    expect(r.applied).toBe(true)
    const split = await prisma.fixedAsset.findFirstOrThrow({ where: { splitFromAssetId: layer.id } })
    expect([split.quantity, Number(split.costCents), Number(split.carriedAccumulatedCents), split.conceptId, split.locationId, split.kind])
      .toEqual([4, 8_000, 1_333, co.concept2, co.location2, 'pool_layer'])
    expect(split.poolId).not.toBe(pool.id)
    const src = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: layer.id } })
    expect([src.quantity, Number(src.costCents), src.status]).toEqual([6, 12_000, 'active'])

    // Zero net per account; per brand the units moved with their accumulated.
    expect(await balance(co.tenantId, '1560')).toBe(20_000)
    expect(await balance(co.tenantId, '1599')).toBe(-3_332)
    expect(await balance(co.tenantId, '1560', co.concept2)).toBe(8_000)
    expect(await balance(co.tenantId, '1599', co.concept2)).toBe(-1_333)

    // The new layer is charged from this month to the original life end; the source keeps its own months.
    const s = await loadAssetState(prisma, split.id)
    const plan = forecast(s.schedule, s.charged, s.adjustments)
    expect(plan[0]!.period).toBe(cur)
    expect(plan.reduce((t, p) => t + p.amountCents, 0)).toBe(8_000 - 1_333)
    expect(plan[plan.length - 1]!.period).toBe(m(19))
    expect(await trialBalance(co.tenantId)).toBe(0)
  })
})

describe('write-downs, estimates and transfers', () => {
  it('an impairment posts to 6155 and the later charges drop', async () => {
    const co = await mkCo('impair')
    const g = await mkAsset(co, { name: 'Pizza oven', costCents: 120_000, inServiceAt: mid(m(-2)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    await expect(createRequest({ kind: 'impairment', assetId: g.id, reason: 'Damaged in the kitchen fire', payload: { amountCents: 200_000 } }, co.fin))
      .rejects.toMatchObject({ code: 'IMPAIRMENT_TOO_LARGE', statusCode: 422 })
    const r = await createRequest({ kind: 'impairment', assetId: g.id, reason: 'Damaged in the kitchen fire', payload: { amountCents: 40_000 } }, co.fin)
    const done = await applyEvent(r.event.id, co.ceo.id)
    expect(Number(done.amountCents)).toBe(40_000)
    expect(await balance(co.tenantId, '6155')).toBe(40_000)
    expect(await balance(co.tenantId, '1591')).toBe(-60_000)
    const s = await loadAssetState(prisma, g.id)
    const plan = forecast(s.schedule, s.charged, s.adjustments)
    expect(plan).toHaveLength(10)
    expect(plan[0]!.amountCents).toBe(6_000) // (120,000 − 60,000) over the 10 months left
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('a change of estimate acts from its month, with no entry', async () => {
    const co = await mkCo('estimate')
    const h = await mkAsset(co, { name: 'Ice machine', costCents: 120_000, inServiceAt: mid(m(-2)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    const before = await entries(co.tenantId)
    const r = await createRequest({ kind: 'change_estimate', assetId: h.id, reason: 'Heavier use than planned', payload: { remainingLifeMonths: 4, salvageCents: 20_000 } }, co.ceo)
    expect(r.event.payload).toMatchObject({ before: { usefulLifeMonths: 12, salvageCents: 0 }, after: { usefulLifeMonths: 6, salvageCents: 20_000 } })
    expect(await entries(co.tenantId)).toBe(before)
    const s = await loadAssetState(prisma, h.id)
    expect(forecast(s.schedule, s.charged, s.adjustments).map((p) => [p.period, p.amountCents])).toEqual(
      [[m(0), 20_000], [m(1), 20_000], [m(2), 20_000], [m(3), 20_000]],
    )
  })

  it('a brand transfer nets to zero and later depreciation carries the new brand', async () => {
    const co = await mkCo('transfer')
    const i = await mkAsset(co, { name: 'Espresso machine', costCents: 120_000, inServiceAt: mid(m(-2)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    const other = await mkCo('transfer-b')
    await expect(createRequest({ kind: 'transfer', assetId: i.id, reason: 'Wrong company outlet here', payload: { toLocationId: other.locationId } }, co.fin))
      .rejects.toMatchObject({ code: 'LOCATION_NOT_IN_COMPANY', statusCode: 422 })
    await expect(createRequest({ kind: 'transfer', assetId: i.id, reason: 'Moves to the second brand', payload: { toConceptId: other.conceptId } }, co.fin))
      .rejects.toMatchObject({ code: 'CONCEPT_NOT_IN_COMPANY', statusCode: 422 })

    const r = await createRequest({ kind: 'transfer', assetId: i.id, reason: 'Moves to the second brand', payload: { toConceptId: co.concept2, toLocationId: co.location2 } }, co.fin)
    expect(r.applied).toBe(true)
    const je = await prisma.journalEntry.findFirst({ where: { tenantId: co.tenantId, reference: `fixed_asset.transfer:${r.event.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    for (const code of ['1510', '1591']) {
      const net = je!.lines.filter((l) => l.account.code === code).reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
      expect(net).toBe(0)
    }
    expect(await balance(co.tenantId, '1510', co.conceptId)).toBe(0)
    expect(await balance(co.tenantId, '1510', co.concept2)).toBe(120_000)
    expect(await balance(co.tenantId, '1591', co.conceptId)).toBe(0)
    expect(await balance(co.tenantId, '1591', co.concept2)).toBe(-20_000)
    const moved = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: i.id } })
    expect([moved.conceptId, moved.locationId]).toEqual([co.concept2, co.location2])

    // Next month: the charge lands on the new brand.
    vi.useFakeTimers({ toFake: ['Date'], now: mid(m(1)), shouldAdvanceTime: true })
    await chargeThrough(co.tenantId, cur, { postedBy: 'system' })
    vi.useRealTimers()
    const row = await prisma.fixedAssetDepreciation.findUniqueOrThrow({ where: { assetId_period: { assetId: i.id, period: cur } } })
    expect([row.conceptId, row.locationId]).toEqual([co.concept2, co.location2])
    expect(await balance(co.tenantId, '6150', co.concept2)).toBe(10_000)
    expect(await balance(co.tenantId, '6150', co.conceptId)).toBe(20_000)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })
})

describe('void and undispose', () => {
  it('a void reverses the acquisition, every charge and impairment', async () => {
    const co = await mkCo('void')
    const j = await mkAsset(co, { name: 'Wrong item', costCents: 120_000, inServiceAt: mid(m(-3)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    await createRequest({ kind: 'impairment', assetId: j.id, reason: 'Water damage on delivery', payload: { amountCents: 10_000 } }, co.ceo)

    const r = await createRequest({ kind: 'void', assetId: j.id, reason: 'Capitalised in error — was a rental', payload: {} }, co.fin)
    expect(r.applied).toBe(false)
    await applyEvent(r.event.id, co.ceo.id)
    const voided = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: j.id } })
    expect(voided.status).toBe('voided')
    expect(voided.voidedAt).not.toBeNull()
    for (const code of ['1510', '1591', '6150', '6155', '2012']) expect(await balance(co.tenantId, code)).toBe(0)
    expect((await prisma.fixedAssetDepreciation.findMany({ where: { assetId: j.id } })).every((x) => x.reversedAt !== null)).toBe(true)
    // A voided asset is never charged again.
    const again = await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    expect(again.results.find((x) => x.assetId === j.id)).toBeUndefined()

    // An asset with a transfer on the books cannot be voided.
    const k = await mkAsset(co, { name: 'Moved freezer', costCents: 60_000, inServiceAt: mid(m(-1)), life: 12 })
    await createRequest({ kind: 'transfer', assetId: k.id, reason: 'Moved to the second outlet', payload: { toLocationId: co.location2 } }, co.fin)
    await expect(createRequest({ kind: 'void', assetId: k.id, reason: 'Capitalised in error, undo it', payload: {} }, co.fin))
      .rejects.toMatchObject({ code: 'ASSET_HAS_EVENTS', statusCode: 409 })
    expect(await trialBalance(co.tenantId)).toBe(0)
  })

  it('undispose reverses the disposal and catches up the months since', async () => {
    const co = await mkCo('undispose')
    const l = await mkAsset(co, { name: 'Deep fryer', costCents: 120_000, inServiceAt: mid(m(-4)), life: 12 })
    await chargeThrough(co.tenantId, m(-1), { postedBy: 'system' })
    await createRequest({ kind: 'disposal', assetId: l.id, effectiveDate: mid(m(-2)), reason: 'Thought it was scrapped', payload: { kind: 'scrap' } }, co.ceo)
    expect(await balance(co.tenantId, '6150')).toBe(20_000)

    const r = await createRequest({ kind: 'undispose', assetId: l.id, reason: 'Found it in the store room', payload: {} }, co.fin)
    expect(r.applied).toBe(false)
    await applyEvent(r.event.id, co.ceo.id)
    const back = await prisma.fixedAsset.findUniqueOrThrow({ where: { id: l.id } })
    expect([back.status, back.disposedAt]).toEqual(['active', null])
    const rows = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: l.id }, orderBy: { period: 'asc' } })
    expect(rows.map((x) => [x.period, x.reversedAt, x.revision])).toEqual([
      [m(-4), null, 1], [m(-3), null, 1], [m(-2), null, 2], [m(-1), null, 2],
    ])
    expect(await prisma.journalEntry.count({ where: { tenantId: co.tenantId, reference: `fixed_asset.depreciation:${l.id}:${m(-2)}@2` } })).toBe(1)
    expect(await balance(co.tenantId, '1510')).toBe(120_000)
    expect(await balance(co.tenantId, '1591')).toBe(-40_000)
    expect(await balance(co.tenantId, '6150')).toBe(40_000)
    expect(await balance(co.tenantId, '8030')).toBe(0)
    expect(await trialBalance(co.tenantId)).toBe(0)
  })
})
