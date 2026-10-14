// Base layers: fixed assets, receivables, food safety.
//
// What is tested is the part that touches money or safety, not the CRUD:
//   - depreciation (fixed assets v2: chargeThrough, the one path) charges
//     exactly cost − salvage over the asset's life, never a cent more or less,
//     on the class's own accumulated account (1591…), and a rerun never
//     double-charges — not even after the old engine charged a month out of
//     order (M-01);
//   - disposal clears the asset out of the books and books the gain or loss;
//   - a receivable cannot be overpaid, and cannot be voided once paid into;
//   - every ledger entry balances per company;
//   - an out-of-range temperature is judged correctly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { chargeThrough, postAcquisition, nextAssetTag } from '../src/modules/fixedAssets/service.js'
import { createRequest } from '../src/modules/fixedAssets/events.js'
import { planCharges, lastDayPkt, type ScheduleAsset } from '../src/modules/fixedAssets/schedule.js'
import { agingBucket } from '../src/modules/receivables/routes.js'
import { withinRange } from '../src/modules/foodSafety/routes.js'

let tenantId: string
let ceoId: string

async function balance(code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { code, tenantId }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
}

async function trialBalance(): Promise<number> {
  const lines = await prisma.journalLine.findMany({ where: { journalEntry: { tenantId } }, select: { type: true, amountCents: true } })
  return lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
}

/** An asset on the register through postAcquisition (Dr class cost / Cr 2012), as CapEx capitalises it. */
async function capitalise(name: string, costCents: number, inServiceAt: Date, life: number) {
  return prisma.$transaction(async (tx) => {
    const a = await tx.fixedAsset.create({
      data: {
        tenantId, name, category: 'kitchen_equipment', assetTag: await nextAssetTag(tx, tenantId), acquisitionCreditCode: '2012',
        acquiredAt: inServiceAt, inServiceAt, costCents, originalCostCents: costCents, salvageCents: 0, usefulLifeMonths: life,
      },
    })
    await postAcquisition(tx, a, { advancedCents: 0, owedCents: costCents, inputTaxCents: 0, inputTaxCode: null, natural: inServiceAt })
    return a
  })
}

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Base Layer Co', slug: 'base-layer-co' } })).id
  await ensureChartOfAccounts(tenantId)
  ceoId = (await prisma.user.create({ data: { name: 'FA CEO', email: 'fa.ceo@base-layer.test', password: 'x', role: 'admin', tenantId } })).id
})

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { journalEntry: { tenantId } } })
  await prisma.journalEntry.deleteMany({ where: { tenantId } })
  await prisma.fixedAssetEvent.deleteMany({ where: { tenantId } })
  await prisma.fixedAssetRun.deleteMany({ where: { tenantId } })
  await prisma.fixedAsset.deleteMany({ where: { tenantId } })
  await prisma.fixedAssetClass.deleteMany({ where: { tenantId } })
  await prisma.exceptionFlag.deleteMany({ where: { tenantId } })
  await prisma.operationsConfig.deleteMany({ where: { tenantId } })
  await prisma.user.deleteMany({ where: { id: ceoId } })
  await prisma.account.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

describe('depreciation arithmetic', () => {
  const asset: ScheduleAsset = {
    inServiceAt: new Date('2025-01-15T12:00:00+05:00'), costCents: 100_001, salvageCents: 1, usefulLifeMonths: 36, method: 'straight_line',
  }
  const total = (xs: Array<{ amountCents: number }>) => xs.reduce((t, x) => t + x.amountCents, 0)

  it('charges exactly cost − salvage over the life, no more, no less', () => {
    expect(total(planCharges(asset, new Map(), [], '2028-12'))).toBe(100_000)
  })

  it('charges nothing before the month it went into service', () => {
    expect(planCharges(asset, new Map(), [], '2024-12')).toEqual([])
    expect(planCharges(asset, new Map(), [], '2025-01')[0]!.amountCents).toBeGreaterThan(0)
  })

  it('charges nothing once fully depreciated', () => {
    const all = new Map(planCharges(asset, new Map(), [], '2028-12').map((p) => [p.period, p.amountCents]))
    expect(planCharges(asset, all, [], '2028-12')).toEqual([])
  })
})

describe('fixed assets in the ledger', () => {
  it('capitalises, depreciates idempotently on 1591, and disposes with a gain', async () => {
    const a = await capitalise('Combi oven', 1_200_000, new Date('2026-01-10T12:00:00+05:00'), 12)
    expect(await balance('1510')).toBe(1_200_000)
    expect(await balance('2012')).toBe(-1_200_000)

    const first = await chargeThrough(tenantId, '2026-01', { postedBy: 'system' })
    expect(first.chargedCents).toBe(100_000)
    const again = await chargeThrough(tenantId, '2026-01', { postedBy: 'system' })
    expect(again.chargedCents).toBe(0)
    expect(again.results.find((r) => r.assetId === a.id)!.status).toBe('already')
    expect(await balance('6150')).toBe(100_000)
    expect(await balance('1591')).toBe(-100_000)
    expect(await balance('1590')).toBe(0)

    await chargeThrough(tenantId, '2026-02', { postedBy: 'system' })
    // Sold on 5 March (the disposal month is not charged): book value 1,000,000; sold for 1,050,000 → 50,000 gain.
    const sold = await createRequest({
      kind: 'disposal', assetId: a.id, effectiveDate: new Date('2026-03-05T12:00:00+05:00'), reason: 'Sold to the franchisee',
      payload: { kind: 'sale', proceedsCents: 1_050_000 },
    }, { id: ceoId, role: 'admin' })
    expect(sold.applied).toBe(true)
    expect(sold.event.payload).toMatchObject({ nbvCents: 1_000_000, gainLossCents: 50_000 })
    expect(await balance('1510')).toBe(0)
    expect(await balance('1591')).toBe(0)
    expect(await balance('1020')).toBe(1_050_000)
    expect(await balance('8030')).toBe(-50_000)
    // Disposed assets are never charged again.
    const after = await chargeThrough(tenantId, '2026-03', { postedBy: 'system' })
    expect(after.results.find((r) => r.assetId === a.id)).toBeUndefined()
    await expect(createRequest({ kind: 'disposal', assetId: a.id, reason: 'Sold to the franchisee', payload: { kind: 'scrap' } }, { id: ceoId, role: 'admin' }))
      .rejects.toThrow(/already/)
    expect(await trialBalance()).toBe(0)
  })

  it('M-01: a month the old engine charged out of order never takes the total past cost − salvage', async () => {
    const a = await capitalise('Old range', 120_000, new Date('2025-01-10T12:00:00+05:00'), 12)
    // The old engine charged the LAST month first and gave it "the remainder" — the whole cost.
    await prisma.fixedAssetDepreciation.create({ data: { tenantId, assetId: a.id, period: '2025-12', amountCents: 120_000 } })
    await postJournalEntry({
      tenantId, sourceType: 'fixed_asset.depreciation', sourceId: `${a.id}:2025-12`, description: 'Depreciation 2025-12',
      entryDate: lastDayPkt('2025-12'), lines: [
        { accountCode: '6150', type: 'debit', amountCents: 120_000 },
        { accountCode: '1590', type: 'credit', amountCents: 120_000 },
      ],
    })
    const r = await chargeThrough(tenantId, '2025-12', { postedBy: 'system', assetIds: [a.id] })
    expect(r.chargedCents).toBe(0) // the old engine would have charged 11 × 10,000 more
    const charged = await prisma.fixedAssetDepreciation.findMany({ where: { assetId: a.id } })
    expect(charged.reduce((t, d) => t + Number(d.amountCents), 0)).toBe(120_000)
    expect(await trialBalance()).toBe(0)
  })

  it('refuses to charge a month that has not ended', async () => {
    await expect(chargeThrough(tenantId, '2099-01', { postedBy: 'system' })).rejects.toMatchObject({ code: 'MONTH_NOT_ENDED' })
  })
})

describe('receivables', () => {
  it('ages by days past due', () => {
    const now = new Date('2026-06-30')
    expect(agingBucket(new Date('2026-07-10'), now)).toBe('current')
    expect(agingBucket(new Date('2026-06-15'), now)).toBe('1-30')
    expect(agingBucket(new Date('2026-05-01'), now)).toBe('31-60')
    expect(agingBucket(new Date('2026-01-01'), now)).toBe('90+')
  })
})

describe('food safety limits', () => {
  it('judges readings against open-ended limits', () => {
    expect(withinRange(4, 0, 5)).toBe(true)
    expect(withinRange(6, 0, 5)).toBe(false)
    expect(withinRange(-20, null, -18)).toBe(true)   // freezer
    expect(withinRange(-15, null, -18)).toBe(false)
    expect(withinRange(70, 63, null)).toBe(true)     // hot hold
    expect(withinRange(55, 63, null)).toBe(false)
  })
})

// ── Receivables through the real handlers ─────────────────────────────────
import Fastify from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { receivableRoutes } from '../src/modules/receivables/routes.js'
import { AppError } from '../src/lib/errors.js'

describe('receivables — issue, pay, overpay, void', () => {
  it('posts balanced entries, refuses overpayment and voiding a paid invoice', async () => {
    const user = await prisma.user.create({
      data: {
        name: 'AR Admin', email: 'ar.admin@gsfoods.pk', password: await bcrypt.hash('x-Password-1', 4),
        role: 'admin', isActive: true, accountStatus: 'active', tenantId,
      },
    })
    await prisma.tenantMember.create({ data: { tenantId, userId: user.id } as never }).catch(() => {})
    const { accessToken } = issueStaffSession(user) as { accessToken: string }

    const app = Fastify()
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code } })
      if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
      return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
    })
    await app.register(receivableRoutes, { prefix: '/r' })
    await app.ready()
    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${accessToken}` } })

    const issued = await call('POST', '/r', {
      customerName: 'Acme Catering', issueDate: '2026-09-01', dueDate: '2026-09-30',
      description: 'Office lunch', amountCents: 100_000, taxCents: 15_000,
    })
    expect(issued.statusCode).toBe(201)
    const inv = issued.json()
    expect(inv.number).toMatch(/^AR-2026-\d{4}$/)
    expect(await balance('1110')).toBe(115_000)

    const over = await call('POST', `/r/${inv.id}/payments`, { reference: 'BL-1', amountCents: 200_000, receivedAt: '2026-09-10', method: 'bank' })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVERPAYMENT')

    const part = await call('POST', `/r/${inv.id}/payments`, { reference: 'BL-2', amountCents: 50_000, receivedAt: '2026-09-10', method: 'bank' })
    expect(part.statusCode).toBe(201)
    expect((await prisma.receivableInvoice.findUnique({ where: { id: inv.id } }))!.status).toBe('partial')
    expect(await balance('1110')).toBe(65_000)

    const voidPaid = await call('POST', `/r/${inv.id}/void`, { reason: 'raised in error' })
    expect(voidPaid.statusCode).toBe(409)

    const rest = await call('POST', `/r/${inv.id}/payments`, { reference: 'BL-3', amountCents: 65_000, receivedAt: '2026-09-20', method: 'cash' })
    expect(rest.statusCode).toBe(201)
    expect((await prisma.receivableInvoice.findUnique({ where: { id: inv.id } }))!.status).toBe('paid')
    expect(await balance('1110')).toBe(0)

    // An unpaid invoice can be voided, and the void reverses it in the ledger.
    const second = (await call('POST', '/r', {
      customerName: 'Beta', issueDate: '2026-09-02', dueDate: '2026-09-30', description: 'x', amountCents: 10_000,
    })).json()
    expect(second.number).not.toBe(inv.number)
    expect((await call('POST', `/r/${second.id}/void`, { reason: 'duplicate' })).statusCode).toBe(200)
    expect(await balance('1110')).toBe(0)
    expect(await trialBalance()).toBe(0)

    await app.close()
    await prisma.receivablePayment.deleteMany({ where: { tenantId } })
    await prisma.receivableInvoice.deleteMany({ where: { tenantId } })
    await prisma.tenantMember.deleteMany({ where: { tenantId } }).catch(() => {})
    await prisma.user.delete({ where: { id: user.id } })
  })
})
