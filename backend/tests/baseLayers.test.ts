// Base layers: fixed assets, receivables, food safety.
//
// What is tested is the part that touches money or safety, not the CRUD:
//   - depreciation charges exactly cost − salvage over the asset's life, never
//     a cent more or less, and a rerun never double-charges;
//   - disposal clears the asset out of the books and books the gain or loss;
//   - a receivable cannot be overpaid, and cannot be voided once paid into;
//   - every ledger entry balances per company;
//   - an out-of-range temperature is judged correctly.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { chargeFor, runDepreciation, disposeAsset, postAcquisition } from '../src/modules/fixedAssets/service.js'
import { agingBucket } from '../src/modules/receivables/routes.js'
import { withinRange } from '../src/modules/foodSafety/routes.js'

let tenantId: string

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

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Base Layer Co', slug: 'base-layer-co' } })).id
  await ensureChartOfAccounts(tenantId)
})

afterAll(async () => {
  await prisma.journalLine.deleteMany({ where: { journalEntry: { tenantId } } })
  await prisma.journalEntry.deleteMany({ where: { tenantId } })
  await prisma.fixedAsset.deleteMany({ where: { tenantId } })
  await prisma.account.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

describe('depreciation arithmetic', () => {
  const asset = { acquiredAt: new Date('2025-01-15'), costCents: 100_001, salvageCents: 1, usefulLifeMonths: 36, disposedAt: null }

  it('charges exactly cost − salvage over the life, no more, no less', () => {
    let charged = 0
    for (let i = 0; i < 48; i++) {
      const y = 2025 + Math.floor(i / 12), m = (i % 12) + 1
      charged += chargeFor(asset, `${y}-${String(m).padStart(2, '0')}`, charged)
    }
    expect(charged).toBe(100_000)
  })

  it('charges nothing before the month of acquisition', () => {
    expect(chargeFor(asset, '2024-12', 0)).toBe(0)
    expect(chargeFor(asset, '2025-01', 0)).toBeGreaterThan(0)
  })

  it('charges nothing once fully depreciated', () => {
    expect(chargeFor(asset, '2028-06', 100_000)).toBe(0)
  })
})

describe('fixed assets in the ledger', () => {
  it('capitalises, depreciates idempotently, and disposes with a gain', async () => {
    const a = await prisma.fixedAsset.create({
      data: {
        tenantId, name: 'Combi oven', category: 'kitchen_equipment', acquisitionCreditCode: '1020',
        acquiredAt: new Date('2026-01-10'), costCents: 1_200_000, salvageCents: 0, usefulLifeMonths: 12,
      },
    })
    await postAcquisition(a.id)
    expect(await balance('1510')).toBe(1_200_000)

    const first = await runDepreciation(tenantId, '2026-01')
    expect(first.chargedCents).toBe(100_000)
    const again = await runDepreciation(tenantId, '2026-01')
    expect(again.chargedCents).toBe(0)
    expect(again.results.find((r) => r.assetId === a.id)!.status).toBe('already')
    expect(await balance('6150')).toBe(100_000)
    expect(await balance('1590')).toBe(-100_000)

    await runDepreciation(tenantId, '2026-02')
    // Book value 1,000,000; sold for 1,050,000 → 50,000 gain.
    const d = await disposeAsset(a.id, { disposedAt: new Date('2026-02-28'), proceedsCents: 1_050_000 })
    expect(d.bookValueCents).toBe(1_000_000)
    expect(d.gainLossCents).toBe(50_000)
    expect(await balance('1510')).toBe(0)
    expect(await balance('1590')).toBe(0)
    expect(await balance('8030')).toBe(-50_000)
    // Disposed assets are never charged again.
    const after = await runDepreciation(tenantId, '2026-03')
    expect(after.results.find((r) => r.assetId === a.id)).toBeUndefined()
    await expect(disposeAsset(a.id, { disposedAt: new Date(), proceedsCents: 0 })).rejects.toThrow(/already/)
    expect(await trialBalance()).toBe(0)
  })

  it('refuses to charge a month that has not started', async () => {
    await expect(runDepreciation(tenantId, '2099-01')).rejects.toThrow(/not started/)
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

    const over = await call('POST', `/r/${inv.id}/payments`, { amountCents: 200_000, receivedAt: '2026-09-10', method: 'bank' })
    expect(over.statusCode).toBe(409)
    expect(over.json().error.code).toBe('OVERPAYMENT')

    const part = await call('POST', `/r/${inv.id}/payments`, { amountCents: 50_000, receivedAt: '2026-09-10', method: 'bank' })
    expect(part.statusCode).toBe(201)
    expect((await prisma.receivableInvoice.findUnique({ where: { id: inv.id } }))!.status).toBe('partial')
    expect(await balance('1110')).toBe(65_000)

    const voidPaid = await call('POST', `/r/${inv.id}/void`, { reason: 'raised in error' })
    expect(voidPaid.statusCode).toBe(409)

    const rest = await call('POST', `/r/${inv.id}/payments`, { amountCents: 65_000, receivedAt: '2026-09-20', method: 'cash' })
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
